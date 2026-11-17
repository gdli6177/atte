import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { WorkspaceService, clipAgentRuntimeText } from "../packages/core/src/index.ts";
import { auditVisualState, focusedVisualState } from "./lib/visual-audit.mjs";

const artifacts = await mkdtemp(join(tmpdir(), "atte-ui-"));
const screenshots = process.env.ATTE_UI_SCREENSHOT_DIR
  ? resolve(process.env.ATTE_UI_SCREENSHOT_DIR) : join(artifacts, "screenshots");
await mkdir(screenshots, { recursive: true });
const home = join(artifacts, "home");
const workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
const service = new WorkspaceService(workspace);
await service.execute({
  type: "agents.configure",
  preferences: { concierge: "/missing/atte-qa-agent" },
});
const goalDraft = await service.execute({
  type: "goal.intake", text: "核对 Atte 验收入口", handling: "later",
});
const goal = await service.execute({ type: "goal.takeover", goalId: goalDraft.id });
const reviewed = await service.execute({
  type: "goal.review", goalId: goal.id, actor: "owner",
  delivery: {
    summary: "消息与验收分开，反馈保留原话。",
    checks: [{ name: "交互回归", command: "pnpm test:atte-ui", result: "passed" }],
  },
});
const ownerReply = "盘点结果已经写入。\n可以继续按结论合并入口。";
const attemptId = "attempt-ui-followup";
await service.execute({
  type: "agent.runtime.register", goalId: goal.id,
  attempt: {
    goalId: goal.id, attemptId, agent: "owner-ui", adapter: "codex",
    startedAt: new Date().toISOString(),
  },
  hookTokenHash: "a".repeat(64), capabilities: ["agent.response"],
});
async function observeReply(sequence, content) {
  await service.execute({
    type: "agent.runtime.event",
    event: {
      version: "v1", eventId: `ui-reply-${sequence}`, sequence,
      at: new Date().toISOString(), source: "hook", agent: "owner-ui", adapter: "codex",
      goalId: goal.id, attemptId, type: "agent.response", content: clipAgentRuntimeText(content),
    },
  });
}
await observeReply(1, ownerReply);
const appPath = resolve(process.env.ATTE_APP_PATH ??
  "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte");
const application = await electron.launch({
  executablePath: appPath,
  args: [...(process.env.ATTE_ATTE_UI_HOLD === "1"
    ? ["--remote-debugging-port=9338"] : [])],
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: "/usr/bin:/bin",
    ATTE_TEST_HOME: home,
    ATTE_TEST_USER_DATA: join(home, "userData"),
    ATTE_TEST_WORKSPACE: workspace,
    ATTE_TEST_ISOLATE_TOOLS: "1",
    ATTE_TEST_SKIP_HERDR_SETUP: "1",
  },
  timeout: 60_000,
});
const errors = [];
const measurements = [];
const visualChecks = [];
const keyboardChecks = [];
try {
  const page = await application.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "注意力", exact: true }).waitFor();
  await expect(page).toHaveTitle("Atte");
  const native = await application.evaluate(({ app, Menu, BrowserWindow }) => ({
    name: app.getName(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    menu: Menu.getApplicationMenu()?.items[0].label,
    about: Menu.getApplicationMenu()?.items[0].submenu?.items.some(item => item.role === "about"),
    background: BrowserWindow.getAllWindows()[0].getBackgroundColor(),
  }));
  assert.equal(native.name, "Atte");
  assert.equal(native.menu, "Atte");
  assert.equal(native.about, true);
  assert.equal(native.userData, join(home, "userData"));
  const tokenSource = await readFile(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8");
  const startupBackground = /--palette-dark-bg:\s*(#[\da-f]{6});/i.exec(tokenSource)?.[1];
  assert.equal(native.background.toLowerCase(), startupBackground?.toLowerCase());

  async function theme(value) {
    await page.evaluate(next => {
      localStorage.setItem("atte.theme", next);
    }, value);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  }
  async function capture(name, matrix = false, target = page) {
    await target.screenshot({ path: join(matrix ? screenshots : artifacts, `${name}.png`), animations: "disabled" });
    if (matrix) {
      const audit = await target.evaluate(auditVisualState);
      visualChecks.push({ name, ...audit });
      assert.deepEqual(audit.failures, [], `${name}: 正文对比度`);
      assert.equal(audit.horizontalOverflow, false, `${name}: 横向溢出`);
      assert.ok(audit.primaryActions.length <= 1, `${name}: ${audit.primaryActions.join(" / ")}`);
      if (target.viewportSize()?.width === 900) await keyboardFocus(target, name);
    }
  }
  async function keyboardFocus(target, name) {
    const count = await target.evaluate(() => {
      const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document.body;
      return [...scope.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')]
        .filter(element => element.checkVisibility() && !element.closest('[inert], [aria-hidden="true"]')).length;
    });
    const observed = [];
    for (let index = 0; index < count; index += 1) {
      await target.keyboard.press("Tab");
      const focus = await target.evaluate(focusedVisualState);
      if (!focus) continue;
      assert.equal(focus.focused, true, JSON.stringify(focus));
      assert.equal(focus.outlineWidth, "2px", JSON.stringify(focus));
      assert.equal(focus.outlineStyle, "solid", JSON.stringify(focus));
      assert.equal(focus.outlineOffset, "2px", JSON.stringify(focus));
      assert.equal(focus.outlineColor, focus.expectedOutlineColor, JSON.stringify(focus));
      assert.equal(focus.boxShadow, "none", JSON.stringify(focus));
      observed.push(focus);
    }
    assert.ok(observed.length > 0, `${name}: 没有可观察的键盘焦点`);
    keyboardChecks.push({ name, observed });
  }
  async function openReview() {
    await page.getByRole("button", { name: "注意力", exact: true }).click();
    await page.locator(".attention-card").filter({ hasText: goal.title }).click();
    await page.locator(".goal-attention-modal").waitFor();
    await expect(page.getByRole("button", { name: "给管家发消息", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "验收通过", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "问管家", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退回修改", exact: true })).toHaveCount(0);
    const reply = page.getByRole("region", { name: "负责人最近回复", exact: true });
    await expect(reply).toBeVisible();
    await expect(reply.locator("p")).toHaveText(ownerReply);
    assert.equal(await reply.locator("p").evaluate(element => getComputedStyle(element).whiteSpace), "pre-wrap");
  }
  for (const value of ["dark", "light"]) {
    await theme(value);
    for (const [width, height] of [[1440, 960], [1024, 768], [900, 700]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => {
        const image = document.querySelector(".pixel-scene img");
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      });
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
      assert.equal(layout.markVisible, width === 1440, JSON.stringify(layout));
      if (layout.markVisible) assert.equal(layout.markWidth, 96, JSON.stringify(layout));
      assert.equal(layout.markClipped, false);
      assert.equal(layout.overlapsTitle, false);
      measurements.push({ theme: value, height, ...layout });
      await capture(`home-${value}-${width}×${height}`, true);
      await openReview();
      await capture(`review-${value}-${width}×${height}`, true);
      await page.getByRole("button", { name: "完整记录", exact: true }).click();
      await page.locator(".goal-detail-modal").waitFor();
      await capture(`detail-${value}-${width}×${height}`, true);
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await capture(`settings-${value}-${width}×${height}`, true);
      if (width === 900) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await page.locator(".ui-button").first().evaluate(element =>
          getComputedStyle(element).transitionDuration), "0s");
        await expect.poll(() => page.evaluate(() => {
          const animations = document.getAnimations();
          for (const animation of animations) {
            const target = animation.effect?.target;
            if (target instanceof Element) getComputedStyle(target).animationName;
          }
          return animations.filter(animation => animation.playState === "running")
            .map(animation => ({
              name: animation.id || animation.animationName || animation.transitionProperty,
              target: animation.effect?.target?.getAttribute("class"),
            }));
        }), { timeout: 1_000 }).toEqual([]);
        await page.emulateMedia({ reducedMotion: "no-preference" });
      }
      await page.getByRole("button", { name: "注意力", exact: true }).click();
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
    await expect(page.getByRole("navigation", { name: "设置分组" }).getByRole("link")).toHaveCount(6);
    const settings = page.locator(".settings");
    const maintenance = page.locator("#settings-maintenance");
    const maintenanceSummary = maintenance.locator(":scope > summary");
    await expect(maintenance).toHaveJSProperty("open", false);
    await expect(settings.getByRole("heading", { name: "Agent 接入", exact: true })).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Herdr 运行时", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "准备管家", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "打开内嵌轻现场", exact: true })).toHaveCount(0);
    await expect(settings.locator(".policy-row")).toHaveCount(0);
    const policyBefore = (await service.read()).projects.map(project => ({ id: project.id, policy: project.policy }));
    const projectPolicies = settings.locator(".settings-policy");
    await expect(projectPolicies).toHaveJSProperty("open", false);
    await projectPolicies.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(projectPolicies).toHaveJSProperty("open", true);
    await expect(settings.locator(".policy-row")).toHaveCount(policyBefore.length);
    const firstPolicy = settings.locator(".policy-row").first();
    await firstPolicy.getByRole("button", { name: "配置", exact: true }).click();
    await firstPolicy.getByLabel("上线策略", { exact: true }).selectOption("auto");
    await firstPolicy.getByRole("button", { name: "取消", exact: true }).click();
    await projectPolicies.locator(":scope > summary").focus();
    await page.keyboard.press("Space");
    await expect(projectPolicies).toHaveJSProperty("open", false);
    await expect(settings.locator(".policy-row")).toHaveCount(0);
    assert.deepEqual((await service.read()).projects.map(project => ({ id: project.id, policy: project.policy })),
      policyBefore, "expanding, cancelling and collapsing project exceptions must not change authorization");
    await expect(settings.locator("#settings-authority details").last()).toHaveJSProperty("open", false);
    await maintenanceSummary.focus();
    await page.keyboard.press("Enter");
    await expect(maintenance).toHaveJSProperty("open", true);
    await expect(maintenance.getByRole("heading", { name: "关于 Atte", exact: true })).toHaveCount(1);
    await maintenanceSummary.focus();
    await page.keyboard.press("Space");
    await expect(maintenance).toHaveJSProperty("open", false);
    await page.getByRole("link", { name: "高级与维护", exact: true }).click();
    await expect(maintenance).toHaveJSProperty("open", true);
    await expect(maintenanceSummary).toBeFocused();
    await expect(maintenance.getByRole("button", { name: "复制诊断日志", exact: true })).toBeVisible();
    await maintenanceSummary.press("Enter");
    await expect(maintenance).toHaveJSProperty("open", false);
    const appearance = page.locator(".ui-settings-card").filter({ has: page.getByRole("heading", { name: "外观", exact: true }) });
    const next = value === "dark" ? "light" : "dark";
    await appearance.getByRole("button", { name: next === "light" ? "浅色" : "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    await expect(appearance.getByText("有未保存的更改", { exact: true })).toBeVisible();
    await appearance.getByRole("button", { name: "保存外观", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    assert.equal(await page.evaluate(() => localStorage.getItem("atte.theme")), next);
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
    const originalScene = await page.evaluate(() => window.atte.sceneSettings());
    assert.notEqual(originalScene.settings.openWith, "embedded");
    await scene.getByRole("button", { name: "保存工作现场", exact: true }).click();
    await expect(scene.getByRole("button", { name: "保存工作现场", exact: true })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.atte.sceneSettings())).settings.openWith, "embedded");
    await scene.getByRole("button", { name: "外部终端（推荐）", exact: true }).click();
    await scene.getByRole("button", { name: "保存工作现场", exact: true }).click();
    await expect(scene.getByRole("button", { name: "保存工作现场", exact: true })).toBeDisabled();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await openReview();
  const updatedTitle = "合并重复入口并验证现有使用方式";
  const updatedReply = "已收到基于盘点结论的新要求。\n待管家退回推进后继续。";
  const beforeObservation = (await service.read()).goals.find(item => item.id === goal.id);
  await service.execute({
    type: "goal.update", goalId: goal.id, patch: { title: updatedTitle }, actor: "owner-ui",
  });
  await observeReply(2, updatedReply);
  await expect(page.locator(".goal-attention-title")).toHaveText(updatedTitle);
  await expect(page.getByRole("region", { name: "负责人最近回复", exact: true }).locator("p")).toHaveText(updatedReply);
  const observed = (await service.read()).goals.find(item => item.id === goal.id);
  assert.equal(observed.status, "review");
  assert.deepEqual(observed.delivery, beforeObservation.delivery);
  assert.deepEqual(observed.attention, beforeObservation.attention);
  assert.equal(observed.description, beforeObservation.description);
  assert.equal(observed.activities.length, beforeObservation.activities.length + 1);
  assert.equal(observed.activities.at(-1).actor, "owner-ui");
  assert.ok(!observed.activities.some(activity => activity.text === updatedReply));
  await capture("review-live-followup");
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
  const onboardingHome = join(artifacts, "onboarding-home");
  await mkdir(onboardingHome, { recursive: true });
  const onboarding = await electron.launch({
    executablePath: appPath,
    args: [],
    env: {
      ...process.env,
      HOME: onboardingHome,
      XDG_CONFIG_HOME: join(onboardingHome, ".config"),
      XDG_STATE_HOME: join(onboardingHome, ".local/state"),
      PATH: "/usr/bin:/bin",
      ATTE_TEST_HOME: onboardingHome,
      ATTE_TEST_USER_DATA: join(onboardingHome, "userData"),
      ATTE_TEST_WORKSPACE: "",
      ATTE_TEST_ISOLATE_TOOLS: "1",
      ATTE_TEST_SKIP_HERDR_SETUP: "1",
    },
    timeout: 60_000,
  });
  try {
    const welcome = await onboarding.firstWindow();
    welcome.on("pageerror", error => errors.push(error.message));
    await welcome.locator(".welcome").waitFor();
    for (const value of ["dark", "light"]) {
      await welcome.evaluate(next => localStorage.setItem("atte.theme", next), value);
      await welcome.reload();
      await expect(welcome.locator("html")).toHaveAttribute("data-theme", value);
      await welcome.locator(".welcome").waitFor();
      for (const [width, height] of [[1440, 960], [1024, 768], [900, 700]]) {
        await welcome.setViewportSize({ width, height });
        await capture(`onboarding-${value}-${width}×${height}`, true, welcome);
      }
    }
  } finally {
    await onboarding.close();
  }
  assert.deepEqual(errors, []);
  const result = { native, measurements, visualChecks, keyboardChecks, errors };
  await writeFile(join(artifacts, "results.json"), JSON.stringify(result, null, 2));
  await writeFile(join(screenshots, "ui-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: "passed", artifacts, screenshots, checks: ["branding", "review-message", "failed-send", "acceptance", "settings-save", "responsive", "reduced-motion", "contrast", "focus", "single-primary", "onboarding"] }));
  if (process.env.ATTE_ATTE_UI_HOLD === "1") {
    console.log("Inspection ready on CDP 9338; send a newline to close.");
    await new Promise(resolveInput => process.stdin.once("data", resolveInput));
    process.stdin.pause();
  }
} catch (error) {
  const page = application.windows()[0];
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => {});
    console.error(JSON.stringify({ artifacts, errors, scene: await page.locator(".scene-settings-panel").innerText().catch(() => "") }));
  }
  if (process.env.ATTE_ATTE_UI_HOLD === "1") {
    console.log("Failure inspection ready on CDP 9338; send a newline to close.");
    await new Promise(resolveInput => process.stdin.once("data", resolveInput));
    process.stdin.pause();
  }
  throw error;
} finally {
  await application.close();
}
assert.ok((await readFile(join(artifacts, "results.json"), "utf8")).length);
