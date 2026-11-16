import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";

// Exercise backlog and manual takeover through the real packaged app.
const home = await mkdtemp("/tmp/cv-pool-ui-"), workspace = join(home, "workspace");
await mkdir(workspace);
const service = new WorkspaceService(workspace);
await service.execute({
  type: "agents.configure",
  preferences: { concierge: "/missing/cv-pool-test-agent" },
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=",
  "base64",
);
const errors = [];

async function launch() {
  const app = await electron.launch({
    executablePath: resolve(process.env.ATTE_APP_PATH ||
      "apps/desktop/release/Atte-darwin-arm64/Atte.app/Contents/MacOS/Atte"),
    args: [],
    env: {
      ...process.env,
      ATTE_TEST_USER_DATA: join(home, "userData"),
      ATTE_TEST_HOME: home,
      ATTE_TEST_WORKSPACE: workspace,
      ATTE_TEST_ISOLATE_TOOLS: "1",
      ATTE_TEST_SKIP_HERDR_SETUP: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "全部事项", exact: true }).waitFor();
  return { app, page };
}

async function snapshot(page) {
  return page.evaluate(() => window.atte.command({ type: "snapshot" }));
}

let app;
try {
  let page;
  ({ app, page } = await launch());
  await page.getByRole("button", { name: "全部事项", exact: true }).click();
  await page.getByRole("button", { name: "先记一件事", exact: true }).click();
  await page.getByLabel("记下这件事", { exact: true })
    .fill("以后研究新的作品集\n只留个想法，还没有授权开始。");
  await page.getByLabel("选择图片", { exact: true }).setInputFiles({
    name: "idea.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "确认先记下" }).click();
  const row = page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" });
  await row.waitFor();
  const captured = (await snapshot(page)).goals.find(goal =>
    goal.title === "以后研究新的作品集");
  assert.equal(captured.status, "backlog");
  assert.equal(captured.dispatch, undefined);
  assert.equal(captured.attachments.length, 1);
  assert.equal((await snapshot(page)).concierge.status, "not_ready");

  // Restarting must recover the same backlog record and attachment.
  await app.close();
  ({ app, page } = await launch());
  await page.getByRole("button", { name: "全部事项", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" }).click();
  await page.getByText("idea.png", { exact: true }).waitFor();
  await page.getByRole("button", { name: "补充说明", exact: true }).click();
  await page.getByLabel("补充说明", { exact: true })
    .fill("先整理三张参考图，等周末再决定。");
  await page.getByRole("button", { name: "保存说明", exact: true }).click();
  await page.getByText(/记录与补充/).click();
  await page.getByText("先整理三张参考图，等周末再决定。", { exact: true }).waitFor();
  await page.screenshot({ path: join(home, "backlog-detail.png"), animations: "disabled" });
  await page.getByRole("button", { name: "我来做", exact: true }).click();
  await expect(page.getByRole("button", { name: "标记完成", exact: true })).toBeVisible();
  let current = (await snapshot(page)).goals.find(goal => goal.id === captured.id);
  assert.equal(current.mode, "manual");
  assert.equal(current.status, "active");
  assert.equal(current.dispatch, undefined);

  await page.getByRole("button", { name: "提醒我", exact: true }).click();
  await page.getByLabel("提醒时间", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存提醒", exact: true }).click();
  await expect.poll(async () =>
    (await snapshot(page)).goals.find(goal => goal.id === captured.id).remindAt)
    .toBe(new Date("2030-01-01T09:30").toISOString());
  await page.getByRole("button", { name: "修改提醒", exact: true }).click();
  await page.getByRole("button", { name: "取消提醒", exact: true }).click();
  await expect.poll(async () =>
    (await snapshot(page)).goals.find(goal => goal.id === captured.id).remindAt)
    .toBeUndefined();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "跟进中", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" }).click();
  await page.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect.poll(async () =>
    (await snapshot(page)).goals.find(goal => goal.id === captured.id).status)
    .toBe("completed");
  current = (await snapshot(page)).goals.find(goal => goal.id === captured.id);
  assert.equal(current.delivery, undefined);
  assert.equal(current.scene, undefined);

  // Manual takeover remains available after a backlog reminder becomes due.
  await page.getByRole("button", { name: "全部事项", exact: true }).click();
  await page.getByRole("button", { name: "先记一件事", exact: true }).click();
  await page.getByLabel("记下这件事", { exact: true }).fill("我去银行办手续");
  await page.getByRole("button", { name: "确认先记下" }).click();
  const personal = (await snapshot(page)).goals.find(goal => goal.title === "我去银行办手续");
  await page.evaluate(async goalId => {
    await window.atte.command({
      type: "goal.remind", goalId, at: new Date(Date.now() + 1_000).toISOString(),
    });
  }, personal.id);
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  const attention = page.locator(".attention-card").filter({ hasText: "我去银行办手续" });
  await attention.waitFor({ timeout: 6_000 });
  await attention.click();
  await page.getByRole("button", { name: "我来做", exact: true }).click();
  await expect.poll(async () =>
    (await snapshot(page)).goals.find(goal => goal.id === personal.id).mode)
    .toBe("manual");
  current = (await snapshot(page)).goals.find(goal => goal.id === personal.id);
  assert.equal(current.status, "active");
  assert.equal(current.dispatch, undefined);

  assert.deepEqual(errors, []);
  console.log(`Backlog and manual-takeover packaged-app trial passed. Evidence: ${home}`);
} finally {
  await app?.close();
}
