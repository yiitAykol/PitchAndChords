
// src/lib/analyzer-processor.js
// @ts-check

// AudioWorkletProcessor: frame tabanlı YIN pitch + enerji zarfı
/** @extends {AudioWorkletProcessor} */
class AnalyzerProcessor extends AudioWorkletProcessor {
  /**
   * @param {{processorOptions?: {sampleRate?: number}}} [options]
   */
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.sampleRate = opts.sampleRate || sampleRate;

    this.frameSize = 2048;
    this.hopSize = 512;

    this._buf = new Float32Array(this.frameSize);
    this._write = 0;
    this.prevRMS = 0;
    /** @type {(frame: Float32Array) => number} */
    this._yinPitch = createYinEstimator(this.frameSize, this.sampleRate);
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} _outputs
   * @param {Record<string, Float32Array>} _parameters
   */
  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;
    const chan = input[0];

    let i = 0;
    while (i < chan.length) {
      const space = this.frameSize - this._write;
      const copyCount = Math.min(space, chan.length - i);
      this._buf.set(chan.subarray(i, i + copyCount), this._write);
      this._write += copyCount;
      i += copyCount;

      if (this._write === this.frameSize) {
        const freq = this._yinPitch(this._buf);
        const rms = rootMeanSquare(this._buf);

        let onset = rms - this.prevRMS;
        if (onset < 0) onset = 0;
        this.prevRMS = rms;

        this.port.postMessage({ freq, rms, onset });

        this._buf.copyWithin(0, this.hopSize);
        this._write = this.frameSize - this.hopSize;
      }
    }
    return true;
  }
}

function rootMeanSquare(/** @type {Float32Array} */ buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function createYinEstimator(/** @type {number} */ frameSize, /** @type {number} */ sr) {
  const tauMax = Math.floor(sr / 50);
  const tauMin = Math.floor(sr / 1000);
  const diff = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);
  const threshold = 0.1;

  return function yinPitch(/** @type {Float32Array} */ frame) {
    const W = frameSize;
    diff.fill(0);

    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W - tau; i++) {
        const delta = frame[i] - frame[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = (diff[tau] * tau) / (running || 1e-12);
    }

    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return 0;

    const x0 = tau > 1 ? tau - 1 : tau;
    const x2 = tau + 1 <= tauMax ? tau + 1 : tau;
    const s0 = cmnd[x0], s1 = cmnd[tau], s2 = cmnd[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    const betterTau = tau + (s2 - s0) / (denom || 1e-12);

    return sr / betterTau;
  };
}

registerProcessor('analyzer-processor', AnalyzerProcessor);
