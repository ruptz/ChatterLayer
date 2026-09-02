'use strict';
// @ts-check
/**
 * Radix-2 FFT, plus a Bluestein wrapper for lengths that are not a power of two.
 *
 * Whisper's mel front end uses a 400-sample window (25 ms at 16 kHz). 400 is
 * 2^4 * 5^2, so no radix-2 transform fits it, and zero-padding the window out to
 * 512 is not an option: that changes the bin spacing, and every mel filter would
 * then be reading the wrong frequencies. Bluestein's algorithm gives the exact
 * 400-point DFT using only power-of-two transforms, at roughly a third the cost
 * of the direct 400x400 DFT — which matters, because a 30-second Whisper window
 * is up to 3000 frames.
 *
 * Verified against a direct DFT in scripts/selftest.js.
 */

/** In-place iterative radix-2 FFT. Sign convention e^(-2*pi*i*jk/n). */
class Radix2 {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT size ${n} is not a power of two.`);
    }
    this.n = n;
    this.levels = Math.round(Math.log2(n));

    // One twiddle table for the largest stage; smaller stages stride into it.
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }

    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
      this.rev[i] = r;
    }
  }

  forward(re, im) {
    const { n, rev, cos, sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k];
          const s = sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** Swapping the real and imaginary arrays turns the forward transform round. */
  inverse(re, im) {
    this.forward(im, re);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Exact DFT of any length via Bluestein's algorithm.
 *
 * X[k] = w[k] * sum_j (x[j] * w[j]) * conj(w[k-j]),  w[t] = e^(-i*pi*t^2/n)
 *
 * The inner sum is a cyclic convolution, so it becomes two power-of-two FFTs
 * (the second operand's transform is precomputed once, here in the constructor).
 */
class Dft {
  constructor(n) {
    this.n = n;

    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    this.m = m;
    this.fft = new Radix2(m);

    // The chirp. Reducing k^2 mod 2n before scaling keeps the angle accurate:
    // k^2 for k near 3000 would otherwise lose precision in the multiply.
    this.cw = new Float64Array(n);
    this.sw = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n;
      this.cw[k] = Math.cos(a);
      this.sw[k] = -Math.sin(a);
    }

    // conj(w) laid out cyclically, so index m-j stands in for -j.
    const bre = new Float64Array(m);
    const bim = new Float64Array(m);
    bre[0] = this.cw[0];
    bim[0] = -this.sw[0];
    for (let j = 1; j < n; j++) {
      bre[j] = bre[m - j] = this.cw[j];
      bim[j] = bim[m - j] = -this.sw[j];
    }
    this.fft.forward(bre, bim);
    this.bre = bre;
    this.bim = bim;

    this.are = new Float64Array(m);
    this.aim = new Float64Array(m);
  }

  /**
   * |X[k]|^2 for k in [0, n/2] of a real signal — everything the mel filterbank
   * needs, and half the bins, since a real signal's spectrum is symmetric.
   *
   * @param {Float64Array|Float32Array} x  length n
   * @param {Float64Array} out  length n/2 + 1, overwritten
   */
  powerSpectrum(x, out) {
    const { n, m, are, aim, bre, bim, cw, sw } = this;

    are.fill(0);
    aim.fill(0);
    for (let j = 0; j < n; j++) {
      are[j] = x[j] * cw[j];
      aim[j] = x[j] * sw[j];
    }

    this.fft.forward(are, aim);
    for (let i = 0; i < m; i++) {
      const r = are[i] * bre[i] - aim[i] * bim[i];
      const q = are[i] * bim[i] + aim[i] * bre[i];
      are[i] = r;
      aim[i] = q;
    }
    this.fft.inverse(are, aim);

    const bins = (n >> 1) + 1;
    for (let k = 0; k < bins; k++) {
      const r = are[k] * cw[k] - aim[k] * sw[k];
      const q = are[k] * sw[k] + aim[k] * cw[k];
      out[k] = r * r + q * q;
    }
  }
}

module.exports = { Radix2, Dft };
