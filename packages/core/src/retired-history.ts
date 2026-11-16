import type { Goal, WorkspaceRetiredHistory, WorkspaceState } from "./types.js";
import { isReadOnlyGoal } from "./retirement.js";

export function retireWorkspaceFeatures(
  state: WorkspaceState,
  sourceVersion: 2 | 3 | 4,
): WorkspaceState {
  const retiredAt = new Date().toISOString();
  const orcaWorkspace = state.backendBinding?.backend === "orca";
  const orcaConcierge = orcaWorkspace || state.concierge.scene?.backend === "orca";
  const preferences = state.agents as (typeof state.agents & { worker?: string });
  const projects = state.projects.filter(project =>
    project.autonomy !== undefined || project.releaseOnMerge !== undefined).map(project => ({
    projectId: project.id,
    ...(project.autonomy ? { autonomy: structuredClone(project.autonomy) } : {}),
    ...(project.releaseOnMerge ? { releaseOnMerge: project.releaseOnMerge } : {}),
  }));
  const history: WorkspaceRetiredHistory = {
    retiredAt,
    sourceVersion,
    ...(state.autonomy ? { autonomy: structuredClone(state.autonomy) } : {}),
    ...(state.bots ? { bots: structuredClone(state.bots) } : {}),
    ...(state.botRequests ? { botRequests: structuredClone(state.botRequests) } : {}),
    ...(preferences?.worker !== undefined ? { worker: preferences.worker } : {}),
    ...(projects.length ? { projects } : {}),
    ...(orcaConcierge ? {
      ...(state.backendBinding ? { backendBinding: structuredClone(state.backendBinding) } : {}),
      concierge: structuredClone(state.concierge),
    } : {}),
  };
  state.history = history;
  state.watchdog = {
    noProgressMinutes: Number.isSafeInteger(state.autonomy?.noProgressMinutes) &&
      state.autonomy!.noProgressMinutes > 0
      ? state.autonomy!.noProgressMinutes
      : state.watchdog?.noProgressMinutes ?? 30,
  };
  delete state.autonomy;
  delete state.bots;
  delete state.botRequests;
  if (state.agents) state.agents = {
    concierge: state.agents.concierge,
    ...(state.agents.owner?.trim() ? { owner: state.agents.owner.trim() } : {}),
  };
  for (const project of state.projects) {
    delete project.autonomy;
    delete project.releaseOnMerge;
  }
  for (const goal of state.goals) {
    const humanAcceptance = goal.acceptance?.kind === "human"
      ? goal.acceptance
      : goal.autonomy?.acceptance?.kind === "human"
        ? goal.autonomy.acceptance
        : undefined;
    const readOnly = isReadOnlyGoal(goal) ||
      orcaWorkspace && goal.mode === "concierge" && goal.status !== "backlog";
    const experimental = Boolean(goal.brief || goal.autonomy || goal.release ||
      goal.kind !== undefined && goal.kind !== "delivery" && goal.kind !== "discovery" ||
      goal.dispatch?.kind === "continuation" || goal.dispatch?.kind === "verification");
    const retired = experimental || readOnly || Boolean(goal.delivery) || goal.skills !== undefined ||
      goal.skillResolutions !== undefined || goal.acceptance !== undefined;
    if (retired) goal.history = {
      retiredAt,
      ...(goal.kind ? { kind: goal.kind } : {}),
      ...(goal.brief ? { brief: structuredClone(goal.brief) } : {}),
      ...(goal.briefHistory ? { briefHistory: structuredClone(goal.briefHistory) } : {}),
      ...(goal.autonomy ? { autonomy: structuredClone(goal.autonomy) } : {}),
      ...(goal.release ? { release: structuredClone(goal.release) } : {}),
      ...(goal.acceptance ? { acceptance: structuredClone(goal.acceptance) } : {}),
      ...(goal.skills ? { skills: structuredClone(goal.skills) } : {}),
      ...(goal.skillResolutions ? { skillResolutions: structuredClone(goal.skillResolutions) } : {}),
      ...(goal.dispatch ? { dispatch: structuredClone(goal.dispatch) } : {}),
      ...(goal.attention ? { attention: structuredClone(goal.attention) } : {}),
    };
    if (humanAcceptance) goal.acceptance = structuredClone(humanAcceptance);
    else delete goal.acceptance;
    delete goal.brief;
    delete goal.briefHistory;
    delete goal.autonomy;
    delete goal.release;
    delete goal.skills;
    delete goal.skillResolutions;
    if (goal.kind !== "discovery") goal.kind = "delivery";
    if (readOnly) {
      goal.readOnly = true;
      goal.readOnlyReason = "legacy-orca";
      delete goal.dispatch;
      delete goal.watchdog;
      delete goal.recovery;
      delete goal.sceneVisit;
      cancelRetiredExecution(goal);
      continue;
    }
    goal.revision ??= 1;
    if (goal.dispatch?.kind === "continuation" || goal.dispatch?.kind === "verification")
      delete goal.dispatch;
    if (["dropped", "backlog"].includes(goal.status)) continue;
    if (goal.delivery && !humanAcceptance) {
      goal.status = "review";
      goal.attention = {
        id: `migration_review_${goal.id}`,
        kind: "review",
        summary: "已有交付已保留，请核对真实检查和证据并人工验收。",
        since: retiredAt,
      };
      goal.next = "查看原交付、检查和证据，验收通过或退回修改。";
      delete goal.waitingFor;
      delete goal.remindAt;
      delete goal.dispatch;
      cancelRetiredExecution(goal);
      continue;
    }
    if (["completed", "review"].includes(goal.status)) continue;
    if (experimental) {
      goal.executionHold = "migration-confirmation";
      goal.status = "active";
      goal.attention = {
        id: `migration_confirm_${goal.id}`,
        kind: "decision",
        summary: "实验功能已退役；是否按普通目标继续？请先确认原目标、已有成果和下一步。",
        since: retiredAt,
        source: "governance",
        decisionKey: `migration-confirmation:${goal.id}`,
      };
      goal.next = "等待你确认是否按普通目标继续；尚未恢复执行。";
      delete goal.dispatch;
      delete goal.waitingFor;
      delete goal.remindAt;
      cancelRetiredExecution(goal);
    }
  }
  if (orcaConcierge) {
    state.concierge = { session: "atte", status: "not_ready" };
    delete state.backendBinding;
  }
  state.version = 5;
  return state;
}

function cancelRetiredExecution(goal: Goal) {
  delete goal.watchdog;
  delete goal.recovery;
  delete goal.sceneVisit;
  const receipt = goal.agentRuntime?.receipt;
  if (receipt && receipt.status !== "written") receipt.status = "cancelled";
}
