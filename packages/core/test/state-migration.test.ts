import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentAbsolutePath,
  importAttachmentBytes,
  migrateApplicationHome,
  prepareWorkspaceState,
  readEvents,
  validateGoalAttachments,
  WorkspaceService,
  type Goal,
  validateState,
} from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atte-state-migration-"));
  fixtures.push(root);
  return root;
}

test("workspace migration verifies a copy, preserves the original and rewrites stored paths", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const [attachment] = await importAttachmentBytes(root, [{
    name: "legacy.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64"),
  }]);
  const goal = await service.execute({
    type: "goal.intake", text: "保留旧工作区", attachments: [attachment!],
  }) as Goal;
  await writeFile(join(root, ".atte", "legacy-event.json"), `${JSON.stringify({
    id: "evt_legacy", type: "workspace_changed", path: ".crewvane/attachments/att_0123456789abcdef.png",
  })}\n`);
  const legacyState = JSON.parse((await readFile(join(root, ".atte", "state.json"), "utf8"))
    .replaceAll(".atte/attachments/", ".crewvane/attachments/"));
  legacyState.minimumCrewvane = "0.10.0";
  legacyState.legacyProtocol = { schema: "crewvane.bot.v1" };
  const before = `${JSON.stringify(legacyState, null, 2)}\n`;
  const eventsBefore = `${(await readFile(join(root, ".atte", "events.jsonl"), "utf8"))
    .replaceAll(".atte/attachments/", ".crewvane/attachments/")}${JSON.stringify({
    id: "evt_bot_legacy",
    type: "bot.request",
    schema: "crewvane.bot.v1",
    path: ".crewvane/attachments/att_0123456789abcdef.png",
  })}\n`;
  await rename(join(root, ".atte"), join(root, ".crewvane"));
  await writeFile(join(root, ".crewvane", "state.json"), before);
  await writeFile(join(root, ".crewvane", "events.jsonl"), eventsBefore);

  const migrated = await prepareWorkspaceState(root);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.fallback, false);
  assert.equal(await readFile(join(root, ".crewvane", "state.json"), "utf8"), before);
  assert.equal(JSON.parse(await readFile(join(root, ".atte", ".atte-migration.json"), "utf8")).verified, true);
  assert.match(await readFile(join(root, ".atte", "legacy-event.json"), "utf8"), /\.crewvane\/attachments\//);
  assert.equal(await readFile(join(root, ".atte", "events.jsonl"), "utf8"), eventsBefore);
  const migratedState = JSON.parse(await readFile(join(root, ".atte", "state.json"), "utf8"));
  assert.equal(migratedState.minimumAtte, "0.10.0");
  assert.equal(migratedState.minimumCrewvane, undefined);
  assert.equal(migratedState.legacyProtocol.schema, "atte.bot.v1");
  const events = await readEvents(root);
  assert.equal(events.at(-1)?.schema, "atte.bot.v1");
  assert.equal(goal.attachments?.[0]?.path.startsWith(".atte/attachments/"), true);
  const saved = (await service.read()).goals.find(item => item.id === goal.id)!;
  const resolved = await validateGoalAttachments(root, saved.attachments);
  assert.equal((await readFile(attachmentAbsolutePath(root, resolved[0]!))).length, attachment!.size);
  assert.equal((await readdir(root)).includes(".crewvane"), true);
  assert.equal((await prepareWorkspaceState(root)).migrated, false);
});

test("an unsafe legacy entry falls back without deleting any old data", async () => {
  const root = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane", "state.json"), "original\n");
  await writeFile(join(root, "outside.txt"), "do not follow\n");
  await symlink(join(root, "outside.txt"), join(root, ".crewvane", "linked.txt"));
  const result = await prepareWorkspaceState(root);
  assert.equal(result.fallback, true);
  assert.equal(result.directory, join(await realpath(root), ".crewvane"));
  assert.match(result.detail ?? "", /继续使用 \.crewvane/);
  assert.equal(await readFile(join(root, ".crewvane", "state.json"), "utf8"), "original\n");
  assert.equal(await readFile(join(root, ".crewvane", "linked.txt"), "utf8"), "do not follow\n");
  assert.equal((await readdir(root)).includes(".atte"), false);
});

test("an unusable current directory falls back to a safe legacy workspace", async () => {
  const root = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane", "state.json"), "legacy\n");
  await writeFile(join(root, "outside"), "outside\n");
  await symlink(join(root, "outside"), join(root, ".atte"));
  const result = await prepareWorkspaceState(root);
  assert.equal(result.fallback, true);
  assert.equal(result.directory, join(await realpath(root), ".crewvane"));
  assert.match(result.detail ?? "", /继续使用 \.crewvane/);
  assert.equal(await readFile(join(root, ".crewvane", "state.json"), "utf8"), "legacy\n");
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside\n");
});

test("fallback writes stay in the legacy workspace instead of following an invalid current path", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  await service.execute({
    type: "goal.create",
    input: { title: "旧工作区仍可写", projectId: "personal", mode: "concierge" },
  });
  await rename(join(root, ".atte"), join(root, ".crewvane"));
  await writeFile(join(root, "outside"), "outside\n");
  await symlink(join(root, "outside"), join(root, ".atte"));

  await service.execute({
    type: "goal.create",
    input: { title: "继续写入旧目录", projectId: "personal", mode: "concierge" },
  });
  assert.equal((await service.read()).goals.length, 2);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside\n");
  assert.equal(await readFile(join(root, ".crewvane", "sequence"), "utf8"), "2");
  assert.equal((await readdir(root)).includes(".atte"), true);
});

test("fallback state keeps legacy attachment paths readable and does not rewrite events", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.intake", text: "保留迁移失败时的附件",
  }) as Goal;
  const [attachment] = await importAttachmentBytes(root, [{
    name: "fallback.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64"),
  }]);
  const stateBefore = await service.read();
  stateBefore.goals.find(item => item.id === goal.id)!.attachments = [attachment!];
  const before = `${JSON.stringify(stateBefore, null, 2)}\n`.replaceAll(".atte/attachments/", ".crewvane/attachments/");
  await rename(join(root, ".atte"), join(root, ".crewvane"));
  await writeFile(join(root, ".crewvane/state.json"), before);
  await writeFile(join(root, "outside.txt"), "do not follow\n");
  await symlink(join(root, "outside.txt"), join(root, ".crewvane/linked.txt"));

  const fallback = await prepareWorkspaceState(root);
  assert.equal(fallback.fallback, true);
  const state = validateState(JSON.parse(before));
  assert.equal(state.goals[0]?.attachments?.[0]?.path.startsWith(".crewvane/attachments/"), true);
  const resolved = await validateGoalAttachments(root, state.goals[0]?.attachments);
  assert.equal(resolved[0]?.path, attachment?.path.replace(".atte/", ".crewvane/"));
  assert.equal((await readFile(attachmentAbsolutePath(root, resolved[0]!))).length, attachment?.size);
});

test("new attachments remain usable while migration falls back to the old directory", async () => {
  const root = await fixture();
  await mkdir(join(root, ".crewvane"));
  await writeFile(join(root, "outside"), "outside\n");
  await symlink(join(root, "outside"), join(root, ".atte"));
  const [attachment] = await importAttachmentBytes(root, [{
    name: "fallback.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64"),
  }]);
  assert.match(attachment!.path, /^\.crewvane\/attachments\//);
  assert.deepEqual(await validateGoalAttachments(root, [attachment!]), [attachment]);
  assert.equal((await readFile(attachmentAbsolutePath(root, attachment!))).length, attachment!.size);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside\n");
});

test("application data migration preserves existing new data and keeps a legacy fallback", async () => {
  const root = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane", "manifest"), "# atte-manifest\n");
  const result = await migrateApplicationHome(root);
  assert.equal(result.migrated, true);
  assert.equal(await readFile(join(root, ".atte", "manifest"), "utf8"), "# atte-manifest\n");
  await writeFile(join(root, ".atte", "new-data"), "keep\n");
  assert.equal((await migrateApplicationHome(root)).migrated, false);
  assert.equal(await readFile(join(root, ".atte", "new-data"), "utf8"), "keep\n");

  await mkdir(join(root, "Crewvane"), { recursive: true });
  await writeFile(join(root, "Crewvane", "workspaces.json"), "{}\n");
  await symlink(join(root, "Crewvane"), join(root, "Atte"));
  const fallback = await migrateApplicationHome(root, "Atte", "Crewvane");
  assert.equal(fallback.directory, join(await realpath(root), "Crewvane"));
  assert.equal(fallback.fallback, true);
  assert.match(fallback.detail ?? "", /继续使用 Crewvane/);
  assert.equal((await readFile(join(root, "Crewvane", "workspaces.json"), "utf8")), "{}\n");
});

test("application migration preserves installer symlinks without following them", async () => {
  const root = await fixture();
  await mkdir(join(root, "Crewvane", "v0.11.0"), { recursive: true });
  await writeFile(join(root, "Crewvane", "v0.11.0", "settings.json"), "{\"theme\":\"light\"}\n");
  await symlink("v0.11.0", join(root, "Crewvane", "current"));
  const result = await migrateApplicationHome(root, "Atte", "Crewvane");
  assert.equal(result.migrated, true);
  assert.equal(await readFile(join(root, "Atte", "current", "settings.json"), "utf8"), "{\"theme\":\"light\"}\n");
  const { readlink } = await import("node:fs/promises");
  assert.equal(await readlink(join(root, "Atte", "current")), "v0.11.0");
  assert.equal(await readlink(join(root, "Crewvane", "current")), "v0.11.0");
});
