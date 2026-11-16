import type { Goal, WorkspaceState } from "../../../packages/core/src/index.js";

/** Activity kinds an owner can only produce through an explicit status command. */
const semanticKinds = new Set<Goal["activities"][number]["kind"]>([
  "progress", "waiting", "decision", "delivery", "resolved", "verification", "release",
]);

function isOwnerWrite(activity: Goal["activities"][number]): boolean {
  const actor = activity.actor ?? "";
  return !actor.startsWith("系统") && !actor.startsWith("管家") && !actor.startsWith("你");
}

/**
 * A managed owner runs a separate CLI process and writes `state.json`
 * directly, so no renderer IPC happens for its progress/decision/delivery.
 * The desktop watches the state file; without this observer only the periodic
 * patrol would ever notice such a write.
 *
 * The observer is intentionally conservative: it only starts coordination for
 * goals that are still live, have no queued dispatch, and gained an owner
 * semantic activity since the last observed snapshot. Seeded history is never
 * replayed, and ordinary progress does not create attention.
 */
export class OwnerWriteObserver {
  private readonly seen = new Set<string>();

  constructor(private readonly options: {
    onWrite(goal: Goal, activityId: string): void;
  }) {}

  /** Records existing history so restarting the app never replays old writes. */
  seed(state: WorkspaceState) {
    for (const goal of state.goals)
      for (const activity of goal.activities) this.seen.add(`${goal.id}:${activity.id}`);
  }

  observe(state: WorkspaceState) {
    for (const goal of state.goals) {
      if (goal.mode !== "concierge" ||
        ["completed", "dropped", "backlog"].includes(goal.status)) continue;
      if (goal.dispatch?.status === "pending") continue;
      const fresh = goal.activities.filter(activity =>
        semanticKinds.has(activity.kind) && isOwnerWrite(activity) &&
        !this.seen.has(`${goal.id}:${activity.id}`));
      for (const activity of fresh) this.seen.add(`${goal.id}:${activity.id}`);
      if (!fresh.length || goal.attention) continue;
      for (const activity of fresh) this.options.onWrite(goal, activity.id);
    }
  }
}
