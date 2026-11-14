# Atte 迭代验收记录

> 本页前半部分保留**第一轮** `codex/atte-rebrand` 的历史结果；第二轮改名、迁移、
> 首页尺寸修正和设计备选以本页末尾“第二轮验收”及 [升级说明](../upgrade-atte.md)
> 为准。第三轮提交收尾、Six Vectors 标识与最终打包结果以“第三轮实际验证”为准。
> 第一轮中“保留 crewvane 标识”的描述已被拍板结果取代。

日期：2026-11-14。分支：`codex/atte-rebrand`。基线：`origin/main` 的
`005549b`。本记录只写实际执行结果，不把准备资产或待批准方向写成最终定稿。

## 需求对照

| 需求 | 本轮结果 | 边界 |
| --- | --- | --- |
| BR-1 | 桌面标题、菜单、关于、首启、安装包命名、README、使用说明、通知与 Skills 展示文案统一为 Atte；安装产物使用 `Atte.app`、`Atte-<version>-macOS-arm64.dmg/zip`。 | 仓库、npm 包、CLI、配置目录与协议标识保留；无命令别名、无目录迁移。 |
| BR-2 | 全仓检索旧中文名及其拆分写法，除允许保留的历史 CHANGELOG 外为零。 | 无。 |
| IX-1 | 验收卡和完整详情合并为「给管家发消息」，保留独立「验收通过」；反馈通过 `goal.message` 发送，保留 review、交付和 attention，管家另行显式变更状态。CLI 控制台同步，真实调用层回归覆盖反馈后显式 rework。 | 未把自然语言猜测成通过或退回；`goal rework` 仍是管家协议。 |
| BR-3 | 关于、首启、README 和仓库内官网/商店候选文案统一「注意力中心」，首启解释「人只做拍板，Agent 并行推进。」 | 未发布外部网站或商店。 |
| BR-4 | 保留原图，生成 32–1024px PNG 与 ICNS、来源清单和 SHA-256；应用、Dock、菜单栏、favicon、首页、关于和原型接入共享 `BrandMark` / `atte-*` 挂点。 | 仅完成要求的准备工作与替换挂点，最终新图形尚未设计或验收。 |
| VI-1 | 首页、详情、设置收敛装饰，统一平面边界、留白、字阶与焦点；移除轨道、光点、网格光晕、卡片抬升和装饰阴影。 | 品牌色未重新决定。 |
| VI-2 | primitive / semantic / component 三层 token 覆盖颜色、字体、间距、圆角、阴影、动效；终端也读取 token，文档见 `docs/design/tokens.md`。 | 媒体查询保留必要字面值。 |
| IX-2 | 设置分为五组，保留原功能；外观和现场选择改为草稿加显式保存，失败保留输入，未保存不能测试现场。分组导航不改变 renderer URL，避免破坏严格 IPC sender 校验。 | 未合并或删除设置功能。 |
| BR-5 | 董事长提出的意大利语联想和 AT-TE 灵感保存在 `docs/brand/naming-origin.md`。 | 词源未独立考证，仅作为提出者的叙述；未公开到关于/README。 |
| VI-3 | 阅读 awesome-design-md 的 Linear、Cal.com、Notion 实际文件，记录版本、候选与取舍；根 `DESIGN.md` 描述已落地的色板、字阶、间距、组件和响应式。 | 最终参考站点待选择，不能声称该项已定稿。 |
| VI-4 | 按拍板结果维持首页 96px 及原响应式显示规则，预览 token 不放大渲染。 | 未决定新 logo 或最终尺寸。最终包内走查待授权执行。 |

## 第一轮历史验证

- 第一轮六个提交此前均执行过 `scripts/workspace-verify fast`，四个 workspace
  typecheck 通过。
- 第一轮 `pnpm desktop:build`、`pnpm desktop:package` 及隔离 UI 冒烟曾通过；
  当时的首页仍是 96px，不能作为后来 144px 预览的通过证据。
- 当时完整的 P2、全量测试和安装器收尾未完成，相关失败已在第二轮重新执行并记录。

## 第二轮改名与迁移

第二轮在上一轮工作树上继续，计划分支为 `codex/atte-full-rename`。改名清单：

| 类别 | 当前标识 | 兼容策略 |
| --- | --- | --- |
| npm workspace | `@atte/core`、`@atte/sessions`、`@atte/cli`、`@atte/desktop` | 包名、import、tsconfig paths 与 CI 全部改用新名。 |
| CLI | `atte` | `bin/atte.js`；不保留 `crewvane` 别名。旧配置需改为 `atte` 或重新安装受管入口。 |
| 工作区状态 | `.atte/`、`.atte-lock/` | 首次打开旧工作区时复制、校验、写迁移标记后原子改名；旧 `.crewvane/` 永久保留。 |
| 用户与应用数据 | `~/.atte/`、`appData/Atte/` | 同样复制校验；失败时继续使用旧目录，不阻断使用。 |
| 环境变量 | `ATTE_*` | 新名优先，读取时回退旧 `CREWVANE_*`；受管子进程镜像旧名以兼容旧 Hook。 |
| IPC / 界面 API | `atte:*` | preload 暴露 `window.atte`；Electron 主进程不再注册旧通道。 |
| 插件与协议 | `dev.atte`、`atte.bot.v1` | Bot 读取兼容旧 envelope；旧 Herdr 插件记录不删除、不再写入。 |
| 仓库与下载 | `github.com/gdli6177/atte` | README、release workflow、install.sh 与文档引用已更新；GitHub 侧改名仍需维护者操作。 |
| Bundle | `dev.atte.desktop` | 应用显示名、bundle 名与可执行文件名均为 `Atte`。 |

迁移实现位于 `packages/core/src/state-migration.ts` 与
`packages/core/src/compatibility.ts`。关键行为：

- 迁移前在兼容锁内完成；目标目录用临时副本构建，核对文件清单与每份文件
  SHA-256 后才原子 rename。
- `events.jsonl` 保留原始字节；快照中的附件路径、Bot 协议和
  `minimumCrewvane` 字段改写为新名。
- 写 `.atte-migration.json` 作为成功标记；任何失败删除未完成临时副本，
  返回旧目录继续使用。
- 旧主题键读取后写回 `atte.*`；旧受管 CLI shim 和 Skill 只有在内容/所有权
  可验证时才迁移，任意同名用户文件不删除。
- 普通锁只写 `.atte-lock`；只有旧工作区兼容路径同时取得新旧锁，避免并发写入
  两份状态。

完整升级与回滚步骤见 [从 Crewvane 升级到 Atte](../upgrade-atte.md)。回滚时先
关闭 Atte/CLI，保存当前 `.atte` 与应用数据目录，再让旧版读取仍保留的
`.crewvane` / `appData/Crewvane` 并重装旧 CLI；迁移后在 Atte 中产生的新写入
不能假定旧版可读。

拍板修正已落实：首页恢复 96px 与原响应式规则，仅保留
`--brand-home-preview-scale: 1` token；README、关于页和首启统一
「注意力中心 · The attention layer」。名字由来仍只在
`docs/brand/naming-origin.md`。

## 设计备选

- Logo 三案：`docs/design/logo-options/`。每案含透明 1024×1024 SVG/PNG、
  深浅 1024×768 预览与一句话说明，覆盖现有像素吉祥物升级、全新极简 A、
  吉祥物 + 字标；均未替换运行时资产，未定稿。
- 设计基线：`docs/design/baseline-compare/`。Linear、Raycast、Vercel 三份
  自包含 HTML 使用同一首页结构与内容，只更换视觉系统；未改正式界面，未选定
  最终基线。

## 第二轮实际验证

通过项：

- `scripts/workspace-verify fast`：通过，四个 workspace typecheck 全部完成。
  日志：`/tmp/atte-workspace-verify-fast-r2.log`。
- `node --import tsx --test packages/core/test/*.test.ts`：164/164 通过。
  日志：`/tmp/atte-core-tests-r2.log`。
- 迁移、兼容和锁定向测试：13/13 通过。
  日志：`/tmp/atte-migration-compat-lock-r2.log`。
- `pnpm desktop:build`：通过，Vite 构建完成。
  日志：`/tmp/atte-desktop-build-final.log`。
- 离线打包：通过，产物为
  `apps/desktop/release/Atte-darwin-arm64/Atte.app`。
  日志：`/tmp/atte-desktop-package-final.log`。

```sh
ATTE_HERDR_BINARY="$PWD/apps/desktop/.herdr-cache/herdr" \
ATTE_ELECTRON_ZIP_DIR="$HOME/Library/Caches/electron" \
pnpm desktop:package
```

- 包内校验：`CFBundleDisplayName`、`CFBundleName`、`CFBundleExecutable`
  均为 `Atte`，`CFBundleIdentifier` 为 `dev.atte.desktop`；bundle ICNS 与
  `atte-icon-baseline.icns` 一致；`codesign --verify --deep --strict` 通过；
  包内 Herdr 0.9.5、插件 `dev.atte`、CLI `atte.cjs` 与 `atte` Skills 均存在。
- 包内 `app.asar` 含「The attention layer」、`--brand-home-baseline:96px`、
  `atte.bot.v1` 与 `dev.atte`，不含 `--brand-home-baseline:144px`；旧
  `crewvane.bot.v1` 仅作为兼容读取保留。静态内容核验不等于 UI 走查通过。
- 手工 ZIP 产物：
  `apps/desktop/release/installers/Atte-0.11.0-macOS-arm64.zip`，
  SHA-256 `db3fa1dd567c5456a0e8784ca29bfdf40dcb3a90e72b5ec5399fe17940d4b22d`；
  解压后的 `Atte.app` 再次通过签名、bundle ID 与图标核验。
- `git diff --check`：通过。
- `bash -n install.sh`、`bash install.sh --help`、`pnpm --dir cli build`、
  `node cli/bin/atte.js --help`：通过。

未通过或受限项：

- `scripts/workspace-verify full`：typecheck 通过，随后在 CLI 测试启动前被
  `tsx` 本地 IPC 拒绝：`listen EPERM .../tsx-501/*.pipe`。
  日志：`/tmp/atte-workspace-verify-full-final.log`。不得视为 full 通过。
- CLI 直接测试：56/62。4 个真实子进程调用被 tsx IPC 拒绝，1 个 Unix
  socket 被拒绝，1 个 `scene-focus` 原生断言崩溃。
  日志：`/tmp/atte-cli-tests-final.log`。
- Sessions：26/68。失败集中在控制进程身份、Unix socket 与 `ps` EPERM。
  日志：`/tmp/atte-sessions-tests-final.log`。
- Desktop：174/190。16 项失败均为 Unix socket、TCP localhost 或进程身份
  限制。日志：`/tmp/atte-desktop-tests-final.log`。
- `pnpm test:atte-ui` 的 `tsx` 入口被同一 IPC 限制拦截；
  `node --import tsx scripts/atte-ui-smoke.mjs` 直接运行时 Playwright Electron
  报 `Process failed to launch!`。日志：
  `/tmp/atte-ui-pnpm-final.log`、`/tmp/atte-ui-direct-final.log`。随后尝试用原生
  界面控制启动同一打包应用，系统返回未授权控制 `Atte`，因此没有可补充的可视走查。
- `node apps/desktop/distribute.mjs` 在 `hdiutil create` 处失败：
  `设备未配置`，DMG 未生成。日志：`/tmp/atte-desktop-dist-final.log`。
- `pnpm test:installers` 因缺少 DMG 与 `SHA256SUMS.txt` 无法完成，不能声称
  安装器验收通过。

README 的 `docs/assets/atte-overview.png` 已人工查看；画面中的定位仍是旧的
单语「注意力中心」，且没有第二轮 UI 冒烟证据，因此只作为历史概览图，不作为
本轮首页尺寸、双语文案或 UI 验收通过证据。

## 第二轮收尾状态（历史）

三组上一轮遗留改动已生成独立补丁并通过 `git apply --cached --check`：
`/tmp/atte-handoff-round2/01-home-mascot.diff`、
`02-p2-docs.diff`、`03-copy-audit.diff`。记录时 Git 写入仍被审批额度限制，
补丁尚未写入索引，`codex/atte-full-rename` 尚未创建；因此本页不声称这些
提交或分支已经完成。审批恢复后按补丁顺序各提交一次，再创建改名分支并分组提交
本轮改动。

旧标识审计允许保留迁移读取、旧锁、旧资产文件名、历史发布记录和测试夹具。
当前新写入路径、命令示例、包名、插件 ID、环境变量文档与下载链接已改用 Atte；
`docs/releases.md` 作为历史发布记录保留旧名。

以上是第二轮收官时的真实状态。第三轮已按这些补丁拆分提交，并在提交后完成
品牌、打包和安装器验证。

## 第三轮实际验证

日期：2026-11-14。分支：`codex/atte-rebrand`。基线：`origin/main` 的
`005549b`。第三轮把工作树中的改名、迁移与三组遗留改动拆成 6 个主体提交，
另追加 1 个 renderer 修复提交和本 QA 记录提交。`origin/main..HEAD` 还包含
第一轮的 6 个历史提交，二者合计为最终分支范围。

| Commit | 范围 |
| --- | --- |
| `535096d` | 核心状态、Session 标识与 `.crewvane` 兼容迁移 |
| `a94f19d` | CLI `atte` 入口、安装器所有权检查与旧配置读取 |
| `c8c6b5d` | Electron、IPC、托盘、打包与 Herdr 插件改名 |
| `a61b94d` | 文档、Skills、设计评审与升级说明 |
| `bff2bdb` | 改名、迁移、锁、安装器与升级兼容回归测试 |
| `386cc08` | Six Vectors 品牌资产、图标生成与运行时挂点 |
| `dd04176` | renderer 隔离 Node-only core 模块，并增加 import 边界测试 |

提交前执行 `git diff --check`，无空白错误。`release/`、`node_modules/`、临时
zip 与打包产物均未入库。

### Six Vectors 接入

只读源目录：
`/Users/ligd/Library/Application Support/Cindy/owners/338adfc1f9f2cec58c46/bots/cindy-default/workspace/documents/codex-logo/atte-logo/final/`。

- 品牌资产放入 `apps/desktop/assets/brand/`，统一使用 `atte-mark*`、
  `atte-app-icon*`、`atte-wordmark*` 命名；品牌规范复制为
  `docs/brand/six-vectors.md`。
- 标识为 **Six Vectors**，角色插画仍为像素吉祥物；`docs/brand/README.md`
  与 `apps/desktop/assets/brand/README.md` 已写明二者分工。
- 仅使用品牌指南色：墨 `#171A1E`、暖白 `#F3F1EA`、琥珀 `#F5A524`、
  图标底 `#14181B`。品牌资产测试会拒绝额外颜色。
- 复用 `apps/desktop/scripts/build-icons.mjs` 生成：
  `atte-app-icon-{32,64,128,256,512,1024}.png`、`atte-app-icon.icns`、
  `atte-favicon-{16,32}.png`、`atte-tray-{16,32}.png` 与
  `atte-tray-reversed-{16,32}.png`；`atte-assets.json` 记录来源与 SHA-256。
- 应用图标、Dock、菜单栏、favicon、侧栏、关于页与 README 均使用新标识。
  托盘随浅色/深色外观切换正向与反白版本。
- 保留 `crewvane-mage.png`、`atte-mascot-baseline-512.png` 等像素吉祥物，
  继续用于首页、首启和管家卡片；只移除了过渡期的
  `atte-icon-baseline.*` 导出，不删除角色资产。

### 通过项

- `scripts/workspace-verify full`：通过。CLI 64/64、Core 168/168、
  Sessions 71/71、Desktop 193/193；四个 workspace typecheck 与
  `desktop:build` 均通过。日志：`/tmp/atte-r3-final-full.log`。
- `pnpm desktop:build`：通过。日志：
  `/tmp/atte-r3-final-desktop-build.log`。
- `pnpm test:atte-ui`：通过，覆盖品牌、验收消息、失败发送、设置显式保存、
  响应式与 reduced-motion。日志：`/tmp/atte-r3-final-ui.log`；截图目录为
  脚本输出的临时 `atte-ui-*` 目录。
- `pnpm desktop:package`（离线）：通过，产物
  `apps/desktop/release/Atte-darwin-arm64/Atte.app`，版本 0.11.0。
  `CFBundleDisplayName`、`CFBundleName`、`CFBundleExecutable` 均为
  `Atte`，`CFBundleIdentifier` 为 `dev.atte.desktop`；bundle ICNS 与
  `atte-app-icon.icns` 字节一致（SHA-256 均为
  `6e08b7269ae802724e56f84a3194711874155804fa5dd2b02a409c08be8f1ee8`）。
  `codesign --verify --deep --strict` 与包内 Herdr 签名均通过。日志：
  `/tmp/atte-r3-final-desktop-package.log`。
- Packager 会提示找不到 `.icon`（Icon Composer 格式）；该提示不影响
  `.icns`，包内图标字节比较与 `CFBundleIconFile` 已确认实际使用新图标。
- `pnpm desktop:dist`（离线）：通过，hdiutil 本轮未受限。
  产物：
  `Atte-0.11.0-macOS-arm64.dmg` SHA-256
  `5c109fd3538acc2b065c9e0064040f90b9b67b874335838b1c67a141a75d06cb`；
  `Atte-0.11.0-macOS-arm64.zip` SHA-256
  `14996505f09e9f849f5499a3c09d671a39584e61fe1a62e24910db146f884f86`。
  `SHA256SUMS.txt` 校验、`hdiutil verify` 与 ZIP 完整性检查均通过。日志：
  `/tmp/atte-r3-final-desktop-dist.log`。
- `pnpm test:installers`：通过。ZIP 与 DMG 两条路径都验证了隔离属性下签名
  仍完整、包内新图标一致、内置 CLI 可安装并写入目标。日志：
  `/tmp/atte-r3-final-installers.log`。

### 环境限制与修复

- 沙箱内 `tsx` 仍无法建立本地 IPC。复现命令：
  `pnpm --dir apps/desktop exec tsx --test test/renderer-import-boundary.test.ts`；
  错误为 `listen EPERM .../tsx-501/58605.pipe`。同一命令在沙箱外通过；
  `full`、UI 与安装器测试也均在沙箱外执行。
- 沙箱内 `iconutil` 会把有效 iconset 判为 `Invalid Iconset`。用生成后的
  32–1024px PNG 重建临时 iconset 后执行
  `iconutil -c icns /tmp/atte-iconutil-check.9WeLD2/Atte.iconset -o …` 仍失败；
  同一 iconset 在沙箱外退出码为 0。未修改图标生成流程绕过该限制。
- 首次 UI 冒烟发现打包应用 renderer 报
  `AsyncLocalStorage is not a constructor`：`GoalAutonomySummary` 从 core
  barrel 导入，导致 `node:async_hooks` 进入浏览器包。改为直接导入
  `model.js` 与 `autonomy.js` 后，UI 冒烟、重新打包与安装器测试均通过。
- 首次安装器冒烟还暴露了测试预检仍在查找完整 `ATTE_TEST_HOME` 字面量；
  环境变量实际经 `environmentValue(...,"TEST_HOME")` 读取，已改为检查
  `TEST_HOME` 并重跑通过。

### 升级风险

- CLI 没有 `crewvane` 别名；旧脚本、旧 Hook 配置和旧 Skill 安装位置需要改用
  `atte` 或重新安装受管入口。
- `.crewvane/`、`.crewvane-lock/`、`~/.crewvane/` 与 `appData/Crewvane`
  只读兼容并复制迁移，不自动合并或删除。迁移失败会继续使用旧目录；迁移后
  在 Atte 中的新写入不应假定旧版可读。
- `ATTE_*` 优先，读取时回退 `CREWVANE_*`；受管子进程仍镜像旧名供旧 Hook 使用。
- 旧 Herdr 插件 `dev.crewvane` 不会自动删除，也不会再被写入；新插件为
  `dev.atte`。旧 Session 按兼容身份恢复，已退出或已存在的场景不会因改名重开。
- 当前产物是 ad-hoc 签名，不是 Developer ID 签名，也未公证；首次打开仍可能
  需要系统“仍要打开”，分发前应完成正式签名与公证。
