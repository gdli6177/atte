export const UPDATE_REPOSITORY = Object.freeze({
  provider: "github",
  owner: "gdli6177",
  repo: "atte",
});

export function appUpdateConfig() {
  return [
    `provider: ${UPDATE_REPOSITORY.provider}`,
    `owner: ${UPDATE_REPOSITORY.owner}`,
    `repo: ${UPDATE_REPOSITORY.repo}`,
    "releaseType: release",
    "updaterCacheDirName: atte-updater",
    "",
  ].join("\n");
}

export function latestMacYaml({
  version,
  fileName,
  sha512,
  size,
  releaseDate = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Invalid update version: ${version}`);
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(fileName))
    throw new Error(`Invalid update archive name: ${fileName}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sha512))
    throw new Error("Update SHA-512 must be base64 text");
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error(`Invalid update archive size: ${size}`);
  if (!Number.isFinite(Date.parse(releaseDate)))
    throw new Error(`Invalid release date: ${releaseDate}`);
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}
