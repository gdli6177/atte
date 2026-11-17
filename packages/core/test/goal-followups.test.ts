import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type AtteCommand,
  type Goal,
  type ManagedSessionContext,
} from "../src/index.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atte-followups-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceService(root);
  const request = "盘点现有体系，找出重复能力。\n先给出结论，再讨论具体改进。";
  const goal = await service.execute({ type: "goal.intake", text: request }) as Goal;
  await service.execute({
    type: "backend.register",
    binding: {
      installationId: "installation-followup", backend: "herdr", epoch: 1,
      scopeGeneration: "scope-followup", status: "active",
    },
  });
  const managed: ManagedSessionContext = {
    installationId: "installation-followup", backend: "herdr", epoch: 1,
    scopeGeneration: "scope-followup", role: "concierge", goalId: goal.id,
  };
  const reviewed = await service.execute({
    type: "goal.review", goalId: goal.id,
    delivery: {
      summary: "已完成体系盘点。",
      checks: [{ name: "入口核对", command: "核对现有能力入口", result: "passed" }],
    },
  }) as Goal;
  return { service, concierge: new WorkspaceService(root, managed), reviewed, request };
}

test("a scope title change is audited without replacing the request or accepting its delivery", async context => {
  const { service, concierge, reviewed, request } = await fixture(context);
  const title = "精简重复能力并统一执行入口";
  const changed = await concierge.execute({
    type: "goal.update", goalId: reviewed.id, patch: { title }, actor: "concierge",
  }) as Goal;
  assert.equal(changed.title, title);
  assert.equal(changed.description, request);
  assert.equal(changed.status, "review");
  assert.deepEqual(changed.attention, reviewed.attention);
  assert.deepEqual(changed.delivery, reviewed.delivery);
  assert.deepEqual(changed.deliveryHistory, reviewed.deliveryHistory);
  assert.deepEqual(changed.activities.slice(0, -1), reviewed.activities);
  assert.equal(changed.activities.at(-1)?.kind, "progress");
  assert.equal(changed.activities.at(-1)?.actor, "concierge");
  assert.ok(changed.activities.at(-1)?.text.includes(reviewed.title));
  assert.ok(changed.activities.at(-1)?.text.includes(title));
  assert.equal(changed.revision, reviewed.revision! + 1);
  const unchanged = await concierge.execute({
    type: "goal.update", goalId: reviewed.id,
    patch: { title, next: "等待用户确认改进范围" },
  }) as Goal;
  assert.equal(unchanged.activities.at(-1)?.text, "已更新目标说明与下一步。");
  assert.equal(unchanged.activities.at(-1)?.actor, "concierge");
  assert.deepEqual((await service.read()).goals[0], unchanged);
});

test("review progress and status edits explain the explicit rework command and remain atomic", async context => {
  const { service, reviewed } = await fixture(context);
  const before = await service.read();
  const commands: AtteCommand[] = [
    { type: "goal.progress", goalId: reviewed.id, summary: "开始执行新增要求" },
    {
      type: "goal.update", goalId: reviewed.id,
      patch: { title: "不能部分写入", status: "active" },
    },
  ];
  for (const command of commands) {
    await assert.rejects(service.execute(command), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /等待验收/);
      assert.ok(error.message.includes(`atte goal rework ${reviewed.id} --note`));
      return true;
    });
    assert.deepEqual(await service.read(), before);
  }
});

test("an old review cannot rename a later delivery and ended or read-only goals stay unchanged", async context => {
  const { service, concierge, reviewed } = await fixture(context);
  await concierge.execute({
    type: "goal.rework", goalId: reviewed.id, attentionId: reviewed.attention!.id,
    note: "按盘点结论统一执行入口", actor: "concierge",
  });
  const nextReview = await service.execute({
    type: "goal.review", goalId: reviewed.id,
    delivery: {
      summary: "已统一执行入口。",
      checks: [{ name: "入口回归", command: "验证统一入口", result: "passed" }],
    },
  }) as Goal;
  assert.deepEqual(nextReview.deliveryHistory?.at(-1), reviewed.delivery);
  const before = await service.read();
  await assert.rejects(concierge.execute({
    type: "goal.update", goalId: reviewed.id, attentionId: reviewed.attention!.id,
    patch: { title: "旧回合覆盖" }, actor: "concierge",
  }), /待处理事项已经变化/);
  assert.deepEqual(await service.read(), before);
  await service.execute({ type: "goal.accept", goalId: reviewed.id, actor: "你" });
  const completed = await service.read();
  await assert.rejects(service.execute({
    type: "goal.update", goalId: reviewed.id, patch: { title: "迟到改名" },
  }), /已结束/);
  assert.deepEqual(await service.read(), completed);
  const history = await service.execute({ type: "goal.intake", text: "只读历史" }) as Goal;
  await service.store.update("test.read-only", state => {
    state.goals.find(goal => goal.id === history.id)!.readOnly = true;
  });
  const readOnly = await service.read();
  await assert.rejects(service.execute({
    type: "goal.update", goalId: history.id, patch: { title: "改写只读历史" },
  }), /goal_read_only/);
  assert.deepEqual(await service.read(), readOnly);
});
