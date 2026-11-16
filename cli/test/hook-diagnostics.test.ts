import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  HOOK_DIAGNOSTICS_MAX_BYTES,
  HOOK_DIAGNOSTIC_REASONS,
  readHookDiagnostics,
  recordHookDiagnostic,
} from "../src/hook-diagnostics.js";

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliRoot = join(repositoryRoot, "cli");
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-hook-diagnostics-"));
  roots.push(root);
  const environment = {
    ATTE_GOAL_ID: "PRIVATE_GOAL", ATTE_ATTEMPT_ID: "PRIVATE_ATTEMPT",
    ATTE_HOOK_TOKEN: "PRIVATE_TOKEN", ATTE_AGENT_NAME: "PRIVATE_AGENT",
    ATTE_WORKSPACE: root,
  };
  return { root, environment, directory: join(root, ".atte/runtime") };
}

test("managed failures store bounded fixed counters and a timestamp without private context", async () => {
  const { root, directory, environment } = await fixture();
  await promisify(execFile)(join(repositoryRoot, "node_modules/.bin/tsx"), [
    join(cliRoot, "test/fixtures/diagnostic-cli.ts"),
  ], {
    cwd: cliRoot,
    env: { ...process.env, ...environment },
    timeout: 5_000,
  });
  for (const reason of HOOK_DIAGNOSTIC_REASONS)
    await recordHookDiagnostic({ environment, reason });
  const body = await readFile(join(directory, "hook-diagnostics.json"), "utf8");
  assert.ok(Buffer.byteLength(body) <= HOOK_DIAGNOSTICS_MAX_BYTES);
  assert.doesNotMatch(body, /PRIVATE|history|xxxxxxxx/i);
  assert.equal(readHookDiagnostics(root).counts.stdin_epipe, 601);
  assert.deepEqual(await readdir(directory), ["hook-diagnostics.json"]);
  assert.equal((await stat(join(directory, "hook-diagnostics.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("unmanaged failures and read-only diagnostics never create files", async () => {
  const { root, environment } = await fixture();
  delete (environment as NodeJS.ProcessEnv).ATTE_HOOK_TOKEN;
  assert.equal(await recordHookDiagnostic({ environment, reason: "overflow" }), false);
  assert.deepEqual(readHookDiagnostics(root), { version: 1, counts: {} });
  assert.deepEqual(await readdir(root), []);
});

test("diagnostic reads and updates whitelist existing fields and reject arbitrary reasons", async () => {
  const { root, directory, environment } = await fixture();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "hook-diagnostics.json"), JSON.stringify({
    version: 1, counts: { stdin_epipe: 3, PRIVATE_TOKEN: 500, timeout: -1 },
    payload: "PRIVATE_PAYLOAD",
    lastFailure: { reason: "stdin_epipe", at: "PRIVATE_HISTORY", token: "PRIVATE_TOKEN" },
  }));
  assert.deepEqual(readHookDiagnostics(root), { version: 1, counts: { stdin_epipe: 3 } });
  assert.equal(await recordHookDiagnostic({
    environment, reason: "PRIVATE_REASON" as "overflow",
  }), false);
  assert.equal(await recordHookDiagnostic({ environment, reason: "overflow" }), true);
  assert.doesNotMatch(await readFile(join(directory, "hook-diagnostics.json"), "utf8"), /PRIVATE/);
});

test("diagnostics never follow state, runtime or file symlinks", async () => {
  for (const component of ["state", "runtime", "file"]) {
    const { root, environment, directory } = await fixture();
    const target = join(root, "unrelated");
    if (component === "file") {
      await mkdir(directory, { recursive: true });
      await writeFile(target, "PRIVATE_USER_FILE");
      await symlink(target, join(directory, "hook-diagnostics.json"));
    } else {
      await mkdir(target);
      if (component === "runtime") await mkdir(join(root, ".atte"));
      await symlink(target, component === "state" ? join(root, ".atte") : directory);
    }
    assert.equal(await recordHookDiagnostic({ environment, reason: "stdin_epipe" }), false);
    assert.deepEqual(readHookDiagnostics(root), { version: 1, counts: {} });
    if (component === "file") assert.equal(await readFile(target, "utf8"), "PRIVATE_USER_FILE");
    else assert.deepEqual(await readdir(target), []);
  }
});

test("legacy workspaces share the same bounded diagnostic schema", async () => {
  const { root, environment } = await fixture();
  await mkdir(join(root, ".crewvane"));
  const legacy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment))
    legacy[key.replace("ATTE_", "CREWVANE_")] = value;
  assert.equal(await recordHookDiagnostic({ environment: legacy, reason: "spawn_error" }), true);
  assert.equal(readHookDiagnostics(root).counts.spawn_error, 1);
  assert.deepEqual((await readdir(root)).sort(), [".crewvane"]);
});
