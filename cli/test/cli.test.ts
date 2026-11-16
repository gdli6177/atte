import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwnerSendReceipt, run } from "../src/cli.js";
import { renderBoardPlain } from "../src/board.js";
import {
  WorkspaceService,
  isReadOnlyGoal,
  type Goal,
} from "../../packages/core/src/index.js";
const fixtures: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAVUlEQVR4nGPUMIr6z4AEAqKWInMZNiyLZqClPBPDAAOmEe8Axoqe///pGefo8kwMAwyYRrwDGEfLAYaR7gDG0XKAYaQ7gHG0HGAY6Q5gHC0HGEa6AwC58E1KmpVcaAAAAABJRU5ErkJggg==",
  "base64",
);
const inheritedProcessKeys = [
  "ATTE_AGENT_NAME",
  "ATTE_COORDINATOR",
  "ATTE_COORDINATOR_SCOPE_FILE",
  "ATTE_GOAL_ID",
  "ATTE_ROLE",
  "ATTE_WORKSPACE",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_PLUGIN_EVENT_JSON",
  "HERDR_SESSION",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
] as const;
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(prefix: string) { const root = await mkdtemp(join(tmpdir(), prefix)); fixtures.push(root); return root; }
test("owner send treats a rejected scene receipt as a hard CLI failure", () => {
  assert.throws(() => assertOwnerSendReceipt({
    status: "rejected",
    deliveryId: "owner-send-test",
    payloadSha256: "a".repeat(64),
    scene: {
      version: 1, backend: "herdr", installationId: "installation", backendEpoch: 1,
      bindingId: "binding", attemptId: "attempt", runtimeId: "runtime",
      runtimeGeneration: "generation",
      locator: { kind: "herdr", session: "atte-test", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    },
    at: new Date().toISOString(),
    detail: "现场身份、空闲或前台 Agent 无法确认，未发送。",
  }), /负责人现场拒绝本次消息.*未发送/);
});
async function call(root: string, argv: string[]) {
  let stdout = "", stderr = "";
  const code = await run([...argv, "--root", root, "--json"], { out: (text) => { stdout += text; }, error: (text) => { stderr += text; } });
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
}
test("the executable presents Atte while keeping the public atte command", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    "pnpm",
    ["--dir", "cli", "exec", "tsx", "src/main.ts", "--help"],
    { cwd: new URL("../../", import.meta.url), timeout: 30_000 },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /^Atte — The attention layer/);
  assert.match(stdout, /atte goal message ID --text TEXT/);
  assert.match(stdout, /atte capture TEXT/);
  assert.match(stdout, /atte goal start ID --by self\|concierge/);
  assert.doesNotMatch(stdout, /^\s+atte (?:skill|autonomy|release|bot|verifier)\b/m);
  assert.doesNotMatch(stdout, /goal (?:brief|checkpoint|verify|boundary|boundary-resolve|autonomy|reopen)\b/);
  assert.doesNotMatch(stdout, /--handling [^\n]*self|--self/);
  assert.doesNotMatch(stdout, /\bcrewvane (?:status|attention|board|goal|owner|skill)\b/);
});
async function callProcess(
  root: string,
  environment: Record<string, string>,
  argv: string[],
) {
  const childEnvironment = { ...process.env };
  for (const key of inheritedProcessKeys) delete childEnvironment[key];
  const { stdout, stderr } = await promisify(execFile)(
    "pnpm",
    ["--dir", "cli", "exec", "tsx", "src/main.ts",
      ...argv, "--root", root, "--json"],
    {
      cwd: new URL("../../", import.meta.url),
      env: { ...childEnvironment, ...environment },
      timeout: 30_000,
    },
  );
  return { stdout, stderr, json: JSON.parse(stdout) };
}
async function coordinator<T>(root: string, goalId: string, task: () => Promise<T>) {
  const scope = join(root, ".atte", "coordinator-scope.json");
  await writeFile(scope, JSON.stringify({ goalId, requestId: "test", setAt: new Date().toISOString() }));
  const previousCoordinator = process.env.ATTE_COORDINATOR,
    previousScope = process.env.ATTE_COORDINATOR_SCOPE_FILE,
    previousActor = process.env.ATTE_AGENT_NAME;
  process.env.ATTE_COORDINATOR = "1";
  process.env.ATTE_COORDINATOR_SCOPE_FILE = scope;
  process.env.ATTE_AGENT_NAME = "concierge";
  try { return await task(); }
  finally {
    if (previousCoordinator === undefined) delete process.env.ATTE_COORDINATOR;
    else process.env.ATTE_COORDINATOR = previousCoordinator;
    if (previousScope === undefined) delete process.env.ATTE_COORDINATOR_SCOPE_FILE;
    else process.env.ATTE_COORDINATOR_SCOPE_FILE = previousScope;
    if (previousActor === undefined) delete process.env.ATTE_AGENT_NAME;
    else process.env.ATTE_AGENT_NAME = previousActor;
  }
}
test("capture records backlog and explicit start reuses the same record", async () => {
  const root = await fixture("cv-cli-pool-");
  const saved = await call(root, ["capture", "先记下，等有空再整理"]);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.json.status, "backlog");
  assert.equal(saved.json.dispatch, undefined);
  assert.equal((await call(root, ["goal", "message", saved.json.id, "--text", "再留一点背景"])).code, 0);
  assert.equal((await call(root, ["goal", "start", saved.json.id, "--by", "wrong"])).code, 1);
  const started = await call(root, ["goal", "start", saved.json.id, "--by", "concierge"]);
  assert.equal(started.json.id, saved.json.id);
  assert.equal(started.json.mode, "concierge");
  assert.equal(started.json.dispatch.status, "pending");
  const repeated = await call(root, ["goal", "start", saved.json.id, "--by", "concierge"]);
  assert.equal(repeated.json.dispatch.id, started.json.dispatch.id);
  const personal = await call(root, ["capture", "我明天去银行",
    "--remind-at", new Date(Date.now() + 86400_000).toISOString()]);
  assert.equal(personal.code, 0, personal.stderr);
  assert.equal(personal.json.status, "backlog");
  assert.equal(personal.json.dispatch, undefined);
  const taken = await call(root, ["goal", "start", personal.json.id, "--by", "self"]);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(taken.json.id, personal.json.id);
  assert.equal(taken.json.mode, "manual");
  assert.equal(taken.json.status, "active");
  assert.equal(taken.json.owner, "你");
  assert.equal(taken.json.dispatch, undefined);
  assert.equal((await call(root, ["attention"])).json.length, 0);
  const completed = await call(root, ["goal", "complete", personal.json.id, "--note", "银行的事已办完"]);
  assert.equal(completed.json.status, "completed");
  assert.equal(completed.json.delivery, undefined);
  assert.equal((await call(root, ["goal", "list", "--all"])).json.length, 2);
});
test("real CLI writes goals that desktop service can read", async () => {
  const root = await fixture("atte-cli-");
  const created = await call(root, ["goal", "create", "--title", "从 CLI 交给管家", "--project", "personal"]);
  assert.equal(created.code, 0, created.stderr);
  const item = created.json as Goal;
  const progress = await call(root, ["goal", "progress", item.id, "--summary", "方案已完成", "--next", "开始实现"]);
  assert.equal(progress.json.next, "开始实现");
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.next, "开始实现");
  await call(root, ["goal", "wait", item.id, "--reason", "等审批", "--owner", "YR", "--remind-at", "2030-01-01T00:00:00Z"]);
  assert.equal((await call(root, ["attention"])).json.length, 0);
  const review = await call(root, ["goal", "review", item.id, "--summary", "交付已就绪", "--check", "测试::pnpm test::passed::全部通过"]);
  assert.equal(review.json.status, "review");
  await call(root, ["goal", "rework", item.id, "--note", "补充边界验证"]);
  await call(root, ["goal", "review", item.id, "--summary", "已补齐", "--check", "测试::pnpm test::passed"]);
  assert.equal((await call(root, ["goal", "accept", item.id])).json.status, "completed");
  assert.equal((await call(root, ["goal", "show", item.id])).json.activities.length, 7);
});
test("real owner CLI receipts and concierge scope bind resolution to the latest human answer", async () => {
  const root = await fixture("atte-cli-scene-");
  const service = new WorkspaceService(root);
  const goal = (await call(root, ["ask", "现场决定"])).json as Goal;
  await call(root, ["session", "set", goal.id, "--agent", "owner-a", "--pane", "w1:p2"]);
  await call(root, ["goal", "decide", goal.id, "--question", "先做核心范围吗？"]);
  const question = (await call(root, ["goal", "show", goal.id])).json.attentionRequest;
  const receipt = await call(root, ["goal", "scene-reply", goal.id, "--actor", "owner-a",
    "--attention-id", question.id, "--quote", "先做核心范围。", "--summary", "已确认范围，待管家记录决定。"]);
  assert.equal(receipt.code, 0, receipt.stderr);
  const first = receipt.json.sceneReply;
  await coordinator(root, goal.id, async () => {
    const scope = join(root, ".atte/coordinator-scope.json");
    await writeFile(scope, JSON.stringify({ goalId: goal.id, attentionId: question.id, sceneReplyId: first.id }));
    const fabricated = await call(root, ["goal", "resolve", goal.id, "--note", "Agent 自己决定"]);
    assert.equal(fabricated.code, 1);
    assert.match(fabricated.stderr, /必须记录用户原话/);
    const resolved = await call(root, ["goal", "resolve", goal.id, "--note", first.quote, "--outcome", "approved"]);
    assert.equal(resolved.code, 0, resolved.stderr);
    await service.execute({ type: "goal.decide", goalId: goal.id, question: "可以删除旧数据吗？" });
    const late = await call(root, ["goal", "resolve", goal.id, "--note", first.quote]);
    assert.equal(late.code, 1);
    assert.match(late.stderr, /待处理事项已经变化/);
  });
  assert.equal((await service.read()).decisions[0]!.source, "Herdr 负责人现场");
});
test("CLI fails closed and preserves an unsupported legacy workspace", async () => {
  const root = await fixture("atte-cli-recovery-");
  await mkdir(join(root, ".atte"), { recursive: true });
  const original = JSON.stringify({ version: 1, tasks: [] });
  await writeFile(join(root, ".atte/state.json"), original);
  let stdout = "", stderr = "";
  const code = await run(["status", "--root", root], {
    out: text => { stdout += text; },
    error: text => { stderr += text; },
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /工作区状态版本 1 与当前版本不兼容/);
  assert.equal(await readFile(join(root, ".atte/state.json"), "utf8"), original);
  assert.deepEqual(
    (await readdir(root)).filter(name => name.startsWith(".atte.backup-")),
    [],
  );
});
test("CLI upgrades v4 Orca workspaces to v5 and keeps legacy goals read-only", async () => {
  const root = await fixture("atte-cli-orca-v5-");
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: { title: "旧 Orca 目标", projectId: "personal", mode: "concierge" },
  }) as Goal;
  const state = await service.read();
  await writeFile(join(root, ".atte/state.json"), JSON.stringify({
    ...state,
    version: 4,
    backendBinding: {
      installationId: "orca-installation",
      backend: "orca",
      epoch: 1,
      scopeGeneration: "legacy-scope",
      status: "active",
    },
  }));

  const status = await call(root, ["status"]);
  assert.equal(status.code, 0, status.stderr);
  const migrated = await new WorkspaceService(root).read();
  assert.equal(migrated.version, 5);
  const legacy = migrated.goals.find(item => item.id === goal.id)!;
  assert.equal(isReadOnlyGoal(legacy), true);
  assert.equal(legacy.readOnly, true);
  assert.equal(legacy.readOnlyReason, "legacy-orca");
  assert.equal(legacy.dispatch, undefined);
  const blocked = await call(root, [
    "goal", "progress", goal.id,
    "--summary", "旧 Orca 现场不能继续执行",
  ]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /goal_read_only/);
});
test("CLI rejects incomplete or fabricated review records", async () => {
  const root = await fixture("atte-cli-invalid-");
  const created = await call(root, ["goal", "create", "--title", "检查证据", "--project", "personal"]);
  const result = await call(root, ["goal", "review", created.json.id, "--summary", "声称完成"]);
  assert.equal(result.code, 1); assert.match(result.stderr, /至少提供一个/);
});
test("CLI records a custom terminal transport and rejects missing process identity", async () => {
  const root = await fixture("atte-cli-custom-");
  const created = await call(root, ["goal", "create", "--title", "自定义 CLI", "--project", "personal"]);
  const noTarget = await call(root, ["session", "set", "--pane", "w1:p0", "--agent", "owner"]);
  assert.equal(noTarget.code, 1);
  assert.match(noTarget.stderr, /必须指定目标 ID/);
  assert.equal((await new WorkspaceService(root).read()).concierge.agent, undefined);
  const missing = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "pane"]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /前台进程 ID/);
  const valid = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "pane", "--process-id", "123"]);
  assert.equal(valid.code, 0);
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.herdr?.processId, 123);
  const invalid = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "shell", "--process-id", "123"]);
  assert.equal(invalid.code, 1);
});
test("owner names from the managed pane are attributed without manual flags", async () => {
  const root = await fixture("atte-cli-owner-name-");
  const created = (await call(root, ["goal", "create", "--title", "负责人署名"])).json as Goal;
  const previous = process.env.ATTE_AGENT_NAME;
  process.env.ATTE_AGENT_NAME = "trial-owner";
  try {
    const reviewed = await call(root, ["goal", "review", created.id,
      "--summary", "真实成果", "--check", "检查::true::passed::通过"]);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.equal(reviewed.json.delivery.submittedBy, "trial-owner");
    assert.equal(reviewed.json.activities.at(-1).actor, "trial-owner");
    const accepted = await call(root, ["goal", "accept", created.id, "--note", "用户原话：通过"]);
    assert.equal(accepted.code, 1);
    assert.match(accepted.stderr, /只能由人/);
  } finally {
    if (previous === undefined) delete process.env.ATTE_AGENT_NAME;
    else process.env.ATTE_AGENT_NAME = previous;
  }
});
test("real CLI preserves discovery and delivery kinds and an external wait without autonomy scheduling", async () => {
  const root = await fixture("atte-cli-kinds-");
  const created = await call(root, [
    "goal", "create",
    "--title", "先探索再决定",
    "--kind", "discovery",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.json.kind, "discovery");
  const switched = await call(root, [
    "goal", "kind", created.json.id,
    "--kind", "delivery",
  ]);
  assert.equal(switched.code, 0, switched.stderr);
  assert.equal(switched.json.kind, "delivery");

  const dueAt = "2030-01-01T00:00:00.000Z",
    waiting = await call(root, [
      "goal", "wait", created.json.id,
      "--reason", "等待外部结果",
      "--owner", "YR",
      "--remind-at", dueAt,
    ]);
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.equal(waiting.json.status, "waiting");
  assert.equal(waiting.json.waitingFor, "YR");
  assert.equal(waiting.json.remindAt, dueAt);
  assert.equal(waiting.json.autonomy, undefined);
  const saved = (await new WorkspaceService(root).read()).goals
    .find(goal => goal.id === created.json.id)!;
  assert.equal(saved.kind, "delivery");
  assert.equal(saved.autonomy, undefined);
});
test("real CLI keeps review evidence while retired verification is rejected", async () => {
  const root = await fixture("atte-cli-review-evidence-");
  const goal = (await call(root, [
    "goal", "create",
    "--title", "保留真实审查证据",
    "--project", "personal",
  ])).json as Goal;
  const evidencePath = join(root, "evidence.json");
  await writeFile(evidencePath, JSON.stringify([{
    id: "ev_tests",
    kind: "command",
    label: "测试通过",
    result: "passed",
    observedAt: new Date().toISOString(),
    command: "true",
  }]));
  const reviewed = await call(root, [
    "goal", "review", goal.id,
    "--summary", "交付附真实检查和证据",
    "--check", "测试::true::passed",
    "--candidate-revision", "rev-1",
    "--evidence-file", evidencePath,
  ]);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  assert.equal(reviewed.json.status, "review");
  assert.equal(reviewed.json.delivery.checks[0].command, "true");
  assert.equal(reviewed.json.delivery.evidence[0].id, "ev_tests");
  assert.equal(reviewed.json.reviewRounds, 1);

  const rejected = await call(root, [
    "goal", "verify", goal.id,
    "--delivery", reviewed.json.delivery.id,
    "--outcome", "passed",
    "--summary", "独立复核已退役",
  ]);
  assert.equal(rejected.code, 2);
  assert.deepEqual(rejected.json, {
    error: "feature_removed",
    message: rejected.json.message,
  });
  assert.match(rejected.stderr, /^atte: feature_removed: /);
  const saved = (await new WorkspaceService(root).read()).goals[0]!;
  assert.deepEqual(saved.delivery, reviewed.json.delivery);
});
test("CLI caps review submissions at three rounds and a human can extend the limit", async () => {
  const root = await fixture("atte-cli-review-rounds-");
  const goal = (await call(root, [
    "goal", "create",
    "--title", "限制审查轮次",
    "--project", "personal",
  ])).json as Goal;
  for (let round = 1; round <= 3; round++) {
    if (round > 1)
      assert.equal((await call(root, [
        "goal", "rework", goal.id,
        "--note", `第 ${round} 轮修改完成`,
      ])).code, 0);
    const reviewed = await call(root, [
      "goal", "review", goal.id,
      "--summary", `第 ${round} 轮交付，真实检查通过`,
      "--check", `第 ${round} 轮检查::true::passed`,
    ]);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.equal(reviewed.json.reviewRounds, round);
  }
  assert.equal((await call(root, [
    "goal", "rework", goal.id,
    "--note", "准备提交第四轮",
  ])).code, 0);
  const blocked = await call(root, [
    "goal", "review", goal.id,
    "--summary", "第四轮交付等待增加审查轮次",
    "--check", "第四轮检查::true::passed",
  ]);
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.equal(blocked.json.reviewRounds, 3);
  assert.equal(blocked.json.delivery.summary, "第 3 轮交付，真实检查通过");
  assert.equal(blocked.json.attention.kind, "intervention");
  assert.match(blocked.json.attention.summary, /审查已达到 3 轮上限/);
  const extended = await call(root, [
    "goal", "resolve", goal.id,
    "--note", "用户明确允许增加第四轮审查",
  ]);
  assert.equal(extended.code, 0, extended.stderr);
  assert.equal(extended.json.reviewLimit, 4);
  assert.equal(extended.json.attention, null);
  const fourth = await call(root, [
    "goal", "review", goal.id,
    "--summary", "第四轮交付，真实检查通过",
    "--check", "第四轮检查::true::passed",
  ]);
  assert.equal(fourth.code, 0, fourth.stderr);
  assert.equal(fourth.json.reviewRounds, 4);
});
test("owner launch is routed through the current concierge case", async () => {
  const root = await fixture("atte-cli-owner-launch-");
  const created = (await call(root, ["goal", "create", "--title", "启动负责人"])).json as Goal;
  const previousEnv = process.env.HERDR_ENV;
  const previousSession = process.env.HERDR_SESSION;
  delete process.env.HERDR_ENV;
  process.env.HERDR_SESSION = "atte-test";
  try {
    const result = await coordinator(root, created.id, () =>
      call(root, [
        "owner",
        "launch",
        created.id,
        "--name",
        "case-owner",
        "--task",
        "完成当前目标",
      ])
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /缺少 Atte 后端控制目录/);
  } finally {
    if (previousEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousEnv;
    if (previousSession === undefined) delete process.env.HERDR_SESSION;
    else process.env.HERDR_SESSION = previousSession;
  }
});
test("Herdr plugin events update only their real owner pane and record exits", async () => {
  const root = await fixture("atte-cli-live-event-");
  const created = (await call(root, ["goal", "create", "--title", "同步现场状态"])).json as Goal;
  await call(root, ["session", "set", created.id, "--workspace", "w1", "--tab", "w1:t2",
    "--pane", "w1:p2", "--agent", "owner"]);
  const previous = process.env.HERDR_PLUGIN_EVENT_JSON;
  const ingest = async (data: Record<string, unknown>, event: string) => {
    process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({ event, data });
    try { return await call(root, ["event", "herdr"]); }
    finally {
      if (previous === undefined) delete process.env.HERDR_PLUGIN_EVENT_JSON;
      else process.env.HERDR_PLUGIN_EVENT_JSON = previous;
    }
  };
  const blocked = await ingest({ pane_id: "w1:p2", workspace_id: "w1", agent_status: "blocked", agent_name: "owner" },
    "pane_agent_status_changed");
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.deepEqual(blocked.json, { matched: 1 });
  let goal = (await new WorkspaceService(root).read()).goals[0]!;
  assert.equal(goal.live?.state, "blocked");
  assert.equal(goal.live?.reachable, true);
  const replaced = await ingest({ pane_id: "w1:p2", workspace_id: "w1", agent_status: "working", agent_name: "manual-agent" },
    "pane_agent_status_changed");
  assert.deepEqual(replaced.json, { matched: 0 });
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.live?.state, "blocked");

  const unrelated = await ingest({ pane_id: "w1:p99", workspace_id: "w1", agent_status: "done" },
    "pane_agent_status_changed");
  assert.deepEqual(unrelated.json, { matched: 0 });
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.live?.state, "blocked");

  const moved = await ingest({
    previous_pane_id: "w1:p2",
    previous_workspace_id: "w1",
    pane: {
      pane_id: "w3:p1",
      workspace_id: "w3",
      tab_id: "w3:t1",
      agent: "owner",
      agent_status: "working",
    },
  }, "pane.moved");
  assert.deepEqual(moved.json, { matched: 1 });
  goal = (await new WorkspaceService(root).read()).goals[0]!;
  assert.deepEqual(goal.herdr, {
    session: "atte",
    workspaceId: "w3",
    tabId: "w3:t1",
    paneId: "w3:p1",
    agent: "owner",
  });
  assert.equal(goal.live?.state, "working");
  assert.equal(goal.live?.reachable, true);

  const closed = await ingest({ pane_id: "w1:p2", workspace_id: "w1" }, "pane_closed");
  assert.deepEqual(closed.json, { matched: 0 }, "the old pane ID must not match after the move");

  const movedClosed = await ingest({ pane_id: "w3:p1", workspace_id: "w3" }, "pane_closed");
  assert.deepEqual(movedClosed.json, { matched: 1 });
  goal = (await new WorkspaceService(root).read()).goals[0]!;
  assert.equal(goal.live?.state, "unknown");
  assert.equal(goal.live?.reachable, false);

  const tabGoal = (await call(root, ["goal", "create", "--title", "同步 Tab 关闭"])).json as Goal;
  await call(root, ["session", "set", tabGoal.id, "--workspace", "w1", "--tab", "w1:t4",
    "--pane", "w1:p4", "--agent", "tab-owner"]);
  const tabClosed = await ingest(
    { type: "tab_closed", tab_id: "w1:t4", workspace_id: "w1" },
    "tab.closed",
  );
  assert.deepEqual(tabClosed.json, { matched: 1 });
  const tabCurrent = (await new WorkspaceService(root).read()).goals.find(item => item.id === tabGoal.id)!;
  assert.deepEqual(tabCurrent.live && {
    state: tabCurrent.live.state, reachable: tabCurrent.live.reachable,
  }, { state: "unknown", reachable: false });

  const workspaceGoal = (await call(root, ["goal", "create", "--title", "同步工作区关闭"])).json as Goal;
  await call(root, ["session", "set", workspaceGoal.id, "--workspace", "w2", "--tab", "w2:t1",
    "--pane", "w2:p1", "--agent", "workspace-owner"]);
  const workspaceClosed = await ingest(
    { type: "workspace_closed", workspace_id: "w2" },
    "workspace.closed",
  );
  assert.deepEqual(workspaceClosed.json, { matched: 1 });
  const workspaceCurrent = (await new WorkspaceService(root).read()).goals
    .find(item => item.id === workspaceGoal.id)!;
  assert.deepEqual(workspaceCurrent.live && {
    state: workspaceCurrent.live.state, reachable: workspaceCurrent.live.reachable,
  }, { state: "unknown", reachable: false });
});
test("CLI creates a goal without requiring a project", async () => {
  const root=await fixture("atte-cli-no-project-");
  const result=await call(root,["goal","create","--title","直接交代一件事"]);
  assert.equal(result.code,0);
  assert.equal(result.json.projectId,"personal");
  assert.equal(result.json.owner,"待分配负责人");
});
test("CLI governs high-risk actions and ship decisions through the shared ledger", async () => {
  const root = await fixture("atte-cli-governance-");
  const policyMutation = await call(root, ["project", "policy", "set", "personal", "--ship-policy", "auto"]);
  assert.equal(policyMutation.code, 1, "CLI must not expose a way for an Agent to modify ship policy");
  const item = (await call(root, ["ask", "执行高风险变更"])).json as Goal;
  const risk = await call(root, ["goal", "risk", item.id, "--category", "delete-data",
    "--summary", "删除生产数据库", "--key", "prod-cleanup"]);
  assert.equal(risk.code, 0, risk.stderr);
  assert.equal(risk.json.attention.kind, "decision");
  const resolved = await call(root, ["goal", "resolve", item.id, "--note", "拒绝删除生产数据库",
    "--outcome", "rejected"]);
  assert.equal(resolved.code, 0, resolved.stderr);
  const ship = await call(root, ["goal", "ship", item.id, "--operation", "merge", "--checks", "passed"]);
  assert.equal(ship.code, 0, ship.stderr);
  assert.equal(ship.json.allowed, false);
  assert.equal(ship.json.requiresHuman, true);
  assert.match(await readFile(join(root, ".atte", "rejected.md"), "utf8"), /拒绝删除生产数据库/);
});
test("ask creates a persisted concierge handoff and message appends feedback without changing state", async () => {
  const root = await fixture("atte-cli-ask-");
  const created = await call(root, ["ask", "检查发布流程", "并补齐证据"]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.json.title, "检查发布流程 并补齐证据");
  assert.equal(created.json.description, "检查发布流程 并补齐证据");
  assert.equal(created.json.dispatch.status, "pending");
  const initialRequest = created.json.dispatch.id;

  const waited = await call(root, ["goal", "wait", created.json.id, "--reason", "等 YR 审批", "--owner", "YR"]);
  assert.equal(waited.code, 0, waited.stderr);
  const nextBefore = waited.json.next;
  const messaged = await call(root, ["goal", "message", created.json.id, "--text", "增加一份回滚验证"]);
  assert.equal(messaged.code, 0, messaged.stderr);
  assert.equal(messaged.json.status, "active");
  assert.equal(messaged.json.waitingFor, undefined);
  assert.equal(messaged.json.next, nextBefore);
  assert.equal(messaged.json.dispatch.status, "pending");
  assert.notEqual(messaged.json.dispatch.id, initialRequest);
  assert.equal(messaged.json.activities.at(-1).kind, "message");
  assert.equal(messaged.json.activities.at(-1).actor, "你");
  assert.match(messaged.json.activities.at(-1).text, /增加一份回滚验证/);
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.dispatch?.status, "pending");
});

test("ask and direct copy repeated image attachments into the shared workspace", async () => {
  const root = await fixture("atte-cli-attachments-"),
    first = join(root, "第一张截图.png"),
    second = join(root, "second.png");
  await writeFile(first, png);
  await writeFile(second, png);
  const created = await call(root, [
    "ask", "结合截图修复布局", "--attachment", first, "--attachment", second,
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.json.attachments.length, 2);
  assert.deepEqual(created.json.attachments.map((item: { name: string }) => item.name),
    ["第一张截图.png", "second.png"]);
  for (const attachment of created.json.attachments) {
    const path = join(root, attachment.path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "base64"), png.toString("base64"));
  }
  const third = join(root, "third.png");
  await writeFile(third, png);
  const appended = await call(root, [
    "direct", "再补一张", "--goal", created.json.id, "--attachment", third,
  ]);
  assert.equal(appended.code, 0, appended.stderr);
  assert.equal(appended.json.attachments.length, 3);
  assert.equal(appended.json.dispatch.id, created.json.dispatch.id);
});

test("CLI rejects missing or fake attachments before creating a goal", async () => {
  const root = await fixture("atte-cli-attachment-invalid-"),
    missing = await call(root, ["ask", "缺失图片", "--attachment", join(root, "missing.png")]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /找不到图片/);
  const fake = join(root, "fake.png");
  await writeFile(fake, "not an image");
  const invalid = await call(root, ["ask", "伪图片", "--attachment", fake]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /不是支持的/);
  assert.equal((await new WorkspaceService(root).read()).goals.length, 0);
});

test("direct terminal messages sync once and never create a duplicate handoff", async () => {
  const root = await fixture("atte-cli-direct-");
  const created = (await call(root, ["ask", "已有目标"])).json as Goal;
  await coordinator(root, created.id, async () => {
    const rejectedProgressAlias = await call(root, ["direct", "追加下一步：补充回滚验证", "--next", "补充回滚验证"]);
    assert.equal(rejectedProgressAlias.code, 1);
    assert.match(rejectedProgressAlias.stderr, /只同步人的原话/);

    const appended = await call(root, ["direct", "补充背景：保留回滚验证"]);
    assert.equal(appended.code, 0, appended.stderr);
    assert.equal(appended.json.id, created.id);
    assert.equal(appended.json.status, "active");
    assert.equal(appended.json.next, created.next, "terminal chat must not silently change the next step");
    assert.match(appended.json.activities.at(-1).text, /补充背景/);
    assert.equal(appended.json.activities.at(-1).actor, "你 · Herdr 直聊");
    assert.equal(appended.json.activities.at(-1).kind, "message");

    const newGoal = await call(root, ["direct", "--new", "整理下周发布计划"]);
    assert.equal(newGoal.code, 0, newGoal.stderr);
    assert.notEqual(newGoal.json.id, created.id);
    assert.equal(newGoal.json.dispatch.status, "sent");
    assert.match(newGoal.json.dispatch.detail, /直接送达管家/);
    const advanced = await call(root, ["goal", "progress", newGoal.json.id,
      "--summary", "管家已直接受理新目标", "--next", "创建负责人"]);
    assert.equal(advanced.code, 0, advanced.stderr);
    assert.equal(advanced.json.next, "创建负责人");
    assert.equal(JSON.parse(await readFile(join(root, ".atte", "coordinator-scope.json"), "utf8")).goalId,
      newGoal.json.id);
  });
  const state = await new WorkspaceService(root).read();
  assert.equal(state.goals.length, 2);
  assert.equal(state.goals[0]?.dispatch?.id, created.dispatch?.id, "direct feedback must not replace the existing dispatch");
  assert.equal(state.goals[1]?.dispatch?.status, "sent");
});

test("a scoped concierge with no active case can still record a direct new task", async () => {
  const root = await fixture("atte-cli-direct-new-");
  const scope = join(root, ".atte", "coordinator-scope.json");
  const previousCoordinator = process.env.ATTE_COORDINATOR,
    previousScope = process.env.ATTE_COORDINATOR_SCOPE_FILE;
  process.env.ATTE_COORDINATOR = "1";
  process.env.ATTE_COORDINATOR_SCOPE_FILE = scope;
  try {
    const denied = await call(root, ["status"]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /没有案卷范围/);

    const created = await call(root, ["direct", "--new", "从终端交办的新事项"]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.description, "从终端交办的新事项");
    assert.equal(created.json.dispatch.status, "sent");
  } finally {
    if (previousCoordinator === undefined) delete process.env.ATTE_COORDINATOR;
    else process.env.ATTE_COORDINATOR = previousCoordinator;
    if (previousScope === undefined) delete process.env.ATTE_COORDINATOR_SCOPE_FILE;
    else process.env.ATTE_COORDINATOR_SCOPE_FILE = previousScope;
  }
});

test("a managed concierge preserves backlog intake and rejects retired self handling", async () => {
  const root = await fixture("cv-direct-pool-");
  const existing = (await call(root, ["ask", "当前案卷"])).json as Goal;
  await coordinator(root, existing.id, async () => {
    const saved = await call(root, ["direct", "--new", "--handling", "later", "先记下，周末再研究"]);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.json.status, "backlog");
    assert.equal(saved.json.dispatch, undefined);
    const illicit = await call(root, ["goal", "progress", saved.json.id, "--summary", "现在偷偷开始"]);
    assert.equal(illicit.code, 1);
    assert.match(illicit.stderr, /尚未开始/);
    const personal = await call(root, ["direct", "--new", "--handling", "self", "这件事我亲自处理"]);
    assert.equal(personal.code, 2);
    assert.equal(personal.json.error, "feature_removed");
    assert.match(personal.stderr, /^atte: feature_removed: /);
    const changeViaMessage = await call(root, ["direct", "--current", "--handling", "concierge", "补充备注"]);
    assert.equal(changeViaMessage.code, 1);
    assert.match(changeViaMessage.stderr, /不能改变执行安排/);
  });
  assert.equal((await new WorkspaceService(root).read()).goals.length, 2);
});

test("Herdr board renders actionable attention without terminal escape codes", async () => {
  const root = await fixture("atte-cli-board-");
  const service = new WorkspaceService(root);
  const decision = await service.execute({ type: "goal.intake", text: "确认周末是否上线" }) as Goal;
  await service.execute({
    type: "goal.decide",
    goalId: decision.id,
    question: "周六还是周日上线？",
    actor: "管家",
  });
  await service.execute({ type: "goal.intake", text: "等待 YR 审批" });
  await service.execute({
    type: "goal.wait",
    goalId: (await service.read()).goals[1]!.id,
    reason: "等待 YR 审批",
    owner: "YR",
    actor: "管家",
  });
  const plain = renderBoardPlain(await service.read(), decision.id);
  assert.match(plain, /Atte/);
  assert.match(plain, /1 件需要你/);
  assert.match(plain, /周六还是周日上线/);
  assert.match(plain, /上线 external-approval/);
  assert.match(plain, /n 新事项/);
  assert.doesNotMatch(plain, /\x1b/);

  const waitingGoal = (await service.read()).goals.find(goal => goal.status === "waiting")!;
  const waitingBoard = renderBoardPlain(await service.read(), waitingGoal.id);
  assert.match(waitingBoard, /u 交给管家推进/);
  assert.match(waitingBoard, /m 我来处理/);

  const reviewed = await service.execute({
    type: "goal.review",
    goalId: decision.id,
    delivery: {
      summary: "方案与证据已就绪。",
      checks: [{ name: "证据", command: "查看方案", result: "passed" }],
    },
  }) as Goal;
  const reviewBoard = renderBoardPlain(await service.read(), reviewed.id);
  assert.match(reviewBoard, /a 验收通过/);
  assert.match(reviewBoard, /c 给管家发消息/);
  assert.doesNotMatch(reviewBoard, /退回修改/);

  const risky = await service.execute({ type: "goal.intake", text: "调整生产权限" }) as Goal;
  await service.execute({
    type: "goal.risk", goalId: risky.id, category: "change-permissions",
    summary: "给生产环境增加管理员",
  });
  const riskyBoard = renderBoardPlain(await service.read(), risky.id);
  assert.match(riskyBoard, /高风险动作必须由你确认/);
});
test("review feedback through the executable keeps delivery and attention until an explicit concierge update", async () => {
  const root = await fixture("atte-review-feedback-");
  const created = await call(root, ["ask", "交付一个可以验收的页面"]);
  const goalId = created.json.id;
  const reviewed = await call(root, [
    "goal", "review", goalId, "--summary", "页面和验证已交付",
    "--check", "页面回归::pnpm test::passed",
  ]);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  const feedback = "请补充浅色截图；这个结果还没验收，不要直接完成。";
  const sent = await callProcess(root, {}, ["goal", "message", goalId, "--text", feedback]);
  assert.equal(sent.json.status, "review");
  assert.deepEqual(sent.json.delivery, reviewed.json.delivery);
  assert.deepEqual(sent.json.attention, reviewed.json.attention);
  assert.equal(sent.json.dispatch.kind, "feedback");
  assert.equal(sent.json.dispatch.note, feedback);
  assert.equal(sent.json.activities.at(-1).text, feedback);
  assert.equal(sent.json.activities.at(-1).kind, "message");
  assert.equal(sent.json.activities.some((item: { kind: string }) => item.kind === "rework"), false);
  const changed = await callProcess(root, {}, ["goal", "rework", goalId, "--note", feedback]);
  assert.equal(changed.json.status, "active");
  assert.equal(changed.json.activities.at(-1).kind, "rework");
});

test("coordinator CLI is limited to the current case and cannot read or mutate another goal", async () => {
  const root = await fixture("atte-cli-scope-");
  const first = (await call(root, ["ask", "目标 A"])).json as Goal;
  const second = (await call(root, ["ask", "目标 B"])).json as Goal;
  await coordinator(root, first.id, async () => {
    const status = await call(root, ["status"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.json.name, "我的工作台");
    assert.deepEqual(Object.keys(status.json).sort(), ["agents", "goal", "name", "project"]);
    assert.equal(status.json.goal.id, first.id);
    assert.equal(status.json.goal.scene, null);

    const current = await call(root, ["goal", "show", first.id]);
    assert.equal(current.code, 0, current.stderr);
    const other = await call(root, ["goal", "show", second.id]);
    assert.equal(other.code, 1);
    assert.match(other.stderr, /当前只处理目标/);

    const progress = await call(root, ["goal", "progress", first.id, "--summary", "已交给负责人", "--actor", "管家"]);
    assert.equal(progress.code, 0, progress.stderr);
    const crossWrite = await call(root, ["goal", "progress", second.id, "--summary", "越界写入", "--actor", "管家"]);
    assert.equal(crossWrite.code, 1);
    assert.match(crossWrite.stderr, /当前只处理目标/);

    const direct = await call(root, ["direct", "补充终端里的新约束"]);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(direct.json.id, first.id);
    const crossDirect = await call(root, ["direct", "越界直聊", "--goal", second.id]);
    assert.equal(crossDirect.code, 1);
    assert.match(crossDirect.stderr, /当前只处理目标/);

    for (const argv of [["goal", "list"], ["attention"], ["ask", "新目标"], ["capture", "暂存"],
      ["goal", "start", second.id, "--by", "concierge"], ["goal", "message", first.id, "--text", "回环"]]) {
      const denied = await call(root, argv);
      assert.equal(denied.code, 1, `${argv.join(" ")} should be denied`);
    }
    assert.equal((await call(root, ["workflow", "list"])).code, 1);
  });
  const state = await new WorkspaceService(root).read();
  assert.equal(state.goals.find(goal => goal.id === first.id)?.next, first.next);
  assert.ok(state.goals.find(goal => goal.id === first.id)?.activities.some(activity => activity.text === "已交给负责人"));
  assert.ok(!state.goals.find(goal => goal.id === second.id)?.activities.some(activity => activity.text === "越界写入"));
});

test("coordinator can turn an explicit user message into an audited current-case state change", async () => {
  const root = await fixture("atte-cli-concierge-state-");
  const first = (await call(root, ["ask", "方案讨论完成，等我确认后结束"])).json as Goal;
  const second = (await call(root, ["ask", "另一个不能串案的目标"])).json as Goal;
  await coordinator(root, first.id, async () => {
    const completed = await call(root, ["goal", "complete", first.id,
      "--note", "方案没问题，结束这个目标"]);
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(completed.json.status, "completed");
    assert.equal(completed.json.activities.at(-1).actor, "concierge");
    assert.equal(completed.json.activities.at(-1).text, "方案没问题，结束这个目标");

    const crossCase = await call(root, ["goal", "complete", second.id,
      "--note", "越权结束另一个目标"]);
    assert.equal(crossCase.code, 1);
    assert.match(crossCase.stderr, /当前只处理目标/);
  });
  const state = await new WorkspaceService(root).read();
  assert.equal(state.goals.find(goal => goal.id === first.id)?.status, "completed");
  assert.equal(state.goals.find(goal => goal.id === second.id)?.status, "active");
});

test("spawned CLI updates an item and rejects a late update after cancellation", async () => {
  const root = await fixture("atte-cli-process-");
  const cli = (...args: string[]) => promisify(execFile)("pnpm", ["--dir", "cli", "exec", "tsx", "src/main.ts",
    ...args, "--root", root, "--json"], { cwd: new URL("../../", import.meta.url), timeout: 30_000 });
  const goal = JSON.parse((await cli("goal", "create", "--title", "真实进程调用", "--project", "personal")).stdout);
  await assert.rejects(() => cli("goal", "wait", goal.id, "--reason", "缺少对象"), /外部第三方/);
  await assert.rejects(() => cli("goal", "wait", goal.id, "--reason", "等你确认", "--owner", "你"), /外部第三方/);
  await assert.rejects(() => cli("goal", "update", goal.id, "--status", "waiting"), /外部第三方/);
  await cli("goal", "update", goal.id, "--next", "等待审批", "--status", "waiting", "--waiting-for", "YR", "--remind-at", "2030-01-01T00:00:00Z");
  const state = await new WorkspaceService(root).read();
  assert.equal(state.goals[0]?.status, "waiting");
  assert.equal(state.goals[0]?.next, "等待审批");
  assert.equal(state.goals[0]?.waitingFor, "YR");
  assert.equal(state.goals[0]?.owner, "待分配负责人");
  await cli("goal", "drop", goal.id, "--reason", "无需继续");
  await assert.rejects(() => cli("goal", "progress", goal.id, "--summary", "迟到写回"), /已结束/);
  const deferred = JSON.parse((await cli("capture", "跨进程记录的想法")).stdout);
  assert.equal(deferred.status, "backlog");
  assert.equal(deferred.dispatch, undefined);
  const personal = JSON.parse((await cli("goal", "start", deferred.id, "--by", "self")).stdout);
  assert.equal(personal.id, deferred.id);
  assert.equal(personal.mode, "manual");
  assert.equal(personal.status, "active");
});

test("doctor reports version, inbox backlog and unreachable scenes without changing state", async () => {
  const root = await fixture("atte-cli-doctor-");
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "诊断示例" }) as Goal;
  await service.execute({
    type: "backend.register",
    binding: { installationId: "installation", backend: "herdr", epoch: 1,
      scopeGeneration: "scope-doctor", status: "active" },
  });
  await service.execute({
    type: "scene.bind", goalId: goal.id,
    scene: {
      version: 1, backend: "herdr", installationId: "installation", backendEpoch: 1,
      bindingId: "binding-doctor", attemptId: "attempt-doctor",
      runtimeId: "runtime", runtimeGeneration: "generation",
      locator: { kind: "herdr", session: "atte-doctor", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" },
    },
  });
  await service.execute({
    type: "scene.observe",
    scenes: [{ bindingId: "binding-doctor",
      presence: { state: "unknown", checkedAt: new Date().toISOString(), reachable: false } }],
  });
  await mkdir(join(root, ".atte"), { recursive: true });
  await writeFile(join(root, ".atte/coordinator-inbox.json"), JSON.stringify({
    version: 1, sequence: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    context: { epoch: 1, startedAt: new Date().toISOString(), completedCases: 0, estimatedChars: 0 },
    items: [
      { id: "a", sequence: 1, goalId: goal.id, requestId: "r1", kind: "watchdog",
        priority: "background", status: "queued", enqueuedAt: new Date().toISOString(), attempts: 0 },
      { id: "b", sequence: 2, goalId: goal.id, requestId: "r2", kind: "feedback",
        priority: "human", status: "unconfirmed", enqueuedAt: new Date().toISOString(), attempts: 1 },
    ],
  }));
  const before = await service.read();
  const result = await call(root, ["doctor"]);
  assert.equal(result.code, 0);
  assert.equal(typeof result.json.version, "string");
  assert.equal(result.json.workspace, root);
  assert.equal(result.json.inbox.queued, 1);
  assert.equal(result.json.inbox.unconfirmed, 1);
  assert.equal(result.json.deadScenes.length, 1);
  assert.equal(result.json.deadScenes[0].goalId, goal.id);
  const after = await service.read();
  assert.deepEqual(after, before, "doctor is read-only");
});

test("delivery lookup reports the terminal status of one request", async () => {
  const root = await fixture("atte-cli-delivery-");
  const goal = (await call(root, ["ask", "投递查询"])).json as Goal;
  await mkdir(join(root, ".atte"), { recursive: true });
  await writeFile(join(root, ".atte/coordinator-inbox.json"), JSON.stringify({
    version: 1, sequence: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    context: { epoch: 1, startedAt: new Date().toISOString(), completedCases: 0, estimatedChars: 0 },
    items: [{ id: "coord_1", sequence: 1, goalId: goal.id, requestId: "owner-send-1",
      kind: "feedback", priority: "human", status: "expired",
      enqueuedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      attempts: 1, detail: "投递结果长时间未确认，已按过期关闭；没有重发，请以现场为准。" }],
  }));
  const found = await call(root, ["delivery", "owner-send-1"]);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.json[0].status, "expired");
  assert.equal(found.json[0].goalId, goal.id);
  const missing = await call(root, ["delivery", "owner-send-missing"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /没有找到请求/);
});
