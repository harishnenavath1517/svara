import { fileURLToPath } from "node:url";
import { optionalEnv } from "@svara/shared";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { TASK_QUEUE } from "./config.js";
import { gatewayChannel } from "./gateway-channel.js";
import { closeTraceProducer } from "./trace.js";

/**
 * The Temporal worker: runs the turn workflow and the three hop activities.
 * Started by `pnpm dev` alongside the gateway and the web app.
 *
 * It dials the gateway's internal channel first — activities read caller audio
 * and write synthesized audio over it (see protocol.ts).
 */
async function main(): Promise<void> {
  gatewayChannel();

  const connection = await NativeConnection.connect({
    address: optionalEnv("TEMPORAL_ADDRESS", "localhost:7233"),
  });

  const worker = await Worker.create({
    connection,
    namespace: optionalEnv("TEMPORAL_NAMESPACE", "default"),
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });

  console.log(`svara worker listening on task queue "${TASK_QUEUE}"`);
  await worker.run();
}

main()
  .catch((err: unknown) => {
    console.error("[worker] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => closeTraceProducer());
