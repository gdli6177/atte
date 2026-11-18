import { useEffect, useRef, useState } from "react";
import { Bell, Bot, Copy, Download, Folder, HardDrive, RefreshCw, Settings2, SquareTerminal, Trash2, Wrench, Zap } from "lucide-react";
import type { AgentPreferences, Project, ShipPolicy, WorkspaceState } from "../../../../../packages/core/src/types.js";
import type { AgentHookAdapterStatus, ManagedAdapterId } from "../../../electron/agent-hook-manager.js";
import type { WebhookSettings } from "../../../electron/webhook-notifications.js";
import type { ApplicationUpdateStatus } from "../../../electron/application-updater.js";
import { api } from "../../api.js";
import { BrandMark, Button, ChoiceGroup, Field, LoadingState, Select, SettingsGroup, SettingsSection, TextInput } from "../../ui/index.js";
import { time } from "../goals/goalPresentation.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { ApplicationUpdateSettings } from "./ApplicationUpdateSettings.js";

type HerdrStatus = Awaited<ReturnType<typeof api.herdrStatus>>;
type CliStatus = Awaited<ReturnType<typeof api.cliStatus>>;
type SkillsStatus = Awaited<ReturnType<typeof api.skillsStatus>>;
type AgentChoice = Awaited<ReturnType<typeof api.agentChoices>>[number];
export type SettingsAction =
  | "herdr-check"
  | "herdr-install"
  | "cli"
  | "skills"
  | "update-check"
  | "update-install";

export function Settings({
  busy, state, herdr, cli, skills, agentHooks, onAgentHooksChange, notify,
  theme, setTheme, onAction, workspace, pickWorkspace, agentOptions,
  webhook, saveAgents, savePolicy, openWebhook, version,
  applicationUpdate, setApplicationUpdateBackground,
}: {
  busy: boolean;
  state: WorkspaceState;
  herdr?: HerdrStatus;
  cli?: CliStatus;
  skills?: SkillsStatus;
  agentHooks: AgentHookAdapterStatus[];
  onAgentHooksChange: (adapters: AgentHookAdapterStatus[]) => void;
  notify: (message: string) => void;
  theme: string;
  setTheme: (theme: string) => void;
  onAction: (action: SettingsAction) => Promise<void>;
  applicationUpdate: ApplicationUpdateStatus;
  setApplicationUpdateBackground: (enabled: boolean) => Promise<void>;
  workspace: string;
  pickWorkspace: () => void;
  agentOptions: AgentChoice[];
  webhook: WebhookSettings;
  saveAgents: (preferences: AgentPreferences) => Promise<void>;
  savePolicy: (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => Promise<void>;
  openWebhook: () => void;
  version: string;
}) {
  const [attachCopy, setAttachCopy] = useState("idle");
  const [diagnosticCopy, setDiagnosticCopy] = useState("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  async function copy(kind: "attach" | "diagnostics") {
    try {
      await api.writeClipboardText(kind === "attach"
        ? `herdr session attach ${herdr?.session}`
        : await api.diagnosticsReport());
      if (kind === "attach") setAttachCopy("copied");
      else {
        setDiagnosticCopy("copied");
        notify("诊断日志已复制，可直接粘贴给维护者排查。");
      }
    } catch (reason) {
      if (kind === "attach") setAttachCopy("failed");
      else setDiagnosticCopy("failed");
      notify(`复制失败：${errorText(reason)}`);
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setAttachCopy("idle");
      setDiagnosticCopy("idle");
    }, 4_000);
  }
  const groups = [
    ["general", "工作区与外观"], ["agents", "Agent"], ["scenes", "执行现场"],
    ["updates", "应用更新"], ["maintenance", "高级与维护"],
  ];
  return (
    <div className="content settings">
      <section className="intro"><div>
        <span className="eyebrow">Atte · The attention layer</span>
        <h1>只设置必要的。</h1>
        <p>保留你已有的终端、CLI、模型与工作方式。</p>
      </div></section>
      <nav className="settings-navigation" aria-label="设置分组">
        {groups.map(([id, label]) => <a key={id} href={`#settings-${id}`} onClick={event => {
          event.preventDefault();
          const section = document.getElementById(`settings-${id}`);
          if (section instanceof HTMLDetailsElement) section.open = true;
          section?.scrollIntoView({ block: "start" });
          (section instanceof HTMLDetailsElement ? section.querySelector("summary") : section)?.focus({ preventScroll: true });
        }}>{label}</a>)}
      </nav>
      <p className="settings-save-hint">修改字段后点击“保存”；安装、检测与更换工作区按按钮说明执行。</p>
      <div className="settings-groups">
        <SettingsGroup id="settings-general" title="工作区与外观" description="选择事项的存储位置与界面主题。">
          <SettingsSection icon={<Folder />} title="工作区存储位置" description="事项保存在此目录的 .atte 中。切换后显示该目录自己的事项。">
            <div className="settings-facts"><code>{workspace || "尚未选择存储位置"}</code></div>
            <div className="ui-settings-card__actions"><Button variant="secondary" size="sm" onClick={pickWorkspace}>
              {workspace ? "更换工作区" : "选择存储位置"}
            </Button></div>
          </SettingsSection>
          <AppearanceSettings theme={theme} onSave={value => { setTheme(value); notify("外观已保存。"); }} />
        </SettingsGroup>
        <SettingsGroup id="settings-agents" title="Agent" description="设置管家与负责人的启动命令，查看生命周期接入状态。">
          <AgentPreferencesEditor key={workspace} preferences={state.agents ?? { concierge: "codex" }}
            options={agentOptions} busy={busy || !workspace} onSave={saveAgents} />
          <AgentRuntimeSettings adapters={agentHooks} busy={busy} onChange={onAgentHooksChange} notify={notify} />
        </SettingsGroup>
        <SettingsGroup id="settings-scenes" title="执行现场" description="Herdr 承载管家和负责人，真实终端为默认打开方式。">
          <SceneSettingsEditor busy={busy} notify={notify} />
        </SettingsGroup>
        <SettingsGroup id="settings-updates" title="应用更新"
          description="后台检查和下载应用更新；安装与重启只在明确操作后执行。">
          <ApplicationUpdateSettings
            status={applicationUpdate}
            busy={busy}
            onCheck={() => onAction("update-check")}
            onInstall={() => onAction("update-install")}
            onBackgroundChange={setApplicationUpdateBackground}
          />
        </SettingsGroup>
        <details id="settings-maintenance" className="manual-tools settings-disclosure settings-maintenance">
          <summary>高级与维护</summary>
          <p>系统通知、上线策略、Herdr 运行时、CLI 与 Skills 安装、缓存清理、诊断和 Webhook；仅在需要时展开。</p>
          <div className="ui-settings-grid">
          <SettingsSection wide icon={<Bell />} title="需要你时，主动通知"
            description="系统通知默认开启，在需要决定、等待验收、到期跟进或 Agent 需要介入时提醒你。">
            <p className="ui-field__hint">点击系统通知回到对应事项。普通进展只留在事项记录中。</p>
          </SettingsSection>
          <GovernanceEditor key={workspace} projects={state.projects} decisions={state.decisions ?? []}
            busy={busy || !workspace} onSave={savePolicy} />
          <SettingsSection wide icon={<SquareTerminal />} title="Herdr 运行时"
            description="Herdr 负责工作现场与全局管家。更新会保留现有事项；检查更新不会替换正在运行的版本。">
            <div className="settings-facts">
              {herdr?.session && <div className="external-herdr-command" role="group" aria-label="在外部终端打开同一 Herdr 会话">
                <div><strong>在 iTerm2 / Terminal / Ghostty 中打开同一现场</strong>
                  <p>复制下面的命令，进入当前工作区的 Herdr Session。</p>
                  <code>herdr session attach {herdr.session}</code></div>
                <Button variant="secondary" size="sm" icon={<Copy size={14} />} aria-label="复制外部终端 attach 命令"
                  onClick={() => void copy("attach")}>{copyLabel(attachCopy, "复制命令")}</Button>
              </div>}
              {herdr?.executable && <code>{herdr.executable}</code>}
            </div>
            <div className="settings-inline">
              {herdr?.installed ? <span className="settings-status ready"><i />已安装 {herdr.version}
                {herdr.latestVersion ? ` · 最新 ${herdr.latestVersion}` : ""}
                {herdr.plugin?.phase === "ready" ? " · 注意力面板已接入" : ""}
              </span> : <LoadingState label={herdr?.detail || "正在检测运行环境…"} />}
              {herdr?.plugin?.phase === "error" && <span className="ui-field__error">{herdr.plugin.detail}</span>}
            </div>
            {herdr?.detail && <p className={herdr.phase === "error" ? "ui-field__error" : "muted"}
              role={herdr.phase === "error" ? "alert" : "status"}>{herdr.detail}</p>}
            <div className="ui-settings-card__actions">
              <Button variant={herdr?.updateAvailable ? "primary" : "secondary"} size="sm"
                icon={herdr?.updateAvailable ? <Download size={14} /> : <RefreshCw size={14} />}
                disabled={busy || herdr?.phase === "checking" || herdr?.phase === "downloading"}
                onClick={() => void onAction(herdr?.updateAvailable || !herdr?.installed ? "herdr-install" : "herdr-check")}>
                {herdr?.phase === "downloading" ? "正在更新…" : herdr?.phase === "checking" ? "正在检查…"
                  : !herdr?.installed ? "安装 Herdr" : herdr.updateAvailable ? "更新 Herdr" : "检查更新"}
              </Button>
            </div>
          </SettingsSection>
          <SettingsSection icon={<Zap />} title="Atte 命令行"
            description="管家通过它读写当前案卷。应用内置，无需另外安装 Node。">
            <div className="settings-facts"><code>{cli?.path}</code></div>
            <div className="ui-settings-card__actions"><Button variant="secondary" size="sm" disabled={busy}
              onClick={() => void onAction("cli")}>{cli?.installed ? "重新安装" : "安装到 ~/.local/bin"}</Button></div>
          </SettingsSection>
          <SettingsSection icon={<Bot />} title="让外部 Agent 会使用 Atte"
            description="安装随应用打包的 Atte Skill，让外部 Agent 提交事项、查看记录和追加说明。">
            {skills?.targets?.length ? <div className="skill-targets">{skills.targets.map(target => (
              <small key={target.id} className={target.phase} title={target.path}>{target.label}<i />
                {target.phase === "installed" ? "已安装" : target.phase === "outdated" ? `可更新 ${target.managedVersion ?? ""}`
                  : target.phase === "conflict" ? "已有同名 Skill，已保护" : "未安装"}
              </small>
            ))}</div> : <LoadingState label="正在检测 Agent Skills 目录…" />}
            <div className="ui-settings-card__actions">
              <span className="settings-status">{skills ? `${skills.installed}/${skills.available} 已就绪` : ""}</span>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onAction("skills")}>
                {skills && skills.installed === skills.available ? "重新安装 Skills" : "安装 / 更新 Skills"}
              </Button>
            </div>
          </SettingsSection>
          <StorageMaintenance />
          <SettingsSection icon={<Wrench />} title="排查与反馈" description="遇到异常时复制脱敏诊断，粘贴给维护者即可定位问题。">
            <p className="muted">报告包含版本、系统环境、Herdr 状态与最近错误，不包含事项正文、消息、附件、终端输出、Webhook 地址或凭据。</p>
            <div className="ui-settings-card__actions"><Button variant="secondary" size="sm" icon={<Copy size={14} />}
              onClick={() => void copy("diagnostics")}>{copyLabel(diagnosticCopy, "复制诊断日志")}</Button></div>
          </SettingsSection>
          <SettingsSection icon={<Bell />} title="Webhook 通知"
            description="按需接收状态变化、决定、验收、到期跟进和 Agent 介入通知。">
            <div className="settings-facts">
              {!webhook.configured && <p>尚未配置，不影响系统通知。</p>}
              {webhook.configured && <p>{webhook.endpoint} · {webhook.enabled ? "已启用" : "已暂停"}
                {webhook.tokenConfigured ? " · Bearer 认证" : ""} · {webhook.statuses.length ? `${webhook.statuses.length} 种状态` : "不订阅状态变化"}
              </p>}
              {webhook.lastSuccessAt && <p>最近送达：{time(webhook.lastSuccessAt)}</p>}
              {webhook.lastError && <p className="ui-field__error">上次发送失败：{webhook.lastError}
                {webhook.lastErrorAt ? ` · ${time(webhook.lastErrorAt)}` : ""}</p>}
            </div>
            <div className="ui-settings-card__actions"><Button variant="secondary" size="sm" onClick={openWebhook}>
              {webhook.configured ? "管理 Webhook" : "配置 Webhook"}
            </Button></div>
          </SettingsSection>
        <SettingsSection icon={<Bot />} title="关于 Atte" description="The attention layer">
          <div className="about-mark"><BrandMark variant="icon" /></div>
          <div className="settings-facts"><p>人只做拍板，Agent 并行推进。管家把决定、验收和需要介入的事项带到你面前。</p><p>当前版本：{version}</p></div>
        </SettingsSection>
          </div>
        </details>
        <p className="settings-foot">Atte {version} · The attention layer · {state.projects.length} 个项目 · {state.goals.length} 件事项</p>
      </div>
    </div>
  );
}

function SceneSettingsEditor({ busy, notify }: { busy: boolean; notify: (message: string) => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.sceneSettings>>>();
  const [openWith, setOpenWith] = useState<"external" | "embedded">("external");
  const [terminal, setTerminal] = useState<"auto" | "iterm2" | "terminal" | "ghostty">("auto");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let current = true;
    void api.sceneSettings().then(value => {
      if (!current) return;
      setStatus(value); setOpenWith(value.settings.openWith); setTerminal(value.settings.terminal);
    }).catch(reason => { if (current) setFailure(errorText(reason)); });
    return () => { current = false; };
  }, []);
  const dirty = Boolean(status && (openWith !== status.settings.openWith || terminal !== status.settings.terminal));
  async function save() {
    setSaving(true); setFailure("");
    try {
      const value = await api.saveSceneSettings({ openWith, terminal });
      setStatus(value); setOpenWith(value.settings.openWith); setTerminal(value.settings.terminal);
      notify("工作现场设置已保存。");
    } catch (reason) { setFailure(errorText(reason)); }
    finally { setSaving(false); }
  }
  async function test() {
    setSaving(true); setFailure("");
    try {
      const lease = await api.testSceneSettings();
      notify(`已在 ${lease.terminal === "iterm2" ? "iTerm2" : lease.terminal === "terminal" ? "Terminal" : "Ghostty"} 打开当前工作现场。`);
    } catch (reason) { setFailure(errorText(reason)); }
    finally { setSaving(false); }
  }
  return (
    <SettingsSection wide icon={<SquareTerminal />} title="工作现场"
      description="真实终端保留图片粘贴、组合键、输入法和完整 Herdr 交互。内嵌轻现场适合快速查看和简单文字输入。">
      <div className="scene-settings-panel">
        <div><strong>“回到现场”默认打开方式</strong>
          <ChoiceGroup label="默认打开方式" value={openWith} disabled={busy || saving || !status}
            options={[{ value: "external", label: "外部终端（推荐）" }, { value: "embedded", label: "内嵌轻现场" }]}
            onChange={setOpenWith} />
          <p>{openWith === "external" ? "使用真实终端，定位同一 Herdr Session 和目标 Tab。" : "不离开 Atte，也可随时切到外部终端。"}</p>
        </div>
        <div><strong>优先使用的终端</strong>
          <div className="scene-terminal-options" role="group" aria-label="优先使用的终端">
            <button type="button" disabled={busy || saving || !status} aria-pressed={terminal === "auto"}
              onClick={() => setTerminal("auto")}>自动选择</button>
            {status?.terminals.map(item => <button key={item.id} type="button"
              disabled={busy || saving || !item.installed} aria-pressed={terminal === item.id}
              onClick={() => setTerminal(item.id)}>{item.label}{item.installed ? "" : "（未安装）"}</button>)}
          </div>
          <p>当前选择：{status?.resolved ? status.terminals.find(item => item.id === status.resolved)?.label : "等待检测可用终端"}</p>
        </div>
      </div>
      <div className="settings-facts">
        <p>当前生效：{status?.settings.openWith === "embedded" ? "内嵌轻现场" : "外部终端"} · {status?.settings.terminal ?? "检测中"}</p>
        <p>Terminal 可直接启动。iTerm2 精确定位可能需要 macOS 自动化权限；外部终端不可用时可继续使用内嵌轻现场。</p>
      </div>
      {failure && <p className="ui-field__error" role="alert">{failure}</p>}
      <div className="ui-settings-card__actions">
        <Button variant="secondary" size="sm" disabled={busy || saving || !dirty} onClick={() => void save()}>
          {saving ? "正在保存…" : "保存工作现场"}
        </Button>
        <span className="settings-status" role="status">{dirty ? "有未保存的更改" : "已保存"}</span>
        <Button variant="secondary" size="sm" disabled={busy || saving || dirty || !status} onClick={() => void test()}>测试打开现场</Button>
      </div>
    </SettingsSection>
  );
}

function AgentPreferencesEditor({ preferences, options, busy, onSave }: {
  preferences: AgentPreferences; options: AgentChoice[]; busy: boolean; onSave: (preferences: AgentPreferences) => Promise<void>;
}) {
  const [commands, setCommands] = useState({ concierge: preferences.concierge, owner: preferences.owner ?? "" });
  useEffect(() => {
    setCommands({ concierge: preferences.concierge, owner: preferences.owner ?? "" });
  }, [preferences.concierge, preferences.owner]);
  return (
    <SettingsSection wide icon={<Bot />} title="Agent 启动命令"
      description="管家负责协调，负责人执行事项。已有会话继续工作，新会话使用保存后的命令。">
      <form className="ui-form" onSubmit={async event => {
        event.preventDefault();
        try { await onSave({ concierge: commands.concierge, owner: commands.owner.trim() || undefined }); }
        catch {}
      }}>
        <div className="agent-role-grid ui-form__grid">
          {(["concierge", "owner"] as const).map(role => <Field key={role}
            label={role === "concierge" ? "管家启动命令" : "负责人启动命令"} hint={role === "owner" ? "留空继承管家启动命令。" : undefined}>
            <TextInput name={role} list="installed-agent-commands" value={commands[role]}
              onChange={event => setCommands(current => ({ ...current, [role]: event.target.value }))}
              placeholder={role === "concierge" ? "codex" : "留空跟随管家"}
              required={role === "concierge"} maxLength={2000} disabled={busy} spellCheck={false} />
          </Field>)}
        </div>
        <datalist id="installed-agent-commands">{options.filter(option => option.installed).map(option =>
          <option key={option.kind} value={option.kind} />)}</datalist>
        <div className="ui-form__footer">
          <p className="ui-form__note">填写本机交互式 CLI 和原生参数，支持绝对路径与 ~/ 路径。环境变量和 shell 表达式请放入自己的启动脚本。</p>
          <Button type="submit" variant="secondary" disabled={busy}>保存偏好</Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function AgentRuntimeSettings({ adapters, busy, onChange, notify }: {
  adapters: AgentHookAdapterStatus[]; busy: boolean;
  onChange: (adapters: AgentHookAdapterStatus[]) => void; notify: (message: string) => void;
}) {
  const [working, setWorking] = useState<ManagedAdapterId>();
  const [failure, setFailure] = useState("");
  const labels = { "not-installed": "未检测", installed: "已接入", "waiting-trust": "等待信任",
    disabled: "已停用", unsupported: "版本不支持", conflict: "配置冲突", error: "接入失败" };
  const needsAttention = (adapter: AgentHookAdapterStatus) =>
    ["waiting-trust", "unsupported", "conflict", "error"].includes(adapter.status);
  const attentionAdapters = adapters.filter(needsAttention);
  async function operate(id: ManagedAdapterId, action: "install" | "disable" | "uninstall" | "refresh") {
    setWorking(id); setFailure("");
    try {
      await api.configureAgentRuntime(id, action);
      onChange(await api.agentRuntimeStatus());
      notify(action === "disable" ? "已停用 Hook；Herdr 与巡检继续可用。"
        : action === "uninstall" ? "已移除 Atte 管理的 Hook，保留其他用户 Hook。" : "Agent Hook 已更新。");
    } catch (reason) { setFailure(errorText(reason)); }
    finally { setWorking(undefined); }
  }
  return (
    <SettingsSection wide icon={<Bot />} title="Agent 接入"
      description="Hook 只观测会话、回合和阻塞等生命周期；事项完成、等待、决定和验收仍由 Atte CLI 结构化写回。">
      {attentionAdapters.length > 0 && <p className="ui-field__error" role="status">
        Hook 接入需要处理：{attentionAdapters.map(adapter => `${adapter.label}（${labels[adapter.status]}）`).join("、")}。
      </p>}
      <div className="agent-runtime-list">
        {adapters.length ? adapters.map(adapter => <div className="agent-runtime-row" key={adapter.id}
          data-needs-attention={needsAttention(adapter) || undefined}>
          <div className="agent-runtime-identity"><span className="agent-runtime-mark"><Bot size={15} aria-hidden="true" /></span>
            <div><strong>{adapter.label}</strong><small title={adapter.configPath}>
              {adapter.version ? `${adapter.version} · ` : ""}{labels[adapter.status]}
            </small></div>
          </div>
          <div className="agent-runtime-detail">
            <span>{adapter.status === "waiting-trust" ? "在 Agent 中信任 Atte Hook 后开始生效。"
              : adapter.detail || (adapter.command ? "受管生命周期 Hook。" : "未检测到本机 CLI。")}</span>
            <details className="settings-hook-details"><summary>接入详情</summary>
              <small className="agent-runtime-events">{adapter.events.join(" · ")}</small>
              {adapter.lastEventAt && <small>最近事件：{time(adapter.lastEventAt)}</small>}
            </details>
          </div>
          <div className="agent-runtime-actions">
            {["installed", "waiting-trust"].includes(adapter.status) ? <>
              <Button variant="ghost" size="sm" disabled={busy || Boolean(working)} onClick={() => void operate(adapter.id, "disable")}>停用</Button>
              <Button variant="ghost" size="sm" disabled={busy || Boolean(working)} onClick={() => void operate(adapter.id, "uninstall")}>卸载</Button>
            </> : <Button variant="secondary" size="sm" disabled={busy || Boolean(working) || !adapter.command}
              onClick={() => void operate(adapter.id, ["conflict", "error", "unsupported"].includes(adapter.status) ? "refresh" : "install")}>
              {working === adapter.id ? "处理中…" : adapter.status === "disabled" ? "恢复接入" : "检查并接入"}
            </Button>}
          </div>
        </div>) : <LoadingState label="正在检测本机 Agent…" />}
      </div>
      {failure && <p className="ui-field__error" role="alert">{failure}</p>}
      <p className="ui-field__hint">Atte 保留 Agent 的官方信任流程、已有 Hooks 和 OMP extensions。</p>
    </SettingsSection>
  );
}

const shipPolicyLabels: Record<ShipPolicy, string> = {
  "external-approval": "外部审批（默认）", auto: "检查通过后自动合并与上线",
  "auto-merge-manual-deploy": "自动合并，上线前审批",
};
function GovernanceEditor({ projects, decisions, busy, onSave }: {
  projects: Project[]; decisions: WorkspaceState["decisions"]; busy: boolean;
  onSave: (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string>();
  const [showProjects, setShowProjects] = useState(false);
  const exceptions = projects.filter(project =>
    project.policy.shipPolicy !== "external-approval" || project.policy.approvers.length > 0).length;
  return (
    <SettingsSection wide icon={<Settings2 />} title="上线策略与决定账本"
      description="默认要求外部审批。自动策略保留检查；删数据、停服、花钱、外发消息、改方向、新建或轮换密钥、改权限和上线策略始终需要人确认。">
      <div className="settings-facts">
        <strong>默认：外部审批</strong>
        <p>合并与上线先取得外部批准。已有项目配置继续生效，只有明确保存项目策略才会修改授权。</p>
        <span className="settings-status">{exceptions ? `${exceptions} 个项目有单独配置` : "所有项目沿用默认策略"}</span>
      </div>
      <details className="manual-tools settings-policy" onToggle={event => {
        setShowProjects(event.currentTarget.open);
        if (!event.currentTarget.open) setEditing(undefined);
      }}>
        <summary>配置项目例外（{exceptions} 个已配置）</summary>
        {showProjects && <div className="policy-list">{projects.map(project => <div className="policy-row" key={project.id}>
        <div><strong>{project.name}</strong><span>{shipPolicyLabels[project.policy.shipPolicy]}</span>
          {project.policy.approvers.length > 0 && <small>审批人：{project.policy.approvers.join("、")}</small>}</div>
        {editing !== project.id ? <Button variant="secondary" size="sm" disabled={busy}
          onClick={() => setEditing(project.id)}>配置</Button> : <form key={`${project.id}-${project.policy.revision}`}
          onSubmit={async event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            try {
              await onSave(project.id, { shipPolicy: String(data.get("shipPolicy")) as ShipPolicy,
                approvers: String(data.get("approvers")).split(/[\n,，、]/).map(value => value.trim()).filter(Boolean) });
              setEditing(undefined);
            } catch {}
          }}>
          <Field label="上线策略"><Select name="shipPolicy" defaultValue={project.policy.shipPolicy} disabled={busy}>
            {Object.entries(shipPolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select></Field>
          <Field label="外部审批人（可选）"><TextInput name="approvers" defaultValue={project.policy.approvers.join("、")} disabled={busy} /></Field>
          <div className="policy-actions"><Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>保存策略</Button></div>
        </form>}
      </div>)}
          {projects.length === 0 && <p className="ui-field__hint">添加项目后，可在这里配置项目例外。</p>}
        </div>}
      </details>
      <details className="manual-tools"><summary>查看已记录的决定（{decisions.length}）</summary>
        <div className="conversation-feed">{[...decisions].reverse().map(decision => (
          <article className="conversation-entry" key={decision.id}>
            <header><strong>{decision.source}</strong><span>{decision.outcome === "approved" ? "批准" : "拒绝"}</span><time>{time(decision.decidedAt)}</time></header>
            <p>{decision.quote}</p>
          </article>
        ))}</div>
      </details>
    </SettingsSection>
  );
}

function StorageMaintenance() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.cacheMaintenanceStatus>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  async function refresh() {
    setFailure("");
    try { setStatus(await api.cacheMaintenanceStatus()); }
    catch (reason) { setFailure(errorText(reason)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function clean() {
    setBusy(true); setFailure(""); setMessage("");
    try {
      const result = await api.cleanCache();
      setStatus(result.status);
      setMessage(`已释放 ${formatBytes(result.removedBytes)}，清理 ${result.removedFiles} 个缓存文件。`);
      if (result.warnings.length) setFailure(`${result.warnings.length} 个文件正在使用或无法删除，已安全跳过。`);
    } catch (reason) { setFailure(errorText(reason)); }
    finally { setBusy(false); }
  }
  return (
    <SettingsSection wide icon={<HardDrive />} title="缓存与本地维护"
      description="自动清理过期渲染缓存、日志和遗留临时文件，保留事项、Agent 会话与旧工作区备份。">
      <div className="settings-inline"><span className="settings-status"><i />
        {status ? `${formatBytes(status.totalBytes)} · ${status.totalFiles} 个缓存文件` : "正在扫描…"}
      </span>{status && <span>{formatBytes(status.staleBytes)} 可在自动维护中释放</span>}</div>
      {message && <p className="ui-field__hint">{message}</p>}
      {failure && <p className="ui-field__error" role="alert">{failure}</p>}
      <div className="ui-settings-card__actions">
        <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} disabled={busy}
          onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)); }}>重新扫描</Button>
        <Button variant="secondary" size="sm" icon={<Trash2 size={14} />} disabled={busy || !status}
          onClick={() => void clean()}>{busy ? "正在清理…" : "清理缓存"}</Button>
      </div>
    </SettingsSection>
  );
}

function errorText(value: unknown) {
  return String(value).replace(/^Error: /, "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
function copyLabel(value: string, fallback: string) {
  return value === "copied" ? "已复制" : value === "failed" ? "复制失败，请重试" : fallback;
}
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
