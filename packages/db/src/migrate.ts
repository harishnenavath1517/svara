import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { closeDb, db } from "./client.js";

/**
 * Applies schema.sql. Every statement in it is `CREATE ... IF NOT EXISTS`, so
 * this is idempotent and safe to run on every boot — there is no migration
 * ledger because there is nothing here that can't be rebuilt from the event
 * stream. When a column has to change shape, replay the sink from offset 0.
 */
export async function migrate(): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await db().query(sql);
}

// `pnpm db:migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await migrate();
    console.log("[db] schema applied");
  } catch (err) {
    console.error("[db] migration failed:", err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
