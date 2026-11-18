import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  isSceneOwnership,
  type LocalProcessIdentity, type ProcessProbe, type SceneOwnershipV1, type SceneReferenceV1,
} from "../../../core/src/index.js";
import {
  SessionError, type AgentResumeResult, type BackendDetection, type CloseReceipt,
  type CreateSceneRequest, type CreateSceneResult, type FocusResult, type OwnedSceneMatch,
  type OwnedSceneQuery, type RuntimeConnection, type RuntimeIdentity, type SceneObservation,
  type SendReceipt, type SendSceneRequest, type SessionAdapter,
} from "../contracts.js";
import { atomicJSON, childPath, claimJSON, privateDirectory, readJSON, record, string } from "../io.js";
import { launcherCommand, readLaunchReceipt, receiptProcess } from "../launcher.js";
import { localProcesses, type ProcessInspector } from "../process.js";
import { withControlLock } from "../control/lock.js";
import { startDetachedHerdrServer } from "./server.js";

const exec = promisify(execFile);
type HerdrScene = Extract<SceneReferenceV1, { backend: "herdr" }>;
type PaneLookup =
  | { status: "ok"; panes: Record<string, unknown>[] }
  | { status: "error"; detail: string };
interface PaneProcessInfo {
  shellPid: number;
  processGroupId: number;
  tty?: string;
  foreground: { pid: number; name?: string };
}
interface OwnershipSample {
  info: PaneProcessInfo;
  shell: LocalProcessIdentity;
  launcher: LocalProcessIdentity;
  foreground: LocalProcessIdentity;
}
interface LaunchRecord { request: CreateSceneRequest; result?: CreateSceneResult }
export interface HerdrAdapterOptions {
  executable: string;
  session: string;
  directory: string;
  environment?: NodeJS.ProcessEnv;
  shellEnvironment?: Record<string, string>;
  run?(args: string[], timeout?: number): Promise<string>;
  start?(): Promise<void>;
  processes?: ProcessInspector;
  socketIdentity?(path: string): Promise<string>;
  ownershipSampleDelayMs?: number;
}
const capabilities = { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: true };
function result(raw: string) {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("Herdr 未返回完整 JSON，结果未确认。"); }
  if (!record(data) || data.error) throw new Error("Herdr 返回未知或错误结果。");
  return record(data.result) ? data.result : data;
}
function list(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every(record)) throw new Error(`Herdr 缺少 ${name} 列表。`);
  return value;
}
function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}
function parsePaneProcessInfo(value: unknown): PaneProcessInfo | undefined {
  if (!record(value)) return;
  const info = record(value.process_info) ? value.process_info :
    record(value.processInfo) ? value.processInfo : value;
  const shellPid = positiveInteger(info.shell_pid ?? info.shellPid);
  const processGroupId = positiveInteger(
    info.foreground_process_group_id ?? info.foregroundProcessGroupId);
  if (!shellPid || !processGroupId) return;
  const rawProcesses = info.foreground_processes ?? info.foregroundProcesses;
  if (!Array.isArray(rawProcesses)) return;
  const foreground = [...rawProcesses].reverse().find(item => record(item) &&
    positiveInteger(item.pid));
  if (!record(foreground)) return;
  const pid = positiveInteger(foreground.pid)!;
  const name = typeof foreground.name === "string" && foreground.name.trim() &&
    foreground.name.length <= 240 && !/[\0\r\n]/.test(foreground.name)
    ? foreground.name.trim() : undefined;
  const tty = typeof info.tty === "string" && info.tty.trim() && info.tty.length <= 240 &&
    !/[\0\r\n]/.test(info.tty) ? info.tty.trim() : undefined;
  return { shellPid, processGroupId, ...(tty ? { tty } : {}),
    foreground: { pid, ...(name ? { name } : {}) } };
}
function sameProcess(left: LocalProcessIdentity, right: LocalProcessIdentity) {
  return left.pid === right.pid && left.bornAt === right.bornAt;
}
function sameOwnershipEvidence(left: SceneOwnershipV1, right: SceneOwnershipV1) {
  return left.processGroupId === right.processGroupId && left.tty === right.tty &&
    sameProcess(left.shell, right.shell) && sameProcess(left.launcher, right.launcher) &&
    sameProcess(left.foreground, right.foreground);
}
function sameOwnershipSample(left: OwnershipSample, right: OwnershipSample) {
  return left.info.shellPid === right.info.shellPid &&
    left.info.processGroupId === right.info.processGroupId &&
    left.info.tty === right.info.tty &&
    left.info.foreground.pid === right.info.foreground.pid &&
    sameProcess(left.shell, right.shell) &&
    sameProcess(left.launcher, right.launcher) &&
    sameProcess(left.foreground, right.foreground);
}
function exactOwnership(
  ownership: SceneOwnershipV1, info: PaneProcessInfo,
  probes: [ProcessProbe, ProcessProbe, ProcessProbe],
) {
  return info.shellPid === ownership.shell.pid &&
    info.processGroupId === ownership.processGroupId &&
    info.foreground.pid === ownership.foreground.pid &&
    (ownership.tty === undefined || info.tty === ownership.tty) &&
    probes.every(probe => probe.status === "matched");
}
function allAbsent(probes: ProcessProbe[]) {
  return probes.length > 0 && probes.every(probe => probe.status === "absent");
}
function agentState(agent: Record<string, unknown> | undefined): SceneObservation["state"] {
  const value = agent?.agent_status;
  const spinner = value === "idle" &&
    /[\u2800-\u28ff]/u.test(String(agent?.terminal_title_stripped ?? agent?.terminal_title ?? ""));
  return value === "blocked" ? "blocked" : value === "working" || spinner ? "working" :
    value === "idle" || value === "done" ? "idle" : "unknown";
}
function agentFamily(agent: Record<string, unknown>) {
  return String(agent.agent_kind ?? agent.agent ?? "").trim().toLowerCase();
}
function deliveryFailure(error: unknown) {
  const source = error instanceof Error ? error.message : String(error);
  // Herdr command errors can contain the complete argv, including the user's
  // prompt. Receipts are durable diagnostics, so keep only a bounded,
  // whitelisted interpretation and never copy the command text.
  if (/agent_prompt_stalled/i.test(source))
    return {
      status: "accepted" as const,
      detail: "agent_prompt_stalled: Herdr 已接受本次输入，但未及时观察到 working；不会自动重发。",
    };
  if (/agent_blocked|requires interactive|等待交互/i.test(source))
    return {
      status: "rejected" as const,
      detail: "agent_blocked: Agent 正在等待交互输入；本次输入未发送，请先到原现场处理。",
    };
  if (/agent_not_found|agent target .* not found/i.test(source))
    return {
      status: "rejected" as const,
      detail: "agent_not_found: 目标 Agent 已不可达；本次输入未发送。",
    };
  if (/timeout|timed out/i.test(source))
    return {
      status: "unknown" as const,
      detail: "timeout: Herdr 投递结果确认超时；已保留原请求，不会自动重发。",
    };
  return {
    status: "unknown" as const,
    detail: "delivery_unknown: Herdr 投递失败或结果未确认；已隐藏命令正文，不会自动重发。",
  };
}
export class HerdrAdapter implements SessionAdapter {
  readonly id = "herdr" as const;
  private runtime?: RuntimeIdentity;
  private readonly processes: ProcessInspector;
  constructor(readonly options: HerdrAdapterOptions) { this.processes = options.processes ?? localProcesses; }
  private now() { return new Date().toISOString(); }
  private async raw(args: string[], timeout = 5_000) {
    return this.options.run ? this.options.run(args, timeout) :
      (await exec(this.options.executable, ["--session", this.options.session, ...args], {
        timeout, maxBuffer: 2_000_000,
        env: { ...(this.options.environment ?? process.env), HERDR_SESSION: this.options.session },
      })).stdout;
  }
  private async call(args: string[], timeout?: number) { return result(await this.raw(args, timeout)); }
  private async waitForAgentStart(paneId: string, timeout = 1_500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const agents = list((await this.call(["agent", "list"])).agents, "Agent");
      const status = agents.find(item => item.pane_id === paneId)?.agent_status;
      if (status === "working" || status === "blocked") return true;
      await delay(150);
    }
    return false;
  }
  async detect(): Promise<BackendDetection> {
    try {
      const text = await this.raw(["--version"]);
      const version = /^herdr\s+v?(\d+\.\d+\.\d+)/.exec(text.trim())?.[1];
      if (!version) throw new Error("无法核实 Herdr CLI 版本。");
      return { id: this.id, status: "compatible", version, path: this.options.executable, capabilities };
    } catch (error) {
      return { id: this.id, status: "missing", capabilities,
        detail: error instanceof Error ? error.message : String(error) };
    }
  }
  private async identity(): Promise<RuntimeIdentity> {
    const data = await this.call(["status", "--json"]);
    if (!record(data.server) || data.server.running !== true)
      throw new SessionError("backend_unreachable", "Herdr 当前 Session 未运行。");
    if (data.server.compatible !== true || data.server.session !== this.options.session)
      throw new SessionError("backend_incompatible", "Herdr Session 或协议版本不匹配。");
    const socket = string(data.server.socket, "Herdr socket");
    const identity = this.options.socketIdentity ? await this.options.socketIdentity(socket) : await lstat(socket).then(info => {
      if (!info.isSocket() || process.getuid && info.uid !== process.getuid())
        throw new Error("Herdr Socket 不属于当前用户或不是本机 Socket。");
      return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    });
    return {
      backend: "herdr", id: socket, generation: `${socket}:${identity}`,
      version: string(data.server.version, "Herdr version", 100),
    };
  }
  async connect(input: RuntimeConnection) {
    try { this.runtime = await this.identity(); }
    catch (error) {
      if (!input.startIfMissing || !(error instanceof SessionError) || error.code !== "backend_unreachable") throw error;
      await withControlLock(join(this.options.directory, "server-start"), async () => {
        try { this.runtime = await this.identity(); return; }
        catch (current) {
          if (!(current instanceof SessionError) || current.code !== "backend_unreachable") throw current;
        }
        if (this.options.start) await this.options.start();
        else startDetachedHerdrServer(this.options.executable, this.options.session, input.cwd,
          this.options.environment ?? process.env);
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        try { this.runtime = await this.identity(); return this.runtime; }
        catch (current) {
          if (Date.now() >= deadline) throw current;
          await delay(100);
        }
      }
    }
    return this.runtime;
  }
  private current() {
    if (!this.runtime) throw new SessionError("backend_unreachable", "请先连接 Herdr。");
    return this.runtime;
  }
  private belongsToRuntime(scene: SceneReferenceV1, runtime = this.current()): scene is HerdrScene {
    return scene.backend === "herdr" && scene.runtimeId === runtime.id &&
      scene.locator.session === this.options.session;
  }
  private matchesRuntime(scene: SceneReferenceV1, runtime = this.current()): scene is HerdrScene {
    return this.belongsToRuntime(scene, runtime) && scene.runtimeGeneration === runtime.generation;
  }
  private async probe(identity: LocalProcessIdentity, processGroupId?: number): Promise<ProcessProbe> {
    try {
      return await this.processes.probe(identity, processGroupId);
    } catch {
      return { status: "unverifiable", detail: "process_probe_failed" };
    }
  }
  private async paneProcessInfo(paneId: string): Promise<PaneProcessInfo | undefined> {
    return parsePaneProcessInfo(await this.call(["pane", "process-info", "--pane", paneId]));
  }
  private async ownershipSample(
    paneId: string, launcher: LocalProcessIdentity,
  ): Promise<OwnershipSample | undefined> {
    const info = await this.paneProcessInfo(paneId);
    if (!info) return;
    const shell = await this.processes.identity(info.shellPid);
    const foreground = await this.processes.identity(info.foreground.pid);
    if (!shell || !foreground) return;
    if (foreground.pid === info.shellPid) return;
    const shellProbe = await this.probe(shell);
    const launcherProbe = await this.probe(launcher);
    const foregroundProbe = await this.probe(foreground, info.processGroupId);
    if (shellProbe.status !== "matched" || launcherProbe.status !== "matched" ||
      foregroundProbe.status !== "matched") return;
    return { info, shell, launcher, foreground };
  }
  private async captureOwnership(
    paneId: string, launcher: LocalProcessIdentity,
  ): Promise<SceneOwnershipV1 | undefined> {
    const first = await this.ownershipSample(paneId, launcher);
    if (!first) return;
    await delay(this.options.ownershipSampleDelayMs ?? 250);
    const second = await this.ownershipSample(paneId, launcher);
    if (!second || !sameOwnershipSample(first, second)) return;
    return {
      version: 1, samples: 2, capturedAt: this.now(),
      shell: second.shell, launcher: second.launcher, foreground: second.foreground,
      processGroupId: second.info.processGroupId,
      ...(second.info.tty ? { tty: second.info.tty } : {}),
    };
  }
  private async fromReceipt(input: CreateSceneRequest, requireOwnership = false): Promise<HerdrScene | undefined> {
    const receipt = await readLaunchReceipt(input.receiptPath);
    if (!receipt?.herdr) return;
    if (receipt.requestId !== input.requestId || receipt.bindingId !== input.bindingId ||
      receipt.installationId !== input.installationId || receipt.attemptId !== input.attemptId ||
      receipt.backendEpoch !== input.backendEpoch || receipt.herdr.session !== this.options.session)
      throw new SessionError("scene_identity_mismatch", "Herdr 启动收据不匹配。");
    const launcher = receiptProcess(receipt);
    if ((await this.probe(launcher)).status !== "matched")
      throw new SessionError("scene_identity_mismatch", "Herdr 启动收据的进程身份已改变。");
    const runtime = await this.identity();
    if (runtime.generation !== this.current().generation) throw new SessionError("scene_identity_mismatch", "Herdr 启动时发生重启。");
    const panes = list((await this.call(["pane", "list", "--workspace", receipt.herdr.workspaceId])).panes, "Pane");
    const pane = panes.find(item => (item.pane_id ?? item.id) === receipt.herdr!.paneId);
    if (!pane || pane.tab_id !== receipt.herdr.tabId) throw new SessionError("scene_identity_mismatch", "Herdr 现场已改变。");
    const agent = list((await this.call(["agent", "list"])).agents, "Agent")
      .find(item => item.pane_id === receipt.herdr!.paneId);
    const ownership = requireOwnership
      ? await this.captureOwnership(receipt.herdr.paneId, launcher) : undefined;
    if (requireOwnership && !ownership) return;
    if ((await this.identity()).generation !== runtime.generation)
      throw new SessionError("scene_identity_mismatch", "Herdr 启动确认期间发生重启。");
    return {
      version: 1, backend: "herdr", installationId: input.installationId,
      runtimeId: runtime.id, runtimeGeneration: runtime.generation,
      bindingId: input.bindingId, attemptId: input.attemptId, backendEpoch: input.backendEpoch,
      process: launcher, ...(ownership ? { ownership } : {}), locator: {
        kind: "herdr", ...receipt.herdr, transport: "pane",
        ...(typeof agent?.name === "string" ? { agent: agent.name } : {}),
      },
    };
  }
  async create(input: CreateSceneRequest): Promise<CreateSceneResult> {
    this.current();
    const path = childPath(join(this.options.directory, "launches"), input.requestId);
    const previous = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as LaunchRecord | undefined;
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(input)) throw new SessionError("scene_identity_mismatch", "启动 ID 内容已变化。");
      const expected = previous.result?.scene?.ownership;
      const scene = await this.fromReceipt(input, isSceneOwnership(expected)).catch(() => undefined);
      const recovered = scene && (!isSceneOwnership(expected) ||
        scene.ownership && sameOwnershipEvidence(expected, scene.ownership)) ? scene : undefined;
      return recovered ? { status: "created", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true, scene: recovered } :
        previous.result ?? { status: "unknown", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true };
    }
    if (!await claimJSON(path, { request: input })) return this.create(input);
    let attempted = false;
    try {
      const workspaces = list((await this.call(["workspace", "list"])).workspaces, "Workspace");
      attempted = true;
      const created = await this.call(workspaces.length
        ? ["tab", "create", "--workspace", string(workspaces[0]!.workspace_id ?? workspaces[0]!.id, "Workspace id"),
          "--cwd", input.cwd, "--label", input.title, "--no-focus",
          ...Object.entries(this.options.shellEnvironment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])]
        : ["workspace", "create", "--cwd", input.cwd, "--label", input.title, "--no-focus",
        ...Object.entries(this.options.shellEnvironment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])], 15_000);
      const pane = record(created.root_pane) ? created.root_pane : undefined;
      const paneId = string(pane?.pane_id, "Pane id");
      const command = launcherCommand(input.launcherPath);
      if (Buffer.byteLength(command) > 768) throw new Error("启动器路径过长，未发送命令。");
      // Herdr 0.9.5's input commands acknowledge through exit status and have
      // no stdout JSON. A successful write is still only acceptance.
      await this.raw(["pane", "run", paneId, command], 5_000);
      let scene: HerdrScene | undefined;
      const deadline = Date.now() + 8_000;
      do {
        scene = await this.fromReceipt(input, true);
        if (scene || Date.now() >= deadline) break;
        await delay(100);
      } while (true);
      const result: CreateSceneResult = {
        status: scene ? "created" : "unknown", requestId: input.requestId, recoveryId: input.requestId,
        mayHaveCreated: true, ...(scene ? { scene } : { detail: "启动环境未确认，请核对原现场；未重复创建。" }),
      };
      await atomicJSON(path, { request: input, result });
      return result;
    } catch (error) {
      const result: CreateSceneResult = {
        status: attempted ? "unknown" : "rejected", requestId: input.requestId, recoveryId: input.requestId,
        mayHaveCreated: attempted, detail: error instanceof Error ? error.message : String(error),
      };
      await atomicJSON(path, { request: input, result });
      return result;
    }
  }
  private async inspectOne(
    scene: SceneReferenceV1,
    runtime: RuntimeIdentity,
    agents: Record<string, unknown>[],
    agentsAvailable: boolean,
    paneLookup: PaneLookup | undefined,
    observedAt: string,
  ): Promise<SceneObservation> {
    const observation: SceneObservation = {
      bindingId: scene.bindingId, identity: "unverifiable", reachable: false, state: "unknown",
      ownership: scene.ownership ? "uncertain" : "legacy",
      observedAt, source: "backend",
    };
    if (scene.backend !== "herdr" || scene.locator.kind !== "herdr") {
      return { ...observation, identity: "mismatch", detail: "backend_mismatch" };
    }
    if (scene.runtimeId !== runtime.id || scene.locator.session !== this.options.session) {
      return { ...observation, identity: "mismatch", detail: "runtime_identity_changed" };
    }
    const sameGeneration = scene.runtimeGeneration === runtime.generation;
    const pane = paneLookup?.status === "ok"
      ? paneLookup.panes.find(item => item.pane_id === scene.locator.paneId) : undefined;
    const paneKnown = paneLookup?.status === "ok";
    const paneMissing = paneKnown && !pane;
    const paneMatches = !!pane && pane.tab_id === scene.locator.tabId;
    const agent = agents.find(item => item.pane_id === scene.locator.paneId);
    const ownership = scene.ownership;
    if (ownership) {
      let info: PaneProcessInfo | undefined;
      let processInfoDetail: string | undefined;
      if (paneMatches) {
        try { info = await this.paneProcessInfo(scene.locator.paneId); }
        catch { processInfoDetail = "process_info_unavailable"; }
        if (!info && !processInfoDetail) processInfoDetail = "process_info_incomplete";
      }
      const probes: [ProcessProbe, ProcessProbe, ProcessProbe] = await Promise.all([
        this.probe(ownership.shell),
        this.probe(ownership.launcher),
        this.probe(ownership.foreground, ownership.processGroupId),
      ]);
      const exact = paneMatches && !!info && exactOwnership(ownership, info, probes);
      if (exact) {
        return {
          ...observation, identity: sameGeneration ? "match" : "mismatch",
          reachable: true, state: agentState(agent), ownership: "live",
          ...(sameGeneration ? {} : {
            reanchor: {
              ...scene, runtimeId: runtime.id, runtimeGeneration: runtime.generation,
              process: ownership.launcher,
            },
          }),
          ...(!agentsAvailable ? { detail: "agent_list_unavailable" } : {}),
        };
      }
      if (sameGeneration && paneKnown && paneMissing && allAbsent(probes)) {
        return {
          ...observation, identity: "match", state: "exited", ownership: "ended",
          detail: "confirmed_scene_exit",
        };
      }
      const absent = probes.some(probe => probe.status === "absent");
      const unverifiable = probes.some(probe => probe.status === "unverifiable");
      const allUnverifiable = unverifiable &&
        probes.every(probe => probe.status === "unverifiable");
      const identity = !sameGeneration ? "mismatch" as const :
        paneLookup?.status === "error" ? "unverifiable" as const :
        absent ? "mismatch" as const :
        allUnverifiable ? "unverifiable" as const :
        paneMissing || (pane && !paneMatches) ? "mismatch" as const :
        unverifiable || !info || processInfoDetail ? "unverifiable" as const :
        "mismatch" as const;
      const detail = !sameGeneration ? "runtime_generation_changed_without_stable_ownership" :
        paneLookup?.status === "error" ? paneLookup.detail :
        absent ? "ownership_identity_changed" :
        allUnverifiable ? "ownership_unverifiable" :
        paneMissing ? "owner_processes_not_confirmed_absent" :
        unverifiable ? "ownership_unverifiable" :
        processInfoDetail ?? "ownership_unverifiable";
      return { ...observation, identity, reachable: paneMatches, detail };
    }
    if (!sameGeneration)
      return { ...observation, identity: "mismatch", detail: "legacy_runtime_generation_changed" };
    if (paneLookup?.status === "error")
      return { ...observation, identity: "unverifiable", detail: paneLookup.detail };
    const launcherProbe = scene.process
      ? await this.probe(scene.process) : { status: "unverifiable" as const, detail: "legacy_process_missing" };
    if (paneMissing) {
      if (launcherProbe.status === "absent")
        return { ...observation, identity: "match", state: "exited", detail: "legacy_scene_exited" };
      if (launcherProbe.status === "matched")
        return { ...observation, identity: "mismatch", detail: "legacy_launcher_alive_without_pane" };
      return { ...observation, identity: "unverifiable", detail: launcherProbe.detail ?? "legacy_process_unverifiable" };
    }
    if (!pane || !paneMatches)
      return { ...observation, identity: "mismatch", reachable: false, detail: "legacy_pane_identity_changed" };
    if (launcherProbe.status === "matched") {
      return {
        ...observation, identity: "match", reachable: true, state: agentState(agent),
        ...(!agentsAvailable ? { detail: "agent_list_unavailable" } : {}),
      };
    }
    if (launcherProbe.status === "absent") {
      return {
        ...observation, identity: "unverifiable", reachable: true,
        detail: "legacy_launcher_missing_without_stable_ownership",
      };
    }
    return {
      ...observation, identity: "unverifiable", reachable: true,
      detail: launcherProbe.detail ?? "legacy_process_unverifiable",
    };
  }
  async inspectMany(scenes: SceneReferenceV1[]): Promise<SceneObservation[]> {
    if (!scenes.length) return [];
    const observedAt = this.now();
    const base = (scene: SceneReferenceV1, detail: string): SceneObservation => ({
      bindingId: scene.bindingId, identity: "unverifiable", reachable: false, state: "unknown",
      ownership: scene.ownership ? "uncertain" : "legacy",
      observedAt, source: "backend", detail,
    });
    let runtime: RuntimeIdentity;
    try { runtime = await this.identity(); }
    catch { return scenes.map(scene => base(scene, "runtime_identity_unavailable")); }
    let agents: Record<string, unknown>[] = [], agentsAvailable = true;
    try { agents = list((await this.call(["agent", "list"])).agents, "Agent"); }
    catch { agentsAvailable = false; }
    const lookups = new Map<string, Promise<PaneLookup>>();
    for (const scene of scenes) {
      if (scene.backend !== "herdr" || scene.locator.kind !== "herdr" ||
        scene.runtimeId !== runtime.id || scene.locator.session !== this.options.session) continue;
      const workspace = scene.locator.workspaceId;
      if (!lookups.has(workspace)) {
        lookups.set(workspace, (async () => {
          try {
            return { status: "ok" as const,
              panes: list((await this.call(["pane", "list", "--workspace", workspace])).panes, "Pane") };
          } catch {
            return { status: "error" as const, detail: "pane_lookup_failed" };
          }
        })());
      }
    }
    const observations = await Promise.all(scenes.map(async scene => {
      try {
        const lookup = scene.backend === "herdr" && scene.locator.kind === "herdr" &&
          scene.runtimeId === runtime.id && scene.locator.session === this.options.session
          ? await lookups.get(scene.locator.workspaceId) : undefined;
        return await this.inspectOne(scene, runtime, agents, agentsAvailable, lookup, observedAt);
      } catch {
        return base(scene, "scene_probe_failed");
      }
    }));
    let confirmed: RuntimeIdentity;
    try { confirmed = await this.identity(); }
    catch { return scenes.map(scene => base(scene, "runtime_identity_unavailable")); }
    if (confirmed.id !== runtime.id || confirmed.generation !== runtime.generation)
      return scenes.map(scene => base(scene, "runtime_changed_during_observation"));
    return observations;
  }
  async inspect(scene: SceneReferenceV1) { return (await this.inspectMany([scene]))[0]!; }
  async reanchor(scene: SceneReferenceV1): Promise<SceneReferenceV1 | undefined> {
    if (!scene.ownership || scene.backend !== "herdr") return;
    const first = await this.inspect(scene);
    if (!first.reanchor || first.ownership !== "live") return;
    await delay(this.options.ownershipSampleDelayMs ?? 250);
    const second = await this.inspect(scene);
    if (!second.reanchor || second.ownership !== "live" ||
      !isDeepStrictEqual(first.reanchor, second.reanchor)) return;
    const runtime = await this.identity();
    if (runtime.id !== second.reanchor.runtimeId ||
      runtime.generation !== second.reanchor.runtimeGeneration) return;
    this.runtime = runtime;
    return structuredClone(second.reanchor);
  }
  private async stopProbes(scene: SceneReferenceV1): Promise<ProcessProbe[]> {
    if (scene.ownership) return Promise.all([
      this.probe(scene.ownership.shell),
      this.probe(scene.ownership.launcher),
      this.probe(scene.ownership.foreground, scene.ownership.processGroupId),
    ]);
    return scene.process ? [await this.probe(scene.process)] : [];
  }
  async send(input: SendSceneRequest): Promise<SendReceipt> {
    if (createHash("sha256").update(input.text).digest("hex") !== input.payloadSha256) throw new Error("投递摘要不匹配。");
    const path = childPath(join(this.options.directory, "deliveries"), input.deliveryId);
    const previous = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    if (previous) {
      if (previous.payloadSha256 !== input.payloadSha256 || previous.scene.bindingId !== input.scene.bindingId)
        throw new SessionError("scene_identity_mismatch", "同一投递 ID 不得更换内容或现场。");
      return previous;
    }
    const receipt: SendReceipt = { status: "unknown", deliveryId: input.deliveryId, scene: input.scene, payloadSha256: input.payloadSha256, at: this.now() };
    if (!await claimJSON(path, receipt)) return this.send(input);
    const scene = input.scene, observation = await this.inspect(scene);
    const processVerified = scene.ownership
      ? observation.ownership === "live"
      : !!scene.process && await this.processes.hasChild(scene.process);
    if (!this.matchesRuntime(scene) || observation.identity !== "match" || !observation.reachable ||
      ["blocked", "working", "exited"].includes(observation.state) || !processVerified) {
      receipt.status = "rejected"; receipt.detail = "现场身份、空闲或前台 Agent 无法确认，未发送。";
    } else {
      try {
        const agents = list((await this.call(["agent", "list"])).agents, "Agent");
        const agent = agents.find(item => item.pane_id === scene.locator.paneId);
        const receiptReminder = input.deliveryId.startsWith("receipt-reminder-") &&
          !input.text.includes("\n");
        if (agent) {
          // OMP 18.15 can intercept marker-sized pastes (>10 lines or >1000
          // UTF-16 code units) with an attachment/menu flow. It is not a byte
          // threshold: a case below 12 KB can still be left as a draft. Do
          // not press Enter again or split one logical task into several
          // turns. Hand it a short, bounded reference to the exact private
          // payload instead; its original receipt still hashes the full text.
          let prompt = input.text;
          if (agentFamily(agent) === "omp" &&
            (input.text.length > 1_000 || input.text.split("\n").length > 10)) {
            const directory = await privateDirectory(join(this.options.directory, "payloads"));
            const path = `${childPath(directory, input.deliveryId)}.txt`;
            await writeFile(path, input.text, { mode: 0o600, flag: "wx" });
            prompt = `这是 Atte 的一次受管消息投递，不是 shell 命令。请先用文件读取工具完整读取 ${path}，再按其中的角色、案卷和 Atte CLI 协议执行。不要只回复已读。投递 ID：${input.deliveryId}；正文 SHA-256：${input.payloadSha256}。`;
          }
          if (receiptReminder && agentFamily(agent) === "codex") {
            try {
              await this.raw([
                "agent", "prompt", scene.locator.paneId, prompt,
                "--wait", "--until", "working", "--timeout", "10000",
              ], 12_000);
              receipt.status = "started";
            } catch (error) {
              if (deliveryFailure(error).status !== "accepted") throw error;
              let started = await this.waitForAgentStart(scene.locator.paneId);
              for (let attempt = 0; !started && attempt < 6; attempt++) {
                const current = await this.inspect(scene);
                if (current.identity !== "match" || !current.reachable) break;
                if (["working", "blocked"].includes(current.state)) {
                  started = true;
                  break;
                }
                if (current.state !== "idle") break;
                const visible = await this.raw(["agent", "read", scene.locator.paneId,
                  "--source", "visible", "--lines", "80"], 5_000);
                const sections = visible.split(/(?:^|\n)[ \t]*›[ \t]/u);
                const draft = sections.length > 1 ? sections.at(-1)! : "";
                if (!draft.replace(/\s+/gu, "").includes("Atte未收到目标")) break;
                await this.raw(["agent", "send-keys", scene.locator.paneId, "enter"], 5_000);
                started = await this.waitForAgentStart(scene.locator.paneId);
              }
              receipt.status = started ? "started" : "accepted";
            }
            receipt.detail = receipt.status === "started"
              ? "提醒已通过原负责人 Agent 输入通道送达，并已确认负责人开始处理。"
              : "Herdr 已接受提醒，但未确认开始处理；未重复发送，交给管家核对。";
          } else {
            await this.raw([
              "agent", "prompt", scene.locator.paneId, prompt,
              "--wait", "--until", "working", "--timeout", "10000",
            ], 12_000);
            receipt.status = "started";
          }
        } else {
          await this.raw(["pane", "run", scene.locator.paneId, input.text], 5_000);
          receipt.status = "accepted";
        }
      } catch (error) {
        const failure = deliveryFailure(error);
        receipt.status = failure.status;
        receipt.detail = failure.detail;
      }
    }
    await atomicJSON(path, receipt);
    return receipt;
  }
  async focus(scene: SceneReferenceV1): Promise<FocusResult> {
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" || !observation.reachable)
      return { status: "missing", navigated: false, detail: "未能核实原现场。" };
    try {
      await this.raw(["tab", "focus", scene.locator.tabId]);
      let panes = list((await this.call(["pane", "list", "--workspace", scene.locator.workspaceId])).panes, "Pane");
      if (!panes.some(pane => pane.pane_id === scene.locator.paneId && pane.focused === true)) {
        const agents = list((await this.call(["agent", "list"])).agents, "Agent");
        if (agents.some(agent => agent.pane_id === scene.locator.paneId)) {
          await this.raw(["agent", "focus", scene.locator.paneId]);
          panes = list((await this.call(["pane", "list", "--workspace", scene.locator.workspaceId])).panes, "Pane");
        }
      }
      const focused = panes.some(pane => pane.pane_id === scene.locator.paneId && pane.focused === true);
      return focused ? { status: "focused", navigated: true } :
        { status: "failed", navigated: false, detail: "Herdr 未确认聚焦目标 Pane。" };
    } catch (error) { return { status: "failed", navigated: false, detail: String(error) }; }
  }
  async close(scene: SceneReferenceV1): Promise<CloseReceipt> {
    const receipt: CloseReceipt = { status: "unknown", bindingId: scene.bindingId, at: this.now(), identityVerified: false };
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" ||
      (!scene.ownership && !scene.process)) return receipt;
    receipt.identityVerified = true;
    if (observation.state === "exited" && allAbsent(await this.stopProbes(scene)))
      return { ...receipt, status: "already_stopped" };
    try {
      // The user may have split another pane in this tab. Close only the
      // verified managed pane; Herdr owns empty-tab cleanup.
      await this.raw(["pane", "close", scene.locator.paneId], 10_000);
      const deadline = Date.now() + 3_000;
      while (!allAbsent(await this.stopProbes(scene)) && Date.now() < deadline) await delay(100);
      if (allAbsent(await this.stopProbes(scene))) return { ...receipt, status: "stopped" };
      receipt.detail = "process_stop_unverifiable";
    } catch (error) { receipt.detail = String(error); }
    return receipt;
  }
  async discover(query: OwnedSceneQuery): Promise<OwnedSceneMatch[]> {
    if (query.runtimeId !== this.current().id) return [];
    const directory = join(this.options.directory, "launches");
    const paths = query.requestId ? [childPath(directory, query.requestId)] :
      (await readdir(directory).catch(() => [])).filter(file => file.endsWith(".json")).map(file => join(directory, file));
    const matches: OwnedSceneMatch[] = [];
    for (const path of paths) {
      const value = await readJSON(path) as LaunchRecord;
      if (value.request.installationId !== query.installationId || query.bindingId && value.request.bindingId !== query.bindingId) continue;
      const expected = value.result?.scene?.ownership;
      const scene = await this.fromReceipt(value.request, isSceneOwnership(expected)).catch(() => undefined);
      if (scene && (!isSceneOwnership(expected) ||
        scene.ownership && sameOwnershipEvidence(expected, scene.ownership)))
        matches.push({ requestId: value.request.requestId, scene });
    }
    return matches;
  }
  async captureResume(scene: SceneReferenceV1): Promise<AgentResumeResult> {
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" || !observation.reachable)
      return { status: "unknown", detail: "未能核实原负责人现场，未捕获原生会话身份。" };
    const live = list((await this.call(["agent", "list"])).agents, "Agent")
      .find(item => item.pane_id === scene.locator.paneId);
    if (!live) return { status: "unsupported", detail: "原负责人不是可恢复的受管 Agent。" };
    const raw = live.agent_session;
    if (!record(raw)) return { status: "unsupported", detail: "Agent 未提供原生会话身份。" };
    const source = typeof raw.source === "string" ? raw.source : undefined;
    const agent = typeof raw.agent === "string" ? raw.agent : undefined;
    const value = typeof raw.value === "string" ? raw.value : undefined;
    const kind = raw.kind === "id" || raw.kind === "path" ? raw.kind : undefined;
    if (!source || !agent || !value || !kind || value.length > 4_096)
      return { status: "unknown", detail: "Agent 原生会话身份不完整，不能安全恢复。" };
    return { status: "supported", agent, kind, value };
  }
}
