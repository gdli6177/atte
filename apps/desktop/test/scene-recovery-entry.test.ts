import assert from "node:assert/strict";
import test from "node:test";
import type { Goal } from "../../../packages/core/src/types.js";
import { goalSceneLabel, needsSceneRecovery } from "../src/features/goals/goalEntry.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal_one", projectId: "personal", title: "目标", description: "目标",
    mode: "concierge", status: "active", steps: [], next: "继续", owner: "owner",
    activities: [], createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z",
    attention: null,
    ...overrides,
  } as Goal;
}

const scene = {
  version: 1, backend: "herdr", installationId: "install", backendEpoch: 0,
  runtimeId: "runtime", runtimeGeneration: "generation", bindingId: "binding",
  attemptId: "attempt",
  locator: { kind: "herdr", session: "s", workspaceId: "w", tabId: "w:t", paneId: "w:p" },
} as Goal["scene"];

const handoff = {
  operationId: "op", status: "skipped", method: "deferred", at: "2026-11-16T00:00:00Z",
} as NonNullable<Goal["backendHandoff"]>;

test("an unreachable scene and a delivered handoff both ask for explicit recovery", () => {
  for (const value of [
    goal({ scene, live: { state: "unknown", reachable: false, checkedAt: "2026-11-16T00:00:00Z" } }),
    goal({ backendHandoff: handoff }),
  ]) {
    assert.equal(needsSceneRecovery(value), true);
    assert.equal(goalSceneLabel(value), "恢复并进入现场");
  }
});

test("a live scene opens directly and a goal without any scene asks for the concierge", () => {
  const live = goal({ scene, live: { state: "idle", reachable: true, checkedAt: "2026-11-16T00:00:00Z" } });
  assert.equal(needsSceneRecovery(live), false);
  assert.equal(goalSceneLabel(live), "回到现场");
  const plain = goal();
  assert.equal(needsSceneRecovery(plain), false);
  assert.equal(goalSceneLabel(plain), "找管家");
});
