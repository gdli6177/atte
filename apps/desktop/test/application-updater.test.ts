import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationUpdater,
  type ApplicationUpdateEngine,
  type ApplicationUpdateEngineEvents,
  type ApplicationUpdateInfo,
  type ApplicationUpdateProgress,
} from "../electron/application-updater.js";

type Listener = (...args: any[]) => void;

class FakeEngine implements ApplicationUpdateEngine {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  disableDifferentialDownload = false;
  logger: ApplicationUpdateEngine["logger"] = null;
  downloadCalls = 0;
  checkCalls = 0;
  installed = false;
  info: ApplicationUpdateInfo = {
    version: "0.14.3",
    releaseDate: "2026-11-17T00:00:00.000Z",
    releaseNotes: "A focused update.",
  };
  private listeners = new Map<string, Set<Listener>>();

  on<E extends keyof ApplicationUpdateEngineEvents>(
    event: E,
    listener: ApplicationUpdateEngineEvents[E],
  ) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as Listener);
  }

  emit<E extends keyof ApplicationUpdateEngineEvents>(
    event: E,
    ...args: Parameters<ApplicationUpdateEngineEvents[E]>
  ) {
    for (const listener of this.listeners.get(event) ?? [])
      listener(...args);
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    this.emit("update-available", this.info);
    return { updateInfo: this.info };
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    return [];
  }

  quitAndInstall() {
    this.installed = true;
  }
}

test("an available update downloads in the background and installs only after the explicit action", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atte-updater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const notifications: string[] = [];
  const order: string[] = [];
  const updater = new ApplicationUpdater({
    enabled: true,
    currentVersion: "0.14.2",
    settingsPath: join(directory, "application-update.json"),
    engine,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
    onDownloaded: status => notifications.push(status.latestVersion ?? ""),
    beforeInstall: async () => { order.push("flush"); },
  });
  await updater.start();
  const checked = await updater.check();
  assert.equal(checked.latestVersion, "0.14.3");
  await waitFor(() => engine.downloadCalls === 1);
  engine.emit("download-progress", progress(42));
  assert.equal(updater.status().phase, "downloading");
  assert.equal(updater.status().progress?.percent, 42);

  engine.emit("update-downloaded", engine.info);
  engine.emit("update-downloaded", engine.info);
  await waitFor(() => notifications.length === 1);
  assert.equal(updater.status().phase, "downloaded");
  assert.equal(engine.installed, false);
  assert.deepEqual(order, []);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(notifications, ["0.14.3"]);
  const downloaded = updater.status();
  assert.equal(downloaded.canCheck, false);
  assert.equal(downloaded.canInstall, true);
  assert.deepEqual(await updater.check(), downloaded);
  assert.equal(engine.checkCalls, 1);

  const originalQuit = engine.quitAndInstall.bind(engine);
  engine.quitAndInstall = () => {
    order.push("install");
    originalQuit();
  };
  await updater.install();
  assert.deepEqual(order, ["flush", "install"]);
  assert.equal(engine.installed, true);
  updater.dispose();
});

test("background checks persist across restarts and disabled updates cannot install", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atte-updater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "application-update.json");
  const first = new ApplicationUpdater({
    enabled: true,
    currentVersion: "0.14.2",
    settingsPath,
    engine: new FakeEngine(),
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  await first.start();
  await first.setBackgroundChecks(false);
  first.dispose();
  const stored = JSON.parse(await readFile(settingsPath, "utf8")) as {
    backgroundChecks?: boolean;
  };
  assert.equal(stored.backgroundChecks, false);

  const second = new ApplicationUpdater({
    enabled: true,
    currentVersion: "0.14.2",
    settingsPath,
    engine: new FakeEngine(),
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  await second.start();
  assert.equal(second.status().backgroundChecks, false);
  second.dispose();

  const disabled = new ApplicationUpdater({
    enabled: false,
    currentVersion: "0.14.2",
    settingsPath: join(directory, "disabled.json"),
  });
  await disabled.start();
  assert.equal((await disabled.check()).phase, "disabled");
  await assert.rejects(() => disabled.install(), /未启用应用更新/);
  disabled.dispose();
});

test("pausing during shutdown stops new checks and background timers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atte-updater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine();
  let scheduled = false;
  const updater = new ApplicationUpdater({
    enabled: true,
    currentVersion: "0.14.2",
    settingsPath: join(directory, "application-update.json"),
    engine,
    setTimer: () => {
      scheduled = true;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  await updater.start();
  assert.equal(scheduled, true);
  updater.pause();
  await updater.check();
  assert.equal(engine.checkCalls, 0);
  updater.dispose();
});

function progress(percent: number): ApplicationUpdateProgress {
  return {
    percent,
    transferred: percent * 10,
    total: 1_000,
    bytesPerSecond: 100,
  };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
