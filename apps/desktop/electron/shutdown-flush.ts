/**
 * Waits for existing work without letting a wedged dependency block an app
 * update forever. Callers still keep their durable records; the timeout only
 * decides when shutdown moves on to closing local bridges.
 */
export async function settleAllWithin(
  promises: Iterable<Promise<unknown>>,
  timeoutMs = 8_000,
): Promise<{ settled: boolean }> {
  const pending = [...promises];
  if (!pending.length) return { settled: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.allSettled(pending).then(() => true);
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
  });
  const settled = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return { settled };
}
