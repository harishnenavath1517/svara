// `/browser`, not the package root: the root barrel reaches node:fs through
// blob.ts, and pulling that into a client bundle breaks `next build`. See
// packages/shared/src/browser.ts.
import { MIC_SAMPLE_RATE, TTS_OUTPUT_SAMPLE_RATE } from "@svara/shared/browser";
import type { FlowConfig, FlowPatch, ServerMessage, TurnEndMessage } from "@svara/shared/browser";

/**
 * The caller's side of the voice loop: mic → gateway → speaker.
 *
 * Two things earn their complexity here.
 *
 * 1. Capture runs in an AudioWorklet at 16kHz, so the audio thread — not the
 *    React render loop — packs the frames the gateway's VAD sees.
 * 2. Playback is a scheduled queue of PCM16 chunks, not an <audio> element.
 *    Chunks arrive while the model is still writing, and barge-in has to stop
 *    them *mid-word*: `stop_audio` kills every scheduled source at once
 *    (guardrail 5). An <audio> element would be a buffered file by then.
 */

export type CallStatus = "idle" | "connecting" | "live" | "ended";

export interface CallHandlers {
  onStatus: (status: CallStatus) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onReply: (text: string) => void;
  onTurnEnd: (turn: TurnEndMessage) => void;
  onError: (message: string) => void;
  /**
   * The flow the gateway *resolved*, on connect and after every `configure`.
   *
   * The `/flow` canvas renders this and never its own optimistic copy. Ask for a
   * bulbul:v2 speaker and what comes back is `shubh`; showing the request instead
   * of the resolution would make the canvas describe a call that didn't happen.
   */
  onFlow?: (flow: FlowConfig, configHash: string) => void;
  /** First audio of a turn reached the speaker. The canvas lights the TTS node here. */
  onAudio?: () => void;
}

export class VoiceCall {
  readonly #handlers: CallHandlers;

  #socket: WebSocket | null = null;
  #mic: AudioContext | null = null;
  #playback: AudioContext | null = null;
  #stream: MediaStream | null = null;

  /** Where the next chunk should start, so the queue plays gapless. */
  #playHead = 0;
  #playing = new Set<AudioBufferSourceNode>();

  constructor(handlers: CallHandlers) {
    this.#handlers = handlers;
  }

  async start(url: string, flow: FlowPatch): Promise<void> {
    this.#handlers.onStatus("connecting");

    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // The graph runs at the rate Saaras wants, so nothing has to resample.
    const mic = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    await mic.audioWorklet.addModule("/pcm-capture.js");
    this.#mic = mic;
    this.#playback = new AudioContext({ sampleRate: TTS_OUTPUT_SAMPLE_RATE });

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start", flow }));
      this.#handlers.onStatus("live");
      this.#pipeMic(mic);
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      this.#onMessage(JSON.parse(event.data) as ServerMessage);
    };
    socket.onerror = () => this.#handlers.onError("gateway connection failed");
    socket.onclose = () => {
      this.#handlers.onStatus("ended");
      void this.stop();
    };
  }

  #pipeMic(mic: AudioContext): void {
    if (this.#stream === null) return;
    const source = mic.createMediaStreamSource(this.#stream);
    const capture = new AudioWorkletNode(mic, "pcm-capture");

    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.#socket?.readyState !== WebSocket.OPEN) return;
      this.#socket.send(toPcm16(event.data));
    };
    source.connect(capture);
    // The worklet emits no audio; connecting it to the destination only keeps
    // some browsers from garbage-collecting the node.
    capture.connect(mic.destination);
  }

  /**
   * Retune the hops. The gateway applies it to the next turn, sanitizes it, and
   * answers with the resolved flow on `onFlow` — which is the only thing the UI
   * should draw.
   */
  configure(flow: FlowPatch): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type: "configure", flow }));
  }

  #onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "ready":
      case "flow_ack":
        this.#handlers.onFlow?.(message.flow, message.config_hash);
        return;
      case "partial":
      case "final":
        this.#handlers.onTranscript(message.text, message.type === "final");
        return;
      case "reply":
        this.#handlers.onReply(message.text);
        return;
      case "audio":
        this.#handlers.onAudio?.();
        this.#enqueue(message.b64);
        return;
      case "stop_audio":
        this.#silence();
        return;
      case "turn_end":
        if (message.error !== null && message.error !== "barged-in") {
          this.#handlers.onError(message.error);
        }
        this.#handlers.onTurnEnd(message);
        return;
    }
  }

  #enqueue(b64: string): void {
    const context = this.#playback;
    if (context === null) return;

    const pcm = decodePcm16(b64);
    const buffer = context.createBuffer(1, pcm.length, TTS_OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, this.#playHead);
    source.start(startAt);
    this.#playHead = startAt + buffer.duration;

    this.#playing.add(source);
    source.onended = () => this.#playing.delete(source);
  }

  /** Barge-in: everything scheduled dies now, including the chunk mid-flight. */
  #silence(): void {
    for (const source of this.#playing) {
      source.onended = null;
      source.stop();
    }
    this.#playing.clear();
    this.#playHead = 0;
  }

  async stop(): Promise<void> {
    this.#silence();
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "stop" }));
      this.#socket.close();
    }
    this.#socket = null;

    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;

    await this.#mic?.close();
    await this.#playback?.close();
    this.#mic = null;
    this.#playback = null;
    this.#handlers.onStatus("ended");
  }
}

/** Float32 [-1,1] → PCM16 little-endian, which is what the gateway and Saaras want. */
function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}

function decodePcm16(b64: string): Float32Array<ArrayBuffer> {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length - (binary.length % 2));
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const pcm = new Int16Array(buffer);
  const samples = new Float32Array(new ArrayBuffer(pcm.length * 4));
  for (let i = 0; i < pcm.length; i += 1) samples[i] = (pcm[i] as number) / 32768;
  return samples;
}
