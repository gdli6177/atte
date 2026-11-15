import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendDetection, SessionCapabilities } from "../contracts.js";
import { inspectOrcaCliContract, OrcaCliContractError } from "./compatibility.js";

const exec = promisify(execFile);
// Reference releases exercised by real smoke tests; never an admission gate.
export const TESTED_ORCA_VERSIONS = ["1.4.258", "1.4.259"] as const;
export const ORCA_CAPABILITIES: SessionCapabilities = {
  create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false,
};
export const ORCA_RELEASE = {
  version: "1.4.259",
  filename: "orca-macos-arm64.dmg",
  bytes: 283_966_513,
  sha256: "4118e9e4ec0e78349570f5e35bb0f1a6a6f8b09d7e1122348b9536805d436fb1",
  url: "https://github.com/stablyai/orca/releases/download/v1.4.259/orca-macos-arm64.dmg",
  releasePage: "https://github.com/stablyai/orca/releases/tag/v1.4.259",
  teamId: "6CX3WHS9HZ",
  bundleId: "com.stablyai.orca",
} as const;
export async function verifyOrcaApplication(appPath: string) {
  const info = join(appPath, "Contents", "Info.plist");
  const property = async (key: string) => (await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, info], { timeout: 5_000 })).stdout.trim();
  const [bundleId, version] = await Promise.all([property("CFBundleIdentifier"), property("CFBundleShortVersionString")]);
  if (bundleId !== ORCA_RELEASE.bundleId) throw new Error("应用身份不是 stablyai/orca。");
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 15_000 });
  const signature = await exec("/usr/bin/codesign", ["-d", "--verbose=4", appPath], { timeout: 5_000 });
  if (!signature.stderr.split("\n").includes(`TeamIdentifier=${ORCA_RELEASE.teamId}`))
    throw new Error("Orca 应用签名来源与经过验证的官方发布者不匹配。");
  const path = join(appPath, "Contents", "Resources", "bin", "orca");
  await access(path);
  const actual = (await exec(path, ["--version"], { timeout: 5_000 })).stdout.trim();
  if (actual !== version) throw new Error("Orca 应用版本与内置 CLI 版本不匹配。");
  return { version, path, appPath };
}
export async function detectOrcaApplication(
  appPath: string,
  verify = verifyOrcaApplication,
  inspect = inspectOrcaCliContract,
): Promise<BackendDetection> {
  try { await access(appPath); }
  catch { return { id: "orca", status: "missing", capabilities: { ...ORCA_CAPABILITIES }, detail: "未找到 Orca，请安装或选择已有应用。" }; }
  let detected: Awaited<ReturnType<typeof verifyOrcaApplication>>;
  try { detected = await verify(appPath); }
  catch (error) {
    return {
      id: "orca", appPath, status: "incompatible", capabilities: { ...ORCA_CAPABILITIES },
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try { await inspect(detected.path); }
  catch (error) {
    return {
      id: "orca", ...detected, capabilities: { ...ORCA_CAPABILITIES },
      status: error instanceof OrcaCliContractError ? "incompatible" : "unverified",
      detail: error instanceof OrcaCliContractError ? error.message
        : "尚未完成 Orca 命令行接口检测，请点击“重新检测”后重试。",
    };
  }
  return {
    id: "orca", ...detected, capabilities: { ...ORCA_CAPABILITIES }, status: "compatible",
    detail: "应用身份和命令行接口检查通过；切换时会核对运行时能力。",
  };
}
