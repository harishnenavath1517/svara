import { traceDetail } from "@svara/db";
import { getAudio } from "@svara/shared";

/**
 * Serves the audio a trace already stored — the caller's utterance and the
 * agent's reply, straight out of the blob store. Nothing is re-synthesized: the
 * whole point of a drill-down is to hear *what actually happened on that turn*,
 * and a fresh TTS call would be a different turn wearing its clothes.
 *
 * **The route takes a trace id, never a path.** The obvious design — `?ref=<key>`
 * — hands an arbitrary filesystem key to a file reader over HTTP, and `getAudio`
 * reads absolute paths by design (that is how the golden set refers to files in
 * the repo), so `?ref=C:\Users\…\.env` would be served cheerfully. Instead the ref
 * is looked up in Postgres from the trace, which means the only files this route
 * can ever return are files a hop actually wrote. There is no path in the query
 * string to traverse.
 */

const HOPS = new Set(["stt", "tts"]);
const DIRECTIONS = new Set(["in", "out"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const traceId = url.searchParams.get("trace");
  const hop = url.searchParams.get("hop");
  const direction = url.searchParams.get("dir");

  if (traceId === null || hop === null || direction === null) {
    return new Response("trace, hop and dir are required", { status: 400 });
  }
  // `trace_id` is a UUID column: anything else reaches Postgres as a cast error and
  // comes back a 500, which reads like a broken dashboard rather than a bad URL.
  if (!UUID.test(traceId)) {
    return new Response("trace must be a uuid", { status: 400 });
  }
  if (!HOPS.has(hop) || !DIRECTIONS.has(direction)) {
    return new Response("only stt/tts and in/out carry audio", { status: 400 });
  }

  const { hops } = await traceDetail(traceId);
  const row = hops.find((h) => h.hop === hop);
  if (row === undefined) {
    return new Response("no such hop on this trace", { status: 404 });
  }

  const ref = direction === "in" ? row.input_ref : row.output_ref;
  if (ref === null) {
    // A hop with no blob is a fact, not an error: `putAudio` is best-effort and
    // never fails a live call to store audio (packages/shared/src/blob.ts).
    return new Response("this hop stored no audio", { status: 404 });
  }

  try {
    const bytes = await getAudio(ref);
    // Uint8Array is a valid BodyInit; the copy keeps TS happy about ArrayBufferLike.
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "audio/wav",
        "content-length": String(bytes.byteLength),
        // Trace audio is immutable — the turn already happened.
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    // The ref is in Postgres and the blob is not on disk: a dangling reference.
    // Say so plainly rather than 500ing — this is exactly the failure mode the
    // repo-root anchoring in blob.ts exists to prevent, and if it ever comes back
    // the drill-down should name it.
    return new Response(`blob missing for ref ${ref} — dangling reference`, { status: 410 });
  }
}
