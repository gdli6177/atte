import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

test("baseline exports preserve the mascot and provide all requested icon sizes with provenance", async () => {
  const brand = resolve("assets/brand");
  const manifest = JSON.parse(await readFile(resolve(brand, "atte-assets.json"), "utf8"));
  assert.equal(manifest.status, "baseline-preparation");
  for (const file of [...manifest.sources, ...manifest.files]) {
    const bytes = await readFile(resolve(brand, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  assert.deepEqual(
    await readFile(resolve(brand, "atte-mascot-baseline-512.png")),
    await readFile(resolve(brand, "crewvane-mage.png")),
  );
  for (const size of [32, 64, 128, 256, 512, 1024]) {
    const bytes = await readFile(resolve(brand, `atte-icon-baseline-${size}.png`));
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const iconset = await readFile(resolve(brand, "atte-icon-baseline.icns"));
  assert.equal(iconset.subarray(0, 4).toString(), "icns");
});
