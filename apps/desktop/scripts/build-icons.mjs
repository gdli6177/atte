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
const sources = [
  "atte-mark.svg",
  "atte-mark-reversed.svg",
  "atte-mark-mono.svg",
  "atte-mark-mono-reversed.svg",
  "atte-mark-small.svg",
  "atte-mark-small-reversed.svg",
  "atte-mark-16-source.png",
  "atte-mark-16-reversed-source.png",
  "atte-mark-32-source.png",
  "atte-mark-32-reversed-source.png",
  "atte-app-icon.svg",
  "atte-app-icon-source.png",
  "atte-wordmark.svg",
  "atte-wordmark-reversed.svg",
  "atte-wordmark-stacked.svg",
  "atte-wordmark-stacked-reversed.svg",
];

async function generatePng(size, source, output) {
  await exec("sips", ["-z", String(size), String(size),
    join(brand, source), "--out", join(brand, output)]);
}

try {
  const iconset = join(temporary, "Atte.iconset");
  await mkdir(iconset);
  const appIcon = "atte-app-icon-source.png";
  for (const pixels of [32, 64, 128, 256, 512, 1024])
    await generatePng(pixels, appIcon, `atte-app-icon-${pixels}.png`);
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      await exec("sips", ["-z", String(pixels), String(pixels),
        join(brand, appIcon), "--out",
        join(iconset, `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`)]);
    }
  }
  await exec("iconutil", [
    "-c", "icns", iconset, "-o", join(brand, "atte-app-icon.icns"),
  ]);
  for (const size of [16, 32]) {
    await cp(join(brand, `atte-mark-${size}-source.png`),
      join(brand, `atte-favicon-${size}.png`));
    await cp(join(brand, `atte-mark-${size}-source.png`),
      join(brand, `atte-tray-${size}.png`));
    await cp(join(brand, `atte-mark-${size}-reversed-source.png`),
      join(brand, `atte-tray-reversed-${size}.png`));
  }
  const files = [
    ...[32, 64, 128, 256, 512, 1024].map(size => `atte-app-icon-${size}.png`),
    "atte-app-icon.icns",
    ...[16, 32].flatMap(size => [
      `atte-favicon-${size}.png`,
      `atte-tray-${size}.png`,
      `atte-tray-reversed-${size}.png`,
    ]),
  ];
  await writeFile(join(brand, "atte-assets.json"), `${JSON.stringify({
    status: "final-six-vectors",
    palette: {
      ink: "#171A1E",
      warmWhite: "#F3F1EA",
      amber: "#F5A524",
      appIconBackground: "#14181B",
    },
    sources: await Promise.all(sources.map(async path => ({
      path, sha256: await digest(path),
    }))),
    files: await Promise.all(files.map(async path => ({
      path, sha256: await digest(path),
    }))),
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
