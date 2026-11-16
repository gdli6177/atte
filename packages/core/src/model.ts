import type {
  Attention,
  AttentionKind,
  Goal,
  GoalKind,
  ProjectPolicy,
  WorkspaceRecovery,
  WorkspaceState,
} from "./types.js";
import { hasDueReminder } from "./task-pool.js";
import { isReadOnlyGoal } from "./retirement.js";
export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const defaultProjectPolicy = (): ProjectPolicy => ({
  shipPolicy: "external-approval",
  approvers: [],
  revision: 1,
  updatedAt: new Date().toISOString(),
});
export const initialState = (recovery?: WorkspaceRecovery): WorkspaceState => ({
  version: 5,
  backendEpoch: 0,
  name: "我的工作台",
  projects: [{
    id: "personal",
    name: "个人事项",
    policy: defaultProjectPolicy(),
    createdAt: new Date().toISOString(),
  }],
  workflows: [],
  goals: [],
  decisions: [],
  watchdog: { noProgressMinutes: 30 },
  ...(recovery ? { recovery } : {}),
  concierge: { session: "atte", status: "not_ready" },
});
export const goalKind = (goal: Goal): GoalKind => goal.kind ?? "delivery";
export const goalRevision = (goal: Goal) => goal.revision ?? 1;
export function attentionGoals(goals: Goal[], now = Date.now()): Goal[] {
  return goals.filter((goal) => attentionKind(goal, now)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
export function attentionKind(goal: Goal, now = Date.now()): AttentionKind | undefined {
  if (isReadOnlyGoal(goal)) return undefined;
  if (["completed", "dropped"].includes(goal.status)) return undefined;
  if (goal.attention) return goal.attention.kind;
  return hasDueReminder(goal, now) ? "follow_up" : undefined;
}
export function attentionRequest(goal: Goal, now = Date.now()): (Attention & { id: string }) | undefined {
  if (isReadOnlyGoal(goal)) return undefined;
  if (["completed", "dropped"].includes(goal.status)) return undefined;
  if (goal.attention) return {
    ...goal.attention,
    // Stable identity for pre-existing questions; a newly raised question
    // always gets its own random ID, even within the same millisecond.
    id: goal.attention.id ?? `legacy_${goal.id}_${Date.parse(goal.attention.since)}`,
  };
  if (attentionKind(goal, now) === "follow_up") return {
    id: `reminder_${goal.id}_${Date.parse(goal.remindAt!)}`,
    kind: "follow_up", summary: goal.next, since: goal.remindAt!,
  };
}
export function pendingSceneReply(goal: Goal) {
  return goal.mode === "concierge" && goal.sceneReply?.attentionId === attentionRequest(goal)?.id
    ? goal.sceneReply
    : undefined;
}
