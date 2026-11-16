import { createHash } from "node:crypto";

export function receiptReminderDeliveryId(goalId: string, attemptId: string, turnId: string): string {
  const key = createHash("sha256")
    .update(`${goalId}\0${attemptId}\0${turnId}`)
    .digest("hex")
    .slice(0, 32);
  return `receipt-reminder-${key}`;
}
