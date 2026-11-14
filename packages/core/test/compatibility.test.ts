import test from "node:test";
import assert from "node:assert/strict";
import {
  environmentValue,
  migrateStoredState,
  rewriteStoredCompatibility,
} from "../src/index.js";

test("Atte environment names win over legacy Crewvane names", () => {
  assert.equal(environmentValue({
    ATTE_WORKSPACE: "/new",
    CREWVANE_WORKSPACE: "/old",
  }, "WORKSPACE"), "/new");
  assert.equal(environmentValue({
    CREWVANE_WORKSPACE: "/old",
  }, "WORKSPACE"), "/old");
  assert.equal(environmentValue({}, "WORKSPACE"), undefined);
});

test("stored compatibility migration only rewrites known legacy fields", () => {
  const value = {
    path: ".crewvane/attachments/att_legacy.png",
    untouched: ".crewvane/other/file",
    minimumCrewvane: "0.10.0",
    nested: {
      schema: "crewvane.bot.v1",
      paths: [{ path: ".crewvane/attachments/att_nested.png" }],
    },
  };
  const migrated = migrateStoredState(value);
  assert.deepEqual(migrated, {
    path: ".atte/attachments/att_legacy.png",
    untouched: ".crewvane/other/file",
    minimumAtte: "0.10.0",
    nested: {
      schema: "atte.bot.v1",
      paths: [{ path: ".atte/attachments/att_nested.png" }],
    },
  });
  assert.deepEqual(rewriteStoredCompatibility({
    schema: "crewvane.bot.v1",
    minimumCrewvane: "0.10.0",
  }), {
    schema: "atte.bot.v1",
    minimumAtte: "0.10.0",
  });
});

test("migration preserves verbatim messages, quotes and evidence containing old protocol names", () => {
  const quote = "请检查 crewvane.bot.v1；不要修改这句原话。";
  const value = {
    schema: "crewvane.bot.v1",
    text: quote,
    decision: { quote },
    evidence: [{ summary: quote, command: "echo crewvane.bot.v1" }],
  };
  assert.deepEqual(migrateStoredState(value), { ...value, schema: "atte.bot.v1" });
  assert.deepEqual(rewriteStoredCompatibility(value), { ...value, schema: "atte.bot.v1" });
});
