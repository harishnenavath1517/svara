import { AsyncQueue } from "@svara/sarvam";
import { optionalEnv } from "@svara/shared";
import WebSocket from "ws";
import { cancelTurn } from "./bus.js";
import { INTERNAL_WS_PATH, type GatewayFrame, type WorkerFrame } from "./protocol.js";

/**
 * The worker's end of the internal channel (see protocol.ts). One socket for the
 * whole worker, multiplexed by trace_id: audio frames come down, transcripts and
 * synthesized audio go back up.
 *
 * The worker dials the gateway (not the other way around) so the gateway stays a
 * plain server and the worker can be restarted freely — it reconnects.
 */
class GatewayChannel {
  readonly #url: string;
  #socket: WebSocket | null = null;
  #reconnectMs = 500;
  #audio = new Map<string, AsyncQueue<Uint8Array>>();
  /** Turns whose audio already ended, so a late subscriber doesn't hang. */
  #ended = new Set<string>();

  constructor(url: string) {
    this.#url = url;
  }

  connect(): void {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.on("open", () => {
      this.#reconnectMs = 500;
      console.log(`[worker] gateway channel open: ${this.#url}`);
    });
    socket.on("message", (raw: Buffer) => {
      try {
        this.#onFrame(JSON.parse(raw.toString("utf8")) as GatewayFrame);
      } catch (err) {
        console.error("[worker] bad gateway frame:", err);
      }
    });
    socket.on("error", (err) => console.error("[worker] gateway channel error:", err.message));
    socket.on("close", () => {
      this.#socket = null;
      const delay = this.#reconnectMs;
      this.#reconnectMs = Math.min(delay * 2, 10_000);
      console.warn(`[worker] gateway channel closed; retrying in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });
  }

  #onFrame(frame: GatewayFrame): void {
    if (frame.t === "audio") {
      this.#queue(frame.trace_id).push(new Uint8Array(Buffer.from(frame.b64, "base64")));
      return;
    }
    if (frame.t === "cancel") {
      // Barge-in. Aborts the hops' Sarvam sockets in-process, right now.
      cancelTurn(frame.trace_id);
      this.discard(frame.trace_id);
      return;
    }
    // audio_end: the caller stopped speaking. Ending the stream is what makes
    // the STT hop flush and produce its final transcript.
    this.#ended.add(frame.trace_id);
    this.#queue(frame.trace_id).close();
    this.#audio.delete(frame.trace_id);
  }

  #queue(traceId: string): AsyncQueue<Uint8Array> {
    let queue = this.#audio.get(traceId);
    if (queue === undefined) {
      queue = new AsyncQueue<Uint8Array>();
      if (this.#ended.has(traceId)) queue.close();
      else this.#audio.set(traceId, queue);
    }
    return queue;
  }

  /** The caller's audio for one turn. Ends at the VAD endpoint. */
  audioStream(traceId: string): AsyncIterable<Uint8Array> {
    return this.#queue(traceId);
  }

  /** Drop the buffered audio of a turn the workflow abandoned. */
  discard(traceId: string): void {
    this.#audio.get(traceId)?.close();
    this.#audio.delete(traceId);
    this.#ended.delete(traceId);
  }

  send(frame: WorkerFrame): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      console.warn(`[worker] dropped ${frame.t} frame: gateway channel is down`);
      return;
    }
    this.#socket.send(JSON.stringify(frame));
  }
}

let channel: GatewayChannel | null = null;

export function gatewayChannel(): GatewayChannel {
  if (channel === null) {
    const base = optionalEnv("GATEWAY_INTERNAL_WS_URL", "ws://localhost:8787");
    channel = new GatewayChannel(`${base}${INTERNAL_WS_PATH}`);
    channel.connect();
  }
  return channel;
}
