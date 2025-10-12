<script lang="ts">
  import { onMount } from 'svelte';

  // ——— Audio graph düğümleri ———
  let ctx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let analyser: AnalyserNode | null = null;

  // ——— UI durum ———
  let running = false;
  let freq = 0;
  let note = '-';
  let notesArray: string[] = [];
  let cents = 0;
  let noteDb = -120;
  let noteDetected = false;
  let label = '';
  let intervalArray: string[] = [];

  // ——— Parametreler ———
  const FFT_SIZE = 4096;
  const NOTE_DB_THRESHOLD = -50;      // açılma eşiği
  const NOTE_DB_RELEASE   = -56;      // kapama eşiği (Schmitt trigger)
  const NOTE_HOLD_MS = 250;           // sessizlikte notayı '-' yapmadan önce bekleme
  const MIN_CENTS_CHANGE = 15;        // küçük sapmaları “yeni nota” sayma

  // ——— Sabitler ———
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;
  const INTERVAL_INFO = [
    { label: 'P1', quality: 'P', baseNumber: 1 },
    { label: 'm2', quality: 'm', baseNumber: 2 },
    { label: 'M2', quality: 'M', baseNumber: 2 },
    { label: 'm3', quality: 'm', baseNumber: 3 },
    { label: 'M3', quality: 'M', baseNumber: 3 },
    { label: 'P4', quality: 'P', baseNumber: 4 },
    { label: 'TT', quality: undefined, baseNumber: 4 },
    { label: 'P5', quality: 'P', baseNumber: 5 },
    { label: 'm6', quality: 'm', baseNumber: 6 },
    { label: 'M6', quality: 'M', baseNumber: 6 },
    { label: 'm7', quality: 'm', baseNumber: 7 },
    { label: 'M7', quality: 'M', baseNumber: 7 }
  ] as const;

  // ——— Tipler ———
  type Dir = '↑' | '↓' | '→';
  type IntervalMeta = (typeof INTERVAL_INFO)[number];

  let lastNoteTs = 0;
  let gateOpen = false;

  type IntervalResult = {
    from: string;
    to: string;
    semitones: number; // pozitif/negatif tamsayı
    octaves: number;   // tam oktav sayısı
    baseLabel: string; // yönlü basit aralık (örn: "↑M3")
    label: string;     // kullanıcıya gösterilecek tam etiket (örn: "↑M10")
  };

  // ——— Yardımcılar ———
  function rmsToDb(rms: number) {
    return 20 * Math.log10(rms || 1e-12);
  }

  function hzToNote(f: number) {
    if (!f || !isFinite(f)) return { name: '-', cents: 0 };
    const midi = 69 + 12 * Math.log2(f / 440);
    const rounded = Math.round(midi);
    const cents = Math.round(
      1200 * Math.log2(f / (440 * Math.pow(2, (rounded - 69) / 12)))
    );
    const name = NOTE_NAMES[(rounded % 12 + 12) % 12] + (Math.floor(rounded / 12) - 1);
    return { name, cents };
  }

  function toMidiStrict(s: string): number {
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s);
    if (!m) return NaN;
    const pcMap: Record<string, number> = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
    let pc = pcMap[m[1].toUpperCase()];
    if (m[2] === '#') pc += 1;
    else if (m[2] === 'b') pc -= 1;
    return (parseInt(m[3], 10) + 1) * 12 + ((pc % 12) + 12) % 12;
  }

  // ——— Sadece iki nota ile (prev → current) aralık etiketi ———
  export function intervalLabel(a: string, b: string): IntervalResult | null {
    if (!a || !b || a === '-' || b === '-') return null;
    const mi = toMidiStrict(a);
    const mj = toMidiStrict(b);
    if (!Number.isFinite(mi) || !Number.isFinite(mj)) return null;

    const semis = mj - mi; // yönlü yarıton
    const dir: Dir = semis === 0 ? '→' : semis > 0 ? '↑' : '↓';
    const steps = Math.abs(semis);
    const info: IntervalMeta = INTERVAL_INFO[steps % INTERVAL_INFO.length];
    const octaves = Math.floor(steps / 12);

    let intervalName: string = info.label;
    if (octaves > 0 && info.quality) {
      const size = info.baseNumber + octaves * 7;
      intervalName = `${info.quality}${size}`;
    } else if (octaves > 0) {
      intervalName = `${info.label} (+${octaves} oktav)`;
    }

    const baseLabel = `${dir}${info.label}`;
    const label = `${dir}${intervalName}`;
    return { from: a, to: b, semitones: semis, octaves, baseLabel, label };
  }

  onMount(() => {
    return () => stop();
  });

  async function start() {
    if (running) return;
    try {
      // 1) Context
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

      // 2) Worklet modülü
      await ctx.audioWorklet.addModule(new URL('../lib/analyzer-processor.js', import.meta.url));

      // 3) ÇIKIŞSIZ Worklet düğümü
      worklet = new AudioWorkletNode(ctx, 'analyzer-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0, // analiz düğümü
        processorOptions: { sampleRate: ctx.sampleRate }
      });

      // 4) Mikrofon
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false },
        video: false
      });

      src = ctx.createMediaStreamSource(micStream);

      // 5) (İsteğe bağlı) görselleştirme için analyser
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.4;

      // 6) Bağlantılar
      src.connect(worklet);
      // src.connect(analyser); // şimdilik kapalı tutabilirsin

      // 7) Mesajlar
      worklet.port.onmessage = (e: MessageEvent) => {
        const { freq: f, rms } = e.data as { freq: number; rms: number };

        freq = f || 0;
        const levelDb = rmsToDb(rms);
        noteDb = levelDb;

        // Schmitt trigger benzeri gate
        if (!gateOpen && (freq > 0) && levelDb > NOTE_DB_THRESHOLD) gateOpen = true;
        if (gateOpen && ((freq <= 0) || levelDb < NOTE_DB_RELEASE)) gateOpen = false;

        const nn = hzToNote(freq);
        cents = nn.cents;

        const prev = note;
        const now = performance.now();

        if (gateOpen) {
          noteDetected = true;

          // İsim değişimi varsa yeni nota kabul et
          const nameChanged = nn.name !== prev;

          if (nameChanged) {
            note = nn.name;
            notesArray = [...notesArray, note];

            const res = intervalLabel(prev, note);
            if (res) {
              label = res.label;
              intervalArray = [...intervalArray, res.label];
            }
          } else {
            // Aynı isim: küçük cents kaymalarını yoksay
            if (Math.abs(cents) < MIN_CENTS_CHANGE) {
              // stabil durumda etiketi koru (istersen boşalt)
              // label = '';
            }
            note = nn.name;
          }

          lastNoteTs = now;
        } else if (noteDetected && now - lastNoteTs > NOTE_HOLD_MS) {
          noteDetected = false;
          note = '-';
          label = '';
        }
      };

      running = true;
    } catch (err) {
      console.error(err);
      await stop();
      label = 'Mikrofon veya worklet başlatılamadı.';
    }
  }

  function stop() {
    if (!running && !ctx && !micStream) return;
    running = false;

    try { if (worklet?.port) worklet.port.onmessage = null; } catch {}
    try { src?.disconnect(); } catch {}
    try { worklet?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}

    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    src = null;
    worklet = null;
    analyser = null;

    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }

    // Durum sıfırla (not listesi kullanıcı isterse düğmelerle temizler)
    freq = 0;
    note = '-';
    cents = 0;
    noteDb = -120;
    noteDetected = false;
    label = '';
    lastNoteTs = 0;
    gateOpen = false;
  }

  // ——— Not listesi yardımcıları ———
  function clearUpToIndex(idxInclusive: number) {
    if (idxInclusive < 0) return;
    const n = Math.min(idxInclusive + 1, notesArray.length);
    notesArray = notesArray.slice(n); // baştan at
  }

  /** Verilen adı ilk gördüğü yere kadar sil (dahil/haric) */
  function clearUntilNote(name: string, inclusive = true) {
    const idx = notesArray.indexOf(name);
    if (idx === -1) return;
    clearUpToIndex(inclusive ? idx : idx - 1);
  }

  /** İlk N notayı sil */
  function clearFirstN(n: number) {
    if (n <= 0) return;
    const k = Math.min(n, notesArray.length);
    notesArray = notesArray.slice(k);
  }

  function resetNotes() {
    notesArray = [];
  }

  function resetIntervals() {
    intervalArray = [];
  }
</script>

<p class="opacity-60 text-sm">Seviye (dBFS): {noteDb.toFixed(1)}</p>
<p class="opacity-60 text-sm">label {label}</p>

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
      <div class="text-sm opacity-60">Nota</div>
      <div class="text-3xl font-bold">{note}</div>
      <div class="text-sm">Frekans: {freq.toFixed(1)} Hz | Cents: {cents}</div>
    </div>

    <div class="p-4 rounded border">
      <div class="text-sm opacity-60">Algı durumu</div>
      <div class="text-3xl font-bold">{noteDetected ? '✓' : '—'}</div>
    </div>
  </div>

  <!-- Not Listesi -->
  <div class="p-4 rounded border space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-sm opacity-60">Not Listesi (0 = en eski)</div>
      <div class="flex gap-2">
        <button class="px-3 py-1 rounded border" on:click={() => clearFirstN(1)}>İlk 1'i sil</button>
        <button class="px-3 py-1 rounded border" on:click={() => clearFirstN(4)}>İlk 4'ü sil</button>
        <button class="px-3 py-1 rounded border" on:click={resetNotes}>Hepsini sil</button>
      </div>
    </div>

    {#if notesArray.length === 0}
      <div class="text-sm opacity-60">Henüz kayıt yok.</div>
    {:else}
      <ul class="space-y-1">
        {#each notesArray as n, i}
          <li class="flex items-center justify-between gap-3">
            <span class="font-mono">{i}.</span>
            <span class="flex-1">{n}</span>
            <button class="text-xs px-2 py-1 rounded border" on:click={() => clearUpToIndex(i)}>
              ⟵ buraya kadar sil
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Aralık Geçmişi -->
  <div class="p-4 rounded border space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-sm opacity-60">Aralık Geçmişi (0 = en eski)</div>
      <button
        class="px-3 py-1 rounded border disabled:opacity-50 disabled:pointer-events-none"
        on:click={resetIntervals}
        disabled={intervalArray.length === 0}
      >
        Hepsini sil
      </button>
    </div>

    {#if intervalArray.length === 0}
      <div class="text-sm opacity-60">Henüz aralık kaydı yok.</div>
    {:else}
      <ul class="space-y-1">
        {#each intervalArray as iv, i}
          <li class="flex items-center justify-between gap-3">
            <span class="font-mono">{i}.</span>
            <span class="flex-1">{iv}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .border { border: 1px solid #e5e7eb }
</style>
