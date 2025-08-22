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
    // BPM zirve algılama için eklendi
    const peakTimes: number[] = [];   // saniye cinsinden zaman damgaları
    const PEAK_MULT = 1.6;
    let instBpm = 0;                    // iki tepe ile çıkan hızlı tahmin

    // --- Otokorelasyon sonucu ---
    let stableBpm = 0;                  // uzun pencere tahmini
    let acfStrength = 0;                // 0..1 arası güven skoru

    // --- Füzyon ve yumuşatma ---
    const EMA_ALPHA = 0.25;             // 0.15–0.35 arası deneyebilirsin
    // --- Nota kapısı (gate) ---
    let gateEnabled = true;            // UI’dan aç/kapat
    let noteDetected = false;          // anlık durum
    let noteDb = -120;                 // RMS’in dBFS karşılığı
    const NOTE_DB_THRESHOLD = -50;     // eşiği buradan ayarla (−55 … −40 arası deneyebilirsin)
    const NOTE_HOLD_MS = 250;          // histerezis: sönüm için bekleme

    let lastNoteTs = 0;

    function rmsToDb(rms: number) {
        return 20 * Math.log10((rms || 1e-12));
    }

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
        const { freq: f, rms } = e.data as { freq: number; rms: number };

        // 1) Pitch'i güncelle
        freq = f || 0;
        const nn = hzToNote(freq);
        note = nn.name;
        cents = nn.cents;

        // 2) Gate mantığı (freq>0 ve seviye>eşik)
        noteDb = rmsToDb(rms);
        const now = performance.now();

        if (freq > 0 && noteDb > NOTE_DB_THRESHOLD) {
            // nota algılandı
            noteDetected = true;
            lastNoteTs = now;
        } else if (noteDetected && now - lastNoteTs > NOTE_HOLD_MS) {
            // bir süredir seviye düşük → kapat
            noteDetected = false;
        }
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

        // GATE: nota yoksa akor/mod hesaplama
        if (gateEnabled && !noteDetected) {
            chord = '-';
            mode = '-';
            rafId = requestAnimationFrame(raf);
            return;
        }

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
        // GATE: nota yoksa BPM için flux işlemi yapma

        if (gateEnabled && !noteDetected) {
            // İstersen BPM’i temizlemek için şu satırı aç:
            // bpm = 0;
            return;
        }


        (analyser as any).getFloatFrequencyData(specDb);
        const mag = dbToMag(specDb);

        const sr = ctx.sampleRate;
        const binHz = sr / (2 * mag.length);
        const iLo = Math.max(1, Math.floor(50   / binHz));
        const iHi = Math.min(mag.length - 1, Math.ceil(5000 / binHz));

        let flux = 0;
        if (prevMag) {
            for (let i = iLo; i <= iHi; i++) {
            const d = mag[i] - prevMag[i];
            if (d > 0) flux += d;
            }
        }
        prevMag = mag;
        if (!isFinite(flux) || flux < 1e-6) flux = 0;

        // --- zarfı güncelle ---
        fluxEnv.push(flux);
        const maxLen = Math.floor(12 / hopSecFlux);
        if (fluxEnv.length > maxLen) fluxEnv.splice(0, fluxEnv.length - maxLen);

        // --- 1) Peak (onset) yakala ve instant BPM üret ---
        const L = fluxEnv.length;
        if (L >= 3) {
            const a = fluxEnv[L - 3], b = fluxEnv[L - 2], c = fluxEnv[L - 1];
            const win = Math.min(Math.floor(0.5 / hopSecFlux), L);
            let mean = 0;
            for (let i = L - win; i < L; i++) mean += fluxEnv[i];
            mean /= win || 1;

            if (b > a && b > c && b > PEAK_MULT * mean) {
            const tSec = (L - 2) * hopSecFlux; // b’nin zamanı
            pushPeak(tSec);
            }
        }

        // --- 2) Periyodik olarak ACF BPM ve güven skorunu güncelle ---
        const now = performance.now();
        if (now - lastBpmUpdate > 500 && fluxEnv.length > FLUX_HZ * 2) {
            const mean = fluxEnv.reduce((s,v)=>s+v,0) / fluxEnv.length;
            const env = fluxEnv.map(v => Math.max(0, v - mean));
            const acf = acfBpm(env, hopSecFlux, 40, 220);
            stableBpm   = acf.bpm;
            acfStrength = acf.strength;
            lastBpmUpdate = now;
        }

        // --- 3) Füzyon ve EMA ---
        fuseTempo();
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

    // --------- bpm de doğruluk için yardımcı fonksiyonlar
    function pushPeak(tSec: number) {
        peakTimes.push(tSec);
        if (peakTimes.length > 10) peakTimes.shift();
        instBpm = instantBpmFromPeaks(peakTimes);
    }

    function instantBpmFromPeaks(times: number[]): number {
        if (times.length < 2) return 0;
        // Son 3-4 aralıktan medyan al (daha sağlam)
        const dts: number[] = [];
        for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
        const last = dts.slice(-4);
        last.sort((a, b) => a - b);
        const med = last.length % 2 ? last[(last.length - 1) / 2]
                                    : 0.5 * (last[last.length / 2 - 1] + last[last.length / 2]);
        if (med <= 0) return 0;
        let bpm = 60 / med;
        return normalizeTempo(bpm, 40, 220);
    }

    function normalizeTempo(t: number, min: number, max: number) {
        if (!t) return 0;
        while (t < min) t *= 2;
        while (t > max) t /= 2;
        return t;
    }

    function octaveAlign(candidate: number, ref: number) {
        if (!candidate || !ref) return candidate;
        const cands = [candidate, candidate * 2, candidate / 2];
        let best = cands[0], err = Number.POSITIVE_INFINITY;
        for (const c of cands) {
            const e = Math.abs(c - ref);
            if (e < err) { err = e; best = c; }
        }
        return best;
    }

    // Otokorelasyon: hem BPM hem de bir "güven" skoru döndür
    function acfBpm(env: number[], hopSec: number, minBpm: number, maxBpm: number) {
        if (env.length < 20) return { bpm: 0, strength: 0 };

        // merkeze al
        const mean = env.reduce((a,b)=>a+b,0) / env.length;
        const x = env.map(v => v - mean);

        const r0 = x.reduce((s,v)=>s + v*v, 0) + 1e-12; // enerji
        const maxLag = Math.floor((60 / minBpm) / hopSec);
        const minLag = Math.floor((60 / maxBpm) / hopSec);

        let bestLag = 0, rMax = -1;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let r = 0;
            for (let i = 0; i < x.length - lag; i++) r += x[i] * x[i + lag];
            if (r > rMax) { rMax = r; bestLag = lag; }
        }
        if (bestLag <= 0) return { bpm: 0, strength: 0 };

        const bpm = 60 / (bestLag * hopSec);
        const strength = Math.max(0, Math.min(1, rMax / r0)); // 0..1

        return { bpm: normalizeTempo(bpm, 40, 220), strength };
        }

        // Nihai BPM füzyonu (yalnızca 2+ peak varsa göster)
        function fuseTempo() {
        if (peakTimes.length < 2) return; // ikinci onset gelmeden BPM yok

        let fused: number;

        if (stableBpm > 0) {
            // Stabil tahmini instant’a oktav-hizala
            const acfAligned = octaveAlign(stableBpm, instBpm || stableBpm);

            // Ağırlık: güven skoru ve geçen süre (6 sn’de tavana yaklaşsın)
            const tWin = Math.min(1, (fluxEnv.length * hopSecFlux) / 6);
            const w = Math.max(0.2, Math.min(0.95, 0.3 + 0.5 * acfStrength + 0.2 * tWin));

            fused = instBpm > 0 ? (w * acfAligned + (1 - w) * instBpm) : acfAligned;
        } else {
            fused = instBpm;
        }

        fused = normalizeTempo(fused, 40, 220);
        bpm = bpm ? Math.round((1 - EMA_ALPHA) * bpm + EMA_ALPHA * fused) : Math.round(fused);
    }

    /**
        Gpt notları:
        Davranış:
        • 2. tepe gelmeden BPM gösterilmez.
        • Geldikten sonra instant BPM hemen çıkar; ACF devreye girdikçe ağırlık stabil tarafa kayar.
        • Oktav (×2/÷2) hataları instant BPM’e hizalama ile azaltılır.
        • Son değer EMA ile yumuşatılır.

        İnce ayar ipuçları

        Çok kararsızsa PEAK_MULT’ı yükselt (1.8–2.0). Çok geç tepki veriyorsa düşür (1.4–1.6).

        Daha hızlı tepki için EMA_ALPHA’yı artır (0.35). Daha pürüzsüz için azalt (0.15).

        ACF penceresini uzatmak için maxLen (12 s) değerini büyütebilirsin; gecikme artar ama kararlılık yükselir.

        İnce Ayar

        Eşik (NOTE_DB_THRESHOLD): Odan gürültülüyse -45 dB civarı; zayıf sinyal için -55 dB daha iyi olabilir.

        Histerezis (NOTE_HOLD_MS): Staccato için 200–300 ms, bağlama/legato gibi çalgılar için 400–600 ms deneyebilirsin.

        Sadeleştirmek istersen gate’i sadece freq > 0 şartına bağlayabilirsin (dB kısmını kaldır).

    */

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
