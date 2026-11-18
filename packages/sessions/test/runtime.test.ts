import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionControl, SessionRuntime, type SessionAdapter, type CreateSceneRequest, type SendSceneRequest } from "../src/index.js";
import {
  ReadOnlyGoalError, WorkspaceService, goalCanExecute, type Goal, type SceneReferenceV1,
} from "../../core/src/index.js";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cv-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const control = new SessionControl(join(root, "control"));
  const config = await control.initialize();
  await control.registerWorkspace(workspace);
  const service = new WorkspaceService(workspace);
  const goal = await service.execute({ type: "goal.intake", text: "只处理隔离目标" }) as Goal;
  await service.execute({ type: "agents.configure", preferences: { concierge: "cursor-2 --model '中文 model'" } });
  const created: CreateSceneRequest[] = [], sent: SendSceneRequest[] = [], stopped: string[] = [];
  let rejectSend = false;
  const adapter: SessionAdapter = {
    id: "herdr",
    detect: async () => ({ id: "herdr", status: "compatible",
      capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: true } }),
    connect: async () => ({ id: "runtime", generation: "generation", backend: "herdr", version: "fixture" }),
    create: async input => {
      created.push(input);
      const scene: SceneReferenceV1 = {
        version: 1, backend: "herdr", installationId: input.installationId, backendEpoch: input.backendEpoch,
        bindingId: input.bindingId, attemptId: input.attemptId, runtimeId: "runtime", runtimeGeneration: "generation",
        ownership: {
          version: 1, samples: 2, capturedAt: new Date().toISOString(),
          shell: { pid: 1000 + created.length, bornAt: "2026-11-17T00:00:00.000Z" },
          launcher: { pid: 2000 + created.length, bornAt: "2026-11-17T00:00:00.000Z" },
          foreground: { pid: 3000 + created.length, bornAt: "2026-11-17T00:00:00.000Z" },
          processGroupId: 2000 + created.length,
        },
        locator: { kind: "herdr", session: "test", workspaceId: "w1", tabId: `t${created.length}`, paneId: `p${created.length}` },
      };
      return { status: "created", requestId: input.requestId, scene, mayHaveCreated: true, recoveryId: input.requestId };
    },
    inspect: async scene => ({ bindingId: scene.bindingId, identity: "match", reachable: true,
      state: "idle", observedAt: new Date().toISOString(), source: "backend" }),
    inspectMany: async scenes => Promise.all(scenes.map(scene => adapter.inspect(scene))),
    send: async input => {
      sent.push(input);
      return { status: rejectSend ? "rejected" : "started", deliveryId: input.deliveryId, scene: input.scene,
        payloadSha256: input.payloadSha256, at: new Date().toISOString() };
    },
    focus: async () => ({ status: "focused", navigated: true }),
    close: async scene => { stopped.push(scene.bindingId); return {
      status: "stopped", bindingId: scene.bindingId, at: new Date().toISOString(), identityVerified: true,
    }; },
    discover: async () => [],
    captureResume: async () => ({ status: "supported", agent: "codex", kind: "id", value: "native-session-one" }),
  };
  const runtime = new SessionRuntime({ control, workspace, cliDirectory: join(root, "bin"), adapter: async () => adapter });
  return { runtime, control, service, workspace, config, goal, created, sent, stopped, adapter,
    rejectSend: () => { rejectSend = true; } };
}

test("one concierge is reused; configured command and native argv stay unchanged in the private launcher", async t => {
  const f = await fixture(t);
  const first = await f.runtime.prepareConcierge();
  assert.deepEqual(await f.runtime.prepareConcierge(), first);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.cwd, f.workspace, "The global concierge runs in the workspace root.");
  const launcher = await readFile(f.created[0]!.launcherPath, "utf8");
  assert.match(launcher, /cursor-2 '--model' '中文 model'/);
  assert.doesNotMatch(launcher, /exec cursor-2|command cursor-2/);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0]!.text.length < 2_000, "Identity initialization stays a short native turn.");
  assert.doesNotMatch(f.sent[0]!.text, /\[ATTE_CASE_BEGIN\]/);
});

test("rechecking an initialized concierge restores readiness without erasing presence or sending identity again", async t => {
  const f = await fixture(t);
  const scene = await f.runtime.prepareConcierge();
  const live = { state: "idle" as const, reachable: true, checkedAt: new Date().toISOString() };
  await f.service.execute({
    type: "scene.concierge.status", status: "not_ready", live, detail: "正在准备全局管家…",
  });
  assert.deepEqual(await f.runtime.prepareConcierge(), scene);
  const current = (await f.service.read()).concierge;
  assert.equal(current.status, "ready");
  assert.equal(current.detail, undefined);
  assert.equal(current.live?.state, live.state);
  assert.equal(current.live?.reachable, live.reachable);
  assert.equal(current.live?.checkedAt, live.checkedAt);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
});

test("owners run in the selected project directory while the global concierge stays at the workspace root", async t => {
  const f = await fixture(t);
  const projectPath = join(f.workspace, "产品 项目");
  await mkdir(projectPath);
  const project = await f.service.execute({ type: "project.add", name: "产品项目", path: projectPath }) as { id: string };
  const createdGoal = await f.service.execute({
    type: "goal.create",
    input: {
      projectId: project.id,
      title: "项目目标",
      description: "只验证工作目录映射。",
      mode: "concierge",
    },
  }) as Goal;
  await f.runtime.prepareConcierge();
  await f.runtime.launchOwner({ goalId: createdGoal.id, name: "owner-project" });
  assert.equal(f.created[0]!.cwd, f.workspace);
  assert.equal(f.created[1]!.cwd, projectPath);
});

test("rediscovering a created concierge initializes its identity once before any case notification", async t => {
  const f = await fixture(t);
  const original = f.adapter.create;
  let result: Awaited<ReturnType<typeof original>>;
  f.adapter.create = async input => {
    result = await original(input);
    return { status: "unknown", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true };
  };
  f.adapter.discover = async () => [{ requestId: result.requestId, scene: result.scene! }];
  await assert.rejects(f.runtime.prepareConcierge(), /launch_unconfirmed/);
  assert.equal(f.sent.length, 0);
  const scene = await f.runtime.prepareConcierge();
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /这是 Atte 身份初始化/);
  const restartedRuntime = new SessionRuntime(f.runtime.options);
  await restartedRuntime.prepareConcierge();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).concierge.initializedAttemptId, scene.attemptId);
});

test("unconfirmed identity delivery is preserved across retries and never marks the concierge initialized", async t => {
  const f = await fixture(t), original = f.adapter.send;
  f.adapter.send = async input => ({ ...await original(input), status: "unknown" });
  await assert.rejects(f.runtime.prepareConcierge(), /delivery_unconfirmed/);
  await assert.rejects(new SessionRuntime(f.runtime.options).prepareConcierge(), /delivery_unconfirmed/);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).concierge.initializedAttemptId, undefined);
});
test("a custom CLI can accept the identity handshake without claiming that a business turn started", async t => {
  const f = await fixture(t), original = f.adapter.send;
  f.adapter.inspect = async scene => ({ bindingId: scene.bindingId, identity: "match", reachable: true,
    state: "unknown", observedAt: new Date().toISOString(), source: "backend" });
  f.adapter.send = async input => ({ ...await original(input), status: "accepted" });
  const scene = await f.runtime.prepareConcierge();
  assert.equal((await f.service.read()).concierge.initializedAttemptId, scene.attemptId);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).goals[0]!.dispatch?.status, "pending");
});
test("an exited concierge is recreated once while an unverifiable occupant is preserved", async t => {
  const f = await fixture(t);
  const original = await f.runtime.prepareConcierge();
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async scene => scene.bindingId === original.bindingId
    ? { ...await inspect(scene), state: "exited", reachable: false } : inspect(scene);
  const replacement = await f.runtime.prepareConcierge();
  assert.notEqual(replacement.attemptId, original.attemptId);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.stopped, []);
  f.adapter.inspect = async scene => ({ ...await inspect(scene), identity: "mismatch" });
  await assert.rejects(f.runtime.prepareConcierge(), /scene_identity_mismatch/);
  assert.equal(f.created.length, 2, "A replacement occupant is never closed or duplicated.");
});

test("background concierge preparation preserves an ended scene until explicit recovery", async t => {
  const f = await fixture(t);
  const original = await f.runtime.prepareConcierge();
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async scene => scene.bindingId === original.bindingId
    ? { ...await inspect(scene), state: "exited", reachable: false, ownership: "ended" }
    : inspect(scene);
  await assert.rejects(f.runtime.prepareConcierge({ recover: false }), /scene_ended/);
  const preserved = (await f.service.read()).concierge;
  assert.equal(preserved.scene?.bindingId, original.bindingId);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.stopped, []);
  const replacement = await f.runtime.prepareConcierge();
  assert.notEqual(replacement.attemptId, original.attemptId);
  assert.equal(f.created.length, 2);
});

test("a scoped concierge launches a separate owner and cannot launch for another case", async t => {
  const f = await fixture(t);
  await f.runtime.prepareConcierge();
  const managed = new SessionRuntime({ ...f.runtime.options, managedContext: {
    installationId: f.config.installationId, backend: "herdr", epoch: 0,
    scopeGeneration: f.config.scopeGeneration, role: "concierge", goalId: f.goal.id,
  } });
  const result = await managed.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  assert.equal(f.created.length, 2);
  assert.notEqual(result.scene.bindingId, (await f.service.read()).concierge.scene?.bindingId);
  assert.equal((await f.service.read()).goals[0]?.owner, "owner-test");
  await assert.rejects(managed.launchOwner({ goalId: "other", name: "owner-other" }), /不能启动|当前案卷/);
  const launcher = await readFile(f.created[1]!.launcherPath, "utf8");
  assert.match(launcher, /ATTE_GOAL_ID/);
  assert.doesNotMatch(launcher, /export ATTE_COORDINATOR=/);
});

test("idempotent sends reuse the same receipt and reject changed payload or unregistered scenes", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const receipt = await f.runtime.send(scene, "delivery-once", "补充信息");
  assert.deepEqual(await f.runtime.send(scene, "delivery-once", "补充信息"), receipt);
  assert.equal(f.sent.filter(input => input.deliveryId === "delivery-once").length, 1);
  await assert.rejects(f.runtime.send(scene, "delivery-once", "不同内容"), /更换正文/);
  await assert.rejects(f.runtime.send({ ...scene, bindingId: "foreign" }, "foreign-send", "内容"), /已登记/);
});

test("consultation restores a review scene while preserving the same attention and delivery", async t => {
  const f = await fixture(t);
  await f.service.execute({ type: "goal.review", goalId: f.goal.id, delivery: {
    summary: "已有可核对的文档结果", location: "/tmp/result.md",
    checks: [{ name: "核对", command: "test", result: "passed", note: "实际核对通过" }],
  }, actor: "owner" });
  const before = (await f.service.read()).goals[0]!;
  await f.control.operation({ workspace: f.workspace, requestId: "admitted-noop", kind: "create",
    goalId: f.goal.id }, async () => {});
  await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-consult", consultationOnly: true });
  const after = (await f.service.read()).goals[0]!;
  assert.equal(after.status, "review");
  assert.deepEqual(after.attention, before.attention);
  assert.deepEqual(after.delivery, before.delivery);
  assert.match(f.sent.at(-1)!.text, /等待用户答复；不得开始实现/);
});
test("explicit recovery retires only a confirmed exited owner and preserves the pending decision", async t => {
  const f = await fixture(t);
  const { scene: original } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-old" });
  await f.service.execute({ type: "goal.decide", goalId: f.goal.id, question: "选择下一步方案？", actor: "owner-old" });
  const before = (await f.service.read()).goals[0]!;
  const existing = await f.runtime.recoverOwnerForConsultation(f.goal.id);
  assert.equal(existing.scene.bindingId, original.bindingId);
  assert.equal(f.created.length, 1, "Opening a live consultation never creates a second owner.");
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async scene => ({ ...await inspect(scene), identity: "mismatch" });
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id), /原现场尚未确认停止/);
  f.adapter.inspect = async scene => scene.bindingId === original.bindingId
    ? { ...await inspect(scene), state: "exited", reachable: false } : inspect(scene);
  const replacement = await f.runtime.recoverOwnerForConsultation(f.goal.id);
  const after = (await f.service.read()).goals[0]!;
  assert.notEqual(replacement.scene.attemptId, original.attemptId);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.attention, before.attention);
  assert.equal(after.sceneHistory?.at(-1)?.bindingId, original.bindingId);
  assert.match(f.sent.at(-1)!.text, /等待用户答复；不得开始实现/);
  assert.deepEqual(f.stopped, []);
});

test("registering an old Orca workspace preserves its read-only binding and cannot create a Herdr owner", async t => {
  const f = await fixture(t);
  await f.service.execute({ type: "goal.decide", goalId: f.goal.id,
    question: "采用 A 还是 B？", actor: "owner-old" });
  const before = (await f.service.read()).goals[0]!;
  const statePath = join(f.workspace, ".atte", "state.json");
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  raw.backendBinding = {
    installationId: "legacy-orca-installation", backend: "orca", epoch: 0,
    scopeGeneration: "legacy-orca-scope", status: "active",
  };
  raw.goals[0].scene = {
    version: 1, backend: "orca", installationId: "legacy-orca-installation", backendEpoch: 0,
    runtimeId: "orca-runtime", runtimeGeneration: "orca-generation",
    bindingId: "orca-binding", attemptId: "orca-attempt",
    locator: { kind: "orca", repoId: "repo", worktreeId: "worktree",
      terminalHandle: "terminal", executionHostId: "local", incarnationId: "incarnation" },
  };
  await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await f.control.registerWorkspace(f.workspace);
  await assert.rejects(f.runtime.launchOwner({ goalId: f.goal.id,
    name: "owner-consult-new", consultationOnly: true }), /只读|旧后端|不属于当前 Herdr/);
  const afterState = await f.service.read(), after = afterState.goals[0]!;
  assert.equal(after.scene?.bindingId, "orca-binding");
  assert.equal(afterState.backendBinding?.backend, "orca", "register cannot overwrite old Orca history");
  assert.equal(afterState.backendBinding?.installationId, "legacy-orca-installation");
  assert.deepEqual(after.attention, before.attention);
  assert.equal(after.status, before.status);
  assert.equal(after.owner, before.owner);
  assert.equal(f.created.length, 0, "no Herdr scene is fabricated from an old Orca binding");
  assert.equal(f.sent.length, 0);
});

test("completion captures native resume before closing only the goal's verified scene", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  await f.service.execute({ type: "goal.complete", goalId: f.goal.id, note: "用户确认已经完成" });
  await f.runtime.captureOwnerResume(f.goal.id, scene);
  await f.runtime.close(scene, f.goal.id);
  const goal = (await f.service.read()).goals[0]!;
  assert.equal(goal.status, "completed");
  assert.equal(goal.scene, undefined);
  assert.equal(goal.ownerResume?.agentSession?.value, "native-session-one");
  assert.deepEqual(f.stopped, [scene.bindingId]);
});

test("a watchdog notification uses its own stable delivery identity after normal dispatch", async t => {
  const f = await fixture(t);
  await f.runtime.notifyGoal(f.goal, "新任务", undefined, "original-dispatch");
  await f.runtime.notifyGoal(f.goal, "核对未写回的结果", undefined, "watchdog-one");
  assert.deepEqual(f.sent.slice(-2).map(item => item.deliveryId), ["original-dispatch", "watchdog-one"]);
});

test("a busy concierge defers a watchdog without consuming its delivery ID or changing the next case", async t => {
  const f = await fixture(t);
  await f.runtime.prepareConcierge();
  const inspect = f.adapter.inspect;
  for (const state of ["working", "blocked"] as const) {
    f.adapter.inspect = async scene => ({ ...await inspect(scene), state });
    await assert.rejects(f.runtime.notifyGoal(f.goal, "核对结果", undefined, "watchdog-deferred"),
      /backend_busy/);
    assert.equal(f.sent.length, 1, "Only the identity handshake was sent.");
  }
  f.adapter.inspect = inspect;
  const result = await f.runtime.notifyGoal(f.goal, "核对结果", undefined, "watchdog-deferred");
  assert.equal(result.receipt.status, "started");
  assert.equal(f.sent.filter(item => item.deliveryId === "watchdog-deferred").length, 1);
});

test("timestamp correlation IDs remain safe, stable and idempotent", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const id = `watchdog:${f.goal.id}:2026-11-13T06:09:52.666Z`;
  const first = await f.runtime.send(scene, id, "核对实际进展");
  assert.deepEqual(await f.runtime.send(scene, id, "核对实际进展"), first);
  assert.match(first.deliveryId, /^delivery-[a-f0-9]{64}$/);
  assert.equal(f.sent.filter(item => item.deliveryId === first.deliveryId).length, 1);
});

test("a verified exited owner scene is superseded instead of blocking a relaunch", async t => {
  const f = await fixture(t);
  const first = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-first" });
  await assert.rejects(
    f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-live" }),
    /已有负责人现场/,
    "a live scene still refuses a second owner",
  );
  const dead = {
    ...f.adapter,
    inspect: async (scene: SceneReferenceV1) => ({
      bindingId: scene.bindingId, identity: "match" as const, reachable: false,
      state: (scene.bindingId === first.scene.bindingId ? "exited" : "idle") as "exited" | "idle",
      observedAt: new Date().toISOString(), source: "backend" as const,
    }),
    inspectMany: async (scenes: SceneReferenceV1[]) => Promise.all(scenes.map(scene => dead.inspect(scene))),
  };
  const runtime = new SessionRuntime({ ...f.runtime.options, adapter: async () => dead });
  const second = await runtime.launchOwner({ goalId: f.goal.id, name: "owner-second" });
  assert.notEqual(second.scene.attemptId, first.scene.attemptId);
  const held = (await f.service.read()).goals.find(goal => goal.id === f.goal.id)!;
  assert.equal(held.scene?.attemptId, second.scene.attemptId);
  assert.equal(held.attemptHistory?.[0]?.attemptId, first.scene.attemptId);
  assert.equal(held.attemptHistory?.[0]?.reason, "superseded");
});

test("an owner that exits during launch is cleaned up instead of leaving a dead scene", async t => {
  const f = await fixture(t);
  const dead = {
    ...f.adapter,
    inspect: async (scene: SceneReferenceV1) => ({
      bindingId: scene.bindingId, identity: "match" as const, reachable: false,
      state: "exited" as const, observedAt: new Date().toISOString(), source: "backend" as const,
    }),
    inspectMany: async (scenes: SceneReferenceV1[]) => Promise.all(scenes.map(scene => dead.inspect(scene))),
  };
  const runtime = new SessionRuntime({ ...f.runtime.options, adapter: async () => dead });
  await assert.rejects(runtime.launchOwner({ goalId: f.goal.id, name: "owner-dead" }), /launch_failed/);
  const goal = (await f.service.read()).goals.find(item => item.id === f.goal.id)!;
  assert.equal(goal.scene, undefined, "a verified crash must not leave a scene that blocks the next launch");
  assert.equal(goal.attemptHistory?.at(-1)?.reason, "superseded");
  assert.equal(goal.attemptHistory?.at(-1)?.attemptId, goal.attemptHistory?.at(-1)?.attemptId);
});

test("native resume never replaces a wrapper and preserves configured argv", async t => {
  const f = await fixture(t);
  await f.service.execute({ type: "agents.configure", preferences: {
    concierge: "cursor-2 --model '中文 model'", owner: "/tmp/custom-wrapper --original",
  } });
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-first" });
  await f.service.execute({ type: "session.resume.capture", goalId: f.goal.id, resume: {
    owner: "old-owner", cwd: f.workspace, savedAt: new Date().toISOString(),
    agentSession: { source: "herdr:omp", agent: "omp", kind: "id", value: "old-session" },
  } });
  await f.service.execute({ type: "goal.complete", goalId: f.goal.id, note: "用户确认本阶段结束" });
  await f.runtime.close(scene, f.goal.id);
  await f.service.execute({ type: "goal.restart", goalId: f.goal.id, note: "用户要求续接原目标" });
  await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const script = await readFile(f.created.at(-1)!.launcherPath, "utf8");
  assert.match(script, /custom-wrapper.*--original/);
  assert.doesNotMatch(script, /old-session/);
});

async function writeForeignScene(
  f: { workspace: string; service: WorkspaceService; config: { installationId: string } },
  goalId: string,
  backend: "orca",
) {
  const path = join(f.workspace, ".atte", "state.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  const goal = raw.goals.find((item: Goal) => item.id === goalId);
  goal.scene = {
    version: 1, backend, installationId: f.config.installationId, backendEpoch: 0,
    runtimeId: `${backend}-runtime`, runtimeGeneration: `${backend}-generation`,
    bindingId: `${backend}-binding`, attemptId: `${backend}-attempt`,
    locator: { kind: "orca", repoId: "r1", worktreeId: "r1::/tmp/w", terminalHandle: "term-1",
      executionHostId: "local", incarnationId: "inc-1" },
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

test("an old Orca scene cannot be retired or replaced by a new Herdr owner", async t => {
  const f = await fixture(t);
  await writeForeignScene(f, f.goal.id, "orca");
  const before = (await f.service.read()).goals[0]!;
  assert.equal(before.scene?.backend, "orca");
  assert.equal(goalCanExecute(before), false);
  assert.throws(() => { throw new ReadOnlyGoalError(before.id); }, /goal_read_only/);
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id), /只读历史目标|旧后端/);
  await assert.rejects(f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-new" }), /只读历史目标/);
  const after = (await f.service.read()).goals[0]!;
  assert.deepEqual(after.scene, before.scene, "history is not mutated");
  assert.equal(after.sceneHistory?.some(scene => scene.backend === "orca") ?? false, false);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.stopped, []);
});

test("an old Orca scene cannot receive a Herdr send or recreate an owner", async t => {
  const f = await fixture(t);
  await writeForeignScene(f, f.goal.id, "orca");
  await assert.rejects(f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-new" }), /只读历史目标/);
  assert.equal(f.created.length, 0, "no second owner is created while the old scene is unverified");
  const goal = (await f.service.read()).goals[0]!;
  assert.equal(goal.scene?.backend, "orca");
  await assert.rejects(f.runtime.send(goal.scene!, "old-orca-send", "不能重放"), /旧后端/);
  assert.equal(f.sent.length, 0);
});

test("a core-marked read-only history goal is rejected before a Herdr scene or prompt exists", async t => {
  const f = await fixture(t);
  const statePath = join(f.workspace, ".atte", "state.json");
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  raw.goals[0].readOnly = true;
  await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-history" }),
    /只读历史目标/);
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
});

for (const terminalCommand of ["goal.drop", "goal.complete"] as const) {
  test(`migration-held goals reject execution until a human ends them with ${terminalCommand}`, async context => {
    const setup = await fixture(context);
    const concierge = await setup.runtime.prepareConcierge();
    const { scene } = await setup.runtime.launchOwner({ goalId: setup.goal.id, name: "owner-before-migration" });
    const originalConcierge = new SessionRuntime({
      ...setup.runtime.options,
      managedContext: {
        installationId: setup.config.installationId, backend: "herdr", epoch: setup.config.epoch,
        scopeGeneration: setup.config.scopeGeneration, role: "concierge",
        attemptId: concierge.attemptId, goalId: setup.goal.id,
      },
      hostExecution: true,
    });
    assert.equal((await originalConcierge.send(scene, "before-migration", "核对旧现场")).status, "started");
    const statePath = join(setup.workspace, ".atte", "state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.version = 4;
    raw.goals[0].kind = "release";
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const migrated = await setup.service.read();
    assert.equal(migrated.version, 5);
    assert.equal(migrated.goals[0]!.executionHold, "migration-confirmation");
    assert.equal(goalCanExecute(migrated.goals[0]!), false);
    const sentBefore = setup.sent.length;
    const createdBefore = setup.created.length;
    await assert.rejects(
      originalConcierge.send(scene, "after-migration", "未经人工确认继续旧目标"),
      /goal_confirmation_required/,
    );
    await assert.rejects(
      originalConcierge.launchOwner({ goalId: setup.goal.id, name: "owner-after-migration" }),
      /goal_confirmation_required/,
    );
    await assert.rejects(
      setup.runtime.recoverOwnerForConsultation(setup.goal.id),
      /goal_confirmation_required/,
    );
    await assert.rejects(
      setup.runtime.notifyGoal(migrated.goals[0]!, "继续旧目标"),
      /goal_confirmation_required/,
    );
    await assert.rejects(setup.runtime.close(scene, setup.goal.id), /goal_confirmation_required/);
    assert.equal(setup.sent.length, sentBefore, "No execution prompt reaches the original owner.");
    assert.equal(setup.created.length, createdBefore, "No replacement owner or concierge is created.");
    assert.deepEqual(setup.stopped, [], "The original owner is not closed.");
    assert.equal((await originalConcierge.inspect([scene]))[0]?.identity, "match");
    assert.equal((await setup.runtime.focus(scene)).status, "focused");
    assert.deepEqual(await setup.service.read(), migrated, "Inspection and rejected sends preserve the hold and business state.");

    const ended = await setup.service.execute({
      type: terminalCommand, goalId: setup.goal.id, actor: "你", note: "用户明确结束这个旧目标。",
    }) as Goal;
    assert.equal(ended.status, terminalCommand === "goal.drop" ? "dropped" : "completed");
    assert.equal(ended.executionHold, undefined, "A human ending the goal clears its migration hold.");
    await setup.runtime.close(scene, setup.goal.id);
    assert.deepEqual(setup.stopped, [scene.bindingId], "Only the original Herdr owner is closed.");
    assert.equal((await setup.service.read()).goals[0]!.scene, undefined);
    const restarted = await setup.service.execute({
      type: "goal.restart", goalId: setup.goal.id, note: "用户明确要求按普通目标重新开始。",
    }) as Goal;
    assert.equal(restarted.status, "active");
    assert.equal(restarted.executionHold, undefined);
    assert.equal(restarted.kind, "delivery");
    assert.equal(restarted.dispatch?.kind, "restart");
    assert.equal(restarted.dispatch?.status, "pending");
    assert.equal(goalCanExecute(restarted), true);
  });
}

test("inspection re-anchors only after a stable live ownership sample", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-live" });
  const next = { ...scene, runtimeId: "runtime-2", runtimeGeneration: "generation-2" };
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId,
    identity: current.runtimeGeneration === "generation-2" ? "match" : "mismatch",
    reachable: true,
    state: "idle",
    ownership: "live",
    ...(current.runtimeGeneration === "generation-2" ? {} : { reanchor: next }),
    observedAt: new Date().toISOString(),
    source: "backend",
  });
  f.adapter.inspectMany = async scenes => Promise.all(scenes.map(current => f.adapter.inspect(current)));
  f.adapter.reanchor = async () => next;
  const [observation] = await f.runtime.inspect([scene]);
  assert.equal(observation?.identity, "match");
  const goal = (await f.service.read()).goals[0]!;
  assert.equal(goal.scene?.runtimeGeneration, "generation-2");
  assert.equal(goal.agentRuntime?.attempt.scene?.runtimeGeneration, "generation-2");
  assert.equal(f.created.length, 1, "the stable pane is reused, not recreated");
  assert.deepEqual(f.stopped, []);
});

test("a changed runtime is safely re-anchored before delivery", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-live" });
  const next = { ...scene, runtimeId: "runtime-2", runtimeGeneration: "generation-2" };
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId,
    identity: current.runtimeGeneration === "generation-2" ? "match" : "mismatch",
    reachable: true,
    state: "idle",
    ownership: "live",
    ...(current.runtimeGeneration === "generation-2" ? {} : { reanchor: next }),
    observedAt: new Date().toISOString(),
    source: "backend",
  });
  f.adapter.inspectMany = async scenes => Promise.all(scenes.map(current => f.adapter.inspect(current)));
  f.adapter.reanchor = async () => next;
  const receipt = await f.runtime.send(scene, "after-reanchor", "继续推进");
  assert.equal(receipt.status, "started");
  assert.equal(receipt.scene.runtimeGeneration, "generation-2");
  assert.equal((await f.service.read()).goals[0]!.scene?.runtimeGeneration, "generation-2");
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.stopped, []);
});

test("legacy exit requires explicit confirmation and never closes the old pane", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-legacy" });
  await f.service.store.update("test.legacy-scene", state => {
    const goal = state.goals.find(item => item.id === f.goal.id)!;
    delete goal.scene!.ownership;
    delete goal.agentRuntime!.attempt.scene!.ownership;
    goal.agentRuntime!.lastEventAt = "2026-11-17T00:00:00.000Z";
    delete goal.agentRuntime!.lastSemanticWriteAt;
    delete goal.live;
  });
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId, identity: "match", reachable: false, state: "exited",
    ownership: "legacy", observedAt: new Date().toISOString(), source: "backend",
  });
  f.adapter.inspectMany = async scenes => Promise.all(scenes.map(current => f.adapter.inspect(current)));
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id),
    error => error instanceof Error && /legacy_confirmation_required/.test(error.message));
  await f.runtime.confirmLegacyScene(f.goal.id, "旧终端窗口已由人确认关闭");
  const goal = (await f.service.read()).goals[0]!;
  assert.equal(goal.scene, undefined);
  assert.equal(goal.attemptHistory?.at(-1)?.attemptId, scene.attemptId);
  assert.equal(goal.attemptHistory?.at(-1)?.reason, "superseded");
  assert.equal(f.created.length, 1, "confirmation does not create a replacement");
  assert.deepEqual(f.stopped, [], "confirmation does not close or kill the old pane");
});

test("a completed legacy owner stays in history and is never closed without confirmation", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-legacy-complete" });
  await f.service.store.update("test.legacy-completed-scene", state => {
    const goal = state.goals.find(item => item.id === f.goal.id)!;
    delete goal.scene!.ownership;
    delete goal.agentRuntime!.attempt.scene!.ownership;
    goal.agentRuntime!.lastEventAt = "2026-11-17T00:00:00.000Z";
    delete goal.agentRuntime!.lastSemanticWriteAt;
    delete goal.live;
  });
  const legacyScene = (await f.service.read()).goals[0]!.scene!;
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId, identity: "match", reachable: false, state: "exited",
    ownership: "legacy", observedAt: new Date().toISOString(), source: "backend",
  });
  f.adapter.inspectMany = async scenes => Promise.all(scenes.map(current => f.adapter.inspect(current)));

  await f.service.execute({ type: "goal.complete", goalId: f.goal.id, note: "用户确认目标已经完成" });
  await assert.rejects(f.runtime.close(legacyScene, f.goal.id),
    error => error instanceof Error && /legacy_confirmation_required/.test(error.message));

  const completed = (await f.service.read()).goals[0]!;
  assert.equal(completed.status, "completed");
  assert.equal(completed.scene?.bindingId, legacyScene.bindingId,
    "completion preserves the unverified scene instead of retiring it silently");
  assert.deepEqual(f.stopped, [], "completion never closes an unverified legacy pane");

  await f.runtime.confirmLegacyScene(f.goal.id, "旧负责人已由人现场确认退出");
  const confirmed = (await f.service.read()).goals[0]!;
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.scene, undefined);
  assert.equal(confirmed.attemptHistory?.at(-1)?.attemptId, scene.attemptId);
  assert.equal(confirmed.attemptHistory?.at(-1)?.reason, "superseded");
  assert.deepEqual(f.stopped, [], "explicit confirmation still does not close the old pane");
});

test("a legacy concierge with changed identity offers explicit recovery without creating a second concierge", async t => {
  const f = await fixture(t);
  const scene = await f.runtime.prepareConcierge();
  await f.service.store.update("test.legacy-concierge", state => {
    delete state.concierge.scene!.ownership;
  });
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId, identity: "mismatch", reachable: false, state: "unknown",
    ownership: "legacy", observedAt: new Date().toISOString(), source: "backend",
  });
  await assert.rejects(f.runtime.prepareConcierge(), /legacy_confirmation_required/);
  assert.equal((await f.service.read()).concierge.scene?.bindingId, scene.bindingId);
  await f.runtime.confirmLegacyScene(undefined, "原管家终端已由人确认结束");
  assert.equal((await f.service.read()).concierge.scene, undefined);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.stopped, []);
});

test("a new semantic write between two exit samples preserves the original owner", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-exit-race" });
  let exitSamples = 0, firstSampleAt = 0, secondSampleAt = 0;
  f.adapter.inspect = async current => {
    exitSamples++;
    if (exitSamples === 2) firstSampleAt = Date.now();
    if (exitSamples === 3) {
      secondSampleAt = Date.now();
      await f.service.execute({
        type: "goal.progress", goalId: f.goal.id, actor: "owner-exit-race",
        summary: "负责人仍在执行，退出核对期间补交真实结果。",
      });
    }
    return {
      bindingId: current.bindingId, identity: "match", reachable: false, state: "exited",
      ownership: "ended", observedAt: new Date().toISOString(), source: "backend",
    };
  };
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id), /退出核对期间收到新写回/);
  const current = (await f.service.read()).goals[0]!;
  assert(secondSampleAt - firstSampleAt >= 2_000);
  assert.equal(current.scene?.bindingId, scene.bindingId);
  assert.equal(current.attemptHistory?.length ?? 0, 0);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.stopped, []);
});

test("an uncertain runtime neither re-anchors, sends, retires, nor creates a replacement", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-uncertain" });
  const before = await f.service.read();
  const sentBefore = f.sent.length;
  f.adapter.inspect = async current => ({
    bindingId: current.bindingId, identity: "mismatch", reachable: false, state: "unknown",
    ownership: "uncertain", observedAt: new Date().toISOString(), source: "backend",
  });
  f.adapter.inspectMany = async scenes => Promise.all(scenes.map(current => f.adapter.inspect(current)));
  await assert.rejects(f.runtime.send(scene, "uncertain-send", "不应发送"), /无法稳定确认|身份已改变/);
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id), /尚未确认停止|无法稳定确认/);
  assert.deepEqual(await f.service.read(), before);
  assert.equal(f.sent.length, sentBefore, "no message reaches an unverified scene");
  assert.equal(f.created.length, 1, "no replacement is created");
  assert.deepEqual(f.stopped, []);
});
