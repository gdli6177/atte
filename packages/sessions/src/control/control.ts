import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceService, isReadOnlyGoal } from "../../../core/src/index.js";
import { SessionError } from "../contracts.js";
import { atomicJSON, childPath, readJSON, record } from "../io.js";
import { localProcesses } from "../process.js";
import { withControlLock } from "./lock.js";
import type { BackendControlV1, OperationLease, WorkspaceRegistration } from "./types.js";

function readyBinding(control: BackendControlV1) {
  return {
    installationId: control.installationId, backend: control.selected,
    epoch: control.epoch, scopeGeneration: control.scopeGeneration, status: "active" as const,
  };
}
function configuration(value: unknown) {
  if (!record(value) || value.version !== 1 || !["herdr", "orca"].includes(String(value.selected)) ||
    !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0 ||
    typeof value.installationId !== "string" || !value.installationId.trim() ||
    typeof value.scopeGeneration !== "string" || !value.scopeGeneration.trim() ||
    !["ready", "switching", "recovery_required"].includes(String(value.phase)))
    throw new SessionError("backend_configuration_invalid", "会话控制配置损坏，已阻止现场操作。");
  return value;
}
export class SessionControl {
  constructor(readonly directory: string) {}
  private get controlPath() { return join(this.directory, "backend.json"); }
  private get registryPath() { return join(this.directory, "workspaces.json"); }
  private async load(): Promise<BackendControlV1> {
    const value = configuration(await readJSON(this.controlPath));
    if (value.selected !== "herdr" || value.phase !== "ready" || value.maintenance !== undefined)
      throw new SessionError("backend_configuration_invalid", "请先初始化 Herdr 会话控制配置。");
    return {
      version: 1, installationId: value.installationId as string, selected: "herdr",
      epoch: value.epoch as number, scopeGeneration: value.scopeGeneration as string, phase: "ready",
    };
  }
  async initialize(_options: { recoverInterrupted?: boolean } = {}) {
    return withControlLock(this.directory, async () => {
      let value: ReturnType<typeof configuration>;
      try { value = configuration(await readJSON(this.controlPath)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const control: BackendControlV1 = {
          version: 1, installationId: randomUUID(), selected: "herdr", epoch: 0,
          scopeGeneration: randomUUID(), phase: "ready",
        };
        await atomicJSON(this.controlPath, control);
        return control;
      }
      const invalidate = value.selected !== "herdr" || value.phase !== "ready" || value.maintenance !== undefined;
      if (invalidate && value.epoch === Number.MAX_SAFE_INTEGER)
        throw new SessionError("backend_configuration_invalid", "会话代次已超出可安全升级的范围。");
      const control: BackendControlV1 = {
        version: 1, installationId: value.installationId as string, selected: "herdr",
        epoch: (value.epoch as number) + (invalidate ? 1 : 0),
        scopeGeneration: invalidate ? randomUUID() : value.scopeGeneration as string, phase: "ready",
      };
      if (JSON.stringify(value) !== JSON.stringify(control)) await atomicJSON(this.controlPath, control);
      return control;
    });
  }
  async status() { return this.load(); }
  async registrations(): Promise<WorkspaceRegistration[]> {
    const value = await readJSON(this.registryPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (!Array.isArray(value) || value.some(item => !record(item) || typeof item.root !== "string" || typeof item.registeredAt !== "string"))
      throw new SessionError("backend_configuration_invalid", "工作区注册表损坏，无法确认受管资源。");
    return value as WorkspaceRegistration[];
  }
  async registerWorkspace(path: string) {
    const root = await realpath(path);
    return withControlLock(this.directory, async () => {
      const control = await this.load();
      const entries = await this.registrations();
      const service = new WorkspaceService(root), state = await service.read();
      const binding = state.backendBinding;
      if (!binding)
        await service.execute({ type: "backend.register", binding: readyBinding(control) });
      else if (binding.backend === "orca") {
        // A synthetic v5 snapshot can still carry Orca history. Never rewrite
        // it into Herdr; the goals remain read-only and cannot execute.
      } else if (binding.backend !== "herdr" || binding.installationId !== control.installationId)
        throw new SessionError(
          "backend_installation_mismatch",
          "工作区属于另一个 Atte 安装，不能自动接管旧后端；请先备份工作区并核对原安装。",
        );
      else if (binding.epoch !== control.epoch ||
        binding.scopeGeneration !== control.scopeGeneration || binding.status !== "active")
        await service.execute({ type: "backend.recover-stale", binding: readyBinding(control) });
      if (!entries.some(entry => entry.root === root)) {
        entries.push({ root, registeredAt: new Date().toISOString() });
        await atomicJSON(this.registryPath, entries.sort((left, right) => left.root.localeCompare(right.root)));
      }
      return control;
    });
  }
  async canDispatch() {
    await this.load();
    return true;
  }
  async operation<T>(input: {
    workspace: string;
    requestId: string;
    kind: OperationLease["kind"];
    bindingId?: string;
    goalId?: string;
    role?: OperationLease["role"];
    leaseMs?: number;
    admit?(control: BackendControlV1): Promise<void>;
  }, perform: (control: BackendControlV1) => Promise<T>, commit?: (result: T, control: BackendControlV1) => Promise<void>) {
    const workspace = await realpath(input.workspace);
    const path = childPath(join(this.directory, "leases"), input.requestId);
    const initial = await withControlLock(this.directory, async () => {
      const control = await this.load();
      const state = await new WorkspaceService(workspace).read(), binding = state.backendBinding;
      if (!binding || binding.backend !== "herdr" || binding.installationId !== control.installationId ||
        binding.epoch !== control.epoch || binding.scopeGeneration !== control.scopeGeneration || binding.status !== "active")
        throw new SessionError("stale_backend_epoch", "工作区不属于当前 Herdr 控制面，历史现场保持只读。");
      if (input.role && !["concierge", "owner"].includes(input.role))
        throw new SessionError("backend_unsupported", "只支持管家和负责人的 Herdr 会话。");
      if (input.goalId) {
        const goal = state.goals.find(item => item.id === input.goalId);
        if (!goal || isReadOnlyGoal(goal))
          throw new SessionError("scene_read_only", "历史目标不能执行现场操作。");
      }
      const previous = await readJSON(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      });
      if (previous)
        throw new SessionError("delivery_unconfirmed", "该请求已有执行记录，请核对原回执，不能重新执行。");
      const owner = await localProcesses.identity(process.pid);
      if (!owner) throw new Error("无法核实控制进程身份。");
      await input.admit?.(control);
      const lease: OperationLease = {
        id: randomUUID(), requestId: input.requestId, workspace, backend: "herdr",
        epoch: control.epoch, kind: input.kind, bindingId: input.bindingId,
        goalId: input.goalId, role: input.role, owner,
        startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (input.leaseMs ?? 40_000)).toISOString(), status: "running",
      };
      await atomicJSON(path, lease);
      return { control, lease };
    });
    try {
      const result = await perform(initial.control);
      await withControlLock(this.directory, async () => {
        const control = await this.load();
        if (control.installationId !== initial.control.installationId || control.epoch !== initial.control.epoch ||
          control.scopeGeneration !== initial.control.scopeGeneration)
          throw new SessionError("stale_backend_epoch", "现场操作返回时身份已改变，未写入陈旧绑定。");
        await commit?.(result, control);
        await atomicJSON(path, { ...initial.lease, status: "finished" });
      });
      return result;
    } catch (error) {
      await withControlLock(this.directory, () => atomicJSON(path, { ...initial.lease, status: "unknown" }));
      throw error;
    }
  }
}
