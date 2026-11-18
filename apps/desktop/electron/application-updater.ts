import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ApplicationUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface ApplicationUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface ApplicationUpdateInfo {
  version: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
}

export interface ApplicationUpdateStatus {
  enabled: boolean;
  phase: ApplicationUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
  progress?: ApplicationUpdateProgress;
  lastCheckedAt?: string;
  detail?: string;
  backgroundChecks: boolean;
  canCheck: boolean;
  canInstall: boolean;
}

export interface ApplicationUpdateLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

export interface ApplicationUpdateEngineEvents {
  "checking-for-update": () => void;
  "update-not-available": (info: ApplicationUpdateInfo) => void;
  "update-available": (info: ApplicationUpdateInfo) => void;
  "download-progress": (progress: ApplicationUpdateProgress) => void;
  "update-downloaded": (info: ApplicationUpdateInfo) => void;
  error: (error: Error) => void;
}

export interface ApplicationUpdateEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  logger: ApplicationUpdateLogger | null;
  checkForUpdates(): Promise<{ updateInfo: ApplicationUpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on<E extends keyof ApplicationUpdateEngineEvents>(
    event: E,
    listener: ApplicationUpdateEngineEvents[E],
  ): () => void;
}

interface StoredSettings {
  version: 1;
  backgroundChecks: boolean;
  notifiedVersion?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ApplicationUpdaterOptions {
  enabled: boolean;
  currentVersion: string;
  settingsPath: string;
  engine?: ApplicationUpdateEngine;
  onStatus?: (status: ApplicationUpdateStatus) => void;
  onDownloaded?: (status: ApplicationUpdateStatus) => void;
  beforeInstall?: () => Promise<void>;
  autoDownload?: boolean;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

const MAX_RELEASE_NOTES_LENGTH = 12_000;

function cleanText(value: unknown, maxLength = MAX_RELEASE_NOTES_LENGTH) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function cleanProgress(value: ApplicationUpdateProgress): ApplicationUpdateProgress {
  return {
    percent: Math.max(0, Math.min(100, Number.isFinite(value.percent) ? value.percent : 0)),
    transferred: Math.max(0, Number.isFinite(value.transferred) ? value.transferred : 0),
    total: Math.max(0, Number.isFinite(value.total) ? value.total : 0),
    bytesPerSecond: Math.max(0, Number.isFinite(value.bytesPerSecond) ? value.bytesPerSecond : 0),
  };
}

function copyStatus(status: ApplicationUpdateStatus): ApplicationUpdateStatus {
  return {
    ...status,
    ...(status.progress ? { progress: { ...status.progress } } : {}),
  };
}

/**
 * Owns the update state machine independently from Electron. The Electron
 * adapter is kept separate so this behavior can be tested without starting an
 * application or contacting GitHub.
 */
export class ApplicationUpdater {
  private readonly options: ApplicationUpdaterOptions;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly unsubscribers: Array<() => void> = [];
  private statusValue: ApplicationUpdateStatus;
  private settings: StoredSettings = { version: 1, backgroundChecks: true };
  private timer: TimerHandle | undefined;
  private started = false;
  private paused = false;
  private disposed = false;
  private checkPromise: Promise<void> | undefined;
  private downloadPromise: Promise<void> | undefined;
  private installPromise: Promise<void> | undefined;

  constructor(options: ApplicationUpdaterOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
    this.statusValue = {
      enabled: options.enabled,
      phase: options.enabled ? "idle" : "disabled",
      currentVersion: options.currentVersion,
      backgroundChecks: true,
      canCheck: false,
      canInstall: false,
    };
  }

  async start(): Promise<ApplicationUpdateStatus> {
    if (this.started) return this.status();
    this.started = true;
    this.paused = false;
    await this.loadSettings();
    if (this.options.enabled && this.options.engine) this.bindEngine(this.options.engine);
    else this.statusValue.enabled = false;
    this.statusValue.backgroundChecks = this.settings.backgroundChecks;
    this.statusValue.phase = this.statusValue.enabled ? "idle" : "disabled";
    this.publish();
    if (this.statusValue.enabled && this.settings.backgroundChecks)
      this.schedule(this.options.initialDelayMs ?? 5_000);
    return this.status();
  }

  status(): ApplicationUpdateStatus {
    return copyStatus(this.statusValue);
  }

  pause(): void {
    this.paused = true;
    this.cancelTimer();
  }

  async check(): Promise<ApplicationUpdateStatus> {
    if (!this.started) await this.start();
    if (!this.statusValue.enabled || !this.options.engine) return this.status();
    if (this.paused) return this.status();
    if (["downloaded", "installing"].includes(this.statusValue.phase))
      return this.status();
    if (this.checkPromise) {
      await this.checkPromise;
      return this.status();
    }
    this.checkPromise = this.performCheck();
    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = undefined;
    }
    return this.status();
  }

  async setBackgroundChecks(enabled: boolean): Promise<ApplicationUpdateStatus> {
    if (!this.started) await this.start();
    const settings: StoredSettings = { ...this.settings, backgroundChecks: enabled };
    await this.saveSettings(settings);
    this.settings = settings;
    this.statusValue.backgroundChecks = enabled;
    if (!enabled) this.cancelTimer();
    else if (this.statusValue.enabled) this.schedule(this.options.initialDelayMs ?? 5_000);
    this.publish();
    return this.status();
  }

  async install(): Promise<void> {
    if (this.installPromise) return this.installPromise;
    if (!this.statusValue.enabled || !this.options.engine) {
      throw new Error("当前构建未启用应用更新。");
    }
    if (this.statusValue.phase !== "downloaded") {
      throw new Error("更新尚未下载完成，暂时不能安装。");
    }
    this.installPromise = (async () => {
      this.patch({
        phase: "installing",
        detail: "正在保存现场并准备重启…",
      });
      try {
        await this.options.beforeInstall?.();
        this.options.engine!.quitAndInstall();
      } catch (error) {
        this.paused = false;
        const detail = error instanceof Error ? error.message : String(error);
        this.patch({ phase: "error", detail: `安装更新失败：${detail}` });
        throw error;
      }
    })();
    try {
      await this.installPromise;
    } finally {
      this.installPromise = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  private async performCheck(): Promise<void> {
    this.patch({
      phase: "checking",
      detail: "正在检查更新…",
      lastCheckedAt: this.now().toISOString(),
      progress: undefined,
    });
    try {
      const result = await this.options.engine!.checkForUpdates();
      if (result?.updateInfo) {
        this.applyInfo(result.updateInfo);
        if (this.statusValue.phase === "checking")
          this.patch({ phase: "available", detail: "发现新版本，正在准备下载…" });
      } else if (this.statusValue.phase === "checking") {
        this.patch({ phase: "idle", detail: "已是最新版本。" });
      }
    } catch (error) {
      this.fail("检查更新失败", error);
    }
  }

  private bindEngine(engine: ApplicationUpdateEngine): void {
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.autoRunAppAfterInstall = true;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.disableDifferentialDownload = true;
    this.unsubscribers.push(
      engine.on("checking-for-update", () => {
        if (this.statusValue.phase === "checking")
          this.publish();
      }),
      engine.on("update-not-available", info => {
        if (!["downloaded", "installing"].includes(this.statusValue.phase))
          this.patch({ ...this.infoPatch(info), phase: "idle", detail: "已是最新版本。" });
      }),
      engine.on("update-available", info => {
        if (["downloaded", "installing"].includes(this.statusValue.phase)) return;
        this.applyInfo(info);
        this.startDownload();
      }),
      engine.on("download-progress", progress => {
        if (["downloaded", "installing"].includes(this.statusValue.phase)) return;
        this.patch({
          phase: "downloading",
          progress: cleanProgress(progress),
          detail: "正在后台下载更新…",
        });
      }),
      engine.on("update-downloaded", info => {
        void this.downloaded(info);
      }),
      engine.on("error", error => {
        if (!["downloaded", "installing"].includes(this.statusValue.phase))
          this.fail("更新操作失败", error);
      }),
    );
  }

  private startDownload(): void {
    if (this.downloadPromise || !this.statusValue.enabled || !this.options.engine) return;
    if (this.paused) return;
    if (["downloaded", "installing"].includes(this.statusValue.phase)) return;
    if (this.options.autoDownload === false) {
      this.patch({ phase: "available", detail: "发现新版本，可在设置中下载。" });
      return;
    }
    this.patch({
      phase: "downloading",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      detail: "正在后台下载更新…",
    });
    this.downloadPromise = Promise.resolve()
      .then(() => this.options.engine!.downloadUpdate())
      .then(() => undefined)
      .catch(error => {
        if (this.statusValue.phase !== "downloaded")
          this.fail("下载更新失败", error);
      })
      .finally(() => {
        this.downloadPromise = undefined;
      });
  }

  private async downloaded(info: ApplicationUpdateInfo): Promise<void> {
    if (this.disposed) return;
    if (this.paused) return;
    if (this.statusValue.phase === "installing") return;
    this.applyInfo(info);
    this.patch({
      phase: "downloaded",
      progress: {
        percent: 100,
        transferred: this.statusValue.progress?.total ?? 0,
        total: this.statusValue.progress?.total ?? 0,
        bytesPerSecond: 0,
      },
      detail: `Atte ${info.version} 已下载。安装并重启后生效。`,
      lastCheckedAt: this.statusValue.lastCheckedAt ?? this.now().toISOString(),
    });
    if (this.settings.notifiedVersion === info.version) return;
    this.settings = { ...this.settings, notifiedVersion: info.version };
    await this.saveSettings(this.settings).catch(() => undefined);
    try {
      this.options.onDownloaded?.(this.status());
    } catch {
      // A failed notification must not corrupt the update state.
    }
  }

  private applyInfo(info: ApplicationUpdateInfo): void {
    this.patch({ ...this.infoPatch(info) });
  }

  private infoPatch(info: ApplicationUpdateInfo) {
    return {
      latestVersion: cleanText(info.version, 80),
      releaseDate: cleanText(info.releaseDate, 80),
      releaseName: cleanText(info.releaseName, 200),
      releaseNotes: cleanText(info.releaseNotes),
    };
  }

  private fail(prefix: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.patch({
      phase: "error",
      detail: `${prefix}：${detail.slice(0, 800)}`,
    });
  }

  private patch(patch: Partial<ApplicationUpdateStatus>): void {
    if (this.disposed) return;
    this.statusValue = {
      ...this.statusValue,
      ...patch,
      canCheck: this.canCheck(),
      canInstall: this.statusValue.enabled && this.statusValue.phase === "downloaded",
    };
    this.publish();
  }

  private canCheck(): boolean {
    return this.statusValue.enabled &&
      !["checking", "downloading", "downloaded", "installing"].includes(this.statusValue.phase);
  }

  private publish(): void {
    if (this.disposed) return;
    this.statusValue.canCheck = this.canCheck();
    this.statusValue.canInstall = this.statusValue.enabled &&
      this.statusValue.phase === "downloaded";
    try {
      this.options.onStatus?.(this.status());
    } catch {
      // Rendering or IPC failures must not interrupt the update state machine.
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.paused || !this.statusValue.enabled || !this.settings.backgroundChecks) return;
    if (["downloaded", "installing"].includes(this.statusValue.phase)) return;
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.check().finally(() => {
        if (!this.disposed) this.schedule(this.options.intervalMs ?? 6 * 60 * 60 * 1_000);
      });
    }, Math.max(0, delayMs));
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private async loadSettings(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.settingsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const value = parsed as Partial<StoredSettings>;
      this.settings = {
        version: 1,
        backgroundChecks: value.backgroundChecks !== false,
        ...(typeof value.notifiedVersion === "string" && value.notifiedVersion
          ? { notifiedVersion: value.notifiedVersion }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.settings = { version: 1, backgroundChecks: true };
    }
  }

  private async saveSettings(settings: StoredSettings): Promise<void> {
    const directory = dirname(this.options.settingsPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.settingsPath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.options.settingsPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
