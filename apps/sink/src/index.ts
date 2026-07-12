import { closeDb, insertTrace, insertTurn, migrate, pingDb } from "@svara/db";
import { TOPICS, optionalEnv } from "@svara/shared";
import type { TraceEvent, TurnEvent } from "@svara/shared";
import { Kafka, logLevel } from "kafkajs";

/**
 * The trace sink: `svara.traces` / `svara.turns` → Postgres.
 *
 * This is the seam between the two planes. The runtime plane publishes and
 * forgets (guardrail: a trace must never be able to slow down or fail a live
 * call); the eval plane reads at its leisure from a durable log. Which means
 * the sink can be down for an hour, or replayed from the beginning, without
 * anybody losing a turn — and it means Postgres holds nothing the topic can't
 * rebuild.
 *
 * Both writes upsert on the event's natural key, so replay is idempotent:
 *
 *   pnpm --filter @svara/sink run backfill   # re-read from offset 0
 */

const FROM_START = process.argv.includes("--from-start");

const kafka = new Kafka({
  clientId: "svara-sink",
  // 19092 is the host listener; 9092 only resolves inside the compose network.
  brokers: optionalEnv("REDPANDA_BROKERS", "localhost:19092").split(","),
  logLevel: logLevel.ERROR,
});

/**
 * A fresh group id on backfill, because a consumer group remembers its offsets:
 * re-running with the same id would resume from the committed offset and read
 * nothing, which looks exactly like "there were no events".
 */
const groupId = FROM_START ? `svara-sink-backfill-${Date.now()}` : "svara-sink";

const consumer = kafka.consumer({ groupId });

let traces = 0;
let turns = 0;
let malformed = 0;

async function handle(topic: string, raw: string): Promise<void> {
  const event: unknown = JSON.parse(raw);

  if (topic === TOPICS.traces) {
    await insertTrace(event as TraceEvent);
    traces += 1;
  } else if (topic === TOPICS.turns) {
    await insertTurn(event as TurnEvent);
    turns += 1;
  }
}

async function main(): Promise<void> {
  if (!(await pingDb())) {
    console.error(
      "[sink] Postgres unreachable. Run `pnpm infra:up` (DATABASE_URL: " +
        `${optionalEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/svara")}).`,
    );
    process.exit(1);
  }
  // Cheap and idempotent; means a fresh clone can run the sink without a
  // separate migrate step and be surprised by a missing table at 3am.
  await migrate();

  await consumer.connect();
  await consumer.subscribe({
    topics: [TOPICS.traces, TOPICS.turns],
    fromBeginning: FROM_START,
  });

  console.log(
    `[sink] consuming ${TOPICS.traces} + ${TOPICS.turns} as "${groupId}"` +
      `${FROM_START ? " from offset 0" : ""}`,
  );

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const raw = message.value?.toString("utf8");
      if (raw === undefined) return;
      try {
        await handle(topic, raw);
      } catch (err) {
        // Do NOT rethrow: kafkajs would retry this message forever and the
        // partition would stall behind one bad row. A malformed trace is a bug
        // to go fix, not a reason to stop ingesting every trace behind it.
        malformed += 1;
        console.error(`[sink] dropped a malformed ${topic} event:`, err);
      }
    },
  });

  const report = setInterval(() => {
    if (traces + turns + malformed === 0) return;
    console.log(`[sink] ${traces} traces, ${turns} turns, ${malformed} malformed`);
  }, 10_000);
  report.unref();
}

async function shutdown(): Promise<void> {
  console.log(`\n[sink] stopping — ${traces} traces, ${turns} turns, ${malformed} malformed`);
  await consumer.disconnect().catch(() => undefined);
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err: unknown) => {
  console.error("[sink] fatal:", err);
  process.exit(1);
});
