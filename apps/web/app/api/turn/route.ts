import { traceDetail } from "@svara/db";

/**
 * The hop rows a turn actually emitted — what the `/flow` canvas paints onto its
 * nodes once a turn is over.
 *
 * Why go all the way back to Postgres for numbers the browser could have timed
 * itself: because the browser's numbers would be *a different measurement wearing
 * the same units*. The client can see when a transcript arrived, but not when
 * Saaras was first called; it sees nothing at all of a hop that failed before it
 * produced output. `latency_ms` and `ttfb_ms` here are the hop's own clocks, the
 * same rows `/traces` and the eval plane read — so a number on the canvas is a
 * number you can go and argue with.
 *
 * The cost is a lag: the trace travels the hop → Redpanda → sink → Postgres, so
 * it lands a beat after `turn_end`. The canvas polls, and if it never lands it
 * says so rather than drawing zeros. A zero is a claim; a blank is the truth.
 *
 * Takes a trace id and nothing else — same rule as /api/audio: no path from the
 * query string ever reaches storage.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const traceId = new URL(request.url).searchParams.get("trace");

  if (traceId === null) return new Response("trace is required", { status: 400 });
  // `trace_id` is a UUID column: anything else reaches Postgres as a cast error
  // and comes back a 500, which reads like a broken dashboard rather than a bad URL.
  if (!UUID.test(traceId)) return new Response("trace must be a uuid", { status: 400 });

  const { turn, hops } = await traceDetail(traceId);

  return Response.json(
    { turn, hops },
    {
      // The turn may still be in flight, or its traces still in the sink's lag.
      // Caching an empty answer would freeze the canvas on "no traces yet".
      headers: { "cache-control": "no-store" },
    },
  );
}
