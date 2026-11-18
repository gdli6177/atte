const FINGERPRINT = /^[0-9A-F]{40}$/;

export function normalizeSigningFingerprint(value) {
  const fingerprint = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!fingerprint) return undefined;
  if (!FINGERPRINT.test(fingerprint))
    throw new Error("ATTE_MACOS_SIGN_FINGERPRINT 必须是 40 位 SHA-1 指纹");
  return fingerprint;
}

export function parseSigningIdentities(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map(line => /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line))
    .filter(match => match !== null)
    .map(match => ({ fingerprint: match[1].toUpperCase(), name: match[2] }));
}

/**
 * Release builds must use the persistent self-signed identity. Development
 * builds may still use ad-hoc signing for local packaging smoke tests.
 */
export function resolveSigningPlan({
  release,
  identity,
  fingerprint,
  identities,
}) {
  const name = String(identity ?? "").trim(),
    pinned = normalizeSigningFingerprint(fingerprint);
  if (!name || name === "-") {
    if (release)
      throw new Error("Release packaging requires ATTE_MACOS_SIGN_IDENTITY; ad-hoc fallback is disabled");
    if (pinned)
      throw new Error("ATTE_MACOS_SIGN_FINGERPRINT 需要同时提供 ATTE_MACOS_SIGN_IDENTITY");
    return {
      release: false,
      identity: "-",
      identityValidation: false,
      hardenedRuntime: false,
      fingerprint: undefined,
    };
  }
  if (!identities.some(item => item.name === name))
    throw new Error(`Configured release signing identity is not available: ${name}`);
  if (release && !pinned)
    throw new Error("Release packaging requires ATTE_MACOS_SIGN_FINGERPRINT");
  if (pinned) {
    const match = identities.find(item => item.name === name && item.fingerprint === pinned);
    if (!match)
      throw new Error(
        `Configured signing identity fingerprint does not match ${name}`,
      );
  }
  return {
    release,
    identity: pinned ?? name,
    identityValidation: !pinned,
    hardenedRuntime: true,
    fingerprint: pinned,
  };
}
