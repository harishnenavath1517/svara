import type { LanguageCode, Transcript } from "@svara/shared";

/**
 * The turn bus: how one hop's output reaches the next hop while it is still
 * being produced.
 *
 * The three hops of a turn run as three *concurrent* activities, not a
 * sequence. `transcribe` pushes transcripts onto the bus; `respond` starts
 * generating the moment the transcript is final and pushes sentences on as it
 * writes them; `synthesize` is already listening and speaks sentence 1 while the
 * model writes sentence 2. That overlap is the 800ms budget (guardrail 3).
 *
 * Channels replay from the start for every subscriber, so a retried activity
 * re-reads its input instead of hanging on an already-drained stream.
 *
 * Scope: this bus lives inside one worker process. The three activities of a
 * turn must therefore land on the same worker — true today (one worker) and in
 * `pnpm dev`. Running multiple workers means moving these channels onto Redis or
 * NATS, or pinning a turn with a Temporal worker session. Do that before you
 * scale the worker out, not after.
 */
class Channel<T> {
  #items: T[] = [];
  #closed = false;
  #failure: unknown = null;
  #waiters: Array<() => void> = [];

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  fail(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = reason;
    this.#wake();
  }

  #wake(): void {
    for (const wake of this.#waiters) wake();
    this.#waiters = [];
  }

  /** Replays everything pushed so far, then follows the stream live. */
  async *subscribe(): AsyncIterable<T> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.#items.length) {
        yield this.#items[cursor] as T;
        cursor += 1;
      }
      if (this.#failure !== null) throw this.#failure;
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

/** Resolves once STT has identified the language — TTS can't speak "unknown". */
class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }
}

/** Why a hop stopped early. `code` is what lands in the trace event. */
export class TurnCancelled extends Error {
  readonly code = "cancelled";

  constructor(reason = "barge-in") {
    super(reason);
    this.name = "TurnCancelled";
  }
}

export interface TurnBus {
  /** STT → LLM. Partials as they land; the last one is `isFinal`. */
  transcripts: Channel<Transcript>;
  /** LLM → TTS. One item per speakable sentence. */
  sentences: Channel<string>;
  /** STT → TTS. The language the caller actually spoke. */
  lang: Deferred<LanguageCode>;
  /**
   * Barge-in, in band. Every hop's Sarvam socket is wired to this signal.
   *
   * Temporal's own cancellation cannot carry barge-in: it reaches an activity
   * only on the *response to a heartbeat*, and heartbeats are throttled to ~80%
   * of `heartbeatTimeout`. Measured, that left a cancelled turn's TTS streaming
   * for another five seconds — inaudible to the caller (the gateway drops the
   * frames) but still burning Sarvam credits and still tracing as a clean turn.
   * So the gateway sends a `cancel` frame straight down the internal channel and
   * we abort here, in the worker, in microseconds. Temporal cancellation still
   * runs behind it and cleans up the workflow.
   */
  abort: AbortController;
}

const buses = new Map<string, TurnBus>();

/** One bus per turn, created by whichever activity gets there first. */
export function turnBus(traceId: string): TurnBus {
  let bus = buses.get(traceId);
  if (bus === undefined) {
    bus = {
      transcripts: new Channel<Transcript>(),
      sentences: new Channel<string>(),
      lang: new Deferred<LanguageCode>(),
      abort: new AbortController(),
    };
    buses.set(traceId, bus);
  }
  return bus;
}

/**
 * Stop every hop of this turn now. Called on barge-in, before Temporal has even
 * heard about it. No-op if the turn already finished.
 */
export function cancelTurn(traceId: string, reason?: string): void {
  const bus = buses.get(traceId);
  if (bus === undefined || bus.abort.signal.aborted) return;
  bus.abort.abort(new TurnCancelled(reason));
}

/** Call when the turn is over — cancelled or complete — or the map leaks. */
export function disposeTurnBus(traceId: string): void {
  const bus = buses.get(traceId);
  if (bus === undefined) return;
  bus.transcripts.close();
  bus.sentences.close();
  buses.delete(traceId);
}
