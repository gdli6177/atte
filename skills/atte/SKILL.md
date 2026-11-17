---
name: atte
description: Use Atte CLI to submit goals and attachments, inspect goals or attention items, and append context in a user's local Atte workspace from another agent.
---

# Atte

Use the installed `atte` CLI to collaborate through the user's shared Atte workspace. The desktop app and CLI read and write the same `.atte/state.json`; do not create a parallel task list in chat or in another database.

## Resolve the workspace

Use the first source that is explicit and verified:

1. A workspace path supplied by the user.
2. `ATTE_WORKSPACE`.
3. The nearest parent directory containing `.atte/state.json`.

Pass `--root <absolute-path>` after the subcommand. Do not guess a different workspace from the current Git repository name. If no Atte workspace can be found, stop and state the missing path.

## Human-facing operations

These commands append user intent without inventing a status transition:

```sh
atte status --root "$WORKSPACE" --json
atte goal list --root "$WORKSPACE" --json
atte goal show "$GOAL_ID" --root "$WORKSPACE" --json
atte ask "$VERBATIM_REQUEST" --project "$PROJECT_ID" --root "$WORKSPACE"
atte capture "$VERBATIM_FUTURE_IDEA" --root "$WORKSPACE"
atte goal message "$GOAL_ID" --text "$VERBATIM_MESSAGE" --root "$WORKSPACE"
```

Use repeatable `--attachment <absolute-path>` for PNG, JPEG, WebP, or GIF context. Preserve the user's original wording and constraints. `goal message` and `direct` never infer approval, acceptance or completion from text. For a concierge goal, handing an external wait back to an Agent returns it to `active` and clears the old wait and reminder pending reconciliation; the next step is preserved. Passive notes on personal tasks preserve external waiting.

If the user asks to create work, prefer one `ask` call with the complete natural-language request. Do not split it into a progress form. Report the returned goal ID and the saved next step, then stop unless the user asked for further execution.

When the user explicitly says to save for later or not to start, use `capture` instead of `ask`. It never starts an agent; add `--remind-at <ISO>` only for an explicit, unambiguous time. Do not change a deferred item to active just because notes were added. Starting it later requires explicit user intent and `goal start ID --by self|concierge`; delegation keeps the same record and attachments. The managed concierge cannot use these human intake commands to escape its current-case scope.

The managed concierge can persist a new request it has already received in its terminal using `direct --new --handling later "$VERBATIM_REQUEST"`. This creates no dispatch. Existing-case `direct` records notes and returns external waits to active coordination; `--handling` must not be used to change an existing goal's execution assignment.

## Work methods

Atte 0.14 ships the concierge and owner instructions with the app. Local method packs,
script approval and method execution were retired. Do not issue `atte skill` commands or
suggest installing a capability pack. Follow the current goal and project instructions
directly, and use only the retained status protocol below.

## Agent execution protocol

Only use status-changing commands when this agent is the registered owner or the concierge for that goal and the stated fact has actually happened. Read [references/cli-protocol.md](references/cli-protocol.md) before using `goal update`, `goal scene-reply`, `goal rework`, `goal progress`, `goal wait`, `goal review`, `goal decide`, `goal risk`, `goal ship`, or `session set`.

- 每次实质写回前先 `goal show`，核对当前状态、attention、标题、原始 description 和最新用户原话。工作从 A 延伸到 A2 时，显式 `goal update --title` 更新为覆盖 A+A2 的短而稳定的整体标题；普通进度和问题不抖动标题。保留原始 description 与用户完整原话，不用摘要替换。
- 有 attention 时，负责人先用绑定当前 `attentionRequest.id` 的 `goal scene-reply --quote "<用户本轮完整原话>"` 保存真实用户答复、新要求、修改意见或普通提问，并通知唯一管家。没有 attention 时先 `direct --goal` 保存本轮原话。回执不代表批准、验收或状态改变。
- review 的明确新增要求或修改意见必须显式执行 review→rework→active。由管家唯一处理本轮退回：在当前 attention 和 sceneReply guard 有效时先更新整体标题，再 `goal rework --note "<用户本轮完整原话>" --attention-id <当前编号> --scene-reply-id <当前回执编号>`，最后 `goal show` 核实 active，通过 `owner send` 转原负责人继续。桌面反馈没有现场回执时只绑定当前 attention；attention 清空后旧 scope 的标题更新会失效。负责人提交回执后结束当前回合，不自行 rework，也不先实现再补状态；已经退回的同一条原话不得重复 rework。
- review 的普通提问保持 review 和已有交付，管家通过 `owner send` 请原负责人回答，由负责人使用 `goal message` 保存具体答案；管家不得调用 `goal message`，不扩大当前案卷权限。含糊反馈先在当前现场澄清。`goal update --status active` 和 `goal progress` 不能代替 rework，在 review 下会被拒绝；不能通过 `decide` 清除验收注意力。
- 所有受管 Agent（包括负责人和管家）均不得执行 `goal accept`，也不得伪装成人或用 `complete` 绕过交付验收。用户明确表示验收时只保存原话并保留人工验收。管家可依据用户明确原话和当前编号处理 `resolve`、`rework`、`drop`；`complete` 只适用于没有待验收交付的明确结束，外部提交 Agent 不获得这些权限。
- 每次 `owner send` 联系已存在的负责人，也要附上本轮的标题、scene-reply、review→rework→active 和仅人验收约束，并说明转达的原话已保存，不重复提交回执；安全 reconciliation 同样携带修正协议，系统核对不是用户输入或继续执行的授权。
- 旧 attention 或回执被替换、CLI 拒绝时，停止状态写入并重新读取当前案卷；不得去掉 `--attention-id` 或 `--scene-reply-id` 重试，不改用无编号命令或编辑 state.json 绕过。
- Never report a check, file, deployment, approval, or message as complete unless it was actually observed.
- Ask the concierge to coordinate before escalating a routine implementation choice to the human.
- `waiting` is exclusively for a named external third party outside the human and all Atte Agents. Outside review, human choices, confirmations, missing information or actions require `decide` and attention; internal Agent coordination stays `active`. Scheduling a reminder does not change lifecycle.
- Treat an empty or idle terminal as unknown, not successful.
- After a human answers in the owner's Herdr scene, write the receipt before ending the turn. Do not ask the human to repeat the same answer in the desktop app. Never treat a Atte system check as a human reply.
- If `owner launch` cannot confirm environment setup but preserves a real scene and
  recovery ID, use `atte owner attach` only after verifying that exact Session,
  Workspace, Tab, Pane and Agent or foreground process. Never replay a task that may
  already have been delivered.

Return concise results to the caller, including the goal ID and any unresolved human decision. Do not paste secrets, credentials, or unrelated workspace state into Atte.

Protocol evaluation scenarios: [references/waiting-eval.md](references/waiting-eval.md).
