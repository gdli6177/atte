import { useEffect, useState } from "react";
import { ChevronRight, FolderPlus, Plus, Sparkles } from "lucide-react";
import { attentionKind } from "../../../../../packages/core/src/model.js";
import { isReadOnlyGoal } from "../../../../../packages/core/src/retirement.js";
import type { Goal, WorkspaceState } from "../../../../../packages/core/src/types.js";
import { Button, Checkbox, EmptyState, Field, Select, StatusPill, TextInput } from "../../ui/index.js";
import type { BadgeTone } from "../../ui/index.js";
import { attentionActionLabel } from "./AttentionHome.js";
import { attentionOverview } from "./attentionOverview.js";
import { deleteFinishedGoals } from "./batchGoalDeletion.js";
import { goalEntryDestination } from "./goalEntry.js";
import { goalProgressLabel, time } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

export function GoalList({ state, projectId, setProjectId, filter, setFilter, open, create, addProject, service, busy, notify, reportError }: {
  state: WorkspaceState;
  projectId: string;
  setProjectId: (value: string) => void;
  filter: string;
  setFilter: (value: string) => void;
  open: (id: string) => void;
  create: (later?: boolean) => void;
  addProject: () => void;
  service: GoalDetailService;
  busy: boolean;
  notify: (message: string) => void;
  reportError: (reason: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const project = state.projects.find(item => item.id === projectId);
  const { attention } = attentionOverview(state.goals);
  const visible = state.goals.filter(goal =>
    (!projectId || goal.projectId === projectId) &&
    (filter === "all" || (filter === "attention" ? attention.includes(goal) : goal.status === filter)) &&
    `${goal.title} ${goal.description} ${goal.next}`.toLowerCase().includes(query.toLowerCase()));
  const batchAvailable = filter === "completed" || filter === "dropped";
  const selectable = visible.filter(goal => !isReadOnlyGoal(goal));
  const chosen = selectable.filter(goal => selected.includes(goal.id));
  const allSelected = selectable.length > 0 && chosen.length === selectable.length;
  const locked = busy || deleting;
  useEffect(() => { setBatchMode(false); setSelected([]); }, [filter, projectId]);
  useEffect(() => { setSelected([]); }, [query]);
  async function removeSelected() {
    if (locked || !chosen.length || !window.confirm(`永久删除选中的 ${chosen.length} 件已结束事项及其附件？此操作不可撤销。`)) return;
    setDeleting(true);
    try {
      const result = await deleteFinishedGoals(chosen, command => service.command(command));
      setSelected(result.failed.map(item => item.goalId));
      setBatchMode(result.failed.length > 0);
      if (result.failed.length) reportError(`已删除 ${result.deleted.length} 件，${result.failed.length} 件未删除：${String(result.failed[0]?.reason)}`);
      else notify(`已删除 ${result.deleted.length} 件已结束事项。`);
    } finally { setDeleting(false); }
  }
  function rowCopy(goal: Goal) {
    return <><span className={`goal-dot ${goal.status}`} /><span className="goal-row-copy">
      <strong>{goal.title}</strong><span className="goal-row-next">{goal.next}</span>
      <small>{state.projects.find(item => item.id === goal.projectId)?.name ?? "个人事项"}<span aria-hidden="true">·</span>
        {goal.owner}<span aria-hidden="true">·</span>{time(goal.updatedAt)} 更新</small>
    </span><StatusPill tone={rowTone(goal)}>{rowLabel(goal)}</StatusPill></>;
  }
  return (
    <div className="content">
      <section className="intro"><div><span className="eyebrow">{project ? "项目视角" : "全局视角"}</span>
        <h1>{project?.name ?? "每件事，都有下一步。"}</h1>
        <p>{filter === "backlog" ? "先记下，准备好再交给管家。" : "这里保留所有事项、下一步和历史记录。"}</p></div></section>
      <div className="project-filter">
        <Field label="项目"><Select aria-label="按项目筛选" value={projectId} disabled={locked}
          onChange={event => setProjectId(event.target.value)}><option value="">全部项目与个人事项</option>
          {state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
        <Button variant="secondary" size="sm" disabled={locked} icon={<FolderPlus size={14} />} onClick={addProject}>添加项目</Button>
        <Button variant="secondary" size="sm" disabled={locked} icon={<Plus size={14} />} onClick={() => create(true)}>先记一件事</Button>
      </div>
      <div className="filter-bar" role="group" aria-label="按事项状态筛选">
        {([["all", "全部"], ["attention", "需要处理"], ["waiting", "等待外部"], ["active", "跟进中"],
          ["backlog", "先记下"], ["review", "待验收"], ["completed", "已完成"], ["dropped", "已放弃"]] as const).map(([value, label]) =>
          <button key={value} type="button" className={filter === value ? "active" : ""} aria-pressed={filter === value}
            disabled={locked} onClick={() => setFilter(value)}>{label}</button>)}
        <TextInput aria-label="搜索事项" className="filter-search" placeholder="搜索事项…" disabled={locked}
          value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      {batchAvailable && <div className="goal-batch-bar" role="group" aria-label="批量管理">
        {batchMode ? <><span className="goal-batch-count" role="status">{deleting ? "正在删除…" : `已选 ${chosen.length} 项`}</span>
          <Button variant="secondary" size="sm" disabled={locked || !selectable.length}
            onClick={() => setSelected(allSelected ? [] : selectable.map(goal => goal.id))}>{allSelected ? "取消全选" : "全选"}</Button>
          <Button variant="danger" size="sm" disabled={locked || !chosen.length} onClick={() => void removeSelected()}>删除所选（{chosen.length}）</Button>
          <Button variant="ghost" size="sm" disabled={locked} onClick={() => { setBatchMode(false); setSelected([]); }}>退出批量</Button>
        </> : <><span className="goal-batch-hint">已结束事项可批量管理；只读历史继续保留。</span>
          <Button variant="secondary" size="sm" disabled={locked || !selectable.length} onClick={() => setBatchMode(true)}>批量选择</Button></>}
      </div>}
      <div className="goal-list">{visible.map(goal => batchMode && batchAvailable && !isReadOnlyGoal(goal)
        ? <Checkbox key={goal.id} className="goal-row goal-row-batch" aria-label={`批量选择 ${goal.title}`}
          checked={selected.includes(goal.id)} disabled={locked} onChange={event => setSelected(current =>
            event.target.checked ? [...new Set([...current, goal.id])] : current.filter(id => id !== goal.id))} label={rowCopy(goal)} />
        : <button key={goal.id} className="goal-row" type="button" disabled={deleting} onClick={() => open(goal.id)}>
          {rowCopy(goal)}<ChevronRight /></button>)}
        {!visible.length && <EmptyState className="goal-empty" icon={<Sparkles size={19} />}
          title={state.goals.length ? "没有符合条件的事项" : "这里还没有事项"}
          description={state.goals.length ? "换个关键词，或清除筛选。" : "记录一件事，或把它交给管家。"}
          action={<Button variant="secondary" size="sm" onClick={() => {
            if (!state.goals.length) create(filter === "backlog");
            else { setQuery(""); setFilter("all"); setProjectId(""); }
          }}>{state.goals.length ? "清除筛选" : "记录第一件事"}</Button>} />}
      </div>
    </div>
  );
}

function rowLabel(goal: Goal) {
  if (isReadOnlyGoal(goal)) return `${goalProgressLabel(goal)} · 只读历史`;
  const destination = goalEntryDestination(goal);
  if (destination === "task") return ["completed", "dropped"].includes(goal.status) ? "查看记录" : goal.status === "backlog" ? "尚未开始" : "由你处理";
  if (destination === "attention") return attentionActionLabel(goal);
  return goalProgressLabel(goal);
}
function rowTone(goal: Goal): BadgeTone {
  if (isReadOnlyGoal(goal)) return "neutral";
  const kind = attentionKind(goal);
  if (kind === "decision") return "accent";
  if (kind === "review") return "mint";
  if (kind === "follow_up" || goal.status === "waiting") return "warm";
  if (kind === "intervention") return "danger";
  return "neutral";
}
