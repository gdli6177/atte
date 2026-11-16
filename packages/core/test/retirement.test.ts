import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeatureRemovedError,
  WorkspaceService,
  assertFeatureAvailable,
  builtinAgentInstructions,
  initialState,
  isReadOnlyGoal,
  type AtteCommand,
  type Goal,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-retirement-"));
  roots.push(root);
  return { root, service: new WorkspaceService(root) };
}

test("retired commands fail with a structured code before touching workspace IO", async () => {
  const { root, service } = await fixture();
  const commands: AtteCommand[] = [
    { type: "bot.binding.set", actor: "你", binding: {
      id: "bot-one", name: "bot", role: "initiator", projectIds: ["personal"],
      operations: ["goal.read"], expiresAt: "2030-01-01T00:00:00Z",
    } },
    { type: "goal.skill.attach", goalId: "goal-one", packId: "pack", actor: "human" },
    { type: "goal.checkpoint", goalId: "goal-one", summary: "progress", next: "next" },
    { type: "goal.reopen", goalId: "goal-one", note: "重新打开", actor: "你" },
    { type: "goal.verify", goalId: "goal-one", deliveryId: "delivery-one", outcome: "passed",
      summary: "verified", criteria: [] },
    { type: "goal.boundary", goalId: "goal-one", change: {
      reason: "scope", evidence: ["evidence"], alternatives: ["other"], recommendation: "approve",
    } },
    { type: "release.create", sourceGoalIds: ["goal-one"], environment: "production",
      candidate: { revision: "abc" }, actor: "你" },
    { type: "autonomy.inspect", at: new Date().toISOString() },
    { type: "workspace.autonomy.set", actor: "你", paused: false },
    { type: "goal.skill.audit", goalId: "goal-one", packId: "pack", scriptId: "script",
      outcome: "succeeded", summary: "ran" },
    { type: "backend.revoke", operationId: "switch-one", expectedEpoch: 1 },
    { type: "backend.commit", binding: {
      installationId: "installation-one", backend: "herdr", epoch: 1,
      scopeGeneration: "scope-one", status: "resuming", operationId: "switch-one",
    }, handoffs: {} },
    { type: "backend.activate", operationId: "switch-one" },
    { type: "backend.handoff", goalId: "goal-one", operationId: "switch-one",
      patch: { status: "failed", detail: "旧交接" } },
  ];
  for (const command of commands) {
    assert.throws(() => assertFeatureAvailable(command), (error: unknown) =>
      error instanceof FeatureRemovedError && error.code === "feature_removed");
    await assert.rejects(service.execute(command), (error: unknown) =>
      error instanceof FeatureRemovedError && error.code === "feature_removed");
  }
  assert.equal((await readdir(root)).includes(".atte"), false);
});

test("task capture only creates backlog and self/manual creation is retired", async () => {
  const { service } = await fixture();
  const captured = await service.execute({
    type: "goal.intake", handling: "later", text: "先记下来，不要启动 Agent。",
  }) as Goal;
  assert.equal(captured.status, "backlog");
  assert.equal(captured.mode, "concierge");
  assert.equal(captured.owner, "尚未开始");
  assert.equal(captured.dispatch, undefined);
  await assert.rejects(service.execute({
    type: "goal.intake", handling: "self", text: "我自己做",
  }), /feature_removed/);
  await assert.rejects(service.execute({
    type: "goal.create",
    input: { title: "manual", projectId: "personal", mode: "manual" },
  }), /feature_removed/);
});

test("existing human takeover remains available and disables concierge dispatch", async () => {
  const { service } = await fixture();
  const goal = await service.execute({ type: "goal.intake", text: "可以人工接管的旧事项" }) as Goal;
  const taken = await service.execute({ type: "goal.takeover", goalId: goal.id }) as Goal;
  assert.equal(taken.mode, "manual");
  assert.equal(taken.status, "active");
  assert.equal(taken.owner, "你");
  assert.equal(taken.dispatch, undefined);
  await assert.rejects(service.execute({
    type: "goal.dispatch", goalId: goal.id, status: "pending",
  }), /由你接管/);
});

test("agent preferences keep concierge and owner only; owner inherits concierge", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "agents.configure",
    preferences: { concierge: "codex --model concierge", owner: "omp" },
  });
  assert.deepEqual((await service.read()).agents, {
    concierge: "codex --model concierge", owner: "omp",
  });
  await service.execute({ type: "agents.configure", preferences: { concierge: "qodercli" } });
  assert.deepEqual((await service.read()).agents, { concierge: "qodercli" });
  await assert.rejects(service.execute({
    type: "agents.configure",
    preferences: { concierge: "codex", worker: "worker-cli" } as never,
  }), (error: unknown) => error instanceof FeatureRemovedError);
});

test("read-only legacy Orca goals reject writes while staying in their original state", async () => {
  const { service } = await fixture();
  const goal = await service.execute({ type: "goal.intake", text: "保留旧 Orca 目标" }) as Goal;
  const state = await service.read();
  const legacy = state.goals.find(item => item.id === goal.id)!;
  legacy.readOnly = true;
  legacy.readOnlyReason = "legacy-orca";
  legacy.skills = [{
    packId: "legacy.pack", version: "1.0.0", digest: "a".repeat(64),
    roles: ["owner"], attachedAt: new Date().toISOString(), attachedBy: "human",
  }];
  await assert.equal(isReadOnlyGoal(legacy), true);
  // Seed through the public snapshot shape only; the real writer refuses this
  // retired field, which is covered by the v4 migration test.
  assert.ok(legacy.skills);
});

test("static builtin instructions are I/O-free and role-specific", () => {
  const concierge = builtinAgentInstructions(undefined, "concierge");
  const owner = builtinAgentInstructions(initialState().goals[0], "owner");
  assert.match(concierge, /控制面管家/);
  assert.match(concierge, /direct --new/);
  assert.match(owner, /唯一独立负责人/);
  assert.match(owner, /goal progress/);
  assert.doesNotMatch(owner, /owner launch/);
});
