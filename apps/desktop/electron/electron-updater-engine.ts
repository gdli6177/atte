import { autoUpdater } from "electron-updater";
import type {
  ApplicationUpdateEngine,
  ApplicationUpdateEngineEvents,
  ApplicationUpdateInfo,
  ApplicationUpdateLogger,
  ApplicationUpdateProgress,
} from "./application-updater.js";

interface UpdateInfoLike {
  version: string;
  releaseDate?: string | null;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ version?: string | null; note?: string | null }> | null;
}

function releaseNotes(value: UpdateInfoLike["releaseNotes"]): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const notes = value
    .map(item => [item.version, item.note]
      .filter((part): part is string => typeof part === "string" && Boolean(part))
      .join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return notes || undefined;
}

function normalizeInfo(value: UpdateInfoLike): ApplicationUpdateInfo {
  const notes = releaseNotes(value.releaseNotes);
  return {
    version: value.version,
    ...(value.releaseDate ? { releaseDate: value.releaseDate } : {}),
    ...(value.releaseName ? { releaseName: value.releaseName } : {}),
    ...(notes ? { releaseNotes: notes } : {}),
  };
}

function normalizeProgress(value: ApplicationUpdateProgress): ApplicationUpdateProgress {
  return {
    percent: value.percent,
    transferred: value.transferred,
    total: value.total,
    bytesPerSecond: value.bytesPerSecond,
  };
}

/**
 * Thin adapter around electron-updater. It deliberately leaves the state
 * machine, notification policy and install coordination to ApplicationUpdater.
 */
export function createElectronUpdaterEngine(
  logger?: ApplicationUpdateLogger,
): ApplicationUpdateEngine {
  const updater = autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true;
  if (logger) updater.logger = logger;

  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: true,
    logger: logger ?? null,
    async checkForUpdates() {
      const result = await updater.checkForUpdates();
      return result?.updateInfo ? { updateInfo: normalizeInfo(result.updateInfo) } : null;
    },
    downloadUpdate: () => updater.downloadUpdate(),
    quitAndInstall: () => updater.quitAndInstall(),
    on<E extends keyof ApplicationUpdateEngineEvents>(
      event: E,
      listener: ApplicationUpdateEngineEvents[E],
    ) {
      const wrapped = (...args: unknown[]) => {
        if (event === "checking-for-update") {
          (listener as ApplicationUpdateEngineEvents["checking-for-update"])();
          return;
        }
        if (event === "download-progress") {
          (listener as ApplicationUpdateEngineEvents["download-progress"])(
            normalizeProgress(args[0] as ApplicationUpdateProgress),
          );
          return;
        }
        if (event === "error") {
          const error = args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? "未知错误"));
          (listener as ApplicationUpdateEngineEvents["error"])(error);
          return;
        }
        (listener as (info: ApplicationUpdateInfo) => void)(
          normalizeInfo(args[0] as UpdateInfoLike),
        );
      };
      updater.on(event, wrapped as never);
      return () => updater.removeListener(event, wrapped as never);
    },
  };
}
