import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { WorkspaceService, attentionGoals, type Goal } from "../../../packages/core/src/index.js";
import type { SessionRuntime, SceneObservation } from "../../../packages/sessions/src/index.js";
import { reconcileSceneReply, requestNeutralSceneReply } from "../electron/scene-reconciliation.js";
import { HerdrClient } from "../electron/herdr.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp("/tmp/cv-scene-check-"); roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "核对现场同步" }) as Goal;
  await service.execute({ type: "session.set", goalId: goal.id,
    reference: { session: "cv-test", agent: "owner-a", paneId: "w1:p2", tabId: "w1:t2" } });
  await service.execute({ type: "goal.decide", goalId: goal.id, question: "先交付核心功能？" });
  return { root, service, id: goal.id };
}
async function live(service: WorkspaceService, id: string, state: "working" | "done") {
  await service.execute({ type: "live.event", target: { paneId: "w1:p2" },
    presence: { state, reachable: true, checkedAt: new Date().toISOString() } });
}
test("viewing a scene alone never queues a reconciliation; a real work cycle does, once across restarts", async () => {
  const { root, service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "done");
  let calls = 0;
  const connection = { async requestSceneReply() { calls++; return true; } };
  await reconcileSceneReply(service, id, connection, { graceMs: 0 });
  assert.equal(calls, 0);
  await live(service, id, "working");
  await live(service, id, "done");
  await Promise.all([
    reconcileSceneReply(service, id, connection, { graceMs: 0 }),
    reconcileSceneReply(new WorkspaceService(root), id, connection, { graceMs: 0 }),
  ]);
  assert.equal(calls, 1);
  // Its own reconciliation round must not create an endless work/check loop.
  await live(service, id, "working");
  await live(service, id, "done");
  await reconcileSceneReply(service, id, connection, { graceMs: 0 });
  assert.equal(calls, 1);
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
});
test("legacy scene reconciliation waits through a user-interaction grace period", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  const visit = (await service.read()).goals[0]!.sceneVisit!;
  assert.ok(visit.pendingAt);
  let calls = 0;
  const connection = { async requestSceneReply() { calls++; return true; } };
  await reconcileSceneReply(service, id, connection, {
    now: () => new Date(Date.parse(visit.pendingAt!) + 59_999),
  });
  assert.equal(calls, 0);
  await reconcileSceneReply(service, id, connection, {
    now: () => new Date(Date.parse(visit.pendingAt!) + 60_000),
  });
  assert.equal(calls, 1);
});
test("hook-capable owners skip scene reconciliation and a real turn cancels the fallback", async () => {
  const { service, id } = await fixture();
  const at = new Date().toISOString();
  await service.execute({
    type: "agent.runtime.register",
    goalId: id,
    attempt: {
      goalId: id, attemptId: "attempt-hook-owner", agent: "owner-a",
      adapter: "omp", startedAt: at,
    },
    hookTokenHash: "a".repeat(64),
    capabilities: ["turn.started", "turn.settled"],
  });
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  let calls = 0;
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { calls++; return true; },
  }, {
    now: () => new Date(Date.now() + 60_000),
  });
  assert.equal(calls, 0);
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "pending");
  await service.execute({
    type: "agent.runtime.event",
    event: {
      version: "v1", eventId: "event-user-turn", sequence: 1,
      at: new Date(Date.now() + 60_001).toISOString(),
      source: "hook", agent: "owner-a", adapter: "omp", goalId: id,
      attemptId: "attempt-hook-owner", type: "turn.started", turnId: "turn-user",
      content: { text: "用户在现场提出的真实问题", sha256: "b".repeat(64), truncated: false },
    },
  });
  assert.equal((await service.read()).goals[0]!.sceneVisit, undefined);
});
test("a human message from the app cancels fallback reconciliation without resolving attention", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "pending");
  await service.execute({ type: "goal.message", goalId: id, text: "补充一个边界条件" });
  const current = (await service.read()).goals[0]!;
  assert.equal(current.sceneVisit, undefined);
  assert.ok(current.attention);
});
test("an owner's semantic receipt skips reconciliation, and failed synchronization can be explicitly retried", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working"); await live(service, id, "done");
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { throw new Error("连接中断"); },
  }, { graceMs: 0 });
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "failed");
  await service.execute({ type: "scene.visit", goalId: id, retry: true });
  await reconcileSceneReply(service, id, { async requestSceneReply(goal) {
    await service.execute({ type: "goal.scene-reply", goalId: id,
      attentionId: goal.attention!.id!, quote: "先交付核心功能。", summary: "已确认范围。", actor: "owner-a" });
    return true;
  } }, { graceMs: 0 });
  let calls = 0;
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { calls++; return true; },
  }, { graceMs: 0 });
  assert.equal(calls, 0);
  assert.equal((await service.read()).goals[0]!.sceneReply?.quote, "先交付核心功能。");
});
test("safe owner reconciliation never prompts a working, blocked, unknown or replaced CLI", async () => {
  const { service } = await fixture();
  const goal = (await service.read()).goals[0]!;
  for (const state of ["working", "blocked", "unknown", "idle", "done"]) {
    for (const replaced of [false, true]) {
      const calls: string[][] = [];
      const client = new HerdrClient({ async run(args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: [{
          name: "owner-a", pane_id: replaced ? "w1:p99" : "w1:p2", agent_status: state,
        }] } });
        return "{}";
      } }, "cv-test");
      const expected = !replaced && ["idle", "done"].includes(state);
      assert.equal(await client.requestSceneReply(goal), expected);
      const prompt = calls.find(args => args[1] === "prompt");
      assert.equal(!!prompt, expected);
      if (prompt) {
        assert.match(prompt[3]!, /不是用户的新回复/);
        assert.match(prompt[3]!, /scene-reply/);
        assert.match(prompt[3]!, new RegExp(goal.attention!.id!));
      }
    }
  }
});

test("the current session runtime sends guarded review reconciliation with the shared owner protocol", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "goal.resolve", goalId: id, note: "先交付核心功能" });
  await service.execute({
    type: "goal.review", goalId: id,
    delivery: {
      summary: "核心功能已交付。",
      checks: [{ name: "验证", command: "检查核心功能", result: "passed" }],
    },
  });
  await service.execute({ type: "scene.visit", goalId: id });
  const before = await service.read();
  const item: Goal = {
    ...before.goals[0]!,
    scene: {
      version: 1, backend: "herdr", installationId: "installation-test", backendEpoch: 1,
      bindingId: "binding-test", attemptId: "attempt-test", runtimeId: "runtime-test",
      runtimeGeneration: "generation-test",
      locator: {
        kind: "herdr", session: "cv-test", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2",
      },
    },
  };
  const sent: string[] = [];
  let observation: SceneObservation = {
    bindingId: item.scene!.bindingId, identity: "match", reachable: true,
    state: "idle", observedAt: new Date().toISOString(), source: "backend",
  };
  const runtime: Pick<SessionRuntime, "inspect" | "send"> = {
    async inspect(scenes) {
      assert.deepEqual(scenes, [item.scene]);
      return [observation];
    },
    async send(scene, deliveryId, text) {
      assert.equal(deliveryId, `scene-reconcile-${item.sceneVisit!.id}`);
      sent.push(text);
      return {
        status: "started", scene, deliveryId,
        payloadSha256: "a".repeat(64), at: new Date().toISOString(),
      };
    },
  };
  assert.equal(await requestNeutralSceneReply(runtime, item), true);
  assert.match(sent[0]!, /不是用户的新回复，不是继续执行的授权/);
  assert.ok(sent[0]!.includes(item.attention!.id!));
  assert.match(sent[0]!, /--attention-id <attentionRequest.id>/);
  assert.match(sent[0]!, /用户本轮完整原话/);
  assert.match(sent[0]!, /review→rework→active/);
  assert.match(sent[0]!, /普通提问.*review/);
  assert.match(sent[0]!, /不得.*goal accept/);
  assert.doesNotMatch(sent[0]!, /如果尚未处理，继续当前工作/);
  for (const state of ["working", "blocked", "unknown", "exited"] as const) {
    observation = { ...observation, state };
    assert.equal(await requestNeutralSceneReply(runtime, item), false);
  }
  for (const identity of ["mismatch", "unverifiable"] as const) {
    observation = { ...observation, state: "idle", identity };
    assert.equal(await requestNeutralSceneReply(runtime, item), false);
  }
  observation = { ...observation, identity: "match", reachable: false };
  assert.equal(await requestNeutralSceneReply(runtime, item), false);
  observation = { ...observation, reachable: true };
  assert.equal(await requestNeutralSceneReply(runtime, {
    ...item, sceneVisit: { ...item.sceneVisit!, attentionId: "old-attention" },
  }), false);
  assert.equal(await requestNeutralSceneReply(runtime, { ...item, readOnly: true }), false);
  assert.equal(sent.length, 1);
  assert.deepEqual(await service.read(), before);
});
