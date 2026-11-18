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
  assert.equal(changed.activities.at(-1)?.kind, "metadata");
  assert.equal(changed.activities.at(-1)?.actor, "concierge");
  assert.ok(changed.activities.at(-1)?.text.includes(reviewed.title));
  assert.ok(changed.activities.at(-1)?.text.includes(title));
  assert.equal(changed.revision, reviewed.revision! + 1);
  const unchanged = await concierge.execute({
    type: "goal.update", goalId: reviewed.id,
    patch: { title, next: "等待用户确认改进范围" },
  }) as Goal;
  assert.equal(unchanged.activities.at(-1)?.text, "已更新元数据：下一步。");
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

test("same-round amendment adds evidence without changing delivery, attention, or review count", async context => {
  const { service, reviewed } = await fixture(context);
  const deliveryId = reviewed.delivery!.id!;
  const amended = await service.execute({
    type: "goal.review.amend",
    goalId: reviewed.id,
    deliveryId,
    title: "原范围下的同一轮补证",
    note: "补齐第二轮回归记录和可复查产物。",
    checks: [{
      name: "补充回归", command: "pnpm test", result: "passed",
      note: "完整套件通过",
    }],
    evidence: [{
      id: "ev_extra_tests",
      kind: "command",
      label: "补充回归",
      result: "passed",
      observedAt: new Date().toISOString(),
      command: "pnpm test",
      note: "同一候选成果，只补充可复查证据。",
    }],
  }) as Goal;
  assert.equal(amended.status, "review");
  assert.equal(amended.delivery?.id, deliveryId);
  assert.equal(amended.delivery?.submittedAt, reviewed.delivery?.submittedAt);
  assert.deepEqual(amended.attention, reviewed.attention);
  assert.equal(amended.reviewRounds, reviewed.reviewRounds);
  assert.equal(amended.reviewLimit, reviewed.reviewLimit);
  assert.equal(amended.delivery?.checks.length, reviewed.delivery!.checks.length + 1);
  assert.equal(amended.delivery?.evidence?.at(-1)?.id, "ev_extra_tests");
  assert.equal(amended.delivery?.amendments?.length, 1);
  assert.equal(amended.delivery?.amendments?.[0]?.addedChecks.length, 1);
  assert.deepEqual(amended.delivery?.amendments?.[0]?.addedEvidenceIds, ["ev_extra_tests"]);
  assert.equal(amended.activities.at(-1)?.kind, "delivery_amend");
  assert.match(amended.activities.at(-1)?.text ?? "", /不增加审查轮次/);
  assert.equal(amended.description, reviewed.description);
});

test("amendment remains available while the review-limit intervention awaits a human decision", async context => {
  const { service, reviewed } = await fixture(context);
  await service.store.update("test.review-limit", state => {
    const item = state.goals.find(goal => goal.id === reviewed.id)!;
    item.reviewRounds = 3;
    item.reviewLimit = 3;
    item.attention = {
      id: "attention-review-limit",
      kind: "intervention",
      summary: "审查已达到 3 轮上限，需要你决定是否增加一轮。",
      since: item.updatedAt,
      source: "governance",
    };
  });
  const amended = await service.execute({
    type: "goal.review.amend",
    goalId: reviewed.id,
    deliveryId: reviewed.delivery!.id!,
    note: "上限裁决期间补一条证据，不提交第四轮。",
    checks: [{
      name: "补证", command: "复核同一构建产物", result: "passed",
    }],
  }) as Goal;
  assert.equal(amended.reviewRounds, 3);
  assert.equal(amended.reviewLimit, 3);
  assert.equal(amended.attention?.kind, "intervention");
  assert.equal(amended.activities.at(-1)?.kind, "delivery_amend");
});

test("a changed re-review still consumes a round, and review-limit rejection is atomic", async context => {
  const { service, reviewed } = await fixture(context);
  const deliveryId = reviewed.delivery!.id!;
  await service.execute({
    type: "goal.review.amend",
    goalId: reviewed.id,
    deliveryId,
    note: "先补证据。",
    evidence: [{
      id: "ev_same_round", kind: "inspection", label: "检查构建记录",
      result: "observed", location: "artifacts/review.log",
      observedAt: new Date().toISOString(),
    }],
  });
  const amended = (await service.read()).goals.find(goal => goal.id === reviewed.id)!;
  assert.equal(amended.reviewRounds, reviewed.reviewRounds);
  await service.execute({
    type: "goal.rework", goalId: reviewed.id,
    attentionId: reviewed.attention!.id,
    note: "结论有变化，重新交付。",
  });
  const next = await service.execute({
    type: "goal.review", goalId: reviewed.id, title: "新的完整交付范围",
    delivery: {
      summary: "第二版改变了候选结论。",
      checks: [{ name: "新版回归", command: "pnpm test", result: "passed" }],
    },
  }) as Goal;
  assert.equal(next.reviewRounds, (reviewed.reviewRounds ?? 0) + 1);
  assert.equal(next.title, "新的完整交付范围");

  await service.store.update("test.review-limit", state => {
    const item = state.goals.find(goal => goal.id === reviewed.id)!;
    item.reviewRounds = 3;
    item.reviewLimit = 3;
  });
  await service.execute({
    type: "goal.rework", goalId: reviewed.id,
    attentionId: next.attention!.id,
    note: "准备提交第四轮。",
  });
  const before = await service.read();
  const blocked = await service.execute({
    type: "goal.review", goalId: reviewed.id, title: "不应部分写入的标题",
    delivery: {
      summary: "第四轮候选。",
      checks: [{ name: "回归", command: "pnpm test", result: "passed" }],
    },
  }) as Goal;
  assert.equal(blocked.title, before.goals.find(goal => goal.id === reviewed.id)?.title);
  assert.equal(blocked.attention?.kind, "intervention");
  assert.equal(blocked.reviewRounds, 3);
});

test("invalid amendment evidence leaves delivery, title, activities, and revision unchanged", async context => {
  const { service, reviewed } = await fixture(context);
  const before = await service.read();
  await assert.rejects(service.execute({
    type: "goal.review.amend",
    goalId: reviewed.id,
    deliveryId: reviewed.delivery!.id!,
    title: "不能部分写入",
    note: "尝试补证。",
    evidence: [{
      id: "bad id with spaces",
      kind: "command",
      label: "无效证据",
      result: "passed",
      observedAt: new Date().toISOString(),
    }],
  }), /第 1 条证据的 id 无效/);
  assert.deepEqual(await service.read(), before);
});
