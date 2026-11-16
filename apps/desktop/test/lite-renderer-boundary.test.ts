import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const retiredBridgeNames = [
  "orcaStatus",
  "orcaAction",
  "selectOrcaApplication",
  "backendStatus",
  "switchBackend",
  "retryBackendSwitch",
  "cancelBackendSwitch",
  "restoreBackend",
  "methodPacksStatus",
  "previewMethodPack",
  "installMethodPack",
  "mutateMethodPack",
];
const retiredCommandPrefixes = [
  "release.approve",
  "release.reject",
  "goal.boundary.resolve",
  "goal.reopen",
  "goal.skill.attach",
  "goal.skill.detach",
  "goal.autonomy.pause",
  "goal.autonomy.resume",
  "workspace.autonomy.set",
  "project.autonomy.set",
];

test("preload and renderer API expose no retired Orca, backend-switch or method-pack bridge", async () => {
  const sources = await Promise.all([
    readFile("electron/preload.ts", "utf8"),
    readFile("src/api.ts", "utf8"),
  ]);
  for (const source of sources) {
    for (const name of retiredBridgeNames)
      assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), name);
  }
});

test("renderer actions contain no release, boundary, method-pack or experimental autonomy commands", async () => {
  const sources = await Promise.all([
    readFile("src/main.tsx", "utf8"),
    readFile("src/features/goals/GoalDetail.tsx", "utf8"),
    readFile("src/features/goals/GoalActionDock.tsx", "utf8"),
  ]);
  for (const source of sources) {
    for (const command of retiredCommandPrefixes)
      assert.doesNotMatch(source, new RegExp(command.replaceAll(".", "\\.")), command);
  }
});
