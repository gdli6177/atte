import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { environmentValue } from "../../packages/core/src/compatibility.js";

export const HOOK_DIAGNOSTICS_MAX_BYTES = 16_384;
export const HOOK_DIAGNOSTIC_REASONS = [
  "stdin_epipe", "stdin_error", "spawn_error", "sync_error", "child_exit",
  "timeout", "overflow", "read_error", "unsupported_adapter", "invalid_payload",
  "invalid_json", "unsupported_event", "sequence_unavailable", "spool_too_large",
  "spool_failed", "ingest_error",
] as const;
export type HookDiagnosticReason = typeof HOOK_DIAGNOSTIC_REASONS[number];

export interface HookDiagnosticsSnapshot {
  version: 1;
  counts: Partial<Record<HookDiagnosticReason, number>>;
  lastFailure?: { reason: HookDiagnosticReason; at: string };
}

export interface HookDiagnosticInput {
  reason: HookDiagnosticReason;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function ownedDirectory(path: string, create: boolean) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()))
    throw new Error("Unusable hook diagnostics directory");
}

function diagnosticsDirectory(workspace: string, create: boolean) {
  if (!isAbsolute(workspace)) throw new Error("Invalid hook workspace");
  ownedDirectory(workspace, false);
  let directory = join(workspace, ".atte");
  try { lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const legacy = join(workspace, ".crewvane");
    try {
      ownedDirectory(legacy, false);
      directory = legacy;
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
    }
  }
  ownedDirectory(directory, create);
  directory = join(directory, "runtime");
  ownedDirectory(directory, create);
  return directory;
}

function readSnapshot(path: string): HookDiagnosticsSnapshot {
  const snapshot: HookDiagnosticsSnapshot = { version: 1, counts: {} };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > HOOK_DIAGNOSTICS_MAX_BYTES ||
      (process.getuid && info.uid !== process.getuid())) return snapshot;
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (parsed?.version !== 1) return snapshot;
    for (const reason of HOOK_DIAGNOSTIC_REASONS) {
      const count = parsed.counts?.[reason];
      if (Number.isSafeInteger(count) && count > 0)
        snapshot.counts[reason] = count;
    }
    const failure = parsed.lastFailure;
    if (HOOK_DIAGNOSTIC_REASONS.includes(failure?.reason) &&
      typeof failure.at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failure.at) &&
      Number.isFinite(Date.parse(failure.at)))
      snapshot.lastFailure = { reason: failure.reason, at: failure.at };
  } catch {
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return snapshot;
}

export function readHookDiagnostics(workspace: string): HookDiagnosticsSnapshot {
  try {
    return readSnapshot(join(diagnosticsDirectory(workspace, false), "hook-diagnostics.json"));
  } catch {
    return { version: 1, counts: {} };
  }
}

async function acquireLock(path: string, create: boolean) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
  }
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() &&
    (!process.getuid || info.uid === process.getuid());
}

export async function recordHookDiagnostic(
  input: HookDiagnosticInput,
  options: { lockTimeoutMs?: number } = {},
): Promise<boolean> {
  let lock: string | undefined;
  let temporary: string | undefined;
  try {
    const environment = input.environment ?? process.env;
    if (!["GOAL_ID", "ATTEMPT_ID", "HOOK_TOKEN", "AGENT_NAME", "WORKSPACE"]
      .every(name => environmentValue(environment, name)?.trim()) ||
      !HOOK_DIAGNOSTIC_REASONS.includes(input.reason)) return false;
    const directory = diagnosticsDirectory(environmentValue(environment, "WORKSPACE")!.trim(), true);
    const lockPath = join(directory, "hook-diagnostics.lock");
    const deadline = Date.now() + Math.min(1_000, Math.max(0, options.lockTimeoutMs ?? 100));
    while (true) {
      if (await acquireLock(lockPath, true)) {
        lock = lockPath;
        break;
      }
      const info = lstatSync(lockPath);
      if (info.isDirectory() && !info.isSymbolicLink() &&
        (!process.getuid || info.uid === process.getuid()) &&
        Date.now() - info.mtimeMs > 60_000) rmdirSync(lockPath);
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const path = join(directory, "hook-diagnostics.json");
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid())) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const snapshot = readSnapshot(path);
    snapshot.counts[input.reason] = Math.min(Number.MAX_SAFE_INTEGER,
      (snapshot.counts[input.reason] ?? 0) + 1);
    snapshot.lastFailure = { reason: input.reason, at: (input.now?.() ?? new Date()).toISOString() };
    const body = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(body) > HOOK_DIAGNOSTICS_MAX_BYTES) return false;
    temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch {}
    }
    if (lock) {
      try { rmdirSync(lock); } catch {}
    }
  }
}
