import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrAdapter, type CreateSceneRequest,
} from "../src/index.js";
import { isSceneReference, type ProcessProbe, type SceneReferenceV1 } from "../../core/src/index.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atte-herdr-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input: CreateSceneRequest = {
    requestId: "ownership-one", installationId: "installation-one",
    bindingId: "binding-one", attemptId: "attempt-one", backendEpoch: 0,
    role: "owner", goalId: "goal-one", cwd: "/tmp/ownership",
    title: "ownership fixture", launcherPath: "/tmp/ownership-launch.zsh",
    receiptPath: join(root, "environment-ready.json"),
  };
  const births = new Map([
    [100, "shell-birth"],
    [400, "launcher-birth"],
    [500, "foreground-birth"],
  ]);
  let generation = "generation-one";
  let alive = true;
  let shellAlive = true;
  let launcherAlive = true;
  let panePresent = true;
  let processUnverifiable = false;
  let foregroundPid = 500;
  let instabilityArmed = false;
  let instabilitySamples = 0;
  const failedWorkspaces = new Set<string>();
  const failedProcessInfo = new Set<string>();
  const commands: string[][] = [];
  let processInfoCalls = 0;
  const envelope = (result: unknown) => JSON.stringify({ result });
  const processes = {
    identity: async (pid: number) => ({ pid, bornAt: births.get(pid) ?? `birth-${pid}` }),
    probe: async (
      identity: { pid: number; bornAt: string }, processGroupId?: number,
    ): Promise<ProcessProbe> => {
      if (processUnverifiable)
        return { status: "unverifiable", detail: "process_table_unavailable" };
      if (!shellAlive && identity.pid === 100) return { status: "absent" };
      if (!launcherAlive && identity.pid === 400) return { status: "absent" };
      if (!alive && identity.pid === 500) return { status: "absent" };
      if (identity.bornAt !== births.get(identity.pid)) return { status: "absent" };
      if (identity.pid === 400 && processGroupId !== undefined)
        return { status: "absent", detail: "launcher_process_group_is_distinct" };
      if (processGroupId !== undefined && processGroupId !== 300)
        return { status: "absent", detail: "process_group_changed" };
      return { status: "matched", identity, ...(processGroupId ? { processGroupId } : {}) };
    },
    alive: async () => alive,
    hasChild: async () => alive,
  };
  const adapter = new HerdrAdapter({
    executable: "/mock/herdr", session: "atte-ownership", directory: root,
    socketIdentity: async () => generation, processes, ownershipSampleDelayMs: 1,
    run: async args => {
      commands.push(args);
      if (args[0] === "status") return envelope({
        server: {
          running: true, compatible: true, session: "atte-ownership",
          socket: "/tmp/atte-ownership.sock", version: "0.9.5",
        },
      });
      const command = args.slice(0, 2).join(" ");
      if (command === "workspace list") return envelope({ workspaces: [{ workspace_id: "w1" }] });
      if (command === "tab create") return envelope({ root_pane: { pane_id: "w1:p1" } });
      if (command === "pane run") {
        await writeFile(input.receiptPath, JSON.stringify({
          version: 1, ...input, pid: 400, bornAt: "launcher-birth",
          herdr: { session: "atte-ownership", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
        }));
        return "";
      }
      if (command === "pane list") {
        const workspace = args[3]!;
        if (failedWorkspaces.has(workspace)) throw new Error("workspace lookup failed");
        const panes = panePresent ? [
          { pane_id: "w1:p1", tab_id: "w1:t1" },
          { pane_id: "w1:p3", tab_id: "w1:t3" },
        ] : [];
        return envelope({ panes });
      }
      if (command === "pane process-info") {
        const pane = args[3]!;
        if (failedProcessInfo.has(pane)) throw new Error("process lookup failed");
        processInfoCalls++;
        if (instabilityArmed && pane === "w1:p1") {
          instabilitySamples++;
          foregroundPid = instabilitySamples === 1 ? 500 : 501;
        }
        return envelope({ process_info: {
          shell_pid: 100, foreground_process_group_id: 300, tty: "ttys001",
          foreground_processes: alive
            ? [{ pid: 400, name: "zsh" }, { pid: foregroundPid, name: "codex" }]
            : [],
        } });
      }
      if (command === "agent list") return envelope({ agents: alive ? [{
        pane_id: "w1:p1", name: "owner-one", agent: "Codex", agent_status: "idle",
      }] : [] });
      if (command === "agent prompt") return "";
      throw new Error(`Unexpected ${command}`);
    },
  });
  await adapter.connect({ installationId: input.installationId, cwd: input.cwd });
  async function create() {
    const result = await adapter.create(input);
    assert(result.scene);
    return result.scene;
  }
  return {
    adapter, create, commands,
    restart: () => { generation = "generation-two"; },
    exit: () => { alive = false; shellAlive = false; launcherAlive = false; panePresent = false; },
    foregroundExit: () => { alive = false; },
    unverifiable: () => { processUnverifiable = true; },
    failWorkspace: (workspace: string) => { failedWorkspaces.add(workspace); },
    failProcessInfo: (pane: string) => { failedProcessInfo.add(pane); },
    armInstability: () => { instabilityArmed = true; instabilitySamples = 0; foregroundPid = 500; },
    processInfoCalls: () => processInfoCalls,
  };
}

function relocated(
  scene: SceneReferenceV1, bindingId: string, workspaceId: string,
  tabId = `${workspaceId}:t1`, paneId = `${workspaceId}:p1`,
): SceneReferenceV1 {
  assert.equal(scene.backend, "herdr");
  return {
    ...scene, bindingId, attemptId: `attempt-${bindingId}`,
    locator: { ...scene.locator, workspaceId, tabId, paneId },
  };
}

test("new scenes capture two stable ownership samples before creation succeeds", async t => {
  const f = await fixture(t), scene = await f.create();
  assert.equal(isSceneReference(scene), true);
  assert(scene.backend === "herdr" && scene.locator.kind === "herdr");
  assert.deepEqual(scene.ownership?.shell, { pid: 100, bornAt: "shell-birth" });
  assert.deepEqual(scene.ownership?.launcher, { pid: 400, bornAt: "launcher-birth" });
  assert.deepEqual(scene.ownership?.foreground, { pid: 500, bornAt: "foreground-birth" });
  assert.equal(scene.ownership?.processGroupId, 300);
  assert.equal(scene.ownership?.samples, 2);
  assert.equal(scene.ownership?.tty, "ttys001");
  assert(f.processInfoCalls() >= 2);
  assert.equal(isSceneReference({ ...scene, ownership: { ...scene.ownership, samples: 1 } }), false);
});

test("generation changes are probed first and exact stable ownership can re-anchor", async t => {
  const f = await fixture(t), scene = await f.create();
  f.restart();
  const before = f.processInfoCalls();
  const observed = await f.adapter.inspect(scene);
  assert.equal(observed.identity, "mismatch");
  assert.equal(observed.ownership, "live");
  assert.equal(observed.state, "idle");
  assert(observed.reanchor);
  assert.match(observed.reanchor.runtimeGeneration, /generation-two$/);
  assert(f.processInfoCalls() > before, "ownership is probed before the generation mismatch is final");
  const reanchored = await f.adapter.reanchor(scene);
  assert(reanchored);
  assert.equal(reanchored.runtimeGeneration, observed.reanchor.runtimeGeneration);
  assert.equal(reanchored.bindingId, scene.bindingId);
  assert.deepEqual(reanchored.ownership, scene.ownership);
  const text = "继续原负责人";
  const receipt = await f.adapter.send({
    scene: reanchored, deliveryId: "after-reanchor", text,
    payloadSha256: createHash("sha256").update(text).digest("hex"),
  });
  assert.equal(receipt.status, "started");
});

test("generation changes can never auto-classify a dead scene as ended", async t => {
  const f = await fixture(t), scene = await f.create();
  f.restart();
  f.exit();
  const observed = await f.adapter.inspect(scene);
  assert.equal(observed.identity, "mismatch");
  assert.equal(observed.ownership, "uncertain");
  assert.notEqual(observed.state, "exited");
  assert.equal(observed.reanchor, undefined);
});

test("a same-runtime pane and all process identities gone is a confirmed end", async t => {
  const f = await fixture(t), scene = await f.create();
  f.exit();
  const observed = await f.adapter.inspect(scene);
  assert.equal(observed.identity, "match");
  assert.equal(observed.ownership, "ended");
  assert.equal(observed.state, "exited");
  assert.equal(observed.reanchor, undefined);
});

test("a foreground exit with a reused pane is a confirmed ended scene", async t => {
  const f = await fixture(t), scene = await f.create();
  f.foregroundExit();
  const observed = await f.adapter.inspect(scene);
  assert.equal(observed.identity, "match");
  assert.equal(observed.state, "exited");
  assert.equal(observed.ownership, "ended");
  assert.equal(observed.reachable, false);
  assert.equal(observed.detail, "confirmed_scene_exit_with_reused_pane");
});

test("unverifiable process sampling is uncertain, never a confirmed exit", async t => {
  const f = await fixture(t), scene = await f.create();
  f.exit();
  f.unverifiable();
  const observed = await f.adapter.inspect(scene);
  assert.equal(observed.identity, "unverifiable");
  assert.equal(observed.ownership, "uncertain");
  assert.notEqual(observed.state, "exited");
});

test("re-anchor requires two identical samples", async t => {
  const f = await fixture(t), scene = await f.create();
  f.restart();
  f.armInstability();
  assert.equal(await f.adapter.reanchor(scene), undefined);
});

test("legacy v1 scenes stay legacy and a generation change never means exited", async t => {
  const f = await fixture(t), current = await f.create();
  const legacy: SceneReferenceV1 = { ...current, ownership: undefined };
  const live = await f.adapter.inspect(legacy);
  assert.equal(live.ownership, "legacy");
  assert.equal(live.identity, "match");
  f.restart();
  f.exit();
  const changed = await f.adapter.inspect(legacy);
  assert.equal(changed.ownership, "legacy");
  assert.equal(changed.identity, "mismatch");
  assert.notEqual(changed.state, "exited");
});

test("inspectMany isolates workspace and scene failures", async t => {
  const f = await fixture(t), own = await f.create();
  const isolatedWorkspace = relocated(own, "binding-w2", "w2");
  const isolatedScene = relocated(own, "binding-p3", "w1", "w1:t3", "w1:p3");
  f.failWorkspace("w2");
  f.failProcessInfo("w1:p3");
  const observed = await f.adapter.inspectMany([own, isolatedWorkspace, isolatedScene]);
  assert.equal(observed[0]?.identity, "match");
  assert.equal(observed[0]?.ownership, "live");
  assert.equal(observed[1]?.identity, "unverifiable");
  assert.equal(observed[1]?.ownership, "uncertain");
  assert.equal(observed[1]?.detail, "pane_lookup_failed");
  assert.equal(observed[2]?.identity, "unverifiable");
  assert.equal(observed[2]?.ownership, "uncertain");
  assert.equal(observed[2]?.detail, "process_info_unavailable");
});
