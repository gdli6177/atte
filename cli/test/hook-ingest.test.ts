import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_TEXT_LIMIT,
  normalizeNativeHookEvent,
  type AgentRuntimeAdapterId,
  type AgentRuntimeEventV1,
} from "../../packages/core/src/index.js";
import { ingestAgentHook } from "../src/hook-ingest.js";
import { readHookDiagnostics } from "../src/hook-diagnostics.js";

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliRoot = join(repositoryRoot, "cli");
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "atte-hook-ingest-"));
  roots.push(value);
  return value;
}

function environment(workspace: string): NodeJS.ProcessEnv {
  return {
    ATTE_GOAL_ID: "goal_hook",
    ATTE_ATTEMPT_ID: "attempt_hook",
    ATTE_HOOK_TOKEN: "token",
    ATTE_AGENT_NAME: "owner-a",
    ATTE_WORKSPACE: workspace,
    ATTE_HOOK_SPOOL: join(workspace, ".atte", "runtime", "spool"),
  };
}

test("official lifecycle fixtures normalize for Codex, Claude Code, Cursor, Qoder and OMP", () => {
  const cases: {
    adapter: AgentRuntimeAdapterId;
    input: Record<string, unknown>;
    types: string[];
    turnId?: string;
  }[] = [
    {
      adapter: "codex",
      input: {
        hook_event_name: "Stop",
        turn_id: "codex-turn",
        last_assistant_message: "Codex result",
        tool_input: { secret: "not persisted" },
        tool_response: "not persisted",
      },
      types: ["agent.response", "turn.settled"],
      turnId: "codex-turn",
    },
    {
      adapter: "claude-code",
      input: {
        hook_event_name: "Notification",
        hook_event_source: "permission",
        notification_type: "permission_request",
        message: "Approve command",
        tool_input: { secret: "not persisted" },
      },
      types: ["agent.blocked"],
    },
    {
      adapter: "cursor",
      input: {
        hook_event_name: "afterAgentResponse",
        generation_id: "cursor-turn",
        text: "Cursor result",
        tool_output: "not persisted",
      },
      types: ["agent.response"],
      turnId: "cursor-turn",
    },
    {
      adapter: "qoder",
      input: {
        hook_event_name: "UserPromptSubmit",
        prompt: "Qoder task",
        tool_args: ["not persisted"],
      },
      types: ["turn.started"],
    },
    {
      adapter: "omp",
      input: {
        hook_event_name: "TurnStart",
        session_id: "session-a",
        turn_index: 2,
        prompt: "OMP task",
        tool_results: ["not persisted"],
      },
      types: ["turn.started"],
      turnId: "session-a:2",
    },
  ];
  for (const fixture of cases) {
    const normalized = normalizeNativeHookEvent(fixture.adapter, fixture.input);
    assert.deepEqual(normalized.map(event => event.type), fixture.types);
    if (fixture.turnId)
      assert.equal(normalized[0]?.turnId, fixture.turnId);
    assert.equal(JSON.stringify(normalized).includes("not persisted"), false);
  }
});

test("a managed prompt without a native turn ID receives a stable turn fallback", async () => {
  const workspace = await root();
  let captured: AgentRuntimeEventV1[] = [];
  const result = await ingestAgentHook({
    adapter: "claude-code",
    environment: environment(workspace),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "实现即时事件",
    }),
    send: async events => {
      captured = events;
      return true;
    },
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(captured[0]?.type, "turn.started");
  assert.match(captured[0]?.turnId ?? "", /^turn-\d+$/);
  assert.equal(captured[0]?.content?.text, "实现即时事件");
});

test("identical native payloads on repeated turns receive distinct event IDs", async () => {
  const workspace = await root();
  const captured: AgentRuntimeEventV1[][] = [];
  for (let run = 0; run < 2; run += 1) {
    await ingestAgentHook({
      adapter: "claude-code",
      environment: environment(workspace),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      stdin: async () => JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "继续检查",
      }),
      send: async events => {
        captured.push(events);
        return true;
      },
    });
  }
  assert.notEqual(captured[0]![0]!.eventId, captured[1]![0]!.eventId);
  assert.equal(captured[0]![0]!.sequence, 1);
  assert.equal(captured[1]![0]!.sequence, 2);
});

test("OMP response capture ignores tool-result messages", () => {
  const [normalized] = normalizeNativeHookEvent("omp", {
    hook_event_name: "AgentEnd",
    session_id: "session-a",
    turn_index: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "这是可见回复" }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "private tool output" }],
      },
    ],
  });
  assert.equal(normalized?.text?.text, "这是可见回复");
  assert.equal(JSON.stringify(normalized).includes("private tool output"), false);
});

test("events outside a managed Atte target are a no-op", async () => {
  const workspace = await root();
  let called = false;
  let consumed = false;
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: { ATTE_WORKSPACE: workspace },
    stdin: async () => {
      consumed = true;
      return JSON.stringify({ hook_event_name: "Stop", turn_id: "turn" });
    },
    send: async () => {
      called = true;
      return true;
    },
  });
  assert.deepEqual(result, { accepted: false, reason: "not_managed" });
  assert.equal(called, false);
  assert.equal(consumed, true);
  assert.deepEqual(await readdir(workspace), []);
});

test("missing identity and invalid adapters consume stdin before returning", async () => {
  const workspace = await root();
  assert.deepEqual(await readdir(workspace), []);
  const seen: string[] = [];
  const managed = { ...environment(workspace), ATTE_HOOK_SOCKET: join(workspace, "offline.sock") };
  for (const [env, adapter, payload, reason] of [
    [{ ATTE_WORKSPACE: workspace }, "codex", '{"hook_event_name":"Stop"}', "not_managed"],
    [managed, "codex", '{"hook_event_name":"UnknownEvent"}', "unsupported_event"],
  ] as const) {
    let called = false;
    assert.deepEqual(await ingestAgentHook({
      adapter,
      environment: env,
      stdin: async () => {
        called = true;
        seen.push("consumed");
        return payload;
      },
    }), { accepted: false, reason });
    assert.equal(called, true);
  }
  assert.deepEqual(seen, ["consumed", "consumed"]);
  assert.equal(readHookDiagnostics(workspace).counts.unsupported_event, 1);
  assert.equal(Object.hasOwn(readHookDiagnostics(workspace).counts, "not_managed"), false);
});

test("legacy Crewvane hook environment still reaches the managed target", async () => {
  const workspace = await root();
  let received: Array<{ attemptId: string; goalId: string }> | undefined;
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: {
      CREWVANE_GOAL_ID: "goal_hook", CREWVANE_ATTEMPT_ID: "attempt_hook",
      CREWVANE_HOOK_TOKEN: "token", CREWVANE_AGENT_NAME: "owner-a",
      CREWVANE_WORKSPACE: workspace, CREWVANE_HOOK_SPOOL: join(workspace, ".crewvane/runtime/spool"),
    },
    stdin: async () => JSON.stringify({
      hook_event_name: "SessionStart", session_id: "legacy-session", turn_id: "legacy-turn",
    }),
    send: async payload => {
      received = payload;
      return true;
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(received?.[0]?.attemptId, "attempt_hook");
  assert.equal(received?.[0]?.goalId, "goal_hook");
});

test("socket failures and thrown transports spool the exact token and events", async () => {
  const workspace = await root();
  let spooled: { events: AgentRuntimeEventV1[]; token: string } | undefined;
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => JSON.stringify({
      hook_event_name: "Stop",
      turn_id: "turn-1",
      last_assistant_message: "完成",
    }),
    send: async () => {
      throw new Error("app offline");
    },
    spool: async (events, token) => {
      spooled = { events, token };
      return "spooled";
    },
  });
  assert.deepEqual(result, { accepted: true, reason: "spooled" });
  assert.equal(spooled?.token, "token");
  assert.deepEqual(spooled?.events.map(event => event.type), [
    "agent.response",
    "turn.settled",
  ]);
});

test("text is bounded to 12,000 Unicode characters with the original SHA-256", async () => {
  const workspace = await root(), prompt = "🧭".repeat(AGENT_RUNTIME_TEXT_LIMIT + 5);
  let captured: AgentRuntimeEventV1[] = [];
  const result = await ingestAgentHook({
    adapter: "qoder",
    environment: environment(workspace),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt,
      tool_input: { private: "not persisted" },
      tool_output: "not persisted",
    }),
    send: async events => {
      captured = events;
      return true;
    },
  });
  assert.equal(result.accepted, true);
  const content = captured[0]!.content!;
  assert.equal(Array.from(content.text).length, AGENT_RUNTIME_TEXT_LIMIT);
  assert.equal(content.truncated, true);
  assert.equal(
    content.sha256,
    createHash("sha256").update(prompt).digest("hex"),
  );
  assert.equal(JSON.stringify(captured).includes("not persisted"), false);
});

test("default spool files are private and readable as a complete offline event", async () => {
  const workspace = await root(), env = environment(workspace);
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: env,
    stdin: async () => JSON.stringify({
      hook_event_name: "SessionStart",
    }),
    send: async () => false,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "spooled");
  const spool = env.ATTE_HOOK_SPOOL!;
  const info = await stat(spool);
  assert.equal(info.mode & 0o777, 0o700);
  const { readdir } = await import("node:fs/promises");
  const [name] = (await readdir(spool)).filter(value => value.endsWith(".json"));
  assert.ok(name);
  const payload = JSON.parse(await readFile(join(spool, name), "utf8"));
  assert.equal(payload[0].token, "token");
  assert.equal(payload[0].events[0].type, "session.started");
  assert.equal((await stat(join(spool, name))).mode & 0o777, 0o600);
});

test("malformed input and unavailable stdin fail open without throwing", async () => {
  const workspace = await root();
  assert.deepEqual(await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => "{",
  }), { accepted: false, reason: "invalid_json" });
  assert.deepEqual(await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => {
      throw new Error("stdin closed");
    },
  }), { accepted: false, reason: "read_error" });
});

test("a CLI wrapper's stable HookInputError reason is preserved instead of becoming read_error", async () => {
  const workspace = await root(), env = environment(workspace);
  for (const reason of ["timeout", "overflow", "read_error"] as const) {
    const error = new Error(reason);
    error.name = "HookInputError";
    assert.deepEqual(await ingestAgentHook({
      adapter: "codex",
      environment: env,
      stdin: async () => { throw error; },
    }), { accepted: false, reason });
  }
  const diagnostics = readHookDiagnostics(workspace);
  assert.equal(diagnostics.counts.timeout, 1);
  assert.equal(diagnostics.counts.overflow, 1);
  assert.equal(diagnostics.counts.read_error, 1);
});

test("informational notifications do not manufacture a blocked Agent", () => {
  for (const adapter of ["claude-code", "qoder"] as const)
    for (const notification_type of ["auth_success", "idle_prompt", "elicitation_complete"])
      assert.deepEqual(normalizeNativeHookEvent(adapter, {
        hook_event_name: "Notification", notification_type,
      }), []);
});

async function runRealIngest(
  adapter: string,
  body: Buffer | string,
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(join(repositoryRoot, "node_modules/.bin/tsx"), [
    "test/fixtures/hook-cli.ts", "hook", "ingest", "--adapter", adapter,
  ], {
    cwd: cliRoot,
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(body);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    resolve => child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
  );
  return { code, signal, stdout, stderr };
}

test("real CLI ingestion exits 0 for normal, rejected, malformed, overflow and 5 MB input", async () => {
  const workspace = await root();
  const env: NodeJS.ProcessEnv = {
    ...environment(workspace), ATTE_HOOK_SOCKET: join(workspace, "offline.sock"),
  };
  const normal = await runRealIngest("codex", JSON.stringify({
    hook_event_name: "SessionStart", session_id: "real-session",
  }), env);
  assert.equal(normal.code, 0);
  assert.equal(normal.signal, null);
  assert.equal(normal.stderr, "");
  const spool = env.ATTE_HOOK_SPOOL!;
  assert.equal((await readdir(spool)).filter(name => name.endsWith(".json")).length, 1);

  for (const [adapter, body] of [
    ["unknown", JSON.stringify({ hook_event_name: "SessionStart" })],
    ["codex", "{"],
    ["codex", Buffer.alloc(600_000, 120)],
    ["codex", Buffer.alloc(5_000_000, 120)],
  ] as const) {
    const result = await runRealIngest(adapter, body, env);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
  }
  assert.equal((await readdir(spool)).filter(name => name.endsWith(".json")).length, 1);
  assert.equal((await stat(spool)).mode & 0o777, 0o700);
  const diagnostics = JSON.parse(await readFile(
    join(workspace, ".atte/runtime/hook-diagnostics.json"), "utf8"));
  assert.equal(diagnostics.counts.overflow, 2);
  assert.equal(diagnostics.counts.unsupported_adapter, 1);
  assert.equal(diagnostics.counts.invalid_json, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /real-session|xxxx/);
});

test("real CLI ingestion exits 0 after a stalled stdin deadline", { timeout: 5_000 }, async () => {
  const workspace = await root();
  const child = spawn(join(repositoryRoot, "node_modules/.bin/tsx"), [
    "test/fixtures/hook-cli.ts", "hook", "ingest", "--adapter", "codex",
  ], {
    cwd: cliRoot,
    env: { ...process.env, ...environment(workspace) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.write('{"hook_event_name":');
  try {
    const started = performance.now();
    const code = await new Promise<number | null>(resolve =>
      child.once("close", exitCode => resolve(exitCode)));
    const elapsed = performance.now() - started;
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.ok(elapsed >= 1_000 && elapsed < 4_000, `timeout took ${elapsed} ms`);
    assert.equal(readHookDiagnostics(workspace).counts.timeout, 1);
  } finally {
    child.stdin.destroy();
  }
});

test("actual CLI JSON reports overflow and exits 0 for oversized stdin", { timeout: 5_000 }, async () => {
  const workspace = await root();
  const child = spawn(join(repositoryRoot, "node_modules/.bin/tsx"), [
    "src/main.ts", "hook", "ingest", "--adapter", "codex", "--json",
  ], {
    cwd: cliRoot,
    env: {
      ...process.env,
      ...environment(workspace),
      ATTE_HOOK_SOCKET: join(workspace, "offline.sock"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(Buffer.alloc(5_000_000, 120));
  const code = await new Promise<number | null>(resolve =>
    child.once("close", exitCode => resolve(exitCode)));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const output = JSON.parse(stdout);
  assert.equal(output.accepted, false);
  assert.equal(output.reason, "overflow");
  assert.equal(output.result.reason, "overflow");
  assert.equal(readHookDiagnostics(workspace).counts.overflow, 1);
});

test("real CLI hook ingestion stays fail-open for dangling and duplicate flags", { timeout: 10_000 }, async () => {
  const workspace = await root();
  for (const args of [
    ["hook", "ingest", "--adapter"],
    ["hook", "ingest", "--adapter", "omp", "--adapter", "omp", "--json"],
  ]) {
    const child = spawn(join(repositoryRoot, "node_modules/.bin/tsx"), [
      "src/main.ts", ...args,
    ], {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...environment(workspace),
        ATTE_HOOK_SOCKET: join(workspace, "offline.sock"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.stdin.end("{}");
    const code = await new Promise<number | null>(resolve =>
      child.once("close", exitCode => resolve(exitCode)));
    assert.equal(code, 0, args.join(" "));
    assert.equal(stderr, "", args.join(" "));
    if (args.includes("--json")) {
      assert.equal(JSON.parse(stdout).accepted, false);
    } else {
      assert.equal(stdout, "");
    }
  }
});
