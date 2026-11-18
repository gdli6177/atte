import { appendFile, mkdir, rename, stat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { arch, release, type } from "node:os";
import type { HookDiagnosticsSnapshot } from "../../../cli/src/hook-diagnostics.js";

/**
 * Sanitized, size-bounded diagnostics for support hand-offs.
 *
 * The report never contains goal text, messages, terminal output, attachments,
 * webhook endpoints or credentials. Every recorded detail passes the same
 * redaction rules, and persisted entries keep those rules for the next start.
 */
export type DiagnosticScope = "app" | "ipc" | "renderer" | "backend" | "session" | "workspace";

export interface DiagnosticsOptions {
  version(): string;
  directory(): string | undefined;
  /** Used only to replace absolute paths with `~` in the report. */
  home?(): string | undefined;
  now?(): Date;
  /** Keeps the report small enough to paste into a chat message. */
  maxEntries?: number;
  maxBytes?: number;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer <redacted>"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "<redacted-token>"],
  [
    /\b(password|passwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi,
    "$1=<redacted>",
  ],
  [/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://<redacted>@"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, "<redacted-email>"],
  [/[A-Za-z0-9+/_-]{40,}/g, "<redacted>"],
];

/** Keeps support reports useful without exposing a full local path. */
export function compactPath(path: string, home?: string): string {
  if (home && home.length > 1 && path.startsWith(home)) return `~${path.slice(home.length)}`;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

export function hookFailureSummary(snapshot: HookDiagnosticsSnapshot, startedAt: string) {
  const counts = Object.entries(snapshot.counts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  if (!counts.length) return "无失败";
  const failure = snapshot.lastFailure;
  const phase = failure && Date.parse(failure.at) >= Date.parse(startedAt)
    ? "本次应用启动后" : "本次应用启动前的历史记录";
  return `历史累计 ${counts.join(" · ")}${failure
    ? ` · 最近=${failure.reason}@${failure.at}（${phase}）`
    : ""}`;
}

export function redact(value: string, home?: string): string {
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (home && home.length > 1) {
    for (const prefix of [home, home.replaceAll("\\", "/")])
      text = text.split(prefix).join("~");
  }
  for (const [pattern, replacement] of REDACTIONS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error)?.slice(0, 400) ?? String(error);
  } catch {
    return String(error);
  }
}

interface Entry {
  at: string;
  scope: DiagnosticScope;
  event: string;
  detail?: string;
}

export class Diagnostics {
  readonly startedAt: string;
  private readonly entries: Entry[] = [];
  private readonly options: DiagnosticsOptions;
  private directory?: string;
  private writing: Promise<void> = Promise.resolve();
  private enabled = false;

  constructor(options: DiagnosticsOptions) {
    this.options = options;
    this.startedAt = (options.now?.() ?? new Date()).toISOString();
  }

  get logPath(): string | undefined {
    return this.directory ? join(this.directory, "diagnostics.log") : undefined;
  }

  /** Starts disk persistence once the real userData path is known. */
  async enable(): Promise<void> {
    const directory = this.options.directory();
    if (!directory || this.enabled) return;
    await mkdir(directory, { recursive: true }).catch(() => {});
    const path = join(directory, "diagnostics.log");
    // Recover the tail from the previous run so a restart does not erase the
    // evidence a user is about to share. The rotated generation is older and
    // read first so entries stay in chronological order.
    const previous = [
      await readFile(`${path}.1`, "utf8").catch(() => ""),
      await readFile(path, "utf8").catch(() => ""),
    ].join("");
    for (const line of previous.split("\n").slice(-(this.options.maxEntries ?? 240))) {
      const entry = this.parse(line);
      if (entry) this.entries.push(entry);
    }
    this.trim();
    await appendFile(path, "", { mode: 0o600 }).catch(() => {});
    this.directory = directory;
    this.enabled = true;
  }

  record(scope: DiagnosticScope, event: string, detail?: unknown): void {
    const text = detail === undefined ? undefined
      : redact(errorDetail(detail), this.options.home?.());
    const entry: Entry = {
      at: (this.options.now?.() ?? new Date()).toISOString(),
      scope,
      event: redact(event, undefined),
      ...(text ? { detail: text } : {}),
    };
    this.entries.push(entry);
    this.trim();
    this.persist(entry);
  }

  installProcessHandlers(): void {
    process.on("uncaughtException", error => this.record("app", "uncaught-exception", error));
    process.on("unhandledRejection", error => this.record("app", "unhandled-rejection", error));
  }

  private parse(line: string): Entry | undefined {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as Partial<Entry>;
      if (typeof value.at !== "string" || typeof value.scope !== "string" || typeof value.event !== "string") return;
      return {
        at: value.at,
        scope: value.scope as DiagnosticScope,
        event: redact(value.event),
        ...(typeof value.detail === "string" ? { detail: redact(value.detail) } : {}),
      };
    } catch {
      return;
    }
  }

  private trim(): void {
    const limit = this.options.maxEntries ?? 240;
    while (this.entries.length > limit) this.entries.shift();
  }

  private persist(entry: Entry): void {
    const path = this.logPath;
    if (!this.enabled || !path) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.writing = this.writing
      .then(async () => {
        await appendFile(path, line, { mode: 0o600 });
        const info = await stat(path);
        if (info.size <= (this.options.maxBytes ?? 512_000)) return;
        // Keep one rotated generation: enough history for support without
        // letting a long-running install accumulate unbounded data.
        await rename(path, `${path}.1`).catch(() => {});
        await rm(path, { force: true }).catch(() => {});
      })
      .catch(() => {});
  }

  /** Awaits queued disk writes; used by shutdown and tests. */
  async flush(): Promise<void> {
    await this.writing;
  }

  report(): string {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const directory = this.options.directory();
    const home = this.options.home?.();
    const lines: string[] = [
      "Atte 诊断日志（可整段粘贴给维护者）",
      `生成时间: ${now}`,
      `本次应用启动: ${this.startedAt}`,
      `版本: ${this.options.version()}`,
      `系统: macOS ${release()} ${arch()} (${type()})`,
      `运行时: Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · Node ${process.versions.node}`,
    ];
    const logPath = this.logPath;
    if (logPath) lines.push(`日志文件: ${compactPath(logPath, home)}`);
    if (!this.enabled) lines.push("持久化: 未启用（仅在内存中保留本次启动事件）");
    lines.push("", "最近事件:");
    if (!this.entries.length) lines.push("  （无）");
    for (const entry of this.entries.slice(-120))
      lines.push(`  ${entry.at} [${entry.scope}] ${entry.event}${entry.detail ? ` — ${entry.detail}` : ""}`);
    return `${lines.join("\n")}\n`;
  }

  /** Exposed for tests and for the support report of a previous run. */
  entriesSnapshot(): Entry[] {
    return this.entries.map(entry => ({ ...entry }));
  }
}
