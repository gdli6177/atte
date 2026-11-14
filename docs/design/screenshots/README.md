# Vercel 品牌视觉改版验收记录

日期：2026-11-15。分支：`codex/vercel-brand-reskin`。
基线提交：`7bc2df63c105c10c1992410d52df16bfdec1cfb7`。

当前状态：四阶段代码与文档已实现；真实桌面回归、30 张截图和四个 Git 提交仍被
当前执行环境阻断，尚未达到完整交付验收。

## 改动范围

- 深浅色 primitive 使用交接指定色板；语义名称保留。
- 主按钮反相胶囊，次按钮透明强描边；卡片 12px、无装饰阴影。
- 状态标签使用中性文案和 6px 圆点，重点卡使用 3px 左侧竖条。
- 主区横向留白 40px，卡片间隔 16px，区块间隔 40px；hero 行高 1.05，中文标题字距为 0。
- 键盘焦点使用 2px 琥珀 outline 和 2px 偏移；保留减少动态效果规则。
- 原生窗口启动背景在构建时从 `tokens.css` 注入，清除旧背景硬编码。

未修改功能组件、状态机、IPC、迁移、品牌资产、图标、终端 token、侧栏宽度
或首页图形的 96px 基线及既有响应式隐藏规则。

## 对比度

运行：

```sh
node scripts/design-contrast.mjs docs/design/screenshots/contrast.json
```

结果：**66 组计算全部通过**；`DESIGN.md` 的 21 个颜色、8 档字号及行高均与
token 一致。完整浮点结果见 [contrast.json](contrast.json)。

下表为普通背景、侧栏、卡片、次级块、悬停底、浮层背景中的最低值；
主按钮同时包含正常和悬停状态。

| 检查项 | Dark | Light | 要求 |
| --- | --- | --- | --- |
| 主文字 | 12.34:1 | 14.82:1 | ≥4.5:1 |
| 次要文字 | 7.93:1 | 6.87:1 | ≥4.5:1 |
| 元信息（组件层 `meta-text`） | 4.80:1 | 4.85:1 | ≥4.5:1 |
| 链接 / 小字号强调文字 | 8.66:1 | 4.70:1 | ≥4.5:1 |
| 反相主按钮文字 | 13.84:1 | 16.52:1 | ≥4.5:1 |
| 琥珀焦点 / 图形标记 | 6.83:1 | 3.14:1 | ≥3:1 |

交接中的浅色 `accent` 对白底实际为 3.79:1。保留指定色值，用
`accent-strong` 承担小字号强调文字。原始 `muted` 对部分侧栏和悬停底也不足
4.5:1，因此组件层采用与主文字 88% / 12% 的混合；禁用文字不再整体降透明度。
这些是 token 层的 sRGB 计算，尚未代替浏览器合成色与真实页面对比度验收。

## 四阶段检查

| 阶段 | `pnpm typecheck` | `pnpm test:desktop` | UI 冒烟 |
| --- | --- | --- | --- |
| 1 · token 换色 | 通过 | IPC 权限阻断 | IPC 权限阻断 |
| 2 · 控件形态 | 通过 | IPC 权限阻断 | IPC 权限阻断 |
| 3 · 留白字阶 | 通过 | IPC 权限阻断 | IPC 权限阻断 |
| 4 · 清理与文档 | 通过 | IPC 权限阻断 | IPC 权限阻断 |

其他检查：

| 检查 | 结果 |
| --- | --- |
| `scripts/workspace-verify full` | 类型检查通过；测试阶段被 tsx IPC 的 `listen EPERM` 阻断，未到构建阶段。 |
| `pnpm desktop:build` | `iconutil` 返回 `Invalid Iconset`；未更改图标构建流程或品牌资产。 |
| 主进程 esbuild bundle、renderer Vite 生产编译 | 单独编译通过；不等同完整桌面构建通过。 |
| 品牌资产 / renderer 边界单测 | 在 `apps/desktop` 目录使用 `node --import tsx --test test/brand-assets.test.ts test/renderer-import-boundary.test.ts`，3/3 通过。 |
| 新增脚本语法、`git diff --check` | 通过。 |
| 品牌资产 Git diff | 空；品牌资产摘要单测通过。 |
| 终端、侧栏、首页图形 | 与基线逐项比较，terminal token、侧栏宽度及首页图形样式未变。 |
| 旧界面色值 | 运行时样式和主进程无残留。 |
| `style.css` 硬编码 HEX | 基线 0，当前仍为 0。 |

阻断证据：

- `pnpm test:desktop` 和 UI 冒烟在 tsx 启动器创建临时 IPC pipe 时返回
  `listen EPERM`。直接以 `node --import tsx` 运行桌面脚本同样无法监听本机端口；
  UI 脚本则在 Electron 启动阶段返回 `Process failed to launch!`。
- 标准构建在既有 `build-icons.mjs` 调用 `iconutil` 时返回 `Invalid Iconset`。
  单独打包尝试也遇到网络访问被拒绝，未形成更新后的应用包。
- 可用浏览器工具返回 `The browser access host is unavailable`，未取得真实截图。
- `git add` 无法在 worktree 公共 Git 目录创建 `index.lock`，返回
  `Operation not permitted`。因此四个提交未创建。

## 截图矩阵

`scripts/atte-ui-smoke.mjs` 已扩展为五个界面 × 两套主题 × 三档窗口，
同时检查可见文字对比度、单一主动作、横向溢出、Tab 焦点、减少动态效果和
首页图形的原尺寸。既有消息、发送失败保留输入、验收、设置保存等回归仍保留。

当前 **30 张均待真实运行生成**。没有以静态比较稿或占位图代替。

| 文件前缀 | 界面 | 窗口（每档各 dark / light） |
| --- | --- | --- |
| `home` | 首页 | 900×700、1024×768、1440×960 |
| `detail` | 任务详情 / 完整记录 | 900×700、1024×768、1440×960 |
| `review` | 验收卡 | 900×700、1024×768、1440×960 |
| `settings` | 设置 | 900×700、1024×768、1440×960 |
| `onboarding` | 首启 | 900×700、1024×768、1440×960 |

具备桌面执行权限的环境中，先从当前代码重新打包，再运行：

```sh
pnpm desktop:package
pnpm test:desktop
ATTE_UI_SCREENSHOT_DIR=docs/design/screenshots pnpm test:atte-ui
scripts/workspace-verify full
```

矩阵命名为 `<界面>-<dark|light>-<宽>×<高>.png`，例如
`home-dark-900×700.png`；成功后同时生成 `ui-results.json`。
其他交互回归截图和隔离测试数据仍位于系统临时目录。

## 四个提交的重放资料

当前工作区保留完整改动；四阶段独立补丁保存在 `/tmp/atte-vercel-reskin/`。
在基于上述基线提交的干净检出中依次重放，每步执行类型检查、桌面测试并提交。

| 顺序 | 补丁 | 提交主题 |
| --- | --- | --- |
| 1 | `01-token.patch` | `style(desktop): 切换 Vercel 品牌色 token` |
| 2 | `02-controls.patch` | `style(desktop): 统一胶囊控件与中性状态` |
| 3 | `03-spacing.patch` | `style(desktop): 调整留白与字阶` |
| 4 | `04-cleanup-docs.patch` | `docs(desktop): 清理视觉样式并补齐验收资料` |

阶段 2–4 的检查日志也保存在该临时目录；阶段 1 的结果见本次会话工具输出。
补丁重放不代表原分支已提交，也不代表上述待验收项已通过。
