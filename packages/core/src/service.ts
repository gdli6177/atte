import { isDeepStrictEqual } from "node:util";
import { WorkspaceStore, newId } from "./store.js";
import { progressBasis } from "./watchdog.js";
import {
  cleanupOrphanAttachmentFiles,
  removeAttachmentFiles,
  validateGoalAttachments,
} from "./attachments.js";
import type {
  AgentAttempt,
  AgentRuntimeEventV1,
  AgentRuntimeEventType,
  AgentRuntimeText,
  AtteCommand,
  Delivery,
  DeliveryCandidate,
  Evidence,
  Goal,
  GoalAttachment,
  LivePresence,
  WorkspaceState,
} from "./types.js";
import { sameScene, validatedScene, type ManagedSessionContext } from "./session-types.js";
import { agentReceiptMarker, isAgentRuntimeAdapter } from "./agent-runtime.js";
import {
  isHighRiskCategory,
  isShipPolicy,
  latestDecision,
  normalizeDecisionKey,
  outcomeLabel,
  projectPolicy,
  riskCategoryForText,
  riskSummary,
} from "./governance.js";
import {
  attentionRequest,
  defaultProjectPolicy,
  pendingSceneReply,
} from "./model.js";
import { observeSceneWork } from "./scene.js";
import { inspectWatchdog, reportWatchdog } from "./watchdog.js";
import { hasDueReminder, intakeArrangement } from "./task-pool.js";
import { externalWaitTarget, leaveExternalWait } from "./waiting.js";
import { isEvidenceKind } from "./delivery.js";
import {
  assertFeatureAvailable,
  assertGoalWritable,
  goalCanExecute,
  isReadOnlyGoal,
} from "./retirement.js";
export const nowIso = () => new Date().toISOString();
function text(value: unknown, label: string, limit = 20_000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    value.includes("\0")
  )
    throw new Error(`请提供有效的${label}`);
  return value.trim();
}
function automaticGoalTitle(request: string): string {
  const firstLine = request.split(/\r\n?|\n/).find(line => line.trim())?.trim();
  return Array.from(firstLine || "新目标").slice(0, 80).join("");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("无效的记录 ID");
  return value;
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("请提供有效的 ISO 时间");
  return new Date(value).toISOString();
}
function preservedOwnerResume(value: unknown): NonNullable<Goal["ownerResume"]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请提供有效的负责人恢复信息");
  const resume = value as NonNullable<Goal["ownerResume"]>;
  const owner = text(resume.owner, "负责人名称", 120);
  const savedAt = iso(resume.savedAt);
  const cwd = resume.cwd === undefined
    ? undefined
    : text(resume.cwd, "负责人工作目录", 4096);
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new Error("负责人工作目录必须是绝对路径");
  const session = resume.agentSession;
  if (session === undefined) return { owner, savedAt, ...(cwd ? { cwd } : {}) };
  if (!session || typeof session !== "object" || Array.isArray(session))
    throw new Error("负责人会话信息无效");
  const source = text(session.source, "Agent 会话来源", 160);
  const agent = text(session.agent, "Agent 类型", 64);
  if (!/^[A-Za-z0-9:_-]+$/.test(source) || !/^[a-z][a-z0-9_-]{0,31}$/.test(agent))
    throw new Error("负责人会话来源或 Agent 类型无效");
  if (session.kind !== "id" && session.kind !== "path")
    throw new Error("负责人会话标识类型无效");
  const sessionValue = text(session.value, "Agent 会话标识", 4096);
  if (/[\x00-\x1f\x7f]/.test(sessionValue))
    throw new Error("Agent 会话标识包含无效字符");
  return {
    owner,
    savedAt,
    ...(cwd ? { cwd } : {}),
    agentSession: { source, agent, kind: session.kind, value: sessionValue },
  };
}
function humanOnly(actor: string | undefined, message: string) {
  if (actor !== "你") throw new Error(message);
}
function assertMigrationConfirmationHuman(
  item: Goal,
  actor: string | undefined,
  managed: ManagedSessionContext | undefined,
) {
  if (item.executionHold !== "migration-confirmation") return;
  if (managed)
    throw new Error("旧实验目标必须由人通过可信界面确认后才能继续");
  humanOnly(actor ?? "你", "旧实验目标必须由人通过可信界面确认后才能继续");
  if (item.attention?.kind !== "decision")
    throw new Error("迁移确认状态无效；请保留原快照并重新读取目标");
}
function deliveryCandidate(value: unknown): DeliveryCandidate | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("候选版本无效");
  const candidate = value as Partial<DeliveryCandidate>;
  const revision = text(candidate.revision, "候选修订", 240);
  if (candidate.digest !== undefined && !/^[a-f0-9]{64}$/i.test(candidate.digest))
    throw new Error("候选摘要必须是 SHA-256");
  if (candidate.version !== undefined) text(candidate.version, "候选版本", 120);
  return {
    revision,
    ...(candidate.digest ? { digest: candidate.digest.toLowerCase() } : {}),
    ...(candidate.version ? { version: candidate.version.trim() } : {}),
  };
}
function writableGoalKind(value: unknown): "delivery" | "discovery" {
  if (value !== "delivery" && value !== "discovery")
    throw new Error("目标类型只能是 delivery 或 discovery；release 目标生命周期已退役");
  return value;
}
function evidenceItems(value: unknown, at: string, checks: Delivery["checks"]): Evidence[] {
  if (value !== undefined && !Array.isArray(value))
    throw new Error("证据列表无效");
  if (Array.isArray(value) && value.length > 100)
    throw new Error("一次最多提交 100 条证据");
  if (value !== undefined) {
    const ids = new Set<string>();
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error(`第 ${index + 1} 条证据无效：必须是对象`);
      const evidence = item as Partial<Evidence>,
        kind = evidence.kind,
        result = evidence.result;
      let evidenceId: string;
      try { evidenceId = id(evidence.id); }
      catch { throw new Error(`第 ${index + 1} 条证据的 id 无效：需要 1-100 位字母、数字、下划线或短横线`); }
      if (ids.has(evidenceId))
        throw new Error(`第 ${index + 1} 条证据的 id 重复：${evidenceId}`);
      ids.add(evidenceId);
      if (!isEvidenceKind(kind))
        throw new Error(`证据 ${evidenceId} 的 kind 无效：必须是 command、artifact、url、attachment 或 inspection`);
      if (!["observed", "passed", "failed"].includes(String(result)))
        throw new Error(`证据 ${evidenceId} 的 result 无效：必须是 observed、passed 或 failed`);
      if (evidence.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(evidence.sha256))
        throw new Error(`证据 ${evidenceId} 的 sha256 无效：需要 64 位十六进制摘要`);
      let observedAt: string;
      try { observedAt = evidence.observedAt ? iso(evidence.observedAt) : at; }
      catch { throw new Error(`证据 ${evidenceId} 的 observedAt 无效：需要 ISO 时间`); }
      return {
        id: evidenceId,
        kind,
        label: text(evidence.label, `证据 ${evidenceId} 的 label`, 240),
        result: result as Evidence["result"],
        observedAt,
        ...(evidence.command ? { command: text(evidence.command, `证据 ${evidenceId} 的 command`, 2_000) } : {}),
        ...(evidence.location ? { location: text(evidence.location, `证据 ${evidenceId} 的 location`, 2_000) } : {}),
        ...(evidence.sourceRevision
          ? { sourceRevision: text(evidence.sourceRevision, `证据 ${evidenceId} 的 sourceRevision`, 240) }
          : {}),
        ...(evidence.sha256 ? { sha256: evidence.sha256.toLowerCase() } : {}),
        ...(evidence.note ? { note: text(evidence.note, `证据 ${evidenceId} 的 note`, 4_000) } : {}),
      };
    });
  }
  return checks.map((check, index) => ({
    id: `evidence_check_${index + 1}`,
    kind: "command" as const,
    label: check.name,
    result: check.result === "passed" ? "passed" as const : "failed" as const,
    observedAt: at,
    command: check.command,
    ...(check.note ? { note: check.note } : {}),
  }));
}
function deliveryChecks(value: unknown): Delivery["checks"] {
  if (!Array.isArray(value) || value.length < 1)
    throw new Error("提交验收至少需要一项真实检查记录");
  const checks = value.map((check, index) => {
    if (!check || typeof check !== "object" || Array.isArray(check))
      throw new Error(`第 ${index + 1} 项检查无效`);
    const item = check as Partial<Delivery["checks"][number]>;
    if (item.result !== "passed" && item.result !== "failed")
      throw new Error(`第 ${index + 1} 项检查结果无效；必须是 passed 或 failed`);
    return {
      name: text(item.name, `第 ${index + 1} 项检查名称`, 200),
      command: text(item.command, `第 ${index + 1} 项检查命令或操作`, 1000),
      result: item.result,
      ...(item.note ? { note: text(item.note, `第 ${index + 1} 项检查说明`, 2000) } : {}),
    } satisfies Delivery["checks"][number];
  });
  if (checks.some(check => check.result !== "passed"))
    throw new Error("仍有检查未通过，请修复后再提交验收");
  return checks;
}
function ongoing(item: Goal, allowReview = false, allowBacklog = false) {
  if (["completed", "dropped"].includes(item.status))
    throw new Error("已结束的目标不能继续修改");
  if (item.status === "review" && !allowReview)
    throw new Error(`目标正在等待验收，请先验收或退回修改。收到明确新增要求时，先执行 atte goal rework ${item.id} --note "用户新增要求原话"，确认状态为 active 后再继续推进。`);
  if (item.status === "backlog" && !allowBacklog)
    throw new Error("这件事尚未开始，请先选择我来做或交给管家");
}
function attachmentActivity(text: string, attachments: GoalAttachment[]): string {
  if (!attachments.length) return text;
  return `${text}\n\n附带图片：${attachments.map(item => item.name).join("、")}`;
}
function runtimeText(value: unknown, label: string): AgentRuntimeText | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`无效的${label}`);
  const candidate = value as Partial<AgentRuntimeText>;
  if (typeof candidate.text !== "string" || Array.from(candidate.text).length > 12_000 ||
    typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
    typeof candidate.truncated !== "boolean")
    throw new Error(`无效的${label}`);
  return {
    text: candidate.text,
    sha256: candidate.sha256,
    truncated: candidate.truncated,
  };
}
const semanticActivityKinds = new Set<Goal["activities"][number]["kind"]>([
  "progress", "waiting", "decision", "delivery", "delivery_amend", "accepted", "rework",
  "dropped", "resolved", "ship",
]);
const runtimeEventTypes = new Set<AgentRuntimeEventType>([
  "session.started", "turn.started", "turn.settled", "turn.interrupted",
  "agent.blocked", "agent.response", "session.ended",
]);
function validatedAttempt(value: AgentAttempt): AgentAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效的 Agent attempt");
  const goalId = id(value.goalId),
    attemptId = id(value.attemptId),
    startedAt = iso(value.startedAt);
  if (value.adapter !== "custom" && !isAgentRuntimeAdapter(value.adapter))
    throw new Error("不支持的 Agent Runtime Adapter");
  const agent = text(value.agent, "Agent 类型", 64);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent))
    throw new Error("Agent 类型格式无效");
  if (value.currentTurnId !== undefined &&
    (typeof value.currentTurnId !== "string" || value.currentTurnId.length > 240))
    throw new Error("Agent turn ID 无效");
  if (value.scene !== undefined &&
    (!value.scene || typeof value.scene !== "object" || Array.isArray(value.scene)))
    throw new Error("Agent attempt 现场无效");
  return {
    goalId,
    attemptId,
    agent,
    adapter: value.adapter,
    startedAt,
    ...(value.currentTurnId ? { currentTurnId: value.currentTurnId } : {}),
    ...(value.scene ? { scene: structuredClone(value.scene) } : {}),
  };
}
function validatedRuntimeEvent(value: AgentRuntimeEventV1): AgentRuntimeEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    value.version !== "v1")
    throw new Error("Agent Runtime 事件版本无效");
  const goalId = id(value.goalId),
    attemptId = id(value.attemptId),
    eventId = text(value.eventId, "Agent 事件 ID", 160),
    at = iso(value.at),
    agent = text(value.agent, "Agent 类型", 64);
  if (!isAgentRuntimeAdapter(value.adapter) ||
    !runtimeEventTypes.has(value.type) ||
    value.source !== "hook" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1)
    throw new Error("Agent Runtime 事件字段无效");
  if (value.turnId !== undefined &&
    (typeof value.turnId !== "string" || !value.turnId.trim() ||
      value.turnId.length > 240))
    throw new Error("Agent turn ID 无效");
  return {
    version: "v1",
    eventId,
    sequence: value.sequence,
    at,
    source: "hook",
    agent,
    adapter: value.adapter,
    goalId,
    attemptId,
    type: value.type,
    ...(value.turnId ? { turnId: value.turnId.trim() } : {}),
    ...(value.content === undefined
      ? {}
      : { content: runtimeText(value.content, "Agent 回复") }),
    ...(value.notificationType === undefined
      ? {}
      : { notificationType: text(value.notificationType, "通知类型", 300) }),
  };
}
function substantiveAgentText(value: string | undefined, label: string, limit: number) {
  const result = text(value, label, limit);
  if (/^(?:已(?:经)?)?(?:回答|回复|答复|处理|完成)(?:了)?(?:用户)?(?:的)?(?:问题)?[。.!！]?$/.test(result))
    throw new Error(`${label}必须写回具体内容，不能只写「已回答」或同类占位摘要`);
  return result;
}
export { attentionGoals, attentionKind } from "./model.js";
export class WorkspaceService {
  readonly store: WorkspaceStore;
  constructor(readonly root: string, private readonly managedContext?: ManagedSessionContext) {
    this.store = new WorkspaceStore(root);
  }
  async read() {
    return this.store.read();
  }
  private async removeGoalAttachment(command: Extract<AtteCommand, { type: "goal.attachment.remove" }>) {
    const attachmentId = id(command.attachmentId),
      actor = command.actor?.trim() ? text(command.actor, "操作者", 120) : "你",
      result = await this.store.update(command.type, async state => {
        const item = state.goals.find(goal => goal.id === id(command.goalId));
        if (!item) throw new Error("找不到目标");
        assertGoalWritable(item);
        const attachment = item.attachments?.find(candidate => candidate.id === attachmentId);
        if (!attachment) throw new Error("找不到这个附件");
        const remaining = (item.attachments ?? []).filter(candidate => candidate.id !== attachmentId);
        if (remaining.length) item.attachments = remaining;
        else delete item.attachments;
        const at = nowIso();
        item.activities.push({
          id: newId("act"),
          at,
          actor,
          kind: "progress",
          text: `已删除图片：${attachment.name}`,
        });
        item.revision = (item.revision ?? 0) + 1;
        item.updatedAt = at;
        return { goal: item, attachment };
      });
    await removeAttachmentFiles(this.root, [result.attachment]);
    return result.goal;
  }
  private async deleteEndedGoal(command: Extract<AtteCommand, { type: "goal.delete" }>) {
    const result = await this.store.update(command.type, state => {
      const goalId = id(command.goalId),
        index = state.goals.findIndex(goal => goal.id === goalId),
        item = state.goals[index];
      if (!item) throw new Error("找不到目标");
      assertGoalWritable(item);
      if (!["completed", "dropped"].includes(item.status))
        throw new Error("只有已完成或已放弃的目标可以永久删除");
      if (command.actor && command.actor !== "你")
        throw new Error("只有人可以永久删除目标");
      state.goals.splice(index, 1);
      return item;
    });
    await removeAttachmentFiles(this.root, result.attachments ?? []);
    return { deleted: result.id };
  }
  private async cleanupAttachments(command: Extract<AtteCommand, { type: "attachments.cleanup" }>) {
    const retentionDays = command.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
      throw new Error("附件保留天数必须是 1 到 3650 的整数");
    const at = command.at ? iso(command.at) : nowIso(),
      cutoff = Date.parse(at) - retentionDays * 24 * 60 * 60 * 1000,
      removed = await this.store.update(command.type, state => {
        const expired: GoalAttachment[] = [];
        for (const item of state.goals) {
          if (isReadOnlyGoal(item) || !["completed", "dropped"].includes(item.status) || !item.attachments?.length) continue;
          if (Date.parse(item.updatedAt) > cutoff) continue;
          const removedHere = item.attachments;
          expired.push(...removedHere);
          delete item.attachments;
          item.activities.push({
            id: newId("act"),
            at,
            actor: "系统",
            kind: "progress",
            text: `已清理保留期满的 ${removedHere.length} 张图片。`,
          });
          item.revision = (item.revision ?? 0) + 1;
          item.updatedAt = at;
        }
        return expired;
      });
    await removeAttachmentFiles(this.root, removed);
    const referenced = (await this.store.read()).goals.flatMap(goal =>
      (goal.attachments ?? []).map(item => item.path));
    const orphans = await cleanupOrphanAttachmentFiles(this.root, referenced, 24 * 60 * 60 * 1000, Date.parse(at));
    return { removed: removed.length, orphans };
  }
  async execute(command: AtteCommand): Promise<unknown> {
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.type !== "string"
    )
      throw new Error("无效的命令");
    assertFeatureAvailable(this.managedContext ? { ...command, managedContext: this.managedContext } : command);
    if (command.type === "snapshot") return this.store.read();
    if (command.type === "goal.attachment.remove") return this.removeGoalAttachment(command);
    if (command.type === "goal.delete") return this.deleteEndedGoal(command);
    if (command.type === "attachments.cleanup") return this.cleanupAttachments(command);
    return this.store.update(command.type, async (state) => {
      const managed = this.managedContext ?? command.managedContext;
      if (managed && state.backendBinding) {
        const binding = state.backendBinding;
        if (binding.status === "revoked" ||
          managed.installationId !== binding.installationId ||
          managed.backend !== binding.backend || managed.epoch !== binding.epoch ||
          managed.scopeGeneration !== binding.scopeGeneration)
          throw new Error("stale_backend_epoch: 当前受管身份已撤销，请重新进入现场。");
        if (managed.role !== "concierge") {
          if (!managed.goalId || ("goalId" in command && command.goalId !== managed.goalId))
            throw new Error("scene_identity_mismatch: 只能写回自己的目标。");
          const current = state.goals.find(item => item.id === managed.goalId);
          if (managed.role === "owner" &&
            managed.attemptId !== current?.agentRuntime?.attempt.attemptId)
            throw new Error("stale_backend_epoch: 负责人 attempt 已更新。");
        }
        if (command.type.startsWith("backend."))
          throw new Error("后端交接只能由桌面控制服务执行。");
      }
      const goal = (goalId: string) => {
        const found = state.goals.find((item) => item.id === id(goalId));
        if (!found) throw new Error("找不到目标");
        assertGoalWritable(found);
        const heldAllowed = new Set(["goal.message", "goal.direct", "goal.update", "goal.remind", "goal.takeover", "goal.resolve", "goal.accept", "goal.complete", "goal.drop", "goal.rework", "notification.sent"]);
        if (found.executionHold && !heldAllowed.has(command.type))
          throw new Error("goal_confirmation_required: 旧实验目标必须先由人确认是否继续。");
        if (found.executionHold && command.type === "goal.update" && command.patch.status)
          throw new Error("goal_confirmation_required: 请先确认是否继续。");
        return found;
      };
      const stamp = (item: Goal) => {
        item.revision = (item.revision ?? 0) + 1;
        item.updatedAt = nowIso();
      };
      const isOwnerSemanticWrite = (actor: string) => {
        // The concierge can record reconciliation notes with normal semantic
        // activity kinds, but those notes do not satisfy the owner's write-back
        // protocol. In particular they must not clear a settled/protocol-missing
        // patrol, otherwise each probe starts another review loop.
        if (managed?.role === "concierge" || actor === "concierge" || actor === "管家")
          return false;
        return actor !== "系统";
      };
      const activity = (
        item: Goal,
        kind: Goal["activities"][number]["kind"],
        body: string,
        actor = "你",
      ) => {
        // Only an authenticated managed owner proves that the dispatched task
        // reached the Agent. Desktop edits and older actor-labelled writes do
        // not establish delivery on their own.
        if (item.dispatch?.status === "unconfirmed" && managed?.role === "owner") {
          item.dispatch.status = "sent";
          delete item.dispatch.detail;
        }
        if (semanticActivityKinds.has(kind) && isOwnerSemanticWrite(actor) &&
          item.agentRuntime &&
          !["completed", "dropped"].includes(item.status)) {
          const now = nowIso();
          item.agentRuntime.lastSemanticWriteAt = now;
          if (item.agentRuntime.currentTurnId)
            item.agentRuntime.lastSemanticWriteTurnId = item.agentRuntime.currentTurnId;
          if (item.agentRuntime.receipt &&
            (item.agentRuntime.receipt.turnId === item.agentRuntime.currentTurnId ||
              item.agentRuntime.receipt.reminderTurnId === item.agentRuntime.currentTurnId))
            item.agentRuntime.receipt.status = "written";
          if (["settled", "protocol_missing"].includes(item.watchdog?.reason ?? ""))
            delete item.watchdog;
        }
        item.activities.push({
          id: newId("act"),
          at: nowIso(),
          actor,
          kind,
          text: text(body, "记录", 12_000),
        });
        stamp(item);
      };
      const observedPresence = (
        current: Goal["live"],
        presence: LivePresence,
        coalesce = true,
      ): LivePresence | undefined => {
        const checkedAt = iso(presence.checkedAt),
          observed = Date.parse(checkedAt);
        if (current && observed < Date.parse(current.checkedAt)) return;
        const uninterrupted = current?.state === presence.state &&
          current.reachable === presence.reachable;
        if (coalesce && uninterrupted &&
          observed - Date.parse(current.checkedAt) < 30_000) return;
        return {
          ...presence,
          checkedAt,
          stateSince: uninterrupted
            ? current.stateSince ?? current.checkedAt
            : checkedAt,
        };
      };
      const cancelAgentReceipt = (item: Goal) => {
        const receipt = item.agentRuntime?.receipt;
        if (receipt && ["waiting", "reminding", "reminded", "protocol_missing"].includes(receipt.status))
          receipt.status = "cancelled";
        if (["settled", "protocol_missing"].includes(item.watchdog?.reason ?? ""))
          delete item.watchdog;
      };
      const cancelSceneReconciliation = (item: Goal) => {
        if (!item.sceneVisit) return false;
        delete item.sceneVisit;
        return true;
      };
      const handBackExternalWait = (item: Goal) => {
        if (item.status !== "waiting") return;
        activity(item, "session",
          `已交回 Agent 核查。此前等待外部：${item.waitingFor}。${item.next}${item.remindAt ? `\n原跟进时间：${item.remindAt}` : ""}`,
          "系统");
        leaveExternalWait(item);
      };
      if ("goalId" in command && command.goalId && command.type !== "goal.scene-reply") {
        const item = goal(command.goalId);
        if (command.attentionId && command.attentionId !== attentionRequest(item)?.id)
          throw new Error("待处理事项已经变化；请重新读取当前目标，不能用旧回复处理新问题");
        if (command.sceneReplyId && command.sceneReplyId !== item.sceneReply?.id)
          throw new Error("现场回复已经更新；请重新读取用户最新原话");
        if (command.sceneReplyId) {
          if (!command.attentionId || command.attentionId !== item.sceneReply?.attentionId)
            throw new Error("现场回执必须绑定对应的待处理事项");
          if (["goal.accept", "goal.complete", "goal.drop", "goal.resolve", "goal.rework"].includes(command.type) &&
            (!("note" in command) || command.note?.trim() !== item.sceneReply.quote))
            throw new Error("处理现场回执时必须记录用户原话，不能替换成 Agent 自己的结论");
        }
      }
      switch (command.type) {
        case "backend.recover-stale": {
          const previous = state.backendBinding;
          if (!previous)
            throw new Error("stale_backend_epoch: 没有可恢复的旧后端绑定。");
          if (previous.backend !== command.binding.backend ||
            previous.installationId !== command.binding.installationId)
            throw new Error("stale_backend_epoch: 旧工作区属于另一个 Atte 后端安装。");
          if (previous.epoch === command.binding.epoch &&
            previous.scopeGeneration === command.binding.scopeGeneration &&
            previous.status === "active") return previous;
          const at = nowIso();
          const previousConcierge = Boolean(
            state.concierge.scene || state.concierge.legacyScene || state.concierge.launch,
          );
          state.history = {
            ...(state.history ?? { retiredAt: at, sourceVersion: 5 as const }),
            ...(state.history?.backendBinding ? {} : { backendBinding: structuredClone(previous) }),
            ...(state.history?.concierge || !previousConcierge
              ? {}
              : { concierge: structuredClone(state.concierge) }),
          };
          for (const item of state.goals) {
            if (["completed", "dropped"].includes(item.status)) continue;
            const staleExecution = Boolean(
              item.scene || item.agentRuntime || item.ownerLaunchRecovery ||
              item.legacyScene || item.sceneLaunch || item.herdr,
            );
            if (!staleExecution || isReadOnlyGoal(item)) continue;
            item.history = {
              retiredAt: item.history?.retiredAt ?? at,
              ...(item.history ?? {}),
              ...(item.history?.dispatch || !item.dispatch
                ? {}
                : { dispatch: structuredClone(item.dispatch) }),
              ...(item.history?.attention || !item.attention
                ? {}
                : { attention: structuredClone(item.attention) }),
            };
            item.readOnly = true;
            item.readOnlyReason = "legacy-epoch";
            delete item.dispatch;
            delete item.watchdog;
            delete item.recovery;
            delete item.sceneVisit;
            delete item.sceneReply;
            delete item.sceneLaunch;
            delete item.executionHold;
            delete item.live;
            const receipt = item.agentRuntime?.receipt;
            if (receipt && receipt.status !== "written") receipt.status = "cancelled";
            item.attention = null;
            item.remindAt = undefined;
            item.waitingFor = undefined;
            item.next = "旧 Herdr 控制代次已失效；现场已冻结为只读历史。";
            item.activities.push({
              id: newId("act"),
              at,
              actor: "系统",
              kind: "session",
              text: "旧 Herdr 控制代次已失效，目标现场已冻结为只读历史。",
            });
            stamp(item);
          }
          if (previousConcierge)
            state.concierge = { session: "atte", status: "not_ready" };
          state.backendEpoch = command.binding.epoch;
          state.backendBinding = structuredClone(command.binding);
          return state.backendBinding;
        }
        case "backend.register": {
          if (state.backendBinding) {
            if (state.backendBinding.installationId !== command.binding.installationId ||
              state.backendEpoch !== command.binding.epoch ||
              state.backendBinding.backend !== command.binding.backend)
              throw new Error("stale_backend_epoch: 工作区仍有未完成的后端交接。");
            return state.backendBinding;
          }
          if (state.backendEpoch !== command.binding.epoch &&
            (state.goals.some(item => !isReadOnlyGoal(item) && (item.scene || item.herdr || item.legacyScene)) ||
              state.concierge.scene || state.concierge.legacyScene?.reference.paneId))
            throw new Error("stale_backend_epoch: 工作区后端代次不一致。");
          state.backendEpoch = command.binding.epoch;
          state.backendBinding = structuredClone(command.binding);
          return state.backendBinding;
        }
        case "scene.prepare": {
          const intent = command.intent;
          if (!intent || !intent.requestId || !intent.bindingId || !intent.attemptId ||
            intent.backendEpoch !== state.backendEpoch || !["owner", "concierge"].includes(intent.role))
            throw new Error("stale_backend_epoch: 启动意图与当前后端不匹配。");
          if (!command.goalId) {
            if (state.concierge.launch?.status === "rejected")
              delete state.concierge.launch;
            if (state.concierge.scene || state.concierge.launch) throw new Error("launch_unconfirmed: 管家已有现场或启动意图，请核对原请求。");
            state.concierge.launch = structuredClone(intent);
          } else {
            const item = goal(command.goalId);
            if (item.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(item.status))
              throw new Error("该事项不能启动 Agent。");
            {
              if (item.sceneLaunch?.status === "rejected") delete item.sceneLaunch;
              if (item.scene || item.sceneLaunch) throw new Error("launch_unconfirmed: 该目标已有现场或启动意图，请核对原请求。");
              item.sceneLaunch = structuredClone(intent);
            }
          }
          return intent;
        }
        case "scene.launch.result": {
          const intent = command.goalId
            ? goal(command.goalId).sceneLaunch
            : state.concierge.launch;
          if (!intent || intent.requestId !== command.requestId)
            throw new Error("launch_unconfirmed: 原启动意图已经变化。");
          intent.status = command.status;
          if (command.detail) intent.detail = text(command.detail, "启动说明", 1000);
          else delete intent.detail;
          return intent;
        }
        case "scene.concierge.status": {
          if (!["ready", "error", "not_ready"].includes(command.status)) throw new Error("无效的管家状态。");
          if (command.initializedAttemptId) {
            if (state.concierge.scene?.attemptId !== command.initializedAttemptId)
              throw new Error("scene_identity_mismatch: 管家初始化对应的现场已经改变。");
            state.concierge.initializedAttemptId = command.initializedAttemptId;
          }
          state.concierge.status = command.status;
          if (command.detail) state.concierge.detail = text(command.detail, "状态说明", 1000);
          else delete state.concierge.detail;
          if (command.live) {
            const observed = observedPresence(state.concierge.live, command.live);
            if (observed) state.concierge.live = observed;
          }
          return state.concierge;
        }
        case "scene.bind": {
          const scene = validatedScene(command.scene);
          if (scene.backendEpoch !== state.backendEpoch ||
            (state.backendBinding && (state.backendBinding.installationId !== scene.installationId ||
              state.backendBinding.backend !== scene.backend ||
              state.backendBinding.status === "revoked")))
            throw new Error("stale_backend_epoch: 现场不属于当前后端代次。");
          if (!command.goalId) {
            if (state.concierge.initializedAttemptId !== scene.attemptId)
              delete state.concierge.initializedAttemptId;
            state.concierge.scene = scene;
            state.concierge.status = state.concierge.initializedAttemptId === scene.attemptId ? "ready" : "not_ready";
            delete state.concierge.legacyScene;
            delete state.concierge.live;
            return state.concierge;
          }
          const item = goal(command.goalId);
          if (["backlog", "completed", "dropped"].includes(item.status) || item.mode !== "concierge")
            throw new Error("该事项当前不能启动 Agent 现场。");
          if (sameScene(state.concierge.scene, scene) ||
            state.goals.some(other => other.id !== item.id &&
              !["completed", "dropped"].includes(other.status) && sameScene(other.scene, scene)))
            throw new Error("scene_identity_mismatch: 目标需要独立负责人现场。");
          {
            if (item.agentRuntime && item.agentRuntime.attempt.attemptId !== scene.attemptId)
              throw new Error("scene_identity_mismatch: 现场 attempt 与负责人不一致。");
            item.scene = scene;
            item.owner = item.sceneLaunch?.agent || item.agentRuntime?.attempt.agent || item.owner;
            if (item.agentRuntime) item.agentRuntime.attempt.scene = structuredClone(scene);
            delete item.legacyScene;
            delete item.herdr;
            delete item.live;
            delete item.sceneVisit;
          }
          return item;
        }
        case "scene.reanchor": {
          if (managed)
            throw new Error("现场重绑只能由桌面在稳定进程证据下执行");
          const next = validatedScene(command.scene),
            current = command.goalId ? goal(command.goalId).scene : state.concierge.scene;
          if (!current || current.bindingId !== command.bindingId ||
            current.attemptId !== command.attemptId)
            throw new Error("scene_identity_mismatch: 原现场已经变化，不能重绑。");
          if (!current.ownership || !next.ownership ||
            !isDeepStrictEqual(current.ownership, next.ownership) ||
            next.bindingId !== current.bindingId || next.attemptId !== current.attemptId ||
            next.installationId !== current.installationId ||
            next.backendEpoch !== current.backendEpoch ||
            next.backend !== current.backend ||
            JSON.stringify(next.locator) !== JSON.stringify(current.locator) ||
            (next.process &&
              (next.process.pid !== next.ownership.launcher.pid ||
                next.process.bornAt !== next.ownership.launcher.bornAt)))
            throw new Error("scene_identity_mismatch: 重绑证据没有保留原 Pane 与负责人身份。");
          if (command.goalId) {
            const item = goal(command.goalId);
            item.scene = next;
            if (item.agentRuntime) item.agentRuntime.attempt.scene = structuredClone(next);
            activity(item, "session", "Herdr 运行时已变化，但 Pane、进程组和负责人进程身份保持稳定；已安全重绑原现场。", "系统");
          } else {
            state.concierge.scene = next;
            if (state.concierge.initializedAttemptId === next.attemptId)
              state.concierge.status = "ready";
          }
          return next;
        }
        case "scene.legacy.confirm": {
          if (managed)
            throw new Error("旧现场只能由人确认后退休");
          const reason = text(command.reason, "旧现场确认原因", 4_000),
            current = command.goalId ? goal(command.goalId).scene : state.concierge.scene;
          if (!current || current.bindingId !== command.bindingId ||
            current.attemptId !== command.attemptId)
            throw new Error("scene_identity_mismatch: 旧现场已经变化，不能重复处理。");
          if (current.ownership)
            throw new Error("该现场已有稳定进程证据；请使用安全重绑，不应按旧现场退休。");
          const item = command.goalId
            ? state.goals.find(candidate => candidate.id === command.goalId)
            : undefined;
          const now = Date.now(),
            recent = [
              item?.agentRuntime?.lastSemanticWriteAt,
              item?.agentRuntime?.lastEventAt,
              item?.live?.state === "working" ? item.live.checkedAt : undefined,
            ].map(value => Date.parse(value ?? "")).filter(value => Number.isFinite(value));
          if (recent.some(value => now - value <= 2 * 60_000))
            throw new Error("旧现场仍有新鲜的 Hook 或负责人写回；请先核对原负责人，不能判定其已退出。");
          if (item) {
            item.sceneHistory = [...(item.sceneHistory ?? []), structuredClone(current)].slice(-20);
            if (item.agentRuntime) {
              const retired: NonNullable<Goal["attemptHistory"]>[number] = {
                attemptId: item.agentRuntime.attempt.attemptId,
                agent: item.agentRuntime.attempt.agent,
                scene: structuredClone(current),
                retiredAt: nowIso(),
                reason: "superseded",
              };
              item.attemptHistory = [...(item.attemptHistory ?? []), retired].slice(-20);
            }
            delete item.scene;
            delete item.sceneLaunch;
            delete item.live;
            delete item.sceneVisit;
            delete item.sceneReply;
            delete item.agentRuntime;
            delete item.ownerLaunchRecovery;
            delete item.watchdog;
            delete item.recovery;
            activity(item, "session",
              `你确认旧 Herdr 现场已退出；已退休原 attempt，未关闭或杀死旧 Pane。原因：${reason}`,
              "你");
          } else {
            delete state.concierge.scene;
            delete state.concierge.live;
            delete state.concierge.launch;
            delete state.concierge.initializedAttemptId;
            state.concierge.status = "not_ready";
            delete state.concierge.detail;
          }
          return true;
        }
        case "scene.retire": {
          // Only the trusted transport calls this after a fresh, identity-bound
          // exited observation. It retires the binding, not the business goal.
          const item = goal(command.goalId);
          if (!item.scene || item.scene.bindingId !== command.bindingId || item.scene.attemptId !== command.attemptId)
            throw new Error("scene_identity_mismatch: 原现场已经变化，不能恢复。");
          if (command.expectedActivity &&
            (item.agentRuntime?.lastEventAt !== command.expectedActivity.lastEventAt ||
              item.agentRuntime?.lastSemanticWriteAt !== command.expectedActivity.lastSemanticWriteAt))
            throw new Error("scene_identity_mismatch: 退出核对期间收到新的 Hook 或负责人写回，未退休原现场。");
          item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          if (item.agentRuntime) {
            const retired: NonNullable<Goal["attemptHistory"]>[number] = {
              attemptId: item.agentRuntime.attempt.attemptId,
              agent: item.agentRuntime.attempt.agent,
              scene: structuredClone(item.scene), retiredAt: nowIso(),
              reason: "superseded",
            };
            item.attemptHistory = [...(item.attemptHistory ?? []), retired].slice(-20);
          }
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          delete item.agentRuntime;
          delete item.sceneVisit;
          return item;
        }
        case "scene.release": {
          if (!command.goalId) {
            if (state.concierge.scene?.bindingId !== command.bindingId) return false;
            delete state.concierge.scene;
            delete state.concierge.launch;
            delete state.concierge.live;
            delete state.concierge.initializedAttemptId;
            state.concierge.status = "not_ready";
            return true;
          }
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已结束的目标可以释放现场。");
          if (item.scene?.bindingId !== command.bindingId) return false;
          item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          return true;
        }
        case "scene.legacy.clear": {
          const reason = text(command.reason, "旧现场清理原因", 1000);
          if (!command.goalId) {
            if (!state.concierge.legacyScene) return false;
            delete state.concierge.legacyScene;
            state.concierge.status = "not_ready";
            delete state.concierge.live;
            return true;
          }
          const item = goal(command.goalId);
          if (item.scene || !item.legacyScene) return false;
          delete item.legacyScene;
          delete item.live;
          activity(item, "session", `已忽略无法重新核实的旧 Herdr 现场：${reason}`, "系统");
          return true;
        }
        case "scene.observe": {
          for (const observation of command.scenes) {
            if (!["working", "idle", "done", "blocked", "unknown"].includes(observation.presence.state))
              throw new Error("无效的现场观测。");
            const item = state.goals.find(candidate =>
              candidate.scene?.bindingId === observation.bindingId &&
              !["completed", "dropped"].includes(candidate.status));
            if (item && !goalCanExecute(item)) continue;
            const current = item?.live ?? (state.concierge.scene?.bindingId === observation.bindingId
              ? state.concierge.live : undefined);
            const presence = observedPresence(current, observation.presence);
            if (!presence) continue;
            if (item) {
              item.live = presence;
              observeSceneWork(item, presence);
            } else if (state.concierge.scene?.bindingId === observation.bindingId) {
              state.concierge.live = presence;
              if (!presence.reachable) {
                state.concierge.status = "not_ready";
                state.concierge.detail = "管家现场已关闭或不可达，请恢复管家。";
              } else if (state.concierge.initializedAttemptId === state.concierge.scene.attemptId) {
                state.concierge.status = "ready";
                delete state.concierge.detail;
              }
            }
          }
          return true;
        }
        case "workspace.rename":
          state.name = text(command.name, "工作区名称", 80);
          return state.name;
        case "workspace.recovery.dismiss":
          delete state.recovery;
          return true;
        case "agents.configure": {
          const startup = (value: unknown) => {
            if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x1f\x7f;&|<>`$]/.test(value)) throw new Error("无效的 Agent 启动命令：请使用单行 CLI 命令与参数，不支持 shell 表达式");
            return value.trim();
          };
          state.agents = {
            concierge: startup(command.preferences.concierge),
            ...(command.preferences.owner?.trim() ? { owner: startup(command.preferences.owner) } : {}),
          };
          return state.agents;
        }
        case "project.add": {
          const name = text(command.name, "项目名称", 100);
          if (state.projects.some((p) => p.name === name))
            throw new Error("已有同名项目");
          const project = {
            id: newId("project"),
            name,
            policy: defaultProjectPolicy(),
            ...(command.path
              ? { path: text(command.path, "项目路径", 1000) }
              : {}),
            createdAt: nowIso(),
          };
          state.projects.push(project);
          return project;
        }
        case "project.remove": {
          if (command.projectId === "personal")
            throw new Error("个人事项不能删除");
          if (state.goals.some((g) => g.projectId === command.projectId))
            throw new Error("项目仍有目标，请先完成或放弃这些目标");
          state.projects = state.projects.filter(
            (p) => p.id !== id(command.projectId),
          );
          return true;
        }
        case "project.policy.set": {
          if (command.actor !== "你")
            throw new Error("上线策略只能由人在 Atte 设置中修改");
          const project = state.projects.find(item => item.id === id(command.projectId));
          if (!project) throw new Error("找不到项目");
          if (!isShipPolicy(command.policy?.shipPolicy))
            throw new Error("无效的上线策略");
          if (!Array.isArray(command.policy.approvers) || command.policy.approvers.length > 20)
            throw new Error("审批人列表无效");
          const approvers = [...new Set(command.policy.approvers.map(value =>
            text(value, "审批人", 120)))];
          project.policy = {
            shipPolicy: command.policy.shipPolicy,
            approvers,
            revision: (project.policy?.revision ?? 0) + 1,
            updatedAt: nowIso(),
          };
          return project;
        }
        case "goal.create": {
          const input = command.input;
          if (!input || input.mode !== "concierge")
            throw new Error("无效的目标；人工任务只能从已有目标接管");
          const kind = input.kind === undefined
            ? "delivery" as const
            : writableGoalKind(input.kind);
          const project = state.projects.find(
            (p) => p.id === id(input.projectId),
          );
          if (!project) throw new Error("请选择有效项目");
          if (input.workflowId)
            throw new Error("工序已移除；请在目标说明中直接写清工作要求");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"),
            projectId: project.id,
            title: text(input.title, "目标", 160),
            description: text(
              input.description || "由管家进一步梳理目标与完成标准。",
              "目标说明",
            ),
            mode: "concierge",
            status: "active",
            kind,
            revision: 1,
            steps: [],
            next: input.next?.trim() || "管家正在理解目标并安排下一步。",
            owner: "待分配负责人",
            ...(input.remindAt ? { remindAt: iso(input.remindAt) } : {}),
            attention: null,
            dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "pending" as const, at },
            activities: [
              {
                id: newId("act"),
                at,
                actor: "你",
                kind: "created",
                text: "已交给管家统筹。",
              },
            ],
            createdAt: at,
            updatedAt: at,
          };
          if (input.waitingFor !== undefined) {
            item.waitingFor = externalWaitTarget(input.waitingFor, state, item);
            item.status = "waiting";
          }
          state.goals.push(item);
          return item;
        }
        case "goal.intake": {
          const request = text(command.text, "事情说明", 20_000);
          const arrangement = intakeArrangement(command.handling ?? "concierge");
          const kind = command.kind === undefined
            ? "delivery" as const
            : writableGoalKind(command.kind);
          const goalAttachments = await validateGoalAttachments(this.root, command.attachments);
          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            kind, revision: 1,
            ...arrangement,
            steps: [],
            attention: null,
            ...(arrangement.status !== "backlog"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "pending" as const, at } }
              : {}),
            ...(command.remindAt ? { remindAt: iso(command.remindAt) } : {}),
            ...(goalAttachments.length ? { attachments: goalAttachments } : {}),
            activities: [{ id: newId("act"), at, actor: "你", kind: "created", text: request }],
            createdAt: at, updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "goal.direct": {
          const backendLabel = state.backendBinding?.backend === "orca" ? "Orca" : "Herdr";
          const request = text(command.text, "终端消息", 20_000);
          const incomingAttachments = await validateGoalAttachments(this.root, command.attachments);
          if (command.goalId) {
            const item = goal(command.goalId);
            if (command.kind !== undefined)
              throw new Error("已有目标请使用 goal kind 明确切换类型");
            if (command.handling)
              throw new Error("终端补充消息不能改变执行安排，请使用明确的开始命令");
            if (["completed", "dropped"].includes(item.status))
              throw new Error("目标已结束，不能再追加终端消息");
            if (item.mode === "concierge") handBackExternalWait(item);
            delete item.sceneReply;
            cancelAgentReceipt(item);
            const combined = await validateGoalAttachments(this.root, [
              ...(item.attachments ?? []),
              ...incomingAttachments,
            ]);
            if (combined.length) item.attachments = combined;
            const at = nowIso();
            item.activities.push({
              id: newId("act"),
              at,
              actor: `你 · ${backendLabel} 直聊`,
              kind: "message",
              text: attachmentActivity(request, incomingAttachments),
              ...(incomingAttachments.length
                ? { attachmentIds: incomingAttachments.map(attachment => attachment.id) }
                : {}),
            });
            item.revision = (item.revision ?? 0) + 1;
            item.updatedAt = at;
            return item;
          }

          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const arrangement = intakeArrangement(command.handling ?? "concierge");
          const kind = command.kind === undefined
            ? "delivery" as const
            : writableGoalKind(command.kind);
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            kind, revision: 1,
            ...arrangement,
            steps: [],
            next: arrangement.status !== "backlog"
              ? `管家正在理解 ${backendLabel} 终端中的原文并整理目标。` : arrangement.next,
            attention: null,
            // The concierge already received this message in its terminal turn.
            // Mark it as delivered so desktop dispatch does not replay the same text.
            ...(arrangement.status !== "backlog"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "sent" as const, at, detail: `已从 ${backendLabel} 终端直接送达管家` } }
              : {}),
            ...(incomingAttachments.length ? { attachments: incomingAttachments } : {}),
            activities: [{ id: newId("act"), at, actor: `你 · ${backendLabel} 直聊`, kind: "created", text: request }],
            createdAt: at, updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "scene.visit": {
          const item = goal(command.goalId), request = attentionRequest(item);
          if (!request || item.mode !== "concierge" ||
            (!item.scene && (!item.herdr?.agent || item.herdr.transport === "pane")) ||
            pendingSceneReply(item)) return item;
          if (item.sceneVisit?.attentionId === request.id &&
            (item.sceneVisit.status === "pending" ||
              item.sceneVisit.status === "checking" &&
              (!command.retry || Date.now() - Date.parse(item.sceneVisit.attemptedAt || item.sceneVisit.at) < 150_000))) return item;
          item.sceneVisit = {
            id: newId("visit"), attentionId: request.id, at: nowIso(),
            worked: item.live?.state === "working",
            status: command.retry ? "pending" : "watching",
          };
          return item;
        }
        case "scene.cancel": {
          const item = goal(command.goalId);
          if (command.reason !== "user-input")
            throw new Error("无效的现场核对取消原因");
          if (!cancelSceneReconciliation(item)) return false;
          stamp(item);
          return true;
        }
        case "scene.check": {
          const item = goal(command.goalId), visit = item.sceneVisit;
          if (!visit || visit.id !== command.visitId ||
            visit.attentionId !== attentionRequest(item)?.id || pendingSceneReply(item) ||
            item.mode !== "concierge" ||
            (command.status === "checking" ? visit.status !== "pending" : visit.status !== "checking")) return false;
          if (!["checking", "checked", "failed"].includes(command.status)) throw new Error("无效的现场核对状态");
          visit.status = command.status;
          if (command.status === "checking") visit.attemptedAt = nowIso();
          if (command.detail) visit.detail = text(command.detail, "现场核对说明", 1000);
          return true;
        }
        case "goal.scene-reply": {
          const item = goal(command.goalId);
          ongoing(item, true);
          if (item.mode !== "concierge")
            throw new Error("目标已由你接管，现场回执不能重新派发给管家");
          const actor = text(command.actor, "现场负责人", 120);
          if (actor !== item.agentRuntime?.attempt.agent && actor !== item.herdr?.agent &&
            actor !== "concierge" && actor !== state.concierge.agent)
            throw new Error("只有本目标登记的负责人或管家可以提交现场回执");
          const quote = text(command.quote, "用户在现场的原话", 4000);
          const summary = substantiveAgentText(command.summary, "现场处理结果", 4000);
          if (!command.attentionId || command.attentionId !== attentionRequest(item)?.id)
            throw new Error("待处理事项已经变化；请重新读取当前目标，不能用旧回复处理新问题");
          const previous = item.sceneReply;
          if (previous?.attentionId === command.attentionId &&
            previous.quote === quote && previous.summary === summary && previous.actor === actor)
            return item;
          const at = nowIso();
          item.sceneReply = {
            id: newId("reply"), attentionId: command.attentionId, quote, summary, actor, at,
          };
          activity(item, "message", quote, `你 · ${item.scene?.backend === "orca" ? "Orca" : "Herdr"} 现场`);
          activity(item, "message", summary, actor);
          item.dispatch = {
            id: newId("handoff"), kind: "scene_reply", status: "pending", at,
            note: "用户已在负责人现场答复。请核对原话并关闭对应事项，不要要求用户重复处理。",
          };
          return item;
        }
        case "goal.message": {
          const item = goal(command.goalId);
          if (["completed", "dropped"].includes(item.status))
            throw new Error("目标已结束，不能再发送消息");
          if (item.status === "backlog" && command.routeToConcierge)
            throw new Error("这件事尚未开始，请先明确交给管家");
          const message = text(command.text, "消息", 12_000);
          const actor = command.actor?.trim() ? text(command.actor, "操作者", 120)
            : managed?.role === "owner" ? item.agentRuntime?.attempt.agent || item.owner : "你";
          const ownerReviewReply = item.status === "review" && !command.routeToConcierge &&
            (managed?.role === "owner" || actor === item.agentRuntime?.attempt.agent || actor === item.herdr?.agent);
          cancelAgentReceipt(item);
          cancelSceneReconciliation(item);
          const incomingAttachments = await validateGoalAttachments(this.root, command.attachments);
          const combined = await validateGoalAttachments(this.root, [
            ...(item.attachments ?? []),
            ...incomingAttachments,
          ]);
          if (combined.length) item.attachments = combined;
          if (item.mode === "concierge" || command.routeToConcierge) handBackExternalWait(item);
          if (item.attention?.source === "dispatch") item.attention = null;
          if (item.status !== "backlog" &&
            (item.mode === "concierge" || command.routeToConcierge) && (
            item.attention?.kind === "follow_up" ||
            hasDueReminder(item)
          )) {
            item.attention = null;
            item.remindAt = undefined;
          }
          if (command.routeToConcierge && item.mode !== "concierge") {
            item.mode = "concierge";
            item.owner = item.herdr?.agent || "待分配负责人";
          }
          if (!ownerReviewReply && item.mode === "concierge" && !item.executionHold && item.status !== "backlog") {
            item.dispatch = {
              id: newId("handoff"),
              kind: "feedback",
              note: message,
              status: "pending",
              at: nowIso(),
            };
          }
          const at = nowIso();
          if (actor.startsWith("你")) delete item.sceneReply;
          item.activities.push({
            id: newId("act"),
            at,
            actor,
            kind: "message",
            text: message,
            ...(incomingAttachments.length
              ? { attachmentIds: incomingAttachments.map(attachment => attachment.id) }
              : {}),
          });
          item.revision = (item.revision ?? 0) + 1;
          item.updatedAt = at;
          return item;
        }
        case "goal.owner-launch.recovery": {
          const item = goal(command.goalId),
            value = command.recovery;
          ongoing(item, true);
          if (
            typeof value.id !== "string" ||
            !/^[A-Za-z0-9_-]{8,160}$/.test(value.id) ||
            typeof value.attemptId !== "string" ||
            !/^[A-Za-z0-9_-]{8,160}$/.test(value.attemptId) ||
            typeof value.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(value.session) ||
            !["pending", "attached", "superseded"].includes(value.status) ||
            !Number.isFinite(Date.parse(value.createdAt))
          )
            throw new Error("负责人恢复信息无效");
          if (value.tabId !== undefined && !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(value.tabId))
            throw new Error("负责人恢复信息中的 Tab ID 无效");
          if (value.paneId !== undefined && !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(value.paneId))
            throw new Error("负责人恢复信息中的 Pane ID 无效");
          item.ownerLaunchRecovery = {
            ...structuredClone(value),
            createdAt: iso(value.createdAt),
            ...(value.attachedAt ? { attachedAt: iso(value.attachedAt) } : {}),
            ...(value.detail ? { detail: text(value.detail, "恢复说明", 2_000) } : {}),
          };
          activity(
            item,
            "session",
            value.status === "attached"
              ? `已通过恢复 ID ${value.id} 绑定现成负责人现场。`
              : `负责人启动恢复 ID：${value.id}。环境确认失败时可使用 owner attach 绑定已核实的现场。`,
            "系统",
          );
          return item;
        }
        case "goal.takeover": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.mode === "manual" && item.status !== "backlog") return item;
          if (item.executionHold)
            throw new Error("goal_confirmation_required: 请先用迁移决定批准或结束这个旧目标");
          delete item.executionHold;
          const fromBacklog = item.status === "backlog";
          if (fromBacklog && hasDueReminder(item)) {
            item.remindAt = undefined;
            if (item.attention?.kind === "follow_up") item.attention = null;
          }
          item.mode = "manual";
          item.status = "active";
          item.owner = "你";
          item.next = "由你安排；做完即可标记完成。";
          item.waitingFor = undefined;
          if (!fromBacklog) item.remindAt = undefined;
          if (item.attention?.source === "dispatch") item.attention = null;
          delete item.dispatch;
          delete item.sceneVisit;
          delete item.sceneReply;
          delete item.watchdog;
          delete item.live;
          cancelAgentReceipt(item);
          activity(item, "session", "你已接管这个目标，不再向管家发送后续更新。", "你");
          return item;
        }
        case "goal.delegate": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.mode === "concierge" && item.status !== "backlog") return item;
          if (item.attention && item.attention.kind !== "follow_up" && item.attention.source !== "dispatch")
            throw new Error("请先处理当前待决定或介入事项，再交给管家");
          item.mode = "concierge";
          item.status = "active";
          item.owner = "待分配负责人";
          item.next = "管家正在接手目标并安排下一步。";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.attention = null;
          item.dispatch = { id: newId("handoff"), kind: "feedback", status: "pending", at: nowIso() };
          delete item.watchdog;
          activity(item, "session", "已重新交给管家统筹。", "你");
          return item;
        }
        case "goal.restore": {
          const item = goal(command.goalId);
          if (item.status !== "dropped" || item.herdr || item.scene || item.legacyScene)
            throw new Error("只有已移出且没有执行现场的个人事项可以恢复到待办池");
          Object.assign(item, intakeArrangement("later"));
          item.attention = null;
          delete item.remindAt;
          delete item.waitingFor;
          delete item.dispatch;
          delete item.watchdog;
          delete item.sceneVisit;
          delete item.sceneReply;
          activity(item, "progress", "已恢复到待办池，尚未开始执行。");
          return item;
        }
        case "goal.update": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          const previousTitle = item.title;
          const previous = structuredClone({
            title: item.title,
            description: item.description,
            next: item.next,
            owner: item.owner,
            waitingFor: item.waitingFor,
            remindAt: item.remindAt,
            status: item.status,
          });
          const actor = command.actor || (managed?.role === "concierge" ? "concierge"
            : managed?.role === "owner" ? item.agentRuntime?.attempt.agent || item.owner : "你");
          for (const field of [
            "title",
            "description",
            "next",
            "owner",
          ] as const)
            if (command.patch[field] !== undefined)
              item[field] = text(
                command.patch[field],
                field,
                field === "description" ? 20_000 : 500,
              );
          if (command.patch.stageId !== undefined) {
            throw new Error("工序已移除；请直接更新目标下一步");
          }
          if (command.patch.waitingFor !== undefined || command.patch.status === "waiting") {
            item.waitingFor = externalWaitTarget(command.patch.waitingFor ?? item.waitingFor, state, item);
          }
          if (command.patch.remindAt !== undefined)
            item.remindAt =
              command.patch.remindAt === null
                ? undefined
                : iso(command.patch.remindAt);
          if (command.patch.remindAt !== undefined && item.attention?.kind === "follow_up")
            item.attention = null;
          if (command.patch.status !== undefined) {
            ongoing(item);
            if (!["active", "waiting"].includes(command.patch.status))
              throw new Error("无效的目标状态");
            item.status = command.patch.status;
            if (item.status === "active") {
              item.waitingFor = undefined;
              item.remindAt = undefined;
            }
          }
          const changed = [
            item.title !== previous.title ? "标题" : undefined,
            item.description !== previous.description ? "原始说明" : undefined,
            item.next !== previous.next ? "下一步" : undefined,
            item.owner !== previous.owner ? "负责人" : undefined,
            item.waitingFor !== previous.waitingFor ? "外部等待" : undefined,
            item.remindAt !== previous.remindAt ? "跟进时间" : undefined,
            item.status !== previous.status ? "状态" : undefined,
          ].filter((value): value is string => Boolean(value));
          if (!changed.length) return item;
          activity(item, "metadata", item.title !== previousTitle
            ? `范围标题已更新：“${previousTitle}” → “${item.title}”；变更字段：${changed.join("、")}。`
            : `已更新元数据：${changed.join("、")}。`, actor);
          return item;
        }
        case "goal.kind.set": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.kind === "release" || item.release)
            throw new Error("发布目标类型不能通过 goal kind 修改");
          const kind = writableGoalKind(command.kind);
          if ((item.kind ?? "delivery") === kind) return item;
          item.kind = kind;
          activity(
            item,
            "progress",
            kind === "discovery"
              ? "目标已标记为探索：先收集证据和候选方向，不据此自动决定产品方向。"
              : "目标已标记为交付：按目标说明产出可验收的成果。",
            command.actor || "管家",
          );
          return item;
        }
        case "goal.dispatch": {
          const item = goal(command.goalId);
          if (command.requestId && item.dispatch?.id !== command.requestId) return item;
          ongoing(item, true);
          if (item.mode !== "concierge")
            throw new Error("这个目标已由你接管");
          if (!["pending", "sent", "unconfirmed", "failed"].includes(command.status)) throw new Error("无效的派送状态");
          const at = nowIso(), detail = command.detail ? text(command.detail, "派送说明", 2000) : undefined;
          item.mode = "concierge";
          item.dispatch = { ...item.dispatch,
            id: command.status === "pending" && !command.requestId ? newId("handoff") : item.dispatch?.id,
            status: command.status, at, detail,
            ...(command.kind ? { kind: command.kind } : {}),
            ...(command.note !== undefined
              ? { note: text(command.note, "派发说明", 12_000) }
              : {}),
          };
          if (command.status !== "failed" && item.attention?.source === "dispatch")
            item.attention = null;
          if (command.status === "failed" && !attentionRequest(item)) item.attention = {
            id: newId("attention"),
            kind: "intervention", source: "dispatch", summary: detail || "目标尚未送达管家，请重试。", since: at,
          };
          if (["sent", "unconfirmed"].includes(command.status) && item.attention?.source === "dispatch")
            item.attention = null;
          activity(item, "session",
            command.status === "sent" ? "目标已送达管家。"
              : command.status === "unconfirmed" ? `目标已提交，送达状态待现场确认。${detail ?? ""}`
                : command.status === "failed" ? `联系管家失败：${detail}`
                  : "正在联系管家。",
            "系统");
          return item;
        }
        case "goal.resume": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以恢复推进");
          if (!["concierge", "manual"].includes(command.mode)) throw new Error("请选择由谁继续推进");
          if (command.mode === "manual" && item.mode !== "manual")
            throw new Error("只有原本由你接管的目标才能恢复为人工推进");
          const note = text(command.note, "最新结果与下一步", 2000);
          item.status = "active";
          item.mode = command.mode;
          item.next = note;
          item.owner = command.mode === "manual" ? "你" : item.herdr?.agent || "待分配负责人";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.attention = null;
          delete item.watchdog;
          delete item.live;
          if (command.mode === "concierge") item.dispatch = {
            id: newId("handoff"), kind: "resume", note, status: "pending", at: nowIso(),
          };
          else delete item.dispatch;
          activity(item, "resolved", `等待已结束。${note}`, "你");
          return item;
        }
        case "goal.restart": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已完成或已放弃的目标可以重启");
          if (item.mode !== "concierge")
            throw new Error("个人事项请恢复到待办池，不需要重启 Agent");
          const note = text(command.note, "交给管家的重启说明", 12_000);
          item.status = "active";
          item.attention = null;
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.owner = item.ownerResume?.owner || item.herdr?.agent || "待分配负责人";
          item.next = item.ownerResume?.agentSession
            ? "正在恢复原负责人会话，并把你的消息交给管家。"
            : "正在重新启动负责人，并把你的消息交给管家。";
          item.dispatch = {
            id: newId("handoff"),
            kind: "restart",
            note,
            status: "pending",
            at: nowIso(),
          };
          if (item.delivery) item.deliveryHistory = [...(item.deliveryHistory ?? []), structuredClone(item.delivery)];
          delete item.delivery;
          delete item.risk;
          delete item.reviewRounds;
          delete item.reviewLimit;
          delete item.herdr;
          if (item.scene) item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          delete item.sceneVisit;
          delete item.sceneReply;
          delete item.watchdog;
          delete item.recovery;
          delete item.agentRuntime;
          delete item.ownerLaunchRecovery;
          activity(item, "message", note, "你");
          activity(item, "session", item.next, "系统");
          return item;
        }
        case "goal.followup": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以请求跟进");
          const note = command.note?.trim() ? text(command.note, "跟进说明", 2000) : "请核查等待事项的最新进展，并写回跟进结果。";
          handBackExternalWait(item);
          if (item.mode !== "concierge") item.owner = item.herdr?.agent || "待分配负责人";
          item.mode = "concierge";
          item.dispatch = { id: newId("handoff"), kind: "follow_up", note, status: "pending", at: nowIso() };
          activity(item, "session", `已请求管家跟进：${note}`, "你");
          return item;
        }
        case "goal.progress": {
          const item = goal(command.goalId);
          ongoing(item);
          const actor = command.actor || "管家",
            summary = actor.startsWith("你")
              ? text(command.summary, "实际结果", 12_000)
              : substantiveAgentText(command.summary, "实际结果", 12_000);
          if (command.title) item.title = text(command.title, "范围标题", 500);
          item.status = "active";
          item.remindAt = undefined;
          item.waitingFor = undefined;
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.next) item.next = text(command.next, "下一步", 2000);
          if (command.stageId) {
            throw new Error("工序已移除；请直接写清当前实际结果和下一步");
          }
          if (actor === "你" && item.mode === "concierge")
            item.dispatch = {
              id: newId("handoff"), kind: "feedback", note: summary,
              status: "pending", at: nowIso(),
            };
          activity(item, "progress", summary, actor);
          delete item.recovery;
          return item;
        }
        case "goal.wait": {
          const item = goal(command.goalId);
          ongoing(item);
          const target = externalWaitTarget(command.owner, state, item);
          item.status = "waiting";
          if (item.attention?.kind === "follow_up") item.attention = null;
          item.next = text(command.reason, "等待原因", 2000);
          item.waitingFor = target;
          item.remindAt = command.remindAt ? iso(command.remindAt) : undefined;
          activity(item, "waiting", `等待外部：${target}。${command.reason}${item.remindAt ? `\n跟进时间：${item.remindAt}` : ""}`, command.actor || "管家");
          delete item.recovery;
          delete item.watchdog;
          return item;
        }
        case "goal.decide": {
          const item = goal(command.goalId);
          ongoing(item);
          const question = text(command.question, "问题", 2000);
          const key = normalizeDecisionKey(command.key ? text(command.key, "决定键", 300) : question);
          const known = latestDecision(state, item.projectId, key);
          item.status = "active";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          if (known) {
            if (item.attention?.source === "governance") item.attention = null;
            item.next = command.next
              ? text(command.next, "下一步", 2000)
              : `沿用你此前${outcomeLabel(known.outcome)}的决定：${known.quote}`;
            activity(item, "decision", `决定账本命中：此前已${outcomeLabel(known.outcome)}「${known.quote}」，不再重复询问。`, known.source);
            return item;
          }
          const riskCategory = riskCategoryForText(question);
          item.attention = {
            id: newId("attention"),
            kind: "decision",
            summary: riskCategory ? riskSummary(riskCategory, question) : question,
            since: nowIso(),
            ...(riskCategory ? { source: "governance" as const } : {}),
            decisionKey: riskCategory ? `risk:${riskCategory}:${key}` : key,
          };
          if (command.next) item.next = text(command.next, "下一步", 2000);
          activity(item, "decision", item.attention.summary, command.actor || "管家");
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.risk": {
          const item = goal(command.goalId);
          ongoing(item);
          if (!isHighRiskCategory(command.category))
            throw new Error("无效的高风险动作类型");
          const summary = text(command.summary, "高风险动作", 2000);
          const actionKey = `risk:${command.category}:${normalizeDecisionKey(
            command.actionKey ? text(command.actionKey, "动作键", 300) : summary,
          )}`;
          const at = nowIso(), known = latestDecision(state, item.projectId, actionKey);
          item.risk = { category: command.category, summary, actionKey, at };
          item.status = "active";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          if (known) {
            item.attention = null;
            item.next = `沿用你此前${outcomeLabel(known.outcome)}的决定：${known.quote}`;
            activity(item, "decision", `决定账本命中高风险动作「${summary}」：${outcomeLabel(known.outcome)}。`, known.source);
            return item;
          }
          item.attention = {
            id: newId("attention"),
            kind: "decision",
            summary: riskSummary(command.category, summary),
            since: at,
            source: "governance",
            decisionKey: actionKey,
          };
          item.next = `执行高风险动作前等待你确认：${summary}`;
          activity(item, "decision", item.attention.summary, command.actor || "管家");
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.ship": {
          const item = goal(command.goalId);
          if (item.status === "dropped")
            throw new Error("已放弃的目标不能执行上线动作");
          if (item.status === "backlog")
            throw new Error("尚未开始的目标不能执行上线动作");
          if (!["merge", "deploy"].includes(command.operation))
            throw new Error("无效的上线动作");
          if (typeof command.checksPassed !== "boolean")
            throw new Error("上线前必须提供真实检查结果");
          leaveExternalWait(item);
          const project = state.projects.find(value => value.id === item.projectId);
          if (!project) throw new Error("找不到目标所属项目");
          const policy = projectPolicy(state, item.projectId);
          const actionKey = `ship:${item.projectId}:${command.operation}`;
          if (!command.checksPassed) {
            item.next = `上线检查未通过，先修复 ${command.operation === "merge" ? "合并" : "部署"}前的问题。`;
            activity(item, "ship", `${command.operation} 检查未通过，未执行上线动作。`, command.actor || "管家");
            return { allowed: false, requiresHuman: false, reason: "checks_failed", policy };
          }
          const known = latestDecision(state, item.projectId, actionKey);
          if (known?.outcome === "rejected") {
            item.attention = null;
            item.next = `你此前已拒绝该上线动作：${known.quote}`;
            activity(item, "ship", item.next, known.source);
            return { allowed: false, requiresHuman: false, reason: "rejected", policy, decision: known };
          }
          const requiresHuman = !known && (
            policy.shipPolicy === "external-approval" ||
            (policy.shipPolicy === "auto-merge-manual-deploy" && command.operation === "deploy"));
          if (requiresHuman) {
            item.attention = {
              id: newId("attention"),
              kind: "decision",
              summary: [
                `上线策略 ${policy.shipPolicy} 要求你确认${command.operation === "merge" ? "合并" : "部署"}。`,
                policy.approvers.length ? `审批人：${policy.approvers.join("、")}。` : "",
              ].join(""),
              since: nowIso(),
              source: "governance",
              decisionKey: actionKey,
            };
            item.next = `等待你按上线策略确认${command.operation}。`;
            activity(item, "ship", item.attention.summary, command.actor || "管家");
            return { allowed: false, requiresHuman: true, reason: policy.shipPolicy, policy, decisionKey: actionKey };
          }
          item.attention = null;
          item.next = `${command.operation} 已通过项目上线策略，可继续执行并核实结果。`;
          activity(item, "ship", `${command.operation} 已获上线策略放行。`, command.actor || "管家");
          return {
            allowed: true,
            requiresHuman: false,
            reason: known ? "ledger" : policy.shipPolicy,
            policy,
            ...(known ? { decision: known } : {}),
          };
        }
        case "goal.review": {
          const item = goal(command.goalId),
            delivery = command.delivery;
          ongoing(item, true);
          if (!delivery) throw new Error("提交验收至少需要一项真实检查记录");
          const checks = deliveryChecks(delivery.checks);
          const at = nowIso(),
            candidate = deliveryCandidate(delivery.candidate),
            evidence = evidenceItems(delivery.evidence, at, checks);
          leaveExternalWait(item);
          delete item.waitingFor;
          delete item.remindAt;
          const reviewRounds = item.reviewRounds ?? 0,
            reviewLimit = item.reviewLimit ?? 3;
          if (reviewRounds >= reviewLimit) {
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: `审查已达到 ${reviewLimit} 轮上限，需要你决定是否增加一轮。`,
              since: at,
              source: "governance",
              decisionKey: `review:${item.id}:round-${reviewLimit + 1}`,
            };
            item.next = "审查轮次达到上限，新的提交已被拦截并升级。";
            activity(item, "decision", item.attention.summary, "系统");
            return item;
          }
          if (command.title) item.title = text(command.title, "范围标题", 500);
          if (item.delivery) item.deliveryHistory = [...(item.deliveryHistory ?? []), structuredClone(item.delivery)];
          item.delivery = {
            id: newId("delivery"),
            summary: substantiveAgentText(delivery.summary, "成果摘要", 12_000),
            ...(delivery.location
              ? { location: text(delivery.location, "交付位置", 2000) }
              : {}),
            ...(delivery.url ? { url: text(delivery.url, "链接", 2000) } : {}),
            ...(candidate ? { candidate } : {}),
            checks,
            evidence,
            submittedAt: at,
            submittedBy: command.actor || "管家",
          };
          item.status = "review";
          item.reviewRounds = reviewRounds + 1;
          item.reviewLimit = reviewLimit;
          item.attention = {
            id: newId("attention"), kind: "review",
            summary: "成果已提交，等待你的验收。", since: at,
          };
          item.next = "查看实际成果和检查结果，验收通过或给管家发消息。";
          activity(
            item,
            "delivery",
            item.delivery.summary,
            command.actor || "管家",
          );
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.review.amend": {
          const item = goal(command.goalId);
          ongoing(item, true);
          if (item.status !== "review" || !item.delivery)
            throw new Error("只有当前正在等待验收的交付可以补充说明或证据");
          if (item.delivery.id !== command.deliveryId)
            throw new Error("交付已经变化；请重新读取当前目标后再补充证据");
          const at = nowIso(),
            note = text(command.note, "补充原因", 4_000),
            previousTitle = item.title,
            previousSummary = item.delivery.summary,
            addedChecks = command.checks === undefined ? [] : deliveryChecks(command.checks),
            addedEvidence = command.evidence === undefined
              ? []
              : evidenceItems(command.evidence, at, item.delivery.checks),
            existingIds = new Set((item.delivery.evidence ?? []).map(evidence => evidence.id)),
            duplicate = addedEvidence.find(evidence => existingIds.has(evidence.id));
          if (duplicate)
            throw new Error(`证据 ID 已存在：${duplicate.id}`);
          if (command.title) item.title = text(command.title, "范围标题", 500);
          if (command.summary !== undefined)
            item.delivery.summary = substantiveAgentText(command.summary, "成果摘要", 12_000);
          if (command.location !== undefined)
            item.delivery.location = text(command.location, "交付位置", 2_000);
          if (command.url !== undefined)
            item.delivery.url = text(command.url, "链接", 2_000);
          if (addedChecks.length)
            item.delivery.checks = [...item.delivery.checks, ...addedChecks];
          if (addedEvidence.length)
            item.delivery.evidence = [...(item.delivery.evidence ?? []), ...addedEvidence];
          const changed =
            item.delivery.summary !== previousSummary ||
            command.location !== undefined ||
            command.url !== undefined ||
            addedChecks.length > 0 ||
            addedEvidence.length > 0 ||
            item.title !== previousTitle;
          if (!changed)
            throw new Error("补充内容没有实际变化；请增加证据、检查或更正说明");
          item.delivery.amendedAt = at;
          item.delivery.amendments = [
            ...(item.delivery.amendments ?? []),
            {
              id: newId("amendment"),
              at,
              actor: command.actor || (managed?.role === "owner"
                ? item.agentRuntime?.attempt.agent || item.owner : "管家"),
              note,
              previousSummary,
              summary: item.delivery.summary,
              addedChecks,
              addedEvidenceIds: addedEvidence.map(evidence => evidence.id),
            },
          ].slice(-30);
          activity(
            item,
            "delivery_amend",
            `补充当前交付：${note}` +
              (addedChecks.length ? `；新增检查 ${addedChecks.length} 项` : "") +
              (addedEvidence.length ? `；新增证据 ${addedEvidence.length} 条` : "") +
              (item.delivery.summary !== previousSummary ? "；更正成果说明" : "") +
              (command.title ? "；更新范围标题" : "") +
              "。未改变候选成果，不增加审查轮次。",
            command.actor || "管家",
          );
          return item;
        }
        case "goal.accept": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有提交验收的目标才能通过验收");
          if (!item.delivery)
            throw new Error("只有提交验收的目标才能通过验收");
          const actor = command.actor || "你";
          if (managed)
            throw new Error("成果验收必须由人通过桌面或可信注意力界面完成，受管 Agent 不能代替人验收");
          humanOnly(
            actor,
            "成果验收必须由人通过桌面或可信注意力界面完成，受管 Agent 不能代替人验收",
          );
          const note = command.note?.trim()
            ? text(command.note, "验收依据", 4000)
            : "成果验收通过。";
          item.acceptance = { id: newId("acceptance"), kind: "human",
            at: nowIso(), by: actor, mandateRevision: item.revision ?? 1, note };
          item.status = "completed";
          delete item.executionHold;
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = "这件事已完成，不需要继续关注。";
          cancelAgentReceipt(item);
          activity(
            item,
            "accepted",
            note,
            actor,
          );
          return item;
        }
        case "goal.complete": {
          const item = goal(command.goalId);
          if (item.status === "review")
            throw new Error("待验收成果必须使用人工验收，不能直接标记完成");
          ongoing(item, true, true);
          assertMigrationConfirmationHuman(item, command.actor, managed);
          const actor = command.actor || "你";
          const note = text(command.note, "用户确认完成的原话", 4000);
          const at = nowIso();
          item.status = "completed";
          delete item.executionHold;
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = `已结束：${note}`;
          cancelAgentReceipt(item);
          activity(item, "accepted", note, actor);
          return item;
        }
        case "goal.rework": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有待验收目标可以退回");
          const at = nowIso();
          if (command.title) item.title = text(command.title, "范围标题", 500);
          item.status = "active";
          item.attention = null;
          item.next = text(command.note, "修改意见", 4000);
          activity(item, "rework", command.note, command.actor || "你");
          return item;
        }
        case "goal.drop": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          assertMigrationConfirmationHuman(item, command.actor, managed);
          const actor = command.actor || "你";
          if (actor !== "你" && !command.note?.trim())
            throw new Error("管家放弃目标时必须记录用户明确放弃的原话");
          item.status = "dropped";
          delete item.executionHold;
          item.attention = null;
          item.remindAt = undefined;
          item.next = text(command.note || "这件事已放弃。", "原因", 4000);
          cancelAgentReceipt(item);
          activity(item, "dropped", item.next, actor);
          return item;
        }
        case "goal.resolve": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          if (item.attention?.kind === "review")
            throw new Error("成果请使用验收通过或给管家发消息");
          if (!item.attention && !hasDueReminder(item))
            throw new Error("当前没有需要解决的注意力事项");
          const at = nowIso(), note = command.note?.trim() ? text(command.note, "决定", 4000) : "";
          const migrationConfirmation = item.executionHold === "migration-confirmation";
          if (migrationConfirmation)
            assertMigrationConfirmationHuman(item, command.actor, managed);
          const decisionAttention = item.attention?.kind === "decision" ? item.attention : undefined;
          const isDecision = Boolean(decisionAttention);
          const rejectedMigration = migrationConfirmation && command.outcome === "rejected";
          if (isDecision) {
            if (!note) throw new Error("决定账本需要记录你的原话");
            const outcome = command.outcome ?? "approved";
            if (!["approved", "rejected"].includes(outcome))
              throw new Error("无效的决定结果");
            state.decisions.push({
              id: newId("decision"),
              projectId: item.projectId,
              actionKey: text(decisionAttention!.decisionKey || decisionAttention!.summary, "决定键", 4000),
              outcome,
              quote: note,
              source: command.sceneReplyId || command.source === "scene"
                ? `${item.scene?.backend === "orca" ? "Orca" : "Herdr"} 负责人现场`
                : command.source === "herdr"
                ? "Herdr 注意力面板"
                : command.source === "cli" ? "Atte CLI" : "Atte 桌面",
              goalId: item.id,
              decidedAt: at,
            });
            item.next = `你已${outcome === "approved" ? "批准" : "拒绝"}：${note}`;
            item.status = "active";
            item.waitingFor = undefined;
            item.remindAt = undefined;
            if (migrationConfirmation && outcome === "approved") delete item.executionHold;
            if (item.mode === "concierge" && !item.executionHold)
              item.dispatch = {
                id: newId("handoff"),
                kind: "feedback",
                note: item.next,
                status: "pending",
                at,
              };
            if (rejectedMigration) {
              item.attention = {
                id: newId("attention"),
                kind: "decision",
                summary: "你已拒绝按普通目标继续；该目标保持暂停。以后需要继续时再明确确认。",
                since: at,
                source: "governance",
                decisionKey: `migration-confirmation:${item.id}`,
              };
              item.next = "旧实验目标保持暂停，不会派发或自动执行。";
            }
          }
          if (item.attention?.kind === "intervention" &&
            item.attention.source === "governance" &&
            item.attention.summary.includes("审查已达到")) {
            item.reviewLimit = (item.reviewLimit ?? 3) + 1;
          }
          if (!rejectedMigration) item.attention = null;
          item.remindAt = undefined;
          if (command.sceneReplyId && item.mode === "concierge" && !isDecision)
            item.dispatch = {
              id: newId("handoff"), kind: "feedback", note, status: "pending", at,
            };
          if (note && !isDecision) item.next = note;
          if (note) activity(item, "resolved", note, command.actor || "你");
          else stamp(item);
          return item;
        }
        case "goal.remind": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          item.remindAt = iso(command.at);
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.note) item.next = text(command.note, "提醒说明", 2000);
          activity(
            item,
            "reminder",
            command.note || `将在 ${item.remindAt} 提醒。`,
          );
          return item;
        }
        case "session.set": {
          const reference = command.reference;
          if (
            typeof reference?.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(reference.session)
          )
            throw new Error("无效的 Herdr Session");
          if (reference.transport !== undefined && reference.transport !== "pane")
            throw new Error("无效的现场通信方式");
          if (reference.transport === "pane" &&
            (!reference.paneId || !Number.isSafeInteger(reference.processId) || reference.processId! <= 0))
            throw new Error("自定义 CLI 现场需要真实 Pane 与前台进程 ID");
          if (command.goalId) {
            const item = goal(command.goalId);
            if (item.status === "backlog")
              throw new Error("暂存事项不能关联执行现场，请先交给管家");
            const sameSite = (other: typeof reference) => other.session === reference.session &&
              (!!reference.paneId && reference.paneId === other.paneId ||
               !!reference.tabId && reference.tabId === other.tabId ||
               !!reference.agent && reference.agent === other.agent);
            if (reference.agent === "concierge" || sameSite(state.concierge))
              throw new Error("目标需要独立负责人，不能把全局管家登记为执行现场");
            if (state.goals.some(other => other.id !== item.id &&
              !["completed","dropped"].includes(other.status) && other.herdr && sameSite(other.herdr)))
              throw new Error("该现场属于其他目标，请为当前目标创建独立负责人 Tab");
            item.herdr = structuredClone(reference);
            if (item.agentRuntime)
              item.agentRuntime.attempt.legacyScene = {
                version: 0, backend: "herdr", verification: "unverified", reference: structuredClone(reference),
              };
            delete item.sceneVisit;
            delete item.live;
            if (item.mode === "concierge" && item.status === "active")
              item.owner = reference.agent || "独立负责人";
            activity(item, "session", "已关联 Herdr 现场。", "系统");
            return item;
          }
          state.concierge = {
            ...state.concierge,
            ...structuredClone(reference),
          };
          delete state.concierge.live;
          return state.concierge;
        }
        case "agent.runtime.register": {
          const item = goal(command.goalId),
            attempt = validatedAttempt(command.attempt);
          ongoing(item, true);
          if (attempt.goalId !== item.id)
            throw new Error("Agent attempt 与目标不一致");
          attempt.scene ??= item.scene ? structuredClone(item.scene) : undefined;
          if (!attempt.scene && item.herdr) attempt.legacyScene = {
            version: 0, backend: "herdr", verification: "unverified",
            reference: structuredClone(item.herdr),
          };
          if (!/^[a-f0-9]{64}$/.test(command.hookTokenHash))
            throw new Error("Agent Hook 令牌无效");
          if (!Array.isArray(command.capabilities) ||
            command.capabilities.some(capability => !runtimeEventTypes.has(capability)))
            throw new Error("Agent Runtime 能力声明无效");
          item.agentRuntime = {
            attempt,
            capabilities: [...new Set(command.capabilities)],
            lastEventId: "",
            lastEventType: "session.started",
            lastEventAt: attempt.startedAt,
            lastSequence: 0,
            hookTokenHash: command.hookTokenHash,
            ...(attempt.currentTurnId ? { currentTurnId: attempt.currentTurnId } : {}),
            seenEventIds: [],
          };
          delete item.recovery;
          delete item.watchdog;
          return item.agentRuntime;
        }
        case "agent.runtime.event": {
          const event = validatedRuntimeEvent(command.event),
            item = goal(event.goalId),
            runtime = item.agentRuntime;
          if (!runtime) return { accepted: false, reason: "runtime_missing" };
          if (["completed", "dropped"].includes(item.status))
            return { accepted: false, reason: "goal_ended" };
          if (runtime.attempt.attemptId !== event.attemptId)
            return { accepted: false, reason: "old_attempt" };
          if (runtime.attempt.adapter !== event.adapter ||
            runtime.attempt.agent !== event.agent)
            return { accepted: false, reason: "runtime_mismatch" };
          if (runtime.seenEventIds?.includes(event.eventId))
            return { accepted: false, reason: "duplicate" };
          if (event.sequence <= runtime.lastSequence)
            return { accepted: false, reason: "late_event" };
          if (event.type === "turn.started" && event.turnId &&
            event.turnId !== runtime.currentTurnId &&
            runtime.seenTurnIds?.includes(event.turnId))
            return { accepted: false, reason: "old_turn" };
          const sessionEvent = event.type === "session.started" ||
            event.type === "session.ended";
          // A turn may move the runtime forward only through an explicit
          // turn.started event. Other events carrying a different turn ID are
          // late writes from a settled/interrupted turn and must not move the
          // active receipt or replace the newest reply.
          if (!sessionEvent && event.turnId &&
            event.type !== "turn.started" &&
            runtime.currentTurnId && event.turnId !== runtime.currentTurnId)
            return { accepted: false, reason: "old_turn" };

          runtime.lastEventId = event.eventId;
          runtime.lastEventType = event.type;
          runtime.lastEventAt = event.at;
          runtime.lastSequence = event.sequence;
          runtime.seenEventIds = [...(runtime.seenEventIds ?? []), event.eventId].slice(-64);
          if (!sessionEvent && event.turnId) {
            runtime.currentTurnId = event.turnId;
            runtime.attempt.currentTurnId = event.turnId;
          }
          if (event.type === "turn.started") {
            runtime.currentTurnStartedAt = event.at;
            const receipt = runtime.receipt;
            const reminder = receipt &&
              ["reminding", "reminded", "protocol_missing", "written"].includes(receipt.status) &&
              event.content?.text.startsWith(
                agentReceiptMarker(runtime.attempt.attemptId, receipt.turnId),
              );
            if (reminder) receipt.reminderTurnId = event.turnId;
            else runtime.receipt = undefined;
            // A real Agent turn proves that the person reached the scene. Hook
            // capable owners use their turn lifecycle instead of racing a
            // synthetic reconciliation prompt against the user's next input.
            if (!reminder) cancelSceneReconciliation(item);
            if (event.turnId)
              runtime.seenTurnIds = [
                ...(runtime.seenTurnIds ?? []).filter(turn => turn !== event.turnId),
                event.turnId,
              ].slice(-128);
            if (event.content) runtime.lastPrompt = event.content;
            delete item.recovery;
            if (item.watchdog?.reason === "settled" ||
              item.watchdog?.reason === "protocol_missing")
              delete item.watchdog;
          } else if (event.type === "agent.response") {
            if (event.content) runtime.lastReply = event.content;
          } else if (event.type === "turn.settled") {
            if (event.content) runtime.lastReply = event.content;
            const turn = event.turnId ?? runtime.currentTurnId;
            if (item.mode === "concierge" && turn && runtime.receipt?.reminderTurnId !== turn &&
              runtime.receipt?.turnId !== turn) {
              const settled = Date.parse(event.at);
              runtime.receipt = {
                turnId: turn,
                status: runtime.lastSemanticWriteTurnId === turn ||
                  (runtime.currentTurnStartedAt && runtime.lastSemanticWriteAt &&
                    Date.parse(runtime.lastSemanticWriteAt) >= Date.parse(runtime.currentTurnStartedAt))
                  ? "written" : "waiting",
                settledAt: event.at,
                remindAt: new Date(settled + 10_000).toISOString(),
                inspectAt: new Date(settled + 40_000).toISOString(),
              };
            }
            delete item.recovery;
          } else if (event.type === "turn.interrupted" ||
            event.type === "session.ended") {
            runtime.receipt = undefined;
            if (item.watchdog?.reason === "settled" ||
              item.watchdog?.reason === "protocol_missing")
              delete item.watchdog;
          } else if (event.type === "agent.blocked") {
            runtime.receipt = undefined;
          }
          item.revision = (item.revision ?? 0) + 1;
          item.updatedAt = event.at;
          return { accepted: true, goal: item, event };
        }
        case "agent.runtime.receipt": {
          const item = goal(command.goalId),
            runtime = item.agentRuntime,
            at = iso(command.at);
          if (!runtime || runtime.attempt.attemptId !== command.attemptId ||
            !runtime.receipt || runtime.receipt.turnId !== command.turnId ||
            (runtime.currentTurnId !== command.turnId &&
              runtime.currentTurnId !== runtime.receipt.reminderTurnId))
            return { updated: false, reason: "stale_receipt" };
          if (runtime.receipt.status === "written" && command.stage !== "reminded")
            return { updated: false, reason: "semantic_write_present" };
          if (command.stage === "cancelled") {
            cancelAgentReceipt(item);
            return { updated: true, goal: item };
          }
          if (command.stage === "reminding") {
            if (runtime.receipt.status !== "waiting")
              return { updated: false, reason: "reminder_in_progress" };
            runtime.receipt.status = "reminding";
            return { updated: true, goal: item };
          }
          if (command.stage === "reminded") {
            if (!["waiting", "reminding", "written"].includes(runtime.receipt.status))
              return { updated: false, reason: "already_reminded" };
            if (runtime.receipt.remindedAt)
              return { updated: false, reason: "already_reminded" };
            if (runtime.receipt.status !== "written")
              runtime.receipt.status = "reminded";
            runtime.receipt.remindedAt = at;
            runtime.receipt.inspectAt =
              new Date(Date.parse(at) + 30_000).toISOString();
            if (command.detail)
              runtime.receipt.reminderError = text(
                command.detail,
                "回执提醒失败说明",
                1000,
              );
            else
              delete runtime.receipt.reminderError;
            activity(item, "session",
              command.detail
                ? `负责人回合结束但尚未写回；结构化回执提醒未送达：${command.detail}`
                : "负责人结束回合后尚未按协议写回，已发送一次结构化回执提醒。",
              "系统");
            return { updated: true, goal: item };
          }
          if (runtime.receipt.status !== "reminded")
            return { updated: false, reason: "reminder_not_sent" };
          runtime.receipt.status = "protocol_missing";
          runtime.receipt.missingAt = at;
          runtime.receipt.detail = command.detail
            ? text(command.detail, "回执缺失说明", 1000)
            : "负责人结束回合并收到一次提醒后，仍未提交结构化结果。";
          item.watchdog = {
            reason: "protocol_missing",
            basis: progressBasis(item),
            detectedAt: at,
          };
          activity(item, "watchdog",
            "负责人回合已结束但未按 Atte 协议写回；现已交给管家核对，不据此推断完成或失败。",
            "系统");
          return { updated: true, goal: item };
        }
        case "session.release": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已完成或已放弃的目标可以释放负责人现场");
          if (!item.herdr) return item;
          delete item.herdr;
          delete item.live;
          activity(item, "session", "目标已结束，负责人现场已关闭。", "系统");
          return item;
        }
        case "session.preserve": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已结束的目标可以保存负责人恢复信息");
          if (!item.herdr && !item.scene)
            throw new Error("当前目标没有可保存的负责人现场");
          item.ownerResume = preservedOwnerResume(command.resume);
          stamp(item);
          return item;
        }
        case "session.resume.capture": {
          const item = goal(command.goalId);
          if (!item.scene || ["completed", "dropped", "backlog"].includes(item.status))
            throw new Error("当前目标没有可捕获的负责人现场");
          item.ownerResume = preservedOwnerResume(command.resume);
          stamp(item);
          return item;
        }
        case "concierge.status": {
          if (!["ready", "error", "not_ready"].includes(command.status))
            throw new Error("无效的管家状态");
          if (command.live &&
            !["working", "idle", "done", "blocked", "unknown"].includes(command.live.state))
            throw new Error("无效的 Herdr 状态");
          const reference = command.reference;
          if (reference?.processId !== undefined &&
            (!Number.isSafeInteger(reference.processId) || reference.processId <= 0))
            throw new Error("无效的管家进程 ID");
          const concierge: WorkspaceState["concierge"] = {
            // Legacy Herdr presence writers must not erase the neutral launch
            // identity. They update observations, not ownership.
            ...state.concierge,
            session: reference?.session ?? "atte",
            ...(reference?.workspaceId === undefined ? {} : { workspaceId: reference.workspaceId }),
            ...(reference?.tabId === undefined ? {} : { tabId: reference.tabId }),
            ...(reference?.paneId === undefined ? {} : { paneId: reference.paneId }),
            ...(reference?.agent === undefined ? {} : { agent: reference.agent }),
            ...(reference?.transport === undefined ? {} : { transport: reference.transport }),
            ...(reference?.processId === undefined ? {} : { processId: reference.processId }),
            ...(reference?.launchPolicy === undefined ? {} : { launchPolicy: reference.launchPolicy }),
            status: command.status,
          };
          if (command.detail)
            concierge.detail = text(command.detail, "状态说明", 1000);
          else delete concierge.detail;
          if (command.live === null) delete concierge.live;
          if (command.live) {
            const observed = observedPresence(concierge.live, command.live);
            if (observed) concierge.live = observed;
          }
          state.concierge = concierge;
          return state.concierge;
        }
        case "live.sync": {
          for (const [goalId, presence] of Object.entries(command.presences)) {
            const item = state.goals.find(candidate => candidate.id === id(goalId));
            if (!item) throw new Error("找不到目标");
            if (!goalCanExecute(item)) continue;
            if (
              !["working", "idle", "done", "blocked", "unknown"].includes(
                presence.state,
              )
            )
              throw new Error("无效的 Herdr 状态");
            const observed = observedPresence(item.live, presence);
            if (!observed) continue;
            item.live = observed;
            observeSceneWork(item, item.live);
            if (
              presence.state !== "blocked" &&
              item.attention?.source === "live"
            )
              item.attention = null;
          }
          return true;
        }
        case "live.event": {
          const target = command.target;
          const idPattern = /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64})?$/;
          const targets = [
            ["paneId", target?.paneId],
            ["tabId", target?.tabId],
            ["workspaceId", target?.workspaceId],
          ] as const;
          if (!targets.some(([, value]) => typeof value === "string" && value.length > 0))
            throw new Error("Herdr 插件事件缺少现场身份");
          for (const [name, value] of targets) {
            if (value !== undefined && (typeof value !== "string" || !idPattern.test(value)))
              throw new Error(`无效的 Herdr ${name}`);
          }
          for (const [name, value] of Object.entries(command.reference ?? {})) {
            if (name === "agent" && value !== undefined &&
              (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)))
              throw new Error("无效的 Herdr Agent 名称");
            if (name !== "agent" && value !== undefined &&
              (typeof value !== "string" || !idPattern.test(value)))
              throw new Error(`无效的 Herdr ${name}`);
          }
          if (!["working", "idle", "done", "blocked", "unknown"].includes(command.presence.state))
            throw new Error("无效的 Herdr 状态");
          let matched = 0;
          for (const item of state.goals) {
            const reference = item.herdr;
            if (!goalCanExecute(item) || !reference ||
              (command.reference?.agent !== undefined &&
                reference.agent !== command.reference.agent) ||
              (target.paneId !== undefined && reference.paneId !== target.paneId) ||
              (target.tabId !== undefined && reference.tabId !== target.tabId) ||
              (target.workspaceId !== undefined && reference.workspaceId !== target.workspaceId)) continue;
            const observed = observedPresence(item.live, command.presence);
            if (!observed) continue;
            item.live = observed;
            observeSceneWork(item, item.live);
            if (command.reference)
              item.herdr = { ...reference, ...structuredClone(command.reference) };
            if (command.presence.state !== "blocked" && item.attention?.source === "live")
              item.attention = null;
            matched += 1;
          }
          const concierge = state.concierge;
          if (
            (
              command.presence.reachable === false ||
              command.reference?.agent === concierge.agent
            ) &&
            (target.paneId === undefined || concierge.paneId === target.paneId) &&
            (target.tabId === undefined || concierge.tabId === target.tabId) &&
            (target.workspaceId === undefined || concierge.workspaceId === target.workspaceId)
          ) {
            if (command.reference) {
              state.concierge = {
                ...concierge,
                ...structuredClone(command.reference),
              };
            }
            const current = state.concierge;
            const observed = observedPresence(current.live, command.presence);
            if (!observed) return { matched };
            current.live = observed;
            if (command.presence.reachable === false) {
              current.status = "not_ready";
              current.detail = "管家现场已关闭或不可达，请恢复管家。";
            } else {
              current.status = "ready";
              delete current.detail;
            }
            matched += 1;
          }
          return { matched };
        }
        case "watchdog.inspect":
          return inspectWatchdog(
            state.goals,
            iso(command.at),
            state.watchdog?.noProgressMinutes ?? 30,
          );
        case "watchdog.report": {
          if (!["contacted", "failed"].includes(command.outcome)) throw new Error("无效的巡检结果");
          reportWatchdog(goal(command.goalId), iso(command.at), iso(command.basis), command.outcome,
            command.detail ? text(command.detail, "巡检说明", 1000) : undefined);
          return true;
        }
        case "notification.sent": {
          const item = goal(command.goalId),
            kind = command.kind;
          if (attentionRequest(item)?.kind !== kind) return true;
          if (item.attention?.kind === kind)
            item.attention.notifiedAt = iso(command.at);
          else if (kind === "follow_up")
            item.attention = {
              id: attentionRequest(item)?.id ?? newId("attention"),
              kind,
              summary: item.next,
              since: iso(command.at),
              notifiedAt: iso(command.at),
            };
          return true;
        }
        default:
          throw new Error("不支持的命令");
      }
    });
  }
}
