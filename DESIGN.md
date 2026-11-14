---
version: atte-iteration
name: Atte
description: 注意力中心 · The attention layer；单列、留白、字阶、克制的状态提示。
---

# Atte 设计基线

产品定位是「注意力中心 · The attention layer」。人做决定、验收和必要介入，
管家协调并行 Agent。
这是当前界面的视觉规范。品牌标识已定稿为 Six Vectors，界面基线已于
2026-11-14 选定 Vercel。

## 基线选择：Vercel

采用 Vercel 比较稿的高对比主动作、胶囊控件、平面卡片与大留白，配色使用
Atte 的墨底、暖白和琥珀。信息架构、文案、交互及状态映射沿用现有实现。
对比稿中的字体、营销渐变、布局列数和候选品牌资产不进入产品。
选定依据见 [首页设计基线](docs/design/baseline-compare/README.md)。

## 颜色

界面使用品牌墨底、暖白与琥珀；浅色强调色采用较沉的琥珀。
所有界面色值集中在 `apps/desktop/src/tokens.css`，组件只消费变量；
原生窗口的启动背景在构建时从同一份深色背景 token 注入。
品牌资产继续按 [Six Vectors](docs/brand/six-vectors.md) 使用，不随界面换色重绘。

| 语义 | Dark | Light |
| --- | --- | --- |
| `bg` | #14181B | #F7F6F3 |
| `sidebar` | #101316 | #EFEEEA |
| `surface` | #1A1F23 | #FFFFFF |
| `surface-soft` | #20262B | #F2F1ED |
| `surface-hover` | #262D33 | #EBEAE5 |
| `surface-raised` | #1F252A | #FFFFFF |
| `text` | #F3F1EA | #14181B |
| `secondary` | #C7C3B9 | #4A4F54 |
| `muted` | #8F8B82 | #6B7076 |
| `line` | #2A3137 | #DCDAD3 |
| `line-strong` | #3C454C | #B9B7B0 |
| `accent` | #F5A524 | #B4761A |
| `accent-strong` | #FFC15C | #8F5C10 |
| `accent-soft` | #3A2A0E | #FBF0DC |
| `on-accent` | #14181B | #FFFFFF |
| `mint` | #7FD1A0 | #2E7D53 |
| `mint-soft` | #1E2E25 | #E7F2EC |
| `warm` | #E0A93F | #8A5A0E |
| `warm-soft` | #33290F | #F7EEDC |
| `danger` | #F26D6D | #A33338 |
| `danger-soft` | #3A2326 | #F7E7E8 |

主按钮使用 `text` / `bg` 反相。琥珀用于焦点、选中标记和需要你的小圆点；
`mint`、`warm`、`danger` 分别用于完成、外部等待和阻塞的小圆点或 3px 左侧竖条。
状态文案保持中性色，不将整块状态卡染色，破坏性动作保留危险色。

浅色 `accent` 在白底实测仅 3.79:1，不能用作小字号正文；文字链接使用
`--link-text: var(--accent-strong)`。原始 `muted` 在部分侧栏和悬停底不满 4.5:1，
组件层用 `--meta-text` 将 `muted` 与 `text` 按 88% / 12% 混合，再供 `body`
内的页面和 Portal 浮层元信息消费；不改上表原始色板或语义名称。实测与限制见
[改版验收记录](docs/design/screenshots/README.md)。

## 字阶

系统无衬线字体：SF Pro Text / PingFang SC；代码与终端使用系统等宽字体。
正文用 `secondary`，元信息才用 `muted`，不引入额外网络字体。

| 档位 | 字号 / 行高 |
| --- | --- |
| caption | 12 / 16px |
| meta | 12 / 18px |
| body | 14 / 20px |
| body-strong | 14 / 21px |
| subtitle | 15 / 22px |
| title | 20 / 28px |
| display | 30 / 38px |
| hero | 48 / 50.4px |

Hero 行高为 1.05，英文标题使用 `--tracking-tight: -0.02em`；
继承中文语言的标题与眉题字距为 0。1150px 以下首页标题收至 display 字号，
保留 1.05 行高。多行消息和说明使用 `--leading-body`；保留段落和原始换行。
字重使用 400 / 500 / 600 / 700 四档。

## 间距与形状

- 使用 4pt 间距：4、8、12、16、20、24、32、40、48、64、72px。
- 主次按钮与标签使用 `--pill-radius`，卡片使用 `--card-radius: 12px`；
  输入框使用 `--r-sm/md`，浮层使用 `--r-xl`。标签为 12px / 500，内边距 6×10px。
- 主区左右留白为 40px，卡片之间 16px，区块之间使用 `--section-gap: 40px`。
- 卡片保持平面，由留白、边界和字阶区分；只有弹窗、终端等浮层使用 `--shadow`。
- 不使用轨道、光点、网格纹理、径向光晕、悬浮抬升或装饰阴影。
- 品牌吉祥物保持原始比例和透明边距，像素图使用最近邻显示；照片与 macOS 图标平滑显示。

## 布局

桌面单列主内容居中；侧栏固定，正文独立滚动。常见窗口最低为 900×700。
1120px 以下收紧侧栏，1080px 以下设置单列；表单在窄窗口统一单列。
浮层有独立滚动区，动作区始终可达。终端画布在深浅主题均保持深色。

## 组件与交互

入口：`apps/desktop/src/ui/index.ts`。优先使用现有原语，不添加第二套组件库。

- `Button` / `IconButton`：primary、secondary、danger、ghost；同一视区一个主动作。
  主按钮为深浅反相的胶囊，悬停背景降亮度 6%；次按钮透明底、1px 强描边，
  悬停使用 `surface-hover`。图标按钮有可访问名称；键盘焦点为 2px 琥珀外环、
  2px 偏移，输入框、复选框、开关与组合输入区只显示一圈。
- `Field` + `TextInput` / `TextArea` / `Select` / `Toggle` / `Checkbox`：
  显式标签，错误紧邻字段，失败保留输入。
- `Card` / `SettingsSection` / `SectionHeading`：标题、说明、当前值和操作清楚对齐。
- `StatusPill`：中性文字加 6px 状态圆点，跨首页、列表和详情使用同一映射。
- 侧栏宽度保持既有规则，选中项为中性文字、1px 描边与左侧 2px 琥珀竖条。
- `EmptyState` / `LoadingState`：给出一句状态说明和可执行的下一步。
- `Modal`：复用 Radix Dialog 的键盘与焦点约束，关闭后回到原入口。
- `BrandMark`：所有界面品牌图形共用的替换挂点，不在页面直接绑定旧文件名。
  首页维持原 96px 基线及既有响应式显示规则；本轮不改变首页图形尺寸。

验收状态保留「验收通过」主按钮和一个「给管家发消息」次入口。
发送反馈只写原话和附件，保留待验收状态；由管家通过显式状态协议决定后续修改。
界面不解析自然语言来推断通过、退回或批准。

## token 与动效

token 分为 primitive、semantic、component 三层，包含颜色、字体、间距、
圆角、阴影、动效六类，详见 [token 文档](docs/design/tokens.md)。
普通微交互 160–200ms，加载状态独立计时；尊重 `prefers-reduced-motion`。
组件不硬编码视觉值；媒体查询断点和结构性比例除外。

## 走查要求

核对首页、任务详情、验收卡、设置、首启的深浅主题；验证 900×700、
1024×768、1440×960，检查键盘、焦点、正文对比度、单一主动作和动作区可达性。
运行 `node scripts/design-contrast.mjs` 检查 token 对比度及本文颜色、字阶一致性。
截图和浏览器检查由 `scripts/atte-ui-smoke.mjs` 执行；当前环境的阻断与待验收项
单独记录，不能从静态检查推定通过。

## 外部参考

已阅读 awesome-design-md 中 Linear、Raycast、Vercel 的实际设计文件；候选、
来源版本与取舍见 [参考候选](docs/design/reference-candidates.md)，同页视觉对比见
[首页设计基线](docs/design/baseline-compare/README.md)。
本文件是当前实现的事实基线，Vercel 已选定为界面参考。

三套同页静态比较稿位于
[设计基线对比](docs/design/baseline-compare/README.md)。Logo 备选目录只保留
为历史评审材料；当前 `BrandMark`、应用图标和 README 已使用定稿的
[Six Vectors](docs/brand/six-vectors.md)。
