/**
 * Minimal WAV (RIFF/PCM16) encoder and decoder.
 *
 * Both Sarvam streaming hops speak headerless PCM16 mono — Saaras wants 16kHz in,
 * Bulbul emits 24kHz out as `linear16` — precisely so chunks concatenate and play
 * as they land. But a *stored* blob has to be a file something can open, and the
 * golden set has to be re-readable by the eval runner months later. So the header
 * goes on exactly once, at the storage boundary, and comes straight back off when
 * the eval runner feeds the audio to Saaras.
 */

const HEADER_BYTES = 44;

export interface WavAudio {
  /** Interleaved PCM16 little-endian samples. Mono only — every hop here is mono. */
  pcm: Uint8Array;
  sampleRate: number;
}

/** Wraps raw PCM16 mono in a 44-byte RIFF header. */
export function encodeWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true); // file size - 8
  writeAscii(out, 8, "WAVE");

  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(out, 36, "data");
  view.setUint32(40, pcm.byteLength, true);

  out.set(pcm, HEADER_BYTES);
  return out;
}

/**
 * Reads a WAV written by `encodeWav`. Deliberately not a general WAV parser: it
 * walks the chunk table rather than assuming a 44-byte header, because some
 * encoders emit a LIST chunk before `data`, but it rejects anything that isn't
 * mono PCM16 instead of silently mis-decoding it into noise.
 */
export function decodeWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let sampleRate = 0;
  let format = 0;
  let channels = 0;
  let bitsPerSample = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      if (format !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(
          `expected mono PCM16, got format=${format} channels=${channels} bits=${bitsPerSample}`,
        );
      }
      return {
        pcm: bytes.subarray(body, Math.min(body + size, bytes.byteLength)),
        sampleRate,
      };
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

/**
 * Mixes white noise into PCM16 at a target SNR, for the golden set's `noisy`
 * bucket. Synthetic noise at a stated SNR is an honest way to build that bucket
 * from TTS audio — what it is *not* is a substitute for real room noise, and the
 * eval report says so rather than implying we tested a noisy call centre.
 */
export function addNoise(pcm: Uint8Array, snrDb: number, seed = 1): Uint8Array {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);

  let power = 0;
  for (const s of samples) power += s * s;
  power /= Math.max(samples.length, 1);
  if (power === 0) return new Uint8Array(pcm); // silence: nothing to set an SNR against

  const noiseAmplitude = Math.sqrt(power / 10 ** (snrDb / 10));

  const out = new Int16Array(samples.length);
  // Deterministic PRNG (mulberry32): the golden set has to be byte-reproducible,
  // or a rebuild silently changes what "noisy" means and every noisy-slice
  // regression is unfalsifiable.
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < samples.length; i += 1) {
    // Box-Muller for gaussian noise; uniform noise would not sound like a room.
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const mixed = (samples[i] ?? 0) + gaussian * noiseAmplitude;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
  }
  return new Uint8Array(out.buffer);
}

/** Seconds of audio in a PCM16 mono buffer. */
export function pcmDurationSec(pcm: Uint8Array, sampleRate: number): number {
  return pcm.byteLength / 2 / sampleRate;
}

/**
 * Resamples PCM16 mono between rates. Needed in exactly two places, both of
 * which cross a rate boundary that would otherwise corrupt a measurement:
 *
 *  - building the golden set (Bulbul speaks at 24kHz; the gateway's mic capture,
 *    and therefore Saaras, is 16kHz — golden audio must look like caller audio),
 *  - TTS round-trip intelligibility (the agent's own 24kHz voice is fed back
 *    through 16kHz STT).
 *
 * Downsampling low-passes first. Skipping that step is the classic way to get a
 * WER number that is really an aliasing artefact: 24kHz carries content up to
 * 12kHz, and decimating straight to 16kHz folds everything above 8kHz back down
 * *into the speech band* as garbage. The filter is a windowed sinc — modest, but
 * the difference between measuring a model and measuring your own arithmetic.
 */
export function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return new Uint8Array(pcm);

  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const source = fromRate > toRate ? lowPass(input, toRate / 2, fromRate) : input;

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    // Linear interpolation between the two neighbouring source samples. The
    // anti-alias filter above has already removed what this can't represent.
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, source.length - 1);
    const frac = position - left;
    const value = (source[left] ?? 0) * (1 - frac) + (source[right] ?? 0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return new Uint8Array(out.buffer);
}

/** Windowed-sinc (Hann) FIR low-pass. Odd tap count, so the delay is symmetric. */
function lowPass(input: Int16Array, cutoffHz: number, sampleRate: number): Int16Array {
  const taps = 31;
  const half = (taps - 1) / 2;
  const fc = cutoffHz / sampleRate; // normalized cutoff, cycles/sample

  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - half;
    // sinc(2*fc*n), with the n=0 singularity taken as its limit.
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * hann;
    sum += kernel[i] ?? 0;
  }
  // Normalize to unity DC gain, or the filter quietly changes the signal's level
  // and every downstream energy/SNR calculation inherits the error.
  for (let i = 0; i < taps; i += 1) kernel[i] = (kernel[i] ?? 0) / sum;

  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let acc = 0;
    for (let k = 0; k < taps; k += 1) {
      const j = i + k - half;
      // Zero-pad at the edges; the tails are silence in practice.
      if (j >= 0 && j < input.length) acc += (input[j] ?? 0) * (kernel[k] ?? 0);
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}

function readAscii(source: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(source[offset + i] ?? 0);
  return text;
}
