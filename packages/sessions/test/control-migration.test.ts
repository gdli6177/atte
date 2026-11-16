import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal, type SceneReferenceV1 } from "../../core/src/index.js";
import { SessionControl } from "../src/index.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atte-control-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, "control") };
}

test("an old Orca control selection upgrades to Herdr without inspecting or moving scenes", async t => {
  const { directory } = await fixture(t);
  const control = new SessionControl(directory);
  await control.initialize();
  const path = join(directory, "backend.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({
    ...legacy, selected: "orca", epoch: 7, phase: "ready",
  }), { mode: 0o600 });
  const upgraded = await control.initialize();
  assert.deepEqual(upgraded, {
    version: 1, installationId: legacy.installationId, selected: "herdr",
    epoch: 8, scopeGeneration: upgraded.scopeGeneration, phase: "ready",
  });
  assert.notEqual(upgraded.scopeGeneration, legacy.scopeGeneration);
  assert.deepEqual(await control.initialize(), upgraded, "upgrade is idempotent");
  assert.deepEqual(await control.status(), upgraded);
  assert.equal(await control.canDispatch(), true);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.selected, "herdr");
  assert.equal(persisted.orcaAppPath, undefined);
});

test("an Orca control and v4 workspace upgrade together while preserving read-only scenes", async t => {
  const { root, directory } = await fixture(t);
  const control = new SessionControl(directory);
  const originalControl = await control.initialize();
  await writeFile(join(directory, "backend.json"), JSON.stringify({
    ...originalControl, selected: "orca", epoch: 7, phase: "ready",
  }), { mode: 0o600 });
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "保留旧 Orca 事项" }) as Goal;
  const state = await service.read();
  const binding = {
    installationId: originalControl.installationId, backend: "orca" as const,
    epoch: 7, scopeGeneration: originalControl.scopeGeneration, status: "active" as const,
  };
  const scene: SceneReferenceV1 = {
    version: 1, backend: "orca", installationId: originalControl.installationId,
    runtimeId: "old-runtime", runtimeGeneration: "old-runtime-birth",
    bindingId: "old-owner-binding", attemptId: "old-owner-attempt", backendEpoch: 7,
    locator: {
      kind: "orca", repoId: "old-repo", worktreeId: "old-worktree",
      terminalHandle: "old-terminal", executionHostId: "local", incarnationId: "old-incarnation",
    },
  };
  const concierge = {
    ...state.concierge, status: "ready" as const,
    scene: { ...scene, bindingId: "old-concierge-binding", attemptId: "old-concierge-attempt" },
  };
  const raw = `${JSON.stringify({
    ...state, version: 4, backendEpoch: 7, backendBinding: binding, concierge,
    goals: state.goals.map(item => ({ ...item, scene })),
  }, null, 2)}\n`;
  await writeFile(join(root, ".atte/state.json"), raw);

  const upgraded = await control.initialize();
  assert.equal(upgraded.epoch, 8);
  assert.equal(upgraded.selected, "herdr");
  assert.equal((await service.read()).goals[0]?.readOnlyReason, "legacy-orca");
  await control.registerWorkspace(root);
  const registered = await service.read();
  assert.equal(registered.version, 5);
  assert.equal(registered.backendEpoch, 8);
  assert.deepEqual(registered.backendBinding, {
    installationId: upgraded.installationId, backend: "herdr", epoch: 8,
    scopeGeneration: upgraded.scopeGeneration, status: "active",
  });
  assert.equal(registered.goals[0]?.id, goal.id);
  assert.equal(registered.goals[0]?.status, goal.status);
  assert.equal(registered.goals[0]?.readOnlyReason, "legacy-orca");
  assert.deepEqual(registered.goals[0]?.scene, scene);
  assert.deepEqual(registered.history?.backendBinding, binding);
  assert.deepEqual(registered.history?.concierge, concierge);
  assert.equal(registered.concierge.scene, undefined);
  assert.equal(registered.concierge.status, "not_ready");
  assert.equal(await readFile(join(root, ".atte/state.v4.backup.json"), "utf8"), raw);
  await control.registerWorkspace(root);
  assert.deepEqual(await service.read(), registered);
  assert.equal((await control.registrations()).length, 1);
});

test("a live Herdr scene still prevents registering a conflicting epoch", async t => {
  const { root, directory } = await fixture(t);
  const control = new SessionControl(directory);
  const originalControl = await control.initialize();
  await writeFile(join(directory, "backend.json"), JSON.stringify({
    ...originalControl, epoch: 8,
  }), { mode: 0o600 });
  const service = new WorkspaceService(root);
  await service.execute({ type: "goal.intake", text: "保持当前 Herdr 现场" });
  const state = await service.read();
  const scene: SceneReferenceV1 = {
    version: 1, backend: "herdr", installationId: originalControl.installationId,
    runtimeId: "herdr-runtime", runtimeGeneration: "herdr-runtime-birth",
    bindingId: "owner-binding", attemptId: "owner-attempt", backendEpoch: 7,
    locator: {
      kind: "herdr", session: "atte-test", workspaceId: "workspace-one",
      tabId: "workspace-one:tab-one", paneId: "workspace-one:pane-one",
    },
  };
  await writeFile(join(root, ".atte/state.json"), JSON.stringify({
    ...state, backendEpoch: 7, goals: state.goals.map(item => ({ ...item, scene })),
  }));

  await assert.rejects(control.registerWorkspace(root), /stale_backend_epoch/);
  const unchanged = await service.read();
  assert.equal(unchanged.backendEpoch, 7);
  assert.equal(unchanged.backendBinding, undefined);
  assert.deepEqual(unchanged.goals[0]?.scene, scene);
});

test("interrupted switch metadata is retired with a new epoch and never becomes dispatchable history", async t => {
  const { directory } = await fixture(t);
  const control = new SessionControl(directory);
  await control.initialize();
  const path = join(directory, "backend.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({
    ...legacy, selected: "herdr", epoch: 3, phase: "recovery_required",
    switchOperationId: "old-switch", maintenance: { id: "update", backend: "orca" },
  }), { mode: 0o600 });
  const upgraded = await control.initialize({ recoverInterrupted: true });
  assert.equal(upgraded.epoch, 4);
  assert.equal(upgraded.phase, "ready");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.switchOperationId, undefined);
  assert.equal(persisted.maintenance, undefined);
});

test("a corrupted Herdr control file blocks dispatch instead of silently recreating identity", async t => {
  const { directory } = await fixture(t);
  const control = new SessionControl(directory);
  await control.initialize();
  const path = join(directory, "backend.json");
  await writeFile(path, JSON.stringify({ version: 1, selected: "herdr", epoch: "bad" }), { mode: 0o600 });
  await assert.rejects(control.status(), /backend_configuration_invalid/);
  await assert.rejects(control.canDispatch(), /backend_configuration_invalid/);
});
