import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

test("Six Vectors exports preserve the mascot and provide all requested icon sizes with provenance", async () => {
  const brand = resolve("assets/brand");
  const manifest = JSON.parse(await readFile(resolve(brand, "atte-assets.json"), "utf8"));
  assert.equal(manifest.status, "final-six-vectors");
  assert.deepEqual(manifest.palette, {
    ink: "#171A1E",
    warmWhite: "#F3F1EA",
    amber: "#F5A524",
    appIconBackground: "#14181B",
  });
  for (const file of [...manifest.sources, ...manifest.files]) {
    const bytes = await readFile(resolve(brand, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  assert.deepEqual(
    await readFile(resolve(brand, "atte-mascot-baseline-512.png")),
    await readFile(resolve(brand, "crewvane-mage.png")),
  );
  for (const size of [32, 64, 128, 256, 512, 1024]) {
    const bytes = await readFile(resolve(brand, `atte-app-icon-${size}.png`));
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  for (const size of [16, 32]) {
    for (const name of [`atte-favicon-${size}.png`, `atte-tray-${size}.png`,
      `atte-tray-reversed-${size}.png`]) {
      const bytes = await readFile(resolve(brand, name));
      assert.equal(bytes.readUInt32BE(16), size, name);
      assert.equal(bytes.readUInt32BE(20), size, name);
    }
  }
  const iconset = await readFile(resolve(brand, "atte-app-icon.icns"));
  assert.equal(iconset.subarray(0, 4).toString(), "icns");
});

test("brand artwork uses only the guide's ink, warm white, amber, and icon background", async () => {
  const brand = resolve("assets/brand");
  const allowed = new Set(["#171A1E", "#F3F1EA", "#F5A524", "#14181B"]);
  for (const name of ["atte-mark.svg", "atte-mark-reversed.svg", "atte-mark-mono.svg",
    "atte-mark-mono-reversed.svg", "atte-mark-small.svg", "atte-mark-small-reversed.svg",
    "atte-app-icon.svg", "atte-wordmark.svg", "atte-wordmark-reversed.svg",
    "atte-wordmark-stacked.svg", "atte-wordmark-stacked-reversed.svg"]) {
    const source = await readFile(resolve(brand, name), "utf8"),
      colors = source.match(/#[0-9A-Fa-f]{6}/g) ?? [];
    assert.ok(colors.length > 0, name);
    for (const color of colors) assert.ok(allowed.has(color.toUpperCase()), `${name}: ${color}`);
  }
});
