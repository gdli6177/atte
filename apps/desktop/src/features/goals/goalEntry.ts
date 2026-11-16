import { attentionKind } from "../../../../../packages/core/src/model.js";
import { isReadOnlyGoal } from "../../../../../packages/core/src/retirement.js";
import type { Goal } from "../../../../../packages/core/src/types.js";

export type GoalEntryDestination = "scene" | "attention" | "details" | "task";

export function hasGoalScene(goal: Goal) {
  return Boolean(goal.scene || goal.herdr?.tabId || goal.herdr?.paneId || goal.herdr?.agent);
}
/** True when opening the scene must create a fresh owner instead of reusing one. */
export function needsSceneRecovery(goal: Goal) {
  if (isReadOnlyGoal(goal)) return false;
  return Boolean(goal.scene && goal.live?.reachable === false) ||
    (!hasGoalScene(goal) && Boolean(goal.backendHandoff));
}

export function goalSceneLabel(goal: Goal) {
  if (isReadOnlyGoal(goal)) return "查看历史记录";
  return needsSceneRecovery(goal) ? "恢复并进入现场" : hasGoalScene(goal) ? "回到现场" : "找管家";
}

export function goalEntryDestination(goal: Goal): GoalEntryDestination {
  if (isReadOnlyGoal(goal)) return "details";
  const kind = attentionKind(goal);
  if (goal.status === "backlog" ||
    goal.mode === "manual" && goal.status !== "review" && !hasGoalScene(goal) &&
      (!kind || kind === "follow_up")) return "task";
  if (goal.status === "completed" || goal.status === "dropped") return "details";
  if (goal.attention?.source === "dispatch") return "attention";
  if (kind === "decision" || kind === "review" || kind === "follow_up") return "attention";
  if (goal.scene && goal.live?.reachable === false) return "details";
  if (kind === "intervention") return hasGoalScene(goal) ? "scene" : "attention";
  if (goal.status === "active" && hasGoalScene(goal)) return "scene";
  return "details";
}
