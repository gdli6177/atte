import { execFile, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  environmentValue,
  type Goal,
  type SceneReferenceV1,
  type WorkspaceState,
} from "../../packages/core/src/index.js";
import {
  HerdrAdapter,
  SessionError,
  workspaceSessionName,
  type SceneObservation,
} from "../../packages/sessions/src/index.js";

export const DOCTOR_PROBE_TIMEOUT_MS = 1_500;

export type DoctorSceneStatus =
  | "reachable"
  | "identity_mismatch"
  | "unreachable"
  | "confirmed_exited"
  | "unverified";

export interface DoctorSceneCheck {
  goalId: string;
  title: string;
  backend: "herdr" | "orca";
  attemptId?: string;
  pid?: number;
  paneId?: string;
  checkedAt?: string;
  status: DoctorSceneStatus;
  lastObservedAt: string | null;
  stateSince: string | null;
  detail?: string;
  legacy: boolean;
  hints: string[];
}

type ObservationTiming = SceneObservation & {
  lastObservedAt?: string;
  stateSince?: string;
};

export interface DoctorSceneProbe {
  status: "ok" | "skipped" | "unreachable" | "unverified" | "timeout";
  checkedAt: string;
  timeoutMs: number;
  detail?: string;
  scenes: DoctorSceneCheck[];
  hints: string[];
}

interface Candidate {
  goal: Goal;
  scene?: SceneReferenceV1;
  legacy: boolean;
  detail?: string;
}

class DoctorProbeTimeout extends Error {
  constructor() {
    super("doctor probe timeout");
    this.name = "DoctorProbeTimeout";
  }
}

function boundedHerdrRunner(input: {
  executable: string;
  session: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  const children = new Set<ChildProcess>();
  let aborted = false;
  let timedOut = false;
  const stopChildren = () => {
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch { /* The child already exited. */ }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stopChildren();
  }, input.timeoutMs);
  timer.unref?.();
  const check = () => {
    if (aborted || timedOut || Date.now() >= deadline)
      throw new DoctorProbeTimeout();
  };
  const run = async (args: string[], requestedTimeout = 5_000): Promise<string> => {
    check();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      stopChildren();
      throw new DoctorProbeTimeout();
    }
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const child = execFile(input.executable, [
        "--session", input.session, ...args,
      ], {
        timeout: Math.max(1, Math.min(requestedTimeout, remaining)),
        killSignal: "SIGKILL",
        maxBuffer: 2_000_000,
        encoding: "utf8",
        env: { ...input.environment, HERDR_SESSION: input.session },
      }, (error, stdout) => {
        children.delete(child);
        if (settled) return;
        settled = true;
        if (aborted || timedOut || error?.killed) {
          timedOut = true;
          reject(new DoctorProbeTimeout());
        } else if (error) {
          reject(error);
        } else {
          resolve(String(stdout));
        }
      });
      children.add(child);
    });
  };
  return {
    run,
    timedOut: () => timedOut,
    close() {
      aborted = true;
      clearTimeout(timer);
      stopChildren();
    },
  };
}

function cachedStateSince(goal: Goal) {
  return goal.live?.stateSince ?? goal.live?.checkedAt ?? null;
}

function baseCheck(input: {
  goal: Goal;
  scene?: SceneReferenceV1;
  status: DoctorSceneStatus;
  detail?: string;
  legacy?: boolean;
  lastObservedAt?: string | null;
  stateSince?: string;
  hints?: string[];
}): DoctorSceneCheck {
  const scene = input.scene;
  return {
    goalId: input.goal.id,
    title: input.goal.title,
    backend: scene?.backend ?? "herdr",
    attemptId: scene?.attemptId,
    pid: scene?.process?.pid,
    paneId: scene?.locator.kind === "herdr" ? scene.locator.paneId : input.goal.herdr?.paneId,
    checkedAt: input.goal.live?.checkedAt,
    status: input.status,
    lastObservedAt: input.lastObservedAt ?? input.goal.live?.checkedAt ?? null,
    stateSince: input.stateSince ?? cachedStateSince(input.goal),
    ...(input.detail ? { detail: input.detail } : {}),
    legacy: input.legacy === true,
    hints: input.hints ?? [],
  };
}

function legacyHint() {
  return "旧 Orca/legacy 现场仅供读取；doctor 不会执行恢复、重绑、发送或关闭。";
}

function statusHints(status: DoctorSceneStatus, legacy = false): string[] {
  if (status === "reachable") return [];
  if (legacy || status === "unverified")
    return [
      "现场尚未得到可核实的归属证据。检查 Herdr 安装、Session 与进程权限后重试 atte doctor --json；现状保持不变。",
      legacy ? legacyHint() : "不要手工重建或重绑现场；先用 Atte 目标详情核对原负责人。",
    ];
  if (status === "identity_mismatch")
    return [
      "现场身份已变化。先在 Atte 目标详情核对原 Pane 与负责人，不要直接发送、重绑或重建。",
      "确认原负责人已退出后，再按人工恢复流程处理；doctor 不会自动修复。",
    ];
  if (status === "confirmed_exited")
    return [
      "原负责人已确认退出。请在 Atte 目标详情恢复负责人；doctor 不会自动重建或关闭现场。",
      "恢复前先核对目标仍需要继续，并保留现有交付与回执。",
    ];
  return [
    "Herdr Session 当前不可达。请在 Atte 中重新连接该工作区；doctor 不会启动 Herdr。",
    "不要通过手工创建同名 Session 或 Pane 来替代原现场。",
  ];
}

function observationCheck(
  goal: Goal,
  scene: SceneReferenceV1,
  observation: ObservationTiming,
  probeTimedOut: boolean,
): DoctorSceneCheck {
  const timing = {
    lastObservedAt: observation.lastObservedAt ?? observation.observedAt,
    ...(observation.stateSince ? { stateSince: observation.stateSince } : {}),
  };
  if (probeTimedOut) {
    return baseCheck({
      goal, scene, status: "unverified", detail: "probe_timeout",
      ...timing,
      hints: statusHints("unverified"),
    });
  }
  if (observation.identity === "mismatch") {
    return baseCheck({
      goal, scene, status: "identity_mismatch",
      detail: observation.detail ?? "scene_identity_mismatch",
      ...timing,
      hints: statusHints("identity_mismatch"),
    });
  }
  if (observation.identity === "unverifiable" ||
    observation.ownership === "legacy" ||
    observation.ownership === "uncertain") {
    return baseCheck({
      goal, scene, status: "unverified",
      detail: observation.detail ?? "scene_identity_unverifiable",
      ...timing,
      hints: statusHints("unverified", observation.ownership === "legacy"),
    });
  }
  if (observation.state === "exited") {
    return baseCheck({
      goal, scene, status: "confirmed_exited",
      detail: observation.detail ?? "confirmed_scene_exit",
      ...timing,
      hints: statusHints("confirmed_exited"),
    });
  }
  if (!observation.reachable) {
    return baseCheck({
      goal, scene, status: "unreachable",
      detail: observation.detail ?? "scene_unreachable",
      ...timing,
      hints: statusHints("unreachable"),
    });
  }
  return baseCheck({
    goal, scene, status: "reachable",
    detail: observation.detail,
    ...timing,
  });
}

function candidates(state: WorkspaceState): Candidate[] {
  return state.goals.flatMap((goal): Candidate[] => {
    const scene = goal.scene;
    if (!scene && !goal.legacyScene && !goal.herdr) return [];
    if (scene?.backend === "orca" || goal.readOnly === true || goal.readOnlyReason === "legacy-orca")
      return [{ goal, scene, legacy: true, detail: "legacy_read_only" }];
    if (!scene)
      return [{ goal, legacy: true, detail: "legacy_scene_unverified" }];
    if (!scene.ownership)
      return [{ goal, scene, legacy: true, detail: "legacy_without_stable_ownership" }];
    return [{ goal, scene, legacy: false }];
  });
}

function probeFailure(error: unknown, timedOut: boolean) {
  if (timedOut || error instanceof DoctorProbeTimeout)
    return { status: "timeout" as const, detail: "probe_timeout" };
  if (error instanceof SessionError) {
    if (error.code === "backend_unreachable")
      return { status: "unreachable" as const, detail: "herdr_session_unreachable" };
    if (error.code === "backend_incompatible")
      return { status: "unverified" as const, detail: "herdr_incompatible" };
    if (error.code === "backend_missing")
      return { status: "unverified" as const, detail: "herdr_missing" };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return { status: "unverified" as const, detail: "herdr_missing" };
  return { status: "unverified" as const, detail: "probe_failed" };
}

function uniqueHints(values: string[]) {
  return [...new Set(values)].slice(0, 8);
}

export async function probeDoctorScenes(input: {
  workspace: string;
  state: WorkspaceState;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<DoctorSceneProbe> {
  const environment = input.environment ?? process.env;
  const timeoutMs = Math.max(100, input.timeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const all = candidates(input.state);
  const binding = input.state.backendBinding;
  let status: DoctorSceneProbe["status"] = "skipped";
  let detail: string | undefined;
  const checks = all.map(candidate => candidate.legacy
    ? baseCheck({
        goal: candidate.goal, scene: candidate.scene, status: "unverified",
        detail: candidate.detail, legacy: true,
        hints: statusHints("unverified", true),
      })
    : baseCheck({ goal: candidate.goal, scene: candidate.scene, status: "unverified" }));
  const globalHints: string[] = [];

  if (!binding)
    globalHints.push("工作区还没有活动的 Herdr 后端绑定；先在 Atte 中连接 Herdr。doctor 不会注册或启动后端。");
  else if (binding.backend !== "herdr")
    globalHints.push("工作区绑定的是旧后端；doctor 只保留只读历史，不会切换或恢复后端。");
  else if (binding.status !== "active")
    globalHints.push("当前 Herdr 后端绑定未激活；doctor 不会自动恢复控制面。");
  if (all.some(candidate => candidate.legacy))
    globalHints.push(legacyHint());

  if (!binding || binding.backend !== "herdr" || binding.status !== "active") {
    const backendDetail = !binding ? "workspace_backend_missing" :
      binding.backend !== "herdr" ? "workspace_backend_unsupported" : "workspace_backend_inactive";
    for (let index = 0; index < all.length; index++) {
      const candidate = all[index]!;
      if (candidate.legacy) continue;
      checks[index] = baseCheck({
        goal: candidate.goal, scene: candidate.scene, status: "unverified",
        detail: backendDetail, hints: statusHints("unverified"),
      });
    }
    return {
      status: "unverified", checkedAt, timeoutMs,
      detail: backendDetail,
      scenes: checks, hints: uniqueHints([...globalHints, ...checks.flatMap(item => item.hints)]),
    };
  }

  const runnable: number[] = [];
  for (let index = 0; index < all.length; index++) {
    const candidate = all[index]!;
    if (candidate.legacy) continue;
    const scene = candidate.scene!;
    if (scene.installationId !== binding.installationId || scene.backendEpoch !== binding.epoch) {
      checks[index] = baseCheck({
        goal: candidate.goal, scene, status: "identity_mismatch",
        detail: "scene_control_epoch_mismatch", hints: statusHints("identity_mismatch"),
      });
      continue;
    }
    runnable.push(index);
  }
  if (!runnable.length)
    return { status: "skipped", checkedAt, timeoutMs, scenes: checks,
      hints: uniqueHints([...globalHints, ...checks.flatMap(item => item.hints)]) };

  const executable = environmentValue(environment, "HERDR_BINARY")?.trim() || "herdr";
  const session = workspaceSessionName(input.workspace, environment, input.state);
  const runner = boundedHerdrRunner({ executable, session, environment, timeoutMs });
  const scenes = runnable.map(index => all[index]!.scene!);
  const adapter = new HerdrAdapter({
    executable,
    session,
    directory: join(tmpdir(), "atte-doctor-probe"),
    environment,
    run: runner.run,
    ownershipSampleDelayMs: 10,
  });
  const probe = (async () => {
    await adapter.connect({
      installationId: binding.installationId,
      cwd: input.workspace,
      startIfMissing: false,
    });
    return await adapter.inspectMany(scenes);
  })();
  let fallback: NodeJS.Timeout | undefined;
  try {
    const observations = await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        fallback = setTimeout(() => {
          runner.close();
          reject(new DoctorProbeTimeout());
        }, timeoutMs + 100);
        fallback.unref?.();
      }),
    ]);
    const timedOut = runner.timedOut();
    for (let index = 0; index < runnable.length; index++) {
      checks[runnable[index]!] = observationCheck(
        all[runnable[index]!]!.goal,
        scenes[index]!,
        observations[index]!,
        timedOut,
      );
    }
    const runnableChecks = runnable.map(index => checks[index]!);
    status = timedOut ? "timeout" :
      runnableChecks.every(check => check.status === "unverified") ? "unverified" : "ok";
    detail = timedOut ? "probe_timeout" :
      status === "unverified" ? runnableChecks[0]?.detail ?? "scene_probe_failed" : undefined;
  } catch (error) {
    const failure = probeFailure(error, runner.timedOut());
    status = failure.status;
    detail = failure.detail;
    for (const index of runnable) {
      const candidate = all[index]!;
      const sceneStatus = failure.status === "unreachable"
        ? "unreachable" as const : "unverified" as const;
      checks[index] = baseCheck({
        goal: candidate.goal, scene: candidate.scene, status: sceneStatus,
        detail: failure.detail, hints: statusHints(sceneStatus),
      });
    }
  } finally {
    if (fallback) clearTimeout(fallback);
    runner.close();
  }

  if (status === "timeout")
    globalHints.push("Herdr 探测超时，已终止探测进程并保持现场原状；稍后重试 atte doctor --json。");
  else if (status === "unreachable")
    globalHints.push("Herdr Session 当前不可达；doctor 不会启动 Herdr 或重建现场。");
  else if (status === "unverified" && detail === "herdr_missing")
    globalHints.push("找不到 Herdr 可执行文件；请确认 Herdr 已安装，doctor 不会自动安装或启动。");
  else if (status === "unverified")
    globalHints.push("Herdr 只读探测失败；现场状态未改变，请检查配置后重试。");

  return {
    status,
    checkedAt: new Date().toISOString(),
    timeoutMs,
    ...(detail ? { detail } : {}),
    scenes: checks,
    hints: uniqueHints([...globalHints, ...checks.flatMap(item => item.hints)]),
  };
}
