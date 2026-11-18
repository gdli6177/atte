import assert from "node:assert/strict";
import test from "node:test";
import { appUpdateConfig, latestMacYaml } from "../update-artifacts.mjs";

test("update metadata names the final signed zip and its digest", () => {
  const yaml = latestMacYaml({
    version: "0.14.3",
    fileName: "Atte-0.14.3-macOS-arm64.zip",
    sha512: Buffer.alloc(64, 7).toString("base64"),
    size: 123_456,
    releaseDate: "2026-11-17T00:00:00.000Z",
  });
  assert.match(yaml, /^version: 0\.14\.3$/m);
  assert.match(yaml, /url: Atte-0\.14\.3-macOS-arm64\.zip/);
  assert.match(yaml, /size: 123456/);
  assert.match(yaml, /releaseDate: '2026-11-17T00:00:00\.000Z'/);
});

test("the packaged provider is the stable GitHub repository and never contains a token", () => {
  const config = appUpdateConfig();
  assert.match(config, /provider: github/);
  assert.match(config, /owner: gdli6177/);
  assert.match(config, /repo: atte/);
  assert.match(config, /releaseType: release/);
  assert.match(config, /updaterCacheDirName: atte-updater/);
  assert.doesNotMatch(config, /token|http/i);
});
