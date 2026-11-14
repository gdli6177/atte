import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-lock-"));
  fixtures.push(root);
  return root;
}

test("a failed current-lock acquisition never removes another process's locks", async () => {
  const root = await fixture();
  const current = join(root, ".atte-lock"), legacy = join(root, ".crewvane-lock");
  await mkdir(current);
  await writeFile(join(current, "owner.json"), JSON.stringify({
    pid: process.pid, hostname: (await import("node:os")).hostname(), started_at: "test", cmd: "test",
  }));
  const compatibility = { workspaceCompatibility: true };
  await assert.rejects(withLock(root, async () => undefined, 0, compatibility), /state is locked/);
  assert.match(await readFile(join(current, "owner.json"), "utf8"), /"cmd":"test"/);
  await mkdir(legacy);
  await writeFile(join(legacy, "owner.json"), "legacy owner\n");
  await assert.rejects(withLock(root, async () => undefined, 0, compatibility), /state is locked/);
  assert.equal(await readFile(join(legacy, "owner.json"), "utf8"), "legacy owner\n");
  assert.equal(await readFile(join(current, "owner.json"), "utf8"), JSON.stringify({
    pid: process.pid, hostname: (await import("node:os")).hostname(), started_at: "test", cmd: "test",
  }));
});

test("ordinary locks never create the retired workspace lock name", async () => {
  const root = await fixture();
  await withLock(root, async () => {
    assert.equal(await readFile(join(root, ".atte-lock/owner.json"), "utf8").then(Boolean), true);
    await assert.rejects(readFile(join(root, ".crewvane-lock/owner.json"), "utf8"), /ENOENT/);
  });
});

test("a dead current lock never authorizes removing a live legacy lock", async () => {
  const root = await fixture();
  const current = join(root, ".atte-lock"), legacy = join(root, ".crewvane-lock");
  const live = {
    pid: process.pid, hostname: (await import("node:os")).hostname(), started_at: "test", cmd: "live",
  };
  const dead = { ...live, pid: 2_147_483_647, cmd: "dead" };
  await mkdir(current);
  await mkdir(legacy);
  await writeFile(join(current, "owner.json"), JSON.stringify(dead));
  await writeFile(join(legacy, "owner.json"), JSON.stringify(live));
  await assert.rejects(withLock(root, async () => assert.fail("lock is held"), 0,
    { workspaceCompatibility: true }), /state is locked/);
  assert.deepEqual(JSON.parse(await readFile(join(legacy, "owner.json"), "utf8")), live);
  assert.deepEqual(JSON.parse(await readFile(join(current, "owner.json"), "utf8")), dead);
});

test("workspace compatibility locks both names while a legacy workspace is pending migration", async () => {
  const root = await fixture();
  await mkdir(join(root, ".crewvane"));
  await withLock(root, async () => {
    await readFile(join(root, ".atte-lock/owner.json"), "utf8");
    await readFile(join(root, ".crewvane-lock/owner.json"), "utf8");
  }, undefined, { workspaceCompatibility: true });
  await assert.rejects(readFile(join(root, ".atte-lock/owner.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(root, ".crewvane-lock/owner.json"), "utf8"), /ENOENT/);
});

test("reentrancy applies only to the canonical root that owns the current lock", async () => {
  const first = await fixture(), second = await fixture();
  await mkdir(join(second, ".atte-lock"));
  await writeFile(join(second, ".atte-lock/owner.json"), JSON.stringify({
    pid: process.pid, hostname: (await import("node:os")).hostname(), started_at: "test", cmd: "test",
  }));
  await withLock(first, async () => {
    await withLock(first, async () => {
      assert.equal(await readFile(join(first, ".atte-lock/owner.json"), "utf8").then(Boolean), true);
    });
    await assert.rejects(withLock(second, async () => undefined, 0), /state is locked/);
  });
  assert.equal(await readFile(join(second, ".atte-lock/owner.json"), "utf8").then(text => JSON.parse(text).cmd), "test");
});
