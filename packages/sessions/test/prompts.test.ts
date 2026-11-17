import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal } from "../../core/src/index.js";
import { goalNotificationPrompt } from "../src/prompts.js";

test("a persisted scene reply instructs the concierge to resolve the exact decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-prompts-"));
  const at = "2030-01-01T08:00:00.000Z";
  const goal: Goal = {
    id: "goal_prompt",
    projectId: "personal",
    title: "现场决定",
    description: "选择方案",
    mode: "concierge",
    status: "active",
    steps: [],
    next: "选择方案 A 或 B",
    owner: "独立负责人",
    attention: {
      id: "attention_prompt",
      kind: "decision",
      summary: "采用方案 A 还是 B？",
      since: at,
    },
    sceneReply: {
      id: "reply_prompt",
      attentionId: "attention_prompt",
      quote: "采用方案 A，先确认最小范围。",
      summary: "已选择方案 A。",
      actor: "owner-a",
      at,
    },
    activities: [],
    createdAt: at,
    updatedAt: at,
  };
  try {
    const prompt = await goalNotificationPrompt(root, goal);
    assert.match(prompt, /不要再次调用 scene-reply/);
    assert.match(prompt, /atte goal resolve goal_prompt/);
    assert.match(prompt, /--attention-id attention_prompt/);
    assert.match(prompt, /--scene-reply-id reply_prompt/);
    assert.match(prompt, /--note "采用方案 A，先确认最小范围。"/);
    assert.match(prompt, /普通 progress 不会关闭注意力/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a review scene reply asks for guarded rework before forwarding and keeps acceptance human", async context => {
  const root = await mkdtemp(join(tmpdir(), "atte-review-prompt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "盘点重复能力" }) as Goal;
  await service.execute({
    type: "session.set", goalId: goal.id,
    reference: { session: "test", paneId: "w1:p2", agent: "owner-a" },
  });
  const reviewed = await service.execute({
    type: "goal.review", goalId: goal.id,
    delivery: {
      summary: "盘点已完成。",
      checks: [{ name: "核对", command: "检查入口", result: "passed" }],
    },
  }) as Goal;
  const quote = "顺着结论合并重复入口，并补齐兼容性验证。";
  const reply = await service.execute({
    type: "goal.scene-reply", goalId: goal.id, attentionId: reviewed.attention!.id!,
    quote, summary: "收到新增执行要求。", actor: "owner-a",
  }) as Goal;
  const prompt = await goalNotificationPrompt(root, reply);
  const instruction = prompt.split("[ATTE_CASE_END]")[1]!;
  assert.ok(instruction.includes(`atte goal rework ${goal.id}`));
  assert.ok(instruction.includes(`--note ${JSON.stringify(quote)}`));
  assert.ok(instruction.includes(`--attention-id ${reviewed.attention!.id}`));
  assert.ok(instruction.includes(`--scene-reply-id ${reply.sceneReply!.id}`));
  assert.match(instruction, /先更新整体标题/);
  assert.match(instruction, /普通提问.*review/);
  assert.match(instruction, /验收.*人/);
  assert.ok(!instruction.includes(`atte goal resolve ${goal.id}`));
  assert.match(prompt, /由负责人.*goal message/);
  assert.doesNotMatch(prompt, /--handling self/);
});
