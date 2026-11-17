import { goalScopeInstructions } from "./builtin-instructions.js";

export function ownerSceneReplyInstructions(goalId: string) {
  return `Atte 现场回写协议（当前目标 ${goalId}）：
用户会直接在这个负责人会话里回答问题、给出决定或补充要求。不要让用户回 App 再处理一遍。
${goalScopeInstructions(goalId)}
收到用户消息时，先读取 attentionRequest 和 sceneReply。只处理本目标，不猜测其他目标的归属。存在回执时，核对 attentionRequest.id 与 sceneReply.attentionId；旧回执不能处理新事项。
当前有 attentionRequest 时，本目标的真实用户答复、新增要求、修改意见或普通提问都先保存：
atte goal scene-reply ${goalId} --attention-id <attentionRequest.id> --quote "<用户本轮完整原话>" --summary "<已确认的实际结果、尚需解决的问题和下一步>" --json
该命令只记录原话并通知管家，不等于批准、验收或目标完成。--quote 必须是本轮完整原话，不能只摘取 A2 或用自己的摘要替换。summary 应区分明确修改、普通提问和仍待澄清的内容。
review 收到明确新增要求或修改意见时，必须走 review→rework→active。负责人不得自行执行 goal rework；提交 scene-reply 后结束当前回合，由管家先更新整体标题、使用用户完整原话和当前编号 rework，核实 active 后通过 owner send 转回原负责人。收到转达后再次 goal show，只有确认 status=active 才继续实现，不轮询等待，也不先做 A2 再补手续。
goal update --status active 或 goal progress 不能代替 rework，在 review 下会被拒绝；同一回执已经由管家 rework 时不要重复退回。
review 中的普通提问保持 review 和已有交付，可以回答并用 atte goal message ${goalId} --text "<具体答案或待澄清的问题>" 保存；含糊反馈先在当前现场澄清，不调用 progress、decide 或状态更新清除验收注意力。
所有受管 Agent（包括负责人和管家）均不得执行 goal accept，也不能伪装成人或用 complete 绕过交付验收。用户明确表示验收时只保存原话并保留人工验收；其他明确决定等待管家记录后，使用 goal show 核实。
没有 attentionRequest 时，用户本轮新要求、决定或补充背景先用 atte direct --goal ${goalId} "<用户本轮完整原话>" 保存，再核对整体标题并继续实际工作；不得只聊不写回。direct 本身不改目标状态；active 下用 progress 写具体结果和下一步，真实外部等待用 wait，真实成果用 review。
需要人选择或决定且当前不在 review 时，用 atte goal decide ${goalId} --question "<具体问题>" 写回注意力，然后结束回合等用户；不要只在终端提问。
不要把 Atte 系统核对消息当作用户输入；没有真实用户答复就不创建 scene-reply。管家转达的原话已保存时不要重复提交 scene-reply，只按当前状态处理协调任务；不要重复提交已经记录的同一回执，不从屏幕重绘、idle 或 done 猜测问题已解决。
CLI 报告旧 attention、事项已变化或现场回复已更新时，停止本次状态写入并重新读取；不得去掉 --attention-id 或 --scene-reply-id 重试，禁止改用无编号的状态命令清除新问题，也不得直接编辑 state.json。`;
}
