import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Diagnostics, hookFailureSummary, redact } from "../electron/diagnostics.ts";

async function fixture(t: test.TestContext, options: { maxEntries?: number; maxBytes?: number; now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atte-diagnostics-"));
  const instances: Diagnostics[] = [];
  t.after(async () => {
    await Promise.all(instances.map(instance => instance.flush()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const diagnostics = new Diagnostics({
    version: () => "0.13.3",
    directory: () => directory,
    home: () => "/Users/example",
    ...options,
  });
  instances.push(diagnostics);
  return { directory, diagnostics, instances };
}

test("secrets, paths and personal identifiers are removed before anything is stored", () => {
  const home = "/Users/example";
  for (const [input, forbidden] of [
    ["Authorization: Bearer abcdef123456", "abcdef123456"],
    ["token=ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["api key sk-live-abcdefghijklmnop", "sk-live-abcdefghijklmnop"],
    ["failed for person@example.com", "person@example.com"],
    ["webhook https://user:pass@example.com/hook", "user:pass"],
    ["password: hunter2hunter2", "hunter2hunter2"],
  ] as const) {
    const output = redact(input, home);
    assert.equal(output.includes(forbidden), false, `${input} -> ${output}`);
  }
  assert.equal(redact(`open /Users/example/Projects/atte`, home), "open ~/Projects/atte");
  assert.equal(redact("word ".repeat(200)).endsWith("…"), true);
  assert.equal(redact("line\u0007bell"), "linebell");
});

test("recorded events keep redaction and a bounded history", async t => {
  const { diagnostics } = await fixture(t, { maxEntries: 5 });
  diagnostics.record("ipc", "atte:command", new Error("Authorization: Bearer supersecrettoken"));
  for (let index = 0; index < 8; index++) diagnostics.record("app", `event-${index}`);
  const entries = diagnostics.entriesSnapshot();
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(entry => entry.event), [
    "event-3", "event-4", "event-5", "event-6", "event-7",
  ]);
  const report = diagnostics.report();
  assert.match(report, /Atte 诊断日志/);
  assert.match(report, /0\.13\.3/);
  assert.doesNotMatch(report, /supersecrettoken/);
  assert.match(report, /\[app\] event-7/);
});

test("persisted history survives a restart with owner-only permissions", async t => {
  const { directory, diagnostics, instances } = await fixture(t);
  await diagnostics.enable();
  assert.equal((await stat(join(directory, "diagnostics.log"))).mode & 0o777, 0o600);
  diagnostics.record("workspace", "open", "/Users/example/work");
  diagnostics.record("backend", "detect", "orca 1.4.259 compatible");
  await diagnostics.flush();
  const restarted = new Diagnostics({
    version: () => "0.13.3", directory: () => directory, home: () => "/Users/example",
  });
  instances.push(restarted);
  await restarted.enable();
  const entries = restarted.entriesSnapshot();
  assert.deepEqual(entries.map(entry => entry.event), ["open", "detect"]);
  const report = restarted.report();
  assert.match(report, /~\/work/);
  assert.doesNotMatch(report, /\/Users\/example\/work/);
});

test("log rotation keeps disk usage bounded while preserving the newest entries", async t => {
  const { directory, diagnostics } = await fixture(t, { maxBytes: 900 });
  await diagnostics.enable();
  for (let index = 0; index < 60; index++) diagnostics.record("session", `probe-${index}`, "payload");
  await diagnostics.flush();
  const files = await readdir(directory);
  assert.ok(files.includes("diagnostics.log"));
  assert.ok(files.includes("diagnostics.log.1"), files.join(","));
  const total = (await Promise.all(files.map(name => stat(join(directory, name)))))
    .reduce((sum, info) => sum + info.size, 0);
  assert.ok(total <= 900 * 2 + 2_000, `unexpected size ${total}`);
  const newest = await readFile(join(directory, "diagnostics.log"), "utf8");
  assert.match(newest, /probe-59/);
});

test("the report never includes workspace state or paths outside diagnostics", async t => {
  const { diagnostics } = await fixture(t);
  assert.match(diagnostics.report(), /最近事件:\n {2}（无）/);
  diagnostics.record("renderer", "window-error", new Error("boom at /Users/example/app/main.js:1:2"));
  const report = diagnostics.report();
  assert.match(report, /boom at ~\/app\/main\.js/);
  assert.doesNotMatch(report, /goal|message|attachment|title/);
});

test("hook failures from before app startup remain explicitly historical", async t => {
  const startedAt = "2026-11-17T09:50:44.497Z";
  const { diagnostics } = await fixture(t, { now: () => new Date(startedAt) });
  assert.match(diagnostics.report(), /本次应用启动: 2026-11-17T09:50:44.497Z/);
  assert.match(hookFailureSummary({
    version: 1, counts: { child_exit: 83 },
    lastFailure: { reason: "child_exit", at: "2026-11-17T09:45:14.745Z" },
  }, startedAt), /历史累计 child_exit=83.*本次应用启动前的历史记录/);
  assert.match(hookFailureSummary({
    version: 1, counts: { child_exit: 84 },
    lastFailure: { reason: "child_exit", at: "2026-11-17T09:55:00.000Z" },
  }, startedAt), /本次应用启动后/);
  assert.equal(hookFailureSummary({ version: 1, counts: {} }, startedAt), "无失败");
});
