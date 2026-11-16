// Real packaged desktop + Herdr + a deterministic interactive CLI.
// No model credentials and no renderer/backend mocks.
import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { waitForWorkspace } from "./lib/autonomy-setup.mjs";

const exec = promisify(execFile);
const trial = await realpath(await mkdtemp("/tmp/atte-semantic-e2e-"));
const workspace = join(trial, "工作 区"), home = join(trial, "home"), userData = join(trial, "userData");
const session = `cv-semantic-${randomUUID().slice(0, 8)}`;
const cli = join(trial, "agent.cjs"), inputLog = join(trial, "agent-input.log");
const executablePath = resolve(process.env.ATTE_APP_PATH ||
  "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte");
const cliSource = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const input = readline.createInterface({ input: process.stdin, terminal: false });
const log = (event, data) => fs.appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({event,data}) + "\\n");
const atte = (args) => execFileSync(process.env.ATTE_CLI, [process.env.ATTE_CLI_BUNDLE, ...args], { encoding: "utf8", maxBuffer: 8_000_000 });
let initialized = false, launched = false, reported = false;
function write(kind) {
  try {
    const id = process.env.ATTE_GOAL_ID;
    if (kind === "progress") atte(["goal","progress",id,"--summary","文档已交付：问题报告已写入","--next","等待管家核对","--json"]);
    else atte(["goal","review",id,"--summary","文档已交付：问题报告已写入","--location","docs/report.md","--check","真实文件核对=passed:已通过真实文件核对","--json"]);
    log("write", {kind,id,cli:process.env.ATTE_CLI});
  } catch (error) { log("write-error", {kind,error:String(error.stderr || error)}); }
}
input.on("line", line => {
  log("input", line);
  if (/这是 Atte 身份初始化/.test(line) && !initialized) {
    initialized = true; console.log("ATTE_CONCIERGE_READY"); return;
  }
  if (line.startsWith("case_id: goal_") && !launched) {
    const goalId = line.trim().slice("case_id: ".length);
    launched = true;
    log("launch-attempt", {goalId,cli:process.env.ATTE_CLI,role:process.env.ATTE_ROLE});
    try {
      const result = atte(["owner","launch",goalId,"--name","owner-semantic","--json"]);
      log("launch", result);
    } catch (error) { log("launch-error", String(error.stderr || error)); }
    return;
  }
  if (line.includes("交付普通进展") && line.includes("执行目标") && !reported) {
    reported = true; write("progress");
  }
});
process.stdin.resume();
`;
await Promise.all([mkdir(workspace), mkdir(home), mkdir(userData)]);
await writeFile(cli, cliSource, { mode: 0o700 });
await writeFile(join(workspace, "AGENTS.md"), "只处理隔离目标，不提交、部署或外发消息。");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(home, ".zshrc"), [
  "cv-local-agent() {",
  `  ${shellQuote(cli)} "$@"`,
  "}",
  "",
].join("\n"), { mode: 0o600 });
const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
  ATTE_TEST_HOME: home, ATTE_TEST_USER_DATA: userData,
  ATTE_TEST_WORKSPACE: workspace, ATTE_TEST_ISOLATE_TOOLS: "1",
  ATTE_HERDR_SESSION: session, ATTE_TEST_SKIP_HERDR_SETUP: "",
  ATTE_CLI: process.execPath,
  ATTE_CLI_BUNDLE: join(executablePath, "../../Resources/app.asar.unpacked/dist/cli/atte.cjs"),
};
let app, page, succeeded = false;
try {
  app = await electron.launch({ executablePath, env: environment, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await waitForWorkspace(page);
  await page.evaluate(() => window.atte.command({ type: "agents.configure", preferences: {
    concierge: "cv-local-agent --model test", owner: "cv-local-agent --model test",
  } }));
  await page.evaluate(() => window.atte.prepareConcierge());
  const goal = await page.evaluate(() => window.atte.command({ type: "goal.intake", text: "交付普通进展：由负责人写回并核对管家是否立即收到。" }));
  await expect.poll(async () => (await page.evaluate(() => window.atte.command({type:"snapshot"}))).goals.find(goal => goal.id === goal.id)?.dispatch?.status, { timeout: 60_000 }).toBe("sent");
  await expect.poll(async () => {
    const content = await readFile(inputLog, "utf8").catch(() => "");
    return content.includes('"event":"write"');
  }, { timeout: 30_000 }).toBe(true);
  const log = await readFile(inputLog, "utf8");
  console.log(JSON.stringify({ log: log.split("\n").filter(Boolean).map(line => JSON.parse(line)).slice(-20), evidence: trial }));
  assert.ok(log.includes('"event":"launch"'), "The coordinator must actually launch the owner.");
  assert.ok(log.includes('"event":"write"'), "The owner must write a progress record through Atte CLI.");
  await expect.poll(async () => {
    const inbox = JSON.parse(await readFile(join(workspace, ".atte/coordinator-inbox.json"), "utf8"));
    const state = JSON.parse(await readFile(join(workspace, ".atte/state.json"), "utf8"));
    const current = state.goals.find(item => item.id === goal.id);
    return inbox.items.filter(item => item.goalId === goal.id && item.status === "sent").length >= 2 &&
      current?.dispatch?.status === "sent" && !current.attention;
  }, { timeout: 60_000 }).toBe(true);
  const inbox = JSON.parse(await readFile(join(workspace, ".atte/coordinator-inbox.json"), "utf8"));
  const state = JSON.parse(await readFile(join(workspace, ".atte/state.json"), "utf8"));
  const current = state.goals.find(item => item.id === goal.id);
  assert.equal(current.status, "active");
  assert.equal(current.attention, null, "ordinary progress must not create attention");
  assert.ok(current.activities.some(item => item.kind === "progress" && item.actor !== "系统"));
  const sent = inbox.items.filter(item => item.goalId === goal.id && item.status === "sent");
  assert.equal(sent.length, 2, "the owner write must create a second coordinator case");
  succeeded = true;
  console.log(JSON.stringify({ passed: true, coordinatorCases: sent.length, attentionCreated: false, evidence: trial }));
} catch (error) {
  console.error(JSON.stringify({ evidence: trial, error: String(error) }));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  const herdr = join(userData, "runtime/herdr");
  await exec(herdr, ["--session", session, "server", "stop"], { env: environment }).catch(() => {});
  if (succeeded && process.env.ATTE_KEEP_TEST_ARTIFACTS !== "1") await rm(trial, { recursive: true, force: true });
}
