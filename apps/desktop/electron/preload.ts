import { contextBridge, ipcRenderer } from "electron";
import type { AtteCommand, GoalAttachment } from "../../../packages/core/src/index.js";
import type { ApplicationUpdateStatus } from "./application-updater.js";
contextBridge.exposeInMainWorld("atte", {
  command: (command: AtteCommand) => ipcRenderer.invoke("atte:command", command),
  importAttachments: (inputs: { name: string; bytes: ArrayBuffer }[]) =>
    ipcRenderer.invoke("atte:import-attachments", inputs) as Promise<GoalAttachment[]>,
  attachmentPreview: (goalId: string, attachmentId: string) =>
    ipcRenderer.invoke("atte:attachment-preview", goalId, attachmentId) as Promise<string>,
  openAttachment: (goalId: string, attachmentId: string) =>
    ipcRenderer.invoke("atte:open-attachment", goalId, attachmentId) as Promise<void>,
  selectWorkspace: () => ipcRenderer.invoke("atte:workspace"), selectProject: () => ipcRenderer.invoke("atte:project"),
  environment: () => ipcRenderer.invoke("atte:environment"), herdrStatus: () => ipcRenderer.invoke("atte:herdr-status"),
  applicationUpdate: () =>
    ipcRenderer.invoke("atte:application-update") as Promise<ApplicationUpdateStatus>,
  checkApplicationUpdate: () =>
    ipcRenderer.invoke("atte:application-update-check") as Promise<ApplicationUpdateStatus>,
  setApplicationUpdateBackground: (enabled: boolean) =>
    ipcRenderer.invoke("atte:application-update-background", enabled) as Promise<ApplicationUpdateStatus>,
  installApplicationUpdate: () =>
    ipcRenderer.invoke("atte:application-update-install") as Promise<void>,
  cacheMaintenanceStatus: () => ipcRenderer.invoke("atte:cache-status"),
  cleanCache: () => ipcRenderer.invoke("atte:cache-clean"),
  agentChoices: () => ipcRenderer.invoke("atte:agent-choices"),
  webhookSettings: () => ipcRenderer.invoke("atte:webhook-settings"),
  saveWebhook: (input: unknown) => ipcRenderer.invoke("atte:webhook-save", input),
  testWebhook: () => ipcRenderer.invoke("atte:webhook-test"),
  installHerdr: () => ipcRenderer.invoke("atte:install-herdr"),
  checkHerdrUpdate: () => ipcRenderer.invoke("atte:check-herdr-update"),
  cliStatus: () => ipcRenderer.invoke("atte:cli-status"),
  skillsStatus: () => ipcRenderer.invoke("atte:skills-status"), installSkills: () => ipcRenderer.invoke("atte:install-skills"),
  agentRuntimeStatus: () => ipcRenderer.invoke("atte:agent-runtime-status"),
  configureAgentRuntime: (id: string, action: "install" | "disable" | "uninstall" | "refresh") =>
    ipcRenderer.invoke("atte:agent-runtime-action", id, action),
  readClipboardText: () => ipcRenderer.invoke("atte:clipboard-read"),
  diagnosticsReport: () => ipcRenderer.invoke("atte:diagnostics-report") as Promise<string>,
  reportRendererError: (summary: string) =>
    ipcRenderer.invoke("atte:diagnostics-render-error", summary) as Promise<void>,
  readClipboardContent: () => ipcRenderer.invoke("atte:clipboard-content"),
  writeClipboardText: (value: string) => ipcRenderer.invoke("atte:clipboard-write", value),
  sceneSettings: () => ipcRenderer.invoke("atte:scene-settings"),
  saveSceneSettings: (input: unknown) => ipcRenderer.invoke("atte:scene-settings-save", input),
  testSceneSettings: () => ipcRenderer.invoke("atte:scene-settings-test"),
  openTerminal: () => ipcRenderer.invoke("atte:open-terminal"),
  installCli: () => ipcRenderer.invoke("atte:install-cli"), prepareConcierge: () => ipcRenderer.invoke("atte:prepare-concierge"),
  coordinatorStatus: () => ipcRenderer.invoke("atte:coordinator-status"),
  dispatchGoal: (goalId: string) => ipcRenderer.invoke("atte:dispatch-goal", goalId),
  restartGoal: (goalId: string, note: string) =>
    ipcRenderer.invoke("atte:restart-goal", goalId, note),
  terminalSnapshot: () => ipcRenderer.invoke("atte:terminal-snapshot"),
  writeTerminal: (session: string, data: string) => ipcRenderer.invoke("atte:terminal-write", session, data),
  resizeTerminal: (session: string, cols: number, rows: number) => ipcRenderer.invoke("atte:terminal-resize", session, cols, rows),
  openScene: (goalId?: string, recover?: boolean) => ipcRenderer.invoke("atte:open-scene", goalId, recover),
  confirmLegacyScene: (goalId: string | undefined, reason: string) =>
    ipcRenderer.invoke("atte:confirm-legacy-scene", goalId, reason) as Promise<boolean>,
  openExternalScene: (goalId?: string) => ipcRenderer.invoke("atte:open-scene-external", goalId),
  openHerdr: (goalId?: string) => ipcRenderer.invoke("atte:open-herdr", goalId), openUrl: (url: string) => ipcRenderer.invoke("atte:open-url", url), showCli: () => ipcRenderer.invoke("atte:show-cli"),
  openRecoveryBackup: () => ipcRenderer.invoke("atte:open-recovery-backup"),
  subscribe: (listener: (event: any) => void) => { const handler = (_: unknown, data: unknown) => listener(data); ipcRenderer.on("atte:event", handler); return () => ipcRenderer.removeListener("atte:event", handler); },
});
