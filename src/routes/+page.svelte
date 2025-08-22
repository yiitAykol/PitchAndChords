<script lang="ts">
  import { onMount } from 'svelte';

  let ctx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let worklet: AudioWorkletNode | null = null;
  let analyser: AnalyserNode | null = null;

  let running = false;

  // UI göstergeleri
  let freq = 0;
  let note = '-';
  let cents = 0;

  let chord = '-';
  let mode  = '-';
  let bpm   = 0;

  // --- Analiz parametreleri / tamponlar ---
  const FFT_SIZE = 4096;

  // Chroma için dB spektrumu
  let spec!: Float32Array;

  // Spectral Flux için
  const FLUX_HZ = 50;
  const hopSecFlux = 1 / FLUX_HZ;
  let fluxTimer: any = null;
  let specDb!: Float32Array;              // dB spektrum (flux hesap için)
  let prevMag: Float32Array | null = null;
  const fluxEnv: number[] = [];
  let lastBpmUpdate = 0;

  // RAF id
  let rafId = 0;

  onMount(() => () => stop());

  // -------- Başlat / Durdur --------
  async function start() {
    if (running) return;

    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const sr = ctx.sampleRate;

    // Pitch worklet
    await ctx.audioWorklet.addModule(new URL('../lib/analyzer-processor.js', import.meta.url));
    worklet = new AudioWorkletNode(ctx, 'analyzer-processor', {
      processorOptions: { sampleRate: sr }
    });

    // Mikrofon
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
      video: false
    });
    const src = ctx.createMediaStreamSource(micStream);

    // Analyser (chroma + flux)
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.6;

    spec   = new Float32Array(analyser.frequencyBinCount);
    specDb = new Float32Array(analyser.frequencyBinCount);

    // Grafik
    src.connect(worklet);
    src.connect(analyser);

    // Pitch olayları
    worklet.port.onmessage = (e: MessageEvent) => {
      const { freq: f } = e.data as { freq: number };
      freq = f || 0;
      const nn = hzToNote(freq);
      note = nn.name;
      cents = nn.cents;
    };

    // Flux örnekleme zamanlayıcısı
    fluxTimer = setInterval(fluxStep, Math.round(1000 / FLUX_HZ));

    running = true;
    raf();
  }

  function stop() {
    running = false;

    if (rafId) cancelAnimationFrame(rafId);
    if (fluxTimer) { clearInterval(fluxTimer); fluxTimer = null; }
    prevMag = null;
    fluxEnv.length = 0;

    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (worklet) { worklet.disconnect(); worklet = null; }
    if (analyser) { analyser.disconnect(); analyser = null; }
    if (ctx) { ctx.close(); ctx = null; }
  }

  // -------- UI raf (chroma → akor/mod) --------
  function raf() {
    if (!running || !analyser || !ctx) return;

    // Tip farklarını susturmak için 'any' cast:
    (analyser as any).getFloatFrequencyData(spec);
    const chroma = spectrumToChroma(spec, ctx.sampleRate);

    const chordRes = detectChord(chroma);
    chord = chordRes ?? '-';

    const modeRes = detectMode(chroma);
    mode = modeRes ?? '-';

    rafId = requestAnimationFrame(raf);
  }

  // -------- Spectral flux → BPM --------
  function fluxStep() {
    if (!analyser || !ctx) return;

    (analyser as any).getFloatFrequencyData(specDb);
    const mag = dbToMag(specDb);

    // Gürültü ve tekme bastırma için bant sınırlama
    const sr = ctx.sampleRate;
    const binHz = sr / (2 * mag.length);
    const iLo = Math.max(1, Math.floor(50   / binHz));
    const iHi = Math.min(mag.length - 1, Math.ceil(5000 / binHz));

    let flux = 0;
    if (prevMag) {
      for (let i = iLo; i <= iHi; i++) {
        const d = mag[i] - prevMag[i];
        if (d > 0) flux += d;           // only positive changes
      }
    }
    prevMag = mag;

    if (!isFinite(flux) || flux < 1e-6) flux = 0;

    fluxEnv.push(flux);
    const maxLen = Math.floor(12 / hopSecFlux); // 12 sn pencere
    if (fluxEnv.length > maxLen) fluxEnv.splice(0, fluxEnv.length - maxLen);

    const now = performance.now();
    if (now - lastBpmUpdate > 500 && fluxEnv.length > FLUX_HZ * 2) {
      // basit detrend
      const mean = fluxEnv.reduce((a, b) => a + b, 0) / fluxEnv.length;
      const env = fluxEnv.map(v => Math.max(0, v - mean));
      bpm = estimateBPM(env, hopSecFlux, 40, 220) | 0;
      lastBpmUpdate = now;
    }
  }

  // -------- Yardımcı DSP fonksiyonları --------
  function dbToMag(db: Float32Array) {
    const out = new Float32Array(db.length);
    for (let i = 0; i < db.length; i++) out[i] = Math.pow(10, db[i] / 20);
    return out;
  }

  function estimateBPM(env: number[], hopSec: number, minBpm: number, maxBpm: number): number {
    if (env.length < 20) return 0;
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const x = env.map(v => v - mean);

    const maxLag = Math.floor((60 / minBpm) / hopSec);
    const minLag = Math.floor((60 / maxBpm) / hopSec);

    let bestLag = 0, bestVal = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < x.length - lag; i++) s += x[i] * x[i + lag];
      if (s > bestVal) { bestVal = s; bestLag = lag; }
    }
    if (bestLag <= 0) return 0;
    return 60 / (bestLag * hopSec);
  }

  function hzToNote(f: number) {
    if (!f || !isFinite(f)) return { name: '-', cents: 0 };
    const midi = 69 + 12 * Math.log2(f / 440);
    const rounded = Math.round(midi);
    const cents = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (rounded - 69) / 12))));
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const name = names[(rounded % 12 + 12) % 12] + (Math.floor(rounded / 12) - 1);
    return { name, cents };
  }

  function spectrumToChroma(spectrum: Float32Array, sr: number) {
    const mag = new Float32Array(spectrum.length);
    for (let i = 0; i < spectrum.length; i++) mag[i] = Math.pow(10, spectrum[i] / 20);
    const binHz = sr / (2 * spectrum.length);

    const chroma = new Float32Array(12);
    for (let i = 1; i < mag.length; i++) {
      const f = i * binHz;
      if (f < 50 || f > 5000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag[i];
    }
    const sum = chroma.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < 12; k++) chroma[k] /= sum;
    return chroma;
  }

  function detectChord(chroma: Float32Array): string | null {
    const templates: Record<string, number[]> = {
      maj: [0, 4, 7],
      min: [0, 3, 7],
      dim: [0, 3, 6],
      aug: [0, 4, 8]
    };
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    let bestScore = 0, bestRoot = 0, bestType = '';
    for (let root = 0; root < 12; root++) {
      for (const [type, ints] of Object.entries(templates)) {
        let s = 0;
        for (const iv of ints) s += chroma[(root + iv) % 12];
        if (s > bestScore) { bestScore = s; bestRoot = root; bestType = type; }
      }
    }
    if (bestScore < 0.12) return null;
    return `${names[bestRoot]} ${bestType}`;
  }

  function detectMode(chroma: Float32Array): string | null {
    const modes = [
      { name: 'Ionian (Majör)',  set: [0,2,4,5,7,9,11] },
      { name: 'Dorian',          set: [0,2,3,5,7,9,10] },
      { name: 'Phrygian',        set: [0,1,3,5,7,8,10] },
      { name: 'Lydian',          set: [0,2,4,6,7,9,11] },
      { name: 'Mixolydian',      set: [0,2,4,5,7,9,10] },
      { name: 'Aeolian (Minör)', set: [0,2,3,5,7,8,10] },
      { name: 'Locrian',         set: [0,1,3,5,6,8,10] }
    ];
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    let bestScore = 0, bestRoot = 0, bestIdx = 0;
    for (let root = 0; root < 12; root++) {
      for (let i = 0; i < modes.length; i++) {
        const m = modes[i];
        let s = 0;
        for (let k = 0; k < 12; k++) {
          const inScale = m.set.includes((k - root + 120) % 12) ? 1 : 0;
          s += chroma[k] * inScale;
        }
        if (s > bestScore) { bestScore = s; bestRoot = root; bestIdx = i; }
      }
    }
    if (bestScore < 0.4) return null;
    return `${names[bestRoot]} ${modes[bestIdx].name}`;
  }
</script>

<div class="p-6 max-w-3xl mx-auto space-y-4">
  <h1 class="text-2xl font-semibold">Canlı Müzik Analizi (Pitch / Akor / Mod / BPM)</h1>

  <div class="flex gap-2">
    {#if !running}
      <button class="px-4 py-2 rounded bg-green-600 text-white" on:click={start}>Başlat</button>
    {:else}
      <button class="px-4 py-2 rounded bg-red-600 text-white" on:click={stop}>Durdur</button>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-4">
    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">Nota</div>
      <div class="text-3xl font-bold">{note}</div>
      <div class="text-sm">Frekans: {freq.toFixed(1)} Hz | Cents: {cents}</div>
    </div>

    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">BPM</div>
      <div class="text-3xl font-bold">{bpm || '-'}</div>
    </div>

    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">Akor</div>
      <div class="text-3xl font-bold">{chord}</div>
      <div class="text-xs text-gray-500">Triad korelasyonu (maj/min/dim/aug)</div>
    </div>

    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">Mod</div>
      <div class="text-3xl font-bold">{mode}</div>
      <div class="text-xs text-gray-500">Kilise modları (Ionian…Locrian)</div>
    </div>
  </div>
</div>

<style>
  .border { border: 1px solid #e5e7eb }
</style>
