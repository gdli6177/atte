import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { record } from "../io.js";

const exec = promisify(execFile);

export const ORCA_REQUIRED_RUNTIME_CAPABILITIES = [
  "terminal.prompt-delivery.v1",
  "terminal.create-idempotency.v2",
  "workspace-selector.folder-match.v1",
] as const;

const requiredCommands: Record<string, readonly string[]> = {
  status: [],
  "repo add": ["path", "kind"],
  "worktree show": ["worktree"],
  "worktree ps": [],
  "terminal list": [],
  "terminal show": ["terminal"],
  "terminal create": ["worktree", "title", "command"],
  "terminal send": ["terminal", "text", "enter", "wait-submit", "retry-request"],
  "terminal switch": ["terminal"],
  "terminal close": ["terminal"],
};

export class OrcaCliContractError extends Error {}

/** Only the commands and flags Atte calls are required; additional interfaces are allowed. */
export function validateOrcaCliContract(value: unknown): void {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.commands))
    throw new OrcaCliContractError("Orca 命令行接口说明格式不受支持，无法确认必要命令。");
  for (const [command, flags] of Object.entries(requiredCommands)) {
    const matches = value.commands.filter(item => record(item) &&
      (item.command === command || Array.isArray(item.aliases) && item.aliases.includes(command)));
    if (matches.length !== 1)
      throw new OrcaCliContractError(`Orca 缺少或重复声明必要命令 ${command}。`);
    const entry = matches[0];
    if (!record(entry) || !Array.isArray(entry.flags))
      throw new OrcaCliContractError(`Orca 命令 ${command} 的参数说明无效。`);
    for (const flag of ["json", "environment", ...flags])
      if (!entry.flags.includes(flag))
        throw new OrcaCliContractError(`Orca 命令 ${command} 缺少必要参数 --${flag}。`);
  }
}

/** Reads the CLI's static schema; it does not start Orca or inspect user sessions. */
export async function inspectOrcaCliContract(path: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await exec(path, ["agent-context", "--environment", "local", "--json"], {
      timeout: 10_000,
      maxBuffer: 4_000_000,
      env: { ...process.env, ORCA_ENVIRONMENT: "local", ORCA_PAIRING_CODE: undefined },
    }));
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number")
      throw new OrcaCliContractError("Orca 命令行无法提供 agent-context 接口说明，请更新官方应用或选择其他 Orca 应用。");
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new OrcaCliContractError("Orca 未返回有效的命令行接口说明。"); }
  validateOrcaCliContract(value);
}
