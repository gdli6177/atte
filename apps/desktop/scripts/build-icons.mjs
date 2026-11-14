import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const brand = fileURLToPath(new URL("../assets/brand/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "crewvane-icons-"));
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
  await exec("iconutil", ["-c", "icns", iconset, "-o", join(brand, "atte-icon-baseline.icns")]);
  const digest = async name => createHash("sha256").update(await readFile(join(brand, name))).digest("hex");
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
