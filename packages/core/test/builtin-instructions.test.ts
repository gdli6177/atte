import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinAgentInstructions } from "../src/builtin-instructions.js";
import { ownerSceneReplyInstructions } from "../src/owner-instructions.js";
import type { Goal } from "../src/types.js";

function reviewGoal(): Goal {
  return {
    id: "goal_protocol",
    projectId: "personal",
    title: "实现 A",
    description: "先实现 A，保留原始约束。",
    mode: "concierge",
    status: "review",
    steps: [],
    next: "等待人验收 A",
    owner: "owner-a",
    attention: {
      id: "attention-a",
      kind: "review",
      summary: "请验收 A",
      since: "2026-11-17T00:00:00.000Z",
    },
    activities: [],
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
  };
}

test("负责人和管家每次实质写回都核对 A→A2 的整体标题并保留原文", () => {
  for (const role of ["owner", "concierge"] as const) {
    const instructions = builtinAgentInstructions(reviewGoal(), role);
    assert.match(instructions, /每次实质写回/);
    assert.match(instructions, /A\+A2/);
    assert.match(instructions, /goal update .*--title/);
    assert.match(instructions, /普通进度.*不.*标题/);
    assert.match(instructions, /description.*原文/);
  }
});

test("负责人先读取当前 attention，保存完整原话后由管家唯一执行 rework", () => {
  const instructions = ownerSceneReplyInstructions("goal_protocol");
  assert.ok(instructions.indexOf("atte goal show goal_protocol --json") <
    instructions.indexOf("atte goal scene-reply goal_protocol"));
  assert.match(instructions, /--attention-id <attentionRequest.id>/);
  assert.match(instructions, /--quote "<用户本轮完整原话>"/);
  assert.match(instructions, /review→rework→active/);
  assert.match(instructions, /负责人不得自行.*goal rework/);
  assert.match(instructions, /管家.*核实.*active.*owner send/);
  assert.match(instructions, /转达的原话已保存.*不要重复提交 scene-reply/);
  assert.match(instructions, /atte direct --goal goal_protocol "<用户本轮完整原话>"/);
  assert.match(instructions, /不等于批准、验收或目标完成/);
});

test("管家在现场回执仍有效时先改标题，再带双编号 rework，确认 active 后转原负责人", () => {
  const instructions = builtinAgentInstructions(reviewGoal(), "concierge");
  const title = instructions.indexOf("atte goal update goal_protocol --title");
  const rework = instructions.indexOf("atte goal rework goal_protocol --note");
  const active = instructions.indexOf("核实 status=active", rework);
  const send = instructions.indexOf("atte owner send goal_protocol --text", active);
  assert.ok(title >= 0 && rework > title && active > rework && send > active);
  assert.match(instructions, /--attention-id <attentionRequest.id> --scene-reply-id <sceneReply.id>/);
  assert.match(instructions, /--note "<用户本轮完整原话>"/);
  assert.match(instructions, /旧 scope.*失效/);
  assert.match(instructions, /已.*rework.*不.*重复/);
  assert.match(instructions, /goal update --status active.*goal progress.*拒绝/);
  assert.match(instructions, /转达的原话已保存.*不要重复 scene-reply/);
});

test("review 普通提问与含糊反馈保留交付，只有人能验收", () => {
  for (const instructions of [
    builtinAgentInstructions(reviewGoal(), "concierge"),
    builtinAgentInstructions(reviewGoal(), "owner"),
    ownerSceneReplyInstructions("goal_protocol"),
  ]) {
    assert.match(instructions, /普通提问.*review/);
    assert.match(instructions, /含糊.*澄清/);
    assert.match(instructions, /goal message/);
    assert.match(instructions, /受管 Agent.*不得.*goal accept/);
    assert.match(instructions, /complete.*绕过.*验收/);
  }
});

test("管家的普通问答只转原负责人，goal message 由负责人写回", () => {
  const instructions = builtinAgentInstructions(reviewGoal(), "concierge");
  assert.match(instructions, /owner send.*原负责人.*回答/);
  assert.match(instructions, /由负责人用 goal message/);
  assert.match(instructions, /管家不得调用 goal message/);
});

test("旧 attention 或现场回执拒绝后必须重新读取，不能去掉编号绕过", () => {
  for (const instructions of [
    builtinAgentInstructions(reviewGoal(), "concierge"),
    ownerSceneReplyInstructions("goal_protocol"),
  ]) {
    assert.match(instructions, /attentionRequest.id.*sceneReply.attentionId/);
    assert.match(instructions, /重新读取/);
    assert.match(instructions, /不得去掉 --attention-id.*--scene-reply-id/);
    assert.match(instructions, /state.json/);
  }
});

test("安装的 Skill、命令协议与 eval 同步声明 review 退回和仅人验收", async () => {
  const skill = await readFile(new URL("../../../skills/atte/SKILL.md", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../../../skills/atte/references/cli-protocol.md", import.meta.url), "utf8");
  const evaluation = await readFile(new URL("../../../skills/atte/references/waiting-eval.md", import.meta.url), "utf8");
  for (const instructions of [skill, protocol]) {
    assert.match(instructions, /review→rework→active/);
    assert.match(instructions, /A\+A2/);
    assert.match(instructions, /受管 Agent.*不得.*goal accept/);
    assert.doesNotMatch(instructions, /`accept` for explicit acceptance|using `resolve`, `accept`/);
  }
  for (const scenario of ["A→A2", "普通提问", "完整原话", "旧 attention", "仅人验收"]) {
    assert.ok(evaluation.includes(scenario), `缺少协议验收场景：${scenario}`);
  }
});
