import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceService, type Goal, type WorkspaceState } from "../../../packages/core/src/index.ts";
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

test("legacy Orca goals expose history only, never acceptance or dispatch controls", () => {
  const goal = {
    id: "legacy", projectId: "personal", title: "旧 Orca 事项", description: "",
    mode: "concierge", status: "review", steps: [], next: "历史下一步", owner: "负责人",
    attention: { kind: "review", summary: "旧验收", since: new Date().toISOString() },
    delivery: { summary: "历史成果", checks: [], submittedAt: new Date().toISOString(), submittedBy: "负责人" },
    activities: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    readOnly: true, readOnlyReason: "legacy-orca",
  } as unknown as Goal;
  const state = { projects: [] } as unknown as WorkspaceState;
  const view = presentGoal(goal, state);
  const markup = renderToStaticMarkup(createElement(GoalActionDock, {
    goal, view, service: {} as GoalDetailService, busy: false, error: "",
    replyMode: null, setReplyMode: () => {}, notify: () => {},
  }));
  assert.match(markup, /只读历史/);
  assert.doesNotMatch(markup, /验收通过|给管家发消息|重试联系管家|打开工作现场/);
});
