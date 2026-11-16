import { attentionGoals, attentionKind } from "../../../../../packages/core/src/model.js";
import { isReadOnlyGoal } from "../../../../../packages/core/src/retirement.js";
import type { Goal } from "../../../../../packages/core/src/types.js";

export const attentionCategories = [
  { kind: "decision", title: "需要你决定", empty: "没有待决定的事项。" },
  { kind: "review", title: "等待你验收", empty: "没有待验收的交付。" },
  { kind: "follow_up", title: "到期跟进", empty: "提醒会在到期时出现在这里。" },
  { kind: "intervention", title: "Agent 需要介入", empty: "Agent 暂时不需要你介入。" },
] as const;

export function attentionOverview(goals: Goal[]) {
  const writable = goals.filter(goal => !isReadOnlyGoal(goal));
  const attention = attentionGoals(writable);
  const groups = attentionCategories.map(category => ({
    ...category,
    goals: attention.filter(goal => attentionKind(goal) === category.kind),
  }));
  const waiting = writable.filter(goal => goal.status === "waiting" && !attention.includes(goal));
  const active = writable.filter(goal => goal.status === "active" && goal.mode === "concierge");
  const nextReminder = waiting.map(goal => goal.remindAt).filter((at): at is string =>
    Boolean(at) && Date.parse(at!) > Date.now()).sort((first, second) => Date.parse(first) - Date.parse(second))[0];
  return { attention, groups, waiting, active, nextReminder };
}
