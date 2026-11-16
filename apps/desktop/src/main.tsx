import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert, Folder,
  Inbox, LayoutList, Moon, Plus, Settings2, Sparkles, SquareTerminal, Sun, X,
} from "lucide-react";
import { initialState } from "../../../packages/core/src/model.js";
import { isReadOnlyGoal } from "../../../packages/core/src/retirement.js";
import type {
  AtteCommand, AgentPreferences, Goal, LiveState, ShipPolicy, WorkspaceState,
} from "../../../packages/core/src/types.js";
import { api } from "./api.js";
import { migratePreference } from "./storage-compat.js";
type HerdrEnvironmentStatus = Awaited<ReturnType<typeof api.herdrStatus>>;
import { GoalIntakeForm } from "./features/intake/GoalIntakeForm.js";
import { Settings, type SettingsAction } from "./features/settings/Settings.js";
import { TaskDetail } from "./features/tasks/TaskDetail.js";
import { useReminderClock } from "./features/tasks/useReminderClock.js";
import { GoalDetail } from "./features/goals/GoalDetail.js";
import { GoalAttentionCard } from "./features/goals/GoalAttentionCard.js";
import { AttentionHome } from "./features/goals/AttentionHome.js";
import { GoalList } from "./features/goals/GoalList.js";
import { attentionOverview } from "./features/goals/attentionOverview.js";
import { goalEntryDestination } from "./features/goals/goalEntry.js";
import { presentSceneContext } from "./features/goals/goalPresentation.js";
import type { GoalDetailService } from "./features/goals/goalService.js";
import {
  Button, BrandMark, Checkbox, Field, IconButton, Modal, TextArea, TextInput, Toggle,
} from "./ui/index.js";
import type { WebhookSettings } from "../electron/webhook-notifications.js";
import type { AgentHookAdapterStatus } from "../electron/agent-hook-manager.js";
import type { CoordinatorInboxStatus } from "../electron/coordinator-inbox.js";
import "./style.css";

const HerdrTerminal = lazy(() => import("./terminal.js").then(module => ({ default: module.HerdrTerminal })));
const pages = { home: "注意力", items: "全部事项", settings: "设置" } as const;
const statusLabel = {
  backlog: "暂存", active: "跟进中", waiting: "等待外部", review: "待验收",
  completed: "已完成", dropped: "已放弃",
};
const goalStatusOptions = Object.entries(statusLabel) as [Goal["status"], string][];
const conciergeLiveLabel: Record<LiveState, string> = {
  working: "管家处理中", idle: "管家在线", done: "管家已完成回合",
  blocked: "管家等待处理", unknown: "管家状态未知",
};

function App() {
  const [state, setState] = useState<WorkspaceState>(initialState);
  const [workspace, setWorkspace] = useState<string>();
  const [version, setVersion] = useState("");
  const [page, setPage] = useState<keyof typeof pages>("home");
  const [theme, setTheme] = useState<string>(migratePreference(localStorage, "theme") === "light" ? "light" : "dark");
  const [collapsed, setCollapsed] = useState(() => migratePreference(localStorage, "sidebar-collapsed") === "true");
  const [projectId, setProjectId] = useState("");
  const [filter, setFilter] = useState("all");
  const [modal, setModal] = useState<"new" | "project" | "attention" | "goal" | "task" | "edit" | "delivery" | "workspace" | "webhook" | "">("");
  const [goalId, setGoalId] = useState("");
  const [intakeLater, setIntakeLater] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [herdr, setHerdr] = useState<HerdrEnvironmentStatus>();
  const [cli, setCli] = useState<Awaited<ReturnType<typeof api.cliStatus>>>();
  const [skills, setSkills] = useState<Awaited<ReturnType<typeof api.skillsStatus>>>();
  const [agentHooks, setAgentHooks] = useState<AgentHookAdapterStatus[]>([]);
  const [coordinatorQueue, setCoordinatorQueue] = useState<CoordinatorInboxStatus>();
  const [webhook, setWebhook] = useState<WebhookSettings>({
    enabled: false, configured: false, tokenConfigured: false,
    statuses: goalStatusOptions.map(([value]) => value),
  });
  const [agentOptions, setAgentOptions] = useState<{ kind: string; installed: boolean }[]>([]);
  const [terminal, setTerminal] = useState<{ session: string; title: string; goalId?: string; visible: boolean }>();
  const stateRef = useRef(state);
  stateRef.current = state;
  useReminderClock(state.goals);
  const pendingState = useRef<{ state: WorkspaceState; signature: string } | undefined>(undefined);
  const stateFrame = useRef<number | undefined>(undefined);
  const lastStateSignature = useRef("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function applyState(next: WorkspaceState) {
    const signature = JSON.stringify(next);
    if (signature === lastStateSignature.current) return;
    pendingState.current = { state: next, signature };
    if (stateFrame.current !== undefined) return;
    stateFrame.current = requestAnimationFrame(() => {
      stateFrame.current = undefined;
      const pending = pendingState.current;
      if (!pending || pending.signature === lastStateSignature.current) return;
      lastStateSignature.current = pending.signature;
      setState(pending.state);
    });
  }
  const goal = state.goals.find(item => item.id === goalId);
  const hasConciergeReference = Boolean(state.concierge.tabId || state.concierge.agent);
  const conciergeAvailable = state.concierge.status === "ready" && state.concierge.live?.reachable !== false;
  const conciergeLive = state.concierge.status === "ready" ? state.concierge.live?.state : undefined;
  const activeAlerts = (coordinatorQueue?.alerts ?? []).filter(alert =>
    state.goals.some(item => item.id === alert.goalId && !["completed", "dropped"].includes(item.status)));
  const failedAlerts = activeAlerts.filter(alert => alert.status === "failed").length;
  const unconfirmedAlerts = activeAlerts.filter(alert => alert.status === "unconfirmed").length;
  const conciergeQueueAlert = failedAlerts + unconfirmedAlerts;
  const conciergeStatus = state.concierge.status === "ready"
    ? coordinatorQueue?.processing
      ? `管家处理中${coordinatorQueue.queued ? ` · ${coordinatorQueue.queued} 件排队` : ""}`
      : coordinatorQueue?.queued ? `管家在线 · ${coordinatorQueue.queued} 件排队`
        : failedAlerts ? `管家在线 · ${failedAlerts} 件待重试`
          : unconfirmedAlerts ? `管家在线 · ${unconfirmedAlerts} 件待核对`
            : conciergeLive ? conciergeLiveLabel[conciergeLive] : "管家在线"
    : state.concierge.status === "error" ? "管家需要恢复" : "管家已离线";
  const { attention } = attentionOverview(state.goals);
  const sceneGoal = terminal?.goalId ? state.goals.find(item => item.id === terminal.goalId) : undefined;
  const sceneContext = sceneGoal ? presentSceneContext(sceneGoal, state) : undefined;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atte.theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("atte.sidebar-collapsed", String(collapsed)); }, [collapsed]);
  useEffect(() => {
    api.environment().then(async env => {
      setWorkspace(env.workspace);
      setVersion(env.version);
      void refreshHerdr().catch(showError);
      if (!env.workspace) return;
      void api.coordinatorStatus().then(setCoordinatorQueue).catch(() => {});
      applyState(await api.command({ type: "snapshot" }));
    }).catch(showError);
    const unsubscribe = api.subscribe(event => {
      if (event.state) applyState(event.state);
      if (event.workspace) setWorkspace(event.workspace);
      if (event.type === "refresh") {
        setTerminal(undefined);
        void api.command({ type: "snapshot" }).then(applyState).catch(showError);
        void api.coordinatorStatus().then(setCoordinatorQueue).catch(() => {});
      }
      if (event.type === "diagnostic") setError(event.message);
      if (event.type === "herdr-status") setHerdr(event.status);
      if (event.type === "agent-runtime-status") setAgentHooks(event.status);
      if (event.type === "coordinator-status") setCoordinatorQueue(event.status);
      if (event.type === "cli-status") setCli(event.status);
      if (event.type === "open-goal") openGoal(event.goalId);
      if (event.type === "terminal-available") {
        setTerminal(current => current?.session === event.session
          ? current : { session: event.session, title: event.title, visible: false });
      }
      if (event.type === "terminal-open") {
        setTerminal({ session: event.session, title: event.title, goalId: event.goalId, visible: true });
      }
    });
    return () => {
      unsubscribe();
      if (stateFrame.current !== undefined) cancelAnimationFrame(stateFrame.current);
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    const report = (summary: string) => {
      void api.reportRendererError(summary.slice(0, 4_000)).catch(() => {});
    };
    const onError = (event: ErrorEvent) => report(
      `window-error: ${event.message} @ ${event.filename ?? "-"}:${event.lineno ?? 0}:${event.colno ?? 0}`,
    );
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { stack?: unknown; message?: unknown } | undefined;
      report(`unhandled-rejection: ${String(reason?.stack ?? reason?.message ?? event.reason)}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  useEffect(() => {
    if (page !== "settings") return;
    void refreshHerdr().catch(showError);
    void api.cliStatus().then(setCli).catch(showError);
    void api.skillsStatus().then(setSkills).catch(showError);
    void api.agentRuntimeStatus().then(setAgentHooks).catch(showError);
    void api.agentChoices().then(setAgentOptions).catch(showError);
    void api.webhookSettings().then(setWebhook).catch(showError);
  }, [page]);
  useEffect(() => {
    if (!error || modal) return;
    const timer = window.setTimeout(() => setError(""), 8_000);
    return () => window.clearTimeout(timer);
  }, [error, modal]);
  function showError(reason: unknown, prefix = "") {
    setError(prefix + String(reason).replace(/^Error: /, "")
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  }
  async function refreshHerdr() {
    const next = await api.herdrStatus();
    setHerdr(next);
    return next;
  }
  async function openScene(id?: string, recover = false) {
    if (busy) return;
    const item = id ? stateRef.current.goals.find(current => current.id === id) : undefined;
    if (item && isReadOnlyGoal(item)) {
      notify("这是只读历史，不再打开运行现场。");
      return;
    }
    setModal("");
    setBusy(true);
    setError("");
    try {
      const result = await api.openScene(id, recover);
      if (result.mode === "embedded") notify(`已打开内嵌轻现场${id ? "。" : "，关闭面板不会终止 Agent。"}`);
      else {
        const label = result.lease.terminal === "iterm2"
          ? "iTerm2" : result.lease.terminal === "terminal" ? "Terminal" : "Ghostty";
        notify(`已在 ${label} 打开${id ? "目标现场" : "全局管家"}。`);
      }
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }
  function notify(text: string) {
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }
  async function execute(command: AtteCommand) {
    setBusy(true);
    setError("");
    try {
      const result = await api.command(command);
      applyState(await api.command({ type: "snapshot" }));
      return result;
    } catch (reason) { showError(reason); throw reason; }
    finally { setBusy(false); }
  }
  const goalDetailService = useMemo<GoalDetailService>(() => ({
    command: execute,
    importAttachments: inputs => api.importAttachments(inputs),
    previewAttachment: (currentGoalId, attachmentId) => api.attachmentPreview(currentGoalId, attachmentId),
    openAttachment: async (currentGoalId, attachmentId) => {
      try { await api.openAttachment(currentGoalId, attachmentId); }
      catch (reason) { showError(reason); }
    },
    openHerdr: async (currentGoalId, recover) => { await openScene(currentGoalId, recover); },
    openUrl: async url => {
      try { await api.openUrl(url); }
      catch (reason) { showError(reason); }
    },
    retryDispatch: async currentGoalId => {
      setBusy(true);
      setError("");
      try {
        await api.dispatchGoal(currentGoalId);
        applyState(await api.command({ type: "snapshot" }));
      } catch (reason) { showError(reason); throw reason; }
      finally { setBusy(false); }
    },
    restartGoal: async (currentGoalId, note) => {
      setBusy(true);
      setError("");
      try {
        const result = await api.restartGoal(currentGoalId, note);
        applyState(await api.command({ type: "snapshot" }));
        return result;
      } catch (reason) { showError(reason); throw reason; }
      finally { setBusy(false); }
    },
  }), [busy]);
  async function pickWorkspace() {
    if (pickingWorkspace || busy) return;
    setPickingWorkspace(true);
    setError("");
    try {
      const selected = await api.selectWorkspace();
      if (!selected) return;
      setProjectId("");
      setGoalId("");
      setModal("");
      setPage("home");
      setWorkspace(selected);
      applyState(await api.command({ type: "snapshot" }));
      notify(selected === workspace ? "你已在这个工作区。"
        : `已打开工作区：${selected.split("/").filter(Boolean).at(-1)}`);
    } catch (reason) { showError(reason); }
    finally { setPickingWorkspace(false); }
  }
  function openGoal(id: string) {
    const item = stateRef.current.goals.find(current => current.id === id);
    if (!item) return;
    const destination = goalEntryDestination(item);
    if (destination === "scene") { void openScene(item.id); return; }
    setGoalId(item.id);
    setModal(destination === "task" ? "task" : destination === "attention" ? "attention" : "goal");
  }
  function createIntake(later = false) {
    setIntakeLater(later);
    setError("");
    setModal("new");
  }
  async function saveGoal(text: string, files: File[], handling: "concierge" | "later") {
    setBusy(true);
    setError("");
    try {
      const inputs = await Promise.all(files.map(async file => ({
        name: file.name, bytes: await file.arrayBuffer(),
      })));
      const attachments = inputs.length ? await api.importAttachments(inputs) : [];
      const created = await api.command({
        type: "goal.intake", text, handling, projectId: projectId || undefined,
        ...(attachments.length ? { attachments } : {}),
      }) as Goal;
      applyState(await api.command({ type: "snapshot" }));
      setGoalId(created.id);
      setModal(handling === "concierge" ? "goal" : "");
      if (handling === "later") {
        setFilter("backlog");
        setProjectId("");
        setPage("items");
      }
      notify(handling === "later" ? "已记下，不会启动 Agent。" : "事项已保存，正在联系管家。");
    } catch (reason) { showError(reason); throw reason; }
    finally { setBusy(false); }
  }
  async function settingsAction(action: SettingsAction) {
    setBusy(true);
    setError("");
    try {
      if (action === "herdr-check") {
        const checked = await api.checkHerdrUpdate();
        setHerdr(await api.herdrStatus());
        notify(checked.detail?.startsWith("检查更新未完成") ? checked.detail
          : checked.updateAvailable ? `发现 Herdr ${checked.latestVersion}，可在设置中更新。`
            : checked.installed ? `Herdr ${checked.version} 已是当前版本。` : "Herdr 尚未安装。");
      } else if (action === "herdr-install") {
        const installed = await api.installHerdr();
        setHerdr(await api.herdrStatus());
        notify(installed.installed ? `Herdr ${installed.version ?? ""} 已就绪`
          : "Herdr 更新未完成，当前可用版本与事项记录均未改变。");
      } else if (action === "cli") {
        notify((await api.installCli()).output);
      } else if (action === "skills") {
        const result = await api.installSkills();
        setSkills(result.status);
        notify(result.errors.length
          ? `Skills 已更新；${result.errors.length} 个目录因已有同名技能而跳过。`
          : "Atte Skills 已安装到检测到的 Agent。");
      }
      setAgentOptions(await api.agentChoices());
      setAgentHooks(await api.agentRuntimeStatus());
      setCli(await api.cliStatus());
      if (workspace) applyState(await api.command({ type: "snapshot" }));
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }
  const taskModal = Boolean(goal && (modal === "task"
    || modal === "goal" && goal.mode === "manual" && goal.status !== "review"));
  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="brand"><BrandMark /><div><strong>Atte</strong><span>The attention layer</span></div></div>
        <nav aria-label="主导航">
          <button aria-label="注意力" aria-current={page === "home" ? "page" : undefined}
            className={page === "home" ? "active" : ""}
            onClick={() => { setPage("home"); setProjectId(""); }}>
            <Inbox /><span>注意力</span>
            {attention.length > 0 && <b aria-label={`${attention.length} 件需要处理`}>{attention.length}</b>}
          </button>
          <button aria-label="全部事项" aria-current={page === "items" ? "page" : undefined}
            className={page === "items" ? "active" : ""}
            onClick={() => { setPage("items"); setProjectId(""); }}>
            <LayoutList /><span>全部事项</span>
          </button>
          <button aria-label="设置" aria-current={page === "settings" ? "page" : undefined}
            className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>
            <Settings2 /><span>设置</span>
          </button>
        </nav>
        <div className="concierge">
          <div className="concierge-orb"><BrandMark variant="mascot" decorative /><i /></div>
          <strong>所有事，找管家。</strong><p>你负责方向，管家负责条理。</p>
          <button disabled={!workspace || busy} aria-label="找管家" onClick={() => void openScene()}>
            <SquareTerminal size={15} />
            <span>{busy ? "正在处理…" : conciergeAvailable ? "回到现场" : hasConciergeReference ? "恢复管家" : "找管家"}</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-footer">
          <button aria-label={theme === "dark" ? "浅色模式" : "深色模式"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun /> : <Moon />}
            <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
          </button>
          <button className="sidebar-collapse" onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>
            <ChevronRight className="collapse-icon" /><span>收起</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-context">
            <span className="topbar-mark" aria-hidden="true"><Sparkles size={16} /></span>
            <span>{state.projects.find(item => item.id === projectId)?.name ?? state.name}</span>
            <span className="slash">/</span><strong>{pages[page]}</strong>
          </div>
          <div className="top-actions">
            <button type="button" aria-atomic="true" aria-live="polite"
              className={`live-status live-status--${coordinatorQueue?.processing ? "working"
                : conciergeQueueAlert ? "blocked" : conciergeLive ?? state.concierge.status}`}
              disabled={!workspace || busy}
              title={hasConciergeReference ? "打开管家现场" : "准备并打开管家"}
              onClick={() => void openScene()}>
              <i />{conciergeStatus}
            </button>
            {page !== "settings" && <Button variant="primary"
              onClick={() => createIntake(filter === "backlog")} disabled={!workspace}
              icon={<Plus size={16} />}>{page === "items" && filter === "backlog" ? "先记一件事" : "新事项"}</Button>}
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {error && <div className="error" role="alert"><CircleAlert size={16} /><span>{error}</span>
            <IconButton label="关闭提示" onClick={() => setError("")}><X size={15} /></IconButton></div>}
          {state.recovery && <div className="recovery-notice" role="status" aria-live="polite">
            <CircleAlert size={18} />
            <div><strong>旧版工作区已自动保护</strong>
              <p>{state.recovery.detail} 已创建兼容的新工作区，旧数据没有被删除。</p>
              <code title={state.recovery.archivedPath}>{state.recovery.archivedPath}</code></div>
            <Button variant="secondary" size="sm"
              onClick={() => void api.openRecoveryBackup().catch(showError)} icon={<Folder size={14} />}>打开备份</Button>
            <IconButton label="关闭恢复提示" onClick={() => void execute({ type: "workspace.recovery.dismiss" })
              .then(() => notify("旧版数据继续保留在备份目录中。")).catch(showError)}><X size={15} /></IconButton>
          </div>}
          {herdr && ["checking", "downloading", "error"].includes(herdr.phase) &&
            <div className={`setup-status ${herdr.phase}`} role="status" aria-live="polite">
              <SquareTerminal size={16} /><span>{herdr.detail || "正在检查 Herdr…"}</span>
              {herdr.phase === "error" && <Button variant="secondary" size="sm"
                onClick={() => void api.installHerdr().catch(showError)}>重试准备 Herdr</Button>}
            </div>}
          {!workspace && page !== "settings" ? page === "home" ? <section className="welcome">
            <BrandMark variant="mascot" />
            <span className="eyebrow">Atte · The attention layer</span>
            <h1>把注意力留给重要的事。</h1>
            <p>人只做拍板，Agent 并行推进。<br />只有真正需要你的时刻，才打扰你。</p>
            <Button variant="primary" disabled={pickingWorkspace}
              onClick={() => void pickWorkspace()} trailing={<ArrowRight size={17} />}>
              {pickingWorkspace ? "正在准备工作区…" : "选择存储位置并开始"}
            </Button>
          </section> : <div className="content">
            <section className="intro"><h1>{pages[page]}</h1><p>记录事项、查看进度和历史。</p></section>
            <div className="welcome"><BrandMark variant="mascot" /></div>
            <p className="muted">先选择存储位置后，就可以在这里记录和查看事项。</p>
            <Button disabled={pickingWorkspace} onClick={() => void pickWorkspace()}>
              {pickingWorkspace ? "正在准备工作区…" : "选择存储位置"}
            </Button>
          </div> : page === "home" ? <AttentionHome state={state} open={openGoal} showItems={nextFilter => {
            setFilter(nextFilter);
            setProjectId("");
            setPage("items");
          }} /> : page === "items" ? <GoalList state={state} projectId={projectId}
            setProjectId={setProjectId} filter={filter} setFilter={setFilter} open={openGoal}
            create={createIntake} addProject={() => setModal("project")} service={goalDetailService}
            busy={busy} notify={notify} reportError={showError} /> : <Settings
            busy={busy} state={state} herdr={herdr} cli={cli} skills={skills} agentHooks={agentHooks}
            onAgentHooksChange={setAgentHooks} notify={notify} agentOptions={agentOptions} webhook={webhook}
            saveAgents={async (preferences: AgentPreferences) => {
              await execute({ type: "agents.configure", preferences });
              notify("Agent 偏好已保存，将用于新启动的会话。");
            }}
            savePolicy={async (projectIdValue: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => {
              await execute({ type: "project.policy.set", projectId: projectIdValue, policy, actor: "你" });
              notify("项目上线策略已更新。");
            }}
            theme={theme} setTheme={setTheme} onAction={settingsAction} version={version}
            workspace={workspace ?? ""}
            pickWorkspace={() => workspace ? setModal("workspace") : void pickWorkspace()}
            openWebhook={() => setModal("webhook")} />}
        </main>
      </div>
      {terminal && <Suspense fallback={null}><HerdrTerminal session={terminal.session}
        title={terminal.title} goal={sceneContext} theme={theme} visible={terminal.visible && !modal}
        onClose={() => setTerminal(current => current ? { ...current, visible: false } : current)}
        onOpenGoal={id => { setGoalId(id); setModal("goal"); }}
        onReturnToAttention={() => {
          setPage("home");
          setProjectId("");
          setTerminal(current => current ? { ...current, visible: false } : current);
        }} /></Suspense>}
      {modal === "workspace" && <Modal title="工作区存储位置"
        description="这里只设置所有事项、提醒和管家的保存位置，不是选择项目。"
        error={error} onClose={() => setModal("")}>
        <div className="workspace-location"><Folder size={22} /><div>
          <strong>{workspace ? "当前工作区" : "先选择一个工作区文件夹"}</strong>
          <p>{workspace || "建议创建一个专门的文件夹，例如 Documents/Atte。"}</p></div></div>
        <p className="workspace-help">切换工作区后，将显示所选目录自己的事项和管家。</p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setModal("")}>返回设置</Button>
          <Button variant="primary" disabled={pickingWorkspace || busy} onClick={() => void pickWorkspace()}>
            {pickingWorkspace ? "正在打开工作区…" : workspace ? "选择其他工作区文件夹" : "选择工作区文件夹"}
          </Button>
        </div>
      </Modal>}
      {modal === "webhook" && <Modal title="Webhook 通知"
        description="状态变化会发送；首次进入注意力时会另发一次通知，去重记录跨重启保留。"
        error={error} onClose={() => setModal("")}>
        <form className="ui-form webhook-form" onSubmit={async event => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const data = new FormData(event.currentTarget);
          try {
            const saved = await api.saveWebhook({
              enabled: data.get("enabled") === "on", url: String(data.get("url") || ""),
              token: String(data.get("token") || ""), clearToken: data.get("clearToken") === "on",
              statuses: data.getAll("statuses")
                .filter((value): value is string => typeof value === "string") as Goal["status"][],
            });
            const verified = saved.enabled ? await api.testWebhook() : saved;
            setWebhook(verified);
            setModal("");
            notify(saved.enabled ? "Webhook 已保存，测试通知已送达。" : "Webhook 通知已暂停。");
          } catch (reason) { showError(reason); }
          finally { setBusy(false); }
        }}>
          <Toggle name="enabled" defaultChecked={webhook.enabled} disabled={busy}
            label="状态更新和需要你处理时发送" />
          <fieldset className="webhook-statuses"><legend>订阅这些状态变化</legend><div>
            {goalStatusOptions.map(([value, label]) => <Checkbox name="statuses" value={value} key={value}
              defaultChecked={webhook.statuses.includes(value)} disabled={busy} label={label} />)}
          </div><small>全部取消后仍会接收注意力通知。</small></fieldset>
          <Field label="Webhook 地址" hint={webhook.configured
            ? `已配置 ${webhook.endpoint ?? ""}，留空保持不变`
            : "远程地址必须使用 HTTPS，本机 localhost 可使用 HTTP。"}>
            <TextInput name="url" type="url" required={!webhook.configured} disabled={busy}
              placeholder={webhook.configured ? "留空保持不变" : "https://hooks.example.com/atte"} />
          </Field>
          <Field label="Bearer 令牌（可选）" hint={webhook.tokenConfigured
            ? "令牌已保存，留空保持不变。" : "留空则不添加 Authorization。"}>
            <TextInput name="token" type="password" autoComplete="new-password" disabled={busy}
              placeholder={webhook.tokenConfigured ? "留空保持不变" : "留空则不添加 Authorization"} />
          </Field>
          {webhook.tokenConfigured && <Checkbox name="clearToken" disabled={busy} label="清除已保存的令牌" />}
          <p className="ui-form__note">内容仅含工作区名称、事项标题、状态、摘要和 `goalId`，不包含聊天记录、附件或本机路径。</p>
          <div className="modal-actions webhook-actions">
            <Button variant="secondary" disabled={busy || !webhook.configured} onClick={async () => {
              setBusy(true);
              setError("");
              try { setWebhook(await api.testWebhook()); notify("测试通知已送达 Webhook。"); }
              catch (reason) { showError(reason); setWebhook(await api.webhookSettings().catch(() => webhook)); }
              finally { setBusy(false); }
            }}>测试当前配置</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "正在保存…" : "保存设置"}</Button>
          </div>
        </form>
      </Modal>}
      {modal === "new" && <GoalIntakeForm error={error} busy={busy}
        initialHandling={intakeLater ? "later" : "concierge"}
        onClose={() => setModal("")} onSubmit={saveGoal} />}
      {taskModal && goal && goalEntryDestination(goal) !== "attention" && <TaskDetail key={goal.id}
        goal={goal} service={goalDetailService} busy={busy} error={error}
        close={() => setModal("")} notify={notify} delegated={() => setModal("goal")} />}
      {(modal === "attention" || taskModal && goal && goalEntryDestination(goal) === "attention") && goal &&
        <GoalAttentionCard key={goal.id} goal={goal} state={state} service={goalDetailService}
          busy={busy} error={error} onClose={() => setModal("")}
          openDetails={() => setModal("goal")} notify={notify} />}
      {modal === "project" && <Modal error={error} title="添加项目"
        description="创建项目并关联本机目录；目录可留空，仍由同一位管家统筹。"
        onClose={() => setModal("")}>
        <form className="ui-form" onSubmit={async event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await execute({
              type: "project.add", name: String(data.get("name")),
              path: String(data.get("path")) || undefined,
            });
            setModal("");
            notify("项目已添加");
          } catch {}
        }}>
          <Field label="项目名称"><TextInput name="name" required autoFocus placeholder="例如：数据平台" /></Field>
          <Field label="项目目录（可选）" htmlFor="project-path" connect={false}
            hint="可留空，仍由同一位管家统筹。">
            <div className="file-input"><TextInput id="project-path" name="path" readOnly placeholder="选择本机目录" />
              <Button variant="secondary" onClick={async () => {
                const selected = await api.selectProject();
                const input = document.querySelector<HTMLInputElement>('input[name="path"]');
                if (input && selected) input.value = selected;
              }}>选择目录</Button></div>
          </Field>
          <div className="modal-actions"><Button type="submit" variant="primary" disabled={busy}>添加项目</Button></div>
        </form>
      </Modal>}
      {modal === "goal" && !taskModal && goal && <GoalDetail key={goal.id} goal={goal}
        error={error} state={state} onClose={() => setModal("")} service={goalDetailService} busy={busy}
        removeAttachment={attachmentId => void execute({
          type: "goal.attachment.remove", goalId: goal.id, attachmentId, actor: "你",
        }).then(() => notify("图片已删除，相关元数据也已清理。")).catch(() => {})}
        deleteGoal={() => {
          if (!window.confirm(`永久删除事项「${goal.title}」及其图片？项目决定账本会保留。`)) return;
          void execute({ type: "goal.delete", goalId: goal.id, actor: "你" }).then(() => {
            setGoalId("");
            setModal("");
            notify("事项与关联图片已永久删除。");
          }).catch(() => {});
        }}
        edit={() => setModal("edit")} submit={() => setModal("delivery")} notify={notify} />}
      {modal === "edit" && goal && <GoalEditor goal={goal} error={error} busy={busy}
        execute={execute} onClose={() => setModal("goal")}
        onSaved={() => { setModal("goal"); notify("下一步已更新"); }} />}
      {modal === "delivery" && goal && <DeliveryEditor goal={goal} error={error} busy={busy}
        execute={execute} onClose={() => setModal("goal")}
        onSaved={() => { setModal("goal"); notify("成果已记录，请核对后验收"); }} />}
      {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    </div>
  );
}

type GoalFormProps = {
  goal: Goal; error: string; busy: boolean;
  execute: (command: AtteCommand) => Promise<unknown>;
  onClose: () => void; onSaved: () => void;
};
function GoalEditor({ goal, error, busy, execute, onClose, onSaved }: GoalFormProps) {
  const [arrangement, setArrangement] = useState(goal.status === "waiting" ? "waiting" : "active");
  const localReminder = goal.remindAt ? (() => {
    const date = new Date(goal.remindAt);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  })() : "";
  return <Modal title="编辑事项"
    description="修改事项说明或接下来的安排。等待外部只适用于你和 Agent 之外的联系人或机构。"
    error={error} onClose={onClose}>
    <form className="ui-form" onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        await execute({ type: "goal.update", goalId: goal.id, patch: {
          title: String(data.get("title")), description: String(data.get("description")),
          next: String(data.get("next")), owner: String(data.get("owner")),
          ...(arrangement === "waiting" ? { waitingFor: String(data.get("waitingFor")) } : {}),
          status: goal.status === "review" ? undefined : arrangement as "active" | "waiting",
          remindAt: data.get("remindAt") ? new Date(String(data.get("remindAt"))).toISOString() : null,
        }});
        onSaved();
      } catch {}
    }}>
      <Field label="事项名称" hint="改标题不会改变状态或验收记录。">
        <TextInput name="title" defaultValue={goal.title} maxLength={160} required />
      </Field>
      <Field label="背景与完成标准"><TextArea name="description" defaultValue={goal.description} required /></Field>
      <div className="ui-form__grid">
        {goal.status !== "review" && <Field label="当前安排">
          <select className="ui-input ui-select" name="status" value={arrangement}
            onChange={event => setArrangement(event.target.value)}>
            <option value="active">继续推进</option><option value="waiting">等待外部</option>
          </select>
        </Field>}
        <Field label="负责人"><TextInput name="owner" defaultValue={goal.owner} required /></Field>
        {arrangement === "waiting" && <Field label="外部等待对象" hint="例如 YR、法务或供应商。">
          <TextInput name="waitingFor" defaultValue={goal.waitingFor} maxLength={120} required />
        </Field>}
        <Field label="跟进提醒" hint="到提醒时间会进入注意力。">
          <TextInput name="remindAt" type="datetime-local" defaultValue={localReminder} />
        </Field>
      </div>
      <Field label="下一步"><TextArea name="next" defaultValue={goal.next} required /></Field>
      <div className="modal-actions"><Button type="submit" variant="primary" disabled={busy}>保存更新</Button></div>
    </form>
  </Modal>;
}
function DeliveryEditor({ goal, error, busy, execute, onClose, onSaved }: GoalFormProps) {
  return <Modal title="提交成果" description="写下实际成果与已完成的检查，供最终验收。"
    error={error} onClose={onClose}>
    <form className="ui-form" onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        await execute({ type: "goal.review", goalId: goal.id, actor: "你", delivery: {
          summary: String(data.get("summary")), location: String(data.get("location")) || undefined,
          checks: [{
            name: String(data.get("checkName")), command: String(data.get("checkCommand")),
            result: "passed", note: String(data.get("checkNote")),
          }],
        }});
        onSaved();
      } catch {}
    }}>
      <Field label="成果摘要"><TextArea name="summary" placeholder="实际完成了什么？" required /></Field>
      <Field label="成果位置（可选）"><TextInput name="location" placeholder="文件位置、文档或其他可核对的位置" /></Field>
      <div className="ui-form__grid">
        <Field label="检查名称"><TextInput name="checkName" placeholder="例如：人工核对审批结果" required /></Field>
        <Field label="实际检查操作"><TextInput name="checkCommand" placeholder="实际执行的命令或人工检查步骤" required /></Field>
      </div>
      <Field label="通过依据" hint="未检查通过时请继续处理，不要提交验收。">
        <TextArea name="checkNote" placeholder="写下实际观察到的结果" required />
      </Field>
      <div className="modal-actions"><Button type="submit" variant="primary" disabled={busy}>提交验收</Button></div>
    </form>
  </Modal>;
}
createRoot(document.getElementById("root")!).render(<App />);
