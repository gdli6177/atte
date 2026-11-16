import assert from "node:assert/strict";
import test from "node:test";
import { initialState, migrateStoredState, validateState, type SceneReferenceV1 } from "../../core/src/index.js";
import { workspaceSessionName, localAdapter } from "../src/index.js";

test("new workspaces use Atte names and explicit session settings take precedence", () => {
  assert.match(workspaceSessionName("/workspace", {}), /^atte-[a-f0-9]{10}$/);
  assert.equal(workspaceSessionName("/workspace", {
    ATTE_HERDR_SESSION: "current", CREWVANE_HERDR_SESSION: "legacy",
  }), "current");
  assert.equal(workspaceSessionName("/workspace", { CREWVANE_HERDR_SESSION: "legacy" }), "legacy");
});

test("rebranding preserves an existing verified v4 scene and its original Herdr session", () => {
  const state = initialState();
  const scene: SceneReferenceV1 = {
    version: 1, backend: "herdr", installationId: "installation", backendEpoch: 0,
    bindingId: "binding", attemptId: "attempt", runtimeId: "runtime", runtimeGeneration: "generation",
    locator: { kind: "herdr", session: "crewvane-original", workspaceId: "w1", tabId: "t1", paneId: "p1" },
  };
  state.concierge.scene = scene;
  const migrated = validateState(migrateStoredState(state));
  assert.deepEqual(migrated.concierge.scene, scene);
  assert.equal(migrated.concierge.legacyScene, undefined);
  assert.equal(workspaceSessionName("/workspace", {}, migrated), "crewvane-original");
});

test("unverified old references are reconnected in their recorded session", () => {
  const state = initialState();
  state.concierge.legacyScene = {
    version: 0, backend: "herdr", verification: "unverified",
    reference: { session: "crewvane-original", workspaceId: "w1", tabId: "t1", paneId: "p1" },
  };
  assert.equal(workspaceSessionName("/workspace", {}, state), "crewvane-original");
});

test("the adapter factory rejects a retired Orca selection before filesystem or process work", () => {
  assert.throws(() => localAdapter({
    backend: "orca",
    workspace: "/workspace",
    control: {
      version: 1, installationId: "installation", selected: "herdr",
      epoch: 0, scopeGeneration: "scope", phase: "ready",
    },
    directory: "/nonexistent",
  }), /backend_unsupported/);
});
