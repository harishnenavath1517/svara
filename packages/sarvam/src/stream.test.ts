import { describe, expect, it } from "vitest";
import { AsyncQueue, sentences } from "./stream.js";

async function* tokens(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

describe("sentences", () => {
  it("emits a sentence as soon as it closes, without waiting for the rest", async () => {
    const stream = sentences(tokens("Aap is yojana", " ke liye eligible hain.", " Aage kya"));
    const iterator = stream[Symbol.asyncIterator]();

    // The first sentence must be speakable before the model has finished writing.
    await expect(iterator.next()).resolves.toEqual({
      value: "Aap is yojana ke liye eligible hain.",
      done: false,
    });
  });

  it("splits on the Devanagari danda", async () => {
    const out = await collect(sentences(tokens("आप पात्र हैं। अब आवेदन करें।")));
    expect(out).toEqual(["आप पात्र हैं।", "अब आवेदन करें।"]);
  });

  it("keeps decimals in one sentence", async () => {
    const out = await collect(sentences(tokens("Aapko 12.5 percent subsidy milegi.")));
    expect(out).toEqual(["Aapko 12.5 percent subsidy milegi."]);
  });

  it("flushes the tail even when the reply ends without punctuation", async () => {
    const out = await collect(sentences(tokens("Ek minute")));
    expect(out).toEqual(["Ek minute"]);
  });
});

describe("AsyncQueue", () => {
  it("delivers items pushed before and after the consumer starts pulling", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const collected = collect(queue);
    queue.push(2);
    queue.close();
    await expect(collected).resolves.toEqual([1, 2]);
  });

  it("surfaces a failure to the consumer instead of ending cleanly", async () => {
    const queue = new AsyncQueue<number>();
    const collected = collect(queue);
    queue.fail(new Error("stt socket died"));
    await expect(collected).rejects.toThrow("stt socket died");
  });
});
