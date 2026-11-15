// Packaged-app regressions for navigation before storage selection and Orca status labels.
// Every application write stays inside the temporary home; no user sessions are started.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const home = await mkdtemp("/tmp/atte-first-launch-");
const userData = join(home, "userData"), workspace = join(home, "workspace");
await mkdir(join(userData, "runtime"), { recursive: true });
await mkdir(workspace);
await writeFile(join(userData, "runtime/herdr"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "herdr 999.0.0" ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o700 });
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: resolve(process.env.ATTE_APP_PATH ||
      "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      ATTE_TEST_HOME: home,
      ATTE_TEST_USER_DATA: userData,
      ATTE_TEST_WORKSPACE: "",
      ATTE_TEST_ISOLATE_TOOLS: "1",
      ATTE_TEST_SKIP_HERDR_SETUP: "1",
      ATTE_HERDR_SESSION: "atte-first-launch-smoke",
      PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByRole("button", { name: "选择存储位置并开始", exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.atte.environment())).workspace, undefined);
  for (const name of ["待办池", "全部目标", "设置"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", {
      name: name === "设置" ? "只设置必要的。" : name,
      exact: true,
    })).toBeVisible();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".welcome")).toHaveCount(0);
  }
  await expect(page.getByText("尚未选择存储位置", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "我的工作台", exact: true })).toHaveCount(0);
  await expect(page.locator(".brand")).not.toContainText("注意力中心");
  await expect(page.locator(".brand")).toContainText("The attention layer");
  await expect(page.getByLabel("管家启动命令")).toBeDisabled();
  await expect(page.getByText("先选择存储位置，再安装或管理工作方法。", { exact: true })).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "选择存储位置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "只设置必要的。" })).toBeVisible();
  await assert.rejects(access(join(workspace, ".atte")), /ENOENT/);
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: join(home, "settings-before-storage-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  const mascot = page.locator(".welcome .brand-mascot");
  await expect(mascot).toHaveAttribute("src", /atte-mascot-armored/);
  await expect.poll(() => mascot.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  assert.equal(await mascot.evaluate(image => getComputedStyle(image).imageRendering), "auto");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, workspace);
  await page.getByRole("button", { name: "选择存储位置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "现在，可以安心了。", exact: true })).toBeVisible();
  assert.equal((await page.evaluate(() => window.atte.environment())).workspace, await realpath(workspace));
  assert.equal(JSON.parse(await readFile(join(workspace, ".atte/state.json"), "utf8")).version, 4);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const base = await page.evaluate(() => window.atte.backendStatus());
  const choice = page.getByRole("radio", { name: /^Orca/ });
  const publishOrca = async (status, version) => {
    const fixture = structuredClone(base);
    fixture.orca = {
      ...fixture.orca,
      phase: "idle",
      detection: {
        ...fixture.orca.detection,
        status,
        version,
        appPath: status === "missing" ? undefined : "/Applications/Orca.app",
        detail: status === "unverified" ? `Orca ${version} 尚未通过兼容验证。` :
          status === "incompatible" ? "Orca CLI 校验失败。" : undefined,
      },
    };
    await app.evaluate(({ BrowserWindow, ipcMain }, next) => {
      for (const channel of ["atte:backend-status", "atte:orca-status", "atte:orca-action"])
        ipcMain.removeHandler(channel);
      ipcMain.handle("atte:backend-status", () => next);
      ipcMain.handle("atte:orca-status", () => next.orca);
      ipcMain.handle("atte:orca-action", () => {
        BrowserWindow.getAllWindows()[0].webContents.send("atte:event", {
          type: "orca-installation", status: next.orca,
        });
        return next.orca;
      });
      BrowserWindow.getAllWindows()[0].webContents.send("atte:event", { type: "backend-control", status: next });
      BrowserWindow.getAllWindows()[0].webContents.send("atte:event", { type: "orca-installation", status: next.orca });
    }, fixture);
  };
  await publishOrca("missing");
  await expect(choice.locator(".backend-choice__state")).toHaveText("先安装");
  await publishOrca("unverified", "1.4.259");
  await expect(choice.locator(".backend-choice__state")).toHaveText("已安装 · 待验证");
  await expect(page.getByText("已安装 1.4.259", { exact: true })).toBeVisible();
  await choice.click();
  await expect(page.locator(".backend-error")).toContainText("1.4.259");
  await expect(page.locator(".backend-error")).toContainText("兼容验证");
  await expect(page.locator(".backend-error")).not.toContainText("先安装");
  await page.screenshot({ path: join(home, "orca-installed-unverified.png"), animations: "disabled" });
  await publishOrca("incompatible", "1.4.259");
  await expect(choice.locator(".backend-choice__state")).toHaveText("安装需修复");
  await publishOrca("compatible", "1.4.258");
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(choice.locator(".backend-choice__state")).toHaveText("可切换");
  await expect(page.getByText("已安装 1.4.258", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, navigationBeforeStorage: true, settingsBeforeStorage: true,
    cancelledPickerPreservesPage: true, storageSelectedFromSettings: true, removedWorkspaceTile: true,
    englishTagline: true, armoredMascot: true, orcaStates: ["missing", "unverified", "incompatible", "compatible"],
    evidence: home }));
} catch (error) {
  console.error(`First-launch evidence: ${home}`);
  throw error;
} finally {
  await app?.close();
  if (process.env.ATTE_KEEP_TEST_ARTIFACTS !== "1")
    await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
