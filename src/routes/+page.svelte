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
    let lastPushedNote: string | null = null; // aynı “süreğen” notayı tekrar eklememek için
    let cents = 0;
    let noteDb = -120;
    let noteDetected = false;

    // ——— Parametreler ———
    const FFT_SIZE = 4096;
    const NOTE_DB_THRESHOLD = -50; // daha hassas istiyorsan -60 … -80'e indir
    const NOTE_HOLD_MS = 250;

    let lastNoteTs = 0;

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
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const name = names[(rounded % 12 + 12) % 12] + (Math.floor(rounded / 12) - 1);
        return { name, cents };
    }

    onMount(() => {
        return () => stop();
    });

    async function start() {
        if (running) return;

        // 1) Context
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

        // 2) Worklet modülünü yükle
        await ctx.audioWorklet.addModule(
            new URL('../lib/analyzer-processor.js', import.meta.url)
        );

        // 3) ÇIKIŞSIZ Worklet düğümü (numberOfOutputs: 0)
        worklet = new AudioWorkletNode(ctx, 'analyzer-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 0,             // <— kritik: çıkışsız analiz düğümü
            processorOptions: { sampleRate: ctx.sampleRate }
        });

        // 4) Mikrofonu al, kaynak ve analyser oluştur
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false },
            video: false
        });

        src = ctx.createMediaStreamSource(micStream);

        analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.4;

        // 5) Bağlantılar (iki kol)
        //    Kol A: Mic → Worklet (analiz için; ses çıkışı yok)
        src.connect(worklet);

        //    Kol B: Mic → Analyser (istersen görselleştirme/flux için)
        src.connect(analyser);

        // 6) Worklet mesajları
        worklet.port.onmessage = (e: MessageEvent) => {
            const { freq: f, rms } = e.data as { freq: number; rms: number };

            freq = f || 0;
            noteDb = rmsToDb(rms);

            const nn = hzToNote(freq);
            cents = nn.cents;

            const now = performance.now();
            const gateOk = (freq > 0) && (noteDb > NOTE_DB_THRESHOLD);

            if (gateOk) {
                noteDetected = true;
                note = nn.name;
                pushNoteIfNew(note);
                lastNoteTs = now;
            } else if (noteDetected && now - lastNoteTs > NOTE_HOLD_MS) {
                noteDetected = false;
                note = '-';
            }
        };

        running = true;
    }

    function stop() {
        running = false;

        // Worklet listener'ı bırak
        if (worklet?.port) {
        
        worklet.port.onmessage = null;
        }

        // Akışları durdur
        if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        }

        // Düğümleri ayır
        try { src?.disconnect(); } catch {}
        try { worklet?.disconnect(); } catch {}
        try { analyser?.disconnect(); } catch {}

        src = null;
        worklet = null;
        analyser = null;

        // Context'i kapat
        if (ctx) {
        ctx.close();
        ctx = null;
        }

        // UI sıfırla
        freq = 0;
        note = '-';
        cents = 0;
        noteDb = -120;
        noteDetected = false;
        lastNoteTs = 0;
    }

    // ——— Not ekleme (yalnızca onset veya ad değişiminde) ———
    function pushNoteIfNew(name: string) {
        if (!noteDetected || name !== lastPushedNote) {
            // en sona ekle → 0. index en eski kalır
            notesArray = [...notesArray, name];
            lastPushedNote = name;
        }
    }

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
        lastPushedNote = null;
    }
</script>

<p class="opacity-60 text-sm">Seviye (dBFS): {noteDb.toFixed(1)}</p>

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
                <button class="text-xs px-2 py-1 rounded border"
                        on:click={() => clearUpToIndex(i)}>
                ⟵ buraya kadar sil
                </button>
            </li>
            {/each}
        </ul>
        {/if}
    </div>
</div>

<style>
  .border { border: 1px solid #e5e7eb }
</style>
