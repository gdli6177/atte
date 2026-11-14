export function auditVisualState() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  const scope = dialogs.at(-1) ?? document.querySelector(".app") ?? document.body;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const colors = new Map();
  const parse = value => {
    if (!colors.has(value)) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      colors.set(value, [...context.getImageData(0, 0, 1, 1).data]);
    }
    return colors.get(value);
  };
  const blend = (foreground, background) => {
    const alpha = foreground[3] / 255;
    return [...foreground.slice(0, 3).map((channel, index) =>
      channel * alpha + background[index] * (1 - alpha)), 255];
  };
  const luminance = color => {
    const channels = color.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const visible = element => {
    const bounds = element.getBoundingClientRect();
    if (element.closest('[inert], [aria-hidden="true"]') || !element.checkVisibility() ||
      bounds.width < 1 || bounds.height < 1 || bounds.bottom <= 0 || bounds.top >= innerHeight ||
      bounds.right <= 0 || bounds.left >= innerWidth) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const clip = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) &&
        (bounds.bottom <= clip.top || bounds.top >= clip.bottom)) return false;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) &&
        (bounds.right <= clip.left || bounds.left >= clip.right)) return false;
    }
    return true;
  };
  const backgroundOf = element => {
    const layers = [];
    for (let parent = element; parent; parent = parent.parentElement) {
      layers.push(parse(getComputedStyle(parent).backgroundColor));
    }
    let background = parse(getComputedStyle(document.documentElement).backgroundColor);
    for (const layer of layers.reverse()) background = blend(layer, background);
    return background;
  };
  const measurements = [];
  for (const element of scope.querySelectorAll("*")) {
    if (!visible(element)) continue;
    const text = [...element.childNodes]
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent.trim()).filter(Boolean).join(" ");
    if (!text) continue;
    const style = getComputedStyle(element);
    const background = backgroundOf(element);
    const foreground = [...parse(style.color)];
    let opacity = 1;
    for (let parent = element; parent; parent = parent.parentElement) {
      opacity *= Number(getComputedStyle(parent).opacity);
    }
    foreground[3] *= opacity;
    const first = luminance(blend(foreground, background));
    const second = luminance(background);
    const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.666 && Number(style.fontWeight) >= 700);
    const required = element.closest(":disabled, [aria-disabled=true]") || large ? 3 : 4.5;
    measurements.push({ text: text.slice(0, 80), ratio: Number(ratio.toFixed(4)), required, passed: ratio >= required });
  }
  const primary = [...scope.querySelectorAll("button.ui-button--primary, button.primary")]
    .filter(element => !element.disabled && visible(element));
  return {
    measurements,
    failures: measurements.filter(item => !item.passed),
    primaryActions: primary.map(element => element.textContent.trim()),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
  };
}

export function focusedVisualState() {
  const active = document.activeElement;
  if (!active || active === document.body) return undefined;
  let target = active;
  if (active.matches(".ui-checkbox input, .ui-toggle input")) target = active.nextElementSibling;
  if (active.matches(".goal-reply-box textarea")) target = active.closest(".goal-reply-box");
  if (active.matches(".goal-intake")) target = active.closest(".goal-intake-zone");
  const style = getComputedStyle(target);
  const expected = document.createElement("span");
  expected.style.color = style.getPropertyValue("--accent").trim();
  return {
    name: active.getAttribute("aria-label") || active.textContent?.trim().slice(0, 80) || active.tagName,
    focused: active.matches(":focus-visible"),
    outlineWidth: style.outlineWidth,
    outlineStyle: style.outlineStyle,
    outlineOffset: style.outlineOffset,
    outlineColor: style.outlineColor,
    expectedOutlineColor: expected.style.color,
    boxShadow: style.boxShadow,
  };
}
