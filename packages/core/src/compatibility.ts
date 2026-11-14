export const STATE_DIRECTORY = ".atte";
export const LEGACY_STATE_DIRECTORY = ".crewvane";
export const LOCK_DIRECTORY = ".atte-lock";
export const LEGACY_LOCK_DIRECTORY = ".crewvane-lock";

export function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return environment[`ATTE_${name}`] ?? environment[`CREWVANE_${name}`];
}

export function exportEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
): void {
  environment[`ATTE_${name}`] = value;
  environment[`CREWVANE_${name}`] = value;
}

export function rewriteStoredCompatibility<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => rewriteStoredCompatibility(item)) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = key === "minimumCrewvane" ? "minimumAtte" : key;
    result[nextKey] = key === "schema" && item === "crewvane.bot.v1"
      ? "atte.bot.v1" : rewriteStoredCompatibility(item);
  }
  return result as T;
}

export function migrateStoredState<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => migrateStoredState(item)) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = key === "path" && typeof item === "string" &&
      item.startsWith(`${LEGACY_STATE_DIRECTORY}/attachments/`)
      ? `${STATE_DIRECTORY}/${item.slice(LEGACY_STATE_DIRECTORY.length + 1)}`
      : migrateStoredState(item);
  }
  return rewriteStoredCompatibility(result) as T;
}
import { lstatSync } from "node:fs";
import { join } from "node:path";

export function isUsableDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function workspaceDataDirectory(root: string): string {
  const current = join(root, STATE_DIRECTORY), legacy = join(root, LEGACY_STATE_DIRECTORY);
  if (isUsableDirectory(current)) return current;
  if (isUsableDirectory(legacy)) return legacy;
  try {
    lstatSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
    throw error;
  }
  throw new Error("状态目录不能是符号链接或非目录文件");
}

export function legacyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("ATTE_") && value !== undefined)
      result[`CREWVANE_${key.slice(5)}`] = value;
  }
  return result;
}
