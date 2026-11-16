import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function nonexistentWorkspace() {
  const parent = await mkdtemp(join(tmpdir(), "atte-retired-cli-"));
  fixtures.push(parent);
  const root = join(parent, "workspace");
  return {
    root,
    missingFile: join(root, "missing-file.json"),
  };
}

async function callRemoved(
  root: string,
  argv: string[],
  environment: Record<string, string> = {},
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  let stdout = "", stderr = "";
  try {
    const code = await run([...argv, "--root", root, "--json"], {
      out: text => {
        stdout += text;
      },
      error: text => {
        stderr += text;
      },
    });
    return {
      code,
      stdout,
      stderr,
      json: stdout ? JSON.parse(stdout) : undefined,
    };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("retired commands fail before workspace I/O with one feature_removed contract", async () => {
  const { root, missingFile } = await nonexistentWorkspace();
  const commands = [
    ["skill", "list"],
    ["skill", "install", missingFile],
    ["autonomy", "set"],
    ["autonomy", "inspect"],
    ["verifier", "launch", "goal_missing", "--name", "reviewer"],
    ["bot", "call", "--file", missingFile],
    ["bot", "bind", "--id", "bot_missing", "--name", "Bot"],
    ["release", "create", "--from", "goal_missing", "--revision", "rev-1"],
    ["release", "approve", "goal_missing", "--note", "批准"],
    ["goal", "brief", "goal_missing", "--file", missingFile],
    ["goal", "checkpoint", "goal_missing", "--summary", "进展", "--next", "下一步"],
    ["goal", "verify", "goal_missing", "--delivery", "delivery_missing",
      "--outcome", "passed", "--summary", "复核"],
    ["goal", "boundary", "goal_missing", "--file", missingFile],
    ["goal", "boundary-resolve", "goal_missing", "--boundary", "boundary_missing",
      "--outcome", "approved", "--note", "批准"],
    ["goal", "autonomy", "pause", "goal_missing"],
    ["goal", "reopen", "goal_missing", "--note", "重新打开"],
    ["project", "autonomy", "personal"],
    ["capture", "我亲自处理", "--self"],
    ["direct", "--handling", "self", "我亲自处理"],
    ["goal", "create", "--title", "人工目标", "--mode", "manual"],
    ["goal", "create", "--title", "发布目标", "--kind", "release"],
    ["goal", "kind", "goal_missing", "--kind", "release"],
    ["goal", "create", "--title", "旧工序", "--workflow", "retired"],
    ["goal", "wait", "goal_missing", "--reason", "等待外部", "--owner", "YR",
      "--continuation", "continuation_missing"],
  ];
  const environment = {
    ATTE_COORDINATOR: "1",
    ATTE_COORDINATOR_SCOPE_FILE: join(root, "missing-scope.json"),
  };
  for (const argv of commands) {
    const result = await callRemoved(root, argv, environment);
    const label = argv.join(" ");
    assert.equal(result.code, 2, label);
    assert.deepEqual(Object.keys(result.json).sort(), ["error", "message"], label);
    assert.equal(result.json.error, "feature_removed", label);
    assert.equal(typeof result.json.message, "string", label);
    assert.match(result.stderr, /^atte: feature_removed: /, label);
    assert.match(result.stderr, new RegExp(result.json.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), label);
  }
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) =>
    error.code === "ENOENT");
});

test("a retired verifier role is rejected before the missing coordinator scope is read", async () => {
  const { root } = await nonexistentWorkspace();
  const result = await callRemoved(root, ["status"], {
    ATTE_COORDINATOR: "1",
    ATTE_COORDINATOR_SCOPE_FILE: join(root, "missing-scope.json"),
    ATTE_ROLE: "verifier",
  });
  assert.equal(result.code, 2);
  assert.equal(result.json.error, "feature_removed");
  assert.match(result.json.message, /0\.14 移除/);
  assert.match(result.stderr, /^atte: feature_removed: /);
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) =>
    error.code === "ENOENT");
});

test("the executable returns exit 2 and the same error without creating a workspace", async () => {
  const { root, missingFile } = await nonexistentWorkspace();
  let failure: (Error & {
    code?: number;
    stdout?: string;
    stderr?: string;
  }) | undefined;
  try {
    await promisify(execFile)(
      "pnpm",
      ["--dir", "cli", "exec", "tsx", "src/main.ts",
        "bot", "call", "--file", missingFile,
        "--root", root, "--json"],
      {
        cwd: new URL("../../", import.meta.url),
        timeout: 30_000,
      },
    );
  } catch (error) {
    failure = error as typeof failure;
  }
  assert.ok(failure, "the executable unexpectedly accepted a retired command");
  assert.equal(failure.code, 2);
  const json = JSON.parse(failure.stdout ?? "");
  assert.deepEqual(Object.keys(json).sort(), ["error", "message"]);
  assert.equal(json.error, "feature_removed");
  assert.match(failure.stderr ?? "", /^atte: feature_removed: /);
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) =>
    error.code === "ENOENT");
});
