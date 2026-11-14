import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyCliPaths, removeOwnedLegacyCli } from "../electron/legacy-cli.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-legacy-cli-"));
  const home = join(root, "home"), appData = join(root, "appData"), userData = join(appData, "Atte");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await mkdir(join(appData, "Crewvane/bin"), { recursive: true });
  const paths = legacyCliPaths(home, appData, userData);
  return { root, paths };
}

test("only a verified old managed Crewvane CLI shim is removed", async () => {
  const { root, paths } = await fixture();
  try {
    await writeFile(paths.path, "#!/bin/sh\necho personal-command\n");
    assert.equal(await removeOwnedLegacyCli(paths), false);
    assert.match(await readFile(paths.path, "utf8"), /personal-command/);

    await writeFile(paths.path, "#!/bin/sh\n# Crewvane embedded CLI\nELECTRON_RUN_AS_NODE=1 exec node old.cjs\n");
    assert.equal(await removeOwnedLegacyCli(paths), true);

    await symlink(join(paths.legacyBin, "crewvane"), paths.path);
    assert.equal(await removeOwnedLegacyCli(paths), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
