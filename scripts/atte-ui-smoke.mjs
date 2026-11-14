import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { WorkspaceService } from "../packages/core/src/index.ts";

const artifacts = await mkdtemp(join(tmpdir(), "atte-ui-"));
const home = join(artifacts, "home");
const workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
const service = new WorkspaceService(workspace);
await service.execute({
  type: "agents.configure",
  preferences: { concierge: "/missing/atte-qa-agent" },
});
const goal = await service.execute({ type: "goal.intake", text: "核对 Atte 验收入口", handling: "self" });
const reviewed = await service.execute({
  type: "goal.review", goalId: goal.id, actor: "owner",
  delivery: {
    summary: "消息与验收分开，反馈保留原话。",
    checks: [{ name: "交互回归", command: "pnpm test:atte-ui", result: "passed" }],
  },
});
const appPath = resolve(process.env.CREWVANE_APP_PATH ??
  "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte");
const application = await electron.launch({
  executablePath: appPath,
  args: [...(process.env.CREWVANE_ATTE_UI_HOLD === "1"
    ? ["--remote-debugging-port=9338"] : [])],
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: "/usr/bin:/bin",
    CREWVANE_TEST_HOME: home,
    CREWVANE_TEST_USER_DATA: join(home, "userData"),
    CREWVANE_TEST_WORKSPACE: workspace,
    CREWVANE_TEST_ISOLATE_TOOLS: "1",
    CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
  },
  timeout: 60_000,
});
const errors = [];
const measurements = [];
try {
  const page = await application.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "注意力", exact: true }).waitFor();
  await expect(page).toHaveTitle("Atte");
  const native = await application.evaluate(({ app, Menu }) => ({
    name: app.getName(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    menu: Menu.getApplicationMenu()?.items[0].label,
    about: Menu.getApplicationMenu()?.items[0].submenu?.items.some(item => item.role === "about"),
  }));
  assert.equal(native.name, "Atte");
  assert.equal(native.menu, "Atte");
  assert.equal(native.about, true);
  assert.equal(native.userData, join(home, "userData"));

  async function theme(value) {
    await page.evaluate(next => {
      localStorage.setItem("crewvane.theme", next);
    }, value);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  }
  async function capture(name) {
    await page.screenshot({ path: join(artifacts, `${name}.png`), animations: "disabled" });
  }
  async function openReview() {
    await page.getByRole("button", { name: "注意力", exact: true }).click();
    await page.locator(".attention-card").filter({ hasText: goal.title }).click();
    await page.locator(".goal-attention-modal").waitFor();
    await expect(page.getByRole("button", { name: "给管家发消息", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "验收通过", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "问管家", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退回修改", exact: true })).toHaveCount(0);
  }
  for (const value of ["dark", "light"]) {
    await theme(value);
    for (const [width, height] of [[1440, 960], [1024, 768], [900, 700]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const heading = document.querySelector(".home .intro h1")?.getBoundingClientRect();
        const image = document.querySelector(".pixel-scene img");
        const mark = image?.getBoundingClientRect();
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          titleClipped: heading && (heading.left < 0 || heading.right > innerWidth),
          markVisible: Boolean(mark?.width && mark?.height),
          markWidth: mark?.width ?? 0,
          markClipped: Boolean(mark?.width && (mark.left < 0 || mark.right > innerWidth)),
          overlapsTitle: Boolean(mark?.width && heading &&
            mark.left < heading.right && mark.right > heading.left &&
            mark.top < heading.bottom && mark.bottom > heading.top),
        };
      });
      assert.ok(layout.scrollWidth <= width + 1, JSON.stringify(layout));
      assert.equal(Boolean(layout.titleClipped), false);
      assert.equal(layout.markClipped, false);
      assert.equal(layout.overlapsTitle, false);
      measurements.push({ theme: value, height, ...layout });
      await capture(`home-${value}-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await openReview();
    await capture(`review-${value}`);
    await page.getByRole("button", { name: "给管家发消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "交给管家", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "完整记录", exact: true }).click();
    await page.locator(".goal-detail-modal").waitFor();
    await expect(page.getByRole("button", { name: "给管家发消息", exact: true })).toHaveCount(1);
    await capture(`detail-${value}`);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "设置分组" }).getByRole("link")).toHaveCount(5);
    await expect(page.getByRole("heading", { name: "关于 Atte", exact: true })).toHaveCount(1);
    const appearance = page.locator(".ui-settings-card").filter({ has: page.getByRole("heading", { name: "外观", exact: true }) });
    const next = value === "dark" ? "light" : "dark";
    await appearance.getByRole("button", { name: next === "light" ? "浅色" : "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    await expect(appearance.getByText("有未保存的更改", { exact: true })).toBeVisible();
    await appearance.getByRole("button", { name: "保存外观", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    assert.equal(await page.evaluate(() => localStorage.getItem("crewvane.theme")), next);
    await theme(value);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await capture(`settings-${value}`);
    await page.setViewportSize({ width: 900, height: 700 });
    assert.equal(await page.locator(".ui-settings-grid").first().evaluate(element =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length), 1);
    await capture(`settings-${value}-900`);
    await page.getByRole("link", { name: "执行现场", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "");
    const scene = page.locator(".ui-settings-card").filter({ has: page.getByRole("heading", { name: "工作现场", exact: true }) });
    await scene.getByRole("button", { name: "内嵌轻现场", exact: true }).click();
    await expect(scene.getByRole("button", { name: "保存工作现场", exact: true })).toBeEnabled();
    await expect(scene.getByRole("button", { name: "测试打开现场", exact: true })).toBeDisabled();
    const originalScene = await page.evaluate(() => window.crewvane.sceneSettings());
    assert.notEqual(originalScene.settings.openWith, "embedded");
    await scene.getByRole("button", { name: "保存工作现场", exact: true }).click();
    await expect(scene.getByRole("button", { name: "保存工作现场", exact: true })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.crewvane.sceneSettings())).settings.openWith, "embedded");
    await scene.getByRole("button", { name: "外部终端（推荐）", exact: true }).click();
    await scene.getByRole("button", { name: "保存工作现场", exact: true }).click();
    await expect(scene.getByRole("button", { name: "保存工作现场", exact: true })).toBeDisabled();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await openReview();
  await page.getByRole("button", { name: "给管家发消息", exact: true }).click();
  const feedback = "请补齐浅色截图，保留现有验收记录。";
  await page.getByLabel("发给管家的消息", { exact: true }).fill(feedback);
  await page.getByLabel("选择回复图片", { exact: true }).setInputFiles({
    name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not-an-image"),
  });
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await expect(page.locator(".goal-reply-composer [role=alert]")).toBeVisible();
  await expect(page.getByLabel("发给管家的消息", { exact: true })).toHaveValue(feedback);
  await capture("feedback-failure");
  await page.getByRole("button", { name: "移除回复图片 invalid.png" }).click();
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await expect(page.getByRole("button", { name: "验收通过", exact: true })).toBeVisible();
  const current = (await service.read()).goals.find(item => item.id === goal.id);
  assert.equal(current.status, "review");
  assert.deepEqual(current.delivery, reviewed.delivery);
  assert.equal(current.attention.id, reviewed.attention.id);
  assert.equal(current.activities.at(-1).text, feedback);
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await expect.poll(async () => (await service.read()).goals.find(item => item.id === goal.id).status).toBe("completed");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".ui-button").first().evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await capture("final-home");
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ native, measurements, errors }, null, 2));
  console.log(JSON.stringify({ result: "passed", artifacts, checks: ["branding", "review-message", "failed-send", "acceptance", "settings-save", "responsive", "reduced-motion"] }));
  if (process.env.CREWVANE_ATTE_UI_HOLD === "1") {
    console.log("Inspection ready on CDP 9338; send a newline to close.");
    await new Promise(resolveInput => process.stdin.once("data", resolveInput));
  }
} catch (error) {
  const page = application.windows()[0];
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => {});
    console.error(JSON.stringify({ artifacts, errors, scene: await page.locator(".scene-settings-panel").innerText().catch(() => "") }));
  }
  throw error;
} finally {
  await application.close();
}
assert.ok((await readFile(join(artifacts, "results.json"), "utf8")).length);
