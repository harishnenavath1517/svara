/**
 * Streaming primitives shared by every hop. Nothing here knows about Sarvam —
 * it's the plumbing that lets a hop start work before the previous one finished
 * (guardrail 3 in CLAUDE.md).
 */

/**
 * A push-driven async iterable. Producers push as fast as they like; the
 * consumer pulls. Unbounded on purpose: an audio frame dropped for backpressure
 * is a word lost from the transcript.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #rejecters: Array<(reason: unknown) => void> = [];
  #closed = false;
  #failure: unknown = null;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    this.#rejecters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  /** No more items. Consumers drain what's buffered, then finish. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ value: undefined, done: true });
    this.#waiters = [];
    this.#rejecters = [];
  }

  /** Abnormal end: consumers see the error rather than a clean finish. */
  fail(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = reason;
    for (const reject of this.#rejecters) reject(reason);
    this.#waiters = [];
    this.#rejecters = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T;
        continue;
      }
      if (this.#failure !== null) throw this.#failure;
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.#waiters.push(resolve);
        this.#rejecters.push(reject);
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}

/** Rejects as soon as `signal` aborts. Race it against any long await. */
export function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

/** Sentence-final punctuation, including the Devanagari danda and its double. */
const SENTENCE_END = /[.!?।॥]/;
/** Long clauses get flushed at a comma so TTS isn't starved on a rambling sentence. */
const CLAUSE_END = /[,;:—]/;
const MIN_SENTENCE_CHARS = 12;
const MAX_CLAUSE_CHARS = 160;

/**
 * Re-chunks an LLM token stream into speakable sentences, yielding each one the
 * moment it closes. This is what lets TTS start on sentence 1 while the model is
 * still writing sentence 2 — buffering the full reply blows the 800ms budget.
 */
export async function* sentences(tokens: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const token of tokens) {
    buffer += token;
    for (;;) {
      const cut = cutPoint(buffer);
      if (cut === null) break;
      const sentence = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      if (sentence.length > 0) yield sentence;
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}

/** Index to cut at (exclusive), or null if the buffer holds no complete unit yet. */
function cutPoint(buffer: string): number | null {
  for (let i = 0; i < buffer.length; i += 1) {
    const char = buffer[i] as string;
    if (SENTENCE_END.test(char) && i + 1 >= MIN_SENTENCE_CHARS) {
      // "12.5%" and "3.2 lakh" are one sentence, not two: a digit either side
      // of a period means it's a decimal point.
      const prev = buffer[i - 1];
      const next = buffer[i + 1];
      if (char === "." && prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next)) {
        continue;
      }
      return i + 1;
    }
    if (CLAUSE_END.test(char) && i + 1 >= MAX_CLAUSE_CHARS) return i + 1;
  }
  return null;
}
