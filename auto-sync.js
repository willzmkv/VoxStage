/* VoxStage 2.0: High-Accuracy Automatic Lyrics Synchronization Engine.
 * Provides Dual-Engine Auto-Sync:
 *   1. Multi-Provider Instant Synced DB Match (LRCLIB Exact Duration Matching)
 *   2. Local Acoustic Voice-Activity & Energy Aligner (Offline / Custom Tracks / Isolated Stems)
 *
 * Runs completely in the background without requiring the song to be actively playing.
 * Uses native VoxStage monochrome styling and real visual progress bar.
 */
(() => {
  'use strict';

  // --- Monochrome Icon Helpers ---

  const ICONS = {
    sync: '<svg class="vox-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    success: '<svg class="vox-icon-success" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    play: '<svg class="vox-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7Z"/></svg>',
    spinner: '<svg class="vox-icon-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>'
  };

  // --- Song & Library Accessors (Never fails with "Escolha uma música primeiro") ---

  function getAllSongs() {
    try {
      if (typeof songs !== 'undefined' && Array.isArray(songs) && songs.length) return songs;
    } catch {}
    if (typeof window.songs !== 'undefined' && Array.isArray(window.songs) && window.songs.length) return window.songs;
    return [];
  }

  function resolveActiveSong(explicitSong = null) {
    if (explicitSong && explicitSong.id) return explicitSong;

    // 1. Check lexical current or window.current
    try {
      if (typeof current !== 'undefined' && current && current.id) {
        window.current = current;
        return current;
      }
    } catch {}
    if (typeof window.current !== 'undefined' && window.current && window.current.id) {
      return window.current;
    }

    const all = getAllSongs();

    // 2. Check manualSyncReturn
    try {
      if (typeof manualSyncReturn !== 'undefined' && manualSyncReturn?.songId) {
        const found = all.find(s => s.id === manualSyncReturn.songId);
        if (found) return found;
      }
    } catch {}
    if (typeof window.manualSyncReturn !== 'undefined' && window.manualSyncReturn?.songId) {
      const found = all.find(s => s.id === window.manualSyncReturn.songId);
      if (found) return found;
    }

    // 3. Check editingSong
    try {
      if (typeof editingSong !== 'undefined' && editingSong && editingSong.id) return editingSong;
    } catch {}
    if (typeof window.editingSong !== 'undefined' && window.editingSong && window.editingSong.id) return window.editingSong;

    // 4. Check display / nowTitle element
    const trackEl = document.getElementById('dispTrack') || document.getElementById('nowTitle');
    if (trackEl && trackEl.textContent && trackEl.textContent !== '—' && trackEl.textContent.trim() !== '') {
      const text = trackEl.textContent.trim().toLowerCase();
      const found = all.find(s => s.title && text.includes(s.title.toLowerCase()));
      if (found) return found;
    }

    // 5. Fallback: first available song in library
    if (all.length) return all[0];
    return null;
  }

  // --- Voice Activity Detection & Acoustic Alignment Primitives ---

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

  function extractMonoSamples(audioBuffer) {
    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
    if (channels === 1) return audioBuffer.getChannelData(0);
    const mono = new Float32Array(length);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      mono[i] = (left[i] + right[i]) * 0.5;
    }
    return mono;
  }

  function detectVocalPhrases(audioBuffer, isVocalIsolated = true) {
    if (!audioBuffer) return [];
    const sampleRate = audioBuffer.sampleRate;
    const rawSamples = extractMonoSamples(audioBuffer);
    const length = rawSamples.length;

    let samples = rawSamples;
    if (!isVocalIsolated) {
      const filter = createVocalBandpassFilter(sampleRate, 260, 3400);
      samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        samples[i] = filter(rawSamples[i]);
      }
    }

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

    const step = Math.max(1, Math.floor(numFrames / 5000));
    const subsampled = [];
    for (let i = 0; i < numFrames; i += step) {
      if (envelope[i] > 0.0001) subsampled.push(envelope[i]);
    }
    subsampled.sort((a, b) => a - b);

    const p15 = subsampled[Math.floor(subsampled.length * 0.15)] || 0.001;
    const p85 = subsampled[Math.floor(subsampled.length * 0.85)] || maxEnergy * 0.5;

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
            const startTime = Math.max(0, (startFrame * hopSize) / sampleRate - 0.06);
            const endTime = Math.min(audioBuffer.duration, (endFrame * hopSize) / sampleRate + 0.12);
            intervals.push({ start: startTime, end: endTime });
          }
          inVoice = false;
        }
      }
    }

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

  function alignLinesToAcousticPhrases(lines, phrases, totalAudioDuration = 0) {
    const validLines = lines.map(line => String(line || '').trim()).filter(Boolean);
    if (!validLines.length) return [];
    if (!phrases.length) {
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

    function groupNetSinging(j, k) {
      let sum = 0;
      for (let idx = j; idx <= k; idx++) {
        sum += (phrases[idx].end - phrases[idx].start);
      }
      return sum;
    }

    const totalNetSinging = phrases.reduce((acc, p) => acc + (p.end - p.start), 0) || 1;
    const dp = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(Infinity));
    const parent = Array.from({ length: N + 1 }, () => new Int32Array(M + 1).fill(-1));
    dp[0][0] = 0;

    for (let i = 1; i <= N; i++) {
      const targetRatio = weights[i - 1] / totalWeight;
      for (let j = i; j <= M - (N - i); j++) {
        for (let k = i - 1; k < j; k++) {
          if (dp[i - 1][k] === Infinity) continue;

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
      .replace(/^\s*\d+[\s.-]+/, '')
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
              lyricProvider: 'LRCLIB (correspondência exata)'
            };
          }
        }
      } catch (err) {
        console.warn('LRCLIB exact match query failed or timed out:', err);
      }
    }

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

  // --- Background Audio Decoding (Without starting playback) ---

  function resolveMediaUrl(name) {
    if (!name) return '';
    if (typeof mediaUrl === 'function') return mediaUrl(name);
    if (typeof window.mediaUrl === 'function') return window.mediaUrl(name);
    if (typeof mobileNative !== 'undefined' && mobileNative && typeof mobileMusicDirectory !== 'undefined' && window.__TAURI__?.core?.convertFileSrc) {
      const path = `${mobileMusicDirectory.replace(/[\\/]$/, '')}/${name}`;
      return window.__TAURI__.core.convertFileSrc(path);
    }
    return `/music/${encodeURIComponent(name)}`;
  }

  async function resolveAudioBufferForSong(song) {
    if (!song) return null;
    if (song.buffers?.Lead) return { buffer: song.buffers.Lead, isIsolated: true };
    if (song.buffers?.Inst && !song.lead) return { buffer: song.buffers.Inst, isIsolated: false };

    // Prioritize vocal lead stem for accurate vocal activity and melody sync!
    const stem = song.lead || song.source || song.inst;
    if (!stem) return null;

    const ctx = (typeof window.audioContext !== 'undefined' && window.audioContext)
      ? window.audioContext
      : new (window.AudioContext || window.webkitAudioContext)();

    const url = resolveMediaUrl(stem);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha ao ler áudio (${response.status})`);
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);

    if (!song.buffers) song.buffers = {};
    const isIsolated = Boolean(song.lead && stem === song.lead);
    if (isIsolated) {
      song.buffers.Lead = decoded;
    } else {
      song.buffers.Inst = decoded;
    }
    return { buffer: decoded, isIsolated };
  }

  // --- Dedicated Progress Modal with Real Visual Progress Bar ---

  let autoSyncModalEl = null;

  function ensureAutoSyncModal() {
    if (autoSyncModalEl) return autoSyncModalEl;
    let modal = document.getElementById('autoSyncModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'autoSyncModal';
      modal.className = 'vox-sync-modal-overlay';
      modal.innerHTML = `
        <div class="vox-sync-card" role="dialog" aria-modal="true">
          <header class="vox-sync-head">
            <div>
              <span class="vox-sync-kicker">VOXSTAGE · AUTO-SYNC</span>
              <h2 id="autoSyncModalTitle">Sincronização Automática</h2>
            </div>
            <button class="vox-sync-close" id="autoSyncModalClose" aria-label="Fechar">×</button>
          </header>

          <div id="autoSyncBodyProgress" class="vox-sync-body">
            <div class="vox-sync-progress-box">
              <div class="vox-sync-progress-header">
                <span class="vox-sync-progress-status" id="autoSyncModalStatus">Iniciando…</span>
                <span class="vox-sync-progress-percent" id="autoSyncPercentText">10%</span>
              </div>
              <div class="vox-sync-progress-track">
                <div class="vox-sync-progress-bar" id="autoSyncBarFill" style="width: 10%;"></div>
              </div>
            </div>
          </div>

          <div id="autoSyncBodyLyricsPrompt" class="vox-sync-body" hidden>
            <p class="vox-sync-prompt-copy">
              Cole a letra da música abaixo. O motor acústico alinhará cada frase aos vocais cantados:
            </p>
            <textarea id="autoSyncPromptText" rows="7" placeholder="Cole a letra da música aqui, uma frase por linha…"></textarea>
            <button class="btn vox-sync-prompt-submit" id="autoSyncPromptSubmit" type="button">
              ${ICONS.sync} <span>Alinhar com a Voz da Música</span>
            </button>
          </div>

          <div id="autoSyncBodyReady" class="vox-sync-body" hidden>
            <div class="vox-sync-ready-icon">${ICONS.success}</div>
            <h3 class="vox-sync-ready-heading">Sincronização Concluída!</h3>
            <p class="vox-sync-ready-copy" id="autoSyncReadyMsg">Todas as frases foram alinhadas com exatidão.</p>
            <div class="vox-sync-actions">
              <button class="btn vox-sync-sing-action" id="autoSyncSingNowBtn" type="button">
                ${ICONS.play} <span>Cantar agora</span>
              </button>
              <button class="btn secondary" id="autoSyncDoneBtn" type="button">
                Concluir
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.append(modal);

      document.getElementById('autoSyncModalClose').onclick = closeAutoSyncModal;
      document.getElementById('autoSyncDoneBtn').onclick = closeAutoSyncModal;
    }
    autoSyncModalEl = modal;
    return modal;
  }

  function openAutoSyncModal(songTitle) {
    const modal = ensureAutoSyncModal();
    document.getElementById('autoSyncModalTitle').textContent = songTitle ? `“${songTitle}”` : 'Sincronização Automática';
    document.getElementById('autoSyncBodyProgress').hidden = false;
    document.getElementById('autoSyncBodyLyricsPrompt').hidden = true;
    document.getElementById('autoSyncBodyReady').hidden = true;
    updateAutoSyncModalStatus('Iniciando análise…', 10);
    modal.classList.add('show');
  }

  function updateAutoSyncModalStatus(msg, progressPercent) {
    ensureAutoSyncModal();
    const status = document.getElementById('autoSyncModalStatus');
    const percentEl = document.getElementById('autoSyncPercentText');
    const bar = document.getElementById('autoSyncBarFill');
    if (status) status.textContent = msg;
    if (progressPercent != null) {
      const pct = Math.max(5, Math.min(100, Math.round(progressPercent)));
      if (percentEl) percentEl.textContent = `${pct}%`;
      if (bar) bar.style.width = `${pct}%`;
    }
  }

  function showAutoSyncLyricsPrompt(onSubmit) {
    ensureAutoSyncModal();
    document.getElementById('autoSyncBodyProgress').hidden = true;
    document.getElementById('autoSyncBodyReady').hidden = true;
    const promptSection = document.getElementById('autoSyncBodyLyricsPrompt');
    promptSection.hidden = false;

    const textarea = document.getElementById('autoSyncPromptText');
    textarea.value = '';
    textarea.focus();

    const submitBtn = document.getElementById('autoSyncPromptSubmit');
    submitBtn.onclick = () => {
      const text = textarea.value.trim();
      if (!text) {
        if (typeof window.toast === 'function') window.toast('Cole o texto da letra primeiro.');
        return;
      }
      promptSection.hidden = true;
      document.getElementById('autoSyncBodyProgress').hidden = false;
      onSubmit(text);
    };
  }

  function showAutoSyncReady(song, phraseCount) {
    ensureAutoSyncModal();
    document.getElementById('autoSyncBodyProgress').hidden = true;
    document.getElementById('autoSyncBodyLyricsPrompt').hidden = true;
    const readySection = document.getElementById('autoSyncBodyReady');
    readySection.hidden = false;

    const msg = document.getElementById('autoSyncReadyMsg');
    if (msg) {
      msg.textContent = `${phraseCount} frases foram alinhadas à faixa vocal. A música já está pronta para o palco!`;
    }

    const singBtn = document.getElementById('autoSyncSingNowBtn');
    singBtn.onclick = async () => {
      closeAutoSyncModal();
      if (typeof window.playSong === 'function') {
        try {
          await window.playSong(song.id);
        } catch (playErr) {
          console.warn('Aviso ao iniciar reprodução:', playErr);
        }
        const display = document.getElementById('display');
        if (display) {
          display.classList.add('show');
          display.classList.remove('mobile-controls-hidden');
        }
      }
    };
  }

  function closeAutoSyncModal() {
    if (autoSyncModalEl) autoSyncModalEl.classList.remove('show');
  }

  // --- High-Level AutoSync Manager ---

  const AutoSyncManager = {
    isProcessing: false,

    detectVocalPhrases,
    alignLinesToAcousticPhrases,
    fetchOnlineSyncedLyrics,
    estimateLineWeight,

    // Run AutoSync on ANY song (does not require playback!)
    async autoSyncSong(song, options = {}) {
      const targetSong = resolveActiveSong(song);
      if (!targetSong) {
        if (typeof window.toast === 'function') window.toast('Selecione uma música primeiro.');
        return null;
      }

      this.isProcessing = true;
      const onProgress = options.onProgress || (() => {});

      try {
        const audioDuration = targetSong.duration || (targetSong.buffers?.Inst?.duration) || (targetSong.buffers?.Lead?.duration) || 0;

        // Step 1: Check Online Synced DB if not forced local and has title
        if (!options.forceLocal && targetSong.title) {
          onProgress('Buscando correspondência de duração exata no catálogo…', 25);
          const onlineMatch = await fetchOnlineSyncedLyrics(targetSong.title, targetSong.artist, audioDuration);
          if (onlineMatch && onlineMatch.syncedLyrics) {
            onProgress('Sincronização encontrada com exatidão!', 90);
            return {
              engine: 'online',
              syncedLyrics: onlineMatch.syncedLyrics,
              plainLyrics: onlineMatch.plainLyrics,
              provider: onlineMatch.lyricProvider,
              phrasesCount: onlineMatch.syncedLyrics.split(/\r?\n/).filter(Boolean).length
            };
          }
        }

        // Step 2: Local Acoustic Aligner (Decodes audio in background silently)
        onProgress('Decodificando áudio vocal em segundo plano…', 45);
        const audioInfo = await resolveAudioBufferForSong(targetSong);
        if (!audioInfo || !audioInfo.buffer) {
          throw new Error('Não foi possível carregar o arquivo de áudio da música para sincronizar.');
        }

        const linesText = options.lyricsText || targetSong.plainLyrics || (options.editorValue) || '';
        const rawLines = linesText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) {
          return { needsLyricsInput: true, song: targetSong };
        }

        onProgress(audioInfo.isIsolated
          ? 'Analisando ataques e pausas na faixa vocal isolada…'
          : 'Identificando frequências da voz no áudio…', 68);

        const phrases = detectVocalPhrases(audioInfo.buffer, audioInfo.isIsolated);
        if (!phrases.length) {
          throw new Error('Não identifiquei frases vocais suficientes no áudio desta música.');
        }

        onProgress(`Alinhando ${rawLines.length} frases com os vocais detectados…`, 86);
        const alignedLines = alignLinesToAcousticPhrases(rawLines, phrases, audioInfo.buffer.duration);

        const syncedLyrics = alignedLines.map(line => `${formatLrcTimestamp(line.time)}${line.text}`).join('\n');
        const plainLyrics = rawLines.join('\n');

        return {
          engine: 'acoustic',
          syncedLyrics,
          plainLyrics,
          alignedLines,
          phrasesCount: alignedLines.length,
          provider: 'VoxStage · Alinhador Acústico Local'
        };
      } finally {
        this.isProcessing = false;
      }
    },

    // Completely process song, save to library, and display ready-to-sing modal
    async processAndReadySong(song, options = {}) {
      const targetSong = resolveActiveSong(song);
      if (!targetSong) {
        if (typeof window.toast === 'function') window.toast('Selecione uma música primeiro.');
        return;
      }

      openAutoSyncModal(targetSong.title);
      updateAutoSyncModalStatus('Iniciando análise…', 15);

      const runSync = async (customText = null) => {
        try {
          const result = await this.autoSyncSong(targetSong, {
            ...options,
            lyricsText: customText || options.lyricsText,
            onProgress: (msg, pct) => updateAutoSyncModalStatus(msg, pct)
          });

          if (!result) return;

          // If plain lyrics are missing, prompt user inside modal
          if (result.needsLyricsInput) {
            showAutoSyncLyricsPrompt(text => runSync(text));
            return;
          }

          // Build storage format and project voices
          updateAutoSyncModalStatus('Gravando na biblioteca…', 94);
          const selection = {
            syncedLyrics: result.syncedLyrics,
            plainLyrics: result.plainLyrics,
            lyricTrack: targetSong.title,
            lyricArtist: targetSong.artist || '',
            lyricProvider: result.provider,
            wordTimings: [],
            lyricLineEnds: []
          };

          if (window.VoxStageLyrics) {
            const lines = (typeof window.parseSyncedLyrics === 'function')
              ? window.parseSyncedLyrics(result.syncedLyrics)
              : [];
            const incomingVoices = window.VoxStageLyrics.fromLegacy(
              selection,
              { lyricLines: lines },
              window.lyricWordEntries || (t => window.VoxStageLyrics.wordEntries(t))
            );
            Object.assign(selection, window.VoxStageLyrics.storage(incomingVoices));
          }

          // Save to library.json
          if (typeof window.api === 'function') {
            const cleanTarget = { ...targetSong };
            delete cleanTarget.buffers;
            const updated = { ...cleanTarget, ...selection };
            await window.api('/api/library', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updated)
            });
            Object.assign(targetSong, updated);
          }

          // Update current if this song is active
          if (window.current && window.current.id === targetSong.id) {
            Object.assign(window.current, selection);
            if (window.VoxStageLyrics && selection.lyricVoices) {
              const projected = window.VoxStageLyrics.project(selection.lyricVoices);
              Object.assign(window.current, projected);
            }
            window.current.playbackTracks = null;
            window.current.lyricIndex = null;
            window.current.vocalSilenceEnds = [];
            window.current.vocalSilenceState = null;
            if (typeof window.updateLyrics === 'function') {
              try {
                window.updateLyrics(window.playbackPosition ? window.playbackPosition() : 0);
              } catch (uiErr) {
                console.warn('Aviso ao atualizar UI das letras após auto-sync:', uiErr);
              }
            }
          }

          // Refresh library grid to update badge to "Sincronizada"
          if (typeof window.render === 'function') window.render();

          // Show ready to sing state
          updateAutoSyncModalStatus('Sincronização concluída!', 100);
          showAutoSyncReady(targetSong, result.phrasesCount || 0);

          if (typeof window.toast === 'function') {
            window.toast(`“${targetSong.title}” sincronizada com sucesso!`);
          }
        } catch (err) {
          console.error('Falha ao sincronizar música:', err);
          updateAutoSyncModalStatus(`Erro: ${err.message || err}`, 100);
          if (typeof window.toast === 'function') window.toast(`Auto-Sync: ${err.message || err}`);
        }
      };

      await runSync();
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
        btn.innerHTML = `${ICONS.spinner} <span>Sincronizando…</span>`;
      }

      const statusEl = document.getElementById('manualSyncCurrent');
      const prevStatus = statusEl ? statusEl.innerHTML : '';

      try {
        const targetSong = resolveActiveSong();
        if (!targetSong) {
          if (typeof window.toast === 'function') window.toast('Selecione uma música primeiro.');
          return;
        }

        // Render visual progress bar directly into manual sync card
        const setInlineProgress = (msg, pct) => {
          if (statusEl) {
            statusEl.innerHTML = `
              <div class="vox-sync-progress-box" style="margin:4px 0;text-align:left;">
                <div class="vox-sync-progress-header">
                  <span class="vox-sync-progress-status">${msg}</span>
                  <span class="vox-sync-progress-percent">${pct}%</span>
                </div>
                <div class="vox-sync-progress-track">
                  <div class="vox-sync-progress-bar" style="width:${pct}%;"></div>
                </div>
              </div>
            `;
          }
        };

        setInlineProgress('Analisando faixa vocal em segundo plano…', 20);

        let result = null;
        if (editorValue) {
          result = await this.autoSyncSong(targetSong, {
            forceLocal: true,
            lyricsText: editorValue,
            onProgress: (msg, pct) => setInlineProgress(msg, pct || 50)
          });
        } else {
          result = await this.autoSyncSong(targetSong, {
            onProgress: (msg, pct) => setInlineProgress(msg, pct || 50)
          });
        }

        if (!result || result.needsLyricsInput) return;

        setInlineProgress('Aplicando tempos…', 95);

        // Update manualSyncVoices with newly computed times
        if (window.manualSyncVoices && window.VoxStageLyrics) {
          const lines = (typeof window.parseSyncedLyrics === 'function')
            ? window.parseSyncedLyrics(result.syncedLyrics)
            : [];

          const unified = (typeof window.unifiedLyricsForSong === 'function')
            ? window.unifiedLyricsForSong({ ...targetSong, syncedLyrics: result.syncedLyrics, plainLyrics: result.plainLyrics })
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
            progressEl.textContent = `${count} frases sincronizadas automaticamente`;
          }

          if (statusEl) {
            statusEl.innerHTML = `
              <div style="display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:8px 0;">
                <span style="color:var(--lime, #c8f568);font-weight:700;">Sincronização concluída!</span>
                <button class="btn" id="manualSyncSingAction" type="button" style="padding:7px 16px;font-size:12px;">${ICONS.play} <span>Cantar agora</span></button>
              </div>
            `;

            const singBtn = document.getElementById('manualSyncSingAction');
            if (singBtn) {
              singBtn.onclick = async () => {
                try {
                  if (typeof window.saveManualSync === 'function') await window.saveManualSync();
                } catch (saveErr) {
                  console.warn('Aviso ao salvar sync manual:', saveErr);
                }
                const closeBtn = document.getElementById('closeManualSync');
                if (closeBtn) closeBtn.click();
                if (typeof window.playSong === 'function') {
                  try {
                    await window.playSong(targetSong.id);
                  } catch (playErr) {
                    console.warn('Aviso ao iniciar reprodução:', playErr);
                  }
                }
              };
            }
          }

          if (typeof window.toast === 'function') {
            window.toast(result.engine === 'online'
              ? 'Letra sincronizada via catálogo! Pronta para cantar.'
              : 'Letra alinhada automaticamente com a voz! Pronta para cantar.');
          }
        }
      } catch (err) {
        console.error('Falha no auto-sync:', err);
        if (statusEl) statusEl.innerHTML = prevStatus;
        if (typeof window.toast === 'function') window.toast(`Auto-Sync: ${err.message || err}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${ICONS.sync} <span>Auto-Sincronizar</span>`;
        }
      }
    },

    // Trigger auto-sync inside the lyrics search dialog
    async triggerInLyricsDialog() {
      const targetSong = resolveActiveSong();
      if (!targetSong) {
        if (typeof window.toast === 'function') window.toast('Selecione uma música primeiro.');
        return;
      }

      const pasteInput = document.getElementById('lyricsPasteInput');
      const customLyrics = pasteInput ? pasteInput.value.trim() : '';

      closeLyricsDialogFallback();
      await this.processAndReadySong(targetSong, { lyricsText: customLyrics || undefined });
    }
  };

  function closeLyricsDialogFallback() {
    const dialog = document.getElementById('lyricsDialog');
    if (dialog) dialog.classList.remove('show');
  }

  window.VoxStageAutoSync = AutoSyncManager;

  // --- UI Injections and Event Bindings (Strictly Monochrome & Native Theme) ---

  function setupAutoSyncUI() {
    if (!document.getElementById('voxstage-auto-sync-styles')) {
      const style = document.createElement('style');
      style.id = 'voxstage-auto-sync-styles';
      style.textContent = `
        /* Monochrome AutoSync Theme */
        .vox-icon {
          display: inline-block;
          vertical-align: middle;
          flex: none;
        }
        .vox-icon-spin {
          display: inline-block;
          vertical-align: middle;
          animation: voxSpin 0.9s linear infinite;
        }
        @keyframes voxSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .auto-sync-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          transition: background 0.16s, border-color 0.16s, transform 0.16s;
        }
        .lyrics-auto-sync-card {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin: 12px 0 16px;
          padding: 13px 15px;
          background: #1d1e23;
          border: 1px solid #33343c;
          border-radius: 13px;
        }
        .lyrics-auto-sync-card button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 40px;
          font-weight: 700;
          font-size: 13px;
        }
        .lyrics-auto-sync-copy {
          color: #9f9fa8;
          font-size: 11px;
          line-height: 1.45;
          text-align: center;
        }

        /* Native Progress Box */
        .vox-sync-progress-box {
          width: 100%;
          box-sizing: border-box;
          padding: 12px 14px;
          background: #141518;
          border: 1px solid #32333b;
          border-radius: 12px;
        }
        .vox-sync-progress-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          margin-bottom: 8px;
          color: #ddd;
        }
        .vox-sync-progress-percent {
          font-weight: 700;
          color: var(--lime, #c8f568);
          font-variant-numeric: tabular-nums;
        }
        .vox-sync-progress-track {
          width: 100%;
          height: 6px;
          background: #25262c;
          border-radius: 6px;
          overflow: hidden;
        }
        .vox-sync-progress-bar {
          height: 100%;
          background: var(--lime, #c8f568);
          border-radius: 6px;
          transition: width 0.28s ease;
        }

        /* Modal Overlay */
        .vox-sync-modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: none;
          place-items: center;
          padding: 16px;
          background: rgba(8, 9, 11, 0.88);
          backdrop-filter: blur(10px);
        }
        .vox-sync-modal-overlay.show {
          display: grid;
        }
        .vox-sync-card {
          box-sizing: border-box;
          width: min(500px, 94vw);
          max-height: 88dvh;
          overflow: auto;
          padding: 22px 24px;
          border: 1px solid #3a3b43;
          border-radius: 18px;
          background: #1a1b1f;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
          display: flex;
          flex-direction: column;
          gap: 16px;
          animation: voxScale 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes voxScale {
          from { transform: scale(0.96); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .vox-sync-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          border-bottom: 1px solid #2b2c33;
          padding-bottom: 12px;
        }
        .vox-sync-kicker {
          font-size: 10px;
          letter-spacing: 1.5px;
          font-weight: 800;
          color: #a8a8b2;
          text-transform: uppercase;
        }
        .vox-sync-head h2 {
          font-size: 18px;
          margin: 4px 0 0;
          color: #fff;
          font-weight: 700;
        }
        .vox-sync-close {
          background: transparent;
          color: #888;
          font-size: 22px;
          line-height: 1;
          padding: 4px;
          cursor: pointer;
        }
        .vox-sync-close:hover {
          color: #fff;
        }
        .vox-sync-body {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 12px;
          padding: 8px 0;
        }
        .vox-sync-prompt-copy {
          font-size: 13px;
          color: #b8b8c2;
          line-height: 1.5;
          margin: 0;
          text-align: left;
          width: 100%;
        }
        #autoSyncPromptText {
          width: 100%;
          box-sizing: border-box;
          background: #111215;
          border: 1px solid #383941;
          border-radius: 12px;
          color: #eee;
          padding: 12px;
          font-size: 13px;
          line-height: 1.5;
          resize: vertical;
          font-family: inherit;
        }
        #autoSyncPromptText:focus {
          outline: none;
          border-color: #666;
        }
        .vox-sync-prompt-submit {
          width: 100%;
          justify-content: center;
          min-height: 42px;
        }
        .vox-sync-ready-icon {
          color: var(--lime, #c8f568);
          margin-bottom: 2px;
        }
        .vox-sync-ready-heading {
          font-size: 19px;
          color: #fff;
          margin: 0;
          font-weight: 800;
        }
        .vox-sync-ready-copy {
          font-size: 13px;
          color: #a8a8b2;
          line-height: 1.5;
          margin: 0;
        }
        .vox-sync-actions {
          display: flex;
          gap: 10px;
          justify-content: center;
          width: 100%;
          margin-top: 6px;
        }
        .vox-sync-sing-action {
          flex: 1;
          justify-content: center;
          font-size: 13px;
          min-height: 42px;
        }
      `;
      document.head.append(style);
    }

    // 1. Add Monochrome "Auto-Sincronizar" to manualSyncDialog footer
    const manualDialog = document.getElementById('manualSyncDialog');
    if (manualDialog && !document.getElementById('manualAutoSyncButton')) {
      const footer = manualDialog.querySelector('footer');
      const startBtn = document.getElementById('startManualSync');
      if (footer && startBtn) {
        const autoBtn = document.createElement('button');
        autoBtn.id = 'manualAutoSyncButton';
        autoBtn.className = 'btn secondary auto-sync-btn';
        autoBtn.type = 'button';
        autoBtn.innerHTML = `${ICONS.sync} <span>Auto-Sincronizar</span>`;
        autoBtn.title = 'Alinha automaticamente a letra com a faixa vocal em segundo plano';
        autoBtn.onclick = () => AutoSyncManager.triggerInManualSyncDialog();

        startBtn.after(autoBtn);
      }
    }

    // 2. Add Monochrome "Sincronizar Automaticamente" to lyricsDialog
    const lyricsDialog = document.getElementById('lyricsDialog');
    if (lyricsDialog && !document.getElementById('lyricsDialogAutoSyncBtn')) {
      const searchRow = lyricsDialog.querySelector('.lyrics-search-row');
      if (searchRow) {
        const box = document.createElement('div');
        box.className = 'lyrics-auto-sync-card';
        box.innerHTML = `
          <button class="btn secondary" id="lyricsDialogAutoSyncBtn" type="button">
            ${ICONS.sync} <span>Sincronizar Automaticamente</span>
          </button>
          <span class="lyrics-auto-sync-copy">
            Busca tempos exatos no catálogo ou decodifica a faixa vocal em segundo plano para alinhar com a voz do cantor.
          </span>
        `;
        searchRow.after(box);

        const btn = document.getElementById('lyricsDialogAutoSyncBtn');
        if (btn) btn.onclick = () => AutoSyncManager.triggerInLyricsDialog();
      }
    }
  }

  // Bind delegated track-menu click for "data-auto-sync" ONCE
  document.addEventListener('click', async (event) => {
    const autoSyncTarget = event.target.closest('[data-auto-sync]');
    if (autoSyncTarget) {
      event.preventDefault();
      event.stopPropagation();
      const songId = autoSyncTarget.dataset.autoSync;
      const all = getAllSongs();
      const song = all.find(s => s.id === songId);
      if (!song) return;

      // Close any open menus
      document.querySelectorAll('.track-menu').forEach(m => m.hidden = true);

      // Run full background process & show ready-to-sing modal
      await AutoSyncManager.processAndReadySong(song);
    }
  });

  // Bind on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAutoSyncUI);
  } else {
    setupAutoSyncUI();
  }

  const observer = new MutationObserver(() => {
    setupAutoSyncUI();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
