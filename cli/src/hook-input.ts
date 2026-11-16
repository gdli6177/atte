import type { Readable } from "node:stream";

export const HOOK_INPUT_MAX_BYTES = 512_000;
export const HOOK_INPUT_TIMEOUT_MS = 2_000;

export type HookInputResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "timeout" | "overflow" | "read_error"; bytes: number };

export interface HookInputOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export function readHookInput(
  stream: Readable = process.stdin,
  options: HookInputOptions = {},
): Promise<HookInputResult> {
  const maxBytes = Math.min(HOOK_INPUT_MAX_BYTES,
    Math.max(0, options.maxBytes ?? HOOK_INPUT_MAX_BYTES));
  const timeoutMs = Math.min(HOOK_INPUT_TIMEOUT_MS,
    Math.max(0, options.timeoutMs ?? HOOK_INPUT_TIMEOUT_MS));
  return new Promise(resolve => {
    let chunks: Buffer[] | undefined = [];
    let bytes = 0;
    let overflow = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finish = (result: HookInputResult) => {
      if (settled) return;
      settled = true;
      chunks = undefined;
      clearTimeout(timer);
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + buffer.length);
      if (bytes > maxBytes) {
        overflow = true;
        chunks = undefined;
      } else if (!overflow) {
        chunks?.push(Buffer.from(buffer));
      }
    };
    const onEnd = () => {
      if (settled) {
        cleanup();
        return;
      }
      let reason: "overflow" | "timeout" | undefined = overflow
        ? "overflow" : chunks === undefined && bytes > maxBytes ? "timeout" : undefined;
      if (!reason && bytes > maxBytes) reason = "overflow";
      finish(reason
        ? { ok: false, reason, bytes }
        : { ok: true, text: Buffer.concat(chunks ?? [], bytes).toString("utf8"), bytes });
      cleanup();
    };
    const onError = () => {
      finish({ ok: false, reason: "read_error", bytes });
      cleanup();
    };
    const onClose = () => {
      finish({ ok: false, reason: "read_error", bytes });
      cleanup();
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", bytes });
      (stream as Readable & { unref?: () => void }).unref?.();
    }, timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.on("error", onError);
    stream.once("close", onClose);
    if (stream.readableEnded) onEnd();
    else if (stream.destroyed) onClose();
    else stream.resume();
  });
}
