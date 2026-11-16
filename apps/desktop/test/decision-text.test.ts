import assert from "node:assert/strict";
import test from "node:test";
import { formatDecisionText } from "../src/features/goals/decisionText.js";

const inline =
  "glow 3.0.0 与 bat 0.26.1 已装到 ~/bin 并实测生效，配置零改动。是否验收收尾？A 验收通过，结束这个目标；B 还有要调整的（请说具体哪里）；C 先保留，我稍后自己再试。";

test("inline A/B/C options become separate lines for display", () => {
  const lines = formatDecisionText(inline).split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /是否验收收尾？$/);
  assert.match(lines[1]!, /^A 验收通过/);
  assert.match(lines[2]!, /^B 还有要调整的/);
  assert.match(lines[3]!, /^C 先保留/);
});

test("an already multi-line decision and ordinary prose stay unchanged", () => {
  assert.equal(formatDecisionText("结论\nA 通过\nB 退回"), "结论\nA 通过\nB 退回");
  assert.equal(formatDecisionText("只有一段说明，没有选项。"), "只有一段说明，没有选项。");
  assert.equal(formatDecisionText("保留；A 一项；只有两个分号也只有一个选项"), "保留；A 一项；只有两个分号也只有一个选项");
});
