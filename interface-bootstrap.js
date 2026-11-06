/* Resolve debug-only presentation overrides before composing the interface. */
(async () => {
  let debug = /-(?:rc|snapshot|test|debug)(?:[.-]|$)/i.test(window.VoxStageBuildInfo?.version||'') || /\b(?:RC|snapshot|debug)\b/i.test(window.VoxStageBuildInfo?.label||'');
  try {
    // Desktop debug mode belongs to the Python backend, just like Settings.
    // Its native shell may predate the debug command or expose another profile.
    const android = /Android/i.test(navigator.userAgent) && typeof window.__TAURI__?.core?.invoke==='function';
    const mode = android
      ? window.__TAURI__.core.invoke('is_debug_build')
      : fetch('/api/build-mode', {signal:AbortSignal.timeout(4000)}).then(response=>response.ok?response.json():{}).then(result=>result.debug===true);
    debug = await Promise.race([mode,new Promise(resolve=>setTimeout(()=>resolve(false),4000))]) === true || debug;
  } catch {}
  window.VoxStageDebugEnabled = debug;
  try {
    const format=localStorage.getItem('voxstage-debug-format');
    if(debug&&['pc','tv','phone'].includes(format))window.VoxStageInterfaceFormat=format;
  } catch {}
  const scripts=['app.js?v=2.0.0','audio/pitch-core.js?v=1.1.1','microphone-input.js?v=1.1.1','vocal-fx.js?v=2.0.0','scoring.js?v=1.1.1','phone-microphone.js?v=1.1.1','onboarding.js?v=1.0.2','android-tv.js?v=2.0.0','menu-shell.js?v=2.0.0','menu-pages.js?v=2.0.0','stage-shell.js?v=2.0.0'];
  for(const source of scripts)await new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=source;script.onload=resolve;script.onerror=()=>reject(new Error(`Não consegui carregar ${source}`));document.body.append(script);
  });
})().catch(error=>{console.error(error);const message=document.createElement('p');message.setAttribute('role','alert');message.textContent='Não consegui carregar a interface. Feche e abra o VoxStage novamente.';document.body.prepend(message);});
