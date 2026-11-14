import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtteSkillInstaller } from "../electron/skill-installer.ts";

test("installs only detected agent targets and never overwrites an unrelated skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-skill-installer-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(join(source, "references"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".claude", "skills", "atte"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Atte\n");
    await writeFile(join(source, "references", "cli-protocol.md"), "# Protocol\n");
    await writeFile(join(home, ".claude", "skills", "atte", "SKILL.md"), "# User skill\n");

    const installer = new AtteSkillInstaller(source, home, "0.6.0");
    let status = await installer.status();
    assert.deepEqual(status.targets.map(target => [target.id, target.phase]), [
      ["agents", "not-installed"],
      ["codex", "not-installed"],
      ["claude", "conflict"],
    ]);

    const result = await installer.install();
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.id, "claude");
    status = result.status;
    assert.equal(status.installed, 2);
    assert.equal(
      await readFile(join(home, ".agents", "skills", "atte", "references", "cli-protocol.md"), "utf8"),
      "# Protocol\n",
    );
    assert.equal(
      await readFile(join(home, ".claude", "skills", "atte", "SKILL.md"), "utf8"),
      "# User skill\n",
    );
    assert.equal(
      JSON.parse(await readFile(join(home, ".codex", "skills", "atte", ".atte-managed.json"), "utf8")).version,
      "0.6.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates a Atte-managed skill in place and skips undetected agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-skill-update-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(source, { recursive: true });
    await mkdir(join(home, ".codex", "skills", "atte"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# New skill\n");
    await writeFile(join(home, ".codex", "skills", "atte", "SKILL.md"), "# Old skill\n");
    await writeFile(
      join(home, ".codex", "skills", "atte", ".atte-managed.json"),
      JSON.stringify({ managedBy: "atte", version: "0.5.1" }),
    );

    const installer = new AtteSkillInstaller(source, home, "0.6.0");
    let status = await installer.status();
    const codex = status.targets.find(target => target.id === "codex");
    assert.equal(codex?.phase, "outdated");
    assert.equal(status.targets.some(target => target.id === "claude"), false);

    const result = await installer.install();
    status = result.status;
    assert.equal(result.errors.length, 0);
    assert.equal(status.targets.find(target => target.id === "codex")?.phase, "installed");
    assert.equal(
      await readFile(join(home, ".codex", "skills", "atte", "SKILL.md"), "utf8"),
      "# New skill\n",
    );
    assert.equal(
      JSON.parse(await readFile(join(home, ".codex", "skills", "atte", ".atte-managed.json"), "utf8")).version,
      "0.6.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moves a verified legacy managed skill to the Atte name without touching unrelated skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-skill-rename-"));
  try {
    const source = join(root, "source"), home = join(root, "home"),
      legacy = join(home, ".codex", "skills", "crewvane");
    await mkdir(source, { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# New skill\n");
    await writeFile(join(legacy, "SKILL.md"), "# Old skill\n");
    await writeFile(join(legacy, ".crewvane-managed.json"), JSON.stringify({
      managedBy: "crewvane", version: "0.10.0", sourceDigest: "legacy-content",
    }));
    const installer = new AtteSkillInstaller(source, home, "0.11.0");
    const result = await installer.install();
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(join(home, ".codex", "skills", "atte", "SKILL.md"), "utf8"), "# New skill\n");
    await assert.rejects(readFile(join(legacy, "SKILL.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install status remains readable before the skills folder exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-skill-status-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(source, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Atte\n");
    const installer = new AtteSkillInstaller(source, home, "0.6.0");
    const status = await installer.status();
    assert.equal(status.targets[0]?.phase, "not-installed");
    await assert.rejects(access(join(home, ".agents", "skills", "atte")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol changes update managed skills even when the app version is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-skill-protocol-"));
  try {
    const source = join(root, "source"), home = join(root, "home");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Atte\n");
    await writeFile(join(source, "references/cli-protocol.md"), "# Previous protocol\n");
    const installer = new AtteSkillInstaller(source, home, "0.6.4");
    await installer.install();
    assert.equal((await installer.status()).targets[0]!.phase, "installed");
    await writeFile(join(source, "references/cli-protocol.md"), "# Scene receipts\n");
    assert.equal((await installer.status()).targets[0]!.phase, "outdated");
    await installer.install();
    assert.match(await readFile(join(home, ".agents/skills/atte/references/cli-protocol.md"), "utf8"), /Scene receipts/);
    assert.equal((await installer.status()).targets[0]!.phase, "installed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installs the local pack author beside the main skill on every detected Agent target", async () => {
  const root = await mkdtemp(join(tmpdir(), "atte-multi-skill-"));
  try {
    const source = join(root, "skills"),
      home = join(root, "home");
    await mkdir(join(source, "atte", "references"), { recursive: true });
    await mkdir(join(source, "atte-local-pack-author", "references"), {
      recursive: true,
    });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(source, "atte", "SKILL.md"), "# Atte\n");
    await writeFile(
      join(source, "atte", "references", "cli-protocol.md"),
      "# Protocol\n",
    );
    await writeFile(
      join(source, "atte-local-pack-author", "SKILL.md"),
      "# Local pack author\n",
    );
    await writeFile(
      join(source, "atte-local-pack-author", "references", "manifest.md"),
      "# Manifest\n",
    );

    const installer = new AtteSkillInstaller(
      source,
      home,
      "0.10.0",
      ["atte", "atte-local-pack-author"],
    );
    const first = await installer.install();
    assert.equal(first.errors.length, 0);
    assert.equal(first.status.installed, first.status.available);
    assert.equal(
      await readFile(
        join(home, ".codex", "skills", "atte-local-pack-author", "SKILL.md"),
        "utf8",
      ),
      "# Local pack author\n",
    );

    await writeFile(
      join(source, "atte-local-pack-author", "references", "manifest.md"),
      "# Manifest v2\n",
    );
    const target = (await installer.status()).targets.find(item =>
      item.id === "codex");
    assert.equal(target?.phase, "outdated");
    await installer.install();
    assert.match(
      await readFile(
        join(
          home,
          ".codex",
          "skills",
          "atte-local-pack-author",
          "references",
          "manifest.md",
        ),
        "utf8",
      ),
      /Manifest v2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
