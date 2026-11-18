/** Session identities are facts recorded by an adapter, never UI titles. */
export type SessionBackendId = "herdr" | "orca";
export interface LocalProcessIdentity {
  pid: number;
  /** OS process start time, to distinguish PID reuse. */
  bornAt: string;
}
export type ProcessProbe =
  | { status: "matched"; identity: LocalProcessIdentity; processGroupId?: number }
  | { status: "absent"; detail?: string }
  | { status: "unverifiable"; detail?: string };
/** Stable process evidence captured before a managed Agent receives its first task. */
export interface SceneOwnershipV1 {
  version: 1;
  samples: 2;
  capturedAt: string;
  shell: LocalProcessIdentity;
  launcher: LocalProcessIdentity;
  foreground: LocalProcessIdentity;
  processGroupId: number;
  tty?: string;
}
interface SceneIdentity {
  version: 1;
  installationId: string;
  runtimeId: string;
  runtimeGeneration: string;
  bindingId: string;
  attemptId: string;
  backendEpoch: number;
  process?: LocalProcessIdentity;
  ownership?: SceneOwnershipV1;
}
export type SceneReferenceV1 = SceneIdentity & (
  | {
      backend: "herdr";
      locator: {
        kind: "herdr";
        session: string;
        workspaceId: string;
        tabId: string;
        paneId: string;
        agent?: string;
        transport?: "pane";
        processId?: number;
        launchPolicy?: "control-plane-v1";
      };
    }
  | {
      backend: "orca";
      locator: {
        kind: "orca";
        repoId: string;
        worktreeId: string;
        terminalHandle: string;
        executionHostId: string;
        incarnationId: string;
      };
    }
);
export interface LegacySceneV0 {
  version: 0;
  backend: "herdr";
  verification: "unverified";
  reference: {
    session: string;
    workspaceId?: string;
    tabId?: string;
    paneId?: string;
    agent?: string;
    transport?: "pane";
    processId?: number;
    launchPolicy?: "control-plane-v1";
  };
}
export interface BackendBinding {
  installationId: string;
  backend: SessionBackendId;
  epoch: number;
  scopeGeneration: string;
  /** Old managed tokens are revoked before closing their scenes. */
  status: "active" | "revoked" | "resuming";
  operationId?: string;
}
export interface BackendHandoff {
  operationId: string;
  checkpointRevision: number;
  checkpointActivityId?: string;
  sourceScene?: SceneReferenceV1;
  sourceAttemptId?: string;
  lastSemanticWriteAt?: string;
  originalDelivery?: "pending" | "sent" | "unconfirmed" | "failed";
  method: "case-rehydrate" | "native-resume" | "deferred";
  status: "prepared" | "stopped" | "pending" | "accepted" | "unconfirmed" | "failed" | "skipped";
  receiptId?: string;
  detail?: string;
}
export interface ManagedSessionContext {
  installationId: string;
  backend: SessionBackendId;
  epoch: number;
  scopeGeneration: string;
  role: "concierge" | "owner" | "verifier";
  goalId?: string;
  attemptId?: string;
}
export interface SceneLaunchIntent {
  requestId: string;
  bindingId: string;
  attemptId: string;
  backendEpoch: number;
  role: "concierge" | "owner" | "verifier";
  agent: string;
  createdAt: string;
  status: "prepared" | "created" | "unconfirmed" | "rejected";
  detail?: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown, limit = 240): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= limit && !/[\0\r\n]/.test(value);
}
function processIdentity(value: unknown): value is LocalProcessIdentity {
  return object(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    identifier(value.bornAt, 100);
}
export function isSceneOwnership(value: unknown): value is SceneOwnershipV1 {
  return object(value) && value.version === 1 && value.samples === 2 &&
    identifier(value.capturedAt) && Number.isSafeInteger(value.processGroupId) &&
    (value.processGroupId as number) > 0 && processIdentity(value.shell) &&
    processIdentity(value.launcher) && processIdentity(value.foreground) &&
    (value.tty === undefined || identifier(value.tty));
}
export function isSceneReference(value: unknown): value is SceneReferenceV1 {
  if (!object(value) || value.version !== 1 ||
    !identifier(value.installationId) || !identifier(value.runtimeId) ||
    !identifier(value.runtimeGeneration) || !identifier(value.bindingId) ||
    !identifier(value.attemptId) || !Number.isSafeInteger(value.backendEpoch) ||
    (value.backendEpoch as number) < 0 || !object(value.locator)) return false;
  if (value.process !== undefined && !processIdentity(value.process)) return false;
  if (value.ownership !== undefined && !isSceneOwnership(value.ownership)) return false;
  const loc = value.locator;
  if (value.backend === "herdr" && loc.kind === "herdr")
    return ["session", "workspaceId", "tabId", "paneId"].every(key => identifier(loc[key])) &&
      (loc.agent === undefined || identifier(loc.agent));
  if (value.backend === "orca" && loc.kind === "orca")
    return ["repoId", "worktreeId", "terminalHandle", "executionHostId", "incarnationId"]
      .every(key => identifier(loc[key], key === "worktreeId" ? 4_096 : 240));
  return false;
}
export function validatedScene(value: unknown): SceneReferenceV1 {
  if (!isSceneReference(value)) throw new Error("scene_identity_mismatch: 现场身份不完整或后端不匹配");
  return structuredClone(value);
}
export function sameScene(left?: SceneReferenceV1, right?: SceneReferenceV1) {
  if (!left || !right) return false;
  if (left.backend !== right.backend || left.installationId !== right.installationId ||
    left.runtimeId !== right.runtimeId || left.runtimeGeneration !== right.runtimeGeneration ||
    left.backendEpoch !== right.backendEpoch) return false;
  if (left.locator.kind === "orca" && right.locator.kind === "orca")
    return left.locator.terminalHandle === right.locator.terminalHandle &&
      left.locator.incarnationId === right.locator.incarnationId &&
      left.locator.executionHostId === right.locator.executionHostId;
  if (left.locator.kind === "herdr" && right.locator.kind === "herdr")
    return left.locator.session === right.locator.session &&
      left.locator.paneId === right.locator.paneId;
  return false;
}
