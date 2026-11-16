import {
  WorkspaceService,
  attentionGoals,
  attentionRequest,
  importAttachmentFiles,
  workspaceDataDirectory,
  type AtteCommand,
  type GoalAttachment,
  type IntakeHandling,
  type HighRiskCategory,
} from "../../packages/core/src/index.js";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { runBoard } from "./board.js";
import { attachOwner } from "./owner-attach.js";
import { ingestAgentHook } from "./hook-ingest.js";
import { readHookDiagnostics } from "./hook-diagnostics.js";
import { readHookInput } from "./hook-input.js";
import {
  SessionControl,
  SessionRuntime,
  localAdapter,
  managedSessionContext,
  type SendReceipt,
} from "../../packages/sessions/src/index.js";
import { environmentValue } from "../../packages/core/src/index.js";
const exec = promisify(execFile);
declare const __ATTE_VERSION__: string | undefined;
const cliVersion = typeof __ATTE_VERSION__ === "string" ? __ATTE_VERSION__ : "0.0.0-dev";
async function doctorReport(service: WorkspaceService) {
  const state = await service.read(), directory = workspaceDataDirectory(service.root);
  const size = async (name: string) =>
    await stat(join(directory, name)).then(info => info.size).catch(() => 0);
  const inbox = await readFile(join(directory, "coordinator-inbox.json"), "utf8")
    .then(raw => JSON.parse(raw) as { items?: Array<{ status?: string; goalId?: string;
      requestId?: string; kind?: string; detail?: string; finishedAt?: string }> })
    .catch(() => undefined);
  const counts: Record<string, number> = { total: inbox?.items?.length ?? 0 };
  for (const item of inbox?.items ?? []) counts[item.status ?? "unknown"] = (counts[item.status ?? "unknown"] ?? 0) + 1;
  const issues = state.goals.flatMap(goal => {
    const items: Array<{ goalId: string; title: string; kind: string; detail: string }> = [];
    if (goal.attention?.kind === "intervention")
      items.push({ goalId: goal.id, title: goal.title, kind: "attention", detail: goal.attention.summary });
    if (goal.dispatch && ["failed", "unconfirmed"].includes(goal.dispatch.status))
      items.push({ goalId: goal.id, title: goal.title, kind: `dispatch_${goal.dispatch.status}`,
        detail: goal.dispatch.detail ?? "派发结果未确认" });
    if (goal.live?.reachable === false)
      items.push({ goalId: goal.id, title: goal.title, kind: "scene_unreachable",
        detail: `负责人现场不可达（最后核对 ${goal.live.checkedAt}）` });
    if (goal.agentRuntime?.receipt?.reminderError)
      items.push({ goalId: goal.id, title: goal.title, kind: "reminder_error",
        detail: goal.agentRuntime.receipt.reminderError });
    if (goal.watchdog?.lastError)
      items.push({ goalId: goal.id, title: goal.title, kind: "watchdog_error", detail: goal.watchdog.lastError });
    return items;
  }).slice(-10);
  const hookDiagnostics = readHookDiagnostics(service.root);
  return {
    version: cliVersion,
    workspace: service.root,
    backend: state.backendBinding ? {
      selected: state.backendBinding.backend,
      epoch: state.backendBinding.epoch,
    } : null,
    state: {
      goals: state.goals.length,
      open: state.goals.filter(goal => !["completed", "dropped", "backlog"].includes(goal.status)).length,
      attention: attentionGoals(state.goals).length,
      bytes: await size("state.json"),
      eventsBytes: await size("events.jsonl"),
    },
    inbox: counts,
    deadScenes: state.goals
      .filter(goal => goal.live?.reachable === false && (goal.scene || goal.herdr))
      .map(goal => ({
        goalId: goal.id, title: goal.title,
        backend: goal.scene?.backend ?? "herdr",
        attemptId: goal.scene?.attemptId,
        pid: goal.scene?.process?.pid,
        paneId: goal.herdr?.paneId,
        checkedAt: goal.live?.checkedAt,
      })),
    issues,
    hookDiagnostics,
  };
}
async function managedRuntime(workspace: string, managedContext: ReturnType<typeof managedSessionContext>) {
  const directory = environmentValue(process.env, "CONTROL_DIRECTORY")?.trim();
  if (!directory) throw new Error("受管 CLI 缺少 Atte 后端控制目录；请从 Atte 桌面或已接入的负责人现场运行。");
  const control = new SessionControl(directory);
  // A managed Agent may be unable to inspect OS processes. The desktop owns
  // admission/identity checks; its current descriptor is discovered below.
  if (!managedContext) await control.initialize();
  const cliDirectory = environmentValue(process.env, "CLI_DIRECTORY")?.trim();
  if (!cliDirectory) throw new Error("受管 CLI 缺少可执行的 Atte 命令目录。");
  return new SessionRuntime({
    control,
    workspace,
    managedContext,
    cliDirectory,
    environment: process.env,
    adapter: async (backend, adapterWorkspace) => localAdapter({
      backend,
      workspace: adapterWorkspace,
      control: await control.status(),
      directory,
      herdrExecutable: environmentValue(process.env, "HERDR_BINARY"),
      environment: process.env,
      state: await new WorkspaceService(adapterWorkspace).read(),
    }),
  });
}
const usage = `Atte — The attention layer

人的消息入口（保存原话，不从文本推断批准或完成）：
  atte status [--json]
  atte doctor [--json]（只读：版本、后端、状态库、收件箱积压与异常现场）
  atte delivery REQUEST_ID [--json]（查询一次协调投递的当前状态）
  atte attention [--json]
  atte board [--new] [--once]
  atte scene focus [GOAL_ID]（只定位已登记现场；省略 ID 回到管家）
  atte ask TEXT [--project ID] [--attachment PATH ...]
  atte capture TEXT [--project ID] [--remind-at ISO]
    [--attachment PATH ...]（先记下；明确交给管家后才执行）
  atte goal start ID --by self|concierge
  atte goal restore ID（将移出的个人事项恢复到待办池）
  atte direct TEXT [--new] [--goal ID] [--project ID]
    [--handling concierge|later]（只适用于新事项）
    [--attachment PATH ...]
  atte goal list [--all] [--json]
  atte goal show ID [--json]
  atte goal message ID --text TEXT [--attachment PATH ...]
  atte goal scene-reply ID --attention-id ID --quote "用户现场原话"
    --summary "现场已如何处理" [--json]

Agent 状态协议（仅在明确事实发生后使用）：
  atte hook ingest --adapter codex|claude-code|cursor|qoder|omp [--json]
    （由受管 Agent Hook 调用；普通 Agent 会话无目标环境时 no-op）
  atte event herdr [--json]
  atte goal create --title TEXT [--project ID] [--description TEXT]
    [--kind delivery|discovery]
  atte goal kind ID --kind delivery|discovery
  atte goal update ID [--title TEXT] [--description TEXT] [--next TEXT]
    [--owner TEXT] [--status active|waiting] [--waiting-for 外部第三方] [--remind-at ISO]
  atte goal progress ID --summary TEXT [--next TEXT] [--owner NAME]
  atte goal wait ID --reason TEXT --owner 外部第三方 [--remind-at ISO]
  atte goal decide ID --question TEXT [--next TEXT] [--key KEY]
  atte goal risk ID --category CATEGORY --summary TEXT [--key KEY]
  atte goal ship ID --operation merge|deploy --checks passed|failed
  atte goal review ID --summary TEXT [--location TEXT] [--url URL]
    --check "名称::命令或操作::passed::说明"（可重复）
    [--candidate-revision REV] [--candidate-digest SHA256] [--evidence-file PATH]
  atte goal accept ID [--note TEXT]
  atte goal complete ID --note "用户明确确认完成的原话"
  atte goal rework ID --note TEXT
  atte goal resolve ID --note TEXT [--outcome approved|rejected]
  atte goal drop ID --reason TEXT
  atte goal remind ID --at ISO [--note TEXT]
    状态命令可用 --attention-id ID --scene-reply-id ID 防止旧回执覆盖新问题
  atte session set ID [--workspace ID] [--tab ID] [--pane ID] [--agent NAME]
    [--transport pane --process-id PID]（自定义 CLI）
  atte owner launch ID --name NAME [--task TEXT | --task-file FILE]
    创建隔离的负责人现场；省略任务内容时读取目标详情与下一步
  atte owner send ID --text TEXT
    向当前目标已核实的原负责人现场发送一条协调消息
  atte owner attach ID --name NAME --session SESSION
    --workspace ID --tab ID --pane ID [--agent NAME] [--recovery-id ID]
    在核对 Herdr 真实现场后，恢复并绑定 owner launch 未确认的负责人

使用 --root DIR 或 ATTE_WORKSPACE 指定工作区（兼容读取 CREWVANE_WORKSPACE）。所有读写与桌面共用状态。
goal message 与 direct 不按正文推断状态。交给管家处理的外部等待会恢复 active，待管家重新核定；next 保留。
waiting 只表示等待用户和所有 Agent 之外的具名外部第三方。需要用户处理请用 decide；内部协调保持 active。remind 不改变生命周期。
高风险动作类别：delete-data、stop-service、spend-money、external-message、
product-direction、create-secret、rotate-secret、change-permissions、change-ship-policy。
goal ship 只按项目策略给出放行或审批判断；外部动作仍由负责人执行并核实。
`;
function parse(argv: string[]) {
  const positional: string[] = [], values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (!name) throw new Error("无效参数");
    if (["json", "all", "help", "new", "once", "current", "self", "initialize"].includes(name)) { values.set(name, ["true"]); continue; }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`--${name} 需要一个值`);
    if (values.has(name) && !["check", "attachment", "criterion", "from", "project", "operation", "evidence", "role", "arg", "approve-script"].includes(name)) throw new Error(`--${name} 不能重复`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positional, one: (name: string) => values.get(name)?.[0], all: (name: string) => values.get(name) ?? [], has: (name: string) => values.has(name) };
}
function hookJsonRequested(argv: string[]) {
  return argv.some(token => token === "--json" || token === "--json=true");
}
async function hookIngestFailOpen(
  argv: string[],
  io: { out: (value: string) => void; error: (value: string) => void },
) {
  let args: ReturnType<typeof parse> | undefined;
  let reason: string | undefined;
  try {
    args = parse(argv);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  let result: unknown;
  try {
    result = await ingestAgentHook({
      adapter: args?.one("adapter") ?? "",
      stdin: () => readHookInput(),
    });
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (result && typeof result === "object" && "reason" in result &&
    typeof result.reason === "string")
    reason = result.reason;
  if (args?.has("json") || hookJsonRequested(argv))
    io.out(JSON.stringify(reason ? { accepted: false, reason, result } : { accepted: true, result }));
  // Agent lifecycle Hooks are observational. Failure is fail-open and must
  // never prevent the Agent from starting, running or stopping.
  return 0;
}
function checks(values: string[]) {
  if (!values.length) throw new Error("至少提供一个 --check，记录实际运行的检查");
  return values.map((value) => {
    const [name, command, result, ...note] = value.split("::");
    if (!name || !command || !["passed", "failed"].includes(result ?? "")) throw new Error("--check 格式：名称::命令或操作::passed|failed::说明");
    return { name, command, result: result as "passed" | "failed", ...(note.length ? { note: note.join("::") } : {}) };
  });
}
class RetiredCommandError extends Error {
  readonly code = "feature_removed";
}
function rejectRetiredCommand(args: ReturnType<typeof parse>) {
  const [group, action] = args.positional;
  const retiredGroup = ["skill", "autonomy", "release", "bot", "verifier", "backend"].includes(group ?? "");
  const retiredGoal = group === "goal" && [
    "brief", "checkpoint", "verify", "boundary", "boundary-resolve", "autonomy", "reopen",
  ].includes(action ?? "");
  const retiredParameter = ["acceptance", "release-on-merge", "max-recovery-attempts",
    "no-progress-minutes", "continuation", "lease", "workflow", "stage", "worker",
    "approve-script"].some(name => args.has(name));
  const retiredCreation = (group === "capture" && args.has("self")) ||
    (group === "direct" && args.one("handling") === "self") ||
    (group === "goal" && action === "kind" && args.one("kind") === "release") ||
    (group === "goal" && action === "create" &&
      (args.one("mode") === "manual" || args.one("kind") === "release"));
  if (retiredGroup || retiredGoal || retiredParameter || retiredCreation ||
    (group === "project" && action === "autonomy") ||
    args.one("role") === "verifier" || environmentValue(process.env, "ROLE") === "verifier")
    throw new RetiredCommandError(
      "该功能已在 Atte 0.14 移除。先记下用 capture，执行用 ask / owner launch，" +
      "进展用 goal progress，交付用 goal review，由人验收；发布继续使用 goal ship 检查项目策略。" +
      "接管已有事项可用 goal start ID --by self。",
    );
}
function textArg(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}
export function assertOwnerSendReceipt(receipt: SendReceipt): SendReceipt {
  if (receipt.status === "rejected")
    throw new Error(`负责人现场拒绝本次消息：${receipt.detail?.trim() || "未提供原因"}`);
  return receipt;
}
async function jsonFile(path: string | undefined, label: string): Promise<unknown> {
  if (!path?.trim()) throw new Error(`需要 ${label} 文件路径`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}
async function coordinatorCaseId(allowMissing = false) {
  if (environmentValue(process.env, "COORDINATOR") !== "1") return;
  const file = environmentValue(process.env, "COORDINATOR_SCOPE_FILE");
  if (!file) throw new Error("管家缺少当前案卷范围，请重新准备管家");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return;
    if (error.code === "ENOENT")
      throw new Error("管家当前没有案卷范围；只有 atte direct --new 可以直接建立新目标");
    throw error;
  });
  if (!raw) return;
  const value = JSON.parse(raw) as { goalId?: unknown };
  if (typeof value.goalId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.goalId))
    throw new Error("管家当前案卷范围无效，请重新准备管家");
  const context = value as { goalId: string; attentionId?: string; sceneReplyId?: string };
  for (const token of [context.attentionId, context.sceneReplyId])
    if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(token)))
      throw new Error("管家现场回执范围无效，请重新派发");
  return context;
}
async function advanceCoordinatorCase(goal: { id: string; dispatch?: { id?: string } }) {
  const file = environmentValue(process.env, "COORDINATOR_SCOPE_FILE");
  if (!file) throw new Error("管家缺少案卷范围文件，无法继续直接新建的目标");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    goalId: goal.id,
    requestId: goal.dispatch?.id,
    setAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
function assertCoordinatorCase(caseId: string, target: string | undefined) {
  if (!target) throw new Error("管家操作必须指定当前案卷目标 ID");
  if (target !== caseId) throw new Error(`管家当前只处理目标 ${caseId}，不能读取或修改其他目标`);
}
function herdrLiveEvent() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) throw new Error("缺少 Herdr 插件事件");
  let value: any;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Herdr 插件事件不是有效 JSON"); }
  const data = value?.data;
  if (!data || typeof data !== "object") throw new Error("Herdr 插件事件缺少 data");
  const rawKind = String(value.event ?? value.type ?? "").trim();
  const legacyKinds: Record<string, string> = {
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
    pane_moved: "pane.moved",
    tab_closed: "tab.closed",
    workspace_closed: "workspace.closed",
  };
  const kind = legacyKinds[rawKind] ?? rawKind;
  const targetId = (name: "pane" | "tab" | "workspace") => {
    const id = data[`${name}_id`];
    if (typeof id !== "string" || !id)
      throw new Error(`Herdr 插件事件缺少有效 ${name === "pane" ? "Pane" : name === "tab" ? "Tab" : "Workspace"} ID`);
    return id;
  };
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const workspaceId = typeof data.workspace_id === "string" ? data.workspace_id : undefined;
  const checkedAt = new Date().toISOString();
  if (kind === "pane.agent_status_changed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    const state = typeof data.agent_status === "string" ? data.agent_status.toLowerCase() : "";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(state))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    const agentName = typeof data.agent_name === "string" ? data.agent_name : undefined;
    return {
      kind,
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      ...(agentName ? { reference: { paneId, ...(workspaceId ? { workspaceId } : {}), agent: agentName } } : {}),
      presence: { state: state as "working" | "idle" | "done" | "blocked" | "unknown", checkedAt, reachable: true },
    };
  }
  if (kind === "pane.exited" || kind === "pane.closed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    return {
      kind,
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  }
  if (kind === "pane.moved") {
    const previousPaneId = typeof data.previous_pane_id === "string" ? data.previous_pane_id : "";
    const previousWorkspaceId = typeof data.previous_workspace_id === "string" ? data.previous_workspace_id : undefined;
    const pane = data.pane;
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(previousPaneId) ||
      !pane || typeof pane !== "object")
      throw new Error("Herdr 插件事件缺少有效的 Pane 移动信息");
    const newPaneId = typeof pane.pane_id === "string" ? pane.pane_id : "";
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(newPaneId))
      throw new Error("Herdr 插件事件缺少有效的新 Pane ID");
    const status = typeof pane.agent_status === "string" ? pane.agent_status.toLowerCase() : "unknown";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(status))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    return {
      kind,
      target: { paneId: previousPaneId, ...(previousWorkspaceId ? { workspaceId: previousWorkspaceId } : {}) },
      reference: {
        paneId: newPaneId,
        ...(typeof pane.workspace_id === "string" ? { workspaceId: pane.workspace_id } : {}),
        ...(typeof pane.tab_id === "string" ? { tabId: pane.tab_id } : {}),
        ...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
      },
      presence: {
        state: status as "working" | "idle" | "done" | "blocked" | "unknown",
        checkedAt, reachable: true,
      },
    };
  }
  if (kind === "tab.closed")
    return {
      kind,
      target: { tabId: targetId("tab"), ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  if (kind === "workspace.closed")
    return {
      kind,
      target: { workspaceId: targetId("workspace") },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  throw new Error(`不支持的 Herdr 插件事件：${kind}`);
}
async function currentHerdrAgent(paneId: string) {
  const injected = environmentValue(process.env, "HERDR_PLUGIN_AGENT")?.trim();
  if (injected) return injected;
  const session = process.env.HERDR_SESSION?.trim();
  if (!session) return undefined;
  const binary = environmentValue(process.env, "HERDR_BINARY")?.trim() ||
    process.env.HERDR_BIN_PATH?.trim() || "herdr";
  try {
    const { stdout } = await exec(binary, ["--session", session, "agent", "list"], {
      timeout: 5_000,
      maxBuffer: 512_000,
    });
    const value = JSON.parse(stdout) as any;
    const list = value.result?.agents ?? value.agents ?? value;
    const entry = Array.isArray(list)
      ? list.find((agent: any) => agent?.pane_id === paneId)
      : undefined;
    const name = entry?.name ?? entry?.agent_name ?? entry?.agent;
    return typeof name === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}
export async function run(argv: string[], io = { out: console.log, error: console.error }): Promise<number> {
  if (argv[0] === "hook" && argv[1] === "ingest")
    return hookIngestFailOpen(argv, io);
  try {
    const args = parse(argv), [group, action, target] = args.positional;
    if (args.has("help") || !group) { io.out(usage); return 0; }
    rejectRetiredCommand(args);
    const managedAgentName = environmentValue(process.env, "AGENT_NAME")?.trim(),
      workspaceRoot = args.one("root") ?? (environmentValue(process.env, "WORKSPACE")?.trim() || process.cwd()),
      sessionContext = managedSessionContext(process.env),
      coordinatorMode = environmentValue(process.env, "COORDINATOR") === "1",
      coordinatorContext = await coordinatorCaseId(group === "direct" && args.has("new")),
      coordinatorCase = coordinatorContext?.goalId,
      managedContext = sessionContext?.role === "concierge"
        ? { ...sessionContext, goalId: coordinatorCase }
        : sessionContext,
      service = new WorkspaceService(workspaceRoot, managedContext),
      actor = args.one("actor") ?? (managedAgentName || undefined);
    const managedAgent = coordinatorMode || Boolean(managedAgentName);
    const requireHumanCli = () => {
      if (managedAgent)
        throw new Error("该命令只能由人通过桌面或普通终端执行，受管 Agent 不能调用");
    };
    if (group === "scene" && action === "focus") {
      requireHumanCli();
      const state = await service.read();
      const scene = target ? state.goals.find(item => item.id === target)?.scene : state.concierge.scene;
      if (!scene) throw new Error("现场尚未登记或需要重新核实，请先在桌面恢复现场。");
      const focused = await (await managedRuntime(workspaceRoot, managedContext)).focus(scene);
      io.out(args.has("json") ? JSON.stringify(focused) : "已定位原现场。");
      return 0;
    }
    let command: AtteCommand | undefined, result: unknown, coordinatorRead = false,
      ownerLaunch: {
        name: string;
        task?: string;
        taskFile?: string;
        role?: "owner";
      } | undefined;
    let ownerSend: { text: string } | undefined;
    if (group === "board" && !coordinatorCase) {
      await runBoard(service, io, {
        once: args.has("once"), startWithNewGoal: args.has("new"),
        focusScene: async goalId => {
          const state = await service.read();
          const scene = goalId ? state.goals.find(item => item.id === goalId)?.scene : state.concierge.scene;
          if (!scene) throw new Error("现场尚未登记或需要重新核实，请先在桌面恢复现场。");
          await (await managedRuntime(service.root, sessionContext)).focus(scene);
        },
      });
      return 0;
    }
    if (coordinatorMode && !coordinatorCase) {
      if (group !== "direct" || !args.has("new"))
        throw new Error("管家当前没有案卷范围；只有 atte direct --new 可以直接建立新目标");
    } else if (coordinatorCase) {
      if (group === "status") {
        const state = await service.read(), goal = state.goals.find(item => item.id === coordinatorCase);
        if (!goal) throw new Error("当前案卷不存在或已结束");
        result = {
          name: state.name, agents: state.agents ?? { concierge: "codex" },
          project: state.projects.find(project => project.id === goal.projectId),
          goal: {
            id: goal.id, title: goal.title, status: goal.status, next: goal.next,
            owner: goal.owner, attention: goal.attention ?? null,
            dispatch: goal.dispatch ?? null, watchdog: goal.watchdog ?? null,
            scene: goal.scene ? {
              bindingId: goal.scene.bindingId, backend: goal.scene.backend,
              attemptId: goal.scene.attemptId, pid: goal.scene.process?.pid,
            } : null,
            live: goal.live ?? null,
          },
        };
        coordinatorRead = true;
      } else if (group === "doctor") {
        // Read-only diagnostics; no case is selected or changed.
      } else if (group === "delivery") {
        // Read-only receipt lookup, limited to the current case below.
      } else if (group === "goal" && action === "show") {
        const goalId = target ?? args.one("id");
        assertCoordinatorCase(coordinatorCase, goalId);
        result = (await service.read()).goals.find(goal => goal.id === goalId);
        if (!result) throw new Error("找不到当前案卷");
        coordinatorRead = true;
      } else if (group === "goal" && [
        "update", "progress", "wait", "decide", "risk", "ship",
        "kind",
        "complete", "rework", "drop", "resolve", "remind", "scene-reply",
      ].includes(action ?? "")) {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "session" && action === "set") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "launch") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "send") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "attach") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "direct") {
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (!args.has("new"))
          assertCoordinatorCase(coordinatorCase, args.one("goal") ?? coordinatorCase);
      } else throw new Error("管家当前只能查看或更新自己的案卷，不能执行该命令");
    }
    if (!coordinatorRead) {
      if (group === "status") result = await service.read();
      else if (group === "doctor") result = await doctorReport(service);
      else if (group === "delivery") {
        const requestId = args.positional[1];
        if (!requestId) throw new Error("请提供要查询的 requestId");
        const raw = await readFile(join(workspaceDataDirectory(service.root), "coordinator-inbox.json"), "utf8")
          .catch(() => { throw new Error("当前工作区还没有协调收件箱记录"); });
        const inbox = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
        const matches = (inbox.items ?? []).filter(item => item.requestId === requestId);
        if (coordinatorCase && matches.some(item => item.goalId !== coordinatorCase))
          throw new Error("只能查询当前案卷的投递");
        if (!matches.length) throw new Error(`没有找到请求 ${requestId} 的投递记录`);
        result = matches.map(item => ({ id: item.id, goalId: item.goalId, requestId: item.requestId,
          kind: item.kind, status: item.status, enqueuedAt: item.enqueuedAt,
          finishedAt: item.finishedAt, attempts: item.attempts, detail: item.detail }));
      }
      else if (group === "attention") result = attentionGoals((await service.read()).goals);
      else if (group === "ask") {
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = { type: "goal.intake", text: args.positional.slice(1).join(" "), projectId: args.one("project"), ...(attachments.length ? { attachments } : {}) };
      }
      else if (group === "capture") {
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = { type: "goal.intake", text: args.positional.slice(1).join(" "),
          projectId: args.one("project"), handling: "later",
          remindAt: args.one("remind-at"), ...(attachments.length ? { attachments } : {}) };
      }
      else if (group === "direct") {
        const directText = args.positional.slice(1).join(" ").trim();
        if (!directText) throw new Error("需要一个要同步给管家的终端消息");
        if (args.has("next"))
          throw new Error("direct 只同步人的原话，不修改下一步；状态更新请使用明确命令");
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (args.has("current") && !coordinatorCase)
          throw new Error("--current 只能由当前受管管家使用");
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = {
          type: "goal.direct",
          text: directText,
          goalId: args.has("new") ? undefined
            : args.has("current") ? coordinatorCase : args.one("goal") ?? coordinatorCase,
          projectId: args.one("project"),
          handling: args.one("handling") as IntakeHandling | undefined,
          ...(attachments.length ? { attachments } : {}),
        };
      }
      else if (group === "event" && action === "herdr") {
        const { kind, ...event } = herdrLiveEvent();
        void kind;
        const target = event.target as { paneId?: string; workspaceId?: string };
        if (
          event.presence.reachable !== false &&
          !event.reference?.agent &&
          target.paneId
        ) {
          const agent = await currentHerdrAgent(target.paneId);
          if (agent)
            event.reference = {
              ...(event.reference ?? {}),
              paneId: target.paneId,
              agent,
            };
        }
        result = await service.execute({ type: "live.event", ...event });
      }
      else if (group === "goal" && action === "list") { const state = await service.read(); result = args.has("all") ? state.goals : state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)); }
      else if (group === "goal" && action === "show") { const goalId = target ?? args.one("id"); if (!goalId) throw new Error("需要目标 ID"); result = (await service.read()).goals.find((goal) => goal.id === goalId); if (!result) throw new Error("找不到目标"); }
      else if (group === "goal" && action === "start") {
        const by = args.one("by");
        if (by !== "self" && by !== "concierge") throw new Error("--by 必须是 self 或 concierge");
        command = { type: by === "self" ? "goal.takeover" : "goal.delegate", goalId: target! };
      }
      else if (group === "goal" && action === "restore") command = { type: "goal.restore", goalId: target! };
      else if (group === "goal" && action === "create") {
        if (args.has("workflow")) throw new Error("工序已移除；请在目标说明中直接写清工作要求");
        command = {
          type: "goal.create",
          input: {
            title: args.one("title")!,
            projectId: args.one("project") ?? "personal",
            description: args.one("description"),
            kind: args.one("kind") as "delivery" | "discovery" | undefined,
            mode: (args.one("mode") ?? "concierge") as "concierge" | "manual",
            next: args.one("next"),
            waitingFor: args.one("owner"),
            remindAt: args.one("remind-at"),
          },
        };
      }
      else if (group === "goal" && action === "kind")
        command = {
          type: "goal.kind.set",
          goalId: target!,
          kind: textArg(args.one("kind"), "--kind") as "delivery" | "discovery",
          actor,
        };
      else if (group === "goal" && action === "update") command = { type: "goal.update", goalId: target!, patch: {
        ...(args.has("stage") ? (() => { throw new Error("工序已移除；请直接更新目标下一步"); })() : {}),
        title: args.one("title"), description: args.one("description"), next: args.one("next"),
        owner: args.one("owner"),
        waitingFor: args.one("waiting-for"),
        status: args.one("status") as "active" | "waiting" | undefined,
        remindAt: args.one("remind-at"),
      } };
      else if (group === "goal" && action === "progress") {
        if (args.has("stage")) throw new Error("工序已移除；请直接写清当前实际结果和下一步");
        command = { type: "goal.progress", goalId: target!, summary: args.one("summary")!, next: args.one("next"), actor: actor ?? args.one("owner") };
      }
      else if (group === "goal" && action === "message") {
        const message = textArg(args.one("text"), "--text");
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = {
          type: "goal.message", goalId: target!, text: message,
          ...(attachments.length ? { attachments } : {}),
        };
      }
      else if (group === "goal" && action === "scene-reply") command = {
        type: "goal.scene-reply", goalId: target!,
        attentionId: textArg(args.one("attention-id"), "--attention-id"),
        quote: textArg(args.one("quote"), "--quote"),
        summary: textArg(args.one("summary"), "--summary"),
        actor: textArg(actor, "已登记的 Agent 身份"),
      };
      else if (group === "goal" && action === "wait") command = { type: "goal.wait", goalId: target!, reason: args.one("reason")!, owner: args.one("owner"), remindAt: args.one("remind-at"), actor };
      else if (group === "goal" && action === "decide") command = { type: "goal.decide", goalId: target!, question: args.one("question")!, next: args.one("next"), actor, key: args.one("key") };
      else if (group === "goal" && action === "risk") command = {
        type: "goal.risk", goalId: target!, category: args.one("category") as HighRiskCategory,
        summary: args.one("summary")!, actionKey: args.one("key"), actor,
      };
      else if (group === "goal" && action === "ship") {
        const checksPassed = args.one("checks");
        if (checksPassed !== "passed" && checksPassed !== "failed")
          throw new Error("--checks 必须是 passed 或 failed");
        command = {
          type: "goal.ship", goalId: target!, operation: args.one("operation") as "merge" | "deploy",
          checksPassed: checksPassed === "passed", actor,
        };
      }
      else if (group === "goal" && action === "review") {
        const evidence = args.one("evidence-file")
          ? await jsonFile(args.one("evidence-file"), "交付证据")
          : undefined;
        if (evidence !== undefined && !Array.isArray(evidence))
          throw new Error("交付证据文件必须是数组");
        const revision = args.one("candidate-revision");
        command = {
          type: "goal.review",
          goalId: target!,
          delivery: {
            summary: args.one("summary")!,
            location: args.one("location"),
            url: args.one("url"),
            checks: checks(args.all("check")),
            ...(revision
              ? {
                  candidate: {
                    revision,
                    digest: args.one("candidate-digest"),
                    version: args.one("candidate-version"),
                  },
                }
              : {}),
            ...(evidence ? { evidence: evidence as import("../../packages/core/src/index.js").Evidence[] } : {}),
          },
          actor,
        };
      }
      else if (group === "goal" && action === "rework")
        command = {
          type: "goal.rework",
          goalId: target!,
          note: textArg(args.one("note"), "--note"),
          actor,
        };
      else if (group === "goal" && ["accept", "complete", "drop"].includes(action ?? "")) {
        if (action === "accept") requireHumanCli();
        command = {
          type: `goal.${action}` as "goal.accept" | "goal.complete" | "goal.drop",
          goalId: target!,
          note: args.one("note") ?? args.one("reason") ?? undefined,
          actor: action === "accept" ? "你" : actor,
        };
      }
      else if (group === "goal" && action === "resolve") command = {
        type: "goal.resolve", goalId: target!, note: args.one("note") ?? args.one("reason"), actor,
        outcome: (args.one("outcome") ?? "approved") as "approved" | "rejected",
        source: "cli",
      };
      else if (group === "goal" && action === "remind") command = { type: "goal.remind", goalId: target!, at: args.one("at")!, note: args.one("note") };
      else if (group === "session" && action === "set") {
        if (!target)
          throw new Error("session set 必须指定目标 ID；全局管家现场由桌面应用管理。");
        command = { type: "session.set", goalId: target, reference: { session: args.one("session") ?? process.env.HERDR_SESSION ?? "atte", workspaceId: args.one("workspace"), tabId: args.one("tab"), paneId: args.one("pane"), agent: args.one("agent"),
          ...(args.has("transport") ? { transport: args.one("transport") as "pane", processId: Number(args.one("process-id")) } : {}) } };
      }
      else if (group === "owner" && action === "attach") {
        if (!target) throw new Error("需要目标 ID");
        result = await attachOwner(service, {
          goalId: target,
          name: textArg(args.one("name"), "--name"),
          session: textArg(args.one("session"), "--session"),
          workspaceId: textArg(args.one("workspace"), "--workspace"),
          tabId: textArg(args.one("tab"), "--tab"),
          paneId: textArg(args.one("pane"), "--pane"),
          ...(args.one("agent") ? { agent: textArg(args.one("agent"), "--agent") } : {}),
          ...(args.one("recovery-id") ? { recoveryId: textArg(args.one("recovery-id"), "--recovery-id") } : {}),
        });
      }
      else if (group === "owner" && action === "launch")
        ownerLaunch = {
          name: textArg(args.one("name"), "--name"),
          role: "owner",
          ...(args.one("task")
            ? { task: textArg(args.one("task"), "--task") }
            : {}),
          ...(args.one("task-file")
            ? { taskFile: textArg(args.one("task-file"), "--task-file") }
            : {}),
        };
      else if (group === "owner" && action === "send")
        ownerSend = { text: textArg(args.one("text"), "--text") };
      else throw new Error(`不支持的命令：${args.positional.join(" ")}\n\n${usage}`);
    }
    if (command && "goalId" in command && command.type !== "goal.scene-reply") {
      const attentionId = args.one("attention-id") ?? coordinatorContext?.attentionId;
      const sceneReplyId = args.one("scene-reply-id") ?? coordinatorContext?.sceneReplyId;
      if (coordinatorContext?.attentionId && attentionId !== coordinatorContext.attentionId)
        throw new Error("不能替换当前案卷绑定的待处理事项");
      if (coordinatorContext?.sceneReplyId && sceneReplyId !== coordinatorContext.sceneReplyId)
        throw new Error("不能替换当前案卷绑定的现场回执");
      command = { ...command, ...(attentionId ? { attentionId } : {}), ...(sceneReplyId ? { sceneReplyId } : {}) };
    }
    if (ownerLaunch) {
      if (!target) throw new Error("owner launch 必须指定当前目标 ID");
      result = await managedRuntime(workspaceRoot, managedContext).then(runtime =>
        runtime.launchOwner({ goalId: target!, ...ownerLaunch! }));
    } else if (ownerSend) {
      if (!target) throw new Error("owner send 必须指定当前目标 ID");
      const state = await service.read(), item = state.goals.find(goal => goal.id === target);
      if (!item?.scene) throw new Error("当前目标没有已核实的负责人现场；请先 owner launch。");
      const runtime = await managedRuntime(workspaceRoot, managedContext);
      const receipt = assertOwnerSendReceipt(await runtime.send(
        item.scene,
        args.one("delivery-id") ?? `owner-send-${randomUUID()}`,
        ownerSend.text,
      ));
      if (!managedAgent && item.sceneVisit)
        await service.execute({ type: "scene.cancel", goalId: item.id, reason: "user-input" });
      result = receipt;
    } else if (command) result = await service.execute(command);
    if (coordinatorMode && group === "direct" && args.has("new") && command?.type === "goal.direct")
      await advanceCoordinatorCase(result as import("../../packages/core/src/index.js").Goal);
    if (group === "goal" && action === "show") {
      const goal = result as import("../../packages/core/src/index.js").Goal;
      result = { ...goal, attentionRequest: attentionRequest(goal) };
    }
    if (args.has("json")) io.out(JSON.stringify(result, null, 2));
    else if (group === "status" && coordinatorRead) {
      const current = result as { name: string; project?: { name?: string };
        goal: { status: string; next: string; owner: string } };
      io.out(`${current.name} · ${current.project?.name ?? "个人事项"} · 当前案卷 · ${current.goal.status}\n${current.goal.next} · ${current.goal.owner}`);
    }
    else if (group === "doctor") {
      const report = result as Awaited<ReturnType<typeof doctorReport>>;
      io.out(`${report.workspace}\nAtte ${report.version} · ${report.backend?.selected ?? "未选择后端"} epoch ${report.backend?.epoch ?? "-"}` +
        `\n目标 ${report.state.open} 个进行中 / ${report.state.goals} 个 · 注意力 ${report.state.attention} · 状态 ${Math.round(report.state.bytes / 1024)} KB` +
        `\n收件箱：排队 ${report.inbox.queued ?? 0} · 未确认 ${report.inbox.unconfirmed ?? 0} · 失败 ${report.inbox.failed ?? 0} · 过期 ${report.inbox.expired ?? 0}` +
        (Object.keys(report.hookDiagnostics.counts).length
          ? `\nHook 观测异常：${Object.entries(report.hookDiagnostics.counts)
            .map(([reason, count]) => `${reason} ${count}`).join(" · ")}`
          : "") +
        (report.deadScenes.length ? `\n不可达现场 ${report.deadScenes.length} 个：${report.deadScenes.map(item => item.goalId).join(", ")}` : "\n没有已标记不可达的现场") +
        (report.issues.length ? `\n最近问题：\n${report.issues.map(item => `- ${item.kind} ${item.goalId} ${item.detail}`).join("\n")}` : ""));
    }
    else if (group === "event" && action === "herdr") {
      const current = result as { matched: number };
      io.out(current.matched ? `已同步 ${current.matched} 个目标的现场状态。` : "没有需要同步的 Atte 目标。");
    }
    else if (group === "goal" && action === "show") {
      const goal = result as import("../../packages/core/src/index.js").Goal,
        images = (goal.attachments ?? []).map((item: GoalAttachment) =>
          `\n图片：${item.name}\n${join(service.root, item.path)}`).join("\n");
      io.out(`${goal.title}\n${goal.status} · ${goal.next}\n\n${goal.description}${images}`);
    }
    else if (Array.isArray(result)) io.out(result.length ? result.map((item) => `${item.id}  ${item.title ?? item.name}  ${item.next ?? ""}`).join("\n") : "暂无记录");
    else if (group === "status") {
      const state = result as import("../../packages/core/src/index.js").WorkspaceState;
      if (state.recovery)
        io.out(`旧版工作区已自动保护：${state.recovery.detail} 备份位于 ${state.recovery.archivedPath}`);
      io.out(`${state.name} · ${state.goals.filter((goal) => !["backlog", "completed", "dropped"].includes(goal.status)).length} 个未结束事项 · ${state.goals.filter(goal => goal.status === "backlog").length} 件暂存 · ${attentionGoals(state.goals).length} 项需要处理`);
    }
    else { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(goal?.id ? `${goal.id} · ${goal.status}\n${goal.next}` : JSON.stringify(result)); }
    return 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "feature_removed") {
      const message = error instanceof Error ? error.message : "该功能已移除";
      if (argv.includes("--json") || argv.includes("--json=true"))
        io.out(JSON.stringify({ error: "feature_removed", message }));
      io.error(`atte: feature_removed: ${message}`);
      return 2;
    }
    io.error(`atte: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
