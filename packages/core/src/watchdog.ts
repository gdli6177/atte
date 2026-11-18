import { newId } from "./model.js";
import type { Goal, WatchdogReason } from "./types.js";
import { goalCanExecute } from "./retirement.js";

const DEFAULT_NO_PROGRESS_MINUTES = 30;
const OWNER_START_GRACE = 60_000;
const SETTLED_AFTER = 90_000;
const HEALTH_FRESH = 2 * 60_000;
const RETRY_AFTER = 5 * 60_000;
const NUDGE_AFTER = 30 * 60_000;
const MAX_NUDGE_FAILURES = 3;
const BUSINESS_WRITES = new Set([
  "progress", "waiting", "decision", "delivery", "delivery_amend", "resolved", "ship",
]);
export interface WatchdogRequest {
  goalId: string;
  reason: WatchdogReason;
  basis: string;
  backgroundOnly?: boolean;
}
const NON_OWNER_ACTORS = new Set(["系统", "你", "管家", "concierge", "巡检"]);
function latestProgress(goal: Goal) {
  return goal.activities.filter(activity => activity.kind !== "watchdog").at(-1);
}
function timestamp(value: string | undefined) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}
// Staleness measures the owner's own last write, not any workspace write.
// A concierge reconciliation note is bookkeeping; letting it move the basis
// would postpone the check forever and let each note trigger another round.
export function progressBasis(goal: Goal, ceiling = Number.POSITIVE_INFINITY) {
  const candidates = [
    goal.createdAt,
    goal.dispatch?.at,
    goal.agentRuntime?.attempt.startedAt,
    ...goal.activities.filter(activity =>
      BUSINESS_WRITES.has(activity.kind) && !NON_OWNER_ACTORS.has(activity.actor)
    ).map(activity => activity.at),
  ].map(timestamp).filter((value): value is number =>
    value !== undefined && value <= ceiling);
  return new Date(Math.max(0, ...candidates)).toISOString();
}
function ownerReportedCurrentDispatch(goal: Goal) {
  const dispatchedAt = Date.parse(
    goal.dispatch?.at ?? goal.agentRuntime?.attempt.startedAt ?? goal.createdAt,
  );
  if (Number.isFinite(Date.parse(goal.agentRuntime?.lastSemanticWriteAt ?? "")) &&
    Date.parse(goal.agentRuntime!.lastSemanticWriteAt!) >= dispatchedAt)
    return true;
  return goal.activities.some(activity =>
    !["系统", "你", "管家", "concierge", "巡检"].includes(activity.actor) &&
    BUSINESS_WRITES.has(activity.kind) &&
    Date.parse(activity.at) >= dispatchedAt);
}
function fresh(now: number, at: string | undefined) {
  const parsed = timestamp(at);
  return parsed !== undefined && now - parsed <= HEALTH_FRESH;
}
function concise(value: string, limit = 180) {
  const characters = Array.from(value.replace(/\s+/g, " ").trim());
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : characters.join("");
}
function reasonLabel(reason: WatchdogReason, noProgressMinutes?: number) {
  return reason === "unassigned" ? "尚未登记独立负责人现场"
    : reason === "blocked" ? "负责人正在等待输入或批准"
      : reason === "missing" ? "负责人现场不可达"
        : reason === "protocol_missing" ? "负责人已停止但未按协议写回结果"
        : reason === "settled" ? "负责人已停止输出但尚未写回结果"
          : noProgressMinutes === undefined
            ? "目标长时间没有写回实质进展"
            : `目标 ${noProgressMinutes} 分钟没有写回实质进展`;
}
function inspectable(goal: Goal) {
  return goalCanExecute(goal) && goal.status === "active";
}
function record(goal: Goal, at: string, text: string) {
  goal.activities.push({ id: newId("act"), at, actor: "巡检", kind: "watchdog", text });
  goal.updatedAt = at;
}
function reasonFor(
  goal: Goal,
  now: number,
  staleAfter: number,
  basis = progressBasis(goal, now),
): WatchdogReason | undefined {
  const age = now - Date.parse(basis);
  const liveFresh = fresh(now, goal.live?.checkedAt);
  const liveWorking = liveFresh && goal.live?.state === "working" &&
    goal.live.reachable !== false;
  if (goal.agentRuntime?.receipt?.status === "protocol_missing")
    return "protocol_missing";
  if (!goal.scene && !goal.herdr?.paneId && !goal.herdr?.agent && goal.dispatch?.status !== "pending" &&
    now - Date.parse(goal.dispatch?.at ?? goal.createdAt) >= OWNER_START_GRACE) return "unassigned";
  if (goal.agentRuntime?.lastEventType === "agent.blocked" &&
    fresh(now, goal.agentRuntime.lastEventAt) &&
    !(liveWorking && Date.parse(goal.live!.checkedAt) >= Date.parse(goal.agentRuntime.lastEventAt)) &&
    now - Date.parse(goal.agentRuntime.lastEventAt) >= 5_000) return "blocked";
  if (liveFresh && goal.live?.state === "blocked") return "blocked";
  if (liveFresh && goal.live?.reachable === false && age >= OWNER_START_GRACE) return "missing";
  const receipt = goal.agentRuntime?.receipt;
  if (receipt && ["waiting", "reminding", "reminded"].includes(receipt.status) &&
    now <= Date.parse(receipt.inspectAt) + 15_000)
    return;
  // A quiet terminal may hold an unrecorded result or an unrecognized input
  // prompt. It is not evidence of delivery, failure or completion. Ask the
  // concierge to reconcile the actual owner, rather than guessing from text.
  if (goal.live?.reachable === true && ["idle", "done"].includes(goal.live.state) &&
    now - Date.parse(goal.live.stateSince ?? goal.live.checkedAt) >= SETTLED_AFTER &&
    receipt?.status !== "written" && !ownerReportedCurrentDispatch(goal))
    return "settled";
  if (age >= staleAfter) return "stale";
}
export function inspectWatchdog(
  goals: Goal[],
  at: string,
  noProgressMinutes = DEFAULT_NO_PROGRESS_MINUTES,
): WatchdogRequest[] {
  const staleAfter =
      Math.max(1, Math.trunc(noProgressMinutes)) * 60_000,
    now = Date.parse(at),
    requests: WatchdogRequest[] = [];
  for (const goal of goals) {
    if (!inspectable(goal) ||
      (goal.attention && goal.attention.source !== "watchdog" && goal.attention.source !== "live")) continue;
    const basis = progressBasis(goal, now), reason = reasonFor(goal, now, staleAfter, basis);
    if (!reason) {
      if (goal.attention?.source === "watchdog" || goal.attention?.source === "live") goal.attention = null;
      delete goal.watchdog;
      delete goal.recovery;
      continue;
    }
    if (!goal.watchdog || goal.watchdog.reason !== reason || goal.watchdog.basis !== basis) {
      const previousReason = goal.watchdog?.reason;
      goal.watchdog = { reason, basis, detectedAt: at };
      // Keep a card that still describes the same issue; only a new kind of
      // problem replaces it. Resolved issues are cleared above.
      if ((goal.attention?.source === "watchdog" || goal.attention?.source === "live") &&
        previousReason && previousReason !== reason) goal.attention = null;
      if (reason === "settled" && goal.live?.reachable && ["idle", "done"].includes(goal.live.state))
        goal.recovery = goal.live.state as "idle" | "done";
      else delete goal.recovery;
    }
    const watch = goal.watchdog;
    if (watch.escalatedAt) continue;
    const interval = watch.lastError ? RETRY_AFTER : NUDGE_AFTER;
    if (!watch.attemptedAt || now - Date.parse(watch.attemptedAt) >= interval)
      requests.push({
        goalId: goal.id,
        reason,
        basis,
        ...(reason === "stale" ? { backgroundOnly: true } : {}),
      });
  }
  return requests;
}
export function reportWatchdog(goal: Goal, at: string, basis: string, outcome: "contacted" | "failed", detail?: string) {
  const watch = goal.watchdog;
  if (!watch || !inspectable(goal) || watch.basis !== basis ||
    progressBasis(goal, Date.parse(at)) !== basis) return;
  watch.attemptedAt = at;
  if (outcome === "contacted") {
    watch.contactedAt ??= at;
    watch.nudgeFailures = 0;
    delete watch.lastError;
    delete watch.escalatedAt;
    delete goal.recovery;
    // A retry clears only the failure card this patrol created. A pre-existing
    // human-facing card still describes the unresolved issue and stays until a
    // later inspection finds the owner healthy or the user answers it.
    if (goal.attention?.source === "watchdog") goal.attention = null;
    record(goal, at, "已请管家核查负责人及下一步，暂不打扰你。");
  } else {
    watch.nudgeFailures = (watch.nudgeFailures ?? 0) + 1;
    watch.lastError = detail || "管家暂时不可达";
    delete goal.recovery;
    if (watch.nudgeFailures < MAX_NUDGE_FAILURES) {
      record(goal, at, `联系管家失败（${watch.nudgeFailures}/${MAX_NUDGE_FAILURES}）：${watch.lastError}`);
      return;
    }
    watch.escalatedAt = at;
    if (!goal.attention) {
      const progress = latestProgress(goal);
      const lastProgress = progress
        ? `${progress.actor}：${concise(progress.text)}`
        : "没有可用的历史进展";
      goal.attention = {
        id: newId("attention"),
        kind: "intervention", source: "watchdog", since: at,
        summary: `目标「${goal.title}」${reasonLabel(watch.reason)}。最后进展：${lastProgress}。巡检连续 ${MAX_NUDGE_FAILURES} 次未能联系管家，请查看现场或恢复管家。`,
      };
    }
    record(goal, at, `连续 ${MAX_NUDGE_FAILURES} 次联系管家失败：${watch.lastError}。现请你查看现场。`);
  }
}
