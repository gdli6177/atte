import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LEGACY_STATE_DIRECTORY, STATE_DIRECTORY } from "./compatibility.js";
import { migrateStoredState } from "./compatibility.js";
import { withLock } from "./storage.js";

export interface StateMigrationResult {
  directory: string;
  migrated: boolean;
  fallback: boolean;
  detail?: string;
}

async function exists(path: string) {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

interface CopyEntry {
  path: string;
  type: "file" | "symlink";
}

async function filesUnder(
  root: string,
  prefix = "",
  allowSymlinks = false,
): Promise<CopyEntry[]> {
  const files: CopyEntry[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      if (!allowSymlinks) throw new Error(`状态迁移不跟随符号链接：${path}`);
      files.push({ path, type: "symlink" });
    } else if (entry.isDirectory())
      files.push(...await filesUnder(root, path, allowSymlinks));
    else if (entry.isFile()) files.push({ path, type: "file" });
    else throw new Error(`状态迁移只复制普通文件：${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyCopy(source: string, destination: string, allowSymlinks = false) {
  const expected = await filesUnder(source, "", allowSymlinks),
    actual = await filesUnder(destination, "", allowSymlinks);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("状态迁移副本的文件清单不一致");
  for (const { path, type } of expected) {
    if (type === "symlink") {
      const [before, after] = await Promise.all([
        readlink(join(source, path)), readlink(join(destination, path)),
      ]);
      if (before !== after) throw new Error(`状态迁移符号链接校验失败：${path}`);
      continue;
    }
    const [before, after] = await Promise.all([
      readFile(join(source, path)),
      readFile(join(destination, path)),
    ]);
    if (createHash("sha256").update(before).digest("hex") !==
      createHash("sha256").update(after).digest("hex"))
      throw new Error(`状态迁移副本校验失败：${path}`);
  }
}

export async function prepareWorkspaceState(root: string): Promise<StateMigrationResult> {
  const owner = await realpath(root);
  const current = join(owner, STATE_DIRECTORY), legacy = join(owner, LEGACY_STATE_DIRECTORY);
  if (await exists(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      const legacyInfo = await lstat(legacy).catch(() => undefined);
      if (legacyInfo && !legacyInfo.isSymbolicLink() && legacyInfo.isDirectory())
        return {
          directory: legacy, migrated: false, fallback: true,
          detail: `Atte 状态目录不可用，已继续使用 ${LEGACY_STATE_DIRECTORY}。`,
        };
      throw new Error("状态目录不能是符号链接或非目录文件");
    }
    return { directory: current, migrated: false, fallback: false };
  }
  if (!await exists(legacy)) {
    await mkdir(current, { recursive: true });
    return { directory: current, migrated: false, fallback: false };
  }
  const legacyInfo = await lstat(legacy);
  if (legacyInfo.isSymbolicLink() || !legacyInfo.isDirectory())
    throw new Error("旧状态目录不能是符号链接或非目录文件");

  const parent = dirname(current);
  return withLock(owner, async () => {
    if (await exists(current)) return { directory: current, migrated: false, fallback: false };
    const temporary = join(parent, `.atte-migration-${process.pid}-${randomUUID()}`);
    try {
      await cp(legacy, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        preserveTimestamps: true,
      });
      await verifyCopy(legacy, temporary);
      for (const entry of await readdir(temporary)) {
        const path = join(temporary, entry);
        const info = await lstat(path);
        if (info.isFile() && entry === "state.json") {
          const body = await readFile(path, "utf8");
          const migrated = JSON.stringify(migrateStoredState(JSON.parse(body)), null, 2);
          await writeFile(path, `${migrated}\n`, { mode: info.mode });
        }
      }
      await writeFile(join(temporary, ".atte-migration.json"), `${JSON.stringify({
        version: 1, source: legacy, migratedAt: new Date().toISOString(), verified: true,
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const { rename } = await import("node:fs/promises");
      await rename(temporary, current);
      return { directory: current, migrated: true, fallback: false };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      return {
        directory: legacy, migrated: false, fallback: true,
        detail: `Atte 状态目录迁移未完成，已继续使用 ${LEGACY_STATE_DIRECTORY}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, undefined, { workspaceCompatibility: true });
}

export async function migrateApplicationHome(
  home: string,
  newName = STATE_DIRECTORY,
  oldName = LEGACY_STATE_DIRECTORY,
): Promise<StateMigrationResult> {
  const owner = await realpath(home);
  const current = join(owner, newName), legacy = join(owner, oldName);
  if (await exists(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      const legacyInfo = await lstat(legacy).catch(() => undefined);
      if (legacyInfo && !legacyInfo.isSymbolicLink() && legacyInfo.isDirectory())
        return {
          directory: legacy, migrated: false, fallback: true,
          detail: `Atte 应用目录不是普通目录，已继续使用 ${oldName}。`,
        };
      throw new Error("Atte 应用目录不能是符号链接或非目录文件");
    }
    return { directory: current, migrated: false, fallback: false };
  }
  if (!await exists(legacy)) {
    await mkdir(current, { recursive: true });
    return { directory: current, migrated: false, fallback: false };
  }
  const temporary = join(owner, `.${newName.slice(1)}-migration-${process.pid}-${randomUUID()}`);
  try {
    await cp(legacy, temporary, {
      recursive: true, force: false, errorOnExist: true,
      dereference: false, preserveTimestamps: true, verbatimSymlinks: true,
    });
    await verifyCopy(legacy, temporary, true);
    if (await exists(current)) {
      await rm(temporary, { recursive: true, force: true });
      return { directory: current, migrated: false, fallback: false };
    }
    await writeFile(join(temporary, ".atte-migration.json"), `${JSON.stringify({
      version: 1, source: legacy, migratedAt: new Date().toISOString(), verified: true,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const { rename } = await import("node:fs/promises");
    await rename(temporary, current);
    return { directory: current, migrated: true, fallback: false };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (await exists(current))
      return { directory: current, migrated: false, fallback: false };
    return {
      directory: legacy, migrated: false, fallback: true,
      detail: `Atte 应用目录迁移未完成，已继续使用 ${oldName}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
