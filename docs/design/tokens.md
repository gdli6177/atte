# Atte Design token

入口：`apps/desktop/src/tokens.css`。组件样式：`apps/desktop/src/style.css`。
本轮采用 Vercel 基线与 Atte 品牌色。只替换 primitive 色板，深浅主题继续使用
同一组语义名称；新增的控件、元信息和布局变量集中在组件层。
品牌标识、图标、首页 96px 图形和终端色板保持原样。

## 三层与六类

| 层 | 职责 |
| --- | --- |
| `tokens.primitives` | 原始色值与尺寸；已有布局尺寸集中在 `--size-*`，不在组件散落字面量。 |
| `tokens.semantic` | 下表六类语义；组件使用这些稳定名字，浅色主题只重映射语义颜色。 |
| `tokens.components` | 按钮、卡片、标签、焦点、元信息、布局及品牌挂点。 |

| 类别 | token | 约定 |
| --- | --- | --- |
| 颜色 | `--bg`、`--sidebar`、`--surface*`、`--text`、`--secondary`、`--muted`、`--line*` | 背景、层级、正文、元信息与边界；普通卡片保持平面。 |
| 语义色 | `--accent*`、`--on-accent`、`--mint*`、`--warm*`、`--danger*` | 琥珀焦点 / 需要你、完成、等待、危险；状态色只用于小圆点或左侧竖条，文字保持中性。 |
| 字体 | `--font-sans`、`--font-mono`、`--fs-*`、`--lh-*`、`--leading-*`、`--weight-*` | 系统字体；正文 14px，元信息最低 12px；终端字体也读取 token。 |
| 间距 | `--space-1/2/3/4/5/6/8/10/12/16/18` | 4、8、12、16、20、24、32、40、48、64、72px；新增布局按 4pt 节奏。 |
| 圆角 | `--r-sm/md/lg/xl/full` | 6 / 10 / 14 / 20 / 999px；控件、卡片、浮层、药丸各有固定档。 |
| 阴影 | `--shadow`、`--shadow-card`、`--focus-ring` | 只有浮层使用阴影；普通卡片为 none；旧 `--focus-ring` 名称保留但值为 none，焦点用 outline。 |
| 动效 | `--duration-fast/normal/spin/pulse/reduced`、`--ease-out/standard` | 160 / 200ms 微交互；加载状态独立；尊重 `prefers-reduced-motion`。 |

## 组件消费

- 页面复用 `Button`、`Field`、`SettingsSection`、`Modal` 等原语。
  不在 TSX 写颜色、字号、间距、圆角、阴影或动效字面量。
- 普通状态用 `surface` + `line`，层级由留白与字阶表达；主动作采用 `text` / `bg` 反相。
- `--sidebar-width`、`--content-width`、`--detail-width`、`--attention-width`
  是组件层布局入口。原有特殊布局尺寸保留在 primitive 层，不扩展成第二套视觉系统。
- `--brand-home-size`、`--brand-welcome-size`、`--brand-about-size` 是图形尺寸挂点。
- Xterm 的画布和 ANSI 内容在两个主题下均保持深色，颜色、字体与字号通过
  `--terminal-*` 读取。原生窗口启动背景在 `build.mjs` 中从
  `--palette-dark-bg` 读取并注入主进程，不再维护独立色值。
- 媒体查询的断点保留 CSS 字面值，因为 CSS 自定义属性不能直接用于媒体查询条件；
  `0`、比例、百分比与网格分配属于布局关系，不建立无意义的 token。

## Vercel 组件 token

| token | 值 / 用途 |
| --- | --- |
| `--btn-primary-bg` | `var(--text)`；深色暖白、浅色墨。 |
| `--btn-primary-text` | `var(--bg)`；反相文字。 |
| `--btn-primary-hover-bg` | 主按钮背景与墨黑按 94% / 6% 混合，仅降低背景亮度。 |
| `--btn-secondary-bg` | `transparent`。 |
| `--btn-secondary-border` | `var(--line-strong)`；1px 描边。 |
| `--link-text` | `var(--accent-strong)`；小字号强调文字与链接。 |
| `--meta-text` | `muted` 与 `text` 按 88% / 12% 混合；在根节点计算后供 `body` 内的 `--muted` 使用，覆盖页面和 Portal 浮层，提高侧栏、次级块和悬停底上的元信息对比度。 |
| `--focus-outline` / `--focus-offset` | `2px solid var(--accent)` / `2px`；键盘焦点单环。 |
| `--pill-radius` / `--pill-padding` | `var(--r-full)` / `6px 10px`；标签字号 12px、字重 500。 |
| `--card-radius` / `--card-shadow` | `12px` / `none`。 |
| `--section-gap` | `var(--space-10)`，40px。 |

字阶补充 `--leading-hero: 1.05`、`--lh-hero: 50.4px`、
`--tracking-tight: -0.02em` 与 `--tracking-normal: 0`；中文标题和眉题不加字距。
完整颜色表和字阶以根目录 `DESIGN.md` 为准。

浅色 `accent` 仍保留交接指定值，只用于图形、焦点和选中标记。
它对白底的对比度为 3.79:1，正文须使用 `link-text` 或中性色。
元信息的混合在组件层完成，不改原始色板值和语义名称。

## 验证

在渲染层临时覆盖 `--accent`、`--r-sm`、`--space-4`，原语和目标页应同步更新；
切换深浅主题不改组件代码。检查首页、验收卡、完整详情、设置和首启；
900×700、1024×768、1440×960 均不得出现横向滚动、标题遮挡或操作不可达。
运行 `node scripts/design-contrast.mjs` 验证 66 组颜色组合、文档颜色和字阶一致性；
它不替代真实渲染的合成色、Tab 焦点和减少动态效果检查。
截图矩阵及当前验证状态见 [改版验收记录](screenshots/README.md)。
