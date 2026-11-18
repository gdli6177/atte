import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSigningFingerprint,
  parseSigningIdentities,
  resolveSigningPlan,
} from "../signing.mjs";

const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
const identities = [{
  fingerprint,
  name: "Atte Release Signing",
}];

test("release signing requires the fixed identity and never falls back to ad-hoc", () => {
  assert.throws(() => resolveSigningPlan({
    release: true,
    identity: undefined,
    identities: [],
  }), /ATTE_MACOS_SIGN_IDENTITY/);
  assert.throws(() => resolveSigningPlan({
    release: true,
    identity: "-",
    identities: [],
  }), /ad-hoc fallback is disabled/);
  const plan = resolveSigningPlan({
    release: true,
    identity: "Atte Release Signing",
    fingerprint,
    identities,
  });
  assert.equal(plan.identity, fingerprint);
  assert.equal(plan.identityValidation, false);
  assert.equal(plan.hardenedRuntime, true);
  assert.throws(() => resolveSigningPlan({
    release: true,
    identity: "Atte Release Signing",
    identities,
  }), /ATTE_MACOS_SIGN_FINGERPRINT/);
});

test("a pinned fingerprint must belong to the configured identity", () => {
  assert.equal(normalizeSigningFingerprint(
    " 01234567 89abcdef 01234567 89abcdef 01234567 ",
  ), fingerprint);
  const plan = resolveSigningPlan({
    release: true,
    identity: "Atte Release Signing",
    fingerprint,
    identities,
  });
  assert.equal(plan.identity, fingerprint);
  assert.equal(plan.fingerprint, fingerprint);
  assert.throws(() => resolveSigningPlan({
    release: true,
    identity: "Atte Release Signing",
    fingerprint: "F".repeat(40),
    identities,
  }), /fingerprint does not match/);
  assert.throws(() => resolveSigningPlan({
    release: true,
    identity: "Another Certificate",
    fingerprint,
    identities,
  }), /not available/);
  assert.equal(resolveSigningPlan({
    release: true,
    identity: "Atte Release Signing",
    fingerprint,
    identities: [{ name: "Atte Release Signing", fingerprint: "F".repeat(40) }, ...identities],
  }).identity, fingerprint);
});

test("development packaging may still use ad-hoc signing without a pinned identity", () => {
  const plan = resolveSigningPlan({
    release: false,
    identity: undefined,
    identities: [],
  });
  assert.equal(plan.identity, "-");
  assert.equal(plan.identityValidation, false);
  assert.equal(plan.hardenedRuntime, false);
});

test("security output parsing keeps exact names and uppercase fingerprints", () => {
  assert.deepEqual(parseSigningIdentities(`
  1) ${fingerprint} "Atte Release Signing"
     1 valid identities found
`), identities);
});
