import test from "node:test";
import assert from "node:assert/strict";
import { receiptReminderDeliveryId } from "../src/index.js";

test("receipt reminder delivery IDs stay isolated across goals, attempts and turns", () => {
  const first = receiptReminderDeliveryId("goal_one", "attempt_one", "turn-1");
  assert.equal(first, receiptReminderDeliveryId("goal_one", "attempt_one", "turn-1"));
  assert.match(first, /^receipt-reminder-[a-f0-9]{32}$/);
  assert.notEqual(first, receiptReminderDeliveryId("goal_two", "attempt_one", "turn-1"));
  assert.notEqual(first, receiptReminderDeliveryId("goal_one", "attempt_two", "turn-1"));
  assert.notEqual(first, receiptReminderDeliveryId("goal_one", "attempt_one", "turn-2"));
});
