import { randomUUID } from "node:crypto";
import {
  configHashOf,
  emitTurn,
  serverDefaultFlow,
  startTurn,
  turnContext,
  type GatewayFrame,
  type WorkerFrame,
} from "@svara/orchestrator";
import { MIC_SAMPLE_RATE, sanitizeFlow } from "@svara/shared";
import type {
  ChatMessage,
  FlowConfig,
  FlowPatch,
  ServerMessage,
  StartMessage,
  TraceLanguage,
} from "@svara/shared";
import type { Client, WorkflowHandle } from "@temporalio/client";
import type { WebSocket } from "ws";
import { Vad } from "./vad.js";

/**
 * One call. Holds the caller's socket, the conversation history, and at most one
 * turn in flight.
 *
 * The gateway is the stream broker: caller audio comes in here, gets VAD'd, and
 * is forwarded to the worker's activities frame by frame; transcripts and
 * synthesized audio come back the other way. Temporal owns the turn's lifecycle,
 * not its bytes (see packages/orchestrator/src/protocol.ts).
 */

/** Frames kept before speech-start, so the first word isn't clipped off the turn. */
const PREROLL_FRAMES = 6;

interface ActiveTurn {
  traceId: string;
  handle: Promise<WorkflowHandle>;
  /**
   * The flow this turn was started with, and the hash its traces already carry.
   * Frozen at `#beginTurn`: a `configure` that lands mid-turn must not retune the
   * hops that are already running, because their traces have already made a claim
   * about which configuration produced them.
   */
  flow: FlowConfig;
  startedAt: number;
  /** When VAD closed the mic. First-audio latency is measured from here. */
  micClosedAt: number | null;
  firstAudioAt: number | null;
  transcript: string;
  reply: string;
  lang: TraceLanguage;
  cancelled: boolean;
}

export class Session {
  readonly id = randomUUID();

  readonly #socket: WebSocket;
  readonly #temporal: Client;
  readonly #toWorker: (frame: GatewayFrame) => void;

  readonly #vad = new Vad(MIC_SAMPLE_RATE);
  readonly #history: ChatMessage[] = [];
  readonly #preroll: Buffer[] = [];

  /** The flow the *next* turn will run with, and its hash. Always server-resolved. */
  #flow: FlowConfig = serverDefaultFlow();
  #configHash: string = configHashOf(this.#flow);
  #turnIndex = 0;
  #turn: ActiveTurn | null = null;
  #started = false;

  constructor(socket: WebSocket, temporal: Client, toWorker: (frame: GatewayFrame) => void) {
    this.#socket = socket;
    this.#temporal = temporal;
    this.#toWorker = toWorker;
  }

  onStart(message: StartMessage): void {
    // `lang` is sugar for flow.stt.lang, kept because most callers set only that.
    // The explicit flow wins when both are present: it is the more specific claim.
    const lang: TraceLanguage | undefined = message.flow?.stt?.lang ?? message.lang;
    this.#applyFlow({
      ...message.flow,
      stt: { ...message.flow?.stt, ...(lang === undefined ? {} : { lang }) },
    });
    this.#started = true;
    this.#send({ type: "ready", session_id: this.id, flow: this.#flow, config_hash: this.#configHash });
  }

  /**
   * Retune the hops from the `/flow` canvas. Takes effect on the next turn — a
   * turn already in flight keeps the flow it was started with (see ActiveTurn).
   */
  onConfigure(patch: FlowPatch): void {
    this.#applyFlow(patch);
    this.#send({ type: "flow_ack", flow: this.#flow, config_hash: this.#configHash });
  }

  /**
   * The one door config comes through, and the only place the hash is computed.
   *
   * The client's patch is a *request*, never a setting: it is resolved against the
   * server's default, and what comes back out is echoed to the client so the
   * canvas renders the flow that will actually run rather than the one it asked
   * for. The hash is recomputed here, next to the flow it describes, because the
   * two drifting apart is the failure this whole feature has to not have.
   */
  #applyFlow(patch: FlowPatch): void {
    this.#flow = sanitizeFlow(patch, serverDefaultFlow());
    this.#configHash = configHashOf(this.#flow);
  }

  /** A PCM16 frame from the caller's mic. This is the hot path — keep it cheap. */
  onAudio(chunk: Buffer): void {
    if (!this.#started) return;

    const event = this.#vad.push(toInt16(chunk));

    if (event === "speech-start") {
      // The caller talking over the agent *is* barge-in. Kill the reply first,
      // then let the new utterance start its own turn.
      if (this.#turn !== null) this.#bargeIn();
      this.#beginTurn();
      for (const frame of this.#preroll) this.#forwardAudio(frame);
    }

    this.#preroll.push(chunk);
    if (this.#preroll.length > PREROLL_FRAMES) this.#preroll.shift();

    if (this.#turn !== null && this.#turn.micClosedAt === null) this.#forwardAudio(chunk);

    if (event === "speech-end" && this.#turn !== null) {
      this.#turn.micClosedAt = Date.now();
      // Ending the audio stream is what makes Saaras flush and finalize — which
      // is what unblocks the LLM hop. Without this the turn hangs on its timeout.
      this.#toWorker({ t: "audio_end", trace_id: this.#turn.traceId });
    }
  }

  /** Transcripts, reply tokens, and synthesized audio coming back from the worker. */
  onWorkerFrame(frame: WorkerFrame): void {
    const turn = this.#turn;
    // A frame from a turn we already cancelled. Dropping it here is what makes
    // barge-in feel instant: we don't wait for cancellation to reach the worker.
    if (turn === null || turn.traceId !== frame.trace_id) return;

    switch (frame.t) {
      case "partial":
      case "final":
        turn.transcript = frame.text;
        turn.lang = frame.lang;
        this.#send({ type: frame.t, trace_id: frame.trace_id, text: frame.text, lang: frame.lang });
        return;
      case "token":
        turn.reply = frame.text;
        this.#send({ type: "reply", trace_id: frame.trace_id, text: frame.text });
        return;
      case "reply":
        turn.reply = frame.text;
        turn.lang = frame.lang;
        return;
      case "tts_audio":
        turn.firstAudioAt ??= Date.now();
        this.#send({ type: "audio", trace_id: frame.trace_id, b64: frame.b64 });
        return;
    }
  }

  close(): void {
    if (this.#turn !== null) this.#bargeIn();
  }

  #beginTurn(): void {
    const traceId = randomUUID();
    // Snapshot both, together. The turn's traces will claim this hash, so they
    // have to be produced by this flow — a `configure` arriving one frame later
    // must not be able to slide in between them.
    const flow = this.#flow;
    const ctx = turnContext(this.id, traceId, this.#turnIndex, this.#configHash);
    this.#turnIndex += 1;

    const turn: ActiveTurn = {
      traceId,
      flow,
      startedAt: Date.now(),
      micClosedAt: null,
      firstAudioAt: null,
      transcript: "",
      reply: "",
      lang: flow.stt.lang,
      cancelled: false,
      handle: startTurn(this.#temporal, { ctx, flow, history: [...this.#history] }),
    };
    this.#turn = turn;

    void this.#awaitTurn(turn);
  }

  async #awaitTurn(turn: ActiveTurn): Promise<void> {
    let error: string | null = null;
    try {
      const handle = await turn.handle;
      await handle.result();
    } catch (err) {
      error = turn.cancelled ? "barged-in" : err instanceof Error ? err.message : String(err);
    }

    const ok = error === null;
    if (ok && turn.transcript.length > 0) {
      this.#history.push({ role: "user", content: turn.transcript });
      if (turn.reply.length > 0) this.#history.push({ role: "assistant", content: turn.reply });
    }

    const firstAudioMs =
      turn.firstAudioAt !== null && turn.micClosedAt !== null
        ? turn.firstAudioAt - turn.micClosedAt
        : null;
    const totalMs = Date.now() - turn.startedAt;

    emitTurn({
      trace_id: turn.traceId,
      session_id: this.id,
      turn_index: this.#turnIndex - 1,
      lang: turn.lang,
      total_latency_ms: totalMs,
      first_audio_ms: firstAudioMs,
      ok,
    });

    this.#send({
      type: "turn_end",
      trace_id: turn.traceId,
      ok,
      first_audio_ms: firstAudioMs,
      total_latency_ms: totalMs,
      lang: turn.lang,
      error,
    });

    // A newer turn may already have replaced this one (that's barge-in).
    if (this.#turn === turn) this.#turn = null;
  }

  /**
   * Barge-in (guardrail 5). Three things, in this order, because each is slower
   * than the last:
   *
   *  1. Stop the caller's playback. Instant, and it's what they actually hear.
   *  2. Abort the hops in-band, over the worker channel. Milliseconds, and it's
   *     what stops us paying Sarvam to synthesize a reply nobody will hear.
   *  3. Cancel the workflow. A round trip to Temporal — correct, but far too slow
   *     to be the thing barge-in depends on.
   */
  #bargeIn(): void {
    const turn = this.#turn;
    if (turn === null) return;
    turn.cancelled = true;
    this.#turn = null;

    this.#send({ type: "stop_audio", trace_id: turn.traceId });
    this.#toWorker({ t: "cancel", trace_id: turn.traceId });
    void turn.handle
      .then((handle) => handle.cancel())
      .catch((err: unknown) => console.warn(`[gateway] cancel ${turn.traceId} failed:`, err));
  }

  #forwardAudio(chunk: Buffer): void {
    if (this.#turn === null) return;
    this.#toWorker({
      t: "audio",
      trace_id: this.#turn.traceId,
      session_id: this.id,
      b64: chunk.toString("base64"),
    });
  }

  #send(message: ServerMessage): void {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }
}

function toInt16(chunk: Buffer): Int16Array {
  // Buffer may not be 2-byte aligned in its own pool, so copy rather than view.
  const aligned = new ArrayBuffer(chunk.byteLength - (chunk.byteLength % 2));
  new Uint8Array(aligned).set(chunk.subarray(0, aligned.byteLength));
  return new Int16Array(aligned);
}
