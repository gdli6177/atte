import { recordHookDiagnostic } from "../../src/hook-diagnostics.js";

for (let index = 0; index < 600; index += 1)
  await recordHookDiagnostic({
    reason: "stdin_epipe",
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
process.exit(0);
