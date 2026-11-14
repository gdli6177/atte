---
version: atte-iteration
name: Atte
description: 注意力中心；单列、留白、字阶、克制的状态提示。
---

# Atte 设计基线

产品定位是「注意力中心」。人做决定、验收和必要介入，管家协调并行 Agent。
这是本轮已经落地的界面规范。最终品牌色、logo 和外部站点参考仍按
[待决策表](docs/product/atte-iteration.md#待决策) 审核。

## 颜色

保留已有墨青与海沫青配色，不在本轮确定新品牌色。所有色值集中在
`apps/desktop/src/tokens.css`，页面只消费语义变量。

| 语义 | Dark | Light |
| --- | --- | --- |
| `bg` | #0d1214 | #f4f8f6 |
| `sidebar` | #12191b | #ecf2ef |
| `surface` | #172023 | #ffffff |
| `surface-soft` | #1d282b | #edf3f0 |
| `surface-hover` | #243135 | #e4ece8 |
| `text` | #edf4f2 | #1d2a27 |
| `secondary` | #bfd0cb | #43554f |
| `muted` | #96aaa5 | #5d706a |
| `line` | #2c3a3d | #c4d1cc |
| `line-strong` | #43565a | #a7b7b1 |
| `accent` | #5ed9c9 | #0d6f65 |
| `accent-strong` | #8bece0 | #075a52 |
| `accent-soft` | #153836 | #def2ed |
| `on-accent` | #061b18 | #ffffff |
| `mint` / `mint-soft` | #9adba4 / #20362a | #2c7048 / #e4f1e9 |
| `warm` / `warm-soft` | #efc56f / #3b3424 | #8a5a19 / #f7eddf |
| `danger` / `danger-soft` | #ff9ba1 / #3b2529 | #913741 / #f9e8ea |

`accent` 用于主动作与需要你，`mint` 用于完成与验收，`warm` 用于外部等待，
`danger` 用于阻塞和破坏性动作。状态始终有文字，不能只靠颜色。

## 字阶

系统无衬线字体：SF Pro Text / PingFang SC；代码与终端使用系统等宽字体。
正文用 `secondary`，元信息才用 `muted`，不引入额外网络字体。

| 档位 | 字号 / 行高 |
| --- | --- |
| caption / meta | 12 / 16、12 / 18px |
| body / body-strong | 14 / 20、14 / 21px |
| subtitle | 15 / 22px |
| title | 20 / 28px |
| display | 30 / 38px |
| hero | 48 / 56px |

标题使用较紧行高，多行消息和说明使用 `--leading-body`；保留段落和原始换行。
字重使用 regular / medium / semibold / bold 四档。

## 间距与形状

- 使用 4pt 间距：4、8、12、16、20、24、32、40、48、64、72px。
- 控件、卡片、浮层圆角分别使用 `--r-sm`、`--r-md/lg`、`--r-xl`；
  药丸使用 `--r-full`。
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
  图标按钮有可访问名称，焦点环只保留一圈。
- `Field` + `TextInput` / `TextArea` / `Select` / `Toggle` / `Checkbox`：
  显式标签，错误紧邻字段，失败保留输入。
- `Card` / `SettingsSection` / `SectionHeading`：标题、说明、当前值和操作清楚对齐。
- `StatusPill`：状态文字与颜色同时出现，跨首页、列表和详情使用同一映射。
- `EmptyState` / `LoadingState`：给出一句状态说明和可执行的下一步。
- `Modal`：复用 Radix Dialog 的键盘与焦点约束，关闭后回到原入口。
- `BrandMark`：所有界面品牌图形共用的替换挂点，不在页面直接绑定旧文件名。

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
外部参考站点与最终图标签字不从自动检查推定完成。
