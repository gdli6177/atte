import type { AtteCommand, Goal } from "./types.js";

export class FeatureRemovedError extends Error {
  readonly code = "feature_removed" as const;
  constructor(readonly feature: string, readonly command?: string) {
    super(`feature_removed: ${feature} 已在 Atte 0.14 退役；历史记录仍可读取。`);
    this.name = "FeatureRemovedError";
  }
}

const retiredCommands = new Map<string, string>([
  ["workspace.autonomy.set", "autonomy"],
  ["project.autonomy.set", "autonomy"],
  ["goal.brief", "autonomy"],
  ["goal.checkpoint", "continuation"],
  ["goal.reopen", "reopen"],
  ["goal.verify", "independent-verifier"],
  ["goal.verification.site", "independent-verifier"],
  ["backend.revoke", "backend-switch"],
  ["backend.commit", "backend-switch"],
  ["backend.activate", "backend-switch"],
  ["backend.handoff", "backend-switch"],
  ["workflow.save", "workflow"],
]);

export function assertFeatureAvailable(command: AtteCommand): void {
  const type = command.type;
  const feature = retiredCommands.get(type) ??
    (type.startsWith("bot.") ? "bot" :
      type.startsWith("release.") ? "release-goal" :
        type.startsWith("autonomy.") || type.startsWith("goal.autonomy.") ? "autonomy" :
          type.startsWith("goal.boundary") ? "boundary-change" :
            type.startsWith("goal.skill.") || type.startsWith("skill.") ? "local-capability-pack" :
              undefined);
  if (feature) throw new FeatureRemovedError(feature, type);
  if ((type === "goal.create" && command.input?.mode === "manual") ||
    ((type === "goal.intake" || type === "goal.direct") && command.handling === "self"))
    throw new FeatureRemovedError("manual-task-creation", type);
  const kind = type === "goal.create" ? command.input?.kind
    : type === "goal.intake" || type === "goal.direct" || type === "goal.kind.set"
      ? command.kind : undefined;
  if ((kind as string | undefined) === "release") throw new FeatureRemovedError("release-goal", type);
  if ((type === "goal.create" && command.input?.workflowId) ||
    (type === "goal.update" && command.patch?.stageId !== undefined) ||
    (type === "goal.progress" && command.stageId !== undefined))
    throw new FeatureRemovedError("workflow", type);
  if (type === "agents.configure" && command.preferences && "worker" in command.preferences)
    throw new FeatureRemovedError("worker-preference", type);
  if ((type === "scene.prepare" && command.intent?.role === "verifier") ||
    ((type === "scene.bind" || type === "scene.launch.result" || type === "scene.release") &&
      command.role === "verifier") || command.managedContext?.role === "verifier")
    throw new FeatureRemovedError("independent-verifier", type);
  if ((type === "backend.register" || type === "backend.commit") && command.binding?.backend === "orca" ||
    type === "scene.bind" && command.scene?.backend === "orca" ||
    type === "agent.runtime.register" && command.attempt?.scene?.backend === "orca" ||
    command.managedContext?.backend === "orca")
    throw new FeatureRemovedError("orca", type);
  if (type === "goal.dispatch" &&
    (command.kind === "continuation" || command.kind === "verification"))
    throw new FeatureRemovedError(command.kind, type);
}

export function isReadOnlyGoal(goal: Goal): boolean {
  return goal.readOnly === true ||
    goal.readOnlyReason === "legacy-orca" ||
    goal.readOnlyReason === "legacy-epoch" ||
    goal.scene?.backend === "orca" ||
    goal.agentRuntime?.attempt.scene?.backend === "orca" ||
    goal.ownerLaunchRecovery?.scene?.backend === "orca";
}

export class ReadOnlyGoalError extends Error {
  readonly code = "goal_read_only" as const;
  constructor(readonly goalId: string) {
    super(`goal_read_only: 旧后端目标 ${goalId} 仅供读取，不能修改、派发或恢复执行。`);
    this.name = "ReadOnlyGoalError";
  }
}

export function assertGoalWritable(goal: Goal): void {
  if (isReadOnlyGoal(goal)) throw new ReadOnlyGoalError(goal.id);
}

export function goalCanExecute(goal: Goal): boolean {
  return !isReadOnlyGoal(goal) && !goal.executionHold && goal.mode === "concierge" &&
    ["active", "waiting", "review"].includes(goal.status);
}
