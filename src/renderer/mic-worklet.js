'use strict';
/* global AudioWorkletProcessor, registerProcessor */
/**
 * Runs on the audio thread. The AudioContext is opened at 16 kHz, so Chromium
 * has already resampled the mic; this only converts to 16-bit PCM and batches
 * it into 100 ms chunks, the rate the window sends them on to the engine.
 */

const CHUNK = 1600;

class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    // First channel only; a stereo mic carries the same voice on both.
    const samples = inputs[0] && inputs[0][0];
    if (!samples) return true;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
      if (this.n === CHUNK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-tap', MicTap);
