import type { LocalProcessIdentity } from "../../../core/src/index.js";

export interface BackendControlV1 {
  version: 1;
  installationId: string;
  selected: "herdr";
  epoch: number;
  scopeGeneration: string;
  phase: "ready";
}
export interface WorkspaceRegistration {
  root: string;
  registeredAt: string;
}
export interface OperationLease {
  id: string;
  requestId: string;
  workspace: string;
  backend: "herdr";
  epoch: number;
  kind: "create" | "send" | "close" | "bind";
  bindingId?: string;
  goalId?: string;
  role?: "concierge" | "owner";
  owner: LocalProcessIdentity;
  startedAt: string;
  expiresAt: string;
  status: "running" | "finished" | "unknown";
}
