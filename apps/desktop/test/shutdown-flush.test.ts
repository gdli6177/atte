import assert from "node:assert/strict";
import test from "node:test";
import { settleAllWithin } from "../electron/shutdown-flush.js";

test("shutdown waiting resolves completed work and reports a wedged task without hanging", async () => {
  assert.deepEqual(await settleAllWithin([Promise.resolve(), Promise.resolve("ok")], 100), {
    settled: true,
  });
  const result = await settleAllWithin([new Promise(() => {})], 10);
  assert.deepEqual(result, { settled: false });
});
