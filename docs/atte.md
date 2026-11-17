# Atte 使用说明

版本：0.14.2

## 这是什么

**The attention layer**

Atte 是一个轻量的注意力中心。所有项目和个人事项进入同一个工作区，由一位全局
管家统筹；新工作交给独立负责人执行，只有需要你决定、验收、到期跟进或真正介入
的事才进入注意力。

Atte 不替代 Codex、Claude Code、OMP、Cursor、Qoder 等 CLI Agent，也不运行模型
或管理模型凭据。它保存目标、现场身份、消息、等待、证据和验收事实，并把人的
决定与 Agent 的显式写回连接起来。

0.14.2 只支持 macOS Apple Silicon（arm64）。Herdr 是唯一执行后端；外部终端仍是
默认工作现场，内嵌轻现场作为回退。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| 工作区 | 一个人所有项目与个人事项的本地集合，数据位于 `.atte/` |
| 管家 | 每个工作区唯一的 `concierge`，负责理解、分发、协调、跟进和交接 |
| 负责人 | 管家为某个事项启动的独立 Agent 现场，负责实际执行和结构化写回 |
| 事项 | 保存原文、项目、下一步、消息、等待、交付和历史的记录 |
| 暂存 | 只记录、不启动 Agent；准备好后再交给管家或由你接管 |
| 工作现场 | Herdr Session 中经过身份核实的负责人终端 |
| 交付 | 成果摘要、位置和真实执行过的检查与证据 |
| 验收 | 由你查看交付后明确通过或退回；0.14 不自动验收 |

## 安装与首次使用

1. 从 [GitHub Releases](https://github.com/gdli6177/atte/releases) 下载
   `Atte-<version>-macOS-arm64.dmg` 或 `.zip`，把 Atte 放入“应用程序”后启动。
2. 选择一个专用工作区目录。Atte 在该目录保存 `.atte/`，不会把目标正文、附件或
   终端历史上传到云端。
3. 应用自带经过校验的 Herdr TUI CLI。Herdr 可用后，Atte 会自动安装并注册
   `dev.atte` 插件，不需要手工执行 `herdr plugin install`。
4. 在“设置”检查工作现场、Agent 接入和启动命令；需要外部 Agent 使用 Atte 时，
   在“高级与维护”中安装随应用打包的 Atte 协议 Skill。
5. 点击主导航的“找管家”准备或返回管家，再新建事项。

安装包当前使用 ad-hoc 签名，未经过 Apple 公证。首次打开可能出现“无法验证
开发者”；请先核对 GitHub 来源和 `SHA256SUMS.txt`，再按 macOS 提示打开。若提示
应用“已损坏”，重新下载并核对校验值，不要用清除隔离属性的方式掩盖问题。

## 界面

主导航只有三项：

- **注意力**：现在需要你处理的事。
- **全部事项**：所有记录、项目筛选、状态筛选、搜索和历史。
- **设置**：常用的工作区、外观、Agent、现场偏好、通知说明与项目授权入口。
  Herdr 详情、CLI / Skill 安装、缓存、诊断和 Webhook 默认折叠在“高级与维护”。
  项目授权显示默认外部审批和例外数量，按需展开配置；Hook 异常保持直接可见。

首页固定展示四类注意力，顺序如下：

| 分组 | 进入条件 | 典型动作 |
| --- | --- | --- |
| 需要你决定 | Agent 提出业务问题、上线策略要求审批、命中高风险动作，或迁移后需确认是否继续 | 明确选择或保留原决定 |
| 等待你验收 | 负责人通过 `atte goal review` 提交带真实检查的交付 | 查看成果与证据后通过或退回 |
| 到期跟进 | 提醒时间已到；提醒本身不改变事项生命周期 | 回复现状、交给管家或稍后提醒 |
| Agent 需要介入 | 派发失败、负责人现场不可达、巡检联系不到管家，或审查轮次耗尽 | 查看现场或恢复联系 |

未到期的“等待外部”事项只显示紧凑概览，不占用四类注意力列表。普通跟进中的
事项另显示数量与入口。旧 Orca 历史不进入注意力。

## 从一句话到验收

### 先记下，或交给管家

新建事项只有两种安排：

- **先记下**：进入暂存，不派发、不巡检，也不启动 Agent。
- **交给管家**：立即进入协调流程，由管家理解原文、组织下一步并安排负责人。

0.14 不再提供新建“我来做”事项的入口。已有事项仍可由你接管；暂存事项也可以
稍后交给管家。

### 管家分发

管家读取完整原文、附件、项目规则和当前记录，决定下一步并启动或复用独立负责人。
派发通知成功只表示管家已收到，不表示负责人已经创建或开始工作。超过一分钟仍没有
负责人现场时，巡检先请管家补充分发；联系失败或长期未恢复才进入注意力。

### 负责人写回

负责人在 Herdr 现场执行，并通过 Atte CLI 提交明确事实：

- `progress`：已经发生的进展与下一步；
- `wait`：只等待用户和所有 Agent 之外的具名外部第三方；
- `decide`：需要人明确决定；
- `risk`：需要高风险动作审批；
- `ship`：检查项目上线策略是否允许合并或部署；
- `review`：提交成果、位置和至少一项真实执行过的检查。

普通回复、终端 `idle` / `done`、Hook 事件或自然语言中的“完成了”都不会自动改变
事项状态。自由留言与结构化状态命令分开保存；Atte 不从文本关键词推断批准、验收
或完成。

### 人工验收

负责人的 `review` 将事项放进“等待你验收”。你可以：

- **验收通过**：结束事项，清除它的注意力；
- **给管家发消息**：提出问题或说明要新增、修改的工作。普通提问保持待验收；
  明确修改要求由管家记录原话、退回推进，再交给原负责人继续。

验收通过不替负责人合并代码、部署应用或发送外部消息。需要外部动作时，负责人仍须
先用 `goal ship` 取得项目策略允许。

### 顺着结论继续做

你可以直接在负责人现场从 A 的结论继续交代 A2。Agent 会先读取最新事项、保留本轮
原话，在整体交付范围变化时更新覆盖 A 与 A2 的短标题；原始说明仍保留。

如果事项已经待验收，负责人先保存现场回执并通知管家；管家显式退回推进，确认
`active` 后让原负责人续做。发消息本身保留待验收，普通提问也不会自动变成返工。
界面继续只有“给管家发消息”和“验收通过”两个操作。

注意力卡会显示 Hook 已观测到的负责人最近回复。最新回复、终端活动和标题都不会
自行改变状态；状态仍以 Agent 的结构化写回为准。没有可用回复时不显示空白占位，
也不自动保存整段对话。该流程需要 Agent 遵循写回协议；已有会话的更新方法见
[升级说明](upgrade-atte.md)。

### 等待与提醒

“等待外部”只用于用户与所有 Atte Agent 之外的联系人或机构，例如等客户回复、等
供应商交货。需要你决定、确认、补充信息或操作时进入注意力，内部 Agent 协调保持
`active`。

提醒可以设在等待、暂存或跟进中的事项上。到期后事项进入“到期跟进”，但生命周期
不变；你仍然用一句话交给管家核查，或用“稍后提醒”只移动下一次提醒时间。

## 工作现场

Herdr 是唯一执行后端。每个工作区使用按路径派生的独立 Session；设置中显示实际
Session 名和可复制的连接命令：

```sh
herdr session attach <session>
```

“回到现场”默认在 iTerm2、Terminal 或 Ghostty 中打开同一 Session，并复用已有
窗口。外部终端保留原生组合键、图片粘贴、输入法和完整滚动历史。首次控制 iTerm2
或 Terminal 时，macOS 可能请求自动化权限；拒绝权限不会丢失事项或 Session。

内嵌轻现场使用同一 Herdr Session，适合快速查看和文字输入。终端历史留在 Herdr，
不会自动复制进 Agent 上下文或作为验收证据。仅剪贴板包含图片时，轻现场会把一次
`Ctrl+V` 交给当前 Agent，由 Agent 自己读取系统剪贴板。

### Orca 历史

0.14 已移除 Orca 的安装、更新、选择、后端切换和交接机制，也没有迁移桥。旧
Orca 事项保留原始状态、消息与现场引用，作为只读历史显示；Atte 不会派发、巡检、
恢复、关闭或替它们创建新的负责人。

### Agent 启动命令

设置只保留两项：

- **管家启动命令**：必填，例如 `codex`。
- **负责人启动命令**：留空时继承管家命令。

命令可包含原生参数、绝对路径或 `~/` 路径；环境变量、管道和复杂表达式请写入
自己的启动脚本。Atte 不替 Codex、OMP、Cursor 或其他 CLI 自动添加沙箱、网络、
审批或额外目录参数，也不管理它们的登录凭据。

0.14 不再有工人偏好。已有会话继续按原命令运行；新建会话使用保存后的设置。

## Agent 即时事件与 Hook

Atte 支持 Codex、Claude Code、Cursor、Qoder 和 OMP 的生命周期接入。Hook 只证明
会话、turn、阻塞、中断或回复发生，不证明事项完成、可验收或需要你决定。

OMP 使用受管 extension。0.14 安装 revision 3，修复了子进程提前退出时未处理
stdin `EPIPE` 导致 OMP 会话被杀死的问题：

- 写 stdin 前先安装子进程和流错误处理器；
- 输入上限为 512,000 字节，2 秒截止；
- 超限时丢弃载荷但继续排空输入，直到 EOF；
- 任何 Hook 失败都保持 fail-open，`atte hook ingest` 退出码仍为 0；
- 失败只记录有界、脱敏的分类计数，不保存 Hook payload、token、工具输出或终端历史。

已运行的 OMP 进程可能继续持有旧 extension 代码。升级后请重启相应 OMP 会话。
若重启后仍有观测异常，可运行：

```sh
atte doctor --json
```

报告的 `hookDiagnostics` 只包含失败分类计数和最后失败时间。设置中的“Agent 接入”
可查看适配器状态、版本、Codex 等待信任、兼容问题、最近事件，并执行停用或卸载。
停用或卸载只处理 Atte 管理的条目，保留用户已有 Hook 与其他 OMP extensions。

## 巡检、回执与协调

### 看门狗

看门狗在 0.14 中保留。默认在 30 分钟没有负责人实质写回时检查一次；迁移前的有效
巡检间隔会保留。它会处理：

- 派发后约 60 秒仍没有负责人现场；
- 负责人 `blocked`、不可达或已停止输出但未写回；
- 负责人 `idle` / `done` 90 秒仍没有结构化结果；
- 可信 Stop 后缺少协议回执；
- 长时间没有负责人实质进展。

巡检先请唯一管家核对，不直接从终端画面猜完成或失败。联系管家失败，或已联系
10 分钟仍没有恢复进展时，才生成“Agent 需要介入”。

### 回执提醒

可信 Stop 后约 10 秒仍没有结构化写回时，Atte 向同一负责人发送一次协议提醒。
单行正文只通过 Herdr 官方 `agent prompt` 投递一次，保持 bracketed paste 和完整
`ATTE_RECEIPT` marker；成功观察 `working` 即记为 `started`。

只有 Codex 报 `agent_prompt_stalled` 时，Atte 才检查同一现场是否仍为 `idle`，并
读取最后一个 `›` 输入框。仅当该输入框的草稿仍含提醒正文时，才通过
`agent send-keys <pane> enter` 补提交，最多 6 次，每次轮询 `working` / `blocked`，
确认接手即停止补按。身份不符、现场不可达、不再 `idle` 或草稿消失也立即停止；
不把 transcript 历史区当草稿，绝不重发正文。

不能确认处理时，投递收据为 `accepted`；桌面 `main` 向 Broker 返回 `unconfirmed`，
不把 `accepted` 算作 `sent`，按回执检查流程交给管家核对。提醒后 30 秒仍无语义写回，标记
`protocol_missing` 并交给管家；初始 `remindAt = settledAt + 10s`、
`inspectAt = settledAt + 40s`，提醒流程结束后更新为 `remindedAt + 30s`。
写回早于投递确认时保留 `written`，并幂等补记一次提醒，不覆盖真实写回或重复记账。

每个 turn 最多提醒一次，新输入、重启或结束会取消旧计时器；成功交给管家时，`contactedAt`
只由协调收件箱的派发路径记录一次，Broker 不重复写成功的 `watchdog.report`，
不重复显示“已请管家核对”。

### 协调收件箱

同一工作区的管家通知持久排队，顺序固定为：人工反馈、注意力、普通目标、后台巡检。
同一事项连续变化只保留最新有效通知；不同事项的负责人仍可并行。应用重启恢复
尚未开始的通知；发送途中的通知标为未确认，不自动重放。管家单通道串行，负责人
继续按事项并行。

负责人新的结构化写回会立即形成协调通知，不必等巡检。普通进展不会因此进入注意力。

## 上线策略、决定与审查

每个项目有三种上线策略：

- `external-approval`：默认，检查和审查通过后仍需你批准合并与部署；
- `auto-merge-manual-deploy`：自动放行合并，部署前仍需批准；
- `auto`：真实检查通过后可放行合并与部署。

Atte 本身不执行 Git、部署或外发消息，只返回项目策略是否允许。审批人字段仅用于
展示，不做身份校验。

九类高风险动作在任何策略下都必须先问你：

1. 删除数据；
2. 停止服务；
3. 花钱；
4. 向外部人员发消息；
5. 改变产品方向；
6. 新建密钥；
7. 轮换密钥；
8. 修改权限；
9. 修改上线策略。

明确批准或拒绝会连同原话、时间、来源、项目和事项写入决定账本；后续相同动作键
优先复用已有决定，不重复打扰。同一事项默认最多接受三轮审查；需要第四轮时进入
注意力，由你决定是否增加一轮。

## CLI

桌面会在 `~/.local/bin/atte` 安装 CLI，并使用应用自带 Node runtime。可通过
`--root` 或 `ATTE_WORKSPACE` 指定工作区。桌面与 CLI 共享同一把工作区锁和同一份
原子快照。

常用入口：

```sh
atte status --json
atte doctor --json
atte attention --json
atte board
atte delivery REQUEST_ID --json

atte capture "以后再研究的想法" --remind-at 2026-11-20T10:00:00+08:00
atte ask "检查发布流程并补齐证据"
atte goal list --all --json
atte goal show GOAL_ID --json
atte goal start GOAL_ID --by concierge
atte goal start GOAL_ID --by self
atte goal restore GOAL_ID
atte goal message GOAL_ID --text "补充一条约束"
atte direct "先记下这条背景" --handling later

atte scene focus GOAL_ID
atte owner launch GOAL_ID --name owner-check
atte owner send GOAL_ID --text "请核对最新结果"
```

负责人或受信任适配器在事实明确后使用：

```sh
atte goal progress GOAL_ID --summary "已完成实现" --next "运行回归"
atte goal wait GOAL_ID --reason "等待客户回复" --owner "客户 A" \
  --remind-at 2026-11-18T09:00:00+08:00
atte goal decide GOAL_ID --question "是否采用方案 B？" --next "等待决定"
atte goal risk GOAL_ID --category delete-data --summary "清理生产数据"
atte goal ship GOAL_ID --operation deploy --checks passed
atte goal review GOAL_ID --summary "候选版本已验证" \
  --location "/Applications/Atte.app" \
  --check "安装包验收::pnpm test:installers::passed::DMG 与 ZIP 均通过"
atte goal scene-reply GOAL_ID --attention-id ATTENTION_ID \
  --quote "用户现场原话" --summary "现场处理结果与下一步"
```

`goal message` 和 `direct` 只追加人的原话，不推断状态。`goal remind` 只修改提醒。
`goal accept` 必须由人在桌面或普通终端执行，受管 Agent 不能替人验收。

### 已退役命令

以下入口在 0.14 已移除，执行时在读取或写入工作区前返回
`feature_removed`，退出码为 2：

- `skill`、`autonomy`、`release`、`bot`、`verifier`、`backend`；
- `goal brief`、`goal checkpoint`、`goal verify`、`goal boundary`、
  `goal autonomy`、`goal reopen`；
- 新建人工事项或实验目标类型；
- 工人、验收授权、续跑、工作流等退役参数。

历史记录仍可读取。`atte hook ingest` 是唯一例外：它保持 fail-open，始终退出 0，
不会阻止 Agent 回合。

## 数据、迁移与隐私

工作区状态保存在 `.atte/state.json`，当前版本为 v5。事件追加到
`.atte/events.jsonl`，决定账本写在 `.atte/decisions.md` 与
`.atte/rejected.md`，图片原图位于 `.atte/attachments/`。

有效 v2、v3、v4 快照会先创建并校验对应备份，再原地迁移到 v5：

- v2：`.atte/state.v2.backup.json`；
- v3：`.atte/state.v3.backup.json`；
- v4：`.atte/state.v4.backup.json`。

备份必须与原始字节一致并通过校验；已有备份不匹配、符号链接、目录或校验失败时
停止迁移，原 `state.json` 不变。迁移完成后再读取 v5 不会重复备份或改写快照。
不支持、损坏或结构无效的快照保留原文件并停止加载，不自动归档或重建。

v4 迁移并退役实验功能时：

- 事项、消息、活动、附件、决定与交付记录保留；
- 已有交付进入人工验收；
- 未完成的续跑、独立复核、探索/发布等实验事项暂停，等待你确认是否按普通事项继续；
- 旧 Orca 事项保留原始状态并标记只读历史，不进入派发、巡检、恢复或自动现场操作；
- 旧自主设置、Bot 记录、工人偏好与项目验收授权移入 `history`，不能重新启用。

迁移与回滚步骤见[升级说明](upgrade-atte.md)。不要把 v5 快照直接交给旧版打开。

图片支持 PNG、JPEG、WebP 和 GIF；每个事项最多 8 张，单张 10 MB，总计 30 MB。
状态只保存文件名、相对路径、MIME、大小与 SHA-256，不保存 Base64 或图片字节。
已结束事项的图片默认保留 30 天，应用启动时清理。

Atte 的诊断报告会压缩绝对路径，不包含目标正文、消息、附件、终端输出、Webhook
地址或凭据。Hook 异常诊断也只保存分类计数和最后失败时间。

## 故障排查

- **Herdr 未就绪**：在“设置 → 高级与维护 → Herdr 运行时”查看实际路径、版本和错误。Herdr 暂时
  不可用时仍可查看事项、处理提醒和人工验收，但无法启动或投递 Agent。
- **外部终端打不开**：允许 Atte 控制所选终端，或把“回到现场”改为内嵌轻现场；
  同一事项与 Session 不会丢失。
- **OMP 升级后仍异常**：重启正在运行的 OMP 会话，使其重新加载 revision 3
  extension，再运行 `atte doctor --json`。
- **找不到工作区 Session**：在“设置 → 高级与维护”中复制 `herdr session attach <session>`，
  直接在外部终端运行 `herdr` 默认看不到 Atte 的命名 Session。
- **迁移停止**：保留 `.atte` 和原快照，检查磁盘空间、权限以及
  `state.vN.backup.json` 是否为同一原文件的普通文件副本。不要删除备份或让旧版
  直接打开 v5。
- **CLI 失效**：移动或删除应用后重新安装应用，并在“设置 → 高级与维护”中重新安装 CLI。
- **需要提交诊断**：使用“设置 → 高级与维护 → 排查与反馈 → 复制诊断日志”或
  `atte doctor --json`；报告已脱敏，可直接粘贴给维护者。

## 0.14 已移除

以下能力不再提供，也不会通过兼容开关重新启用：

- Orca 安装、更新、选择、后端切换与交接；
- Bot 绑定与请求协议；
- 本地能力包安装、挂载、脚本授权和执行；
- 持久续跑、独立复核编排、自动验收与边界变更申请；
- 独立发布目标生命周期；
- 工人偏好与自主推进设置。

仍保留的能力是：普通事项执行、管家协调、负责人结构化写回、真实交付检查与人工
验收、上线策略、高风险审批、决定账本、审查上限、提醒、看门狗、回执恢复、
协调收件箱、负责人写回通知，以及内置 Atte 协议 Skill 的安装。
