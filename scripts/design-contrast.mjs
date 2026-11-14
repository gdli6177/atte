import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const tokens = await readFile(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8");
const design = await readFile(new URL("../DESIGN.md", import.meta.url), "utf8");
const rules = [...tokens.matchAll(/(:root(?:\[data-theme="light"\])?|body)\s*\{([^{}]*)\}/g)];
const declarations = body => Object.fromEntries(
  [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]),
);
const measurements = [];
const palettes = {};

function parseColor(value, variables, stack = []) {
  if (Array.isArray(value)) return value;
  assert.ok(value, `缺少颜色 token：${stack.join(" → ")}`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) {
    assert.ok(!stack.includes(reference[1]), `颜色 token 循环：${reference[1]}`);
    return parseColor(variables[reference[1]], variables, [...stack, reference[1]]);
  }
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (hex) {
    const expanded = hex[1].length === 3 ? [...hex[1]].map(channel => channel.repeat(2)).join("") : hex[1];
    return expanded.match(/../g).map(channel => Number.parseInt(channel, 16));
  }
  const mixed = /^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+([\d.]+)%,\s*(var\(--[\w-]+\))\)$/.exec(value);
  assert.ok(mixed, `不支持的颜色表达式：${value}`);
  const first = parseColor(mixed[1], variables, stack);
  const second = parseColor(mixed[3], variables, stack);
  const weight = Number(mixed[2]) / 100;
  return first.map((channel, index) => channel * weight + second[index] * (1 - weight));
}

function luminance(channels) {
  const linear = channels.map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function measure(theme, foreground, background, variables, required = 4.5) {
  const foregroundColor = parseColor(variables[foreground], variables);
  const backgroundColor = parseColor(variables[background], variables);
  const first = luminance(foregroundColor);
  const second = luminance(backgroundColor);
  const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  measurements.push({
    theme, foreground, background, foregroundColor, backgroundColor,
    ratio: Number(ratio.toFixed(4)), required, passed: ratio >= required,
  });
}

for (const theme of ["dark", "light"]) {
  const root = {};
  for (const [, selector, body] of rules) {
    if (selector === "body" || (theme === "dark" && selector.includes("data-theme"))) continue;
    Object.assign(root, declarations(body));
  }
  const variables = { ...root };
  for (const [, selector, body] of rules) {
    if (selector !== "body") continue;
    for (const [name, value] of Object.entries(declarations(body))) {
      variables[name] = parseColor(value, root);
    }
  }
  palettes[theme] = root;
  for (const background of ["--bg", "--sidebar", "--surface", "--surface-soft", "--surface-hover", "--surface-raised"]) {
    for (const foreground of ["--text", "--secondary", "--muted", "--link-text"]) {
      measure(theme, foreground, background, variables);
    }
    measure(theme, "--accent", background, variables, 3);
  }
  measure(theme, "--muted", "--surface-soft", variables, 3);
  measure(theme, "--btn-primary-text", "--btn-primary-bg", variables);
  measure(theme, "--btn-primary-text", "--btn-primary-hover-bg", variables);
}

for (const [, name, dark, light] of design.matchAll(/^\| `([\w-]+)` \| (#[\da-f]+) \| (#[\da-f]+) \|$/gmi)) {
  for (const [theme, documented] of [["dark", dark], ["light", light]]) {
    const actual = parseColor(palettes[theme][`--${name}`], palettes[theme]);
    assert.deepEqual(actual, parseColor(documented, {}), `DESIGN.md 的 ${theme}/${name} 与 token 不一致`);
  }
}
const colorRows = [...design.matchAll(/^\| `([\w-]+)` \| (#[\da-f]+) \| (#[\da-f]+) \|$/gmi)];
assert.equal(colorRows.length, 21, "DESIGN.md 必须记录全部 21 个主题颜色");
for (const name of ["caption", "meta", "body", "body-strong", "subtitle", "title", "display", "hero"]) {
  const row = new RegExp(`^\\| ${name} \\| (\\d+(?:\\.\\d+)?) / (\\d+(?:\\.\\d+)?)px \\|`, "m").exec(design);
  assert.ok(row, `DESIGN.md 缺少字阶：${name}`);
  assert.equal(`${row[1]}px`, palettes.dark[`--fs-${name}`], `字号不一致：${name}`);
  assert.equal(`${row[2]}px`, palettes.dark[`--lh-${name}`], `行高不一致：${name}`);
}

const failed = measurements.filter(item => !item.passed);
const report = {
  source: "tokens.css；按 sRGB 相对亮度计算，未代替浏览器合成和真实截图走查",
  measurements,
  failed,
};
if (process.argv[2]) await writeFile(resolve(process.argv[2]), `${JSON.stringify(report, null, 2)}\n`);
for (const theme of ["dark", "light"]) {
  const minimum = Math.min(...measurements.filter(item => item.theme === theme && item.required === 4.5).map(item => item.ratio));
  console.log(`${theme}: 最低正文对比度 ${minimum.toFixed(2)}:1`);
}
assert.deepEqual(failed, [], "颜色对比度不达标");
console.log(`通过 ${measurements.length} 组对比度、21 个颜色和 8 档字阶一致性检查`);
