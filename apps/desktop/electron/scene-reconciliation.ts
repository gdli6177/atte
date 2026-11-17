import {
  attentionRequest, pendingSceneReply, SCENE_RECONCILIATION_GRACE_MS,
  isReadOnlyGoal, ownerSceneReplyInstructions, type Goal, type WorkspaceService,
} from "../../../packages/core/src/index.js";
import type { SessionRuntime } from "../../../packages/sessions/src/index.js";

export async function requestNeutralSceneReply(
  runtime: Pick<SessionRuntime, "inspect" | "send">,
  goal: Goal,
) {
  const question = attentionRequest(goal);
  if (isReadOnlyGoal(goal) || goal.scene?.backend !== "herdr" || !goal.sceneVisit ||
    !question || goal.sceneVisit.attentionId !== question.id) return false;
  const observation = (await runtime.inspect([goal.scene]))[0];
  if (!observation || observation.identity !== "match" || !observation.reachable ||
    observation.state !== "idle") return false;
  const receipt = await runtime.send(
    goal.scene,
    `scene-reconcile-${goal.sceneVisit.id}`,
    `[ATTE_SCENE_CHECK]
这是系统协议核对，不是用户的新回复，不是继续执行的授权。
当前目标 ${goal.id}，待处理事项 ${question.id}：${question.summary}
用户曾打开本目标现场，随后观察到一次工作回合结束。这个事实不证明用户已经回答问题。
请只核对自己会话中最近的真实用户交互：若已明确回答当前事项且尚未写回，保存原话和结果；若没有、含糊或无法确认，保留待处理并立即结束，不凭空生成回执。不要重复提问，不做额外业务工作。
${ownerSceneReplyInstructions(goal.id)}
[/ATTE_SCENE_CHECK]`,
  );
  return receipt.status !== "rejected";
}

// Older owners did not receive the write-back protocol at launch. After a user
// visit and one observed work cycle, ask that same owner once, at a safe idle
// point. Never copy terminal history into the concierge's context.
export async function reconcileSceneReply(
  target: WorkspaceService,
  goalId: string,
  connection: { requestSceneReply(goal: import("../../../packages/core/src/index.js").Goal): Promise<boolean> },
  options: { now?: () => Date; graceMs?: number } = {},
) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  const visit = item?.sceneVisit;
  if (!item || !visit || visit.status !== "pending" || (!item.scene && !item.herdr) ||
    visit.attentionId !== attentionRequest(item)?.id || pendingSceneReply(item)) return;
  // Hook-capable Agents already report turn settlement. Do not inject another
  // turn that can take the keyboard away from the person answering in-scene.
  if (item.agentRuntime?.capabilities.includes("turn.settled")) return;
  const now = (options.now ?? (() => new Date()))().getTime();
  const graceMs = options.graceMs ?? SCENE_RECONCILIATION_GRACE_MS;
  const observedAt = Date.parse(visit.pendingAt ?? visit.at);
  if (!Number.isFinite(observedAt) || now - observedAt < graceMs) return;
  // The claim is persisted and atomic. A concurrent tick or restart cannot
  // submit the same reconciliation prompt twice.
  if (!await target.execute({ type: "scene.check", goalId, visitId: visit.id, status: "checking" })) return;
  try {
    const sent = await connection.requestSceneReply(item);
    await target.execute({
      type: "scene.check", goalId, visitId: visit.id, status: sent ? "checked" : "failed",
      ...(!sent ? { detail: "现场正在工作、等待交互或身份已变化；没有发送核对消息。" } : {}),
    });
  } catch (error) {
    await target.execute({
      type: "scene.check", goalId, visitId: visit.id, status: "failed",
      detail: String(error instanceof Error ? error.message : error).slice(0, 1000),
    });
  }
}
