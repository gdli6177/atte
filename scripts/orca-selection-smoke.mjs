// Real installed Orca detection and the packaged Atte selection path, without IPC mocks.
// Uses a private Atte home/workspace and stops at the user's handoff confirmation.
import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkspaceService } from "../packages/core/src/index.ts";
import { ORCA_RELEASE, verifyOrcaApplication } from "../packages/sessions/src/index.ts";

const installed = await verifyOrcaApplication("/Applications/Orca.app");
if (process.env.ATTE_TEST_ORCA_VERSION)
  assert.equal(installed.version, process.env.ATTE_TEST_ORCA_VERSION);
const trial = await realpath(await mkdtemp("/tmp/atte-orca-selection-"));
const home = join(trial, "home"), workspace = join(trial, "workspace"), userData = join(trial, "userData");
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
  type: "agents.configure", preferences: { concierge: "/missing/atte-orca-selection-test-agent" },
});
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
      ATTE_ORCA_HOST_HOME: process.env.HOME,
    },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "只设置必要的。" })).toBeVisible();
  const status = await page.evaluate(() => window.atte.backendStatus());
  assert.equal(status.orca.detection.version, installed.version);
  assert.equal(status.orca.detection.status, "compatible", status.orca.detection.detail);
  assert.equal(status.orca.verifiedVersion, ORCA_RELEASE.version);
  const choice = page.getByRole("radio", { name: /^Orca/ });
  await expect(choice).toBeEnabled();
  await expect(choice.locator(".backend-choice__state")).toHaveText("可切换");
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(choice.locator(".backend-choice__state")).toHaveText("可切换");
  await expect(page.getByText(`已安装 ${installed.version}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`推荐安装包 ${ORCA_RELEASE.version}`, { exact: true })).toBeVisible();
  await page.screenshot({ path: join(trial, "orca-compatible-settings-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: join(trial, "orca-compatible-settings-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await choice.click();
  const confirmation = page.getByRole("dialog", { name: "切换到 Orca？", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "切换到 Orca", exact: true })).toBeEnabled();
  await expect(page.locator(".backend-error")).toHaveCount(0);
  await page.screenshot({ path: join(trial, "orca-selection-confirmation.png"), animations: "disabled" });
  await confirmation.getByRole("button", { name: "保留当前后端", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.atte.backendStatus())).control.selected, "herdr");
  assert.deepEqual(errors, []);
  succeeded = true;
  console.log(JSON.stringify({ passed: true, installedVersion: status.orca.detection.version,
    detection: status.orca.detection.status, selectable: true, confirmationReachable: true,
    existingBackendPreserved: true, ipcMocks: false, evidence: trial }));
} catch (error) {
  await page?.screenshot({ path: join(trial, "failure.png"), animations: "disabled" }).catch(() => {});
  console.error(`Orca selection evidence: ${trial}`);
  throw error;
} finally {
  await app?.close();
  if (succeeded && process.env.ATTE_KEEP_TEST_ARTIFACTS !== "1")
    await rm(trial, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
