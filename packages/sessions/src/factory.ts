import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SessionBackendId, WorkspaceState } from "../../core/src/index.js";
import { HerdrAdapter } from "./herdr/adapter.js";
import { SessionError } from "./contracts.js";
import type { BackendControlV1 } from "./control/types.js";
import { environmentValue } from "../../core/src/index.js";
export function workspaceSessionName(root: string, environment = process.env, state?: WorkspaceState) {
  const configured = environmentValue(environment, "HERDR_SESSION")?.trim();
  if (configured) return configured;
  if (state) {
    const goals = state.goals.filter(goal => !["completed", "dropped"].includes(goal.status));
    const scenes = [state.concierge.scene, ...goals.flatMap(goal => [
      goal.scene, goal.agentRuntime?.attempt.scene,
    ])];
    const current = scenes.find(scene => scene?.backend === "herdr");
    if (current?.locator.kind === "herdr") return current.locator.session;
    const legacy = [state.concierge.legacyScene?.reference.session, state.concierge.session,
      ...goals.flatMap(goal => [goal.legacyScene?.reference.session, goal.herdr?.session,
        goal.agentRuntime?.attempt.legacyScene?.reference.session])].find(session => session?.trim());
    if (legacy) return legacy;
  }
  return `atte-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
}
export function localAdapter(input: {
  backend: SessionBackendId;
  workspace: string;
  control: BackendControlV1;
  directory: string;
  herdrExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  state?: WorkspaceState;
}) {
  if (input.backend !== "herdr")
    throw new SessionError("backend_unsupported", "仅支持 Herdr；旧后端现场保留为只读历史。");
  const environment = input.environment ?? process.env;
  const directory = join(input.directory, "adapters", "herdr");
  const testZdotdir = environmentValue(environment, "TEST_ZDOTDIR");
  return new HerdrAdapter({
    directory, executable: input.herdrExecutable ?? environmentValue(environment, "HERDR_BINARY") ?? "herdr",
    session: workspaceSessionName(input.workspace, environment, input.state), environment,
    ...(testZdotdir ? { shellEnvironment: { ZDOTDIR: testZdotdir } } : {}),
  });
}
