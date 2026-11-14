import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { cp, mkdir, rm } from "node:fs/promises";
await import("./scripts/build-icons.mjs");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["electron/main.ts", "electron/preload.ts", "electron/terminal-worker.ts"], bundle: true, platform: "node", format: "cjs", outdir: "dist", outExtension: { ".js": ".cjs" }, external: ["electron", "node-pty"], sourcemap: true });
await build({ entryPoints: ["../../cli/src/main.ts"], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: "dist/cli/atte.cjs" });
await mkdir("dist/assets", { recursive: true });
for (const file of ["atte-favicon-16.png", "atte-favicon-32.png",
  "atte-tray-16.png", "atte-tray-32.png", "atte-tray-reversed-16.png",
  "atte-tray-reversed-32.png"])
  await cp(`assets/brand/${file}`, `dist/assets/${file}`);
await cp("assets/brand/atte-app-icon-1024.png", "dist/assets/atte-app-icon.png");
await viteBuild({ root: ".", base: "./", build: { outDir: "dist/renderer", emptyOutDir: true }, esbuild: { jsx: "automatic" } });
await mkdir("dist/renderer/assets", { recursive: true });
for (const size of [16, 32])
  await cp(`assets/brand/atte-favicon-${size}.png`,
    `dist/renderer/assets/atte-favicon-${size}.png`);
