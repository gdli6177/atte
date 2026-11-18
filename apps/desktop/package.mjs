import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { packager } from "@electron/packager";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareHerdr } from "./scripts/prepare-herdr.mjs";
import { appUpdateConfig } from "./update-artifacts.mjs";
import { parseSigningIdentities, resolveSigningPlan } from "./signing.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url)),
  electronVersion = createRequire(import.meta.url)("electron/package.json")
    .version,
  desktopPackage = JSON.parse(
    await readFile(join(here, "package.json"), "utf8"),
  ),
  releaseSigning = process.env.ATTE_RELEASE_SIGNING === "1" ||
    process.env.GITHUB_REF_TYPE === "tag",
  signingIdentity = process.env.ATTE_MACOS_SIGN_IDENTITY?.trim(),
  signingFingerprint = process.env.ATTE_MACOS_SIGN_FINGERPRINT?.trim(),
  electronZipDir = process.env.ATTE_ELECTRON_ZIP_DIR
    ? resolve(process.env.ATTE_ELECTRON_ZIP_DIR)
    : undefined,
  stage = await mkdtemp(join(tmpdir(), "atte-package-"));

try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Desktop packaging currently requires macOS arm64");
  let signingPlan;
  if (releaseSigning || signingIdentity) {
    const identities = await exec("security", ["find-identity", "-v", "-p", "codesigning"]);
    signingPlan = resolveSigningPlan({
      release: releaseSigning,
      identity: signingIdentity,
      fingerprint: signingFingerprint,
      identities: parseSigningIdentities(identities.stdout),
    });
  } else {
    signingPlan = resolveSigningPlan({
      release: false,
      identity: undefined,
      fingerprint: undefined,
      identities: [],
    });
  }
  // Electron/main, preload, CLI and renderer are bundled by build.mjs.
  // Deploying the source package also copies its previous release directory,
  // recursively shipping old applications/installers with every new build.
  await cp(join(here, "dist"), join(stage, "dist"), { recursive: true });
  const nativePackage = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  await cp(nativePackage, join(stage, "node_modules/node-pty"), {
    recursive: true,
    filter: (path) => !/\/(?:src|deps|test|fixtures|obj\.target)(?:\/|$)/.test(path),
  });
  const addonPackage = dirname(createRequire(join(nativePackage, "package.json")).resolve("node-addon-api/package.json"));
  await cp(addonPackage, join(stage, "node_modules/node-addon-api"), { recursive: true });
  await cp(join(here, "assets/brand/atte-app-icon-1024.png"), join(stage, "dist/assets/atte-app-icon.png"));
  const bundledSkills = join(stage, "atte-skills");
  await mkdir(bundledSkills, { recursive: true });
  await cp(join(here, "../../skills/atte"), join(bundledSkills, "atte"), { recursive: true });
  const cliNode = join(stage, "cli-node");
  await cp(process.execPath, cliNode);
  const herdrBinary = await prepareHerdr();
  const updateConfig = join(stage, "app-update.yml");
  await writeFile(updateConfig, appUpdateConfig(), { mode: 0o644 });
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "atte",
      version: desktopPackage.version,
      description: desktopPackage.description,
      productName: "Atte",
      main: "dist/main.cjs",
      dependencies: { "node-pty": createRequire(import.meta.url)("node-pty/package.json").version },
      private: false,
    }),
  );
  const paths = await packager({
    dir: stage,
    out: join(here, "release"),
    name: "Atte",
    electronVersion,
    appBundleId: "dev.atte.desktop",
    platform: "darwin",
    arch: "arm64",
    icon: join(here, "assets/brand/atte-app-icon.icns"),
    asar: { unpack: "{**/dist/cli/**,**/node_modules/node-pty/**}" },
    extraResource: [
      cliNode,
      join(here, "herdr-plugin"),
      bundledSkills,
      herdrBinary,
      updateConfig,
    ],
    ignore: [/^\/cli-node$/, /^\/app-update\.yml$/, /^\/dist\/.*\.map$/],
    overwrite: true,
    prune: true,
    appCategoryType: "public.app-category.developer-tools",
    extendInfo: {
      NSAppleEventsUsageDescription:
        "Atte uses the selected terminal to open and focus your current Herdr work scene.",
    },
    ...(electronZipDir ? { electronZipDir } : {}),
    // Electron patches its binaries while packaging. Release builds require
    // the persistent self-signed identity and never fall back to ad-hoc.
    // Development packages may still use ad-hoc signing for local smoke tests.
    osxSign: {
      identity: signingPlan.identity,
      identityValidation: signingPlan.identityValidation,
      timestamp: "none",
      strictVerify: true,
      continueOnError: false,
      optionsForFile: () => ({
        hardenedRuntime: signingPlan.hardenedRuntime,
        timestamp: "none",
        entitlements: signingPlan.hardenedRuntime ? join(here, "entitlements.mac.plist") : [],
      }),
    },
  });
  if (releaseSigning) {
    const app = join(paths[0], "Atte.app");
    await exec("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  }
  console.log(paths.join("\n"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
