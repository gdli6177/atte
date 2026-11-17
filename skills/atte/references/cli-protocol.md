# Atte state protocol

Read this file only when the current agent is acting as a registered Atte owner or the global concierge. Every state command requires a real event; natural language alone never proves approval, acceptance, completion, or a passed check.

## 范围与标题

每次实质写回前先 `goal show` 核对当前状态、attention、标题、原始 description 和最新原话。用户通常从 A 继续到 A2；明确新增要求或修改范围时，用 `goal update --title` 写出覆盖 A+A2 的短而稳定的整体标题。普通进度、问题或措辞调整不抖动标题。原始 description 和每轮用户完整原话始终保留，不能用标题或新摘要覆盖。

## Progress and waiting

```sh
atte goal progress "$GOAL_ID" --summary "$ACTUAL_RESULT" --next "$NEXT_STEP" --root "$WORKSPACE"
atte goal wait "$GOAL_ID" --reason "$WAITING_REASON" --owner "$WAITING_OWNER" --remind-at "$ISO_TIME" --root "$WORKSPACE"
```

Use `progress` after an observable result, not as a heartbeat. Use `wait` only while a named external third party (a contact, organization or external service) outside the human and every Atte Agent is blocking work. `--owner` is required and stores the external party in `waitingFor`; it does not replace the execution owner. The CLI rejects missing targets, the human, the concierge and registered Agents.

Human choices, confirmations, information or manual actions outside review use `decide`; delivery uses `review`. Neither belongs in external waiting. Coordination with an owner stays `active`; ending a turn or an idle terminal never proves external waiting. `remind` changes only the schedule, including on active goals.

Handing a waiting concierge goal back via `message`, `direct` or follow-up returns it to `active` and clears the old wait and reminder while an Agent processes it. Read the waiting activity/history to recover the original party and time; explicitly re-establish `wait` with an appropriate reminder if it is still an external dependency. Do not infer external completion from the message alone.

## Decisions and high-risk actions

```sh
atte goal decide "$GOAL_ID" --question "$SPECIFIC_QUESTION" --next "$PLANNED_NEXT_STEP" --root "$WORKSPACE"
atte goal risk "$GOAL_ID" --category "$CATEGORY" --summary "$PROPOSED_ACTION" --root "$WORKSPACE"
```

Use `decide` for a concrete choice Atte cannot resolve. Use `risk` before deleting data, stopping a service, spending money, sending an external message, changing product direction, creating or rotating a secret, changing permissions, or changing shipping policy. High-risk work waits for the human even when a project policy is automatic.

## Human replies in an owner scene

```sh
atte goal show "$GOAL_ID" --root "$WORKSPACE" --json
atte goal scene-reply "$GOAL_ID" --attention-id "$ATTENTION_REQUEST_ID" \
  --quote "$VERBATIM_HUMAN_ANSWER" --summary "$ACTUAL_RESULT_AND_NEXT_STEP" \
  --root "$WORKSPACE" --json
```

先读取 `goal show` 的 `attentionRequest.id`、`sceneReply` 和最新状态。只有本目标登记的负责人或管家可以提交回执，身份来自 `ATTE_AGENT_NAME` 或 `--actor`。有 attention 时，本目标真实用户答复、新要求、修改意见或普通提问都先通过上述命令保存完整原话；`--quote` 不能只摘取 A2，也不能改成 Agent 的结论。原话与事实摘要分别保存，回执通知唯一管家，但不解决问题、不批准、不验收，也不改变生命周期。没有真实用户输入不得创建回执；系统 reconciliation 不是用户答复。

管家重新读取当前案卷，核对 `attentionRequest.id === sceneReply.attentionId`，并确认 `sceneReply.id` 仍对应本轮；旧 attention 或更新后的原话会拒绝旧命令。当前案卷 scope 自动绑定 `attentionId` 和 `sceneReplyId`；决策或退回命令的 `--note` 必须逐字保留 `sceneReply.quote`。

review 收到明确新增要求或修改意见时，必须显式执行 review→rework→active。负责人优先只提交 `scene-reply` 并结束当前回合，由管家唯一执行退回；不让用户回 App 重复要求修改，也不先实现再补状态。管家按以下顺序操作：

```sh
atte goal update "$GOAL_ID" --title "$OVERALL_TITLE" \
  --attention-id "$ATTENTION_REQUEST_ID" --scene-reply-id "$SCENE_REPLY_ID" \
  --root "$WORKSPACE" --json
atte goal rework "$GOAL_ID" --note "$VERBATIM_HUMAN_ANSWER" \
  --attention-id "$ATTENTION_REQUEST_ID" --scene-reply-id "$SCENE_REPLY_ID" \
  --root "$WORKSPACE" --json
atte goal show "$GOAL_ID" --root "$WORKSPACE" --json
```

第一步仅在标题需要反映新范围时执行，整体标题覆盖 A+A2。标题必须在 rework 之前更新：rework 清空 attention 后，旧 scope 下的标题更新会失效。桌面 feedback 没有对应 `sceneReply` 时，先读最新用户消息，上述命令只携带当前 `--attention-id`，不携带旧的 `--scene-reply-id`；`--note` 使用本轮完整原话。

核实最新 `status=active` 后，使用 `atte owner send "$GOAL_ID" --text "$VERBATIM_HUMAN_ANSWER_AND_NEXT_STEP" --root "$WORKSPACE" --json` 转原负责人继续，随消息重申当前协议，再结束协调回合。负责人收到转达后再次 `goal show` 确认 active 才执行。若同一条原话已退回且当前 active，不重复 rework。`goal update --status active` 或 `goal progress` 不能代替 rework，review 下这两种写法会被拒绝。

review 的普通提问保持 review 和已有交付，管家只通过 `owner send` 请原负责人回答，由负责人使用 `goal message --text "<具体答案>"` 保存事实答复；管家不得调用 `goal message`，不扩大当前案卷权限。含糊反馈在当前现场澄清是否要求修改，不调用 `progress`、`decide` 或状态更新清除验收注意力。所有受管 Agent（包括负责人和管家）均不得执行 `goal accept`，不得伪装成人，也不得用 `complete` 绕过交付验收。用户明确表示验收时只保存原话并保留人工验收。

决策类 attention 的明确答复使用 `resolve --outcome approved|rejected`，保存原话和双编号；`resolve` 不能处理 review。明确放弃使用 `drop`；`complete` 只适用于没有待验收交付的明确结束。普通进展不解决旧决定。

没有 attention 时，先用 `direct --goal "$GOAL_ID" "$VERBATIM_HUMAN_MESSAGE"` 保存补充原话，核对整体标题后按事实写回进展、外部等待或交付。CLI 报旧 attention、事项已变化或现场回复已更新时，停止本次写入并重新读取；不得去掉 `--attention-id` 或 `--scene-reply-id` 重试，不使用无编号命令或编辑 state.json 绕过旧回执守卫。

每次通知已有负责人或管家，也必须携带标题、现场回执、review→rework→active 与仅人验收约束。转达的原话已经保存时，明确告知负责人不重复 scene-reply。安全 reconciliation 只核对真实用户交互；没有明确原话就保持原状态并结束，不把核对提示、idle 或 done 当成执行授权。

## Delivery and shipping

```sh
atte goal review "$GOAL_ID" --summary "$DELIVERY_SUMMARY" \
  --location "$REAL_ARTIFACT_PATH" \
  --check "$CHECK_NAME::$ACTUAL_OPERATION::$RESULT::$OBSERVED_RESULT" \
  --root "$WORKSPACE"
atte goal ship "$GOAL_ID" --operation merge --checks passed --root "$WORKSPACE"
```

`goal review` needs at least one real check. A check result is `passed` or `failed`; include what was actually executed or inspected. `goal ship` asks the policy engine whether an external merge or deployment is allowed. It does not perform the merge or deployment.

## Work methods

Atte 0.14 retires local method packs, method attachment, script approval and
`atte skill run`. The concierge and owner instructions are built in. Use the current
goal, project rules and retained protocol commands directly; do not attempt retired
commands or reconstruct an executable method loader.

## Herdr owner session

Register a real owner scene only after Herdr returned its identifiers:

```sh
atte session set "$GOAL_ID" --session "$HERDR_SESSION" \
  --workspace "$HERDR_WORKSPACE_ID" --tab "$HERDR_TAB_ID" \
  --pane "$HERDR_PANE_ID" --agent "$LIVE_AGENT_NAME" --root "$WORKSPACE"
```

For an unrecognized interactive CLI, verify its foreground PID and add:

```sh
--transport pane --process-id "$FOREGROUND_PID"
```

After the goal is completed or dropped, Atte releases the owner scene. Do not register the global concierge or another active goal's pane as the owner.

If `owner launch` preserved a real scene but could not confirm environment injection,
bind that exact scene only:

```sh
atte owner attach "$GOAL_ID" --name "$OWNER_NAME" \
  --session "$HERDR_SESSION" --workspace "$HERDR_WORKSPACE_ID" \
  --tab "$HERDR_TAB_ID" --pane "$HERDR_PANE_ID" \
  ${LIVE_AGENT:+--agent "$LIVE_AGENT"} \
  --recovery-id "$RECOVERY_ID" --root "$WORKSPACE"
```

Run it from the matching managed Herdr Session. Verify the Tab, Pane, Agent or
foreground PID first. A stale or superseded recovery ID and a scene owned by another
goal are rejected. Never replay the original task during recovery.

## Boundaries

- Use the current goal ID only. Do not infer ownership from similar titles.
- 所有受管 Agent 都不能代人验收，包括管家。当前案卷管家只能依据明确原话、当前编号和对应命令记录允许的决定；验收原话本身不授权 `goal accept`。
- Do not bypass a rejected CLI scope by editing state files directly.
- Do not retry an external effect without current authorization.
- Treat Atte's coordinator scope as a data API boundary, not an operating-system sandbox.
