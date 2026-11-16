// Opt-in real-model regression for a quiet owner that omitted its write-back.
// Uses an isolated workspace and Herdr session, never the user's live workspace.
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";

const trial = await realpath(await mkdtemp("/tmp/cv-settled-"));
const home = join(trial, "home"), workspace = join(trial, "workspace");
const session = `cv-settled-${Date.now().toString(36)}`;
await mkdir(home); await mkdir(workspace);
await writeFile(join(workspace, "AGENTS.md"), `# 隔离验收
只处理 Atte 当前案卷，不读取真实用户项目，不提交、不发布、不发送外部消息。
管家只协调，不能自己执行目标。
`);
const service = new WorkspaceService(workspace);
const agent = process.env.ATTE_TRIAL_AGENT ||
  "omp";
await service.execute({ type:"agents.configure", preferences:{ concierge:agent, owner:agent } });
const app = await electron.launch({
  executablePath:resolve(process.env.ATTE_APP_PATH || "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte"),
  env:{ ...process.env, ATTE_TEST_HOME:home, ATTE_TEST_USER_DATA:join(trial,"userData"),
    ATTE_TEST_WORKSPACE:workspace, ATTE_HERDR_SESSION:session,
    PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR || join(homedir(),".omp/agent") },
  timeout:60_000,
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
async function state() { return service.read(); }
const nonOwnerActors = new Set(["系统", "你", "管家", "concierge", "巡检"]);
function ownerDecision(goal) {
  const attention = goal?.attention;
  const remindedAt = goal?.agentRuntime?.receipt?.remindedAt;
  if (!attention || attention.kind !== "decision" || !remindedAt) return undefined;
  const decision = [...goal.activities].reverse().find(activity =>
    activity.kind === "decision" &&
    !nonOwnerActors.has(activity.actor) &&
    activity.text === attention.summary);
  if (!decision) return undefined;
  const reminded = Date.parse(remindedAt);
  const decided = Date.parse(decision.at);
  const attended = Date.parse(attention.since);
  if (![reminded, decided, attended].every(Number.isFinite) ||
    decided < reminded || attended < reminded) return undefined;
  return { decision, remindedAt };
}
function assertOwnerDecision(goal, label) {
  const evidence = ownerDecision(goal);
  assert.ok(evidence, `${label}: attention must come from the owner's own decision after the receipt reminder`);
  assert.equal(goal.attention.kind, "decision");
  assert.equal(evidence.decision.text, goal.attention.summary);
  return evidence;
}
async function herdr(args, timeout=20_000) {
  return app.evaluate(async (_electron, {session,args,timeout}) => {
    const {execFile} = process.getBuiltinModule("node:child_process");
    return new Promise(resolve => execFile("herdr",["--session",session,...args],
      {timeout,maxBuffer:512_000},(error,stdout,stderr) => resolve({error:error?.message,stdout,stderr})));
  },{session,args,timeout});
}
let goal;
try {
  await expect.poll(async () => (await page.evaluate(() => window.atte.environment())).workspace).toBe(workspace);
  goal = await page.evaluate(() => window.atte.command({ type:"goal.intake", text:
    "隔离回归：请安排独立负责人处理一个方案选择。负责人第一轮必须先实际执行 shell 命令 `sleep 60`，模拟长时间处理；然后只在终端写出“阶段结果已产出”并结束回合，不要调用 goal progress、wait、decide 或 review，模拟遗漏写回。在收到管家关于空闲未汇报的核实时，不要重新执行 sleep；直接用 goal decide 提出一个具体问题“是否采用方案 A 继续？”，然后结束回合等待用户。",
  }));
  console.log(JSON.stringify({step:"delegated",trial,session,goalId:goal.id}));
  await expect.poll(async () => {
    const item = (await state()).goals.find(item => item.id===goal.id);
    if (item?.dispatch?.status==="failed" && !item.scene) throw new Error(item.dispatch.detail || "派发失败");
    return item?.scene?.locator.paneId ?? null;
  },{timeout:240_000,intervals:[1000]}).not.toBeNull();
  await expect.poll(async () => {
    const item = (await state()).goals.find(item => item.id===goal.id);
    return item?.live?.state ?? null;
  },{timeout:120_000,intervals:[500]}).toBe("working");
  await expect.poll(async () => {
    const item = (await state()).goals.find(item => item.id===goal.id);
    return item?.live?.state ?? null;
  },{timeout:240_000,intervals:[500]}).toMatch(/^(idle|done)$/);
  const settled = (await state()).goals.find(item => item.id===goal.id);
  assert.equal(settled.status, "active", "idle does not mean waiting for an external party");
  let verificationPath;
  if (settled.attention) {
    assertOwnerDecision(settled, "settled snapshot");
    verificationPath = "owner-decision-after-reminder";
  } else {
    assert.equal(settled.attention,null,"idle alone must not invent a decision");
    verificationPath = "settled-without-attention";
  }
  console.log(JSON.stringify({
    step:"owner-settled", owner:settled.scene.locator.paneId, live:settled.live,
    verificationPath,
  }));
  let watchdogContacted = settled.watchdog?.reason==="settled" && Boolean(settled.watchdog.contactedAt);
  if (!settled.attention && !watchdogContacted) {
    await expect.poll(async () => {
      const item = (await state()).goals.find(item => item.id===goal.id);
      if (!item) return "missing";
      if (item.watchdog?.reason==="settled" && item.watchdog.contactedAt) {
        watchdogContacted = true;
        return "watchdog-contacted";
      }
      if (item.attention) {
        assertOwnerDecision(item, "attention after idle");
        verificationPath = "owner-decision-after-reminder";
        return "owner-decision";
      }
      return "waiting";
    },{timeout:360_000,intervals:[1000]}).toMatch(/^(watchdog-contacted|owner-decision)$/);
  } else if (watchdogContacted) {
    verificationPath = "watchdog-contacted";
  }
  if (watchdogContacted) console.log(JSON.stringify({step:"watchdog-contacted"}));
  await expect.poll(async () => (await state()).goals.find(item => item.id===goal.id)?.attention?.kind,
    {timeout:240_000,intervals:[1000]}).toBe("decision");
  const current = await state(), item = current.goals.find(item => item.id===goal.id);
  assertOwnerDecision(item, "final state");
  assert.equal(item.scene.locator.paneId,settled.scene.locator.paneId,"reconcile the original owner, not a replacement");
  assert.equal(item.recovery,undefined);
  assert.equal(item.watchdog,undefined);
  assert.equal(item.status,"active");
  assert.match(item.attention.summary,/方案 A/);
  if (watchdogContacted)
    assert.ok(item.activities.some(activity => activity.kind==="watchdog" && /已请管家核查/.test(activity.text)));
  await page.getByRole("button",{name:"注意力",exact:true}).click();
  await expect(page.locator(".attention-card").filter({hasText:item.attention.summary})).toBeVisible();
  await page.screenshot({path:join(trial,"settled-reconciled.png"),animations:"disabled"});
  await writeFile(join(trial,"verified-state.json"),JSON.stringify(current,null,2));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({
    result:"passed",trial,goalId:goal.id,owner:item.scene.locator.paneId,
    attention:item.attention.summary,verificationPath,
  }));
} catch (error) {
  await writeFile(join(trial,"failed-state.json"),JSON.stringify(await state(),null,2));
  const listed = await herdr(["agent","list"]).catch(() => undefined);
  if (listed) await writeFile(join(trial,"failed-agents.json"),JSON.stringify(listed,null,2));
  await page.screenshot({path:join(trial,"failed.png")}).catch(() => {});
  console.error(JSON.stringify({result:"failed",trial,error:String(error)}));
  throw error;
} finally {
  await herdr(["server","stop"],10_000).catch(() => {});
  await app.close();
}
