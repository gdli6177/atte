# Atte 领域语言

当前产品为 Atte 0.14.0：轻量注意力中心。产品行为以[使用说明](docs/atte.md)
和[架构](docs/ARCHITECTURE.md)为准； `docs/product/` 中标注“历史规格”的文件
只用于理解旧版本，不定义当前行为。

- **工作区 / Workspace**：一个人所有项目与个人事项的本地集合；状态位于 `.atte/`。
- **管家 / Concierge**：每个工作区唯一的 `concierge` Agent，负责理解目标、分发、
  协调、跟进、转达和向人交接；不亲自执行事项。
- **负责人 / Owner**：管家为某个事项启动的独立 Agent 现场，负责实际执行并通过
  Atte CLI 结构化写回事实。
- **事项 / Goal**：保存原文、项目、下一步、等待、消息、附件、交付与历史的记录。
- **暂存 / Backlog**：只记录、不派发的状态；不巡检、不创建现场，只有明确交给
  管家或由人接管后才开始。
- **人接管 / Takeover**：人接管一个已有事项并停止后续管家派发；0.14 不允许新建
  “我来做”事项。
- **注意力 / Attention**：由同一份目标状态派生的当前人工事项，固定四类：
  `decision`（需要你决定）、`review`（等待你验收）、`follow_up`（到期跟进）、
  `intervention`（Agent 需要介入）。
- **全部事项 / All items**：所有目标、项目和历史的集合视图；项目筛选与状态筛选
  在这里，不另设“待办池”产品入口。
- **交付 / Delivery**：成果摘要、位置和至少一项真实执行过的检查；负责人自称完成
  不等于交付可验收。
- **验收 / Acceptance**：人查看交付与证据后明确通过或退回；0.14 只有人工验收，
  没有独立复核编排或自动验收。
- **工作现场 / Scene**：Herdr Session 中经过身份核实的负责人终端。外部
  iTerm2、Terminal 或 Ghostty 是默认打开方式，内嵌轻现场是回退。
- **Herdr 后端 / Herdr backend**：0.14 唯一的执行后端，负责持久 Session、Tab、
  Pane、Agent 通信和现场生命周期；没有第二个可选后端。
- **外部终端 lease**：记录工作区、Session、终端类型和真实 TTY 的本地引用，用于
  复用已有窗口；控制失败只影响打开方式，不改变事项或 Herdr Session。
- **协调收件箱 / Coordinator inbox**：每个工作区一份持久、私有的管家通知队列；
  按人工反馈、注意力、普通目标、后台巡检排序，同目标变化只保留最新有效通知。
- **看门狗 / Watchdog**：基于负责人写回、派发时间、现场可达性和回执的巡检；
  先请管家核对，联系失败或长期未恢复才升级为人的注意力。回执缺失成功交给管家时，
  `contactedAt` 只由协调收件箱的派发路径记录一次，Broker 不重复记账。
- **回执提醒 / Receipt reminder**：可信 Stop 后约 10 秒仍无结构化写回时提醒同一
  负责人一次；单行正文只通过 Herdr 官方 `agent prompt` 投递一次，保持 bracketed
  paste 和完整 `ATTE_RECEIPT` marker，成功观察 `working` 即记为 `started`。只有
  Codex 报 `agent_prompt_stalled` 时，才在核实同一现场仍 `idle` 后，读取最后一个
  `›` 输入框；仅当该草稿仍含提醒正文时，补按 `agent send-keys <pane> enter`，
  最多 6 次，每次轮询 `working` / `blocked`，确认接手即停止补按。身份不符、现场
  不再 `idle` 或草稿消失也立即停止，不把 transcript 历史区当草稿，绝不重发正文。
  不能确认处理则记 `accepted`，由 `main` 向 Broker 返回 `unconfirmed`，不能算作
  `sent`，按回执检查流程交给管家核对。提醒后 30 秒仍无语义写回则标记
  `protocol_missing`；初始 `remindAt = settledAt + 10s`、`inspectAt = settledAt + 40s`，
  提醒流程结束后更新为 `remindedAt + 30s`。写回早于投递确认时保留 `written`，
  并幂等补记一次提醒，不覆盖真实写回或重复记账。
- **协议缺失 / Protocol missing**：Agent 回合已停止且回执提醒后仍无结构化写回
  的可核对事实；不等于完成、失败、验收或人工待办。
- **状态命令 / State command**：管家或受信任适配器显式提交的结构化事实，如
  `progress`、`wait`、`decide`、`risk`、`ship`、`review`；只有它能改变业务状态。
- **原始消息 / Goal message**：人或 Agent 追加到事项的不透明文本与附件事实，
  不从正文推断状态、批准或验收。
- **决定账本 / Decision ledger**：人明确批准或拒绝的动作、原话、时间、来源和
  事项；相同动作键优先复用，不重复打扰。
- **上线策略 / Ship policy**：项目级合并与部署授权规则，默认外部审批；只由人在
  桌面修改。Atte 只返回是否允许，不执行 Git、部署或外发。
- **高风险动作 / High-risk action**：删数据、停服、花钱、外发消息、改产品方向、
  新建或轮换密钥、改权限、改上线策略；任何上线策略下都必须先问人。
- **审查上限 / Review limit**：同一事项默认最多三轮交付审查；第四轮进入注意力，
  由人决定是否增加。
- **Agent attempt**：一次负责人启动、重启或恢复的唯一运行绑定，包含事项、
  Adapter、Agent、现场、当前 turn 与一次性 Hook token；旧 attempt 不能覆盖新现场。
- **生命周期事件 / Agent Runtime Event**：会话、turn、阻塞、中断、回复与会话
  结束的受限结构化事件；工具参数、工具输出和终端全文不进入事项。
- **Hook 诊断 / Hook diagnostics**：只保存固定失败分类计数和最后失败时间的
  有界脱敏记录，通过 `atte doctor --json` 查询；不保存 payload、token、工具输出
  或终端历史。
- **迁移确认 / Migration confirmation**：v5 退役实验功能后，旧自主事项暂停执行并
  等待人确认是否按普通事项继续的状态。
- **只读历史 / Read-only history**：旧 Orca 事项或已退役记录保留原始状态供查看，
  但不进入注意力、派发、巡检、恢复或自动现场操作。
- **退役功能 / Retired feature**：0.14 明确移除、不能通过兼容开关重新启用的能力；
  命令返回 `feature_removed`（退出码 2），历史记录仍可读取。
- **历史规格 / Historical spec**：描述 0.13 及更早行为的开发或验收文档；只用于
  追溯，不覆盖当前产品事实。

## 0.14 当前边界

保留：普通事项执行、管家协调、负责人写回、真实交付检查与人工验收、上线策略、
高风险审批、决定账本、审查上限、提醒、看门狗、回执恢复、协调收件箱、负责人写回
通知，以及内置 Atte 协议 Skill 安装。

退役：Orca 安装/更新/选择/切换、Bot 协议、本地能力包与脚本、持久续跑、独立复核、
自动验收、边界变更、独立发布目标生命周期、工人偏好和自主推进设置。

工作区快照版本为 v5。有效 v2/v3/v4 先校验备份再迁移；备份失败停止且不改原快照。
旧交付进入人工验收；未完成实验事项暂停；旧 Orca 事项保留原状态并只读。`hook ingest`
保持 fail-open 且退出 0；OMP extension revision 3 在写 stdin 前安装子进程与流错误
处理器，防止子进程提前退出引发的 stdin `EPIPE` 杀死 OMP。已运行的 OMP 进程需要
重启才能加载 revision 3 extension。
