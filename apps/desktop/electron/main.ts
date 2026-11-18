import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, Tray } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  attentionGoals,
  attentionKind,
  attentionRequest,
  attachmentAbsolutePath,
  importAttachmentBytes,
  isReadOnlyGoal,
  validateGoalAttachments,
  WorkspaceService,
  type AtteCommand,
  type Goal,
  type GoalStatus,
  type HerdrReference,
  type WatchdogRequest,
  type WorkspaceState,
  environmentValue,
  migrateApplicationHome,
  prepareWorkspaceState,
  workspaceDataDirectory,
} from "../../../packages/core/src/index.js";
import {
  HerdrClient,
  herdrRunner,
  quoteShell,
  startDetachedHerdrServer,
} from "./herdr.js";
import { TerminalHost } from "./terminal-host.js";
import { parseAgentCommand } from "./agent-command.js";
import { Executables } from "./executables.js";
import { HerdrInstallation, type HerdrStatus } from "./herdr-install.js";
import {
  SessionControl,
  SessionError,
  SessionRuntime,
  localAdapter,
  receiptReminderDeliveryId,
  workspaceSessionName,
} from "../../../packages/sessions/src/index.js";
import { HerdrPlugin } from "./herdr-plugin.js";
import { deliverGoalUpdate } from "./goal-delivery.js";
import { reconcileSceneReply, requestNeutralSceneReply } from "./scene-reconciliation.js";
import { SessionPoller } from "./session-poller.js";
import { CoordinatorInbox, type CoordinatorInboxItem, type CoordinatorInboxStatus } from "./coordinator-inbox.js";
import { CoordinatorDispatcher, type CoordinatorExecutionResult } from "./coordinator-dispatcher.js";
import { writeCoordinatorScope } from "./coordinator-scope.js";
import { WebhookNotifier, type WebhookSaveInput } from "./webhook-notifications.js";
import { AtteSkillInstaller } from "./skill-installer.js";
import { clearManagedCaches, inspectManagedCaches } from "./cache-maintenance.js";
import {
  AgentHookManager,
  managedRevision as managedHookRevision,
  type ManagedAdapterId,
} from "./agent-hook-manager.js";
import { AgentRuntimeBroker } from "./agent-runtime-broker.js";
import { HerdrHostBridge } from "./herdr-host-bridge.js";
import {
  ExternalTerminalManager,
  type ExternalSceneLease,
  type SceneSettings,
} from "./external-terminal.js";
import { SessionCommandHost } from "./session-command-host.js";
import { legacyCliPaths, removeOwnedLegacyCli } from "./legacy-cli.js";
import { compactPath, Diagnostics, hookFailureSummary } from "./diagnostics.js";
import { OwnerWriteObserver } from "./owner-write-observer.js";
import { readHookDiagnostics } from "../../../cli/src/hook-diagnostics.js";
import {
  ApplicationUpdater,
  type ApplicationUpdateStatus,
} from "./application-updater.js";
import { createElectronUpdaterEngine } from "./electron-updater-engine.js";
import { settleAllWithin } from "./shutdown-flush.js";
/** Owner CLI processes write state directly; the watcher must start coordination. */
const ownerWriteTasks = new Set<Promise<void>>();
const ownerWrites = new OwnerWriteObserver({
  onWrite(goal, activityId) {
    if (!root || isReadOnlyGoal(goal) || shuttingDown) return;
    const target = new WorkspaceService(root);
    const task = (async () => {
      // The CLI already wrote on disk. Queue a coordinator case of its own
      // instead of inventing a pending goal dispatch: a failed delivery must
      // stay a queue alert, never a goal-level failure the user has to clear.
      const { inbox, dispatcher } = await ensureCoordinatorInbox();
      const current = (await target.read()).goals.find(item => item.id === goal.id);
      if (root !== target.root || !current || isReadOnlyGoal(current)) return;
      await inbox.enqueue({
        goalId: goal.id,
        requestId: `owner-write-${activityId}`,
        kind: "owner_write",
        priority: "normal",
      });
      await dispatcher.drain();
      if (root !== target.root) return;
      broadcastSnapshot(await target.read(), target.root);
      broadcastCoordinatorStatus(await inbox.status());
    })();
    ownerWriteTasks.add(task);
    void task.catch(error => {
      diagnostics.record("session", "owner-write-notify", error);
    }).finally(() => ownerWriteTasks.delete(task));
  },
});
const exec = promisify(execFile);
let window: BrowserWindow, tray: Tray, root: string | undefined, service: WorkspaceService | undefined, syncing = false, quitting = false, shuttingDown = false;
let stateWatcher: FSWatcher | undefined, stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let synchronizeTimer: ReturnType<typeof setInterval> | undefined;
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;
let quitAfterShutdown = false;
let updateNotification: Notification | undefined;
const selections = new Set<string>();
const knownGoalStatuses = new Map<string, GoalStatus>();
let knownGoalStatusWorkspace: string | undefined;
let lastSnapshotSignature: string | undefined;
let automaticCacheCleanupStarted = false;
let cacheMaintenanceQueue: Promise<unknown> = Promise.resolve();
const here = __dirname;
const diagnostics = new Diagnostics({
  version: () => app.getVersion(),
  directory: () => app.getPath("userData"),
  home: () => app.getPath("home"),
});
diagnostics.installProcessHandlers();
/** Records every handler failure once, without altering what the caller sees. */
function watchIpcFailures(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown) =>
    handle(channel, async (event, ...args) => {
      try {
        return await listener(event, ...args);
      } catch (error) {
        diagnostics.record("ipc", channel, error);
        throw error;
      }
    })) as typeof ipcMain.handle;
}
function trayIcon() {
  const variant = nativeTheme.shouldUseDarkColors ? "atte-tray-reversed" : "atte-tray",
    image = nativeImage.createFromPath(join(here, "assets", `${variant}-16.png`));
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(join(here, "assets", `${variant}-32.png`)).toPNG(),
  });
  image.setTemplateImage(false);
  return image;
}
// Native window chrome needs a startup color before renderer CSS is available.
// Keep this synchronized with the dark `--bg` design token and DESIGN.md.
declare const ATTE_WINDOW_BACKGROUND: string;
const WINDOW_BACKGROUND = ATTE_WINDOW_BACKGROUND;
const terminals = new TerminalHost((event) => {
  if (window && !window.isDestroyed()) window.webContents.send("atte:event", event);
}, process.env);
const rendererURL = pathToFileURL(join(here, "renderer/index.html")).href;
let tools: Executables, herdrInstallation: HerdrInstallation, herdrPlugin: HerdrPlugin, webhookNotifier: WebhookNotifier, skillInstaller: AtteSkillInstaller, agentHookManager: AgentHookManager, agentRuntimeBroker: AgentRuntimeBroker, externalTerminals: ExternalTerminalManager;
let coordinatorInbox: CoordinatorInbox | undefined, coordinatorDispatcher: CoordinatorDispatcher | undefined;
let herdrHostBridge: HerdrHostBridge | undefined;
let sessionControl: SessionControl;
let applicationUpdater: ApplicationUpdater | undefined;
const sessionRuntimes = new Map<string, SessionRuntime>();
const sessionHosts = new Map<string, Promise<SessionCommandHost>>();
const sessionPoller = new SessionPoller();
async function ensureSessionCommandHost(workspace: string): Promise<SessionCommandHost> {
  let pending = sessionHosts.get(workspace);
  if (!pending) {
    pending = (async () => {
      const host = new SessionCommandHost({
        workspace, directory: sessionControl.directory,
        canDispatch: () => sessionControl.canDispatch(),
        runtime: context => new SessionRuntime({
          ...sessionRuntime(workspace).options, managedContext: context, hostExecution: true,
        }),
      });
      await host.start();
      return host;
    })();
    sessionHosts.set(workspace, pending);
    void pending.catch(() => { if (sessionHosts.get(workspace) === pending) sessionHosts.delete(workspace); });
  }
  return pending;
}
async function backendAdapter(backend: "herdr", workspace: string) {
  const control = await sessionControl.status();
  const herdr = await herdrInstallation.ensure();
  if (!herdr.executable)
    throw new Error(herdr.detail || "Herdr 当前不可用。");
  return localAdapter({
    backend,
    workspace,
    control,
    directory: join(app.getPath("userData"), "session-control"),
    herdrExecutable: herdr.executable,
    environment: process.env,
    state: await new WorkspaceService(workspace).read(),
  });
}
function sessionRuntime(workspace = root) {
  if (!workspace) throw new Error("请先打开工作区");
  const existing = sessionRuntimes.get(workspace);
  if (existing) return existing;
  const runtime = new SessionRuntime({
    control: sessionControl,
    workspace,
    cliDirectory: join(app.getPath("userData"), "bin"),
    environment: process.env,
    prepareHost: async () => { await ensureSessionCommandHost(workspace); },
    adapter: backendAdapter,
  });
  sessionRuntimes.set(workspace, runtime);
  return runtime;
}
type SceneOpenResult =
  | { mode: "external"; lease: ExternalSceneLease }
  | { mode: "embedded" };
const workspaceSessions = new Map<string, string>();
function sessionName(path = root) {
  return environmentValue(process.env, "HERDR_SESSION")?.trim() ||
    workspaceSessions.get(path ?? "") || workspaceSessionName(path ?? "");
}
function sender(event: Electron.IpcMainInvokeEvent) { if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error("不受信任的界面请求"); }
function activeService() { if (!service) throw new Error("请先打开工作区"); return service; }
async function snapshot() { return activeService().read(); }
function cacheMaintenancePaths() {
  return {
    userDataRoot: app.getPath("userData"),
    cacheRoot: app.getPath("sessionData"),
    logsRoot: app.getPath("logs"),
    workspaceRoot: root,
  };
}
function queueCacheMaintenance<T>(task: () => Promise<T>): Promise<T> {
  const queued = cacheMaintenanceQueue.catch(() => undefined).then(task);
  cacheMaintenanceQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
async function runAutomaticCacheCleanup() {
  if (automaticCacheCleanupStarted) return;
  automaticCacheCleanupStarted = true;
  const marker = join(app.getPath("userData"), "cache-maintenance.json");
  try {
    const previous = JSON.parse(await readFile(marker, "utf8")) as { lastAutomaticRunAt?: string };
    if (previous.lastAutomaticRunAt &&
      Date.now() - Date.parse(previous.lastAutomaticRunAt) < 24 * 60 * 60 * 1000) return;
  } catch {
    // Missing or malformed bookkeeping only means it is time for one safe pass.
  }
  await queueCacheMaintenance(() => clearManagedCaches(cacheMaintenancePaths(), {
    mode: "automatic",
  }));
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(marker, `${JSON.stringify({
    lastAutomaticRunAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}
function broadcastSnapshot(state: WorkspaceState, workspace: string) {
  if (root !== workspace || !window || window.isDestroyed()) return;
  const signature = JSON.stringify(state);
  if (signature === lastSnapshotSignature) return;
  lastSnapshotSignature = signature;
  window.webContents.send("atte:event", { type: "snapshot", state, workspace });
}
async function validatedAttachment(goalId: string, attachmentId: string) {
  if (typeof goalId !== "string" || typeof attachmentId !== "string")
    throw new Error("附件参数无效");
  const target = activeService(), state = await target.read(),
    item = state.goals.find(goal => goal.id === goalId),
    attachment = item?.attachments?.find(candidate => candidate.id === attachmentId);
  if (!attachment) throw new Error("找不到这个附件");
  const [validated] = await validateGoalAttachments(target.root, [attachment]);
  return { target, attachment: validated!, path: attachmentAbsolutePath(target.root, validated!) };
}
function broadcastHerdrStatus(status: HerdrStatus) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("atte:event", {
    type: "herdr-status",
    status: {
      ...status,
      session: sessionName(),
      plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
    },
  });
}
type AgentHookStatuses = Awaited<ReturnType<AgentHookManager["status"]>>;
function broadcastAgentRuntimeStatus(
  statuses: AgentHookStatuses | Promise<AgentHookStatuses> = agentHookManager?.status() ?? [],
) {
  void Promise.resolve(statuses).then(status => {
    if (window && !window.isDestroyed())
      window.webContents.send("atte:event", {
        type: "agent-runtime-status",
        status,
      });
  }).catch(() => {});
}
function fallbackApplicationUpdateStatus(): ApplicationUpdateStatus {
  return {
    enabled: false,
    phase: "disabled",
    currentVersion: app.getVersion(),
    backgroundChecks: false,
    canCheck: false,
    canInstall: false,
    detail: "当前构建未启用应用更新。",
  };
}
function applicationUpdateStatus() {
  return applicationUpdater?.status() ?? fallbackApplicationUpdateStatus();
}
function broadcastApplicationUpdate(status: ApplicationUpdateStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("atte:event", { type: "application-update", status });
}
function notifyApplicationUpdateReady(status: ApplicationUpdateStatus) {
  if (!Notification.isSupported()) return;
  const version = status.latestVersion ? ` ${status.latestVersion}` : "";
  const notification = new Notification({
    title: "Atte 更新已准备好",
    body: `Atte${version} 已下载。打开设置，点击“安装并重启”后生效。`,
  });
  notification.on("click", () => {
    updateNotification = undefined;
    window?.show();
    window?.focus();
    window?.webContents.send("atte:event", { type: "open-settings" });
  });
  notification.on("close", () => {
    if (updateNotification === notification) updateNotification = undefined;
  });
  updateNotification = notification;
  notification.show();
}
async function coordinatedShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    quitting = true;
    diagnostics.record("app", "shutdown", "开始协调退出");
    applicationUpdater?.pause();
    if (synchronizeTimer) {
      clearInterval(synchronizeTimer);
      synchronizeTimer = undefined;
    }
    if (stateRefreshTimer) {
      clearTimeout(stateRefreshTimer);
      stateRefreshTimer = undefined;
    }
    stateWatcher?.close();
    stateWatcher = undefined;
    const settled = await settleAllWithin([
      ...handoffs.values(),
      ...ownerWriteTasks,
      cacheMaintenanceQueue,
      cliInstallQueue,
      ...preparations.values(),
      coordinatorDispatcher?.pause() ?? Promise.resolve(),
    ]);
    if (!settled.settled)
      diagnostics.record("app", "shutdown", "等待在途工作超时，已停止本地桥；未自动重放未确认投递");
    await coordinatorInbox?.recoverInterrupted().catch(error => {
      diagnostics.record("app", "shutdown-inbox-recovery", error);
    });
    await coordinatorInbox?.flush().catch(error => {
      diagnostics.record("app", "shutdown-inbox-flush", error);
    });
    const stopping = [
      agentRuntimeBroker?.stop(),
      herdrHostBridge?.stop(),
      ...[...sessionHosts.values()].map(async pending => {
        const host = await pending;
        await host.stop();
      }),
    ].filter((value): value is Promise<void> => Boolean(value));
    await Promise.allSettled(stopping);
    terminals.dispose();
    diagnostics.record("app", "shutdown", "本地桥已停止；Herdr 与 Agent 未关闭");
    await diagnostics.flush().catch(() => undefined);
  })().finally(() => {
    shutdownComplete = true;
  });
  await shutdownPromise;
}
async function initializeApplicationUpdater() {
  const testMode = environmentValue(process.env, "ATTE_DISABLE_UPDATE") === "1" ||
    Object.keys(process.env).some(key =>
      key.startsWith("TEST_") || key.startsWith("ATTE_TEST_"));
  const enabled = app.isPackaged &&
    existsSync(join(process.resourcesPath, "app-update.yml")) &&
    !testMode;
  applicationUpdater = new ApplicationUpdater({
    enabled,
    currentVersion: app.getVersion(),
    settingsPath: join(app.getPath("userData"), "application-update.json"),
    engine: enabled
      ? createElectronUpdaterEngine({
        info: message => diagnostics.record("app", "updater-info", message),
        warn: message => diagnostics.record("app", "updater-warn", message),
        error: message => diagnostics.record("app", "updater-error", message),
      })
      : undefined,
    onStatus: broadcastApplicationUpdate,
    onDownloaded: notifyApplicationUpdateReady,
    beforeInstall: async () => {
      await coordinatedShutdown();
    },
  });
  await applicationUpdater.start();
}
async function agentRuntimeStatus() {
  if (!agentHookManager) return [];
  return agentHookManager.status();
}
async function configureAgentRuntime(id: string, action: string) {
  if (!agentHookManager || !["codex", "claude-code", "cursor", "qoder", "omp"].includes(id))
    throw new Error("无效的 Agent Runtime Adapter");
  let result;
  if (action === "install") result = await agentHookManager.install(id as ManagedAdapterId);
  else if (action === "disable") result = await agentHookManager.disable(id as ManagedAdapterId);
  else if (action === "uninstall") result = await agentHookManager.uninstall(id as ManagedAdapterId);
  else if (action === "refresh") result = (await agentHookManager.autoInstallDetected())
    .find(item => item.id === id);
  else throw new Error("无效的 Agent 接入操作");
  await agentRuntimeBroker?.refresh();
  const statuses = await agentHookManager.status();
  broadcastAgentRuntimeStatus(statuses);
  return result ?? statuses.find(item => item.id === id);
}
async function installDetectedAgentHooks() {
  if (!agentHookManager) return [];
  const statuses = await agentHookManager.autoInstallDetected();
  broadcastAgentRuntimeStatus(statuses);
  return statuses;
}
async function remindRuntimeOwner(goal: Goal, prompt: string) {
  const target = activeService(), current = (await target.read()).goals.find(item => item.id === goal.id);
  if (!current?.scene || isReadOnlyGoal(current)) throw new Error("负责人现场暂不可达或目标为只读历史");
  const attemptId = current.agentRuntime?.attempt.attemptId;
  const turnId = current.agentRuntime?.receipt?.turnId;
  if (!attemptId || !turnId) throw new Error("负责人回合身份不完整，不能发送回执提醒");
  const receipt = await sessionRuntime(target.root).send(
    current.scene,
    receiptReminderDeliveryId(current.id, attemptId, turnId),
    prompt,
  );
  if (receipt.status === "rejected") throw new Error(receipt.detail ?? "负责人现场拒绝本次提醒。");
  return {
    status: receipt.status === "started" ? "sent" as const : "unconfirmed" as const,
    ...(receipt.detail ? { detail: receipt.detail } : {}),
  };
}
async function notifyRuntimeConcierge(goal: Goal, detail: string) {
  const target = activeService(), state = await target.read();
  const current = state.goals.find(item => item.id === goal.id) ?? goal;
  if (isReadOnlyGoal(current)) return;
  const issue: WatchdogRequest = {
    goalId: goal.id,
    reason: "protocol_missing",
    basis: current.watchdog?.basis ??
      current.agentRuntime?.receipt?.missingAt ??
      current.updatedAt,
  };
  await enqueueWatchdog(target, issue, detail);
  await drainCoordinatorQueue(target);
}
async function executable(command: string, cwd?: string) {
  return tools.find(command, cwd);
}
async function herdrStatus() {
  return {
    ...await herdrInstallation.status(),
    session: sessionName(),
    plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
  };
}
const AGENT_COMMANDS = [
  "codex",
  "claude",
  "cursor",
  "cursor-agent",
  "qoder",
  "qodercli",
  "omp",
  "gemini",
  "aider",
] as const;
async function agentChoices() {
  return Promise.all(AGENT_COMMANDS.map(async kind => ({
    kind, installed: Boolean(await executable(kind)),
  })));
}
let companionPreparation: {
  workspace: string;
  promise: Promise<Awaited<ReturnType<typeof prepareHerdrCompanionsNow>>>;
} | undefined;
function prepareHerdrCompanions(workspace = root) {
  const requestedWorkspace = workspace ?? "";
  if (companionPreparation?.workspace === requestedWorkspace)
    return companionPreparation.promise;
  const previous = companionPreparation?.promise.catch(() => undefined),
    promise = (previous ?? Promise.resolve()).then(() =>
      prepareHerdrCompanionsNow(requestedWorkspace),
    ).finally(() => {
      if (companionPreparation?.promise === promise)
        companionPreparation = undefined;
    });
  companionPreparation = { workspace: requestedWorkspace, promise };
  return promise;
}
async function prepareHerdrCompanionsNow(workspace = root) {
  try {
    await installCli(workspace);
    await installDetectedAgentHooks();
  } catch (error) {
    if (window && !window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `Atte CLI 或 Agent Hook 准备暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const status = await herdrInstallation.ensure();
  if (!status.executable) return status;
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  return status;
}
async function installHerdr() {
  try {
    await installCli();
    await installDetectedAgentHooks();
  } catch (error) {
    if (window && !window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `Atte CLI 或 Agent Hook 准备暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const status = await herdrInstallation.ensure(true);
  if (!status.executable) return status;
  await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  return status;
}
async function checkHerdrUpdate() {
  const status = await herdrInstallation.check();
  broadcastHerdrStatus(status);
  return status;
}
async function cliStatus() {
  const bundled = join(here, "cli/atte.cjs"), path = join(app.getPath("home"), ".local/bin/atte"), directory = join(app.getPath("userData"), "bin");
  return { bundled: Boolean(await access(bundled).then(() => true).catch(() => false)), installed: Boolean(await lstat(path).then(() => true).catch(() => false)), path, directory };
}
function skillsStatus() {
  return skillInstaller.status();
}
function installSkills() {
  return skillInstaller.install();
}
let cliInstallQueue: Promise<{ output: string }> = Promise.resolve({ output: "" });
function installCli(workspace = root) {
  const installing = cliInstallQueue.catch(() => undefined).then(() => installCliNow(workspace));
  cliInstallQueue = installing;
  return installing;
}
async function installCliNow(workspace = root) {
  const status = await cliStatus(); if (!status.bundled) throw new Error("安装包缺少内置 CLI");
  await mkdir(status.directory, { recursive: true });
  await mkdir(join(app.getPath("home"), ".local/bin"), { recursive: true });
  if (status.installed) {
    const existing = await readFile(status.path, "utf8").catch(() => "");
    const linked = await realpath(status.path).catch(() => "");
    const target = await readlink(status.path).catch(() => "");
    if (!existing.startsWith("#!/bin/sh\n# Atte embedded CLI\n") &&
      linked !== join(status.directory, "atte") && target !== join(status.directory, "atte"))
      throw new Error(`${status.path} 已存在，且不是 Atte 安装的 CLI。请手动处理后重试。`);
  }
  const cliRuntime = app.isPackaged ? join(process.resourcesPath, "cli-node") : process.execPath;
  const cliBundle = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked/dist/cli/atte.cjs") : join(here, "cli/atte.cjs");
  const launcher = join(status.directory, "atte");
  const defaultRoot = workspace ? quoteShell(workspace) : '""';
  const controlDirectory = join(app.getPath("userData"), "session-control");
  await writeFile(launcher, `#!/bin/sh\n# Atte embedded CLI\n[ -n "\${ATTE_WORKSPACE:-}\${CREWVANE_WORKSPACE:-}" ] || ATTE_WORKSPACE=${defaultRoot}\nexport ATTE_WORKSPACE CREWVANE_WORKSPACE=\${ATTE_WORKSPACE:-\${CREWVANE_WORKSPACE:-}}\nATTE_CONTROL_DIRECTORY=${quoteShell(controlDirectory)}\nATTE_CLI_DIRECTORY=${quoteShell(status.directory)}\nexport ATTE_CONTROL_DIRECTORY ATTE_CLI_DIRECTORY CREWVANE_CONTROL_DIRECTORY=\${ATTE_CONTROL_DIRECTORY} CREWVANE_CLI_DIRECTORY=\${ATTE_CLI_DIRECTORY}\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(cliRuntime)} ${quoteShell(cliBundle)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  if (status.installed) await unlink(status.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(launcher, status.path);
  await removeOwnedLegacyCli(legacyCliPaths(
    app.getPath("home"), app.getPath("appData"), app.getPath("userData"),
  ));
  // On first launch there may be no workspace yet. Do not run status from
  // Finder's "/" working directory, which would look like a request to create
  // "/.atte-lock". A real workspace queues a second preparation pass and
  // then performs the full CLI check.
  const checked = workspace
    ? await exec(status.path, ["status", "--root", workspace], { timeout: 15_000 })
    : undefined;
  const installed = await cliStatus();
  if (window && !window.isDestroyed()) {
    window.webContents.send("atte:event", { type: "cli-status", status: installed });
  }
  return { ...installed, output: checked?.stdout.trim() ?? "" };
}
function client(path: string, workspace = root) {
  const session = sessionName(workspace);
  if (!workspace) throw new Error("请先选择工作区");
  return new HerdrClient(herdrRunner(path, session), session, workspace, async () => {
    await terminals.attach(path, session, workspace!);
    if (root === workspace) window.webContents.send("atte:event", { type: "terminal-available", session, title: "全局管家" });
  });
}
function externalClient(path: string, workspace = root) {
  const session = sessionName(workspace);
  if (!workspace) throw new Error("请先选择工作区");
  return new HerdrClient(herdrRunner(path, session), session, workspace, async () => {
    // External scenes must never depend on the embedded PTY succeeding. Start
    // the named server headlessly; the user's terminal performs the attach.
    startDetachedHerdrServer(path, session, workspace);
  });
}
async function closeEndedGoalSession(target: WorkspaceService, goalId: string, executable?: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item || isReadOnlyGoal(item) || !["completed", "dropped"].includes(item.status)) return false;
  if (item.scene) {
    await sessionRuntime(target.root).captureOwnerResume(goalId, item.scene).catch(() => undefined);
    await sessionRuntime(target.root).close(item.scene, goalId);
    return true;
  }
  if (!item.herdr) return false;
  const herdrExecutable = executable ?? (await herdrStatus()).executable;
  if (!herdrExecutable) throw new Error("Herdr 当前不可用，负责人现场将在恢复后自动关闭");
  const connection = client(herdrExecutable, target.root);
  const resume = await connection.captureOwnerResume(item.herdr).catch(() => undefined);
  if (resume)
    await target.execute({ type: "session.preserve", goalId, resume });
  await connection.closeGoal(item.herdr);
  await target.execute({ type: "session.release", goalId });
  return true;
}
async function restartEndedGoal(target: WorkspaceService, goalId: string, note: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item) throw new Error("找不到目标");
  if (isReadOnlyGoal(item)) throw new Error("该目标为只读历史，不能重启或创建负责人");
  if (!["completed", "dropped"].includes(item.status))
    throw new Error("只有已完成或已放弃的目标可以重启");
  if (item.mode !== "concierge")
    throw new Error("个人事项请恢复到待办池，不需要重启 Agent");
  // A previous close may have failed. Close only an identity-verified scene
  // before opening the new backend attempt.
  if (item.scene || item.herdr)
    await closeEndedGoalSession(target, item.id);
  const restarted = await target.execute({ type: "goal.restart", goalId, note }) as Goal;
  void agentRuntimeBroker?.refresh(goalId).catch(() => {});
  void dispatchGoal(target, goalId).catch(error => {
    if (root === target.root && !window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `目标已重启，负责人恢复暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  if (root === target.root) {
    const state = await target.read();
    deliverGoalStatusChanges(target, state, target.root);
    broadcastSnapshot(state, target.root);
  }
  return restarted;
}
const preparations = new Map<string, Promise<import("../../../packages/core/src/index.js").SceneReferenceV1>>();
const handoffs = new Map<string, Promise<void>>();
function broadcastCoordinatorStatus(status: CoordinatorInboxStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("atte:event", { type: "coordinator-status", status });
}
function coordinatorPriority(kind: CoordinatorInboxItem["kind"], reason?: string) {
  if (kind === "feedback" || kind === "restart" || kind === "scene_reply") return "human" as const;
  if (kind === "follow_up") return "attention" as const;
  if (kind === "watchdog") return reason === "blocked" || reason === "missing"
    ? "attention" as const : "background" as const;
  if (kind === "reconcile") return "background" as const;
  return "normal" as const;
}
async function enqueueWatchdog(target: WorkspaceService, issue: WatchdogRequest, detail?: string) {
  if (root !== target.root) return;
  const goal = (await target.read()).goals.find(item => item.id === issue.goalId);
  if (!goal || isReadOnlyGoal(goal)) return;
  const { inbox } = await ensureCoordinatorInbox();
  await inbox.enqueue({
    goalId: issue.goalId,
    requestId: `watchdog-${issue.reason}-${issue.basis}`,
    kind: "watchdog",
    priority: coordinatorPriority("watchdog", issue.reason),
    watchdogReason: issue.reason,
    watchdogBasis: issue.basis,
    ...(detail ? { detail } : {}),
  });
}
function dispatchKind(goal: Goal): CoordinatorInboxItem["kind"] {
  switch (goal.dispatch?.kind) {
    case "follow_up": return "follow_up";
    case "scene_reply": return "scene_reply";
    case "restart": return "restart";
    case "feedback":
      return "feedback";
    default: return "goal";
  }
}
async function ensureCoordinatorInbox() {
  if (!coordinatorInbox || !coordinatorDispatcher) throw new Error("管家收件箱尚未准备好");
  return { inbox: coordinatorInbox, dispatcher: coordinatorDispatcher };
}
async function executeCoordinatorItem(
  target: WorkspaceService,
  item: CoordinatorInboxItem,
): Promise<CoordinatorExecutionResult> {
  if (shuttingDown)
    return { status: "deferred", detail: "应用正在退出，本次通知保留在队列中。" };
  if (root !== target.root)
    return { status: "cancelled", detail: "工作区已切换，本次收件未发送。" };
  const queuedGoal = (await target.read()).goals.find(goal => goal.id === item.goalId);
  if (!queuedGoal || isReadOnlyGoal(queuedGoal))
    return { status: "cancelled", detail: "目标不存在或已保留为只读历史。" };
  if (!await sessionControl.canDispatch())
    return { status: "deferred", detail: "运行时暂不可用，通知已保留。" };
  if (item.kind === "owner_write") {
    // A managed owner wrote through its own CLI. Deliver that case without
    // touching goal.dispatch: the write already happened and is not a failed
    // send the user must retry.
    const current = (await target.read()).goals.find(goal => goal.id === item.goalId);
    if (!current || isReadOnlyGoal(current) || current.mode !== "concierge" ||
      ["completed", "dropped", "backlog"].includes(current.status))
      return { status: "cancelled", detail: "目标已结束、已接管或不存在。" };
    try {
      const runtime = sessionRuntime(target.root);
      const concierge = await prepareConcierge(target);
      const site = (await runtime.inspect([concierge]))[0];
      if (site?.identity === "match" && ["working", "blocked"].includes(site.state))
        return { status: "deferred", detail: "管家仍在处理上一案卷，负责人写回已保留并稍后送达。" };
      await writeCoordinatorScope(target.root, item.goalId, item.requestId);
      const result = await runtime.notifyGoal(current, undefined, undefined, item.requestId);
      if (result.receipt.status === "rejected")
        throw new Error(result.receipt.detail ?? "管家现场拒绝本次写回通知。");
      return {
        status: result.receipt.status === "unknown" ? "unconfirmed" : "sent",
        detail: "负责人写回已交给管家核对。",
        estimatedChars: Math.min(20_000, current.next.length + JSON.stringify(current.activities.slice(-8)).length + 3_000),
      };
    } catch (error) {
      if (error instanceof SessionError && error.code === "backend_busy")
        return { status: "deferred", detail: error.message };
      if (isConciergeUnavailable(error))
        return { status: "deferred", detail: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
  if (item.kind === "watchdog") {
    if (!item.watchdogReason || !item.watchdogBasis)
      return { status: "cancelled", detail: "巡检请求缺少原因或基准，已取消。" };
    if (!["blocked", "missing", "stale", "unassigned", "settled", "protocol_missing"].includes(
      item.watchdogReason,
    )) return { status: "cancelled", detail: "巡检请求包含未知原因，已取消。" };
    try {
      const current = (await target.read()).goals.find(goal => goal.id === item.goalId);
      if (!current || isReadOnlyGoal(current))
        return { status: "cancelled", detail: "目标不存在或已保留为只读历史。" };
      if (current.watchdog?.basis !== item.watchdogBasis ||
        current.watchdog.reason !== item.watchdogReason || attentionRequest(current) ||
        ["completed", "dropped", "backlog"].includes(current.status))
        return { status: "cancelled", detail: "巡检依据已被新的现场或语义写回取代。" };
      const runtime = sessionRuntime(target.root);
      const concierge = await prepareConcierge(target);
      const site = (await runtime.inspect([concierge]))[0];
      if (site?.identity === "match" && ["working", "blocked"].includes(site.state))
        return { status: "deferred", detail: "管家正在处理上一回合，巡检通知仍保存在队列中。" };
      await writeCoordinatorScope(target.root, item.goalId, item.requestId);
      const result = await sessionRuntime(target.root).notifyGoal(
        current,
        `请核对巡检事项：${item.watchdogReason}。依据基准 ${item.watchdogBasis}。`,
        undefined,
        item.requestId,
      );
      if (result.receipt.status === "rejected") throw new Error(result.receipt.detail ?? "管家现场拒绝本次核对消息。");
      await target.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "contacted",
      });
      return { status: result.receipt.status === "unknown" ? "unconfirmed" : "sent", estimatedChars: 3_500 };
    } catch (error) {
      if (error instanceof SessionError && error.code === "backend_busy")
        return { status: "deferred", detail: error.message };
      if (isConciergeUnavailable(error))
        return { status: "deferred", detail: error instanceof Error ? error.message : String(error) };
      const detail = error instanceof Error ? error.message : String(error);
      await target.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "failed",
        detail: detail.slice(0, 1000),
      }).catch(() => {});
      return {
        status: "failed",
        detail,
        pauseQueue: /blocked|等待交互输入/i.test(detail),
      };
    }
  }

  const before = (await target.read()).goals.find(goal => goal.id === item.goalId);
  if (!before || isReadOnlyGoal(before) || before.mode !== "concierge" ||
    ["completed", "dropped"].includes(before.status)) {
    return { status: "cancelled", detail: "目标已结束、已接管或不存在。" };
  }
  if (before.dispatch?.id !== item.requestId)
    return { status: "cancelled", detail: "已有更新请求，本次请求已合并。" };

  try {
    const runtime = sessionRuntime(target.root);
    const concierge = await prepareConcierge(target);
    const site = await runtime.inspect([concierge]);
    if (site[0]?.state === "working")
      return {
        status: "deferred",
        detail: "管家仍在处理上一案卷，本通知已保留并将在其空闲后继续。",
      };
    if (site[0]?.state === "blocked")
      return {
        status: "deferred",
        detail: "管家正在等待人处理现场输入，本通知已保留且不会插入终端。",
      };
    await writeCoordinatorScope(
      target.root,
      item.goalId,
      item.requestId,
      item.kind === "scene_reply" ? before.sceneReply : undefined,
    );
    await deliverGoalUpdate(target, item.goalId, async current => {
      const result = await runtime.notifyGoal(current, current.dispatch?.note);
      if (result.receipt.status === "rejected")
        throw new Error(result.receipt.detail ?? "管家现场拒绝本次消息。");
      return {
        status: result.receipt.status === "unknown" ? "unconfirmed" : "sent",
        ...(result.receipt.detail ? { detail: result.receipt.detail } : {}),
      };
    }, item.requestId);
    const latest = (await target.read()).goals.find(goal => goal.id === item.goalId);
    if (!latest?.dispatch || latest.dispatch.id !== item.requestId)
      return { status: "cancelled", detail: "发送期间目标状态已更新，本次请求不再覆盖新状态。" };
    const deliveryStatus = latest.dispatch.status;
    let pauseQueue = false;
    if (deliveryStatus === "unconfirmed") {
      const presence = await runtime.inspect([concierge])
        .then(site => site[0]?.state)
        .catch(() => undefined);
      pauseQueue = presence === "working";
    }
    return {
      status: deliveryStatus === "pending" ? "failed" : deliveryStatus,
      detail: latest.dispatch.detail ??
        (deliveryStatus === "sent" ? "管家已收到本次案卷通知。" : undefined),
      estimatedChars: Math.min(
        20_000,
        (latest.description.length + latest.next.length + JSON.stringify(
          latest.activities.slice(-8),
        ).length + 3_000),
      ),
      pauseQueue,
    };
  } catch (error) {
    if (error instanceof SessionError && error.code === "backend_busy")
      return { status: "deferred", detail: error.message };
    if (isConciergeUnavailable(error))
      return { status: "deferred", detail: error instanceof Error ? error.message : String(error) };
    const detail = error instanceof Error ? error.message : String(error);
    const latest = (await target.read()).goals.find(goal => goal.id === item.goalId);
    if (latest && !isReadOnlyGoal(latest) &&
      latest.dispatch?.id === item.requestId && latest.dispatch.status === "pending") {
      await target.execute({
        type: "goal.dispatch",
        goalId: item.goalId,
        status: "failed",
        requestId: item.requestId,
        detail: `联系管家失败：${detail.replace(/[。.!！]\s*$/, "")}。内容已保存，请重试联系管家。`,
      }).catch(() => {});
    }
    return {
      status: "failed",
      detail,
      pauseQueue: /blocked|等待交互输入/i.test(detail),
    };
  }
}
async function resetCoordinatorContextIfNeeded(target: WorkspaceService) {
  const { inbox } = await ensureCoordinatorInbox();
  const status = await inbox.status();
  if (!status.contextResetDue || status.queued || status.processing) return;
  const state = await target.read();
  if (state.concierge.status !== "ready" || state.concierge.scene?.backend !== "herdr") return;
  const runtime = sessionRuntime(target.root);
  const site = (await runtime.inspect([state.concierge.scene]))[0];
  if (!site || !["idle"].includes(site.state)) return;
  await runtime.close(state.concierge.scene);
  await target.execute({
    type: "concierge.status",
    status: "not_ready",
    detail: "正在轮换管家上下文，已完成案卷仍保存在工作区。",
  });
  await prepareConcierge(target, true);
  await inbox.markContextReset();
  broadcastCoordinatorStatus(await inbox.status());
}
async function drainCoordinatorQueue(target: WorkspaceService) {
  if (root !== target.root) return;
  const { dispatcher } = await ensureCoordinatorInbox();
  await dispatcher.drain();
  if (root !== target.root) return;
  await resetCoordinatorContextIfNeeded(target).catch(error => {
    if (root === target.root && !window.isDestroyed()) {
      window.webContents.send("atte:event", {
        type: "diagnostic",
        message: `管家上下文轮换暂未完成：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
async function dispatchGoal(target: WorkspaceService, goalId: string): Promise<void> {
  if (shuttingDown) return;
  if (root !== target.root) return;
  if (!await sessionControl.canDispatch()) return;
  const key = `${target.root}:${goalId}`;
  const pending = handoffs.get(key); if (pending) return pending;
  const work = (async () => {
    try {
      let current = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!current || isReadOnlyGoal(current) || current.mode !== "concierge" ||
        ["backlog", "completed", "dropped"].includes(current.status)) return;
      if (current?.dispatch?.kind === "restart" && !current.scene && !current.herdr) {
        try {
          await restartOwnerSession(target, current);
        } catch (error) {
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/[。.!！]\s*$/, "");
          await target.execute({
            type: "goal.dispatch",
            goalId,
            status: "failed",
            requestId: current.dispatch.id,
            detail: `原负责人重启失败：${detail}`,
          });
          throw error;
        }
      }
      current = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!current || isReadOnlyGoal(current) || current.mode !== "concierge" ||
        ["backlog", "completed", "dropped"].includes(current.status)) return;
      if (current.dispatch?.status !== "pending") {
        current = await target.execute({
          type: "goal.dispatch",
          goalId,
          status: "pending",
        }) as Goal;
      }
      if (!current.dispatch?.id) throw new Error("目标缺少可持久化的派发编号");
      const { inbox } = await ensureCoordinatorInbox();
      await inbox.enqueue({
        goalId,
        requestId: current.dispatch.id,
        kind: dispatchKind(current),
        priority: coordinatorPriority(dispatchKind(current)),
      });
      await drainCoordinatorQueue(target);
    } finally {
      if (root === target.root) broadcastSnapshot(await target.read(), target.root);
    }
  })();
  handoffs.set(key, work);
  try { await work; } finally { handoffs.delete(key); }
}
function restartOwnerName(goal: Goal) {
  const candidate = goal.ownerResume?.owner?.trim();
  return candidate && /^[a-z][a-z0-9_-]{0,31}$/.test(candidate)
    ? candidate
    : `owner-${goal.id.slice(-8)}`;
}
function restartOwnerTask(goal: Goal) {
  return [
    `目标「${goal.title}」已由用户从 Atte 重新启动。`,
    `目标 ID：${goal.id}`,
    "这是续接原目标，不是新任务。先运行 atte goal show " + goal.id +
      " --json 核对当前记录、上次成果和原会话上下文；不要重复已经完成的工作。",
    "用户的新消息会由管家在下一条通知中交给你。现在只恢复状态并等待管家转交，不要自行扩大范围或直接结束目标。",
  ].join("\n\n");
}
async function restartOwnerSession(target: WorkspaceService, goal: Goal) {
  return sessionRuntime(target.root).launchOwner({
    goalId: goal.id,
    name: restartOwnerName(goal),
    task: restartOwnerTask(goal),
  });
}
function isConciergeUnavailable(error: unknown) {
  if (error instanceof SessionError)
    return ["scene_identity_mismatch", "scene_ended", "legacy_confirmation_required", "launch_unconfirmed"]
      .includes(error.code);
  if (error instanceof Error && error.cause instanceof SessionError)
    return ["scene_identity_mismatch", "scene_ended", "legacy_confirmation_required", "launch_unconfirmed"]
      .includes(error.cause.code);
  return false;
}
async function prepareConcierge(target = activeService(), recover = false) {
  const pending = preparations.get(target.root);
  if (pending) return pending;
  const preparing = doPrepareConcierge(target, recover);
  preparations.set(target.root, preparing);
  try { return await preparing; } finally { preparations.delete(target.root); }
}
async function doPrepareConcierge(target: WorkspaceService, recover: boolean) {
  await installCli(target.root);
  await installDetectedAgentHooks();
  const status = await herdrInstallation.ensure();
  if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好，请在设置中重试");
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  const state = await target.read();
  if (!state.concierge.scene ||
    state.concierge.initializedAttemptId !== state.concierge.scene.attemptId)
    await target.execute({
      type: "scene.concierge.status",
      status: "not_ready",
      detail: "正在准备全局管家…",
    });
  try {
    const scene = await sessionRuntime(target.root).prepareConcierge({ recover });
    // The runtime owns initialization/readiness. Reusing a verified concierge
    // must not clear its presence or generate another identity handshake.
    return scene;
  } catch (error) {
    // Never pass an untrusted transport's arbitrarily long stderr to a Core
    // status field. Keep a useful, bounded first line and leave the original
    // delivery receipt available for recovery.
    const reported = (error instanceof Error ? error.message : String(error))
      .split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
    const detail = reported.slice(0, 800) ||
      "管家初始化尚未确认；请打开原现场核对，Atte 不会重复创建或重发。";
    await target.execute({
      type: "concierge.status",
      status: recover ? "error" : "not_ready",
      reference: (await target.read()).concierge,
      detail,
    });
    throw new Error(`管家尚未准备好：${detail}`, { cause: error });
  }
}
async function openHerdr(reference?: HerdrReference, goalId?: string) {
  const target = activeService(), session = sessionName(target.root);
  const status = await herdrInstallation.ensure(); if (!status.executable) throw new Error("Herdr 尚未准备好，请在设置中重试");
  const connection = client(status.executable, target.root);
  await connection.ensureSession();
  if (reference?.tabId || reference?.agent) await connection.open(reference);
  else await connection.ensureWorkspace();
  if (goalId && reference?.agent && reference.agent !== "concierge") {
    await target.execute({ type: "scene.visit", goalId });
  }
  await terminals.attach(status.executable, session, target.root);
  if (root === target.root) window.webContents.send("atte:event", {
    type: "terminal-open", session, title: reference?.agent === "concierge" ? "全局管家" : "工作现场", goalId,
  });
}
async function openExternalScene(
  reference?: HerdrReference,
  goalId?: string,
): Promise<ExternalSceneLease> {
  const target = activeService(),
    session = sessionName(target.root),
    status = await herdrInstallation.ensure();
  if (!status.executable)
    throw new Error(status.detail || "Herdr 尚未准备好，请在设置中重试");
  const connection = externalClient(status.executable, target.root);
  await connection.ensureSession();
  if (reference?.tabId || reference?.agent) await connection.open(reference);
  else await connection.ensureWorkspace();
  if (goalId && reference?.agent && reference.agent !== "concierge")
    await target.execute({ type: "scene.visit", goalId });
  return externalTerminals.open({
    workspaceRoot: target.root,
    session,
    herdrExecutable: status.executable,
  });
}
async function openEmbeddedScene(target: WorkspaceService, goalId?: string) {
  const candidate = goalId ? (await target.read()).goals.find(goal => goal.id === goalId) : undefined;
  if (candidate && isReadOnlyGoal(candidate)) throw new Error("该目标为只读历史，不能打开或恢复现场");
  if (candidate?.mode === "manual" && !candidate.scene) {
    // A recorded personal item opens the real workspace, not a model session.
    // A failed concierge initialization must not disable terminal viewing.
    const executable = await herdrInstallationStatusBinary();
    await (await backendAdapter("herdr", target.root)).connect({
      installationId: (await sessionControl.status()).installationId,
      cwd: target.root, startIfMissing: true,
    });
    await client(executable, target.root).ensureWorkspace();
    await terminals.attach(executable, sessionName(target.root), target.root);
    if (root === target.root) window.webContents.send("atte:event", {
      type: "terminal-open", session: sessionName(target.root), title: "工作现场", goalId,
    });
    return;
  }
  const scene = await sceneForGoal(target, goalId);
  if (scene.backend !== "herdr") throw new Error("旧后端现场仅保留历史记录");
  await sessionRuntime(target.root).focus(scene);
  if (goalId) await target.execute({ type: "scene.visit", goalId });
  await terminals.attach(await herdrInstallationStatusBinary(), sessionName(target.root), target.root);
  if (root === target.root) window.webContents.send("atte:event", {
    type: "terminal-open", session: sessionName(target.root),
    title: goalId ? "工作现场" : "全局管家", goalId,
  });
}
async function openExternalSceneForGoal(target: WorkspaceService, goalId?: string) {
  const candidate = goalId ? (await target.read()).goals.find(goal => goal.id === goalId) : undefined;
  if (candidate && isReadOnlyGoal(candidate)) throw new Error("该目标为只读历史，不能打开或恢复现场");
  if (candidate?.mode === "manual" && !candidate.scene) {
    const executable = await herdrInstallationStatusBinary();
    await (await backendAdapter("herdr", target.root)).connect({
      installationId: (await sessionControl.status()).installationId,
      cwd: target.root, startIfMissing: true,
    });
    await client(executable, target.root).ensureWorkspace();
    return externalTerminals.open({ workspaceRoot: target.root,
      session: sessionName(target.root), herdrExecutable: executable });
  }
  const scene = await sceneForGoal(target, goalId);
  if (scene.backend !== "herdr") throw new Error("旧后端现场仅保留历史记录");
  await sessionRuntime(target.root).focus(scene);
  if (goalId) await target.execute({ type: "scene.visit", goalId });
  return externalTerminals.open({
    workspaceRoot: target.root,
    session: sessionName(target.root),
    herdrExecutable: await herdrInstallationStatusBinary(),
  });
}
async function openPreferredScene(
  target: WorkspaceService,
  goalId?: string,
  recover = false,
): Promise<SceneOpenResult> {
  if (recover) {
    if (!goalId) throw new Error("恢复现场需要目标 ID。");
    const goal = (await target.read()).goals.find(item => item.id === goalId);
    if (!goal || isReadOnlyGoal(goal)) throw new Error("目标不存在或为只读历史，不能恢复负责人");
    await sessionRuntime(target.root).recoverOwnerForConsultation(goalId);
  }
  const status = await externalTerminals.status();
  if (status.settings.openWith === "external") {
    return {
      mode: "external",
      lease: await openExternalSceneForGoal(target, goalId),
    };
  }
  await openEmbeddedScene(target, goalId);
  return { mode: "embedded" };
}
async function herdrInstallationStatusBinary() {
  const executable = (await herdrInstallation.status()).executable ?? environmentValue(process.env, "HERDR_BINARY");
  if (!executable) throw new Error("Herdr 当前不可用。");
  return executable;
}
async function sceneForGoal(target: WorkspaceService, goalId?: string) {
  const state = await target.read();
  if (!goalId) {
    return prepareConcierge(target, true);
  }
  const item = state.goals.find(goal => goal.id === goalId);
  if (!item) throw new Error("目标不存在");
  if (isReadOnlyGoal(item)) throw new Error("该目标为只读历史，不能打开或恢复现场");
  if (item.scene) {
    const observed = (await sessionRuntime(target.root).inspect([item.scene]))[0];
    if (observed?.identity !== "match")
      throw new Error(observed?.ownership === "legacy"
        ? "旧现场没有稳定的进程归属证据；请在目标详情确认原负责人已经退出，再恢复现场。"
        : "现场身份尚未稳定确认；未自动创建新负责人，请稍后重试或核对原终端。");
    if (observed?.identity === "match" && observed.state === "exited")
      throw new Error("原现场已结束，请在目标详情点击“恢复并进入现场”。未自动创建新负责人。");
    return (await target.read()).goals.find(goal => goal.id === goalId)?.scene ?? item.scene;
  }
  return prepareConcierge(target, true);
}
async function diagnosticsReport(): Promise<string> {
  const facts: string[] = [];
  const attempt = async (label: string, read: () => Promise<string> | string) => {
    try { facts.push(`${label}: ${await read()}`); }
    catch (error) {
      facts.push(`${label}: 读取失败 (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  await attempt("工作区", () => root ? compactPath(root, app.getPath("home")) : "未选择");
  await attempt("会话后端", async () => {
    const control = await sessionControl.status();
    const workspaces = await sessionControl.registrations();
    return `herdr · phase=${control.phase} · epoch=${control.epoch} · workspaces=${workspaces.length}`;
  });
  await attempt("Herdr", async () => {
    const status = await herdrStatus();
    return `installed=${Boolean(status.installed)} · version=${status.version ?? "-"}` +
      ` · latest=${status.latestVersion ?? "-"} · phase=${status.phase}` +
      ` · plugin=${status.plugin?.phase ?? "-"}`;
  });
  await attempt("CLI", async () => {
    const status = await cliStatus();
    const owned = await realpath(status.path).catch(() => "") === join(status.directory, "atte");
    const managedVersion = owned
      ? await exec(status.path, ["--version"], { timeout: 2_000, maxBuffer: 4_096 })
        .then(result => result.stdout.trim()).catch(() => "无法读取")
      : "未安装受管 CLI";
    return `installed=${status.installed} · bundled=${app.getVersion()} · managed=${managedVersion}`;
  });
  await attempt("Skills", async () => {
    const status = await skillsStatus();
    return `installed=${status.installed}/${status.available} · bundled=${status.version}` +
      ` · managed=${status.targets.filter(target => target.managedVersion)
        .map(target => `${target.id}:${target.managedVersion}`).join(",") || "-"}`;
  });
  await attempt("应用更新", () => {
    const status = applicationUpdateStatus();
    return `enabled=${status.enabled} · phase=${status.phase}` +
      ` · current=${status.currentVersion} · latest=${status.latestVersion ?? "-"}` +
      ` · checked=${status.lastCheckedAt ?? "-"}`;
  });
  await attempt("Agent 接入", async () => {
    const adapters = await agentRuntimeStatus();
    return adapters.length
      ? `Hook revision=${managedHookRevision} · ` +
        adapters.map(adapter => `${adapter.id}=${adapter.status}/${adapter.installed ? "installed" : "absent"}`).join(" · ")
      : "无";
  });
  await attempt("Hook 观测", async () => {
    if (!root) return "未打开工作区";
    return hookFailureSummary(readHookDiagnostics(root), diagnostics.startedAt);
  });
  await attempt("协调收件箱", async () => {
    const status = await (await ensureCoordinatorInbox()).inbox.status();
    return `queued=${status.queued} · processing=${Boolean(status.processing)} · alerts=${status.alerts.length}`;
  });
  await attempt("工作区状态", async () => {
    if (!service) return "未打开";
    const state = await service.read();
    return `version=${state.version} · projects=${state.projects.length} · goals=${state.goals.length}` +
      ` · attention=${attentionGoals(state.goals).length} · concierge=${state.concierge.status}`;
  });
  const separators = "─".repeat(24);
  return [
    diagnostics.report().trimEnd(),
    "",
    `环境快照（${new Date().toISOString()}）`,
    separators,
    ...facts,
    "",
    "说明：报告不包含目标正文、消息、附件、终端输出、Webhook 地址或凭据；绝对路径已替换为 ~。",
    "",
  ].join("\n");
}

function watchWorkspaceState(target: WorkspaceService) {
  stateWatcher?.close();
  if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
  stateWatcher = watch(workspaceDataDirectory(target.root), { persistent: false }, (_event, filename) => {
    const name = filename?.toString();
    if (name && name !== "state.json" && name !== "events.jsonl") return;
    if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
    stateRefreshTimer = setTimeout(async () => {
      if (root !== target.root || service !== target) return;
      try {
        const state = await target.read();
        ownerWrites.observe(state);
        await agentRuntimeBroker?.refresh();
        deliverGoalStatusChanges(target, state, target.root);
        broadcastSnapshot(state, target.root);
      } catch (error) {
        if (!window.isDestroyed()) window.webContents.send("atte:event", {
          type: "diagnostic",
          message: `工作区更新暂未同步：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }, 80);
  });
}
function deliverGoalStatusChanges(target: WorkspaceService, state: WorkspaceState, workspace: string) {
  if (knownGoalStatusWorkspace !== workspace) {
    knownGoalStatusWorkspace = workspace;
    knownGoalStatuses.clear();
    for (const goal of state.goals) knownGoalStatuses.set(goal.id, goal.status);
    return;
  }
  const current = new Set(state.goals.map(goal => goal.id));
  for (const id of knownGoalStatuses.keys())
    if (!current.has(id)) knownGoalStatuses.delete(id);
  for (const goal of state.goals) {
    const previousStatus = knownGoalStatuses.get(goal.id);
    knownGoalStatuses.set(goal.id, goal.status);
    if (isReadOnlyGoal(goal) || !previousStatus || previousStatus === goal.status) continue;
    void webhookNotifier.deliverStatusChange({
      workspace: { name: state.name },
      goal,
      previousStatus,
    }).catch(() => {});
  }
}
async function deliverAttentionNotifications(target: WorkspaceService, state: Awaited<ReturnType<WorkspaceService["read"]>>, workspace: string) {
  for (const goal of attentionGoals(state.goals).filter(goal => !isReadOnlyGoal(goal))) {
    if (root !== workspace) break;
    const kind = attentionKind(goal)!;
    if (!goal.attention?.notifiedAt && Notification.isSupported()) {
      try {
        const notification = new Notification({ title: kind === "review" ? "有一份成果等你验收" : kind === "follow_up" ? "到了该跟进的时候" : "Atte · 需要你处理", body: `${goal.title}\n${goal.attention?.summary ?? goal.next}`.slice(0, 220) });
        notification.on("click", () => { window.show(); window.webContents.send("atte:event", { type: "open-goal", goalId: goal.id }); });
        notification.show();
        await target.execute({ type: "notification.sent", goalId: goal.id, kind,
          attentionId: attentionRequest(goal)?.id, at: new Date().toISOString() });
      } catch {
        // The external channel and inbox remain available if system notification persistence fails.
      }
    }
    void webhookNotifier.deliver({ workspace: { name: state.name }, goal, kind }).catch(() => {});
  }
}
async function openWorkspace(path: string) {
  const canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw new Error("工作区必须是目录");
  const opened = new WorkspaceService(canonical), initialState = await opened.read();
  workspaceSessions.set(canonical, workspaceSessionName(canonical, process.env, initialState));
  await sessionControl.registerWorkspace(canonical);
  await ensureSessionCommandHost(canonical);
  await herdrHostBridge?.stop().catch(() => {});
  herdrHostBridge = new HerdrHostBridge(
    canonical,
    sessionName(canonical),
    async () => {
      const status = await herdrInstallation.ensure();
      if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好");
      return status.executable;
    },
  );
  await herdrHostBridge.start();
  await agentRuntimeBroker?.stop().catch(() => {});
  deliverGoalStatusChanges(opened, initialState, canonical);
  const inbox = await CoordinatorInbox.open(canonical);
  coordinatorInbox = inbox;
  coordinatorDispatcher = new CoordinatorDispatcher(inbox, {
    execute: item => executeCoordinatorItem(opened, item),
    onStatus: status => {
      if (root === canonical) broadcastCoordinatorStatus(status);
    },
  });
  root = canonical; service = opened;
  ownerWrites.seed(initialState);
  diagnostics.record("workspace", "open", `${canonical} · backend=herdr`);
  lastSnapshotSignature = undefined;
  const recovered = await inbox.recoverInterrupted();
  for (const { item, detail } of recovered) {
    const goal = (await opened.read()).goals.find(candidate => candidate.id === item.goalId);
    if (!goal || isReadOnlyGoal(goal)) continue;
    if (item.kind === "watchdog" && item.watchdogBasis) {
      await opened.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "failed",
        detail,
      }).catch(() => {});
      continue;
    }
    if (goal?.dispatch?.id === item.requestId) {
      await opened.execute({
        type: "goal.dispatch",
        goalId: item.goalId,
        status: "unconfirmed",
        requestId: item.requestId,
        detail,
      }).catch(() => {});
    }
  }
  broadcastCoordinatorStatus(await inbox.status());
  watchWorkspaceState(opened);
  await agentRuntimeBroker.start().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `Agent Hook 本地网关暂未启动：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  void opened.execute({ type: "attachments.cleanup", retentionDays: 30 }).catch(error => {
    if (!window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `附件清理暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  void runAutomaticCacheCleanup().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `缓存自动清理暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "workspaces.json"), JSON.stringify({ selected: root }), { mode: 0o600 });
  window.webContents.send("atte:event", { type: "refresh", workspace: root });
  if (environmentValue(process.env, "TEST_SKIP_HERDR_SETUP") !== "1")
    void prepareHerdrCompanions(canonical).catch(error => {
      if (!window.isDestroyed()) window.webContents.send("atte:event", {
        type: "diagnostic", message: error instanceof Error ? error.message : String(error),
      });
    });
  void coordinatorDispatcher?.drain().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `管家收件箱恢复暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
}
async function synchronize() {
  if (syncing || !service || !root) return;
  syncing = true;
  const target = service, workspace = root;
  try {
    let state = await target.read();
    deliverGoalStatusChanges(target, state, workspace);
    ownerWrites.observe(state);
    await deliverAttentionNotifications(target, state, workspace);
    if (!await sessionControl.canDispatch()) {
      broadcastSnapshot(state, workspace);
      return;
    }
    for (const goal of state.goals.filter(goal => !isReadOnlyGoal(goal) &&
      ["completed", "dropped"].includes(goal.status) && (goal.scene || goal.herdr)))
      await closeEndedGoalSession(target, goal.id).catch(() => {});
    state = await target.read();
    for (const goal of state.goals.filter(goal => !isReadOnlyGoal(goal) && goal.mode === "concierge" && goal.dispatch?.status === "pending" &&
      !["completed", "dropped"].includes(goal.status))) {
      void dispatchGoal(target, goal.id).catch(() => {});
    }
    const tracked = state.goals.filter(goal => !isReadOnlyGoal(goal) &&
      !["completed", "dropped"].includes(goal.status) && goal.scene?.backend === "herdr");
    const backendScenes = [
      ...(state.concierge.scene?.backend === "herdr" ? [state.concierge.scene] : []),
      ...tracked.flatMap(goal => goal.scene ? [goal.scene] : []),
    ];
    if (backendScenes.length) {
      try {
        const observations = await sessionPoller.inspect(backendScenes,
          scenes => sessionRuntime(workspace).inspect(scenes));
        if (observations) await target.execute({
          type: "scene.observe",
          scenes: observations.map(observation => ({
            bindingId: observation.bindingId,
            presence: {
              state: observation.state === "unknown" ? "unknown" :
                observation.state === "exited" ? "unknown" : observation.state,
              reachable: observation.reachable,
              checkedAt: observation.observedAt,
            },
          })),
        });
      } catch (error) {
        const current = await target.read();
        if (current.concierge.status === "ready" && current.concierge.scene?.backend === "herdr") {
          await target.execute({
            type: "concierge.status",
            status: "not_ready",
            live: {
              state: "unknown",
              checkedAt: new Date().toISOString(),
              reachable: false,
            },
            detail: `无法与 Herdr 同步：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    // This runs outside the coordinator queue: it talks only to the owner.
    for (const item of (await target.read()).goals.filter(goal => !isReadOnlyGoal(goal) && goal.sceneVisit?.status === "pending"))
      void reconcileSceneReply(target, item.id, {
        requestSceneReply: async goal => requestNeutralSceneReply(sessionRuntime(workspace), goal),
      }).catch(() => {});
    const requests = (await target.execute({ type: "watchdog.inspect", at: new Date().toISOString() }) as WatchdogRequest[]).slice(0, 10);
    state = await target.read();
    // An agent may write a decision or delivery while the concierge prompt is
    // in flight. That structured fact supersedes a quiet-terminal probe.
    const activeRequests = requests.filter(request => {
      const goal = state.goals.find(item => item.id === request.goalId);
      return goal && !isReadOnlyGoal(goal) && goal.watchdog?.basis === request.basis && !goal.attention;
    });
    if (activeRequests.length && root === workspace) {
      for (const request of activeRequests)
        await enqueueWatchdog(target, request);
    }
    if (root === workspace) await drainCoordinatorQueue(target);
    state = await target.read();
    await deliverAttentionNotifications(target, state, workspace);
    broadcastSnapshot(state, workspace);
  } catch (error) {
    if (root === workspace && !window.isDestroyed()) window.webContents.send("atte:event", { type: "diagnostic", message: `后台同步暂未成功：${error instanceof Error ? error.message : String(error)}` });
  } finally { syncing = false; }
}
const testUserData = environmentValue(process.env, "TEST_USER_DATA");
if (testUserData) {
  app.setPath("userData", testUserData);
} else {
  const applicationData = app.getPath("appData");
  app.setPath("userData", existsSync(join(applicationData, "Atte"))
    ? join(applicationData, "Atte")
    : existsSync(join(applicationData, "Crewvane"))
      ? join(applicationData, "Crewvane")
      : join(applicationData, "Atte"));
}
const applicationDataReady = (async () => {
  if (testUserData) return true;
  const applicationData = await migrateApplicationHome(app.getPath("appData"), "Atte", "Crewvane")
    .catch(error => ({
      directory: join(app.getPath("appData"), "Crewvane"), migrated: false,
      fallback: true, detail: `Atte 应用配置迁移未完成，已继续使用 Crewvane：${String(error)}`,
    }));
  if (applicationData.fallback && applicationData.detail) console.warn(applicationData.detail);
  app.setPath("userData", applicationData.directory);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  return true;
})();
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  if (!await applicationDataReady) return;
  const testHome = environmentValue(process.env, "TEST_HOME");
  if (testHome) app.setPath("home", testHome);
  if (testHome) {
    // Every Herdr child must address the same session, including the PTY and
    // CLI diagnostics. Changing Electron's home alone leaves HOME unchanged.
    process.env.HOME = app.getPath("home");
    process.env.XDG_CONFIG_HOME = join(app.getPath("home"), ".config");
    process.env.XDG_STATE_HOME = join(app.getPath("home"), ".local/state");
  }
  const applicationHome = await migrateApplicationHome(app.getPath("home"));
  if (applicationHome.fallback && applicationHome.detail) console.warn(applicationHome.detail);
  terminals.setEnvironment(process.env);
  webhookNotifier = new WebhookNotifier(app.getPath("userData"), app.getVersion());
  const managedBin = join(app.getPath("userData"), "runtime");
  tools = new Executables(app.getPath("home"), managedBin, process.env,
    !!testHome && environmentValue(process.env, "TEST_ISOLATE_TOOLS") === "1");
  agentHookManager = new AgentHookManager({
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    commandPath: command => tools.find(command),
  });
  agentRuntimeBroker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    hooks: agentHookManager,
    remindOwner: remindRuntimeOwner,
    notifyConcierge: notifyRuntimeConcierge,
    onChanged: () => {
      const target = service, workspace = root;
      if (target && workspace) void target.read().then(state => {
        if (root !== workspace) return;
        deliverGoalStatusChanges(target, state, workspace);
        broadcastSnapshot(state, workspace);
      }).catch(() => {});
      void agentRuntimeStatus().then(broadcastAgentRuntimeStatus);
    },
  });
  herdrInstallation = new HerdrInstallation(
    tools,
    join(managedBin, "herdr"),
    broadcastHerdrStatus,
    fetch,
    process.platform,
    process.arch,
    app.isPackaged ? join(process.resourcesPath, "herdr") : undefined,
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined,
  );
  sessionControl = new SessionControl(join(app.getPath("userData"), "session-control"));
  await sessionControl.initialize({ recoverInterrupted: true });
  if (environmentValue(process.env, "TEST_ISOLATE_TOOLS") === "1") herdrInstallation.disableBundledForTest();
  const integrationEnvironment = testHome ? {
    ...process.env,
    HOME: app.getPath("home"),
    XDG_CONFIG_HOME: join(app.getPath("home"), ".config"),
    XDG_STATE_HOME: join(app.getPath("home"), ".local/state"),
  } : process.env;
  externalTerminals = new ExternalTerminalManager({
    userDataRoot: app.getPath("userData"),
    env: integrationEnvironment,
  });
  herdrPlugin = new HerdrPlugin(
    app.isPackaged ? join(process.resourcesPath, "herdr-plugin") : join(app.getAppPath(), "herdr-plugin"),
    join(app.getPath("userData"), "herdr-plugin"),
    app.getVersion(),
    integrationEnvironment,
  );
  skillInstaller = new AtteSkillInstaller(
    app.isPackaged
      ? join(process.resourcesPath, "atte-skills")
      : join(here, "../../skills"),
    app.getPath("home"),
    app.getVersion(),
    ["atte"],
  );
  app.setName("Atte");
  app.setAboutPanelOptions({
    applicationName: "Atte",
    applicationVersion: app.getVersion(),
    copyright: "The attention layer",
  });
  // BrowserWindow.icon is ignored by the macOS Dock in development.
  // Packaged builds embed the same artwork as their CFBundleIconFile.
  app.dock?.setIcon(nativeImage.createFromPath(join(here, "assets/atte-app-icon.png")));
  process.env.PATH = (await tools.paths()).join(":");
  const width = Number(environmentValue(process.env, "TEST_WINDOW_WIDTH")), height = Number(environmentValue(process.env, "TEST_WINDOW_HEIGHT"));
  await diagnostics.enable();
  diagnostics.record("app", "ready", `${app.getVersion()} · Electron ${process.versions.electron}`);
  watchIpcFailures();
  window = new BrowserWindow({ width: Number.isFinite(width) && width >= 900 ? width : 1440, height: Number.isFinite(height) && height >= 700 ? height : 960, minWidth: 900, minHeight: 700, title: "Atte", titleBarStyle: "hiddenInset", backgroundColor: WINDOW_BACKGROUND, icon: join(here, "assets/atte-app-icon.png"), webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  nativeAutoUpdater.on("before-quit-for-update", () => { quitting = true; });
  window.webContents.on("render-process-gone", (_event, details) =>
    diagnostics.record("renderer", "render-process-gone", `${details.reason} (exit ${details.exitCode})`));
  window.webContents.on("unresponsive", () => diagnostics.record("renderer", "unresponsive"));
  window.webContents.on("did-fail-load", (_event, code, description, url) =>
    diagnostics.record("renderer", "did-fail-load", `${code} ${description}`));
  ipcMain.handle("atte:environment", (event) => { sender(event); return { workspace: root, version: app.getVersion() }; });
  ipcMain.handle("atte:application-update", event => {
    sender(event);
    return applicationUpdateStatus();
  });
  ipcMain.handle("atte:application-update-check", async event => {
    sender(event);
    if (!applicationUpdater) return fallbackApplicationUpdateStatus();
    return applicationUpdater.check();
  });
  ipcMain.handle("atte:application-update-background", async (event, enabled: unknown) => {
    sender(event);
    if (typeof enabled !== "boolean") throw new Error("自动更新设置无效");
    if (!applicationUpdater) return fallbackApplicationUpdateStatus();
    return applicationUpdater.setBackgroundChecks(enabled);
  });
  ipcMain.handle("atte:application-update-install", async event => {
    sender(event);
    if (!applicationUpdater) throw new Error("当前构建未启用应用更新");
    await applicationUpdater.install();
  });
  ipcMain.handle("atte:import-attachments", async (event, inputs: { name: string; bytes: ArrayBuffer }[]) => {
    sender(event);
    const target = activeService();
    if (!Array.isArray(inputs) || inputs.length > 8) throw new Error("附件列表无效");
    return importAttachmentBytes(target.root, inputs.map(input => ({ name: input?.name, bytes: input?.bytes })));
  });
  ipcMain.handle("atte:attachment-preview", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { attachment, path } = await validatedAttachment(goalId, attachmentId),
      image = nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error(`无法读取图片：${attachment.name}`);
    const size = image.getSize(), scale = Math.min(1, 360 / size.width, 240 / size.height);
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "best",
    }).toDataURL();
  });
  ipcMain.handle("atte:open-attachment", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { path } = await validatedAttachment(goalId, attachmentId),
      error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("atte:workspace", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择 Atte 工作区", properties: ["openDirectory", "createDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return null; await openWorkspace(picked.filePaths[0]); return root; });
  ipcMain.handle("atte:project", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择项目目录", properties: ["openDirectory"] }); const path = picked.filePaths[0]; if (!path) return null; const real = await realpath(path); selections.add(real); return real; });
  ipcMain.handle("atte:command", async (event, command: AtteCommand) => {
    sender(event); if (!command || JSON.stringify(command).length > 256_000) throw new Error("无效的命令");
    if (command.type === "project.add" && command.path && !selections.has(command.path)) throw new Error("请通过文件选择器选择项目目录");
    if (command.type === "agents.configure") {
      const kinds = (await agentChoices()).map(option => option.kind);
      for (const value of Object.values(command.preferences)) if (value?.trim()) parseAgentCommand(value, kinds);
    }
    const target = activeService();
    if (command.type === "goal.delete") {
      const item = (await target.read()).goals.find(goal => goal.id === command.goalId);
      if (item && ["completed", "dropped"].includes(item.status) && (item.scene || item.herdr))
        if (!isReadOnlyGoal(item)) await closeEndedGoalSession(target, item.id);
    }
    const result = await target.execute(command);
    void agentRuntimeBroker?.refresh(
      "goalId" in command && typeof command.goalId === "string"
        ? command.goalId
        : undefined,
    ).catch(() => {});
    if (command.type === "scene.visit" && command.retry) {
      void reconcileSceneReply(target, command.goalId, {
        requestSceneReply: goal => requestNeutralSceneReply(sessionRuntime(target.root), goal),
      }, { graceMs: 0 }).catch(() => {});
    }
    if (["goal.accept", "goal.complete", "goal.drop"].includes(command.type)) {
      const item = result as import("../../../packages/core/src/index.js").Goal;
      if (!isReadOnlyGoal(item)) await closeEndedGoalSession(target, item.id).catch((error) => {
        if (root === target.root) window.webContents.send("atte:event", {
          type: "diagnostic",
          message: `目标已结束，负责人现场暂未关闭，将自动重试：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
    if (["goal.rework", "goal.resolve", "goal.update"].includes(command.type)) {
      const item = result as Goal;
      const shouldDispatch = command.type === "goal.update"
        ? item.status === "active"
        : !["completed", "dropped"].includes(item.status);
      if (shouldDispatch && item.mode === "concierge" && !isReadOnlyGoal(item)) {
        const current = (await target.read()).goals.find(goal => goal.id === item.id);
        if (current?.dispatch?.status !== "pending") {
          await target.execute({
            type: "goal.dispatch",
            goalId: item.id,
            status: "pending",
            kind: "feedback",
          });
        }
        void dispatchGoal(target, item.id).catch(error => {
          if (root === target.root) window.webContents.send("atte:event", {
            type: "diagnostic",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    if (root === target.root) {
      const state = await target.read();
      deliverGoalStatusChanges(target, state, target.root);
      broadcastSnapshot(state, target.root);
    }
    return result;
  });
  ipcMain.handle("atte:herdr-status", (event) => { sender(event); return herdrStatus(); });
  ipcMain.handle("atte:cache-status", (event) => {
    sender(event);
    activeService();
    return queueCacheMaintenance(() => inspectManagedCaches(cacheMaintenancePaths()));
  });
  ipcMain.handle("atte:cache-clean", (event) => {
    sender(event);
    activeService();
    return queueCacheMaintenance(() => clearManagedCaches(cacheMaintenancePaths(), {
      mode: "manual",
      clearBrowserRuntime: () => session.defaultSession.clearCache(),
    }));
  });
  ipcMain.handle("atte:agent-choices", (event) => { sender(event); return agentChoices(); });
  ipcMain.handle("atte:webhook-settings", (event) => { sender(event); return webhookNotifier.status(); });
  ipcMain.handle("atte:webhook-save", (event, input: WebhookSaveInput) => {
    sender(event);
    return webhookNotifier.save(input);
  });
  ipcMain.handle("atte:webhook-test", async (event) => {
    sender(event);
    return webhookNotifier.test((await activeService().read()).name);
  });
  ipcMain.handle("atte:install-herdr", (event) => { sender(event); return installHerdr(); });
  ipcMain.handle("atte:check-herdr-update", (event) => {
    sender(event);
    return checkHerdrUpdate();
  });
  ipcMain.handle("atte:cli-status", (event) => { sender(event); return cliStatus(); });
  ipcMain.handle("atte:install-cli", (event) => { sender(event); return installCli(); });
  ipcMain.handle("atte:skills-status", (event) => { sender(event); return skillsStatus(); });
  ipcMain.handle("atte:install-skills", (event) => { sender(event); return installSkills(); });
  ipcMain.handle("atte:agent-runtime-status", (event) => {
    sender(event);
    return agentRuntimeStatus();
  });
  ipcMain.handle("atte:agent-runtime-action", async (event, id: unknown, action: unknown) => {
    sender(event);
    if (typeof id !== "string" || typeof action !== "string")
      throw new Error("Agent 接入参数无效");
    return configureAgentRuntime(id, action);
  });
  ipcMain.handle("atte:diagnostics-report", async event => {
    sender(event);
    return diagnosticsReport();
  });
  ipcMain.handle("atte:diagnostics-render-error", (event, summary: unknown) => {
    sender(event);
    if (typeof summary !== "string" || summary.length > 4_000) throw new Error("诊断信息无效");
    diagnostics.record("renderer", "window-error", summary);
  });
  ipcMain.handle("atte:clipboard-read", (event) => { sender(event); return clipboard.readText(); });
  ipcMain.handle("atte:clipboard-write", async (event, value: unknown) => {
    sender(event);
    if (typeof value !== "string" || value.length > 2_000_000) throw new Error("剪贴板文本无效");
    await clipboard.writeText(value);
  });
  ipcMain.handle("atte:clipboard-content", async (event) => {
    sender(event);
    const items = await clipboard.read();
    if (items.some(item => item.types.some(type => type.startsWith("image/"))))
      return { kind: "image" as const };
    const text = await clipboard.readText();
    return text ? { kind: "text" as const, text } : { kind: "empty" as const };
  });
  ipcMain.handle("atte:scene-settings", (event) => {
    sender(event);
    return externalTerminals.status();
  });
  ipcMain.handle("atte:scene-settings-save", (event, input: SceneSettings) => {
    sender(event);
    activeService();
    return externalTerminals.save(input);
  });
  ipcMain.handle("atte:scene-settings-test", async (event) => {
    sender(event);
    activeService();
    return openExternalScene();
  });
  ipcMain.handle("atte:prepare-concierge", (event) => {
    sender(event);
    sessionPoller.reset();
    return prepareConcierge(activeService(), true);
  });
  ipcMain.handle("atte:coordinator-status", async event => {
    sender(event);
    return (await ensureCoordinatorInbox()).inbox.status();
  });
  ipcMain.handle("atte:dispatch-goal", (event, goalId: string) => { sender(event); return dispatchGoal(activeService(), goalId); });
  ipcMain.handle("atte:restart-goal", (event, goalId: string, note: string) => {
    sender(event);
    if (typeof goalId !== "string" || typeof note !== "string")
      throw new Error("重启参数无效");
    return restartEndedGoal(activeService(), goalId, note);
  });
  ipcMain.handle("atte:open-terminal", async event => { sender(event); await openHerdr(); });
  ipcMain.handle("atte:open-herdr", async (event, goalId?: string) => {
    sender(event);
    await openEmbeddedScene(activeService(), goalId);
  });
  ipcMain.handle("atte:open-scene", async (event, goalId?: string, recover?: boolean) => {
    sender(event);
    if (recover !== undefined && typeof recover !== "boolean") throw new Error("无效的恢复参数。");
    return openPreferredScene(activeService(), goalId, recover);
  });
  ipcMain.handle("atte:confirm-legacy-scene", async (event, goalId: unknown, reason: unknown) => {
    sender(event);
    if (goalId !== undefined && (typeof goalId !== "string" || !goalId.trim()))
      throw new Error("旧现场确认参数无效。");
    if (typeof reason !== "string" || reason.trim().length < 4 || reason.length > 4_000)
      throw new Error("请写明确认旧现场已退出的原因。");
    const target = activeService();
    return sessionRuntime(target.root).confirmLegacyScene(
      typeof goalId === "string" ? goalId : undefined,
      reason.trim(),
    );
  });
  ipcMain.handle("atte:open-scene-external", async (event, goalId?: string) => {
    sender(event);
    return openExternalSceneForGoal(activeService(), goalId);
  });
  ipcMain.handle("atte:terminal-snapshot", (event) => { sender(event); activeService(); return terminals.snapshot(sessionName()); });
  ipcMain.handle("atte:terminal-write", (event, session: string, data: string) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.write(session, data);
  });
  ipcMain.handle("atte:terminal-resize", (event, session: string, cols: number, rows: number) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.resize(session, cols, rows);
  });
  ipcMain.handle("atte:open-url", async (event, url: string) => { sender(event); if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("只允许打开 HTTPS 链接"); await shell.openExternal(url); });
  ipcMain.handle("atte:open-recovery-backup", async (event) => {
    sender(event);
    const target = activeService(), recovery = (await target.read()).recovery;
    if (!recovery) throw new Error("当前工作区没有待查看的旧版备份");
    const owner = await realpath(target.root),
      archived = await realpath(recovery.archivedPath).catch(() => "");
    if (!archived || dirname(archived) !== owner || !basename(archived).startsWith(".atte.backup-"))
      throw new Error("旧版备份路径已失效或不属于当前工作区");
    const failure = await shell.openPath(archived);
    if (failure) throw new Error(`无法打开旧版备份：${failure}`);
  });
  ipcMain.handle("atte:show-cli", async (event) => { sender(event); shell.showItemInFolder((await cliStatus()).path); });
  tray = new Tray(trayIcon()); tray.setToolTip("Atte"); tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 Atte", click: () => { window.show(); window.focus(); } }, { type: "separator" }, { label: "退出", click: () => app.quit() }])); tray.on("click", () => { window.show(); window.focus(); });
  nativeTheme.on("updated", () => {
    if (tray && !tray.isDestroyed()) tray.setImage(trayIcon());
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Atte", submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "复制诊断日志",
        click: async () => {
          try {
            await clipboard.writeText(await diagnosticsReport());
            await dialog.showMessageBox({ type: "info", message: "诊断日志已复制",
              detail: "已复制脱敏报告，可直接粘贴给维护者排查；不包含目标正文、终端内容与凭据。" });
          } catch (error) {
            await dialog.showMessageBox({ type: "error", message: "复制诊断日志失败",
              detail: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      { type: "separator" },
      { role: "hide" },
      { role: "quit" },
    ] }, { role: "editMenu" }, { role: "viewMenu" }]));
  await window.loadURL(rendererURL);
  await initializeApplicationUpdater().catch(error => {
    diagnostics.record("app", "updater-init", error);
    if (!window.isDestroyed()) window.webContents.send("atte:event", {
      type: "diagnostic",
      message: `应用更新初始化失败：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  if (environmentValue(process.env, "TEST_SKIP_HERDR_SETUP") !== "1")
    void prepareHerdrCompanions().catch(() => { /* persistent readiness error is shown by the renderer */ });
  const saved = await readFile(join(app.getPath("userData"), "workspaces.json"), "utf8").then(JSON.parse).catch(() => null), workspace = environmentValue(process.env, "TEST_WORKSPACE") ?? saved?.selected;
  if (workspace) await openWorkspace(workspace).catch((error) => window.webContents.send("atte:event", { type: "diagnostic", message: String(error) }));
  if (environmentValue(process.env, "TEST_PREPARE_CONCIERGE") === "1") {
    void prepareConcierge(activeService(), true).catch((error) => window.webContents.send("atte:event", { type: "diagnostic", message: String(error) }));
  }
  synchronizeTimer = setInterval(() => void synchronize(), 10_000);
  void synchronize();
});
app.on("activate", () => window?.show());
app.on("before-quit", event => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitAfterShutdown) return;
  quitAfterShutdown = true;
  void coordinatedShutdown().finally(() => {
    if (shutdownComplete) app.quit();
  });
});
