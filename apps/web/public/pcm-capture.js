/**
 * Mic capture worklet. Runs on the audio thread, so a busy React render can't
 * stall it and drop a word.
 *
 * The graph runs at 16kHz (the AudioContext is constructed at MIC_SAMPLE_RATE),
 * so there is no resampling here: we just pack Float32 samples into 1024-sample
 * frames — 64ms — and post them to the page, which converts to PCM16 and sends.
 */
const FRAME_SAMPLES = 1024;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.frame[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === FRAME_SAMPLES) {
        this.port.postMessage(this.frame.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
