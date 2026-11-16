import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type {
  HerdrReference,
  LivePresence,
  AgentPreferences,
  Goal,
  OwnerResume,
} from "../../../packages/core/src/types.js";
import type { WatchdogRequest } from "../../../packages/core/src/watchdog.js";
import { attachmentAbsolutePath } from "../../../packages/core/src/attachments.js";
import { attentionRequest } from "../../../packages/core/src/model.js";
import {
  renderAgentCommand,
  renderLoginShellAgentCommand,
} from "../../../packages/core/src/agent-command.js";
import { builtinAgentInstructions } from "../../../packages/core/src/builtin-instructions.js";
import { workspaceDataDirectory } from "../../../packages/core/src/compatibility.js";
import { ownerSceneReplyInstructions } from "../../../cli/src/owner-instructions.js";
import { startDetachedHerdrServer } from "../../../packages/sessions/src/herdr/server.js";
const exec = promisify(execFile);
export const CONCIERGE_LAUNCH_POLICY = "control-plane-v1" as const;
export interface HerdrRunner {
  run(args: string[], timeout?: number): Promise<string>;
}
export interface ConciergeSite {
  reference: HerdrReference;
  live: LivePresence;
}
export class ConciergeBlockedError extends Error {
  constructor() {
    super("管家正在等待交互输入。请打开管家现场，完成或关闭当前提示后再重试。");
    this.name = "ConciergeBlockedError";
  }
}
export const herdrRunner = (
  executable: string,
  session = "atte",
): HerdrRunner => ({
  async run(args, timeout = 30_000) {
    try {
      const result = await exec(executable, args, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HERDR_SESSION: session },
      });
      return result.stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      let detail = stderr.trim();
      try {
        const data = JSON.parse(stderr);
        detail = JSON.stringify(data.error ?? data);
      } catch {
        /* keep stderr */
      }
      throw new Error(
        `Herdr ${args.slice(0, 2).join(" ")}：${detail || (error as Error).message}`,
      );
    }
  },
});

export { startDetachedHerdrServer };
function payload(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Herdr 返回了无法读取的结果：${raw.slice(0, 300)}`);
  }
}
function named(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
export const quoteShell = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;
// Unknown CLIs can use canonical TTY input (macOS MAX_CANON is 1024 bytes).
// Keep each line below the limit without breaking a Unicode code point.
export function terminalPrompt(text: string) {
  return text.split("\n").map(line => {
    const lines: string[] = [];
    let current = "", bytes = 0;
    for (const character of line) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 768) { lines.push(current); current = ""; bytes = 0; }
      current += character; bytes += length;
    }
    return [...lines, current].join("\n");
  }).join("\n");
}
function receiptMarker(text: string) {
  const marker = text.match(/\[ATTE_RECEIPT:[0-9a-f]{24}\]/)?.[0];
  if (!marker)
    throw new Error("回执提醒缺少唯一标记，未发送到负责人现场");
  if (text.includes("\n"))
    throw new Error("回执提醒必须是单个逻辑行，未发送到负责人现场");
  return marker;
}
function agents(raw: string): any[] {
  const data = payload(raw),
    list = data.result?.agents ?? data.agents ?? data;
  if (!Array.isArray(list)) throw new Error("Herdr 没有返回 Agent 列表");
  return list;
}
function liveState(agent: any): LivePresence["state"] {
  const reported =
    agent?.agent_status ?? agent?.state ?? agent?.status ?? agent?.lifecycle;
  const title = String(agent?.terminal_title_stripped ?? agent?.terminal_title ?? "");
  // Some interactive CLIs keep agent_status=idle while a tool call is still
  // running and expose progress only through a spinner in the terminal title.
  // Treat a running title animation as working until the title settles.
  if (reported === "idle" && /[\u2800-\u28ff]/u.test(title)) return "working";
  return ["working", "idle", "done", "blocked", "unknown"].includes(reported)
    ? reported
    : "unknown";
}
function livePresence(agent: any, checkedAt: string): LivePresence {
  return {
    state: liveState(agent),
    checkedAt,
    reachable: true,
  };
}
const staticConciergeRole = `${builtinAgentInstructions(undefined, "concierge")}
你是当前工作区的控制面管家，不亲自执行目标；简单任务也交给独立负责人。把目标整理成清晰下一步后，交给本目标独立负责人，退回修改转交原负责人，交付齐备则向人交接。
首次创建负责人必须使用 atte owner launch <目标ID> --name <负责人名称> --json；已有负责人使用 atte owner send <目标ID> --text "<完整任务>" --json。owner launch 已发送首次任务；返回 agent_prompt_stalled 或未知投递时先核对原现场，禁止未经核对就重复发送或重建负责人。命令行单次输入通常只有约 1 KB；长说明先写入工作区内文件再传任务文件。不要手工串联 Herdr tab、pane 或 agent 命令。
在 Herdr 中，用户直接发给你的、且不带案卷标记的消息也是用户输入，必须先用 atte direct 保存原话，不得只在终端处理；图片附件用 --attachment 保存真实本地文件。每回合只处理一个案卷，完成分发或记账后立即结束，不轮询、不等待负责人完成整项工程。`;
function staticIdentityInstructions(root: string) {
  return `这是 Atte 管家的身份初始化，不是案卷任务。工作区：${root}
你是本工作区唯一的控制面管家，只负责分发、协调和向人交接，不亲自执行业务目标。
没有当前案卷，禁止读取或修改目标、创建负责人或执行工作。保留用户配置的 CLI 和模型。
回复 ATTE_CONCIERGE_READY，然后立即结束回合。`;
}
export class HerdrClient {
  constructor(
    readonly runner: HerdrRunner,
    readonly session = "atte",
    readonly workspaceRoot = "",
    readonly startSession?: () => Promise<void>,
  ) {}
  private async foreground(paneId: string) {
    const data = payload(await this.runner.run(["pane", "process-info", "--pane", paneId]));
    const info = data.result?.process_info ?? data.process_info;
    if (!info || !Array.isArray(info.foreground_processes)) throw new Error("无法核实自定义 CLI 的前台进程");
    return info.foreground_processes.filter((process: any) => process.pid !== info.shell_pid) as { pid: number }[];
  }
  private async rawAlive(reference: HerdrReference) {
    return !!reference.paneId && !!reference.processId &&
      (await this.foreground(reference.paneId)).some(process => process.pid === reference.processId);
  }
  private async prompt(reference: HerdrReference, text: string, waitForSettlement = true, timeout?: number) {
    if (reference.transport === "pane") {
      // A custom launcher can still start an Agent that Herdr auto-detects in
      // the Pane. Once that happens, prefer Herdr's lifecycle-aware prompt
      // target so serial work cannot be pasted into the composer while the
      // previous turn is still running. The Pane ID remains stable even when
      // Herdr names the detected Agent differently from our governed role.
      const running = await this.foreground(reference.paneId!);
      const discovered = agents(await this.runner.run(["agent", "list"]))
        .find(agent => agent.pane_id === reference.paneId);
      const exactProcess = !!reference.processId &&
        running.some(process => process.pid === reference.processId);
      if (discovered?.pane_id && running[0] &&
        (exactProcess || reference.launchPolicy === CONCIERGE_LAUNCH_POLICY))
        return this.promptManagedAgent(
          discovered.pane_id,
          text,
          waitForSettlement,
          timeout,
        );
      if (!running.length || (reference.processId && !exactProcess))
        throw new Error("自定义 Agent 已退出或现场已更换，未发送任务。请重新准备管家。");
      // pane run submits literal text + Enter atomically (including bracketed
      // paste handling). Never fall back to sending a task to an idle shell.
      await this.runner.run(["pane", "run", reference.paneId!, terminalPrompt(text)]);
      // An arbitrary CLI has no trustworthy lifecycle signal. Give its
      // terminal input loop a short turn before the next case is queued.
      await delay(750);
      return { status: "sent" as const };
    } else {
      if (!reference.agent) throw new Error("管家尚未准备好");
      return this.promptManagedAgent(
        reference.agent,
        text,
        waitForSettlement,
        timeout,
      );
    }
  }
  private async promptManagedAgent(
    target: string,
    text: string,
    waitForSettlement = true,
    timeout?: number,
  ) {
    try {
      await this.runner.run([
        "agent", "prompt", target, text,
        ...(waitForSettlement ? ["--wait"] : []),
        ...(timeout ? ["--timeout", String(timeout)] : []),
      ], timeout ? timeout + 5000 : waitForSettlement ? 0 : undefined);
    } catch (error) {
      if (/\bagent_blocked\b/.test(String(error)))
        throw new ConciergeBlockedError();
      // Herdr can submit the prompt before its lifecycle probe observes the
      // agent transition. Timeout and stalled responses do not prove that the
      // prompt was rejected, so replaying them can duplicate work. Save an
      // unconfirmed delivery fact and let scene events plus the watchdog
      // decide whether recovery is needed.
      if (/\bagent_prompt_stalled\b/.test(String(error)) ||
        /\btimed out waiting for agent status\b/.test(String(error)) ||
        /"code"\s*:\s*"timeout"/.test(String(error))) {
        await delay(750);
        return {
          status: "unconfirmed" as const,
          detail: /\bagent_prompt_stalled\b/.test(String(error))
            ? "Herdr 已接收任务，但未及时观察到工作状态；先以现场为准，不重复发送。"
            : "Herdr 已提交任务，但状态确认超时；先以现场为准，不重复发送。",
        };
      }
      throw error;
    }
    return { status: "sent" as const };
  }
  private async labelDetectedAgent(paneId: string, name: string) {
    try {
      const detected = agents(await this.runner.run(["agent", "list"]))
        .find(agent => agent.pane_id === paneId);
      if (detected && detected.name !== name)
        await this.runner.run(["agent", "rename", paneId, name]);
    } catch {
      // Unrecognized CLIs intentionally remain Pane-tracked. A supported CLI
      // that Herdr detects gets a stable governed name when rename is available.
    }
  }
  async inspectConcierge(existing?: HerdrReference): Promise<ConciergeSite | undefined> {
    await this.ensureSession();
    const checkedAt = new Date().toISOString();
    const sameSession = existing?.session === this.session;
    if (sameSession && existing.transport === "pane" &&
      existing.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      try {
        const running = await this.foreground(existing.paneId!).catch(() => []);
        const live = agents(await this.runner.run(["agent", "list"]))
          .find(agent => agent.pane_id === existing.paneId);
        if (existing.processId && running.some(process => process.pid === existing.processId)) {
          return {
            reference: existing,
            live: live
              ? livePresence(live, checkedAt)
              : { state: "unknown", checkedAt, reachable: true },
          };
        }
        // A custom launcher may re-exec into a different PID after Herdr
        // auto-detects the Agent. The governed Pane and detected Agent are
        // stronger identity than the startup PID in that case.
        if (live && running[0]) {
          return {
            reference: { ...existing, processId: running[0].pid },
            live: livePresence(live, checkedAt),
          };
        }
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error))) throw error;
      }
    }
    const listed = agents(await this.runner.run(["agent", "list"]));
    if (sameSession && existing?.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      // Pane and tab IDs survive an agent exit. They identify a terminal
      // location, not the concierge process. Require the exact governed agent
      // name and preserve the new IDs when Herdr reports a pane move.
      const live = listed.find(agent => agent.name === existing.agent);
      if (!live) return;
      const paneId = named(live.pane_id) ?? existing.paneId;
      let processId = existing.processId;
      if (paneId) {
        try {
          const running = await this.foreground(paneId);
          if (processId) {
            if (!running.some(process => process.pid === processId)) return;
          } else {
            processId = running[0]?.pid;
          }
        } catch {
          // A persisted PID is the stronger identity. If it cannot be verified,
          // recover instead of sending a command to a possibly replaced pane.
          if (processId) return;
        }
      }
      return {
        reference: {
          ...existing,
          workspaceId: named(live.workspace_id) ?? existing.workspaceId,
          tabId: named(live.tab_id) ?? existing.tabId,
          paneId,
          ...(processId === undefined ? {} : { processId }),
        },
        live: livePresence(live, checkedAt),
      };
    }
    // Without a persisted control-plane reference, provenance is unknown.
    // Never close or reuse a same-named process the user may have started.
    return;
  }
  /**
   * Re-verifies one migrated v3 reference without granting control from a
   * title, pane name or recycled PID alone. The OS birth time is required for
   * a migrated process before it can become a closable v4 scene.
   */
  async inspectManagedReference(
    existing: HerdrReference,
  ): Promise<{ reference: HerdrReference; live: LivePresence } | undefined> {
    if (existing.session !== this.session || !existing.paneId || !existing.processId) return;
    const listed = agents(await this.runner.run(["agent", "list"]));
    const agent = listed.find(item =>
      item.pane_id === existing.paneId &&
      (!existing.agent || item.name === existing.agent || item.agent === existing.agent ||
        item.agent_kind === existing.agent));
    if (!agent) return;
    const foreground = await this.foreground(existing.paneId).catch(() => []);
    if (!foreground.some(process => process.pid === existing.processId)) return;
    return {
      reference: {
        ...existing,
        workspaceId: named(agent.workspace_id) ?? existing.workspaceId,
        tabId: named(agent.tab_id) ?? existing.tabId,
        agent: named(agent.name) ?? existing.agent,
      },
      live: livePresence(agent, new Date().toISOString()),
    };
  }
  async findConcierge(existing?: HerdrReference): Promise<HerdrReference | undefined> {
    return (await this.inspectConcierge(existing))?.reference;
  }
  async ensureSession(): Promise<void> {
    try {
      agents(await this.runner.run(["agent", "list"]));
      return;
    } catch (error) {
      if (!String(error).includes("server_not_running") || !this.startSession)
        throw error;
    }
    await this.startSession();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        agents(await this.runner.run(["agent", "list"], 2000));
        return;
      } catch (error) {
        if (!String(error).includes("server_not_running")) throw error;
      }
      await delay(250);
    }
    throw new Error(
      "Herdr 会话未能启动。请在应用内重新连接现场，再点「准备管家」重试。",
    );
  }
  async ensureWorkspace() {
    const listed = payload(await this.runner.run(["workspace", "list"])),
      workspaces = listed.result?.workspaces ?? listed.workspaces;
    if (Array.isArray(workspaces) && workspaces.length) return;
    await this.runner.run([
      "workspace", "create",
      "--cwd", this.workspaceRoot,
      "--label", "Atte",
      "--focus",
    ], 60_000);
  }
  async prepareConcierge(
    root: string,
    existing?: HerdrReference,
    kind = "codex",
    cliDirectory = "",
    localBin = "/usr/local/bin",
    agentBin = "/usr/local/bin",
    onReference?: (reference: HerdrReference) => Promise<void>,
    preferences?: AgentPreferences,
    nativeArgs: string[] = [],
    executable?: string,
    cliBin = "",
    herdrBinary = "herdr",
    hostSocket = "",
    hostToken = "",
    resolveExecutableInLoginShell = false,
  ): Promise<HerdrReference> {
    const concierge = await this.findConcierge(existing);
    if (concierge) return concierge;
    let workspaceId: string | undefined,
      tabId: string | undefined,
      paneId: string | undefined;
    // A known Agent can leave a usable shell behind. A Pane-tracked custom
    // CLI cannot: Herdr may keep the stale Pane and its output while the shell
    // child has exited. Reusing it makes pane.wait-output match old output and
    // then strands the launch command, so recovery always needs a fresh site.
    if (existing?.session === this.session && existing.paneId &&
      existing.transport !== "pane") {
      try {
        const current = payload(
          await this.runner.run(["pane", "get", existing.paneId]),
        );
        const pane = current.result?.pane ?? current.pane;
        if (pane?.pane_id === existing.paneId) {
          // A closed concierge can leave its tab and shell behind. Reuse only
          // that empty shell pane; never replace a manual agent in the same pane.
          if ((await this.foreground(existing.paneId)).length === 0) {
            workspaceId = existing.workspaceId;
            tabId = existing.tabId;
            paneId = existing.paneId;
          }
        }
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error)))
          throw error;
      }
    }
    if (!workspaceId || !tabId || !paneId) {
      const controlRoot = workspaceDataDirectory(this.workspaceRoot);
      const created = payload(
        await this.runner.run(
          [
            "workspace",
            "create",
            "--cwd",
            controlRoot,
            "--label",
            "Atte · 全局工作台",
            "--no-focus",
          ],
          60_000,
        ),
      );
      const result = created.result ?? created;
      workspaceId =
        named(result.workspace?.workspace_id) ?? named(result.workspace?.id);
      tabId = named(result.tab?.tab_id) ?? named(result.tab?.id);
      paneId = named(result.root_pane?.pane_id) ?? named(result.root_pane?.id);
    }
    if (!workspaceId || !tabId || !paneId)
      throw new Error("Herdr 没有返回管家所需的真实会话 ID");
    const reference: HerdrReference = {
      session: this.session,
      workspaceId,
      tabId,
      paneId,
      agent: "concierge",
      launchPolicy: CONCIERGE_LAUNCH_POLICY,
      ...(!kind && executable ? { transport: "pane" as const } : {}),
    };
    await onReference?.(reference);
    await this.runner.run(["tab", "focus", tabId]);
    const cliRoot = cliBin || cliDirectory || join(workspaceDataDirectory(root), "bin");
    const cliPath = `${cliRoot}:${localBin}:${agentBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
      const environment = `export HOME=${quoteShell(process.env.HOME || "")} XDG_CONFIG_HOME=${quoteShell(process.env.XDG_CONFIG_HOME || "")} XDG_STATE_HOME=${quoteShell(process.env.XDG_STATE_HOME || "")} ATTE_AGENT_NAME=concierge ATTE_WORKSPACE=${quoteShell(root)} ATTE_COORDINATOR=1 ATTE_COORDINATOR_SCOPE_FILE=${quoteShell(join(workspaceDataDirectory(root), "coordinator-scope.json"))} ATTE_HERDR_BINARY=${quoteShell(herdrBinary)}${hostSocket ? ` ATTE_HOST_SOCKET=${quoteShell(hostSocket)}` : ""}${hostToken ? ` ATTE_HOST_TOKEN=${quoteShell(hostToken)}` : ""} HERDR_SESSION=${quoteShell(this.session)} HERDR_ENV=1 HERDR_WORKSPACE_ID=${quoteShell(workspaceId)} HERDR_TAB_ID=${quoteShell(tabId)} HERDR_PANE_ID=${quoteShell(paneId)} PATH=${quoteShell(cliPath)}:"$PATH"; printf '\\n__ATTE_ENV_READY__\\n'`;
    await this.runner.run(["pane", "run", paneId, environment]);
    await this.runner.run(["pane", "wait-output", paneId, "--match", "__ATTE_ENV_READY__", "--timeout", "10000"], 15_000);
    if (!kind && executable) {
      await this.runner.run([
        "pane",
        "run",
        paneId,
        resolveExecutableInLoginShell
          ? renderLoginShellAgentCommand(
            process.env.SHELL || "/bin/zsh",
            executable,
            nativeArgs,
          )
          : renderAgentCommand(executable, nativeArgs),
      ]);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const running = await this.foreground(paneId);
        if (running.length) {
          // Arbitrary interactive CLIs are not registered with Herdr yet, so
          // there is no trusted "ready" state. The process can appear before
          // its TTY enters raw input mode; submitting immediately makes tools
          // such as Codex discard buffered keystrokes and exit. Give the CLI a
          // short initialization window, then verify it is still alive.
          await delay(2_000);
          const ready = await this.foreground(paneId);
          if (!ready[0])
            throw new Error("自定义 Agent 在准备输入时退出，请打开现场检查登录或启动配置。");
          reference.transport = "pane";
          reference.processId = ready[0].pid;
          await onReference?.(reference);
          await this.labelDetectedAgent(paneId, "concierge");
          await this.prompt(reference, staticIdentityInstructions(root), true);
          return reference;
        }
        await delay(200);
      }
      throw new Error("自定义 Agent 未保持运行。请打开现场检查启动命令、登录或配置。");
    }
    await this.runner.run(
      [
        "agent",
        "start",
        "concierge",
        "--kind",
        kind,
        "--pane",
        paneId,
        ...(nativeArgs.length ? ["--", ...nativeArgs] : []),
      ],
      60_000,
    );
    await this.prompt(reference, staticIdentityInstructions(root), true, 180_000);
    const running = await this.foreground(paneId).catch(() => []);
    if (running[0]) {
      reference.processId = running[0].pid;
      await onReference?.(reference);
    }
    return reference;
  }
  async notifyGoal(
    reference: HerdrReference | undefined,
    goalId: string,
    title: string,
    goal?: Goal,
    workspaceRoot?: string,
    timeout?: number,
  ) {
    if (!reference?.agent && reference?.transport !== "pane")
      throw new Error("管家尚未准备好，请先在设置中准备管家");
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    return this.prompt(reference,
      `${staticConciergeRole}
[ATTE_CASE_BEGIN]
case_id: ${goalId}
request_id: ${goal?.dispatch?.id ?? "unknown"}
event: ${goal?.dispatch?.kind ?? "goal_update"}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal?.dispatch?.kind === "resume" ? `resume_note: ${goal.dispatch.note ?? ""}` : ""}
${goal?.dispatch?.kind === "restart" ? `restart_note: ${goal.dispatch.note ?? ""}` : ""}
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, description: goal.description, projectId: goal.projectId, status: goal.status, next: goal.next, attentionRequest: attentionRequest(goal), sceneReply: goal.sceneReply, delivery: goal.delivery, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : `title: ${title}`}
[ATTE_CASE_END]
${attachments.length ? `用户附带的图片是目标证据。把下列真实绝对路径连同任务交给负责人；负责人使用的 CLI 支持图片时，应实际查看图片再判断。不要声称看过图片，除非现场确有读取记录。\n${attachments.map(item => `attachment: ${item.absolutePath}`).join("\n")}\n` : ""}
${goal?.dispatch?.kind === "scene_reply" ? `这是负责人现场回执，不是新任务。用户已经在负责人会话中给出 sceneReply.quote；不要要求用户再回 App 重复回答，也不要重新派发已经执行的任务。
先重新读取 goal show，核对 attentionRequest.id 与 sceneReply.attentionId。若编号不一致，旧回执不得清除新问题。语义含糊则只追问缺少的信息。
若原问题已经有明确答复，根据原话调用 resolve（批准或拒绝）、rework（退回）、complete（用户明确结束）、drop（放弃），或在确有新事实时 progress / wait / remind。交付必须走 review 并由人验收；complete 不能绕过验收，受管 Agent 不得调用 goal accept。验收类回执只保存用户原话并保留注意力，最终验收由人在桌面完成。结束或决定命令的 --note 必须使用 sceneReply.quote 原文；普通问题处理不能冒充成果验收。当前 CLI 自动绑定本回执编号，拒绝迟到或被替换的回执。单纯补充进展不能关闭旧决定；请明确解决对应事项。核对完成后结束本回合，不轮询等待。` : ""}
${goal?.dispatch?.kind === "restart" ? `这是用户主动重启的已结束目标，不是重新创建，也不是普通反馈。桌面已经优先恢复原负责人会话并重新绑定真实现场；请先读取 restart_note，再联系当前负责人，要求其核对原会话和既有成果，带着这条新说明继续推进。若 ownerResume 表明没有可恢复会话，负责人会是基于原目标记录新启动的；必须让它先读完整目标与历史活动补足上下文。不要把旧交付重新当作本轮成果，也不要自己执行。` : ""}
请用 atte goal show ${goalId} --json 读取当前案卷，并用 atte status --json 查看 Agent 启动偏好与当前关联项目。若目标尚未登记负责人现场，根据 description 中的完整原文整理标题、背景、完成标准与下一步；没有充分依据则保留个人事项，不猜测范围。整理后交给本目标独立负责人；退回修改转交原负责人；交付齐备则向人交接。若本次是 feedback，先读取新增的人发消息，再按原话协调负责人；自由回复不会自动批准或结束目标，外部等待交回处理时先回到 active；只有明确事实才可执行当前案卷的 progress、wait、complete、rework、drop、resolve 或 remind，并在结束或决定命令中保留用户原话。成果验收必须留给人在桌面完成，不要调用 goal accept。若人已经验收或放弃，请通知负责人停止该目标的工作，不再派发。`,
      true,
      timeout,
    );
  }
  async notifyFollowUp(
    reference: HerdrReference,
    goalId: string,
    note: string,
    goal?: Goal,
    workspaceRoot?: string,
    timeout?: number,
  ) {
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    return this.prompt(reference,
      `${staticConciergeRole}
[ATTE_CASE_BEGIN]
case_id: ${goalId}
request_id: ${goal?.dispatch?.id ?? "unknown"}
event: follow_up
note: ${note}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, projectId: goal.projectId, next: goal.next, waitingFor: goal.waitingFor, remindAt: goal.remindAt, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : ""}
[ATTE_CASE_END]
请用 atte goal show ${goalId} --json 读取实际等待对象与提醒安排，联系原负责人核查进展并写回结果。现在处于 active，表示你正在核查，不代表外部已处理完；请读取历史等待记录确认原对象与提醒。若核查后仍确实等待外部第三方，显式调用 goal wait --owner "<具名外部第三方>" 并重新设置必要的提醒。等待你、负责人或其他 Agent 时保持 active；需要用户处理时用 goal decide 提出具体问题，不亲自执行业务，也不自动向外部人员发送消息。`,
      true,
      timeout,
    );
  }
  async refreshConcierge(reference: HerdrReference, root: string, preferences?: AgentPreferences) {
    await this.prompt(reference, staticIdentityInstructions(root), true);
  }
  async requestSceneReply(goal: Goal): Promise<boolean> {
    const reference = goal.herdr, question = attentionRequest(goal);
    if (!reference?.agent || reference.session !== this.session ||
      reference.transport === "pane" || !question) return false;
    const listed = agents(await this.runner.run(["agent", "list"]));
    const entry = listed.find(candidate =>
      (candidate.name ?? candidate.agent) === reference.agent &&
      candidate.pane_id === reference.paneId);
    const state = entry?.agent_status ?? entry?.state ?? entry?.status ?? entry?.lifecycle;
    if (!entry || !["idle", "done"].includes(state)) return false;
    await this.prompt(reference, `[ATTE_SCENE_CHECK]
这是系统协议核对，不是用户的新回复，不是继续执行的授权。
当前目标 ${goal.id}，待处理事项 ${question.id}：${question.summary}
用户曾打开本目标现场，随后观察到一次工作回合结束。这个事实不证明用户已经回答问题。
请只核对你自己会话中最近的真实用户交互：若已明确回答当前事项且尚未写回，保存原话和结果；若没有、含糊或无法确认，保留待处理并立即结束，不凭空生成回执。不要重复提问，不做额外业务工作。
${ownerSceneReplyInstructions(goal.id)}
[/ATTE_SCENE_CHECK]`, true, 120_000);
    return true;
  }
  async open(reference: HerdrReference) {
    if (reference.tabId)
      await this.runner.run(["tab", "focus", reference.tabId]);
    else if (reference.agent)
      await this.runner.run(["agent", "focus", reference.agent]);
  }
  async closeGoal(reference: HerdrReference) {
    if (reference.session !== this.session)
      throw new Error("负责人现场属于其他 Herdr Session，不能自动关闭");
    const close = async (tabId: string) => {
      try {
        await this.runner.run(["tab", "close", tabId]);
        return true;
      } catch (error) {
        if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return false;
        throw error;
      }
    };
    if (reference.tabId && await close(reference.tabId)) return;
    const live = agents(await this.runner.run(["agent", "list"])).find(agent =>
      (!!reference.paneId && agent.pane_id === reference.paneId) ||
      (!!reference.workspaceId && agent.workspace_id === reference.workspaceId &&
        !!reference.agent && (agent.name === reference.agent || agent.agent === reference.agent)));
    if (!live?.tab_id) return;
    try {
      await this.runner.run(["tab", "close", live.tab_id]);
    } catch (error) {
      if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return;
      throw error;
    }
  }
  async closeConcierge(reference: HerdrReference) {
    if (reference.session !== this.session)
      throw new Error("管家现场属于其他 Herdr Session，不能轮换");
    if (!reference.tabId) return;
    try {
      await this.runner.run(["tab", "close", reference.tabId]);
    } catch (error) {
      if (!/not_found|invalid_tab|unknown_tab/.test(String(error))) throw error;
    }
  }
  async captureOwnerResume(reference: HerdrReference): Promise<OwnerResume | undefined> {
    if (reference.session !== this.session) return undefined;
    const entries = agents(await this.runner.run(["agent", "list"]));
    const live = entries.find(entry =>
      (!!reference.paneId && entry.pane_id === reference.paneId) ||
      (!!reference.agent &&
        (entry.name === reference.agent || entry.agent === reference.agent)));
    if (!live) return undefined;
    const raw = live.agent_session;
    const source = named(raw?.source);
    const agent = named(raw?.agent);
    const value = named(raw?.value);
    const kind = raw?.kind === "id" || raw?.kind === "path" ? raw.kind : undefined;
    const owner = reference.agent || named(live.name) || named(live.agent) || "owner";
    const cwd = named(live.foreground_cwd) || named(live.cwd);
    return {
      owner,
      savedAt: new Date().toISOString(),
      ...(cwd ? { cwd } : {}),
      ...(source && agent && value && kind
        ? { agentSession: { source, agent, kind, value } }
        : {}),
    };
  }
  async notifyWatchdog(reference: HerdrReference, issues: WatchdogRequest[]) {
    if (!reference.agent && reference.transport !== "pane") throw new Error("管家尚未准备好，请先连接管家");
    const conciergeRole = staticConciergeRole;
    const reasons: Record<string, string> = { blocked: "负责人正在等待输入或批准", missing: "负责人会话暂时不可达", stale: "目标 30 分钟没有写回实质进展", unassigned: "目标尚未登记独立负责人现场，请先创建并启动负责人，保存真实现场再发送任务", settled: "负责人已停止输出并回到输入状态，但尚未写回这一阶段的结果；这不等于任务完成或失败", protocol_missing: "负责人的 Stop Hook 已确认回合结束，自动提醒后仍未提交 Atte 结构化结果" };
    for (const issue of issues) await this.prompt(reference,
      `${conciergeRole}\n[ATTE_CASE_BEGIN]\ncase_id: ${issue.goalId}\nrequest_id: watchdog-${issue.reason}-${issue.basis}\nevent: watchdog\nissue: ${reasons[issue.reason] ?? issue.reason}\npolicy: 只处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标\n[ATTE_CASE_END]\n这是后台巡检，不是用户新增任务。请先用 atte goal show ${issue.goalId} 读取实际记录，检查真实负责人现场并主动联系负责人，通过澄清要求、调整分工或联系其他负责人协调恢复，不能自己接手执行。写回实际协调进展，不把终端安静或 idle 当作失败或完成。确实必须由人决定时才用 goal decide 提出具体问题；不要让人填写进度表。已明确等待外部第三方、已交付或已结束的目标不要重新启动。${["settled", "protocol_missing"].includes(issue.reason) ? "负责人停在输入状态但没有写回，可能是遗漏汇报，也可能是等待未被识别的输入。请要求负责人补齐真实结果、下一步，以及必要的 decide / wait / review；不要自行验收或猜测终端文字的含义。若目标已有 attentionRequest，不要重复提问，应先核对该事项。" : ""}`,
      true,
      30_000,
    );
  }
  async notifyOwnerReminder(reference: HerdrReference, text: string) {
    if (!reference.agent && reference.transport !== "pane")
      throw new Error("负责人现场不可达，无法发送回执提醒");
    const marker = receiptMarker(text);
    if (reference.transport === "pane") {
      await this.prompt(reference, text, false);
      return {
        status: "unconfirmed" as const,
        detail: "自定义 Agent 已通过 Pane 收到回执提醒；需等待 Agent Hook 确认实际开始处理，现在交给管家核对。",
      };
    }
    if (!reference.paneId) throw new Error("负责人现场缺少 Pane，无法确认回执提醒输入");
    const current = agents(await this.runner.run(["agent", "list"])).find(agent =>
      agent?.name === reference.agent && agent?.pane_id === reference.paneId,
    );
    if (!current) throw new Error("负责人 Agent 已退出或 Pane 已更换，回执提醒未发送");
    const state = liveState(current);
    if (state === "working") return {
      status: "unconfirmed" as const,
      detail: "负责人仍在工作，未插入自动回执提醒；交给管家核对当前回合。",
    };
    if (state === "blocked") return {
      status: "unconfirmed" as const,
      detail: "负责人正在等待交互输入，未插入自动回执提醒；交给管家核对。",
    };
    if (!["idle", "done"].includes(state)) return {
      status: "unconfirmed" as const,
      detail: `负责人当前状态为 ${state}，未确认可安全插入回执提醒；交给管家核对。`,
    };
    if (current.interactive_ready === false) return {
      status: "unconfirmed" as const,
      detail: "负责人终端尚未恢复输入，未发送自动回执提醒；交给管家核对。",
    };
    try {
      await this.runner.run([
        "agent", "prompt", reference.agent!, text,
        "--wait", "--until", "working", "--timeout", "5000",
      ], 7_000);
    } catch (error) {
      if (/\bagent_blocked\b/.test(String(error)))
        return {
          status: "unconfirmed" as const,
          detail: "负责人正在等待输入，没有插入自动回执提醒；交给管家核对。",
        };
      if (/\bagent_prompt_stalled\b/.test(String(error)) ||
        /\btimed out waiting for agent status\b/.test(String(error)) ||
        /"code"\s*:\s*"timeout"/.test(String(error)))
        return {
          status: "unconfirmed" as const,
          detail: "Herdr 已提交回执提醒，但 5 秒内未确认负责人开始处理；为避免重复，已交给管家核对。",
        };
      throw error;
    }
    return { status: "sent" as const };
  }
  async presences(
    goals: { id: string; herdr?: HerdrReference }[],
  ): Promise<Record<string, LivePresence>> {
    const entries = agents(await this.runner.run(["agent", "list"]));
    const result: Record<string, LivePresence> = {};
    for (const goal of goals) {
      if (goal.herdr?.transport === "pane") {
        const reachable = await this.rawAlive(goal.herdr).catch(() => false);
        const live = reachable
          ? entries.find(entry => entry.pane_id === goal.herdr?.paneId)
          : undefined;
        result[goal.id] = live
          ? livePresence(live, new Date().toISOString())
          : { state: "unknown", checkedAt: new Date().toISOString(), reachable };
        continue;
      }
      if (!goal.herdr?.agent) continue;
      const agent = entries.find(
        (entry) =>
          entry.name === goal.herdr?.agent ||
          entry.agent === goal.herdr?.agent ||
          entry.pane_id === goal.herdr?.paneId,
      );
      if (!agent) {
        result[goal.id] = { state: "unknown", checkedAt: new Date().toISOString(), reachable: false };
        continue;
      }
      result[goal.id] = {
        state: liveState(agent),
        checkedAt: new Date().toISOString(),
        reachable: true,
      };
    }
    return result;
  }
}
