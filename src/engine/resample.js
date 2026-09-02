'use strict';
// @ts-check
/**
 * Discord decodes to 48 kHz stereo; Vosk wants 16 kHz mono.
 *
 * Plain "keep every 3rd sample" decimation folds everything above 8 kHz back
 * into the speech band as aliasing, which measurably hurts recognition. So we
 * low-pass with a windowed-sinc FIR first and evaluate it only at output
 * positions — 25 multiplies per output sample, ~400k/sec per speaker.
 */

const DECIMATION = 3; // 48000 / 16000
const TAPS = 25; // odd -> linear phase
const CUTOFF_HZ = 7200; // just under the 8 kHz Nyquist of the 16 kHz output
const INPUT_RATE = 48000;

/** Hamming-windowed sinc low-pass, normalised to unity DC gain. */
function buildLowpass(taps, cutoffHz, sampleRate) {
  const h = new Float32Array(taps);
  const fc = cutoffHz / sampleRate;
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

const H = buildLowpass(TAPS, CUTOFF_HZ, INPUT_RATE);

/**
 * One instance per speaker. Filter history carries across chunks, otherwise
 * every 20 ms packet boundary produces a click.
 */
class Resampler48kStereoTo16kMono {
  constructor() {
    // Tail of the previous chunk, needed to evaluate the filter at the start
    // of the next one.
    this.history = new Float32Array(TAPS - 1);
    // Index into history+chunk of the next output sample.
    this.nextIndex = TAPS - 1;
  }

  /**
   * @param {Buffer} stereo 48 kHz interleaved stereo 16-bit LE PCM
   * @returns {Buffer} 16 kHz mono 16-bit LE PCM
   */
  process(stereo) {
    const frames = stereo.length >> 2; // 4 bytes per stereo frame
    if (frames === 0) return Buffer.alloc(0);

    const histLen = this.history.length;
    const mono = new Float32Array(histLen + frames);
    mono.set(this.history, 0);

    // Average rather than sum, to avoid clipping.
    for (let i = 0; i < frames; i++) {
      const o = i << 2;
      const l = stereo.readInt16LE(o);
      const r = stereo.readInt16LE(o + 2);
      mono[histLen + i] = (l + r) * 0.5;
    }

    const maxOut = Math.ceil((mono.length - this.nextIndex) / DECIMATION) + 1;
    const out = Buffer.allocUnsafe(Math.max(maxOut, 0) * 2);
    let written = 0;

    let p = this.nextIndex;
    for (; p < mono.length; p += DECIMATION) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += H[k] * mono[p - k];
      let v = acc | 0;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, written);
      written += 2;
    }

    // Carry the filter tail forward.
    this.history = mono.slice(mono.length - histLen);
    this.nextIndex = p - (mono.length - histLen);

    return written === out.length ? out : out.subarray(0, written);
  }

  reset() {
    this.history = new Float32Array(TAPS - 1);
    this.nextIndex = TAPS - 1;
  }
}

module.exports = { Resampler48kStereoTo16kMono, buildLowpass, TAPS, DECIMATION };
