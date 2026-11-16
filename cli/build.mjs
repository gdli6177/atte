import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
  target: "node20", outfile: "dist/atte.cjs",
  define: { __ATTE_VERSION__: JSON.stringify(version) },
});
