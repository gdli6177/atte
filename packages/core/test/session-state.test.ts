import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initialState, isSceneReference, sameScene, WorkspaceService, WorkspaceStore,
  type Goal, type SceneReferenceV1, type ManagedSessionContext,
} from "../src/index.js";

const scene = (attemptId = "attempt-one"): Extract<SceneReferenceV1, { backend: "herdr" }> => ({
  version: 1, backend: "herdr", installationId: "installation-one",
  runtimeId: "runtime-one", runtimeGeneration: "runtime-one:birth-one",
  bindingId: `binding-${attemptId}`, attemptId, backendEpoch: 1,
  locator: {
    kind: "herdr", session: "atte-test", workspaceId: "w1",
    tabId: `w1:t-${attemptId}`, paneId: `w1:p-${attemptId}`,
  },
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atte-session-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceService(root);
  const item = await service.execute({ type: "goal.intake", text: "保留原始事项与决定。" }) as Goal;
  return { root, service, item };
}
async function register(service: WorkspaceService) {
  await service.execute({
    type: "backend.register",
    binding: {
      installationId: "installation-one", backend: "herdr", epoch: 1,
      scopeGeneration: "scope-one", status: "active",
    },
  });
}
test("v3 migration backs up bytes before v5 and never invents runtime identity", async t => {
  const { root, service, item } = await fixture(t);
  await service.execute({ type: "goal.decide", goalId: item.id, question: "确认方案？", actor: "owner" });
  const state = await service.read();
  const legacy = {
    ...state, version: 3,
    goals: state.goals.map(goal => ({
      ...goal, herdr: { session: "old", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    })),
  };
  const raw = JSON.stringify(legacy);
  await writeFile(join(root, ".atte/state.json"), raw);
  const migrated = await new WorkspaceStore(root).read();
  assert.equal(migrated.version, 5);
  assert.equal(migrated.backendEpoch, 0);
  assert.equal(migrated.goals[0]?.id, item.id);
  assert.deepEqual(migrated.goals[0]?.attention, state.goals[0]?.attention);
  assert.deepEqual(migrated.goals[0]?.activities, state.goals[0]?.activities);
  assert.equal(migrated.goals[0]?.scene, undefined);
  assert.equal(migrated.goals[0]?.legacyScene?.verification, "unverified");
  assert.equal(migrated.goals[0]?.legacyScene?.reference.paneId, "w1:p1");
  assert.equal(migrated.goals[0]?.herdr, undefined);
  assert.equal(await readFile(join(root, ".atte/state.v3.backup.json"), "utf8"), raw);
  assert.deepEqual(await service.read(), migrated);
});
test("backup conflict or unsafe backup stops migration without overwriting the snapshot", async t => {
  const { root, service } = await fixture(t);
  const raw = JSON.stringify({ ...await service.read(), version: 4 });
  const stateFile = join(root, ".atte/state.json");
  const backup = join(root, ".atte/state.v4.backup.json");
  await writeFile(stateFile, raw);
  await writeFile(backup, "{}");
  await assert.rejects(service.read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
  await rm(backup);
  await symlink(stateFile, backup);
  await assert.rejects(service.read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
});
test("scene schema rejects a backend/locator mismatch and PID reuse is a different identity", () => {
  const current = scene();
  assert.equal(isSceneReference(current), true);
  assert.equal(isSceneReference({ ...current, backend: "orca" }), false);
  assert.equal(isSceneReference({ ...current, locator: { ...current.locator, paneId: "" } }), false);
  assert.equal(sameScene(current, { ...current, runtimeGeneration: "restarted" }), false);
  assert.equal(sameScene(current, { ...current, locator: { ...current.locator, paneId: "w1:new" } }), false);
});
test("current owner can write its case but not another goal or from a stale epoch", async t => {
  const { root, service, item } = await fixture(t);
  await register(service);
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: { goalId: item.id, attemptId: "attempt-one", agent: "owner-one", adapter: "custom", startedAt: new Date().toISOString() },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  const context: ManagedSessionContext = {
    installationId: "installation-one", backend: "herdr", epoch: 1,
    scopeGeneration: "scope-one", role: "owner", goalId: item.id, attemptId: "attempt-one",
  };
  const owner = new WorkspaceService(root, context);
  await owner.execute({ type: "goal.progress", goalId: item.id, summary: "核对磁盘后已回报。", actor: "owner-one" });
  await assert.rejects(owner.execute({ type: "goal.progress", goalId: "other", summary: "越界" }), /自己的目标/);
  await assert.rejects(new WorkspaceService(root, {
    ...context,
    scopeGeneration: "old-scope",
  }).execute({
    type: "goal.progress", goalId: item.id, summary: "迟到",
  }), /stale_backend_epoch/);
});
test("repeated lifecycle observation does not add activities or change the business progress time", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  const before = (await service.read()).goals[0]!;
  const observation = {
    type: "scene.observe" as const,
    scenes: [{ bindingId: scene().bindingId, presence: { state: "idle" as const, reachable: true, checkedAt: new Date().toISOString() } }],
  };
  await service.execute(observation);
  const once = (await service.read()).goals[0]!;
  for (let i = 0; i < 20; i++) await service.execute(observation);
  const after = (await service.read()).goals[0]!;
  assert.deepEqual(after, once);
  assert.equal(after.status, "active");
  assert.deepEqual(after.activities, before.activities);
  assert.equal(after.updatedAt, before.updatedAt);
});
test("legacy concierge status observations preserve the neutral scene and pending launch identity", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", scene: scene("concierge-one") });
  const before = (await service.read()).concierge;
  await service.execute({ type: "concierge.status", status: "not_ready", reference: before, detail: "准备中" });
  await service.execute({ type: "concierge.status", status: "ready",
    live: { state: "idle", reachable: true, checkedAt: new Date().toISOString() } });
  const after = (await service.read()).concierge;
  assert.deepEqual(after.scene, before.scene);
  assert.deepEqual(after.launch, before.launch);
});
test("neutral concierge initialization does not need a second legacy readiness write", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", scene: scene("concierge-one") });
  const attemptId = (await service.read()).concierge.scene!.attemptId;
  await service.execute({ type: "scene.concierge.status", status: "ready", initializedAttemptId: attemptId });
  const initialized = (await service.read()).concierge;
  assert.equal(initialized.initializedAttemptId, attemptId);
  assert.equal(initialized.scene?.backend, "herdr");
  // Opening the scene only focuses it; it must not downgrade this receipt to
  // the legacy Herdr status channel. The packaged terminal smoke covers IPC.
  assert.deepEqual((await service.read()).concierge, initialized);
});

const ownedScene = (
  generation = "runtime-one:birth-one",
): Extract<SceneReferenceV1, { backend: "herdr" }> => {
  const launcher = { pid: 4242, bornAt: "2026-11-17T00:00:00.000Z" };
  return {
    ...scene(),
    runtimeGeneration: generation,
    ownership: {
      version: 1,
      samples: 2,
      capturedAt: "2026-11-17T00:01:00.000Z",
      shell: { pid: 4240, bornAt: "2026-11-17T00:00:00.000Z" },
      launcher,
      foreground: { pid: 4243, bornAt: "2026-11-17T00:00:05.000Z" },
      processGroupId: 4242,
      tty: "ttys001",
    },
  };
};

test("safe runtime re-anchor keeps binding, attempt, attention, and delivery", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", goalId: item.id, scene: ownedScene() });
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: {
      goalId: item.id, attemptId: "attempt-one", agent: "owner-one",
      adapter: "custom", startedAt: new Date().toISOString(),
    },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  const reviewed = await service.execute({
    type: "goal.review", goalId: item.id,
    delivery: {
      summary: "稳定现场下的交付。",
      checks: [{ name: "入口核对", command: "核对入口", result: "passed" }],
    },
  }) as Goal;
  const nextScene = {
    ...structuredClone(ownedScene("runtime-one:birth-two")),
    runtimeId: "runtime-two",
  };
  const reanchored = await service.execute({
    type: "scene.reanchor", goalId: item.id,
    bindingId: reviewed.scene!.bindingId,
    attemptId: reviewed.scene!.attemptId,
    scene: nextScene,
  }) as SceneReferenceV1;
  assert.equal(reanchored.bindingId, reviewed.scene!.bindingId);
  assert.equal(reanchored.attemptId, reviewed.scene!.attemptId);
  assert.equal(reanchored.runtimeGeneration, "runtime-one:birth-two");
  const after = (await service.read()).goals.find(goal => goal.id === item.id)!;
  assert.deepEqual(after.attention, reviewed.attention);
  assert.deepEqual(after.delivery, reviewed.delivery);
  assert.equal(after.status, "review");
  assert.equal(after.description, reviewed.description);
  assert.deepEqual(after.agentRuntime?.attempt.scene, nextScene);
  assert.equal(after.activities.at(-1)?.kind, "session");
  assert.match(after.activities.at(-1)?.text ?? "", /安全重绑/);
});

test("re-anchor rejects stale or mismatched ownership without partial writes", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  const current = ownedScene();
  await service.execute({ type: "scene.bind", goalId: item.id, scene: current });
  const before = await service.read();
  const attempts: unknown[] = [
    {
      type: "scene.reanchor", goalId: item.id,
      bindingId: current.bindingId, attemptId: "attempt-other",
      scene: ownedScene("runtime-one:birth-two"),
    },
    {
      type: "scene.reanchor", goalId: item.id,
      bindingId: current.bindingId, attemptId: current.attemptId,
      scene: {
        ...ownedScene("runtime-one:birth-two"),
        locator: { ...current.locator, paneId: "w1:p-moved" },
      },
    },
    {
      type: "scene.reanchor", goalId: item.id,
      bindingId: current.bindingId, attemptId: current.attemptId,
      scene: { ...ownedScene("runtime-one:birth-two"), ownership: undefined },
    },
    {
      type: "scene.reanchor", goalId: item.id,
      bindingId: current.bindingId, attemptId: current.attemptId,
      scene: {
        ...ownedScene("runtime-one:birth-two"),
        process: { pid: 9999, bornAt: "2026-11-17T00:00:00.000Z" },
      },
    },
    ...[
      { foreground: { pid: 9999, bornAt: "another-agent" } },
      { shell: { pid: 8888, bornAt: "another-shell" } },
      { processGroupId: 7777 },
      { tty: "ttys999" },
    ].map(change => ({
      type: "scene.reanchor", goalId: item.id,
      bindingId: current.bindingId, attemptId: current.attemptId,
      scene: {
        ...ownedScene("runtime-one:birth-two"),
        ownership: { ...current.ownership, ...change },
      },
    })),
  ];
  for (const command of attempts) {
    await assert.rejects(service.execute(command as never), /scene_identity_mismatch/);
    assert.deepEqual(await service.read(), before);
  }
});

test("retirement rejects a concurrent owner write inside the state lock", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  const current = ownedScene();
  await service.execute({ type: "scene.bind", goalId: item.id, scene: current });
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: {
      goalId: item.id, attemptId: current.attemptId, agent: "owner-one",
      adapter: "custom", startedAt: new Date().toISOString(),
    },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  const previous = (await service.read()).goals[0]!.agentRuntime!;
  await service.execute({
    type: "goal.progress", goalId: item.id, actor: "owner-one",
    summary: "退出核对期间仍然有真实业务写回。",
  });
  const before = await service.read();
  await assert.rejects(service.execute({
    type: "scene.retire", goalId: item.id,
    bindingId: current.bindingId, attemptId: current.attemptId,
    expectedActivity: {
      lastEventAt: previous.lastEventAt,
      lastSemanticWriteAt: previous.lastSemanticWriteAt,
    },
  }), /新的 Hook 或负责人写回/);
  assert.deepEqual(await service.read(), before);
});

test("legacy retirement refuses fresh Hook, semantic, or working evidence", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: {
      goalId: item.id, attemptId: "attempt-one", agent: "owner-one",
      adapter: "custom", startedAt: "2026-11-17T00:00:00.000Z",
    },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  const now = new Date().toISOString();
  const evidence = [
    { lastEventAt: now, lastSemanticWriteAt: undefined, live: undefined },
    { lastEventAt: "2026-11-17T00:00:00.000Z", lastSemanticWriteAt: now, live: undefined },
    {
      lastEventAt: "2026-11-17T00:00:00.000Z",
      lastSemanticWriteAt: undefined,
      live: { state: "working" as const, reachable: true, checkedAt: now },
    },
  ];
  for (const fresh of evidence) {
    await service.store.update("test.fresh-evidence", state => {
      const goal = state.goals.find(candidate => candidate.id === item.id)!;
      goal.agentRuntime!.lastEventAt = fresh.lastEventAt;
      if (fresh.lastSemanticWriteAt) goal.agentRuntime!.lastSemanticWriteAt = fresh.lastSemanticWriteAt;
      else delete goal.agentRuntime!.lastSemanticWriteAt;
      if (fresh.live) goal.live = fresh.live;
      else delete goal.live;
    });
    const before = await service.read();
    await assert.rejects(service.execute({
      type: "scene.legacy.confirm", goalId: item.id,
      bindingId: (await service.read()).goals[0]!.scene!.bindingId,
      attemptId: (await service.read()).goals[0]!.scene!.attemptId,
      reason: "看起来已经退出了",
    }), /新鲜的 Hook 或负责人写回/);
    assert.deepEqual(await service.read(), before);
  }
  await service.store.update("test.owned-legacy", state => {
    state.goals.find(candidate => candidate.id === item.id)!.scene = ownedScene();
  });
  const owned = await service.read();
  await assert.rejects(service.execute({
    type: "scene.legacy.confirm", goalId: item.id,
    bindingId: owned.goals[0]!.scene!.bindingId,
    attemptId: owned.goals[0]!.scene!.attemptId,
    reason: "误按旧现场处理",
  }), /稳定进程证据/);
  assert.deepEqual(await service.read(), owned);
});

test("confirmed legacy retirement only retires the attempt and never closes the pane", async t => {
  const { service, item } = await fixture(t);
  await register(service);
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: {
      goalId: item.id, attemptId: "attempt-one", agent: "owner-one",
      adapter: "custom", startedAt: "2026-11-17T00:00:00.000Z",
    },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  const reviewed = await service.execute({
    type: "goal.review", goalId: item.id,
    delivery: {
      summary: "旧现场的交付仍然保留。",
      checks: [{ name: "入口核对", command: "核对入口", result: "passed" }],
    },
  }) as Goal;
  await service.store.update("test.age-legacy", state => {
    const goal = state.goals.find(candidate => candidate.id === item.id)!;
    goal.agentRuntime!.lastEventAt = "2026-11-17T00:00:00.000Z";
    delete goal.agentRuntime!.lastSemanticWriteAt;
    delete goal.live;
  });
  await service.execute({
    type: "scene.legacy.confirm", goalId: item.id,
    bindingId: reviewed.scene!.bindingId,
    attemptId: reviewed.scene!.attemptId,
    reason: "人已确认旧终端退出",
  });
  const after = (await service.read()).goals.find(goal => goal.id === item.id)!;
  assert.equal(after.scene, undefined);
  assert.equal(after.agentRuntime, undefined);
  assert.equal(after.status, "review");
  assert.deepEqual(after.attention, reviewed.attention);
  assert.deepEqual(after.delivery, reviewed.delivery);
  assert.equal(after.description, reviewed.description);
  assert.equal(after.attemptHistory?.at(-1)?.attemptId, "attempt-one");
  assert.equal(after.attemptHistory?.at(-1)?.reason, "superseded");
  assert.equal(after.sceneHistory?.at(-1)?.bindingId, reviewed.scene!.bindingId);
  assert.match(after.activities.at(-1)?.text ?? "", /未关闭或杀死旧 Pane/);
});
