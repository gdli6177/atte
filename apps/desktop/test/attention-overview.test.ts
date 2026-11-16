import assert from "node:assert/strict";
import test from "node:test";
import type { Goal, WorkspaceState } from "../../../packages/core/src/types.ts";
import { attentionOverview } from "../src/features/goals/attentionOverview.ts";
import { presentGoal } from "../src/features/goals/goalPresentation.ts";

const at = "2026-11-16T00:00:00.000Z";
function goal(patch: Partial<Goal>): Goal {
  return {
    id: `goal_${Math.random()}`, projectId: "personal", title: "事项", description: "",
    mode: "concierge", status: "active", steps: [], next: "继续", owner: "负责人",
    attention: null, activities: [], createdAt: at, updatedAt: at, ...patch,
  };
}
const state = { projects: [] } as unknown as WorkspaceState;

test("home attention is split into decision, review, follow-up and intervention only", () => {
  const goals = [
    goal({ attention: { kind: "decision", summary: "选一个", since: at, source: "governance" } }),
    goal({ status: "review", attention: { kind: "review", summary: "验收", since: at },
      delivery: { summary: "成果", checks: [], submittedAt: at, submittedBy: "负责人" } }),
    goal({ status: "waiting", remindAt: "2020-01-01T00:00:00.000Z" }),
    goal({ attention: { kind: "intervention", summary: "介入", since: at, source: "live" } }),
    goal({ status: "waiting", waitingFor: "供应商", remindAt: "2099-01-01T00:00:00.000Z" }),
  ];
  const overview = attentionOverview(goals);
  assert.deepEqual(overview.groups.map(group => group.goals.length), [1, 1, 1, 1]);
  assert.equal(overview.waiting.length, 1, "unextended external waits are compact overview data, not cards");
});

test("legacy Orca history is excluded from all actionable attention and keeps its original status presentation", () => {
  const legacy = goal({
    status: "waiting", readOnly: true, readOnlyReason: "legacy-orca",
    attention: { kind: "decision", summary: "旧 Orca 决定", since: at },
  });
  const overview = attentionOverview([legacy]);
  assert.equal(overview.attention.length, 0);
  assert.equal(overview.waiting.length, 0);
  const view = presentGoal(legacy, state);
  assert.equal(view.needsDecision, false);
  assert.equal(view.label, "等待外部");
});
