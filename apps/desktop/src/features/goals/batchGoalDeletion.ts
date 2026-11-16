import type { AtteCommand, Goal } from "../../../../../packages/core/src/types.js";

type FinishedGoal = Pick<Goal, "id" | "title" | "status">;

export async function deleteFinishedGoals(
  goals: FinishedGoal[],
  command: (command: AtteCommand) => Promise<unknown>,
) {
  const deleted: string[] = [];
  const failed: { goalId: string; title: string; reason: unknown }[] = [];
  for (const goal of goals) {
    if (goal.status !== "completed" && goal.status !== "dropped") continue;
    try {
      await command({ type: "goal.delete", goalId: goal.id });
      deleted.push(goal.id);
    } catch (reason) {
      failed.push({ goalId: goal.id, title: goal.title, reason });
    }
  }
  return { deleted, failed };
}
