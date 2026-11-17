import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntimeText } from "../../../packages/core/src/index.ts";
import { GoalAgentLastReply } from "../src/features/goals/GoalAgentLastReply.tsx";

const reply = (text: string): AgentRuntimeText => ({
  text,
  sha256: "a".repeat(64),
  truncated: false,
});

test("attention card renders the observed owner reply without an empty placeholder", () => {
  assert.equal(renderToStaticMarkup(createElement(GoalAgentLastReply, {
    reply: undefined,
  })), "");

  const first = renderToStaticMarkup(createElement(GoalAgentLastReply, {
    reply: reply("第一行\n<script>alert(1)</script>"),
  }));
  assert.match(first, /负责人最近回复/);
  assert.match(first, /仅现场观测；目标状态以结构化写回为准/);
  assert.match(first, /第一行\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first, /<script>/);

  const updated = renderToStaticMarkup(createElement(GoalAgentLastReply, {
    reply: reply("更新后的回复\n第二行"),
  }));
  assert.match(updated, /更新后的回复\n第二行/);
  assert.doesNotMatch(updated, /第一行/);
});
