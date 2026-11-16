import { ArrowRight, ArrowUpRight, Check, CircleAlert, Clock3, Sparkles, Zap } from "lucide-react";
import type { Goal, WorkspaceState } from "../../../../../packages/core/src/types.js";
import { BrandMark, Button, EmptyState, SectionHeading } from "../../ui/index.js";
import { attentionOverview } from "./attentionOverview.js";
import { goalEntryDestination, hasGoalScene } from "./goalEntry.js";
import { sceneSyncPresentation, time } from "./goalPresentation.js";

export function attentionActionLabel(goal: Goal) {
  const destination = goalEntryDestination(goal);
  if (destination === "details") return "查看记录";
  if (goal.status === "review") return "查看并验收";
  if (goal.attention?.kind === "decision") return "作出决定";
  if (goal.attention?.source === "dispatch") return "恢复联系";
  if (destination === "scene") return "进入现场";
  return "查看并处理";
}

export function AttentionHome({ state, open, showItems }: {
  state: WorkspaceState;
  open: (goalId: string) => void;
  showItems: (filter: string) => void;
}) {
  const { attention, groups, waiting, active, nextReminder } = attentionOverview(state.goals);
  return (
    <div className="content home">
      <section className="intro"><div>
        <span className="eyebrow">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span>
        <h1>{attention.length ? <>把注意力，<em>留给真正重要的事。</em></> : <>现在，<em>可以安心了。</em></>}</h1>
        <p>{attention.length ? `有 ${attention.length} 件事需要你。其余的事，管家会继续推进。` : "该你处理的事已经清零。去专注于你想做的事吧。"}</p>
      </div><div className="pixel-scene" aria-hidden="true"><BrandMark variant="mascot" decorative /></div></section>
      {!attention.length && <EmptyState inline tone="mint" icon={<Sparkles size={18} />}
        title="此刻，没有等你处理的事。" description="内部进展不会打扰你。真正需要决定、验收、跟进或介入时，再告诉你。" />}
      <div className="attention-groups">
        {groups.map(category => <section className="attention-section" key={category.kind} aria-labelledby={`attention-${category.kind}`}>
          <SectionHeading title={<span id={`attention-${category.kind}`}>{category.title}</span>} count={category.goals.length} />
          {category.goals.length ? <div className="attention-list">{category.goals.map(goal => {
            const sceneSync = sceneSyncPresentation(goal);
            return <button type="button" className={`attention-card ${category.kind}`} key={goal.id} onClick={() => open(goal.id)}>
              <span className="attention-symbol">{category.kind === "review" ? <Check /> : category.kind === "follow_up" ? <Clock3 />
                : category.kind === "intervention" ? <CircleAlert /> : <Zap />}</span>
              <div><span className="card-label">{state.projects.find(project => project.id === goal.projectId)?.name ?? "个人事项"}
                {" · "}{sceneSync?.label || (category.kind === "intervention" && !hasGoalScene(goal) ? "需要你处理" : category.title)}</span>
                <h3>{goal.title}</h3><p>{sceneSync?.summary || goal.attention?.summary || goal.next}</p></div>
              <span className="card-link"><span className="card-link-label">{attentionActionLabel(goal)}</span><ArrowRight size={15} /></span>
            </button>;
          })}</div> : <p className="attention-empty">{category.empty}</p>}
        </section>)}
      </div>
      {waiting.length > 0 && <section className="waiting-overview" aria-label="等待外部概览">
        <Clock3 size={18} aria-hidden="true" /><div><strong>{waiting.length} 件等待外部</strong>
          <p>{nextReminder ? `下次跟进提醒：${time(nextReminder)}` : "收到结果或到期提醒时，再带回你的注意力。"}</p></div>
        <Button variant="ghost" size="sm" trailing={<ArrowUpRight size={13} />} onClick={() => showItems("waiting")}>查看等待事项</Button>
      </section>}
      {active.length > 0 && <div className="running"><span className="pulse" />
        <span><strong>{active.length} 件事项</strong>由管家跟进</span><span>·</span>
        <span>{active.some(goal => goal.recovery) ? "空闲结果正在核对" : "有需要时再打扰你"}</span>
        <Button variant="ghost" size="sm" trailing={<ArrowUpRight size={13} />} onClick={() => showItems("active")}>查看进展</Button>
      </div>}
    </div>
  );
}
