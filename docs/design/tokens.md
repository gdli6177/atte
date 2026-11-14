# Atte Design token

入口：`apps/desktop/src/tokens.css`。组件样式：`apps/desktop/src/style.css`。
本轮保留现有配色，减少轨道、光点、渐变、纹理、抬升与装饰阴影；
不替最终 logo / 品牌色决策定稿。深浅主题使用同一组语义名。

## 三层与六类

| 层 | 职责 |
| --- | --- |
| `tokens.primitives` | 原始色值与尺寸；已有布局尺寸集中在 `--size-*`，不在组件散落字面量。 |
| `tokens.semantic` | 下表六类语义；组件使用这些稳定名字，浅色主题只重映射语义颜色。 |
| `tokens.components` | 外壳、弹窗与品牌挂点尺寸，不把临时图标尺寸当品牌定稿。 |

| 类别 | token | 约定 |
| --- | --- | --- |
| 颜色 | `--bg`、`--sidebar`、`--surface*`、`--text`、`--secondary`、`--muted`、`--line*` | 背景、层级、正文、元信息与边界；普通卡片保持平面。 |
| 语义色 | `--accent*`、`--on-accent`、`--mint*`、`--warm*`、`--danger*` | 主动作 / 需要你、完成、等待、危险；始终配文字。 |
| 字体 | `--font-sans`、`--font-mono`、`--fs-*`、`--lh-*`、`--leading-*`、`--weight-*` | 系统字体；正文 14px，元信息最低 12px；终端字体也读取 token。 |
| 间距 | `--space-1/2/3/4/5/6/8/10/12/16/18` | 4、8、12、16、20、24、32、40、48、64、72px；新增布局按 4pt 节奏。 |
| 圆角 | `--r-sm/md/lg/xl/full` | 6 / 10 / 14 / 20 / 999px；控件、卡片、浮层、药丸各有固定档。 |
| 阴影 | `--shadow`、`--shadow-card`、`--focus-ring` | 只有浮层使用阴影；普通卡片为 none；焦点环保留且只出现一圈。 |
| 动效 | `--duration-fast/normal/spin/pulse/reduced`、`--ease-out/standard` | 160 / 200ms 微交互；加载状态独立；尊重 `prefers-reduced-motion`。 |

## 组件消费

- 页面复用 `Button`、`Field`、`SettingsSection`、`Modal` 等原语。
  不在 TSX 写颜色、字号、间距、圆角、阴影或动效字面量。
- 普通状态用 `surface` + `line`，层级由留白与字阶表达；主动作才使用 `accent`。
- `--sidebar-width`、`--content-width`、`--detail-width`、`--attention-width`
  是组件层布局入口。原有特殊布局尺寸保留在 primitive 层，不扩展成第二套视觉系统。
- `--brand-home-size`、`--brand-welcome-size`、`--brand-about-size` 是图形尺寸挂点。
- Xterm 的画布和 ANSI 内容在两个主题下均保持深色，颜色、字体与字号通过
  `--terminal-*` 读取。原生窗口启动背景与深色 `--bg` 对齐。
- 媒体查询的断点保留 CSS 字面值，因为 CSS 自定义属性不能直接用于媒体查询条件；
  `0`、比例、百分比与网格分配属于布局关系，不建立无意义的 token。

## 验证

在渲染层临时覆盖 `--accent`、`--r-sm`、`--space-4`，原语和目标页应同步更新；
切换深浅主题不改组件代码。检查首页、验收卡、完整详情、设置和首启；
900×700、1024×768、1440×960 均不得出现横向滚动、标题遮挡或操作不可达。
