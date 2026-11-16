import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import {
  HOOK_INPUT_MAX_BYTES,
  HOOK_INPUT_TIMEOUT_MS,
  readHookInput,
} from "../src/hook-input.js";

test("hook input buffers at most 512000 bytes and decodes split UTF-8 after EOF", async () => {
  assert.equal(HOOK_INPUT_MAX_BYTES, 512_000);
  assert.equal(HOOK_INPUT_TIMEOUT_MS, 2_000);
  const text = "🧭".repeat(128_000);
  const bytes = Buffer.from(text);
  const stream = Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]);
  assert.deepEqual(await readHookInput(stream), { ok: true, text, bytes: 512_000 });
});

test("hook input discards a 5 MB overflow while draining every byte through EOF", async () => {
  const stream = new PassThrough();
  const result = readHookInput(stream);
  let settled = false;
  void result.then(() => { settled = true; });
  for (let index = 0; index < 80; index += 1)
    stream.write(Buffer.alloc(65_536, 120));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(stream.destroyed, false);
  stream.end();
  assert.deepEqual(await result, { ok: false, reason: "overflow", bytes: 5_242_880 });
  assert.equal(stream.readableEnded, true);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("hook input enforces the byte limit instead of the character count", async () => {
  const text = "🧭".repeat(128_001);
  assert.deepEqual(await readHookInput(Readable.from([text])), {
    ok: false, reason: "overflow", bytes: 512_004,
  });
});

test("hook input deadlines resolve while the pipe remains drainable without EPIPE", async () => {
  const stream = new PassThrough();
  stream.write("partial");
  const started = performance.now();
  const result = await readHookInput(stream, { timeoutMs: 25 });
  assert.deepEqual(result, { ok: false, reason: "timeout", bytes: 7 });
  assert.ok(performance.now() - started < 300);
  assert.equal(stream.destroyed, false);
  stream.end(Buffer.alloc(600_000));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stream.readableEnded, true);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("overflow followed by a stalled producer is bounded by the same deadline", async () => {
  const stream = new PassThrough();
  const result = readHookInput(stream, { timeoutMs: 25 });
  stream.write(Buffer.alloc(600_000));
  assert.deepEqual(await result, { ok: false, reason: "timeout", bytes: 600_000 });
  stream.end();
});

test("hook input classifies read errors and premature closes without rejecting", async () => {
  const stream = new PassThrough();
  const result = readHookInput(stream);
  stream.write("prefix");
  stream.destroy(new Error("PRIVATE read error"));
  assert.deepEqual(await result, { ok: false, reason: "read_error", bytes: 6 });
  const closed = new PassThrough();
  closed.destroy();
  assert.deepEqual(await readHookInput(closed), { ok: false, reason: "read_error", bytes: 0 });
});
