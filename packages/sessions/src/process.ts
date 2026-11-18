import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalProcessIdentity, ProcessProbe } from "../../core/src/index.js";

const exec = promisify(execFile);
interface ProcessRow extends LocalProcessIdentity {
  parent: number;
  processGroupId: number;
}
let processTable: {
  at: number;
  promise: Promise<Map<number, ProcessRow>>;
} | undefined;
function table(refreshAfter?: NonNullable<typeof processTable>["promise"]) {
  if (processTable && processTable.promise !== refreshAfter && Date.now() - processTable.at < 150)
    return processTable.promise;
  const promise = exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    timeout: 2_000, maxBuffer: 2_000_000, env: { ...process.env, LC_ALL: "C" },
  }).then(({ stdout }) => {
    const rows = new Map<number, ProcessRow>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) rows.set(Number(match[1]), {
        pid: Number(match[1]), parent: Number(match[2]), processGroupId: Number(match[3]),
        bornAt: match[4]!.trim(),
      });
    }
    return rows;
  });
  processTable = { at: Date.now(), promise };
  return promise;
}
async function identityFor(pid: number, expectedBirth?: string): Promise<LocalProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    const snapshot = table();
    let row = (await snapshot).get(pid);
    // Launch admission just sampled ps before the child existed. A cache miss
    // (or a reused PID) needs one fresh, shared sample; it is not a dead process.
    if (!row || expectedBirth !== undefined && row.bornAt !== expectedBirth)
      row = (await table(snapshot)).get(pid);
    if (row) return { pid, bornAt: row.bornAt };
  } catch { /* An unverified PID is not a live identity. */ }
}
async function probeFor(identity: LocalProcessIdentity, expectedGroupId?: number): Promise<ProcessProbe> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.bornAt)
    return { status: "unverifiable", detail: "process_identity_invalid" };
  try {
    const cached = table();
    let rows = await cached;
    let row = rows.get(identity.pid);
    if (!row || row.bornAt !== identity.bornAt) {
      rows = await table(cached);
      row = rows.get(identity.pid);
    }
    if (!row || row.bornAt !== identity.bornAt) return { status: "absent" };
    if (expectedGroupId !== undefined && row.processGroupId !== expectedGroupId)
      return { status: "absent", detail: "process_group_changed" };
    return { status: "matched", identity: { pid: row.pid, bornAt: row.bornAt },
      processGroupId: row.processGroupId };
  } catch {
    return { status: "unverifiable", detail: "process_table_unavailable" };
  }
}
export interface ProcessInspector {
  identity(pid: number): Promise<LocalProcessIdentity | undefined>;
  probe(identity: LocalProcessIdentity, expectedGroupId?: number): Promise<ProcessProbe>;
  alive(identity: LocalProcessIdentity): Promise<boolean>;
  hasChild(identity: LocalProcessIdentity): Promise<boolean>;
}
export const localProcesses: ProcessInspector = {
  identity: identityFor,
  probe: probeFor,
  async alive(identity) {
    return (await probeFor(identity)).status === "matched";
  },
  async hasChild(identity) {
    const probe = await probeFor(identity);
    if (probe.status !== "matched") return false;
    try {
      return [...(await table()).values()].some(row => row.parent === identity.pid);
    } catch {
      return false;
    }
  },
};
