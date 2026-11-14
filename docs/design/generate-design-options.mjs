import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logoDir = join(here, "logo-options");
const baselineDir = join(here, "baseline-compare");
const mascot = await readFile(join(here, "../../apps/desktop/assets/brand/atte-mascot-baseline-512.png"));
const mascotUri = `data:image/png;base64,${mascot.toString("base64")}`;
await mkdir(logoDir, { recursive: true });
await mkdir(baselineDir, { recursive: true });

const svg = (body, title, description) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">${description}</desc>
${body}
</svg>
`;

const logos = {
  "01-pixel-mascot": svg(`
  <defs>
    <radialGradient id="halo" cx="50%" cy="42%" r="53%">
      <stop offset="0" stop-color="#25376e"/>
      <stop offset=".7" stop-color="#11182f"/>
      <stop offset="1" stop-color="#090d18"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#87f5df"/><stop offset=".52" stop-color="#7ca9ff"/><stop offset="1" stop-color="#f8d47d"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#halo)"/>
  <rect x="24" y="24" width="976" height="976" rx="202" fill="none" stroke="url(#rim)" stroke-opacity=".2" stroke-width="8"/>
  <circle cx="512" cy="492" r="345" fill="none" stroke="#f8d47d" stroke-opacity=".1" stroke-width="4"/>
  <image href="${mascotUri}" x="92" y="92" width="840" height="840" preserveAspectRatio="xMidYMid meet" style="image-rendering:pixelated"/>
`, "Atte 像素吉祥物升级", "深靛圆角底上放大的原有像素吉祥物，保留完整角色识别。"),
  "02-attention-a": svg(`
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#0a1518"/><stop offset="1" stop-color="#152b2e"/>
    </linearGradient>
    <linearGradient id="stroke" gradientUnits="userSpaceOnUse" x1="200" y1="760" x2="800" y2="260">
      <stop stop-color="#5ce1c5"/><stop offset=".55" stop-color="#91a9ff"/><stop offset="1" stop-color="#f8c96f"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="22" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <rect x="28" y="28" width="968" height="968" rx="199" fill="none" stroke="#d9fff6" stroke-opacity=".12" stroke-width="6"/>
  <path d="M238 738 467 278" fill="none" stroke="url(#stroke)" stroke-width="64" stroke-linecap="round"/>
  <path d="M786 738 557 278" fill="none" stroke="url(#stroke)" stroke-width="64" stroke-linecap="round"/>
  <path d="M349 584 L675 584" fill="none" stroke="url(#stroke)" stroke-width="46" stroke-linecap="round" stroke-opacity=".86"/>
  <circle cx="512" cy="501" r="58" fill="#fff0b5" filter="url(#glow)"/>
  <circle cx="512" cy="501" r="23" fill="#fffdf1"/>
`, "Atte 注意力层", "由两束汇聚线和中心光点构成的极简 A，表达注意力收束。"),
  "03-mascot-wordmark": svg(`
  <defs>
    <linearGradient id="word" x1="0" y1="0" x2="1" y2=".6">
      <stop stop-color="#4665b0"/><stop offset="1" stop-color="#7890dc"/>
    </linearGradient>
  </defs>
  <image href="${mascotUri}" x="35" y="213" width="430" height="430" preserveAspectRatio="xMidYMid meet" style="image-rendering:pixelated"/>
  <text x="486" y="505" fill="url(#word)" font-family="ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, sans-serif" font-size="250" font-weight="650" letter-spacing="-14">Atte</text>
  <path d="M501 551h389" stroke="#28b8a3" stroke-width="16" stroke-linecap="round"/>
  <circle cx="907" cy="551" r="11" fill="#f2b951"/>
`, "Atte 吉祥物与字标", "原有像素吉祥物与 Atte 字标并列，适合需要直接读出产品名的场景。"),
};
for (const [name, content] of Object.entries(logos))
  await writeFile(join(logoDir, `${name}.svg`), content);

const previewMarkup = (name, theme) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:768px;overflow:hidden}body{display:grid;place-items:center;background:#0b0e15;color:#f4f7ff;font:500 20px ui-sans-serif,system-ui,sans-serif}
.light{background:#f5f3ed;color:#182033}.frame{display:grid;place-items:center;gap:24px}.mark{width:500px;height:500px;object-fit:contain}.label{opacity:.6;letter-spacing:.12em;text-transform:uppercase}
</style><body class="${theme}"><div class="frame"><img alt="" class="mark" src="${name}.svg"><div class="label">Atte · logo option</div></div>`;
for (const name of Object.keys(logos)) {
  await writeFile(join(logoDir, `${name}.preview-dark.html`), previewMarkup(name, "dark"));
  await writeFile(join(logoDir, `${name}.preview-light.html`), previewMarkup(name, "light"));
}

const logoIndex = `# Atte Logo 备选

状态：**历史评审材料。最终已选定 Six Vectors，本目录不再代表当前品牌。**
当前标识见 [Six Vectors 品牌使用规范](../../brand/six-vectors.md)。
每个方案提供透明背景的 1024×1024 SVG 与 PNG、深色和浅色背景预览；图标均保留
四周安全区。第一个方案使用现有像素吉祥物，后两个方向不改变当前运行时资产。

| 方案 | 方向 | 一句话说明 | 文件 |
| --- | --- | --- | --- |
| 01 | 现有像素吉祥物升级 | 深靛圆角底上放大的原有像素吉祥物，保留完整角色识别。 | [SVG](01-pixel-mascot.svg) · [PNG](01-pixel-mascot.png) · [深色](01-pixel-mascot.preview-dark.png) · [浅色](01-pixel-mascot.preview-light.png) |
| 02 | 全新极简图形 | 两束注意力线汇聚成 A，中心光点表示需要人处理的那件事。 | [SVG](02-attention-a.svg) · [PNG](02-attention-a.png) · [深色](02-attention-a.preview-dark.png) · [浅色](02-attention-a.preview-light.png) |
| 03 | 吉祥物 + 字标 | 缩小吉祥物并列 Atte 字标，兼顾角色记忆与产品名识别。 | [SVG](03-mascot-wordmark.svg) · [PNG](03-mascot-wordmark.png) · [深色](03-mascot-wordmark.preview-dark.png) · [浅色](03-mascot-wordmark.preview-light.png) |

## 比较

- **01 像素吉祥物**：延续现有资产，迁移风险最低；在 32px 下细节较多，适合桌面应用
  图标，不一定是单色菜单栏图标的最佳选择。
- **02 极简 A**：缩放最稳，深浅背景与单色化最容易；品牌角色感弱于吉祥物，需要
  后续再建立拟人化资产。
- **03 吉祥物 + 字标**：产品名识别直接，适合 README、启动页和宣传物料；方形图标
  内元素较多，超小尺寸需另做只保留吉祥物的响应式版本。

预览使用同一 1024×768 画布、同一图形尺寸和系统字体，只改变背景色，便于只比较
图形本身。可运行 \`node docs/design/generate-design-options.mjs\` 重新生成。
`;
await writeFile(join(logoDir, "README.md"), logoIndex);

const homeBody = `
<div class="app">
  <aside>
    <div class="brand"><span class="brand-mark">A</span><strong>Atte</strong></div>
    <nav><a class="active">注意力 <b>3</b></a><a>我的工作台</a><a>所有目标</a><a>待办池</a></nav>
    <div class="projects"><small>项目</small><a>个人事项</a><a>Atte</a><a>客户支持</a></div>
    <div class="concierge"><span>全局管家</span><strong>正在整理下一轮</strong><button>回到现场</button></div>
  </aside>
  <main>
    <header><span class="crumb">我的工作台 / 注意力</span><button class="new">＋ 新目标</button></header>
    <section class="hero"><p class="eyebrow">Atte · 注意力中心 · The attention layer</p><h1>现在，只需要你处理这 3 件事。</h1><p class="intro">其余目标正在按计划推进。Agent 的普通进展不会打断你。</p></section>
    <section class="attention"><div><h2>需要你留意</h2><span>按优先级排序</span></div>
      <article><div class="status review">待验收</div><div class="copy"><small>Atte / 负责人 2 分钟前更新</small><h3>桌面安装包 0.11.0 已准备好</h3><p>检查 DMG、ZIP 与安装后的 CLI 写回；独立复核已通过。</p></div><button>查看交付</button></article>
      <article><div class="status decision">待决定</div><div class="copy"><small>客户支持 / 刚刚</small><h3>下周是否接入新的工单来源？</h3><p>会影响 Webhook 范围和首轮迁移，负责人已列出两种取舍。</p></div><button>回答问题</button></article>
      <article><div class="status wait">到期跟进</div><div class="copy"><small>个人事项 / 今天 15:40</small><h3>确认 YR 是否收到合同修订</h3><p>外部联系人尚未回复，其他准备工作已经完成。</p></div><button>记录进展</button></article>
    </section>
  </main>
  <aside class="context"><span class="eyebrow">今日</span><div class="metric"><b>8</b><span>推进中</span></div><div class="metric"><b>3</b><span>需要你</span></div><hr><h4>最近完成</h4><p>方法库安装说明已更新</p><p>Windows 抄送问题已归档</p><button>打开发送记录</button></aside>
</div>`;

const themes = {
  "linear": {
    label: "Linear",
    note: "近黑画布、细分层表面与紧凑工程工具层级；使用随机强调色而不是 Linear 原色。",
    css: `
*{box-sizing:border-box}body{margin:0;background:#08090a;color:#f4f4f5;font:13px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}.app{display:grid;grid-template-columns:236px minmax(0,1fr) 250px;min-height:100vh}aside{padding:24px 18px;border-right:1px solid #242629;background:#0c0d0f}.brand{display:flex;align-items:center;gap:10px;margin-bottom:30px}.brand-mark{display:grid;place-items:center;width:29px;height:29px;border-radius:8px;background:linear-gradient(135deg,#7c86ff,#4bdcb1);color:#08090a;font-weight:800}nav,.projects{display:grid;gap:4px}nav a,.projects a{padding:8px 10px;border-radius:6px;color:#a9abb2}nav a.active{background:#202126;color:#fff}nav b{margin-left:auto;font-size:11px}nav a{display:flex}.projects{margin-top:30px}.projects small{padding:0 10px 8px;color:#656871;font-size:11px}.concierge{margin-top:auto;padding:16px;border:1px solid #27292e;border-radius:9px;background:#121316}.concierge span,.concierge strong{display:block}.concierge span{color:#72757e;font-size:11px}.concierge strong{margin:5px 0 13px;font-size:12px}button{border:1px solid #303238;border-radius:6px;background:#1a1b1f;color:#e8e8ea;padding:7px 10px;font:inherit}main{padding:0 44px 44px}header{height:62px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #202226}.crumb{color:#777a83;font-size:12px}.new{background:#676ff1;border-color:#676ff1;color:white}.hero{padding:44px 0 30px}.eyebrow{color:#777a83;font-size:10px;letter-spacing:.13em;font-weight:700}.hero h1{max-width:680px;margin:11px 0 8px;font-size:34px;line-height:1.16;letter-spacing:-.035em}.intro{color:#92959d}.attention>div{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}.attention h2{margin:0;font-size:15px}.attention span{color:#666a73;font-size:12px}.attention article{display:grid;grid-template-columns:78px minmax(0,1fr) auto;align-items:center;gap:18px;margin:8px 0;padding:17px;border:1px solid #23252a;border-radius:8px;background:#0f1012}.attention article:hover{background:#141519;border-color:#303238}.status{align-self:start;padding:4px 7px;border-radius:5px;font-size:10px;text-align:center}.review{background:#183126;color:#66d6a2}.decision{background:#2d243f;color:#bca1ff}.wait{background:#332c1e;color:#e5bd6f}.copy small{color:#686b73;font-size:11px}.copy h3{margin:5px 0;font-size:15px}.copy p{margin:0;color:#92959d}.context{background:#0b0c0e}.metric{display:flex;justify-content:space-between;margin-top:18px}.metric b{font-size:25px;font-weight:550}.metric span{color:#777a83}.context hr{margin:28px 0;border:0;border-top:1px solid #27292e}.context h4{font-size:12px}.context p{color:#83868e;border-bottom:1px solid #1d1f23;padding-bottom:12px}`,
  },
  "raycast": {
    label: "Raycast",
    note: "近黑画布、命令面板式紧凑行、发丝边界与白色主按钮；强调快速操作而不是营销展示。",
    css: `
*{box-sizing:border-box}body{margin:0;background:#07080a;color:#f4f4f6;font:13px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}.app{display:grid;grid-template-columns:236px minmax(0,1fr) 250px;min-height:100vh}aside{padding:22px 16px;border-right:1px solid #242728;background:#0d0d0d}aside:last-child{border-right:0;border-left:1px solid #242728;background:#0a0b0c}.brand{display:flex;align-items:center;gap:10px;margin-bottom:30px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #34363a;border-radius:7px;background:#121212;color:#fff;font-weight:700}nav,.projects{display:grid;gap:3px}nav a,.projects a{padding:8px 10px;border-radius:6px;color:#b7b8ba}nav a.active{background:#18191a;color:#fff}nav a{display:flex}nav b{margin-left:auto;padding:0 6px;border:1px solid #34363a;border-radius:99px;font-size:10px}.projects{margin-top:30px}.projects small{padding:0 10px 7px;color:#6a6b6c}.concierge{margin-top:30px;padding:15px;border:1px solid #242728;border-radius:8px;background:#101111}.concierge span,.concierge strong{display:block}.concierge span{color:#77787a;font-size:11px}.concierge strong{margin:5px 0 13px}.app button{border:1px solid #303236;border-radius:7px;background:#121212;color:#f4f4f6;padding:7px 11px;font:inherit}main{padding:0 44px 44px}header{height:64px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #202223}.crumb{color:#8f9092}.new{background:#fff!important;border-color:#fff!important;color:#0a0a0a!important}.hero{padding:44px 0 30px}.eyebrow{color:#77787a;font-size:10px;letter-spacing:.14em;font-weight:700}.hero h1{max-width:680px;margin:11px 0 9px;font-size:36px;line-height:1.14;letter-spacing:-.035em}.intro{color:#9c9c9d}.attention>div{display:flex;align-items:baseline;gap:13px;margin-bottom:12px}.attention h2{margin:0;font-size:16px}.attention span{color:#77787a}.attention article{display:grid;grid-template-columns:80px minmax(0,1fr) auto;align-items:center;gap:18px;margin:7px 0;padding:16px;border:1px solid #242728;border-radius:8px;background:#0d0d0d}.attention article:hover{background:#101111}.status{align-self:start;padding:4px 7px;border:1px solid #3b3d40;border-radius:6px;background:#151617;font-size:10px;text-align:center}.review{color:#59d499}.decision{color:#57c1ff}.wait{color:#ffc533}.copy small{color:#77787a;font-size:11px}.copy h3{margin:5px 0;font-size:15px}.copy p{margin:0;color:#9c9c9d}.context h4{font-size:12px}.metric{display:flex;justify-content:space-between;margin-top:17px}.metric b{font-size:25px;font-weight:520}.metric span{color:#77787a}.context hr{margin:27px 0;border:0;border-top:1px solid #242728}.context p{color:#858688;border-bottom:1px solid #1b1d1f;padding-bottom:12px}`,
  },
  "vercel": {
    label: "Vercel",
    note: "高对比黑白画布、胶囊按钮、技术标签与少量渐变强调；结构最轻，适合把注意力内容留在前景。",
    css: `
*{box-sizing:border-box}body{margin:0;background:#fff;color:#171717;font:14px/1.55 Geist,Inter,ui-sans-serif,system-ui,sans-serif}.app{display:grid;grid-template-columns:240px minmax(0,1fr) 260px;min-height:100vh}.app:before{content:"";position:fixed;z-index:2;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#007cf0,#00dfd8 24%,#7928ca 52%,#ff0080 72%,#f9cb28)}aside{padding:26px 18px;border-right:1px solid #ebebeb;background:#fafafa}aside:last-child{border-right:0;border-left:1px solid #ebebeb;background:#fafafa}.brand{display:flex;align-items:center;gap:10px;margin-bottom:32px}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:99px;background:#171717;color:#fff;font-weight:650}nav,.projects{display:grid;gap:3px}nav a,.projects a{padding:8px 11px;border-radius:7px;color:#4d4d4d}nav a.active{background:#f5f5f5;color:#171717;font-weight:600}nav a{display:flex}nav b{margin-left:auto;border:1px solid #ebebeb;border-radius:99px;padding:0 7px;background:#fff;font:600 10px Geist Mono,ui-monospace,monospace}.projects{margin-top:30px}.projects small{padding:0 11px 7px;color:#888;font:10px Geist Mono,ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase}.concierge{margin-top:30px;padding:16px;border:1px solid #ebebeb;border-radius:10px;background:#fff}.concierge span,.concierge strong{display:block}.concierge span{color:#888;font:10px Geist Mono,ui-monospace,monospace;text-transform:uppercase}.concierge strong{margin:6px 0 13px}.app button{border:1px solid #ebebeb;border-radius:99px;background:#fff;color:#171717;padding:7px 12px;font:500 12px inherit}main{padding:0 50px 48px}header{height:70px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ebebeb}.crumb{color:#888;font:11px Geist Mono,ui-monospace,monospace}.new{background:#171717!important;border-color:#171717!important;color:#fff!important}.hero{padding:46px 0 34px}.eyebrow{color:#888;font:10px Geist Mono,ui-monospace,monospace;letter-spacing:.1em}.hero h1{max-width:680px;margin:12px 0 10px;font-size:40px;line-height:1.08;letter-spacing:-.045em}.intro{color:#4d4d4d;font-size:15px}.attention>div{display:flex;align-items:baseline;gap:14px;margin-bottom:13px}.attention h2{margin:0;font-size:18px}.attention span{color:#888;font-size:12px}.attention article{display:grid;grid-template-columns:82px minmax(0,1fr) auto;align-items:center;gap:20px;margin:9px 0;padding:18px;border:1px solid #ebebeb;border-radius:9px;background:#fff}.attention article:hover{background:#fafafa}.status{align-self:start;padding:4px 8px;border:1px solid #ebebeb;border-radius:99px;background:#fafafa;font:10px Geist Mono,ui-monospace,monospace;text-align:center}.review{color:#0070f3}.decision{color:#7928ca}.wait{color:#ab570a}.copy small{color:#888;font-size:11px}.copy h3{margin:5px 0;font-size:16px}.copy p{margin:0;color:#4d4d4d}.context h4{font-size:13px}.metric{display:flex;justify-content:space-between;margin-top:18px}.metric b{font-size:27px;font-weight:600}.metric span{color:#888}.context hr{margin:28px 0;border:0;border-top:1px solid #ebebeb}.context p{color:#4d4d4d;border-bottom:1px solid #ebebeb;padding-bottom:12px}`,
  },
};

for (const [key, theme] of Object.entries(themes)) {
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Atte 首页 · ${theme.label} 参考稿</title><style>${theme.css}</style>
${homeBody}</html>`;
  await writeFile(join(baselineDir, `${key}.html`), html);
}
const baselineIndex = `# 首页设计基线对比

状态：**三份都是静态比较稿，不锁定最终设计，也没有改正式界面。**
三份使用完全相同的页面结构与内容，只更换视觉系统，便于比较取舍。

| 参考 | 静态稿 | 主要取舍 |
| --- | --- | --- |
| Linear | [linear.html](linear.html) | 信息密度高、工程工具气质强；深色长时间阅读好，但对非工程用户更冷。 |
| Raycast | [raycast.html](raycast.html) | 命令面板式紧凑行和白色主按钮操作感最强；密集深色界面需要更严格控制信息噪声。 |
| Vercel | [vercel.html](vercel.html) | 黑白对比和胶囊控件最轻、最清楚；技术感强，但柔和度和角色识别弱于前两者。 |

来源版本为 awesome-design-md \`fcc70284932276d085f01ef9f83edde90b1258cb\` 中
[Linear](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/linear.app/DESIGN.md)、
[Raycast](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/raycast/DESIGN.md) 和
[Vercel](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/vercel/DESIGN.md)
的实际文件；不是按品牌印象仿制。字体使用系统字体，未复制候选品牌字体、Logo、
配色或营销素材。

## 共同页面

- 左侧：工作区、注意力计数、项目与管家入口。
- 主区：一句当前结论、三条不同优先级的注意力卡、每卡一个主动作。
- 右侧：今日概览、最近完成与记录入口。

对比只覆盖首页静态外观，不证明键盘、焦点、响应式、真实数据或 Electron 打包已验收。
可运行 \`node docs/design/generate-design-options.mjs\` 重新生成 HTML 与 Logo PNG；
渲染依赖本机 Sharp，可用 \`ATTE_SHARP_PATH\` 指向已安装的 Sharp 入口。
`;
await writeFile(join(baselineDir, "README.md"), baselineIndex);

let sharp;
try {
  ({ default: sharp } = await import(process.env.ATTE_SHARP_PATH ?? "sharp"));
} catch {
  throw new Error("PNG rendering requires Sharp; install it or set ATTE_SHARP_PATH to its entry file");
}
for (const name of Object.keys(logos)) {
  const icon = await readFile(join(logoDir, `${name}.svg`));
  const iconUri = `data:image/svg+xml;base64,${icon.toString("base64")}`;
  await sharp(icon).png().toFile(join(logoDir, `${name}.png`));
  for (const theme of ["dark", "light"]) {
    const background = theme === "dark" ? "#0b0e15" : "#f5f3ed",
      foreground = theme === "dark" ? "#f4f7ff" : "#182033";
    const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768">
      <rect width="1024" height="768" fill="${background}"/>
      <image href="${iconUri}" x="262" y="76" width="500" height="500"/>
      <text x="512" y="650" text-anchor="middle" fill="${foreground}" fill-opacity=".58"
        font-family="-apple-system,BlinkMacSystemFont,Helvetica,sans-serif" font-size="20" font-weight="600"
        letter-spacing="3">ATTE · LOGO OPTION</text>
    </svg>`;
    await sharp(Buffer.from(preview)).png().toFile(join(logoDir, `${name}.preview-${theme}.png`));
  }
}
