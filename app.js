// Camada local: a biblioteca e os arquivos ficam em ./library.json e ./music.
let chosenFiles = [];
let editingSong = null;
let favoriteOnly = false;
let showHiddenSongs = false;
let compactTrackView = false;
let libraryLyricsFilter = 'all';
let libraryDisplayOrder = [];
// Lyric filters affect the catalogue; playback order only follows its sort direction.
function songHasSyncedLyrics(song) {
  return Boolean(/\[\d+:\d+/.test(song.syncedLyrics || '') || song.lyricVoices && ['lead','parallel','backing'].some(voice => song.lyricVoices[voice]?.some(row => Number.isFinite(row.time))) || song.wordTimings?.some(row => Array.isArray(row) ? row.length : row?.words?.length));
}
function followingLibrarySongs() {
  const ordered=songs.filter(song=>!song.hidden);
  if(sorted)ordered.reverse();
  const index=ordered.findIndex(song=>song.id===current?.id);
  return index<0?ordered:ordered.slice(index+1);
}
function nextPlaybackSong() {
  while(remoteSongQueue.length){const id=remoteSongQueue.shift();if(songs.some(song=>song.id===id&&!song.hidden))return id;}
  return followingLibrarySongs()[0]?.id || null;
}
function addToPlaybackQueue(id) {
  if(!songs.some(song=>song.id===id&&!song.hidden))return;
  if(current?.id===id || remoteSongQueue.includes(id)){toast('Esta música já está tocando ou na fila.');return;}
  remoteSongQueue.push(id);window.dispatchEvent(new Event('voxstage-queue-changed'));
  toast('Música adicionada à fila.');
}
try { compactTrackView = localStorage.getItem('voxstage-library-view') === 'compact'; } catch {}
let draftLyrics = null;
// A draft belongs to an import/edit operation, not to the visibility of its dialog.
// Keep File objects in memory and downloaded attachments in persistent storage.
const uploadDrafts = new Map();
let activeUploadDraftId = 'new';
function persistUploadDrafts() {
  try {
    localStorage.setItem('voxstage-upload-drafts', JSON.stringify([...uploadDrafts.values()].map(draft => ({
      id: draft.id, title: draft.title, artist: draft.artist, editingId: draft.editingId, youtubeUrl: draft.youtubeUrl, youtubeSelection: draft.youtubeSelection,
      importSource: draft.importSource, importStep: draft.importStep, downloadVideo: draft.downloadVideo,
      lyrics: draft.lyrics, lyricStatus: draft.lyricStatus,
      files: draft.files.filter(item => item.name).map(({name, role, label}) => ({name, role, label}))
    }))));
  } catch (error) { console.warn('Não foi possível guardar o rascunho de envio.', error); }
}
function captureUploadDraft() {
  const draft = uploadDrafts.get(activeUploadDraftId) || {id: activeUploadDraftId};
  Object.assign(draft, {files: chosenFiles, lyrics: draftLyrics, editingId: editingSong?.id || null,
    title: $('titleInput')?.value || '', artist: $('artistInput')?.value || '',
    lyricStatus: $('draftLyricsStatus')?.textContent || ''});
  uploadDrafts.set(draft.id, draft);
  persistUploadDrafts();
  return draft;
}
function activateUploadDraft(id) {
  captureUploadDraft();
  activeUploadDraftId = id;
  const draft = uploadDrafts.get(id) || {id, files: [], lyrics: null, title: '', artist: ''};
  uploadDrafts.set(id, draft);
  chosenFiles = draft.files; draftLyrics = draft.lyrics;
  editingSong = songs.find(song => song.id === draft.editingId) || null;
  $('titleInput').value = draft.title; $('artistInput').value = draft.artist;
  if ($('draftLyricsStatus')) $('draftLyricsStatus').textContent = draft.lyricStatus || 'Opcional · você pode buscar pela internet';
  document.querySelector('.modal h2').textContent = editingSong ? 'Editar música' : 'Adicionar música';
  picker.value = ''; drawAssignments();
}
function updateUploadDraft(id, update) {
  const draft = id === activeUploadDraftId ? captureUploadDraft() : uploadDrafts.get(id);
  if (!draft) return; // Explicitly discarded; never attach to another song.
  update(draft);
  if (id === activeUploadDraftId) {
    chosenFiles = draft.files; draftLyrics = draft.lyrics;
    $('titleInput').value = draft.title; $('artistInput').value = draft.artist;
    drawAssignments();
  } else persistUploadDrafts();
}
function uploadDraftFingerprint(draft) {
  return JSON.stringify({title:draft.title,artist:draft.artist,lyrics:draft.lyrics,
    files:draft.files.map(item=>({name:item.name,role:item.role,label:item.label,
      file:item.file ? [item.file.name,item.file.size,item.file.lastModified] : null}))});
}
let audioContext = null;
let playbackBase = 0;
let playbackStartContextTime = 0;
let playbackToken = 0;
let playbackFrame = 0;
let playbackWatchdog = 0;
let playbackUiUpdatedAt = 0;
let stemGains = {};
let playbackSpeed = 1;
let playbackSemitones = 0;
let tempoWorkletPromise = null;
let tempoWorkletReady = false;
let playbackTransformSequence = 0;
let waveformPeaks = null;
let waveformResizeObserver = null;
let interfaceLanguage = 'pt-BR';
try { interfaceLanguage = localStorage.getItem('voxstage-language') || 'pt-BR'; } catch {}
let interfaceTheme = 'lime';
try { interfaceTheme = localStorage.getItem('voxstage-theme') || 'lime'; } catch {}
const mobileInvoke = window.__TAURI__?.core?.invoke;
const mobileNative = /Android/i.test(navigator.userAgent) && typeof mobileInvoke === 'function';
const androidTv = mobileNative && (() => { try { return Boolean(window.VoxStageMedia?.isTelevision()); } catch { return false; } })();
const presentationDevice = window.VoxStageInterfaceFormat || (androidTv?'tv':mobileNative||matchMedia('(max-width:700px)').matches?'phone':'pc');
let mobileMusicDirectory = '';
const mobileStorageReady = mobileNative
  ? mobileInvoke('mobile_get_music_dir').then(path => { mobileMusicDirectory = path; })
  : Promise.resolve();
const mediaUrl = name => {
  if (!name) return '';
  if (mobileNative) {
    const path = `${mobileMusicDirectory.replace(/[\\/]$/, '')}/${name}`;
    return mobileMusicDirectory ? window.__TAURI__.core.convertFileSrc(path) : '';
  }
  return `/music/${encodeURIComponent(name)}`;
};
const extension = name => (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';

// A text selection can finish over a dialog backdrop (or the sync stage).
// Browsers still dispatch a click there after pointerup; it must not close a
// popup or advance a lyric mark. Capture it before individual click handlers.
let pointerGesture = null;
document.addEventListener('pointerdown', event => {
  if (!event.isPrimary) return;
  pointerGesture = {id:event.pointerId,x:event.clientX,y:event.clientY,origin:event.target,dragged:false,active:true};
}, true);
document.addEventListener('pointermove', event => {
  if (!pointerGesture || event.pointerId !== pointerGesture.id) return;
  if (Math.hypot(event.clientX-pointerGesture.x,event.clientY-pointerGesture.y) > 6) pointerGesture.dragged = true;
}, true);
document.addEventListener('pointerup', event => {
  if (!pointerGesture || event.pointerId !== pointerGesture.id) return;
  if (Math.hypot(event.clientX-pointerGesture.x,event.clientY-pointerGesture.y) > 6) pointerGesture.dragged = true;
  const card = pointerGesture.origin?.closest?.('[role="dialog"],.modal');
  if (card && !card.contains(event.target)) pointerGesture.dragged = true;
  pointerGesture.active = false;
  pointerGesture.releasedAt = event.timeStamp;
}, true);
document.documentElement.addEventListener('pointerleave', () => {
  if (pointerGesture?.active) pointerGesture.dragged = true;
}, true);
window.addEventListener('blur', () => {
  if (pointerGesture?.active) pointerGesture.dragged = true;
});
document.addEventListener('click', event => {
  if (event.detail === 0 || !pointerGesture) return; // keyboard activation
  const samePointer = event.pointerId == null || event.pointerId === pointerGesture.id;
  const recent = pointerGesture.active || event.timeStamp - (pointerGesture.releasedAt || 0) < 700;
  if (samePointer && recent && pointerGesture.dragged) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  pointerGesture = null;
}, true);

async function mobileApi(path, options = {}) {
  await mobileStorageReady;
  const method = (options.method || 'GET').toUpperCase();
  if (androidTv && path.startsWith('/api/remote/')) {
    return mobileInvoke('mobile_tv_host_api', {path, method, body: options.body ? JSON.parse(options.body) : null});
  }
  if(path==='/api/archives/inspect'&&method==='POST'&&options.body instanceof Blob){
    const name=crypto.randomUUID()+'.zip';
    await mobileApi('/api/files/'+name,{method:'PUT',body:options.body});
    return mobileInvoke('mobile_archive',{action:'inspect',request:{name}});
  }
  const archiveAction=path.match(/^\/api\/archives\/(export|import|save|save-status)$/);
  if(archiveAction&&method==='POST')return mobileInvoke('mobile_archive',{action:archiveAction[1],request:JSON.parse(options.body||'{}')});
  if (path === '/api/youtube/search' && method === 'POST') {
    const request = JSON.parse(options.body || '{}');
    return {results: await mobileInvoke('mobile_youtube_search', {query: request.query || '', includeYoutube: Boolean(request.includeYoutube), youtubeOnly:Boolean(request.youtubeOnly)})};
  }
  if (path === '/api/youtube/download' && method === 'POST') {
    return mobileInvoke('mobile_youtube_download', {url: JSON.parse(options.body || '{}').url || ''});
  }
  if (path === '/api/youtube/metadata' && method === 'POST') {
    const request = JSON.parse(options.body || '{}');
    return mobileInvoke('mobile_music_metadata', {title: request.title || '', url: request.url || ''});
  }
  if (path === '/api/covers/search' && method === 'POST') {
    const request = JSON.parse(options.body || '{}');
    const result = await mobileInvoke('mobile_cover_search', {query:request.query || '',provider:request.provider || 'archive',artist:request.artist || ''});
    if (result?.error) { const error=new Error(result.error);error.status=result.status;error.retryAfter=result.retryAfter;throw error; }
    return Array.isArray(result) ? {results:result} : result;
  }
  if (path === '/api/covers/download' && method === 'POST') {
    const result = await mobileInvoke('mobile_cover_download', {url: JSON.parse(options.body || '{}').url || ''});
    if (result?.error) throw new Error(result.error);
    return result;
  }
  if (path === '/api/mvsep/config' && method === 'GET') return mobileInvoke('mobile_mvsep_get_config');
  if (path === '/api/mvsep/config' && method === 'POST') {
    const token = JSON.parse(options.body || '{}').token || '';
    if (!token) return mobileInvoke('mobile_mvsep_remove_config');
    // Saving a key must also work while MVSep or the connection is unavailable.
    return mobileInvoke('mobile_mvsep_save_config', {token});
  }
  if (path === '/api/mvsep/config/validate' && method === 'POST') {
    return mobileInvoke('mobile_mvsep_validate_token', {token: JSON.parse(options.body || '{}').token || ''});
  }
  if (path === '/api/mvsep/models') return mobileInvoke('mobile_mvsep_models');
  if (path === '/api/mvsep/separations' && method === 'POST') {
    const request = JSON.parse(options.body || '{}');
    return mobileInvoke('mobile_mvsep_start_song', {songId: request.songId, modelId: Number(request.modelId) || 12, modelOptions: request.modelOptions || {}});
  }
  if (path === '/api/youtube/separations' && method === 'POST') {
    const request = JSON.parse(options.body || '{}');
    return mobileInvoke('mobile_mvsep_start_youtube', {url: request.url || '', title: request.title || '', artist: request.artist || '', modelId: Number(request.modelId) || 12, modelOptions: request.modelOptions || {}});
  }
  const mvsepJob = path.match(/^\/api\/youtube\/separations\/([a-z0-9._-]{8,200})$/i);
  if (mvsepJob && method === 'GET') return mobileInvoke('mobile_mvsep_youtube_status', {jobHash: mvsepJob[1]});
  if (path === '/api/library' && method === 'GET') return mobileInvoke('mobile_get_library');
  if (path === '/api/library' && method === 'POST') {
    return mobileInvoke('mobile_save_song', {song: JSON.parse(options.body)});
  }
  const deleteMatch = path.match(/^\/api\/library\/([a-f0-9-]{36})$/i);
  if (deleteMatch && method === 'DELETE') {
    await mobileInvoke('mobile_delete_song', {id: deleteMatch[1]});
    return {deleted: deleteMatch[1]};
  }
  const uploadMatch = path.match(/^\/api\/files\/([a-z0-9._-]{1,180})$/i);
  if (uploadMatch && method === 'PUT' && options.body instanceof Blob) {
    const file = options.body;
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const data = new Uint8Array(await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer());
      await mobileInvoke('mobile_write_file_chunk', {
        name: uploadMatch[1], offset, chunk: Array.from(data), finalChunk: offset + data.length >= file.size,
      });
    }
    if (file.size === 0) {
      await mobileInvoke('mobile_write_file_chunk', {name: uploadMatch[1], offset: 0, chunk: [], finalChunk: true});
    }
    return {name: uploadMatch[1]};
  }
  throw new Error('A integração móvel desse serviço ainda está em preparação. A biblioteca e a reprodução locais continuam disponíveis.');
}

async function api(path, options = {}) {
  if (mobileNative) {
    try { return await mobileApi(path, options); }
    catch (error) { throw error instanceof Error ? error : new Error(String(error || 'Falha na operação Android.')); }
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.text();
    let detail; try { detail = JSON.parse(body); } catch {}
    const error = new Error(detail?.error || (detail ? `HTTP ${response.status}` : body.slice(0, 220)) || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = Number(detail?.retryAfter || response.headers.get('Retry-After')) || 0;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

if (mobileNative) {
  document.body.classList.add('mobile-native-app');
  const style = document.createElement('style');
  style.textContent = `
    body.mobile-native-app{min-height:100dvh;background:radial-gradient(ellipse at 50% -25%,#24251e 0%,#101012 50%)}
    .mobile-native-app .app{display:block;min-height:100dvh}
    .mobile-native-app .sidebar,.mobile-native-app .hero,.mobile-native-app .profile{display:none!important}
    .mobile-native-app .main{max-width:760px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 10px) 18px calc(150px + env(safe-area-inset-bottom))}
    .mobile-native-app .topbar{position:sticky;top:0;z-index:4;margin:0 -18px 22px;padding:10px 18px;background:#101012eF;border-bottom:1px solid #ffffff0d;backdrop-filter:blur(18px)}
    .mobile-native-app .corner-brand{font-size:20px!important}.mobile-native-app .corner-brand .brand-mark{width:34px;height:34px;border-radius:11px}
    .mobile-native-app .welcome{display:block;margin:0 0 22px}.mobile-native-app .welcome .eyebrow{font-size:9px;letter-spacing:1.8px;margin:0 0 6px}.mobile-native-app .welcome h1{font-size:28px;letter-spacing:-1px}.mobile-native-app .welcome p{font-size:12px;margin:4px 0 15px}
    .mobile-native-app .mobile-library-actions{display:grid;grid-template-columns:1.1fr 1fr;gap:9px}.mobile-native-app .mobile-library-actions .btn{justify-content:center;min-height:46px;padding:9px 11px;font-size:12px;border-radius:13px}.mobile-native-app .mobile-library-actions #syncPcLibrary{background:#1d1d21;border-color:#37373d;color:#e5e5e8}
    .mobile-native-app .filters{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;margin:0 0 11px}.mobile-native-app .filters h2{grid-column:1/-1;font-size:17px}.mobile-native-app .search{grid-column:1/-1;width:100%;height:43px;font-size:13px;padding:0 13px;border-radius:12px}.mobile-native-app .filter-btn{height:39px;padding:0 10px;font-size:11px;border-radius:11px}
    .mobile-native-app .grid{display:grid;grid-template-columns:1fr;gap:9px}.mobile-native-app .track{display:grid;grid-template-columns:62px minmax(0,1fr) auto;align-items:center;gap:11px;padding:9px 11px;border-radius:14px;background:linear-gradient(110deg,#19191c,#151517);border-color:#2b2b30}.mobile-native-app .track:hover{transform:none}.mobile-native-app .track .cover{grid-column:1;grid-row:1;width:62px!important;height:62px!important;min-height:62px;aspect-ratio:1;border-radius:10px}.mobile-native-app .track .cover-letter{font-size:23px}.mobile-native-app .track .track-play{width:25px;height:25px;right:3px;bottom:3px;font-size:10px}.mobile-native-app .track .track-info{grid-column:2;grid-row:1;display:block;min-width:0;padding:0}.mobile-native-app .track .track-title{font-size:13px}.mobile-native-app .track .track-artist{font-size:11px;margin-top:5px}.mobile-native-app .track .track-meta{margin-top:7px;font-size:9px}.mobile-native-app .track .track-actions{grid-column:3;grid-row:1;gap:3px}.mobile-native-app .track .action-icon{padding:6px;font-size:14px}.mobile-native-app .empty{padding:32px 20px;border-radius:15px;font-size:12px}
    .mobile-native-app .player{left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:8;padding:9px 11px;grid-template-columns:minmax(0,1fr) auto;gap:6px;border:1px solid #ffffff19;border-radius:17px;background:#1b1b1eef;box-shadow:0 12px 38px #0008;backdrop-filter:blur(20px)}.mobile-native-app .player .now{max-width:none;min-width:0;height:48px}.mobile-native-app .player .mini-cover{width:42px;height:42px;flex:0 0 42px}.mobile-native-app .player .now-title{font-size:11px}.mobile-native-app .player .now-sub{font-size:9px}.mobile-native-app .player .transport{gap:0}.mobile-native-app .player .controls{gap:7px}.mobile-native-app .player .controls button{width:31px;height:34px;border-radius:10px;font-size:13px}.mobile-native-app .player .controls #playBtn{width:43px;height:43px;border-radius:50%;font-size:15px}.mobile-native-app .player .volumes,.mobile-native-app .player .seek{display:none!important}.mobile-native-app .player #fullscreenBtn{font-size:18px!important}
    .mobile-native-app .remote-open-button,.mobile-native-app #openSetupWizard,.mobile-native-app .local-audio-section,.mobile-native-app .local-lyrics-alignment-section,.mobile-native-app .track-menu button[data-local-separate],.mobile-native-app .local-separation-status,.mobile-native-app #localAudioStatus{display:none!important}
    .mobile-native-app .display{z-index:100;inset:0;background:#09090b}
    .mobile-native-app .display-bg{inset:-24px;opacity:.72;filter:blur(18px) brightness(.62)}
    .mobile-native-app .display-content{height:100dvh;justify-content:center;gap:15px;padding:calc(env(safe-area-inset-top) + 72px) 20px calc(238px + env(safe-area-inset-bottom));overflow:auto}
    .mobile-native-app .display-hud{top:calc(env(safe-area-inset-top) + 13px);left:58px;right:58px;max-width:none;transform:none;justify-content:center}
    .mobile-native-app .display-hud #dispTrack{font-size:13px!important;max-width:100%}
    .mobile-native-app .hamb,.mobile-native-app .backdrop-options{display:none!important}
    .mobile-native-app .lyrics{width:min(100%,650px);font-size:clamp(30px,8vw,48px)!important;line-height:1.25;text-wrap:balance}
    .mobile-native-app .lyrics .next{display:block;margin-top:.5em;font-size:.58em;line-height:1.3;color:#ffffffa6}
    .mobile-native-app .display-bottom{left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));gap:10px;padding:12px;background:#111d;border-color:#ffffff24;border-radius:18px;backdrop-filter:blur(22px)}
    .mobile-native-app .waveform-row{height:24px}.mobile-native-app .waveform-canvas{height:24px}
    .mobile-native-app .display-transport{display:grid;grid-template-columns:40px 48px 40px minmax(0,1fr) auto;gap:6px;width:100%}
    .mobile-native-app .display-transport>#dispSeek{grid-column:1/-1;grid-row:1;height:24px;order:0}
    .mobile-native-app .display-transport>#previousDisplay,.mobile-native-app .display-transport>#dispPlay,.mobile-native-app .display-transport>#nextDisplay,.mobile-native-app .display-transport>#dispTime,.mobile-native-app .display-transport>#dispDuration{grid-row:2}
    .mobile-native-app .display-transport>#dispPlay{width:46px;height:42px;border-radius:14px;background:var(--lime);color:#151610;font-size:17px}
    .mobile-native-app .display-transport>#lyricSync{grid-column:1/-1;min-height:38px}
    .mobile-native-app .display-settings{max-height:94px;overflow:auto;justify-content:flex-start;flex-wrap:nowrap;padding-bottom:2px;scrollbar-width:thin}
    .mobile-native-app .display-settings>.visual-settings{display:none!important}
    .mobile-native-app .display-settings .fullscreen-volumes{gap:9px}
    .mobile-native-app .display-settings .hud-range{font-size:9px}
    .mobile-native-app .display-settings .hud-range input{width:58px}
    
    
    
    .mobile-native-app .modal-back{align-items:end;padding:0;background:#000b}.mobile-native-app .modal{width:100%;max-width:760px;max-height:92dvh;overflow:auto;margin:0 auto;padding:20px 18px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;border-bottom:0;background:#1b1b1f;box-shadow:0 -20px 60px #0009}.mobile-native-app #pcSyncDialog .modal>p{font-size:12px}.mobile-native-app .pc-sync-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.mobile-native-app .pc-sync-actions .btn{justify-content:center;min-height:42px;padding:8px;font-size:11px}.mobile-native-app #pcSyncLink{margin-top:10px}.mobile-native-app .pc-sync-list{max-height:34dvh}
    .pc-sync-list{display:grid;gap:7px;max-height:38vh;overflow:auto;margin:14px 0}.pc-sync-row{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #38383d;border-radius:9px;background:#18181b}.pc-sync-row input{accent-color:#c9fa5f}.pc-sync-row span{min-width:0}.pc-sync-row strong,.pc-sync-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pc-sync-row small{color:#92929a;margin-top:3px}.pc-sync-status{min-height:18px;color:#bfdc78;font-size:12px;margin:10px 0}
    @media(min-width:700px){.mobile-native-app .grid.compact-view{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  style.textContent += '.mobile-native-app .mvsep-key-section,.mobile-native-app .mvsep-model-section{display:block!important}.mobile-native-app .local-audio-section,.mobile-native-app .local-lyrics-alignment-section,.mobile-native-app .youtube-video-download,.mobile-native-app [data-setup-feature="youtube"]{display:none!important}';
  document.head.append(style);
  const welcomeActions = document.createElement('div');
  welcomeActions.className = 'mobile-library-actions';
  const syncButton = document.createElement('button');
  syncButton.type = 'button';
  syncButton.className = 'btn secondary';
  syncButton.id = 'syncPcLibrary';
  syncButton.textContent = '▣ Conectar ao VoxStage';
  const welcome = document.querySelector('.welcome');
  const addButton = $('addTop');
  if (addButton && welcome) {
    addButton.textContent = '＋ Adicionar música';
    welcomeActions.append(addButton, syncButton);
    welcome.append(welcomeActions);
  }
  const libraryHeading = document.querySelector('.welcome h1');
  if (libraryHeading) libraryHeading.textContent = 'Sua biblioteca';

  const syncDialog = document.createElement('div');
  syncDialog.id = 'pcSyncDialog';
  syncDialog.className = 'modal-back';
  syncDialog.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pcSyncTitle"><div class="modal-head"><h2 id="pcSyncTitle">Conectar ao VoxStage</h2><button class="x" id="pcSyncClose" aria-label="Fechar">×</button></div><p>Leia o QR exibido no VoxStage do PC ou da TV para controlar a reprodução e enviar músicas. Os dois aparelhos precisam estar na mesma rede Wi‑Fi.</p><input class="field" id="pcSyncLink" placeholder="http://192.168.x.x:8000/remote#código"><input id="pcSyncScanInput" type="file" accept="image/*" capture="environment" hidden><div class="pc-sync-actions"><button class="btn secondary" id="pcSyncScan">▣ Abrir leitor QR</button><button class="btn secondary" id="pcSyncPhoto">Ler QR de uma foto</button><button class="btn secondary" id="pcSyncFind">Conectar pelo link</button></div><section class="pc-remote-controls" id="pcRemoteControls" hidden><div class="pc-remote-heading"><strong>Controle remoto</strong><span id="pcRemoteNow">Conectando…</span></div><div class="pc-remote-buttons"><button class="btn secondary" data-pc-control="previous" aria-label="Música anterior">↶</button><button class="btn" id="pcRemotePlay" data-pc-control="toggle">▶</button><button class="btn secondary" data-pc-control="next" aria-label="Próxima música">↷</button></div><div class="pc-remote-request"><input class="field" id="pcRequestTitle" placeholder="Pedir uma música que não está na lista"><input class="field" id="pcRequestArtist" placeholder="Artista (opcional)"><button class="btn secondary" id="pcSendRequest">Enviar pedido</button></div><small class="pc-remote-status" id="pcRemoteStatus" aria-live="polite"></small></section><div class="pc-sync-actions"><button class="btn secondary" id="pcSyncAll" disabled>Selecionar todas</button><button class="btn" id="pcSyncImport" disabled>Baixar selecionadas</button></div><div class="pc-sync-status" id="pcSyncStatus" aria-live="polite"></div><div class="pc-sync-list" id="pcSyncSongs"></div><div class="modal-actions"><button class="btn secondary" id="pcSyncCancel">Fechar</button></div></div>`;
  syncDialog.querySelector('#pcSyncSongs').insertAdjacentHTML('afterend', `<section class="mobile-send-section" id="mobileSendSection" hidden><h3>Músicas deste celular</h3><p>Peça uma faixa para adicioná-la à fila. Se ela ainda não estiver no aparelho conectado, será enviada automaticamente. Você também pode enviar várias faixas sem tocar.</p><div class="pc-sync-list" id="mobileSendSongs"></div><button class="btn" id="mobileSendSelected" type="button">Enviar selecionadas</button></section>`);
  syncDialog.querySelector('#pcRemoteControls').insertAdjacentHTML('beforeend', `<section id="tvKeyTransfer" hidden><b>Chave MVSEP na Google TV</b><p>Envie a chave salva neste celular ou cole uma chave abaixo. Ela será guardada na TV conectada.</p><input class="field" id="tvMvsepToken" type="password" autocomplete="new-password" placeholder="Chave MVSEP (opcional)"><button class="btn secondary" id="sendTvMvsepKey" type="button">Enviar chave para a TV</button><small id="tvMvsepKeyStatus" aria-live="polite"></small></section>`);
  document.body.append(syncDialog);
  $('sendTvMvsepKey').onclick = async () => {
    const button = $('sendTvMvsepKey'); button.disabled = true;
    $('tvMvsepKeyStatus').textContent = 'Enviando chave…';
    try {
      await mobileInvoke('mobile_remote_send_mvsep_key', {...parsePcLink(), apiKey: $('tvMvsepToken').value.trim() || null});
      $('tvMvsepToken').value = '';
      $('tvMvsepKeyStatus').textContent = 'Chave salva na TV. Ela já pode separar músicas com MVSEP.';
    } catch (error) { $('tvMvsepKeyStatus').textContent = String(error?.message || error); }
    finally { button.disabled = false; }
  };

  const qrScanner = document.createElement('div');
  qrScanner.className = 'pc-qr-scanner'; qrScanner.id = 'pcQrScanner'; qrScanner.hidden = true;
  qrScanner.innerHTML = `<section class="pc-qr-scanner-card" role="dialog" aria-modal="true" aria-label="Leitor de QR code"><header><strong>Aponte para o QR do VoxStage</strong><button type="button" class="lyrics-close" id="pcQrScannerClose" aria-label="Fechar câmera">×</button></header><video id="pcQrScannerVideo" autoplay muted playsinline></video><p id="pcQrScannerStatus">Abrindo a câmera…</p></section>`;
  document.body.append(qrScanner);
  let pcQrStream = null, pcQrTimer = 0, pcQrDetecting = false;
  const stopPcQrScanner = () => {
    clearTimeout(pcQrTimer); pcQrTimer = 0; pcQrDetecting = false;
    pcQrStream?.getTracks().forEach(track => track.stop()); pcQrStream = null;
    $('pcQrScannerVideo').srcObject = null; qrScanner.hidden = true;
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPcQrScanner(); });
  let pcRemoteState = null, pcRemoteTimer = 0, pcTransferTimer = 0;
  const pendingPcTransfers = new Map();
  const closePcSync = () => { stopPcQrScanner(); clearInterval(pcRemoteTimer); clearInterval(pcTransferTimer); pcRemoteTimer = pcTransferTimer = 0; syncDialog.classList.remove('show'); };
  const qrStyle = document.createElement('style');
  qrStyle.textContent = `.pc-qr-scanner[hidden]{display:none!important}.pc-qr-scanner{position:fixed;inset:0;z-index:16000;display:grid;place-items:center;padding:16px;background:#050506ed;backdrop-filter:blur(12px)}.pc-qr-scanner-card{width:min(560px,100%);padding:16px;border:1px solid #44444b;border-radius:18px;background:#19191d;box-shadow:0 24px 80px #000c}.pc-qr-scanner-card header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.pc-qr-scanner-card video{display:block;width:100%;max-height:65dvh;aspect-ratio:4/3;object-fit:cover;border-radius:12px;background:#080809}.pc-qr-scanner-card p{min-height:18px;margin:10px 0 0;color:#c8e98c;font-size:12px}.mobile-native-app .pc-sync-actions{grid-template-columns:1fr 1fr}.mobile-native-app .pc-sync-actions:first-of-type #pcSyncFind{grid-column:1/-1}.mobile-native-app .pc-remote-controls[hidden]{display:none!important}.mobile-native-app .pc-remote-controls{display:grid;gap:8px;margin-top:13px;padding:12px;border:1px solid #3b3e31;border-radius:13px;background:#17191a}.mobile-native-app .pc-remote-heading{display:grid;gap:5px}.mobile-native-app .pc-remote-heading strong{font-size:13px}.mobile-native-app .pc-remote-heading span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b6c987;font-size:10px}.mobile-native-app .pc-remote-buttons{display:grid;grid-template-columns:1fr 1.35fr 1fr;gap:8px}.mobile-native-app .pc-remote-buttons button{justify-content:center;min-height:42px}.mobile-native-app .pc-remote-request{display:grid;grid-template-columns:1fr 1fr;gap:6px}.mobile-native-app .pc-remote-request .field{margin-top:0;font-size:11px}.mobile-native-app #pcRequestTitle,.mobile-native-app #pcSendRequest{grid-column:1/-1}.mobile-native-app .pc-remote-status{min-height:14px;color:#a7b875;font-size:10px}.mobile-native-app .pc-sync-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center}.mobile-native-app .pc-sync-request{padding:7px 9px;border:1px solid #34383a;border-radius:8px;background:#222529;color:#e5e5e8;font-size:10px}`;
  document.head.append(qrStyle);
  qrStyle.textContent += `.mobile-send-section{margin-top:16px;padding-top:14px;border-top:1px solid #39393e}.mobile-send-section[hidden]{display:none!important}.mobile-send-section h3{font:700 13px Manrope;margin:0 0 5px}.mobile-send-section p{margin:0;color:#aaa;font-size:11px;line-height:1.4}.mobile-send-section .pc-sync-list{max-height:27dvh}.mobile-send-row{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;align-items:center}.mobile-send-row .transfer-progress{grid-column:2;width:100%;height:5px;accent-color:var(--lime)}.mobile-send-row .transfer-state{grid-column:2;color:#b8ca91;font-size:10px}.mobile-send-section>.btn{width:100%;justify-content:center}`;
  const parsePcLink = () => {
    const link = new URL($('pcSyncLink').value.trim());
    const token = decodeURIComponent(link.hash.slice(1));
    if (!token) throw new Error('Cole o link completo do QR exibido no PC ou na TV.');
    if (!/^https?:$/.test(link.protocol)) throw new Error('O link de conexão não é válido.');
    return {baseUrl: link.origin, token};
  };
  syncButton.onclick = () => {
    $('pcSyncLink').value = localStorage.getItem('voxstage-pc-sync-link') || '';
    $('pcSyncSongs').innerHTML = '';
    $('mobileSendSongs').innerHTML = '';
    $('mobileSendSection').hidden = true;
    $('tvKeyTransfer').hidden = true; $('tvMvsepToken').value = ''; $('tvMvsepKeyStatus').textContent = '';
    $('pcRemoteControls').hidden = true; pcRemoteState = null; clearInterval(pcRemoteTimer); pcRemoteTimer = 0;
    $('pcSyncStatus').textContent = '';
    $('pcSyncImport').disabled = true;
    $('pcSyncAll').disabled = true;
    syncDialog.classList.add('show');
  };
  $('pcSyncClose').onclick = $('pcSyncCancel').onclick = closePcSync;
  syncDialog.addEventListener('click', event => { if (event.target === syncDialog) closePcSync(); });
  const findPcSongs = async () => {
    try {
      const connection = parsePcLink();
      localStorage.setItem('voxstage-pc-sync-link', $('pcSyncLink').value.trim());
      $('pcSyncStatus').textContent = 'Buscando a biblioteca…';
      const library = await mobileInvoke('mobile_get_pc_library', connection);
      if (!syncDialog.classList.contains('show')) return;
      $('pcSyncSongs').innerHTML = library.map(song => `<div class="pc-sync-row"><input type="checkbox" value="${esc(song.id)}"><span><strong>${esc(song.title || 'Sem título')}</strong><small>${esc(song.artist || 'Artista desconhecido')}</small></span><button class="pc-sync-request" type="button" data-pc-request="${esc(song.id)}">Pedir</button></div>`).join('') || '<span class="empty">O aparelho conectado ainda não tem músicas na biblioteca.</span>';
      const localLibrary=await mobileInvoke('mobile_get_library');
      const existingIds=new Set(library.map(song=>song.id));
      $('mobileSendSongs').innerHTML=localLibrary.map(song=>`<label class="pc-sync-row mobile-send-row" data-mobile-song="${esc(song.id)}"><input type="checkbox" value="${esc(song.id)}" ${existingIds.has(song.id)?'disabled':''}><span><strong>${esc(song.title||'Sem título')}</strong><small>${esc(song.artist||'Artista desconhecido')}</small></span><button class="pc-sync-request" type="button" data-local-request="${esc(song.id)}">Pedir</button><progress class="transfer-progress" max="100" value="0" hidden></progress><small class="transfer-state">${existingIds.has(song.id)?'Já está no aparelho conectado':''}</small></label>`).join('')||'<span class="empty">Não há músicas neste celular para enviar.</span>';
      $('mobileSendSection').hidden=false;
      $('mobileSendSongs').querySelectorAll('[data-local-request]').forEach(button => button.onclick = async event => { event.preventDefault(); button.disabled=true; try { await sendPcRemoteRequest({songId:button.dataset.localRequest}); } finally { button.disabled=false; } });
      $('mobileSendSelected').disabled=!localLibrary.some(song=>!existingIds.has(song.id));
      $('pcRemoteControls').hidden = false;
      $('pcSyncSongs').querySelectorAll('[data-pc-request]').forEach(button => button.onclick = () => sendPcRemoteRequest({songId:button.dataset.pcRequest}));
      await refreshPcRemoteState();
      clearInterval(pcRemoteTimer); pcRemoteTimer = setInterval(refreshPcRemoteState, 2500);
      clearInterval(pcTransferTimer); pcTransferTimer = setInterval(refreshPendingPcTransfers, 2500);
      $('pcSyncStatus').textContent = `${library.length} música(s) encontradas. Marque as que quer baixar.`;
      $('pcSyncImport').disabled = !library.length;
      $('pcSyncAll').disabled = !library.length;
      const tvConnection = pcRemoteState?.hostType === 'tv';
      $('pcSyncImport').hidden = tvConnection; $('pcSyncAll').hidden = tvConnection;
      $('mobileSendSection').hidden = false;
      $('pcSyncSongs').querySelectorAll('input[type="checkbox"]').forEach(input => input.hidden = tvConnection);
      if (tvConnection) $('pcSyncStatus').textContent = 'Conectado à TV. Use os controles ou peça uma música da biblioteca.';
    } catch (error) {
      $('pcSyncStatus').textContent = error.message;
    }
  };
  const refreshPcRemoteState = async () => {
    if (!syncDialog.classList.contains('show')) return;
    try {
      pcRemoteState = await mobileInvoke('mobile_remote_state', parsePcLink());
      $('tvKeyTransfer').hidden = pcRemoteState.hostType !== 'tv';
      const title = pcRemoteState.title ? `${pcRemoteState.title}${pcRemoteState.artist ? ` · ${pcRemoteState.artist}` : ''}` : 'Nenhuma música tocando';
      $('pcRemoteNow').textContent = pcRemoteState.title ? title : (interfaceLanguage==='en-US'?'No song playing on the host':'Nenhuma música tocando');
      $('pcRemotePlay').innerHTML = playbackControlSvg(pcRemoteState.playing ? 'pause' : 'play');
      $('pcRemotePlay').setAttribute('aria-label', pcRemoteState.playing ? 'Pausar reprodução' : 'Retomar reprodução');
      $('pcRemoteStatus').textContent = pcRemoteState.playing ? (pcRemoteState.hostType === 'tv' ? 'Tocando na TV' : 'Tocando no computador') : 'Reprodução pausada';
    } catch (error) { $('pcRemoteStatus').textContent = error.message; }
  };
  const mobileTransferRow=id=>[...$('mobileSendSongs').querySelectorAll('[data-mobile-song]')].find(row=>row.dataset.mobileSong===id);
  const refreshPendingPcTransfers=async()=>{
    if (!syncDialog.classList.contains('show') || !pendingPcTransfers.size) return;
    let connection;
    try { connection=parsePcLink(); } catch { return; }
    for (const [transferId,songId] of pendingPcTransfers) {
      try {
        const result=await mobileInvoke('mobile_pc_transfer_status',{...connection,id:transferId});
        if (result.status==='pending') continue;
        const row=mobileTransferRow(songId);
        if (row) row.querySelector('.transfer-state').textContent=result.status==='approved'?'Salva no aparelho conectado':result.status==='rejected'?'Recusada no aparelho conectado':result.error||result.status;
        pendingPcTransfers.delete(transferId);
      } catch (error) { $('pcSyncStatus').textContent=String(error); }
    }
  };
  if (window.__TAURI__?.event?.listen) window.__TAURI__.event.listen('voxstage-pc-transfer-progress',event=>{
    const progress=event.payload||{}, row=mobileTransferRow(progress.songId);
    if (!row) return;
    const bar=row.querySelector('progress'); bar.hidden=false;
    bar.value=Math.min(100,Math.round(100*Number(progress.sent||0)/Math.max(1,Number(progress.total||1))));
    row.querySelector('.transfer-state').textContent=`Enviando ${progress.file||'arquivo'} · ${bar.value}%`;
  }).catch(error=>console.warn('Progresso da transferência indisponível',error));
  $('mobileSendSelected').onclick=async()=>{
    let connection;
    try { connection=parsePcLink(); } catch(error) { $('pcSyncStatus').textContent=error.message; return; }
    const selected=[...$('mobileSendSongs').querySelectorAll('input:checked')].map(input=>input.value);
    if (!selected.length) { $('pcSyncStatus').textContent='Selecione uma música do celular.'; return; }
    $('mobileSendSelected').disabled=true;
    for (const id of selected) {
      const row=mobileTransferRow(id);
      if (row) { row.querySelector('input').disabled=true; row.querySelector('.transfer-state').textContent='Preparando envio…'; }
      try {
        const result=await mobileInvoke('mobile_send_pc_song',{...connection,id});
        pendingPcTransfers.set(result.id,id);
        if (row) row.querySelector('.transfer-state').textContent='Enviada · salvando na biblioteca';
      } catch(error) {
        if (row) { row.querySelector('.transfer-state').textContent=String(error); row.querySelector('input').disabled=false; }
      }
    }
    $('mobileSendSelected').disabled=false;
    $('pcSyncStatus').textContent='As músicas selecionadas serão salvas automaticamente no aparelho conectado.';
    void refreshPendingPcTransfers();
  };
  const sendPcRemoteControl = async action => {
    try {
      const resolvedAction = action === 'toggle' ? (pcRemoteState?.playing ? 'pause' : 'play') : action;
      await mobileInvoke('mobile_remote_control', {...parsePcLink(), action:resolvedAction, songId:null});
      $('pcRemoteStatus').textContent = pcRemoteState?.hostType==='tv'?'Comando enviado à TV.':'Comando enviado ao computador.';
      setTimeout(refreshPcRemoteState, 500);
    } catch (error) { $('pcRemoteStatus').textContent = error.message; }
  };
  const sendPcRemoteRequest = async ({songId=null}={}) => {
    try {
      $('pcRemoteStatus').textContent='Preparando pedido… Se a faixa estiver só no celular, ela será enviada automaticamente.';
      const result = await mobileInvoke('mobile_remote_request', {...parsePcLink(), title:$('pcRequestTitle').value.trim(), artist:$('pcRequestArtist').value.trim(), songId});
      $('pcRemoteStatus').textContent = result?.status === 'approved' ? 'Música adicionada à fila.' : 'Pedido enviado. Aprove no aparelho conectado antes de buscar ou separar a faixa.';
      if (!songId) $('pcRequestTitle').value = '';
    } catch (error) { $('pcRemoteStatus').textContent = error.message; }
  };
  syncDialog.querySelectorAll('[data-pc-control]').forEach(button => button.onclick = () => sendPcRemoteControl(button.dataset.pcControl));
  $('pcSendRequest').onclick = () => sendPcRemoteRequest();
  $('pcSyncFind').onclick = findPcSongs;
  const startPcQrScanner = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este Android não liberou acesso direto à câmera. Use “Ler QR de uma foto” ou cole o link.');
      if (!('BarcodeDetector' in window)) throw new Error('O leitor de QR não está disponível neste WebView. Use “Ler QR de uma foto” ou cole o link.');
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) throw new Error('Este WebView não reconhece QR codes. Use “Ler QR de uma foto” ou cole o link.');
      qrScanner.hidden = false;
      $('pcQrScannerStatus').textContent = 'Solicitando permissão da câmera…';
      pcQrStream = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
      const video = $('pcQrScannerVideo'); video.srcObject = pcQrStream;
      await video.play();
      const detector = new BarcodeDetector({formats:['qr_code']});
      pcQrDetecting = true;
      const scanFrame = async () => {
        if (!pcQrDetecting) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          try {
            const codes = await detector.detect(video);
            const value = codes.find(code => code.rawValue)?.rawValue;
            if (value) {
              $('pcSyncLink').value = value.trim(); parsePcLink();
              $('pcQrScannerStatus').textContent = 'QR reconhecido. Conectando…';
              stopPcQrScanner(); await findPcSongs(); return;
            }
          } catch (error) {
            $('pcQrScannerStatus').textContent = `Não consegui ler a imagem: ${error.message}`;
          }
        }
        pcQrTimer = setTimeout(scanFrame, 140);
      };
      $('pcQrScannerStatus').textContent = 'Mantenha o QR inteiro dentro da moldura.';
      scanFrame();
    } catch (error) {
      stopPcQrScanner();
      $('pcSyncStatus').textContent = error.message || 'Não consegui abrir a câmera.';
    }
  };
  $('pcSyncScan').onclick = startPcQrScanner;
  $('pcSyncPhoto').onclick = () => $('pcSyncScanInput').click();
  $('pcQrScannerClose').onclick = stopPcQrScanner;
  qrScanner.onclick = event => { if (event.target === qrScanner) stopPcQrScanner(); };
  $('pcSyncScanInput').onchange = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!('BarcodeDetector' in window)) throw new Error('Este aparelho não oferece leitura de QR integrada. Cole o link do QR manualmente ou atualize o Android System WebView.');
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) throw new Error('O leitor deste aparelho não reconhece QR codes. Cole o link do controle web.');
      $('pcSyncStatus').textContent = 'Lendo o QR da câmera…';
      const detector = new BarcodeDetector({formats:['qr_code']});
      const image = await createImageBitmap(file);
      let codes;
      try { codes = await detector.detect(image); } finally { image.close?.(); }
      const rawValue = codes.find(code => code.rawValue)?.rawValue;
      if (!rawValue) throw new Error('Não encontrei um QR code na imagem. Tente enquadrar o QR inteiro e com boa iluminação.');
      $('pcSyncLink').value = rawValue.trim();
      parsePcLink();
      $('pcSyncStatus').textContent = 'QR lido. Conectando ao VoxStage…';
      await findPcSongs();
    } catch (error) {
      $('pcSyncStatus').textContent = error.message || 'Não consegui ler este QR code.';
    } finally {
      event.target.value = '';
    }
  };
  $('pcSyncAll').onclick = () => {
    const boxes = [...$('pcSyncSongs').querySelectorAll('input[type="checkbox"]')];
    const select = boxes.some(box => !box.checked);
    boxes.forEach(box => { box.checked = select; });
    $('pcSyncAll').textContent = select ? 'Desmarcar todas' : 'Selecionar todas';
  };
  $('pcSyncImport').onclick = async () => {
    const ids = [...$('pcSyncSongs').querySelectorAll('input[type="checkbox"]:checked')].map(box => box.value);
    if (!ids.length) { $('pcSyncStatus').textContent = 'Selecione pelo menos uma música.'; return; }
    try {
      $('pcSyncImport').disabled = true;
      $('pcSyncStatus').textContent = 'Baixando músicas e arquivos. Isso pode levar alguns minutos…';
      const imported = await mobileInvoke('mobile_import_pc_songs', {...parsePcLink(), ids});
      await loadSongs();
      $('pcSyncStatus').textContent = `${imported} música(s) adicionadas à biblioteca deste celular.`;
      $('pcSyncImport').disabled = false;
    } catch (error) {
      $('pcSyncStatus').textContent = error.message;
      $('pcSyncImport').disabled = false;
    }
  };
}

loadSongs = async function () {
  try {
    await mobileStorageReady;
    songs = await api('/api/library');
    songs.forEach(song => { song.coverUrl = mediaUrl(song.cover); });
    render();
  } catch (error) {
    console.error(error);
    toast('Não consegui acessar a biblioteca local. Inicie o app pelo arquivo .bat.');
  }
};

render = function () {
  const query = $('search').value.toLowerCase();
  const list = songs.filter(song => (showHiddenSongs || !song.hidden) && (!favoriteOnly || song.favorite) && (libraryLyricsFilter === 'all' || songHasSyncedLyrics(song) === (libraryLyricsFilter === 'ready')) && `${song.title} ${song.artist}`.toLowerCase().includes(query));
  if (sorted) list.reverse();
  libraryDisplayOrder=list.map(song=>song.id);
  $('songCount').textContent = songs.filter(song => showHiddenSongs || !song.hidden).length;
  $('grid').classList.toggle('compact-view', compactTrackView);
  $('grid').innerHTML = list.length ? list.map((song, index) => { return `<article class="track" data-song-id="${esc(song.id)}"><div class="cover c${index % 6 + 1}"><span class="cover-letter">${esc((song.title || '♫')[0].toUpperCase())}</span>${song.cover ? `<img class="cover-image" src="${mediaUrl(song.cover)}" alt="Capa de ${esc(song.title)}">` : ''}<button class="track-play" data-play="${song.id}" aria-label="Tocar ${esc(song.title)}">▶</button></div><div class="track-info"><div class="track-title" title="${esc(song.title)}">${esc(song.title)}</div><div class="track-artist">${esc(song.artist || 'Artista desconhecido')}</div><div class="track-meta"><span class="tag">${song.separationStatus === 'pending' ? 'Não separada' : song.back ? '3 stems' : '2 stems'}</span><div class="track-actions"><button class="action-icon ${song.favorite ? 'is-fav' : ''}" title="${song.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" aria-label="${song.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" data-fav="${song.id}">★</button><div class="track-menu-wrap"><button class="action-icon track-menu-toggle" title="Mais opções" aria-label="Mais opções para ${esc(song.title)}" aria-expanded="false" data-menu-toggle="${song.id}">⋮</button><div class="track-menu" data-track-menu="${song.id}" hidden><button type="button" data-add-queue="${esc(song.id)}">＋ <span>Adicionar à fila</span></button><button type="button" data-fav="${esc(song.id)}">☆ <span>${song.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}</span></button>${song.source && !song.lead ? `<button type="button" data-mvsep-separate="${song.id}">✦ <span>Separar com MVSEP</span></button>` : ''}<button type="button" data-export-song="${song.id}">⇩ <span>Exportar música</span></button><button type="button" data-edit="${song.id}">✎ <span>Editar música</span></button><button type="button" data-hide-song="${song.id}">◌ <span>${song.hidden ? "Mostrar música" : "Ocultar música"}</span></button><button type="button" class="menu-delete" data-delete="${song.id}">× <span>Apagar música</span></button></div></div></div></div></div></article>`; }).join('') : `<div class="empty">${favoriteOnly ? 'Você ainda não favoritou músicas.' : songs.length ? 'Nenhuma música encontrada.' : 'Sua biblioteca está vazia. Adicione uma música para começar.'}</div>`;
  if (compactTrackView) document.querySelectorAll('.grid.compact-view .track').forEach(card => {
    const coverImage = card.querySelector('.cover-image');
    if (coverImage) card.style.setProperty('--track-cover', `url("${coverImage.src}")`);
  });
  document.querySelectorAll('.cover-image').forEach(image => {
    image.addEventListener('load', () => image.closest('.cover')?.classList.add('cover-image-ready'), {once: true});
    image.addEventListener('error', () => { image.remove(); image.closest('.cover')?.classList.remove('cover-image-ready'); }, {once: true});
    if (image.complete && image.naturalWidth > 0) image.closest('.cover')?.classList.add('cover-image-ready');
  });
  document.querySelectorAll('.cover-image').forEach(image => image.addEventListener('load', () => {
    const ratio = image.naturalWidth / image.naturalHeight;
    const box = image.closest('.cover');
    box.dataset.aspect = ratio > 1.55 && ratio < 1.95 ? '16:9' : ratio > 1.22 && ratio < 1.48 ? '4:3' : 'other';
    if (box.dataset.aspect !== 'other') {
      image.classList.add('wide-cover');
      box.style.backgroundImage = `linear-gradient(#0003,#0003),url("${image.src}")`;
      box.style.backgroundSize = 'cover'; box.style.backgroundPosition = 'center';
    }
  }, {once: true}));
  document.querySelectorAll('[data-play]').forEach(button => button.onclick = () => playSong(button.dataset.play));
  document.querySelectorAll('[data-add-queue]').forEach(button => button.onclick = () => addToPlaybackQueue(button.dataset.addQueue));
  document.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => deleteSong(button.dataset.delete));
  document.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => editSong(button.dataset.edit));
  document.querySelectorAll('[data-export-song]').forEach(button=>button.onclick=()=>exportArchive(button.dataset.exportSong));
  document.querySelectorAll('[data-hide-song]').forEach(button => button.onclick = () => setSongHidden(button.dataset.hideSong));
  document.querySelectorAll('[data-mvsep-separate]').forEach(button => button.onclick = () => runMvsepSeparation(button.dataset.mvsepSeparate));
  document.querySelectorAll('[data-fav]').forEach(button => button.onclick = () => toggleFavorite(button.dataset.fav));
  document.querySelectorAll('[data-menu-toggle]').forEach(button => button.onclick = event => {
    event.stopPropagation();
    const menu = document.querySelector(`[data-track-menu="${CSS.escape(button.dataset.menuToggle)}"]`);
    const opening = menu?.hidden;
    document.querySelectorAll('.track-menu').forEach(other => { other.hidden = true; });
    document.querySelectorAll('[data-menu-toggle]').forEach(other => other.setAttribute('aria-expanded', 'false'));
    if (menu) { menu.hidden = !opening; button.setAttribute('aria-expanded', String(Boolean(opening))); }
  });
};
async function setSongHidden(id) {
  const song = songs.find(item => item.id === id); if (!song) return;
  try {
    await api('/api/library', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...song, hidden: !song.hidden})});
    song.hidden = !song.hidden;
    if (current?.id === id) current.hidden = song.hidden;
    render();
    toast(song.hidden ? 'Música oculta. Use “Mostrar ocultas” para recuperá-la.' : 'Música visível novamente.');
  } catch (error) { toast(error.message); }
}
document.addEventListener('click', () => {
  document.querySelectorAll('.track-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('[data-menu-toggle]').forEach(button => button.setAttribute('aria-expanded', 'false'));
});
// Carrega a biblioteca imediatamente; assim, uma falha em ajustes visuais não esconde as músicas locais.
loadSongs();

const picker = document.createElement('input');
picker.type = 'file'; picker.multiple = true; picker.accept = 'audio/*,image/*,video/*'; picker.id = 'allFiles';
const fileRow = document.querySelector('.file-row');
fileRow.classList.add('unified-files');
fileRow.innerHTML = `<label class="unified-picker">＋ Escolher arquivos de áudio, imagem e vídeo <span>Selecione vários arquivos de uma vez</span></label><div class="assignments" id="assignments"><div class="assignment-empty">Depois da seleção, marque o papel de cada arquivo.</div></div>`;
fileRow.querySelector('.unified-picker').append(picker);
document.querySelector('#modal .modal > p').textContent = 'Escolha os arquivos e marque cada papel. Uma faixa completa pode ser tocada ou separada depois pelo menu da música; tudo fica na pasta music.';
document.querySelector('.drop h3').textContent = 'Arquivos para esta música';
document.querySelector('.drop > small').textContent = 'Áudio e imagem · selecione vários arquivos';
const uploadStyle = document.createElement('style');
uploadStyle.textContent = `.modal{max-height:90vh;overflow-y:auto}.unified-files{display:block}.unified-picker{position:relative;display:block;padding:14px;border:1px dashed #56565c;border-radius:10px;background:#202023;color:var(--lime)!important;font-weight:700;text-align:center;cursor:pointer}.unified-picker span{display:block;color:#929298;font-size:10px;font-weight:400;margin-top:5px}.unified-picker input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.assignments{display:grid;gap:7px;margin-top:11px;max-height:210px;overflow:auto}.assignment{display:grid;grid-template-columns:20px minmax(0,1fr) 145px;gap:8px;align-items:center;background:#141416;border:1px solid #303035;border-radius:8px;padding:7px 9px}.file-kind{color:var(--lime)}.file-name{font-size:10px;color:#d4d4d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.assignment select{min-width:0;width:100%;background:#222226;color:#ddd;border:1px solid #3d3d42;border-radius:6px;padding:6px;font-size:10px}.assignment-empty{padding:12px;text-align:center;font-size:10px;color:#808087}`;
uploadStyle.textContent += `.local-separation-status{display:block;max-width:100%;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8b182;font-size:9px;line-height:1.4}.track-menu button:disabled{opacity:.55;cursor:wait}`;
document.head.append(uploadStyle);
const youtubeImport = document.createElement('section');
youtubeImport.className = 'youtube-import';
const mobileYoutubeDescription = interfaceLanguage==='en-US'?'Search or paste a link. yt-dlp runs inside the app; after downloading, confirm the audio role in the form and save the song. Some YouTube tracks may still be unavailable while its JavaScript challenge runtime is being integrated.':'Busque uma faixa ou cole o link. O yt-dlp roda dentro do app; ao baixar, confira o papel do áudio no formulário e salve a música. Algumas faixas do YouTube ainda podem falhar enquanto integramos o runtime JavaScript de desafios.';
const mobileYoutubeStatus = interfaceLanguage==='en-US'?'Search by title or paste a YouTube link.':'Pesquise pelo nome ou cole um link do YouTube.';
youtubeImport.innerHTML = `<div class="youtube-import-head"><div><span class="processing-kicker">${mobileNative?'YT-DLP · INTEGRADO':'MVSep · ONLINE'}</span><h3>Buscar ou colar do YouTube</h3></div><span class="youtube-badge">YouTube Music primeiro</span></div><p>${mobileNative?mobileYoutubeDescription:'A busca prioriza faixas do catálogo do YouTube Music para evitar apresentações ao vivo e videoclipes. O VoxStage baixa o áudio com yt-dlp e envia à MVSep para separar os stems; o serviço pode usar créditos da sua conta.'}</p><div class="youtube-search-row"><input id="youtubeQuery" placeholder="Link do YouTube ou nome da música"><button class="btn secondary" id="youtubeSearch">Buscar</button></div><label class="youtube-normal-toggle"><input id="includeNormalYoutube" type="checkbox"><span>Incluir resultados do YouTube normal</span></label><div class="youtube-status" id="youtubeStatus">${mobileNative?mobileYoutubeStatus:'Configure uma chave MVSep em ⚙ Configurações para usar esta opção.'}</div><div class="youtube-progress" id="youtubeProgress" hidden><div class="youtube-progress-track"><i id="youtubeProgressFill"></i></div><small id="youtubeProgressLabel">0%</small></div><div class="mvsep-queue" id="mvsepQueue" hidden><div class="mvsep-queue-heading"><strong id="mvsepQueueStage">Fila MVSep</strong><span id="mvsepQueuePercent"></span></div><div id="mvsepFileTransfers"></div></div><div class="youtube-results" id="youtubeResults"></div>`;
const manualImport = document.querySelector('.drop');
const importMethods = document.createElement('div'); importMethods.className = 'input-methods';
manualImport.parentElement.insertBefore(importMethods, manualImport);
importMethods.append(youtubeImport, manualImport);
const youtubeVideoDownload = document.createElement('section');
youtubeVideoDownload.className = 'youtube-video-download';
youtubeVideoDownload.innerHTML = `<div><span class="processing-kicker">DOWNLOAD LOCAL · YT-DLP</span><h3>Baixar vídeo</h3><p>Baixe um vídeo do YouTube diretamente para a pasta music, sem enviar nada à MVSep. Ele fica disponível como fundo mudo; se não houver faixa combinada no YouTube, o download salva apenas o vídeo e não precisa de FFmpeg.</p></div><div class="youtube-video-download-row"><input id="youtubeVideoUrl" type="url" placeholder="Cole o link do vídeo do YouTube"><button class="btn secondary" id="youtubeVideoDownloadButton">Baixar vídeo</button></div><div class="youtube-video-download-status" id="youtubeVideoDownloadStatus" aria-live="polite"></div><div class="youtube-video-progress" id="youtubeVideoProgress" hidden><div><i id="youtubeVideoProgressFill"></i></div><small id="youtubeVideoProgressLabel">0%</small></div>`;
importMethods.insertAdjacentElement('afterend', youtubeVideoDownload);
const youtubeStyle = document.createElement('style');
youtubeStyle.textContent = `.youtube-import{margin-top:14px;padding:15px;border-radius:13px;background:linear-gradient(145deg,#211a1d,#191719);border:1px solid #59353b}.youtube-import-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.youtube-import-head h3{font-size:13px;margin:5px 0 0}.youtube-badge{font-size:9px;color:#b4e77a;border:1px solid #526838;background:#252c1e;border-radius:20px;padding:5px 8px;white-space:nowrap}.youtube-import>p{margin:9px 0 11px;color:#b6a9ac;font-size:10px;line-height:1.5}.youtube-search-row{display:flex;gap:8px}.youtube-search-row input{flex:1;min-width:0;background:#111113;color:#eee;border:1px solid #3d3538;border-radius:8px;padding:9px 10px;font-size:11px;outline:none}.youtube-search-row input:focus{border-color:#9e555d}.youtube-search-row .btn{padding:8px 11px;font-size:10px}.youtube-normal-toggle{display:flex;align-items:center;gap:7px;margin-top:9px;color:#c2b4b7;font-size:10px;cursor:pointer}.youtube-normal-toggle input{accent-color:var(--lime)}.youtube-status{margin-top:9px;color:#d29ca0;font-size:10px;line-height:1.5}.youtube-progress{display:flex;align-items:center;gap:9px;margin-top:9px}.youtube-progress[hidden]{display:none}.youtube-progress-track{height:7px;flex:1;overflow:hidden;border-radius:8px;background:#33292c}.youtube-progress-track i{display:block;width:0;height:100%;border-radius:inherit;background:var(--lime);transition:width .35s ease}.youtube-progress.indeterminate .youtube-progress-track i{width:35%;animation:youtubeProgressMove 1.25s ease-in-out infinite alternate}.youtube-progress small{min-width:31px;text-align:right;color:#c9c9ce;font-size:9px;font-variant-numeric:tabular-nums}@keyframes youtubeProgressMove{from{transform:translateX(0)}to{transform:translateX(185%)}}.youtube-results{display:grid;gap:6px;margin-top:8px;max-height:240px;overflow:auto}.youtube-result{display:grid;grid-template-columns:54px minmax(0,1fr) auto;grid-template-rows:auto auto;gap:3px 10px;align-items:center;text-align:left;padding:7px 9px;border:1px solid #393236;border-radius:8px;background:#171517;color:#eee;min-width:0}.youtube-result:hover{border-color:#a54c57;background:#21181a}.youtube-result-thumb{grid-column:1;grid-row:1/3;width:54px;height:40px;object-fit:cover;border-radius:5px;background:#29272a}.youtube-result strong,.youtube-result small{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.youtube-result strong{grid-row:1;font-size:10px}.youtube-result small{grid-row:2;font-size:9px;color:#999;margin-top:3px}.youtube-result span{grid-column:3;grid-row:1/3;color:#ff9ca2;font-size:9px;font-weight:700;white-space:nowrap}.youtube-result:disabled{opacity:.5;cursor:wait}@media(max-width:520px){.youtube-import-head{align-items:flex-start;flex-direction:column}.youtube-search-row{align-items:stretch;flex-direction:column}.youtube-result{grid-template-columns:44px minmax(0,1fr) auto;gap:3px 7px}.youtube-result-thumb{width:44px;height:34px}}`;
youtubeStyle.textContent += `.input-methods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:12px}.input-methods>.youtube-import,.input-methods>.drop{min-width:0;height:100%;margin-top:0}.input-methods>.drop{padding:14px}.modal:has(.input-methods){width:min(940px,100%);max-height:92vh;overflow-y:auto}@media(max-width:680px){.input-methods{grid-template-columns:1fr}.input-methods>.drop{margin-top:0}}`;
youtubeStyle.textContent += `.mvsep-queue{margin-top:11px;padding:11px;border:1px solid #514047;border-radius:10px;background:#151518}.mvsep-queue[hidden]{display:none}.mvsep-queue-heading,.mvsep-transfer-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.mvsep-queue-heading strong{font-size:11px;color:#edf5d7}.mvsep-queue-heading span,.mvsep-transfer-heading span{font-size:10px;color:#aaaab0;font-variant-numeric:tabular-nums}.mvsep-transfer{margin-top:10px}.mvsep-transfer-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#e8e5e8}.mvsep-transfer-track{height:6px;margin-top:5px;overflow:hidden;border-radius:7px;background:#383239}.mvsep-transfer-track i{display:block;height:100%;width:0;border-radius:inherit;background:var(--lime);transition:width .25s ease}.mvsep-transfer-track.indeterminate i{width:35%;animation:youtubeProgressMove 1.2s ease-in-out infinite alternate}`;
document.head.append(youtubeStyle);
const youtubeMetadataStyle=document.createElement('style');
youtubeMetadataStyle.textContent=`.youtube-result{grid-template-rows:auto auto auto}.youtube-result-thumb{grid-row:1/4;align-self:center;height:54px}.youtube-result strong{grid-row:1}.youtube-result .youtube-result-artist{grid-row:2;color:#d2d2d6}.youtube-result .youtube-result-album{grid-row:3;color:#a7a7ad}.youtube-result>span{grid-row:1/4}`;
document.head.append(youtubeMetadataStyle);
const videoDownloadStyle = document.createElement('style');
videoDownloadStyle.textContent = `.youtube-video-download{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.85fr);gap:10px 16px;align-items:center;margin-top:12px;padding:14px;border:1px solid #35353a;border-radius:12px;background:#171719}.youtube-video-download h3{margin:4px 0;font-size:13px}.youtube-video-download p{margin:0;color:#9999a1;font-size:10px;line-height:1.5}.youtube-video-download-row{display:flex;gap:7px;min-width:0}.youtube-video-download-row input{flex:1;min-width:0;background:#111113;color:#eee;border:1px solid #3d3d42;border-radius:8px;padding:9px 10px;font-size:10px;outline:none}.youtube-video-download-row .btn{padding:8px 10px;font-size:10px;white-space:nowrap}.youtube-video-download-status{grid-column:1/-1;min-height:0;color:#aeb5a1;font-size:10px;line-height:1.45}.youtube-video-download-status a{margin-left:8px;color:var(--lime);text-decoration:underline}.youtube-video-progress{grid-column:1/-1;display:flex;align-items:center;gap:9px}.youtube-video-progress[hidden]{display:none}.youtube-video-progress>div{height:6px;flex:1;overflow:hidden;border-radius:7px;background:#303034}.youtube-video-progress i{display:block;width:0;height:100%;border-radius:inherit;background:var(--lime);transition:width .3s}.youtube-video-progress.indeterminate i{width:34%;animation:youtubeProgressMove 1.1s ease-in-out infinite alternate}.youtube-video-progress small{min-width:32px;text-align:right;color:#aaa;font-size:9px;font-variant-numeric:tabular-nums}@media(max-width:680px){.youtube-video-download{grid-template-columns:1fr}.youtube-video-download-row,.youtube-video-download-status,.youtube-video-progress{grid-column:1}}`;
document.head.append(videoDownloadStyle);

const artworkDialog = document.createElement('div');
artworkDialog.className = 'artwork-dialog'; artworkDialog.id = 'artworkDialog';
artworkDialog.innerHTML = `<section class="artwork-card" role="dialog" aria-modal="true" aria-labelledby="artworkTitle"><header class="artwork-head"><div><span class="processing-kicker">CAPAS EM ALTA RESOLUÇÃO</span><h2 id="artworkTitle">Buscar capa da música</h2></div><button class="lyrics-close" id="artworkClose" aria-label="Fechar">×</button></header><p>Busque pelo nome da música ou do álbum, ou escolha uma miniatura do YouTube.</p><div class="artwork-provider"><label for="artworkProvider">Provedor</label><select id="artworkProvider"><option value="itunes">Apple/iTunes</option><option value="youtube">Miniatura do YouTube</option></select></div><div class="artwork-search"><input id="artworkQuery" aria-label="Música, álbum ou link" placeholder="Nome da música ou álbum"><button class="btn" id="artworkSearch">Buscar</button></div><small id="artworkProviderHint" class="artwork-provider-hint"></small><div class="artwork-status" id="artworkStatus" role="status"></div><button type="button" class="btn secondary artwork-archive-search" id="artworkArchiveSearch">Não encontrou seu resultado? Pesquise no Cover Art</button><div class="artwork-results" id="artworkResults"></div></section>`;
document.body.append(artworkDialog);
const artworkSearchButton = document.createElement('button');
artworkSearchButton.type = 'button'; artworkSearchButton.className = 'btn secondary artwork-search-open'; artworkSearchButton.id = 'artworkSearchOpen'; artworkSearchButton.textContent = '⌕ Buscar capa na internet';
const artworkStyle = document.createElement('style');
artworkStyle.textContent = `.artwork-search-open{margin-top:10px;padding:8px 11px;font-size:10px}.artwork-dialog{position:fixed;inset:0;z-index:42;display:none;place-items:center;padding:18px;background:#08090bdc;backdrop-filter:blur(12px)}.artwork-dialog.show{display:grid}.artwork-card{width:min(720px,100%);max-height:88vh;overflow:auto;padding:22px;border-radius:18px;background:linear-gradient(145deg,#202124,#141416);border:1px solid #414148;box-shadow:0 24px 80px #000b}.artwork-head{display:flex;justify-content:space-between;align-items:center}.artwork-head h2{font:700 21px Manrope;margin:5px 0 0}.artwork-card>p{color:#aaa;font-size:11px;line-height:1.5}.artwork-search{display:flex;gap:8px}.artwork-search input{flex:1;min-width:0;background:#111113;color:#f6f5f3;border:1px solid #3d3d42;border-radius:9px;padding:10px 12px;outline:none}.artwork-search .btn{padding:8px 13px;font-size:11px}.artwork-status{min-height:20px;margin-top:9px;color:#aaa;font-size:10px}.artwork-results{display:grid;gap:9px;grid-template-columns:repeat(2,minmax(0,1fr));max-height:56vh;overflow:auto}.artwork-result{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;padding:9px;background:#171719;border:1px solid #333339;border-radius:11px;min-width:0}.artwork-result img{width:86px;height:86px;object-fit:cover;border-radius:7px;background:#252529}.artwork-meta{min-width:0}.artwork-meta strong,.artwork-meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.artwork-meta strong{font-size:11px}.artwork-meta small{color:#999;font-size:9px;margin-top:4px}.artwork-actions{display:flex;gap:5px;margin-top:9px}.artwork-actions button{padding:6px 7px;font-size:9px}.artwork-actions .btn.secondary{border-radius:8px}.artwork-loading{opacity:.6;pointer-events:none}@media(max-width:590px){.artwork-results{grid-template-columns:1fr}.artwork-card{padding:17px}.artwork-result{grid-template-columns:72px minmax(0,1fr)}.artwork-result img{width:72px;height:72px}.artwork-search{flex-direction:column}}`;
artworkStyle.textContent += `.artwork-actions{flex-wrap:wrap}.artwork-actions button{flex:1 1 auto}.artwork-provider{display:flex;gap:10px;align-items:center;margin:12px 0;color:#aaa;font-size:11px}.artwork-provider select{max-width:100%;padding:8px;border-radius:8px;border:1px solid #3d3d42;background:#171719;color:#f6f5f3}.artwork-archive-search{margin:0 0 12px;padding:9px 12px;font-size:11px;white-space:normal;text-align:left}.artwork-archive-search[hidden]{display:none}.artwork-provider-hint{display:block;margin-top:7px;color:#999;font-size:10px}`;
document.head.append(artworkStyle);
let artworkSearchSequence = 0, artworkSearchController = null, artworkActiveQuery = '', artworkSearchBusy = false;
let artworkDisplayedKey = '', artworkDisplayedResults = [];
const artworkArchiveCache = new Map();
const artworkRetryUntil = {archive:0,itunes:0,youtube:0};let artworkRetryTimer = null;
$('artworkProvider').value = localStorage.getItem('voxstage-artwork-provider-v2') === 'youtube' ? 'youtube' : 'itunes';
function artworkQueryKey(query) { return query.trim().toLocaleLowerCase().replace(/\s+/g,' '); }
function cachedArchiveArtwork(query) {
  const key=artworkQueryKey(query),entry=artworkArchiveCache.get(key);
  if(entry&&entry.expires>Date.now())return entry.results;
  artworkArchiveCache.delete(key);return null;
}
function artworkWaitSeconds(provider=$('artworkProvider').value) {
  return Math.max(0,Math.ceil(((artworkRetryUntil[provider]||0)-Date.now())/1000));
}
function refreshArtworkSearchButton() {
  clearTimeout(artworkRetryTimer);
  const seconds=artworkWaitSeconds(),archiveSeconds=artworkWaitSeconds('archive');
  $('artworkSearch').disabled=artworkSearchBusy||seconds>0;
  $('artworkSearch').textContent=seconds?(interfaceLanguage==='en-US'?`Wait ${seconds}s`:`Aguarde ${seconds}s`):(interfaceLanguage==='en-US'?'Search':'Buscar');
  $('artworkArchiveSearch').disabled=artworkSearchBusy||archiveSeconds>0;
  $('artworkArchiveSearch').textContent=archiveSeconds?`Cover Art indisponível. Aguarde ${archiveSeconds}s`:'Não encontrou seu resultado? Pesquise no Cover Art';
  if((seconds||archiveSeconds)&&artworkDialog.classList.contains('show'))artworkRetryTimer=setTimeout(refreshArtworkSearchButton,1000);
}
function closeArtworkDialog() {
  artworkDialog.classList.remove('show');
  artworkSearchSequence++;
  artworkSearchController?.abort(); artworkSearchController = null;
  artworkSearchBusy = false; refreshArtworkSearchButton();
}
function openArtworkDialog() {
  closeArtworkDialog();
  const title = $('titleInput').value.trim();
  $('artworkQuery').value = title;
  updateArtworkProvider();
  $('artworkResults').innerHTML = ''; $('artworkStatus').textContent = '';
  artworkDialog.classList.add('show');
  refreshArtworkSearchButton();
  if ($('artworkQuery').value) searchArtwork();
}
function renderArtworkResults(results,startIndex=0) {
    $('artworkResults').insertAdjacentHTML('beforeend', results.slice(startIndex).map((result,offset)=>{const index=startIndex+offset;return `<article class="artwork-result"><img src="${esc(result.previewUrl)}" alt="Capa do álbum ${esc(result.title)}"><div class="artwork-meta"><strong>${esc(result.title)}</strong><small>${esc(result.artist)}${result.track ? ` · faixa: ${esc(result.track)}`:''}</small><small>${esc([result.provider,result.releaseType==='Album'?'Álbum':result.releaseType].filter(Boolean).join(' · '))}</small><div class="artwork-actions"><button class="btn secondary" data-art-use="${index}" data-art-role="cover">Usar como capa</button><button class="btn secondary" data-art-use="${index}" data-art-role="background">Usar como fundo</button><button class="btn secondary" data-art-use="${index}" data-art-role="both">Usar como ambos</button></div></div></article>`;}).join(''));
    $('artworkResults').querySelectorAll('[data-art-use]').forEach(button=>button.onclick=async()=>{
      const draft = captureUploadDraft(), draftId = draft.id;
      draft.pendingAttachments = (draft.pendingAttachments || 0) + 1;
      artworkDialog.querySelectorAll('[data-art-use]').forEach(item => item.disabled = true);
      closeArtworkDialog();
      toast('Aplicando a imagem escolhida…');
      try {
        const result=results[Number(button.dataset.artUse)]; const {name}=await api('/api/covers/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:result.imageUrl})});
        const role=button.dataset.artRole; const roles=role==='both'?['cover','background']:[role];
        updateUploadDraft(draftId, draft => {
          draft.files = draft.files.filter(item => !roles.includes(item.role));
          roles.forEach(assignedRole => draft.files.push({name,role:assignedRole,label:`${result.title} — ${result.artist}`}));
        });
        $('artworkStatus').textContent=`Imagem adicionada como ${role==='both'?'capa e fundo':role==='cover'?'capa':'fundo'}. Salve a música para manter a alteração.`; toast(role==='both'?'Imagem aplicada como capa e fundo.':'Imagem de alta resolução adicionada.');
      } catch(error) { $('artworkStatus').textContent=error.message; toast(error.message); }
      finally { draft.pendingAttachments = Math.max(0, draft.pendingAttachments - 1); artworkDialog.querySelectorAll('[data-art-use]').forEach(item => item.disabled = false); }
    });
}
async function searchArtwork(source=$('artworkProvider').value) {
  const query=$('artworkQuery').value.trim(),provider=$('artworkProvider').value;
  if(!query){$('artworkStatus').textContent='Digite o nome da música ou álbum.';return;}
  if(!['itunes','youtube','archive'].includes(source)||(source==='archive'&&provider!=='itunes'))return;
  const displayKey=JSON.stringify([provider,artworkQueryKey(query)]),searchKey=JSON.stringify([source,query]);
  if(artworkSearchBusy&&artworkActiveQuery===searchKey)return;
  // Archive is an explicit second search, attached only to the current Apple query.
  if(source==='archive'&&artworkDisplayedKey!==displayKey){
    await searchArtwork(provider);
    if($('artworkQuery').value.trim()!==query||$('artworkProvider').value!==provider||!artworkDialog.classList.contains('show'))return;
    return searchArtwork('archive');
  }
  if(artworkWaitSeconds(source)){
    $('artworkStatus').textContent='O serviço de capas está temporariamente indisponível. Aguarde o tempo indicado para buscar novamente.';
    refreshArtworkSearchButton();return;
  }
  artworkSearchController?.abort();
  const controller=new AbortController(),sequence=++artworkSearchSequence;
  artworkSearchController=controller;artworkActiveQuery=searchKey;artworkSearchBusy=true;refreshArtworkSearchButton();
  const timeout=setTimeout(()=>controller.abort(new DOMException('Tempo de busca esgotado.','TimeoutError')),25000);
  const labels={itunes:'Apple/iTunes',archive:'Cover Art Archive',youtube:'YouTube'};
  if(source!=='archive'){
    artworkDisplayedKey=displayKey;artworkDisplayedResults=[];$('artworkResults').replaceChildren();
  }
  const results=artworkDisplayedResults;
  const append=(batch,label)=>{
    const seen=new Set(results.map(item=>JSON.stringify([item.provider,item.id||item.imageUrl,item.title]))),first=results.length;
    for(const item of batch){
      const result={...item,provider:item.provider||label},key=JSON.stringify([result.provider,result.id||result.imageUrl,result.title]);
      if(!seen.has(key)){seen.add(key);results.push(result);}
    }
    renderArtworkResults(results,first);
  };
  $('artworkStatus').textContent=source==='archive'?'Buscando no Cover Art Archive; isso pode demorar.'+(results.length?' Você já pode escolher uma capa da Apple.':''):'Buscando capas no '+labels[source]+'…';
  try {
    let batch=source==='archive'?cachedArchiveArtwork(query):null;
    const fromCache=batch!==null;
    if(batch===null){
      for(let attempt=0;attempt<2;attempt++){
        try{
          if(source==='youtube')batch=await searchYoutubeArtwork(query,controller.signal);
          else ({results:batch}=await api('/api/covers/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,provider:source}),signal:controller.signal}));
          break;
        }catch(error){
          if(controller.signal.aborted||attempt||error.status||!/fetch|network|load failed/i.test(error.message||''))throw error;
          await new Promise(resolve=>setTimeout(resolve,500));
          if(controller.signal.aborted)throw controller.signal.reason;
        }
      }
    }
    if(sequence!==artworkSearchSequence)return;
    if(!Array.isArray(batch))throw new Error('O serviço de capas retornou uma resposta inválida. Tente novamente em alguns instantes.');
    if(source==='archive'&&!fromCache){
      artworkArchiveCache.set(artworkQueryKey(query),{results:batch,expires:Date.now()+(batch.length?900000:60000)});
      // Keep the session cache bounded when looking up many different songs.
      if(artworkArchiveCache.size>50)artworkArchiveCache.delete(artworkArchiveCache.keys().next().value);
    }
    append(batch,labels[source]);
    if(source==='itunes'){
      const cached=cachedArchiveArtwork(query);
      if(cached)append(cached,labels.archive);
    }
    $('artworkStatus').textContent=results.length?results.length+' resultado(s). As imagens serão salvas localmente.':source==='archive'?'Não encontramos capas no Cover Art Archive para esta busca.':'Não encontramos capas no '+labels[source]+' para esta busca.';
  }catch(error){
    if(sequence!==artworkSearchSequence)return;
    const wait=Number(error.retryAfter)||([429,503].includes(error.status)?30:0);
    if(Number.isFinite(wait)&&wait>0)artworkRetryUntil[source]=Date.now()+wait*1000;
    if(error.name==='AbortError'&&!controller.signal.reason?.name?.includes('Timeout'))return;
    if(source==='itunes'){
      const cached=cachedArchiveArtwork(query);
      if(cached)append(cached,labels.archive);
    }
    const message=/fetch|network|load failed/i.test(error.message||'')||['TimeoutError','AbortError'].includes(error.name)
      ? 'A conexão com a busca de capas falhou. Tente novamente em alguns instantes.':error.message;
    $('artworkStatus').textContent=labels[source]+': '+message+(results.length?' As capas abaixo continuam disponíveis.':'');
  }finally{
    clearTimeout(timeout);
    if(sequence===artworkSearchSequence){artworkSearchBusy=false;artworkSearchController=null;refreshArtworkSearchButton();}
  }
}
function updateArtworkProvider() {
  const provider=$('artworkProvider').value;
  $('artworkQuery').maxLength=provider==='youtube'?2048:180;
  $('artworkQuery').placeholder=provider==='youtube'?'Busque a música ou cole um link do YouTube':'Nome da música ou álbum';
  $('artworkProviderHint').textContent=provider==='itunes'?'Capas do catálogo da Apple. O Cover Art Archive pode ser consultado pelo botão abaixo.':'Miniaturas de vídeos do YouTube comum. Esta busca não inclui o catálogo do YouTube Music.';
  $('artworkArchiveSearch').hidden=provider!=='itunes';
  refreshArtworkSearchButton();
}
$('artworkProvider').onchange=()=>{
  closeArtworkDialog();artworkDialog.classList.add('show');
  const provider=$('artworkProvider').value;localStorage.setItem('voxstage-artwork-provider-v2',provider);
  if(/^https?:/i.test($('artworkQuery').value))$('artworkQuery').value=$('titleInput').value.trim();
  $('artworkResults').replaceChildren();$('artworkStatus').textContent='';updateArtworkProvider();
  if($('artworkQuery').value)searchArtwork();
};
artworkSearchButton.onclick=openArtworkDialog; $('artworkSearch').onclick=()=>searchArtwork(); $('artworkArchiveSearch').onclick=()=>searchArtwork('archive'); $('artworkQuery').onkeydown=event=>{if(event.key==='Enter')searchArtwork()}; $('artworkClose').onclick=closeArtworkDialog; artworkDialog.onclick=event=>{if(event.target===artworkDialog)closeArtworkDialog()};
let mvsepConfigured = false;
let youtubeSearchResults = [];
let youtubeSearchContext = null;
let youtubeProcessing = false;
let youtubeSearchSequence = 0;
const youtubeMetadataCache = new Map();
function mvsepKeyLocationText(saved = true) {
  const english = interfaceLanguage === 'en-US';
  if (!saved) return english ? 'No key configured.' : 'Nenhuma chave configurada.';
  if (mobileNative) return english ? 'Key saved on this device.' : 'Chave salva neste aparelho.';
  return english ? 'Key saved on this computer.' : 'Chave salva neste computador.';
}
async function loadMvsepConfiguration(){
  try { mvsepConfigured = Boolean((await api('/api/mvsep/config')).configured); }
  catch { mvsepConfigured = false; }
  if (!mvsepConfigured) $('youtubeStatus').textContent = 'Configure uma chave MVSep em ⚙ Configurações antes de enviar uma música.';
  else $('youtubeStatus').textContent = 'Pesquise pelo título ou cole um link direto. O envio à MVSep só começa quando você escolher um resultado.';
  const keyStatus = $('mvsepKeyStatus');
  if (keyStatus) keyStatus.textContent = mvsepKeyLocationText(mvsepConfigured);
}
loadMvsepConfiguration();
let receiptAudioContext = null;
function prepareReceiptSound(){
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !receiptAudioContext) receiptAudioContext = new AudioContextClass();
    if (receiptAudioContext?.state === 'suspended') receiptAudioContext.resume().catch(()=>{});
  } catch {}
}
function playReceiptSound(){
  try {
    prepareReceiptSound();
    if (!receiptAudioContext) return;
    const start = receiptAudioContext.currentTime + .05;
    [784, 988, 1175].forEach((frequency,index)=>{
      const oscillator=receiptAudioContext.createOscillator(), gain=receiptAudioContext.createGain();
      oscillator.type='sine';oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.001,start+index*.16);gain.gain.exponentialRampToValueAtTime(.12,start+index*.16+.025);gain.gain.exponentialRampToValueAtTime(.001,start+index*.16+.14);
      oscillator.connect(gain);gain.connect(receiptAudioContext.destination);oscillator.start(start+index*.16);oscillator.stop(start+index*.16+.15);
    });
  } catch {}
}
function updateYoutubeProgress(job){
  const progress=$('youtubeProgress'), fill=$('youtubeProgressFill'), label=$('youtubeProgressLabel');
  if(!progress||!fill||!label)return;
  progress.hidden=false;
  const value=Math.max(0,Math.min(100,Number(job.progress)||0));
  fill.style.width=`${value}%`;
  progress.classList.toggle('indeterminate',Boolean(job.indeterminate));
  label.textContent=job.indeterminate?'':`${value}%`;
  progress.setAttribute('aria-label',job.indeterminate?'Processamento em andamento':`Progresso: ${value}%`);
}
function renderMvsepTransfers(job){
  const panel=$('mvsepQueue');if(!panel)return;
  panel.hidden=false;
  const stages={preparing:'Preparando áudio', 'downloading-source':'Baixando áudio do YouTube',sending:'Enviando à MVSep',waiting:'Na fila da MVSep',processing:'Processando na MVSep',distributing:'Separando a faixa',merging:'Unindo os stems',receiving:'Recebendo stems',reconnecting:'Reconectando ao MVSEP',done:'Arquivos recebidos',error:'Falha na separação'};
  $('mvsepQueueStage').textContent=stages[job.stage]||job.message||'MVSep';
  $('mvsepQueuePercent').textContent=job.indeterminate?'':`${Math.max(0,Math.min(100,Number(job.progress)||0))}%`;
  if ($('attachMvsepFiles')) $('attachMvsepFiles').hidden = job.stage !== 'done' || !(job.files || []).some(file => file.name);
  const formatSize=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} MB`:`${Math.round(bytes/1024)} KB`;
  $('mvsepFileTransfers').innerHTML=(job.files||[]).map(file=>{
    const received=Number(file.received)||0,total=Number(file.total)||0;
    const complete=file.state==='done'||job.stage==='done',fraction=complete?100:total?Math.min(100,Math.round(received*100/total)):0;
    const state=complete?'Concluído':file.state==='downloading'?(total?`${formatSize(received)} / ${formatSize(total)}`:`${formatSize(received)} recebidos`):file.state==='connecting'?'Conectando…':'Aguardando download';
    return `<div class="mvsep-transfer"><div class="mvsep-transfer-heading"><strong title="${esc(file.label||file.role||'Stem')}">${esc(file.label||file.role||'Stem')}</strong><span>${esc(state)}</span></div><div class="mvsep-transfer-track ${file.state==='downloading'&&!total?'indeterminate':''}"><i style="width:${fraction}%"></i></div></div>`;
  }).join('');
}
function showYoutubeError(error){let message=error.message||'Falha na integração.';try{message=JSON.parse(message).error||message}catch{}$('youtubeStatus').textContent=message;}
async function searchYoutube(){
  const query=$('youtubeQuery').value.trim();if(!query){$('youtubeStatus').textContent='Digite o nome da música ou cole um link do YouTube.';return;}const sequence=++youtubeSearchSequence;
  const includeYoutube=$('includeNormalYoutube').checked;$('youtubeSearch').disabled=true;$('youtubeResults').replaceChildren();$('youtubeProgress').hidden=true;$('youtubeStatus').textContent=interfaceLanguage==='en-US'?(includeYoutube?'Searching YouTube Music and YouTube…':'Searching YouTube Music…'):(includeYoutube?'Buscando no YouTube Music e no YouTube…':'Buscando opções no YouTube Music…');
  try{
    const result=await api('/api/youtube/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,includeYoutube})});
    if(sequence!==youtubeSearchSequence)return;
    youtubeSearchResults=result.results||[];
    youtubeSearchContext={query,includeYoutube};
    $('youtubeResults').replaceChildren();
    if(!youtubeSearchResults.length){$('youtubeStatus').textContent='Não encontrei vídeos para essa busca.';return;}
    $('youtubeStatus').textContent=interfaceLanguage==='en-US'
      ? mobileNative ? `${youtubeSearchResults.length} option(s). Choose one to download its audio to the device.` : `${youtubeSearchResults.length} option(s)${includeYoutube?' from YouTube Music and YouTube':' prioritizing YouTube Music tracks'}. Choose one to start the MVSep upload.`
      : mobileNative ? `${youtubeSearchResults.length} opção(ões). Escolha uma para baixar o áudio no aparelho.` : `${youtubeSearchResults.length} opção(ões)${includeYoutube?' do YouTube Music e do YouTube':' priorizando faixas do YouTube Music'}. Escolher inicia o envio para a MVSep.`;
    youtubeSearchResults.forEach((item,index)=>{
      item.metadataState = 'loaded';
      const button=document.createElement('button');button.type='button';button.className='youtube-result';
      const thumbnail=document.createElement('img');thumbnail.className='youtube-result-thumb';thumbnail.alt='';thumbnail.loading='lazy';thumbnail.src=item.thumbnail||item.thumbnailFallback||'';
      thumbnail.onerror=()=>{if(item.thumbnailFallback&&thumbnail.src!==item.thumbnailFallback){thumbnail.src=item.thumbnailFallback;return;}thumbnail.hidden=true;};
      const main=document.createElement('strong');main.textContent=item.title;
      const artistLine=document.createElement('small');artistLine.className='youtube-result-artist';artistLine.textContent=item.artist||'Buscando artista…';
      const albumLine=document.createElement('small');albumLine.className='youtube-result-album';albumLine.textContent=item.album||'Buscando álbum…';item.artistLabel=artistLine;item.albumLabel=albumLine;renderYoutubeMetadata(item);
      const action=document.createElement('span');action.textContent=mobileNative&&!mvsepConfigured?(interfaceLanguage==='en-US'?'Download →':'Baixar →'):(interfaceLanguage==='en-US'?'Separate →':'Separar →');
      button.append(thumbnail,main,artistLine,albumLine,action);button.onclick=()=>mobileNative&&!mvsepConfigured?downloadYoutubeAudio(item):startYoutubeSeparation(item);$('youtubeResults').append(button);renderYoutubeMetadata(item);
    });
    // Use the catalog response. Opening every video here can trigger bot checks.
  }catch(error){showYoutubeError(error)}finally{$('youtubeSearch').disabled=false;}
}
function renderYoutubeMetadata(item){
  const loading=item.metadataState==='pending';
  const failed=item.metadataState==='error';
  const artist=item.artist||(loading?'Buscando artista…':failed?'Não foi possível consultar o artista':'Artista não informado pelo YouTube');
  const album=[item.album||(loading?'Buscando álbum…':failed?'Não foi possível consultar o álbum':'Álbum não informado pelo YouTube'),item.duration?`${Math.floor(item.duration/60)} min`:null,item.releaseYear||null,item.source||null].filter(Boolean).join(' · ');
  if(item.artistLabel?.isConnected){item.artistLabel.textContent=artist;item.artistLabel.title=artist;}
  if(item.albumLabel?.isConnected){item.albumLabel.textContent=album;item.albumLabel.title=album;}
  if(failed){if(item.artistLabel)item.artistLabel.title=item.metadataError||artist;if(item.albumLabel)item.albumLabel.title=item.metadataError||album;}
}
async function enrichYoutubeMetadata(items,sequence){
  let cursor=0,blockedError='';
  const workers=Array.from({length:Math.min(1,items.length)},async()=>{
    while(cursor<items.length){
      if(sequence!==youtubeSearchSequence)return;
      const item=items[cursor++];
      if(item.artist&&item.album)continue;
      if(blockedError){item.metadataState='error';item.metadataError=blockedError;renderYoutubeMetadata(item);continue;}
      try{
        const details=await ensureYoutubeMetadata(item);
        if(sequence!==youtubeSearchSequence)return;
        renderYoutubeMetadata(item);
      }catch(error){
        if(sequence!==youtubeSearchSequence)return;
        if(/bloqueou temporariamente|limitou as solicitações|not a bot|too many requests|429/i.test(error.message||''))blockedError=error.message;
        renderYoutubeMetadata(item);
      }
    }
  });
  await Promise.all(workers);
}
function ensureYoutubeMetadata(item){
  if(item.artist&&item.album)return Promise.resolve(item);
  const cached=youtubeMetadataCache.get(item.url);
  if(cached&&Date.now()-cached.time<3600000){Object.assign(item,cached.details);item.metadataState='loaded';renderYoutubeMetadata(item);return Promise.resolve(item);}
  item.metadataState='pending';renderYoutubeMetadata(item);
  if(!item.metadataPromise)item.metadataPromise=api('/api/youtube/metadata',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.url,title:item.title})})
    .then(details=>{item.title=details.title||item.title;item.artist=details.artist||item.artist;item.album=details.album||item.album;item.albumArtist=details.albumArtist||'';item.duration=details.duration||item.duration;item.releaseYear=details.releaseYear||'';item.metadataState='loaded';item.metadataError='';
      youtubeMetadataCache.set(item.url,{time:Date.now(),details:Object.fromEntries(['title','artist','album','albumArtist','duration','releaseYear'].map(key=>[key,item[key]]))});
      if(youtubeMetadataCache.size>256)youtubeMetadataCache.delete(youtubeMetadataCache.keys().next().value);
      renderYoutubeMetadata(item);return item;})
    .catch(error=>{item.metadataPromise=null;item.metadataState='error';item.metadataError=error.message;renderYoutubeMetadata(item);throw error;});
  return item.metadataPromise;
}
function prefillYoutubeDraft(item, draftId) {
  const query = $('youtubeQuery').value.trim();
  updateUploadDraft(draftId, draft => {
    if (item.url) {draft.youtubeUrl = item.url;draft.youtubeSelection={url:item.url,title:item.title||'',artist:item.artist||'',album:item.album||'',source:item.source||''};}
    if (!draft.title.trim()) draft.title = item.title || (!/^https?:\/\//i.test(query) ? query : '');
    if (!draft.artist.trim()) draft.artist = item.artist || '';
  });
  if(item.url) applyAutomaticYoutubeArtwork(item,draftId);
}
function youtubeArtworkResult(item) {
  try {
    const url=new URL(item.url);
    if(!['https:','http:'].includes(url.protocol)||!['youtu.be','youtube.com','www.youtube.com','music.youtube.com','m.youtube.com'].includes(url.hostname))return null;
    const id=url.hostname==='youtu.be'?url.pathname.split('/')[1]:url.searchParams.get('v')||url.pathname.split('/')[2];
    if(!/^[A-Za-z0-9_-]{11}$/.test(id||''))return null;
    return {id:`youtube-${id}`,title:item.album||item.title||'Miniatura do YouTube',artist:item.artist||'',track:item.title||'',provider:'YouTube',
      previewUrl:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`,imageUrl:`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`};
  } catch { return null; }
}
async function searchYoutubeArtwork(query,signal) {
  const draft=captureUploadDraft(),selected=draft.youtubeSelection;
  if(selected?.source==='YouTube' && query===$('titleInput').value.trim()) {
    const result=youtubeArtworkResult(selected);if(result)return [result];
  }
  const fullQuery=query.trim();
  const normalize=text=>text.trim().replace(/\s+/g,' ').toLowerCase();
  const standardResults=youtubeSearchResults.filter(item=>item.source==='YouTube');
  const cached=youtubeSearchContext && normalize(fullQuery)===normalize(youtubeSearchContext.query) && standardResults.length?standardResults:null;
  const items=cached || (await api('/api/youtube/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:fullQuery,includeYoutube:true,youtubeOnly:true}),signal})).results || [];
  return items.filter(item=>item.source!=='YouTube Music'&&!/^https?:\/\/music\.youtube\.com(?:\/|$)/i.test(item.url||'')).map(youtubeArtworkResult).filter(Boolean);
}
async function applyAutomaticYoutubeArtwork(item,draftId) {
  const draft=uploadDrafts.get(draftId),art=youtubeArtworkResult(item);
  if(!draft||!art||draft.youtubeArtworkAttempted===item.url||draft.files.some(file=>file.role==='cover'))return;
  draft.youtubeArtworkAttempted=item.url;draft.pendingAttachments=(draft.pendingAttachments||0)+1;
  try {
    const {name}=await api('/api/covers/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:art.imageUrl})});
    updateUploadDraft(draftId,target=>{if(target.youtubeSelection?.url===item.url&&!target.files.some(file=>file.role==='cover'))target.files.push({name,role:'cover',label:`${art.title} — YouTube`});});
  } catch { /* Artwork is optional; never interrupt importing the song. */ }
  finally {draft.pendingAttachments=Math.max(0,draft.pendingAttachments-1);}
}
function attachReceivedMvsepFiles(job, draftId, replaceOriginal = false) {
  const files = (job?.files || []).filter(file => typeof file.name === 'string' && file.name);
  if (!files.length) throw new Error('Nenhum arquivo recebido está disponível para acoplar.');
  if (!uploadDrafts.has(draftId)) throw new Error('O rascunho deste envio foi descartado.');
  updateUploadDraft(draftId, draft => {
    if (replaceOriginal) draft.files = draft.files.filter(file => !['source', 'inst', 'lead', 'back'].includes(file.role));
    if (!draft.title.trim()) draft.title = job.title || '';
    if (!draft.artist.trim()) draft.artist = job.artist || '';
    const existing = new Set(draft.files.map(file => file.name || file.file?.name));
    for (const output of files) if (!existing.has(output.name)) {
      draft.files.push({name: output.name, role: output.role || 'ignore', label: output.label});
      existing.add(output.name);
    }
  });
  persistUploadDrafts();
}
let uploadActivityJob = null;
try { uploadActivityJob = JSON.parse(localStorage.getItem('voxstage-upload-activity') || 'null'); } catch {}
const uploadActivityButton = document.createElement('button'); uploadActivityButton.type='button'; uploadActivityButton.className='btn secondary upload-activity-button'; uploadActivityButton.hidden=true;
const uploadActivityDialog = document.createElement('div'); uploadActivityDialog.className='upload-activity-dialog'; uploadActivityDialog.hidden=true;
uploadActivityDialog.innerHTML='<section role="dialog" aria-modal="true" aria-labelledby="uploadActivityTitle"><header><h2 id="uploadActivityTitle">Envios em progresso</h2><button type="button" class="lyrics-close" aria-label="Fechar">×</button></header><strong class="upload-activity-name"></strong><progress max="100" value="0"></progress><p aria-live="polite"></p><footer><button type="button" class="btn secondary upload-activity-close">Fechar</button><button type="button" class="btn upload-activity-return">Voltar ao envio</button></footer></section>';
uploadActivityDialog.querySelector('footer').insertAdjacentHTML('beforeend', '<button type="button" class="btn upload-activity-attach" hidden>Acoplar arquivos</button>');
$('mvsepQueue').insertAdjacentHTML('beforeend', '<button type="button" class="btn secondary" id="attachMvsepFiles" hidden>Acoplar arquivos</button>');
const uploadActivityStyle=document.createElement('style'); uploadActivityStyle.textContent='.upload-activity-button{white-space:nowrap}.upload-activity-dialog[hidden],.upload-activity-button[hidden]{display:none!important}.upload-activity-dialog{position:fixed;inset:0;z-index:22000;display:grid;place-items:center;padding:18px;background:#08090bdf;backdrop-filter:blur(10px)}.upload-activity-dialog section{box-sizing:border-box;width:min(520px,100%);padding:20px;border:1px solid #414148;border-radius:16px;background:#1b1c21}.upload-activity-dialog header,.upload-activity-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.upload-activity-dialog h2{margin:0;font:700 18px Manrope}.upload-activity-name{display:block;margin-top:20px}.upload-activity-dialog progress{width:100%;height:8px;margin-top:14px;accent-color:var(--lime)}.upload-activity-dialog p{min-height:1.5em;color:#aaa;font-size:12px;line-height:1.5}.upload-activity-dialog footer{justify-content:flex-end;margin-top:16px}'; document.head.append(uploadActivityStyle);
uploadActivityStyle.textContent += '.upload-activity-dialog footer{flex-wrap:wrap}.upload-activity-attach[hidden],#attachMvsepFiles[hidden]{display:none!important}#attachMvsepFiles{margin-top:10px}';
document.querySelector('.mobile-library-actions,.hero-actions')?.append(uploadActivityButton); document.body.append(uploadActivityDialog);
function updateUploadActivity(job, finished=false, error='', notify=true) {
  if (!job) return;
  uploadActivityJob={...uploadActivityJob,...job,finished,error:error||''};
  try { localStorage.setItem('voxstage-upload-activity',JSON.stringify(uploadActivityJob)); } catch {}
  uploadActivityButton.hidden=false;
  const title=uploadActivityJob.title||'Música';
  const message=error||job.message||(finished?'Envio concluído. Volte ao formulário para revisar e salvar.':'Enviando para a MVSep…');
  const progress=finished&&!error?100:Math.max(0,Math.min(100,Number(job.progress)||0));
  uploadActivityButton.textContent=error?'Envio falhou · Ver detalhes':finished?'Envio concluído · Voltar ao formulário':`Envios em progresso · ${progress}%`;
  uploadActivityDialog.querySelector('.upload-activity-name').textContent=title;
  uploadActivityDialog.querySelector('progress').value=progress;
  uploadActivityDialog.querySelector('p').textContent=message;
  const canAttach = uploadActivityJob.stage === 'done' && (uploadActivityJob.files || []).some(file => file.name);
  uploadActivityDialog.querySelector('.upload-activity-attach').hidden = !canAttach;
  $('attachMvsepFiles').hidden = !canAttach;
  try { if (notify && mobileNative) window.VoxStageMedia?.updateJobNotification(title,message,finished); } catch {}
}
if(uploadActivityJob) updateUploadActivity(uploadActivityJob,uploadActivityJob.finished,uploadActivityJob.error,false);
const closeUploadActivity=()=>{uploadActivityDialog.hidden=true;};
uploadActivityButton.onclick=()=>{uploadActivityDialog.hidden=false;};
uploadActivityDialog.querySelectorAll('.lyrics-close,.upload-activity-close').forEach(button=>button.onclick=closeUploadActivity);
uploadActivityDialog.onclick=event=>{if(event.target===uploadActivityDialog)closeUploadActivity();};
uploadActivityDialog.querySelector('.upload-activity-return').onclick=()=>{activateUploadDraft(uploadActivityJob?.draftId||'new');showModal();closeUploadActivity();};
function recoverReceivedMvsepFiles() {
  try {
    const draftId = uploadActivityJob?.draftId || 'new';
    attachReceivedMvsepFiles(uploadActivityJob, draftId);
    activateUploadDraft(draftId); showModal(); closeUploadActivity();
    $('youtubeStatus').textContent = 'Arquivos acoplados. Confira os papéis e salve a música.';
    toast('Arquivos acoplados ao formulário.');
  } catch (error) {
    uploadActivityDialog.querySelector('p').textContent = error.message;
    $('youtubeStatus').textContent = error.message; toast(error.message);
  }
}
$('attachMvsepFiles').onclick = recoverReceivedMvsepFiles;
uploadActivityDialog.querySelector('.upload-activity-attach').onclick = recoverReceivedMvsepFiles;
async function startYoutubeSeparation(item){
  if(youtubeProcessing)return;
  if(!mvsepConfigured){$('youtubeStatus').textContent='Configure sua chave da API MVSep em ⚙ Configurações primeiro.';return;}
  prepareReceiptSound();
  const draftId = captureUploadDraft().id;
  prefillYoutubeDraft(item, draftId);
  youtubeProcessing=true;$('youtubeSearch').disabled=true;document.querySelectorAll('.youtube-result').forEach(button=>button.disabled=true);$('youtubeProgress').hidden=false;updateYoutubeProgress({progress:1,indeterminate:true});$('youtubeStatus').textContent='Iniciando…';
  try{
    prefillYoutubeDraft(item, draftId);
    const selectedModel=String(processingSettings.mvsepModelId||'12');
    const started=await api('/api/youtube/separations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.url,title:item.title||'',artist:item.artist||'',modelId:selectedModel,modelOptions:processingSettings.mvsepOptionsByModel?.[selectedModel]||{}})});
    const pending={...started,draftId,title:item.title||'',artist:item.artist||''};
    try{localStorage.setItem('voxstage-active-mvsep-job',JSON.stringify(pending));}catch{}
    updateUploadActivity(pending);
    await followYoutubeSeparation(pending,item);
  }catch(error){if(uploadActivityJob&&!uploadActivityJob.finished)updateUploadActivity(uploadActivityJob,true,error.message);showYoutubeError(error)}finally{youtubeProcessing=false;$('youtubeSearch').disabled=false;document.querySelectorAll('.youtube-result').forEach(button=>button.disabled=false);}
}
async function followYoutubeSeparation(started,item){
    renderMvsepTransfers(started);updateYoutubeProgress(started);$('youtubeStatus').textContent=started.message||'Preparando áudio…';
    let job;
    do{
      await new Promise(resolve=>setTimeout(resolve,mobileNative?1000:5000));
      job=await api(`/api/youtube/separations/${encodeURIComponent(started.id)}`);
      $('youtubeStatus').textContent=job.message||'Processando…';
      updateUploadActivity({...started,...job,draftId:started.draftId});
      updateYoutubeProgress(job);
      renderMvsepTransfers(job);
    }while(!['done','error','missing'].includes(job.stage));
    if(job.stage!=='done'){
      updateUploadActivity({...started,...job,draftId:started.draftId},true,job.message||'A separação falhou. Volte ao envio para tentar novamente.');
      try{localStorage.removeItem('voxstage-active-mvsep-job');}catch{}
      throw new Error(job.message||'Não foi possível concluir a separação.');
    }
    attachReceivedMvsepFiles({...job,title:job.title||item.title,artist:job.artist||item.artist}, started.draftId || 'new', Boolean(started.songId));
    if (started.songId) {
      const library = await api('/api/library');
      const song = library.find(song => song.id === started.songId);
      const stems = Object.fromEntries((job.files || []).filter(file => ['inst', 'lead', 'back'].includes(file.role)).map(file => [file.role, file.name]));
      if (!stems.inst || !stems.lead) throw new Error('O modelo não retornou instrumental e vocal. Os arquivos estão no formulário; confira os papéis e salve.');
      if (!song || song.source !== started.source) throw new Error('A música de origem foi removida ou alterada. Os stems recebidos estão no formulário.');
      const updated = {...song, ...stems, separationEngine:'mvsep'};
      if (!stems.back) delete updated.back;
      delete updated.separationStatus;
      await api('/api/library', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updated)});
      // Keep edits made in the form while the separation was running.
      const draft = uploadDrafts.get(started.draftId);
      if (draft) draft.editingId = updated.id;
      if (activeUploadDraftId === started.draftId) { editingSong = updated; updateSaveSongLabel(); }
      persistUploadDrafts();
      $('youtubeStatus').textContent = 'Instrumental e vocais salvos na biblioteca. Você pode continuar editando a música.';
      updateUploadActivity({...started,...job,draftId:started.draftId,message:'Separação concluída e música salva na biblioteca.'},true);
      await loadSongs();
      toast('Música separada com MVSEP e salva na biblioteca.'); playReceiptSound();
      try { localStorage.removeItem('voxstage-active-mvsep-job'); } catch {}
      return;
    }
    drawAssignments();$('youtubeStatus').textContent='Arquivos recebidos! Confira os papéis e salve a música.';updateUploadActivity({...started,...job,draftId:started.draftId,message:'Arquivos recebidos. Volte ao formulário para revisar e salvar a música.'},true);toast('Arquivos recebidos da MVSep. Revise os stems e salve a música.');playReceiptSound();
    try{localStorage.removeItem('voxstage-active-mvsep-job');}catch{}
}
try{
  const pending=JSON.parse(localStorage.getItem('voxstage-active-mvsep-job')||'null');
  if(pending?.id){
    updateUploadActivity(pending);
    youtubeProcessing=true;$('youtubeSearch').disabled=true;
    followYoutubeSeparation(pending,pending).catch(error=>{updateUploadActivity(pending,true,error.message);showYoutubeError(error);}).finally(()=>{youtubeProcessing=false;$('youtubeSearch').disabled=false;});
  }
}catch{}
$('youtubeSearch').onclick=searchYoutube;$('youtubeQuery').onkeydown=event=>{if(event.key==='Enter')searchYoutube();};
async function downloadYoutubeAudio(item){
  if(youtubeProcessing)return;
  const draftId = captureUploadDraft().id;
  prefillYoutubeDraft(item, draftId);
  youtubeProcessing=true;$('youtubeSearch').disabled=true;document.querySelectorAll('.youtube-result').forEach(button=>button.disabled=true);
  $('youtubeProgress').hidden=false;updateYoutubeProgress({progress:1,indeterminate:true});$('youtubeStatus').textContent=interfaceLanguage==='en-US'?'Downloading audio on this device…':'Baixando áudio no aparelho…';
  try{
    prefillYoutubeDraft(item, draftId);
    const result=await api('/api/youtube/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.url})});
    updateUploadDraft(draftId, draft => {
      const hasAudio=draft.files.some(file=>['source','inst','lead','back'].includes(file.role));
      draft.files.push({name:result.filename,role:hasAudio?'ignore':'source',label:item.title||result.filename});
      if(!draft.title)draft.title=item.title||'';
      if(!draft.artist)draft.artist=item.artist||'';
    });
    drawAssignments();$('youtubeProgress').hidden=true;
    $('youtubeStatus').textContent=interfaceLanguage==='en-US'?'Audio downloaded. Confirm its role below, then save the song.':'Áudio baixado. Confirme o papel dele abaixo e salve a música.';
    toast(interfaceLanguage==='en-US'?'Audio added to the song form.':'Áudio adicionado ao formulário da música.');
  }catch(error){showYoutubeError(error);$('youtubeProgress').hidden=true;}
  finally{youtubeProcessing=false;$('youtubeSearch').disabled=false;document.querySelectorAll('.youtube-result').forEach(button=>button.disabled=false);}
}
let videoDownloadBusy = false;
function updateVideoDownloadProgress(job) {
  const progress = $('youtubeVideoProgress'), fill = $('youtubeVideoProgressFill'), label = $('youtubeVideoProgressLabel');
  progress.hidden = false;
  const value = Math.max(0, Math.min(100, Number(job.progress) || 0));
  fill.style.width = `${value}%`;
  progress.classList.toggle('indeterminate', Boolean(job.indeterminate));
  label.textContent = job.indeterminate ? '' : `${value}%`;
  $('youtubeVideoDownloadStatus').textContent = job.message || 'Baixando o vídeo…';
}
async function downloadYoutubeVideo() {
  if (videoDownloadBusy) return;
  const draftId = captureUploadDraft().id;
  const url = $('youtubeVideoUrl').value.trim();
  if (!url) { $('youtubeVideoDownloadStatus').textContent = 'Cole um link direto de vídeo do YouTube.'; return; }
  videoDownloadBusy = true;
  const button = $('youtubeVideoDownloadButton'); button.disabled = true;
  $('youtubeVideoDownloadStatus').textContent = 'Iniciando download…';
  updateVideoDownloadProgress({progress: 1, indeterminate: true});
  try {
    let job;
    if (mobileNative) {
      $('youtubeVideoDownloadStatus').textContent = 'Baixando o vídeo no aparelho…';
      try { job = await mobileInvoke('mobile_youtube_video_download', {url}); }
      catch (error) { throw new Error(String(error?.message || error)); }
      updateVideoDownloadProgress(job);
    } else {
    const started = await api('/api/youtube/video-downloads', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url})});
    do {
      await new Promise(resolve => setTimeout(resolve, 900));
      job = await api(`/api/youtube/video-downloads/${encodeURIComponent(started.id)}`);
      updateVideoDownloadProgress(job);
    } while (!['done', 'error', 'missing'].includes(job.stage));
    }
    if (job.stage !== 'done') throw new Error(job.message || 'Não foi possível concluir o download.');
    const filename = `${job.title || 'Vídeo do YouTube'}.${job.extension || 'mp4'}`;
    updateUploadDraft(draftId, draft => {
      if (!draft.files.some(item => item.name === job.name)) draft.files.push({name: job.name, role: 'video', label: filename});
    });
    drawAssignments();
    const audioStatus = job.hasAudio ? 'com áudio' : 'sem áudio · pronto para fundo mudo';
    const status = $('youtubeVideoDownloadStatus'); status.textContent = `${job.title || 'Vídeo'} salvo em music · ${audioStatus}.`;
    const link = document.createElement('a'); link.href = mediaUrl(job.name); link.download = filename; link.textContent = 'Baixar uma cópia no computador';
    if (!mobileNative) status.append(link);
    $('youtubeVideoUrl').value = '';
    toast('Vídeo baixado para a pasta music.');
  } catch (error) {
    console.error(error);
    let message = error.message || 'Falha ao baixar o vídeo.';
    try { message = JSON.parse(message).error || message; } catch {}
    $('youtubeVideoDownloadStatus').textContent = message;
  } finally {
    videoDownloadBusy = false; button.disabled = false;
  }
}
$('youtubeVideoDownloadButton').onclick = downloadYoutubeVideo;
$('youtubeVideoUrl').onkeydown = event => { if (event.key === 'Enter') downloadYoutubeVideo(); };
picker.addEventListener('change', () => {
  const known = new Set(chosenFiles.filter(item => item.file).map(item => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  for (const file of Array.from(picker.files)) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!known.has(key)) chosenFiles.push({file, role: 'ignore'});
    known.add(key);
  }
  picker.value = '';
  if (!$('titleInput').value && chosenFiles.some(item => item.file?.type.startsWith('audio/'))) {
    $('titleInput').value = chosenFiles.find(item => item.file?.type.startsWith('audio/')).file.name.replace(/\.[^.]+$/, '');
  }
  drawAssignments();
});

function drawAssignments() {
  $('assignments').innerHTML = chosenFiles.length ? chosenFiles.map((item, index) => {
const isVideo = item.role === 'video' || item.file?.type.startsWith('video/');
    const isImage = !isVideo && (['cover', 'background'].includes(item.role) || item.file?.type.startsWith('image/'));
    const filename = item.label || item.file?.name || item.name;
    const options = isImage
      ? [['ignore', 'Não usar'], ['cover', 'Capa do álbum'], ['background', 'Imagem de fundo']]
      : isVideo ? [['ignore', 'Não usar'], ['video', 'Vídeo de fundo (mudo)']]
      : [['ignore', 'Não usar'], ['inst', 'Instrumental'], ['lead', 'Vocais principais'], ['back', 'Backing vocals'], ['source', 'Música completa · não separada']];
    return `<div class="assignment"><span class="file-kind">${isVideo ? '▶' : isImage ? '▧' : '♫'}</span><span class="file-name" title="${esc(filename)}" ${mobileNative ? `role="button" tabindex="0" data-file-name="${index}"` : ''}>${esc(filename)}</span><select data-role="${index}">${options.map(([value, label]) => `<option value="${value}" ${item.role === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="assignment-remove" data-remove-file="${index}" aria-label="Remover ${esc(filename)} do formulário" title="Remover do formulário">×</button></div>`;
  }).join('') : '<div class="assignment-empty">Depois da seleção, marque o papel de cada arquivo.</div>';
  document.querySelectorAll('[data-role]').forEach(select => select.onchange = () => { chosenFiles[Number(select.dataset.role)].role = select.value; updateSaveSongLabel(); captureUploadDraft(); });
  $('assignments').querySelectorAll('[data-remove-file]').forEach(button => button.onclick = () => {
    chosenFiles.splice(Number(button.dataset.removeFile), 1);
    drawAssignments();
  });
  document.querySelectorAll('[data-file-name]').forEach(node => {
    node.onclick = () => showFullFilename(chosenFiles[Number(node.dataset.fileName)], node);
    node.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.click(); } };
  });
  updateSaveSongLabel();
  captureUploadDraft();
}

function updateSaveSongLabel() {
  const hasCompleteSong = chosenFiles.some(item => item.role === 'source');
  const hasStem = chosenFiles.some(item => ['inst', 'lead', 'back'].includes(item.role));
  $('saveSong').textContent = hasCompleteSong && !hasStem && !editingSong ? 'Separar música' : editingSong ? 'Salvar alterações' : 'Salvar música';
  $('saveSong').title = hasCompleteSong && !hasStem ? 'Guardar a música completa localmente para separação' : '';
}

function editSong(id) {
  const song = songs.find(song => song.id === id);
  if (!song) return;
  const draftId = `edit:${id}`;
  if (uploadDrafts.has(draftId)) { activateUploadDraft(draftId); showModal(); return; }
  captureUploadDraft(); activeUploadDraftId = draftId; editingSong = song;
  draftLyrics = null;
  $('draftLyricsStatus').textContent = editingSong.syncedLyrics ? `Letra salva: ${editingSong.lyricTrack || editingSong.title}` : 'Opcional · você pode buscar pela internet';
  chosenFiles = ['source', 'inst', 'lead', 'back', 'cover', 'background', 'backgroundVideo']
    .flatMap(role => editingSong[role] && !(role === 'source' && editingSong.inst && editingSong.lead) ? [{name: editingSong[role], role: role === 'backgroundVideo' ? 'video' : role, file: null}] : []);
  $('titleInput').value = editingSong.title || '';
  $('artistInput').value = editingSong.artist || '';
  document.querySelector('.modal h2').textContent = 'Editar música';
  $('saveSong').textContent = 'Salvar alterações';
  drawAssignments(); showModal();
}

async function toggleFavorite(id) {
  const song = songs.find(item => item.id === id); if (!song) return;
  const updated = {...song, favorite: !song.favorite};
  try {
    await api('/api/library', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(updated)});
    Object.assign(song, updated); render();
  } catch (error) { console.error(error); toast('Não consegui atualizar os favoritos.'); }
}

saveSong = async function () {
  if (youtubeProcessing || videoDownloadBusy) { toast('Aguarde a chegada dos arquivos antes de salvar a música.'); return; }
  const savedDraft = captureUploadDraft(), savedDraftId = savedDraft.id;
  if (savedDraft.saving) return;
  if (savedDraft.pendingAttachments) { toast('Aguarde a chegada dos arquivos antes de salvar a música.'); return; }
  const savedFingerprint = uploadDraftFingerprint(savedDraft);
  const one = role => chosenFiles.filter(item => item.role === role);
  const instrumental = one('inst'), lead = one('lead'), backing = one('back'), source = one('source'), covers = one('cover'), backgrounds = one('background'), videos = one('video');
  const hasStems = instrumental.length + lead.length + backing.length > 0;
  const invalidAttachments = backing.length > 1 || covers.length > 1 || backgrounds.length > 1 || videos.length > 1;
  if (invalidAttachments || source.length > 1 || (source.length && hasStems) || (!source.length && (instrumental.length !== 1 || lead.length !== 1))) {
    toast(source.length ? 'Use a música completa sozinha ou envie os stems separados.' : 'Marque um instrumental e um vocal principal. Backing, imagens e vídeo são opcionais.'); return;
  }
  const title = $('titleInput').value.trim() || ((lead[0] || source[0]).file?.name || (lead[0] || source[0]).name || 'Nova música').replace(/\.[^.]+$/, '');
  const isEditing = Boolean(editingSong);
  const song = {...(editingSong || {}), id: editingSong?.id || crypto.randomUUID(), title, artist: $('artistInput').value.trim(), created: editingSong?.created || Date.now(), favorite: Boolean(editingSong?.favorite)};
  if (draftLyrics) Object.assign(song, draftLyrics);
  const assigned = [['source', source], ['inst', instrumental], ['lead', lead], ['back', backing], ['cover', covers], ['background', backgrounds], ['backgroundVideo', videos]];
  if (source.length) song.separationStatus = 'pending';
  else delete song.separationStatus;
  savedDraft.saving = true;
  try {
    for (const [role, items] of assigned) {
      if (!items.length) continue;
      const item = items[0];
      if (item.file) {
        const name = `${crypto.randomUUID()}.${extension(item.file.name)}`;
        await api(`/api/files/${name}`, {method: 'PUT', headers: {'Content-Type': item.file.type || 'application/octet-stream'}, body: item.file});
        song[role] = name;
      } else if (item.name) song[role] = item.name;
    }
    for (const [role, items] of assigned) {
      const keepOriginalSource = role === 'source' && isEditing && editingSong?.inst && editingSong?.lead;
      if (!items.length && !keepOriginalSource) delete song[role];
    }
    await api('/api/library', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(song)});
    song.coverUrl = mediaUrl(song.cover);
    if (isEditing) songs = songs.map(item => item.id === song.id ? song : item); else songs.push(song);
    render();
    if (activeUploadDraftId === savedDraftId) captureUploadDraft();
    const unchanged = uploadDraftFingerprint(savedDraft) === savedFingerprint;
    if (unchanged) {
      uploadDrafts.delete(savedDraftId);
      if (activeUploadDraftId === savedDraftId) { hideModal(); resetSongForm(); }
    } else {
      // Edits made while the request was running remain available for the next save.
      savedDraft.editingId = song.id;
      if (activeUploadDraftId === savedDraftId) { editingSong = song; updateSaveSongLabel(); }
    }
    persistUploadDrafts();
    toast(source.length ? (mobileNative ? 'Faixa completa salva no celular e pronta para tocar.' : 'Faixa completa salva e pronta para tocar ou separar.') : 'Música e arquivos salvos na pasta music.');
  } catch (error) {
    console.error(error); toast('Falha ao salvar no disco. Confira a janela do servidor.');
  } finally { savedDraft.saving = false; }
};

deleteSong = async function (id) {
  const song = songs.find(item => item.id === id);
  if (!song || !confirm(`Apagar “${song.title}” e seus arquivos da pasta music?`)) return;
  try {
    await api(`/api/library/${id}`, {method: 'DELETE'});
    songs = songs.filter(item => item.id !== id);
    if (current?.id === id) stopSong();
    render(); toast('Música e arquivos apagados.');
  } catch (error) { console.error(error); toast('Não consegui apagar a música.'); }
};

async function ensureAudioEngine() {
  audioContext ||= new AudioContext({latencyHint: 'interactive'});
  if (audioContext.state !== 'running') await audioContext.resume();
  if (playbackSpeed !== 1 || playbackSemitones !== 0) await ensureTempoEngine();
}
async function ensureTempoEngine() {
  if (tempoWorkletReady) return;
  if (!audioContext?.audioWorklet) throw new Error('Este aparelho não disponibilizou processamento de tom em tempo real.');
  tempoWorkletPromise ||= audioContext.audioWorklet.addModule('audio/vendor/soundtouch-processor.js?v=2.1.1').then(() => { tempoWorkletReady = true; });
  try { await tempoWorkletPromise; } catch (error) { tempoWorkletPromise = null; throw error; }
}
async function setPlaybackTransform(speed = playbackSpeed, semitones = playbackSemitones) {
  const sequence = ++playbackTransformSequence;
  const nextSpeed = Number(speed), nextPitch = Number(semitones);
  playbackSpeed = Number.isFinite(nextSpeed) ? Math.max(.75, Math.min(1.25, nextSpeed)) : 1;
  playbackSemitones = Number.isFinite(nextPitch) ? Math.max(-4, Math.min(4, Math.round(nextPitch))) : 0;
  try {
    if (playbackSpeed !== 1 || playbackSemitones !== 0) { await ensureAudioEngine(); }
    if (sequence !== playbackTransformSequence) return;
    if (playing && current?.buffers?.Inst) startAudioSources(playbackPosition());
  } catch (error) {
    if (sequence !== playbackTransformSequence) return;
    playbackSpeed = 1; playbackSemitones = 0;
    if (playing && current?.buffers?.Inst) startAudioSources(playbackPosition());
    toast(error.message || 'Não consegui ativar velocidade e tom neste aparelho.');
  }
  updatePlaybackTransformControls();
}

// Vector controls share the same geometry in the stage and the mini player.
function playbackControlSvg(kind, seconds = 10) {
  const shapes = {
    play: '<path fill="currentColor" d="M8 5v14l11-7Z"/>',
    pause: '<rect fill="currentColor" x="6" y="5" width="4" height="14" rx="1"/><rect fill="currentColor" x="14" y="5" width="4" height="14" rx="1"/>',
    previous: '<path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 5v14"/><path fill="currentColor" d="M19 5 8 12l11 7Z"/>',
    next: '<path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M19 5v14"/><path fill="currentColor" d="m5 5 11 7-11 7Z"/>',
    mix: '<path d="M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 7h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    lyrics: '<path d="M5 3h10l4 4v14H5ZM15 3v5h4M8 11h8M8 15h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
    sync: '<path d="m14 5 5 5M4 20l4-1 12-12-4-4L4 15ZM14 20h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
    exit: '<path d="M10 4H4v16h6M12 12h9m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
    portrait: '<rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    tv: '<rect x="2" y="4" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 22h8M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  };
  const rewind = '<path d="M4.4 8a8 8 0 1 1-.4 8M4 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  const shape = kind === 'back' || kind === 'forward'
    ? `<g${kind === 'forward' ? ' transform="translate(24 0) scale(-1 1)"' : ''}>${rewind}</g><text x="12" y="15" fill="currentColor" text-anchor="middle" font-size="8" font-weight="700" font-family="sans-serif">${Math.round(Number(seconds) || 10)}</text>`
    : shapes[kind] || shapes.play;
  return `<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shape}</svg>`;
}

function setPlayBusy(busy) {
  for (const button of [$('playBtn'), $('dispPlay')]) {
    if (!button) continue;
    button.disabled = busy;
    if (busy) {
      button.innerHTML = '<span class="play-spinner" role="status" aria-label="Processando áudio"></span>';
      button.title = 'Processando áudio';
    } else {
      button.innerHTML = playbackControlSvg(playing ? 'pause' : 'play');
      button.title = interfaceLanguage === 'en-US' ? (playing ? 'Pause' : 'Play') : (playing ? 'Pausar' : 'Reproduzir');
      button.setAttribute('aria-label', button.title);
    }
  }
}

async function decodeStem(filename) {
  const response = await fetch(mediaUrl(filename));
  if (!response.ok) throw new Error(`Não consegui carregar o stem (${response.status}).`);
  return audioContext.decodeAudioData(await response.arrayBuffer());
}

function stopActiveSources() {
  playbackToken++;
  clearTimeout(current?.engine?.finishTimer);
  for (const source of Object.values(current?.engine?.sources || {})) {
    try { source.onended = null; source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  for (const node of Object.values(current?.engine?.gains || {})) {
    try { node.disconnect(); } catch {}
  }
  try { current?.engine?.processor?.port.postMessage({type:'voxstage-stop'}); current?.engine?.processor?.disconnect(); current?.engine?.processor?.port.close(); } catch {}
  try { current?.engine?.output?.disconnect(); } catch {}
  stemGains = {};
}

function playbackPosition() {
  if (!current?.buffers?.Inst) return playbackBase;
  if (!playing || !audioContext) return playbackBase;
  const engine = current.engine;
  return Math.min(current.buffers.Inst.duration, playbackBase + Math.max(0, audioContext.currentTime - playbackStartContextTime - (engine?.latencySeconds || 0)) * (engine?.speed || 1));
}

function stopPlaybackUiLoop() {
  if (playbackFrame) cancelAnimationFrame(playbackFrame);
  playbackFrame = 0;
  if (playbackWatchdog) clearInterval(playbackWatchdog);
  playbackWatchdog = 0;
}

function keepPlaybackUiAlive() {
  if (playbackWatchdog) return;
  playbackWatchdog = setInterval(() => {
    if (playing && current?.buffers?.Inst && performance.now() - playbackUiUpdatedAt > 500) {
      try { syncUi(); } catch (error) { reportPlaybackUiError('relógio', error); }
    }
  }, 250);
}

function reportPlaybackUiError(part, error) {
  const key = `${part}:${error?.message || error}`;
  const now = performance.now();
  if (syncUi.lastErrorKey !== key || now - (syncUi.lastErrorAt || 0) > 15000) {
    console.error(`VoxStage: falha ao atualizar ${part}`, error);
    syncUi.lastErrorKey = key;
    syncUi.lastErrorAt = now;
  }
}

function startAudioSources(offset = playbackBase) {
  if (!audioContext || !current?.buffers) return;
  if (playbackFrame) cancelAnimationFrame(playbackFrame);
  playbackFrame = 0;
  current.profanityMuted = false;
  stopActiveSources();
  const token = playbackToken;
  const startAt = audioContext.currentTime + .08;
  playbackBase = Math.max(0, offset);
  playbackStartContextTime = startAt;
  const adjusted = tempoWorkletReady && (playbackSpeed !== 1 || playbackSemitones !== 0);
  const output = audioContext.createGain();
  output.gain.setValueAtTime(0, audioContext.currentTime);
  output.gain.linearRampToValueAtTime(1, startAt + .025);
  output.connect(audioContext.destination);
  current.engine = {sources: {}, gains: {}, output, speed: adjusted ? playbackSpeed : 1, latencySeconds: adjusted ? .25 : 0};
  let destination = output;
  if (adjusted) {
    const processor = new AudioWorkletNode(audioContext, 'soundtouch-processor', {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
    processor.parameters.get('playbackRate').setValueAtTime(playbackSpeed, startAt);
    processor.parameters.get('pitchSemitones').setValueAtTime(playbackSemitones, startAt);
    processor.port.onmessage = event => {
      if (token === playbackToken && event.data.type === 'metrics' && Number.isFinite(event.data.latencySeconds)) {
        current.engine.latencySeconds = Math.max(0, event.data.latencySeconds);
        current.engine.metrics = event.data;
      }
    };
    processor.connect(output); current.engine.processor = processor; destination = processor;
  }
  for (const [key, buffer] of Object.entries(current.buffers)) {
    if (!buffer) continue;
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(current.engine.speed, startAt);
    gain.gain.setValueAtTime(Number($(`vol${key}`).value), startAt);
    source.connect(gain);
    gain.connect(destination);
    source.onended = () => {
      if (token === playbackToken && key === 'Inst' && playing) {
        current.engine.finishTimer = setTimeout(() => { if (token === playbackToken && playing) finishPlayback(); }, (current.engine.latencySeconds + (adjusted ? .05 : 0)) * 1000);
      }
    };
    current.engine.sources[key] = source;
    current.engine.gains[key] = gain;
    stemGains[key] = gain;
    source.start(startAt, Math.min(playbackBase, Math.max(0, buffer.duration - .01)));
  }
  playing = true;
  setPlayBusy(false);
  keepPlaybackUiAlive();
  syncUi();
  window.dispatchEvent(new CustomEvent('voxstage-score-playback', {detail:{type:'start'}}));
  if (presentationDevice==='tv' && !manualSyncState) window.dispatchEvent(new Event('voxstage-tv-song-started'));
}

function pausePlayback() {
  if (!current) return;
  playbackBase = playbackPosition();
  playing = false;
  window.dispatchEvent(new CustomEvent('voxstage-score-playback', {detail:{type:'pause'}}));
  stopPlaybackUiLoop();
  stopActiveSources();
  setPlayBusy(false);
  syncUi();
}

function finishPlayback() {
  if (!current) return;
  if (manualSyncState?.mode === 'silence' && manualSilenceStartMs !== null) void markManualSilenceToEnd();
  playbackBase = current.buffers?.Inst?.duration || 0;
  playing = false;
  window.dispatchEvent(new CustomEvent('voxstage-score-playback', {detail:{type:'finish'}}));
  stopPlaybackUiLoop();
  stopActiveSources();
  setPlayBusy(false);
  syncUi();
  const nextId = !manualSyncState && nextPlaybackSong();
  if (nextId) { void playSong(nextId); return; }
  if (presentationDevice==='tv' && !manualSyncState) window.dispatchEvent(new Event('voxstage-tv-song-ended'));
}

const remoteSongQueue = [];
async function enqueueRemoteSong(songId) {
  if (!songId || !songs.some(song => song.id === songId && !song.hidden)) return;
  if (current?.id === songId || remoteSongQueue.includes(songId)) return;
  if (!playing || !current) { await playSong(songId); return; }
  remoteSongQueue.push(songId);
  window.dispatchEvent(new Event('voxstage-queue-changed'));
  toast(`Adicionada à fila (${remoteSongQueue.length}).`);
}

stopSong = function () {
  window.dispatchEvent(new CustomEvent('voxstage-score-playback', {detail:{type:'stop'}}));
  if (typeof manualSyncState !== 'undefined' && manualSyncState) {manualSyncReturn=null;$('closeManualSync').click();}
  stopPlaybackUiLoop();
  if($('lyricSecondLine'))$('lyricSecondLine').hidden=true;
  playing = false;
  stopActiveSources();
  playbackBase = 0; playbackStartContextTime = 0; waveformPeaks = null;
  current = null;
  updateSongVolumeControls(null);
  if (mobileNative) try { window.VoxStageMedia?.clear(); } catch {}
  setPlayBusy(false);
  if ($('nowLyric')) { $('nowLyric').textContent = ''; $('nowLyric').hidden = true; }
  drawWaveform();
};

toggle = function () {
  if (!current) { const nextId = nextPlaybackSong(); if (nextId) playSong(nextId); else toast('Adicione uma música primeiro.'); return; }
  if (playing) pausePlayback(); else startAudioSources(playbackBase >= (current.buffers?.Inst?.duration || Infinity) ? 0 : playbackBase);
};
document.addEventListener('voxstage-media-control', event => {
  const command = event.detail || {};
  if (command.action === 'play' && !playing) toggle();
  else if (command.action === 'pause' && playing) pausePlayback();
  else if (command.action === 'next') navigateSong(1);
  else if (command.action === 'previous') navigateSong(-1);
  else if (command.action === 'seek' && current?.buffers?.Inst?.duration) seek(Number(command.position) / current.buffers.Inst.duration * 1000);
});

seek = function (value) {
  if (!current?.buffers?.Inst) return;
  const position = current.buffers.Inst.duration * Number(value) / 1000;
  if (playing) startAudioSources(position);
  else { playbackBase = position; syncUi(); }
};

function drawWaveform(position = playbackPosition()) {
  const canvas = $('waveformCanvas'); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d'); context.clearRect(0, 0, width, height);
  if (!waveformPeaks?.length) return;
  const duration = current?.buffers?.Inst?.duration || 0, progress = duration ? position / duration : 0;
  const step = width / waveformPeaks.length, center = height / 2;
  waveformPeaks.forEach((peak, index) => {
    const x = index * step, barHeight = Math.max(2 * ratio, peak * height * .88);
    context.fillStyle = index / waveformPeaks.length < progress ? '#d7ff72' : '#66704a';
    context.fillRect(x, center - barHeight / 2, Math.max(1, step * .58), barHeight);
  });
}

function calculateWaveform(buffer) {
  const samples = buffer.getChannelData(0), columns = 360, stride = Math.max(1, Math.floor(samples.length / columns));
  waveformPeaks = Array.from({length: columns}, (_, index) => {
    const start = index * stride, end = Math.min(samples.length, start + stride);
    let peak = 0; for (let cursor = start; cursor < end; cursor += 8) peak = Math.max(peak, Math.abs(samples[cursor]));
    return peak;
  });
  drawWaveform(0);
}

syncUi = function () {
  if (!current?.buffers?.Inst) { drawWaveform(0); return; }
  // Schedule the next frame before rendering. Lyrics and waveform are visual
  // consumers of the audio clock; an error in either must not freeze the timer.
  if (playing && !playbackFrame) playbackFrame = requestAnimationFrame(() => {
    playbackFrame = 0;
    try { syncUi(); } catch (error) { reportPlaybackUiError('relógio', error); }
  });
  playbackUiUpdatedAt = performance.now();
  const duration = current.buffers.Inst.duration, time = playbackPosition();
  $('seek').value = duration ? time / duration * 1000 : 0;
  $('dispSeek').value = duration ? time / duration * 1000 : 0;
  $('currentTime').textContent = fmt(time); $('duration').textContent = fmt(duration);
  $('dispTime').textContent = fmt(time); $('dispDuration').textContent = fmt(duration);
  try { updateLyrics(time); } catch (error) { reportPlaybackUiError('letras', error); }
  try { drawWaveform(time); } catch (error) { reportPlaybackUiError('waveform', error); }
  if (mobileNative && Date.now() - (syncUi.mobileMediaAt || 0) > 900) {
    syncUi.mobileMediaAt = Date.now();
    try { window.VoxStageMedia?.update(current.title || '', current.artist || '', Boolean(playing), Math.round(duration * 1000), Math.round(time * 1000)); } catch {}
  }
  if (playing && time >= duration && !current.engine?.finishTimer) { finishPlayback(); return; }
};

const refreshPlaybackUiOnReturn = () => {
  if (!playing || !current?.buffers?.Inst) return;
  try { syncUi(); } catch (error) { reportPlaybackUiError('relógio', error); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPlaybackUiOnReturn(); });
window.addEventListener('focus', refreshPlaybackUiOnReturn);

function parseSyncedLyrics(lrc) {
  return (lrc || '').split(/\r?\n/).flatMap(line => {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').replace(/^\s*\[(?:ar|ti|al|by|re|ve|offset|length|la|id):[^\]]+\]\s*/i, '').trim();
    if (!text) return [];
    return tags.map(tag => ({time: (Number(tag[1]) * 60 + Number(tag[2])) * 1000 + Number((tag[3] || '0').padEnd(3, '0').slice(0, 3)), text}));
  }).sort((a, b) => a.time - b.time);
}
function isBackingLyric(text) { return /^\s*\(.*\)\s*$/.test(String(text || '')); }
function lyricWordEntries(text) {
  let value = String(text || '');
  if (isBackingLyric(value)) value = value.trim().slice(1, -1);
  const entries = [];
  const add = (segment, parallel = false) => {
    for (const entry of VoxStageLyrics.wordEntries(segment)) entries.push({...entry,parallel});
  };
  let cursor = 0;
  for (const match of value.matchAll(/\[([^\]]+)\]/g)) {
    add(value.slice(cursor, match.index));
    add(match[1], true);
    cursor = match.index + match[0].length;
  }
  add(value.slice(cursor));
  return entries;
}
function lyricWords(text) { return lyricWordEntries(text).map(entry => entry.word); }
function lyricEntriesMarkup(entries, className = 'lyric-word', decorate = () => '') {
  let markup = '', previousParallel = false;
  entries.forEach((entry, index) => {
    if(previousParallel&&!entry.parallel)markup+='</span>';
    if(index)markup+=esc(entry.joiner||' ');
    if(entry.parallel&&!previousParallel)markup+='<span class="lyric-parallel-phrase">';
    const classes = [className, entry.parallel ? 'parallel-vocal' : '', decorate(entry, index)].filter(Boolean).join(' ');
    markup += `<span class="${classes}">${esc(entry.word)}</span>`;
    previousParallel = entry.parallel;
  });
  if (previousParallel) markup += '</span>';
  return markup;
}
function lyricWordMarkup(text, className = 'lyric-word', lineIndex = -1) {
  return lyricEntriesMarkup(lyricWordEntries(text), className, (entry, index) => processingSettings.markProfanity === true && isProfanityOccurrence(lineIndex, index, entry.word) ? 'profanity' : '');
}
function lyricCensorMarkup(text, className = 'lyric-censor-word', lineIndex = -1) {
  return lyricWordMarkup(text, className, lineIndex);
}
function lyricTokenKey(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}
function splitLegacyVoiceTimings(line, words = []) {
  const entries = lyricWordEntries(line?.text || '');
  const positions=VoxStageLyrics.cuePositions({text:VoxStageLyrics.joinEntries(entries),words});
  const lead=[],parallel=[],backing=[];
  for(const [index,cue] of positions){
    const cloned={...cue};
    if(isBackingLyric(line?.text))backing.push(cloned);
    else if(entries[index]?.parallel){lead.push(cloned);parallel.push({...cloned});}
    else lead.push(cloned);
  }
  return {lead, parallel, backing};
}
function legacyUnifiedLyricsForSong(song) {
  const main = parseSyncedLyrics(song.syncedLyrics || '');
  const backing = parseSyncedLyrics(song.backingSyncedLyrics || '');
  const existingBacking = new Set(main.filter(line=>isBackingLyric(line.text)).map(line=>`${line.text.trim().slice(1,-1).trim().toLocaleLowerCase()}|${Math.round(line.time/250)}`));
  const rows = [
    ...main.map((line,index) => ({...line, source:isBackingLyric(line.text) ? 'inline-backing' : 'lead', sourceIndex:index})),
    ...backing.map((line,index)=>({line,index})).filter(({line})=>!existingBacking.has(`${line.text.trim().replace(/^\(|\)$/g,'').trim().toLocaleLowerCase()}|${Math.round(line.time/250)}`)).map(({line,index}) => ({...line, text:isBackingLyric(line.text) ? line.text : `(${line.text})`, source:'backing', sourceIndex:index}))
  ].sort((a,b) => a.time - b.time);
  // Plain lyric edits may add [parallel] markers without replacing the timed LRC.
  // A repeated bracketed line annotates the preceding matching timed line.
  const lyricKey=text=>lyricWordEntries(text).map(entry=>lyricTokenKey(entry.word)).join(' ');
  let plainCursor=0, lastPlainMatch=-1, lastPlainKey='';
  for (const plainLine of String(song.plainLyrics||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean)) {
    const key=lyricKey(plainLine);
    if (!key) continue;
    const parallel=/\[[^\]]+\]/.test(plainLine);
    if (parallel && lastPlainMatch>=0 && key===lastPlainKey) { rows[lastPlainMatch].text=plainLine; continue; }
    const found=rows.findIndex((row,index)=>index>=plainCursor && !isBackingLyric(row.text) && lyricKey(row.text)===key);
    if (found<0) continue;
    if (parallel) rows[found].text=plainLine;
    plainCursor=found+1; lastPlainMatch=found; lastPlainKey=key;
  }
  const wordTimings = [], parallelWordTimings = [], backingWordTimings = [];
  const lyricLineEnds = [], backingLineEnds = [], parallelLineStarts = [];
  rows.forEach((line,lineIndex) => {
    const legacy = line.source==='backing' ? null : (song.wordTimings || []).find(item=>Number(item.lineIndex)===line.sourceIndex);
    const split = splitLegacyVoiceTimings(line, legacy?.words || []);
    if (line.source === 'lead') {
      const leadWords = split.lead;
      const explicitParallel = (song.parallelWordTimings || []).find(item=>Number(item.lineIndex)===line.sourceIndex)?.words;
      const parallelWords = explicitParallel || split.parallel;
      if (leadWords.length) wordTimings.push({lineIndex,words:leadWords});
      if (parallelWords.length) parallelWordTimings.push({lineIndex,words:parallelWords});
      if (song.lyricLineEnds?.[line.sourceIndex] != null) lyricLineEnds[lineIndex]=song.lyricLineEnds[line.sourceIndex];
      if (song.parallelLineStarts?.[line.sourceIndex] != null) parallelLineStarts[lineIndex]=song.parallelLineStarts[line.sourceIndex];
    } else {
      const explicitBacking = line.source === 'backing'
        ? (song.backingWordTimings || []).find(item=>Number(item.lineIndex)===line.sourceIndex)?.words
        : null;
      const backingWords = explicitBacking || split.backing;
      if (backingWords.length) backingWordTimings.push({lineIndex,words:backingWords});
      const ends = line.source === 'backing' ? song.backingLineEnds : song.lyricLineEnds;
      if (ends?.[line.sourceIndex] != null) backingLineEnds[lineIndex]=ends[line.sourceIndex];
    }
  });
  const syncedLyrics = rows.map(line=>`[${formatLrcTime(line.time/1000)}]${line.text}`).join('\n');
  return {syncedLyrics,plainLyrics:String(song.plainLyrics||'').trim()?song.plainLyrics:rows.map(line=>line.text).join('\n'),lyricLines:rows,wordTimings,parallelWordTimings,backingWordTimings,lyricLineEnds,backingLineEnds,parallelLineStarts};
}
function unifiedLyricsForSong(song) {
  return song.lyricVoices?.version===1 ? VoxStageLyrics.project(song.lyricVoices) : legacyUnifiedLyricsForSong(song);
}
function hasStoredLyricText(song) {
  return Boolean([song?.plainLyrics,song?.backingPlainLyrics,song?.parallelPlainLyrics].some(text=>String(text||'').trim()) || VoxStageLyrics.tracks.some(track=>song?.lyricVoices?.[track]?.length));
}

function lyricStatus(text) { const node = $('lyricsDialogStatus'); if (node) node.textContent = text; }
function estimateWordWeights(words) {
  // Heurística leve para iniciar o word-sync sem baixar modelos de IA.
  // Vogais e ditongos aproximam sílabas; o usuário ainda poderá ajustar depois.
  return words.map(word => {
    const syllables = (word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[aeiouy]+/g) || []).length;
    return Math.max(1, syllables);
  });
}
function vocalSilenceEnd(lineIndex, nominalEndMs) {
  const buffer = current?.buffers?.Lead;
  const line = current?.lyricLines?.[lineIndex];
  if (!buffer || !line) return null;
  current.vocalSilenceEnds ||= [];
  if (current.vocalSilenceEnds[lineIndex] !== undefined) return current.vocalSilenceEnds[lineIndex];

  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const startSample = Math.max(0, Math.floor(line.time * sampleRate / 1000));
  const endSample = Math.min(samples.length, Math.floor(nominalEndMs * sampleRate / 1000));
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.025));
  const windows = [];
  for (let offset = startSample; offset < endSample; offset += windowSize) {
    const limit = Math.min(endSample, offset + windowSize);
    let energy = 0;
    for (let sample = offset; sample < limit; sample++) energy += samples[sample] * samples[sample];
    const rms = Math.sqrt(energy / Math.max(1, limit - offset));
    windows.push({time: offset / sampleRate * 1000, rms});
  }

  const threshold = 10 ** (-34 / 20); // sensibilidade normal, fixa
  const silenceWindows = 16; // 400 ms contínuos abaixo do limiar
  let heardVoice = false;
  let quietStart = -1;
  for (let index = 0; index < windows.length; index++) {
    if (windows[index].rms > threshold) {
      heardVoice = true;
      quietStart = -1;
      continue;
    }
    if (heardVoice) {
      if (quietStart < 0) quietStart = index;
      if (index - quietStart + 1 >= silenceWindows) {
        return (current.vocalSilenceEnds[lineIndex] = windows[quietStart].time);
      }
    }
  }
  return (current.vocalSilenceEnds[lineIndex] = null);
}
function hasLyricTrackingNear(ms) {
  if (!current) return false;
  const lines = current.lyricLines || [];
  const tracks = [current.wordTimings, current.parallelWordTimings, current.backingWordTimings];
  const margin = 350;
  return lines.some((line, index) => {
    if (!lyricWordEntries(line.text).length) return false;
    const adjustment = current.lyricAdjustments?.[index] || {};
    const offset = Number(adjustment.offsetMs) || 0;
    const speed = Math.max(.5, Math.min(2, Number(adjustment.speed) || 1));
    const origin = Number(line.time);
    const cues = tracks.flatMap(track => track?.find(row => Number(row.lineIndex) === index)?.words || [])
      .filter(cue => Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)) && Number(cue.end) >= Number(cue.start));
    if (cues.length) {
      const start = Math.min(...cues.map(cue => origin + (Number(cue.start) * 1000 - origin) * speed + offset));
      const end = Math.max(...cues.map(cue => origin + (Number(cue.end) * 1000 - origin) * speed + offset));
      return ms >= start - margin && ms <= end + margin;
    }
    // Line-only lyrics still count as tracking even when the separator placed
    // the singer in the instrumental. Bound estimates so a long interlude can pause.
    const markedEnd = (line.voice==='parallel' ? current.parallelLineEnds : isBackingLyric(line.text) ? current.backingLineEnds : current.lyricLineEnds)?.[index];
    const estimate = origin + Math.min(8000, Math.max(2200, lyricWordEntries(line.text).length * 550));
    const next = lines.slice(index + 1).find(row => line.voice ? row.voice===line.voice : isBackingLyric(row.text) === isBackingLyric(line.text));
    const end = Math.min(markedEnd != null && Number(markedEnd) > origin ? Number(markedEnd) : estimate, next?.time ?? Infinity);
    return ms >= origin + offset - margin && ms <= origin + (end - origin) * speed + offset + margin;
  });
}
function updateVocalPause(seconds) {
  const indicator = $('lyricPauseIndicator');
  const clock = indicator?.querySelector('.lyric-pause-clock');
  const positionMs = seconds * 1000;
  const tracking = hasLyricTrackingNear(positionMs);
  const durationMs = current?.buffers?.Inst?.duration ? current.buffers.Inst.duration * 1000 : 0;
  const markedSilence = (current?.manualVocalSilences || []).find(mark => {
    const start = Number(mark?.startMs), end = mark?.endMs == null ? durationMs : Number(mark.endMs);
    return Number.isFinite(start) && Number.isFinite(end) && positionMs >= start && positionMs <= end;
  });
  if (markedSilence && !tracking) {
    current.vocalSilenceState ||= {quietSince:null,lastPosition:null,silent:false};
    current.vocalSilenceState.silent = true;
    if (indicator) indicator.hidden = false;
    $('lyrics')?.classList.add('manual-vocal-silence');
    indicator?.classList.add('manual');
    if (clock) { clock.hidden = false; clock.textContent = `${Math.max(0, Math.ceil(((markedSilence.endMs == null ? durationMs : Number(markedSilence.endMs)) - positionMs) / 1000))}s`; }
    return;
  }
  $('lyrics')?.classList.remove('manual-vocal-silence');
  indicator?.classList.remove('manual');
  if (clock) { clock.hidden = true; clock.textContent = ''; }
  const buffer = current?.buffers?.Lead;
  if (!buffer) {
    if (indicator) indicator.hidden = true;
    if (current?.vocalSilenceState) current.vocalSilenceState.silent = false;
    return;
  }
  const samples = buffer.getChannelData(0);
  const end = Math.min(samples.length, Math.floor(seconds * buffer.sampleRate));
  const start = Math.max(0, end - Math.floor(buffer.sampleRate * .08));
  let energy = 0;
  for (let index = start; index < end; index++) energy += samples[index] * samples[index];
  const rms = Math.sqrt(energy / Math.max(1, end - start));
  const threshold = 10 ** (-34 / 20); // sensibilidade normal, fixa
  const state = current.vocalSilenceState ||= {quietSince: null, lastPosition: null, silent: false};
  if (state.lastPosition !== null && (seconds < state.lastPosition || seconds - state.lastPosition > .2)) {
    state.quietSince = rms <= threshold ? seconds : null;
    state.silent = false;
  }
  if (rms <= threshold) {
    if (state.quietSince === null) state.quietSince = seconds;
    const minimumPause = Number(processingSettings.pauseThresholdSeconds) || 1.5;
    state.silent = !tracking && seconds - state.quietSince >= minimumPause;
  } else {
    state.quietSince = null;
    state.silent = false;
  }
  state.lastPosition = seconds;
  if (indicator) { indicator.hidden = !state.silent; indicator.classList.remove('manual'); }
}
function positionVocalPause(seconds, lineIndex) {
  const indicator = $('lyricPauseIndicator');
  if (!indicator || !current?.vocalSilenceState?.silent) return;
  const milliseconds = seconds * 1000;
  const leadLines = current.lyricLines.filter(line=>!isBackingLyric(line.text));
  const firstLyricTime = leadLines[0]?.time ?? 0;
  const atBeginning = milliseconds < firstLyricTime;
  let atEnd = false;
  const lastIndex = leadLines.length ? current.lyricLines.lastIndexOf(leadLines.at(-1)) : -1;
  const duration = current.buffers?.Inst?.duration ? current.buffers.Inst.duration * 1000 : 0;
  const manualMark = (current.manualVocalSilences || []).find(mark=>milliseconds >= Number(mark.startMs) && milliseconds <= (mark.endMs == null ? (duration || Infinity) : Number(mark.endMs)));
  if (manualMark?.endMs == null && duration && milliseconds >= Number(manualMark.startMs)) atEnd = true;
  if (!manualMark && !atBeginning && lineIndex === lastIndex && duration) {
    const silenceStart = vocalSilenceEnd(lastIndex, duration);
    atEnd = silenceStart !== null && milliseconds >= silenceStart;
  }
  indicator.hidden = false;
  indicator.classList.toggle('at-top', atBeginning);
  indicator.classList.toggle('at-bottom', atEnd);
}
function isProfanityOccurrence(lineIndex, wordIndex, word) {
  return (current?.profanityMarks || []).some(mark => Number(mark.lineIndex) === lineIndex && Number(mark.wordIndex) === wordIndex && lyricTokenKey(mark.word) === lyricTokenKey(word));
}
function activeCensorCue(milliseconds) {
  if (processingSettings.muteProfanity !== true) return false;
  return (current?.profanityCues || []).some(cue => {
    const line = current?.lyricLines?.[Number(cue.lineIndex)];
    const word = line && lyricWordEntries(line.text)[Number(cue.wordIndex)]?.word;
    return word && lyricTokenKey(word) === lyricTokenKey(cue.word)
      && milliseconds >= Number(cue.startMs) && milliseconds < Number(cue.endMs);
  });
}
function setProfanityMute(muted) {
  if (!current || current.profanityMuted === muted) return;
  current.profanityMuted = muted;
  if (!audioContext) return;
  for (const key of ['Lead','Back']) {
    const gain = stemGains[key]; if (!gain) continue;
    const level = muted ? 0 : Number($(`vol${key}`)?.value ?? 1);
    gain.gain.setTargetAtTime(level, audioContext.currentTime, muted ? .012 : .035);
  }
}
function updateWordMarker(ms, lineIndex = current?.lyricIndex ?? -1) {
  const marker = $('lyricWordMarker'), parallelMarker = $('lyricParallelWordMarker');
  const hideMarkers = () => { if (marker) marker.hidden = true; if (parallelMarker) parallelMarker.hidden = true; };
  if (current?.wordByWordEnabled === false || current?.vocalSilenceState?.silent) {
    hideMarkers();$('lyricCurrentLine')?.querySelectorAll('.upcoming').forEach(word=>word.classList.remove('upcoming'));return;
  }
  const line = current?.lyricLines?.[lineIndex];
  const host = $('lyricCurrentLine');
  if (!line || !host) { hideMarkers(); return; }
  const allWords = [...host.querySelectorAll('.lyric-word')];
  const words = allWords;
  const parallelWords = allWords.filter(word => word.classList.contains('parallel-vocal'));
  if (!words.length && !parallelWords.length) { hideMarkers(); return; }
  const actual = current.wordTimings?.find(item => Number(item.lineIndex) === lineIndex)?.words || [];
  const parallelActual = current.parallelWordTimings?.find(item => Number(item.lineIndex) === lineIndex)?.words || [];
  const parallelOriginValue=current.parallelLineStarts?.[lineIndex];
  const adjustment = current.lyricAdjustments?.[lineIndex] || {offsetMs: 0, speed: 1};
  const offsetMs = Number(adjustment.offsetMs) || 0;
  const speedFactor = Math.max(.5, Math.min(2, Number(adjustment.speed) || 1));
  const normalized = value => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const nextLine = current.lyricLines.slice(lineIndex + 1).find(candidate=>line.voice ? candidate.voice===line.voice : !isBackingLyric(candidate.text));
  const firstParallelIndex=allWords.findIndex(word=>word.classList.contains('parallel-vocal'));
  const lineWeights=estimateWordWeights(allWords.map(word=>word.textContent));
  const totalLineWeight=lineWeights.reduce((sum,weight)=>sum+weight,0);
  const beforeParallelWeight=lineWeights.slice(0,firstParallelIndex).reduce((sum,weight)=>sum+weight,0);
  const inferredParallelOrigin=line.time+(Math.max(1,(nextLine?.time??line.time+5000)-line.time)*beforeParallelWeight/Math.max(1,totalLineWeight));
  const parallelOrigin=parallelOriginValue!=null && Number.isFinite(Number(parallelOriginValue))?Number(parallelOriginValue):inferredParallelOrigin;
  const nextParallelLine = current.lyricLines.find((candidate,index)=>index > lineIndex && !isBackingLyric(candidate.text) && lyricWordEntries(candidate.text).some(entry=>entry.parallel));
  const fallbackActive = (targetWords, origin = line.time, nextTime = nextLine?.time) => {
    if (!targetWords.length) return -1;
    const weights = estimateWordWeights(targetWords.map(word => word.textContent));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const nominalEnd = nextTime ?? (current.buffers?.Inst?.duration ? current.buffers.Inst.duration * 1000 : origin + 5000);
    const availableDuration = Math.max(1, nominalEnd - origin - offsetMs);
    const adjustedDuration = Math.min(availableDuration, Math.max(1, availableDuration * speedFactor));
    const progress = Math.max(0, Math.min(1, (ms - origin - offsetMs) / adjustedDuration));
    let cursor = progress * total, active = 0;
    while (active < weights.length - 1 && cursor >= weights[active]) cursor -= weights[active++];
    return active;
  };
  const timedActive = (targetWords, cues, origin = line.time) => {
    if (!cues.length) return null;
    const positions=VoxStageLyrics.cuePositions({text:targetWords.map(node=>node.textContent).join(' '),words:cues});
    let active = -1, lastMatched = null, matchedCount = 0, lastMatchedWordIndex = -1;
    targetWords.forEach((node, index) => {
      const timing=positions.get(index);
      if (timing) {
        lastMatched = timing; lastMatchedWordIndex = index;
        matchedCount++;
        const adjustedStart = origin + (Number(timing.start) * 1000 - origin) * speedFactor + offsetMs;
        const adjustedEnd = origin + (Number(timing.end) * 1000 - origin) * speedFactor + offsetMs;
        if (ms >= adjustedStart && ms <= (adjustedEnd + 240)) active = index;
      }
    });
    if (!lastMatched) return null;
    const adjustedLastEnd = origin + (Number(lastMatched.end) * 1000 - origin) * speedFactor + offsetMs;
    // Keep aligned timestamps authoritative; silence detection only affects the pause visual.
    if (ms >= adjustedLastEnd) {
      if (matchedCount === targetWords.length || lastMatchedWordIndex === targetWords.length - 1) active = lastMatchedWordIndex;
      else return null;
    }
    return active;
  };
  // The secondary voice runs over the same phrase window as the lead instead of being
  // serialized after it. Without its own recorded cue track, distribute its words evenly.
  const timedLead = words.length ? timedActive(words, actual, line.time) : null;
  const active = words.length ? (timedLead === null ? fallbackActive(words, line.time) : timedLead) : -1;
  const timedParallel = parallelWords.length ? timedActive(parallelWords, parallelActual, parallelOrigin) : null;
  const parallelNextIndex = nextParallelLine ? current.lyricLines.indexOf(nextParallelLine) : -1;
  const parallelNextStartValue=parallelNextIndex>=0?current.parallelLineStarts?.[parallelNextIndex]:null;
  const parallelNextStart=parallelNextStartValue!=null?Number(parallelNextStartValue):NaN;
  const nextParallelTime = parallelNextIndex >= 0 ? Number.isFinite(parallelNextStart)?parallelNextStart:nextParallelLine.time : Infinity;
  const parallelNextTime = Math.min(nextLine?.time ?? Infinity,nextParallelTime);
  const parallelActive = parallelWords.length && ms>=parallelOrigin ? (timedParallel === null ? fallbackActive(parallelWords, parallelOrigin,Number.isFinite(parallelNextTime)?parallelNextTime:undefined) : timedParallel) : -1;
  const showUpcoming = processingSettings.showUpcomingWordPreview === true;
  const tokenEntries=lyricWordEntries(line.text);
  const forcedNext=active>=0&&tokenEntries[active+1]?.joiner?active+1:-1;
  allWords.forEach((word, index) => {
    const parallelIndex=parallelWords.indexOf(word);
    const isActive=index===active || parallelIndex>=0 && parallelIndex===parallelActive;
    const isUpcoming=index===(active<0?0:active+1) || parallelIndex>=0 && parallelIndex===(parallelActive<0?0:parallelActive+1);
    const marked = processingSettings.markProfanity === true && isProfanityOccurrence(lineIndex, index, word.textContent);
    word.classList.toggle('profanity', marked);
    word.setAttribute('aria-label', marked ? `${word.textContent} · palavrão detectado` : word.textContent);
    word.classList.toggle('active', isActive);
    word.classList.toggle('voice1-active', isActive);
    word.classList.toggle('upcoming', (showUpcoming&&isUpcoming||index===forcedNext)&&!isActive);
    word.classList.toggle('dimmed', !isActive);
  });
  const paired=words[active] && words[active]===parallelWords[parallelActive];
  marker?.classList.toggle('paired',Boolean(paired));
  parallelMarker?.classList.toggle('paired',Boolean(paired));
  const positionMarker = (element, node, keyName, markerKey) => {
    if (!element || !node) { if (element) element.hidden = true; if (current) current[keyName] = null; return; }
    const displayRect = element.parentElement.getBoundingClientRect(), wordRect = node.getBoundingClientRect();
    element.style.left = `${wordRect.left - displayRect.left + wordRect.width / 2}px`;
    element.style.top = `${wordRect.top - displayRect.top - 5}px`;
    element.hidden = false;
    if (current[keyName] !== markerKey) {
      element.classList.remove('hopping'); void element.offsetWidth; element.classList.add('hopping');
      current[keyName] = markerKey;
    }
  };
  positionMarker(marker, words[active], 'wordMarkerKey', `${lineIndex}:${active}`);
  if(!lyricPlaybackTracks().duet.some(row=>row.source==='parallel')) {
    positionMarker(parallelMarker, parallelWords[parallelActive], 'parallelWordMarkerKey', `${lineIndex}:parallel:${parallelActive}`);
    if(paired&&parallelMarker)parallelMarker.hidden=true;
  }
}

function currentLyricAdjustment() {
  const index = current?.lyricIndex ?? -1;
  return index >= 0 ? (current.lyricAdjustments?.[index] || {offsetMs: 0, speed: 1}) : {offsetMs: 0, speed: 1};
}
function updateLyricAdjustmentLabel() {
  const label = $('lyricAdjustmentLabel');
  if (!label) return;
  if (!current || current.lyricIndex < 0) { label.textContent = 'Aguardando a letra'; return; }
  const adjustment = currentLyricAdjustment();
  const offset = Number(adjustment.offsetMs) || 0;
  const speedFactor = Number(adjustment.speed) || 1;
  label.textContent = `atraso ${offset > 0 ? '+' : ''}${Math.round(offset)} ms · duração ${Math.round(speedFactor * 100)}%`;
}
async function changeCurrentLyricAdjustment(change) {
  if (!current || current.lyricIndex < 0) { toast('Toque até chegar à linha que quer ajustar.'); return; }
  const song = songs.find(item => item.id === current.id);
  if (!song) return;
  song.lyricAdjustments ||= {};
  current.lyricAdjustments = song.lyricAdjustments;
  const key = String(current.lyricIndex);
  const adjustment = {...(song.lyricAdjustments[key] || {offsetMs: 0, speed: 1})};
  if (change === 'reset') { delete song.lyricAdjustments[key]; }
  else if (change.offsetMs) adjustment.offsetMs = Math.max(-3000, Math.min(3000, (Number(adjustment.offsetMs) || 0) + change.offsetMs));
  else if (change.speed) adjustment.speed = Math.round(Math.max(.5, Math.min(2, (Number(adjustment.speed) || 1) + change.speed)) * 10) / 10;
  if (change !== 'reset') song.lyricAdjustments[key] = adjustment;
  if(current.lyricVoices) {
    const rowId=current.lyricLines[current.lyricIndex]?.voiceId;
    for(const model of [current.lyricVoices,song.lyricVoices]) for(const track of VoxStageLyrics.tracks) {
      const row=model?.[track]?.find(item=>item.id===rowId);if(!row)continue;
      if(change==='reset')delete row.adjustment;else row.adjustment={...adjustment};
    }
  }
  current.lyricAdjustments = song.lyricAdjustments;
  updateLyricAdjustmentLabel();
  updateWordMarker(playbackPosition() * 1000, current.lyricIndex);
  try { await api('/api/library', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(song)}); }
  catch (error) { console.error('Não foi possível salvar o ajuste desta linha', error); toast('Ajuste aplicado, mas não consegui salvá-lo.'); }
}

function lyricPlaybackTracks() {
  if (!current) return {lead:[],backing:[],duet:[],silence:[],censor:[]};
  // Keep the five timelines separate. A line index is only a reference back to
  // its own lyric row; it never determines another track's playback position.
  const lines = current.lyricLines || [];
  const cached = current.playbackTracks;
  if (cached?.lines === lines && cached?.backingEnds === current.backingLineEnds && cached?.censorCues === current.profanityCues && cached?.silences === current.manualVocalSilences && cached?.audioDuration === current.buffers?.Inst?.duration) return cached;
  const lead = [], backing = [], duet = [];
  lines.forEach((line,lineIndex) => {
    const startMs = Number(line.time);
    if (!Number.isFinite(startMs) || startMs < 0) return;
    const track = line.source==='parallel' ? duet : isBackingLyric(line.text) ? backing : lead;
    track.push({lineIndex,startMs,text:line.text,source:line.source,activeWordIndices:line.activeWordIndices,phraseKey:lyricWords(line.text).map(lyricTokenKey).join(' ')});
    if (track === lead && lyricWordEntries(line.text).some(entry=>entry.parallel)) duet.push({lineIndex,startMs,text:line.text});
  });
  // An independently synced backing replaces the same phrase embedded in the
  // main LRC, even when its timestamp differs. Repeated phrases within one
  // source remain distinct.
  const explicitRows = backing.filter(row=>row.source==='backing');
  const backingRows = backing.filter(row=>row.source!=='inline-backing' || !explicitRows.some(explicit=>lyricTokenKey(explicit.text)===lyricTokenKey(row.text) && Math.abs(explicit.startMs-row.startMs)<8000));
  display.classList.toggle('has-second-voice',duet.some(row=>row.source==='parallel'));
  const audioEnd = (current.buffers?.Inst?.duration || 0) * 1000;
  for(const [rows,ends,timings] of [[backingRows,current.backingLineEnds,current.backingWordTimings],[duet,current.parallelLineEnds,current.parallelWordTimings],[lead,current.lyricLineEnds,current.wordTimings]]) rows.forEach((row,index) => {
    const explicit = Number(ends?.[row.lineIndex]);
    const cues = timings?.find(item=>Number(item.lineIndex)===row.lineIndex)?.words || [];
    const cueEnd = cues.reduce((last,cue)=>Math.max(last,Number(cue.end)*1000||0),0);
    const nextStart = rows[index+1]?.startMs ?? Infinity;
    const plausible = value => Number.isFinite(value) && value > row.startMs && (!audioEnd || value < audioEnd-120 || value-row.startMs < 15000);
    // A backing without a marked end must never remain active until a distant
    // phrase. The short estimate is only a visual fallback.
    row.endMs = plausible(explicit) ? explicit : plausible(cueEnd) ? cueEnd : row.startMs + Math.min(3200,Math.max(900,lyricWordEntries(row.text).length*380));
    row.endMs = Math.min(row.endMs,nextStart,audioEnd||Infinity);
  });
  current.playbackTracks = {lines,backingEnds:current.backingLineEnds,censorCues:current.profanityCues,silences:current.manualVocalSilences,audioDuration:current.buffers?.Inst?.duration,lead,backing:backingRows,duet,silence:current.manualVocalSilences||[],censor:current.profanityCues||[]};
  return current.playbackTracks;
}
function backingLineEndMs(index) {
  return lyricPlaybackTracks().backing.find(row=>row.lineIndex===index)?.endMs ?? 0;
}
function updateParallelLyrics(seconds=0) {
  if(!current)return;
  const ms=seconds*1000,tracks=lyricPlaybackTracks(),rows=tracks.duet.filter(row=>row.source==='parallel');
  const latest=rows.findLast(item=>ms>=item.startMs);
  const lead=tracks.lead.find(item=>item.lineIndex===current.lyricIndex);
  const leadAtTime=lead&&ms>=lead.startMs&&ms<lead.endMs?lead:null;
  // Once the same phrase has met, keep its single visual in place until either
  // track advances. Ending one voice must not move the phrase into the solo lane.
  // Derive this from the timelines so seeking gives the same result as playback.
  const merged=Boolean(latest&&lead&&latest.phraseKey&&latest.phraseKey===lead.phraseKey
    && Math.max(latest.startMs,lead.startMs)<Math.min(latest.endMs,lead.endMs)
    && ms>=Math.max(latest.startMs,lead.startMs));
  const soloHeld=latest&&(!lead||latest.startMs>=lead.endMs);
  const row=latest&&(ms<latest.endMs||merged||soloHeld)?latest:null,lineIndex=row?.lineIndex??-1;
  const rowActive=Boolean(row&&ms<row.endMs);
  const leadNode=$('lyricCurrentLine'),root=$('lyrics'),wordMode=current.wordByWordEnabled!==false;
  root.classList.toggle('voices-overlap',Boolean(rowActive&&leadAtTime));
  root.classList.toggle('voices-merged',merged);
  let node=$('lyricSecondLine');
  if(!node){node=document.createElement('span');node.id='lyricSecondLine';node.className='lyric-second-line';document.querySelector('.display-content').append(node);}
  const words=current.parallelWordTimings?.find(item=>Number(item.lineIndex)===lineIndex)?.words||[];
  const raw=row?current.lyricLines[lineIndex].text:'';
  const signature=JSON.stringify([current.id,lineIndex,raw,wordMode,processingSettings.markProfanity,current.profanityMarks]);
  if(node.dataset.signature!==signature){
    node.innerHTML=row?`<small class="lyric-voice-label">${interfaceLanguage==='en-US'?'Voice 2':'Voz 2'}</small>${lyricWordMarkup(raw,'second-lyric-word',lineIndex)}`:'';
    node.dataset.signature=signature;
  }
  node.hidden=!row||merged;
  if(leadNode&&current.lyricVoices){
    // Keep the main block's geometry while a different phrase is sung above it.
    leadNode.hidden=false;
    leadNode.classList.toggle('voice-ended',Boolean(row&&!merged&&(!lead||ms>=lead.endMs)));
  }
  const spans=[...node.querySelectorAll('.second-lyric-word')];let active=-1;
  if(rowActive&&wordMode){
    const positions=VoxStageLyrics.cuePositions({text:lyricWords(raw).join(' '),words});
    for(const [index,cue] of positions)if((!row.activeWordIndices||row.activeWordIndices.includes(index))&&ms>=cue.start*1000&&ms<=cue.end*1000+240)active=index;
    if(!words.length){const targets=row.activeWordIndices||spans.map((_,index)=>index);active=targets[Math.min(targets.length-1,Math.max(0,Math.floor((ms-row.startMs)/Math.max(1,row.endMs-row.startMs)*targets.length)))]??-1;}
  }
  const nextPart=active>=0&&lyricWordEntries(raw)[active+1]?.joiner&&(!row.activeWordIndices||row.activeWordIndices.includes(active+1))?active+1:-1;
  spans.forEach((span,index)=>{span.classList.toggle('active',index===active);span.classList.toggle('upcoming',index===nextPart);});
  const sharedSpans=[...(leadNode?.querySelectorAll('.lyric-word,.lyric-censor-word')||[])];
  sharedSpans.forEach((span,index)=>{
    const firstActive=Boolean(wordMode&&(!current.lyricVoices||leadAtTime)&&span.classList.contains('voice1-active')),secondActive=merged&&index===active;
    span.classList.toggle('voice1-active',firstActive);
    span.classList.toggle('voice2-active',secondActive);
    span.classList.toggle('voices-active',firstActive&&secondActive);
    if(merged){
      span.classList.toggle('active',firstActive||secondActive);
      span.classList.toggle('dimmed',!firstActive&&!secondActive);
      if(secondActive)span.classList.remove('upcoming');
      else if(index===nextPart)span.classList.add('upcoming');
    }
    const marked=processingSettings.markProfanity===true&&(isProfanityOccurrence(current.lyricIndex,index,span.textContent)||merged&&isProfanityOccurrence(lineIndex,index,span.textContent));
    span.classList.toggle('profanity',marked);
    span.setAttribute('aria-label',marked?span.textContent+' · palavrão detectado':span.textContent);
  });
  const marker=$('lyricParallelWordMarker'),leadMarker=$('lyricWordMarker');
  if(current.lyricVoices&&!leadAtTime&&leadMarker)leadMarker.hidden=true;
  if(rows.length&&marker){
    const target=merged?sharedSpans[active]:spans[active];
    marker.hidden=!target||current.vocalSilenceState?.silent;
    if(!marker.hidden){
      const outer=marker.parentElement.getBoundingClientRect(),rect=target.getBoundingClientRect();
      marker.style.left=`${rect.left-outer.left+rect.width/2}px`;marker.style.top=`${rect.top-outer.top-5}px`;
      const markerKey=`voice2:${lineIndex}:${active}`;
      if(current.parallelWordMarkerKey!==markerKey){marker.classList.remove('hopping');void marker.offsetWidth;marker.classList.add('hopping');current.parallelWordMarkerKey=markerKey;}
    }else current.parallelWordMarkerKey=null;
    const paired=Boolean(merged&&!marker.hidden&&!leadMarker?.hidden&&target?.classList.contains('voice1-active'));
    marker.classList.toggle('paired',paired);leadMarker?.classList.toggle('paired',paired);
    if(paired)marker.hidden=true;
  }
}

function updateBackingLyrics(seconds = 0) {
  if (!current) return;
  const ms = seconds * 1000;
  const row = lyricPlaybackTracks().backing.findLast(item=>ms>=item.startMs && ms<item.endMs);
  const index = row?.lineIndex ?? -1;
  const lines = current.lyricLines || [];
  const rawText = index >= 0 ? lines[index]?.text || '' : '';
  const text = isBackingLyric(rawText) ? rawText.trim().slice(1, -1).trim() : '';
  let node = $('lyricBackingLine');
  if (!node) { node = document.createElement('span'); node.id = 'lyricBackingLine'; node.className = 'lyric-backing-line'; $('lyrics').append(node); }
  const wordTimings = current.backingWordTimings?.find(item => Number(item.lineIndex) === index)?.words || [];
  const wordMode = current.wordByWordEnabled !== false;
  const profanityVersion = `${processingSettings.markProfanity === true}:${JSON.stringify(current.profanityMarks||[])}`;
  if (node.dataset.lineIndex !== String(index) || node.dataset.wordMode !== String(wordMode) || node.dataset.profanityVersion !== profanityVersion) {
    node.innerHTML = text ? `(${wordMode ? lyricWordMarkup(rawText, 'backing-lyric-word', index) : lyricCensorMarkup(rawText, 'backing-lyric-word', index)})` : '';
    node.dataset.lineIndex = String(index);
    node.dataset.wordMode = String(wordMode);
    node.dataset.profanityVersion = profanityVersion;
  }
  node.hidden = !text;
  const wordSpans = [...node.querySelectorAll('.backing-lyric-word')];
  let active = -1;
  if (wordMode && wordSpans.length) {
    const normalized = value => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    const positions=VoxStageLyrics.cuePositions({text:wordSpans.map(word=>word.textContent).join(' '),words:wordTimings});
    let matched = false, lastMatched = null;
    wordSpans.forEach((word, wordIndex) => {
      const timing=positions.get(wordIndex);
      if (timing) {
        matched = true; lastMatched = {timing, wordIndex};
        if (ms >= Number(timing.start) * 1000 && ms <= (Number(timing.end) * 1000 + 240)) active = wordIndex;
      }
    });
    if (matched && lastMatched && ms >= Number(lastMatched.timing.end) * 1000) active = lastMatched.wordIndex;
    if (!matched) {
       const start = Number(lines[index]?.time) || 0;
       const end = backingLineEndMs(index, lines);
      const weights = estimateWordWeights(wordSpans.map(word => word.textContent));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let cursor = Math.max(0, Math.min(1, (ms - start) / Math.max(1, end - start))) * total;
      active = 0;
      while (active < weights.length - 1 && cursor >= weights[active]) cursor -= weights[active++];
    }
  }
  const nextPart=active>=0&&lyricWordEntries(rawText)[active+1]?.joiner?active+1:-1;
  wordSpans.forEach((word,wordIndex)=>{word.classList.toggle('active',wordIndex===active);word.classList.toggle('upcoming',wordIndex===nextPart);});
  const marker = $('lyricBackingWordMarker');
  if (marker && !current.vocalSilenceState?.silent && wordMode && index >= 0 && active >= 0 && wordSpans[active]) {
    const displayRect = marker.parentElement.getBoundingClientRect(), wordRect = wordSpans[active].getBoundingClientRect();
    marker.style.left = `${wordRect.left - displayRect.left + wordRect.width / 2}px`;
    marker.style.top = `${wordRect.top - displayRect.top - 3}px`;
    marker.hidden = false;
    const markerKey = `${index}:${active}`;
    if (current.backingWordMarkerKey !== markerKey) {
      marker.classList.remove('hopping'); void marker.offsetWidth; marker.classList.add('hopping');
      current.backingWordMarkerKey = markerKey;
    }
  } else if (marker) {
    marker.hidden = true;
    current.backingWordMarkerKey = null;
  }
  current.backingLyricIndex = index;
}
function updateLyrics(seconds = 0) {
  if (!current) return;
  const censorTime = seconds + (playing ? (current.engine?.latencySeconds || 0) * (current.engine?.speed || 1) : 0);
  setProfanityMute(!manualSyncState && activeCensorCue(censorTime*1000));
  if (manualSyncState?.mode !== 'silence' && manualSyncState) { if($('lyricSecondLine'))$('lyricSecondLine').hidden=true; renderManualSyncStagePreview(); updateVocalPause(seconds); return; }
  if (!current.lyricLines?.length) {
    if($('lyricSecondLine'))$('lyricSecondLine').hidden=true;
    const showUnsyncedHint=hasStoredLyricText(current), lyricsNode=$('lyrics');
    if (!lyricsNode.querySelector('#lyricPauseIndicator') || lyricsNode.dataset.unsyncedHint !== String(showUnsyncedHint) || lyricsNode.dataset.lyricSongId !== String(current.id)) {
      lyricsNode.innerHTML = showUnsyncedHint
        ? '<span class="lyric-unsynced-hint">Letra salva sem sincronização<br><small>Abra Sync para marcar os tempos</small></span><span class="lyric-pause" id="lyricPauseIndicator" aria-label="Pausa vocal" hidden><i></i><i></i><i></i><span class="lyric-pause-clock" hidden></span></span>'
        : '<span class="lyric-pause" id="lyricPauseIndicator" aria-label="Pausa vocal" hidden><i></i><i></i><i></i><span class="lyric-pause-clock" hidden></span></span>';
      lyricsNode.dataset.unsyncedHint=String(showUnsyncedHint);
      lyricsNode.dataset.lyricSongId=String(current.id);
    }
    updateVocalPause(seconds);
    const miniLine = $('nowLyric'); if (miniLine) { miniLine.textContent = ''; miniLine.hidden = true; }
    updateBackingLyrics(seconds);
    return;
  }
  updateVocalPause(seconds);
  const ms = seconds * 1000;
  const leadRows = lyricPlaybackTracks().lead;
  const activeLead = leadRows.findLast(row=>row.startMs<=ms);
  const index = activeLead?.lineIndex ?? -1;
  const nextIndex = leadRows.find(row=>row.lineIndex>index)?.lineIndex;
  updateBackingLyrics(seconds);
  if (current.lyricIndex === index) { positionVocalPause(seconds, index); updateWordMarker(ms, index); updateParallelLyrics(seconds); updateLyricAdjustmentLabel(); return; }
  current.lyricIndex = index;
  const line = index >= 0 ? current.lyricLines[index]?.text || '' : '';
  const next = nextIndex !== undefined ? current.lyricLines[nextIndex]?.text || '' : '';
  $('lyrics').classList.remove('lyric-slide');
  void $('lyrics').offsetWidth;
  const wordMarkup = current.wordByWordEnabled === false
    ? lyricCensorMarkup(line, 'lyric-censor-word', index)
    : lyricWordMarkup(line, 'lyric-word', index);
  $('lyrics').innerHTML = `<span id="lyricCurrentLine" class="lyric-current-line">${wordMarkup}</span><span class="lyric-pause" id="lyricPauseIndicator" aria-label="Pausa vocal" hidden><i></i><i></i><i></i><span class="lyric-pause-clock" hidden></span></span>${next ? `<span class="next">${lyricWordMarkup(next, 'lyric-word', nextIndex)}</span>` : ''}`;
  $('lyrics').dataset.unsyncedHint='false'; $('lyrics').dataset.lyricSongId=String(current.id);
  updateVocalPause(seconds);
  updateBackingLyrics(seconds);
  const backingNode = $('lyricBackingLine'), nextNode = $('lyrics').querySelector('.next');
  if (backingNode && nextNode) nextNode.before(backingNode);
  $('lyrics').classList.add('lyric-slide');
  positionVocalPause(seconds, index);
  updateWordMarker(ms, index);
  updateParallelLyrics(seconds);
  updateLyricAdjustmentLabel();
  const miniLine = $('nowLyric');
  if (miniLine) { miniLine.textContent = line; miniLine.hidden = !line; }
}

function cleanTrackQuery(song) {
  return (song.title || '').replace(/[_]+/g, ' ').replace(/(?:roformer|karaoke|instrumentals?|vocals?|backing|stem|mt\s*\d+).*/ig, '').replace(/\b(ft|feat)\b/ig, ' ').replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

let lyricCandidates = [];
let lyricsDialogContext = 'current';
let lyricsSearchSequence = 0;
let lyricsSearchController = null;
function openLyricsDialog(context = 'current') {
  lyricsDialogContext = context;
  const source = context === 'draft' ? {title: $('titleInput').value, artist: $('artistInput').value} : current;
  $('lyricsDialogTitle').textContent = context === 'draft' ? 'Adicionar letra à música' : 'Letras sincronizadas';
  $('lyricsQuery').value = source ? [cleanTrackQuery(source), source.artist].filter(Boolean).join(' ').trim() : '';
  $('lyricsPasteInput').value = context === 'draft'
    ? draftLyrics?.plainLyrics || ''
    : current?.plainLyrics || parseSyncedLyrics(current?.syncedLyrics || '').map(line => line.text).join('\n');
  $('lyricsResults').innerHTML = '<div class="lyrics-empty">Pesquise pelo nome da música para encontrar letras.</div>';
  lyricStatus(context === 'draft' ? 'A letra será salva junto com a música.' : current?.syncedLyrics ? `Letra salva: ${current.lyricTrack || current.title}` : 'Busque uma letra sincronizada ou cole sua própria letra.');
  $('lyricsDialog').classList.add('show');
  if ($('lyricsQuery').value.trim()) void searchLyrics(false);
}
function closeLyricsDialog() { $('lyricsDialog').classList.remove('show'); lyricsSearchController?.abort(); }
async function applyPastedLyrics() {
  const text = $('lyricsPasteInput').value.trim();
  if (!text) { lyricStatus('Cole sua letra antes de aplicar.'); $('lyricsPasteInput').focus(); return; }
  const timedLines = parseSyncedLyrics(text);
  const containsTimestamps = /^\s*\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/m.test(text);
  if (containsTimestamps && !timedLines.length) { lyricStatus('Não consegui reconhecer os timestamps LRC. Confira o formato [mm:ss.xx].'); return; }
  const source = lyricsDialogContext === 'draft' ? {title:$('titleInput').value.trim(),artist:$('artistInput').value.trim()} : current;
  const title = source?.title || 'Letra colada';
  await useLyricCandidate({
    trackName:title, artistName:source?.artist || '',
    plainLyrics:containsTimestamps ? timedLines.map(line=>line.text).join('\n') : text,
    syncedLyrics:containsTimestamps ? text : '', lyricProvider:'VoxStage · letra colada'
  }, lyricsDialogContext);
}

async function searchLyrics(automatic = false) {
  const context = automatic ? 'current' : lyricsDialogContext;
  const source = context === 'draft' ? {title: $('titleInput').value, artist: $('artistInput').value} : current;
  if (!source) { lyricStatus('Toque uma música primeiro.'); return; }
  const query = automatic ? [cleanTrackQuery(source), source.artist].filter(Boolean).join(' ').trim() : $('lyricsQuery').value.trim();
  if (!query) { lyricStatus('Digite o título e, se souber, o artista.'); return; }
  const sequence = ++lyricsSearchSequence;
  lyricsSearchController?.abort();
  const controller = lyricsSearchController = new AbortController();
  const sourceId = context === 'draft' ? activeUploadDraftId : source.id;
  const isCurrent = () => sequence === lyricsSearchSequence && !controller.signal.aborted &&
    (context === 'draft' ? activeUploadDraftId === sourceId : current?.id === sourceId) &&
    (automatic || lyricsDialogContext === context && $('lyricsDialog').classList.contains('show'));
  if (!automatic) $('lyricsResults').innerHTML = '<div class="lyrics-empty">Buscando no catálogo…</div>';
  lyricStatus(`Buscando “${query}”…`);
  try {
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!isCurrent()) return;
      response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {signal: controller.signal, headers: {'X-User-Agent': 'VoxStage/1.1 (local karaoke player)'}});
      if (response.status !== 503 || attempt === 3) break;
      if (!isCurrent()) return;
      lyricStatus(`Serviço de letras temporariamente indisponível. Tentando novamente (${attempt + 1}/3)…`);
      const retryAfter = Number(response.headers.get('Retry-After')) || 0;
      const delay = Math.min(8000, Math.max(1000 * 2 ** attempt, retryAfter * 1000));
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Busca cancelada', 'AbortError')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, delay);
        controller.signal.addEventListener('abort', abort, {once: true});
      });
    }
    if (!isCurrent()) return;
    if (response.status === 429) throw new Error('Limite de buscas atingido. Aguarde um pouco e tente novamente.');
    if (!response.ok) throw new Error(`Serviço de letras respondeu ${response.status}.`);
    const results = await response.json();
    if (!isCurrent()) return;
    lyricCandidates = results.filter(result => result.syncedLyrics || result.plainLyrics);
    if (!lyricCandidates.length) {
      lyricStatus('Não encontrei letra para essa busca.');
      if (!automatic) $('lyricsResults').innerHTML = '<div class="lyrics-empty">Nenhuma letra encontrada. Tente artista + título ou confira a grafia.</div>';
      else $('lyrics').innerHTML = '<span>Letra não encontrada</span><br><span class="next">Busque outra versão pelo botão Letras</span>';
      return;
    }
    if (automatic) {
      const synced = lyricCandidates.find(result => result.syncedLyrics);
      if (synced) await useLyricCandidate(synced, 'current');
      else { lyricStatus('Encontrei apenas letras sem sincronia.'); $('lyrics').innerHTML = '<span>Letra sem sincronização</span><br><span class="next">Escolha uma versão sincronizada pelo botão Letras</span>'; }
      return;
    }
    $('lyricsResults').innerHTML = lyricCandidates.map((result, index) => `<button class="lyrics-result" data-lyric-index="${index}"><span class="lyrics-result-main"><strong>${esc(result.trackName || 'Faixa sem título')}</strong><small>${esc(result.artistName || 'Artista desconhecido')}${result.albumName ? ` · ${esc(result.albumName)}` : ''}</small></span><span class="lyrics-badge ${result.syncedLyrics ? 'synced' : ''}">${result.syncedLyrics ? 'Sincronizada' : 'Sem tempos'}</span><span class="lyrics-use">Usar letra →</span></button>`).join('');
    document.querySelectorAll('[data-lyric-index]').forEach(button => button.onclick = () => useLyricCandidate(Number(button.dataset.lyricIndex), context));
    lyricStatus(`${lyricCandidates.length} resultado(s). Escolha a versão que corresponde à música.`);
  } catch (error) {
    if (!isCurrent() || error.name === 'AbortError') return;
    console.error(error); lyricStatus(error.message || 'Não consegui acessar o serviço de letras.');
    if (!automatic) $('lyricsResults').innerHTML = '<div class="lyrics-empty">Não foi possível conectar. Confira a internet e tente novamente.</div>';
    else $('lyrics').innerHTML = '<span>Não foi possível buscar a letra</span><br><span class="next">Tente novamente pelo botão Letras</span>';
  }
}

async function useLyricCandidate(matchOrIndex, context = lyricsDialogContext) {
  const match = typeof matchOrIndex === 'number' ? lyricCandidates[matchOrIndex] : matchOrIndex;
  if (!match) return;
  const lines = parseSyncedLyrics(match.syncedLyrics);
  const plainLyrics = match.plainLyrics || (match.syncedLyrics ? match.syncedLyrics.split(/\r?\n/).map(row => row.replace(/^\s*\[[^\]]+\]\s*/, '')).join('\n') : '');
  if (!lines.length && !plainLyrics.trim()) { lyricStatus('Esta versão não trouxe texto de letra. Escolha outra.'); return; }
  let selection = {syncedLyrics: lines.length ? match.syncedLyrics : '', plainLyrics, lyricTrack: match.trackName || current?.title || $('titleInput').value, lyricArtist: match.artistName || current?.artist || $('artistInput').value, lyricProvider: match.lyricProvider || 'LRCLIB', lyricVoices:null, wordTimings: [], parallelWordTimings: [], parallelLineStarts: [], parallelLineEnds: [], parallelSyncedLyrics:'',parallelPlainLyrics:'',lyricLineEnds: [], backingSyncedLyrics: '', backingPlainLyrics: '', backingWordTimings: [], backingLineEnds: []};
  const incomingVoices=VoxStageLyrics.fromLegacy(selection,legacyUnifiedLyricsForSong(selection),lyricWordEntries);
  selection={...selection,...VoxStageLyrics.storage(incomingVoices)};
  if (context === 'draft') {
    draftLyrics = selection;
    $('draftLyricsStatus').textContent = `Letra selecionada: ${match.trackName} — ${match.artistName}${lines.length ? '' : ' · precisa sincronizar'}`;
    captureUploadDraft();
    closeLyricsDialog(); return;
  }
  if (!current) return;
  if(!lines.length && (current.lyricLines?.length || current.lyricVoices)) {
    const voices=VoxStageLyrics.fromLegacy(current,current.lyricLines?current:unifiedLyricsForSong(current),lyricWordEntries);
    const incoming=VoxStageLyrics.fromLegacy(selection,{lyricLines:[]},lyricWordEntries);
    for(const track of VoxStageLyrics.tracks)if(incoming[track].length)
      voices[track]=VoxStageLyrics.reconcile(voices[track],VoxStageLyrics.editorText(incoming[track]),track);
    const projected=VoxStageLyrics.project(voices);
    selection={...selection,...VoxStageLyrics.storage(voices),lyricAdjustments:projected.lyricAdjustments,
      profanityMarks:remapLyricOccurrences(current.profanityMarks,current.lyricLines||[],projected.lyricLines),
      profanityCues:remapLyricOccurrences(current.profanityCues,current.lyricLines||[],projected.lyricLines)};
  }
  Object.assign(current, selection); current.lyricAdjustments = {}; current.lyricLines = lines; current.lyricIndex = null; current.vocalSilenceEnds = []; current.vocalSilenceState = null;
  if(selection.lyricVoices)Object.assign(current,VoxStageLyrics.project(selection.lyricVoices));
  current.playbackTracks=null;
  updateLyrics(playbackPosition());
  lyricStatus(lines.length ? `Sincronizada: ${match.trackName} — ${match.artistName}` : `Letra sem tempos: ${match.trackName} — ${match.artistName}. Sincronize por linha para usar na apresentação.`);
  closeLyricsDialog();
  const song = songs.find(item => item.id === current.id);
  if (song) {
    Object.assign(song, selection);
    try { await api('/api/library', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(song)}); }
    catch (error) { console.error('Não foi possível guardar a letra em library.json', error); }
  }
  if (!lines.length && !current.lyricLines?.length) openManualLineSync();
}

playSong = async function (id) {
  const song = songs.find(item => item.id === id); if (!song) return;
  stopSong(); current = {...song, buffers: {}}; waveformPeaks = null;
  updateSongVolumeControls(song);
  updateWordSyncToggle();
  setPlayBusy(true);
  $('nowTitle').textContent = song.title; $('nowArtist').textContent = song.artist || '—'; setMiniStage(song); $('dispTrack').textContent = `${song.title}${song.artist ? ' · ' + song.artist : ''}`;
  if (mobileStageArtwork) setMobileStageArtwork(song);
  if ($('nowLyric')) { $('nowLyric').textContent = ''; $('nowLyric').hidden = true; }
  const videoBg = $('displayVideoBg');
  if (videoBg) {
    videoBg.muted = true; videoBg.defaultMuted = true; videoBg.volume = 0; videoBg.loop = true; videoBg.playsInline = true;
    if (song.backgroundVideo) { videoBg.src = mediaUrl(song.backgroundVideo); videoBg.classList.add('active'); }
    else { videoBg.pause(); videoBg.removeAttribute('src'); videoBg.load(); videoBg.classList.remove('active'); }
    syncMutedVideoBackground();
  }
  const previewImage = song.backgroundVideo && !mobileNative ? null : song.background || song.cover;
  $('displayBg').style.backgroundImage = previewImage ? `url("${mediaUrl(previewImage)}")` : '';
  $('displayBg').style.backgroundSize = 'cover';
  $('displayBg').style.backgroundPosition = 'center';
  $('displayBg').style.opacity = previewImage ? '.78' : '.5';
  const unifiedLyrics = unifiedLyricsForSong(current);
  current.syncedLyrics = unifiedLyrics.syncedLyrics; current.plainLyrics = unifiedLyrics.plainLyrics;
  current.wordTimings = unifiedLyrics.wordTimings; current.parallelWordTimings = unifiedLyrics.parallelWordTimings;
  current.backingWordTimings = unifiedLyrics.backingWordTimings; current.lyricLineEnds = unifiedLyrics.lyricLineEnds;
  current.backingLineEnds = unifiedLyrics.backingLineEnds; current.parallelLineStarts = unifiedLyrics.parallelLineStarts;
  current.parallelLineEnds = unifiedLyrics.parallelLineEnds || [];
  if(unifiedLyrics.lyricAdjustments)current.lyricAdjustments=unifiedLyrics.lyricAdjustments;
  current.lyricLines = unifiedLyrics.lyricLines; current.lyricIndex = null; current.vocalSilenceState = null;
  if (current.lyricLines.length) { lyricStatus(`Sincronizada: ${song.lyricTrack || song.title}`); updateLyrics(0); }
  else if (hasStoredLyricText(current)) { lyricStatus('Letra salva sem sincronização. Abra Sync para marcar os tempos.'); $('lyrics').innerHTML = '<span>Letra sem sincronização</span><br><span class="next">Abra Sync para marcar os tempos</span>'; }
  else { lyricStatus('Ainda sem letra sincronizada.'); $('lyrics').innerHTML = '<span>Buscando a letra</span><br><span class="next">via LRCLIB…</span>'; searchLyrics(true); }
  try {
    toast('Preparando os stems…');
    await ensureAudioEngine();
    const files = [['Inst', song.inst || song.source], ['Lead', song.lead], ['Back', song.back]].filter(([, filename]) => filename);
    const decoded = await Promise.all(files.map(([, filename]) => decodeStem(filename)));
    if (current?.id !== song.id) return;
    files.forEach(([key], index) => { current.buffers[key] = decoded[index]; });
    if (!current.buffers.Inst) throw new Error('Esta faixa não tem instrumental.');
    updateManualSilenceControls();
    calculateWaveform(current.buffers.Inst);
    playbackBase = 0;
    startAudioSources(0);
  } catch (error) {
    console.error('Falha ao preparar o motor de áudio', error);
    playing = false; setPlayBusy(false);
    toast(`Não consegui preparar o áudio: ${error.message || 'verifique os arquivos e o navegador.'}`);
  }
};

$('saveSong').onclick = saveSong;
$('navRecent')?.remove();
document.querySelector('.sidebar')?.remove();
document.querySelector('.app').style.display = 'block';
document.querySelector('.main').style.maxWidth = '1250px';
document.querySelector('.player').style.left = '0';
document.querySelector('.profile').outerHTML = '<button class="settings-top" id="settingsTop" title="Configurações">⚙</button>';
const remoteOpenButton = document.createElement('button'); remoteOpenButton.type = 'button'; remoteOpenButton.className = 'btn secondary remote-open-button'; remoteOpenButton.id = 'remoteOpen'; remoteOpenButton.title = 'Conectar com o celular'; remoteOpenButton.setAttribute('aria-label', 'Conectar com o celular'); remoteOpenButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6.5" y="2.5" width="11" height="19" rx="2.2"></rect><path d="M10 5.5h4M11 18.5h2"></path></svg><span>Conectar com o celular</span>';
if (!mobileNative) { const actions=document.createElement('div'); actions.className='hero-actions'; $('heroAdd').insertAdjacentElement('beforebegin',actions); actions.append($('heroAdd'),remoteOpenButton); }
const remoteIconStyle = document.createElement('style');
remoteIconStyle.textContent = '.hero-actions{display:flex;align-items:center;flex-wrap:wrap;gap:9px}.hero-actions .remote-open-button{display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;width:auto;height:auto;min-height:36px;padding:9px 13px;white-space:nowrap}.hero-actions .remote-open-button span{display:inline;white-space:nowrap}.remote-open-button svg{display:block;flex:none;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}';
document.head.append(remoteIconStyle);
const processingSettings = (() => { try { return JSON.parse(localStorage.getItem('voxstage-processing-settings') || '{}'); } catch { return {}; } })();
processingSettings.mvsepModelId ||= '12';
processingSettings.mvsepOptionsByModel ||= {};
delete processingSettings.localAudioBackend;
delete processingSettings.execution;
processingSettings.showUpcomingWordPreview ??= false;
processingSettings.muteProfanity ??= false;
delete processingSettings.profanityMuteStartOffsetSeconds;
delete processingSettings.profanityMuteEndOffsetSeconds;
processingSettings.lyricsScale ??= 1;
processingSettings.lyricsScaleTv ??= processingSettings.lyricsScale;
processingSettings.seekStepSeconds ??= 10;
if (![5, 10, 15, 30].includes(Number(processingSettings.seekStepSeconds))) processingSettings.seekStepSeconds = 10;
processingSettings.themeCustomColor ||= '#d4fb69';
if(!/^#[0-9a-f]{6}$/i.test(processingSettings.voice2Color||''))processingSettings.voice2Color='#ff79c8';
processingSettings.voicesOverlapGradient ??= true;
processingSettings.useCoverTheme ??= false;
delete processingSettings.method;
delete processingSettings.alignmentEngine;
delete processingSettings.silenceThresholdDb;
processingSettings.pauseThresholdSeconds ??= 1.5;
if (![0.5, 1, 1.5, 2, 3].includes(Number(processingSettings.pauseThresholdSeconds))) processingSettings.pauseThresholdSeconds = 1.5;
youtubeImport.hidden = false;
const settingsDialog = document.createElement('div');
settingsDialog.className = 'processing-dialog'; settingsDialog.id = 'processingDialog';
settingsDialog.innerHTML = `<section class="processing-card" role="dialog" aria-modal="true" aria-labelledby="processingTitle"><header><div><span class="processing-kicker">VOXSTAGE</span><h2 id="processingTitle">Configurações</h2></div><button class="lyrics-close" id="closeProcessing" aria-label="Fechar">×</button></header><div class="processing-section"><b>Quanto resíduo há no stem vocal?</b><p>O VoxStage usa este perfil para decidir quando o vocal realmente parou. Se a voz estiver sendo cortada cedo, escolha um perfil mais baixo.</p><label class="silence-setting"><select id="silenceThreshold"><option value="-42">Pouco resíduo · preserva vocais baixos</option><option value="-34">Normal</option><option value="-26">Muito resíduo · ignora ruído mais alto</option></select><small id="silenceThresholdValue">Normal</small></label></div><div class="processing-section"><b>Método para preparar os stems</b><p>Importe stems manualmente ou baixe uma faixa do YouTube com yt-dlp e separe-a online pela MVSep.</p><div class="processing-options methods"><label><input type="radio" name="method" value="manual"><span><strong>Arquivos manuais</strong><small>Disponível agora</small></span></label><label class="unavailable"><input type="radio" name="method" value="local" disabled><span><strong>Separação local</strong><small>Em preparação</small></span></label><label><input type="radio" name="method" value="mvsep"><span><strong>API MVSep</strong><small>Busca no YouTube · separação online</small></span></label></div></div><footer><button class="btn" id="saveProcessing">Salvar preferências</button></footer></section>`;
settingsDialog.querySelector('.processing-options.methods').closest('.processing-section').remove();
const pauseSection = settingsDialog.querySelector('#silenceThreshold').closest('.processing-section');
pauseSection.querySelector('b').textContent = 'Tempo mínimo de silêncio vocal';
pauseSection.querySelector('p').textContent = 'Define quando uma pausa vocal oculta os marcadores de palavra.';
const pauseThresholdSelect = pauseSection.querySelector('#silenceThreshold');
pauseThresholdSelect.id = 'pauseThreshold';
pauseThresholdSelect.innerHTML = `<option value="0.5">0,5 s · pausas bem curtas</option><option value="1">1 s · pausas curtas</option><option value="1.5">1,5 s · recomendado</option><option value="2">2 s · pausas longas</option><option value="3">3 s · silêncios prolongados</option>`;
pauseSection.querySelector('#silenceThresholdValue').id = 'pauseThresholdValue';
pauseSection.querySelector('#pauseThresholdValue').hidden = true;
const mvsepKeySection = document.createElement('div'); mvsepKeySection.className = 'processing-section mvsep-key-section';
mvsepKeySection.innerHTML = `<b>Chave da API MVSep</b><p>${mobileNative ? 'A chave fica no armazenamento privado deste app Android. Não cole sua chave aqui no chat.' : 'No Windows, ela é protegida para sua conta e fica neste computador. Não cole sua chave aqui no chat.'}</p><div class="mvsep-key-row"><input id="mvsepToken" type="password" autocomplete="new-password" placeholder="Cole sua chave da API"><button class="btn secondary" id="removeMvsepToken" type="button">Remover</button></div><small id="mvsepKeyStatus" class="mvsep-key-status">Verificando configuração…</small>`;
const mvsepModelSection = document.createElement('div'); mvsepModelSection.className = 'processing-section mvsep-model-section';
mvsepModelSection.innerHTML = `<b>Modelo de separação MVSep</b><p>Escolha o algoritmo online para separar os vocais e o instrumental. As opções são carregadas do catálogo oficial.</p><select id="mvsepModel" class="mvsep-model-select" aria-label="Modelo de separação MVSep"><option value="">Carregando modelos…</option></select><div id="mvsepModelOptions" class="mvsep-model-options"></div><small id="mvsepModelStatus" class="mvsep-key-status">Carregando modelos disponíveis…</small>`;
settingsDialog.querySelector('.processing-card footer').before(mvsepModelSection);
settingsDialog.querySelector('.processing-card footer').before(mvsepKeySection);
document.body.append(settingsDialog);
const languageSection = document.createElement('div'); languageSection.className = 'processing-section language-section';
languageSection.innerHTML = `<b>Idioma da interface</b><p>Escolha o idioma usado nos menus, mensagens e configurações do VoxStage.</p><select id="interfaceLanguage" class="mvsep-model-select" aria-label="Idioma da interface"><option value="pt-BR">Português (Brasil)</option><option value="en-US">English</option></select>`;
settingsDialog.querySelector('.processing-card footer').before(languageSection);
languageSection.querySelector('#interfaceLanguage').onchange = event => setInterfaceLanguage(event.target.value);
const themeSection = document.createElement('div'); themeSection.className = 'processing-section theme-section';
themeSection.innerHTML = `<b>Tema de cores</b><p>Muda os destaques do app, a palavra ativa e os indicadores de letra no palco.</p><select id="interfaceTheme" class="mvsep-model-select" aria-label="Tema de cores"><option value="lime">Lima · padrão</option><option value="ocean">Oceano</option><option value="violet">Violeta</option><option value="rose">Rosa</option><option value="amber">Âmbar</option></select>`;
settingsDialog.querySelector('.processing-card footer').before(themeSection);
themeSection.querySelector('#interfaceTheme').onchange = event => setAppTheme(event.target.value);
themeSection.querySelector('#interfaceTheme').insertAdjacentHTML('beforeend', '<option value="custom">Personalizado</option>');
themeSection.insertAdjacentHTML('beforeend', `<label class="theme-custom-row">Cor RGB <input id="themeCustomColor" type="color" value="${processingSettings.themeCustomColor || '#d4fb69'}" aria-label="Cor personalizada do tema"></label><button class="btn secondary" id="themeFromCover" type="button">Usar cor da capa atual</button><label class="lyrics-scale-row">Escala das letras · vertical <input id="lyricsScale" type="range" min="0.75" max="1.65" step="0.05" value="${processingSettings.lyricsScale || 1}"><output id="lyricsScaleValue">${Math.round((processingSettings.lyricsScale || 1) * 100)}%</output></label><label class="lyrics-scale-row">Escala das letras · TV/horizontal <input id="lyricsScaleTv" type="range" min="0.75" max="1.65" step="0.05" value="${processingSettings.lyricsScaleTv || 1}"><output id="lyricsScaleTvValue">${Math.round((processingSettings.lyricsScaleTv || 1) * 100)}%</output></label>`);
themeSection.querySelector('#themeCustomColor').oninput = event => { processingSettings.themeCustomColor = event.target.value; setAppTheme('custom'); localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); };
themeSection.querySelector('#themeCustomColor').closest('label').insertAdjacentHTML('afterend',`<label class="theme-custom-row">Cor da Voz 2 <input id="voice2Color" type="color" value="${processingSettings.voice2Color}" aria-label="Cor da Voz 2"></label><label class="theme-custom-row"><span>Gradiente quando as vozes cantam juntas</span><input id="voicesOverlapGradient" type="checkbox" ${processingSettings.voicesOverlapGradient?'checked':''}></label><div class="voice-color-preview" aria-label="Prévia das cores das vozes"><span class="preview-voice1">Voz 1</span><span class="preview-voice2">Voz 2</span><span class="preview-voices-together">Juntas</span></div>`);
for(const setting of ['voice2Color','voicesOverlapGradient'])themeSection.querySelector('#'+setting).addEventListener(setting==='voice2Color'?'input':'change',event=>{
  processingSettings[setting]=event.target.type==='checkbox'?event.target.checked:event.target.value;
  localStorage.setItem('voxstage-processing-settings',JSON.stringify(processingSettings));
  applyVoiceTheme();
  if(current)updateParallelLyrics(playbackPosition());
});
themeSection.querySelector('#lyricsScale').oninput = event => { processingSettings.lyricsScale = Number(event.target.value); document.documentElement.style.setProperty('--lyrics-scale-portrait', event.target.value); $('lyricsScaleValue').textContent = `${Math.round(Number(event.target.value) * 100)}%`; localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); };
themeSection.querySelector('#lyricsScaleTv').oninput = event => { processingSettings.lyricsScaleTv = Number(event.target.value); document.documentElement.style.setProperty('--lyrics-scale-tv', event.target.value); $('lyricsScaleTvValue').textContent = `${Math.round(Number(event.target.value) * 100)}%`; localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); };
themeSection.querySelector('#themeFromCover').onclick = async () => {
  const artwork = current?.cover || current?.background || current?.artwork;
  if (!artwork) { toast('Abra uma música com capa primeiro.'); return; }
  try {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.src = mediaUrl(artwork);
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', {willReadFrequently:true}); context.drawImage(image, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    const color = `#${[red,green,blue].map(value => value.toString(16).padStart(2,'0')).join('')}`;
    processingSettings.themeCustomColor = color; themeSection.querySelector('#themeCustomColor').value = color; setAppTheme('custom'); localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings));
    toast('Cor do tema extraída da capa atual.');
  } catch { toast('Não consegui ler esta imagem de capa.'); }
};
const settingsCard = settingsDialog.querySelector('.processing-card');
const settingsFooter = settingsCard.querySelector('footer');
const settingsTabs = document.createElement('nav'); settingsTabs.className = 'settings-tabs'; settingsTabs.setAttribute('role', 'tablist'); settingsTabs.setAttribute('aria-label', 'Seções de configurações');
settingsTabs.innerHTML = `<button type="button" role="tab" id="settingsTabPlayback" aria-controls="settingsPanePlayback" class="active" data-settings-tab="playback" aria-selected="true">Reprodução</button><button type="button" role="tab" id="settingsTabCloud" aria-controls="settingsPaneCloud" data-settings-tab="cloud" aria-selected="false">Nuvem</button><button type="button" role="tab" id="settingsTabVisual" aria-controls="settingsPaneVisual" data-settings-tab="visual" aria-selected="false">Visual</button>`;
settingsTabs.insertAdjacentHTML('beforeend','<button type="button" role="tab" id="settingsTabData" aria-controls="settingsPaneData" data-settings-tab="data" aria-selected="false">Dados e backup</button>');
settingsTabs.insertAdjacentHTML('beforeend','<button type="button" role="tab" id="settingsTabAbout" aria-controls="settingsPaneAbout" data-settings-tab="about" aria-selected="false">Sobre</button>');
settingsTabs.insertAdjacentHTML('beforeend','<button type="button" role="tab" id="settingsTabDebug" aria-controls="settingsPaneDebug" data-settings-tab="debug" aria-selected="false">Debug</button>');
function isDiagnosticBuild(info) {
  return /-(?:rc|snapshot|test|debug)(?:[.-]|$)/i.test(info?.version||'') || /\b(?:RC|snapshot|debug)\b/i.test(info?.label||'');
}
let nativeDebugBuild=window.VoxStageDebugEnabled===true;
let settingsDebugEnabled=nativeDebugBuild||isDiagnosticBuild(window.VoxStageBuildInfo);
settingsTabs.querySelector('[data-settings-tab="debug"]').hidden=!settingsDebugEnabled;
const settingsPaneIds = {playback:'settingsPanePlayback',cloud:'settingsPaneCloud',visual:'settingsPaneVisual',lyrics:'settingsPaneLyrics',data:'settingsPaneData',about:'settingsPaneAbout',debug:'settingsPaneDebug'};
const settingsPanes = Object.fromEntries(['playback','cloud','visual','data','about','debug'].map(name => { const pane = document.createElement('div'); pane.className = 'settings-pane'; pane.id = settingsPaneIds[name]; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', `settingsTab${name[0].toUpperCase()}${name.slice(1)}`); pane.dataset.settingsPane = name; return [name, pane]; }));
if (mobileNative) {
  document.body.classList.add('mobile-mvsep-ready');
}
settingsCard.querySelector('header').insertAdjacentElement('afterend', settingsTabs);
settingsCard.insertBefore(settingsPanes.playback, settingsFooter);
settingsCard.insertBefore(settingsPanes.cloud, settingsFooter);
settingsCard.insertBefore(settingsPanes.visual, settingsFooter);
settingsCard.insertBefore(settingsPanes.data, settingsFooter);
settingsCard.insertBefore(settingsPanes.about, settingsFooter);
settingsCard.insertBefore(settingsPanes.debug, settingsFooter);
const debugFormatSection=document.createElement('section');debugFormatSection.className='processing-section';
debugFormatSection.innerHTML='<b>Formato da interface</b><p>Teste os menus e o palco de cada formato neste aparelho. Salve suas edições antes de aplicar: a interface será recarregada e a reprodução será interrompida.</p><label class="theme-custom-row"><span>Formato</span><select id="debugInterfaceFormat"><option value="auto">Automático (aparelho)</option><option value="pc">PC</option><option value="tv">TV</option><option value="phone">Mobile</option></select></label><button type="button" id="debugApplyInterfaceFormat" class="btn secondary">Aplicar formato</button>';
settingsPanes.debug.append(debugFormatSection);
$('debugInterfaceFormat').value=window.VoxStageInterfaceFormat||'auto';
$('debugApplyInterfaceFormat').onclick=()=>{
  if(!settingsDebugEnabled)return;
  const format=$('debugInterfaceFormat').value;if(!['auto','pc','tv','phone'].includes(format))return;
  try{if(format==='auto')localStorage.removeItem('voxstage-debug-format');else localStorage.setItem('voxstage-debug-format',format);captureUploadDraft();location.reload();}catch{toast('Não consegui guardar o formato de teste.');}
};
settingsPanes.about.innerHTML=`<section class="about-app"><img src="branding/voxstage-animated.svg" alt="Logo do VoxStage" width="112" height="112"><h3>VoxStage</h3><span id="aboutAppVersion" class="about-version" aria-label="Versão do aplicativo"></span><p>Feito por <a href="https://github.com/kaua0f0m" target="_blank" rel="noopener noreferrer">kaua0f0m</a></p><p>Inspirado no software de <a href="https://www.youtube.com/@funkyblackcat" target="_blank" rel="noopener noreferrer">FunkyBlackCat</a></p><details class="about-credits"><summary>Atribuições e licenças</summary><div><p>Tipografia: Nunito, Manrope, DM Sans, Outfit e Rubik · SIL Open Font License.</p><p>Velocidade e tom: SoundTouchJS · MPL-2.0.</p><p>Capas: Cover Art Archive · MusicBrainz e Internet Archive; catálogo iTunes; miniaturas do YouTube.</p><p>Downloads: yt-dlp e yt-dlp-android · licenças dos projetos originais.</p><p>Letras: LRCLIB. Separação na nuvem: MVSEP.</p><p>As licenças completas acompanham o pacote em THIRD_PARTY_NOTICES.md e nos arquivos de cada componente.</p></div></details></section>`;
settingsPanes.about.querySelectorAll('a').forEach(link=>link.onclick=event=>{
  if(mobileNative && window.VoxStageMedia?.openAuthorLink){event.preventDefault();window.VoxStageMedia.openAuthorLink(link.href);}
  else if(window.__TAURI__?.core?.invoke && !mobileNative){
    event.preventDefault();
    void api('/api/about/open-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:link.href})}).catch(error=>toast(error.message||'Não consegui abrir o navegador.'));
  }
});
$('aboutAppVersion').textContent=window.VoxStageBuildInfo?.label||'Versão indisponível';
async function refreshAboutVersion() {
  try {
    const response=await fetch('build-info.json',{cache:'no-store'});
    if(!response.ok)return;
    const info=await response.json();
    if(typeof info.label==='string'&&info.label.length<100) { $('aboutAppVersion').textContent=info.label; updateDebugAvailability(info); }
  } catch {} // The bundled script also identifies the build while offline.
}
pauseSection.dataset.settingsPage = 'playback';
mvsepModelSection.dataset.settingsPage = 'cloud'; mvsepKeySection.dataset.settingsPage = 'cloud';
languageSection.dataset.settingsPage = 'visual'; themeSection.dataset.settingsPage = 'visual';
const lyricAppearanceSection=document.createElement('section');
lyricAppearanceSection.className='processing-section lyric-appearance-section';
lyricAppearanceSection.innerHTML='<b>Letras e vozes</b><p>A cor da Voz 1 acompanha o tema escolhido em Visual. Personalize aqui a Voz 2, a sobreposição das vozes e o tamanho das letras.</p>';
for(const id of ['voice2Color','voicesOverlapGradient'])lyricAppearanceSection.append($(id).closest('label'));
lyricAppearanceSection.append(themeSection.querySelector('.voice-color-preview'));
for(const id of ['lyricsScale','lyricsScaleTv'])lyricAppearanceSection.append($(id).closest('label'));
lyricAppearanceSection.insertAdjacentHTML('beforeend','<p role="note">Estas preferências valem para todas as músicas. Os textos e os tempos de Voz 1, Voz 2 e Backing são editados individualmente no editor de letras de cada música.</p>');
settingsPanes.visual.append(lyricAppearanceSection);
const lyricAppearanceStyle=document.createElement('style');
lyricAppearanceStyle.textContent='.lyric-appearance-section{min-width:0}.lyric-appearance-section .lyrics-scale-row,.lyric-appearance-section .theme-custom-row{flex-wrap:wrap}.lyric-appearance-section .lyrics-scale-row input{min-width:0;flex:1 1 90px}.lyric-appearance-section input[type=color]{flex:0 0 50px}';
document.head.append(lyricAppearanceStyle);
settingsCard.querySelectorAll(':scope > .processing-section').forEach(section => settingsPanes[section.dataset.settingsPage || 'local'].append(section));
const wordPreviewSection = document.createElement('section'); wordPreviewSection.className = 'processing-section word-preview-section';
wordPreviewSection.innerHTML = `<b>Prévia da próxima palavra</b><label class="experimental-feature-row"><span><strong>Mostrar próxima palavra</strong></span><input type="checkbox" id="showUpcomingWordPreview" aria-label="Mostrar próxima palavra durante a reprodução"><i aria-hidden="true"><i></i></i></label>`;
settingsPanes.playback.append(wordPreviewSection);
const seekStepSection = document.createElement('section'); seekStepSection.className = 'processing-section';
seekStepSection.dataset.settingsPage = 'playback';
seekStepSection.innerHTML = `<b>Avanço rápido</b><p>Escolha quanto os botões de voltar e avançar pulam na música.</p><select id="seekStepSeconds" class="mvsep-model-select"><option value="5">5 segundos</option><option value="10">10 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option></select>`;
settingsPanes.playback.append(seekStepSection);
seekStepSection.querySelector('#seekStepSeconds').value = String(processingSettings.seekStepSeconds);
seekStepSection.querySelector('#seekStepSeconds').onchange = event => { processingSettings.seekStepSeconds = Number(event.target.value); localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); updateSeekStepButtons(); };
const wordPreviewToggle = wordPreviewSection.querySelector('#showUpcomingWordPreview');
wordPreviewToggle.checked = processingSettings.showUpcomingWordPreview === true;
const profanitySection = document.createElement('section'); profanitySection.className = 'processing-section profanity-section';
profanitySection.dataset.settingsPage = 'playback';
profanitySection.innerHTML = `<b>Palavrões</b><p>Escolha cada ocorrência no Sync. O mute usa somente o início e o fim marcados para aquela palavra; não altera a sincronia da letra.</p><label class="experimental-feature-row"><span><strong>Borrar palavras escolhidas na letra</strong><small>Aplica desfoque às ocorrências selecionadas.</small></span><input type="checkbox" id="markProfanity"><i aria-hidden="true"><i></i></i></label><label class="experimental-feature-row"><span><strong>Silenciar os vocais nas palavras marcadas</strong><small>Usa apenas os intervalos da censura sincronizada.</small></span><input type="checkbox" id="muteProfanity"><i aria-hidden="true"><i></i></i></label>`;
settingsPanes.playback.append(profanitySection);
profanitySection.querySelector('#markProfanity').checked = processingSettings.markProfanity === true;
profanitySection.querySelector('#muteProfanity').checked = processingSettings.muteProfanity === true;
for (const id of ['markProfanity','muteProfanity']) profanitySection.querySelector(`#${id}`).onchange = event => {
  processingSettings[id] = event.target.checked;
  localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings));
  if (current) { current.lyricIndex = null; updateLyrics(playbackPosition()); }
};
const vocalFxSection = document.createElement('section'); vocalFxSection.className = 'processing-section vocal-fx-section';
vocalFxSection.innerHTML = `<b>Retorno e efeitos de voz</b><p>Ouça sua própria voz pelo fone de ouvido enquanto canta, com efeitos de palco, compressão e eco de estúdio.</p><button type="button" class="btn secondary" id="settingsOpenVocalFx">🎤 Configurar retorno e efeitos</button>`;
settingsPanes.playback.append(vocalFxSection);
vocalFxSection.querySelector('#settingsOpenVocalFx').onclick = () => window.VoxStageVocalMonitor?.openDialog();
wordPreviewToggle.onchange = () => {
  processingSettings.showUpcomingWordPreview = wordPreviewToggle.checked;
  try { localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); } catch {}
  if (current) updateLyrics(playbackPosition());
};
let activeSettingsTab = 'playback';
function selectSettingsTab(name) {
  if(name==='lyrics')name='visual'; // Existing links lead to the combined appearance page.
  activeSettingsTab = settingsPanes[name] && !(name==='debug'&&!settingsDebugEnabled) ? name : 'playback';
  settingsTabs.querySelectorAll('[data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === activeSettingsTab;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
  });
  Object.entries(settingsPanes).forEach(([key, pane]) => { pane.hidden = key !== activeSettingsTab; });
  if(activeSettingsTab==='about')void refreshAboutVersion();
}
settingsTabs.querySelectorAll('[data-settings-tab]').forEach(button => button.onclick = () => selectSettingsTab(button.dataset.settingsTab));
selectSettingsTab(activeSettingsTab);
function updateDebugAvailability(info=window.VoxStageBuildInfo) {
  settingsDebugEnabled=nativeDebugBuild||isDiagnosticBuild(info);
  settingsTabs.querySelector('[data-settings-tab="debug"]').hidden=!settingsDebugEnabled;
  if(!settingsDebugEnabled&&activeSettingsTab==='debug')selectSettingsTab('playback');
}
if(window.VoxStageDebugEnabled===undefined&&window.__TAURI__?.core?.invoke) {
  const debugMode = mobileNative ? window.__TAURI__.core.invoke('is_debug_build') : api('/api/build-mode').then(result=>result.debug===true);
  void debugMode.then(value=>{nativeDebugBuild=value===true;updateDebugAvailability();}).catch(()=>{});
}
const settingsStyle = document.createElement('style');
settingsStyle.textContent = `.processing-dialog{position:fixed;inset:0;z-index:35;display:none;place-items:center;padding:18px;background:#08090bd9;backdrop-filter:blur(12px)}.processing-dialog.show{display:grid}.processing-card{width:min(820px,100%);max-height:90vh;overflow:auto;padding:23px;border-radius:18px;background:linear-gradient(145deg,#202124,#141416);border:1px solid #414148;box-shadow:0 24px 80px #000b}.processing-card header,.processing-card footer{display:flex;align-items:center;justify-content:space-between}.processing-card h2{font:700 22px Manrope;margin:5px 0 0}.processing-kicker{font-size:9px;letter-spacing:1.8px;color:var(--lime);font-weight:700}.processing-section{margin-top:23px}.processing-section>b{font-size:13px}.processing-section p{margin:7px 0 12px;color:#9999a1;font-size:11px;line-height:1.5}.processing-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.processing-options label{display:flex;gap:8px;align-items:flex-start;min-width:0;padding:10px;background:#18181b;border:1px solid #35353b;border-radius:10px;cursor:pointer}.processing-options label:has(input:checked){border-color:#728b3a;background:#22271b}.processing-options input{accent-color:var(--lime);margin:2px 0 0}.processing-options span,.processing-options strong,.processing-options small{display:block}.processing-options strong{font-size:11px}.processing-options small{margin-top:4px;color:#95959c;font-size:9px;line-height:1.4}.processing-options .unavailable{opacity:.48;cursor:not-allowed}.silence-setting{display:flex;align-items:center;gap:14px;padding:12px;background:#18181b;border:1px solid #35353b;border-radius:10px}.silence-setting select{flex:1;min-width:0;background:#222226;color:#eee;border:1px solid #3d3d42;border-radius:8px;padding:9px;font-size:11px;outline:none}.silence-setting select:focus{border-color:var(--lime)}.silence-setting small{color:#95959c;font-size:9px;line-height:1.4}.mvsep-key-row{display:flex;gap:8px}.mvsep-key-row input{flex:1;min-width:0;background:#111113;color:#eee;border:1px solid #3d3d42;border-radius:8px;padding:9px;font-size:11px}.mvsep-key-row button{padding:8px 11px;font-size:10px}.mvsep-key-status{display:block;margin-top:8px;color:#a5c77a;font-size:10px}.processing-card footer{justify-content:flex-end;margin-top:20px}.settings-tabs{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:190px;flex:0 0 190px;padding:6px;margin:18px 18px 0 0;border:0;border-radius:0;background:transparent}.settings-tabs button{padding:10px 12px;border-radius:7px;background:transparent;color:#a7a7ae;font-size:12px;font-weight:650;text-align:left}.settings-tabs button.active{background:#292e1e;color:#d6fb7a;box-shadow:inset 2px 0 #a9d654}.settings-card-body{min-width:0;flex:1}.settings-pane[hidden]{display:none!important}.settings-pane .processing-section:first-child{margin-top:4px}.processing-card>.settings-tabs~.settings-pane:not([hidden]){min-height:240px}.processing-card:has(.settings-tabs){display:grid;grid-template-columns:190px minmax(0,1fr);grid-template-rows:auto 1fr auto}.processing-card:has(.settings-tabs)>header{grid-column:1/-1}.processing-card:has(.settings-tabs)>.settings-tabs{grid-column:1;grid-row:2/4}.processing-card:has(.settings-tabs)>.settings-pane:not([hidden]){grid-column:2;grid-row:2}.processing-card:has(.settings-tabs)>footer{grid-column:2;grid-row:3}@media(max-width:600px){.processing-card{padding:17px}.processing-card:has(.settings-tabs){grid-template-columns:130px minmax(0,1fr)}.processing-card:has(.settings-tabs)>.settings-tabs{width:130px;flex-basis:130px;margin-right:10px}.settings-tabs button{padding:9px 7px;font-size:10px}.processing-options{grid-template-columns:1fr}.silence-setting{align-items:stretch;flex-direction:column}}`;
settingsStyle.textContent += `.local-audio-options{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:550px){.local-audio-options{grid-template-columns:1fr}}.experimental-feature-list{display:grid;gap:7px}.experimental-feature-row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:54px;padding:9px 11px;border:1px solid #35353b;border-radius:10px;background:#18181b;cursor:pointer}.experimental-feature-row:has(input:checked){border-color:var(--theme-border,#667a35);background:var(--theme-soft,#22271b)}.experimental-feature-row>span,.experimental-feature-row strong,.experimental-feature-row small{display:block}.experimental-feature-row strong{font-size:11px}.experimental-feature-row small{margin-top:3px;color:#96969e;font-size:9px;line-height:1.4}.experimental-feature-row>input{position:absolute;right:11px;width:1px;height:1px;opacity:0}.experimental-feature-row>i{flex:0 0 36px;width:36px;height:21px;padding:3px;border-radius:20px;background:#414148;transition:background .16s}.experimental-feature-row>i>i{display:block;width:15px;height:15px;border-radius:50%;background:#c4c4c9;transition:transform .16s,background .16s}.experimental-feature-row:has(input:checked)>i{background:var(--lime)}.experimental-feature-row:has(input:checked)>i>i{transform:translateX(15px);background:#171811}.experimental-feature-row:has(input:focus-visible){outline:2px solid var(--lime);outline-offset:2px}[data-experimental-control][hidden]{display:none!important}`;
document.head.append(settingsStyle);
settingsStyle.textContent+='.about-app{display:grid;justify-items:center;align-content:center;gap:14px;min-height:260px;padding:26px 12px;text-align:center}.about-app img{width:112px;height:112px;max-width:100%;border-radius:22px}.about-app h3{margin:0;font-size:26px;letter-spacing:-.5px}.about-version{display:inline-block;max-width:100%;padding:7px 12px;border:1px solid var(--theme-border,#728b3a);border-radius:20px;background:var(--theme-soft,#22271b);color:var(--lime);font-size:12px;font-weight:750;overflow-wrap:anywhere}@media(max-width:600px){.about-app{padding:20px 4px;min-height:240px}.about-app img{width:88px;height:88px}.about-app h3{font-size:23px}.about-version{font-size:11px;padding:6px 9px}}';
const mvsepModelStyle = document.createElement('style');
mvsepModelStyle.textContent = `.mvsep-model-select,.mvsep-model-options select{width:100%;background:#18181b;color:#eee;border:1px solid #3d3d42;border-radius:9px;padding:10px;font-size:11px;outline:none}.mvsep-model-select:focus,.mvsep-model-options select:focus{border-color:var(--lime)}.mvsep-model-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:9px}.mvsep-model-options label{display:grid;gap:5px;color:#aaa;font-size:10px}.mvsep-model-options:empty{display:none}@media(max-width:550px){.mvsep-model-options{grid-template-columns:1fr}}`;
document.head.append(mvsepModelStyle);
let availableMvsepModels = [];
function renderMvsepModelOptions(){
  const model = availableMvsepModels.find(item => String(item.id) === String($('mvsepModel').value));
  if (!model) { $('mvsepModelOptions').innerHTML = ''; return; }
  const saved = processingSettings.mvsepOptionsByModel[String(model.id)] || {};
  $('mvsepModelOptions').innerHTML = (model.fields || []).map(field => `<label>${esc(field.label)}<select data-mvsep-option="${esc(field.name)}">${Object.entries(field.options || {}).map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select></label>`).join('');
  $('mvsepModelOptions').querySelectorAll('[data-mvsep-option]').forEach(select => { const field = model.fields.find(item => item.name === select.dataset.mvsepOption); select.value = saved[field.name] ?? field.default; });
}
async function loadMvsepModels(force=false){
  const status = $('mvsepModelStatus'); if (!status) return;
  status.textContent = 'Carregando modelos disponíveis…';
  try {
    const result = await api('/api/mvsep/models', force ? {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'} : {});
    availableMvsepModels = Array.isArray(result.models) ? result.models : [];
    if (!availableMvsepModels.length) throw new Error('Nenhum modelo de vocais e instrumental foi encontrado.');
    const preferred = availableMvsepModels.find(item => String(item.id) === String(processingSettings.mvsepModelId)) || availableMvsepModels.find(item => String(item.id) === '12') || availableMvsepModels[0];
    $('mvsepModel').innerHTML = availableMvsepModels.map(model => `<option value="${model.id}">${esc(model.name)}${Number(model.orientation) === 1 ? ' · conta registrada' : ''}</option>`).join('');
    $('mvsepModel').value = String(preferred.id); processingSettings.mvsepModelId = String(preferred.id); renderMvsepModelOptions();
    status.textContent = `${availableMvsepModels.length} modelos compatíveis disponíveis. Modelos premium foram ocultados.`;
  } catch(error) {
    status.textContent = `Não consegui carregar o catálogo da MVSep: ${error.message}`;
    if (!$('mvsepModel').options.length || !$('mvsepModel').value) $('mvsepModel').innerHTML = '<option value="12">MDX-B Karaoke · padrão</option>';
  }
}
$('mvsepModel').onchange = () => { const previous=String(processingSettings.mvsepModelId||'12');const values={};$('mvsepModelOptions').querySelectorAll('[data-mvsep-option]').forEach(select=>values[select.dataset.mvsepOption]=select.value);processingSettings.mvsepOptionsByModel[previous]=values;processingSettings.mvsepModelId=$('mvsepModel').value;renderMvsepModelOptions(); };
function openProcessingSettings(){ $('pauseThreshold').value=processingSettings.pauseThresholdSeconds;$('pauseThresholdValue').textContent=$('pauseThreshold').selectedOptions[0].textContent;$('mvsepToken').value='';$('mvsepToken').placeholder=mvsepConfigured?'Chave já salva · digite outra para substituir':'Cole sua chave da API';$('mvsepKeyStatus').textContent=mvsepKeyLocationText(mvsepConfigured);$('interfaceLanguage').value=interfaceLanguage;$('interfaceTheme').value=interfaceTheme;$('themeCustomColor').value=processingSettings.themeCustomColor||'#d4fb69';$('lyricsScale').value=String(processingSettings.lyricsScale||1);$('lyricsScaleValue').textContent=`${Math.round((processingSettings.lyricsScale||1)*100)}%`;$('lyricsScaleTv').value=String(processingSettings.lyricsScaleTv||1);$('lyricsScaleTvValue').textContent=`${Math.round((processingSettings.lyricsScaleTv||1)*100)}%`;$('seekStepSeconds').value=String(processingSettings.seekStepSeconds||10);document.documentElement.style.setProperty('--lyrics-scale-portrait',String(processingSettings.lyricsScale||1));document.documentElement.style.setProperty('--lyrics-scale-tv',String(processingSettings.lyricsScaleTv||1));selectSettingsTab(activeSettingsTab);settingsDialog.classList.add('show');loadMvsepModels(); }
$('pauseThreshold').onchange = event => $('pauseThresholdValue').textContent = event.target.selectedOptions[0].textContent;
$('settingsTop').onclick = openProcessingSettings;
$('navSettings')?.addEventListener('click', openProcessingSettings);
const usageGuide=document.createElement('dialog');usageGuide.id='usageGuide';
usageGuide.setAttribute('aria-labelledby','usageGuideTitle');
usageGuide.innerHTML=`<header><div><span class="processing-kicker">VOXSTAGE</span><h2 id="usageGuideTitle">Guia de uso</h2></div><button type="button" class="lyrics-close" id="closeUsageGuide" aria-label="Fechar guia">×</button></header><div class="usage-guide-body"><p>Abra um tópico para consultar as instruções. O guia funciona sem internet.</p><div id="usageGuideTopics"></div></div>`;
document.body.append(usageGuide);
const usageGuideTopics=[
  ['queue','Biblioteca e fila de reprodução',`<p>No PC, a fila fica ao lado da biblioteca. No celular e na TV, abra <b>Fila</b> no menu. O botão + adiciona músicas; a busca e os filtros ajudam a encontrar faixas e letras prontas.</p><p>No menu de três pontos da música, escolha <b>Adicionar à fila</b>. Suas escolhas tocam primeiro. Na fila, use a seta para subir uma faixa, × para remover ou Limpar para voltar à ordem normal.</p><p>Sem escolhas pendentes, a reprodução segue as músicas que vêm abaixo da atual na biblioteca, respeitando a ordenação. Buscar ou filtrar não muda a sequência; a última música encerra a sessão.</p>`],
  ['start','Adicionar e organizar músicas',`<p>Use <b>Adicionar música</b> para importar arquivos ou buscar uma faixa no YouTube. Confira título, artista e o papel de cada arquivo antes de salvar.</p><p>Uma música completa já pode tocar sozinha. Com faixas separadas, marque instrumental, vocal principal e backing para controlar seus volumes. O × remove um arquivo do formulário.</p><p>Use a busca e os favoritos para encontrar músicas. O menu de três pontos permite editar ou apagar uma música e enviar uma faixa completa salva para separação.</p>`],
  ['separation','Separação de áudio e MVSEP',`<p>Em <b>Configurações → Nuvem</b>, salve sua chave MVSEP e escolha o modelo. A ajuda da chave explica onde obtê-la. A separação pode usar créditos do serviço.</p><p>Ao receber o resultado, confira os arquivos e salve a música. Se eles não forem anexados automaticamente, use <b>Acoplar arquivos</b>.</p>`],
  ['playback','Tocar, ajustar volumes, velocidade e tom',`<p>Abra a apresentação para cantar. Os controles permitem pausar, avançar e ajustar os volumes das faixas. Em uma música completa há um controle de volume.</p><p><b>Velocidade e tom</b> reúne os ajustes em tempo real: 0,75× a 1,25× e −4 a +4 semitons. As letras e a pontuação acompanham esses ajustes.</p><p>Use o botão de ocultar para liberar a tela. No PC, os controles também se ocultam após inatividade; mantenha o mouse sobre eles para continuarem visíveis.</p>`],
  ['lyrics','Letras, vozes e aparência',`<p>Em <b>Letras</b>, busque uma versão que corresponda à sua gravação ou cole o texto. Uma letra sem tempos precisa ser sincronizada.</p><p>No editor de Sync, <b>Voz 1</b>, <b>Voz 2</b> e <b>Backing</b> têm textos e tempos independentes. Editar uma voz preserva os tempos das outras. Durante um sync, abra <b>Editar letra</b> para salvar outra voz e depois retomar a marcação em andamento. Hífens dentro de uma palavra separam suas partes: caçado-o-or recebe três marcações. A próxima parte aparece automaticamente durante esse trecho, sem mudar sua preferência de prévia. Para textos antigos, a extração move () para Backing e [] para Voz 2, inclusive dentro de uma frase.</p><p>Na caixa da <b>Voz 2</b>, escreva <b>look through [my eyes]</b> para que apenas my eyes receba o gradiente e o ponto compartilhado. O restante serve como contexto para a mesma frase da Voz 1. Sem colchetes, a Voz 2 participa da frase inteira.</p><p>Frases iguais e simultâneas compartilham uma linha; quando a mesma palavra é cantada pelas duas vozes, ela recebe um único ponto em gradiente. Falas diferentes da Voz 2 aparecem no topo, sem mover a letra principal. Em <b>Configurações → Letras e vozes</b>, ajuste cor da Voz 2, gradiente de sobreposição e tamanho das letras.</p>`],
  ['sync','Sincronizar por linha ou palavra',`<p>Escolha a voz e o modo no editor de Sync. <b>Por linha:</b> toque quando a frase começar e depois quando ela terminar. Cada frase das três vozes recebe início e fim, inclusive a última.</p><p><b>Palavra por palavra:</b> o primeiro toque marca o início real da primeira palavra. Depois, toque ao terminar cada palavra; esse toque também inicia a seguinte. Nenhuma voz recebe um início em zero automaticamente. A reprodução começa na posição atual: avance até a entrada da voz, se precisar.</p><p><b>Intervalos entre trechos:</b> deixe uma linha vazia entre as frases no texto. Ao terminar a última palavra antes dela, um toque encerra a frase e entra em pausa de marcação. Você pode esperar ou avançar pela barra de progresso. Quando o próximo trecho começar, toque para marcar seu início; depois continue marcando os finais das palavras.</p><p>O áudio continua tocando durante o intervalo; use Pausar/Continuar se precisar. No PC, Espaço também marca. No celular, o mesmo gesto é um toque na letra.</p><p><b>Desfazer</b> volta uma marcação. <b>Salvar</b> aceita trabalho parcial. <b>Cancelar</b> descarta a sessão em andamento e volta à apresentação e à posição anteriores, preservando a letra salva.</p><p>As ferramentas recolhidas do editor permitem corrigir linhas selecionadas, marcar silêncios vocais e selecionar palavras para censura.</p>`],
  ['covers','Capas e fundos',`<p>A busca de capas usa apenas o título informado. A Apple/iTunes é a busca inicial. Se faltar uma opção, toque em <b>Não encontrou seu resultado? Pesquise no Cover Art</b> para consultar o catálogo comunitário. Ele pode levar mais tempo; os resultados recentes são reaproveitados.</p><p>Para uma imagem de vídeo, escolha <b>Miniatura do YouTube</b> e pesquise a música ou cole o link. A busca usa o YouTube comum. A faixa selecionada na importação também pode fornecer uma capa automaticamente.</p><p>Escolha usar a imagem como capa, fundo ou ambos. A seleção fecha a busca e preenche o formulário; salve a música para guardar a alteração.</p>`],
  ['scoring','Pontuação e microfone',`<aside class="usage-guide-note"><b>Esta função funciona melhor no PC ou em celulares/TVs onde você pode ouvir o som pelo fone de ouvido.</b><p>O som do alto-falante pode encobrir sua voz ou ser contado como canto pelo microfone. Use fones sempre que possível.</p></aside><p>Abra <b>Pontuar</b>, escolha o microfone e permita o acesso quando solicitado. Você pode usar ambos os vocais ou as três trilhas como referência. Ao começar, a música volta ao início e toca automaticamente.</p><p>Se a seta não reagir, confira o dispositivo e o nível captado. Um filtro de volume mais baixo permite captar vozes fracas, mas também admite mais ruído e vazamento do alto-falante.</p><p>A pontuação soma 1.000 pontos por nota acertada, sem descontar pontos. As cinco estrelas brancas aparecem em 9%, 18%, 27%, 36% e 45% de acerto; ficam douradas em 55%. O histórico fica salvo localmente.</p>`],
  ['devices','Conectar celular, PC e TV',`<p>Use a opção de conexão para parear o celular com o PC ou a TV seguindo as instruções mostradas. Os aparelhos precisam se alcançar pela rede.</p><p>Músicas já disponíveis entram na fila; arquivos que estão no celular podem ser enviados ao aparelho conectado. Uma faixa nova que exige processamento pode pedir autorização.</p><p>O celular também pode enviar a chave MVSEP e funcionar como microfone do aparelho conectado. Para usar o microfone, permita a captura no celular.</p><p>Em <b>Envios em progresso</b>, acompanhe uma tarefa e volte ao formulário depois. No Android, as notificações ajudam a acompanhar o processamento ao sair do app.</p>`],
  ['backup','Exportar e importar dados',`<p>Em <b>Configurações → Dados e backup</b>, exporte a biblioteca completa ou escolha um pacote para importar. O arquivo .voxstage.zip inclui áudios, imagens, letras e tempos das três vozes. O backup completo também guarda preferências e histórico de pontuação, sem chaves de API nem pareamentos.</p><p>Para uma única música, abra seu menu de três pontos e escolha <b>Exportar música</b>. Depois de preparar, use <b>Salvar arquivo</b>.</p><p>A importação mostra uma prévia antes de alterar a biblioteca. Por padrão, músicas com o mesmo identificador são mantidas. Marque Atualizar músicas que já existem para substituir seus dados e arquivos pelo conteúdo do pacote. As demais músicas são preservadas.</p><p>Restaurar preferências e histórico é opcional e recarrega a interface ao concluir.</p>`],
  ['errors','Erros de conexão: 503, busca e YouTube',`<p><b>503 — serviço temporariamente indisponível:</b> o provedor pode estar sobrecarregado, em manutenção ou limitando consultas. Isso não quer dizer que sua música não existe. Aguarde o tempo indicado antes de tentar novamente; insistir pode prolongar a limitação.</p><p><b>Falha de conexão / Failed to fetch:</b> a consulta não chegou ao serviço ou a resposta não voltou. Confira a conexão e tente de novo após uma pausa. Se persistir nas capas, use outro provedor ou uma miniatura do YouTube.</p><p><b>Cover Art Archive lento:</b> esse catálogo depende de consultas adicionais. Ele só busca quando você pede pelo botão; você pode escolher uma capa da Apple enquanto espera.</p><p><b>“Faça login para confirmar que não é um robô”:</b> é um bloqueio do YouTube, que pode variar conforme a rede e o aparelho. Aguarde antes de repetir. Como alternativa, importe o áudio obtido de outra forma e, depois de salvar, use Enviar para o MVSEP no menu da música.</p>`]
];
$('usageGuideTopics').innerHTML=usageGuideTopics.map(([id,title,content])=>`<details id="usageGuide-${id}"><summary>${title}</summary><div>${content}</div></details>`).join('');
const usageGuideButton=document.createElement('button');usageGuideButton.type='button';usageGuideButton.id='openUsageGuide';usageGuideButton.className='usage-guide-open';
usageGuideButton.textContent='? Guia';usageGuideButton.title='Guia de uso';usageGuideButton.setAttribute('aria-label','Abrir guia de uso');
const mainMenuActions=document.createElement('div');mainMenuActions.className='main-menu-actions';
$('settingsTop').before(mainMenuActions);mainMenuActions.append(usageGuideButton,$('settingsTop'));
let usageGuideOrigin=null;
function openUsageGuide(topic){
  usageGuideOrigin=document.activeElement;
  (document.fullscreenElement||document.body).append(usageGuide);
  if(!usageGuide.open)usageGuide.showModal();
  if(topic){const section=$('usageGuide-'+topic);if(section){section.open=true;section.scrollIntoView({block:'start'});section.querySelector('summary').focus();}}
}
usageGuideButton.onclick=()=>openUsageGuide();
$('closeUsageGuide').onclick=()=>usageGuide.close();
usageGuide.addEventListener('click',event=>{if(event.target===usageGuide){const box=usageGuide.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)usageGuide.close();}});
usageGuide.addEventListener('close',()=>{if(usageGuideOrigin?.isConnected)usageGuideOrigin.focus({preventScroll:true});});
usageGuide.addEventListener('keydown',event=>event.stopPropagation());
const usageGuideStyle=document.createElement('style');
usageGuideStyle.textContent=`.main-menu-actions{display:flex;align-items:center;gap:8px;flex:none}.main-menu-actions .settings-top{flex:none}.usage-guide-open{display:flex;align-items:center;justify-content:center;min-height:44px;padding:9px 12px;border:1px solid var(--line,#36363a);border-radius:10px;background:#222226;color:#eee;font-size:12px;font-weight:700;white-space:nowrap}.usage-guide-open:focus-visible,#usageGuide summary:focus-visible{outline:2px solid var(--lime);outline-offset:3px}#usageGuide{width:min(760px,calc(100% - 28px));max-height:calc(100dvh - 28px);padding:0;overflow:hidden;border:1px solid #414148;border-radius:18px;background:#1b1c21;color:var(--text,#f4f4f5);box-shadow:0 24px 80px #000b}#usageGuide[open]{display:flex;flex-direction:column}#usageGuide::backdrop{background:#08090bd9;backdrop-filter:blur(10px)}#usageGuide>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid #ffffff12;flex:none}#usageGuide h2{margin:5px 0 0;font:700 23px Manrope,sans-serif}.usage-guide-body{padding:4px 24px 24px;overflow:auto;min-height:0;overscroll-behavior:contain}#usageGuide p{font-size:13px;line-height:1.65;color:#babac3;margin:10px 0}#usageGuide details{margin-top:10px;border:1px solid #37383e;border-radius:11px;background:#17181b;scroll-margin-top:12px}#usageGuide summary{padding:15px;cursor:pointer;font-size:14px;font-weight:700;min-height:48px}#usageGuide details>div{padding:0 15px 8px}#usageGuide b{color:#ebebef}#usageGuide .usage-guide-note{padding:12px;border:1px solid var(--theme-border,#65763d);border-radius:9px;background:var(--theme-soft,#262c1d);font-size:13px;line-height:1.6}#usageGuide .usage-guide-note p{margin-bottom:0}@media(max-width:550px){#usageGuide>header{padding:16px}.usage-guide-body{padding:0 16px 16px}#usageGuide h2{font-size:21px}.usage-guide-open{padding:8px 10px;font-size:11px}.main-menu-actions{gap:6px}#usageGuide summary{padding:13px;font-size:13px}}`;
document.head.append(usageGuideStyle);


settingsPanes.data.innerHTML=`<section class="processing-section"><b>Exportar e importar</b><p>Guarde a biblioteca em um arquivo .voxstage.zip com áudios, imagens, letras, sincronização e ajustes. Para uma única faixa, use Exportar música no menu de três pontos.</p><div class="archive-data-actions"><button type="button" class="btn" id="exportLibrary">Exportar biblioteca</button><button type="button" class="btn secondary" id="importLibrary">Importar arquivo</button></div><p>O backup da biblioteca inclui preferências e histórico de pontuação. Chaves de API e conexões com outros aparelhos ficam fora dele.</p></section>`;
const archiveFileInput=document.createElement('input');archiveFileInput.type='file';archiveFileInput.accept='.zip,.voxstage,application/zip,application/x-zip-compressed';archiveFileInput.id='archiveFileInput';archiveFileInput.hidden=true;document.body.append(archiveFileInput);
const archiveDialog=document.createElement('dialog');archiveDialog.id='archiveDialog';archiveDialog.setAttribute('aria-labelledby','archiveDialogTitle');
archiveDialog.innerHTML=`<header><div><span class="processing-kicker">VOXSTAGE</span><h2 id="archiveDialogTitle">Dados e backup</h2></div><button type="button" class="lyrics-close" id="archiveClose" aria-label="Fechar">×</button></header><div class="archive-dialog-body"><p id="archiveStatus" role="status"></p><progress id="archiveProgress" aria-label="Processando arquivo" hidden></progress><section id="archivePreview" hidden><ul id="archiveTitles"></ul><label id="archiveReplaceLabel"><input type="checkbox" id="archiveReplace"> Atualizar músicas que já existem</label><p id="archiveReplaceHint">Desmarcado: mantém as músicas locais com o mesmo identificador. As outras músicas da biblioteca são preservadas.</p><label id="archivePreferencesLabel"><input type="checkbox" id="archivePreferences"> Restaurar preferências e histórico</label><p id="archivePreferencesHint">Ao restaurar preferências, a interface será recarregada ao concluir.</p></section></div><footer><button type="button" class="btn secondary" id="archiveChoose" hidden>Escolher outro arquivo</button><button type="button" class="btn" id="archiveDownload" hidden>Salvar arquivo</button><button type="button" class="btn" id="archiveConfirm" hidden>Importar agora</button></footer>`;
document.body.append(archiveDialog);
let archiveBusy=false,archiveExport=null,archivePreview=null,archiveOrigin=null;
const archivePreferenceKeys=['voxstage-language','voxstage-theme','voxstage-library-view','voxstage-processing-settings','voxstage-score-settings','voxstage-score-history','voxstage-artwork-provider-v2'];
function formatArchiveSize(bytes){return bytes>=1073741824?(bytes/1073741824).toFixed(1)+' GB':bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';}
function captureArchivePreferences(){return Object.fromEntries(archivePreferenceKeys.map(key=>[key,localStorage.getItem(key)]).filter(([,value])=>value!==null));}
function showArchiveDialog(title){
  archiveOrigin=document.activeElement;
  (document.fullscreenElement||document.body).append(archiveDialog);
  $('archiveDialogTitle').textContent=title;
  if(!archiveDialog.open)archiveDialog.showModal();
}
function setArchiveBusy(busy){
  archiveBusy=busy;$('archiveProgress').hidden=!busy;
  for(const id of ['exportLibrary','importLibrary','archiveChoose','archiveDownload','archiveConfirm'])$(id).disabled=busy;
}
function resetArchiveDialog(){
  archiveExport=null;archivePreview=null;
  for(const id of ['archivePreview','archiveChoose','archiveDownload','archiveConfirm'])$(id).hidden=true;
  $('archiveReplace').checked=false;$('archivePreferences').checked=false;
}
async function exportArchive(songId=null){
  if(archiveBusy){showArchiveDialog($('archiveDialogTitle').textContent);return;}
  resetArchiveDialog();showArchiveDialog(songId?'Exportar música':'Exportar biblioteca');
  $('archiveStatus').textContent='Preparando o pacote com os arquivos e dados. Você pode fechar esta tela enquanto espera.';setArchiveBusy(true);
  try{
    archiveExport=await api('/api/archives/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({songId,preferences:songId?{}:captureArchivePreferences()})});
    $('archiveStatus').textContent=`Pacote pronto: ${archiveExport.songs} música(s), ${archiveExport.files} arquivo(s) · ${formatArchiveSize(archiveExport.bytes)}. Salve o arquivo para guardar seu backup.`;
    $('archiveDownload').hidden=false;
    if(!archiveDialog.open)toast('Exportação pronta. Abra Dados e backup para salvar o arquivo.');
  }catch(error){$('archiveStatus').textContent=error.message;toast(error.message);}
  finally{setArchiveBusy(false);}
}
async function saveArchiveExport(){
  if(!archiveExport||archiveBusy)return;
  if(!mobileNative){
    const link=document.createElement('a');link.href=archiveExport.downloadUrl;link.download=archiveExport.filename;document.body.append(link);link.click();link.remove();
    $('archiveStatus').textContent='Download iniciado: '+archiveExport.filename+'. Guarde o arquivo para importar depois.';return;
  }
  setArchiveBusy(true);
  try{
    const {token}=await api('/api/archives/save',{method:'POST',body:JSON.stringify(archiveExport)});
    $('archiveStatus').textContent='Escolha onde salvar o arquivo no Android.';
    while(true){
      const result=await api('/api/archives/save-status',{method:'POST',body:JSON.stringify({token})});
      if(result.state==='done'){$('archiveStatus').textContent='Arquivo salvo: '+archiveExport.filename;break;}
      if(result.state==='cancelled'){$('archiveStatus').textContent='Salvamento cancelado. Você pode tentar salvar o pacote novamente.';break;}
      $('archiveStatus').textContent=result.state==='saving'?'Salvando o pacote no destino escolhido…':'Escolha onde salvar o arquivo no Android.';
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }catch(error){$('archiveStatus').textContent=error.message;}
  finally{setArchiveBusy(false);}
}
function chooseArchiveFile(){if(archiveBusy)return;archiveFileInput.value='';archiveFileInput.click();}
async function inspectArchiveFile(file){
  if(!file||archiveBusy)return;
  resetArchiveDialog();showArchiveDialog('Importar músicas');setArchiveBusy(true);
  $('archiveChoose').hidden=false;$('archiveStatus').textContent='Conferindo '+file.name+'… A biblioteca só muda após você confirmar a importação.';
  try{
    archivePreview=await api('/api/archives/inspect',{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
    $('archiveStatus').textContent=`${archivePreview.songs} música(s): ${archivePreview.new} nova(s), ${archivePreview.existing} já existente(s). ${formatArchiveSize(archivePreview.bytes)} em arquivos.`;
    $('archiveTitles').replaceChildren(...archivePreview.titles.map(title=>{const item=document.createElement('li');item.textContent=title;return item;}));
    $('archivePreview').hidden=false;$('archiveConfirm').hidden=false;
    $('archiveReplaceLabel').hidden=$('archiveReplaceHint').hidden=!archivePreview.existing;
    $('archivePreferencesLabel').hidden=$('archivePreferencesHint').hidden=!archivePreview.preferences;
  }catch(error){$('archiveStatus').textContent=error.message;}
  finally{setArchiveBusy(false);}
}
async function importArchive(){
  if(!archivePreview||archiveBusy)return;
  const restorePreferences=$('archivePreferences').checked;
  setArchiveBusy(true);$('archiveStatus').textContent='Importando arquivos e conferindo sua integridade…';
  try{
    const result=await api('/api/archives/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:archivePreview.id,replaceExisting:$('archiveReplace').checked})});
    if(current&&result.ids.includes(current.id)){stopSong();$('display').classList.remove('show');}
    await loadSongs();
    $('archiveStatus').textContent=`Importação concluída: ${result.added} nova(s), ${result.updated} atualizada(s), ${result.skipped} mantida(s) sem alteração.`;
    $('archiveConfirm').hidden=true;$('archivePreview').hidden=true;archivePreview=null;
    if(restorePreferences&&Object.keys(result.preferences||{}).length){
      captureUploadDraft();
      const keys=archivePreferenceKeys.filter(key=>typeof result.preferences[key]==='string');
      const previous=new Map(keys.map(key=>[key,localStorage.getItem(key)]));
      try{
        for(const key of keys)localStorage.setItem(key,result.preferences[key]);
      }catch(error){
        for(const [key,value] of previous)try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}catch{}
        $('archiveStatus').textContent+=' As músicas foram importadas, mas não houve espaço para restaurar as preferências.';
        return;
      }
      window.location.reload();
    }
  }catch(error){$('archiveStatus').textContent=error.message;}
  finally{setArchiveBusy(false);}
}
$('exportLibrary').onclick=()=>exportArchive();$('importLibrary').onclick=chooseArchiveFile;
$('archiveClose').onclick=()=>archiveDialog.close();$('archiveDownload').onclick=saveArchiveExport;$('archiveConfirm').onclick=importArchive;$('archiveChoose').onclick=chooseArchiveFile;
archiveFileInput.onchange=()=>inspectArchiveFile(archiveFileInput.files[0]);
archiveDialog.addEventListener('keydown',event=>event.stopPropagation());
archiveDialog.addEventListener('close',()=>{if(archiveOrigin?.isConnected)archiveOrigin.focus({preventScroll:true});});
// Reopening this settings tab also recovers a prepared export after its dialog closes.
settingsPanes.data.insertAdjacentHTML('beforeend','<button type="button" class="btn secondary" id="archiveResume" hidden>Ver exportação em andamento</button>');
$('archiveResume').onclick=()=>showArchiveDialog($('archiveDialogTitle').textContent);
const archiveVisibility=new MutationObserver(()=>{$('archiveResume').hidden=!archiveBusy&&!archiveExport&&!archivePreview;$('archiveResume').textContent=archiveBusy?'Ver operação em andamento':archiveExport?'Salvar exportação preparada':'Continuar importação';});
archiveVisibility.observe($('archiveProgress'),{attributes:true,attributeFilter:['hidden']});
const archiveStyle=document.createElement('style');archiveStyle.textContent=`.archive-data-actions{display:flex;flex-wrap:wrap;gap:9px}.archive-data-actions button{justify-content:center;font-size:12px}#archiveResume{margin-top:12px;font-size:12px}#archiveDialog{width:min(600px,calc(100% - 28px));max-height:calc(100dvh - 28px);padding:0;overflow:hidden;border:1px solid #414148;border-radius:18px;background:#1b1c21;color:var(--text,#f4f4f5)}#archiveDialog[open]{display:flex;flex-direction:column}#archiveDialog::backdrop{background:#08090bd9;backdrop-filter:blur(10px)}#archiveDialog header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px;border-bottom:1px solid #ffffff12}#archiveDialog h2{font:700 21px Manrope,sans-serif;margin:5px 0 0}.archive-dialog-body{padding:4px 20px 20px;overflow:auto;min-height:0}#archiveDialog p{font-size:13px;line-height:1.6;color:#bcbcc5}#archiveDialog progress{width:100%;accent-color:var(--lime)}#archiveDialog ul{padding-left:20px;font-size:13px;line-height:1.6}#archiveDialog label{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:12px}#archiveDialog input{accent-color:var(--lime);flex:none}#archiveDialog #archiveReplaceHint,#archiveDialog #archivePreferencesHint{font-size:11px;margin-top:6px}#archiveDialog footer{padding:14px 20px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #ffffff12}#archiveDialog footer button{font-size:12px}#archiveDialog [hidden],#archiveResume[hidden]{display:none!important}@media(max-width:550px){.archive-data-actions{flex-direction:column}#archiveDialog header{padding:16px}.archive-dialog-body{padding:0 16px 16px}#archiveDialog footer{padding:12px 16px;flex-wrap:wrap}#archiveDialog footer button{flex:1;justify-content:center}}`;document.head.append(archiveStyle);

$('closeProcessing').onclick = () => settingsDialog.classList.remove('show');
settingsDialog.addEventListener('click', event => { if (event.target === settingsDialog) settingsDialog.classList.remove('show'); });
$('removeMvsepToken').onclick = async () => { try { await api('/api/mvsep/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:''})});mvsepConfigured=false;$('mvsepToken').value='';$('mvsepKeyStatus').textContent=interfaceLanguage==='en-US'?'Key removed from this device.':'Chave removida deste aparelho.';loadMvsepConfiguration(); } catch(error){$('mvsepKeyStatus').textContent=error.message;} };
$('saveProcessing').onclick = async () => { processingSettings.mvsepModelId=$('mvsepModel').value||'12';const model=availableMvsepModels.find(item=>String(item.id)===String(processingSettings.mvsepModelId));if(model){const values={};$('mvsepModelOptions').querySelectorAll('[data-mvsep-option]').forEach(select=>values[select.dataset.mvsepOption]=select.value);processingSettings.mvsepOptionsByModel[processingSettings.mvsepModelId]=values;}processingSettings.pauseThresholdSeconds=Number($('pauseThreshold').value);const token=$('mvsepToken').value.trim();if(token){try{await api('/api/mvsep/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});mvsepConfigured=true;}catch(error){$('mvsepKeyStatus').textContent=error.message;selectSettingsTab('cloud');return;}}localStorage.setItem('voxstage-processing-settings',JSON.stringify(processingSettings));if(current){current.vocalSilenceEnds=[];current.vocalSilenceState=null;updateLyrics(playbackPosition());}settingsDialog.classList.remove('show');await loadMvsepConfiguration();toast('Preferências salvas neste aparelho.'); };
const favoriteButton = document.createElement('button'); favoriteButton.className = 'filter-btn'; favoriteButton.id = 'filterFavorites'; favoriteButton.textContent = '☆ Favoritas';
$('search').insertAdjacentElement('afterend', favoriteButton);
favoriteButton.onclick = () => { favoriteOnly = !favoriteOnly; favoriteButton.classList.toggle('selected', favoriteOnly); favoriteButton.textContent = favoriteOnly ? '★ Favoritas' : '☆ Favoritas'; render(); };
const hiddenSongsButton = document.createElement('button'); hiddenSongsButton.type = 'button'; hiddenSongsButton.className = 'filter-btn'; hiddenSongsButton.id = 'showHiddenSongs'; hiddenSongsButton.textContent = 'Mostrar ocultas'; hiddenSongsButton.setAttribute('aria-pressed', 'false');
favoriteButton.insertAdjacentElement('afterend', hiddenSongsButton);
hiddenSongsButton.onclick = () => { showHiddenSongs = !showHiddenSongs; hiddenSongsButton.textContent = showHiddenSongs ? 'Esconder ocultas' : 'Mostrar ocultas'; hiddenSongsButton.setAttribute('aria-pressed', String(showHiddenSongs)); render(); };
const trackViewButton = document.createElement('button'); trackViewButton.type = 'button'; trackViewButton.className = 'filter-btn track-view-toggle'; trackViewButton.id = 'trackViewToggle';
const updateTrackViewButton = () => {
  const label = interfaceLanguage === 'en-US'
    ? compactTrackView ? 'Return to card view' : 'Switch to compact list'
    : compactTrackView ? 'Voltar aos cartões' : 'Ativar lista compacta';
  trackViewButton.textContent = compactTrackView
    ? (interfaceLanguage === 'en-US' ? '▦ Cards' : '▦ Cartões')
    : (interfaceLanguage === 'en-US' ? '☷ Compact · 2/row' : '☷ Compacta · 2/linha');
  trackViewButton.title = label;
  trackViewButton.setAttribute('aria-label', label);
  trackViewButton.setAttribute('aria-pressed', String(compactTrackView));
  trackViewButton.classList.toggle('selected', compactTrackView);
};
favoriteButton.insertAdjacentElement('afterend', trackViewButton);
updateTrackViewButton();
trackViewButton.onclick = () => {
  compactTrackView = !compactTrackView;
  try { localStorage.setItem('voxstage-library-view', compactTrackView ? 'compact' : 'cards'); } catch {}
  updateTrackViewButton();
  render();
};
const compactLibraryStyle = document.createElement('style');
compactLibraryStyle.textContent = `.track-view-toggle{white-space:nowrap;font-size:10px!important;padding:0 10px!important}.track-view-toggle.selected{color:var(--lime)}.grid.compact-view{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.grid.compact-view .track{display:flex;align-items:center;gap:10px;min-height:78px;padding:9px;border-radius:12px}.grid.compact-view .track:hover{transform:translateY(-1px)}.grid.compact-view .cover{flex:0 0 56px;width:56px!important;height:56px!important;min-height:56px;aspect-ratio:1/1;border-radius:9px}.grid.compact-view .cover-letter{font-size:24px}.grid.compact-view .track-play{width:25px;height:25px;right:3px;bottom:3px;font-size:10px}.grid.compact-view .track-info{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:3px 7px;flex:1;min-width:0;padding:0}.grid.compact-view .track-title{grid-column:1/-1;font-size:11px}.grid.compact-view .track-artist{grid-column:1/-1;margin-top:0;font-size:10px}.grid.compact-view .track-meta{grid-column:1/-1;margin-top:3px;font-size:9px}.grid.compact-view .track-actions{gap:4px}.grid.compact-view .action-icon{padding:2px 4px}.grid.compact-view .track-menu-toggle{width:23px;height:23px;font-size:18px}.grid.compact-view .local-separation-status{grid-column:1/-1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:760px){.filters{flex-wrap:wrap}.filters h2{flex:1 0 100%}.filters .search{flex:1;min-width:120px;width:auto}}@media(max-width:650px){.grid.compact-view{gap:7px}.grid.compact-view .track{gap:7px;padding:7px;min-height:70px}.grid.compact-view .cover{flex-basis:44px;width:44px!important;height:44px!important;min-height:44px}.grid.compact-view .track-title{font-size:10px}.grid.compact-view .track-artist{font-size:9px}.grid.compact-view .tag{padding:3px 5px}}`;
document.head.append(compactLibraryStyle);
const compactCoverStyle = document.createElement('style');
compactCoverStyle.textContent = `.grid.compact-view .track{position:relative;isolation:isolate;overflow:visible;background:var(--panel);box-shadow:0 7px 20px #0003}.grid.compact-view .track:has(.track-menu:not([hidden])){z-index:30}.grid.compact-view .track::before{content:'';position:absolute;z-index:-1;inset:0;border-radius:inherit;pointer-events:none;background-image:linear-gradient(90deg,rgba(18,18,21,.87),rgba(18,18,21,.62)),var(--track-cover,none);background-position:center;background-size:cover;opacity:.92}.grid.compact-view .cover,.grid.compact-view .track-info{position:relative;z-index:1}.grid.compact-view .cover{box-shadow:0 3px 13px #0008;border:1px solid #ffffff30}.grid.compact-view .track-title,.grid.compact-view .track-artist{text-shadow:0 1px 8px #000b}`;
document.head.append(compactCoverStyle);
const fullscreenVolumes = document.createElement('div'); fullscreenVolumes.className = 'fullscreen-volumes';
fullscreenVolumes.innerHTML = [['Inst', 'Instrumental'], ['Lead', 'Vocal'], ['Back', 'Backing'], ['Mic', 'Mic 🎤']].map(([key, label]) => `<label class="hud-range hud-range-${key.toLowerCase()}">${label}<input type="range" min="0" max="${key==='Mic'?'1.5':'1'}" step=".01" value="${key==='Mic'?(window.VoxStageVocalMonitor?.getVolume()??1):$('vol' + key).value}" data-full-volume="${key}"></label>`).join('');
const lyricsDialog = document.createElement('div'); lyricsDialog.id = 'lyricsDialog'; lyricsDialog.className = 'lyrics-dialog';
lyricsDialog.innerHTML = `<div class="lyrics-dialog-card"><div class="lyrics-dialog-head"><div><span class="lyrics-kicker">VOXSTAGE · LETRAS</span><h2 id="lyricsDialogTitle">Letras sincronizadas</h2></div><button class="lyrics-close" id="closeLyricsDialog" aria-label="Fechar">×</button></div><p class="lyrics-dialog-copy">Busque uma versão sincronizada e escolha o resultado que corresponde à gravação.</p><div class="lyrics-search-row"><input id="lyricsQuery" placeholder="Título da música ou artista"><button class="btn" id="searchLyricsButton">Buscar</button></div><section class="lyrics-paste"><label for="lyricsPasteInput">Ou cole sua própria letra</label><textarea id="lyricsPasteInput" rows="5" placeholder="Cole a letra aqui, uma linha por frase. Você pode colar timestamps LRC também."></textarea><button class="btn secondary" id="applyPastedLyrics" type="button">Usar esta letra</button></section><div id="lyricsResults" class="lyrics-results"><div class="lyrics-empty">Pesquise pelo nome da música para encontrar letras.</div></div><div id="lyricsDialogStatus" class="lyrics-dialog-status"></div></div>`;
const profanityPicker = document.createElement('div'); profanityPicker.className = 'profanity-picker-dialog'; profanityPicker.id = 'profanityPicker';
profanityPicker.innerHTML = `<section class="profanity-picker-card" role="dialog" aria-modal="true" aria-labelledby="profanityPickerTitle"><header><div><span class="lyrics-kicker">CENSURA</span><h2 id="profanityPickerTitle">Escolha cada ocorrência</h2></div><button class="lyrics-close" id="closeProfanityPicker" type="button" aria-label="Fechar">×</button></header><p id="profanityPickerCopy">Escolha as palavras por voz. Depois, no Sync, marque o início e o fim de cada uma para silenciar os vocais.</p><div id="profanityVoiceTabs" class="profanity-voice-tabs" role="tablist" aria-label="Voz da letra"></div><div id="profanityPickerWords" class="profanity-picker-words"></div><footer><span id="profanitySelectionCount" role="status" aria-live="polite"></span><button class="btn" id="saveProfanityWords" type="button">Salvar seleção</button></footer></section>`;
let profanityPickerVoice='lead',profanityPickerSongId=null,profanityPickerReturnFocus=null,profanityPickerBusy=false;
document.body.append(profanityPicker);
document.body.append(lyricsDialog);
const manualSyncStyle = document.createElement('style');
manualSyncStyle.textContent = `.manual-sync-dialog{position:fixed;inset:0;z-index:45;display:none;place-items:center;padding:18px;background:#08090bdc;backdrop-filter:blur(12px)}.manual-sync-dialog.show{display:grid}.manual-sync-card{width:min(680px,100%);max-height:90vh;overflow:auto;padding:22px;border-radius:18px;background:linear-gradient(145deg,#202124,#141416);border:1px solid #414148;box-shadow:0 24px 80px #000b}.manual-sync-card header{display:flex;align-items:center;justify-content:space-between}.manual-sync-card h2{font:700 22px Manrope;margin:5px 0 0}.manual-sync-copy{color:#aaa;font-size:11px;line-height:1.5;margin:12px 0}.manual-sync-card textarea{width:100%;resize:vertical;min-height:150px;padding:12px;border-radius:10px;border:1px solid #3d3d42;background:#111113;color:#f4f4f5;font:12px/1.7 'DM Sans',sans-serif;outline:none}.manual-sync-card textarea:focus{border-color:#95b94a}.manual-sync-current{min-height:54px;display:grid;place-items:center;margin-top:12px;padding:12px;border-radius:10px;background:#17191a;border:1px solid #3b4032;text-align:center;color:#f5f5f3;font:700 clamp(16px,2.5vw,24px)/1.35 Manrope}.manual-sync-progress{margin-top:8px;color:#b9d773;font-size:10px;text-align:center}.manual-sync-card footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:15px}.manual-sync-card footer button{font-size:10px;padding:9px 11px}.manual-sync-card button:disabled{opacity:.42;cursor:not-allowed}.lyrics-paste{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;margin-top:12px;padding:12px;border:1px solid #38383e;border-radius:11px;background:#171719}.lyrics-paste label{grid-column:1/-1;color:#cfd0d2;font-size:11px;font-weight:650}.lyrics-paste textarea{min-width:0;min-height:74px;resize:vertical;padding:10px;border:1px solid #3d3d42;border-radius:8px;background:#111113;color:#eee;font:11px/1.6 'DM Sans',sans-serif}.lyrics-paste button{align-self:end;padding:8px 10px;font-size:10px}.lyrics-dialog-card #manualSyncOpen{margin-top:10px;padding:8px 11px;font-size:10px}@media(max-width:590px){.manual-sync-card{padding:17px}.manual-sync-card footer{display:grid;grid-template-columns:1fr}.manual-sync-card footer button{justify-content:center}.lyrics-paste{grid-template-columns:1fr}.lyrics-paste button{justify-self:end}}`;
manualSyncStyle.textContent += `.manual-sync-dialog{place-items:end center;padding:20px 20px clamp(138px,17vh,190px);background:transparent;backdrop-filter:none;pointer-events:none}.manual-sync-card{width:min(760px,100%);max-height:min(58vh,520px);padding:16px 20px;background:#17181deb;backdrop-filter:blur(14px);pointer-events:auto}.manual-sync-card header{margin-bottom:4px}.manual-sync-card h2{font-size:18px}.manual-sync-copy{margin:6px 0 10px}.manual-sync-current{min-height:66px;margin-top:0;font-size:clamp(22px,3.2vw,40px);text-shadow:0 2px 14px #000}.manual-sync-card textarea{min-height:90px;max-height:28vh}.manual-sync-card textarea[hidden]{display:none!important}.manual-sync-card footer{justify-content:center;margin-top:10px}.manual-sync-card footer button{min-height:42px}.manual-sync-card #editManualLyrics{margin-right:auto}.manual-sync-card #markManualSync{order:2;flex:1 0 100%;min-height:clamp(60px,8vh,78px);padding:14px 20px;border:1px solid #c8f568;border-radius:13px;background:linear-gradient(135deg,#d7ff73,#b7ed4f);color:#16190d;font:800 clamp(15px,2vw,19px)/1.2 Manrope,sans-serif;box-shadow:0 5px 22px #b9ed4e2e;touch-action:manipulation}.manual-sync-card #markManualSync:not(:disabled):active{transform:translateY(1px) scale(.99)}.manual-sync-card #markManualSync:disabled{background:#41443a;border-color:#55584b;color:#b3b5ad;box-shadow:none}.manual-sync-card #saveManualSync{order:3;min-height:42px;padding:10px 18px;font-size:12px}.manual-sync-card #undoManualSync,.manual-sync-card #startManualSync,.manual-sync-card #editManualLyrics{order:1}.manual-sync-modes{display:flex;gap:7px;margin:0 0 10px}.manual-sync-modes .selected{border-color:#c8f568;color:#d8ff78;background:#292e1e}.manual-sync-modes[hidden]{display:none!important}.manual-sync-card .manual-sync-context{display:block;color:#aeb1ad;font:500 11px/1.4 'DM Sans',sans-serif;margin-bottom:2px}.manual-sync-repair-toggle[hidden],.manual-sync-picker[hidden]{display:none!important}.manual-sync-repair-toggle{font-size:10px!important;padding:7px 10px!important;margin:0 0 9px}.manual-sync-repair-toggle.selected{border-color:#c8f568;color:#d8ff78;background:#292e1e}.manual-sync-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;max-height:145px;overflow:auto;padding:7px;margin:0 0 10px;border:1px solid #36383b;border-radius:9px;background:#121315}.manual-sync-picker label{display:flex;align-items:flex-start;gap:7px;min-width:0;padding:6px 7px;border-radius:6px;background:#1c1d1f;color:#ddd;font:11px/1.35 'DM Sans',sans-serif;cursor:pointer}.manual-sync-picker label:has(input:checked){background:#292e1e;color:#e3ff9c}.manual-sync-picker input{flex:0 0 auto;accent-color:var(--lime);margin:2px 0 0}.manual-sync-picker span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.manual-sync-current.manual-sync-phrase{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:.12em .38em;min-height:94px;padding:16px 22px;font-size:clamp(23px,3.6vw,43px);line-height:1.4}.manual-sync-phrase .lyric-word.active:before{content:''!important;position:absolute;width:10px;height:10px;left:50%;top:-.48em;transform:translateX(-50%);border-radius:50%;background:var(--word-marker,#b5f34b);box-shadow:0 0 12px var(--word-marker,#b5f34b);animation:travelingWordHop .46s cubic-bezier(.2,.75,.25,1)}@media(max-width:590px){.manual-sync-dialog{padding:12px 12px 148px}.manual-sync-card{max-height:54vh;padding:13px}.manual-sync-card footer{display:flex;flex-wrap:wrap}.manual-sync-card #editManualLyrics{margin-right:0}.manual-sync-card #markManualSync{font-size:16px;min-height:62px}.manual-sync-picker{grid-template-columns:1fr}.manual-sync-current.manual-sync-phrase{font-size:clamp(21px,5vw,31px);padding:12px 8px}}`;
manualSyncStyle.textContent += `.sync-focus-row{display:flex;align-items:center;gap:6px;margin:0 0 10px;padding:7px 9px;border:1px solid #35363b;border-radius:10px;background:#121315;color:#aeb0b5;font-size:10px}.sync-focus-row>span{margin-right:3px;text-transform:uppercase;letter-spacing:.08em;font-size:9px}.sync-focus-row button{min-height:30px;padding:5px 9px;font-size:10px}.sync-focus-row button.selected{border-color:#c8f568;color:#d8ff78;background:#292e1e}.sync-focus-row[hidden]{display:none!important}.sync-focus-row button:disabled{opacity:.75;cursor:default}.sync-stage-focus{color:#c9db9f;font-size:10px;font-weight:700}@media(max-width:590px){.sync-focus-row{flex-wrap:wrap}.sync-focus-row>span{flex-basis:100%}.sync-focus-row button{flex:1;min-width:0;padding:5px 6px;font-size:9px}}`;
const manualSyncHopStyle = document.createElement('style');
manualSyncHopStyle.textContent = `.manual-sync-phrase .lyric-word.active:before{animation:manualSyncWordHop .46s cubic-bezier(.2,.75,.25,1)}@keyframes manualSyncWordHop{0%{opacity:.65;transform:translate(-50%,.16em) scale(.75)}32%{opacity:1;transform:translate(-50%,-.9em) scale(1.2)}62%{transform:translate(-50%,-.1em) scale(.94)}82%{transform:translate(-50%,-.35em) scale(1.06)}100%{opacity:1;transform:translate(-50%,0) scale(1)}}`;
document.head.append(manualSyncHopStyle);
manualSyncStyle.textContent += `.voice-editors{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}.voice-editors[hidden]{display:none!important}.voice-editor{display:flex;flex-direction:column;gap:5px;min-width:0;padding:9px;border:1px solid #35363b;border-radius:10px;background:#16171a}.voice-editor.selected{border-color:#b4d75b}.voice-editor b{font-size:12px;color:#d6ed99}.voice-editor[data-voice-editor=parallel] b{color:#b9cfff}.voice-editor[data-voice-editor=backing] b{color:#d8baff}.voice-editor small{color:#a9aab0;font-size:10px;min-height:26px}.voice-editor textarea{box-sizing:border-box;flex:1;min-width:0;min-height:140px}.assignment{grid-template-columns:20px minmax(0,1fr) auto 32px!important}.assignment-remove{width:32px;height:32px;border-radius:7px;background:#2c2326;color:#f2b0b4;border:1px solid #694049;cursor:pointer;font-size:20px;line-height:1}.assignment-remove:hover{background:#573039}.assignment-remove:focus-visible{outline:2px solid #e7ed9b;outline-offset:2px}.lyric-second-line{display:block;margin:.4em auto;font-size:.8em;color:#b9cfff;line-height:1.4}.lyric-voice-label{display:block;font:700 10px/1.5 'DM Sans',sans-serif;letter-spacing:.1em;opacity:.7;text-transform:uppercase}.lyric-second-line .active{color:var(--lyric-accent,var(--lime));text-shadow:0 0 14px currentColor}.lyric-current-line[hidden]{display:none!important}@media(max-width:590px){.voice-editors{grid-template-columns:1fr}.voice-editor textarea{min-height:100px}.voice-editor small{min-height:0}.assignment{gap:6px!important}.assignment select{max-width:138px}.lyric-second-line{font-size:.85em}}`;
manualSyncStyle.textContent += '.voice-extract{grid-column:1/-1;display:flex;align-items:center;flex-wrap:wrap;gap:8px}.voice-extract small{font-size:10px;color:#aaa;flex:1;min-width:180px}.voice-extract button{font-size:10px;padding:8px}.lyric-second-line[hidden]{display:none!important}';
document.head.append(manualSyncStyle);
const manualSilenceStyle = document.createElement('style');
manualSilenceStyle.textContent = `.manual-silence-tracker{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0 0;padding:9px 10px;border:1px solid #3c3d42;border-radius:9px;background:#111214}.manual-silence-tracker>div:first-child{display:grid;gap:3px;min-width:0}.manual-silence-tracker strong{font-size:10px;color:#eee}.manual-silence-tracker small{font-size:9px;color:#aeb0b5}.manual-silence-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.manual-silence-actions button{min-height:32px!important;padding:6px 8px!important;font-size:9px!important}.profanity-offset-settings{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px;padding:10px;border:1px solid #34363a;border-radius:10px;background:#111214}.profanity-offset-settings>b,.profanity-offset-settings>p{grid-column:1/-1;margin:0}.profanity-offset-settings>b{font-size:11px}.profanity-offset-settings>p{color:#aeb0b5;font-size:10px}.profanity-offset-settings>label{display:grid;gap:5px;padding:8px;border-radius:8px;background:#1a1b1f;font-size:10px}.profanity-offset-settings>label span{display:flex;align-items:center;gap:4px;font-weight:700}.profanity-offset-settings input{width:86px;padding:5px;border:1px solid #45474c;border-radius:6px;background:#101114;color:#eee;font:inherit}.profanity-offset-settings>label small{color:#aeb0b5;font-size:9px}.sync-silence-mode[aria-pressed="true"]{border-color:#c8ef69!important;color:#d8ff78!important;background:#282e1e!important}.manual-sync-select-all{grid-column:1/-1;justify-self:start;padding:6px 9px;border:1px solid #4a4d3e;border-radius:7px;background:#25291e;color:#d8f791;font:650 10px 'DM Sans',sans-serif;cursor:pointer}.lyric-pause-clock{margin-left:.3em;padding:.08em .38em;border-radius:999px;background:#111a;color:currentColor;font:700 .48em/1.3 'DM Sans',sans-serif;font-variant-numeric:tabular-nums}.lyric-pause-clock[hidden]{display:none!important}@media(max-width:590px){.manual-silence-tracker{align-items:flex-start;flex-direction:column}.manual-silence-actions{justify-content:flex-start}.manual-silence-actions button{flex:1}.profanity-offset-settings{grid-template-columns:1fr}}`;
document.head.append(manualSilenceStyle);
manualSilenceStyle.textContent += `.silence-from-start{display:flex;align-items:center;gap:7px;margin-top:5px;color:#c9d3b1;font-size:10px;cursor:pointer}.silence-from-start input{accent-color:var(--lime);margin:0;flex:none}`;
manualSilenceStyle.textContent += `.censor-sync-section{margin:9px 0;padding:10px;border:1px solid #4b3643;border-radius:10px;background:#211920}.censor-sync-section>b{display:block;font-size:11px;color:#ffb5d0}.censor-sync-section>p{margin:4px 0 8px;color:#bbb;font-size:10px;line-height:1.45}.censor-sync-section>.btn{min-height:34px;margin-right:5px;font-size:10px}.profanity-picker-words>div{padding:7px 0;border-bottom:1px solid #ffffff13}.profanity-pick-word.selected{border-color:#ff9cbd!important;background:#5c2b44!important;color:white!important}`;
const manualSilenceLyricsStyle = document.createElement('style');
manualSilenceLyricsStyle.textContent = `.lyrics.manual-vocal-silence .lyric-current-line{opacity:.75}`;
document.head.append(manualSilenceLyricsStyle);
const manualSyncLayoutStyle = document.createElement('style');
manualSyncLayoutStyle.textContent = '';
document.head.append(manualSyncLayoutStyle);
$('closeLyricsDialog').onclick = closeLyricsDialog;
$('searchLyricsButton').onclick = () => searchLyrics(false);
$('applyPastedLyrics').onclick = applyPastedLyrics;
$('lyricsQuery').onkeydown = event => { if (event.key === 'Enter') searchLyrics(false); };
lyricsDialog.onclick = event => { if (event.target === lyricsDialog) closeLyricsDialog(); };
function selectProfanityVoice(voice,focus=false) {
  profanityPickerVoice=voice;
  for(const tab of $('profanityVoiceTabs').querySelectorAll('[data-censor-voice]')){
    const selected=tab.dataset.censorVoice===voice;
    tab.classList.toggle('selected',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    $(tab.getAttribute('aria-controls')).hidden=!selected;
    if(selected&&focus)tab.focus({preventScroll:true});
  }
}
function updateProfanitySelectionCount(){
  const selected=$('profanityPickerWords').querySelectorAll('.profanity-pick-word.selected');
  $('profanitySelectionCount').textContent=interfaceLanguage==='en-US'?`${selected.length} selected`:`${selected.length} selecionada${selected.length===1?'':'s'}`;
  for(const tab of $('profanityVoiceTabs').querySelectorAll('[data-censor-voice]')){
    const count=$(tab.getAttribute('aria-controls')).querySelectorAll('.selected').length;
    const badge=tab.querySelector('small');badge.textContent=count;badge.hidden=!count;
  }
}
function closeProfanityPicker(){
  if(profanityPickerBusy)return;
  profanityPicker.classList.remove('show');
  if(profanityPickerReturnFocus?.isConnected)profanityPickerReturnFocus.focus({preventScroll:true});
}
function openProfanityPickerForCurrent() {
  if(!current||profanityPickerBusy)return;
  profanityPickerReturnFocus=document.activeElement;profanityPickerSongId=current.id;
  const fullscreenLayer=document.fullscreenElement||(display?.classList.contains('show')?display:null);
  (fullscreenLayer||document.body).append(profanityPicker);
  const lines=current.lyricLines?.length?current.lyricLines:String(current.plainLyrics||'').split(/\r?\n/).filter(Boolean).map(text=>({text}));
  const groups={lead:[],parallel:[],backing:[]};
  lines.forEach((line,lineIndex)=>{
    const entries=lyricWordEntries(line.text),track=line.voice||line.source;
    for(const voice of VoxStageLyrics.tracks){
      const selected=entries.flatMap((entry,wordIndex)=>{
        const source=track==='parallel'?'parallel':track==='backing'||isBackingLyric(line.text)?'backing':entry.parallel?'parallel':'lead';
        if(source!==voice||source==='parallel'&&line.activeWordIndices&&!line.activeWordIndices.includes(wordIndex))return [];
        return [{...entry,wordIndex}];
      });
      if(!selected.length)continue;
      const markup=selected.map((entry,index)=>(index?esc(entry.joiner||' '):'')+`<button type="button" class="profanity-pick-word${isProfanityOccurrence(lineIndex,entry.wordIndex,entry.word)?' selected':''}" aria-pressed="${isProfanityOccurrence(lineIndex,entry.wordIndex,entry.word)}" data-line-index="${lineIndex}" data-word-index="${entry.wordIndex}" data-word="${esc(entry.word)}">${esc(entry.word)}</button>`).join('');
      groups[voice].push(`<div class="profanity-phrase" data-line-index="${lineIndex}">${markup}</div>`);
    }
  });
  const labels={lead:interfaceLanguage==='en-US'?'Voice 1':'Voz 1',parallel:interfaceLanguage==='en-US'?'Voice 2':'Voz 2',backing:'Backing'};
  $('profanityPickerTitle').textContent=interfaceLanguage==='en-US'?'Choose each occurrence':'Escolha cada ocorrência';
  $('profanityPickerCopy').textContent=interfaceLanguage==='en-US'?'Choose words by voice. Then use Sync to mark each start and end for muting.':'Escolha as palavras por voz. Depois, no Sync, marque o início e o fim de cada uma para silenciar os vocais.';
  $('saveProfanityWords').textContent=interfaceLanguage==='en-US'?'Save selection':'Salvar seleção';
  $('profanityVoiceTabs').innerHTML=VoxStageLyrics.tracks.map(voice=>`<button type="button" id="censorTab-${voice}" role="tab" data-censor-voice="${voice}" aria-controls="censorWords-${voice}" aria-selected="false" tabindex="-1"><span>${labels[voice]}</span><small hidden></small></button>`).join('');
  $('profanityPickerWords').innerHTML=VoxStageLyrics.tracks.map(voice=>`<section id="censorWords-${voice}" role="tabpanel" aria-labelledby="censorTab-${voice}" hidden>${groups[voice].join('')||`<p class="profanity-empty">${interfaceLanguage==='en-US'?'No lines from this voice in these lyrics.':'Nenhuma linha desta voz nesta letra.'}</p>`}</section>`).join('');
  profanityPicker.classList.add('show');
  const preferred=manualSyncDialog.classList.contains('show')?manualSyncFocus:profanityPickerVoice;
  selectProfanityVoice(groups[preferred]?.length?preferred:VoxStageLyrics.tracks.find(voice=>groups[voice].length)||'lead',true);
  updateProfanitySelectionCount();$('profanityPickerWords').scrollTop=0;
}
$('profanityVoiceTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-censor-voice]');if(tab&&!profanityPickerBusy){selectProfanityVoice(tab.dataset.censorVoice);$('profanityPickerWords').scrollTop=0;}});
$('profanityPickerWords').addEventListener('click',event=>{
  const button=event.target.closest('.profanity-pick-word');if(!button||profanityPickerBusy)return;
  button.classList.toggle('selected');button.setAttribute('aria-pressed',String(button.classList.contains('selected')));updateProfanitySelectionCount();
});
$('closeProfanityPicker').onclick=closeProfanityPicker;
$('saveProfanityWords').onclick=async()=>{
  if(profanityPickerBusy||!current||current.id!==profanityPickerSongId){if(!profanityPickerBusy)closeProfanityPicker();return;}
  const songId=current.id,marks=[...$('profanityPickerWords').querySelectorAll('.profanity-pick-word.selected')].map(button=>({lineIndex:Number(button.dataset.lineIndex),wordIndex:Number(button.dataset.wordIndex),word:button.dataset.word}));
  const cues=(current.profanityCues||[]).filter(cue=>marks.some(mark=>mark.lineIndex===Number(cue.lineIndex)&&mark.wordIndex===Number(cue.wordIndex)&&lyricTokenKey(mark.word)===lyricTokenKey(cue.word)));
  const song=songs.find(item=>item.id===songId);
  profanityPickerBusy=true;profanityPicker.querySelectorAll('button').forEach(button=>button.disabled=true);
  try{
    if(!song)throw new Error('Música não encontrada na biblioteca.');
    await api('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...song,profanityMarks:marks,profanityCues:cues})});
    Object.assign(song,{profanityMarks:marks,profanityCues:cues});
    if(current?.id===songId){Object.assign(current,{profanityMarks:marks,profanityCues:cues,playbackTracks:null,lyricIndex:null});updateLyrics(playbackPosition());}
    profanityPickerBusy=false;closeProfanityPicker();
    toast(interfaceLanguage==='en-US'?`${marks.length} selected occurrence(s) saved.`:`${marks.length} ocorrência${marks.length===1?'':'s'} marcada${marks.length===1?'':'s'}.`);
  }catch(error){console.error('Falha ao salvar a censura',error);toast(interfaceLanguage==='en-US'?'Could not save. Your selection is still here to retry.':'Não consegui salvar. Sua seleção continua aqui para tentar novamente.');}
  finally{profanityPickerBusy=false;profanityPicker.querySelectorAll('button').forEach(button=>button.disabled=false);}
};
profanityPicker.addEventListener('click',event=>{if(event.target===profanityPicker)closeProfanityPicker();});
profanityPicker.addEventListener('keydown',event=>{
  event.stopPropagation();
  if(event.key==='Escape'){event.preventDefault();closeProfanityPicker();return;}
  if(profanityPickerBusy)return;
  const tab=event.target.closest('[data-censor-voice]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();const tracks=VoxStageLyrics.tracks,index=tracks.indexOf(tab.dataset.censorVoice);
    const next=event.key==='Home'?0:event.key==='End'?tracks.length-1:(index+(event.key==='ArrowRight'?1:-1)+tracks.length)%tracks.length;
    selectProfanityVoice(tracks[next],true);$('profanityPickerWords').scrollTop=0;
  }
  if(event.key==='Tab'){
    const controls=[...profanityPicker.querySelectorAll('button:not(:disabled)')].filter(button=>button.getClientRects().length),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});

const manualSyncDialog = document.createElement('div'); manualSyncDialog.className = 'manual-sync-dialog'; manualSyncDialog.id = 'manualSyncDialog';
manualSyncDialog.innerHTML = `<section class="manual-sync-card" role="dialog" aria-modal="false" aria-labelledby="manualSyncTitle"><header><div><span class="lyrics-kicker">SINCRONIZAÇÃO LEVE</span><h2 id="manualSyncTitle">Marcar letra por linha</h2></div><button class="lyrics-close" id="closeManualSync" aria-label="Fechar">×</button></header><p class="manual-sync-copy" id="manualSyncCopy">Acompanhe a letra no palco. Use o botão grande quando a frase começar. A reprodução e a barra de busca continuam acessíveis.</p><div class="manual-sync-modes" role="group" aria-label="Método de sincronização"><button class="btn secondary selected" type="button" data-sync-mode="line" aria-pressed="true">Por linha</button><button class="btn secondary" type="button" data-sync-mode="word" aria-pressed="false">Palavra por palavra</button></div><div class="sync-focus-row" id="manualSyncFocusRow" role="group" aria-label="Foco vocal"><span>Foco</span><button class="btn secondary selected" type="button" data-sync-focus="lead" aria-pressed="true">Principal</button><button class="btn secondary" type="button" data-sync-focus="parallel" aria-pressed="false">Paralelo [ ]</button><button class="btn secondary" type="button" data-sync-focus="backing" aria-pressed="false">Backing ( )</button></div><button class="btn secondary manual-sync-repair-toggle" id="toggleLineRepair" type="button" aria-expanded="false" aria-pressed="false" hidden>Selecionar linhas para corrigir</button><div class="manual-sync-picker" id="manualSyncLinePicker" role="group" aria-label="Linhas para corrigir" hidden></div><div class="voice-editors" id="manualVoiceEditors"><label class="voice-editor" data-voice-editor="lead"><b>Voz 1</b><small>Vocal principal</small><textarea id="manualSyncText" rows="5" aria-label="Letra da Voz 1" placeholder="Uma frase por linha"></textarea></label><label class="voice-editor" data-voice-editor="parallel"><b>Voz 2</b><small>Dueto ou segunda voz, mesmo sozinha</small><textarea id="manualSyncParallelText" rows="5" aria-label="Letra da Voz 2" placeholder="Uma frase por linha"></textarea></label><label class="voice-editor" data-voice-editor="backing"><b>Backing</b><small>Apoios e respostas</small><textarea id="manualSyncBackingText" rows="5" aria-label="Letra do backing" placeholder="Uma frase por linha"></textarea></label></div><div class="manual-sync-current" id="manualSyncCurrent">Cole ou edite a letra acima.</div><div class="manual-sync-progress" id="manualSyncProgress">0 linhas marcadas</div><footer><button class="btn secondary" id="editManualLyrics" type="button" hidden>✎ Editar letra</button><button class="btn secondary" id="startManualSync">▶ Começar do início</button><button class="btn secondary" id="undoManualSync" disabled>↶ Desfazer</button><button class="btn" id="markManualSync" disabled>Marcar início da frase</button><button class="btn" id="saveManualSync" disabled>Salvar sync</button></footer></section>`;
manualSyncDialog.querySelector('.manual-sync-modes').insertAdjacentHTML('afterend', '<section class="censor-sync-section"><b>Censura palavra por palavra</b><p>Escolha ocorrências e marque o início e o fim de cada uma, sem alterar o sync da letra.</p><button class="btn secondary" id="openProfanityPicker" type="button">Escolher palavras</button> <button class="btn secondary" id="startCensorSync" type="button">▶ Sincronizar censura</button></section>');
manualSyncDialog.querySelector('#manualVoiceEditors').insertAdjacentHTML('beforeend','<div class="voice-extract"><button class="btn secondary" type="button" id="extractLegacyVoices">Extrair () e [] da Voz 1</button><small>Move parênteses para Backing e colchetes para Voz 2, inclusive na mesma linha. Os campos continuam independentes.</small></div>');
manualSyncDialog.querySelector('#extractLegacyVoices').onclick=()=>{
  if(manualSyncState)return;
  try {
    flushManualVoiceEditors();
    manualSyncVoices=VoxStageLyrics.extractLegacy(manualSyncVoices,manualSyncEditor('lead').value);
    for(const track of VoxStageLyrics.tracks)manualSyncEditor(track).value=VoxStageLyrics.editorText(manualSyncVoices[track]);
    refreshManualVoicePanels();refreshManualSyncLinePicker();updateManualSaveButton();
    toast('Trechos movidos para Voz 2 e Backing. Salve para manter.');
  }catch(error){toast(error.message);}
};
manualSyncDialog.querySelector('#openProfanityPicker').onclick = openProfanityPickerForCurrent;
manualSyncDialog.querySelector('#manualSyncProgress').insertAdjacentHTML('afterend', `<section class="manual-silence-tracker" aria-label="Marcador manual de silêncio"><div><strong>${interfaceLanguage === 'en-US' ? 'Manual vocal silence' : 'Silêncio vocal manual'}</strong><small id="manualSilenceStatus"></small><label class="silence-from-start"><input id="silenceFromStart" type="checkbox"> ${interfaceLanguage === 'en-US' ? 'Start with silence (0:00 → first tap marks the end)' : 'Começar com silêncio (0:00 → primeiro toque marca o fim)'}</label></div><div class="manual-silence-actions"><button class="btn secondary sync-silence-mode" id="toggleSilenceSync" type="button">${interfaceLanguage === 'en-US' ? 'Mark silences' : 'Marcar silêncios'}</button><button class="btn secondary" id="undoManualSilence" type="button" disabled>${interfaceLanguage === 'en-US' ? 'Undo last silence' : 'Desfazer último silêncio'}</button></div></section>`);
const syncEditorCard=manualSyncDialog.querySelector('.manual-sync-card');
syncEditorCard.setAttribute('aria-modal','true');
syncEditorCard.querySelector('.lyrics-kicker').textContent='LETRAS E VOZES';
const syncEditorBody=document.createElement('div');syncEditorBody.className='sync-editor-body';
syncEditorCard.querySelector('header').after(syncEditorBody);
const syncEditorToolbar=document.createElement('div');syncEditorToolbar.className='sync-editor-toolbar';
const voiceTabs=manualSyncDialog.querySelector('#manualSyncFocusRow');
voiceTabs.setAttribute('role','tablist');voiceTabs.setAttribute('aria-label','Voz para editar e sincronizar');
syncEditorToolbar.append(voiceTabs,manualSyncDialog.querySelector('.manual-sync-modes'));
syncEditorBody.append(syncEditorToolbar,manualSyncDialog.querySelector('#manualVoiceEditors'),manualSyncDialog.querySelector('#manualSyncCopy'),manualSyncDialog.querySelector('#toggleLineRepair'),manualSyncDialog.querySelector('#manualSyncLinePicker'));
const voiceNames={lead:'Vocal principal',parallel:'Segunda voz',backing:'Apoios e respostas'};
for(const [voice,name] of Object.entries(voiceNames)){
  const old=manualSyncDialog.querySelector('[data-voice-editor="'+voice+'"]'),editor=old.querySelector('textarea');
  const panel=document.createElement('section');panel.className='voice-editor';panel.dataset.voiceEditor=voice;
  panel.id='manualVoicePanel-'+voice;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','manualVoiceTab-'+voice);panel.hidden=voice!=='lead';
  panel.innerHTML='<div class="voice-editor-meta"><label for="'+editor.id+'">'+name+'</label><span data-voice-count="'+voice+'"></span></div>';
  panel.append(editor);old.replaceWith(panel);
  const tab=voiceTabs.querySelector('[data-sync-focus="'+voice+'"]');tab.id='manualVoiceTab-'+voice;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);
}
const syncEditorTools=document.createElement('div');syncEditorTools.className='sync-editor-tools';
for(const [id,title,content] of [
  ['syncCensorTool','Censura de palavras',manualSyncDialog.querySelector('.censor-sync-section')],
  ['syncExtractTool','Separar vozes de uma letra',manualSyncDialog.querySelector('.voice-extract')],
  ['syncSilenceTool','Silêncios vocais',manualSyncDialog.querySelector('.manual-silence-tracker')]
]){
  const detail=document.createElement('details');detail.className='sync-editor-tool';detail.id=id;
  const summary=document.createElement('summary');summary.textContent=title;detail.append(summary,content);syncEditorTools.append(detail);
}
syncEditorBody.append(syncEditorTools,manualSyncDialog.querySelector('#manualSyncCurrent'),manualSyncDialog.querySelector('#manualSyncProgress'));
syncEditorCard.querySelector('header').after(syncEditorBody);
manualSyncDialog.querySelector('#extractLegacyVoices').textContent='Separar Voz 2 e Backing';
voiceTabs.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||[...voiceTabs.querySelectorAll('button')].every(button=>button.disabled))return;
  event.preventDefault();const buttons=[...voiceTabs.querySelectorAll('[data-sync-focus]')],index=buttons.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
  buttons[next].focus();setManualSyncFocus(buttons[next].dataset.syncFocus);
});
function updateSyncEditorViewport(){
  const viewport=window.visualViewport;
  manualSyncDialog.style.setProperty('--sync-viewport-height',Math.min(innerHeight,viewport?.height||innerHeight)+'px');
  manualSyncDialog.style.setProperty('--sync-viewport-top',(viewport?.offsetTop||0)+'px');
}
window.visualViewport?.addEventListener('resize',updateSyncEditorViewport);
window.visualViewport?.addEventListener('scroll',updateSyncEditorViewport);
window.addEventListener('resize',updateSyncEditorViewport);
updateSyncEditorViewport();
document.body.append(manualSyncDialog);
// Setup is a real modal. Recording controls live inside the stage, never over the lyrics.
const syncToolbar = document.createElement('section');
syncToolbar.id = 'syncToolbar'; syncToolbar.hidden = true;
syncToolbar.setAttribute('aria-label', 'Controles de sincronização');
syncToolbar.innerHTML = `<div id="syncStageStatus" role="status"></div><div class="sync-actions"><button class="hud-btn" id="syncPause">Pausar</button><button class="hud-btn" id="syncUndo">Desfazer</button><button class="hud-btn" id="syncEdit">Editar letra</button><button class="hud-btn" id="syncSave">Salvar</button><button class="hud-btn" id="syncCancel">Cancelar</button></div>`;
$('display').append(syncToolbar);
function enterSyncStage() {
  manualSyncDialog.classList.remove('show', 'recording');
  $('display').classList.add('sync-editing'); syncToolbar.hidden = false;
  manualSyncState.stagePreviewKey = null;
  updateManualSyncProgress();
}
function leaveSyncStage() {
  $('display').classList.remove('sync-editing'); syncToolbar.hidden = true;
}
function updateSyncToolbar() {
  if (!manualSyncState) return;
  if (manualSyncState.mode === 'censor' || manualSyncState.mode === 'silence') {
    $('syncStageStatus').textContent = $('manualSyncProgress').textContent;
    $('syncEdit').hidden = true;
    $('syncUndo').disabled = $('undoManualSync').disabled;
    $('syncSave').disabled = $('saveManualSync').disabled;
    $('syncPause').textContent = playing ? 'Pausar' : 'Continuar';
    return;
  }
  $('syncEdit').hidden = false;
  const lineIndex = (manualSyncState.lineTargets || manualSyncState.lines.map((_,index)=>index))[manualSyncState.nextIndex];
  const syncHint = manualSyncState.mode !== 'line' ? '' : manualSyncState.pendingBackingEnd
    ? ' · toque na letra para marcar o fim da frase'
    : lineIndex!==undefined ? ' · toque na letra quando a frase começar' : '';
  $('syncStageStatus').textContent = `${syncFocusLabel(manualSyncState.focus)} · ${$('manualSyncProgress').textContent}${syncHint}`;
  $('syncUndo').disabled = $('undoManualSync').disabled;
  $('syncSave').disabled = $('saveManualSync').disabled;
  $('syncPause').textContent = playing ? 'Pausar' : 'Continuar';
}
$('syncPause').onclick = () => { toggle(); updateSyncToolbar(); };
$('syncUndo').onclick = () => undoManualSyncLine();
$('syncEdit').onclick = () => editManualLyrics();
$('syncSave').onclick = () => saveManualSync();
$('syncCancel').onclick = () => $('closeManualSync').click();
let manualSyncReturn = null;
let manualSyncVoices = null;
let manualSyncState = null;
let manualVoiceSavePending = false;
let manualSyncMode = 'line';
let manualSyncFocus = 'lead';
let manualSyncRepairEnabled = false;
let manualSyncCanRepair = false;
let manualSyncPickerState = {lines:[], ids:[], selectedIds:new Set(), nextId:0};
let manualSilenceStartMs = null;
function manualSyncEditor(track = manualSyncFocus) {
  return $(track==='backing'?'manualSyncBackingText':track==='parallel'?'manualSyncParallelText':'manualSyncText');
}
function manualEditorLines() {
  return VoxStageLyrics.voiceTextRows(manualSyncEditor().value,manualSyncFocus).map(row=>VoxStageLyrics.encode(row.text,manualSyncFocus));
}
function refreshManualVoicePanels(){
  if(!manualSyncState)$('startManualSync').disabled=!manualSyncEditor().value.trim()||!current?.buffers?.Inst;
  for(const voice of VoxStageLyrics.tracks){
    const panel=$('manualVoicePanel-'+voice),count=manualSyncEditor(voice).value.split(/\r?\n/).filter(line=>line.trim()).length;
    panel.hidden=voice!==manualSyncFocus;panel.classList.toggle('selected',!panel.hidden);
    panel.querySelector('[data-voice-count]').textContent=interfaceLanguage==='en-US'?(count?count+' line'+(count===1?'':'s'):'No lyrics'):(count?count+' linha'+(count===1?'':'s'):'Sem letra');
  }
}
function restoreManualVoiceEditors() {
  $('manualVoiceEditors').hidden=false;
  $('extractLegacyVoices').disabled=Boolean(manualSyncState);
  syncEditorTools.hidden=Boolean(manualSyncState);
  for(const track of VoxStageLyrics.tracks) {const editor=manualSyncEditor(track);editor.hidden=false;editor.disabled=false;}
  refreshManualVoicePanels();
}
function flushManualVoiceEditors() {
  if(!manualSyncVoices)return;
  for(const track of VoxStageLyrics.tracks) {
    const text=manualSyncEditor(track).value;
    if(text.split(/\r?\n/).filter(line=>line.trim()).length>500 || VoxStageLyrics.words(text).length>5000)
      throw new Error('Use até 500 linhas e 5.000 palavras por voz.');
    manualSyncVoices[track]=VoxStageLyrics.reconcile(manualSyncVoices[track],text,track);
  }
}
function manualSyncNeedsEnd(line) {
  return Boolean(String(line||'').trim());
}
function updateManualSilenceControls() {
  const undoButton = $('undoManualSilence'), status = $('manualSilenceStatus');
  if (!undoButton || !status) return;
  const pending = manualSilenceStartMs !== null;
  const marks = current?.manualVocalSilences || [];
  const heading = status.closest('.manual-silence-tracker')?.querySelector('strong');
  if (heading) heading.textContent = interfaceLanguage === 'en-US' ? 'Manual vocal silence' : 'Silêncio vocal manual';
  const fromStartLabel=$('silenceFromStart')?.closest('label');
  if (fromStartLabel) fromStartLabel.lastChild.textContent=interfaceLanguage === 'en-US' ? ' Start with silence (from 0:00)' : ' Começar com silêncio (a partir de 0:00)';
  undoButton.textContent = interfaceLanguage === 'en-US' ? 'Undo last silence' : 'Desfazer último silêncio';
  undoButton.disabled = !marks.length;
  const modeButton = $('toggleSilenceSync');
  if (modeButton) { modeButton.textContent = interfaceLanguage === 'en-US' ? 'Mark silences' : 'Marcar silêncios'; modeButton.disabled=!current?.buffers?.Inst; }
  const savedCount = marks.length;
  status.textContent = pending
    ? interfaceLanguage === 'en-US' ? `Start marked at ${(manualSilenceStartMs / 1000).toFixed(1)}s · mark the end` : `Início marcado em ${(manualSilenceStartMs / 1000).toFixed(1)}s · marque o fim`
    : savedCount ? interfaceLanguage === 'en-US' ? `${savedCount} silence${savedCount === 1 ? '' : 's'} saved` : `${savedCount} silêncio${savedCount === 1 ? '' : 's'} marcado${savedCount === 1 ? '' : 's'}`
      : interfaceLanguage === 'en-US' ? 'Mark a gap between vocal lines.' : 'Marque o intervalo entre frases vocais.';
}
function startSilenceSync() {
  if (!current?.buffers?.Inst) { toast('Carregue o áudio da música primeiro.'); return; }
  const fromStart=$('silenceFromStart')?.checked===true;
  manualSilenceStartMs=fromStart?0:null;
  manualSyncState={mode:'silence',focus:'lead',lines:current.lyricLines?.map(line=>line.text)||[],running:true};
  $('manualSyncText').hidden=true; $('manualSyncText').disabled=true;
  $('startManualSync').hidden=true; $('editManualLyrics').hidden=true;
  $('manualSyncDialog').querySelector('.manual-sync-modes').hidden=true;
  $('manualSyncFocusRow').hidden=true;
  playbackBase=fromStart?0:Math.max(0,playbackPosition());
  startAudioSources(playbackBase); enterSyncStage();
}
async function markManualSilenceBoundary() {
  if (!playing) { toast(interfaceLanguage === 'en-US' ? 'Press Play before marking the silence.' : 'Dê play antes de marcar o silêncio.'); return; }
  if (manualSilenceStartMs === null) markManualSilenceStart();
  else await markManualSilenceEnd();
  updateSyncToolbar();
}
async function persistManualVocalSilences() {
  if (!current) return;
  const marks = [...(current.manualVocalSilences || [])].sort((a,b)=>Number(a.startMs)-Number(b.startMs));
  const merged = [];
  for (const mark of marks) {
    const startMs = Math.max(0, Math.round(Number(mark.startMs)));
    const endMs = mark.endMs == null ? null : Math.max(startMs + 1, Math.round(Number(mark.endMs)));
    if (!Number.isFinite(startMs) || endMs !== null && !Number.isFinite(endMs)) continue;
    const createdAt = Number(mark.createdAt) || startMs;
    const last = merged.at(-1);
    const lastEnd = last?.endMs == null ? Infinity : Number(last?.endMs);
    if (last && startMs <= lastEnd + 80) {
      last.endMs = last.endMs == null || endMs == null ? null : Math.max(last.endMs, endMs);
      last.createdAt = Math.max(Number(last.createdAt) || 0, createdAt);
    } else merged.push({startMs, endMs, createdAt});
  }
  current.manualVocalSilences = merged;
  const song = songs.find(item=>item.id===current.id);
  if (song) {
    song.manualVocalSilences = merged;
    await api('/api/library', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(song)});
  }
  updateManualSilenceControls();
  updateLyrics(playbackPosition());
}
function markManualSilenceStart() {
  if (!current?.buffers?.Inst) { toast(interfaceLanguage === 'en-US' ? 'Load the song audio first.' : 'Carregue o áudio da música primeiro.'); return; }
  manualSilenceStartMs = Math.round(playbackPosition() * 1000);
  updateManualSilenceControls();
}
async function markManualSilenceEnd() {
  if (manualSilenceStartMs === null) return;
  const endMs = Math.round(playbackPosition() * 1000), startMs = manualSilenceStartMs;
  if (endMs <= startMs) { toast(interfaceLanguage === 'en-US' ? 'Move playback forward before marking the end.' : 'Avance a reprodução antes de marcar o fim.'); return; }
  current.manualVocalSilences = [...(current.manualVocalSilences || []), {startMs, endMs, createdAt:Date.now()}];
  manualSilenceStartMs = null;
  try { await persistManualVocalSilences(); toast(interfaceLanguage === 'en-US' ? 'Vocal silence saved.' : 'Silêncio vocal salvo.'); }
  catch (error) { console.error('Falha ao salvar silêncio vocal', error); toast(interfaceLanguage === 'en-US' ? 'Could not save this silence.' : 'Não consegui salvar esse silêncio.'); }
}
async function markManualSilenceToEnd() {
  if (!current?.buffers?.Inst) { toast(interfaceLanguage === 'en-US' ? 'Load the song audio first.' : 'Carregue o áudio da música primeiro.'); return; }
  if (manualSilenceStartMs === null) return;
  const startMs = manualSilenceStartMs;
  current.manualVocalSilences = [...(current.manualVocalSilences || []), {startMs, endMs:null, createdAt:Date.now()}];
  manualSilenceStartMs = null;
  try { await persistManualVocalSilences(); toast(interfaceLanguage === 'en-US' ? 'Silence marked through the end of the song.' : 'Silêncio marcado até o fim da música.'); }
  catch (error) { console.error('Falha ao salvar silêncio vocal', error); toast(interfaceLanguage === 'en-US' ? 'Could not save this silence.' : 'Não consegui salvar esse silêncio.'); }
}
async function undoLastManualSilence() {
  const marks = [...(current?.manualVocalSilences || [])];
  if (!marks.length) return;
  let latestIndex = 0;
  for (let index = 1; index < marks.length; index++) {
    if ((Number(marks[index].createdAt) || Number(marks[index].startMs)) >= (Number(marks[latestIndex].createdAt) || Number(marks[latestIndex].startMs))) latestIndex = index;
  }
  marks.splice(latestIndex, 1);
  current.manualVocalSilences = marks;
  try { await persistManualVocalSilences(); toast(interfaceLanguage === 'en-US' ? 'Last silence removed.' : 'Último silêncio removido.'); }
  catch (error) { console.error('Falha ao remover silêncio vocal', error); toast(interfaceLanguage === 'en-US' ? 'Could not remove this silence.' : 'Não consegui remover esse silêncio.'); }
}
const manualSyncFocusLabels = {
  lead: {pt:'Voz 1', en:'Voice 1'},
  parallel: {pt:'Voz 2', en:'Voice 2'},
  backing: {pt:'Backing', en:'Backing'}
};
function syncFocusLabel(focus = manualSyncFocus) {
  const labels = manualSyncFocusLabels[focus] || manualSyncFocusLabels.lead;
  return interfaceLanguage === 'en-US' ? labels.en : labels.pt;
}
function setManualSyncFocus(focus) {
  const editingSession=manualSyncState&&['line','word'].includes(manualSyncState.mode)&&manualSyncDialog.classList.contains('show');
  if (manualSyncState && !editingSession && focus !== manualSyncFocus) return;
  manualSyncFocus = ['lead','parallel','backing'].includes(focus) ? focus : 'lead';
  document.querySelectorAll('[data-sync-focus]').forEach(button => {
    const selected = button.dataset.syncFocus === manualSyncFocus;
    const optionLabels = interfaceLanguage === 'en-US'
      ? {lead:'Voice 1',parallel:'Voice 2',backing:'Backing'}
      : {lead:'Voz 1',parallel:'Voz 2',backing:'Backing'};
    button.textContent = optionLabels[button.dataset.syncFocus] || optionLabels.lead;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    button.disabled = Boolean(manualSyncState&&!editingSession);
  });
  document.querySelectorAll('.sync-focus-row>span').forEach(label=>{label.textContent=interfaceLanguage==='en-US'?'Focus':'Foco';});
  refreshManualVoicePanels();
  if(!manualSyncState)$('startManualSync').textContent=(interfaceLanguage==='en-US'?'Sync ':'Sincronizar ')+syncFocusLabel();
  if (!manualSyncState) {
    $('manualSyncCopy').textContent=interfaceLanguage==='en-US'?'Edit one voice at a time. The other voices keep their lyrics and timing.':'Edite uma voz por vez. As outras mantêm suas letras e seus tempos.';
    manualSyncPickerState={lines:[],ids:[],selectedIds:new Set(),nextId:0};
    if(manualSyncVoices)refreshManualSyncLinePicker();
    updateManualSaveButton();
  }
  if(editingSession){
    const other=manualSyncFocus!==manualSyncState.focus;
    $('editManualLyrics').textContent=other?(interfaceLanguage==='en-US'?'Return to '+syncFocusLabel(manualSyncState.focus)+' sync':'Retomar sync · '+syncFocusLabel(manualSyncState.focus)):(interfaceLanguage==='en-US'?'Apply lyrics and return':'Aplicar letra e voltar');
    $('manualSyncCopy').textContent=interfaceLanguage==='en-US'?'Sync for '+syncFocusLabel(manualSyncState.focus)+' is paused. You can save another voice here without saving or discarding its timing marks.':'Sync pausado · '+syncFocusLabel(manualSyncState.focus)+'. Salve outras letras sem alterar as marcações em andamento.';
  }
  updateManualSaveButton();updateSyncToolbar();
}
function manualSyncLineIndices(lines, focus = manualSyncFocus) {
  return lines.map((line,index) => {
    if (focus === 'backing') return isBackingLyric(line) ? index : -1;
    if (isBackingLyric(line)) return -1;
    const entries = lyricWordEntries(line);
    if (focus === 'parallel') return entries.some(entry=>entry.parallel) ? index : -1;
    return entries.length ? index : -1;
  }).filter(index=>index >= 0);
}
function lyricLineKey(line) { return String(line || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
function mapLyricLineIndices(sourceLines, targetLines, includeEdited = false) {
  const source = sourceLines.map(lyricLineKey), target = targetLines.map(lyricLineKey);
  const rows = source.length, columns = target.length;
  const lengths = Array.from({length: rows + 1}, () => new Uint16Array(columns + 1));
  for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) {
    lengths[i][j] = source[i] && source[i] === target[j]
      ? lengths[i + 1][j + 1] + 1
      : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const map = new Map(), anchors = [[-1, -1]];
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    if (source[i] && source[i] === target[j]) { map.set(i, j); anchors.push([i++, j++]); }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  anchors.push([rows, columns]);
  if (includeEdited) for (let anchor = 1; anchor < anchors.length; anchor++) {
    const [previousSource, previousTarget] = anchors[anchor - 1], [nextSource, nextTarget] = anchors[anchor];
    const sourceCount = nextSource - previousSource - 1, targetCount = nextTarget - previousTarget - 1;
    if (!sourceCount || sourceCount!==targetCount) continue;
    for (let offset = 0; offset < sourceCount; offset++) {
      const targetOffset = offset;
      map.set(previousSource + 1 + offset, previousTarget + 1 + targetOffset);
    }
  }
  return map;
}
function manualSyncLineMarkup(line) {
  const markup = lyricWordMarkup(line);
  return isBackingLyric(line) ? `(${markup})` : markup;
}
function manualSyncEntryMatchesFocus(line, entry, focus = manualSyncFocus) {
  const backing = isBackingLyric(line);
  if (focus === 'backing') return backing;
  if (backing) return false;
  return focus !== 'parallel' || entry.parallel === true;
}
function renderManualSyncStagePreview() {
  if($('lyricSecondLine'))$('lyricSecondLine').hidden=true;
  const state = manualSyncState;
  if (!state || !current) return;
  const isWordMode = state.mode === 'word' || state.mode === 'censor';
  let lineIndex, wordIndex = -1, nextLineIndex, nextWord;
  if (isWordMode) {
    const cursor = state.finished ? state.queue.length - 1 : state.awaitingStart ? Math.max(0,state.nextIndex-1) : state.nextIndex;
    const target = state.queue[cursor];
    if (!target) return;
    lineIndex = target.lineIndex; wordIndex = state.awaitingStart ? -1 : target.wordIndex;
    nextWord = state.queue[cursor + 1];
    if (nextWord && nextWord.lineIndex !== lineIndex) nextLineIndex = nextWord.lineIndex;
  } else {
    const targets = state.lineTargets || state.lines.map((_, index) => index);
    const cursor = Math.min(state.nextIndex, Math.max(0, targets.length - 1));
    lineIndex = targets[cursor];
    nextLineIndex = targets[cursor + 1];
  }
  if (lineIndex === undefined) return;
  const line = state.lines[lineIndex] || '';
  const entries = lyricWordEntries(line);
  const parallelPositions = entries.map((entry,index)=>entry.parallel?index:-1).filter(index=>index>=0);
  const leadPositions = entries.map((_,index)=>index);
  const focusPositions=state.focus==='parallel'?parallelPositions:leadPositions;
  const focusOrdinal=focusPositions.indexOf(wordIndex);
  const focusProgress=focusPositions.length<=1?0:Math.max(0,focusOrdinal)/(focusPositions.length-1);
  const leadOrdinal=state.focus==='parallel'&&leadPositions.length?Math.min(leadPositions.length-1,Math.floor(focusProgress*leadPositions.length)):Math.max(0,focusOrdinal);
  const parallelOrdinal=state.focus==='parallel'&&parallelPositions.length?Math.max(0,focusOrdinal):parallelPositions.length?Math.min(parallelPositions.length-1,Math.floor(focusProgress*parallelPositions.length)):-1;
  state.leadPreviewWordIndex=leadPositions.includes(wordIndex)?wordIndex:-1;
  state.parallelPreviewWordIndex=state.focus==='parallel' || entries[wordIndex]?.parallel ? wordIndex : -1;
  state.nextPreviewWordIndex=state.focus==='parallel'
    ? (leadPositions[leadOrdinal+1]??-1)
    : nextWord?.lineIndex===lineIndex ? nextWord.wordIndex : -1;
  state.parallelPreviewUpcomingIndex=state.focus==='parallel'
    ? nextWord?.lineIndex===lineIndex && entries[nextWord.wordIndex]?.parallel ? nextWord.wordIndex : -1
    : parallelPositions[parallelOrdinal+1]??-1;
  if(state.awaitingStart){
    const upcoming=state.queue[state.nextIndex];
    state.nextPreviewWordIndex=upcoming?.lineIndex===lineIndex&&!upcoming.parallel?upcoming.wordIndex:-1;
    state.parallelPreviewUpcomingIndex=upcoming?.lineIndex===lineIndex&&upcoming.parallel?upcoming.wordIndex:-1;
  }
  const previewKey = `${state.mode}:${lineIndex}:${wordIndex}:${nextLineIndex ?? ''}:${state.finished ? 'done' : state.awaitingStart ? 'pause' : 'active'}:${state.nextIndex}`;
  if (state.stagePreviewKey !== previewKey || !$('lyricCurrentLine')) {
    const markup = isWordMode
      ? lyricEntriesMarkup(entries, 'lyric-word', (entry, index) => `${processingSettings.markProfanity === true && isProfanityOccurrence(lineIndex,index,entry.word) ? 'profanity ' : ''}${entry.parallel ? (index === state.parallelPreviewWordIndex ? 'active ' : index === state.parallelPreviewUpcomingIndex ? 'upcoming ' : '') : (index === state.leadPreviewWordIndex ? 'active ' : index === state.nextPreviewWordIndex ? 'upcoming ' : '')}${state.focus === 'backing' && !entry.parallel ? 'backing-focus-word' : ''}`.trim())
      : lyricWordMarkup(line, 'lyric-word', lineIndex);
    const visibleMarkup = isBackingLyric(line) ? `(${markup})` : markup;
    const nextLine = nextLineIndex === undefined ? '' : state.lines[nextLineIndex] || '';
    const nextMarkup = isBackingLyric(nextLine) ? `(${lyricWordMarkup(nextLine,'lyric-word',nextLineIndex)})` : lyricWordMarkup(nextLine,'lyric-word',nextLineIndex);
    $('lyrics').classList.remove('lyric-slide');
    $('lyrics').innerHTML = `<span id="lyricCurrentLine" class="lyric-current-line${isBackingLyric(line) ? ' lyric-current-backing' : ''}">${visibleMarkup}</span><span class="lyric-pause" id="lyricPauseIndicator" aria-label="Pausa vocal" hidden><i></i><i></i><i></i><span class="lyric-pause-clock" hidden></span></span>${nextLine ? `<span class="next">${nextMarkup}</span>` : ''}`;
    $('lyrics').dataset.unsyncedHint='sync-preview'; $('lyrics').dataset.lyricSongId=String(current.id);
    $('lyrics').classList.add('lyric-slide');
    const markers = [$('lyricWordMarker'), $('lyricParallelWordMarker'), $('lyricBackingWordMarker')];
    markers.forEach(marker=>{ if(marker) marker.hidden=true; });
    const miniLine = $('nowLyric'); if (miniLine) { miniLine.textContent = line; miniLine.hidden = !line; }
    state.stagePreviewKey = previewKey;
    current.lyricIndex = null;
  }
  if (!isWordMode) { [$('lyricWordMarker'), $('lyricParallelWordMarker'), $('lyricBackingWordMarker')].forEach(marker=>{ if(marker) marker.hidden=true; }); return; }
  const host = $('lyricCurrentLine'), words = host?.querySelectorAll('.lyric-word') || [];
  const positionPreviewMarker = (marker, word, keyName, markerKey) => {
    if (!marker || !word) { if (marker) marker.hidden = true; return; }
    const displayRect = marker.parentElement.getBoundingClientRect(), wordRect = word.getBoundingClientRect();
    marker.style.left = `${wordRect.left - displayRect.left + wordRect.width / 2}px`;
    marker.style.top = `${wordRect.top - displayRect.top - 5}px`;
    marker.hidden = false;
    if (state[keyName] !== markerKey) {
      marker.classList.remove('hopping'); void marker.offsetWidth; marker.classList.add('hopping');
      state[keyName] = markerKey;
    }
  };
  if (state.focus==='backing') {
    positionPreviewMarker($('lyricBackingWordMarker'),words[wordIndex],'stageBackingMarkerKey',`${previewKey}:backing:${wordIndex}`);
  } else {
    const leadMarker=$('lyricWordMarker'), parallelMarker=$('lyricParallelWordMarker');
    const paired=words[state.leadPreviewWordIndex] && words[state.leadPreviewWordIndex]===words[state.parallelPreviewWordIndex];
    leadMarker?.classList.toggle('paired',Boolean(paired));
    parallelMarker?.classList.toggle('paired',Boolean(paired));
    positionPreviewMarker(leadMarker,words[state.leadPreviewWordIndex],'stageMarkerKey',`${previewKey}:lead:${state.leadPreviewWordIndex}`);
    positionPreviewMarker(parallelMarker,words[state.parallelPreviewWordIndex],'stageParallelMarkerKey',`${previewKey}:parallel:${state.parallelPreviewWordIndex}`);
  }
}
function manualSyncWords(lines,focus=manualSyncFocus){
  const rows=VoxStageLyrics.voiceTextRows(manualSyncEditor(focus).value,focus);
  return lines.flatMap((line,lineIndex)=>lyricWordEntries(line).flatMap((entry,wordIndex)=>{
    const row=rows[lineIndex],selected=row?.activeWordIndices;
    if(!manualSyncEntryMatchesFocus(line,entry,focus)||selected&&!selected.includes(wordIndex))return [];
    return [{lineIndex,wordIndex,word:entry.word,parallel:entry.parallel,backing:isBackingLyric(line),breakBefore:wordIndex===(selected?.[0]??0)&&row?.breakBefore===true}];
  }));
}
function refreshManualSyncLinePicker() {
  const picker = $('manualSyncLinePicker');
  if (!picker) return;
  const lines = manualEditorLines();
  const pickerState = manualSyncPickerState;
  const visibleIds = new Set([...picker.querySelectorAll('input[data-line-id]')].map(input => input.dataset.lineId));
  const selectedIds = new Set(pickerState.selectedIds);
  for (const id of visibleIds) selectedIds.delete(id);
  for (const input of picker.querySelectorAll('input[data-line-id]:checked')) selectedIds.add(input.dataset.lineId);
  const oldIds = pickerState.ids;
  const oldToNew = mapLyricLineIndices(pickerState.lines, lines, true);
  const ids = Array(lines.length).fill(null);
  const nextSelected = new Set();
  for (const [oldIndex, newIndex] of oldToNew) {
    ids[newIndex] = oldIds[oldIndex];
    if (selectedIds.has(oldIds[oldIndex])) nextSelected.add(oldIds[oldIndex]);
  }
  for (let index = 0; index < ids.length; index++) if (!ids[index]) ids[index] = `lyric-line-${++pickerState.nextId}`;
  pickerState.lines = lines;
  pickerState.ids = ids;
  pickerState.selectedIds = nextSelected;
  const focusLines = new Set(manualSyncLineIndices(lines));
  const eligible = [...focusLines];
  const selectAllLabel = interfaceLanguage === 'en-US'
    ? manualSyncFocus === 'backing' ? 'Select all backing lines' : manualSyncFocus === 'parallel' ? 'Select all duet lines' : 'Select all lines'
    : manualSyncFocus === 'backing' ? 'Marcar todos os backings' : manualSyncFocus === 'parallel' ? 'Marcar todos os duetos' : 'Marcar todas as linhas';
  picker.innerHTML = `<button class="manual-sync-select-all" type="button" data-select-all-lines>${esc(selectAllLabel)}</button>` + lines.map((line, index) => focusLines.has(index) ? `<label title="${esc(line.replace(/\[([^\]]+)\]/g,'$1'))}"><input type="checkbox" data-line-id="${esc(ids[index])}" value="${index}" ${nextSelected.has(ids[index]) ? 'checked' : ''}><span>${esc(line.replace(/\[([^\]]+)\]/g,'$1'))}</span></label>` : '').join('');
}
function setManualSyncMode(mode) {
  if (manualSyncState?.running) return;
  manualSyncMode = mode === 'word' ? 'word' : 'line';
  manualSyncDialog.querySelectorAll('[data-sync-mode]').forEach(button => {
    const selected = button.dataset.syncMode === manualSyncMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('manualSyncTitle').textContent=interfaceLanguage==='en-US'?'Lyrics editor':'Editor de letras';
  if(!manualSyncState)$('startManualSync').textContent=(interfaceLanguage==='en-US'?'Sync ':'Sincronizar ')+syncFocusLabel();
  $('manualSyncProgress').textContent = manualSyncMode === 'word'
    ? interfaceLanguage === 'en-US' ? '0 words marked' : '0 palavras marcadas'
    : interfaceLanguage === 'en-US' ? '0 lines marked' : '0 linhas marcadas';
  $('markManualSync').textContent = manualSyncMode === 'word'
    ? interfaceLanguage === 'en-US' ? '✓ Word ended · next' : '✓ Palavra terminou · avançar'
    : interfaceLanguage === 'en-US' ? '✓ Mark phrase start' : '✓ Marcar início da frase';
  $('manualSyncCopy').textContent=manualSyncMode==='word'
    ? interfaceLanguage==='en-US'?'Tap to mark the first start, then each word end. Blank lines separate passages.':'Marque o início com um toque; depois, os finais das palavras. Linha vazia separa trechos.'
    : manualSyncRepairEnabled
      ? interfaceLanguage==='en-US'?'Select only the lines you want to sync again.':'Selecione apenas as linhas que quer sincronizar novamente.'
      : interfaceLanguage==='en-US'?'Tap at each phrase start, then tap again at its end.':'Toque no início de cada frase e depois no fim. Vale para as três vozes.';
  $('manualSyncCopy').title=manualSyncMode==='word'?(interfaceLanguage==='en-US'?'The first tap marks the first word start. Blank lines let you end a passage and start the next later.':'O primeiro toque marca o início da primeira palavra. Uma linha vazia permite encerrar o trecho e começar o próximo depois.'):(interfaceLanguage==='en-US'?'Each phrase needs a start and an end tap, including the final phrase.':'Cada frase precisa de um toque no início e outro no fim, inclusive a última.');
  $('toggleLineRepair').hidden = manualSyncMode !== 'line' || !manualSyncCanRepair;
  if (manualSyncMode !== 'line') $('manualSyncLinePicker').hidden = true;
}
function openManualLineSync() {
  if (!current) { toast('Selecione uma música e abra a apresentação primeiro.'); return; }
  $('display').classList.remove('mobile-controls-hidden');
  if (!$('display').classList.contains('show')) {
    $('display').classList.add('show');
  }
  if (manualSyncState) { enterSyncStage(); return; }
  leaveSyncStage();
  manualSyncReturn={songId:current.id,position:playbackPosition(),playing};
  manualSyncDialog.classList.remove('confirm-discard');
  manualSyncVoices=VoxStageLyrics.fromLegacy(current,current.lyricLines?current:unifiedLyricsForSong(current),lyricWordEntries);
  manualSyncFocus='lead';
  for(const track of VoxStageLyrics.tracks)manualSyncEditor(track).value=VoxStageLyrics.editorText(manualSyncVoices[track]);
  restoreManualVoiceEditors();
  manualSyncPickerState = {lines:[], ids:[], selectedIds:new Set(), nextId:0};
  $('manualSyncCurrent').classList.remove('manual-sync-phrase');
  manualSyncState = null;
  manualSyncDialog.classList.remove('recording');
  manualSyncRepairEnabled = false;
  manualSyncCanRepair = parseSyncedLyrics(current.syncedLyrics || '').length > 0;
  manualSyncFocus = 'lead';
  $('manualSyncFocusRow').hidden = false;
  setManualSyncFocus(manualSyncFocus);
  $('toggleLineRepair').classList.remove('selected'); $('toggleLineRepair').setAttribute('aria-pressed', 'false'); $('toggleLineRepair').setAttribute('aria-expanded', 'false');
  $('manualSyncLinePicker').hidden = true; $('manualSyncLinePicker').replaceChildren(); refreshManualSyncLinePicker();
  manualSyncEditor().hidden = false; manualSyncEditor().disabled = false; $('editManualLyrics').hidden = true;
  $('startManualSync').hidden = false; $('startManualSync').disabled = false;
  $('startManualSync').textContent = 'Começar sincronização';
  manualSyncDialog.querySelector('.manual-sync-modes').hidden = false;
  $('manualSyncCurrent').textContent = interfaceLanguage === 'en-US' ? 'Paste or edit the lyrics above.' : 'Cole ou edite a letra acima.';
  $('manualSyncProgress').textContent = interfaceLanguage === 'en-US' ? '0 lines marked' : '0 linhas marcadas';
  setManualSyncMode('line');
  $('markManualSync').disabled = true; $('undoManualSync').disabled = true; $('saveManualSync').disabled = !manualSyncEditor().value.trim(); $('saveManualSync').textContent = interfaceLanguage === 'en-US' ? 'Save lyrics' : 'Salvar letra';
  updateManualSilenceControls();
  manualSyncDialog.classList.add('show');
  manualSyncDialog.querySelector('.manual-sync-card header').append($('closeManualSync'));
  updateSyncEditorViewport();
  syncEditorBody.scrollTop=0;
  for(const tool of syncEditorTools.querySelectorAll('details'))tool.open=false;
  refreshManualVoicePanels();updateManualSaveButton();
  if(!mobileNative&&matchMedia('(pointer:fine)').matches)manualSyncEditor().focus({preventScroll:true});
}
function updateManualSaveButton() {
  const button = $('saveManualSync'), editor = manualSyncEditor();
  if (!button || !editor) return;
  if(manualVoiceSavePending){button.disabled=true;button.textContent=interfaceLanguage==='en-US'?'Saving…':'Salvando…';return;}
  if(manualSyncState&&['line','word'].includes(manualSyncState.mode)&&manualSyncDialog.classList.contains('show')&&manualSyncFocus!==manualSyncState.focus){
    button.disabled=false;button.textContent=(interfaceLanguage==='en-US'?'Save ':'Salvar letra · ')+syncFocusLabel();return;
  }
  if (manualSyncState?.mode === 'censor') {
    button.disabled = !manualSyncState.cues?.length;
    button.textContent = interfaceLanguage === 'en-US' ? 'Save censorship' : 'Salvar censura';
    return;
  }
  if (manualSyncState?.mode === 'silence') {
    button.disabled = false;
    button.textContent = interfaceLanguage === 'en-US' ? 'Finish silence sync' : 'Concluir silêncio';
    return;
  }
  if (manualSyncState && !editor.hidden && !editor.disabled) { button.disabled = true; return; }
  const hasText = Boolean(manualSyncState?.lines?.length || VoxStageLyrics.tracks.some(track=>manualSyncEditor(track).value.trim()) || current?.lyricLines?.length);
  if (!hasText) { button.disabled = true; button.textContent = interfaceLanguage === 'en-US' ? 'Save lyrics' : 'Salvar letra'; return; }
  if (!manualSyncState) { button.disabled = false; button.textContent = interfaceLanguage === 'en-US' ? 'Save lyrics' : 'Salvar letra'; return; }
  const state = manualSyncState;
  const hasMarks = state.mode === 'word' ? state.times.length > 1 || Object.keys(state.wordEnds||{}).length>0 || state.finished : state.times.length > 0 || Object.keys(state.lineEnds || {}).length > 0;
  const complete = state.mode === 'word'
    ? state.finished
    : state.nextIndex >= (state.lineTargets?.length || 0) && !state.pendingBackingEnd;
  button.disabled = false;
  button.textContent = !hasMarks
    ? interfaceLanguage === 'en-US' ? 'Save lyrics' : 'Salvar letra'
    : complete && !state.repairOnly
      ? interfaceLanguage === 'en-US' ? 'Save sync' : 'Salvar sync'
      : interfaceLanguage === 'en-US' ? 'Save partial sync' : 'Salvar sync parcial';
}
function updateManualSyncProgress() {
  if (!manualSyncState) return;
  if (manualSyncState.mode === 'silence') {
    const count=current?.manualVocalSilences?.length||0;
    $('manualSyncProgress').textContent = `${count} silêncio${count===1?'':'s'} · toque na letra ou Espaço ${manualSilenceStartMs==null?'para marcar o começo':'para marcar o fim'}`;
    $('manualSyncCurrent').textContent = manualSilenceStartMs==null ? 'Marque o começo do silêncio' : 'Marque o fim do silêncio';
    $('markManualSync').textContent = manualSilenceStartMs==null ? 'Marcar início' : 'Marcar fim';
    $('markManualSync').disabled=false;
    $('undoManualSync').disabled=manualSilenceStartMs==null && !count;
    updateManualSaveButton(); updateSyncToolbar(); return;
  }
  if (manualSyncState.mode === 'censor') {
    const state=manualSyncState, target=state.queue[state.nextIndex], next=state.queue[state.nextIndex+1];
    $('manualSyncProgress').textContent = target
      ? `${state.nextIndex+1}/${state.queue.length} · ${state.pendingStartMs == null ? 'marque o começo' : 'marque o fim'}`
      : `${state.cues.length} intervalo${state.cues.length===1?'':'s'} marcado${state.cues.length===1?'':'s'} · salve a censura`;
    $('manualSyncCurrent').innerHTML = target
      ? `<span class="manual-sync-context">PALAVRA PARA CENSURAR</span><span class="manual-sync-target">${esc(target.word)}</span>${next?`<span class="manual-sync-upcoming"><small>PRÓXIMA</small>${esc(next.word)}</span>`:''}`
      : 'Censura marcada. Salve para aplicar.';
    $('markManualSync').textContent = state.pendingStartMs == null ? 'Marcar início da palavra' : 'Marcar fim da palavra';
    $('markManualSync').disabled = !target;
    $('undoManualSync').disabled = state.pendingStartMs == null && !state.cues.length;
    updateManualSaveButton(); renderManualSyncStagePreview(); updateSyncToolbar();
    return;
  }
  const {lines, times} = manualSyncState;
  if (manualSyncState.mode === 'word') {
    const queue = manualSyncState.queue, cursor = manualSyncState.nextIndex;
    const target = manualSyncState.finished ? null : queue[cursor];
    const awaitingStart=manualSyncState.awaitingStart,initialStart=awaitingStart&&cursor===0;
    const phraseTarget = target || queue.at(-1);
    const nextTarget = !manualSyncState.finished ? queue[cursor + 1] : null;
    const currentWordLabel = interfaceLanguage === 'en-US' ? 'CURRENT WORD' : 'PALAVRA ATUAL';
    const nextWordLabel = interfaceLanguage === 'en-US' ? 'NEXT WORD' : 'PRÓXIMA PALAVRA';
    $('manualSyncProgress').textContent = manualSyncState.finished
      ? interfaceLanguage === 'en-US' ? 'All words synced · ready to save' : 'Todas as palavras sincronizadas · pronto para salvar'
      : initialStart ? interfaceLanguage==='en-US'?`First word: ${target.word} · seek if needed, then tap when it starts`:`Primeira palavra: ${target.word} · avance se precisar e toque quando ela começar`
      : awaitingStart ? interfaceLanguage==='en-US'?'Pause · seek to the next passage, then tap when it starts':'Pausa · avance até o próximo trecho e toque quando ele começar'
      : target ? interfaceLanguage === 'en-US' ? `Word ${cursor + 1} of ${queue.length} · tap when it ends` : `Palavra ${cursor + 1} de ${queue.length} · toque quando terminar` : interfaceLanguage === 'en-US' ? 'All words are marked.' : 'Todas as palavras foram marcadas.';
    $('manualSyncCurrent').classList.remove('manual-sync-phrase');
    $('manualSyncCurrent').innerHTML = awaitingStart
      ? `<span class="manual-sync-context">${initialStart?(interfaceLanguage==='en-US'?'FIRST PASSAGE':'PRIMEIRO TRECHO'):(interfaceLanguage==='en-US'?'NEXT PASSAGE':'PRÓXIMO TRECHO')}</span><span class="manual-sync-target">${manualSyncLineMarkup(lines[target.lineIndex])}</span>`
      : phraseTarget
      ? `<span class="manual-sync-context">${currentWordLabel}</span><span class="manual-sync-target">${esc(phraseTarget.word)}</span>${nextTarget ? `<span class="manual-sync-upcoming"><small>${nextWordLabel}</small>${esc(nextTarget.word)}</span>` : ''}`
      : 'Todas as palavras foram marcadas. Salve para aplicar a sincronia.';
    $('markManualSync').textContent = initialStart
      ? interfaceLanguage==='en-US'?'▶ Mark first word start':'▶ Marcar início da primeira palavra'
      : awaitingStart
      ? interfaceLanguage==='en-US'?'▶ Mark next passage start':'▶ Marcar início do próximo trecho'
      : queue[cursor+1]?.breakBefore
      ? interfaceLanguage==='en-US'?'✓ End phrase · pause':'✓ Encerrar frase · pausa'
      : target && cursor < queue.length - 1
      ? interfaceLanguage === 'en-US' ? '✓ Word ended · next' : '✓ Palavra terminou · avançar'
      : interfaceLanguage === 'en-US' ? '✓ Finish last word' : '✓ Concluir última palavra';
    $('markManualSync').disabled = !manualSyncState.running || manualSyncState.finished || cursor >= queue.length;
    $('undoManualSync').disabled = !manualSyncState.finished && times.length===0;
    updateManualSaveButton();
    renderManualSyncStagePreview();
  } else {
    $('manualSyncCurrent').classList.remove('manual-sync-phrase');
    const nextIndex = manualSyncState.nextIndex;
    const targets = manualSyncState.lineTargets || lines.map((_, index) => index);
    const targetLine = targets[nextIndex];
    const nextLine = targets[nextIndex + 1] !== undefined ? lines[targets[nextIndex + 1]] : '';
    const backingPending = manualSyncState.pendingBackingEnd;
    const backingCount = targets.filter(index => manualSyncNeedsEnd(lines[index])).length;
    const completedMarks = times.length + Object.keys(manualSyncState.lineEnds || {}).length;
    const totalMarks = targets.length + backingCount;
    const currentLineLabel = interfaceLanguage === 'en-US' ? 'CURRENT LINE' : 'LINHA ATUAL';
    const nextLineLabel = interfaceLanguage === 'en-US' ? 'NEXT LINE' : 'PRÓXIMA LINHA';
    const scopeLabel = manualSyncState.repairOnly
      ? interfaceLanguage === 'en-US' ? targets.length === 1 ? 'selected line' : 'selected lines' : targets.length === 1 ? 'linha selecionada' : 'linhas selecionadas'
      : interfaceLanguage === 'en-US' ? targets.length === 1 ? 'line' : 'lines' : targets.length === 1 ? 'linha' : 'linhas';
    $('manualSyncProgress').textContent = backingPending
      ? interfaceLanguage === 'en-US' ? `Phrase started · tap again when it ends (${completedMarks}/${totalMarks})` : `Frase começou · toque de novo quando terminar (${completedMarks}/${totalMarks})`
      : interfaceLanguage === 'en-US'
        ? `${completedMarks} of ${totalMarks} timing marks · ${times.length} ${scopeLabel} started${nextIndex === targets.length ? ' · ready to save' : ''}`
        : `${completedMarks} de ${totalMarks} marcações · ${times.length} ${scopeLabel} iniciadas${nextIndex === targets.length ? ' · pronto para salvar' : ''}`;
    $('manualSyncCurrent').innerHTML = targetLine !== undefined
      ? `<span class="manual-sync-context">${currentLineLabel}</span><span class="manual-sync-target">${manualSyncLineMarkup(lines[targetLine])}</span>${nextLine ? `<span class="manual-sync-upcoming"><small>${nextLineLabel}</small>${manualSyncLineMarkup(nextLine)}</span>` : ''}`
      : 'Todas as linhas selecionadas foram marcadas. Salve para aplicar a sincronia.';
    $('markManualSync').textContent = backingPending
      ? interfaceLanguage === 'en-US' ? '✓ Mark phrase end' : '✓ Marcar fim da frase'
      : targetLine !== undefined && manualSyncNeedsEnd(lines[targetLine])
        ? interfaceLanguage === 'en-US' ? '✓ Mark phrase start' : '✓ Marcar início da frase'
        : manualSyncState.repairOnly
          ? interfaceLanguage === 'en-US' ? '✓ Mark selected line' : '✓ Marcar linha selecionada'
          : interfaceLanguage === 'en-US' ? '✓ Mark phrase start' : '✓ Marcar início da frase';
    $('markManualSync').disabled = !manualSyncState.running || (nextIndex >= targets.length && !backingPending);
    $('undoManualSync').disabled = times.length === 0;
    updateManualSaveButton();
    renderManualSyncStagePreview();
  }
  updateSyncToolbar();
}
async function startManualSync() {
  if (manualSyncState) {
    if (!manualSyncEditor().hidden) { editManualLyrics(); return; }
    manualSyncDialog.classList.remove('confirm-discard');
    enterSyncStage(); return;
  }
  if (!current?.buffers?.Inst) { toast('Toque esta música primeiro e aguarde o áudio carregar.'); return; }
  try {flushManualVoiceEditors();}catch(error){toast(error.message);return;}
  const syncStartPosition=Math.max(0,playbackPosition());
  const lines = manualEditorLines();
  if (!lines.length) { toast('Cole a letra, com uma linha por frase.'); return; }
  if (lines.length > 500) { toast('Use até 500 linhas por música.'); return; }
  refreshManualSyncLinePicker();
  const focusLines = manualSyncLineIndices(lines, manualSyncFocus);
  const checkedLineIndices = [...$('manualSyncLinePicker').querySelectorAll('input:checked')].map(input => Number(input.value));
  const selectedLineIndices = manualSyncRepairEnabled ? checkedLineIndices.filter(index=>focusLines.includes(index)) : focusLines;
  if (manualSyncMode === 'line' && !selectedLineIndices.length) { toast('Selecione pelo menos uma linha para sincronizar.'); $('manualSyncLinePicker').hidden = false; return; }
  try { if (audioContext?.state === 'suspended') await audioContext.resume(); } catch {}
  const mode = manualSyncMode;
  const queue = mode === 'word' ? manualSyncWords(lines, manualSyncFocus) : [];
  if (mode === 'word' && !queue.length) { toast('Não encontrei palavras na letra.'); return; }
  if (mode === 'word' && queue.length > 5000) { toast('Use até 5.000 palavras por música.'); return; }
  const times = [];
  manualSyncState = {mode, focus:manualSyncFocus, lines, queue, times, wordEnds:{}, awaitingStart:mode==='word', lineEnds:{}, nextIndex: 0, running: true, finished: false, endTime: null, lineTargets: selectedLineIndices, repairOnly: mode === 'line' && manualSyncRepairEnabled, pendingBackingEnd:false};
  $('manualSyncLinePicker').hidden = true; $('toggleLineRepair').hidden = true;
  $('manualSyncDialog').querySelector('.manual-sync-modes').hidden = true;
  $('manualSyncFocusRow').querySelectorAll('[data-sync-focus]').forEach(button=>button.disabled=true);
  manualSyncEditor().value = VoxStageLyrics.editorText(manualSyncVoices[manualSyncFocus]);
  manualSyncEditor().hidden = true; manualSyncEditor().disabled = true; $('manualVoiceEditors').hidden=true; $('editManualLyrics').hidden = false;
  $('startManualSync').hidden = true;
  playbackBase=syncStartPosition;
  startAudioSources(playbackBase); enterSyncStage();
}
async function startCensorSync() {
  if (!current?.buffers?.Inst) { toast('Toque a música e aguarde o áudio carregar.'); return; }
  const marks = (current.profanityMarks||[]).filter(mark=>lyricTokenKey(current.lyricLines?.[mark.lineIndex] && lyricWordEntries(current.lyricLines[mark.lineIndex].text)[mark.wordIndex]?.word)===lyricTokenKey(mark.word));
  if (!marks.length) { openProfanityPickerForCurrent(); toast('Escolha as ocorrências antes de sincronizar a censura.'); return; }
  try { if (audioContext?.state==='suspended') await audioContext.resume(); } catch {}
  const queue=[...marks].sort((a,b)=>Number(current.lyricLines[a.lineIndex].time)-Number(current.lyricLines[b.lineIndex].time)||a.wordIndex-b.wordIndex);
  manualSyncState={mode:'censor',focus:'lead',lines:current.lyricLines.map(line=>line.text),queue,nextIndex:0,pendingStartMs:null,cues:[],running:true,finished:false,stagePreviewKey:null};
  manualSyncEditor().hidden=true; manualSyncEditor().disabled=true;
  $('startManualSync').hidden=true; $('editManualLyrics').hidden=true;
  $('manualSyncDialog').querySelector('.manual-sync-modes').hidden=true;
  $('manualSyncFocusRow').hidden=true; $('toggleLineRepair').hidden=true; $('manualSyncLinePicker').hidden=true;
  const first=Number(current.lyricLines[queue[0].lineIndex].time)/1000;
  playbackBase=Math.max(0,(Number.isFinite(first)?first:0)-2);
  startAudioSources(playbackBase); enterSyncStage();
}
async function saveCensorSync() {
  const state=manualSyncState;
  if (!current || state?.mode!=='censor') return;
  const replacement=new Set(state.queue.map(mark=>`${mark.lineIndex}:${mark.wordIndex}`));
  const cues=[...(current.profanityCues||[]).filter(cue=>!replacement.has(`${cue.lineIndex}:${cue.wordIndex}`)),...state.cues].sort((a,b)=>a.startMs-b.startMs);
  const song=songs.find(item=>item.id===current.id);
  if (song) {
    song.profanityMarks=current.profanityMarks||[]; song.profanityCues=cues;
    try { await api('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(song)}); }
    catch(error) { console.error('Falha ao salvar censura',error); toast('Não consegui salvar a censura. As marcações continuam abertas.'); return; }
  }
  current.profanityCues=cues; current.playbackTracks=null;manualSyncReturn=null;
  $('closeManualSync').click();
  toast(`${state.cues.length} intervalo${state.cues.length===1?'':'s'} de censura salvo${state.cues.length===1?'':'s'}.`);
}
function markCensorBoundary() {
  const state=manualSyncState;
  if (state?.mode!=='censor' || !state.queue[state.nextIndex]) return;
  if (!playing) { toast('Dê play antes de marcar a palavra.'); return; }
  const now=Math.round(playbackPosition()*1000);
  if (state.pendingStartMs==null) state.pendingStartMs=now;
  else {
    if (now<=state.pendingStartMs) { toast('Marque o fim depois do início.'); return; }
    state.cues.push({...state.queue[state.nextIndex],startMs:state.pendingStartMs,endMs:now});
    state.pendingStartMs=null; state.nextIndex++;
  }
  updateManualSyncProgress();
}
function markManualSyncLine() {
  if (manualSyncState?.mode === 'word') { markManualSyncWordBoundary(); return; }
  if (!manualSyncState?.running || (manualSyncState.nextIndex >= (manualSyncState.lineTargets?.length ?? manualSyncState.lines.length) && !manualSyncState.pendingBackingEnd)) return;
  if (!playing) { toast(interfaceLanguage === 'en-US' ? 'Press Play before marking the next line.' : 'Dê play antes de marcar a próxima linha.'); return; }
  const time = playbackPosition();
  const targets = manualSyncState.lineTargets || manualSyncState.lines.map((_, index) => index);
  const previous = manualSyncState.pendingBackingEnd ? manualSyncState.times.at(-1) : manualSyncState.lineEnds[targets[manualSyncState.nextIndex-1]] ?? -1;
  if (time <= previous) { toast('Espere a próxima linha chegar antes de marcar.'); return; }
  const lineIndex = targets[manualSyncState.nextIndex];
  if (manualSyncState.pendingBackingEnd) {
    manualSyncState.lineEnds[lineIndex] = time;
    manualSyncState.pendingBackingEnd = false;
    manualSyncState.nextIndex++;
  } else {
    manualSyncState.times.push(time);
    manualSyncState.pendingBackingEnd = true;
  }
  if(manualSyncState.nextIndex>=targets.length&&!manualSyncState.pendingBackingEnd){manualSyncState.running=false;manualSyncState.finished=true;}
  updateManualSyncProgress();
}
function markManualSyncInput() {
  if (!manualSyncState?.running) return;
  if (manualSyncState.mode === 'censor') { markCensorBoundary(); return; }
  if (manualSyncState.mode === 'silence') { void markManualSilenceBoundary().then(updateManualSyncProgress); return; }
  if (manualSyncState.mode === 'word') markManualSyncWordBoundary(); else markManualSyncLine();
}
function markManualSyncWordBoundary() {
  if (!manualSyncState?.running) return;
  if (!playing) { toast(interfaceLanguage === 'en-US' ? 'Press Play before marking the next word.' : 'Dê play antes de marcar a próxima palavra.'); return; }
  const state=manualSyncState,time=playbackPosition(),cursor=state.nextIndex;
  state.wordEnds ||= {};
  if(state.awaitingStart) {
    if(!Number.isFinite(time)||time<0||cursor>0&&time<=state.wordEnds[cursor-1]){toast('Avance para depois do fim da frase anterior.');return;}
    state.times[cursor]=time;state.awaitingStart=false;
  } else {
    const wordStart=state.times[cursor];
    if(!Number.isFinite(wordStart)||time<=wordStart){toast('Deixe a palavra exibida tocar até o fim antes de avançar.');return;}
    state.wordEnds[cursor]=time;
    if(cursor>=state.queue.length-1){state.endTime=time;state.finished=true;state.running=false;}
    else {
      state.nextIndex++;
      if(state.queue[state.nextIndex].breakBefore)state.awaitingStart=true;
      else state.times[state.nextIndex]=time;
    }
  }
  updateManualSyncProgress();
}
function undoManualSyncLine() {
  if (manualSyncState?.mode === 'silence') {
    if (manualSilenceStartMs!=null) { manualSilenceStartMs=null; updateManualSilenceControls(); updateManualSyncProgress(); }
    else void undoLastManualSilence().then(updateManualSyncProgress);
    return;
  }
  if (manualSyncState?.mode === 'censor') {
    const state=manualSyncState;
    if (state.pendingStartMs!=null) state.pendingStartMs=null;
    else if (state.cues.length) { state.cues.pop(); state.nextIndex=Math.max(0,state.nextIndex-1); }
    updateManualSyncProgress(); return;
  }
  if (!manualSyncState?.times.length) return;
  if(manualSyncState.mode==='word') {
    const state=manualSyncState;state.wordEnds ||= {};
    let returnTo=state.times.at(-1);
    if(state.finished){state.finished=false;state.running=true;state.endTime=null;delete state.wordEnds[state.nextIndex];}
    else if(state.awaitingStart&&state.nextIndex>0){state.nextIndex--;state.awaitingStart=false;delete state.wordEnds[state.nextIndex];}
    else if(state.nextIndex===0){state.times=[];state.awaitingStart=true;}
    else if(state.nextIndex>0){
      state.times.pop();
      if(state.queue[state.nextIndex].breakBefore)state.awaitingStart=true;
      else {state.nextIndex--;delete state.wordEnds[state.nextIndex];}
    }
    pausePlayback();playbackBase=Math.max(0,returnTo-1);updateManualSyncProgress();return;
  }
  const returnTo=manualSyncState.times.at(-1);
  pausePlayback();playbackBase=Math.max(0,returnTo-1);
  const targets = manualSyncState.lineTargets || manualSyncState.lines.map((_, index) => index);
  manualSyncState.running=true;manualSyncState.finished=false;
  if(manualSyncState.pendingBackingEnd){
    manualSyncState.times.pop();manualSyncState.pendingBackingEnd=false;
  }else if(manualSyncState.nextIndex>0){
    manualSyncState.nextIndex--;
    delete manualSyncState.lineEnds[targets[manualSyncState.nextIndex]];
    manualSyncState.pendingBackingEnd=true;
  }
  updateManualSyncProgress();
}
function editManualLyrics() {
  let editor = manualSyncEditor();const button = $('editManualLyrics');
  if (editor.hidden) {
    pausePlayback();
    manualSyncDialog.classList.add('show');
    manualSyncDialog.classList.remove('confirm-discard');
    $('startManualSync').hidden = true;
    restoreManualVoiceEditors();setManualSyncFocus(manualSyncFocus);editor.focus({preventScroll:true});
    return;
  }
  // Editing another tab never changes the recording track. Return to its own
  // editor before remapping any words or line boundaries.
  if(manualSyncState&&manualSyncFocus!==manualSyncState.focus){setManualSyncFocus(manualSyncState.focus);editor=manualSyncEditor();}
  const lines = manualEditorLines();
  if (!lines.length) { toast('A letra precisa ter pelo menos uma linha.'); editor.focus(); return; }
  if (lines.length > 500) { toast('Use até 500 linhas por música.'); editor.focus(); return; }
  if (manualSyncState) {
    const state = manualSyncState, oldLines = state.lines;
    const oldToNew = mapLyricLineIndices(oldLines, lines, true);
    state.lines = lines;
    state.stagePreviewKey = null;
    if (state.mode === 'line') {
      const oldTargets = state.lineTargets || oldLines.map((_, index) => index);
      const focusLineSet = new Set(manualSyncLineIndices(lines, state.focus));
      const newTargets = state.repairOnly
        ? [...new Set(oldTargets.map(index=>oldToNew.get(index)).filter(index=>index !== undefined && focusLineSet.has(index)))]
        : [...focusLineSet];
      const started = new Map();
      oldTargets.slice(0, state.times.length).forEach((oldIndex, markIndex) => {
        const newIndex = oldToNew.get(oldIndex);
        if (newIndex !== undefined && newTargets.includes(newIndex)) started.set(newIndex, state.times[markIndex]);
      });
      const remappedEnds = {};
      for (const [oldIndex, end] of Object.entries(state.lineEnds || {})) {
        const newIndex = oldToNew.get(Number(oldIndex));
        if (newIndex !== undefined && newTargets.includes(newIndex)) remappedEnds[newIndex] = end;
      }
      const remappedTimes = [];
      for (const target of newTargets) {
        if (!started.has(target)) break;
        remappedTimes.push(started.get(target));
      }
      state.lineTargets=newTargets;state.times=remappedTimes;
      state.lineEnds=Object.fromEntries(Object.entries(remappedEnds).filter(([index,end])=>{
        const position=newTargets.indexOf(Number(index)),start=remappedTimes[position];
        return position>=0&&Number.isFinite(start)&&Number.isFinite(end)&&end>start;
      }));
      state.nextIndex=0;
      while(state.nextIndex<state.times.length&&state.lineEnds[newTargets[state.nextIndex]]!=null)state.nextIndex++;
      state.pendingBackingEnd=state.nextIndex<state.times.length;
      state.times=state.times.slice(0,state.nextIndex+(state.pendingBackingEnd?1:0));
      const completed=new Set(newTargets.slice(0,state.nextIndex));
      state.lineEnds=Object.fromEntries(Object.entries(state.lineEnds).filter(([index])=>completed.has(Number(index))));
      state.running=state.nextIndex<newTargets.length;state.finished=!state.running;
    } else {
      const oldQueue = state.queue, oldTimes = state.times;
      const newQueue = manualSyncWords(lines, state.focus), mappedStarts = new Map(), mappedEnds = new Map(), wordMaps = new Map();
      oldQueue.forEach((entry, oldIndex) => {
        if (!Number.isFinite(Number(oldTimes[oldIndex]))) return;
        const newLineIndex = oldToNew.get(entry.lineIndex);
        if (newLineIndex === undefined) return;
        if(!wordMaps.has(entry.lineIndex))wordMaps.set(entry.lineIndex,new Map(VoxStageLyrics.match(lyricWordEntries(oldLines[entry.lineIndex]).map(item=>lyricTokenKey(item.word)),lyricWordEntries(lines[newLineIndex]).map(item=>lyricTokenKey(item.word)))));
        const newWordIndex=wordMaps.get(entry.lineIndex).get(entry.wordIndex);
        const match=newQueue.find(candidate=>candidate.lineIndex===newLineIndex&&candidate.wordIndex===newWordIndex&&candidate.parallel===entry.parallel);
        if(match){const next=newQueue.indexOf(match);mappedStarts.set(next,oldTimes[oldIndex]);if(Number.isFinite(state.wordEnds?.[oldIndex]))mappedEnds.set(next,state.wordEnds[oldIndex]);}
      });
      state.queue = newQueue;
      state.times = [];
      for (let index = 0; index < newQueue.length && mappedStarts.has(index); index++) state.times.push(mappedStarts.get(index));
      state.finished = false; state.endTime = null; state.running = true;
      state.wordEnds=Object.fromEntries([...mappedEnds].filter(([index])=>index<state.times.length));
      state.awaitingStart=state.times.length===0||state.times.length<newQueue.length&&newQueue[state.times.length]?.breakBefore&&Number.isFinite(state.wordEnds[state.times.length-1]);
      state.nextIndex=state.awaitingStart?state.times.length:Math.max(0,state.times.length-1);
    }
    refreshManualSyncLinePicker();
    updateManualSyncProgress();
  } else {
    editor.value = VoxStageLyrics.editorText(VoxStageLyrics.textRows(editor.value));
  }
  editor.hidden = true; editor.disabled = true; $('manualVoiceEditors').hidden=true; button.textContent = '✎ Editar letra';
  if (manualSyncState) enterSyncStage();
}
function formatLrcTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centiseconds / 6000), remainder = centiseconds % 6000;
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 100)).padStart(2, '0')}.${String(remainder % 100).padStart(2, '0')}`;
}
function serializeLrcTrack(lines, secondsByTrackIndex) {
  return lines.flatMap((line,index)=>Number.isFinite(secondsByTrackIndex[index]) ? [`[${formatLrcTime(secondsByTrackIndex[index])}]${line}`] : []).join('\n');
}
function remapLyricOccurrences(items,oldRows,newRows) {
  return (items||[]).flatMap(item=>{
    const oldIndex=Number(item.lineIndex),row=oldRows[oldIndex];if(!row)return [];
    const entries=lyricWordEntries(row.text),entry=entries[Number(item.wordIndex)];
    if(!entry||lyricTokenKey(entry.word)!==lyricTokenKey(item.word))return [];
    const voice=row.voice || (isBackingLyric(row.text)?'backing':entry.parallel?'parallel':'lead');
    const rowId=row.voiceId || 'legacy-'+voice+'-'+oldIndex;
    const newIndex=newRows.findIndex(candidate=>candidate.voiceId===rowId);if(newIndex<0)return [];
    const filtered=entries.filter(candidate=>voice==='backing'||row.voice ? true : voice==='parallel'?candidate.parallel:!candidate.parallel);
    const localIndex=filtered.indexOf(entry),nextEntries=lyricWordEntries(newRows[newIndex].text);
    const mapping=new Map(VoxStageLyrics.match(filtered.map(candidate=>lyricTokenKey(candidate.word)),nextEntries.map(candidate=>lyricTokenKey(candidate.word))));
    const wordIndex=mapping.get(localIndex);if(wordIndex===undefined)return [];
    return [{...item,lineIndex:newIndex,wordIndex,word:nextEntries[wordIndex].word}];
  });
}
async function saveOtherManualVoice() {
  const state=manualSyncState,voice=manualSyncFocus,songId=current?.id;
  if(!state||!['line','word'].includes(state.mode)||voice===state.focus||!songId||manualVoiceSavePending)return;
  const text=manualSyncEditor(voice).value;
  if(text.split(/\r?\n/).filter(line=>line.trim()).length>500||VoxStageLyrics.words(text).length>5000){toast('Use até 500 linhas e 5.000 palavras por voz.');return;}
  const voices=VoxStageLyrics.fromLegacy(current,current.lyricLines?current:unifiedLyricsForSong(current),lyricWordEntries);
  voices[voice]=VoxStageLyrics.reconcile(voices[voice],text,voice);
  const projected=VoxStageLyrics.project(voices),oldRows=current.lyricLines||[];
  const selection={...VoxStageLyrics.storage(voices),lyricAdjustments:projected.lyricAdjustments,
    profanityMarks:remapLyricOccurrences(current.profanityMarks,oldRows,projected.lyricLines),
    profanityCues:remapLyricOccurrences(current.profanityCues,oldRows,projected.lyricLines)};
  const song=songs.find(item=>item.id===songId);
  manualVoiceSavePending=true;updateManualSaveButton();
  try{
    if(!song)throw new Error('Música não encontrada na biblioteca.');
    await api('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...song,...selection})});
    Object.assign(song,selection);
    if(current?.id!==songId)return;
    Object.assign(current,selection,projected,{lyricIndex:null,playbackTracks:null,vocalSilenceEnds:[],vocalSilenceState:null});
    if(manualSyncState===state)manualSyncVoices[voice]=structuredClone(voices[voice]);
    if(!manualSyncState)updateLyrics(playbackPosition());
    toast(interfaceLanguage==='en-US'?syncFocusLabel(voice)+' saved. Your sync is still open.':'Letra salva · '+syncFocusLabel(voice)+'. O sync continua aberto.');
  }catch(error){
    console.error('Falha ao salvar a letra de outra voz',error);
    toast(interfaceLanguage==='en-US'?'Could not save. Your lyrics and timing marks are still here.':'Não consegui salvar. A letra e as marcações continuam aqui para tentar novamente.');
  }finally{manualVoiceSavePending=false;updateManualSaveButton();}
}
async function saveManualSync() {
  if(manualVoiceSavePending)return;
  if(manualSyncState&&['line','word'].includes(manualSyncState.mode)&&manualSyncDialog.classList.contains('show')){
    if(manualSyncFocus!==manualSyncState.focus)await saveOtherManualVoice();
    return;
  }
  if(manualSyncState?.mode==='censor'){await saveCensorSync();return;}
  if(manualSyncState?.mode==='silence'){manualSilenceStartMs=null;manualSyncReturn=null;$('closeManualSync').click();return;}
  if(!current||!manualSyncVoices)return;
  try {flushManualVoiceEditors();}catch(error){toast(error.message);return;}
  const state=manualSyncState,voice=state?.focus||manualSyncFocus;
  const voices=VoxStageLyrics.normalize(manualSyncVoices),rows=voices[voice];
  if(state?.mode==='word') {
    const replacements=new Map();
    state.queue.forEach((entry,index)=>{
      const start=state.times[index],end=state.wordEnds?.[index]??(index+1<state.times.length?state.times[index+1]:state.finished&&index===state.queue.length-1?state.endTime:null);
      if(start==null||end==null||!Number.isFinite(Number(start))||!Number.isFinite(Number(end))||Number(end)<=Number(start))return;
      if(!replacements.has(entry.lineIndex))replacements.set(entry.lineIndex,new Map());
      replacements.get(entry.lineIndex).set(entry.wordIndex,{word:entry.word,index:entry.wordIndex,start:Number(start),end:Number(end)});
    });
    for(const [index,cues] of replacements) {
      const row=rows[index];if(!row)continue;
      const saved=VoxStageLyrics.cuePositions(row);
      for(const [wordIndex,cue] of cues)saved.set(wordIndex,cue);
      row.words=[...saved.values()].sort((a,b)=>a.index-b.index);
      const first=row.activeWordIndices?.[0]??0,last=row.activeWordIndices?.at(-1)??VoxStageLyrics.words(row.text).length-1;
      if(cues.has(first))row.time=cues.get(first).start*1000;
      else if(row.time==null)row.time=Math.min(...row.words.map(cue=>cue.start))*1000;
      if(cues.has(last))row.end=cues.get(last).end*1000;
      delete row.adjustment;
    }
  } else if(state?.mode==='line') {
    (state.lineTargets||[]).forEach((index,markIndex)=>{
      const row=rows[index],start=state.times[markIndex];
      if(!row||start==null||!Number.isFinite(Number(start)))return;
      const previous=row.time,delta=previous==null?0:Number(start)-previous/1000;
      row.time=Number(start)*1000;
      if(state.lineEnds?.[index]!=null)row.end=Number(state.lineEnds[index])*1000;
      else if(row.end!=null)row.end+=delta*1000;
      row.words=row.words.map(cue=>({...cue,start:cue.start+delta,end:cue.end+delta}));
      delete row.adjustment;
    });
  }
  const projected=VoxStageLyrics.project(voices),oldRows=current.lyricLines||[];
  const selection={...VoxStageLyrics.storage(voices),lyricAdjustments:projected.lyricAdjustments,
    lyricTrack:current.lyricTrack||current.title,lyricArtist:current.lyricArtist||current.artist||'',
    lyricProvider:state?.mode==='word'?'VoxStage · manual (palavra por palavra)':current.lyricProvider||'VoxStage · manual',
    profanityMarks:remapLyricOccurrences(current.profanityMarks,oldRows,projected.lyricLines),
    profanityCues:remapLyricOccurrences(current.profanityCues,oldRows,projected.lyricLines)};
  if(state?.mode==='word')selection.wordByWordEnabled=true;
  const song=songs.find(item=>item.id===current.id),songId=current.id;
  $('saveManualSync').disabled=true;
  try {
    if(song) {
      await api('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...song,...selection})});
      Object.assign(song,selection);
    }
  } catch(error) {
    console.error('Falha ao salvar as vozes',error);toast('Não consegui salvar. As letras e marcações continuam abertas para tentar novamente.');updateManualSaveButton();return;
  }
  if(current?.id!==songId)return;
  Object.assign(current,selection,projected,{lyricIndex:null,playbackTracks:null,vocalSilenceEnds:[],vocalSilenceState:null});
  manualSyncVoices=voices;manualSyncReturn=null;
  $('closeManualSync').click();
  lyricStatus('Letras e sincronização salvas.');
  toast('Letras e tempos salvos. As outras vozes mantêm sua sincronização.');
}
$('closeManualSync').onclick = () => {
  const returnTo=manualSyncState&&manualSyncReturn?.songId===current?.id?manualSyncReturn:null;
  leaveSyncStage();manualSyncDialog.classList.remove('show','recording','confirm-discard');
  manualSyncDialog.querySelector('.manual-sync-card header').append($('closeManualSync'));
  manualSyncState=null;manualSyncReturn=null;restoreManualVoiceEditors();manualSilenceStartMs=null;
  updateManualSilenceControls();setManualSyncFocus(manualSyncFocus);
  manualSyncEditor().hidden=false;manualSyncEditor().disabled=false;$('editManualLyrics').hidden=true;$('editManualLyrics').textContent='✎ Editar letra';
  $('startManualSync').hidden=false;$('startManualSync').disabled=false;
  manualSyncDialog.querySelector('.manual-sync-modes').hidden=false;
  if(current){
    if(returnTo){pausePlayback();playbackBase=returnTo.position;if(returnTo.playing)startAudioSources(playbackBase);}
    // Preview replaces the lyric DOM. Restore every voice from saved data, even
    // when playback is paused and no animation frame would rebuild the stage.
    $('lyrics').replaceChildren();$('lyrics').classList.remove('voices-merged','voices-overlap');
    current.lyricIndex=null;current.playbackTracks=null;current.vocalSilenceState=null;
    for(const id of ['lyricWordMarker','lyricParallelWordMarker','lyricBackingWordMarker'])if($(id))$(id).hidden=true;
    updateLyrics(playbackPosition());
  }
};
manualSyncDialog.addEventListener('click', event => { if (event.target === manualSyncDialog) $('closeManualSync').click(); });
$('toggleLineRepair').onclick = () => {
  manualSyncRepairEnabled = !manualSyncRepairEnabled;
  $('toggleLineRepair').classList.toggle('selected', manualSyncRepairEnabled);
  $('toggleLineRepair').setAttribute('aria-pressed', String(manualSyncRepairEnabled));
  $('toggleLineRepair').setAttribute('aria-expanded', String(manualSyncRepairEnabled));
  $('manualSyncLinePicker').hidden = !manualSyncRepairEnabled;
  $('manualSyncCopy').textContent = manualSyncRepairEnabled
    ? interfaceLanguage === 'en-US' ? 'Select only the lines that are out of sync. Tap at the start of each phrase, then again at its end.' : 'Marque abaixo só as linhas fora de sincronia. Toque no início de cada frase e depois no fim.'
    : interfaceLanguage === 'en-US' ? 'Follow the lyrics on stage. Tap at the start of each phrase, then again at its end.' : 'Acompanhe a letra no palco. Toque no início de cada frase e depois no fim.';
  if (manualSyncRepairEnabled) refreshManualSyncLinePicker();
};
for(const track of VoxStageLyrics.tracks){
manualSyncEditor(track).addEventListener('focus',()=>{if(manualSyncFocus!==track)setManualSyncFocus(track);});
manualSyncEditor(track).addEventListener('input',()=>{
  refreshManualVoicePanels();
  if(manualSyncRepairEnabled&&!manualSyncState&&track===manualSyncFocus)refreshManualSyncLinePicker();
  updateManualSaveButton();
});
}
$('manualSyncLinePicker').addEventListener('click', event => {
  if (!event.target.closest('[data-select-all-lines]')) return;
  const inputs = [...$('manualSyncLinePicker').querySelectorAll('input[data-line-id]')];
  inputs.forEach(input=>{ input.checked = true; manualSyncPickerState.selectedIds.add(input.dataset.lineId); });
});
$('manualSyncLinePicker').addEventListener('change', event => {
  const input = event.target.closest('input[data-line-id]');
  if (!input) return;
  if (input.checked) manualSyncPickerState.selectedIds.add(input.dataset.lineId);
  else manualSyncPickerState.selectedIds.delete(input.dataset.lineId);
});
$('undoManualSilence').onclick = undoLastManualSilence;
$('toggleSilenceSync').onclick = startSilenceSync;
$('startCensorSync').onclick = startCensorSync;
$('manualSyncDialog').querySelectorAll('[data-sync-mode]').forEach(button => button.onclick = () => setManualSyncMode(button.dataset.syncMode));
$('manualSyncDialog').querySelectorAll('[data-sync-focus]').forEach(button => button.onclick = () => {
  if(manualSyncFocus!==button.dataset.syncFocus)setManualSyncFocus(button.dataset.syncFocus);
});
document.querySelector('.display-content').addEventListener('click', event => {
  if (!manualSyncState?.running || manualSyncDialog.classList.contains('show') || event.target.closest('button,input,a')) return;
  markManualSyncInput();
});
$('startManualSync').onclick = startManualSync; $('markManualSync').onclick = markManualSyncInput; $('undoManualSync').onclick = undoManualSyncLine; $('saveManualSync').onclick = saveManualSync; $('editManualLyrics').onclick = editManualLyrics;
document.addEventListener('keydown', event => {
  if (manualSyncState && !manualSyncDialog.classList.contains('show') && event.code === 'Space' && !event.repeat && !event.target.closest('button,input,textarea,select')) { event.preventDefault(); markManualSyncInput(); return; }
  if (!manualSyncDialog.classList.contains('show')) return;
  if (event.key === 'Escape') { $('closeManualSync').click(); return; }
});
const lyricsButton = document.createElement('button'); lyricsButton.className = 'hud-btn'; lyricsButton.id = 'openLyrics'; lyricsButton.textContent = '♫ Letras';
document.querySelector('.display-bottom').insertBefore(lyricsButton, $('lyricSync'));
lyricsButton.onclick = () => openLyricsDialog('current');
// Concentra controles da apresentação numa barra fixa no rodapé, sem menu flutuante.
const display = $('display'), displayBottom = document.querySelector('.display-bottom'), optionsPanel = $('options');
const lyricWordMarker = document.createElement('span');
lyricWordMarker.className = 'lyric-word-marker'; lyricWordMarker.id = 'lyricWordMarker'; lyricWordMarker.hidden = true;
lyricWordMarker.setAttribute('aria-hidden', 'true'); lyricWordMarker.innerHTML = '<i></i>';
document.querySelector('.display-content').append(lyricWordMarker);
const lyricParallelWordMarker = document.createElement('span');
lyricParallelWordMarker.className = 'lyric-word-marker parallel'; lyricParallelWordMarker.id = 'lyricParallelWordMarker'; lyricParallelWordMarker.hidden = true;
lyricParallelWordMarker.setAttribute('aria-hidden', 'true'); lyricParallelWordMarker.innerHTML = '<i></i>';
document.querySelector('.display-content').append(lyricParallelWordMarker);
const lyricBackingWordMarker = document.createElement('span');
lyricBackingWordMarker.className = 'lyric-word-marker backing'; lyricBackingWordMarker.id = 'lyricBackingWordMarker'; lyricBackingWordMarker.hidden = true;
lyricBackingWordMarker.setAttribute('aria-hidden', 'true'); lyricBackingWordMarker.innerHTML = '<i></i>';
document.querySelector('.display-content').append(lyricBackingWordMarker);
const previousDisplay = document.createElement('button'); previousDisplay.className = 'hud-btn'; previousDisplay.id = 'previousDisplay'; previousDisplay.textContent = '↶'; previousDisplay.title = 'Música anterior';
const nextDisplay = document.createElement('button'); nextDisplay.className = 'hud-btn'; nextDisplay.id = 'nextDisplay'; nextDisplay.textContent = '↷'; nextDisplay.title = 'Próxima música';
const displayBack10 = document.createElement('button'); displayBack10.className = 'hud-btn display-skip'; displayBack10.id = 'displayBack10'; displayBack10.textContent = '−10s'; displayBack10.title = 'Voltar 10 segundos';
const displayForward10 = document.createElement('button'); displayForward10.className = 'hud-btn display-skip'; displayForward10.id = 'displayForward10'; displayForward10.textContent = '+10s'; displayForward10.title = 'Avançar 10 segundos';
function updateSeekStepButtons() {
  const seconds = Math.max(1, Number(processingSettings.seekStepSeconds) || 10);
  for (const button of [displayBack10, displayForward10]) {
    if (!button) continue;
    button.innerHTML = playbackControlSvg(button === displayBack10 ? 'back' : 'forward', seconds);
    button.title = `${button === displayBack10 ? 'Voltar' : 'Avançar'} ${seconds} segundos`;
    button.setAttribute('aria-label', button.title);
  }
}
function nudgePlayback(seconds) {
  if (!current?.buffers?.Inst) return;
  const duration = current.buffers.Inst.duration || 0;
  const nextPosition = Math.max(0, Math.min(duration, playbackPosition() + seconds));
  seek(duration ? nextPosition / duration * 1000 : 0);
}
const displayExit = $('closeDisplay');
const visualSettings = document.createElement('div'); visualSettings.className = 'visual-settings';
const blurInput = $('blur'), glowInput = $('textGlow');
visualSettings.append(blurInput.parentElement, glowInput.parentElement);
visualSettings.querySelectorAll('label').forEach(label=>label.classList.add('hud-range'));
document.documentElement.style.setProperty('--lyrics-glow', `${glowInput.value}px`);
const displayPlayButton = $('dispPlay'), displaySeekInput = $('dispSeek'), displayTime = $('dispTime'), displaySyncButton = $('lyricSync');
const seekLabel = document.createElement('span'); seekLabel.className = 'display-time'; seekLabel.append(displayTime);
const displayDuration = document.createElement('span'); displayDuration.id = 'dispDuration'; displayDuration.className = 'display-time'; displayDuration.textContent = '0:00';
const waveformRow = document.createElement('div'); waveformRow.className = 'waveform-row';
const waveformCanvas = document.createElement('canvas'); waveformCanvas.id = 'waveformCanvas'; waveformCanvas.className = 'waveform-canvas'; waveformCanvas.setAttribute('aria-label', 'Forma de onda e posição da música');
displaySeekInput.style.width = '100%';
waveformRow.append(waveformCanvas, displaySeekInput);
const transportRow = document.createElement('div'); transportRow.className = 'display-transport';
const settingsRow = document.createElement('div'); settingsRow.className = 'display-settings';
const wordSyncToggle = document.createElement('button'); wordSyncToggle.type = 'button'; wordSyncToggle.className = 'hud-btn word-sync-toggle'; wordSyncToggle.id = 'wordSyncToggle';
function updateWordSyncToggle() {
  const button = $('wordSyncToggle');
  if (!button) return;
  const enabled = current?.wordByWordEnabled !== false;
  button.textContent = `Palavra por palavra: ${enabled ? 'ligada' : 'desligada'}`;
  button.title = enabled ? 'Desligar o destaque palavra por palavra nesta música' : 'Ligar o destaque palavra por palavra nesta música';
  button.setAttribute('aria-pressed', String(enabled));
}
wordSyncToggle.onclick = async () => {
  if (!current) { toast('Selecione uma música primeiro.'); return; }
  const previous = current.wordByWordEnabled !== false;
  current.wordByWordEnabled = !previous;
  const song = songs.find(item => item.id === current.id);
  if (song) song.wordByWordEnabled = current.wordByWordEnabled;
  const position = playbackPosition();
  current.lyricIndex = -1;
  updateLyrics(position);
  updateWordSyncToggle();
  if (!song) return;
  try {
    await api('/api/library', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(song)});
  } catch (error) {
    current.wordByWordEnabled = previous;
    song.wordByWordEnabled = previous;
    current.lyricIndex = -1;
    updateLyrics(position);
    updateWordSyncToggle();
    toast('Não consegui salvar essa preferência para a música.');
    console.error(error);
  }
};
displayBottom.replaceChildren(waveformRow, transportRow, settingsRow);
if (mobileNative || presentationDevice!=='pc') {
  const mixButton = document.createElement('button');
  mixButton.id = 'mobileMixToggle'; mixButton.type = 'button'; mixButton.className = 'hud-btn';
  mixButton.textContent = '♫'; mixButton.title = 'Volumes e palavra por palavra';
  mixButton.setAttribute('aria-label', 'Abrir volumes e palavra por palavra');
  mixButton.setAttribute('aria-expanded', 'false');
  displayBottom.append(mixButton);
  mixButton.onclick = () => {
    const open = displayBottom.classList.toggle('mix-open');
    mixButton.setAttribute('aria-expanded', String(open));
    mixButton.setAttribute('aria-label', open ? 'Fechar volumes' : 'Abrir volumes e palavra por palavra');
  };
  document.addEventListener('pointerdown', event => {
    if (!displayBottom.contains(event.target) && displayBottom.classList.contains('mix-open')) {
      displayBottom.classList.remove('mix-open'); mixButton.setAttribute('aria-expanded', 'false');
    }
  });
}
const mobileControlsToggle = document.createElement('button'); mobileControlsToggle.type = 'button'; mobileControlsToggle.id = 'mobileControlsToggle'; mobileControlsToggle.className = 'hud-btn mobile-controls-toggle'; mobileControlsToggle.setAttribute('aria-expanded', 'true'); mobileControlsToggle.setAttribute('aria-label', 'Ocultar controles'); mobileControlsToggle.setAttribute('title', 'Ocultar controles'); mobileControlsToggle.textContent = '⌄';
display.append(mobileControlsToggle);
const quickExitButton = document.createElement('button'); quickExitButton.type = 'button'; quickExitButton.id = 'quickExitDisplay'; quickExitButton.className = 'hud-btn quick-exit-display'; quickExitButton.textContent = '×'; quickExitButton.setAttribute('aria-label', 'Sair da apresentação'); quickExitButton.title = 'Sair da apresentação'; display.append(quickExitButton);
mobileControlsToggle.onclick = () => {
  const collapsed = !display.classList.contains('mobile-controls-hidden');
  setStageControlsHidden(collapsed);
};
function setStageControlsHidden(collapsed) {
  display.classList.toggle('mobile-controls-hidden', collapsed);
  mobileControlsToggle.setAttribute('aria-expanded', String(!collapsed));
  mobileControlsToggle.setAttribute('aria-label', collapsed ? 'Mostrar controles' : 'Ocultar controles');
  mobileControlsToggle.setAttribute('title', collapsed ? 'Mostrar controles' : 'Ocultar controles');
  mobileControlsToggle.textContent = collapsed ? '⌃' : '⌄';
};
// Hidden transport remains usable by touch, including lyrics moved into the lane.
display.addEventListener('click', event => {
  if (presentationDevice!=='phone' || manualSyncState || display.classList.contains('sync-editing') || !event.target.closest('#lyrics,#lyricSecondLine,#scoreLaneLyrics') || event.target.closest('button,input,a')) return;
  if (display.classList.contains('mobile-controls-hidden')) displayPlayButton.click();
  else setStageControlsHidden(true,'manual');
});
transportRow.append(seekLabel, previousDisplay, displayBack10, displayPlayButton, displayForward10, nextDisplay, displayDuration, lyricsButton, displaySyncButton, displayExit);
updateSeekStepButtons();
displayBack10.onclick = () => nudgePlayback(-Math.max(1, Number(processingSettings.seekStepSeconds) || 10));
displayForward10.onclick = () => nudgePlayback(Math.max(1, Number(processingSettings.seekStepSeconds) || 10));
settingsRow.append(wordSyncToggle, fullscreenVolumes, visualSettings);
updateWordSyncToggle();
displayExit.textContent = '⤢ Sair'; displayExit.className = 'hud-btn'; displayExit.removeAttribute('style');
const leaveDisplay = () => {
  if (manualSyncState || manualSyncDialog.classList.contains('show')) $('closeManualSync').click();
  display.classList.remove('show');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
};
displayExit.onclick = leaveDisplay;
quickExitButton.onclick = () => displayExit.click();
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && manualSyncDialog.classList.contains('show') && !display.classList.contains('show')) $('closeManualSync').click();
});
optionsPanel.remove(); $('hamb').remove();
function navigateSong(direction) {
  const visible = songs.filter(song => !song.hidden);
  if (sorted) visible.reverse();
  if (!visible.length) return;
  const index = visible.findIndex(song => song.id === current?.id);
  const nextIndex = index < 0 ? 0 : (index + direction + visible.length) % visible.length;
  playSong(visible[nextIndex].id);
}
const previousPlayerButton = document.querySelector('.controls button[title="Anterior"]');
const nextPlayerButton = document.querySelector('.controls button[title="Próxima"]');
if (previousPlayerButton) previousPlayerButton.onclick = () => navigateSong(-1);
if (nextPlayerButton) nextPlayerButton.onclick = () => navigateSong(1);
previousDisplay.onclick = () => navigateSong(-1); nextDisplay.onclick = () => navigateSong(1);
for (const [button, kind] of [[previousDisplay, 'previous'], [nextDisplay, 'next'], [previousPlayerButton, 'previous'], [nextPlayerButton, 'next']]) {
  if (!button) continue;
  button.innerHTML = playbackControlSvg(kind);
  button.setAttribute('aria-label', button.title);
}
setPlayBusy(false);
const remotePanelStyle = document.createElement('style');
remotePanelStyle.textContent = `.remote-open-button{font-size:16px;margin-right:7px;position:relative}.remote-open-button[data-pending]:after{content:attr(data-pending);position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;padding:0 3px;border-radius:9px;background:#ff748c;color:#190d11;font:800 9px/15px 'DM Sans',sans-serif;text-align:center}.remote-panel{position:fixed;inset:0;z-index:12000;display:none;place-items:center;padding:18px;background:#070809db;backdrop-filter:blur(12px)}.remote-panel.show{display:grid}.remote-card{width:min(760px,100%);max-height:92vh;overflow:auto;padding:22px;border:1px solid #3a3a40;border-radius:18px;background:linear-gradient(145deg,#202124,#141416);box-shadow:0 24px 80px #000b}.remote-card-head{display:flex;justify-content:space-between;align-items:center}.remote-card-head h2{margin:3px 0;font:750 21px Manrope}.remote-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px;margin-top:17px}.remote-qr-box{display:grid;justify-items:center;align-content:start;gap:10px;padding:14px;border:1px solid #37373d;border-radius:14px;background:#121214}.remote-qr-box canvas{width:198px;height:198px;max-width:100%;image-rendering:pixelated;border-radius:5px}.remote-url{width:100%;overflow-wrap:anywhere;color:#aaa;font-size:9px;text-align:center}.remote-howto{margin:0 0 12px;color:#aaa;font-size:11px;line-height:1.55}.remote-host-requests{display:grid;gap:8px;max-height:56vh;overflow:auto}.remote-request{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 10px;padding:11px;border:1px solid #34343a;border-radius:11px;background:#18181b}.remote-request strong,.remote-request small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.remote-request strong{font-size:12px}.remote-request small{grid-column:1;color:#999;font-size:10px}.remote-request-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:6px;margin-top:3px}.remote-request-actions .btn{padding:7px 10px;font-size:10px}.remote-request-state{grid-column:1/-1;color:#aebd87;font-size:10px}.remote-empty{padding:20px;text-align:center;color:#898990;border:1px dashed #3a3a40;border-radius:10px;font-size:11px}.remote-panel-note{margin:12px 0 0;color:#999;font-size:10px;line-height:1.5}@media(max-width:600px){.remote-card{padding:16px}.remote-layout{grid-template-columns:1fr}.remote-qr-box{grid-template-columns:150px minmax(0,1fr);align-items:center;text-align:left}.remote-qr-box canvas{width:144px;height:144px;grid-row:span 2}.remote-url{text-align:left}.remote-host-requests{max-height:38vh}}`;
document.head.append(remotePanelStyle);
remotePanelStyle.textContent += `.hero-actions .remote-open-button{font-size:12px;margin-right:0}`;
remotePanelStyle.textContent += `.remote-transfer-list{display:grid;gap:8px;margin:8px 0 12px;max-height:22vh;overflow:auto}.remote-transfer-list .remote-request{border-color:#53613a}.remote-transfer-list .remote-request small{grid-column:1/-1}`;
const remotePanel = document.createElement('div'); remotePanel.className = 'remote-panel'; remotePanel.id = 'remotePanel';
remotePanel.innerHTML = `<section class="remote-card" role="dialog" aria-modal="true" aria-labelledby="remotePanelTitle"><header class="remote-card-head"><div><span class="lyrics-kicker">VOXSTAGE · CONTROLE LOCAL</span><h2 id="remotePanelTitle">Conectar com o celular</h2></div><button class="lyrics-close" id="remotePanelClose" aria-label="Fechar">×</button></header><div class="remote-layout"><div class="remote-qr-box"><canvas id="remoteQr" width="270" height="270" aria-label="QR code para conectar o celular"></canvas><strong>Leia com a câmera</strong><span class="remote-url" id="remoteUrl">Preparando o endereço…</span><button class="btn secondary" id="remoteQrRefresh">Gerar outro QR</button></div><div><p class="remote-howto">Na mesma rede Wi‑Fi, este QR conecta o controle web. No app VoxStage para Android, toque em “Conectar ao VoxStage” e leia este QR para controlar a reprodução, pedir músicas e copiar faixas.</p><h3 style="font:700 13px Manrope;margin:0 0 9px">Pedidos para aprovar</h3><div class="remote-host-requests" id="remoteHostRequests"><div class="remote-empty">Nenhum pedido ainda.</div></div><p class="remote-panel-note">Faixas da biblioteca entram automaticamente na fila. Músicas enviadas pelo celular são salvas automaticamente. Aprove apenas pedidos novos, que podem precisar de busca ou separação.</p></div></div></section>`;
remotePanel.querySelector('#remoteHostRequests').insertAdjacentHTML('beforebegin','<h3 style="font:700 13px Manrope;margin:12px 0 8px">Músicas enviadas pelo celular</h3><div class="remote-transfer-list" id="remoteTransferList"><div class="remote-empty">Nenhuma transferência aguardando.</div></div>');
document.body.append(remotePanel);
let remoteInfo = null, remotePollBusy = false, remoteStatePublishAt = 0, remotePendingCount = 0;
async function refreshRemoteInfo() {
  const info = await api('/api/remote/host-info');
  remoteInfo = info;
  if (info.url) { const qrUrl = new URL(info.url); qrUrl.searchParams.set('lang', interfaceLanguage); window.drawVoxstageQr($('remoteQr'), qrUrl.toString()); }
  $('remoteUrl').textContent = info.url ? info.url.split('#')[0] : 'Não consegui detectar o IP local. Confira a conexão Wi‑Fi.';
}
function showRemotePanel() {
  remotePanel.classList.add('show');
  refreshRemoteInfo().catch(error => { $('remoteUrl').textContent = error.message; });
  refreshRemoteRequests();
}
function closeRemotePanel() { remotePanel.classList.remove('show'); }
async function refreshRemoteRequests() {
  try {
    const [requests, transfers] = await Promise.all([api('/api/remote/requests'),api('/api/remote/transfers')]);
    const pending = requests.filter(request => request.status === 'pending');
    const pendingCount=pending.length+transfers.length;
    if (pendingCount) remoteOpenButton.dataset.pending = String(pendingCount); else delete remoteOpenButton.dataset.pending;
    if (pendingCount > remotePendingCount && !remotePanel.classList.contains('show')) toast(`${pendingCount} pedido(s) pelo celular aguardando aprovação.`);
    remotePendingCount = pendingCount;
    $('remoteTransferList').innerHTML=transfers.length?transfers.map(item=>`<article class="remote-request"><strong>${esc(item.title)}</strong><small>${esc(item.artist||'Artista desconhecido')} · ${item.files} arquivo(s) recebidos</small><div class="remote-request-actions"><button class="btn secondary" data-transfer-decision="reject" data-transfer-id="${item.id}">Recusar</button><button class="btn" data-transfer-decision="approve" data-transfer-id="${item.id}">Adicionar ao PC</button></div></article>`).join(''):'<div class="remote-empty">Nenhuma transferência aguardando.</div>';
    $('remoteTransferList').querySelectorAll('[data-transfer-decision]').forEach(button=>button.onclick=()=>decideRemoteTransfer(button.dataset.transferId,button.dataset.transferDecision));
    $('remoteHostRequests').innerHTML = pending.length ? pending.map(request => `<article class="remote-request"><strong>${esc(request.title)}</strong><small>${esc(request.artist || (request.songId ? 'Da biblioteca' : 'Pedido de música nova'))}</small><div class="remote-request-actions"><button class="btn secondary" data-remote-decision="reject" data-remote-id="${request.id}">Recusar</button><button class="btn" data-remote-decision="approve" data-remote-id="${request.id}">Aprovar</button></div></article>`).join('') : '<div class="remote-empty">Nenhum pedido aguardando aprovação.</div>';
    document.querySelectorAll('[data-remote-decision]').forEach(button => button.onclick = () => decideRemoteRequest(button.dataset.remoteId, button.dataset.remoteDecision));
  } catch (error) { $('remoteHostRequests').innerHTML = `<div class="remote-empty">${esc(error.message)}</div>`; }
}
async function decideRemoteTransfer(id,decision) {
  try {
    await api(`/api/remote/transfers/${encodeURIComponent(id)}/decision`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});
    if (decision==='approve') { await loadSongs(); toast('Música recebida do celular e adicionada à biblioteca.'); }
    else toast('Transferência recusada.');
    await refreshRemoteRequests();
  } catch(error) { toast(error.message); }
}
async function decideRemoteRequest(id, decision) {
  try {
    const request = await api(`/api/remote/requests/${encodeURIComponent(id)}/decision`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});
    if (decision === 'approve' && !request.songId) {
      closeRemotePanel();
      if (chosenFiles.length || editingSong || $('modal').classList.contains('show')) {
        toast(`Pedido aprovado: ${request.title}. Termine a importação atual antes de começar esta.`);
      } else {
        $('titleInput').value = request.title; $('artistInput').value = request.artist || '';
        showModal();
        toast('Pedido aprovado. Escolha os arquivos desta música para adicionar à biblioteca.');
      }
    } else toast(decision === 'approve' ? 'Pedido aprovado; a música começou no host.' : 'Pedido recusado.');
    refreshRemoteRequests();
  } catch (error) { toast(error.message); }
}
remoteOpenButton.onclick = showRemotePanel;
$('remotePanelClose').onclick = closeRemotePanel;
$('remoteQrRefresh').onclick = async () => { try { await api('/api/remote/rotate', {method:'POST'}); await refreshRemoteInfo(); toast('QR renovado; controles conectados foram desconectados.'); } catch (error) { toast(error.message); } };
remotePanel.onclick = event => { if (event.target === remotePanel) closeRemotePanel(); };
if (!mobileNative || androidTv) { if (!androidTv) refreshRemoteRequests(); setInterval(() => { if (!androidTv || remoteInfo) refreshRemoteRequests(); }, 3500); }
async function pollRemoteHost() {
  if (remotePollBusy) return;
  remotePollBusy = true;
  try {
    const {commands=[]} = await api('/api/remote/commands');
    for (const item of commands) {
      if (item.action === 'play') { if (item.songId) await playSong(item.songId); else if (!playing) toggle(); }
      else if (item.action === 'library-changed') await loadSongs();
      else if (item.action === 'queue') await enqueueRemoteSong(item.songId);
      else if (item.action === 'pause' && playing) pausePlayback();
      else if (item.action === 'next') navigateSong(1);
      else if (item.action === 'previous') navigateSong(-1);
      else if (item.action === 'mvsep-configured') { await loadMvsepConfiguration(); toast('Chave MVSEP recebida do celular.'); }
    }
    const now = Date.now();
    if (now - remoteStatePublishAt > 700) {
      remoteStatePublishAt = now;
      await api('/api/remote/state', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({songId:current?.id||null,title:current?.title||'',artist:current?.artist||'',playing,time:current?playbackPosition():0,duration:current?.buffers?.Inst?.duration||0})});
    }
  } catch {} finally { remotePollBusy = false; }
}
if (!mobileNative || androidTv) setInterval(() => { if (!androidTv || remoteInfo) pollRemoteHost(); }, 550);
const uploadLyrics = document.createElement('div'); uploadLyrics.className = 'upload-lyrics';
uploadLyrics.innerHTML = `<button class="btn secondary" id="draftLyricsButton">♫ Buscar letra sincronizada</button><span id="draftLyricsStatus">Opcional · você pode buscar pela internet</span>`;
$('artistInput').insertAdjacentElement('afterend', uploadLyrics);
artworkSearchButton.classList.add('lyrics-artwork-button');
uploadLyrics.insertAdjacentElement('afterend', artworkSearchButton);
$('draftLyricsButton').onclick = () => openLyricsDialog('draft');
const miniLyric = document.createElement('div'); miniLyric.id = 'nowLyric'; miniLyric.className = 'now-lyric'; miniLyric.hidden = true;
$('nowArtist').insertAdjacentElement('afterend', miniLyric);
const miniStage = document.createElement('div'); miniStage.className = 'mini-stage'; miniStage.id = 'miniStage';
const miniStageImage = document.createElement('img'); miniStageImage.className = 'mini-stage-image'; miniStageImage.alt = '';
const miniStageShade = document.createElement('div'); miniStageShade.className = 'mini-stage-shade';
const miniCoverImage = document.createElement('img'); miniCoverImage.className = 'mini-cover-image'; miniCoverImage.alt = '';
const miniCover = $('miniCover'); miniCover.replaceChildren(miniCoverImage); miniCover.classList.add('has-image');
const miniMeta = miniCover.nextElementSibling;
miniStage.append(miniStageImage, miniStageShade, miniCover, miniMeta);
document.querySelector('.player .now').replaceChildren(miniStage);
function setMiniStage(song) {
  miniCover.dataset.fallback = (song?.title || '♫')[0].toUpperCase();
  miniCover.classList.remove('has-image');
  const preview = song?.background || song?.cover || '';
  if (preview) {
    miniStageImage.src = mediaUrl(preview);
    miniStageImage.hidden = false;
  } else {
    miniStageImage.removeAttribute('src');
    miniStageImage.hidden = true;
  }
  if (song?.cover) {
    miniCoverImage.src = mediaUrl(song.cover);
    miniCoverImage.hidden = false;
  } else {
    miniCoverImage.removeAttribute('src');
    miniCoverImage.hidden = true;
  }
  $('miniStage').setAttribute('aria-label', song ? `Prévia do palco: ${song.title}` : 'Prévia do palco');
}
miniCoverImage.onload = () => miniCover.classList.add('has-image');
miniCoverImage.onerror = () => { miniCover.classList.remove('has-image'); miniCoverImage.hidden = true; };
setMiniStage(null);
miniStage.tabIndex = 0; miniStage.setAttribute('role', 'button'); miniStage.title = 'Abrir o player e as letras';
miniStage.onclick = () => { if (!current) return; $('display').classList.add('show'); $('display').classList.remove('mobile-controls-hidden'); };
miniStage.onkeydown = event => { if (current && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); miniStage.click(); } };
$('fullscreenBtn').title = 'Abrir o player e as letras';
$('fullscreenBtn').setAttribute('aria-label', 'Abrir o player e as letras');
$('fullscreenBtn').onclick = () => { if (current) { $('display').classList.add('show'); $('display').classList.remove('mobile-controls-hidden'); } else toast('Escolha uma música primeiro.'); };
const miniStageStyle = document.createElement('style');
miniStageStyle.textContent = `.player .now{min-width:0;height:76px}.mini-stage{position:relative;isolation:isolate;display:flex;align-items:center;gap:11px;width:100%;height:100%;min-width:0;overflow:hidden;padding:8px 11px;border:1px solid #ffffff1c;border-radius:12px;background:linear-gradient(135deg,#282528,#171719);box-shadow:inset 0 1px #ffffff08}.mini-stage-image{position:absolute;z-index:-2;inset:0;width:100%;height:100%;object-fit:cover;opacity:.72;filter:saturate(.82)}.mini-stage-image[hidden]{display:none}.mini-stage-shade{position:absolute;z-index:-1;inset:0;background:linear-gradient(90deg,#111e 0%,#111c 48%,#1119 100%)}.mini-cover{position:relative;flex:0 0 48px;width:48px;height:48px;overflow:hidden;border-radius:9px;background:linear-gradient(135deg,#624036,#de946b);display:grid;place-items:center;color:white;font-size:18px;box-shadow:0 4px 14px #0007}.mini-cover:after{content:attr(data-fallback);position:absolute;font-weight:800;text-shadow:0 2px 8px #0008}.mini-cover.has-image:after{display:none}.mini-cover-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.mini-cover-image[hidden]{display:none}.mini-stage .now-title{font-size:11px}.mini-stage .now-sub{font-size:9px}.mini-stage .now-lyric{max-width:100%;font-size:clamp(13px,1.25vw,19px);line-height:1.1;font-weight:800;white-space:nowrap;text-overflow:ellipsis;color:#fff;text-shadow:0 2px 10px #000,0 0 12px #fff7;margin-top:5px}.mini-stage .now-lyric[hidden]{display:none!important}@media(max-width:900px){.player .now{height:68px}.mini-stage{gap:7px;padding:6px 7px}.mini-cover{flex-basis:40px;width:40px;height:40px}.mini-stage .now-title{font-size:10px}.mini-stage .now-lyric{font-size:14px}}@media(max-width:590px){.player .now{height:58px;max-width:48vw}.mini-stage{gap:6px;padding:5px}.mini-cover{flex-basis:34px;width:34px;height:34px;border-radius:7px}.mini-stage .now-sub{display:none}.mini-stage .now-lyric{font-size:12px;margin-top:3px}.mini-stage .now-title{font-size:9px}}`;
document.head.append(miniStageStyle);
function updateVolume(key, value) {
  if (key === 'Mic') {
    const volume = Math.max(0, Math.min(1.5, Number(value)));
    const mirror = document.querySelector('[data-full-volume="Mic"]'); if (mirror) mirror.value = String(volume);
    window.VoxStageVocalMonitor?.setVolume(volume);
    return;
  }
  const volume = Math.max(0, Math.min(1, Number(value)));
  $(`vol${key}`).value = String(volume);
  const mirror = document.querySelector(`[data-full-volume="${key}"]`); if (mirror) mirror.value = String(volume);
  if (stemGains[key] && audioContext) stemGains[key].gain.setTargetAtTime(current?.profanityMuted && ['Lead','Back'].includes(key) ? 0 : volume, audioContext.currentTime, .015);
}
document.querySelectorAll('[data-full-volume]').forEach(input => input.oninput = () => updateVolume(input.dataset.fullVolume, input.value));
// O script base já tinha ligado estes controles a elementos <audio>; agora eles
// operam no motor sincronizado dos stems.
$('playBtn').onclick = $('dispPlay').onclick = toggle;
$('seek').oninput = $('dispSeek').oninput = event => seek(event.target.value);
displaySyncButton.onclick = openManualLineSync;
function updateSyncEngineUi() {
  displaySyncButton.textContent = '✎ Sync linhas';
  displaySyncButton.title = 'Abrir sincronização por linha';
  $('lyricSync')?.setAttribute('aria-label', displaySyncButton.title);
}
updateSyncEngineUi();
['Inst', 'Lead', 'Back'].forEach(key => $(`vol${key}`).oninput = event => updateVolume(key, event.target.value));

let mobileStageArtwork = null;
let stagePerformanceTools = null;
function setMobileStageArtwork(song) {
  if (!mobileStageArtwork) return;
  const cover = song?.cover || '';
  mobileStageArtwork.hidden = !cover;
  if (cover) mobileStageArtwork.src = mediaUrl(cover);
  else mobileStageArtwork.removeAttribute('src');
}
if (mobileNative || presentationDevice!=='pc') {
  const displayContent = document.querySelector('.display-content');
  mobileStageArtwork = document.createElement('img');
  mobileStageArtwork.id = 'mobileStageArtwork';
  mobileStageArtwork.alt = 'Capa da música';
  mobileStageArtwork.hidden = true;
  displayContent.insertBefore(mobileStageArtwork, $('lyrics'));

  // Use separate progress, playback and action groups. Desktop keeps its toolbar.
  displayBottom.classList.add('stage-control-panel');
  const progressGroup = document.createElement('div'); progressGroup.className = 'stage-progress';
  progressGroup.append(seekLabel, waveformRow, displayDuration);
  const playbackGroup = document.createElement('div'); playbackGroup.className = 'stage-playback';
  playbackGroup.append(previousDisplay, displayBack10, displayPlayButton, displayForward10, nextDisplay);
  const actionGroup = document.createElement('div'); actionGroup.className = 'stage-actions';
  const startTools = document.createElement('div'); startTools.className = 'stage-tools-start';
  const endTools = document.createElement('div'); endTools.className = 'stage-tools-end';
  const mixButton = $('mobileMixToggle');
  for (const [button, kind, label] of [[lyricsButton, 'lyrics', 'Letras'], [displaySyncButton, 'sync', 'Sync linhas'], [displayExit, 'exit', 'Sair']]) {
    button.innerHTML = `${playbackControlSvg(kind)}<span class="stage-action-label">${label}</span>`;
    button.setAttribute('aria-label', label);
  }
  mixButton.innerHTML = playbackControlSvg('mix');
  mixButton.setAttribute('aria-controls', 'stageMixPanel');
  settingsRow.id = 'stageMixPanel'; settingsRow.setAttribute('aria-label', 'Volumes e palavra por palavra');
  startTools.append(lyricsButton, displaySyncButton); endTools.append(mixButton, displayExit);
  actionGroup.append(startTools, endTools);
  transportRow.className = 'stage-controls'; transportRow.replaceChildren(playbackGroup, actionGroup);
  stagePerformanceTools = document.createElement('div'); stagePerformanceTools.className = 'stage-performance-tools';
  transportRow.append(stagePerformanceTools);
  displayBottom.replaceChildren(progressGroup, transportRow, settingsRow);
  const stageHud = document.querySelector('.display-hud');
  stageHud.classList.add('stage-hud'); stageHud.prepend(mobileControlsToggle, quickExitButton);

  const mobileStageModeButton = document.createElement('button');
  mobileStageModeButton.type = 'button';
  mobileStageModeButton.id = 'mobileStageMode';
  mobileStageModeButton.className = 'hud-btn mobile-stage-mode';
  document.querySelector('.display-hud').append(mobileStageModeButton);
  const updateMobileStageModeButton = () => {
    const tvMode = $('display').classList.contains('mobile-stage-tv');
    const english = interfaceLanguage === 'en-US';
    if (presentationDevice==='tv') {
      const shown = processingSettings.tvShowCover !== false;
      $('display').classList.toggle('tv-cover-visible', shown);
      mobileStageModeButton.innerHTML = `${playbackControlSvg('tv')}<span>${english ? 'Cover' : 'Capa'}: ${shown ? (english ? 'hide' : 'ocultar') : (english ? 'show' : 'exibir')}</span>`;
      mobileStageModeButton.setAttribute('aria-pressed', String(shown));
      mobileStageModeButton.title = english ? 'Show or hide album cover' : 'Exibir ou ocultar capa';
      return;
    }
    mobileStageModeButton.innerHTML = `${playbackControlSvg(tvMode ? 'portrait' : 'tv')}<span>${tvMode ? (english ? 'Portrait' : 'Vertical') : (english ? 'TV mode' : 'Modo TV')}</span>`;
    mobileStageModeButton.setAttribute('aria-pressed', String(tvMode));
    mobileStageModeButton.title = tvMode ? (english ? 'Return to portrait view' : 'Voltar à exibição vertical') : (english ? 'Open landscape full-screen view' : 'Abrir a exibição horizontal em tela cheia');
  };
  mobileStageModeButton.onclick = async () => {
    if (presentationDevice==='tv') { processingSettings.tvShowCover = processingSettings.tvShowCover === false; localStorage.setItem('voxstage-processing-settings', JSON.stringify(processingSettings)); updateMobileStageModeButton(); return; }
    const tvMode = !$('display').classList.contains('mobile-stage-tv');
    if (tvMode) {
      $('display').classList.add('mobile-stage-tv');
      if (mobileNative) { try { window.VoxStageMedia?.setOrientation('landscape'); } catch {} }
      try {
        if ($('display').requestFullscreen && !document.fullscreenElement) await $('display').requestFullscreen();
      } catch {}
      if (!mobileNative) try {
        if (screen.orientation?.lock) await screen.orientation.lock('landscape');
        else throw new Error('orientation lock unavailable');
      } catch {
        if (!screen.orientation?.type?.startsWith('landscape')) {
          $('display').classList.remove('mobile-stage-tv');
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          toast(interfaceLanguage === 'en-US' ? 'Enable auto-rotate, turn your phone sideways, then choose TV mode again.' : 'Ative a rotação automática, vire o celular de lado e escolha o modo TV novamente.');
        }
      }
    } else {
      $('display').classList.remove('mobile-stage-tv');
      if (mobileNative) { try { window.VoxStageMedia?.setOrientation('portrait'); } catch {} }
      try { screen.orientation?.unlock?.(); } catch {}
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    }
    updateMobileStageModeButton();
  };
  updateMobileStageModeButton();
  document.addEventListener('fullscreenchange', () => {
    if (presentationDevice==='tv') return;
    if (!document.fullscreenElement && $('display').classList.contains('mobile-stage-tv')) {
      $('display').classList.remove('mobile-stage-tv');
      if (mobileNative) { try { window.VoxStageMedia?.setOrientation('portrait'); } catch {} }
      try { screen.orientation?.unlock?.(); } catch {}
      updateMobileStageModeButton();
    }
  });
  const leaveDisplayWithOrientation = leaveDisplay;
  $('closeDisplay').onclick = () => {
    leaveDisplayWithOrientation();
    if (presentationDevice==='tv') { window.dispatchEvent(new Event('voxstage-tv-library')); return; }
    $('display').classList.remove('mobile-stage-tv');
    if (mobileNative) { try { window.VoxStageMedia?.setOrientation('portrait'); } catch {} }
    try { screen.orientation?.unlock?.(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    updateMobileStageModeButton();
  };
  const mobileStageStyle = document.createElement('style');
  mobileStageStyle.textContent = `
    .mobile-native-app #mobileStageArtwork{display:block;width:min(52vw,230px);height:min(52vw,230px);flex:0 0 auto;object-fit:cover;border-radius:19px;box-shadow:0 18px 52px #0009}
    .mobile-native-app #mobileStageArtwork[hidden]{display:none}
    .mobile-native-app .display-content{justify-content:flex-start;padding-top:calc(env(safe-area-inset-top) + 88px);gap:clamp(20px,5vh,38px)}
    .mobile-native-app .display-content .lyrics{flex:0 1 auto;max-height:38dvh;overflow:auto;padding:0 4px}
    .mobile-native-app .display-hud{pointer-events:none}
    .mobile-native-app .mobile-stage-mode{position:absolute;right:0;top:0;z-index:10;min-height:36px;padding:0 10px;pointer-events:auto;font-size:10px}
    .mobile-native-app .display-bottom{display:flex;flex-direction:column;align-items:stretch}
    .mobile-native-app .waveform-row{width:100%;height:23px}
    .mobile-native-app .waveform-canvas{height:23px}
    .mobile-native-app .display-transport{display:grid;grid-template-columns:40px 46px 40px minmax(0,1fr) auto;gap:6px;width:100%}
    .mobile-native-app .display-transport>#previousDisplay{grid-column:1;grid-row:1}
    .mobile-native-app .display-transport>#dispPlay{grid-column:2;grid-row:1}
    .mobile-native-app .display-transport>#nextDisplay{grid-column:3;grid-row:1}
    .mobile-native-app .display-transport>.display-time:first-of-type{grid-column:4;grid-row:1;justify-self:end}
    .mobile-native-app .display-transport>#dispDuration{grid-column:5;grid-row:1}
    .mobile-native-app .display-transport>#openLyrics{grid-column:1/3;grid-row:2}
    .mobile-native-app .display-transport>#lyricSync{grid-column:3/5;grid-row:2}
    .mobile-native-app .display-transport>#closeDisplay{grid-column:5;grid-row:2;min-width:44px}
    .mobile-native-app .display-transport>#dispPlay{width:46px;height:42px;border-radius:14px;background:var(--lime);color:#151610;font-size:17px}
    .mobile-native-app .display.mobile-stage-tv .display-content{height:100dvh;flex-direction:row;justify-content:center;align-items:center;gap:5vw;padding:64px 5vw 160px;overflow:hidden}
    .mobile-native-app .display.mobile-stage-tv #mobileStageArtwork{display:none}
    .mobile-native-app .display.mobile-stage-tv .display-content .lyrics{width:min(78vw,1100px);max-width:1100px;max-height:calc(100dvh - 210px);font-size:clamp(34px,5.4vw,76px)!important;line-height:1.22;overflow:hidden}
    .mobile-native-app .display.mobile-stage-tv .display-hud{left:5vw;right:5vw;top:calc(env(safe-area-inset-top) + 12px);max-width:none;transform:none;justify-content:center}
    .mobile-native-app .display.mobile-stage-tv .mobile-stage-mode{right:0;top:0}
    .mobile-native-app .display.mobile-stage-tv .display-bottom{left:4vw;right:4vw;bottom:calc(9px + env(safe-area-inset-bottom));display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:10px 14px}
    .mobile-native-app .display.mobile-stage-tv .display-transport{grid-template-columns:40px 46px 40px auto minmax(100px,1fr) auto;align-items:center}
    .mobile-native-app .display.mobile-stage-tv .display-transport>#previousDisplay,.mobile-native-app .display.mobile-stage-tv .display-transport>#dispPlay,.mobile-native-app .display.mobile-stage-tv .display-transport>#nextDisplay,.mobile-native-app .display.mobile-stage-tv .display-transport>.display-time:first-of-type,.mobile-native-app .display.mobile-stage-tv .display-transport>#dispDuration{grid-row:1}
    .mobile-native-app .display.mobile-stage-tv .display-transport>#openLyrics{grid-column:auto;grid-row:1}
    .mobile-native-app .display.mobile-stage-tv .display-transport>#lyricSync{grid-column:auto;grid-row:1}
    .mobile-native-app .display.mobile-stage-tv .display-transport>#closeDisplay{grid-column:auto;grid-row:1}
    .mobile-native-app .display.mobile-stage-tv .waveform-row{order:initial}
    .mobile-native-app .display.mobile-stage-tv .display-settings{max-height:44px;overflow-x:auto;overflow-y:hidden}
    .mobile-native-app .display.mobile-stage-tv .display-content .lyrics .next{margin-top:.35em}
    @media(orientation:landscape){.mobile-native-app .display:not(.mobile-stage-tv) .display-content{flex-direction:row;justify-content:center;gap:5vw;padding:60px 6vw 168px}.mobile-native-app .display:not(.mobile-stage-tv) #mobileStageArtwork{width:min(30vw,40dvh);height:min(30vw,40dvh)}.mobile-native-app .display:not(.mobile-stage-tv) .display-content .lyrics{max-height:55dvh}}
  `;
  mobileStageStyle.textContent += `
    .mobile-native-app .display-content{padding-bottom:calc(58px + env(safe-area-inset-bottom));overflow:hidden}
    .mobile-native-app .display:not(.mobile-controls-hidden) .display-content{padding-bottom:calc(150px + env(safe-area-inset-bottom))}
    .mobile-native-app .display-bottom{left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));display:grid;grid-template-columns:minmax(0,1fr);gap:5px;padding:8px 10px;border-radius:16px;max-height:24dvh;overflow:auto;transition:opacity .18s,transform .18s,background .18s}
    .mobile-native-app .waveform-row,.mobile-native-app .waveform-canvas{height:18px}
    .mobile-native-app .display-transport{display:grid;grid-template-columns:38px 44px 38px minmax(0,1fr) auto;gap:5px;width:100%;align-items:center}
    .mobile-native-app .display-transport>#previousDisplay,.mobile-native-app .display-transport>#dispPlay,.mobile-native-app .display-transport>#nextDisplay,.mobile-native-app .display-transport>.display-time:first-of-type,.mobile-native-app .display-transport>#dispDuration{grid-row:1;grid-column:auto;justify-self:initial}
    .mobile-native-app .display-transport>#dispPlay{width:42px;height:38px}
    .mobile-native-app .display-transport>#openLyrics,.mobile-native-app .display-transport>#lyricSync,.mobile-native-app .display-transport>#closeDisplay{grid-row:2;min-height:34px;padding:0 8px;font-size:10px}
    .mobile-native-app .display-transport>#openLyrics{grid-column:1/3}.mobile-native-app .display-transport>#lyricSync{grid-column:3/5}.mobile-native-app .display-transport>#closeDisplay{grid-column:5;min-width:38px}
    .mobile-native-app .display-settings{max-height:40px;overflow-x:auto;overflow-y:hidden;justify-content:flex-start;flex-wrap:nowrap;white-space:nowrap;scrollbar-width:none;padding:1px 0}
    .mobile-native-app .display-settings::-webkit-scrollbar{display:none}
    .mobile-native-app .display-settings .fullscreen-volumes{flex-wrap:nowrap;gap:7px}
    .mobile-native-app .display-settings .hud-range input{width:48px}
    .mobile-native-app .mobile-controls-toggle{display:none;position:absolute;z-index:2;top:-36px;left:50%;transform:translateX(-50%);width:44px;height:32px;min-width:44px;padding:0;border-radius:12px 12px 0 0;background:#17181deF;font-size:16px}
    .mobile-native-app .display-bottom .mobile-controls-toggle{display:grid;place-items:center}
    .mobile-native-app .display.mobile-controls-hidden .display-bottom{left:50%;right:auto;bottom:calc(8px + env(safe-area-inset-bottom));width:48px;height:42px;max-height:42px;overflow:visible;transform:translateX(-50%);padding:0;background:transparent;border:0;box-shadow:none}
    .mobile-native-app .display.mobile-controls-hidden .display-bottom>.waveform-row,.mobile-native-app .display.mobile-controls-hidden .display-bottom>.display-transport,.mobile-native-app .display.mobile-controls-hidden .display-bottom>.display-settings{display:none!important}
    .mobile-native-app .display.mobile-controls-hidden .mobile-controls-toggle{position:static;width:48px;height:42px;border:1px solid #ffffff35;border-radius:15px;background:#17181dcc;backdrop-filter:blur(14px);transform:none;box-shadow:0 5px 22px #0008}
    .mobile-native-app .display:not(.mobile-controls-hidden) .mobile-controls-toggle{top:-31px}
    .mobile-native-app .display.mobile-stage-tv .display-content{padding:54px 5vw calc(54px + env(safe-area-inset-bottom));}
    .mobile-native-app .display.mobile-stage-tv:not(.mobile-controls-hidden) .display-content{padding-bottom:calc(122px + env(safe-area-inset-bottom))}
    .mobile-native-app .display.mobile-stage-tv .display-bottom{left:5vw;right:5vw;bottom:calc(7px + env(safe-area-inset-bottom));grid-template-columns:minmax(0,1fr);max-height:21dvh}
    .mobile-native-app .display.mobile-stage-tv .display-transport{grid-template-columns:38px 44px 38px auto minmax(70px,1fr) auto auto auto auto}
    .mobile-native-app .display.mobile-stage-tv .display-transport>*{grid-row:1!important;grid-column:auto!important}
    .mobile-native-app .display.mobile-stage-tv .display-transport #dispSeek{grid-column:1/-1!important;grid-row:2!important}
    .mobile-native-app .display.mobile-stage-tv .display-settings{max-height:34px}
    .mobile-native-app .display.mobile-stage-tv.mobile-controls-hidden .display-bottom{left:50%;right:auto;width:48px}
    
    
    
    
    
    
    
    
    
    
    
    @media(orientation:landscape){.mobile-native-app .display:not(.mobile-stage-tv) .display-content{padding-bottom:calc(60px + env(safe-area-inset-bottom))}.mobile-native-app .display:not(.mobile-stage-tv):not(.mobile-controls-hidden) .display-content{padding-bottom:calc(124px + env(safe-area-inset-bottom))}}
  `;
  document.head.append(mobileStageStyle);
}

// Interface localization: Portuguese remains the source language so that
// returning to Portuguese restores the original copy without reloading data.
const englishUiCopy = {
  'Separar com MVSEP':'Separate with MVSEP','Volume':'Volume','Como obter uma chave MVSEP':'How to get an MVSEP key','Nome completo do arquivo':'Full file name','Faixa completa · pronta para tocar ou separar.':'Full track · ready to play or separate.','Recentes':'Recent','Favoritas':'Favorites','Configurações':'Settings','Seu espaço':'Your space','Biblioteca':'Library','Seu palco começa aqui':'Your stage starts here','Biblioteca musical':'Music library','Suas músicas, seus stems, sua apresentação.':'Your songs, your stems, your show.','＋ Adicionar música':'＋ Add music','Pronto para cantar?':'Ready to sing?','Transforme qualquer música no seu palco.':'Turn any song into your stage.','Importe suas faixas, ajuste cada voz e cante no seu ritmo — tudo salvo no seu dispositivo.':'Import your tracks, adjust each stem, and sing at your own pace — everything stays on your device.','＋ Importar música':'＋ Import music','músicas':'songs','Áudio local':'Local audio','Privado':'Private','Suas músicas':'Your songs','⌕  Buscar música...':'⌕  Search songs...','Mais recentes⌄':'Newest⌄','Mais antigas⌄':'Oldest⌄','Escolha uma música':'Choose a song','Seu palco está esperando':'Your stage is waiting','Anterior':'Previous','Próxima':'Next','Velocidade':'Speed','Transpor':'Transpose','Tela de exibição':'Stage view','Inst.':'Inst.','Lead':'Lead','Back':'Back','Adicionar música':'Add music','Os arquivos são guardados neste computador. Para começar, envie o instrumental e os vocais principais. Backing vocals são opcionais.':'Files are stored on this computer. To get started, upload the instrumental and lead vocals. Backing vocals are optional.','Os arquivos são guardados neste navegador. Para começar, envie o instrumental e os vocais principais. Backing vocals são opcionais.':'Files are stored in this browser. To get started, upload the instrumental and lead vocals. Backing vocals are optional.','Arquivos de áudio':'Audio files','Instrumental *':'Instrumental *','Vocais principais *':'Lead vocals *','Backing vocals':'Backing vocals','Imagem de capa':'Cover image','Nome da música':'Song title','Artista':'Artist','Cancelar':'Cancel','Salvar música':'Save song','Ajustes de exibição':'Display settings','Desfoque do fundo':'Background blur','Brilho do texto':'Text glow','Sair da exibição':'Exit stage view','e comece seu show':'and start your show','Sync':'Sync','Não separada':'Not separated','3 stems':'3 stems','2 stems':'2 stems','Artista desconhecido':'Unknown artist','Adicionar aos favoritos':'Add to favorites','Remover dos favoritos':'Remove from favorites','Mais opções':'More options','Editar música':'Edit song','Apagar música':'Delete song','Separar no computador':'Separate on this computer','Separando…':'Separating…','Faixa completa · pronta para tocar ou separar.':'Full track · waiting for local separation.','Nenhuma música encontrada.':'No songs found.','Sua biblioteca está vazia. Adicione uma música para começar.':'Your library is empty. Add a song to get started.','Você ainda não favoritou músicas.':'You have no favorite songs yet.','＋ Escolher arquivos de áudio, imagem e vídeo':'＋ Choose audio, image, and video files','Selecione vários arquivos de uma vez':'Select multiple files at once','Depois da seleção, marque o papel de cada arquivo.':'After selecting files, assign a role to each one.','Música completa · não separada':'Full song · not separated','Capa':'Cover','Imagem de fundo':'Background image','Vídeo de fundo':'Background video','Não usar':'Do not use','Selecionado':'Selected','Arquivo inválido':'Invalid file','Buscar ou colar do YouTube':'Search or paste from YouTube','YouTube Music primeiro':'YouTube Music first','Pesquisar no catálogo do YouTube Music…':'Search YouTube Music…','Link do YouTube ou nome da música':'YouTube link or song title','Buscar':'Search','Cole o link do vídeo do YouTube':'Paste the YouTube video link','Capa do álbum':'Album cover','Buscar capa da música':'Search for album art','CAPAS EM ALTA RESOLUÇÃO':'HIGH-RESOLUTION ARTWORK','Usar como capa':'Use as cover','Usar como fundo':'Use as background','Usar como ambos':'Use for both','Fechar':'Close','Nome da música e artista':'Song title and artist','Sincronizar letras':'Sync lyrics','Buscar letras':'Search lyrics','Letra sincronizada':'Synced lyrics','Sincronização de letras':'Lyrics sync','Sincronização manual':'Manual sync','Sincronizar':'Sync','Palavra por palavra':'Word by word','Não mostrar novamente':'Do not show again','Entendi':'Got it','Continuar':'Continue','Recurso beta':'Beta feature','Este recurso está em beta':'This feature is in beta','Modelo local':'Local model','Processamento local':'Local processing','Aviso sobre modelos locais':'Local model warning','Separação de música no computador':'Local song separation','O modo local gera instrumental e uma faixa vocal combinada. Backing vocals separados ainda não são gerados. Na primeira execução, o modelo será baixado para este computador.':'Local processing creates an instrumental and a combined vocal track. It does not create a separate backing vocal stem yet. The model will be downloaded to this computer the first time you run it.','CPU · recomendado':'CPU · recommended','GPU · DirectML beta':'GPU · DirectML beta','Mais compatível e sem depender da GPU; pode demorar.':'More compatible and does not rely on your GPU; it may take longer.','Experimental em AMD/Intel Windows; pode falhar ou consumir a memória de vídeo.':'Experimental on AMD/Intel Windows; it may fail or use a lot of video memory.','Tempo mínimo de silêncio vocal':'Minimum vocal silence duration','Os pontos só aparecem depois que o vocal fica em silêncio por este tempo contínuo. A sensibilidade do áudio fica no perfil normal.':'The pause indicator appears only after vocals stay silent for this long. Audio sensitivity remains at the normal setting.','Chave da API MVSep':'MVSep API key','No Windows, ela é protegida para sua conta e fica neste computador. Não cole sua chave aqui no chat.':'On Windows, this key is protected for your account and stays on this computer. Do not paste your key into this chat.','Remover':'Remove','Verificando configuração…':'Checking configuration…','Modelo de separação MVSep':'MVSep separation model','Escolha o algoritmo online para separar os vocais e o instrumental. As opções são carregadas do catálogo oficial.':'Choose the online algorithm for separating vocals and instrumentals. Options are loaded from the official catalog.','Carregando modelos…':'Loading models…','Carregando modelos disponíveis…':'Loading available models…','Idioma da interface':'Interface language','Escolha o idioma usado nos menus, mensagens e configurações do VoxStage.':'Choose the language used in VoxStage menus, messages, and settings.','Português (Brasil)':'Português (Brasil)','English':'English','Chave já salva · digite outra para substituir':'Key saved · enter another to replace it','Cole sua chave da API':'Paste your API key','Chave salva neste computador.':'Key saved on this computer.','Nenhuma chave configurada.':'No key configured.','Verificando instalação…':'Checking installation…','Verificando o mecanismo local…':'Checking local engine…','CPU pronto neste computador.':'CPU is ready on this computer.','DirectML pronto neste computador.':'DirectML is ready on this computer.','Chave removida deste computador.':'Key removed from this computer.','Nenhum modelo de vocais e instrumental foi encontrado.':'No vocal and instrumental models were found.','Não consegui reproduzir estes arquivos.':'Could not play these files.','Música salva na sua biblioteca.':'Song saved to your library.','Música apagada.':'Song deleted.','Instrumental e vocais principais são obrigatórios.':'Instrumental and lead vocals are required.','Adicione uma música primeiro.':'Add a song first.','Configurações de exibição: use o menu durante a apresentação.':'Display settings: use the menu during your performance.','Exibindo sua biblioteca recente.':'Showing your recent library.','Digite o nome da música ou artista.':'Enter a song title or artist.','Buscando capas…':'Searching for artwork…','Não encontrei capas para esta busca.':'No artwork found for this search.','Baixando imagem em qualidade alta…':'Downloading high-resolution artwork…','Imagem adicionada como capa. Salve a música para manter a alteração.':'Image added as cover. Save the song to keep this change.','Imagem adicionada como fundo. Salve a música para manter a alteração.':'Image added as background. Save the song to keep this change.','Imagem adicionada como capa e fundo. Salve a música para manter a alteração.':'Image added as cover and background. Save the song to keep this change.','Imagem de alta resolução adicionada.':'High-resolution image added.','Imagem aplicada como capa e fundo.':'Image applied as cover and background.','Não foi possível conectar. Confira a internet e tente novamente.':'Could not connect. Check your internet connection and try again.','Pesquise pelo nome da música para encontrar letras.':'Search by song title to find lyrics.','Buscando no catálogo…':'Searching the catalog…','Não foi possível conectar. Confira a internet e tente novamente.':'Could not connect. Check your internet connection and try again.','Letra ainda sem tempos':'Lyrics have no timing yet','Use Sync linhas para marcar enquanto toca':'Use line sync to mark lyrics during playback','Letra não encontrada':'Lyrics not found','Busque outra versão pelo botão Letras':'Search for another version using the Lyrics button','Letra sem sincronização':'Unsynced lyrics','Escolha uma versão sincronizada pelo botão Letras':'Choose a synced version using the Lyrics button','Sincronizada':'Synced','Sem tempos':'No timing','Usar letra →':'Use lyrics →','Adicionar letra à música':'Add lyrics to song','Letras sincronizadas':'Synced lyrics','Buscar letra':'Search lyrics','Ainda sem letra sincronizada.':'No synced lyrics yet.','Buscando a letra':'Searching for lyrics','via LRCLIB…':'via LRCLIB…','Esta música completa ainda precisa ser separada antes de tocar.':'This full track must be separated before playback.','Preparando os stems…':'Preparing stems…','Preferências salvas neste aparelho.':'Preferences saved on this computer.','Configurações':'Settings','Fechar':'Close','Salvar preferências':'Save preferences','Onde executar o alinhamento local de letras':'Where to run local lyric alignment','Vale para sincronizar palavras das letras já existentes. No modo automático, usa a GPU apenas se estiver disponível no ambiente instalado.':'This controls word alignment for existing lyrics. Automatic mode uses the GPU only if it is available in the installed environment.','Automático':'Automatic','Usar GPU compatível; senão, CPU':'Use a compatible GPU; otherwise, CPU','CPU':'CPU','Mais compatível; pode ser lento':'More compatible; may be slow','GPU':'GPU','Requer suporte do PyTorch e driver compatível':'Requires PyTorch support and a compatible driver','Quanto resíduo há no stem vocal?':'How much residue is in the vocal stem?','O VoxStage usa este perfil para decidir quando o vocal realmente parou. Se a voz estiver sendo cortada cedo, escolha um perfil mais baixo.':'VoxStage uses this profile to decide when vocals have stopped. If vocals are being cut off too early, choose a lower profile.','Pouco resíduo · preserva vocais baixos':'Low residue · preserves quiet vocals','Muito resíduo · ignora ruído mais alto':'High residue · ignores louder noise','Método para preparar os stems':'Stem preparation method','Importe stems manualmente ou baixe uma faixa do YouTube com yt-dlp e separe-a online pela MVSep.':'Upload stems manually or download a YouTube track with yt-dlp and separate it online with MVSep.','Arquivos manuais':'Manual files','Disponível agora':'Available now','Separação local':'Local separation','Em preparação':'In progress','API MVSep':'MVSep API','Busca no YouTube · separação online':'YouTube search · online separation','Tempo mínimo de silêncio vocal':'Minimum vocal silence duration','Configurações salvas.':'Settings saved.','＋ Buscar capa na internet':'＋ Search the internet for artwork','Buscar capa na internet':'Search the internet for artwork','Baixar vídeo':'Download video','Baixe um vídeo do YouTube diretamente para a pasta music, sem enviar nada à MVSep. Ele fica disponível como fundo mudo; se não houver faixa combinada no YouTube, o download salva apenas o vídeo e não precisa de FFmpeg.':'Download a YouTube video directly to the music folder without sending anything to MVSep. It can be used as a muted background; if YouTube has no combined audio track, only the video is saved and FFmpeg is not needed.','Configure uma chave MVSep em ⚙ Configurações para usar esta opção.':'Set an MVSep API key in ⚙ Settings to use this option.','MVSep · ONLINE':'MVSep · ONLINE','DOWNLOAD LOCAL · YT-DLP':'LOCAL DOWNLOAD · YT-DLP','Imagens serão salvas localmente.':'Images are saved locally.','Separe uma faixa completa':'Separate a full track','Separar música':'Separate track','Status local':'Local status','Sincronizar linhas':'Sync lines','Sync linhas':'Sync lines','Usar letra':'Use lyrics','Adicionar letra à música':'Add lyrics to song','Marcador de palavra':'Word marker','Sobreposição de precisão':'Vocal score overlay','Pontuação da apresentação':'Performance score','Vocal':'Vocal','Indisponível':'Unavailable','Abrir':'Open','Voltar':'Back','Padrão':'Default','Aplicar':'Apply','Restaurar':'Restore','1,5 s · recomendado':'1.5 s · recommended'
};
Object.assign(englishUiCopy, {
  'Sobre':'About','Versão indisponível':'Version unavailable','Versão do aplicativo':'App version',
  'Incluir resultados do YouTube normal':'Include standard YouTube results',
  'Pesquise uma versão sincronizada ou cole sua própria letra. Backings podem ficar entre parênteses.':'Search for synced lyrics or paste your own. Put backing vocals in parentheses.',
  'Ou cole sua própria letra':'Or paste your own lyrics',
  'Cole a letra aqui, uma linha por frase. Você pode colar timestamps LRC também.':'Paste lyrics here, one phrase per line. You can also paste LRC timestamps.',
  'Usar esta letra':'Use these lyrics',
  'Marcar palavrões':'Mark profanity',
  'Marcar início do backing':'Mark backing start',
  'Marcar fim do backing':'Mark backing end',
  '✓ Marcar início da frase':'✓ Mark phrase start',
  '✓ Marcar fim da frase':'✓ Mark phrase end',
  'Cole sua letra antes de aplicar.':'Paste your lyrics before applying them.',
  'Não consegui reconhecer os timestamps LRC. Confira o formato [mm:ss.xx].':'I could not read those LRC timestamps. Check the [mm:ss.xx] format.',
  'Cole uma frase por linha. Coloque backing vocals entre parênteses.':'Paste one phrase per line. Put backing vocals in parentheses.',
  'Coloque backings entre parênteses':'Put backing vocals in parentheses',
  'Reprodução':'Playback',
  'Processamento':'Processing',
  'Processamento local':'Local processing',
  'Nuvem':'Cloud',
  'Envios em progresso':'Uploads in progress',
  'Visual':'Visual',
  'Escolha os arquivos e marque cada papel. Uma faixa completa pode ser tocada ou separada depois pelo menu da música; tudo fica na pasta music.':'Choose files and assign a role to each one. You can play a full track or separate it later from the song menu; everything stays in the music folder.',
  'Arquivos para esta música':'Files for this song','Áudio e imagem · selecione vários arquivos':'Audio and image · select multiple files','Depois da seleção, marque o papel de cada arquivo.':'After selecting files, assign a role to each one.','Faixa completa':'Full track','Vocal principal':'Lead vocal','Vocais':'Vocals','Imagem adicionada como capa. Salve a música para manter a alteração.':'Image added as cover. Save the song to keep this change.','Imagem adicionada como fundo. Salve a música para manter a alteração.':'Image added as background. Save the song to keep this change.','Imagem adicionada como capa e fundo. Salve a música para manter a alteração.':'Image added as cover and background. Save the song to keep this change.','Pesquise por música e artista. Escolha se quer aplicar o resultado como capa ou imagem de fundo.':'Search for a song and artist. Choose whether to use the result as the cover or background image.','Pesquise pelo título ou cole um link direto. O envio à MVSep só começa quando você escolher um resultado.':'Search by title or paste a direct link. The upload to MVSep starts only after you choose a result.','Configure uma chave MVSep em ⚙ Configurações antes de enviar uma música.':'Set an MVSep API key in ⚙ Settings before sending a song.','A busca prioriza faixas do catálogo do YouTube Music para evitar apresentações ao vivo e videoclipes. O VoxStage baixa o áudio com yt-dlp e envia à MVSep para separar os stems; o serviço pode usar créditos da sua conta.':'Search prioritizes tracks from YouTube Music to avoid live performances and music videos. VoxStage downloads the audio with yt-dlp and sends it to MVSep for stem separation; the service may use credits from your account.','Digite o nome da música ou cole um link do YouTube.':'Enter a song title or paste a YouTube link.','Buscando opções no YouTube Music…':'Searching YouTube Music…','Não encontrei vídeos para essa busca.':'No videos found for this search.','Separar →':'Separate →','Separando…':'Separating…','Processamento em andamento':'Processing','Letra ainda sem tempos':'Lyrics have no timing yet','Pesquise pelo nome da música para encontrar letras.':'Search by song title to find lyrics.','Buscando no catálogo…':'Searching the catalog…','Nenhuma letra encontrada. Tente artista + título ou confira a grafia.':'No lyrics found. Try artist + title or check the spelling.','Busque outra versão pelo botão Letras':'Search for another version using the Lyrics button','Escolha uma versão sincronizada pelo botão Letras':'Choose a synced version using the Lyrics button','Não foi possível conectar. Confira a internet e tente novamente.':'Could not connect. Check your internet connection and try again.','Buscando artista…':'Loading artist…','Buscando álbum…':'Loading album…','Faixa sem título':'Untitled track','Sem artista':'Unknown artist','Pausa vocal':'Vocal pause','Digite o nome da música ou artista.':'Enter a song title or artist.','Buscando capas…':'Searching for artwork…','Não encontrei capas para esta busca.':'No artwork found for this search.','Baixando imagem em qualidade alta…':'Downloading high-resolution artwork…','Imagem de alta resolução adicionada.':'High-resolution image added.','Sincronismo palavra a palavra salvo':'Word-by-word sync saved','Não consegui alinhar as palavras.':'Could not align the words.','Letra selecionada:':'Lyrics selected:','precisa sincronizar':'needs syncing','Ainda sem letra sincronizada.':'No synced lyrics yet.','Buscando a letra':'Searching for lyrics','Preparando os stems…':'Preparing stems…','Você precisa escolher um papel para cada arquivo.':'Choose a role for each file.','Não foi possível salvar esta música.':'Could not save this song.','Música salva na sua biblioteca.':'Song saved to your library.','Esta música completa ainda precisa ser separada antes de tocar.':'This full track must be separated before playback.','Processando áudio':'Processing audio','Não foi possível reproduzir estes arquivos.':'Could not play these files.','Ajustes de exibição':'Display settings','Brilho do texto':'Text glow','Desfoque do fundo':'Background blur','Sair da exibição':'Exit stage view','Sync linhas':'Sync lines','⟲ Sync':'⟲ Sync','Salvar preferências':'Save preferences','Configurações de processamento':'Processing settings','Tempo mínimo de silêncio vocal':'Minimum vocal silence duration','Chave da API MVSep':'MVSep API key','Modelo de separação MVSep':'MVSep separation model','Onde executar o alinhamento local de letras':'Where to run local lyric alignment','Método para preparar os stems':'Stem preparation method','Arquivos manuais':'Manual files','Separação local':'Local separation','Disponível agora':'Available now','Em preparação':'In progress','GPU compatível':'compatible GPU','Escolha uma música':'Choose a song','Capa do álbum':'Album cover','Imagem de capa':'Cover image','Imagem de fundo':'Background image','Vídeo de fundo':'Background video','Normal':'Normal','Padrão':'Default','Salvar':'Save','Cancelar':'Cancel'
  ,'Vídeo de fundo (mudo)':'Background video (muted)','Música completa · não separada':'Full song · not separated','Instrumental':'Instrumental','Vocais principais':'Lead vocals','Backing vocals':'Backing vocals','Não usar':'Do not use','Capa do álbum':'Album cover','Imagem de fundo':'Background image','Arquivos recebidos! Confira os papéis e salve a música.':'Files received! Check the roles and save the song.','Arquivos recebidos da MVSep. Revise os stems e salve a música.':'Files received from MVSep. Review the stems and save the song.','Arquivo recebido':'File received','Download concluído':'Download complete','Falha na integração.':'Integration failed.','Digite o nome da música ou cole um link do YouTube.':'Enter a song title or paste a YouTube link.','Adicionada à biblioteca':'Added to library','Sem sincronização':'Unsynced','Letras ainda sem tempos':'Lyrics have no timing yet','Use Sync linhas para marcar enquanto toca':'Use line sync to mark lyrics during playback','Letra não encontrada':'Lyrics not found','Letra sem sincronização':'Unsynced lyrics','Não foi possível buscar a letra':'Could not search for lyrics','Tente novamente pelo botão Letras':'Try again using the Lyrics button','Palavra':'Word','Iniciar sincronização':'Start syncing','Editar música':'Edit song','Salvar música':'Save song','Preparar separação local':'Prepare for local separation','Separar música':'Separate track','Opcional · você pode buscar pela internet':'Optional · you can search online','Escolha uma música primeiro.':'Choose a song first.','Processando separação…':'Processing separation…','Separação concluída.':'Separation complete.','Separação falhou.':'Separation failed.','Não consegui acessar a biblioteca local. Inicie o app pelo arquivo .bat.':'Could not access the local library. Start the app using the .bat file.','Não consegui atualizar os favoritos.':'Could not update favorites.','Use a música completa sozinha ou envie os stems separados.':'Use the full track on its own or upload the separated stems.','Marque um instrumental e um vocal principal. Backing, imagens e vídeo são opcionais.':'Assign an instrumental and lead vocal. Backing vocals, images, and video are optional.','Faixa completa salva e pronta para tocar ou separar.':'Full track saved in music for local separation.','Música e arquivos salvos na pasta music.':'Song and files saved in the music folder.','Iniciando separação local…':'Starting local separation…','Separação local concluída. Vocal combinado e instrumental salvos.':'Local separation complete. Combined vocals and instrumental saved.','Música e arquivos apagados.':'Song and files deleted.','Não consegui apagar a música.':'Could not delete the song.','Toque até chegar à linha que quer ajustar.':'Play until you reach the line you want to adjust.','Não foi possível salvar o ajuste desta linha':'Could not save this line adjustment','Ajuste aplicado, mas não consegui salvá-lo.':'Adjustment applied, but could not save it.','O modelo multilíngue analisa o vocal para marcar cada palavra. Pode consumir vários GB de RAM e bastante CPU. A configuração atual do PyTorch é CPU-only, então este alinhamento ainda não usará a GPU.':'The multilingual model analyzes vocals to timestamp each word. It can use several GB of RAM and a lot of CPU. The current PyTorch setup is CPU-only, so this alignment will not use the GPU yet.','A alternativa manual por linha não usa modelos nem exige instalação. Continue apenas se quiser iniciar o alinhamento palavra a palavra.':'Manual line-by-line sync does not use models or require installation. Continue only if you want to start word alignment.','Toque ou selecione uma música primeiro.':'Play or select a song first.','Selecione uma música e abra a apresentação primeiro.':'Select a song and open the stage view first.','Toque esta música primeiro e aguarde o áudio carregar.':'Play this song first and wait for the audio to load.','Use até 500 linhas por música.':'Use up to 500 lines per song.','Espere a próxima linha chegar antes de marcar.':'Wait for the next line before marking it.','Letra atualizada;':'Lyrics updated;','marcação(ões) após a alteração precisam ser refeitas.':'mark(s) after the change need to be redone.','Falha ao salvar a sincronização manual':'Could not save manual sync','Sync aplicado, mas não consegui salvar na biblioteca.':'Sync applied, but could not save it to the library.','Selecione uma música primeiro.':'Select a song first.','Não consegui salvar essa preferência para a música.':'Could not save this song preference.','Mais rápido':'Faster','Agora não':'Not now','Processamento em andamento':'Processing','Progresso:':'Progress:','Sem artista':'Unknown artist','Abrindo…':'Opening…','Baixando o vídeo…':'Downloading video…','Cole um link direto de vídeo do YouTube.':'Paste a direct YouTube video link.','Vídeo baixado para a pasta music.':'Video downloaded to the music folder.','Configure sua chave da API MVSep em ⚙ Configurações primeiro.':'Set your MVSep API key in ⚙ Settings first.','1 música':'1 song','Salvar como':'Save as','Letra atualizada':'Lyrics updated','Nome da música e artista':'Song title and artist','Áudio local · Privado':'Local audio · Private','Importar música':'Import music','Salvar alterações':'Save changes','☆ Favoritas':'☆ Favorites','★ Favoritas':'★ Favorites','Entendi, continuar':'Got it, continue','Atenção · processamento local':'Warning · local processing','ATENÇÃO · PROCESSAMENTO LOCAL':'WARNING · LOCAL PROCESSING','Uso alto de recursos':'High resource usage','A separação por IA pode usar bastante memória do sistema e da placa de vídeo, deixar o computador lento ou falhar em músicas longas. Feche outros programas pesados. CPU é a opção mais compatível; DirectML na GPU é experimental.':'AI separation may use a lot of system and video memory, slow down your computer, or fail on long tracks. Close other demanding programs. CPU is the most compatible option; GPU DirectML is experimental.','Não mostrar novamente':'Do not show again','Adicionar uma música primeiro.':'Add a song first.','Aguardando a letra':'Waiting for lyrics','atraso':'offset','duração':'duration','◌ Alinhando…':'◌ Syncing…','O MMS-FA precisa de tempos por linha. Escolha Sync manual ou busque uma letra sincronizada.':'MMS-FA requires line timings. Choose manual sync or search for synced lyrics.','A letra precisa ter pelo menos uma linha.':'Lyrics must have at least one line.','Cole a letra, com uma linha por frase.':'Paste the lyrics, one line per phrase.','Salvar alterações':'Save changes','Aplicar letra':'Apply lyrics','Salvar sync':'Save sync','Salvar sincronização':'Save sync','Desfazer':'Undo','Marcar início da frase':'Mark phrase start','Começar do início':'Start from the beginning','✎ Editar letra':'✎ Edit lyrics','✎ Sincronizar por linha':'✎ Sync line by line','✎ Sincronizar por linha':'⌨ Sync line by line','Cole ou edite a letra acima.':'Paste or edit the lyrics above.','Todas as linhas foram marcadas. Salve para aplicar a sincronia.':'All lines have been marked. Save to apply the sync.','linhas marcadas':'lines marked','linhas com tempo':'timed lines','pronto para salvar':'ready to save','SYNC aplicado':'SYNC applied','Sincronismo palavra a palavra salvo':'Word-by-word sync saved','Vocal':'Vocal','Instrumental':'Instrumental','Backing':'Backing','Aumentar velocidade':'Increase speed','Diminuir velocidade':'Decrease speed','Mais lenta':'Slower','Mais rápida':'Faster','Mais recentes':'Newest','Mais antigas':'Oldest','Salvar preferências':'Save preferences','Buscar letras':'Search lyrics'
});
Object.assign(englishUiCopy, {
  'Título da música ou artista':'Song title or artist',
  'Buscar letra sincronizada':'Search synced lyrics','♫ Buscar letra sincronizada':'Search synced lyrics','♪ Buscar letra sincronizada':'Search synced lyrics','⌕ Buscar letra sincronizada':'Search synced lyrics',
  '⌕ Buscar capa na internet':'⌕ Search for artwork online','＋ Buscar capa na internet':'＋ Search for artwork online','Buscar capa na internet':'Search for artwork online',
  'Tema de cores':'Color theme','Muda os destaques do app, a palavra ativa e os indicadores de letra no palco.':'Changes the app accents, active lyric word, and on-stage lyric indicators.','Lima · padrão':'Lime · default','Oceano':'Ocean','Violeta':'Violet','Rosa':'Rose','Âmbar':'Amber',
  'Palavra por palavra: ligada':'Word-by-word: on','Palavra por palavra: desligada':'Word-by-word: off','♫ Letras':'♫ Lyrics','✎ Sync linhas':'⌨ Sync lines','⤢ Sair':'⤢ Exit','Pontuar':'Score','Letras':'Lyrics','Sync linhas':'Sync lines','Sair':'Exit','Abrir sincronização por linha':'Open line sync','Música anterior':'Previous song','Próxima música':'Next song','Abrir a apresentação em tela cheia':'Open the full-screen stage view',
  'Desligar o destaque palavra por palavra nesta música':'Turn off word-by-word highlighting for this song','Ligar o destaque palavra por palavra nesta música':'Turn on word-by-word highlighting for this song'
});
const appThemePalette = {
  lime: {accent:'#d4fb69', soft:'rgba(212,251,105,.13)', border:'#718b39'},
  ocean: {accent:'#74dbd3', soft:'rgba(116,219,211,.14)', border:'#397e79'},
  violet: {accent:'#b99aff', soft:'rgba(185,154,255,.14)', border:'#7456a9'},
  rose: {accent:'#ff82ad', soft:'rgba(255,130,173,.14)', border:'#a84d70'},
  amber: {accent:'#ffc46b', soft:'rgba(255,196,107,.14)', border:'#9b7138'}
};
function setAppTheme(name) {
  interfaceTheme = name === 'custom' ? 'custom' : Object.hasOwn(appThemePalette, name) ? name : 'lime';
  try { localStorage.setItem('voxstage-theme', interfaceTheme); } catch {}
  const custom = processingSettings.themeCustomColor || '#d4fb69';
  const toRgb = hex => { const value = String(hex).replace('#',''); return [parseInt(value.slice(0,2),16),parseInt(value.slice(2,4),16),parseInt(value.slice(4,6),16)]; };
  const [r,g,b] = toRgb(custom);
  const palette = interfaceTheme === 'custom' ? {accent:custom, soft:`rgba(${r},${g},${b},.14)`, border:`rgba(${r},${g},${b},.58)`} : appThemePalette[interfaceTheme], root = document.documentElement.style;
  root.setProperty('--lime', palette.accent);
  root.setProperty('--word-marker', palette.accent);
  root.setProperty('--lyrics-active-color', palette.accent);
  applyVoiceTheme();
  root.setProperty('--theme-soft', palette.soft);
  root.setProperty('--theme-border', palette.border);
  const selector = $('interfaceTheme'); if (selector) selector.value = interfaceTheme;
  root.setProperty('--lyrics-scale-portrait', String(processingSettings.lyricsScale || 1));
  root.setProperty('--lyrics-scale-tv', String(processingSettings.lyricsScaleTv || 1));
}
function applyVoiceTheme() {
  document.documentElement.style.setProperty('--word-marker-secondary',processingSettings.voice2Color);
  document.documentElement.classList.toggle('voice-overlap-gradient',processingSettings.voicesOverlapGradient!==false);
}
const appThemeStyle = document.createElement('style');
appThemeStyle.textContent = `.tag,.filter-btn.selected,.word-sync-toggle[aria-pressed=true],.lyrics-badge.synced{background:var(--theme-soft)!important;border-color:var(--theme-border)!important}.lyric-word.active{color:var(--lyrics-active-color)!important;text-shadow:0 0 20px var(--lyrics-active-color)!important}.lyric-word-marker i,.lyric-pause i{background:var(--word-marker)!important;box-shadow:0 0 12px var(--word-marker)}.lyric-pause{color:var(--word-marker)!important}.processing-options label:has(input:checked){border-color:var(--theme-border)!important;background:var(--theme-soft)!important}.lyrics-badge.synced,.tag{color:var(--lime)!important}.filter-btn.selected,.word-sync-toggle[aria-pressed=true]{color:var(--lime)!important}`;
document.head.append(appThemeStyle);
const extraFeatureStyle = document.createElement('style');
extraFeatureStyle.textContent = `.profanity-picker-dialog{position:fixed;inset:0;z-index:42;display:none;place-items:center;padding:18px;background:#08090bdc;backdrop-filter:blur(12px)}.profanity-picker-dialog.show{display:grid}.profanity-picker-card{width:min(760px,100%);max-height:88vh;overflow:auto;padding:22px;border:1px solid #414148;border-radius:18px;background:linear-gradient(145deg,#202124,#141416);box-shadow:0 24px 80px #000b}.profanity-picker-card header{display:flex;align-items:center;justify-content:space-between}.profanity-picker-card h2{margin:4px 0;font:700 20px Manrope}.profanity-picker-card p{color:#aaa;font-size:12px;line-height:1.5}.profanity-picker-words{display:grid;gap:8px;padding:14px;border-radius:12px;background:#101012;line-height:2.2}.profanity-picker-words>div{display:block}.profanity-pick-word{padding:2px 4px;border-radius:5px;background:transparent;color:#e9e9eb;cursor:pointer}.profanity-pick-word.selected{background:#7c3037;color:#fff;border-bottom:2px solid #ff737d}.profanity-picker-card footer{display:flex;justify-content:flex-end;margin-top:15px}.lyric-word.profanity{color:#ff7884!important;text-decoration:underline wavy #ff7884;text-decoration-thickness:1px;text-underline-offset:5px}.lyric-backing-line{display:block;margin:.42em auto 0;color:#c7a7ff;font-size:.58em;font-weight:600;line-height:1.25;opacity:.9}.lyric-backing-line[hidden]{display:none!important}.sync-track-select,.theme-custom-row,.lyrics-scale-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;padding:10px 12px;border:1px solid #35353b;border-radius:10px;background:#18181b;color:#ddd;font-size:11px}.sync-track-select select{background:#222226;color:#eee;border:1px solid #3d3d42;border-radius:8px;padding:7px}.theme-custom-row input[type=color]{width:50px;height:32px;padding:2px;background:#18181b;border:1px solid #414148;border-radius:7px}.lyrics-scale-row input{flex:1;max-width:180px;accent-color:var(--lime)}.lyrics-scale-row output{min-width:38px;text-align:right;font-variant-numeric:tabular-nums}.mobile-native-app .display .display-content .lyrics{font-size:calc(clamp(30px,8vw,48px) * var(--lyrics-scale,1))!important}.mobile-native-app .display.mobile-stage-tv .display-content .lyrics{font-size:calc(clamp(34px,5.4vw,76px) * var(--lyrics-scale,1))!important}@media(max-width:550px){.profanity-picker-card{padding:16px}.sync-track-select{align-items:stretch;flex-direction:column}.sync-track-select select{width:100%}}`;
document.head.append(extraFeatureStyle);
const lyricBehaviorStyle=document.createElement('style');
lyricBehaviorStyle.textContent=`.profanity-picker-dialog{z-index:60}.lyric-word.profanity,.lyric-word.profanity.active,.backing-lyric-word.profanity,.lyric-censor-word.profanity{color:inherit!important;text-decoration:none!important;filter:blur(.34em)!important;transition:filter .12s ease}.lyric-backing-line .backing-lyric-word.active{color:var(--lyric-accent,var(--lime));text-shadow:0 0 14px var(--lyric-accent,var(--lime))}.lyric-current-backing{color:#d4b7ff!important}.manual-sync-card #openProfanityPicker{align-self:flex-start;margin:0 0 8px;padding:7px 10px;font-size:10px}`;
document.head.append(lyricBehaviorStyle);
const uiTextNodes = new WeakMap(), uiAttributeValues = new WeakMap();
const uiAttributes = ['title','placeholder','aria-label','aria-description','alt'];
const userSuppliedText = '#stageSongTitle,#stageSongArtist,#menuTvTitle,#menuTvArtist,.menu-queue-song,.menu-now-song,.track-title,.track-artist,.now-title,.now-sub,#dispTrack,.lyric-current-line,.lyric-word,.lyric-parallel-phrase,.lyric-backing-line,.second-lyric-word,.profanity-phrase,.manual-sync-context,.manual-sync-current,.manual-sync-picker,.file-name,.youtube-result strong,.youtube-result-artist,.youtube-result-album,.artwork-meta strong,.artwork-meta small';
Object.assign(englishUiCopy, {
  'VOXSTAGE · CONFIGURAÇÃO INICIAL':'VOXSTAGE · FIRST-TIME SETUP',
  'Prepare os recursos opcionais':'Set up optional features',
  'Escolha o que quer instalar neste computador. Você pode pular e configurar depois.':'Choose what to install on this computer. You can skip and set things up later.',
  'Separação local de áudio':'Local audio separation',
  'Sincronização automática de letras':'Automatic lyric alignment',
  'Importação do YouTube':'YouTube importing',
  'Verificando…':'Checking…',
  'Pronto neste computador':'Ready on this computer',
  'Não instalado':'Not installed',
  'Falha ao verificar':'Could not check',
  'Separação local':'Local separation',
  'Cria instrumental e vocal combinado sem enviar o áudio para um serviço. O download das bibliotecas ocupa vários GB; o modelo de separação baixa na primeira música.':'Creates instrumental and combined vocals without sending audio to a service. The libraries use several GB; the separation model downloads the first time you process a song.',
  'Onde processar':'Where to process',
  'CPU · mais compatível':'CPU · most compatible',
  'GPU DirectML · experimental para AMD/Intel':'DirectML GPU · experimental for AMD/Intel',
  'Instalar separação local':'Install local separation',
  'Sincroniza letras existentes palavra por palavra. A instalação é grande; ao usar, o modelo pode consumir vários GB de memória. Em placas AMD, o alinhamento roda na CPU.':'Aligns existing lyrics word by word. The installation is large; the model may use several GB of memory when run. On AMD cards, alignment runs on the CPU.',
  'Instalar alinhador de letras':'Install lyric aligner',
  'Habilita pesquisa e importação pelo yt-dlp. Precisa de internet; Deno é opcional e pode melhorar a compatibilidade com o YouTube.':'Enables search and importing with yt-dlp. Requires internet; Deno is optional and may improve YouTube compatibility.',
  'Instalar importador':'Install importer',
  'Não mostrar automaticamente novamente':'Do not show automatically again',
  'Pular por agora':'Skip for now',
  'Instalar novamente':'Install again',
  'Preparando instalação…':'Preparing installation…',
  'Iniciando…':'Starting…',
  'Instalação concluída.':'Setup complete.',
  'Configurar recursos opcionais':'Set up optional features',
  'Não foi possível verificar':'Could not check',
  'yt-dlp + Deno prontos':'yt-dlp + Deno ready',
  'Não instalado. Abra “Configurar recursos opcionais” para instalar CPU.':'Not installed. Open “Set up optional features” to install CPU.',
  'Não instalado. Abra “Configurar recursos opcionais” para instalar GPU DirectML.':'Not installed. Open “Set up optional features” to install DirectML GPU.'
});

Object.assign(englishUiCopy, {
  '✦ Transcrever áudio com MVSep':'✦ Transcribe audio with MVSep',
  'Controle pelo celular':'Phone remote control','Conectar com o celular':'Connect to phone',
  'VOXSTAGE · CONTROLE LOCAL':'VOXSTAGE · LOCAL REMOTE',
  'Leia com a câmera':'Scan with your camera',
  'Gerar outro QR':'Generate another QR code',
  'Pedidos para aprovar':'Requests to review',
  'Na mesma rede Wi‑Fi, este QR conecta o controle web. No app VoxStage para Android, toque em “Conectar ao VoxStage” e leia este QR para controlar a reprodução, pedir músicas e copiar faixas.':'On the same Wi-Fi network, this QR connects the web remote. In the VoxStage Android app, tap “Connect to VoxStage” and scan this QR to control playback, request songs, and copy tracks.',
  'Ao aprovar um pedido novo, a tela de importação abre no host para você escolher os arquivos. Pedidos da biblioteca aprova e toca a faixa no host.':'Approving a new song opens the import screen on the host so you can choose files. Approving a library request starts playback on the host.',
  'Nenhum pedido ainda.':'No requests yet.',
  'Nenhum pedido aguardando aprovação.':'No requests awaiting approval.',
  'Da biblioteca':'From library',
  'Pedido de música nova':'New song request',
  'Recusar':'Reject',
  'Aprovar':'Approve',
  'Pedido aprovado. Escolha os arquivos desta música para adicionar à biblioteca.':'Request approved. Choose this song’s files to add it to the library.',
  'Pedido aprovado; a música começou no host.':'Request approved; playback started on the host.',
  'Pedido recusado.':'Request rejected.'
});

Object.assign(englishUiCopy, {
  'Marcar letra por linha':'Sync lyrics line by line',
  'Marcar letra palavra por palavra':'Sync lyrics word by word',
  'SINCRONIZAÇÃO LEVE':'LIGHTWEIGHT SYNC',
  '✎ Sync linhas':'✎ Line sync',
  'Abrir sincronização por linha':'Open line sync',
  'Acompanhe a letra no palco. Use o botão grande quando a frase começar. A reprodução e a barra de busca continuam acessíveis.':'Follow the lyrics on stage. Tap the large button when each phrase begins. Playback and seeking stay available.',
  'Marque abaixo só as linhas fora de sincronia. Toque no botão grande quando a linha selecionada começar; os outros tempos serão mantidos.':'Select only the lines that are out of sync. Tap the large button when the selected line begins; other timings will be kept.',
  'Selecionar linhas para corrigir':'Select lines to fix',
  '✓ Marcar linha selecionada':'✓ Mark selected line',
  '✓ Marcar início da frase':'✓ Mark phrase start',
  'Marcar início da frase':'Mark phrase start',
  'Marcar linha selecionada':'Mark selected line',
  '0 linhas marcadas':'0 lines marked',
  '0 palavras marcadas':'0 words marked',
  'Todas as palavras sincronizadas · pronto para salvar':'All words synced · ready to save',
  'Todas as palavras foram marcadas.':'All words are marked.',
  'Selecione pelo menos uma linha para sincronizar.':'Select at least one line to sync.',
  'Todas as linhas selecionadas foram marcadas. Salve para aplicar a sincronia.':'All selected lines are marked. Save to apply the sync.',
  'Linhas selecionadas corrigidas.':'Selected lines corrected.',
  'VoxStage · correção manual parcial':'VoxStage · partial manual correction',
  'A palavra exibida é a atual. Deixe o áudio tocar e toque no botão grande quando ela terminar; a próxima começa nesse instante. A primeira usa o tempo da linha existente ou 0:00.':'The displayed word is the current one. Let it play, then tap the large button when it ends; the next word starts at that moment. The first word uses the existing line timing or 0:00.',
  'Palavra por palavra':'Word by word',
  'PALAVRA ATUAL':'CURRENT WORD',
  'PRÓXIMA PALAVRA':'NEXT WORD',
  'Por linha':'Line by line',
  'Deixe a palavra exibida tocar até o fim antes de avançar.':'Let the displayed word play to the end before advancing.',
  'Não encontrei palavras na letra.':'No words found in these lyrics.',
  'Use até 5.000 palavras por música.':'Use up to 5,000 words per song.',
  'Espere a próxima palavra antes de marcar.':'Wait for the next word before marking.',
  'Todas as palavras foram marcadas. Salve para aplicar a sincronia.':'All words are marked. Save to apply the sync.',
  'Letra sincronizada manualmente palavra por palavra.':'Lyrics synced manually word by word.',
  'VoxStage · manual (palavra por palavra)':'VoxStage · manual (word by word)'
});

Object.assign(englishUiCopy, {
  'Ativar lista compacta':'Switch to compact list','Voltar aos cartões':'Return to card view',
  'Prévia da próxima palavra':'Next word preview','Mostra discretamente a palavra seguinte durante a reprodução. No sync manual, a próxima palavra continua visível.':'Shows the upcoming word subtly during playback. Manual sync always shows the next word.','Mostrar próxima palavra no playback':'Show next word during playback','Desativado por padrão; o sync manual sempre mostra o próximo alvo.':'Off by default; manual sync always shows the next target.','Mostrar próxima palavra durante a reprodução':'Show the next word during playback',
  'Recursos experimentais':'Experimental features','Ative apenas os recursos que deseja usar. As alterações entram em vigor imediatamente.':'Enable only the features you want to use. Changes take effect immediately.','GPU · DirectML experimental':'GPU · DirectML experimental'
});
Object.assign(englishUiCopy, {
  '▣ Conectar ao VoxStage':'▣ Connect to VoxStage','Conectar ao VoxStage':'Connect to VoxStage','Conectar pelo link':'Connect with link','Importar músicas':'Import songs',
  'Músicas deste celular':'Send from phone to PC','Peça uma faixa para adicioná-la à fila. Se ela ainda não estiver no aparelho conectado, será enviada automaticamente. Você também pode enviar várias faixas sem tocar.':'Select songs on this phone. Songs will be saved automatically to the PC library.','Enviar selecionadas':'Send selected to PC','Músicas enviadas pelo celular':'Songs sent from phone','Nenhuma transferência aguardando.':'No transfers awaiting approval.','Adicionar ao PC':'Add to PC','Já está no aparelho conectado':'Already on PC','Enviada · salvando na biblioteca':'Sent · saving on PC','Salva no aparelho conectado':'Saved on PC','Recusada no aparelho conectado':'Rejected on PC','Preparando envio…':'Preparing upload…',
  'Leia o QR exibido no VoxStage do PC ou da TV para controlar a reprodução e enviar músicas. Os dois aparelhos precisam estar na mesma rede Wi‑Fi.':'Scan the QR shown in VoxStage to control playback. Both devices must be on the same Wi-Fi network.',
  '▣ Abrir leitor QR':'▣ Open QR scanner','Ler QR de uma foto':'Scan a QR from a photo','Aponte para o QR do VoxStage':'Point at the VoxStage QR code','Abrindo a câmera…':'Opening camera…','Solicitando permissão da câmera…':'Requesting camera permission…','Mantenha o QR inteiro dentro da moldura.':'Keep the whole QR code inside the frame.','QR reconhecido. Conectando…':'QR recognized. Connecting…',
  'Controle remoto':'Remote control','Conectando…':'Connecting…','Nenhuma música tocando':'No song playing on the host','Tocando no computador':'Playing on computer','Reprodução pausada':'Playback paused','Comando enviado ao computador.':'Command sent to computer.','Pedido enviado. O host precisa aprovar.':'Request sent. The host must approve it.','Música adicionada à fila.':'Song added to the queue.','Conectar ao VoxStage':'Connect to VoxStage','Conectado à TV. Use os controles ou peça uma música da biblioteca.':'Connected to TV. Use the controls or request a library song.','Pedir':'Request','Pedir uma música que não está na lista':'Request a song that is not listed','Artista (opcional)':'Artist (optional)','Enviar pedido':'Send request to host','A música não está no aparelho':'Song is not on this device'
});
Object.assign(englishUiCopy, {
  'Mostrar ocultas':'Show hidden', 'Esconder ocultas':'Hide hidden', 'Ocultar música':'Hide song', 'Mostrar música':'Unhide song',
  'Música oculta. Use “Mostrar ocultas” para recuperá-la.':'Song hidden. Use “Show hidden” to restore it.',
  'Música visível novamente.':'Song visible again.', 'Tocando na TV':'Playing on TV',
  'Conectado à TV. Use os controles ou peça uma música da biblioteca.':'Connected to TV. Use the controls or request a library song.'
});

Object.assign(englishUiCopy, {
  'Músicas deste celular':'Songs on this phone',
  'Enviar selecionadas':'Send selected',
  'Já está no aparelho conectado':'Already on the connected device',
  'Salva no aparelho conectado':'Saved on the connected device',
  'Recusada no aparelho conectado':'Rejected on the connected device',
  'Enviada · salvando na biblioteca':'Sent · saving to the library',
  'Preferências salvas neste aparelho.':'Preferences saved on this device.',
  'Importe uma faixa completa ou os stems. Você pode separar a faixa com MVSEP pelo menu da música salva.':'Import a full track or stems. Separate the track with MVSEP from the saved song menu.',
  'Sair da apresentação':'Exit stage view',
  'Envio falhou · Ver detalhes':'Upload failed · View details',
  'Envio concluído · Voltar ao formulário':'Upload complete · Return to form',
  'Voltar ao envio':'Return to upload'
});

function translateUiCopy(source) {
  if (interfaceLanguage !== 'en-US') return source;
  const trimmed = source.trim();
  const normalized = trimmed.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  if (Object.hasOwn(englishUiCopy, normalized)) return englishUiCopy[normalized];
  let match;
  if ((match = trimmed.match(/^(\d+) músicas$/))) return `${match[1]} songs`;
  if ((match = trimmed.match(/^(\d+) nota\(s\) marcada\(s\)$/))) return `${match[1]} note(s) marked`;
  if ((match = trimmed.match(/^(\d+) linha\(s\) marcada\(s\)$/))) return `${match[1]} line(s) marked`;
  if ((match = trimmed.match(/^Palavra (\d+) de (\d+) · toque quando terminar$/))) return `Word ${match[1]} of ${match[2]} · tap when it ends`;
  if ((match = trimmed.match(/^(\d+) de (\d+) linhas selecionadas com tempo(?: · pronto para salvar)?$/))) return `${match[1]} of ${match[2]} selected lines timed${trimmed.endsWith(' · pronto para salvar') ? ' · ready to save' : ''}`;
  if ((match = trimmed.match(/^(\d+) de (\d+) linha selecionada com tempo(?: · pronto para salvar)?$/))) return `${match[1]} of ${match[2]} selected line timed${trimmed.endsWith(' · pronto para salvar') ? ' · ready to save' : ''}`;
  if ((match = trimmed.match(/^Correção salva · (\d+) linhas$/))) return `Correction saved · ${match[1]} lines`;
  if ((match = trimmed.match(/^(\d+) de (\d+) palavras marcadas(?: · pronto para salvar)?$/))) return `${match[1]} of ${match[2]} words marked${trimmed.endsWith(' · pronto para salvar') ? ' · ready to save' : ''}`;
  if ((match = trimmed.match(/^(\d+) de (\d+) linhas com tempo(?: · pronto para salvar)?$/))) return `${match[1]} of ${match[2]} timed lines${trimmed.endsWith(' · pronto para salvar') ? ' · ready to save' : ''}`;
  if ((match = trimmed.match(/^(\d+) resultados?$/))) return `${match[1]} result${match[1] === '1' ? '' : 's'}`;
  if ((match = trimmed.match(/^(\d+) resultado\(s\)\. As imagens serão salvas localmente\.$/))) return `${match[1]} result(s). Images will be saved locally.`;
  if ((match = trimmed.match(/^(\d+) modelos compatíveis disponíveis\. Modelos premium foram ocultados\.$/))) return `${match[1]} compatible models available. Premium models are hidden.`;
  if ((match = trimmed.match(/^(\d+) opção\(ões\), priorizando faixas do YouTube Music\. Escolher inicia o envio para a MVSep\.$/))) return `${match[1]} option(s), prioritizing YouTube Music tracks. Choose one to start the MVSep upload.`;
  if ((match = trimmed.match(/^([+-]?\d+) palavras \(MMS-FA · (GPU|CPU)\)$/))) return `${match[1]} words (MMS-FA · ${match[2]})`;
  if ((match = trimmed.match(/^([+-]?\d+) notas?$/))) return `${match[1]} note${Math.abs(Number(match[1])) === 1 ? '' : 's'}`;
  if ((match = trimmed.match(/^Aguardando na fila da MVSep · posição (\d+)$/))) return `Waiting in the MVSep queue · position ${match[1]}`;
  if ((match = trimmed.match(/^([\d.]+) s · (.+)$/))) return `${match[1]} s · ${({ 'pausas bem curtas':'very short pauses','pausas curtas':'short pauses','recomendado':'recommended','pausas longas':'long pauses','silêncios prolongados':'extended silences' })[match[2]] || match[2]}`;
  if (/^Não consegui carregar o catálogo da MVSep:/.test(trimmed)) return trimmed.replace('Não consegui carregar o catálogo da MVSep:','Could not load the MVSep catalog:');
  if (/^Não consegui verificar a instalação:/.test(trimmed)) return trimmed.replace('Não consegui verificar a instalação:','Could not check the installation:');
  if (/^Não consegui preparar o áudio:/.test(trimmed)) return trimmed.replace('Não consegui preparar o áudio:','Could not prepare audio:');
  if (/^Não consegui buscar a letra:/.test(trimmed)) return trimmed.replace('Não consegui buscar a letra:','Could not search for lyrics:');
  return source;
}
function translateUiNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest('script,style,textarea,[contenteditable="true"]') || parent.closest(userSuppliedText)) return;
  const previous = uiTextNodes.get(node);
  const source = previous && node.nodeValue === previous.output ? previous.source : node.nodeValue;
  if(!source.trim())return;
  const leading = source.match(/^\s*/)?.[0] || '', trailing = source.match(/\s*$/)?.[0] || '';
  const core = source.slice(leading.length, source.length - trailing.length);
  const output = translateUiCopy(core);
  const translated = `${leading}${output}${trailing}`;
  if (translated !== node.nodeValue) node.nodeValue = translated;
  uiTextNodes.set(node, {source, output:translated});
}
function translateUiElement(element) {
  if (!(element instanceof Element)) return;
  for (const attribute of uiAttributes) {
    if (!element.hasAttribute(attribute)) continue;
    let values = uiAttributeValues.get(element); if (!values) { values = new Map(); uiAttributeValues.set(element, values); }
    const currentValue = element.getAttribute(attribute), previous = values.get(attribute);
    const source = previous && currentValue === previous.output ? previous.source : currentValue;
    const output = translateUiCopy(source);
    if (output !== currentValue) element.setAttribute(attribute, output);
    values.set(attribute, {source, output});
  }
  for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) translateUiNode(node);
  for (const child of element.children) translateUiElement(child);
  if (element.matches('input,textarea,select')) return;
}
function translateUi(root = document.body) {
  if (!root) return;
  if (root instanceof Element) translateUiElement(root);
}
function setInterfaceLanguage(language) {
  interfaceLanguage = language === 'en-US' ? 'en-US' : 'pt-BR';
  try { localStorage.setItem('voxstage-language', interfaceLanguage); } catch {}
  document.documentElement.lang = interfaceLanguage;
  document.title = interfaceLanguage === 'en-US' ? 'VoxStage — your stage' : 'VoxStage — seu palco';
  const selector = $('interfaceLanguage'); if (selector) selector.value = interfaceLanguage;
  translateUi();
  if (typeof updateTrackViewButton === 'function') updateTrackViewButton();
  if (typeof updateManualSilenceControls === 'function') updateManualSilenceControls();
  if (typeof manualSyncState !== 'undefined' && manualSyncState && typeof updateSyncToolbar === 'function') updateSyncToolbar();
}
const uiTranslationObserver = new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'characterData') translateUiNode(record.target);
    else if (record.type === 'attributes') translateUiElement(record.target);
    else record.addedNodes.forEach(node => { if (node.nodeType === Node.ELEMENT_NODE) translateUi(node); else if (node.nodeType === Node.TEXT_NODE) translateUiNode(node); });
  }
});
uiTranslationObserver.observe(document.body, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:uiAttributes});
Object.assign(englishUiCopy, {
  'Marcar palavras da letra':'Mark words in lyrics','EDIÇÃO MANUAL':'MANUAL EDITING','Escolha as palavras':'Choose the words','Toque nas palavras que deseja marcar. Elas serão destacadas durante a reprodução e podem silenciar os vocais quando estiverem sincronizadas palavra por palavra.':'Tap the words you want to mark. They will be highlighted during playback and can mute vocals when synced word by word.','Salvar palavras':'Save words','Palavras':'Words','Sincronizar faixa':'Sync track','Vocal principal':'Lead vocals','Backing vocals':'Backing vocals','Escala das letras no celular':'Mobile lyric size','Escala das letras · vertical':'Lyric size · portrait','Escala das letras · TV/horizontal':'Lyric size · TV/landscape','Avanço rápido':'Seek interval','Escolha quanto os botões de voltar e avançar pulam na música.':'Choose how far the back and forward buttons jump.','5 segundos':'5 seconds','10 segundos':'10 seconds','15 segundos':'15 seconds','30 segundos':'30 seconds','Usar cor da capa atual':'Use current cover color','Cor RGB':'RGB color','Escolha as palavras manualmente na letra antes de tocar. Com o sync palavra por palavra, os vocais podem ser silenciados enquanto uma delas estiver ativa.':'Select words in the lyrics before playback. With word-by-word sync, vocals can be muted while a selected word is active.','Escolha as palavras manualmente no Sync antes de tocar. Com o sync palavra por palavra, os vocais podem ser silenciados enquanto uma delas estiver ativa.':'Select words manually in Sync before playback. With word-by-word sync, vocals can be muted while a selected word is active.','Marcar palavras escolhidas na letra':'Highlight selected lyric words','Borrar palavras escolhidas na letra':'Blur selected words in lyrics','Aplica desfoque às palavras que você selecionou.':'Blur the words you selected.','Afeta vocal principal e backing; o instrumental continua.':'Affects lead and backing vocals; the instrumental keeps playing.','Silenciar os vocais nessas palavras':'Mute vocals on selected words','Ajuste do tempo do mute':'Mute timing adjustment','Estes desvios são somados à sincronia atual. Zero mantém o comportamento existente; valores negativos adiantam e positivos atrasam.':'These offsets are added to the current timing. Zero keeps the existing behavior; negative moves earlier and positive moves later.','Início do mute':'Mute start','Fim do mute':'Mute end','− antes · + depois':'− earlier · + later','Desfazer último silêncio':'Undo last silence','Sync com Espaço: desligado':'Sync with Space: off','Sync com Espaço: ligado':'Sync with Space: on','Silêncio: desligado':'Silence: off'
});
setInterfaceLanguage(interfaceLanguage);
setAppTheme(interfaceTheme);
function resetSongForm() {
  uploadDrafts.delete(activeUploadDraftId);
  activeUploadDraftId = 'new';
  const remaining = uploadDrafts.get('new');
  chosenFiles = remaining?.files || []; editingSong = null; draftLyrics = remaining?.lyrics || null; picker.value = ''; $('titleInput').value = remaining?.title || ''; $('artistInput').value = remaining?.artist || ''; $('draftLyricsStatus').textContent = remaining?.lyricStatus || 'Opcional · você pode buscar pela internet';
  document.querySelector('.modal h2').textContent = 'Adicionar música'; $('saveSong').textContent = 'Salvar música'; drawAssignments();
}
try {
  const savedDrafts = JSON.parse(localStorage.getItem('voxstage-upload-drafts') || '[]');
  for (const draft of savedDrafts) if (draft?.id && Array.isArray(draft.files)) uploadDrafts.set(draft.id, draft);
  const saved = uploadDrafts.get('new');
  if (saved) {
    chosenFiles = saved.files; draftLyrics = saved.lyrics;
    $('titleInput').value = saved.title || ''; $('artistInput').value = saved.artist || '';
    $('draftLyricsStatus').textContent = saved.lyricStatus || 'Opcional · você pode buscar pela internet';
    drawAssignments();
  }
} catch (error) { console.warn('Não foi possível restaurar o rascunho.', error); }
['addTop', 'heroAdd'].forEach(id => $(id).onclick = () => { activateUploadDraft('new'); showModal(); });
['closeModal', 'cancelModal'].forEach(id => $(id).onclick = () => { captureUploadDraft(); hideModal(); });
$('cancelModal').textContent = 'Fechar';
['titleInput', 'artistInput'].forEach(id => $(id).addEventListener('input', captureUploadDraft));
const discardUploadDraft = document.createElement('button');
discardUploadDraft.id = 'discardUploadDraft'; discardUploadDraft.type = 'button';
discardUploadDraft.className = 'btn secondary small'; discardUploadDraft.textContent = 'Descartar rascunho';
discardUploadDraft.onclick = () => {
  const draft = captureUploadDraft();
  if (youtubeProcessing || videoDownloadBusy || draft.pendingAttachments || draft.saving) { toast('Aguarde a chegada dos arquivos antes de descartar o rascunho.'); return; }
  resetSongForm();
};
$('cancelModal').insertAdjacentElement('beforebegin', discardUploadDraft);
Object.assign(englishUiCopy, {'Descartar rascunho':'Discard draft','Aguarde a chegada dos arquivos antes de salvar a música.':'Wait for the files to arrive before saving the song.','Aguarde a chegada dos arquivos antes de descartar o rascunho.':'Wait for the files to arrive before discarding the draft.'});
const finalStyle = document.createElement('style');
finalStyle.textContent = `.settings-top{width:36px;height:36px;border-radius:10px;border:1px solid #343439;background:#1d1d20;color:#ddd;font-size:17px}.filter-btn.selected{background:#30331f;color:var(--lime);border-color:#59613a}.track-actions{display:flex;align-items:center;gap:5px}.action-icon{background:transparent;color:#aaa;padding:3px 5px;font-size:13px;border-radius:5px}.action-icon:hover{background:#303034;color:#fff}.action-icon.is-fav{color:var(--lime)}.delete-icon{font-size:17px}.hero{height:auto;min-height:218px}.hero-content{padding-bottom:28px}.corner-brand{padding:0!important}.corner-brand span:last-child{font-size:20px}.display-content{pointer-events:none}.display-bottom{z-index:5;pointer-events:auto}.hamb{z-index:20;pointer-events:auto}.backdrop-options{z-index:19;pointer-events:auto;max-height:calc(100vh - 95px);overflow:auto;width:min(280px,calc(100vw - 40px))}.backdrop-options *{pointer-events:auto}.fullscreen-volumes,.lyrics-controls{border-top:1px solid #36363b;margin-top:12px;padding-top:11px}.fullscreen-volumes b,.lyrics-controls b{display:block;color:#f3f3f3;font-size:11px;margin-bottom:8px}.fullscreen-volumes label{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:#bbb;margin:8px 0}.fullscreen-volumes input{width:120px;accent-color:var(--lime)}#lyricResults{background:#222226;color:#eee;border:1px solid #444;border-radius:7px;padding:7px;font-size:10px}#lyricStatus{display:block;margin-top:8px;color:#aaa;font-size:10px;line-height:1.4}.file-name:hover:after{content:none!important}`;
finalStyle.textContent += `.cover-image-ready .cover-letter{display:none}.cover-letter{position:relative;z-index:1}.cover-image{z-index:2}.track-actions{gap:8px}.track-menu-wrap{position:relative}.track-menu-toggle{width:28px;height:28px;padding:0;font-size:21px;line-height:1;border:1px solid transparent}.track-menu-toggle[aria-expanded=true],.track-menu-toggle:hover{background:#303034;border-color:#414148;color:var(--lime)}.track-menu{position:absolute;right:0;bottom:calc(100% + 7px);z-index:25;display:grid;gap:3px;min-width:148px;padding:5px;background:#1c1c20f5;border:1px solid #414148;border-radius:10px;box-shadow:0 10px 28px #000a;backdrop-filter:blur(12px)}.track-menu[hidden]{display:none!important}.track-menu button{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;background:transparent;color:#ddd;text-align:left;font-size:11px;white-space:nowrap}.track-menu button:hover{background:#30331f;color:var(--lime)}.track-menu button.menu-delete{color:#ffaaa8}.track-menu button.menu-delete:hover{background:#392222;color:#ffb2af}.track-menu button span{flex:1}`;
document.head.append(finalStyle);
const polishStyle = document.createElement('style');
polishStyle.textContent = `.cover{height:auto!important;aspect-ratio:1/1;min-height:0}.cover-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}.cover-image.wide-cover{object-fit:contain}.cover-letter{z-index:1}.player-select{max-width:86px;background:#222226;color:#eee;border:1px solid #36363b;border-radius:8px;padding:6px 7px;font-size:10px;outline:none}.player-select:focus{border-color:#b5e64e}.player-select option{background:#1b1b1e;color:#eee}.lyrics-dialog{position:fixed;inset:0;z-index:30;display:none;place-items:center;padding:20px;background:#08090bd9;backdrop-filter:blur(12px)}.lyrics-dialog.show{display:grid}.lyrics-dialog-card{width:min(590px,100%);max-height:84vh;overflow:auto;padding:24px;border-radius:20px;background:linear-gradient(145deg,#202124,#141416);border:1px solid #414148;box-shadow:0 24px 80px #000b}.lyrics-dialog-head{display:flex;justify-content:space-between;align-items:center}.lyrics-kicker{font-size:9px;letter-spacing:1.8px;color:var(--lime);font-weight:700}.lyrics-dialog-head h2{font:700 22px Manrope;margin:5px 0 0}.lyrics-close{background:#2b2b30;color:#ddd;border-radius:9px;width:34px;height:34px;font-size:20px}.lyrics-dialog-copy{color:#aaa;font-size:12px;line-height:1.5;margin:12px 0 16px}.lyrics-search-row{display:flex;gap:9px}.lyrics-search-row input{flex:1;min-width:0;background:#111113;color:#f6f5f3;border:1px solid #3d3d42;border-radius:10px;padding:11px 12px;outline:none}.lyrics-results{display:grid;gap:8px;margin-top:15px;max-height:40vh;overflow:auto}.lyrics-empty{padding:22px 14px;text-align:center;background:#161619;border:1px dashed #3a3a40;border-radius:12px;color:#929298;font-size:11px}.lyrics-result{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;text-align:left;background:#19191c;border:1px solid #333339;border-radius:11px;padding:11px 12px;color:#eee}.lyrics-result:hover{border-color:#859b43;background:#20221c}.lyrics-result-main{min-width:0}.lyrics-result-main strong,.lyrics-result-main small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lyrics-result-main strong{font-size:12px}.lyrics-result-main small{font-size:10px;color:#97979e;margin-top:4px}.lyrics-badge{align-self:start;border-radius:20px;padding:5px 8px;background:#302528;color:#ff9b9b;font-size:9px}.lyrics-badge.synced{background:#28301b;color:var(--lime)}.lyrics-use{grid-column:1/-1;text-align:right;color:#b9d773;font-size:10px}.lyrics-dialog-status{margin-top:13px;font-size:10px;color:#aaa;line-height:1.5}.upload-lyrics{display:flex;align-items:center;gap:10px;margin-top:9px}.upload-lyrics .btn{padding:8px 10px;font-size:10px}.upload-lyrics span{font-size:10px;color:#999}.display-bottom{z-index:5;pointer-events:auto}.lyrics.lyric-slide{animation:lyricSlide .38s cubic-bezier(.2,.75,.2,1)}@keyframes lyricSlide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@media(max-width:590px){.player-select{max-width:72px;padding:5px 4px}.cover{aspect-ratio:1/1}.lyrics-dialog{padding:12px}.lyrics-dialog-card{padding:18px}.upload-lyrics{align-items:flex-start;flex-direction:column}}`;
document.head.append(polishStyle);
const controlsStyle = document.createElement('style');
controlsStyle.textContent = `.display-bottom{left:14px;right:14px;bottom:12px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:8px;padding:10px 12px;background:#111c;border:1px solid #ffffff1a;border-radius:14px;backdrop-filter:blur(14px);z-index:12}.display-transport,.display-settings{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0}.display-transport>#dispSeek{flex:1;width:auto!important;min-width:80px;max-width:none}.display-time{display:flex;align-items:center;font-size:10px;color:#ccc;white-space:nowrap}.display-settings{flex-wrap:wrap}.fullscreen-volumes{display:flex;align-items:center;gap:8px;margin:0;padding:0;border:0}.hud-range{display:flex;align-items:center;gap:6px;color:#c7c7cc;font-size:10px;white-space:nowrap}.hud-range input{width:72px;accent-color:var(--lime)}.visual-settings{display:flex;align-items:center;gap:8px}.display-bottom .hud-btn{display:inline-flex;align-items:center;justify-content:center;height:34px;min-width:64px;padding:0 11px;background:#222226;color:#ddd;border:1px solid #36363b;border-radius:9px;font:600 11px 'DM Sans',sans-serif;text-decoration:none;box-shadow:none;transition:background .16s,border-color .16s,color .16s,transform .16s}.display-bottom .hud-btn:hover{background:#30331f;border-color:#59613a;color:var(--lime);transform:translateY(-1px)}.display-bottom #dispPlay,.display-bottom #previousDisplay,.display-bottom #nextDisplay{min-width:40px;width:40px;padding:0;font-size:14px}.display-bottom #openLyrics,.display-bottom #lyricSync,.display-bottom #closeDisplay{min-width:76px}.display-transport #closeDisplay{margin-left:0}@media(max-width:850px){.display-bottom{left:7px;right:7px;bottom:7px;padding:8px}.display-transport,.display-settings{flex-wrap:wrap;gap:6px}.display-transport>#dispSeek{flex-basis:100%;order:5}.fullscreen-volumes,.visual-settings{flex-wrap:wrap;justify-content:center}.display-content{padding-bottom:155px}}`;
controlsStyle.textContent += `.volume input[type=range],.hud-range input[type=range],#seek,#dispSeek{accent-color:var(--lime);height:4px}.hud-range input[type=range]{width:72px}.word-sync-toggle[aria-pressed=true]{border-color:#59613a!important;background:#30331f!important;color:var(--lime)!important}.now-lyric{display:block;max-width:min(38vw,340px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;color:#e5e5e8;font-size:9px;line-height:1.2;text-shadow:0 0 var(--lyrics-glow,22px) #fff8}.now-lyric[hidden]{display:none!important}.lyrics{text-shadow:0 3px 22px #000,0 0 var(--lyrics-glow,22px) #fff8!important}.volume,.hud-range{font-size:10px;color:#c7c7cc}.volume input[type=range],.hud-range input[type=range]{cursor:pointer}.waveform-row{position:relative;flex:none;width:100%;min-width:70px;height:20px;align-self:center;border-radius:6px;overflow:hidden}.waveform-canvas{display:block;width:100%;height:20px;pointer-events:none}.waveform-row #dispSeek{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.display-transport{min-height:34px}.display-transport .display-time{font-variant-numeric:tabular-nums}@media(max-width:850px){.waveform-row{order:0;flex:none;width:100%;min-width:100%;height:18px}.waveform-canvas{height:18px}.display-content{padding-bottom:175px}}`;
document.head.append(controlsStyle);
const processingStyle = document.createElement('style');
processingStyle.textContent = `.play-spinner{display:inline-block;width:14px;height:14px;border:2px solid #687044;border-top-color:var(--lime);border-radius:50%;animation:playSpin .72s linear infinite;vertical-align:middle}@keyframes playSpin{to{transform:rotate(360deg)}}button:disabled{cursor:wait;opacity:.9}`;
document.head.append(processingStyle);
const wordSyncStyle = document.createElement('style');
wordSyncStyle.textContent = `.lyric-current-line{display:inline}.lyrics .next{display:block}.lyric-pause{display:flex;align-items:center;justify-content:center;gap:.22em;height:.72em;color:var(--word-marker,#b5f34b)}.lyric-pause[hidden]{display:none!important}.lyric-pause.at-top,.lyric-pause.at-bottom{position:absolute;left:0;right:0;margin:0 auto;height:.8em}.lyric-pause.at-top{top:16vh}.lyric-pause.at-bottom{bottom:19vh}.lyric-pause i{width:.18em;height:.18em;border-radius:50%;background:currentColor;opacity:.35;animation:lyricPausePulse 1s ease-in-out infinite}.lyric-pause i:nth-child(2){animation-delay:.16s}.lyric-pause i:nth-child(3){animation-delay:.32s}@keyframes lyricPausePulse{0%,60%,100%{opacity:.28;transform:translateY(0) scale(.8)}30%{opacity:1;transform:translateY(-.12em) scale(1.2)}}.lyric-word{position:relative;display:inline-block;white-space:pre;opacity:.44;filter:brightness(.72);transition:opacity .16s ease,filter .16s ease,color .16s ease}.lyric-word.active{opacity:1;filter:brightness(1.25);color:#fff;text-shadow:0 0 20px #fff9}.lyric-word.active:before{content:'';position:absolute;width:.18em;height:.18em;left:50%;top:-.28em;transform:translateX(-50%);border-radius:50%;background:var(--word-marker,#b5f34b);box-shadow:0 0 .35em var(--word-marker,#b5f34b);animation:wordMarkerHop .58s cubic-bezier(.2,.75,.3,1)}@keyframes wordMarkerHop{0%{opacity:0;transform:translate(-50%,.22em) scale(.7)}35%{opacity:1;transform:translate(-50%,-.55em) scale(1.18)}62%{transform:translate(-50%,-.04em) scale(.96)}82%{transform:translate(-50%,-.25em) scale(1.04)}100%{opacity:1;transform:translate(-50%,0) scale(1)}}`;
document.head.append(wordSyncStyle);
const wordMarkerStyle = document.createElement('style');
wordMarkerStyle.textContent = `.lyric-word.active:before{content:none!important}.lyric-word-marker{position:absolute;z-index:3;width:0;height:0;pointer-events:none;transform:translate(-50%,-100%);transition:left .26s cubic-bezier(.2,.75,.25,1),top .26s cubic-bezier(.2,.75,.25,1)}.lyric-word-marker[hidden]{display:none!important}.lyric-word-marker i{display:block;width:10px;height:10px;border-radius:50%;background:var(--word-marker,#b5f34b);box-shadow:0 0 12px var(--word-marker,#b5f34b)}.lyric-word-marker.hopping i{animation:travelingWordHop .46s cubic-bezier(.2,.75,.25,1)}@keyframes travelingWordHop{0%{opacity:.65;transform:translateY(.16em) scale(.75)}32%{opacity:1;transform:translateY(-.9em) scale(1.2)}62%{transform:translateY(-.1em) scale(.94)}82%{transform:translateY(-.35em) scale(1.06)}100%{opacity:1;transform:translateY(0) scale(1)}}`;
document.head.append(wordMarkerStyle);
const layeredVocalStyle = document.createElement('style');
layeredVocalStyle.textContent = `.lyric-parallel-phrase,.lyric-word.parallel-vocal{color:var(--word-marker-secondary,#ff79c8)}.lyric-word.parallel-vocal.active{color:var(--word-marker-secondary,#ff79c8)!important;text-shadow:0 0 20px var(--word-marker-secondary,#ff79c8)!important}.lyric-word-marker.parallel{transform:translate(calc(-50% + 15px),calc(-100% - 3px))}.lyric-word-marker.parallel i{background:var(--word-marker-secondary,#ff79c8)!important;box-shadow:0 0 12px var(--word-marker-secondary,#ff79c8)!important}.lyric-word-marker.backing{transform:translate(calc(-50% + 9px),-100%)}.lyric-word-marker.backing i{background:#b9a0ff!important;box-shadow:0 0 12px #b9a0ff!important}.lyric-backing-line .backing-lyric-word.active{color:#b9a0ff!important;text-shadow:0 0 14px #b9a0ff!important}.lyric-word.parallel-vocal.upcoming{text-decoration-color:var(--word-marker-secondary,#ff79c8)!important}`;
layeredVocalStyle.textContent += `.lyric-word-marker.paired:not(.parallel){transform:translate(-50%,-100%)}.lyric-word-marker.paired:not(.parallel) i{background:linear-gradient(110deg,var(--word-marker) 10%,var(--word-marker-secondary) 90%)!important;box-shadow:0 0 8px var(--word-marker),0 0 12px var(--word-marker-secondary)!important}`;
layeredVocalStyle.textContent += `.lyric-second-line,.lyric-second-line .lyric-parallel-phrase{color:var(--word-marker-secondary,#ff79c8)}.lyric-second-line .second-lyric-word.active{color:var(--word-marker-secondary,#ff79c8)!important;text-shadow:0 0 14px var(--word-marker-secondary,#ff79c8)}.second-lyric-word.profanity{filter:blur(.34em)!important}.voice-color-preview{display:flex;justify-content:center;flex-wrap:wrap;gap:18px;padding:14px;font-weight:800;font-size:16px}.preview-voice1{color:var(--lyrics-active-color)}.preview-voice2,.preview-voices-together{color:var(--word-marker-secondary)}@supports ((background-clip:text) or (-webkit-background-clip:text)){.voice-overlap-gradient #lyrics.voices-merged #lyricCurrentLine .voices-active,.voice-overlap-gradient .preview-voices-together{background:linear-gradient(110deg,var(--lyrics-active-color) 10%,var(--word-marker-secondary) 90%);background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:transparent!important;text-shadow:none!important}}`;
layeredVocalStyle.textContent += `#lyrics.voices-merged #lyricCurrentLine .voice2-active:not(.voice1-active){color:var(--word-marker-secondary)!important;text-shadow:0 0 14px var(--word-marker-secondary)!important}@supports ((background-clip:text) or (-webkit-background-clip:text)){.voice-overlap-gradient #lyrics.voices-merged #lyricCurrentLine .active:not(.voices-active){background:none;-webkit-text-fill-color:currentColor;color:var(--lyrics-active-color)!important;text-shadow:0 0 20px var(--lyrics-active-color)!important}.voice-overlap-gradient #lyrics.voices-merged #lyricCurrentLine .voice2-active:not(.voice1-active){color:var(--word-marker-secondary)!important;text-shadow:0 0 14px var(--word-marker-secondary)!important}}`;

layeredVocalStyle.textContent += `#display .lyric-second-line{position:absolute;z-index:3;top:calc(74px + env(safe-area-inset-top));left:6%;right:6%;width:auto;max-width:1100px;margin:0 auto;max-height:24dvh;overflow:auto;scrollbar-width:none;text-align:center;text-wrap:balance;font:800 calc(clamp(22px,3.4vw,44px) * var(--lyrics-scale-tv,1))/1.25 Manrope,sans-serif;pointer-events:auto;text-shadow:0 2px 14px #0009;animation:none;transition:none}#display.score-lane-active .lyric-second-line{top:max(calc(74px + env(safe-area-inset-top)),var(--score-lane-space,0px))}#display .lyric-current-line.voice-ended{visibility:hidden}#display .lyric-second-line .lyric-voice-label{margin-bottom:7px}#display .lyric-second-line .second-lyric-word{display:inline-block;white-space:pre-wrap}#display .lyric-second-line .second-lyric-word:not(.active){opacity:.7}@media(orientation:portrait) and (max-width:600px){#display .lyric-second-line{left:7%;right:7%;font-size:calc(clamp(22px,6vw,32px) * var(--lyrics-scale-portrait,1));max-height:20dvh}}@media(orientation:landscape) and (max-height:550px){#display .lyric-second-line{top:52px;font-size:calc(clamp(20px,3vw,30px) * var(--lyrics-scale-tv,1));max-height:22dvh}.mobile-native-app #display .lyric-second-line{left:15%;right:15%}}`;
layeredVocalStyle.textContent += `@media(orientation:portrait){body.mobile-native-app #display.has-second-voice:not(.mobile-stage-tv):not(.sync-editing) .display-content{padding-top:calc(160px + env(safe-area-inset-top))!important}body.mobile-native-app #display.has-second-voice.score-lane-active:not(.mobile-stage-tv):not(.sync-editing) .display-content{padding-top:calc(var(--score-lane-space,100px) + 96px)!important}}@media(orientation:landscape){body.mobile-native-app #display.has-second-voice:not(.mobile-stage-tv):not(.sync-editing) .display-content{padding-top:110px!important}body.mobile-native-app #display.has-second-voice.score-lane-active:not(.mobile-stage-tv):not(.sync-editing) .display-content{padding-top:calc(var(--score-lane-space,70px) + 72px)!important}}`;
document.head.append(layeredVocalStyle);
const lyricPreviewStyle = document.createElement('style');
lyricPreviewStyle.textContent = `.lyric-word.upcoming,.second-lyric-word.upcoming,.backing-lyric-word.upcoming{opacity:.8!important;filter:brightness(1.08)!important;color:#d9e7b1!important;text-decoration:underline;text-decoration-color:var(--word-marker,#b5f34b);text-decoration-thickness:.055em;text-underline-offset:.16em}.second-lyric-word.upcoming{color:var(--word-marker-secondary)!important;text-decoration-color:var(--word-marker-secondary)}.backing-lyric-word.upcoming{color:#b9a0ff!important;text-decoration-color:#b9a0ff}.lyrics .next{color:#ffffff85;filter:brightness(1.08)}.manual-sync-current .manual-sync-target{display:block;line-height:1.3}.manual-sync-current .manual-sync-upcoming{display:flex;flex-direction:column;gap:2px;margin-top:4px;color:#d7e7a9;font:600 clamp(12px,1.5vw,16px)/1.35 'DM Sans',sans-serif}.manual-sync-current .manual-sync-upcoming small{color:#a8bf6b;font-size:8px;font-weight:800;letter-spacing:1px}.manual-sync-current .manual-sync-context{font-size:8px;letter-spacing:1px}`;
document.head.append(lyricPreviewStyle);
const displayVideoBackground = document.createElement('video');
displayVideoBackground.id = 'displayVideoBg'; displayVideoBackground.className = 'display-video-bg';
displayVideoBackground.setAttribute('muted',''); displayVideoBackground.muted = true; displayVideoBackground.defaultMuted = true;
displayVideoBackground.setAttribute('playsinline',''); displayVideoBackground.setAttribute('loop',''); displayVideoBackground.preload = 'auto';
$('display').insertBefore(displayVideoBackground, $('display').children[1] || null);
const displayVideoStyle = document.createElement('style');
displayVideoStyle.textContent = `.display-video-bg{position:absolute;z-index:1;inset:0;width:100%;height:100%;object-fit:cover;opacity:.62;pointer-events:none;display:none}.display-video-bg.active{display:block}.display-content{z-index:2}.display-hud,.display-bottom,.hamb,.backdrop-options{z-index:5}`;
document.head.append(displayVideoStyle);
function syncMutedVideoBackground(){
  const video=$('displayVideoBg'); if(!video)return;
  video.muted=true; video.defaultMuted=true; video.volume=0;
  video.playbackRate = current?.engine?.speed || playbackSpeed;
  if(video.getAttribute('src') && video.classList.contains('active') && $('display').classList.contains('show')) {
    const source = video.getAttribute('src');
    video.play().catch(error => { if (error.name !== 'AbortError' && source === video.getAttribute('src') && $('display').classList.contains('show')) useAndroidVideoFallback(); });
    if (mobileNative && video.readyState < 3 && !androidVideoWaitTimer) {
      androidVideoWaitTimer = setTimeout(() => { androidVideoWaitTimer = 0; if (source === video.getAttribute('src') && $('display').classList.contains('show') && video.readyState < 3) useAndroidVideoFallback(); }, 8000);
    }
  } else video.pause();
}
function useAndroidVideoFallback() {
  if (!mobileNative) return;
  const video = $('displayVideoBg'); if (!video || !video.classList.contains('active')) return;
  video.pause(); video.classList.remove('active');
  const image = current?.cover || current?.background;
  $('displayBg').style.backgroundImage = image ? `url("${mediaUrl(image)}")` : '';
  $('displayBg').style.opacity = image ? '.78' : '.5';
}
let androidVideoWaitTimer = 0;
$('displayVideoBg').addEventListener('error', useAndroidVideoFallback);
$('displayVideoBg').addEventListener('waiting', () => {
  if (!mobileNative) return;
  clearTimeout(androidVideoWaitTimer); androidVideoWaitTimer = 0;
  const source = $('displayVideoBg').getAttribute('src');
  androidVideoWaitTimer = setTimeout(() => { if (source === $('displayVideoBg').getAttribute('src') && $('display').classList.contains('show')) useAndroidVideoFallback(); }, 8000);
});
for (const type of ['playing', 'emptied', 'pause']) $('displayVideoBg').addEventListener(type, () => { clearTimeout(androidVideoWaitTimer); androidVideoWaitTimer = 0; });
new MutationObserver(syncMutedVideoBackground).observe($('display'),{attributes:true,attributeFilter:['class']});
waveformResizeObserver = new ResizeObserver(() => drawWaveform());
waveformResizeObserver.observe(waveformCanvas);
const deviceLayoutStyle = document.createElement('style');
deviceLayoutStyle.textContent = `
  #lyrics:empty{display:none!important}
  .mobile-native-app .mobile-controls-toggle{display:grid!important;place-items:center;position:absolute;z-index:30;top:calc(env(safe-area-inset-top) + 58px);left:12px;width:42px;height:40px;min-width:42px;padding:0;border:1px solid #ffffff35;border-radius:13px;background:#17181dcc;color:#eee;backdrop-filter:blur(14px);box-shadow:0 5px 22px #0008;transform:none}
  .mobile-native-app .display-bottom .mobile-controls-toggle{display:none!important}
  .mobile-native-app .display.mobile-controls-hidden .display-bottom{left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));width:auto;height:auto;max-height:none;overflow:hidden;transform:none;padding:0;border:0;background:transparent;box-shadow:none;visibility:hidden;opacity:0;pointer-events:none}
  .mobile-native-app .display.mobile-controls-hidden .display-bottom>*{visibility:hidden}
  .mobile-native-app .display.mobile-controls-hidden .display-content{padding-bottom:calc(40px + env(safe-area-inset-bottom))!important}
  .mobile-native-app .display:not(.mobile-controls-hidden) .display-content{padding-bottom:calc(205px + env(safe-area-inset-bottom))!important}
  .mobile-native-app .display-bottom{max-height:28dvh!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain}
  .mobile-native-app .waveform-row,.mobile-native-app .waveform-canvas{height:24px!important}
  .mobile-native-app .display-settings{max-height:43px!important;min-height:38px;overflow-x:auto!important;overflow-y:hidden!important;justify-content:flex-start!important;flex-wrap:nowrap!important;scrollbar-width:none;touch-action:pan-x}
  .mobile-native-app .display-settings::-webkit-scrollbar{display:none}
  .mobile-native-app .display-settings .fullscreen-volumes{flex-wrap:nowrap!important;gap:10px!important}
  .mobile-native-app .display-settings .hud-range{gap:4px;font-size:10px!important}
  .mobile-native-app .display-settings .hud-range input{width:clamp(48px,14vw,74px)!important;min-width:48px}
  .mobile-native-app .display-content .lyrics{pointer-events:auto;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  
  
  
  
  
  
  
  
  
  
  @media(max-width:390px){}
  @media(orientation:landscape){.mobile-native-app .display:not(.mobile-stage-tv):not(.mobile-controls-hidden) .display-content{padding-bottom:calc(158px + env(safe-area-inset-bottom))!important}.mobile-native-app .display-bottom{max-height:38dvh!important}}
  @media(min-width:760px){.mobile-native-app .main{max-width:940px;padding-left:clamp(24px,5vw,60px);padding-right:clamp(24px,5vw,60px)}.mobile-native-app .grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
document.head.append(deviceLayoutStyle);
const topbarCrumb = document.querySelector('.crumb');
if (topbarCrumb) topbarCrumb.outerHTML = '<div class="brand corner-brand"><div class="brand-mark vx-brand-mark" aria-hidden="true"><span>V<i>·</i>X</span></div><span>vox<em>stage</em></span></div>';
// Os nomes completos usam o tooltip nativo do navegador via atributo title.
['Inst', 'Lead', 'Back'].forEach(key => $(`vol${key}`).oninput = event => updateVolume(key, event.target.value));

// Shared modal layering and the mobile stage layout have one final stylesheet.
const mobileRevisionStyles = document.createElement('link');
mobileRevisionStyles.rel = 'stylesheet'; mobileRevisionStyles.href = 'mobile-stage.css?v=2.0.0-stage-controls';
document.head.append(mobileRevisionStyles);
const finalBrandAndScaleStyles = document.createElement('style');
finalBrandAndScaleStyles.textContent = `.vx-brand-mark{display:grid;place-items:center;background:#17191a!important;color:#d4fb69!important;border:1px solid #d4fb6944;box-shadow:inset 0 0 0 1px #ffffff08}.vx-brand-mark>span{font:900 12px/1 Manrope,sans-serif;letter-spacing:-1.2px}.vx-brand-mark i{font-style:normal;color:#d4fb69;font-size:17px;vertical-align:-1px;margin:0 -1px}.profanity-picker-dialog{z-index:60}.lyric-backing-line{pointer-events:none}.playback-icon{display:block;width:24px;height:24px;flex:none}.player .controls button .playback-icon{width:22px;height:22px}`;
document.head.append(finalBrandAndScaleStyles);
// One vector mark for both logo formats. The bouncing lyric dot sits above VX.
const voxstageMark = "<svg viewBox=\"10 3 90 86\" aria-hidden=\"true\" focusable=\"false\"><g transform=\"translate(-3.5 -12)\"><style>.vx-static{display:none}@media(prefers-reduced-motion:reduce){.vx-motion{display:none}.vx-static{display:block}}</style><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M26 49L39 78L52 49\"/><path d=\"M66 49L84 78M84 49L66 78\"/></g><g class=\"vx-static\"><g fill=\"currentColor\"><circle cx=\"54\" cy=\"24\" r=\"1.8\" opacity=\".2\"/><circle cx=\"61\" cy=\"24\" r=\"2.3\" opacity=\".4\"/><circle cx=\"68\" cy=\"28\" r=\"2.8\" opacity=\".65\"/><circle cx=\"75\" cy=\"35\" r=\"4.5\"/></g></g><g class=\"vx-motion\"><g fill=\"currentColor\" opacity=\"0.16\"><circle r=\"1.8\"/><animateMotion path=\"M39 35Q57 5 75 35Q57 5 39 35\" dur=\"2.6s\" begin=\"-2.39s\" repeatCount=\"indefinite\" calcMode=\"spline\" keyPoints=\"0;.5;.5;1;1\" keyTimes=\"0;.38;.5;.88;1\" keySplines=\".3 0 .4 1;0 0 1 1;.3 0 .4 1;0 0 1 1\"/></g><g fill=\"currentColor\" opacity=\"0.3\"><circle r=\"2.3\"/><animateMotion path=\"M39 35Q57 5 75 35Q57 5 39 35\" dur=\"2.6s\" begin=\"-2.46s\" repeatCount=\"indefinite\" calcMode=\"spline\" keyPoints=\"0;.5;.5;1;1\" keyTimes=\"0;.38;.5;.88;1\" keySplines=\".3 0 .4 1;0 0 1 1;.3 0 .4 1;0 0 1 1\"/></g><g fill=\"currentColor\" opacity=\"0.5\"><circle r=\"2.8\"/><animateMotion path=\"M39 35Q57 5 75 35Q57 5 39 35\" dur=\"2.6s\" begin=\"-2.53s\" repeatCount=\"indefinite\" calcMode=\"spline\" keyPoints=\"0;.5;.5;1;1\" keyTimes=\"0;.38;.5;.88;1\" keySplines=\".3 0 .4 1;0 0 1 1;.3 0 .4 1;0 0 1 1\"/></g><g fill=\"currentColor\" opacity=\"1\"><circle r=\"4.5\"/><animateMotion path=\"M39 35Q57 5 75 35Q57 5 39 35\" dur=\"2.6s\" begin=\"0s\" repeatCount=\"indefinite\" calcMode=\"spline\" keyPoints=\"0;.5;.5;1;1\" keyTimes=\"0;.38;.5;.88;1\" keySplines=\".3 0 .4 1;0 0 1 1;.3 0 .4 1;0 0 1 1\"/></g></g></g></svg>";
const voxstageWordmark = "<span class=\"vx-wordmark-text\">vox<em>stage</em></span>";
document.querySelectorAll('.brand-mark').forEach(mark => {
  mark.classList.add('vx-brand-mark'); mark.innerHTML = voxstageMark;
});
document.querySelectorAll('.corner-brand').forEach(brand => {
  brand.setAttribute('aria-label', 'VoxStage');
  const name = brand.querySelector(':scope > span');
  if (name) { name.classList.add('brand-wordmark'); name.innerHTML = voxstageWordmark; }
});
const responsiveBrandStyle = document.createElement('style');
responsiveBrandStyle.textContent = `.topbar{gap:12px;min-width:0}.corner-brand{min-width:0;max-width:100%;gap:9px;flex:0 1 auto;overflow:hidden}.vx-brand-mark{flex:0 0 36px;width:36px!important;height:36px!important;overflow:hidden;color:var(--lime)!important}.vx-brand-mark svg{display:block;width:100%;height:100%;padding:2px}.brand-wordmark{display:block;min-width:0;white-space:nowrap;line-height:1.15;letter-spacing:-.7px}.topbar>.settings-top{flex:none}.mobile-native-app .corner-brand{max-width:calc(100% - 58px)}.mobile-native-app .corner-brand .brand-wordmark{font-size:clamp(18px,5vw,22px)!important}.mobile-native-app .corner-brand .vx-brand-mark{flex-basis:34px;width:34px!important;height:34px!important}@media(max-width:280px){.corner-brand .brand-wordmark{display:none}}.hero:after{content:'VX';font-family:Manrope,sans-serif;font-size:170px;letter-spacing:-18px;top:0;right:8%;transform:rotate(-8deg)}`;
document.head.append(responsiveBrandStyle);
const wordmarkStyle = document.createElement('style');
wordmarkStyle.textContent = `@font-face{font-family:VoxStageNunito;src:url('fonts/Nunito-Variable.ttf') format('truetype');font-weight:200 1000;font-style:normal;font-display:swap}.corner-brand .brand-wordmark{max-width:100%;flex:0 1 auto}.corner-brand .vx-wordmark-text{font-family:VoxStageNunito,sans-serif!important;font-weight:900;letter-spacing:.1px!important;font-size:28px;line-height:1.2;white-space:nowrap}.mobile-native-app .corner-brand .vx-wordmark-text{font-size:26px}`;
document.head.append(wordmarkStyle);
if (mobileNative) {
  const stageLayoutObserver = new ResizeObserver(() => {
    $('display').style.setProperty('--controls-height', `${document.querySelector('.display-bottom').getBoundingClientRect().height + 20}px`);
    $('display').style.setProperty('--sync-height', `${syncToolbar.hidden ? 0 : syncToolbar.getBoundingClientRect().height}px`);
  });
  stageLayoutObserver.observe(document.querySelector('.display-bottom')); stageLayoutObserver.observe(syncToolbar);
}
window.__voxstageUiReady = true;

async function runMvsepSeparation(songId) {
  if (youtubeProcessing) { toast('Aguarde a separação em andamento.'); return; }
  await loadMvsepConfiguration();
  if (!mvsepConfigured) { openProcessingSettings(); selectSettingsTab('cloud'); toast('Salve sua chave MVSEP para separar a música.'); return; }
  const song = songs.find(song => song.id === songId);
  if (!song?.source || song.lead) return;
  editSong(songId);
  const draft = captureUploadDraft();
  if (draft.saving || draft.pendingAttachments) return;
  youtubeProcessing = true; $('youtubeSearch').disabled = true;
  prepareReceiptSound();
  try {
    const modelId = String(processingSettings.mvsepModelId || '12');
    const started = await api('/api/mvsep/separations', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({songId,modelId,modelOptions:processingSettings.mvsepOptionsByModel?.[modelId] || {}})});
    const pending = {...started, draftId:draft.id, songId, source:song.source, title:song.title, artist:song.artist};
    try { localStorage.setItem('voxstage-active-mvsep-job', JSON.stringify(pending)); } catch {}
    updateUploadActivity(pending);
    await followYoutubeSeparation(pending, song);
  } catch (error) { if(uploadActivityJob&&!uploadActivityJob.finished)updateUploadActivity(uploadActivityJob,true,error.message); showYoutubeError(error); toast(error.message); }
  finally { youtubeProcessing = false; $('youtubeSearch').disabled = false; }
}

function updateSongVolumeControls(song) {
  const complete = Boolean(song?.source && !song.lead && !song.back);
  document.body.classList.toggle('complete-song', complete);
  for (const key of ['Inst','Lead','Back']) {
    for (const input of [$(`vol${key}`), document.querySelector(`[data-full-volume="${key}"]`)]) {
      const label = input?.closest('label'); if (!label) continue;
      label.hidden = complete && key !== 'Inst';
      if (key === 'Inst') {
        const text = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
        if (text) text.textContent = complete ? 'Volume ' : 'Instrumental ';
      }
    }
  }
}

const filenameDialog = document.createElement('div');
filenameDialog.className = 'filename-dialog'; filenameDialog.hidden = true;
filenameDialog.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="filenameTitle"><header><h2 id="filenameTitle">${interfaceLanguage === 'en-US' ? 'Full file name' : 'Nome completo do arquivo'}</h2><button class="lyrics-close" type="button" aria-label="Fechar">×</button></header><p id="fullFilename"></p></section>`;
document.body.append(filenameDialog);
let filenameOrigin = null;
function showFullFilename(item, origin) {
  if (!item) return;
  filenameOrigin = origin;
  $('fullFilename').textContent = item.label || item.file?.name || item.name || '';
  filenameDialog.hidden = false; filenameDialog.querySelector('button').focus();
}
function closeFilenameDialog() { filenameDialog.hidden = true; filenameOrigin?.focus(); }
filenameDialog.querySelector('button').onclick = closeFilenameDialog;
filenameDialog.onclick = event => { if (event.target === filenameDialog) closeFilenameDialog(); };
filenameDialog.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeFilenameDialog(); } else if (event.key === 'Tab') { event.preventDefault(); filenameDialog.querySelector('button').focus(); } };

const mvsepHelpDialog = document.createElement('div');
mvsepHelpDialog.className = 'mvsep-help-dialog'; mvsepHelpDialog.hidden = true;
const helpEnglish = interfaceLanguage === 'en-US';
mvsepHelpDialog.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="mvsepHelpTitle"><header><h2 id="mvsepHelpTitle">${helpEnglish ? 'How to get an MVSEP key' : 'Como obter uma chave MVSEP'}</h2><button class="lyrics-close" type="button" aria-label="Fechar">×</button></header><ol><li>${helpEnglish ? 'Open the official MVSEP website and create an account or log in.' : 'Abra o site oficial do MVSEP e crie uma conta ou faça login.'}</li><li>${helpEnglish ? 'Open the API page while logged in and copy your API token.' : 'Abra a página API com a conta conectada e copie seu API token.'}</li><li>${helpEnglish ? 'Return to VoxStage, paste the key and tap Save key. You can also save it in Settings → Cloud.' : 'Volte ao VoxStage, cole a chave e toque em Salvar chave. Você também pode salvá-la em Configurações → Nuvem.'}</li><li>${helpEnglish ? 'To use it on Google TV, scan the TV QR on your phone and choose Send key to TV.' : 'Para usar na Google TV, leia o QR da TV no celular e escolha Enviar chave para a TV.'}</li></ol><a class="btn" href="https://mvsep.com/${helpEnglish ? 'en' : 'pt'}/full_api" target="_blank" rel="noopener noreferrer">${helpEnglish ? 'Open MVSEP API page' : 'Abrir página API do MVSEP'}</a></section>`;
document.body.append(mvsepHelpDialog);
mvsepHelpDialog.querySelector('a').onclick = event => {
  if (mobileNative && typeof window.VoxStageMedia?.openMvsepApi === 'function') { event.preventDefault(); window.VoxStageMedia.openMvsepApi(); }
};
let helpOrigin = null;
function showMvsepKeyHelp() { helpOrigin = document.activeElement; mvsepHelpDialog.hidden = false; mvsepHelpDialog.querySelector('button').focus(); }
function closeMvsepKeyHelp() { mvsepHelpDialog.hidden = true; helpOrigin?.focus(); }
mvsepHelpDialog.querySelector('button').onclick = closeMvsepKeyHelp;
mvsepHelpDialog.onclick = event => { if (event.target === mvsepHelpDialog) closeMvsepKeyHelp(); };
mvsepHelpDialog.onkeydown = event => {
  if (event.key === 'Escape') { event.stopPropagation(); closeMvsepKeyHelp(); }
  if (event.key === 'Tab') {
    const controls = [...mvsepHelpDialog.querySelectorAll('button,a')];
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
};
const mvsepHelpButton = document.createElement('button'); mvsepHelpButton.className = 'btn secondary'; mvsepHelpButton.type = 'button';
mvsepHelpButton.textContent = helpEnglish ? 'How to get an MVSEP key' : 'Como obter uma chave MVSEP'; mvsepHelpButton.onclick = showMvsepKeyHelp;
mvsepKeySection.append(mvsepHelpButton);

const releaseStyle = document.createElement('style');
releaseStyle.textContent = `.complete-song label[hidden]{display:none!important}.complete-song .fullscreen-volumes{grid-template-columns:1fr!important}.filename-dialog,.mvsep-help-dialog{position:fixed;inset:0;z-index:260;display:grid;place-items:center;padding:18px;background:#08090bdf;backdrop-filter:blur(10px)}.filename-dialog[hidden],.mvsep-help-dialog[hidden]{display:none!important}.filename-dialog section,.mvsep-help-dialog section{box-sizing:border-box;width:min(580px,100%);max-height:85dvh;overflow:auto;padding:20px;border:1px solid #414148;border-radius:18px;background:#1b1c21}.filename-dialog header,.mvsep-help-dialog header{display:flex;justify-content:space-between;align-items:center;gap:12px}.filename-dialog h2,.mvsep-help-dialog h2{font-size:18px;margin:0}.filename-dialog p{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font-size:16px;line-height:1.6}.mvsep-help-dialog li{margin-bottom:12px;line-height:1.5}.mobile-native-app .file-name[role=button]{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}#tvKeyTransfer p,#tvMvsepKeyStatus{display:block;font-size:12px;line-height:1.5;overflow-wrap:anywhere}#tvKeyTransfer[hidden]{display:none!important}#tvKeyTransfer .btn{margin:8px 0}body:not(.mobile-native-app) #mobileControlsToggle{position:absolute;display:grid;place-items:center;z-index:30;top:18px;left:18px;width:44px;height:40px;background:#17181dcc;border-radius:12px}body:not(.mobile-native-app) #display.mobile-controls-hidden :is(.display-bottom,.display-hud,.hamb,.backdrop-options){visibility:hidden;opacity:0;pointer-events:none}body:not(.mobile-native-app) #display.mobile-controls-hidden .display-content{padding-bottom:40px}`;
document.head.append(releaseStyle);
releaseStyle.textContent += `.quick-exit-display{position:absolute!important;z-index:31!important;top:18px!important;left:70px!important;display:grid!important;place-items:center;width:44px!important;height:40px!important;min-width:44px!important;padding:0!important;border:1px solid #ffffff35!important;border-radius:12px!important;background:#17181dcc!important;color:#eee!important;font-size:22px!important}.mobile-native-app .quick-exit-display{top:calc(env(safe-area-inset-top) + 58px)!important;left:62px!important;width:42px!important;height:40px!important;min-width:42px!important;border-radius:13px!important}.profanity-picker-dialog{z-index:2147483646!important}`;
if (!mobileNative) {
  let stageIdleTimer = 0;
  const controlSelector = '.display-bottom,.display-hud,#mobileControlsToggle,#quickExitDisplay,.hamb,.backdrop-options,#syncToolbar';
  const scheduleStageIdle = () => {
    clearTimeout(stageIdleTimer);
    if (!display.classList.contains('show') || display.classList.contains('sync-editing') || manualSyncDialog.classList.contains('show')) return;
    stageIdleTimer = setTimeout(() => {
      const hovered = [...display.querySelectorAll(controlSelector)].some(node => node.matches(':hover') && node.getClientRects().length);
      if (!hovered && !display.classList.contains('sync-editing') && !manualSyncDialog.classList.contains('show')) setStageControlsHidden(true);
    }, 5000);
  };
  window.addEventListener('pointermove', event => { if (event.pointerType === 'mouse') { setStageControlsHidden(false); scheduleStageIdle(); } }, {passive:true});
  display.addEventListener('pointerout', scheduleStageIdle);
  window.addEventListener('keydown', () => { setStageControlsHidden(false); scheduleStageIdle(); }, {passive:true});
  window.addEventListener('keydown', async event => {
    if (event.key === 'F11') {
      event.preventDefault();
      if (window.__TAURI__?.core?.invoke) {
        try {
          const isFs = await window.__TAURI__.core.invoke('plugin:window|is_fullscreen', { label: 'main' });
          await window.__TAURI__.core.invoke('plugin:window|set_fullscreen', { label: 'main', value: !isFs });
        } catch (e) {
          console.warn('Native fullscreen error:', e);
        }
      }
    }
  });
  new MutationObserver(() => {
    if (!display.classList.contains('show')) { clearTimeout(stageIdleTimer); setStageControlsHidden(false); }
    else scheduleStageIdle();
  }).observe(display, {attributes:true,attributeFilter:['class']});
}

function updatePlaybackTransformControls() {
  document.querySelectorAll('.playback-transform').forEach(panel => {
    const speed = panel.querySelector('[data-playback-speed]'); speed.value = playbackSpeed;
    panel.querySelector('output').textContent = `${playbackSpeed.toFixed(2)}×`;
    panel.querySelector('[data-playback-pitch]').value = playbackSemitones;
    const speedButton = panel.querySelector('[data-speed-open]');
    const pitchButton = panel.querySelector('[data-pitch-open]');
    if (speedButton) speedButton.textContent = `${playbackSpeed.toFixed(2)}× · Tom ${playbackSemitones > 0 ? '+' : ''}${playbackSemitones}`;
    if (pitchButton) pitchButton.textContent = `Tom ${playbackSemitones > 0 ? '+' : ''}${playbackSemitones}`;
  });
  const video = $('displayVideoBg'); if (video) video.playbackRate = current?.engine?.speed || playbackSpeed;
}
for (const target of [settingsRow, $('settingsPaneDebug')]) {
  if (!target) continue;
  const panel = document.createElement('div'); panel.className = 'playback-transform';
  panel.innerHTML = `<label>Velocidade <output>1.00×</output><input type="range" min="0.75" max="1.25" step="0.05" value="1" data-playback-speed aria-label="Velocidade"></label><label>Tom<select data-playback-pitch aria-label="Tom em semitons">${Array.from({length:9},(_,index)=>index-4).map(value=>`<option value="${value}" ${value===0?'selected':''}>${value===0?'Original':`${value>0?'+':''}${value} semitons`}</option>`).join('')}</select></label><button type="button" class="btn secondary">Restaurar</button>`;
  panel.querySelector('[data-playback-speed]').oninput = event => { panel.querySelector('output').textContent = `${Number(event.target.value).toFixed(2)}×`; };
  panel.querySelector('[data-playback-speed]').onchange = event => { void setPlaybackTransform(Number(event.target.value), playbackSemitones); };
  panel.querySelector('[data-playback-pitch]').onchange = event => { void setPlaybackTransform(playbackSpeed, Number(event.target.value)); };
  panel.querySelector('button').onclick = () => { void setPlaybackTransform(1, 0); };
  if (target === settingsRow) {
    panel.classList.add('playback-transform-compact');
    const popup = document.createElement('div'); popup.id = 'playbackTransformPopup'; popup.className = 'playback-transform-popup'; popup.setAttribute('popover', 'auto');
    while (panel.firstChild) popup.append(panel.firstChild);
    const speedButton = document.createElement('button'); speedButton.type = 'button'; speedButton.className = 'hud-btn'; speedButton.dataset.speedOpen = '';
    speedButton.textContent = '1.00× · Tom 0'; speedButton.title = 'Ajustar velocidade e tom'; speedButton.setAttribute('aria-label', 'Ajustar velocidade e tom');
    for (const button of [speedButton]) {
      button.setAttribute('popovertarget', popup.id); button.setAttribute('popovertargetaction', 'toggle');
      button.onclick = () => {
      if (mobileNative && displayBottom.classList.contains('mix-open')) $('mobileMixToggle').click();
      positionPopup();
      if (!popup.togglePopover) popup.classList.toggle('popup-fallback-open');
      };
    };
    panel.append(speedButton, popup);
    const popupOpen = () => popup.classList.contains('popup-fallback-open') || (Boolean(popup.showPopover) && popup.matches(':popover-open'));
    const closePopup = () => { if (popup.showPopover && popup.matches(':popover-open')) popup.hidePopover(); popup.classList.remove('popup-fallback-open'); };
    function positionPopup() {
      const rect = speedButton.getBoundingClientRect(), anchor = displayBottom.getBoundingClientRect();
      const width = Math.min(270, innerWidth - 16);
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
      popup.style.bottom = `${Math.max(8, innerHeight - anchor.top + 12)}px`;
      popup.style.maxHeight = `${Math.max(0, anchor.top - 20)}px`;
      popup.style.overflowY = 'auto';
    }
    window.addEventListener('resize', () => { if (popupOpen()) positionPopup(); });
    window.visualViewport?.addEventListener('resize', () => { if (popupOpen()) positionPopup(); });
    new MutationObserver(() => {
      if (!display.classList.contains('show') || display.classList.contains('mobile-controls-hidden')) closePopup();
      else if (popupOpen()) positionPopup();
    }).observe(display, {attributes:true,attributeFilter:['class']});
    $('mobileMixToggle')?.addEventListener('click', closePopup);
    document.addEventListener('click', event => { if (!popup.togglePopover && !panel.contains(event.target)) closePopup(); });
  }
  if (target === settingsRow) (stagePerformanceTools || transportRow).append(panel); else target.append(panel);
}
const playbackTransformStyle = document.createElement('style');
playbackTransformStyle.textContent = `.playback-transform{display:grid;grid-template-columns:minmax(100px,1fr) minmax(115px,1fr) auto;gap:10px;align-items:end;width:100%;padding:10px;border:1px solid #ffffff25;border-radius:10px;background:#1118}.playback-transform label{display:grid;gap:5px;font-size:11px;color:#ddd}.playback-transform output{float:right;font-variant-numeric:tabular-nums}.playback-transform select{width:100%;min-height:34px;background:#202126;color:#eee;border:1px solid #444;border-radius:6px;padding:5px}.playback-transform button{font-size:10px;min-height:34px}.display-settings{flex-wrap:wrap!important}.display-settings .playback-transform{flex:1 0 100%;grid-column:1/-1}@media(max-width:420px){.playback-transform{grid-template-columns:1fr 1fr}.playback-transform button{grid-column:1/-1}}`;
document.head.append(playbackTransformStyle);
const compactPlaybackStyle = document.createElement('style');
compactPlaybackStyle.textContent = `.display .playback-transform-compact{display:flex!important;flex:0 0 auto!important;grid-column:auto;width:auto;padding:0;border:0;background:none;gap:5px;align-items:center}.playback-transform-compact>button{min-height:28px!important;height:28px;padding:4px 9px!important;font-size:10px;white-space:nowrap}.playback-transform-popup{display:none;position:fixed;inset:auto;margin:0;width:270px;padding:12px;border:1px solid #555;border-radius:11px;background:#202126;color:#eee;box-shadow:0 10px 40px #0009;z-index:10030}.playback-transform-popup:popover-open,.playback-transform-popup.popup-fallback-open{display:grid;grid-template-columns:1fr;gap:10px}.playback-transform-popup label{display:grid;gap:5px;font-size:11px}.playback-transform-popup input{width:100%;accent-color:var(--lime)}.playback-transform-popup select{width:100%;min-height:28px;font-size:11px}.playback-transform-popup button{min-height:26px!important;padding:4px 8px!important;font-size:10px}.playback-transform-popup::backdrop{background:transparent}`;
document.head.append(compactPlaybackStyle);
Object.assign(englishUiCopy, {'Velocidade':'Speed','Tom':'Pitch','Original':'Original','Restaurar':'Reset'});

// Playback boundary shared by local and phone microphone scoring.
window.VoxStageScoreHost = {
  mobile: presentationDevice!=='pc',
  tv:presentationDevice==='tv', api, connectPhone:showRemotePanel,
  state: () => ({song:current, context:audioContext, playing, position:playbackPosition(),
    base:playbackBase, startTime:playbackStartContextTime, token:playbackToken,
    speed:current?.engine?.speed || 1, transpose:current?.engine?.processor ? playbackSemitones : 0,
    latency:current?.engine?.latencySeconds || 0, manualSync:Boolean(manualSyncState)}),
  ensureAudio:ensureAudioEngine, pause:pausePlayback,
  resume:() => { if (current?.buffers?.Inst) startAudioSources(playbackBase >= current.buffers.Inst.duration ? 0 : playbackBase); },
  restart:() => { if (current?.buffers?.Inst) startAudioSources(0); },
  lyricCues: (from, to) => {
    if (!current) return [];
    const result = [], lines = current.lyricLines || [];
    lines.forEach((line, lineIndex) => {
      const backing = isBackingLyric(line.text), parallel=line.source==='parallel', entries = lyricWordEntries(line.text);
      const adjustment = current.lyricAdjustments?.[lineIndex] || {};
      const origin = Number(line.time), offset = Number(adjustment.offsetMs) || 0;
      const speed = Math.max(.5, Math.min(2, Number(adjustment.speed) || 1));
      const adjust = milliseconds => (origin + (milliseconds-origin)*speed + offset)/1000;
      const words = (backing ? current.backingWordTimings : parallel ? current.parallelWordTimings : current.wordTimings)?.find(row => Number(row.lineIndex) === lineIndex)?.words || [];
      const valid = words.filter(cue => Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)) && Number(cue.end)>Number(cue.start));
      if (valid.length) {
        let entryCursor = 0;
        for (const cue of valid) {
          const wordIndex = entries.findIndex((entry,index) => index>=entryCursor && lyricTokenKey(entry.word)===lyricTokenKey(cue.word));
          if (wordIndex>=0) entryCursor = wordIndex+1;
          const start=adjust(Number(cue.start)*1000), end=adjust(Number(cue.end)*1000);
          if (end<from || start>to || wordIndex<0 || parallel&&line.activeWordIndices&&!line.activeWordIndices.includes(wordIndex)) continue;
          result.push({start,end,text:entries[wordIndex].word,backing,voice:line.voice|| (backing?'backing':parallel?'parallel':'lead'),censored:processingSettings.markProfanity===true && isProfanityOccurrence(lineIndex,wordIndex,entries[wordIndex].word)});
        }
      } else if (entries.length && Number.isFinite(origin)) {
        const next = lines.slice(lineIndex+1).find(row => line.voice ? row.voice===line.voice : isBackingLyric(row.text)===backing);
        const marked = (backing ? current.backingLineEnds : parallel ? current.parallelLineEnds : current.lyricLineEnds)?.[lineIndex];
        const endMs = Math.min(next?.time ?? Infinity, marked!=null && Number(marked)>origin ? Number(marked) : origin+Math.min(8000,Math.max(2200,entries.length*550)));
        const start=adjust(origin), end=adjust(endMs);
        if (end<from || start>to) return;
        const text = entries.flatMap((entry,index) => parallel&&line.activeWordIndices&&!line.activeWordIndices.includes(index)?[]:[processingSettings.markProfanity===true && isProfanityOccurrence(lineIndex,index,entry.word) ? '•••' : entry.word]).join(' ');
        result.push({start,end,text,backing,voice:line.voice||(backing?'backing':parallel?'parallel':'lead'),line:true});
      }
    });
    return result.sort((a,b)=>a.start-b.start).slice(0,80);
  },
  toast, mix:settingsRow, transport:stagePerformanceTools || transportRow
};

Object.assign(englishUiCopy,{'Formato da interface':'Interface format','Formato':'Format','Automático (aparelho)':'Automatic (device)','Aplicar formato':'Apply format','Teste os menus e o palco de cada formato neste aparelho. Salve suas edições antes de aplicar: a interface será recarregada e a reprodução será interrompida.':'Test each menu and stage format on this device. Save your edits before applying: the interface will reload and playback will stop.'});
