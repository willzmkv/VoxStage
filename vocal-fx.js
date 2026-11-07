/* VoxStage 2.0: Vocal Live Monitor & Studio FX Engine.
 * Allows hearing your own voice with studio/stage presence, compression, reverb and delay.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'voxstage-vocal-fx';
  const defaultSettings = {
    enabled: false,
    volume: 1.0,
    preset: 'stage',
    reverb: 0.35,
    delay: 0.16,
    deviceId: ''
  };

  let settings = { ...defaultSettings };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    settings = { ...defaultSettings, ...saved };
  } catch {}

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }

  const presets = {
    stage: {
      name: 'Palco ao Vivo',
      desc: 'Reverb de auditório com presença estéreo e eco sutil de palco.',
      reverb: 0.35,
      delay: 0.16,
      presence: 3.5,
      air: 2.0
    },
    studio: {
      name: 'Estúdio',
      desc: 'Acústica tratada com compressão quente e clareza vocal máxima.',
      reverb: 0.20,
      delay: 0.0,
      presence: 4.5,
      air: 2.5
    },
    karaoke: {
      name: 'Karaokê Show',
      desc: 'Reverb amplo e repetições marcadas no clássico estilo karaokê.',
      reverb: 0.50,
      delay: 0.32,
      presence: 2.5,
      air: 1.5
    },
    natural: {
      name: 'Voz Natural',
      desc: 'Monitor limpo com equalização suave, sem eco ou reverberação.',
      reverb: 0.0,
      delay: 0.0,
      presence: 1.0,
      air: 0.5
    }
  };

  let activeStream = null;
  let micSource = null;
  let inputGain = null;
  let highPass = null;
  let presenceEQ = null;
  let airShelf = null;
  let compressor = null;
  let dryGain = null;
  let reverbSend = null;
  let reverbNode = null;
  let reverbReturn = null;
  let delaySend = null;
  let delayNode = null;
  let delayFeedback = null;
  let delayFilter = null;
  let delayReturn = null;
  let masterGain = null;
  let limiter = null;
  let reverbBuffer = null;
  let isRunning = false;

  // Generate synthetic stereo studio/stage impulse response
  function buildReverbBuffer(ctx, duration = 2.2, decay = 2.5) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buffer = ctx.createBuffer(2, length, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let prevL = 0;
    let prevR = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const envelope = Math.exp(-t * (decay / (duration * 0.4)));
      const rawL = (Math.random() * 2 - 1) * envelope;
      const rawR = (Math.random() * 2 - 1) * envelope;
      // Lowpass damping over time simulates air/wall reflection absorption
      prevL = rawL * 0.72 + prevL * 0.28;
      prevR = rawR * 0.72 + prevR * 0.28;
      left[i] = prevL;
      right[i] = prevR;
    }
    return buffer;
  }

  function getAudioContext() {
    if (typeof audioContext !== 'undefined' && audioContext) return audioContext;
    if (typeof window.VoxStageAudioContext !== 'undefined' && window.VoxStageAudioContext) return window.VoxStageAudioContext;
    return null;
  }

  async function startMonitoring(customStream = null) {
    if (isRunning) return true;

    // Ensure audio engine
    if (typeof ensureAudioEngine === 'function') {
      try { await ensureAudioEngine(); } catch {}
    }

    const ctx = getAudioContext();
    if (!ctx) {
      if (typeof toast === 'function') toast('Inicie uma música ou toque na tela para liberar o áudio.');
      return false;
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }

    if (customStream) {
      activeStream = customStream;
    } else {
      try {
        const constraints = {
          audio: {
            deviceId: settings.deviceId ? { exact: settings.deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            latency: 0
          },
          video: false
        };

        activeStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn('[VocalMonitor] Falha ao capturar microfone:', err);
        // Fallback without device constraint if specific device failed
        if (settings.deviceId) {
          try {
            activeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          } catch (e) {
            if (typeof toast === 'function') toast('Não foi possível acessar o microfone. Verifique as permissões.');
            return false;
          }
        } else {
          if (typeof toast === 'function') toast('Não foi possível acessar o microfone. Verifique as permissões.');
          return false;
        }
      }
    }

    try {
      // 1. Source and input gain
      micSource = ctx.createMediaStreamSource(activeStream);
      inputGain = ctx.createGain();
      inputGain.gain.setValueAtTime(1.0, ctx.currentTime);

      // 2. High-pass filter (cuts sub-rumble and breath pops below 85Hz)
      highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.setValueAtTime(85, ctx.currentTime);
      highPass.Q.setValueAtTime(0.7, ctx.currentTime);

      // 3. Presence EQ (enhances speech intelligibility and vocal body at 3.2 kHz)
      presenceEQ = ctx.createBiquadFilter();
      presenceEQ.type = 'peaking';
      presenceEQ.frequency.setValueAtTime(3200, ctx.currentTime);
      presenceEQ.Q.setValueAtTime(1.1, ctx.currentTime);
      presenceEQ.gain.setValueAtTime(presets[settings.preset]?.presence ?? 3.5, ctx.currentTime);

      // 4. Air shelf (adds smooth studio polish and breath above 9.5 kHz)
      airShelf = ctx.createBiquadFilter();
      airShelf.type = 'highshelf';
      airShelf.frequency.setValueAtTime(9500, ctx.currentTime);
      airShelf.gain.setValueAtTime(presets[settings.preset]?.air ?? 2.0, ctx.currentTime);

      // 5. Vocal dynamics compressor (evens out soft whispers vs loud belting)
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-22, ctx.currentTime);
      compressor.knee.setValueAtTime(12, ctx.currentTime);
      compressor.ratio.setValueAtTime(3.5, ctx.currentTime);
      compressor.attack.setValueAtTime(0.005, ctx.currentTime);
      compressor.release.setValueAtTime(0.18, ctx.currentTime);

      // 6. Direct Dry Path
      dryGain = ctx.createGain();
      dryGain.gain.setValueAtTime(1.0, ctx.currentTime);

      // 7. Stereo Concert Reverb
      if (!reverbBuffer || reverbBuffer.sampleRate !== ctx.sampleRate) {
        reverbBuffer = buildReverbBuffer(ctx, 2.2, 2.4);
      }
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = reverbBuffer;
      reverbSend = ctx.createGain();
      reverbSend.gain.setValueAtTime(settings.reverb, ctx.currentTime);
      reverbReturn = ctx.createGain();
      reverbReturn.gain.setValueAtTime(0.85, ctx.currentTime);

      // 8. Stage Delay / Echo
      delayNode = ctx.createDelay(1.0);
      delayNode.delayTime.setValueAtTime(0.145, ctx.currentTime);
      delayFeedback = ctx.createGain();
      delayFeedback.gain.setValueAtTime(0.24, ctx.currentTime);
      delayFilter = ctx.createBiquadFilter();
      delayFilter.type = 'lowpass';
      delayFilter.frequency.setValueAtTime(3400, ctx.currentTime);
      delaySend = ctx.createGain();
      delaySend.gain.setValueAtTime(settings.delay, ctx.currentTime);
      delayReturn = ctx.createGain();
      delayReturn.gain.setValueAtTime(0.75, ctx.currentTime);

      // 9. Master output & safety limiter
      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.001, ctx.currentTime);
      masterGain.gain.exponentialRampToValueAtTime(Math.max(0.001, settings.volume), ctx.currentTime + 0.05);

      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-1.5, ctx.currentTime);
      limiter.ratio.setValueAtTime(20, ctx.currentTime);
      limiter.attack.setValueAtTime(0.002, ctx.currentTime);
      limiter.release.setValueAtTime(0.05, ctx.currentTime);

      // Routing:
      // Mic -> Input -> HP -> Presence -> Air -> Compressor
      micSource.connect(inputGain);
      inputGain.connect(highPass);
      highPass.connect(presenceEQ);
      presenceEQ.connect(airShelf);
      airShelf.connect(compressor);

      // Dry path
      compressor.connect(dryGain);
      dryGain.connect(masterGain);

      // Reverb path
      compressor.connect(reverbSend);
      reverbSend.connect(reverbNode);
      reverbNode.connect(reverbReturn);
      reverbReturn.connect(masterGain);

      // Delay path
      compressor.connect(delaySend);
      delaySend.connect(delayNode);
      delayNode.connect(delayFilter);
      delayFilter.connect(delayFeedback);
      delayFeedback.connect(delayNode); // feedback loop
      delayFilter.connect(delayReturn);
      delayReturn.connect(masterGain);

      // Final output to destination
      masterGain.connect(limiter);
      limiter.connect(ctx.destination);

      isRunning = true;
      settings.enabled = true;
      saveSettings();
      updateUiState();
      return true;
    } catch (err) {
      console.error('[VocalMonitor] Erro ao montar grafo de áudio:', err);
      stopMonitoring();
      return false;
    }
  }

  function stopMonitoring() {
    const ctx = getAudioContext();
    if (masterGain && ctx && ctx.state === 'running') {
      try {
        masterGain.gain.setValueAtTime(masterGain.gain.value, ctx.currentTime);
        masterGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
      } catch {}
    }

    setTimeout(() => {
      try {
        activeStream?.getTracks().forEach(track => track.stop());
      } catch {}
      activeStream = null;

      try {
        micSource?.disconnect();
        highPass?.disconnect();
        presenceEQ?.disconnect();
        airShelf?.disconnect();
        compressor?.disconnect();
        dryGain?.disconnect();
        reverbSend?.disconnect();
        reverbNode?.disconnect();
        reverbReturn?.disconnect();
        delaySend?.disconnect();
        delayNode?.disconnect();
        delayFeedback?.disconnect();
        delayFilter?.disconnect();
        delayReturn?.disconnect();
        masterGain?.disconnect();
        limiter?.disconnect();
      } catch {}

      micSource = null;
      isRunning = false;
      settings.enabled = false;
      saveSettings();
      updateUiState();
    }, 40);
  }

  function setVolume(val) {
    const vol = Math.max(0, Math.min(1.5, Number(val)));
    settings.volume = vol;
    saveSettings();
    const ctx = getAudioContext();
    if (masterGain && ctx && isRunning) {
      try {
        masterGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
      } catch {}
    }
    updateVolumeSliders();
  }

  function setReverb(val) {
    const amt = Math.max(0, Math.min(1.0, Number(val)));
    settings.reverb = amt;
    saveSettings();
    const ctx = getAudioContext();
    if (reverbSend && ctx && isRunning) {
      try {
        reverbSend.gain.setTargetAtTime(amt, ctx.currentTime, 0.02);
      } catch {}
    }
    const slider = document.getElementById('vocalFxReverb');
    if (slider && slider.value !== String(amt)) slider.value = String(amt);
    const valSpan = document.getElementById('vocalFxReverbVal');
    if (valSpan) valSpan.textContent = `${Math.round(amt * 100)}%`;
  }

  function setDelay(val) {
    const amt = Math.max(0, Math.min(1.0, Number(val)));
    settings.delay = amt;
    saveSettings();
    const ctx = getAudioContext();
    if (delaySend && ctx && isRunning) {
      try {
        delaySend.gain.setTargetAtTime(amt, ctx.currentTime, 0.02);
      } catch {}
    }
    const slider = document.getElementById('vocalFxDelay');
    if (slider && slider.value !== String(amt)) slider.value = String(amt);
    const valSpan = document.getElementById('vocalFxDelayVal');
    if (valSpan) valSpan.textContent = `${Math.round(amt * 100)}%`;
  }

  function applyPreset(presetKey) {
    if (!presets[presetKey]) return;
    settings.preset = presetKey;
    const p = presets[presetKey];
    setReverb(p.reverb);
    setDelay(p.delay);
    const ctx = getAudioContext();
    if (ctx && isRunning) {
      try {
        if (presenceEQ) presenceEQ.gain.setTargetAtTime(p.presence, ctx.currentTime, 0.03);
        if (airShelf) airShelf.gain.setTargetAtTime(p.air, ctx.currentTime, 0.03);
      } catch {}
    }
    saveSettings();
    updatePresetButtons();
    updateUiState();
  }

  async function setDevice(deviceId) {
    settings.deviceId = deviceId || '';
    saveSettings();
    if (isRunning) {
      stopMonitoring();
      await startMonitoring();
    }
  }

  // UI Dialog creation
  let dialog = null;
  function ensureDialog() {
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.id = 'vocalFxDialog';
    dialog.className = 'vocal-fx-dialog';
    dialog.setAttribute('aria-label', 'Retorno e efeitos de voz');

    dialog.innerHTML = `
      <div class="vocal-fx-card">
        <header class="vocal-fx-head">
          <div class="vocal-fx-title">
            <span class="vocal-fx-badge">ÁUDIO AO VIVO</span>
            <h2>Voz & Efeitos de Palco</h2>
          </div>
          <button type="button" class="x" id="closeVocalFx" aria-label="Fechar">×</button>
        </header>

        <p class="vocal-fx-desc">Ouça sua própria voz em tempo real com efeitos de estúdio, compressão e reverberação de palco.</p>

        <aside class="vocal-fx-headphone-tip">
          <span class="tip-icon">🎧</span>
          <div>
            <strong>Recomendamos fones de ouvido</strong>
            <p>Usar caixas de som com o retorno ligado pode causar microfonia ou eco indesejado.</p>
          </div>
        </aside>

        <div class="vocal-fx-toggle-box">
          <button type="button" class="btn vocal-toggle-btn" id="vocalFxMainToggle">
            <span class="toggle-icon">🎤</span>
            <span id="vocalToggleText">Ativar retorno da voz</span>
          </button>
          <span class="vocal-status-chip" id="vocalStatusChip">Desativado</span>
        </div>

        <div class="vocal-fx-section">
          <label class="vocal-device-label">
            <span>Microfone de entrada</span>
            <select id="vocalFxDeviceSelect"></select>
          </label>
        </div>

        <div class="vocal-fx-section">
          <span class="section-label">Estilo do efeito vocal</span>
          <div class="vocal-presets-grid" id="vocalPresetsGrid">
            ${Object.entries(presets).map(([key, p]) => `
              <button type="button" class="vocal-preset-btn ${settings.preset === key ? 'selected' : ''}" data-vocal-preset="${key}">
                <strong>${p.name}</strong>
                <small>${p.desc}</small>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="vocal-fx-sliders">
          <label class="vocal-slider-row">
            <div class="slider-head">
              <span>Volume da sua voz</span>
              <b id="vocalFxVolumeVal">${Math.round(settings.volume * 100)}%</b>
            </div>
            <input type="range" min="0" max="1.5" step="0.02" value="${settings.volume}" id="vocalFxVolume">
          </label>

          <label class="vocal-slider-row">
            <div class="slider-head">
              <span>Reverb (Espaço de palco)</span>
              <b id="vocalFxReverbVal">${Math.round(settings.reverb * 100)}%</b>
            </div>
            <input type="range" min="0" max="1" step="0.02" value="${settings.reverb}" id="vocalFxReverb">
          </label>

          <label class="vocal-slider-row">
            <div class="slider-head">
              <span>Eco (Delay de karaokê)</span>
              <b id="vocalFxDelayVal">${Math.round(settings.delay * 100)}%</b>
            </div>
            <input type="range" min="0" max="1" step="0.02" value="${settings.delay}" id="vocalFxDelay">
          </label>
        </div>

        <footer class="vocal-fx-foot">
          <button type="button" class="btn secondary" id="closeVocalFxBottom">Pronto</button>
        </footer>
      </div>
    `;

    document.body.append(dialog);

    // Event listeners
    dialog.querySelector('#closeVocalFx').onclick = () => dialog.close();
    dialog.querySelector('#closeVocalFxBottom').onclick = () => dialog.close();
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });

    const toggleBtn = dialog.querySelector('#vocalFxMainToggle');
    toggleBtn.onclick = async () => {
      if (isRunning) {
        stopMonitoring();
      } else {
        await startMonitoring();
      }
    };

    dialog.querySelectorAll('[data-vocal-preset]').forEach(btn => {
      btn.onclick = () => applyPreset(btn.dataset.vocalPreset);
    });

    const volSlider = dialog.querySelector('#vocalFxVolume');
    volSlider.oninput = e => {
      setVolume(e.target.value);
      dialog.querySelector('#vocalFxVolumeVal').textContent = `${Math.round(e.target.value * 100)}%`;
    };

    const revSlider = dialog.querySelector('#vocalFxReverb');
    revSlider.oninput = e => {
      setReverb(e.target.value);
    };

    const dlySlider = dialog.querySelector('#vocalFxDelay');
    dlySlider.oninput = e => {
      setDelay(e.target.value);
    };

    const devSelect = dialog.querySelector('#vocalFxDeviceSelect');
    devSelect.onchange = e => {
      setDevice(e.target.value);
    };

    return dialog;
  }

  async function populateDevices() {
    const select = document.getElementById('vocalFxDeviceSelect');
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      select.innerHTML = '<option value="">Microfone padrão do sistema</option>';
      for (const d of audioInputs) {
        if (!d.deviceId || d.deviceId === 'default') continue;
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microfone ${select.options.length}`;
        if (d.deviceId === settings.deviceId) opt.selected = true;
        select.append(opt);
      }
    } catch {}
  }

  function updatePresetButtons() {
    document.querySelectorAll('[data-vocal-preset]').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.vocalPreset === settings.preset);
    });
  }

  function updateVolumeSliders() {
    const slider = document.getElementById('vocalFxVolume');
    if (slider && slider.value !== String(settings.volume)) slider.value = String(settings.volume);
    const val = document.getElementById('vocalFxVolumeVal');
    if (val) val.textContent = `${Math.round(settings.volume * 100)}%`;

    const micFull = document.querySelector('[data-full-volume="Mic"]');
    if (micFull && micFull.value !== String(settings.volume)) micFull.value = String(settings.volume);
  }

  function updateUiState() {
    const chip = document.getElementById('vocalStatusChip');
    const toggleText = document.getElementById('vocalToggleText');
    const toggleBtn = document.getElementById('vocalFxMainToggle');
    const stageBtn = document.getElementById('stageVocalFx');

    if (chip) {
      chip.textContent = isRunning ? `Ativo · ${presets[settings.preset]?.name || 'Palco'}` : 'Desativado';
      chip.classList.toggle('live', isRunning);
    }
    if (toggleText) {
      toggleText.textContent = isRunning ? 'Desativar retorno da voz' : 'Ativar retorno da voz';
    }
    if (toggleBtn) {
      toggleBtn.classList.toggle('secondary', isRunning);
    }
    if (stageBtn) {
      stageBtn.classList.toggle('active', isRunning);
      stageBtn.title = isRunning ? `Retorno vocal ativo (${presets[settings.preset]?.name})` : 'Configurar retorno e efeitos de voz';
      const label = stageBtn.querySelector('.palco-control-label');
      if (label) label.textContent = isRunning ? `Voz: ${presets[settings.preset]?.name || 'On'}` : 'Voz';
    }

    window.dispatchEvent(new CustomEvent('voxstage-vocal-monitor-state', {
      detail: { running: isRunning, preset: settings.preset, volume: settings.volume }
    }));
  }

  function openDialog() {
    const d = ensureDialog();
    populateDevices();
    updatePresetButtons();
    updateVolumeSliders();
    updateUiState();
    d.showModal();
  }

  // Inject styles for dialog and controls
  const style = document.createElement('style');
  style.id = 'vocal-fx-styles';
  style.textContent = `
    .vocal-fx-dialog{border:0;padding:0;background:transparent;max-width:min(620px,calc(100vw - 32px));border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,0.8);color:#eee}
    .vocal-fx-dialog::backdrop{background:rgba(8,9,11,0.75);backdrop-filter:blur(10px)}
    .vocal-fx-card{background:linear-gradient(145deg,#202124,#151518);border:1px solid #414148;border-radius:20px;padding:24px 26px;display:flex;flex-direction:column;gap:18px;max-height:88vh;overflow-y:auto}
    .vocal-fx-head{display:flex;justify-content:space-between;align-items:flex-start}
    .vocal-fx-title h2{margin:4px 0 0;font:750 22px Manrope,sans-serif;color:#f6f5f3;letter-spacing:-0.5px}
    .vocal-fx-badge{font-size:9px;font-weight:800;letter-spacing:1.5px;color:var(--cyan,#74dbd3);text-transform:uppercase}
    .vocal-fx-desc{margin:0;font-size:12px;color:#a0a0a8;line-height:1.5}
    .vocal-fx-headphone-tip{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:rgba(116,219,211,0.08);border:1px solid rgba(116,219,211,0.22);color:#d0f0ed;font-size:11px}
    .vocal-fx-headphone-tip .tip-icon{font-size:24px;flex:none}
    .vocal-fx-headphone-tip strong{display:block;color:#74dbd3;font-size:12px;margin-bottom:2px}
    .vocal-fx-headphone-tip p{margin:0;color:#b2dedb;line-height:1.4}
    .vocal-fx-toggle-box{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 16px;background:#18191c;border:1px solid #33343a;border-radius:14px}
    .vocal-toggle-btn{display:inline-flex;align-items:center;gap:10px;font-size:13px;padding:10px 18px;font-weight:700}
    .vocal-status-chip{font-size:11px;font-weight:700;padding:5px 11px;border-radius:20px;background:#28292e;color:#8e8f96}
    .vocal-status-chip.live{background:rgba(116,219,211,0.18);color:#74dbd3;border:1px solid rgba(116,219,211,0.35);animation:vocalPulse 2s infinite ease-in-out}
    @keyframes vocalPulse{0%,100%{opacity:1}50%{opacity:0.75}}
    .vocal-fx-section{display:flex;flex-direction:column;gap:8px}
    .vocal-device-label{display:flex;flex-direction:column;gap:6px;font-size:11px;color:#bdbdc2;font-weight:600}
    .vocal-device-label select{background:#121214;color:#eee;border:1px solid #38383e;border-radius:9px;padding:9px 12px;font:500 12px 'DM Sans',sans-serif;outline:none}
    .section-label{font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:1px}
    .vocal-presets-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .vocal-preset-btn{background:#1a1a1d;border:1px solid #323237;border-radius:12px;padding:12px;text-align:left;color:#ddd;transition:border-color .16s,background .16s,transform .16s}
    .vocal-preset-btn:hover{border-color:#555;background:#222227;transform:translateY(-1px)}
    .vocal-preset-btn.selected{border-color:var(--cyan,#74dbd3);background:rgba(116,219,211,0.1);color:#fff;box-shadow:0 0 16px rgba(116,219,211,0.15)}
    .vocal-preset-btn strong{display:block;font-size:13px;color:#fff;margin-bottom:3px}
    .vocal-preset-btn.selected strong{color:var(--cyan,#74dbd3)}
    .vocal-preset-btn small{display:block;font-size:10px;color:#8e8e96;line-height:1.35}
    .vocal-fx-sliders{display:flex;flex-direction:column;gap:12px;background:#17171a;border:1px solid #2e2e33;border-radius:14px;padding:14px 16px}
    .vocal-slider-row{display:flex;flex-direction:column;gap:6px}
    .slider-head{display:flex;justify-content:space-between;font-size:11px;color:#ccc}
    .slider-head b{color:var(--cyan,#74dbd3);font-variant-numeric:tabular-nums}
    .vocal-slider-row input[type=range]{accent-color:var(--cyan,#74dbd3);width:100%;height:5px;cursor:pointer}
    .vocal-fx-foot{display:flex;justify-content:flex-end;margin-top:6px}
    .vocal-fx-foot .btn{min-width:100px;justify-content:center}
    .vocal-fx-btn.active{border-color:var(--cyan,#74dbd3)!important;color:var(--cyan,#74dbd3)!important;box-shadow:0 0 14px rgba(116,219,211,0.28)!important}
    @media(max-width:540px){.vocal-presets-grid{grid-template-columns:1fr}}
  `;
  document.head.append(style);

  // Expose API
  window.VoxStageVocalMonitor = {
    get isRunning() { return isRunning; },
    get settings() { return { ...settings }; },
    getVolume: () => settings.volume,
    start: startMonitoring,
    connectRemoteStream: async (stream) => {
      if (isRunning) stopMonitoring();
      return await startMonitoring(stream);
    },
    stop: stopMonitoring,
    toggle: async () => {
      if (isRunning) { stopMonitoring(); return false; }
      return await startMonitoring();
    },
    setVolume,
    setReverb,
    setDelay,
    applyPreset,
    setDevice,
    openDialog
  };
})();
