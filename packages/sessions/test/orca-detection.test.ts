import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectOrcaApplication } from "../src/orca/detection.js";
import { validateOrcaCliContract } from "../src/orca/compatibility.js";

async function application(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), "atte-orca-detection-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function contract() {
  const common = ["json", "environment"];
  return { schemaVersion: 1, commands: [
    { command: "status", flags: [...common] },
    { command: "repo add", flags: [...common, "path", "kind"] },
    { command: "worktree show", flags: [...common, "worktree"] },
    { command: "worktree ps", flags: [...common] },
    { command: "terminal list", flags: [...common] },
    { command: "terminal show", flags: [...common, "terminal"] },
    { command: "terminal create", flags: [...common, "worktree", "title", "command"] },
    { command: "terminal send", flags: [...common, "terminal", "text", "enter", "wait-submit", "retry-request"] },
    { command: "terminal switch", flags: [...common, "terminal"] },
    { command: "terminal close", flags: [...common, "terminal"] },
  ] };
}

function verified(version: string) {
  return async (path: string) => ({ version, appPath: path, path: join(path, "Contents/Resources/bin/orca") });
}

test("signed Orca releases are admitted by interface compatibility, including unlisted future versions", async t => {
  const appPath = await application(t);
  for (const version of ["1.4.258", "1.4.259", "1.4.260", "2.0.0"]) {
    let inspected = false;
    const detected = await detectOrcaApplication(appPath, verified(version), async path => {
      assert.equal(path, join(appPath, "Contents/Resources/bin/orca"));
      inspected = true;
      validateOrcaCliContract(contract());
    });
    assert.equal(inspected, true);
    assert.equal(detected.version, version);
    assert.equal(detected.status, "compatible", `${version}: ${detected.detail}`);
  }
});

test("missing required commands block even a previously tested Orca version", async t => {
  const appPath = await application(t);
  const schema = contract();
  schema.commands = schema.commands.filter(command => command.command !== "terminal send");
  const detected = await detectOrcaApplication(appPath, verified("1.4.259"), async () => validateOrcaCliContract(schema));
  assert.equal(detected.status, "incompatible");
  assert.match(detected.detail!, /terminal send/);
});

test("missing idempotent-retry flags are reported before a backend switch", async t => {
  const appPath = await application(t);
  const schema = contract();
  const send = schema.commands.find(command => command.command === "terminal send")!;
  send.flags = send.flags.filter(flag => flag !== "retry-request");
  const detected = await detectOrcaApplication(appPath, verified("2.0.0"), async () => validateOrcaCliContract(schema));
  assert.equal(detected.status, "incompatible");
  assert.match(detected.detail!, /--retry-request/);
});

test("unknown interface schemas fail explicitly instead of guessing from the product version", async t => {
  const appPath = await application(t);
  const detected = await detectOrcaApplication(appPath, verified("1.4.259"), async () => {
    validateOrcaCliContract({ ...contract(), schemaVersion: 2 });
  });
  assert.equal(detected.status, "incompatible");
  assert.match(detected.detail!, /接口说明格式/);
});

test("extra commands and flags do not reject a compatible interface", async t => {
  const appPath = await application(t);
  const schema = contract();
  schema.commands.push({ command: "new optional feature", flags: ["future-flag"] });
  schema.commands[0]!.flags.push("new-status-option");
  const detected = await detectOrcaApplication(appPath, verified("9.0.0"), async () => validateOrcaCliContract(schema));
  assert.equal(detected.status, "compatible");
});

test("a renamed command remains compatible when the CLI explicitly preserves its old alias", async t => {
  const appPath = await application(t);
  const schema = { ...contract(), commands: contract().commands.map(command =>
    command.command === "terminal switch"
      ? { ...command, command: "terminal activate", aliases: ["terminal switch"] }
      : command) };
  const detected = await detectOrcaApplication(appPath, verified("3.0.0"), async () => validateOrcaCliContract(schema));
  assert.equal(detected.status, "compatible");
});

test("an incomplete CLI probe can be retried without declaring the version incompatible", async t => {
  const appPath = await application(t);
  const detected = await detectOrcaApplication(appPath, verified("1.4.259"), async () => {
    throw new Error("probe timed out");
  });
  assert.equal(detected.status, "unverified");
  assert.match(detected.detail!, /重新检测/);
});

test("application verification failures cannot be bypassed by a compatible CLI schema", async t => {
  const appPath = await application(t);
  let inspected = false;
  const detected = await detectOrcaApplication(appPath, async () => {
    throw new Error("Orca application signature failed verification");
  }, async () => { inspected = true; });
  assert.equal(detected.status, "incompatible");
  assert.match(detected.detail!, /signature/);
  assert.equal(inspected, false);
});

test("a missing Orca application never reaches verification or interface inspection", async t => {
  const appPath = join(await application(t), "missing.app");
  const detected = await detectOrcaApplication(appPath, async () => {
    assert.fail("Missing applications must not be verified");
  }, async () => { assert.fail("Missing applications must not be probed"); });
  assert.equal(detected.status, "missing");
});
