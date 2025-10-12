<script lang="ts">
  import { onMount } from 'svelte';

  const CHORD_SIZES = [3, 4] as const;
  type ChordSize = (typeof CHORD_SIZES)[number];

  type ChordDefinition = {
    id: string;
    intervals: number[];
    label: string;
  };

  type ChordMatch = {
    id: string;
    rootPc: number;
    chordLabel: string;
    intervals: number[];
    intervalNames: string[];
  };

  type ChordWindow = {
    start: number;
    notes: string[];
    matches: ChordMatch[];
  };

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
  let chordSelection: number[] = [];
  let chordSize: ChordSize = 3;
  let selectedChordNotes: string[] = [];
  let selectedChordMatches: ChordMatch[] = [];
  let chordWindows: ChordWindow[] = [];

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
  const TURKISH_NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'] as const;
  const INTERVAL_SHORT_NAMES = ['R', 'b2', '2', 'b3', '3', '4', '#11', '5', 'b6', '6', 'b7', '7'] as const;
  const CHORD_DEFINITIONS: ChordDefinition[] = [
    { id: 'maj', intervals: [0, 4, 7], label: 'majör' },
    { id: 'min', intervals: [0, 3, 7], label: 'minör' },
    { id: 'dim', intervals: [0, 3, 6], label: 'dim' },
    { id: 'aug', intervals: [0, 4, 8], label: 'aug' },
    { id: 'sus2', intervals: [0, 2, 7], label: 'sus2' },
    { id: 'sus4', intervals: [0, 5, 7], label: 'sus4' },
    { id: 'maj7', intervals: [0, 4, 7, 11], label: 'majör 7' },
    { id: 'dom7', intervals: [0, 4, 7, 10], label: '7' },
    { id: 'min7', intervals: [0, 3, 7, 10], label: 'minör 7' },
    { id: 'minMaj7', intervals: [0, 3, 7, 11], label: 'minör maj7' },
    { id: 'halfDim7', intervals: [0, 3, 6, 10], label: 'yarı-dim 7' },
    { id: 'dim7', intervals: [0, 3, 6, 9], label: 'dim 7' },
    { id: 'maj6', intervals: [0, 4, 7, 9], label: 'majör 6' },
    { id: 'min6', intervals: [0, 3, 7, 9], label: 'minör 6' },
    { id: 'maj7_shell', intervals: [0, 4, 11], label: 'majör 7 (shell)' },
    { id: 'dom7_shell', intervals: [0, 4, 10], label: '7 (shell)' },
    { id: 'min7_shell', intervals: [0, 3, 10], label: 'minör 7 (shell)' },
    { id: 'minMaj7_shell', intervals: [0, 3, 11], label: 'minör maj7 (shell)' },
    { id: 'maj6_shell', intervals: [0, 4, 9], label: 'majör 6 (shell)' },
    { id: 'min6_shell', intervals: [0, 3, 9], label: 'minör 6 (shell)' },
    { id: 'majSharp11', intervals: [0, 4, 6, 7], label: 'majör #11' },
    { id: 'majSharp11_shell', intervals: [0, 4, 6], label: 'majör #11 (shell)' }
  ];

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

  $: {
    if (chordSelection.length > chordSize) {
      chordSelection = chordSelection.slice(-chordSize);
    }
  }

  $: {
    const filtered = chordSelection.filter((idx) => idx < notesArray.length);
    if (filtered.length !== chordSelection.length) {
      chordSelection = filtered;
    }
  }

  $: selectedChordNotes = chordSelection
    .map((idx) => notesArray[idx])
    .filter((note): note is string => Boolean(note));

  $: selectedChordMatches =
    chordSelection.length === chordSize ? detectChords(selectedChordNotes) : [];

  $: chordWindows = computeChordWindows(notesArray, chordSize);

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

  function setChordSize(size: ChordSize) {
    chordSize = size;
  }

  function toggleChordSelection(idx: number) {
    if (chordSelection.includes(idx)) {
      chordSelection = chordSelection.filter((value) => value !== idx);
      return;
    }
    if (chordSelection.length >= chordSize) return;
    chordSelection = [...chordSelection, idx].sort((a, b) => a - b);
  }

  function clearChordSelection() {
    if (chordSelection.length > 0) {
      chordSelection = [];
    }
  }

  function shiftSelectionAfterTrim(count: number) {
    if (count <= 0 || chordSelection.length === 0) return;
    const next = chordSelection
      .map((idx) => idx - count)
      .filter((idx) => idx >= 0);
    if (
      next.length !== chordSelection.length ||
      next.some((value, index) => value !== chordSelection[index])
    ) {
      chordSelection = next;
    }
  }

  function pitchClassFromNote(name: string): number {
    const midi = toMidiStrict(name);
    if (!Number.isFinite(midi)) return NaN;
    return ((midi % 12) + 12) % 12;
  }

  function formatRootName(pc: number): string {
    return TURKISH_NOTE_NAMES[((pc % 12) + 12) % 12];
  }

  function arraysEqual(a: number[], b: number[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function dedupeChordMatches(matches: ChordMatch[]): ChordMatch[] {
    const seen = new Set<string>();
    return matches.filter((match) => {
      if (seen.has(match.id)) return false;
      seen.add(match.id);
      return true;
    });
  }

  function detectChords(notes: string[]): ChordMatch[] {
    if (notes.length === 0) return [];

    const pitchClasses: number[] = [];
    for (const note of notes) {
      const pc = pitchClassFromNote(note);
      if (!Number.isFinite(pc)) return [];
      if (!pitchClasses.includes(pc)) {
        pitchClasses.push(pc);
      }
    }

    if (pitchClasses.length < 2) return [];

    const matches: ChordMatch[] = [];
    for (const rootPc of pitchClasses) {
      const intervals = pitchClasses
        .map((pc) => (pc - rootPc + 12) % 12)
        .sort((a, b) => a - b);
      if (intervals[0] !== 0) continue;

      for (const def of CHORD_DEFINITIONS) {
        if (def.intervals.length !== intervals.length) continue;
        if (!arraysEqual(intervals, def.intervals)) continue;

        const chordLabel = `${formatRootName(rootPc)} ${def.label}`;
        const intervalNames = intervals.map(
          (value) => INTERVAL_SHORT_NAMES[value] ?? `${value}`
        );
        const id = `${rootPc}:${def.id}`;
        matches.push({ id, rootPc, chordLabel, intervals, intervalNames });
      }
    }

    return dedupeChordMatches(matches);
  }

  function computeChordWindows(list: string[], size: number): ChordWindow[] {
    if (size <= 0 || list.length < size) return [];
    const rows: ChordWindow[] = [];
    for (let i = 0; i <= list.length - size; i++) {
      const windowNotes = list.slice(i, i + size);
      rows.push({ start: i, notes: windowNotes, matches: detectChords(windowNotes) });
    }
    return rows;
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
    if (n <= 0) return;
    notesArray = notesArray.slice(n); // baştan at
    shiftSelectionAfterTrim(n);
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
    if (k <= 0) return;
    notesArray = notesArray.slice(k);
    shiftSelectionAfterTrim(k);
  }

  function resetNotes() {
    notesArray = [];
    clearChordSelection();
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
          <li
            class="flex items-center justify-between gap-3"
            class:chord-selected={chordSelection.includes(i)}
          >
            <span class="font-mono">{i}.</span>
            <span class="flex-1">{n}</span>
            <div class="flex gap-1">
              <button
                class="text-xs px-2 py-1 rounded border select-btn"
                class:selected={chordSelection.includes(i)}
                on:click={() => toggleChordSelection(i)}
              >
                {chordSelection.includes(i) ? 'Seçili' : 'Seç'}
              </button>
              <button class="text-xs px-2 py-1 rounded border" on:click={() => clearUpToIndex(i)}>
                ⟵ buraya kadar sil
              </button>
            </div>
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

  <!-- Akor Analizi -->
  <div class="p-4 rounded border space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="text-sm opacity-60">Akor Analizi</div>
      <div class="flex flex-wrap items-center gap-3 text-xs">
        <span>Nota sayısı:</span>
        {#each CHORD_SIZES as size}
          <label class="flex items-center gap-1">
            <input
              type="radio"
              name="chord-size"
              value={size}
              checked={chordSize === size}
              on:change={() => setChordSize(size)}
            />
            <span>{size}</span>
          </label>
        {/each}
        <button
          class="px-3 py-1 rounded border disabled:opacity-50 disabled:pointer-events-none"
          on:click={clearChordSelection}
          disabled={chordSelection.length === 0}
        >
          Seçimi temizle
        </button>
      </div>
    </div>

    <div class="space-y-2 text-sm">
      {#if chordSelection.length === 0}
        <p class="opacity-60">Listeden {chordSize} nota seçerek akor önerisi al.</p>
      {:else if chordSelection.length < chordSize}
        <p>
          Seçilen notlar: {selectedChordNotes.join(', ')}. {chordSize - chordSelection.length} nota daha seç.
        </p>
      {:else if chordSelection.length > chordSize}
        <p class="text-red-600">En fazla {chordSize} nota seçebilirsin.</p>
      {:else}
        <p>Seçilen notlar: {selectedChordNotes.join(', ')}.</p>
        {#if selectedChordMatches.length === 0}
          <p class="opacity-60">Bu kombinasyon için tanımlı bir akor bulunamadı.</p>
        {:else}
          <ul class="space-y-1">
            {#each selectedChordMatches as match}
              <li class="flex items-center gap-2">
                <span class="font-medium">{match.chordLabel}</span>
                <span class="text-xs opacity-60">({match.intervalNames.join(', ')})</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    {#if chordWindows.length > 0}
      <details class="text-sm">
        <summary>Ardışık {chordSize} notalar için öneriler</summary>
        <ul class="space-y-2 pt-2">
          {#each chordWindows as row}
            <li class="space-y-1">
              <div class="text-xs font-mono opacity-60">
                [{row.start} – {row.start + chordSize - 1}] {row.notes.join(', ')}
              </div>
              {#if row.matches.length === 0}
                <div class="text-xs opacity-60">Akor eşleşmesi yok</div>
              {:else}
                <ul class="pl-3 space-y-1">
                  {#each row.matches as match}
                    <li class="flex items-center gap-2 text-xs">
                      <span class="font-medium">{match.chordLabel}</span>
                      <span class="opacity-60">({match.intervalNames.join(', ')})</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </details>
    {:else}
      <p class="text-xs opacity-60">Akor analizi için yeterli sayıda ardışık nota yok.</p>
    {/if}
  </div>
</div>

<style>
  .border { border: 1px solid #e5e7eb }
  .select-btn.selected {
    background: #dcfce7;
    border-color: #16a34a;
    color: #065f46;
  }
  .chord-selected {
    background: #f0fdf4;
  }
  details summary {
    cursor: pointer;
  }
</style>
