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
    const NOTE_DB_THRESHOLD =-50;     // eşiği buradan ayarla (−55 … −40 arası deneyebilirsin)
    const NOTE_HOLD_MS = 250;          // histerezis: sönüm için bekleme

    let lastNoteTs = 40;

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
        //note = nn.name;
        cents = nn.cents;

        // 2) Gate mantığı (freq>0 ve seviye>eşik)
        noteDb = rmsToDb(rms);
        const now = performance.now();

        if (freq > 0 && noteDb > NOTE_DB_THRESHOLD) {
            // nota algılandı
            note = nn.name;
            noteDetected = true;
            lastNoteTs = now;
        } else if (noteDetected && now - lastNoteTs > NOTE_HOLD_MS) {
            // bir süredir seviye düşük → kapat
            noteDetected = false;
        }
        };

        running = true;
        
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

    function hzToNote(f: number) {
        if (!f || !isFinite(f)) return { name: '-', cents: 0 };
        const midi = 69 + 12 * Math.log2(f / 440);
        const rounded = Math.round(midi);
        const cents = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (rounded - 69) / 12))));
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const name = names[(rounded % 12 + 12) % 12] + (Math.floor(rounded / 12) - 1);
        return { name, cents };
    }
    
   

</script>
<p>{noteDb}</p>
<div class="p-6 max-w-3xl mx-auto space-y-4">
  <h1 class="text-2xl font-semibold">Note Catcher</h1>

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
    <!-- Aşağıdaki kısımlar henüz tamamlanmadı, sadece gösterim amaçlıdır 
    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">Akor</div>
      <div class="text-3xl font-bold">{chord}</div>
      <div class="text-xs text-gray-500">Triad korelasyonu (maj/min/dim/aug)</div>
    </div>

    <div class="p-4 rounded border">
      <div class="text-sm text-gray-500">Mod</div>
      <div class="text-3xl font-bold">{mode}</div>
      <div class="text-xs text-gray-500">Kilise modları (Ionian…Locrian)</div>
    </div>-->
  </div>
</div>

<style>
  .border { border: 1px solid #e5e7eb }
</style>
