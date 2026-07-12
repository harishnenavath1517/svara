import { optionalEnv } from "@svara/shared";
import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import { TASK_QUEUE, TURN_WORKFLOW } from "./config.js";
import type { TurnArgs, TurnResult } from "./turn.js";

/**
 * The gateway's handle on Temporal: start a turn per utterance, cancel it on
 * barge-in. Started by workflow *name* so this module never loads workflow code.
 */
export async function connectTemporal(): Promise<Client> {
  const connection = await Connection.connect({
    address: optionalEnv("TEMPORAL_ADDRESS", "localhost:7233"),
  });
  return new Client({
    connection,
    namespace: optionalEnv("TEMPORAL_NAMESPACE", "default"),
  });
}

export async function startTurn(
  client: Client,
  args: TurnArgs,
): Promise<WorkflowHandle<(args: TurnArgs) => Promise<TurnResult>>> {
  return client.workflow.start<(args: TurnArgs) => Promise<TurnResult>>(TURN_WORKFLOW, {
    taskQueue: TASK_QUEUE,
    // One workflow per turn, so a replayed utterance can't start two.
    workflowId: `turn-${args.ctx.trace_id}`,
    args: [args],
  });
}
