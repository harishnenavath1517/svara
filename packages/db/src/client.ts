import { optionalEnv } from "@svara/shared";
import pg from "pg";

/**
 * Postgres access for the eval plane. One lazily-created pool per process,
 * shared by the trace sink (writes traces/turns), the eval runner (writes
 * eval_runs/eval_scores, reads traces for latency), and the Phase 3 dashboard.
 *
 * Locally this is the `svara` database in infra/docker-compose.yml. In
 * production it is Supabase — same SQL, different DATABASE_URL.
 */

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  pool ??= new Pool({
    connectionString: optionalEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@localhost:5432/svara",
    ),
    // The sink is the only long-lived writer; the eval runner is a short CLI.
    // A small pool keeps a failed connection loud instead of queueing forever.
    max: 8,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** True when Postgres is reachable. The eval runner refuses to score without it. */
export async function pingDb(): Promise<boolean> {
  try {
    await db().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
