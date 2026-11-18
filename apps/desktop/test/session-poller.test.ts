import test from "node:test";
import assert from "node:assert/strict";
import { SessionPoller } from "../electron/session-poller.js";
import type { SceneReferenceV1 } from "../../../packages/core/src/index.js";
import type { SceneObservation } from "../../../packages/sessions/src/index.js";

const ownership = {
  version: 1 as const,
  samples: 2 as const,
  capturedAt: "2026-11-17T00:00:00.000Z",
  shell: { pid: 101, bornAt: "2026-11-17T00:00:00.000Z" },
  launcher: { pid: 102, bornAt: "2026-11-17T00:00:00.000Z" },
  foreground: { pid: 103, bornAt: "2026-11-17T00:00:00.000Z" },
  processGroupId: 101,
  tty: "/dev/ttys001",
};

function scene(
  bindingId: string,
  options: {
    runtimeId?: string;
    runtimeGeneration?: string;
    session?: string;
    workspaceId?: string;
    owned?: boolean;
  } = {},
): SceneReferenceV1 {
  const workspaceId = options.workspaceId ?? "w1";
  return {
    version: 1,
    backend: "herdr",
    installationId: "installation",
    backendEpoch: 1,
    runtimeId: options.runtimeId ?? "runtime",
    runtimeGeneration: options.runtimeGeneration ?? "generation",
    bindingId,
    attemptId: `attempt-${bindingId}`,
    ...(options.owned ? { ownership } : {}),
    locator: {
      kind: "herdr",
      session: options.session ?? "atte",
      workspaceId,
      tabId: `${workspaceId}:t-${bindingId}`,
      paneId: `${workspaceId}:p-${bindingId}`,
    },
  };
}

function healthy(scene: SceneReferenceV1, now: number): SceneObservation {
  return {
    bindingId: scene.bindingId,
    identity: "match",
    reachable: true,
    state: "idle",
    observedAt: new Date(now).toISOString(),
    source: "backend",
  };
}

const scenes = Array.from({ length: 100 }, (_, index) => scene(`binding-${index}`));
test("ten minutes of routine observation stays one batch per ten seconds regardless of goal count", async () => {
  let now = 0, calls = 0;
  const poller = new SessionPoller(() => now);
  const read = async (batch: SceneReferenceV1[]): Promise<SceneObservation[]> => {
    calls++;
    return batch.map(scene => healthy(scene, now));
  };
  for (now = 0; now < 600_000; now += 100) await poller.inspect(scenes, read);
  assert.equal(calls, 60);
});
test("transport failure backs off thirty then sixty seconds; explicit reset probes immediately", async () => {
  let now = 0, calls = 0;
  const poller = new SessionPoller(() => now);
  const offline = async (): Promise<SceneObservation[]> => {
    calls++;
    return [{ bindingId: scenes[0]!.bindingId, identity: "unverifiable", reachable: false,
      state: "unknown", observedAt: new Date(now).toISOString(), source: "backend" }];
  };
  const first = await poller.inspect(scenes, offline);
  assert.equal(first?.length, 1);
  assert.equal(first?.[0]?.bindingId, scenes[0]!.bindingId);
  now = 29_999;
  assert.equal(await poller.inspect(scenes, offline), undefined);
  now = 30_000;
  await poller.inspect(scenes, offline);
  now = 89_999;
  assert.equal(await poller.inspect(scenes, offline), undefined);
  now = 90_000;
  await poller.inspect(scenes, offline);
  assert.equal(calls, 3);
  poller.reset();
  await poller.inspect(scenes, offline);
  assert.equal(calls, 4);
});
test("mixed runtime generations are read as independent groups", async () => {
  let now = 0;
  const reads: string[][] = [];
  const poller = new SessionPoller(() => now);
  const mixed = [
    scene("old-a", { runtimeGeneration: "generation-a" }),
    scene("new", { runtimeGeneration: "generation-b" }),
    scene("old-b", { runtimeGeneration: "generation-a" }),
  ];
  const observations = await poller.inspect(mixed, async batch => {
    reads.push(batch.map(item => item.bindingId));
    return batch.map(item => healthy(item, now));
  });
  assert.deepEqual(reads, [["old-a", "old-b"], ["new"]]);
  assert.deepEqual(observations?.map(item => item.bindingId), ["old-a", "new", "old-b"]);
  assert(observations?.every(item => item.identity === "match"));
});
test("different Herdr workspaces are read and scheduled independently", async () => {
  let now = 0;
  const reads: string[][] = [];
  const poller = new SessionPoller(() => now);
  const workspaces = [
    scene("w1-a", { workspaceId: "w1" }),
    scene("w2-a", { workspaceId: "w2" }),
    scene("w1-b", { workspaceId: "w1" }),
  ];
  const observations = await poller.inspect(workspaces, async batch => {
    reads.push(batch.map(item => item.bindingId));
    return batch.map(item => healthy(item, now));
  });
  assert.deepEqual(reads, [["w1-a", "w1-b"], ["w2-a"]]);
  assert.deepEqual(observations?.map(item => item.bindingId), ["w1-a", "w2-a", "w1-b"]);
});
test("one workspace failure returns restricted unknowns without hiding healthy groups", async () => {
  const now = 1_000;
  const poller = new SessionPoller(() => now);
  const failedLegacy = scene("failed-legacy", { workspaceId: "w1" });
  const failedOwned = scene("failed-owned", { workspaceId: "w1", owned: true });
  const healthyScene = scene("healthy", { workspaceId: "w2", owned: true });
  const input = [failedLegacy, failedOwned, healthyScene];
  const before = structuredClone(input);
  const reads: string[][] = [];
  const observations = await poller.inspect(input, async batch => {
    reads.push(batch.map(item => item.bindingId));
    if (batch[0]?.locator.kind === "herdr" && batch[0].locator.workspaceId === "w1")
      throw new Error("fixture workspace unavailable");
    return batch.map(item => healthy(item, now));
  });
  assert.deepEqual(reads, [["failed-legacy", "failed-owned"], ["healthy"]]);
  assert.deepEqual(input, before);
  assert.equal(observations?.length, 3);
  assert.deepEqual(observations?.[0], {
    bindingId: "failed-legacy",
    identity: "unverifiable",
    reachable: false,
    state: "unknown",
    ownership: "legacy",
    observedAt: new Date(now).toISOString(),
    source: "backend",
    detail: "session_poll_failed",
  });
  assert.deepEqual(observations?.[1], {
    bindingId: "failed-owned",
    identity: "unverifiable",
    reachable: false,
    state: "unknown",
    ownership: "uncertain",
    observedAt: new Date(now).toISOString(),
    source: "backend",
    detail: "session_poll_failed",
  });
  assert.deepEqual(observations?.[2], healthy(healthyScene, now));
  assert(observations?.every(item => !("reanchor" in item)));
});
test("simultaneous ticks share the in-flight group", async () => {
  const poller = new SessionPoller();
  let calls = 0, release!: (observations: SceneObservation[]) => void;
  const read = () => { calls++; return new Promise<SceneObservation[]>(resolve => { release = resolve; }); };
  const first = poller.inspect(scenes, read), second = poller.inspect(scenes, read);
  release([]);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
test("simultaneous ticks coalesce each runtime workspace group", async () => {
  const poller = new SessionPoller(() => 0);
  const input = [scene("w1", { workspaceId: "w1" }), scene("w2", { workspaceId: "w2" })];
  const calls: string[][] = [];
  const releases = new Map<string, () => void>();
  const read = (batch: SceneReferenceV1[]) => new Promise<SceneObservation[]>(resolve => {
    const workspace = batch[0]!.locator.kind === "herdr" ? batch[0]!.locator.workspaceId : "missing";
    calls.push(batch.map(item => item.bindingId));
    releases.set(workspace, () => resolve(batch.map(item => healthy(item, 0))));
  });
  const first = poller.inspect(input, read), second = poller.inspect(input, read);
  assert.deepEqual(calls, [["w1"], ["w2"]]);
  releases.get("w1")?.();
  releases.get("w2")?.();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(calls.length, 2);
});
test("a failed group keeps its own backoff without suppressing a healthy group", async () => {
  let now = 0;
  const poller = new SessionPoller(() => now);
  const failedScene = scene("failed", { workspaceId: "w1" });
  const healthyScene = scene("healthy", { workspaceId: "w2" });
  const calls = { w1: 0, w2: 0 };
  const read = async (batch: SceneReferenceV1[]): Promise<SceneObservation[]> => {
    const workspace = batch[0]!.locator.kind === "herdr" ? batch[0]!.locator.workspaceId : "missing";
    if (workspace === "w1") {
      calls.w1++;
      throw new Error("fixture failure");
    }
    calls.w2++;
    return batch.map(item => healthy(item, now));
  };
  await poller.inspect([failedScene, healthyScene], read);
  assert.deepEqual(calls, { w1: 1, w2: 1 });

  now = 10_000;
  const observations = await poller.inspect([failedScene, healthyScene], read);
  assert.deepEqual(calls, { w1: 1, w2: 2 });
  assert.deepEqual(observations?.map(item => item.bindingId), ["healthy"]);

  now = 30_000;
  await poller.inspect([failedScene], read);
  assert.equal(calls.w1, 2);
  now = 89_999;
  assert.equal(await poller.inspect([failedScene], read), undefined);
  now = 90_000;
  await poller.inspect([failedScene], read);
  assert.equal(calls.w1, 3);
});

test("legacy non-Herdr scenes are never observed or migrated", async () => {
  let calls = 0;
  const poller = new SessionPoller(() => 0);
  const orca = {
    ...scenes[0]!,
    backend: "orca" as const,
    locator: {
      kind: "orca" as const, repoId: "repo", worktreeId: "repo::/tmp/fixture",
      terminalHandle: "terminal", executionHostId: "local", incarnationId: "incarnation",
    },
  };
  await assert.rejects(poller.inspect([orca], async () => { calls++; return []; }), /旧后端现场保持只读/);
  assert.equal(calls, 0);
  await assert.rejects(
    poller.inspect([scenes[0]!, orca], async () => { calls++; return []; }),
    /旧后端现场保持只读/,
  );
  assert.equal(calls, 0);
});
