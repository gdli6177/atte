import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceService, type Goal } from "../../../packages/core/src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalActionDock } from "../src/features/goals/GoalActionDock.tsx";
import { presentGoal } from "../src/features/goals/goalPresentation.ts";
import type { GoalDetailService } from "../src/features/goals/goalService.ts";

test("review offers one message entry and independent acceptance in both detail surfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-review-dock-"));
  try {
    const service = new WorkspaceService(root);
    const created = await service.execute({ type: "goal.intake", text: "待验收页面" }) as Goal;
    const goal = await service.execute({
      type: "goal.review", goalId: created.id,
      delivery: { summary: "已交付", checks: [{ name: "回归", command: "pnpm test", result: "passed" }] },
    }) as Goal;
    const state = await service.read();
    const detailService: GoalDetailService = {
      command: command => service.execute(command),
      importAttachments: async () => [],
      previewAttachment: async () => "",
      openAttachment: async () => {},
      openHerdr: async () => {},
      openUrl: async () => {},
      retryDispatch: async () => {},
      restartGoal: async () => {},
    };
    const view = presentGoal(goal, state);
    const props = {
      goal, view, service: detailService, busy: false, error: "",
      replyMode: null, setReplyMode: () => {}, notify: () => {},
    };
    const markup = renderToStaticMarkup(createElement(GoalActionDock, props));
    assert.equal((markup.match(/>给管家发消息<\/span>/g) ?? []).length, 1);
    assert.match(markup, /验收通过<\/span>/);
    assert.doesNotMatch(markup, /问管家|退回修改/);
    const composer = renderToStaticMarkup(createElement(GoalActionDock, { ...props, replyMode: "message" }));
    assert.match(composer, /发给管家的消息/);
    assert.match(composer, /发送后保留待验收状态/);
    const reconciled = renderToStaticMarkup(createElement(GoalActionDock, {
      ...props, view: { ...view, sceneSync: { label: "已保存", detail: "待核对", quote: "现场已答复" } },
    }));
    assert.match(reconciled, /验收通过<\/span>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
