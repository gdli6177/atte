import { MessageSquareText } from "lucide-react";
import type { AgentRuntimeText } from "../../../../../packages/core/src/types.js";

export function GoalAgentLastReply({ reply }: { reply?: AgentRuntimeText }) {
  if (!reply?.text) return null;
  return (
    <section className="goal-handoff attention-agent-reply" aria-label="负责人最近回复">
      <header>
        <span><MessageSquareText size={14} aria-hidden="true" /></span>
        <div>
          <strong>负责人最近回复</strong>
          <small>仅现场观测；目标状态以结构化写回为准</small>
        </div>
      </header>
      <p>{reply.text}</p>
    </section>
  );
}
