/* VoxStage 2.0: High-Accuracy Automatic Lyrics Synchronization Engine.
 * Provides Dual-Engine Auto-Sync:
 *   1. Multi-Provider Instant Synced DB Match (LRCLIB Exact Duration Matching)
 *   2. Local Acoustic Voice-Activity & Energy Aligner (Offline / Custom Tracks / Isolated Stems)
 * Does NOT use MVSEP. Runs 100% locally or via instant public duration-matched sync.
 */
(() => {
  'use strict';

  // --- Voice Activity Detection & Acoustic Alignment Primitives ---

  // 2nd-order Butterworth bandpass filter for vocal range (approx 260Hz - 3400Hz)
  function createVocalBandpassFilter(sampleRate, lowFreq = 260, highFreq = 3400) {
    const nyquist = sampleRate / 2;
    const low = Math.max(0.001, Math.min(0.95, lowFreq / nyquist));
    const high = Math.max(low + 0.01, Math.min(0.99, highFreq / nyquist));
    const center = (low + high) / 2;
    const bw = high - low;
    const q = center / bw;

    const w0 = 2 * Math.PI * (center * nyquist) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    return function process(sample) {
      const y0 = (b0 * sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = sample;
      y2 = y1;
      y1 = y0;
      return y0;
    };
  }

  // Extracts mono PCM samples from AudioBuffer (averages channels if stereo)
  function extractMonoSamples(audioBuffer) {
    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
    if (channels === 1) {
      return audioBuffer.getChannelData(0);
    }
    const mono = new Float32Array(length);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      mono[i] = (left[i] + right[i]) * 0.5;
    }
    return mono;
  }

  // Detects vocal phrases and onsets from audio buffer using VAD
  function detectVocalPhrases(audioBuffer, isVocalIsolated = true) {
    if (!audioBuffer) return [];
    const sampleRate = audioBuffer.sampleRate;
    const rawSamples = extractMonoSamples(audioBuffer);
    const length = rawSamples.length;

    // Filter audio if not an isolated vocal stem to focus on human voice formant band
    let samples = rawSamples;
    if (!isVocalIsolated) {
      const filter = createVocalBandpassFilter(sampleRate, 260, 3400);
      samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        samples[i] = filter(rawSamples[i]);
      }
    }

    // 25ms frame, 12.5ms hop
    const frameSize = Math.max(128, Math.round(sampleRate * 0.025));
    const hopSize = Math.max(64, Math.round(sampleRate * 0.0125));
    const numFrames = Math.floor((length - frameSize) / hopSize);
    if (numFrames < 10) return [];

    const frameEnergies = new Float32Array(numFrames);
    let maxEnergy = 0;

    for (let i = 0; i < numFrames; i++) {
      const offset = i * hopSize;
      let sum = 0;
      for (let j = 0; j < frameSize; j++) {
        const val = samples[offset + j];
        sum += val * val;
      }
      const rms = Math.sqrt(sum / frameSize);
      frameEnergies[i] = rms;
      if (rms > maxEnergy) maxEnergy = rms;
    }

    if (maxEnergy < 0.0005) return [];

    // Smooth energy envelope (fast attack 25ms, release 100ms)
    const attackAlpha = Math.exp(-0.0125 / 0.025);
    const releaseAlpha = Math.exp(-0.0125 / 0.100);
    const envelope = new Float32Array(numFrames);
    let currentEnv = 0;
    for (let i = 0; i < numFrames; i++) {
      const val = frameEnergies[i];
      if (val > currentEnv) {
        currentEnv = val + (currentEnv - val) * attackAlpha;
      } else {
        currentEnv = val + (currentEnv - val) * releaseAlpha;
      }
      envelope[i] = currentEnv;
    }

    // Sample envelope percentiles to adaptively determine voice activity threshold
    const step = Math.max(1, Math.floor(numFrames / 5000));
    const subsampled = [];
    for (let i = 0; i < numFrames; i += step) {
      if (envelope[i] > 0.0001) subsampled.push(envelope[i]);
    }
    subsampled.sort((a, b) => a - b);

    const p15 = subsampled[Math.floor(subsampled.length * 0.15)] || 0.001;
    const p85 = subsampled[Math.floor(subsampled.length * 0.85)] || maxEnergy * 0.5;

    // Dynamic threshold: higher confidence for voice onset
    const voiceThreshold = isVocalIsolated
      ? Math.max(p15 * 1.5, p15 + (p85 - p15) * 0.12, maxEnergy * 0.05)
      : Math.max(p15 * 1.8, p15 + (p85 - p15) * 0.22, maxEnergy * 0.10);

    const minSilenceFrames = Math.round((isVocalIsolated ? 0.42 : 0.55) * (sampleRate / hopSize));
    const minVoiceFrames = Math.round(0.28 * (sampleRate / hopSize));

    const intervals = [];
    let inVoice = false;
    let startFrame = 0;
    let silenceFrames = 0;

    for (let i = 0; i < numFrames; i++) {
      const active = envelope[i] >= voiceThreshold;
      if (active) {
        if (!inVoice) {
          inVoice = true;
          startFrame = i;
        }
        silenceFrames = 0;
      } else if (inVoice) {
        silenceFrames++;
        if (silenceFrames >= minSilenceFrames) {
          const endFrame = i - silenceFrames;
          if (endFrame - startFrame >= minVoiceFrames) {
            // Apply slight lookahead padding (-60ms) and release padding (+120ms)
            const startTime = Math.max(0, (startFrame * hopSize) / sampleRate - 0.06);
            const endTime = Math.min(audioBuffer.duration, (endFrame * hopSize) / sampleRate + 0.12);
            intervals.push({ start: startTime, end: endTime });
          }
          inVoice = false;
        }
      }
    }

    // Flush last interval if file ended during voice
    if (inVoice) {
      const endFrame = numFrames - 1;
      if (endFrame - startFrame >= minVoiceFrames) {
        intervals.push({
          start: Math.max(0, (startFrame * hopSize) / sampleRate - 0.06),
          end: Math.min(audioBuffer.duration, (endFrame * hopSize) / sampleRate + 0.12)
        });
      }
    }

    return intervals;
  }

  // Rough syllable and phonetic weight estimation for duration proportionality
  function estimateLineWeight(text) {
    const clean = String(text || '').trim();
    if (!clean) return 1;
    const words = clean.split(/\s+/).filter(Boolean);
    let syllables = 0;
    for (const word of words) {
      const matches = word.match(/[aeiouyáéíóúãõâêîôûàèìòùäëïöü]+/gi);
      syllables += matches ? matches.length : 1;
    }
    return Math.max(1, syllables + words.length * 0.35);
  }

  // Aligns lyric lines to detected acoustic phrases using dynamic programming
  function alignLinesToAcousticPhrases(lines, phrases, totalAudioDuration = 0) {
    const validLines = lines.map(line => String(line || '').trim()).filter(Boolean);
    if (!validLines.length) return [];
    if (!phrases.length) {
      // Fallback: distribute evenly if no phrases were detected
      const step = totalAudioDuration ? (totalAudioDuration / (validLines.length + 1)) : 5;
      return validLines.map((line, idx) => ({
        text: line,
        time: Math.round((idx + 1) * step * 1000),
        end: Math.round(((idx + 1) * step + step * 0.8) * 1000),
        words: generateWordCues(line, (idx + 1) * step, (idx + 1) * step + step * 0.8)
      }));
    }

    const N = validLines.length;
    const M = phrases.length;
    const weights = validLines.map(estimateLineWeight);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // If fewer phrases than lines, subdivide phrases monotonically
    if (M < N) {
      const results = [];
      let pIdx = 0;
      for (let i = 0; i < N; i++) {
        const p = phrases[Math.min(pIdx, M - 1)];
        const subFraction = 1 / Math.ceil(N / M);
        const subDuration = (p.end - p.start) * subFraction;
        const subStart = p.start + (i % Math.ceil(N / M)) * subDuration;
        const subEnd = Math.min(p.end, subStart + subDuration);
        results.push({
          text: validLines[i],
          time: Math.round(subStart * 1000),
          end: Math.round(subEnd * 1000),
          words: generateWordCues(validLines[i], subStart, subEnd)
        });
        if (pIdx < M - 1 && (i + 1) * M / N >= (pIdx + 1)) pIdx++;
      }
      return results;
    }

    // Dynamic Programming: partition M phrases into N contiguous blocks
    function groupNetSinging(j, k) {
      let sum = 0;
      for (let idx = j; idx <= k; idx++) {
        sum += (phrases[idx].end - phrases[idx].start);
      }
      return sum;
    }

    const totalNetSinging = phrases.reduce((acc, p) => acc + (p.end - p.start), 0) || 1;

    // dp[i][j]: min cost of assigning first i lines to first j phrases
    const dp = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(Infinity));
    const parent = Array.from({ length: N + 1 }, () => new Int32Array(M + 1).fill(-1));
    dp[0][0] = 0;

    for (let i = 1; i <= N; i++) {
      const targetRatio = weights[i - 1] / totalWeight;
      for (let j = i; j <= M - (N - i); j++) {
        for (let k = i - 1; k < j; k++) {
          if (dp[i - 1][k] === Infinity) continue;

          // Huge penalty for spanning long silence breaks (>2.2s) within the SAME lyric line
          let gapPenalty = 0;
          for (let gapIdx = k; gapIdx < j - 1; gapIdx++) {
            const gap = phrases[gapIdx + 1].start - phrases[gapIdx].end;
            if (gap > 2.0) gapPenalty += (gap - 2.0) * 25.0;
          }

          const phraseDuration = groupNetSinging(k, j - 1);
          const ratio = phraseDuration / totalNetSinging;
          const diff = ratio - targetRatio;
          const cost = dp[i - 1][k] + (diff * diff * 120) + gapPenalty;

          if (cost < dp[i][j]) {
            dp[i][j] = cost;
            parent[i][j] = k;
          }
        }
      }
    }

    // Backtrack to find boundaries
    const boundaries = [];
    let currJ = M;
    for (let i = N; i >= 1; i--) {
      const prevJ = parent[i][currJ];
      boundaries.push({ lineIndex: i - 1, startPhrase: prevJ >= 0 ? prevJ : i - 1, endPhrase: currJ - 1 });
      currJ = prevJ >= 0 ? prevJ : i - 1;
    }
    boundaries.reverse();

    return boundaries.map(b => {
      const start = phrases[b.startPhrase].start;
      const end = phrases[b.endPhrase].end;
      return {
        text: validLines[b.lineIndex],
        time: Math.round(start * 1000),
        end: Math.round(end * 1000),
        words: generateWordCues(validLines[b.lineIndex], start, end)
      };
    });
  }

  // Generates word-level timing cues within a phrase for karaoke bounce & highlight
  function generateWordCues(text, startSec, endSec) {
    const rawTokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!rawTokens.length) return [];
    const totalDuration = Math.max(0.1, endSec - startSec);
    const weights = rawTokens.map(w => {
      const syllables = (w.match(/[aeiouyáéíóúãõâêîôûàèìòùäëïöü]+/gi) || []).length;
      return Math.max(1, syllables + w.length * 0.15);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const cues = [];
    let currentStart = startSec;
    for (let i = 0; i < rawTokens.length; i++) {
      const wordDuration = (weights[i] / totalWeight) * totalDuration;
      const wordEnd = (i === rawTokens.length - 1) ? endSec : currentStart + wordDuration;
      cues.push({
        word: rawTokens[i],
        index: i,
        start: Number(currentStart.toFixed(3)),
        end: Number(wordEnd.toFixed(3))
      });
      currentStart = wordEnd;
    }
    return cues;
  }

  // Formats milliseconds into standard LRC timestamp [mm:ss.xx]
  function formatLrcTimestamp(ms) {
    const totalCentis = Math.max(0, Math.round(ms / 10));
    const mins = Math.floor(totalCentis / 6000);
    const secs = Math.floor((totalCentis % 6000) / 100);
    const centis = totalCentis % 100;
    return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}]`;
  }

  // --- Multi-Provider Online Sync Engine (LRCLIB Exact Duration Matching) ---

  function cleanSearchQuery(title, artist = '') {
    const cleanTitle = String(title || '')
      .replace(/^\s*\d+[\s.-]+/, '') // strip leading track numbers e.g. "01 - "
      .replace(/\s*[\(\[](?:official\s*(?:video|audio|music\s*video)|lyric\s*video|clipe\s*oficial|áudio\s*oficial|remaster(?:ed)?(?:\s*\d+)?|remasterizado|ao\s*vivo|live|hd|4k)[^\)\]]*[\)\]]/gi, '')
      .replace(/(?:roformer|karaoke|instrumentals?|vocals?|backing|stem|mt\s*\d+).*/ig, '')
      .replace(/\s+/g, ' ')
      .trim();

    const cleanArtist = String(artist || '')
      .replace(/\s*-\s*topic\b/gi, '')
      .replace(/\s*vevo\b/gi, '')
      .trim();

    return { title: cleanTitle, artist: cleanArtist };
  }

  async function fetchOnlineSyncedLyrics(title, artist = '', duration = 0) {
    const { title: cleanTitle, artist: cleanArtist } = cleanSearchQuery(title, artist);
    if (!cleanTitle) return null;

    const headers = { 'X-User-Agent': 'VoxStage/2.0 (local karaoke player auto-sync)' };

    // 1. Try exact duration get if duration is available (LRCLIB exact match)
    if (duration > 10) {
      try {
        const roundedDuration = Math.round(duration);
        let url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&duration=${roundedDuration}`;
        if (cleanArtist) url += `&artist_name=${encodeURIComponent(cleanArtist)}`;

        const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
        if (response.ok) {
          const data = await response.json();
          if (data && data.syncedLyrics && !data.instrumental) {
            return {
              syncedLyrics: data.syncedLyrics,
              plainLyrics: data.plainLyrics || '',
              trackName: data.trackName || cleanTitle,
              artistName: data.artistName || cleanArtist,
              albumName: data.albumName || '',
              duration: data.duration,
              lyricProvider: 'LRCLIB (correspondência exata de duração)'
            };
          }
        }
      } catch (err) {
        console.warn('LRCLIB exact match query failed or timed out:', err);
      }
    }

    // 2. Fallback: Search endpoint with query
    try {
      const q = [cleanTitle, cleanArtist].filter(Boolean).join(' ');
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      if (response.ok) {
        const results = await response.json();
        if (Array.isArray(results) && results.length) {
          const syncedCandidates = results.filter(r => r && r.syncedLyrics && !r.instrumental);
          if (syncedCandidates.length) {
            if (duration > 10) {
              // Score by duration closeness
              syncedCandidates.sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration));
              const best = syncedCandidates[0];
              if (Math.abs((best.duration || 0) - duration) <= 4.0) {
                return {
                  syncedLyrics: best.syncedLyrics,
                  plainLyrics: best.plainLyrics || '',
                  trackName: best.trackName || cleanTitle,
                  artistName: best.artistName || cleanArtist,
                  albumName: best.albumName || '',
                  duration: best.duration,
                  lyricProvider: 'LRCLIB (sincronizada)'
                };
              }
            } else {
              const best = syncedCandidates[0];
              return {
                syncedLyrics: best.syncedLyrics,
                plainLyrics: best.plainLyrics || '',
                trackName: best.trackName || cleanTitle,
                artistName: best.artistName || cleanArtist,
                albumName: best.albumName || '',
                duration: best.duration,
                lyricProvider: 'LRCLIB (sincronizada)'
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn('LRCLIB search query failed or timed out:', err);
    }

    return null;
  }

  // --- Decoding Helper ---

  async function resolveAudioBufferForSong(song = window.current) {
    if (!song) return null;
    if (song.buffers?.Lead) return { buffer: song.buffers.Lead, isIsolated: true };
    if (song.buffers?.Inst) return { buffer: song.buffers.Inst, isIsolated: false };

    const stem = song.lead || song.inst || song.source;
    if (!stem) return null;

    const ctx = (typeof window.audioContext !== 'undefined' && window.audioContext)
      ? window.audioContext
      : new (window.AudioContext || window.webkitAudioContext)();

    const mediaUrlFn = window.mediaUrl || (name => `/api/remote/media/${name}`);
    const url = mediaUrlFn(stem);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha ao ler áudio (${response.status})`);
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);

    if (song.buffers) {
      if (song.lead && stem === song.lead) song.buffers.Lead = decoded;
      else song.buffers.Inst = decoded;
    }
    return { buffer: decoded, isIsolated: Boolean(song.lead && stem === song.lead) };
  }

  // --- High-Level AutoSync Manager ---

  const AutoSyncManager = {
    isProcessing: false,

    detectVocalPhrases,
    alignLinesToAcousticPhrases,
    fetchOnlineSyncedLyrics,
    estimateLineWeight,

    // Run AutoSync on the song (prioritizing online exact match, then acoustic local aligner)
    async autoSyncSong(song = window.current, options = {}) {
      if (!song) {
        if (typeof window.toast === 'function') window.toast('Toque uma música primeiro.');
        return null;
      }

      this.isProcessing = true;
      const onProgress = options.onProgress || (() => {});

      try {
        const audioDuration = song.duration || (song.buffers?.Inst?.duration) || (song.buffers?.Lead?.duration) || 0;

        // Step 1: Check Online Synced DB if not forced local
        if (!options.forceLocal && song.title) {
          onProgress('Buscando sincronização no catálogo LRCLIB…');
          const onlineMatch = await fetchOnlineSyncedLyrics(song.title, song.artist, audioDuration);
          if (onlineMatch && onlineMatch.syncedLyrics) {
            onProgress('Sincronização encontrada com exatidão!');
            return {
              engine: 'online',
              syncedLyrics: onlineMatch.syncedLyrics,
              plainLyrics: onlineMatch.plainLyrics,
              provider: onlineMatch.lyricProvider
            };
          }
        }

        // Step 2: Local Acoustic Aligner
        onProgress('Carregando áudio para análise acústica local…');
        const audioInfo = await resolveAudioBufferForSong(song);
        if (!audioInfo || !audioInfo.buffer) {
          throw new Error('Não foi possível carregar a faixa de áudio para sincronizar.');
        }

        const linesText = options.lyricsText || song.plainLyrics || (options.editorValue) || '';
        const rawLines = linesText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) {
          throw new Error('A música não tem texto de letra. Cole ou escreva a letra no editor.');
        }

        onProgress(audioInfo.isIsolated
          ? 'Detectando atividade na faixa vocal isolada…'
          : 'Analisando frequências vocais no instrumental…');

        const phrases = detectVocalPhrases(audioInfo.buffer, audioInfo.isIsolated);
        if (!phrases.length) {
          throw new Error('Não identifiquei frases vocais suficientes no áudio.');
        }

        onProgress(`Alinhando ${rawLines.length} frases com os vocais detectados…`);
        const alignedLines = alignLinesToAcousticPhrases(rawLines, phrases, audioInfo.buffer.duration);

        const syncedLyrics = alignedLines.map(line => `${formatLrcTimestamp(line.time)}${line.text}`).join('\n');
        const plainLyrics = rawLines.join('\n');

        return {
          engine: 'acoustic',
          syncedLyrics,
          plainLyrics,
          alignedLines,
          phrasesCount: phrases.length,
          provider: 'VoxStage · Alinhador Acústico Local'
        };
      } finally {
        this.isProcessing = false;
      }
    },

    // Trigger auto-sync inside the manual line sync dialog
    async triggerInManualSyncDialog() {
      const activeVoice = window.manualSyncFocus || 'lead';
      const editor = (typeof window.manualSyncEditor === 'function')
        ? window.manualSyncEditor(activeVoice)
        : document.getElementById(activeVoice === 'backing' ? 'manualSyncBackingText' : activeVoice === 'parallel' ? 'manualSyncParallelText' : 'manualSyncText');

      if (!editor) return;
      const editorValue = editor.value.trim();

      const btn = document.getElementById('manualAutoSyncButton');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="auto-sync-spinner">⏳</span> Sincronizando…';
      }

      const statusEl = document.getElementById('manualSyncCurrent');
      const prevStatus = statusEl ? statusEl.innerHTML : '';

      try {
        const currentSong = window.current;
        if (!currentSong) {
          if (typeof window.toast === 'function') window.toast('Toque a música primeiro e aguarde o áudio carregar.');
          return;
        }

        const audioDuration = currentSong.duration || (currentSong.buffers?.Inst?.duration) || 0;
        let result = null;

        // If editor has lines, prioritize acoustic alignment of those exact lines with the vocal track!
        if (editorValue) {
          if (statusEl) statusEl.textContent = '⚡ Analisando voz da música e calculando tempos…';
          result = await this.autoSyncSong(currentSong, {
            forceLocal: true,
            lyricsText: editorValue,
            onProgress: msg => { if (statusEl) statusEl.textContent = msg; }
          });
        } else {
          // If editor is empty, try online sync first
          if (statusEl) statusEl.textContent = '⚡ Buscando letra sincronizada online…';
          result = await this.autoSyncSong(currentSong, {
            onProgress: msg => { if (statusEl) statusEl.textContent = msg; }
          });
        }

        if (!result) return;

        // Update manualSyncVoices with newly computed times
        if (window.manualSyncVoices && window.VoxStageLyrics) {
          const lines = (typeof window.parseSyncedLyrics === 'function')
            ? window.parseSyncedLyrics(result.syncedLyrics)
            : [];

          const unified = (typeof window.unifiedLyricsForSong === 'function')
            ? window.unifiedLyricsForSong({ ...currentSong, syncedLyrics: result.syncedLyrics, plainLyrics: result.plainLyrics })
            : { lyricLines: lines };

          const incoming = window.VoxStageLyrics.fromLegacy(
            { syncedLyrics: result.syncedLyrics, plainLyrics: result.plainLyrics },
            unified,
            window.lyricWordEntries || (t => window.VoxStageLyrics.wordEntries(t))
          );

          if (incoming[activeVoice] && incoming[activeVoice].length) {
            window.manualSyncVoices[activeVoice] = incoming[activeVoice];
            editor.value = window.VoxStageLyrics.editorText(window.manualSyncVoices[activeVoice]);
          }

          if (typeof window.restoreManualVoiceEditors === 'function') window.restoreManualVoiceEditors();
          if (typeof window.updateManualSaveButton === 'function') window.updateManualSaveButton();

          const progressEl = document.getElementById('manualSyncProgress');
          if (progressEl) {
            const count = window.manualSyncVoices[activeVoice].filter(r => r.time != null).length;
            progressEl.textContent = `✨ ${count} frases sincronizadas automaticamente!`;
          }

          if (statusEl) {
            statusEl.innerHTML = `<span style="color:#74dbd3;font-weight:700;">✨ Sincronização automática concluída!</span><br><small style="color:#bbb;font-size:14px;">Os tempos foram aplicados às frases. Clique em “Salvar sync” ou ajuste conforme desejar.</small>`;
          }

          if (typeof window.toast === 'function') {
            window.toast(result.engine === 'online'
              ? 'Letra sincronizada via catálogo LRCLIB! Clique em Salvar sync.'
              : 'Letra alinhada automaticamente com os vocais da música! Clique em Salvar sync.');
          }
        }
      } catch (err) {
        console.error('Falha no auto-sync:', err);
        if (statusEl) statusEl.innerHTML = prevStatus;
        if (typeof window.toast === 'function') window.toast(`Auto-Sync: ${err.message || err}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="auto-sync-icon">⚡</span> Auto-Sincronizar';
        }
      }
    },

    // Trigger auto-sync inside the lyrics search dialog
    async triggerInLyricsDialog() {
      const currentSong = window.current;
      if (!currentSong) {
        if (typeof window.toast === 'function') window.toast('Toque uma música primeiro.');
        return;
      }

      const btn = document.getElementById('lyricsDialogAutoSyncBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="auto-sync-spinner">⏳</span> Sincronizando…';
      }

      const statusEl = document.getElementById('lyricsDialogStatus');
      const prevStatus = statusEl ? statusEl.textContent : '';

      try {
        if (statusEl) statusEl.textContent = '⚡ Buscando sincronização precisa…';

        const pasteInput = document.getElementById('lyricsPasteInput');
        const customLyrics = pasteInput ? pasteInput.value.trim() : '';

        const result = await this.autoSyncSong(currentSong, {
          lyricsText: customLyrics || undefined,
          onProgress: msg => { if (statusEl) statusEl.textContent = msg; }
        });

        if (!result) return;

        // Apply to current song and library
        if (typeof window.useLyricCandidate === 'function') {
          await window.useLyricCandidate({
            syncedLyrics: result.syncedLyrics,
            plainLyrics: result.plainLyrics,
            trackName: currentSong.title,
            artistName: currentSong.artist,
            lyricProvider: result.provider
          }, 'current');

          if (typeof window.toast === 'function') {
            window.toast(`Letra sincronizada automaticamente (${result.engine === 'online' ? 'LRCLIB' : 'Alinhador Acústico'})!`);
          }
        }
      } catch (err) {
        console.error('Falha no auto-sync na janela de letras:', err);
        if (statusEl) statusEl.textContent = prevStatus;
        if (typeof window.toast === 'function') window.toast(`Auto-Sync: ${err.message || err}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="auto-sync-icon">⚡</span> Sincronizar Automaticamente';
        }
      }
    }
  };

  window.VoxStageAutoSync = AutoSyncManager;

  // --- UI Injections and Event Bindings ---

  function setupAutoSyncUI() {
    // 1. Inject Style for AutoSync elements
    if (!document.getElementById('voxstage-auto-sync-styles')) {
      const style = document.createElement('style');
      style.id = 'voxstage-auto-sync-styles';
      style.textContent = `
        .auto-sync-btn {
          border-color: #74dbd3 !important;
          color: #74dbd3 !important;
          font-weight: 700 !important;
          transition: all 0.2s ease !important;
        }
        .auto-sync-btn:hover:not(:disabled) {
          background: rgba(116, 219, 211, 0.16) !important;
          border-color: #92ebe4 !important;
          color: #92ebe4 !important;
          transform: translateY(-1px);
        }
        .auto-sync-btn:active:not(:disabled) {
          transform: translateY(0);
        }
        .lyrics-auto-sync-box {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin: 10px 0 14px;
          padding: 12px 14px;
          background: rgba(116, 219, 211, 0.07);
          border: 1px solid rgba(116, 219, 211, 0.24);
          border-radius: 12px;
        }
        .lyrics-auto-sync-box button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 40px;
          border-color: #74dbd3;
          color: #74dbd3;
          font-weight: 700;
          font-size: 13px;
        }
        .lyrics-auto-sync-box button:hover:not(:disabled) {
          background: rgba(116, 219, 211, 0.18);
          color: #fff;
        }
        .lyrics-auto-sync-hint {
          color: #b0d8d5;
          font-size: 11px;
          line-height: 1.4;
          text-align: center;
        }
        .auto-sync-icon {
          display: inline-block;
          font-size: 15px;
          filter: drop-shadow(0 0 4px #74dbd3);
        }
        .auto-sync-spinner {
          display: inline-block;
          animation: autoSyncSpin 1s infinite linear;
        }
        @keyframes autoSyncSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.append(style);
    }

    // 2. Add "⚡ Auto-Sincronizar" to manualSyncDialog footer
    const manualDialog = document.getElementById('manualSyncDialog');
    if (manualDialog && !document.getElementById('manualAutoSyncButton')) {
      const footer = manualDialog.querySelector('footer');
      const startBtn = document.getElementById('startManualSync');
      if (footer && startBtn) {
        const autoBtn = document.createElement('button');
        autoBtn.id = 'manualAutoSyncButton';
        autoBtn.className = 'btn secondary auto-sync-btn';
        autoBtn.type = 'button';
        autoBtn.innerHTML = '<span class="auto-sync-icon">⚡</span> Auto-Sincronizar';
        autoBtn.title = 'Alinha automaticamente a letra com os vocais da música usando IA acústica ou banco de dados';
        autoBtn.onclick = () => AutoSyncManager.triggerInManualSyncDialog();

        // Place right beside "Começar do início"
        startBtn.after(autoBtn);
      }
    }

    // 3. Add "⚡ Sincronizar Automaticamente" to lyricsDialog
    const lyricsDialog = document.getElementById('lyricsDialog');
    if (lyricsDialog && !document.getElementById('lyricsDialogAutoSyncBtn')) {
      const card = lyricsDialog.querySelector('.lyrics-dialog-card');
      const searchRow = lyricsDialog.querySelector('.lyrics-search-row');
      if (card && searchRow) {
        const box = document.createElement('div');
        box.className = 'lyrics-auto-sync-box';
        box.innerHTML = `
          <button class="btn secondary" id="lyricsDialogAutoSyncBtn" type="button">
            <span class="auto-sync-icon">⚡</span> Sincronizar Automaticamente
          </button>
          <span class="lyrics-auto-sync-hint">
            Busca tempos exatos no catálogo LRCLIB ou alinha o texto diretamente com a faixa de voz da música.
          </span>
        `;
        searchRow.after(box);

        const btn = document.getElementById('lyricsDialogAutoSyncBtn');
        if (btn) btn.onclick = () => AutoSyncManager.triggerInLyricsDialog();
      }
    }

    // 4. Delegate track-menu click for "data-auto-sync"
    document.addEventListener('click', async (event) => {
      const autoSyncTarget = event.target.closest('[data-auto-sync]');
      if (autoSyncTarget) {
        event.preventDefault();
        event.stopPropagation();
        const songId = autoSyncTarget.dataset.autoSync;
        const song = (window.songs || []).find(s => s.id === songId);
        if (!song) return;

        if (typeof window.toast === 'function') {
          window.toast(`⚡ Sincronizando “${song.title}”…`);
        }

        try {
          const result = await AutoSyncManager.autoSyncSong(song);
          if (result && typeof window.api === 'function') {
            const updated = {
              ...song,
              syncedLyrics: result.syncedLyrics,
              plainLyrics: result.plainLyrics,
              lyricProvider: result.provider
            };
            await window.api('/api/library', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updated)
            });
            Object.assign(song, updated);
            if (window.current && window.current.id === song.id) {
              Object.assign(window.current, updated);
              if (typeof window.updateLyrics === 'function') window.updateLyrics(window.playbackPosition());
            }
            if (typeof window.toast === 'function') {
              window.toast(`“${song.title}” sincronizada com sucesso!`);
            }
          }
        } catch (err) {
          console.error(err);
          if (typeof window.toast === 'function') window.toast(`Erro ao sincronizar: ${err.message || err}`);
        }
      }
    });
  }

  // Bind on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAutoSyncUI);
  } else {
    setupAutoSyncUI();
  }

  // Also re-verify bindings when dialogs open
  const observer = new MutationObserver(() => {
    setupAutoSyncUI();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
