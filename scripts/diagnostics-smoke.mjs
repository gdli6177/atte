// Packaged-app check for the support report: a real clipboard copy, redaction,
// owner-only log file and the menu entry. No IPC mocks and no network.
import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkspaceService } from "../packages/core/src/index.ts";

const trial = await realpath(await mkdtemp("/tmp/atte-diagnostics-"));
const home = join(trial, "home"), workspace = join(trial, "workspace");
const userData = join(trial, "userData");
await mkdir(home);
await mkdir(workspace);
await mkdir(join(userData, "runtime"), { recursive: true });
await writeFile(join(userData, "runtime/herdr"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "herdr 999.0.0" ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o700 });
await new WorkspaceService(workspace).execute({
  type: "agents.configure", preferences: { concierge: "/missing/atte-diagnostics-agent" },
});
const secret = "supersecret-diagnostics-token-9f2c";
let app, page, succeeded = false;
try {
  app = await electron.launch({
    executablePath: resolve(process.env.ATTE_APP_PATH ||
      "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
      ATTE_TEST_HOME: home, ATTE_TEST_USER_DATA: userData, ATTE_TEST_WORKSPACE: workspace,
      ATTE_TEST_ISOLATE_TOOLS: "1", ATTE_TEST_SKIP_HERDR_SETUP: "1", PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByRole("heading", { name: /现在，可以安心了。|把注意力，留给真正重要的事。/ }).waitFor();
  const menu = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items.find(entry => entry.label === "Atte");
    return item?.submenu?.items.map(entry => entry.label) ?? [];
  });
  assert.ok(menu.includes("复制诊断日志"), menu.join(","));

  // A failure carrying a credential must never reach the report verbatim.
  await page.evaluate(token => window.atte.reportRendererError(`Authorization: Bearer ${token}`), secret);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText("排查与反馈", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制诊断日志", exact: true }).click();
  await expect(page.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
  const copied = await page.evaluate(() => window.atte.readClipboardText());
  assert.match(copied, /Atte 诊断日志/);
  assert.match(copied, /环境快照/);
  assert.match(copied, /会话后端: /);
  assert.match(copied, /\[renderer\] window-error/);
  assert.doesNotMatch(copied, new RegExp(secret));
  assert.match(copied, /redacted/);
  assert.doesNotMatch(copied, /\/Users\/[^/\s]+\//, "home paths must be masked");
  assert.equal(copied.includes(workspace), false, "the workspace path must be compacted");
  assert.match(copied, /工作区: …\/.+\/workspace/);
  await page.screenshot({ path: join(trial, "diagnostics-settings.png"), animations: "disabled" });

  const logPath = join(userData, "diagnostics.log");
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /diagnostics-render-error|window-error/);
  assert.equal(log.includes(secret), false);
  assert.deepEqual(errors, []);
  succeeded = true;
  console.log(JSON.stringify({
    passed: true, menuEntry: true, clipboardCopied: true, redacted: true,
    logFile: logPath, logMode: "0600", reportBytes: Buffer.byteLength(copied), evidence: trial,
  }));
} catch (error) {
  await page?.screenshot({ path: join(trial, "failure.png"), animations: "disabled" }).catch(() => {});
  console.error(`Diagnostics evidence: ${trial}`);
  throw error;
} finally {
  await app?.close();
  if (succeeded && process.env.ATTE_KEEP_TEST_ARTIFACTS !== "1")
    await rm(trial, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
