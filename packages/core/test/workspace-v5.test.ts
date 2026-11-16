import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeatureRemovedError, WorkspaceService, WorkspaceStore, goalCanExecute, importAttachmentBytes,
  initialState, isReadOnlyGoal,
  type Goal, type ManagedSessionContext, type SceneReferenceV1, type WorkspaceState,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-v5-"));
  roots.push(root);
  return { root, service: new WorkspaceService(root) };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function orcaScene(goalId: string): SceneReferenceV1 {
  return {
    version: 1, backend: "orca", installationId: "installation-one",
    runtimeId: "runtime-one", runtimeGeneration: "runtime-birth-one",
    bindingId: `binding-${goalId}`, attemptId: `attempt-${goalId}`,
    backendEpoch: 1,
    locator: {
      kind: "orca", repoId: "repo-one", worktreeId: "repo-one::/tmp/legacy",
      terminalHandle: `terminal-${goalId}`, executionHostId: "local",
      incarnationId: "incarnation-one",
    },
  };
}
function v4Snapshot(state: WorkspaceState): Record<string, unknown> {
  const goals = state.goals.map((goal, index) => {
    if (index === 0) return {
      ...goal, kind: "discovery",
      brief: {
        revision: 1, outcome: "history", inScope: [], outOfScope: [],
        criteria: [{ id: "c1", statement: "done", required: true,
          provenance: { kind: "verification-method", rationale: "检查真实结果" } }],
        constraints: [], externalEffects: [], verificationPlan: {
          requiredEvidenceKinds: ["inspection"], independentReviewer: true,
        }, attemptBudget: { maxRecoveryAttempts: 2 }, source: { activityIds: [], ruleRefs: [] },
        setBy: "管家", setAt: new Date().toISOString(),
      },
      autonomy: {
        continuation: {
          id: "continuation-one", trigger: "checkpoint", status: "scheduled",
          dueAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1,
          basisRevision: "1:now", idempotencyKey: "key",
        },
        attempts: { used: 0, limit: 2 },
      },
      skills: [{
        packId: "pack", version: "1.0.0", digest: "a".repeat(64),
        roles: ["owner"], attachedAt: new Date().toISOString(), attachedBy: "human",
      }],
      dispatch: { id: "old-dispatch", kind: "continuation", status: "pending", at: new Date().toISOString() },
    };
    if (index === 1) return { ...goal, status: "review" };
    return {
      ...goal, status: "active", scene: orcaScene(goal.id),
      autonomy: {
        attempts: { used: 0, limit: 3 },
        continuation: {
          id: "orca-continuation", trigger: "checkpoint", status: "scheduled",
          dueAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1,
          basisRevision: "1:orca", idempotencyKey: "orca-continuation",
        },
      },
      watchdog: { reason: "stale", basis: "old", detectedAt: new Date().toISOString() },
      recovery: "idle" as const,
      dispatch: { id: "orca-dispatch", kind: "feedback", status: "pending", at: new Date().toISOString() },
    };
  });
  return {
    ...state, version: 4, goals,
    autonomy: {
      acceptance: "auto-with-verification", paused: false,
      maxRecoveryAttempts: 3, noProgressMinutes: 45, revision: 2,
      updatedAt: new Date().toISOString(),
    },
    bots: [{ id: "bot", name: "bot", role: "initiator", projectIds: ["personal"],
      operations: ["goal.read"], expiresAt: "2030-01-01T00:00:00Z", status: "active" }],
    botRequests: [{ botId: "bot", requestId: "request", operation: "goal.read",
      at: new Date().toISOString(), status: "completed" }],
    agents: { concierge: "codex", owner: "omp", worker: "worker" },
    projects: state.projects.map(project => ({
      ...project,
      autonomy: { acceptance: "auto-with-verification", revision: 1, updatedAt: new Date().toISOString() },
      releaseOnMerge: "production",
    })),
  };
}

test("v4 migrates atomically to v5 with verified backup and complete historical facts", async () => {
  const { root, service } = await fixture();
  const experimental = await service.execute({ type: "goal.intake", text: "实验目标" }) as Goal;
  const delivered = await service.execute({ type: "goal.intake", text: "待验收目标" }) as Goal;
  const orca = await service.execute({ type: "goal.intake", text: "旧 Orca 目标" }) as Goal;
  await service.execute({
    type: "goal.message", goalId: experimental.id,
    text: "保留这条原始消息和它的活动顺序。",
  });
  const [attachment] = await importAttachmentBytes(root, [{
    name: "evidence.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64"),
  }]);
  await service.execute({
    type: "goal.message", goalId: experimental.id,
    text: "保留附件消息。", attachments: [attachment!],
  });
  await service.execute({
    type: "goal.risk", goalId: experimental.id,
    category: "change-permissions", summary: "保留已批准的历史决定",
  });
  await service.execute({
    type: "goal.resolve", goalId: experimental.id,
    note: "批准保留原历史决定", outcome: "approved", actor: "你",
  });
  await service.execute({
    type: "goal.review", goalId: delivered.id, actor: "owner-one",
    delivery: {
      summary: "旧交付完整保留", location: "/tmp/result",
      candidate: { revision: "candidate-one", digest: "b".repeat(64) },
      checks: [{ name: "真实测试", command: "pnpm test", result: "passed" }],
      evidence: [{
        id: "evidence-one", kind: "command", label: "真实测试",
        result: "passed", observedAt: new Date().toISOString(),
        command: "pnpm test",
      }],
    },
  });
  const original = await service.read();
  const originalGoals = structuredClone(original.goals);
  const raw = `${JSON.stringify(v4Snapshot(original), null, 2)}\n`;
  const stateFile = join(root, ".atte/state.json");
  await writeFile(stateFile, raw);
  const pack = join(root, ".atte/skills/pack/SKILL.md");
  await mkdir(join(root, ".atte/skills/pack"), { recursive: true });
  await writeFile(pack, "keep me\n");

  const migrated = await new WorkspaceStore(root).read();
  assert.equal(migrated.version, 5);
  assert.equal(migrated.name, original.name);
  assert.deepEqual(migrated.projects.map(project => project.id),
    original.projects.map(project => project.id));
  assert.deepEqual(migrated.goals.map(goal => goal.id), [
    experimental.id, delivered.id, orca.id,
  ]);
  assert.deepEqual(migrated.goals.map(goal => goal.activities), originalGoals.map(goal => goal.activities));
  assert.deepEqual(migrated.goals.map(goal => goal.attachments ?? []),
    originalGoals.map(goal => goal.attachments ?? []));
  assert.deepEqual(migrated.goals.map(goal => goal.createdAt), originalGoals.map(goal => goal.createdAt));
  assert.deepEqual(migrated.goals.map(goal => goal.updatedAt), originalGoals.map(goal => goal.updatedAt));
  assert.ok(migrated.goals[0]?.activities.some(activity =>
    activity.text === "保留这条原始消息和它的活动顺序。"));
  assert.equal(migrated.goals[0]?.attachments?.[0]?.id, attachment?.id);
  assert.deepEqual(migrated.decisions, original.decisions);
  assert.equal(migrated.decisions.length, 1);

  const held = migrated.goals[0]!;
  assert.equal(held.executionHold, "migration-confirmation");
  assert.equal(held.status, "active");
  assert.equal(held.dispatch, undefined);
  assert.equal(held.history?.dispatch?.kind, "continuation");
  assert.equal(held.history?.autonomy?.continuation?.status, "scheduled");
  assert.equal(held.history?.kind, "discovery");
  assert.equal(goalCanExecute(held), false);

  const oldDelivery = migrated.goals[1]!;
  assert.equal(oldDelivery.status, "review");
  assert.equal(oldDelivery.attention?.kind, "review");
  assert.equal(oldDelivery.delivery?.id, originalGoals[1]?.delivery?.id);
  assert.deepEqual(oldDelivery.delivery, originalGoals[1]?.delivery);
  assert.equal(oldDelivery.acceptance, undefined);
  assert.equal(oldDelivery.history?.kind, "delivery");
  assert.equal(oldDelivery.history?.retiredAt !== undefined, true);

  const legacyOrca = migrated.goals[2]!;
  assert.equal(legacyOrca.status, "active");
  assert.equal(legacyOrca.status, originalGoals[2]?.status);
  assert.equal(legacyOrca.readOnly, true);
  assert.equal(legacyOrca.readOnlyReason, "legacy-orca");
  assert.equal(isReadOnlyGoal(legacyOrca), true);
  assert.equal(goalCanExecute(legacyOrca), false);
  assert.equal(legacyOrca.dispatch, undefined);
  assert.equal(legacyOrca.watchdog, undefined);
  assert.equal(legacyOrca.recovery, undefined);
  assert.equal(legacyOrca.autonomy, undefined);
  assert.equal(legacyOrca.history?.autonomy?.continuation?.status, "scheduled");
  assert.deepEqual(legacyOrca.scene, orcaScene(legacyOrca.id));
  assert.equal(legacyOrca.owner, originalGoals[2]?.owner);

  assert.deepEqual(migrated.agents, { concierge: "codex", owner: "omp" });
  assert.equal(migrated.watchdog?.noProgressMinutes, 45);
  assert.equal(migrated.autonomy, undefined);
  assert.equal(migrated.history?.autonomy?.acceptance, "auto-with-verification");
  assert.equal(migrated.history?.worker, "worker");
  assert.equal(migrated.history?.bots?.[0]?.id, "bot");
  assert.equal(migrated.history?.projects?.[0]?.projectId, "personal");

  const backup = await readFile(join(root, ".atte/state.v4.backup.json"), "utf8");
  assert.equal(backup, raw);
  assert.equal(digest(backup), digest(raw));
  assert.notEqual(digest(raw), digest(await readFile(stateFile, "utf8")));
  assert.equal(await readFile(pack, "utf8"), "keep me\n");

  assert.deepEqual(await service.execute({
    type: "watchdog.inspect", at: new Date(Date.now() + 86400_000).toISOString(),
  }), []);
  await assert.rejects(service.execute({
    type: "goal.dispatch", goalId: held.id, status: "pending",
  }), /goal_confirmation_required/);
  await assert.rejects(service.execute({
    type: "goal.dispatch", goalId: legacyOrca.id, status: "pending",
  }), /goal_read_only/);
  await assert.rejects(service.execute({
    type: "goal.update", goalId: legacyOrca.id, patch: { next: "不允许改写旧 Orca 目标" },
  }), /goal_read_only/);

  const firstWrite = await readFile(stateFile, "utf8");
  const secondRead = await new WorkspaceStore(root).read();
  assert.deepEqual(secondRead, migrated);
  assert.equal(await readFile(stateFile, "utf8"), firstWrite);
  assert.equal((await readdir(join(root, ".atte"))).filter(name => name.includes("tmp")).length, 0);
});

test("v4 auto-accepted delivery is revoked into human review, while a human acceptance is preserved", async () => {
  const { root, service } = await fixture();
  const goal = await service.execute({ type: "goal.intake", text: "旧自动验收交付" }) as Goal;
  await service.execute({
    type: "goal.review", goalId: goal.id, actor: "owner-one",
    delivery: {
      summary: "旧自动验收前的真实交付",
      checks: [{ name: "真实测试", command: "pnpm test", result: "passed" }],
    },
  });
  const legacy = structuredClone(await service.read());
  const legacyGoal = legacy.goals[0]!;
  legacyGoal.status = "completed";
  legacyGoal.autonomy = {
    acceptance: {
      id: "acceptance-auto", kind: "automatic", at: new Date().toISOString(),
      by: "Atte", mandateRevision: 1,
    },
    attempts: { used: 0, limit: 3 },
  };
  const raw = `${JSON.stringify({ ...legacy, version: 4 }, null, 2)}\n`;
  const stateFile = join(root, ".atte/state.json");
  await writeFile(stateFile, raw);

  const migrated = await new WorkspaceStore(root).read();
  const reviewed = migrated.goals[0]!;
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.acceptance, undefined);
  assert.equal(reviewed.delivery?.summary, "旧自动验收前的真实交付");
  assert.equal(reviewed.history?.autonomy?.acceptance?.kind, "automatic");
  assert.equal(reviewed.attention?.kind, "review");
  await assert.rejects(new WorkspaceService(root).execute({
    type: "goal.accept", goalId: goal.id, actor: "Atte",
  }), /必须由人/);
  const accepted = await new WorkspaceService(root).execute({
    type: "goal.accept", goalId: goal.id, actor: "你", note: "人工核对后通过。",
  }) as Goal;
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.acceptance?.kind, "human");
});

test("v4 keeps delivery and discovery ordinary while release lifecycle and migration confirmation stay guarded", async () => {
  const { root, service } = await fixture();
  const discovery = await service.execute({
    type: "goal.intake", text: "普通探索目标", kind: "discovery",
  }) as Goal;
  const release = await service.execute({
    type: "goal.intake", text: "旧发布目标",
  }) as Goal;
  const legacy = structuredClone(await service.read());
  const discoveryGoal = legacy.goals.find(goal => goal.id === discovery.id)!;
  const releaseGoal = legacy.goals.find(goal => goal.id === release.id)!;
  assert.equal(discoveryGoal.kind, "discovery");
  releaseGoal.kind = "release";
  releaseGoal.release = {
    sourceGoalIds: [discovery.id], environment: "production",
    candidate: { revision: "release-candidate" }, status: "drafting",
  };
  const raw = `${JSON.stringify({ ...legacy, version: 4 }, null, 2)}\n`;
  await writeFile(join(root, ".atte/state.json"), raw);

  const migrated = await new WorkspaceStore(root).read();
  const keptDiscovery = migrated.goals.find(goal => goal.id === discovery.id)!;
  const retiredRelease = migrated.goals.find(goal => goal.id === release.id)!;
  assert.equal(keptDiscovery.kind, "discovery");
  assert.equal(keptDiscovery.status, "active");
  assert.equal(keptDiscovery.executionHold, undefined);
  assert.equal(keptDiscovery.history, undefined);
  assert.equal(goalCanExecute(keptDiscovery), true);
  assert.equal(retiredRelease.kind, "delivery");
  assert.equal(retiredRelease.executionHold, "migration-confirmation");
  assert.equal(retiredRelease.dispatch, undefined);
  assert.equal(retiredRelease.history?.kind, "release");
  assert.equal(retiredRelease.history?.release?.environment, "production");
  assert.equal(goalCanExecute(retiredRelease), false);

  await assert.rejects(new WorkspaceService(root).execute({
    type: "goal.resolve", goalId: retiredRelease.id,
    note: "由管家代为确认继续", outcome: "approved", actor: "管家",
  }), /必须由人/);
  await assert.rejects(new WorkspaceService(root).execute({
    type: "goal.delegate", goalId: retiredRelease.id,
  }), /goal_confirmation_required/);
  const rejected = await new WorkspaceService(root).execute({
    type: "goal.resolve", goalId: retiredRelease.id,
    note: "先不要继续", outcome: "rejected", actor: "你",
  }) as Goal;
  assert.equal(rejected.executionHold, "migration-confirmation");
  assert.equal(rejected.attention?.kind, "decision");
  assert.equal(rejected.dispatch, undefined);
  assert.equal(goalCanExecute(rejected), false);
  const approved = await new WorkspaceService(root).execute({
    type: "goal.resolve", goalId: retiredRelease.id,
    note: "确认按普通交付目标继续", outcome: "approved", actor: "你",
  }) as Goal;
  assert.equal(approved.executionHold, undefined);
  assert.equal(approved.dispatch?.status, "pending");
  assert.equal(goalCanExecute(approved), true);
});

test("delivery and discovery kinds can switch, while release and unknown kinds are rejected", async () => {
  const { service } = await fixture();
  const goal = await service.execute({ type: "goal.intake", text: "可切换类型" }) as Goal;
  assert.equal(goal.kind, "delivery");
  const discovery = await service.execute({
    type: "goal.kind.set", goalId: goal.id, kind: "discovery", actor: "管家",
  }) as Goal;
  assert.equal(discovery.kind, "discovery");
  assert.equal(discovery.activities.at(-1)?.kind, "progress");
  const delivery = await service.execute({
    type: "goal.kind.set", goalId: goal.id, kind: "delivery", actor: "管家",
  }) as Goal;
  assert.equal(delivery.kind, "delivery");
  await assert.rejects(service.execute({
    type: "goal.kind.set", goalId: goal.id, kind: "release" as never,
  }), (error: unknown) => error instanceof FeatureRemovedError);
  await assert.rejects(service.execute({
    type: "goal.kind.set", goalId: goal.id, kind: "unknown" as never,
  }), /delivery 或 discovery/);
});

test("backup conflict, unsafe or unusable backup stops migration without rewriting state", async () => {
  const { root, service } = await fixture();
  await service.execute({ type: "goal.intake", text: "不可破坏" });
  const stateFile = join(root, ".atte/state.json");
  const raw = `${JSON.stringify({ ...await service.read(), version: 4 }, null, 2)}\n`;
  await writeFile(stateFile, raw);
  const backup = join(root, ".atte/state.v4.backup.json");
  await writeFile(backup, "different");
  await assert.rejects(new WorkspaceStore(root).read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
  await rm(backup);
  await symlink(stateFile, backup);
  await assert.rejects(new WorkspaceStore(root).read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
  await rm(backup);
  await mkdir(backup);
  await assert.rejects(new WorkspaceStore(root).read(), /备份|目录/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
  assert.equal((await readdir(root)).filter(name => name.startsWith(".atte.backup-")).length, 0);
});

test("unsupported, corrupt and structurally invalid snapshots stop without archiving", async () => {
  for (const raw of [
    JSON.stringify({ ...initialState(), version: 6, plugins: [] }),
    "{broken",
    JSON.stringify({ version: 5, addons: [] }),
  ]) {
    const { root } = await fixture();
    await mkdir(join(root, ".atte"));
    await writeFile(join(root, ".atte/state.json"), raw);
    await writeFile(join(root, ".atte/keep.txt"), "keep");
    await assert.rejects(new WorkspaceStore(root).read());
    assert.equal(await readFile(join(root, ".atte/state.json"), "utf8"), raw);
    assert.equal(await readFile(join(root, ".atte/keep.txt"), "utf8"), "keep");
    assert.equal((await readdir(root)).filter(name => name.startsWith(".atte.backup-")).length, 0);
  }
});

test("v5 rejects re-enabled retired execution fields", async () => {
  const cases: Array<{
    name: string;
    mutate: (state: WorkspaceState, goal: Goal) => void;
  }> = [
    {
      name: "release kind",
      mutate: (_state, goal) => {
        goal.kind = "release";
      },
    },
    {
      name: "continuation dispatch",
      mutate: (_state, goal) => {
        goal.dispatch = {
          id: "legacy-continuation", kind: "continuation", status: "pending",
          at: new Date().toISOString(),
        };
      },
    },
    {
      name: "automatic acceptance",
      mutate: (_state, goal) => {
        goal.acceptance = {
          id: "acceptance-auto", kind: "automatic", at: new Date().toISOString(),
          by: "Atte", mandateRevision: 1,
        };
      },
    },
  ];
  for (const current of cases) {
    const { root, service } = await fixture();
    const goal = await service.execute({ type: "goal.intake", text: current.name }) as Goal;
    const state = await service.read();
    current.mutate(state, state.goals.find(item => item.id === goal.id)!);
    const raw = `${JSON.stringify(state, null, 2)}\n`;
    const stateFile = join(root, ".atte/state.json");
    await writeFile(stateFile, raw);
    await assert.rejects(new WorkspaceStore(root).read(),
      (error: unknown) => error instanceof Error, current.name);
    assert.equal(await readFile(stateFile, "utf8"), raw, current.name);
  }
});

test("v5 legacy Orca data stays readable with original status and scene but no executable state", async () => {
  const { root, service } = await fixture();
  const goal = await service.execute({ type: "goal.intake", text: "v5 旧 Orca 目标" }) as Goal;
  const state = await service.read();
  const legacy = state.goals.find(item => item.id === goal.id)!;
  legacy.scene = orcaScene(goal.id);
  legacy.watchdog = {
    reason: "stale", basis: "old", detectedAt: new Date().toISOString(),
  };
  legacy.recovery = "idle";
  legacy.sceneVisit = {
    id: "visit-old", attentionId: "attention-old", at: new Date().toISOString(),
    worked: false, status: "watching",
  };
  state.backendBinding = {
    installationId: "installation-one", backend: "orca", epoch: 0,
    scopeGeneration: "scope-one", status: "active",
  };
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  const stateFile = join(root, ".atte/state.json");
  await writeFile(stateFile, raw);

  const read = await new WorkspaceStore(root).read();
  const saved = read.goals.find(item => item.id === goal.id)!;
  assert.equal(saved.status, "active");
  assert.equal(saved.owner, goal.owner);
  assert.equal(saved.scene?.backend, "orca");
  assert.equal(saved.readOnly, true);
  assert.equal(saved.readOnlyReason, "legacy-orca");
  assert.equal(isReadOnlyGoal(saved), true);
  assert.equal(goalCanExecute(saved), false);
  assert.equal(saved.dispatch, undefined);
  assert.equal(saved.watchdog, undefined);
  assert.equal(saved.recovery, undefined);
  assert.equal(saved.sceneVisit, undefined);
  assert.equal(read.backendBinding?.backend, "orca");
  assert.equal(await readFile(stateFile, "utf8"), raw);
});

test("v2 and v3 migrate through verified backups without losing goals or messages", async () => {
  for (const version of [2, 3] as const) {
    const { root, service } = await fixture();
    const ids: string[] = [];
    for (const text of [`v${version} 目标一`, `v${version} 目标二`, `v${version} 目标三`]) {
      ids.push((await service.execute({ type: "goal.intake", text }) as Goal).id);
    }
    await service.execute({
      type: "goal.message", goalId: ids[0]!, text: `v${version} 的原始消息`,
    });
    const [attachment] = await importAttachmentBytes(root, [{
      name: `v${version}.png`,
      bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64"),
    }]);
    await service.execute({
      type: "goal.message", goalId: ids[0]!, text: `v${version} 的附件消息`,
      attachments: [attachment!],
    });
    await service.execute({
      type: "goal.risk", goalId: ids[0]!, category: "change-permissions",
      summary: `v${version} 的旧高风险决定`,
    });
    await service.execute({
      type: "goal.resolve", goalId: ids[0]!, actor: "你",
      outcome: "approved", note: `v${version} 原话批准`,
    });
    await service.execute({
      type: "goal.review", goalId: ids[1]!, actor: "owner-one",
      delivery: {
        summary: `v${version} 的旧交付`,
        checks: [{ name: "真实检查", command: "pnpm test", result: "passed" }],
        evidence: [{
          id: `evidence-v${version}`, kind: "command", label: "真实检查",
          result: "passed", observedAt: new Date().toISOString(), command: "pnpm test",
        }],
      },
    });
    const legacy = v4Snapshot(await service.read());
    delete legacy.autonomy;
    delete legacy.bots;
    delete legacy.botRequests;
    legacy.version = version;
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(join(root, ".atte/state.json"), raw);
    const migrated = await new WorkspaceStore(root).read();
    const legacyGoals = (legacy as unknown as WorkspaceState).goals;
    const legacyDecisions = (legacy as unknown as WorkspaceState).decisions;
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.goals.map(goal => goal.id), ids);
    assert.deepEqual(migrated.goals.map(goal => goal.activities),
      legacyGoals.map(goal => goal.activities));
    assert.deepEqual(migrated.goals.map(goal => goal.attachments ?? []),
      legacyGoals.map(goal => goal.attachments ?? []));
    assert.deepEqual(migrated.decisions, legacyDecisions);
    assert.equal(migrated.decisions.length, 1);
    assert.deepEqual(migrated.goals.map(goal => goal.delivery),
      legacyGoals.map(goal => goal.delivery));
    assert.equal(migrated.goals[1]?.delivery?.summary, `v${version} 的旧交付`);
    assert.ok(migrated.goals[0]?.activities.some(activity =>
      activity.text === `v${version} 的原始消息`));
    assert.ok(migrated.goals[0]?.activities.some(activity =>
      activity.text.includes(`v${version} 的附件消息`)));
    assert.equal(await readFile(join(root, ".atte", `state.v${version}.backup.json`), "utf8"), raw);
    assert.equal(migrated.goals[1]?.status, "review");
    assert.equal(migrated.goals[2]?.readOnly, true);
  }
});
