import test from "node:test";
import assert from "node:assert/strict";
import { migratePreference } from "../src/storage-compat.js";

test("legacy browser preferences are read once and copied to the Atte key", () => {
  const values = new Map([["crewvane.theme", "light"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(migratePreference(storage, "theme"), "light");
  assert.equal(values.get("atte.theme"), "light");
  values.set("crewvane.theme", "dark");
  assert.equal(migratePreference(storage, "theme"), "light");
});
