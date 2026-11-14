import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

for (const kind of ["file", "symlink"] as const) {
  test(`the real installer preserves an unowned CLI ${kind} before downloading or installing`, async context => {
    const root = await mkdtemp(join(tmpdir(), "atte-installer-shim-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), target = join(root, "outside");
    await mkdir(bin);
    await writeFile(target, "user-owned\n");
    if (kind === "symlink") await symlink(target, join(bin, "atte"));
    else await writeFile(join(bin, "atte"), "user-owned\n");
    await assert.rejects(promisify(execFile)("bash", ["install.sh", "--target", join(root, "skills")], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, ATTE_HOME: join(root, "kit"), ATTE_BIN_DIR: bin },
      timeout: 5_000,
    }), /refused to replace unowned CLI entry/);
    assert.equal(await readFile(join(bin, "atte"), "utf8"), "user-owned\n");
    assert.equal(await readFile(target, "utf8"), "user-owned\n");
    if (kind === "symlink") assert.equal(await readlink(join(bin, "atte")), target);
    await assert.rejects(readFile(join(root, "kit", "manifest")), /ENOENT/);
  });
}
