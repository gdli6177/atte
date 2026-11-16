import { ingestAgentHook } from "../../src/hook-ingest.js";

const args = process.argv.slice(2);
void ingestAgentHook({
  adapter: args[args.indexOf("--adapter") + 1] ?? "",
}).then(result => {
  if (args.includes("--result")) console.log(JSON.stringify(result));
  process.exitCode = 0;
}).catch(() => { process.exitCode = 0; });
