import assert from "node:assert/strict";
import test from "node:test";
import type { Goal, WorkspaceState } from "../../../packages/core/src/index.js";
import { OwnerWriteObserver } from "../electron/owner-write-observer.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal_one", projectId: "personal", title: "排查", description: "排查",
    mode: "concierge", status: "active", steps: [], next: "等管家核对",
    owner: "owner-tapsession", activities: [], createdAt: "2026-11-16T00:00:00Z",
    updatedAt: "2026-11-16T00:00:00Z",
    dispatch: { id: "handoff_one", status: "sent", at: "2026-11-16T00:00:00Z" },
    ...overrides,
  } as Goal;
}

function activity(id: string, kind: Goal["activities"][number]["kind"], actor = "owner-tapsession") {
  return { id, at: "2026-11-16T00:01:00Z", actor, kind, text: "结果" };
}

function state(goals: Goal[]): WorkspaceState {
  return { goals } as WorkspaceState;
}

test("an owner progress write recorded by a separate CLI starts coordination once", () => {
  const calls: string[] = [];
  const observer = new OwnerWriteObserver({ onWrite: (goal, activityId) => calls.push(`${goal.id}:${activityId}`) });
  const before = goal();
  observer.seed(state([before]));
  assert.deepEqual(calls, []);
  const after = goal({ activities: [activity("act_1", "progress")] });
  observer.observe(state([after]));
  observer.observe(state([after]));
  assert.deepEqual(calls, ["goal_one:act_1"]);
});

test("a delivery write is reported once per recorded activity", () => {
  const calls: string[] = [];
  const observer = new OwnerWriteObserver({ onWrite: (goal, activityId) => calls.push(`${goal.id}:${activityId}`) });
  observer.seed(state([goal()]));
  observer.observe(state([goal({
    status: "review",
    delivery: { id: "delivery_one", summary: "交付", checks: [], evidence: [], submittedAt: "2026-11-16T00:02:00Z", submittedBy: "owner" } as Goal["delivery"],
    activities: [activity("act_2", "delivery")],
  })]));
  assert.deepEqual(calls, ["goal_one:act_2"]);
});

test("history seeded at startup, concierge notes, system events and queued dispatches never notify", () => {
  const calls: string[] = [];
  const observer = new OwnerWriteObserver({ onWrite: goal => calls.push(goal.id) });
  const historical = goal({ activities: [activity("act_old", "progress")] });
  observer.seed(state([historical]));
  observer.observe(state([goal({ activities: [
    activity("act_old", "progress"),
    activity("act_concierge", "progress", "管家"),
    activity("act_system", "session", "系统"),
    activity("act_you", "progress", "你"),
  ] })]));
  observer.observe(state([goal({
    dispatch: { id: "handoff_two", status: "pending", at: "2026-11-16T00:03:00Z" },
    activities: [activity("act_pending", "progress")],
  })]));
  assert.deepEqual(calls, []);
});

test("goals needing the human already in attention are not turned into coordinator work", () => {
  const calls: string[] = [];
  const observer = new OwnerWriteObserver({ onWrite: goal => calls.push(goal.id) });
  observer.seed(state([goal()]));
  observer.observe(state([goal({
    status: "review",
    attention: { id: "attention_one", kind: "review", summary: "请验收", since: "2026-11-16T00:04:00Z" },
    activities: [activity("act_review", "delivery")],
  })]));
  assert.deepEqual(calls, []);
});

test("finished and manual goals never start coordinator work", () => {
  const calls: string[] = [];
  const observer = new OwnerWriteObserver({ onWrite: goal => calls.push(goal.id) });
  observer.seed(state([]));
  observer.observe(state([
    goal({ id: "done", status: "completed", activities: [activity("act_a", "progress")] }),
    goal({ id: "manual", mode: "manual", activities: [activity("act_b", "progress")] }),
  ]));
  assert.deepEqual(calls, []);
});
