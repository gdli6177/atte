import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const brand = fileURLToPath(new URL("../assets/brand/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "atte-icons-"));
const digest = async name => createHash("sha256")
  .update(await readFile(join(brand, name))).digest("hex");

async function existingIconMatchesSources() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(brand, "atte-assets.json"), "utf8"));
  } catch {
    return false;
  }
  const expected = new Map([
    ["crewvane-mage.png", digest],
    ["crewvane-macos-source.png", digest],
  ]);
  for (const source of manifest?.sources ?? []) {
    const readDigest = expected.get(source?.path);
    if (!readDigest || await readDigest(source.path) !== source.sha256) return false;
  }
  if ((manifest?.sources ?? []).length !== expected.size) return false;
  const existingIcon = (manifest?.files ?? []).find(file =>
    file?.path === "atte-icon-baseline.icns");
  if (!existingIcon || await digest("atte-icon-baseline.icns") !== existingIcon.sha256)
    return false;
  const { stdout } = await exec("sips", [
    "-g", "format", "-g", "pixelWidth", "-g", "pixelHeight",
    join(brand, "atte-icon-baseline.icns"),
  ]);
  return /format:\s*icns/.test(stdout) &&
    /pixelWidth:\s*1024/.test(stdout) &&
    /pixelHeight:\s*1024/.test(stdout);
}

try {
  const iconset = join(temporary, "Atte.iconset");
  await mkdir(iconset);
  const source = join(brand, "crewvane-macos-source.png");
  await exec("sips", ["-z", "1024", "1024", join(brand, "crewvane-macos-source.png"),
    "--out", join(brand, "atte-icon-baseline-1024.png")]);
  await cp(join(brand, "crewvane-mage.png"), join(brand, "atte-mascot-baseline-512.png"));
  const sizes = [32, 64, 128, 256, 512, 1024];
  for (const pixels of sizes.filter(size => size !== 1024)) {
    await exec("sips", ["-z", String(pixels), String(pixels), source,
      "--out", join(brand, `atte-icon-baseline-${pixels}.png`)]);
  }
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      await exec("sips", ["-z", String(pixels), String(pixels),
        join(brand, "atte-icon-baseline-1024.png"), "--out",
        join(iconset, `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`)]);
    }
  }
  try {
    await exec("iconutil", [
      "-c", "icns", iconset, "-o", join(brand, "atte-icon-baseline.icns"),
    ]);
  } catch (error) {
    if (!await existingIconMatchesSources()) throw error;
    console.warn(
      "iconutil rejected the generated iconset; reusing the existing ICNS because " +
      "its source hashes and size metadata match the verified asset manifest",
    );
  }
  const files = [
    "atte-mascot-baseline-512.png",
    ...sizes.map(size => `atte-icon-baseline-${size}.png`),
    "atte-icon-baseline.icns",
  ];
  await writeFile(join(brand, "atte-assets.json"), JSON.stringify({
    status: "baseline-preparation",
    sources: [
      { path: "crewvane-mage.png", sha256: await digest("crewvane-mage.png") },
      { path: "crewvane-macos-source.png", sha256: await digest("crewvane-macos-source.png") },
    ],
    files: await Promise.all(files.map(async path => ({ path, sha256: await digest(path) }))),
  }, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
