import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  WorkspaceService,
  type Goal,
  type ManagedSessionContext,
} from "../../packages/core/src/index.js";

async function cli(root: string, environment: Record<string, string>, ...args: string[]) {
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (/^(ATTE_|CREWVANE_|HERDR_)/.test(key)) delete childEnvironment[key];
  }
  const { stdout, stderr } = await promisify(execFile)(
    "pnpm", ["--dir", "cli", "exec", "tsx", "src/main.ts", ...args, "--root", root, "--json"],
    {
      cwd: new URL("../../", import.meta.url),
      env: { ...childEnvironment, ...environment }, timeout: 30_000,
    },
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout) as Goal;
}

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atte-cli-followup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceService(root);
  const original = "盘点现有能力，找出重复入口。\n保留原文作为最初需求。";
  const goal = await service.execute({ type: "goal.intake", text: original }) as Goal;
  const other = await service.execute({ type: "goal.intake", text: "另一件独立事项" }) as Goal;
  const managed: ManagedSessionContext = {
    installationId: "installation-cli-followup", backend: "herdr", epoch: 1,
    scopeGeneration: "scope-cli-followup", role: "concierge",
  };
  await service.execute({
    type: "backend.register",
    binding: {
      installationId: managed.installationId, backend: "herdr", epoch: managed.epoch,
      scopeGeneration: managed.scopeGeneration, status: "active",
    },
  });
  await service.execute({
    type: "agent.runtime.register", goalId: goal.id,
    attempt: {
      goalId: goal.id, attemptId: "attempt-cli-followup", agent: "owner-a",
      adapter: "custom", startedAt: new Date().toISOString(),
    },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  const reviewed = await service.execute({
    type: "goal.review", goalId: goal.id, actor: "owner-a",
    delivery: {
      summary: "已完成能力盘点。",
      checks: [{ name: "能力核对", command: "检查入口与实现", result: "passed" }],
    },
  }) as Goal;
  const scope = join(root, ".atte", "followup-case.json");
  await writeFile(scope, JSON.stringify({ goalId: goal.id, attentionId: reviewed.attention!.id }));
  const concierge = {
    ATTE_SESSION_CONTEXT: JSON.stringify(managed),
    ATTE_COORDINATOR: "1",
    ATTE_COORDINATOR_SCOPE_FILE: scope,
    ATTE_AGENT_NAME: "concierge",
  };
  const owner = {
    ATTE_SESSION_CONTEXT: JSON.stringify({
      ...managed, role: "owner", goalId: goal.id, attemptId: "attempt-cli-followup",
    }),
    ATTE_AGENT_NAME: "owner-a",
  };
  return { root, service, reviewed, original, other, scope, concierge, owner, managed };
}

test("the real managed concierge reworks review feedback while questions and messages preserve review", async context => {
  const { root, service, reviewed, original, other, concierge, owner, managed } = await fixture(context);
  const question = await cli(root, {}, "goal", "message", reviewed.id, "--text", "这里的结论有什么依据？");
  assert.equal(question.status, "review");
  assert.deepEqual(question.attention, reviewed.attention);
  assert.deepEqual(question.delivery, reviewed.delivery);
  const quote = "按盘点结论统一执行入口，并补齐回归测试。";
  const feedback = await cli(root, {}, "goal", "message", reviewed.id, "--text", quote);
  assert.equal(feedback.status, "review");
  assert.deepEqual(feedback.attention, reviewed.attention);
  assert.deepEqual(feedback.delivery, reviewed.delivery);
  assert.equal(feedback.dispatch?.note, quote);
  assert.equal(feedback.activities.at(-1)?.text, quote);
  assert.equal(feedback.activities.some(activity => activity.kind === "rework"), false);
  await assert.rejects(
    cli(root, concierge, "goal", "progress", reviewed.id, "--summary", "准备执行新增要求"),
    error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`atte goal rework ${reviewed.id} --note`));
      return true;
    },
  );
  await assert.rejects(cli(root, {
    ...concierge, ATTE_SESSION_CONTEXT: JSON.stringify({ ...managed, epoch: 0 }),
  }, "goal", "rework", reviewed.id, "--note", quote), /stale_backend_epoch/);
  await assert.rejects(
    cli(root, concierge, "goal", "rework", other.id, "--note", quote), /当前只处理目标/,
  );
  await assert.rejects(cli(root, concierge, "goal", "accept", reviewed.id), /只能查看或更新自己的案卷/);
  const title = "统一执行入口并补齐回归";
  const renamed = await cli(root, concierge, "goal", "update", reviewed.id, "--title", title);
  assert.equal(renamed.title, title);
  assert.equal(renamed.activities.at(-1)?.actor, "concierge");
  assert.ok(renamed.activities.at(-1)?.text.includes(reviewed.title));
  assert.ok(renamed.activities.at(-1)?.text.includes(title));
  const active = await cli(root, concierge, "goal", "rework", reviewed.id, "--note", quote);
  assert.equal(active.status, "active");
  assert.equal(active.attention, null);
  assert.deepEqual(active.delivery, reviewed.delivery);
  assert.equal(active.next, quote);
  assert.equal(active.description, original);
  assert.equal(active.activities.at(-1)?.actor, "concierge");
  assert.equal(active.activities.at(-1)?.text, quote);
  const progress = await cli(root, owner, "goal", "progress", reviewed.id,
    "--summary", "已按盘点结论开始统一入口", "--next", "验证兼容性");
  assert.equal(progress.status, "active");
  assert.equal(progress.activities.at(-1)?.actor, "owner-a");
  assert.deepEqual((await service.read()).goals.find(goal => goal.id === other.id), other);
});

test("scene followups bind title and rework to the exact owner receipt and reject an old review", async context => {
  const { root, service, reviewed, scope, concierge, owner } = await fixture(context);
  const quote = "顺着盘点结果，把重复入口合并，并验证现有使用方式。";
  const reply = await cli(root, owner, "goal", "scene-reply", reviewed.id,
    "--attention-id", reviewed.attention!.id!, "--quote", quote,
    "--summary", "收到新增执行要求，待管家退回推进后继续。");
  assert.equal(reply.status, "review");
  assert.equal(reply.sceneReply?.quote, quote);
  assert.equal(reply.dispatch?.kind, "scene_reply");
  assert.ok(reply.activities.some(activity => activity.actor === "你 · Herdr 现场" && activity.text === quote));
  await writeFile(scope, JSON.stringify({
    goalId: reviewed.id, attentionId: reviewed.attention!.id, sceneReplyId: reply.sceneReply!.id,
  }));
  const title = "合并重复入口并验证兼容性";
  await cli(root, concierge, "goal", "update", reviewed.id, "--title", title);
  await assert.rejects(
    cli(root, concierge, "goal", "rework", reviewed.id, "--note", "Agent 自行扩大的范围"), /必须记录用户原话/,
  );
  await assert.rejects(
    cli(root, owner, "goal", "accept", reviewed.id), /只能由人.*受管 Agent 不能调用/,
  );
  const active = await cli(root, concierge, "goal", "rework", reviewed.id, "--note", quote);
  assert.equal(active.status, "active");
  assert.equal(active.title, title);
  assert.equal(active.attention, null);
  assert.deepEqual(active.delivery, reviewed.delivery);
  await cli(root, owner, "goal", "progress", reviewed.id, "--summary", "正在合并入口");
  const nextReview = await cli(root, owner, "goal", "review", reviewed.id,
    "--summary", "已合并入口并验证现有使用方式", "--check", "兼容回归::pnpm test::passed");
  assert.notEqual(nextReview.attention!.id, reviewed.attention!.id);
  assert.deepEqual(nextReview.deliveryHistory?.at(-1), reviewed.delivery);
  const before = await service.read();
  await assert.rejects(
    cli(root, concierge, "goal", "update", reviewed.id, "--title", "旧回合覆盖"), /待处理事项已经变化/,
  );
  await assert.rejects(
    cli(root, concierge, "goal", "rework", reviewed.id, "--note", quote), /待处理事项已经变化/,
  );
  assert.deepEqual(await service.read(), before);
});

test("an owner answer to a review question keeps its actor and receipt without another feedback dispatch", async context => {
  const { root, service, reviewed, owner } = await fixture(context);
  const quote = "这个方案为什么保留一个统一入口？";
  const reply = await cli(root, owner, "goal", "scene-reply", reviewed.id,
    "--attention-id", reviewed.attention!.id!, "--quote", quote,
    "--summary", "用户只询问方案依据，不要求修改成果。");
  await service.execute({
    type: "goal.dispatch", goalId: reviewed.id, requestId: reply.dispatch!.id,
    status: "sent",
  });
  const delivered = (await service.read()).goals.find(goal => goal.id === reviewed.id)!;
  const answer = "统一入口共享同一份状态，可以避免多个入口各自保存任务进度。";
  const answered = await cli(root, owner, "goal", "message", reviewed.id, "--text", answer);
  assert.equal(answered.status, "review");
  assert.deepEqual(answered.attention, reviewed.attention);
  assert.deepEqual(answered.delivery, reviewed.delivery);
  assert.deepEqual(answered.sceneReply, delivered.sceneReply);
  assert.deepEqual(answered.dispatch, delivered.dispatch);
  assert.equal(answered.activities.at(-1)?.actor, "owner-a");
  assert.equal(answered.activities.at(-1)?.text, answer);
  assert.equal(answered.activities.at(-1)?.kind, "message");
  assert.equal(answered.activities.some(activity => activity.kind === "rework"), false);
});
