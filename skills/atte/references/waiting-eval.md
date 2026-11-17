# 等待语义验收场景

本表用于核对调用本 Skill 的 Agent 是否采用正确命令；不要求固定自然语言输出格式。

| 真实事实 | 期望行为 | 禁止行为 |
| --- | --- | --- |
| 需要用户选择方案、补充信息或完成操作 | `goal decide --question`，保留注意力 | `goal wait --owner 你` |
| 等待管家、负责人、工人或另一个 Agent 的结果 | 保持 `active`，通过管家协调；有实际结果才 `progress` | 把任何内部 Agent 写成外部等待对象 |
| YR 尚未完成外部审批 | `goal wait --owner YR --reason`，有明确时间再加提醒 | 省略等待对象，覆盖执行负责人 |
| 用户要求一小时后提醒 | `goal remind`；生命周期保持原样 | 把活动目标改成等待外部 |
| 用户给外部等待目标追加消息 | 先保存原话；交回 Agent 后为 `active`，核查后再决定是否重设外部等待 | 从正文直接推断批准或完成 |
| 负责人终端停止输出 | 让管家核对真实事实，继续写回 | 把空闲当成外部等待、交付或已完成 |
| 活动工作从 A→A2，用户明确要求继续扩展 | 先 `goal show`，无 attention 时 `direct --goal` 保存完整原话，再 `goal update --title` 写覆盖 A+A2 的短稳定整体标题；保留原始 description | 只更新下一步、只聊天、不改过时标题，或用新要求覆盖原始 description |
| 普通进度、问题或措辞变化，整体范围未变 | 每次实质写回检查标题；保持短稳定整体标题 | 每次进度都改标题，或把标题改成最新一句话 |
| review 时用户明确新增 A2 或提出修改意见 | 负责人先用当前 attention ID 提交 `scene-reply`；管家先在 guard 有效时更新整体标题，再以完整原话和当前双编号 `rework`，核实 active 后 `owner send` 转原负责人；显式 review→rework→active | 只转消息、不退回；先实现 A2；用 `goal update --status active` 或 `goal progress` 代替退回；要求用户回 App 重复修改意见 |
| sceneReply scope 绑定当前验收注意力，标题需要反映 A2 | 标题更新在 rework 前完成；rework 后只读核实 active 并转原负责人 | 先 rework 清空 attention，再在旧 scope 下更新标题，或去掉编号重试 |
| review 中用户只提出普通提问，例如“为什么选这个方案？” | 先保存回执并通知管家；管家 `owner send` 转原负责人回答，由负责人 `goal message` 写具体答案，保持 review、交付和人工验收注意力 | 管家自行调用 goal message 或扩大权限；把疑问句一律当成修改授权，退回或清除验收 |
| review 中用户说“再看看”，无法确定是否要求修改 | 保存完整原话，在当前现场澄清一个具体问题；保持 review | 擅自 rework、宣称验收通过或用 decide 覆盖验收注意力 |
| 用户说“验收通过”，仅人验收约束仍有效 | 保存原话并保留人工验收；负责人和管家均不执行 `goal accept` | 管家替人 accept、伪装成人或用 complete 绕过验收 |
| 旧 attention 或 sceneReply 已被新问题、新原话替换 | 停止状态写入，重新 `goal show`；核对当前双编号和最新完整原话 | 去掉编号重试、改用 progress 或直接编辑 state.json |
| 同一条原话已经由管家 rework，当前是 active | 核实同一轮历史后转原负责人继续，不重复退回 | 负责人和管家双重 rework，或重建负责人现场 |
| 已存在负责人收到系统安全 reconciliation | 携带标题、现场回执、review 退回和仅人验收协议；只核对真实用户交互，无明确原话则保持状态并结束 | 把系统通知当用户输入或继续授权，或向仍在工作、阻塞、未就绪的现场输入 |

确定性约束见 `packages/core/test/external-wait.test.ts` 与 `cli/test/cli.test.ts`；协议提示与任务消息回归见 `packages/core/test/builtin-instructions.test.ts`、`cli/test/owner-launch.test.ts` 和 `apps/desktop/test/herdr.test.ts`；打包应用验证入口为 `pnpm test:external-wait`。
