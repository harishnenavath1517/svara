import { describe, expect, it } from "vitest";
import { addNoise, decodeWav, encodeWav, pcmDurationSec } from "./wav.js";

/** A short PCM16 mono tone — enough to have real signal power for the SNR maths. */
function tone(samples: number, amplitude = 8000, sampleRate = 16000): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  return new Uint8Array(pcm.buffer);
}

describe("encodeWav / decodeWav", () => {
  it("round-trips PCM bytes and sample rate unchanged", () => {
    const pcm = tone(1600);
    const decoded = decodeWav(encodeWav(pcm, 16000));

    expect(decoded.sampleRate).toBe(16000);
    expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));
  });

  it("round-trips Bulbul's 24kHz output rate", () => {
    // A hard-coded 16000 here would resample the agent's own voice on the way
    // into the round-trip intelligibility scorer and read as a TTS regression.
    const decoded = decodeWav(encodeWav(tone(2400, 8000, 24000), 24000));
    expect(decoded.sampleRate).toBe(24000);
  });

  it("writes a 44-byte header and no more", () => {
    const pcm = tone(100);
    expect(encodeWav(pcm, 16000).byteLength).toBe(44 + pcm.byteLength);
  });

  it("rejects bytes that are not RIFF/WAVE", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
  });

  it("computes duration from the sample rate", () => {
    expect(pcmDurationSec(tone(16000), 16000)).toBeCloseTo(1.0, 6);
  });
});

describe("addNoise", () => {
  it("is deterministic for a given seed, so a golden-set rebuild is reproducible", () => {
    const pcm = tone(4000);
    expect(Array.from(addNoise(pcm, 10, 42))).toEqual(Array.from(addNoise(pcm, 10, 42)));
  });

  it("hits the requested SNR within a reasonable tolerance", () => {
    const pcm = tone(32000);
    const noisy = addNoise(pcm, 10, 7);

    const clean = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    const mixed = new Int16Array(noisy.buffer, noisy.byteOffset, noisy.byteLength / 2);

    let signal = 0;
    let noise = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const c = clean[i] ?? 0;
      const d = (mixed[i] ?? 0) - c;
      signal += c * c;
      noise += d * d;
    }
    const measuredSnr = 10 * Math.log10(signal / noise);
    // Clipping at the int16 rail biases this slightly; ±1.5dB is the honest band.
    expect(measuredSnr).toBeGreaterThan(8.5);
    expect(measuredSnr).toBeLessThan(11.5);
  });

  it("leaves silence alone rather than dividing by zero power", () => {
    const silence = new Uint8Array(200);
    expect(Array.from(addNoise(silence, 10))).toEqual(Array.from(silence));
  });
});
