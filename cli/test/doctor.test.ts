import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  WorkspaceService,
  type Goal,
  type LocalProcessIdentity,
} from "../../packages/core/src/index.js";
import { SessionControl } from "../../packages/sessions/src/index.js";
import { DOCTOR_PROBE_TIMEOUT_MS } from "../src/doctor.js";

const exec = promisify(execFile);
const roots: string[] = [];
const childProcesses: ChildProcess[] = [];
const servers: Server[] = [];

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, 1_000);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  });
}

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await Promise.race([
        exited.catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 1_000)),
      ]);
    }
  }
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  workspace: string;
  control: string;
  bin: string;
  socket: string;
  log: string;
  pidFile: string;
  config: Awaited<ReturnType<SessionControl["initialize"]>>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atte-doctor-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const bin = join(root, "bin");
  await Promise.all([mkdir(workspace), mkdir(bin)]);
  const sessionControl = new SessionControl(control);
  const config = await sessionControl.initialize();
  const socket = join(root, "herdr.sock");
  const server = createServer((_request, response) => response.end());
  servers.push(server);
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    root,
    workspace,
    control,
    bin,
    socket,
    log: join(root, "herdr-commands.jsonl"),
    pidFile: join(root, "herdr.pid"),
    config,
  };
}

async function fakeHerdr(f: Fixture, mode: "healthy" | "mismatch" | "exited" | "unreachable" | "hang") {
  const path = join(f.bin, `fake-herdr-${mode}.mjs`);
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args[2];
const subcommand = args[3];
if (process.env.FAKE_HERDR_LOG)
  appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_HERDR_MODE;
const output = value => process.stdout.write(JSON.stringify({ result: value }));
if (command === "status") {
  if (mode === "hang") {
    writeFileSync(process.env.FAKE_HERDR_PIDFILE, String(process.pid));
    setInterval(() => {}, 1_000);
  } else {
    output({ server: {
      running: mode !== "unreachable", compatible: true,
      session: process.env.FAKE_HERDR_SESSION,
      socket: process.env.FAKE_HERDR_SOCKET, version: "0.9.5",
    } });
  }
} else if (command === "agent" && subcommand === "list") {
  output({ agents: mode === "exited" ? [] : [{
    pane_id: "w1:p1", name: "owner-doctor", agent: "Codex", agent_status: "idle",
  }] });
} else if (command === "pane" && subcommand === "list") {
  output({ panes: mode === "exited" ? [] : [{
    pane_id: "w1:p1", tab_id: mode === "mismatch" ? "w1:t-other" : "w1:t1",
  }] });
} else if (command === "pane" && subcommand === "process-info") {
  output({ process_info: {
    shell_pid: Number(process.env.FAKE_HERDR_PID),
    foreground_process_group_id: Number(process.env.FAKE_HERDR_PGID),
    foreground_processes: [{ pid: Number(process.env.FAKE_HERDR_PID), name: "node" }],
  } });
} else {
  process.stderr.write("unexpected herdr command: " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`, { mode: 0o755 });
  return path;
}

async function ownedProcess(): Promise<{ identity: LocalProcessIdentity; pgid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  childProcesses.push(child);
  for (let attempt = 0; attempt < 40; attempt++) {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
      env: { ...process.env, LC_ALL: "C" },
    });
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match && Number(match[1]) === child.pid) {
        return {
          identity: { pid: child.pid!, bornAt: match[4]!.trim() },
          pgid: Number(match[3]),
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("owned fixture process did not appear in ps");
}

async function stopOwnedProcess(identity: LocalProcessIdentity) {
  const child = childProcesses.find(candidate => candidate.pid === identity.pid);
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited.catch(() => undefined);
}

async function createScene(f: Fixture, identity: LocalProcessIdentity, pgid: number, cachedReachable: boolean) {
  const service = new WorkspaceService(f.workspace);
  const goal = await service.execute({ type: "goal.intake", text: "诊断隔离现场" }) as Goal;
  const control = new SessionControl(f.control);
  await control.registerWorkspace(f.workspace);
  const socketInfo = await lstat(f.socket);
  const runtimeGeneration = `${f.socket}:${socketInfo.dev}:${socketInfo.ino}:${socketInfo.birthtimeMs}`;
  const scene = {
    version: 1 as const,
    backend: "herdr" as const,
    installationId: f.config.installationId,
    backendEpoch: f.config.epoch,
    bindingId: "binding-doctor",
    attemptId: "attempt-doctor",
    runtimeId: f.socket,
    runtimeGeneration,
    process: identity,
    ownership: {
      version: 1 as const,
      samples: 2 as const,
      capturedAt: "2026-11-16T00:00:00.000Z",
      shell: identity,
      launcher: identity,
      foreground: identity,
      processGroupId: pgid,
    },
    locator: {
      kind: "herdr" as const,
      session: "doctor-session",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
    },
  };
  await service.execute({ type: "scene.bind", goalId: goal.id, scene });
  const checkedAt = "2026-11-16T12:00:00.000Z";
  await service.execute({
    type: "scene.observe",
    scenes: [{
      bindingId: scene.bindingId,
      presence: { state: "idle", checkedAt, reachable: cachedReachable },
    }],
  });
  return { service, goal, scene, checkedAt };
}

async function runDoctor(f: Fixture, options: {
  binary: string;
  mode: string;
  identity?: { pid: number; bornAt: string };
  pgid?: number;
}) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(ATTE_|CREWVANE_|HERDR_|FAKE_HERDR_|COORDINATOR$|AGENT_NAME$|WORKSPACE$|ROLE$|GOAL_ID$)/.test(key))
      delete environment[key];
  }
  Object.assign(environment, {
    ATTE_CONTROL_DIRECTORY: f.control,
    CREWVANE_CONTROL_DIRECTORY: f.control,
    ATTE_HERDR_BINARY: options.binary,
    CREWVANE_HERDR_BINARY: options.binary,
    ATTE_HERDR_SESSION: "doctor-session",
    CREWVANE_HERDR_SESSION: "doctor-session",
    FAKE_HERDR_MODE: options.mode,
    FAKE_HERDR_LOG: f.log,
    FAKE_HERDR_PIDFILE: f.pidFile,
    FAKE_HERDR_SOCKET: f.socket,
    FAKE_HERDR_SESSION: "doctor-session",
    FAKE_HERDR_PID: String(options.identity?.pid ?? process.pid),
    FAKE_HERDR_PGID: String(options.pgid ?? process.pid),
  });
  const started = Date.now();
  const { stdout, stderr } = await exec(
    "pnpm",
    ["--dir", "cli", "exec", "tsx", "src/main.ts", "doctor", "--root", f.workspace, "--json"],
    {
      cwd: new URL("../../", import.meta.url),
      env: environment,
      timeout: 10_000,
    },
  );
  assert.equal(stderr, "");
  return { report: JSON.parse(stdout), elapsed: Date.now() - started };
}

async function snapshot(root: string) {
  const files: Record<string, string> = {};
  async function walk(directory: string, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) files[name] = (await readFile(path)).toString("base64");
    }
  }
  await walk(root);
  return files;
}

async function commands(path: string) {
  return await readFile(path, "utf8").then(raw => raw.trim().split("\n").filter(Boolean).map(line =>
    JSON.parse(line) as string[])).catch(() => []);
}

test("doctor uses a live read-only probe instead of cached reachability", async () => {
  const f = await fixture();
  const owned = await ownedProcess();
  await createScene(f, owned.identity, owned.pgid, false);
  const binary = await fakeHerdr(f, "healthy");
  const workspaceBefore = await snapshot(f.workspace);
  const controlBefore = await snapshot(f.control);
  const { report } = await runDoctor(f, {
    binary, mode: "healthy", identity: owned.identity, pgid: owned.pgid,
  });
  assert.equal(typeof report.version, "string");
  assert.equal(report.workspace, f.workspace);
  assert.ok(report.state);
  assert.ok(report.inbox);
  assert.deepEqual(report.deadScenes, []);
  assert.equal(report.probe.status, "ok");
  assert.ok(Array.isArray(report.hints));
  assert.deepEqual(await snapshot(f.workspace), workspaceBefore, "doctor never changes workspace state");
  assert.deepEqual(await snapshot(f.control), controlBefore, "doctor never changes session control");
  const invoked = await commands(f.log);
  assert.ok(invoked.length > 0);
  assert.ok(invoked.every(args =>
    args[2] === "status" ||
    args[2] === "agent" && args[3] === "list" ||
    args[2] === "pane" && ["list", "process-info"].includes(args[3] ?? "")),
  "doctor only invokes read-only Herdr commands");
});

test("doctor distinguishes identity mismatch and a confirmed exit with actionable hints", async () => {
  const mismatchFixture = await fixture();
  const mismatchOwned = await ownedProcess();
  await createScene(mismatchFixture, mismatchOwned.identity, mismatchOwned.pgid, true);
  const mismatchBinary = await fakeHerdr(mismatchFixture, "mismatch");
  const mismatch = await runDoctor(mismatchFixture, {
    binary: mismatchBinary, mode: "mismatch",
    identity: mismatchOwned.identity, pgid: mismatchOwned.pgid,
  });
  assert.equal(mismatch.report.deadScenes[0]?.status, "identity_mismatch");
  assert.equal(mismatch.report.deadScenes[0]?.lastObservedAt != null, true);
  assert.equal(mismatch.report.deadScenes[0]?.stateSince, "2026-11-16T12:00:00.000Z");
  assert.ok(mismatch.report.deadScenes[0]?.hints.length > 0);
  assert.match(mismatch.report.deadScenes[0]?.hints.join("\n"), /重绑|重建/);

  const exitedFixture = await fixture();
  const exitedOwned = await ownedProcess();
  await createScene(exitedFixture, exitedOwned.identity, exitedOwned.pgid, true);
  await stopOwnedProcess(exitedOwned.identity);
  const exitedBinary = await fakeHerdr(exitedFixture, "exited");
  const exited = await runDoctor(exitedFixture, {
    binary: exitedBinary, mode: "exited",
    identity: exitedOwned.identity, pgid: exitedOwned.pgid,
  });
  assert.equal(exited.report.deadScenes[0]?.status, "confirmed_exited");
  assert.ok(exited.report.deadScenes[0]?.lastObservedAt != null);
  assert.ok(exited.report.deadScenes[0]?.hints.some((hint: string) => /恢复负责人/.test(hint)));
  assert.ok(exited.report.hints.length > 0);
});

test("doctor fails safe when Herdr is unreachable or its executable is missing", async () => {
  const unreachableFixture = await fixture();
  const owned = await ownedProcess();
  await createScene(unreachableFixture, owned.identity, owned.pgid, false);
  const unreachableBinary = await fakeHerdr(unreachableFixture, "unreachable");
  const unreachable = await runDoctor(unreachableFixture, {
    binary: unreachableBinary, mode: "unreachable",
    identity: owned.identity, pgid: owned.pgid,
  });
  assert.equal(unreachable.report.probe.status, "unreachable");
  assert.equal(unreachable.report.deadScenes[0]?.status, "unreachable");
  assert.ok(Array.isArray(unreachable.report.deadScenes[0]?.hints));
  assert.ok(unreachable.report.hints.some((hint: string) => /重新连接/.test(hint)));

  const missingFixture = await fixture();
  const missingOwned = await ownedProcess();
  await createScene(missingFixture, missingOwned.identity, missingOwned.pgid, false);
  const missing = await runDoctor(missingFixture, {
    binary: join(missingFixture.bin, "missing-herdr"),
    mode: "healthy",
    identity: missingOwned.identity,
    pgid: missingOwned.pgid,
  });
  assert.equal(missing.report.probe.status, "unverified");
  assert.equal(missing.report.deadScenes[0]?.status, "unverified");
  assert.ok(Array.isArray(missing.report.deadScenes[0]?.hints));
  assert.ok(missing.report.hints.some((hint: string) => /Herdr 可执行文件|Herdr 已安装/.test(hint)));
});

test("doctor bounds a hanging Herdr probe and kills the child process", async () => {
  const f = await fixture();
  const owned = await ownedProcess();
  await createScene(f, owned.identity, owned.pgid, false);
  const binary = await fakeHerdr(f, "hang");
  const workspaceBefore = await snapshot(f.workspace);
  const controlBefore = await snapshot(f.control);
  const { report, elapsed } = await runDoctor(f, {
    binary, mode: "hang", identity: owned.identity, pgid: owned.pgid,
  });
  assert.equal(report.probe.status, "timeout");
  assert.equal(report.deadScenes[0]?.status, "unverified");
  assert.equal(report.deadScenes[0]?.detail, "probe_timeout");
  assert.ok(Array.isArray(report.deadScenes[0]?.hints));
  assert.ok(report.hints.some((hint: string) => /已终止探测进程/.test(hint)));
  assert.ok(elapsed < DOCTOR_PROBE_TIMEOUT_MS + 5_000, `doctor returned in ${elapsed}ms`);
  const pid = Number(await readFile(f.pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let stopped = false;
  for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 25));
    } catch {
      stopped = true;
    }
  }
  assert.equal(stopped, true, "timed-out Herdr process was terminated");
  assert.deepEqual(await snapshot(f.workspace), workspaceBefore);
  assert.deepEqual(await snapshot(f.control), controlBefore);
});

test("doctor reports legacy Orca as read-only without invoking Herdr", async () => {
  const f = await fixture();
  const service = new WorkspaceService(f.workspace);
  const goal = await service.execute({ type: "goal.intake", text: "旧 Orca 历史" }) as Goal;
  const control = new SessionControl(f.control);
  await control.registerWorkspace(f.workspace);
  const state = await service.read();
  const current = state.goals.find(item => item.id === goal.id)!;
  current.readOnly = true;
  current.readOnlyReason = "legacy-orca";
  current.scene = {
    version: 1,
    backend: "orca",
    installationId: "legacy-orca",
    backendEpoch: 0,
    bindingId: "legacy-binding",
    attemptId: "legacy-attempt",
    runtimeId: "legacy-runtime",
    runtimeGeneration: "legacy-generation",
    locator: {
      kind: "orca",
      repoId: "repo",
      worktreeId: "worktree",
      terminalHandle: "terminal",
      executionHostId: "host",
      incarnationId: "incarnation",
    },
  };
  current.live = {
    state: "unknown",
    checkedAt: "2026-11-16T12:00:00.000Z",
    stateSince: "2026-11-15T12:00:00.000Z",
    reachable: false,
  };
  await writeFile(join(f.workspace, ".atte", "state.json"), JSON.stringify(state, null, 2));
  await mkdir(f.bin, { recursive: true });
  const binary = await fakeHerdr(f, "healthy");
  const workspaceBefore = await snapshot(f.workspace);
  const controlBefore = await snapshot(f.control);
  const { report } = await runDoctor(f, {
    binary, mode: "healthy", identity: { pid: process.pid, bornAt: "unused" }, pgid: process.pid,
  });
  assert.equal(report.probe.status, "skipped");
  assert.equal(report.deadScenes[0]?.status, "unverified");
  assert.equal(report.deadScenes[0]?.legacy, true);
  assert.ok(report.deadScenes[0]?.hints.some((hint: string) => /只读|legacy/.test(hint)));
  await assert.rejects(access(f.log));
  assert.deepEqual(await snapshot(f.workspace), workspaceBefore);
  assert.deepEqual(await snapshot(f.control), controlBefore);
});
