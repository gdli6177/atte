import { Download, RefreshCw } from "lucide-react";
import type { ApplicationUpdateStatus } from "../../../electron/application-updater.js";
import { Button, SettingsSection, Toggle } from "../../ui/index.js";

const phaseLabel: Record<ApplicationUpdateStatus["phase"], string> = {
  disabled: "不可用",
  idle: "已就绪",
  checking: "正在检查",
  available: "发现新版本",
  downloading: "正在下载",
  downloaded: "可安装",
  installing: "正在准备安装",
  error: "需要处理",
};

export function ApplicationUpdateSettings({
  status,
  busy,
  onCheck,
  onInstall,
  onBackgroundChange,
}: {
  status: ApplicationUpdateStatus;
  busy: boolean;
  onCheck: () => Promise<void>;
  onInstall: () => Promise<void>;
  onBackgroundChange: (enabled: boolean) => Promise<void>;
}) {
  const latest = status.latestVersion && status.latestVersion !== status.currentVersion
    ? status.latestVersion
    : undefined;
  const progress = status.progress;
  const working = busy || ["checking", "downloading", "installing"].includes(status.phase);
  return (
    <SettingsSection
      wide
      icon={<Download />}
      title="应用更新"
      description="后台检查并下载新版本；安装和重启只在你明确点击后发生。"
    >
      <div className="application-update-facts" role="status" aria-live="polite">
        <div>
          <small>当前版本</small>
          <strong>{status.currentVersion}</strong>
        </div>
        <div>
          <small>{status.canInstall ? "可安装版本" : latest ? "新版本" : "更新状态"}</small>
          <strong>{latest ?? phaseLabel[status.phase]}</strong>
        </div>
        {status.releaseDate && latest && (
          <div>
            <small>发布时间</small>
            <strong>{formatDate(status.releaseDate)}</strong>
          </div>
        )}
        {status.lastCheckedAt && (
          <div>
            <small>上次检查</small>
            <strong>{formatDate(status.lastCheckedAt)}</strong>
          </div>
        )}
      </div>

      {status.phase === "downloading" && progress && (
        <div className="application-update-progress">
          <div>
            <span>正在下载更新</span>
            <strong>{Math.round(progress.percent)}%</strong>
          </div>
          <progress max={100} value={progress.percent} aria-label="应用更新下载进度" />
          {progress.total > 0 && (
            <small>
              {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
              {progress.bytesPerSecond > 0 ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ""}
            </small>
          )}
        </div>
      )}

      <p className={status.phase === "error" ? "ui-field__error" : "ui-field__hint"}>
        {status.detail ?? (status.enabled
          ? "应用会每 6 小时在后台检查更新，下载过程不影响正在运行的 Herdr 和 Agent。"
          : "当前构建未启用应用更新。安装正式包后可使用自动更新。")}
      </p>

      {status.enabled && (
        <Toggle
          label="后台自动检查并下载"
          description="只在后台获取新版本，不会自动安装、关闭现场或重启应用。"
          checked={status.backgroundChecks}
          disabled={working}
          onChange={event => void onBackgroundChange(event.currentTarget.checked)}
        />
      )}

      <div className="ui-settings-card__actions">
        <Button
          variant={status.canInstall ? "secondary" : "primary"}
          size="sm"
          icon={<RefreshCw size={14} />}
          disabled={!status.canCheck || working}
          onClick={() => void onCheck()}
        >
          {status.phase === "checking" ? "正在检查…" : "检查更新"}
        </Button>
        {status.canInstall && (
          <Button
            variant="primary"
            size="sm"
            icon={<Download size={14} />}
            disabled={working}
            onClick={() => void onInstall()}
          >
            安装 {latest ?? "新版本"} 并重启
          </Button>
        )}
      </div>

      {status.canInstall && (
        <p className="ui-field__hint">
          Atte 会先保存现场和未确认投递状态，再关闭本地界面；Herdr 与 Agent 不会被关闭。
        </p>
      )}

      {status.releaseNotes && (
        <details className="settings-update-notes">
          <summary>本版发布说明</summary>
          <pre>{status.releaseNotes}</pre>
        </details>
      )}
    </SettingsSection>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
