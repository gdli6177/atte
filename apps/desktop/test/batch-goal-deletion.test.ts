import assert from "node:assert/strict";
import test from "node:test";
import { deleteFinishedGoals } from "../src/features/goals/batchGoalDeletion.js";

test("batch deletion continues after a failure, reports only real deletions, and skips unfinished goals", async () => {
  const failure = new Error("负责人现场关闭失败");
  const attempted: string[] = [];
  const result = await deleteFinishedGoals([
    { id: "failed", title: "需要重试", status: "completed" },
    { id: "active", title: "仍在推进", status: "active" },
    { id: "review", title: "等待验收", status: "review" },
    { id: "completed", title: "已完成", status: "completed" },
    { id: "dropped", title: "已放弃", status: "dropped" },
  ], async command => {
    assert.equal(command.type, "goal.delete");
    if (command.type !== "goal.delete") throw new Error("Unexpected command");
    attempted.push(command.goalId);
    if (command.goalId === "failed") throw failure;
  });
  assert.deepEqual(attempted, ["failed", "completed", "dropped"]);
  assert.deepEqual(result.deleted, ["completed", "dropped"]);
  assert.deepEqual(result.failed, [{ goalId: "failed", title: "需要重试", reason: failure }]);
});

test("batch deletion waits for each goal cleanup before starting the next one", async () => {
  let releaseFirst!: () => void;
  const firstCleanup = new Promise<void>(resolve => { releaseFirst = resolve; });
  const attempted: string[] = [];
  const pending = deleteFinishedGoals([
    { id: "first", title: "第一个", status: "completed" },
    { id: "second", title: "第二个", status: "completed" },
  ], async command => {
    if (command.type !== "goal.delete") throw new Error("Unexpected command");
    attempted.push(command.goalId);
    if (command.goalId === "first") await firstCleanup;
  });
  assert.deepEqual(attempted, ["first"]);
  releaseFirst();
  assert.deepEqual((await pending).deleted, ["first", "second"]);
});
