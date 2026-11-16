import { appendFile, mkdir, open, readFile, realpath, rename, link, lstat, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { nextSequence, withLock } from "./storage.js";
import type { WorkspaceRecoveryReason, WorkspaceState } from "./types.js";
import {
  defaultProjectPolicy,
  initialState,
  newId,
} from "./model.js";
import { retireWorkspaceFeatures } from "./retired-history.js";
import { decisionMarkdown } from "./governance.js";
import { normalizeExternalWaits } from "./waiting.js";
import { isSceneReference, type LegacySceneV0 } from "./session-types.js";
import { prepareWorkspaceState } from "./state-migration.js";
import { rewriteStoredCompatibility, STATE_DIRECTORY } from "./compatibility.js";
export { initialState, newId } from "./model.js";
const DEFAULT_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_EVENT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_EVENTS = 2_000;
class IncompatibleWorkspaceStateError extends Error {
  constructor(readonly reason: WorkspaceRecoveryReason, message: string) {
    super(message);
  }
}
function invalidState(message: string): never {
  throw new IncompatibleWorkspaceStateError("invalid-state", message);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
function stateDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function compactEvent(record: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "type", "sequence", "created_at", "title", "source_task_id", "recovery"]) {
    if (record[key] !== undefined) compact[key] = record[key];
  }
  if (record.state !== undefined) {
    const state = JSON.stringify(record.state);
    compact.state_sha256 = stateDigest(state);
    compact.state_bytes = Buffer.byteLength(state);
  }
  compact.compacted = true;
  return compact;
}
async function readEventTail(path: string, maxBytes: number): Promise<Record<string, unknown>[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat(), offset = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    let raw = buffer.toString("utf8");
    if (offset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    const records: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value))
          records.push(value as Record<string, unknown>);
      } catch {
        // A tail read can begin in the middle of a UTF-8 code point. The
        // newline boundary above removes that partial record.
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}
export async function compactEventLogIfNeeded(
  directory: string,
  options: { maxBytes?: number; tailBytes?: number; keepEvents?: number } = {},
) {
  const path = join(directory, "events.jsonl"),
    maxBytes = options.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES,
    tailBytes = options.tailBytes ?? DEFAULT_EVENT_TAIL_BYTES,
    keepEvents = options.keepEvents ?? DEFAULT_RETAINED_EVENTS;
  let before: number;
  try {
    before = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { compacted: false, before: 0, after: 0 };
    throw error;
  }
  if (before <= maxBytes) return { compacted: false, before, after: before };
  const records = (await readEventTail(path, tailBytes)).slice(-keepEvents).map(compactEvent);
  if (!records.length) throw new Error("events.jsonl 超过上限，但尾部没有完整事件可安全保留");
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`,
    body = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
  return { compacted: true, before, after: Buffer.byteLength(body) };
}
function validateShape(value: unknown, version: 2 | 3 | 4 | 5): WorkspaceState {
  if (!record(value))
    throw new IncompatibleWorkspaceStateError(
      "invalid-state",
      "工作区快照不是有效对象。",
    );
  if (value.version !== version)
    throw new IncompatibleWorkspaceStateError(
      "unsupported-version",
      `工作区状态版本 ${String(value.version ?? "未知")} 与当前版本不兼容。`,
    );
  if (!nonEmptyString(value.name)) invalidState("工作区快照缺少名称。");
  if (!Array.isArray(value.projects)) invalidState("工作区快照缺少项目列表。");
  if (!Array.isArray(value.goals)) invalidState("工作区快照缺少目标列表。");
  if (!Array.isArray(value.workflows)) invalidState("工作区快照缺少工序列表。");
  if (!record(value.concierge) || !nonEmptyString(value.concierge.session) ||
    !["not_ready", "ready", "error"].includes(String(value.concierge.status)))
    invalidState("工作区快照中的管家状态无效。");
  if (version >= 4 && (!Number.isSafeInteger(value.backendEpoch) ||
    (value.backendEpoch as number) < 0))
    invalidState("工作区后端代次无效。");
  if (version >= 4 && value.concierge.scene !== undefined &&
    !isSceneReference(value.concierge.scene))
    invalidState("管家现场身份无效。");
  if (value.decisions !== undefined && !Array.isArray(value.decisions))
    invalidState("工作区快照中的决定账本无效。");
  for (const project of value.projects)
    if (!record(project) || !nonEmptyString(project.id) || !nonEmptyString(project.name))
      invalidState("工作区快照包含无效项目。");
  for (const goal of value.goals) {
    if (!record(goal) || !nonEmptyString(goal.id) || !nonEmptyString(goal.projectId) ||
      !nonEmptyString(goal.title) || typeof goal.description !== "string" ||
      !["concierge", "manual"].includes(String(goal.mode)) ||
      !["backlog", "active", "waiting", "review", "completed", "dropped"].includes(String(goal.status)) ||
      typeof goal.next !== "string" || typeof goal.owner !== "string" ||
      !Array.isArray(goal.activities) || !nonEmptyString(goal.createdAt) ||
      !nonEmptyString(goal.updatedAt))
      invalidState("工作区快照包含结构不完整的目标。");
    if (version >= 4 && goal.scene !== undefined && !isSceneReference(goal.scene))
      invalidState("目标现场身份无效。");
    if (goal.skills !== undefined) {
      if (!Array.isArray(goal.skills) || goal.skills.length > 8 ||
        goal.skills.some(skill =>
          !record(skill) ||
          !nonEmptyString(skill.packId) ||
          !nonEmptyString(skill.version) ||
          !/^[a-f0-9]{64}$/.test(String(skill.digest)) ||
          !Array.isArray(skill.roles) ||
          !skill.roles.every(role => role === "owner" || role === "verifier") ||
          !nonEmptyString(skill.attachedAt) ||
          !["human", "concierge"].includes(String(skill.attachedBy))))
        invalidState("工作区快照包含无效的目标能力包绑定。");
    }
    if (goal.skillResolutions !== undefined &&
      (!Array.isArray(goal.skillResolutions) || goal.skillResolutions.length > 40))
      invalidState("工作区快照包含无效的能力包解析记录。");
    if (goal.ownerLaunchRecovery !== undefined) {
      const recovery = goal.ownerLaunchRecovery;
      if (!record(recovery) || !nonEmptyString(recovery.id) ||
        !nonEmptyString(recovery.attemptId) || !nonEmptyString(recovery.session) ||
        !["pending", "attached", "superseded"].includes(String(recovery.status)) ||
        !nonEmptyString(recovery.createdAt))
        invalidState("工作区快照包含无效的负责人恢复信息。");
    }
  }
  if (value.recovery !== undefined) {
    const recovery = value.recovery;
    if (!record(recovery) || !nonEmptyString(recovery.id) ||
      !nonEmptyString(recovery.detectedAt) || !nonEmptyString(recovery.archivedPath) ||
      !["unsupported-version", "invalid-state", "legacy-event-log"].includes(String(recovery.reason)) ||
      !nonEmptyString(recovery.detail))
      invalidState("工作区恢复提示信息无效。");
  }
  const state = value as unknown as WorkspaceState;
  state.decisions ??= [];
  for (const project of state.projects) project.policy ??= defaultProjectPolicy();
  return state;
}
function migrateStateV2(value: unknown): WorkspaceState {
  const state = validateShape(value, 2);
  (state as unknown as { version: number }).version = 3;
  return migrateStateV3(state);
}
function legacyScene(reference: unknown): LegacySceneV0 | undefined {
  if (!record(reference) || !nonEmptyString(reference.session)) return;
  return {
    version: 0,
    backend: "herdr",
    verification: "unverified",
    reference: Object.fromEntries(
      ["session", "workspaceId", "tabId", "paneId", "agent", "transport", "processId", "launchPolicy"]
        .filter(key => reference[key] !== undefined)
        .map(key => [key, structuredClone(reference[key])]),
    ) as unknown as LegacySceneV0["reference"],
  };
}
function migrateStateV3(value: unknown): WorkspaceState {
  const state = validateShape(value, 3);
  (state as unknown as { version: number }).version = 4;
  state.backendEpoch = 0;
  state.concierge.legacyScene = legacyScene(state.concierge);
  for (const item of state.goals) {
    if (item.herdr) {
      item.legacyScene = legacyScene(item.herdr);
      delete item.herdr;
    }
    const runtime = item.agentRuntime;
    if (runtime?.attempt.scene) {
      runtime.attempt.legacyScene = legacyScene(runtime.attempt.scene);
      delete runtime.attempt.scene;
    }
    if (item.ownerLaunchRecovery)
      item.ownerLaunchRecovery.legacyScene = legacyScene(item.ownerLaunchRecovery);
    const sites = item.autonomy?.verificationSite;
    if (sites) sites.legacyScene = legacyScene(sites.reference);
    for (const verification of item.autonomy?.lastVerification ? [item.autonomy.lastVerification] : []) {
      if (verification.reviewerHerdr) {
        verification.legacyScene = legacyScene(verification.reviewerHerdr);
        delete verification.reviewerHerdr;
      }
    }
  }
  return state;
}
export function validateState(value: unknown): WorkspaceState {
  value = rewriteStoredCompatibility(value);
  if (!record(value))
    throw new IncompatibleWorkspaceStateError(
      "invalid-state",
      "工作区快照不是有效对象。",
    );
  const version = value.version;
  if (version !== 2 && version !== 3 && version !== 4 && version !== 5)
    throw new IncompatibleWorkspaceStateError("unsupported-version",
      `工作区状态版本 ${String(version ?? "未知")} 与当前版本不兼容。`);
  const state = version === 2 ? migrateStateV2(value) : version === 3
    ? migrateStateV3(value) : validateShape(value, version);
  if (state.autonomy !== undefined &&
    (!record(state.autonomy) ||
      !["human-review", "auto-with-verification"].includes(String(state.autonomy.acceptance)) ||
      typeof state.autonomy.paused !== "boolean" ||
      !Number.isSafeInteger(state.autonomy.maxRecoveryAttempts) ||
      !Number.isSafeInteger(state.autonomy.noProgressMinutes) ||
      !Number.isSafeInteger(state.autonomy.revision) ||
      !nonEmptyString(state.autonomy.updatedAt)))
    invalidState("工作区自主目标设置无效。");
  if (state.bots !== undefined && !Array.isArray(state.bots))
    invalidState("工作区 Bot 绑定列表无效。");
  if (state.botRequests !== undefined && !Array.isArray(state.botRequests))
    invalidState("工作区 Bot 请求回执列表无效。");
  if (version !== 5) retireWorkspaceFeatures(state, version);
  else {
    if (state.autonomy !== undefined || state.bots !== undefined || state.botRequests !== undefined ||
      state.projects.some(project => project.autonomy !== undefined || project.releaseOnMerge !== undefined) ||
      state.goals.some(goal => goal.autonomy !== undefined || goal.brief !== undefined ||
        goal.briefHistory !== undefined || goal.release !== undefined || goal.skills !== undefined ||
        goal.skillResolutions !== undefined || goal.kind === "release" ||
        goal.dispatch?.kind === "continuation" || goal.dispatch?.kind === "verification" ||
        goal.acceptance?.kind === "automatic"))
      invalidState("v5 快照不能重新启用已退役的执行配置；请保留原快照并检查 history。");
  }
  if (state.agents && "worker" in state.agents) invalidState("v5 Agent 偏好不支持 worker。");
  if (state.watchdog !== undefined && (!record(state.watchdog) ||
    !Number.isSafeInteger(state.watchdog.noProgressMinutes) || state.watchdog.noProgressMinutes < 1))
    invalidState("巡检设置无效。");
  for (const goal of state.goals) {
    const legacyOrca = goal.scene?.backend === "orca" ||
      goal.agentRuntime?.attempt.scene?.backend === "orca" ||
      goal.ownerLaunchRecovery?.scene?.backend === "orca";
    if (legacyOrca) {
      goal.readOnly = true;
      goal.readOnlyReason = "legacy-orca";
      delete goal.dispatch;
      delete goal.watchdog;
      delete goal.recovery;
      delete goal.sceneVisit;
      const receipt = goal.agentRuntime?.receipt;
      if (receipt && receipt.status !== "written") receipt.status = "cancelled";
    }
    if (goal.readOnly !== undefined && goal.readOnly !== true) invalidState("目标只读标记无效。");
    if (goal.readOnlyReason !== undefined &&
      goal.readOnlyReason !== "legacy-orca" && goal.readOnlyReason !== "legacy-epoch")
      invalidState("目标只读原因无效。");
    if (goal.readOnlyReason === "legacy-orca" || goal.readOnlyReason === "legacy-epoch")
      goal.readOnly = true;
    if (goal.readOnly === true) goal.readOnlyReason ??= "legacy-orca";
    if (goal.executionHold !== undefined && goal.executionHold !== "migration-confirmation")
      invalidState("目标执行暂停标记无效。");
    if (goal.kind !== undefined && goal.kind !== "delivery" && goal.kind !== "discovery")
      invalidState("v5 目标类型只能是 delivery 或 discovery。");
  }
  normalizeExternalWaits(state);
  return state;
}
async function writeAtomic(path: string, body: string) {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
async function backupSnapshot(directory: string, version: 2 | 3 | 4, raw: string) {
  const backup = join(directory, `state.v${version}.backup.json`);
  const verify = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() ||
      stateDigest(await readFile(path, "utf8")) !== stateDigest(raw))
      throw new Error("原版本备份校验失败，已停止升级并保留原快照。");
  };
  try {
    await verify(backup);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${backup}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    await verify(temporary);
    await link(temporary, backup);
    await verify(backup);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
export class WorkspaceStore {
  constructor(readonly root: string) {}
  private async directory() {
    const { directory: path } = await prepareWorkspaceState(this.root);
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink()) throw new Error("状态目录不能是符号链接");
    return path;
  }
  private async recoveryReason(directory: string): Promise<IncompatibleWorkspaceStateError | undefined> {
    try {
      validateState(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
      return undefined;
    } catch (error) {
      if (error instanceof IncompatibleWorkspaceStateError) return error;
      if (error instanceof SyntaxError)
        return new IncompatibleWorkspaceStateError(
          "invalid-state",
          "原 state.json 无法解析。",
        );
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const events = await readFile(join(directory, "events.jsonl"), "utf8");
        if (events.trim())
          return new IncompatibleWorkspaceStateError(
            "legacy-event-log",
            "检测到没有 v2 快照的旧版或未完成事件日志。",
          );
      } catch (eventError) {
        if ((eventError as NodeJS.ErrnoException).code !== "ENOENT") throw eventError;
      }
      return undefined;
    }
  }
  private async readStateFile(directory: string): Promise<WorkspaceState> {
    const path = join(directory, "state.json"), raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new IncompatibleWorkspaceStateError("invalid-state", "原 state.json 无法解析。");
      throw error;
    }
    if (!record(parsed) || ![2, 3, 4].includes(parsed.version as number)) return validateState(parsed);
    validateShape(structuredClone(parsed), parsed.version as 2 | 3 | 4);
    await backupSnapshot(directory, parsed.version as 2 | 3 | 4, raw);
    const migrated = validateState(parsed);
    await writeAtomic(path, `${JSON.stringify(migrated, null, 2)}\n`);
    return migrated;
  }
  /** Caller must hold the workspace-root lock. Recovery moves `.atte`
   * atomically, so its lock must live beside that directory. */
  private async readUnlocked(): Promise<WorkspaceState> {
    const directory = await this.directory();
    try {
      return await this.readStateFile(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const incompatible = await this.recoveryReason(directory);
      if (incompatible) throw incompatible;
      return initialState();
    }
  }
  async read(): Promise<WorkspaceState> {
    return withLock(await realpath(this.root), () => this.readUnlocked(),
      undefined, { workspaceCompatibility: true });
  }
  async update<T>(reason: string, action: (state: WorkspaceState) => T | Promise<T>): Promise<T> {
    const owner = await realpath(this.root), { directory } = await prepareWorkspaceState(this.root);
    return withLock(owner, async () => {
      const state = await this.readUnlocked(), before = JSON.stringify(state), result = await action(state);
      if (before === JSON.stringify(state)) return result;
      const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`),
        serialized = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, join(directory, "state.json"));
      await Promise.all([
        writeAtomic(join(directory, "decisions.md"), decisionMarkdown(state.decisions, "approved")),
        writeAtomic(join(directory, "rejected.md"), decisionMarkdown(state.decisions, "rejected")),
      ]);
      await compactEventLogIfNeeded(directory);
      await appendFile(join(directory, "events.jsonl"), `${JSON.stringify({
        id: newId("evt"),
        type: "workspace_changed",
        sequence: await nextSequence(directory),
        created_at: new Date().toISOString(),
        title: reason,
        source_task_id: "workspace",
        state_sha256: stateDigest(serialized),
        state_bytes: Buffer.byteLength(serialized),
      })}\n`, { mode: 0o600 });
      return result;
    }, undefined, { workspaceCompatibility: true });
  }
}
