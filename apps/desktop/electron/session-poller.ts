import type { SceneReferenceV1 } from "../../../packages/core/src/index.js";
import type { SceneObservation } from "../../../packages/sessions/src/index.js";

type HerdrScene = Extract<SceneReferenceV1, { backend: "herdr" }>;
interface Schedule {
  next: number;
  failures: number;
  pending?: Promise<GroupResult>;
}
interface PollGroup {
  scenes: HerdrScene[];
  positions: number[];
}
interface GroupResult {
  observations: SceneObservation[];
  positions: number[];
}

function isHerdrScene(scene: SceneReferenceV1): scene is HerdrScene {
  return scene.backend === "herdr" && scene.locator.kind === "herdr";
}

function groupKey(scene: HerdrScene) {
  return JSON.stringify([
    scene.backend,
    scene.runtimeId,
    scene.runtimeGeneration,
    scene.locator.session,
    scene.locator.workspaceId,
  ]);
}

function unavailable(scene: HerdrScene, observedAt: string, detail: string): SceneObservation {
  return {
    bindingId: scene.bindingId,
    identity: "unverifiable",
    reachable: false,
    state: "unknown",
    ownership: scene.ownership ? "uncertain" : "legacy",
    observedAt,
    source: "backend",
    detail,
  };
}

/** Budget only the routine compensation poll. Explicit focus and delivery
 * identity checks always query freshly through the SessionRuntime. */
export class SessionPoller {
  private readonly schedules = new Map<string, Schedule>();
  constructor(private readonly now = Date.now) {}

  async inspect(
    scenes: SceneReferenceV1[],
    read: (scenes: SceneReferenceV1[]) => Promise<SceneObservation[]>,
  ): Promise<SceneObservation[] | undefined> {
    if (!scenes.length) return;
    if (scenes.some(scene => !isHerdrScene(scene)))
      throw new Error("只轮询当前 Herdr 现场；旧后端现场保持只读，不得触碰。");

    const groups = new Map<string, PollGroup>();
    scenes.forEach((scene, position) => {
      if (!isHerdrScene(scene)) return;
      const key = groupKey(scene);
      let group = groups.get(key);
      if (!group) {
        group = { scenes: [], positions: [] };
        groups.set(key, group);
      }
      group.scenes.push(scene);
      group.positions.push(position);
    });

    const results = await Promise.all(
      [...groups].map(([key, group]) => this.inspectGroup(key, group, read)),
    );
    const batches = results.filter((result): result is GroupResult => result !== undefined);
    if (!batches.length) return;
    return batches
      .flatMap(batch => batch.observations.map((observation, index) => ({
        observation,
        position: batch.positions[index] ?? Number.MAX_SAFE_INTEGER,
      })))
      .sort((left, right) => left.position - right.position)
      .map(item => item.observation);
  }

  private inspectGroup(
    key: string,
    group: PollGroup,
    read: (scenes: SceneReferenceV1[]) => Promise<SceneObservation[]>,
  ): Promise<GroupResult> | undefined {
    let schedule = this.schedules.get(key);
    if (!schedule) {
      schedule = { next: 0, failures: 0 };
      this.schedules.set(key, schedule);
    }
    if (schedule.pending) return schedule.pending;
    if (this.now() < schedule.next) return;
    // Reserve this runtime/workspace group at admission, independent of goal count.
    schedule.next = this.now() + 10_000;
    const current = schedule;
    const markFailure = () => {
      const failedAt = this.now();
      current.failures++;
      current.next = failedAt + (current.failures === 1 ? 30_000 : 60_000);
      return failedAt;
    };
    const restrictedFailure = (): GroupResult => {
      const failedAt = markFailure();
      const observedAt = new Date(failedAt).toISOString();
      return {
        observations: group.scenes.map(scene => unavailable(scene, observedAt, "session_poll_failed")),
        positions: group.positions,
      };
    };
    const pending = (async (): Promise<GroupResult> => {
      try {
        const observations = await read(group.scenes);
        if (!observations.length || observations.every(item => item.identity !== "match")) {
          markFailure();
          return { observations, positions: group.positions };
        }
        current.failures = 0;
        current.next = this.now() + 10_000;
        return { observations, positions: group.positions };
      } catch {
        return restrictedFailure();
      }
    })().finally(() => { current.pending = undefined; });
    current.pending = pending;
    return pending;
  }

  reset() { this.schedules.clear(); }
}
