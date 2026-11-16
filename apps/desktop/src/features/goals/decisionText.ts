/**
 * Attention summaries arrive from Agents and are often written as one long
 * line with inline options ("…？A 验收通过；B 还要调整；C 先保留"). Break each
 * option onto its own line for display; the stored text is never changed.
 */
const optionSeparator = /([；;。！？!?])\s*(?=[A-Za-z](?:\s|[、.．:：)]))/g;

export function formatDecisionText(value: string): string {
  const text = value.replaceAll("\r\n", "\n").trim();
  if (!text || text.includes("\n")) return text;
  // Only act on real enumerations: at least two inline option labels.
  const optionCount = (text.match(optionSeparator) ?? []).length
    + (/^[A-Za-z](?:\s|[、.．:：)])/.test(text) ? 1 : 0);
  if (optionCount < 2) return text;
  return text
    .replace(optionSeparator, (_match, punctuation: string) => `${punctuation}\n`)
    .split("\n")
    .map(line => line.trim().replace(/[；;]$/, ""))
    .join("\n");
}
