import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  WorkspaceService, agentRuntimeCapabilities, agentRuntimeSocketPath,
  parseAgentCommand, builtinAgentInstructions, isReadOnlyGoal, ownerSceneReplyInstructions, resumeAgentArgs,
  type AgentRuntimeAdapterId, type Goal, type ManagedSessionContext, type OwnerResume,
  type SceneLaunchIntent,
  type SceneReferenceV1, type SessionBackendId, type WorkspaceState,
  environmentValue, workspaceDataDirectory,
} from "../../core/src/index.js";
import { SessionControl } from "./control/control.js";
import type { BackendControlV1 } from "./control/types.js";
import { SessionError, type SendReceipt, type SessionAdapter } from "./contracts.js";
import { createLaunchFiles, type LaunchFiles } from "./launcher.js";
import { atomicJSON, childPath, readJSON } from "./io.js";
import { caseTask, conciergeIdentityPrompt, goalNotificationPrompt } from "./prompts.js";
import { requestWorkspaceSessionHost } from "./session-host.js";

function adapterId(executable: string): AgentRuntimeAdapterId {
  const name = executable.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^codex(?:$|-)/.test(name)) return "codex";
  if (/^claude(?:$|-)/.test(name)) return "claude-code";
  if (/^cursor(?:$|-)/.test(name)) return "cursor";
  if (/^qoder(?:cli)?$/.test(name)) return "qoder";
  if (/^omp$/.test(name)) return "omp";
  return "custom";
}
function environmentContext(control: BackendControlV1, role: ManagedSessionContext["role"], goalId?: string, attemptId?: string) {
  return {
    installationId: control.installationId, backend: control.selected, epoch: control.epoch,
    scopeGeneration: control.scopeGeneration, role, goalId, attemptId,
  } satisfies ManagedSessionContext;
}
export function managedSessionContext(environment: NodeJS.ProcessEnv): ManagedSessionContext | undefined {
  const raw = environmentValue(environment, "SESSION_CONTEXT");
  if (!raw) return;
  let value: ManagedSessionContext;
  try { value = JSON.parse(raw) as ManagedSessionContext; } catch { throw new Error("受管会话环境损坏。"); }
  if (!value || typeof value !== "object" || !value.installationId || !value.scopeGeneration || value.backend !== "herdr" ||
    !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !["owner", "concierge"].includes(value.role))
    throw new Error("受管会话身份无效。");
  return value;
}
interface StoredLaunch {
  intent: SceneLaunchIntent;
  files: LaunchFiles;
  cwd: string;
  title: string;
  hookTokenHash: string;
  runtimeAdapter: AgentRuntimeAdapterId;
}
export interface SessionRuntimeOptions {
  control: SessionControl;
  workspace: string;
  adapter(backend: SessionBackendId, workspace: string): Promise<SessionAdapter>;
  cliDirectory: string;
  managedContext?: ManagedSessionContext;
  environment?: NodeJS.ProcessEnv;
  prepareHost?: () => Promise<void>;
  /** Only the desktop sets this; it is never inferred from Agent environment. */
  hostExecution?: boolean;
}
/** Desktop and standalone CLI use this exact launch/send implementation.
 * This layer coordinates transport receipts; core alone owns business facts. */
export class SessionRuntime {
  readonly service: WorkspaceService;
  private readonly adapters = new Map<string, Promise<{ adapter: SessionAdapter; control: BackendControlV1 }>>();
  constructor(readonly options: SessionRuntimeOptions) { this.service = new WorkspaceService(options.workspace); }
  private launchPath(id: string) { return childPath(join(this.options.control.directory, "runtime-launches"), id); }
  private assertWorkspace(state: WorkspaceState, control: BackendControlV1) {
    const binding = state.backendBinding;
    if (!binding || binding.backend !== "herdr" || binding.status !== "active" ||
      binding.installationId !== control.installationId || binding.epoch !== control.epoch ||
      binding.scopeGeneration !== control.scopeGeneration)
      throw new SessionError("stale_backend_epoch", "工作区不属于当前 Herdr 控制面；历史现场保持只读。");
    const managed = this.options.managedContext;
    if (managed && (managed.backend !== "herdr" || !["concierge", "owner"].includes(managed.role) ||
      managed.installationId !== control.installationId || managed.epoch !== control.epoch ||
      managed.scopeGeneration !== control.scopeGeneration))
      throw new SessionError("stale_backend_epoch", "受管会话身份已撤销。");
  }
  private assertGoal(goal: Goal, access: "read" | "execute" = "execute") {
    if (isReadOnlyGoal(goal) || goal.scene?.backend === "orca" || goal.agentRuntime?.attempt.scene?.backend === "orca")
      throw new SessionError("scene_read_only", "旧后端或只读历史目标不能启动、恢复或操作负责人。");
    if (access === "execute" && goal.executionHold)
      throw new Error("goal_confirmation_required: 旧实验目标必须先由人确认是否继续。");
  }
  private assertScene(state: WorkspaceState, scene: SceneReferenceV1, control: BackendControlV1,
    access: "read" | "execute" = "read") {
    this.assertWorkspace(state, control);
    if (scene.backend !== "herdr" || scene.locator.kind !== "herdr")
      throw new SessionError("backend_unsupported", "仅支持 Herdr，旧后端现场保持只读。");
    if (scene.installationId !== control.installationId || scene.backendEpoch !== control.epoch)
      throw new SessionError("stale_backend_epoch", "现场不属于当前 Herdr 安装与代次。");
    const goal = state.goals.find(item => item.scene?.bindingId === scene.bindingId);
    if (goal) this.assertGoal(goal, access);
    const registered = goal?.scene ?? (state.concierge.scene?.bindingId === scene.bindingId ? state.concierge.scene : undefined);
    if (!registered || !isDeepStrictEqual(scene, registered))
      throw new SessionError("scene_identity_mismatch", "操作目标不属于当前工作区中已登记的真实现场。");
    return { goal, role: goal ? "owner" as const : "concierge" as const };
  }
  private async adapter(startIfMissing = false) {
    const control = await this.options.control.status();
    if (control.selected !== "herdr")
      throw new SessionError("backend_unsupported", "仅支持 Herdr 会话。");
    const key = `${control.selected}:${control.epoch}:${control.scopeGeneration}`;
    let pending = this.adapters.get(key);
    if (!pending) {
      pending = (async () => ({
        adapter: await this.options.adapter(control.selected, this.options.workspace),
        control,
      }))();
      this.adapters.set(key, pending);
    }
    const value = await pending;
    if (value.adapter.id !== "herdr")
      throw new SessionError("backend_unsupported", "仅支持 Herdr Adapter。");
    const identity = await value.adapter.connect({
      installationId: control.installationId,
      cwd: this.options.workspace,
      startIfMissing,
    });
    if (identity.backend !== "herdr")
      throw new SessionError("backend_unsupported", "连接的运行时不是 Herdr。");
    return { adapter: value.adapter, control };
  }
  private async prepareLaunch(input: {
    role: "concierge" | "owner"; goal?: Goal; name: string;
  }, control: BackendControlV1) {
    await this.options.prepareHost?.();
    const managed = this.options.managedContext;
    if (managed) {
      if (managed.role !== "concierge")
        throw new SessionError("scene_identity_mismatch", "只有受管管家可以启动负责人。");
      if (input.role === "concierge" || !input.goal || managed.goalId !== input.goal.id)
        throw new SessionError("scene_identity_mismatch", "只能为当前案卷启动负责人。");
      if (managed.backend !== control.selected || managed.epoch !== control.epoch ||
        managed.scopeGeneration !== control.scopeGeneration)
        throw new SessionError("stale_backend_epoch", "管家启动身份已撤销。");
    }
    const state = await this.service.read(), goal = input.goal;
    const intent: SceneLaunchIntent = {
      requestId: randomUUID(), bindingId: randomUUID(), attemptId: randomUUID(),
      backendEpoch: control.epoch, role: input.role, agent: input.name,
      status: "prepared", createdAt: new Date().toISOString(),
    };
    const configured = input.role === "concierge" ? state.agents?.concierge ?? "codex" :
      state.agents?.owner || state.agents?.concierge || "codex";
    const command = parseAgentCommand(configured, []);
    const resume = input.role === "owner" ? goal?.ownerResume?.agentSession : undefined;
    // Native session metadata must not replace a configured alias, wrapper,
    // model flags or credential environment with another executable.
    const nativeName = command.executable.split("/").at(-1);
    const restored = resume && nativeName === resume.agent ? resumeAgentArgs(resume) : undefined;
    if (restored) command.args = [...command.args, ...restored];
    const home = this.options.environment?.HOME ?? process.env.HOME ?? "";
    const executable = command.executable.startsWith("~/") ? join(home, command.executable.slice(2)) : command.executable;
    const project = goal && state.projects.find(item => item.id === goal.projectId);
    const cwd = await realpath(project?.path || this.options.workspace);
    const context = environmentContext(control, input.role, goal?.id, intent.attemptId);
    const hookToken = randomBytes(32).toString("hex");
    const environment: Record<string, string> = {
      ATTE_WORKSPACE: this.options.workspace,
      ATTE_AGENT_NAME: input.name, ATTE_ROLE: input.role,
      ATTE_SESSION_CONTEXT: JSON.stringify(context),
      ATTE_BACKEND: control.selected, ATTE_BACKEND_EPOCH: String(control.epoch),
      ATTE_CONTROL_DIRECTORY: this.options.control.directory,
      ATTE_CLI_DIRECTORY: this.options.cliDirectory,
      PATH: this.options.cliDirectory,
      ...(input.role === "concierge" ? {
        ATTE_COORDINATOR: "1",
        ATTE_COORDINATOR_SCOPE_FILE: join(workspaceDataDirectory(this.options.workspace), "coordinator-scope.json"),
      } : {}),
      ...(goal ? {
        ATTE_GOAL_ID: goal.id, ATTE_ATTEMPT_ID: intent.attemptId,
        ATTE_HOOK_TOKEN: hookToken, ATTE_HOOK_SOCKET: agentRuntimeSocketPath(this.options.workspace),
        ATTE_HOOK_SPOOL: join(workspaceDataDirectory(this.options.workspace), "runtime", "spool"),
      } : {}),
    };
    for (const [key, value] of Object.entries({ ...environment }))
      if (key.startsWith("ATTE_")) environment[`CREWVANE_${key.slice(5)}`] = value;
    // Keep test or explicit host configuration; never copy credentials or
    // inject CLI permission/model flags.
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME", "HOST_SOCKET", "HOST_TOKEN"]) {
      const value = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME"].includes(key)
        ? this.options.environment?.[key] : environmentValue(this.options.environment ?? {}, key);
      const target = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME"].includes(key) ? key : `ATTE_${key}`;
      if (value) environment[target] = value;
      if (value && target.startsWith("ATTE_")) {
        environment[target] = value;
        environment[`CREWVANE_${target.slice(5)}`] = value;
      }
    }
    const binary = environmentValue(this.options.environment ?? {}, "HERDR_BINARY") ??
      (await (await this.options.adapter("herdr", this.options.workspace)).detect()).path;
    if (binary) {
      environment.ATTE_HERDR_BINARY = binary;
      environment.CREWVANE_HERDR_BINARY = binary;
    }
    const files = await createLaunchFiles(this.options.control.directory, {
      ...intent, installationId: control.installationId, cwd, executable, args: command.args, environment,
    });
    const launch: StoredLaunch = {
      intent, files, cwd, title: input.role === "concierge" ? "Atte · 管家" : `Atte · ${goal!.title.slice(0, 60)}`,
      hookTokenHash: createHash("sha256").update(hookToken).digest("hex"), runtimeAdapter: adapterId(executable),
    };
    await atomicJSON(this.launchPath(intent.requestId), launch);
    return launch;
  }
  private async create(launch: StoredLaunch, adapter: SessionAdapter, control: BackendControlV1,
    goalId?: string) {
    if (!["concierge", "owner"].includes(launch.intent.role))
      throw new SessionError("backend_unsupported", "只支持管家和负责人。");
    const request = {
      requestId: launch.intent.requestId, bindingId: launch.intent.bindingId, attemptId: launch.intent.attemptId,
      installationId: control.installationId, backendEpoch: control.epoch,
      role: launch.intent.role as "concierge" | "owner", goalId, cwd: launch.cwd, title: launch.title, ...launch.files,
    };
    const created = await this.options.control.operation({
      workspace: this.options.workspace, requestId: request.requestId, kind: "create",
      role: request.role, goalId,
      admit: async current => {
        if (current.installationId !== control.installationId || current.epoch !== launch.intent.backendEpoch ||
          current.scopeGeneration !== control.scopeGeneration)
          throw new SessionError("stale_backend_epoch", "启动身份已改变，未创建现场。");
        await this.service.execute({ type: "scene.prepare", goalId, intent: launch.intent });
        if (goalId && launch.intent.role === "owner") {
          await this.service.execute({
            type: "agent.runtime.register", goalId,
            attempt: { goalId, attemptId: launch.intent.attemptId, agent: launch.intent.agent,
              adapter: launch.runtimeAdapter, startedAt: launch.intent.createdAt },
            hookTokenHash: launch.hookTokenHash,
            capabilities: agentRuntimeCapabilities(launch.runtimeAdapter),
          });
        }
      },
    }, async () => adapter.create(request), async result => {
      this.assertWorkspace(await this.service.read(), control);
      if (result.scene && (result.scene.backend !== "herdr" || result.scene.installationId !== control.installationId ||
        result.scene.backendEpoch !== control.epoch || result.scene.bindingId !== request.bindingId ||
        result.scene.attemptId !== request.attemptId))
        throw new SessionError("scene_identity_mismatch", "启动回执与当前 Herdr 请求不匹配。");
      if (result.scene) await this.service.execute({
        type: "scene.bind", goalId, scene: result.scene, role: launch.intent.role,
      });
      await this.service.execute({
        type: "scene.launch.result", goalId, role: launch.intent.role, requestId: request.requestId,
        status: result.status === "created" ? "created" : result.status === "rejected" ? "rejected" : "unconfirmed",
        detail: result.detail,
      });
    });
    if (!created.scene) throw new SessionError("launch_unconfirmed", created.detail ?? "启动结果未确认；请核对原请求，不重复创建。");
    // An environment receipt precedes the Agent child. Do not type a task into
    // the launcher's shell while the configured CLI is still starting.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const observation = await adapter.inspect(created.scene);
      if (observation.identity === "match" && observation.state === "exited") {
        // A verified exit is a failed launch, not an uncertain delivery. Clean
        // this attempt up so a retry cannot deadlock on its own dead scene; the
        // retired attempt stays visible in attemptHistory.
        if (goalId && launch.intent.role === "owner")
          await this.service.execute({ type: "scene.retire", goalId,
            bindingId: created.scene.bindingId, attemptId: created.scene.attemptId }).catch(() => {});
        else if (launch.intent.role === "concierge")
          await this.service.execute({ type: "scene.release",
            bindingId: created.scene.bindingId }).catch(() => {});
        throw new SessionError("launch_failed",
          `${launch.intent.role === "concierge" ? "管家" : "负责人"}启动后立即退出（可能是 Agent CLI 崩溃，例如 EPIPE）。本次现场已清理，可直接重试。`);
      }
      if (observation.identity !== "match")
        throw new SessionError("launch_unconfirmed", "启动程序未保持存活；已保留原现场和请求，未重新创建。");
      if (observation.reachable && ["idle", "working", "blocked"].includes(observation.state)) break;
      // Arbitrary interactive CLIs may not expose a lifecycle state. The
      // launcher receipt and live foreground process still prove that a
      // terminal exists; allow its raw-input handshake to settle without
      // blocking every custom launch for the full 15 second uncertainty window.
      if (observation.reachable && observation.state === "unknown" &&
        Date.now() - Date.parse(launch.intent.createdAt) >= 1_800) break;
      if (Date.now() >= deadline) break; // An unknown custom CLI may have no lifecycle.
      await delay(250);
    }
    return created.scene;
  }
  private async recoverIntent(intent: SceneLaunchIntent, goalId?: string) {
    const state = await this.service.read(), current = await this.options.control.status();
    this.assertWorkspace(state, current);
    if (intent.backendEpoch !== current.epoch || !["concierge", "owner"].includes(intent.role))
      throw new SessionError("stale_backend_epoch", "原启动请求已退休，不能恢复或重建现场。");
    if (goalId) {
      const goal = state.goals.find(item => item.id === goalId);
      if (!goal) throw new Error("目标不存在。");
      this.assertGoal(goal);
    }
    const { adapter, control } = await this.adapter();
    const discovered = await adapter.discover({ installationId: control.installationId,
      runtimeId: (await adapter.connect({ installationId: control.installationId, cwd: this.options.workspace })).id,
      requestId: intent.requestId });
    if (discovered.length === 1) {
      const scene = discovered[0]!.scene;
      if (scene.backend !== "herdr" || scene.installationId !== control.installationId ||
        scene.backendEpoch !== control.epoch || scene.bindingId !== intent.bindingId || scene.attemptId !== intent.attemptId)
        throw new SessionError("scene_identity_mismatch", "原启动请求的现场身份不匹配。");
      await this.service.execute({ type: "scene.bind", goalId, role: intent.role, scene });
      return scene;
    }
    throw new SessionError("launch_unconfirmed", "原启动请求未确认；已保留记录，不能自动再建一个现场。");
  }
  private async initializeConcierge(scene: SceneReferenceV1) {
    const state = await this.service.read();
    if (state.concierge.initializedAttemptId === scene.attemptId) {
      if (state.concierge.status !== "ready" || state.concierge.detail)
        await this.service.execute({
          type: "scene.concierge.status", status: "ready", initializedAttemptId: scene.attemptId,
        });
      return scene;
    }
    const { adapter } = await this.adapter();
    const waitIdle = async (allowUnknown = false) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const observation = await adapter.inspect(scene);
        if (observation.identity !== "match" || observation.state === "exited")
          throw new SessionError("scene_identity_mismatch", "管家初始化时现场身份已改变。");
        if (observation.reachable && observation.state === "idle") return;
        if (allowUnknown && observation.reachable && observation.state === "unknown") return;
        if (observation.state === "blocked" || Date.now() >= deadline)
          throw new SessionError("delivery_unconfirmed", "管家尚未结束初始化或正在等待授权，请打开原现场核对；未重复发送。");
        await delay(250);
      }
    };
    const id = `identity-${scene.attemptId}`;
    const path = childPath(join(this.options.control.directory, "runtime-deliveries"), id);
    let receipt = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    if (!receipt) {
      await waitIdle(true);
      receipt = await this.send(scene, id, conciergeIdentityPrompt(this.options.workspace, state.agents));
    }
    if (!["started", "accepted"].includes(receipt.status))
      throw new SessionError("delivery_unconfirmed", receipt.detail ?? "管家身份初始化尚未确认；请核对原现场，未重复发送。");
    await waitIdle(receipt.status === "accepted");
    await this.service.execute({ type: "scene.concierge.status", status: "ready", initializedAttemptId: scene.attemptId });
    return scene;
  }
  async prepareConcierge() {
    const state = await this.service.read();
    this.assertWorkspace(state, await this.options.control.status());
    if (state.concierge.scene) {
      this.assertScene(state, state.concierge.scene, await this.options.control.status());
      const { adapter } = await this.adapter();
      const observation = await adapter.inspect(state.concierge.scene);
      if (observation.identity !== "match") throw new SessionError("scene_identity_mismatch", "管家运行时已改变，请重新核实现场。");
      if (observation.state !== "exited") return this.initializeConcierge(state.concierge.scene);
      await this.service.execute({ type: "scene.release", bindingId: state.concierge.scene.bindingId });
    } else if (state.concierge.legacyScene)
      throw new SessionError("scene_identity_mismatch", "旧管家现场尚未核实；不能静默创建第二位管家。");
    if (state.concierge.launch && !state.concierge.scene && state.concierge.launch.status !== "rejected")
      return this.initializeConcierge(await this.recoverIntent(state.concierge.launch));
    const { adapter, control } = await this.adapter(true);
    const launch = await this.prepareLaunch({ role: "concierge", name: "concierge" }, control);
    const scene = await this.create(launch, adapter, control);
    return this.initializeConcierge(scene);
  }
  async launchOwner(input: { goalId: string; name: string; role?: "owner"; task?: string; taskFile?: string;
    consultationOnly?: boolean }) {
    if (input.role && input.role !== "owner")
      throw new SessionError("backend_unsupported", "仅支持负责人启动。");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name)) throw new Error("负责人名称只能包含小写英文字母、数字、下划线和短横线，以字母开头。");
    const state = await this.service.read(), goal = state.goals.find(item => item.id === input.goalId);
    this.assertWorkspace(state, await this.options.control.status());
    if (!goal || goal.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(goal.status))
      throw new Error("当前事项不能启动负责人。");
    this.assertGoal(goal);
    if (this.options.managedContext && (this.options.managedContext.role !== "concierge" ||
      this.options.managedContext.goalId !== goal.id))
      throw new SessionError("scene_identity_mismatch", "只能为当前案卷启动负责人。");
    if (goal.legacyScene && !goal.scene)
      throw new SessionError("scene_identity_mismatch", "旧负责人现场尚未核实，不能创建第二个负责人。");
    if (goal.scene) this.assertScene(state, goal.scene, await this.options.control.status());
    if (this.options.managedContext && !this.options.hostExecution) {
      const host = await requestWorkspaceSessionHost(this.options.workspace, {
        context: this.options.managedContext, operation: "launch", input,
      });
      if (host.handled) return host.result as {
        goalId: string; runtime: string; scene: SceneReferenceV1; receipt?: SendReceipt; warning?: string;
      };
    }
    if (goal.scene) {
      // A dead terminal keeps its reference on purpose: it is evidence until
      // someone verifies that the process is gone. Re-verify here so a crashed
      // owner can be replaced by a new attempt without hand-editing state.
      const { adapter: current } = await this.adapter();
      const observed = await current.inspect(goal.scene);
      if (observed.identity !== "match" || observed.state !== "exited")
        throw new Error("目标已有负责人现场；请使用 owner send 联系原负责人。若原负责人已退出，请先在目标详情恢复现场。");
      await this.service.execute({
        type: "scene.retire", goalId: goal.id,
        bindingId: goal.scene.bindingId, attemptId: goal.scene.attemptId,
      });
      delete goal.scene;
      delete goal.sceneLaunch;
      delete goal.agentRuntime;
    }
    const candidateIntent = goal.sceneLaunch;
    const existingIntent = candidateIntent?.status === "rejected" ? undefined : candidateIntent;
    if (existingIntent) {
      const scene = await this.recoverIntent(existingIntent, goal.id);
      return { goalId: goal.id, runtime: state.agents?.owner || state.agents?.concierge || "codex", scene,
        warning: "已核实原现场；原投递结果需另行核对，未重复发送任务。" };
    }
    const { adapter, control } = await this.adapter(true);
    const launch = await this.prepareLaunch({ role: "owner", goal, name: input.name }, control);
    let task = input.task;
    if (input.taskFile) {
      if (task) throw new Error("--task 与 --task-file 不能同时使用。");
      const path = await realpath(input.taskFile), base = await realpath(this.options.workspace);
      const pathInWorkspace = relative(base, path);
      if (!pathInWorkspace || pathInWorkspace.startsWith("..") || (await stat(path)).size > 100_000)
        throw new Error("任务文件必须位于当前工作区内，且不超过 100 KB。");
      task = await readFile(path, "utf8");
    }
    if (task && task.length > 100_000) throw new Error("任务说明超长。");
    const scene = await this.create(launch, adapter, control, goal.id);
    const instructions = builtinAgentInstructions(goal, "owner");
    const prompt = input.consultationOnly
      ? `${instructions}\n当前目标处于决定、验收或等待。只读取 goal show ${goal.id} 的问题与已有证据，等待用户答复；不得开始实现、解掉注意力或变更状态。\n${ownerSceneReplyInstructions(goal.id)}`
      : `${instructions}\n${task ?? caseTask(this.options.workspace, goal, "owner")}\n${ownerSceneReplyInstructions(goal.id)}`;
    const receipt = await this.send(scene, `task-${launch.intent.requestId}`, prompt);
    return { goalId: goal.id, runtime: state.agents?.owner || state.agents?.concierge || "codex", scene, receipt,
      ...(["accepted", "unknown"].includes(receipt.status) ? { warning: "任务送达后尚未观察到开始；已保留原现场，不自动重发。" } : {}) };
  }
  async send(scene: SceneReferenceV1, deliveryId: string, text: string): Promise<SendReceipt> {
    const state = await this.service.read(), control = await this.options.control.status();
    const { goal, role } = this.assertScene(state, scene, control, "execute");
    const managed = this.options.managedContext;
    if (managed && (managed.role !== "concierge" || !goal || managed.goalId !== goal.id))
      throw new SessionError("scene_identity_mismatch", "只能向当前案卷负责人发送协调消息。");
    if (this.options.managedContext && !this.options.hostExecution) {
      const host = await requestWorkspaceSessionHost(this.options.workspace, {
        context: this.options.managedContext, operation: "send", input: { scene, deliveryId, text },
      });
      if (host.handled) return host.result as SendReceipt;
    }
    // Watchdog correlation IDs can include ISO timestamps. Keep a bounded,
    // stable encoding for filesystem and control-operation keys.
    if (!/^[a-zA-Z0-9_-]{1,140}$/.test(deliveryId))
      deliveryId = `delivery-${createHash("sha256").update(deliveryId).digest("hex")}`;
    const receiptPath = childPath(join(this.options.control.directory, "runtime-deliveries"), deliveryId);
    const previous = await readJSON(receiptPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    const payloadSha256 = createHash("sha256").update(text).digest("hex");
    if (previous) {
      if (previous.payloadSha256 !== payloadSha256 || !isDeepStrictEqual(previous.scene, scene))
        throw new SessionError("scene_identity_mismatch", "原投递不能更换正文或现场。");
      return previous;
    }
    const { adapter } = await this.adapter();
    const result = await this.options.control.operation({
      workspace: this.options.workspace, requestId: `delivery-${deliveryId}`, kind: "send",
      bindingId: scene.bindingId, role, goalId: goal?.id,
      admit: async current => { this.assertScene(await this.service.read(), scene, current, "execute"); },
    }, () => adapter.send({ scene, deliveryId, text, payloadSha256 }),
    async receipt => {
      this.assertScene(await this.service.read(), scene, control, "execute");
      await atomicJSON(receiptPath, receipt);
    });
    return result;
  }
  async notifyGoal(goal: Goal, note?: string, _authority?: never, deliveryId?: string) {
    const state = await this.service.read();
    const current = state.goals.find(item => item.id === goal.id);
    if (!current) throw new Error("目标不存在。");
    this.assertWorkspace(state, await this.options.control.status());
    this.assertGoal(current);
    const scene = await this.prepareConcierge();
    const observation = (await this.inspect([scene]))[0];
    if (observation?.identity === "match" && ["working", "blocked"].includes(observation.state))
      throw new SessionError("backend_busy", "管家仍在处理上一回合或等待现场授权；通知保留在队列中，尚未发送。");
    const receipt = await this.send(scene, deliveryId ?? goal.dispatch?.id ?? randomUUID(),
      await goalNotificationPrompt(this.options.workspace, current, note));
    if (receipt.status === "rejected") throw new Error(receipt.detail ?? "管家未接受消息。");
    return { scene, receipt };
  }
  async focus(scene: SceneReferenceV1) {
    this.assertScene(await this.service.read(), scene, await this.options.control.status());
    const { adapter } = await this.adapter();
    const result = await adapter.focus(scene);
    if (result.status !== "focused" || !result.navigated) throw new SessionError("focus_failed", result.detail ?? "未能定位原现场。");
    return result;
  }
  /** Explicit user recovery only. A disconnected or replaced runtime is never
   * enough evidence to retire a possibly working scene. */
  async recoverOwnerForConsultation(goalId: string) {
    const state = await this.service.read(), goal = state.goals.find(item => item.id === goalId);
    const control = await this.options.control.status();
    this.assertWorkspace(state, control);
    if (!goal || goal.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(goal.status))
      throw new Error("该事项当前不能恢复现场。");
    this.assertGoal(goal);
    const scene = goal.scene;
    if (scene) {
      this.assertScene(state, scene, control);
      const { adapter } = await this.adapter();
      const observed = await adapter.inspect(scene);
      if (observed.identity === "match" && observed.reachable && observed.state !== "exited")
        return { scene };
      if (observed.identity !== "match" || observed.state !== "exited")
        throw new SessionError("scene_identity_mismatch", "原现场尚未确认停止；未创建新负责人，请重新连接或核实原现场。");
      await this.service.execute({ type: "scene.retire", goalId,
        bindingId: scene.bindingId, attemptId: scene.attemptId });
    }
    return this.launchOwner({ goalId, name: `owner-${goalId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()}`,
      consultationOnly: true });
  }
  async close(scene: SceneReferenceV1, goalId?: string) {
    const registered = this.assertScene(await this.service.read(), scene, await this.options.control.status(), "execute");
    if (goalId && registered.goal?.id !== goalId)
      throw new SessionError("scene_identity_mismatch", "关闭目标与登记的负责人现场不一致。");
    const { adapter } = await this.adapter();
    const receipt = await this.options.control.operation({
      workspace: this.options.workspace, requestId: `close-${scene.bindingId}-${randomUUID()}`, kind: "close",
      bindingId: scene.bindingId, goalId: registered.goal?.id, role: registered.role,
      admit: async current => { this.assertScene(await this.service.read(), scene, current, "execute"); },
    }, () => adapter.close(scene), async () => {
      this.assertScene(await this.service.read(), scene, await this.options.control.status(), "execute");
    });
    if (!receipt.identityVerified || receipt.status === "unknown")
      throw new SessionError("scene_identity_mismatch", receipt.detail ?? "现场停止未确认。");
    await this.service.execute({ type: "scene.release", bindingId: scene.bindingId, goalId });
    return receipt;
  }
  async captureOwnerResume(goalId: string, scene: SceneReferenceV1): Promise<OwnerResume | undefined> {
    const state = await this.service.read();
    const registered = this.assertScene(state, scene, await this.options.control.status());
    if (registered.goal?.id !== goalId)
      throw new SessionError("scene_identity_mismatch", "恢复记录与登记的负责人现场不一致。");
    const { adapter } = await this.adapter();
    const result = await adapter.captureResume(scene);
    if (result.status !== "supported") return undefined;
    const goal = state.goals.find(item => item.id === goalId);
    if (!goal) throw new Error("目标不存在。");
    const project = state.projects.find(item => item.id === goal.projectId);
    const cwd = project?.path || this.options.workspace;
    const resume = {
      owner: goal.owner || scene.locator.kind === "herdr" && scene.locator.agent || "owner",
      cwd,
      savedAt: new Date().toISOString(),
      agentSession: {
        source: `${scene.backend}:${result.agent}`,
        agent: result.agent,
        kind: result.kind,
        value: result.value,
      },
    } satisfies OwnerResume;
    await this.service.execute({
      type: ["completed", "dropped"].includes(goal.status) ? "session.preserve" : "session.resume.capture",
      goalId,
      resume,
    });
    return resume;
  }
  async inspect(scenes: SceneReferenceV1[]) {
    if (!scenes.length) return [];
    const state = await this.service.read(), control = await this.options.control.status();
    for (const scene of scenes) this.assertScene(state, scene, control);
    const { adapter } = await this.adapter();
    return adapter.inspectMany(scenes);
  }
}
