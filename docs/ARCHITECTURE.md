# Atte 架构

版本：0.14.0

产品说明见[使用说明](atte.md)，领域术语见[CONTEXT.md](../CONTEXT.md)。

## 边界

```text
Electron 主进程       工作区、Herdr、终端、通知、Hook Broker、巡检、受约束 IPC
React 渲染进程        注意力、全部事项、设置；无 Node 或任意命令能力
packages/core         目标、注意力、决定、交付、状态、锁、v5 迁移与恢复
cli                   人的入口、Agent 状态协议与 Hook ingest，调用同一 core
Agent Adapter         Codex、Claude Code、Cursor、Qoder 与 OMP 生命周期
packages/sessions     Herdr-only 的 SessionControl、负责人启动、身份与投递
Herdr 插件           注意力面板、新建入口、回到管家与现场事件；不是状态副本
```

Atte 不运行模型，不保存模型凭据，也不从终端画面推断业务结果。0.14 没有自主调度
器、独立复核执行器、方法注册表、后端切换事务或 Orca Adapter。旧 Orca 类型只保留
用于读取 v2–v4 快照和展示历史，不能创建新的执行。

## 工作区状态

工作区由用户选择，状态位于 `<workspace>/.atte/`。

- `state.json`：完整快照，当前 `WorkspaceState.version = 5`；
- `events.jsonl`：有界追加事件，保存轻量元数据、状态摘要哈希与字节数，不复制整份快照；
- `decisions.md` / `rejected.md`：由结构化决定派生的可读账本；
- `attachments/`：原图，状态只保存相对路径、MIME、大小和 SHA-256；
- `coordinator-inbox.json`：协调收件箱；
- `runtime/`：Hook spool、诊断和受管运行文件。

工作区根目录的 `.atte-lock/` 串行化桌面与 CLI。每次状态修改先写同目录临时文件，
同步后原子替换 `state.json`；事件日志达到阈值时在写锁内压缩。附件导入校验真实
文件类型、数量与大小，不把图片字节写入目标状态。

### v5 迁移

v5 只保留当前产品所需字段：

- 项目与上线策略；
- 目标、消息、活动、附件、等待、提醒和交付；
- 决定账本；
- 唯一管家与现场引用；
- `watchdog.noProgressMinutes`；
- Agent 运行时 attempt、turn、回执与受限事件；
- `history` 中的退役能力事实。

有效 v2、v3、v4 快照先在原目录创建对应备份：

- `state.v2.backup.json`
- `state.v3.backup.json`
- `state.v4.backup.json`

备份过程先写临时普通文件，同步内容后按原始字节计算 SHA-256，再通过原子硬链接
发布并再次校验。已有备份必须是同字节普通文件；不符、为符号链接、为目录或无法
校验时停止迁移，原 `state.json` 保持未改写。迁移成功后再次读取 v5 不重复备份、
不重复写盘。

迁移映射：

- 事项、消息、活动、附件、决定与已有交付保留；
- 已有交付进入 `review`，生成人工验收注意力；
- `brief`、`autonomy`、续跑/复核派发、探索/发布等实验事项进入
  `executionHold=migration-confirmation`，清除执行派发并等待人确认；
- 旧 Orca 事项保留原状态、消息和现场引用，标记 `readOnly=legacy-orca`，清除派发、
  巡检、恢复和自动现场操作；
- 工作区自主设置、Bot、工人偏好与项目验收授权移入 `history`；
- 管家与负责人命令收敛为 `agents.concierge`、`agents.owner`，负责人留空继承管家。

不支持版本、损坏 JSON、缺字段或结构无效的快照保留原文件并停止加载，不自动归档
或创建空工作区。`workspace.recovery` 只保留为旧格式读取兼容，不覆盖原快照。

## 目标与注意力

`Goal` 的主要生命周期是：

```text
backlog -> active -> waiting -> active
                    \-> review -> completed
active / waiting / review -> dropped
```

`backlog` 是暂存，不派发、不巡检、不创建现场。`active` 表示仍需跟进；
`waiting` 只表示等待用户和所有 Atte Agent 之外的具名外部第三方；`review` 表示已
提交交付、等待人工验收。旧 `manual` 事项可读取和接管，但 v5 不允许新建人工事项。

人的原文与状态事实严格分开：

- `goal.message` / `goal.direct` 只追加原话与附件，不推断状态；
- `goal.progress` / `wait` / `decide` / `risk` / `ship` / `review` 等提交明确事实；
- `goal.accept` 必须由人通过桌面或可信注意力界面执行；
- `complete` / `rework` / `drop` / `resolve` 的最终状态来自人的明确操作或原话，
  管家只能记录用户已明确说出的事实；
- `goal.remind` 只改提醒时间，不改变生命周期。

注意力由同一份状态派生，不建立第二份列表：

| 来源 | 注意力类型 |
| --- | --- |
| 业务问题、上线审批、高风险动作、迁移确认 | `decision` |
| 带真实检查的交付，且需要人验收 | `review` |
| 提醒到期 | `follow_up` |
| 派发失败、现场不可达、巡检升级、审查轮次耗尽 | `intervention` |
| 普通进展、`idle` / `done`、Hook heartbeat | 否 |

首页按固定顺序显示“需要你决定、等待你验收、到期跟进、Agent 需要介入”。未到期的
外部等待只显示紧凑概览。`isReadOnlyGoal` 会在注意力、派发、巡检和现场操作入口
排除旧 Orca 历史。

## 协调与巡检

### 协调收件箱

每个工作区一份 `coordinator-inbox.json`，只允许一个管家 drain。优先级固定为：

```text
human > attention > normal > background
```

同一事项只保留最新有效通知；更高优先级不会被同级新通知降级。`requestId` 是投递
幂等键。已排队请求在重启后继续；`processing` 在重启后转为 `unconfirmed`，不自动
重放。负责人仍按事项并行，管家案卷严格串行。

负责人新的结构化写回由桌面观察器发现，立即排入协调收件箱；启动时先播种已见活动，
因此不会重放历史。通知送达不等于业务完成。

### 看门狗

`packages/core/src/watchdog.ts` 只根据负责人写回、派发时间、现场可达性和回执判断，
不解析终端文本。默认无进展阈值为 30 分钟，迁移时可继承有效旧值。

主要检查点：

- 派发后 60 秒仍无负责人现场：`unassigned`；
- 负责人处于 `blocked`：先请管家核对；
- 现场不可达或进程替换：`missing`；
- `idle` / `done` 持续 90 秒但仍无结构化结果：`settled`；
- 可信 Stop 后回执缺失：`protocol_missing`；
- 超过无进展阈值：`stale`。

巡检请求先进入协调收件箱。联系管家失败会保留失败信息并形成 `intervention`；
已联系 10 分钟仍无恢复进展时升级给人。看门狗、提醒和回执恢复都在 0.14 保留。
回执提醒成功交给管家时，`contactedAt` 只由协调收件箱的派发路径记账一次；
Broker 不再额外写一次成功的 `watchdog.report`，避免重复“已请管家核对”。

### 回执提醒

可信 `turn.settled` 启动一次回执检查：

1. 等待约 10 秒（初始 `remindAt = settledAt + 10s`）；
2. 当前 turn 已有关键语义写回则取消；
3. 否则核实同一负责人现场，把单行协议提醒正文通过 Herdr 官方
   `agent prompt <pane> <text> --wait --until working` 只投递一次，保持 bracketed
   paste 和完整 `ATTE_RECEIPT` marker；成功观察 `working` 即记为 `started`；
4. 只有 Codex 报 `agent_prompt_stalled` 时才补提交：先轮询 `agent list` 是否已
   `working` / `blocked`；尚未确认接手时，重新核实同一现场身份、可达性及 `idle`
   状态，通过 `agent read --source visible` 读取最后一个 `›` 输入框，只检查当前
   草稿，不把 transcript 历史区当作未提交正文；
5. 仅当最后一个 `›` 输入框的草稿仍含提醒正文时，才补按
   `agent send-keys <pane> enter`，最多 6 次，每次补按后轮询 `working` / `blocked`，
   确认接手即记为 `started` 并停止补按。每次补按前重新核实，身份不符、现场不可达、
   不再 `idle` 或草稿消失即停止；绝不重发正文；
6. 不能确认处理则记为 `accepted`。桌面 `main` 只把 `started` 映射为 `sent`；
   `accepted` 向 Broker 返回为 `unconfirmed`，保留说明并按回执检查流程交给管家核对；
7. 提醒后等待 30 秒仍无语义写回，则标记 `protocol_missing` 并交给管家。
   初始 `inspectAt = settledAt + 40s`；提醒流程结束时记录 `remindedAt`，并把
   `inspectAt` 更新为 `remindedAt + 30s`；
8. 写回早于投递确认时，保留语义回执的 `written`；投递确认只幂等补记一次提醒和
   `remindedAt`，不退回 `reminded`，不覆盖真实结果或重复生成提醒记录；
9. 新输入、新 turn、重启、结束或人工接管取消旧计时器。

投递收据的 `started` / `accepted` 与语义回执分开；提醒本身产生的 Agent 回合通过
完整 marker 沿用原回执，不再次催办。没有 Hook 的 Agent 继续使用 Herdr 空闲路径。

## Herdr 会话

Herdr 是唯一执行后端。`packages/sessions` 提供：

- `SessionControl`：租约、epoch、绑定身份和幂等操作；
- `SessionRuntime`：准备管家、启动/投递负责人、聚焦与关闭现场；
- 私有 launcher 与启动收据：保存安装、epoch、attempt、进程出生时间和 locator，
  不保存 Prompt 或 Hook token；
- Herdr Session / Tab / Pane / Pane 前台进程的运行时核查。

每次受管启动或投递先取得控制租约，返回时复核 epoch。旧现场、旧 attempt、旧 turn
或未经核实的 locator 不能发送输入或关闭新现场。创建和发送在外部副作用前记录请求；
响应丢失时按同一 request / binding 核对，不重建正文或自动重放。身份核实时失败则
拒绝发送，不把 shell 或已退出的 Pane 当成负责人。

每个工作区使用独立的 Herdr Session。应用自带经过 SHA-256 校验的 Herdr TUI CLI，
并提供 `Session Host` 私有通道，使沙箱中的受管 Agent 不必自行查询系统进程或开放
额外权限。

外部工作现场由 `ExternalTerminalManager` 在 iTerm2、Terminal 或 Ghostty 中 attach
当前 Session。终端与工作区的映射保存在 userData 的私有设置中；再次打开先验证
原 attach 进程与 TTY lease，再复用窗口。内嵌轻现场使用同一 Session，不维护第二份
Agent 状态；终端滚动历史不进入目标上下文。

0.14 不再保存或切换执行后端，也没有 `SwitchAuthority`、旧后端停止确认或交替恢复
事务。Herdr 不可用时，目标、提醒和人工验收仍可读取，但新的 Agent 启动与投递暂停。

### Herdr 插件

应用把固定源码部署到 `userData/herdr-plugin`，以 `dev.atte` 注册。插件提供注意力
控制台、新建入口、回到管家和现场事件：

- `pane.agent_status_changed`
- `pane.exited`
- `pane.closed`
- `pane.moved`
- `tab.closed`
- `workspace.closed`

插件只提交事件与动作，不持有业务状态。Pane 移动时用新 locator 原子更新绑定，
旧 ID 立即失效。插件继承 Herdr 用户权限，因此权限判断和状态写入仍在 core 与受约束
Electron IPC 中。

## Agent Hook 管线

```text
官方 Hook / OMP extension
        |
        v
atte hook ingest --adapter <id>
        |
        +--> 512,000-byte / 2 s bounded stdin
        |
        +--> 归一化、序列与 turn 校验
                 |
                 +--> 本地 Socket -> Electron Broker -> AgentRuntimeState
                 |
                 +--> 私有 spool -> 重启后补处理
```

Hook 只观测会话、turn、阻塞、中断和可用回复。工具参数、工具输出和终端全文不进入
目标；Prompt 与最新回复只保存有界文本和原文哈希。事件按 attempt 与单调序号去重，
旧 attempt、旧 turn 和迟到事件只能进入诊断。

OMP extension revision 3 在写 stdin 前安装子进程与流错误处理器，避免 child 提前
退出时未处理的 `EPIPE` 杀死 OMP。CLI ingest 同样有界读取；超限后丢弃载荷并继续
排空到 EOF，2 秒超时，任何失败都不向 Agent 回合返回非零退出码。

Socket 不可用或 500 ms 内未响应时，事件转入私有 spool。spool 最多 200 条、保留
7 天，权限为 owner-only。应用重启先 drain 离线事件，再恢复回执计时器。

Hook 失败诊断写入有界 `hook-diagnostics.json`，只包含固定失败分类的计数和最后
失败时间；不保存 payload、token、工具输出或终端历史。`atte doctor --json` 读取该
快照，`AgentHookManager` 同时负责配置合并、首次备份、受管标记、停用与卸载。
Codex 等待原生 `/hooks` 信任；损坏配置、未来 schema、非普通文件或用户同名 OMP
文件不会被覆盖。

## 交付、验收与授权

`goal.review` 要求成果摘要和至少一项真实执行过的检查，检查必须包含命令或操作、
`passed` / `failed` 结果与说明。可选证据支持 `command`、`artifact`、`url`、
`attachment`、`inspection`。空检查或失败检查不能提交为可验收交付。

人在桌面调用 `goal.accept`，或通过普通终端提交明确验收。0.14 没有独立复核者、
自动验收门禁或 acceptance mandate。验收通过只结束目标，不执行合并、部署或外发。

`Project.policy` 保存 `shipPolicy`、审批人展示信息、修订号和更新时间。默认
`external-approval`；策略只由人在桌面修改。`goal.ship` 检查策略并返回是否允许，
不执行外部动作。九类高风险动作始终先建立 `decision` 注意力，决定账本按稳定动作键
复用明确批准或拒绝。

`goal.review` 默认最多三轮。达到上限后的新提交转为 `intervention`，只有人明确
允许才增加一轮。

## 桌面 IPC 与安全

`BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、
`sandbox: true`，拒绝窗口跳转与权限请求。preload 只暴露：

- 工作区与项目选择；
- 图片导入与附件打开；
- 目标命令；
- Herdr、CLI、Skill 与 Hook 管理；
- 工作现场设置；
- 诊断与 HTTPS 链接。

IPC 校验发送方 URL；附件按字节导入，预览只接受当前状态中的附件 ID；终端枚举、
Session 名称、TTY lease 和用户文本在进入系统命令前校验。渲染进程只从同一份工作区
快照派生界面，不直接读取状态文件，也不从自然语言推断目标状态。

应用数据中的私有描述文件、spool 与锁使用 owner-only 权限。诊断日志限制大小并
压缩绝对路径；不记录目标正文、消息、附件、终端输出、Webhook 地址或凭据。

## 打包与验证

目标平台仅 macOS Apple Silicon。发布产物为：

- `Atte-<version>-macOS-arm64.dmg`
- `Atte-<version>-macOS-arm64.zip`
- `SHA256SUMS.txt`

应用包包含 Electron、Atte CLI 的 Node runtime 和经过校验的 Herdr TUI CLI。构建
完成 Electron 嵌套代码签名后再制作附件。ad-hoc 签名不等于 Apple 公证。

验证覆盖：

- Node 与 Bun 下 OMP extension 的提前退出、部分读取、spawn 失败和重复大载荷；
- CLI ingest 的超限、超时、排空、非法载荷、正常投递与 spool；
- v2/v3/v4 → v5 备份、失败停止、幂等和旧记录映射；
- 看门狗、回执、协调收件箱和负责人写回通知；
- 真实 Herdr 启动、外部终端、内嵌轻现场、插件注册与安装包。

## 已移除的架构

0.14 不再包含：

- 自主续跑 scheduler 与 continuation lease；
- 独立复核执行器和自动验收门禁；
- Bot 请求、能力包仓库、脚本授权与执行；
- 发布目标生命周期和独立发布批准执行链；
- 多后端选择、切换、交接和双后端恢复；Herdr 内部绑定注册与 epoch 防护继续保留；
- Orca 安装、检测、窗口激活和原生终端适配；
- 工人偏好、工作方法挂载和验收授权设置。

旧字段与旧记录只用于迁移、诊断或历史展示，不获得当前执行权。
