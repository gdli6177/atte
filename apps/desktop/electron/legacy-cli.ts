import { lstat, readFile, readlink, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface LegacyCliPaths {
  path: string;
  currentBin: string;
  legacyBin: string;
  legacyKit: string;
}
export async function removeOwnedLegacyCli(paths: LegacyCliPaths): Promise<boolean> {
  let info;
  try {
    info = await lstat(paths.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() && !info.isSymbolicLink()) return false;
  const body = info.isFile()
    ? await readFile(paths.path, "utf8").catch(() => "")
    : "";
  const managedScript = body.startsWith("#!/bin/sh\n# Crewvane embedded CLI\n") ||
    body.startsWith("#!/bin/sh\n# Atte embedded CLI\n") ||
    body.startsWith("#!/bin/sh\n# crewvane-shim\n");
  const target = info.isSymbolicLink() ? await readlink(paths.path).catch(() => "") : "";
  const managedLink = target === join(paths.currentBin, "crewvane") ||
    target === join(paths.legacyBin, "crewvane") ||
    target === join(paths.legacyKit, "current/cli/bin/crewvane.js");
  if (!managedScript && !managedLink) return false;
  await unlink(paths.path);
  return true;
}

export function legacyCliPaths(home: string, appData: string, userData: string): LegacyCliPaths {
  return {
    path: join(home, ".local/bin/crewvane"),
    currentBin: join(userData, "bin"),
    legacyBin: join(appData, "Crewvane/bin"),
    legacyKit: join(home, ".crewvane"),
  };
}
