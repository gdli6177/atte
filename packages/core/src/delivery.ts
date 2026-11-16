import type { EvidenceKind } from "./types.js";

export const EVIDENCE_KINDS = ["command", "artifact", "url", "attachment", "inspection"] as const;

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return EVIDENCE_KINDS.includes(value as EvidenceKind);
}
