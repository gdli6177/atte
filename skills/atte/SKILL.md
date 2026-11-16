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

Only use status-changing commands when this agent is the registered owner or the concierge for that goal and the stated fact has actually happened. Read [references/cli-protocol.md](references/cli-protocol.md) before using `goal progress`, `goal wait`, `goal review`, `goal decide`, `goal risk`, `goal ship`, `session set`, or any acceptance command.

- An owner records a direct human answer using `goal scene-reply`, bound to the current `attentionRequest.id`; it does not approve or dismiss the question. The current-case concierge may apply an explicit human decision using `resolve`, `accept`, `complete`, `rework`, or `drop`, preserving the human's exact words. An external submitting agent must not make these decisions.
- Never report a check, file, deployment, approval, or message as complete unless it was actually observed.
- Ask the concierge to coordinate before escalating a routine implementation choice to the human.
- `waiting` is exclusively for a named external third party outside the human and all Atte Agents. Human choices, confirmations, missing information or actions require `decide` and attention; internal Agent coordination stays `active`. Scheduling a reminder does not change lifecycle.
- Treat an empty or idle terminal as unknown, not successful.
- After a human answers in the owner's Herdr scene, write the receipt before ending the turn. Do not ask the human to repeat the same answer in the desktop app. Never treat a Atte system check as a human reply.
- If `owner launch` cannot confirm environment setup but preserves a real scene and
  recovery ID, use `atte owner attach` only after verifying that exact Session,
  Workspace, Tab, Pane and Agent or foreground process. Never replay a task that may
  already have been delivered.

Return concise results to the caller, including the goal ID and any unresolved human decision. Do not paste secrets, credentials, or unrelated workspace state into Atte.

Protocol evaluation scenarios: [references/waiting-eval.md](references/waiting-eval.md).
