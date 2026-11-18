import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { localProcesses } from "../src/process.js";

test("a process created after a cached process table is immediately verified by PID and birth time", async t => {
  await localProcesses.identity(process.pid);
  const child = spawn("/bin/sleep", ["10"]);
  t.after(() => { child.kill(); });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid!;
  const bornAt = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
    { env: { ...process.env, LC_ALL: "C" } }).toString().trim();
  const processGroupId = Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="],
    { env: { ...process.env, LC_ALL: "C" } }).toString().trim());
  const matched = await localProcesses.probe({ pid, bornAt });
  assert.equal(matched.status, "matched");
  if (matched.status === "matched") assert.equal(matched.processGroupId, processGroupId);
  assert.equal(await localProcesses.alive({ pid, bornAt }), true);
  assert.equal((await localProcesses.probe({ pid, bornAt: `${bornAt}-different` })).status, "absent");
  assert.equal((await localProcesses.probe({ pid, bornAt }, processGroupId + 1)).status, "absent");
  assert.equal((await localProcesses.probe({ pid: 2_147_483_646, bornAt: "missing" })).status, "absent");
  assert.equal((await localProcesses.probe({ pid: 0, bornAt: "" })).status, "unverifiable");
});
