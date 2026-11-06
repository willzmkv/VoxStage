/* Palco livre: shared engine/controls, platform-specific composition. */
(() => {
  'use strict';
  const stage=$('display'),menu=window.VoxStageMenu;if(!stage||!menu)return;
  const device=menu.device,pc=device==='pc',tv=device==='tv',en=()=>interfaceLanguage==='en-US';
  const txt=(pt,english)=>{englishUiCopy[pt]=english;return en()?english:pt;};
  const css=document.createElement('link');css.rel='stylesheet';css.href='stage-shell.css?v=2.0.0';document.head.append(css);
  stage.classList.add('palco-livre');stage.dataset.stageDevice=device;
  const paths={more:'M5 12h.01M12 12h.01M19 12h.01',close:'m6 6 12 12M18 6 6 18',hide:'m3 3 18 18M10 5a12 12 0 0 1 11 7 14 14 0 0 1-4 5M6 6a14 14 0 0 0-3 6 12 12 0 0 0 12 7M10 10a3 3 0 0 0 4 4',show:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6',speed:'M4 18a10 10 0 1 1 16 0M12 13l5-6M5 18h14',mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0Zm-3 7v1a6 6 0 0 0 12 0v-1M12 18v4M8 22h8',back:'m14 6-6 6 6 6M8 12h13',sync:'M3 5h17M3 10h8M3 15h8M17 13v3l2 1',vocal:'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-5 9a5 5 0 0 0 10 0M12 18v4M8 22h8M19 8a5 5 0 0 1 0 6M5 8a5 5 0 0 0 0 6'};
  function svg(name){if(!paths[name])return playbackControlSvg(name);return `<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name]}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>${name==='sync'?'<circle cx="17" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/>':''}</svg>`;}
  function paint(button,name,label='',accessible=label){
    if(!button)return;
    button.innerHTML=svg(name)+(label?`<span class="palco-control-label">${esc(label)}</span>`:'');
    if(accessible){button.setAttribute('aria-label',accessible);button.title=accessible;}
  }
  function group(name){const node=document.createElement('div');node.className=name;return node;}
  const fonts={nunito:{family:'Nunito',label:txt('Nunito · janela de letras','Nunito · lyric window'),weight:400,body:400,title:750,button:650},'nunito-light':{family:'Nunito',label:txt('Nunito leve · teste','Nunito light · test'),weight:300,body:300,title:600,button:500},manrope:{family:'Manrope',label:txt('Manrope · original','Manrope · original'),weight:800,body:400,title:750,button:650},'dm-sans':{family:'DM Sans',label:'DM Sans',weight:500,body:400,title:700,button:600},outfit:{family:'Outfit',label:'Outfit',weight:500,body:400,title:650,button:550},rubik:{family:'Rubik',label:'Rubik',weight:500,body:400,title:650,button:550}};
  const fontSection=document.createElement('section');fontSection.className='processing-section font-preferences';
  fontSection.innerHTML=`<b>${txt('Fontes','Fonts')}</b><label class="theme-custom-row lyric-font-row"><span>${txt('Fonte da interface','Interface font')}</span><select id="interfaceFont"></select></label><label class="theme-custom-row lyric-font-row"><span>${txt('Fonte das letras','Lyric font')}</span><select id="lyricsFont"></select></label><div class="font-preview" aria-hidden="true">${txt('Sua música, seu palco','Your music, your stage')}</div>`;
  settingsPanes.visual.append(fontSection);
  for(const id of ['interfaceFont','lyricsFont'])$(id).innerHTML=Object.entries(fonts).map(([value,font])=>`<option value="${value}">${esc(font.label)}</option>`).join('');
  let typographyKey='';
  function applyTypography(){
    const lyricKey=Object.hasOwn(fonts,processingSettings.lyricsFont)?processingSettings.lyricsFont:'nunito',uiKey=Object.hasOwn(fonts,processingSettings.interfaceFont)?processingSettings.interfaceFont:'nunito';
    $('lyricsFont').value=lyricKey;$('interfaceFont').value=uiKey;
    if(typographyKey===`${lyricKey}:${uiKey}`)return;typographyKey=`${lyricKey}:${uiKey}`;
    const lyric=fonts[lyricKey],ui=fonts[uiKey],root=document.documentElement.style;
    for(const [key,value]of Object.entries({'--lyrics-font':`"${lyric.family}",sans-serif`,'--lyrics-weight':lyric.weight,'--interface-font':`"${ui.family}",sans-serif`,'--ui-body-weight':ui.body,'--ui-title-weight':ui.title,'--ui-button-weight':ui.button}))root.setProperty(key,String(value));
    Promise.allSettled([document.fonts.load(`${lyric.weight} 32px "${lyric.family}"`),document.fonts.load(`${ui.title} 24px "${ui.family}"`)]).then(()=>{if(current&&!manualSyncState)updateLyrics(playbackPosition());});
  }
  for(const id of ['interfaceFont','lyricsFont'])$(id).onchange=()=>{processingSettings[id]=$(id).value;localStorage.setItem('voxstage-processing-settings',JSON.stringify(processingSettings));applyTypography();};
  const oldVoiceTheme=applyVoiceTheme;applyVoiceTheme=function(){oldVoiceTheme();applyTypography();};
  applyTypography();
  const hud=stage.querySelector('.display-hud');hud.classList.add('palco-header');
  const track=group('palco-track');track.innerHTML='<strong id="stageSongTitle"></strong><span id="stageSongArtist"></span>';
  $('dispTrack').hidden=true;hud.append(track);
  const headerActions=group('palco-header-actions');hud.append(headerActions);
  const quickExit=$('quickExitDisplay'),hide=$('mobileControlsToggle');
  if(pc&&$('mobileStageMode'))$('mobileStageMode').hidden=true;
  headerActions.append(hide,quickExit);paint(quickExit,pc?'close':'back','',txt('Sair da apresentação','Leave presentation'));
  const legacy=group('palco-legacy');legacy.hidden=true;legacy.append($('closeDisplay'));stage.append(legacy);
  const panel=stage.querySelector('.display-bottom');panel.classList.add('palco-panel','stage-control-panel');
  const progress=group('palco-progress stage-progress');progress.append($('dispTime').parentElement,waveformRow,$('dispDuration'));
  const controls=group('palco-controls'),left=group('palco-tools-left'),playback=group('palco-playback stage-playback'),right=group('palco-tools-right');
  playback.setAttribute('role','group');playback.setAttribute('aria-label',txt('Reprodução','Playback'));
  playback.append(previousDisplay,displayBack10,$('dispPlay'),displayForward10,nextDisplay);
  controls.append(left,playback,right);
  const pitchPanel=stage.querySelector('.playback-transform-compact');
  const score=$('scoreOpen'),lyrics=$('openLyrics'),sync=$('lyricSync');
  paint(lyrics,'lyrics',txt('Letras','Lyrics'));
  function paintSync(){paint(sync,'sync','Sync',txt('Sincronizar letra','Synchronize lyrics'));}
  const oldSyncUi=updateSyncEngineUi;updateSyncEngineUi=function(){oldSyncUi();paintSync();};paintSync();
  paint(score,'mic',txt('Pontuar','Score'));
  const vocalFxBtn=document.createElement('button');
  vocalFxBtn.id='stageVocalFx';vocalFxBtn.type='button';vocalFxBtn.className='hud-btn vocal-fx-btn';
  function paintVocalFx(){
    const running=Boolean(window.VoxStageVocalMonitor?.isRunning);
    vocalFxBtn.classList.toggle('active',running);
    paint(vocalFxBtn,'vocal',running?txt('Voz On','Voice On'):txt('Voz','Vocal'),txt('Retorno e efeitos de voz','Voice return and vocal effects'));
  }
  paintVocalFx();
  vocalFxBtn.onclick=()=>window.VoxStageVocalMonitor?.openDialog();
  window.addEventListener('voxstage-vocal-monitor-state',paintVocalFx);
  const oldTransformUi=updatePlaybackTransformControls;
  updatePlaybackTransformControls=function(){oldTransformUi();const b=stage.querySelector('[data-speed-open]');if(b){const label=b.textContent;paint(b,'speed',label,txt('Ajustar velocidade e tom','Adjust speed and pitch'));}};
  updatePlaybackTransformControls();
  let mix=$('mobileMixToggle');
  if(!mix&&!pc){mix=document.createElement('button');mix.id='mobileMixToggle';mix.className='hud-btn';mix.type='button';mix.setAttribute('aria-expanded','false');mix.onclick=()=>{const open=panel.classList.toggle('mix-open');mix.setAttribute('aria-expanded',String(open));};}
  if(mix)paint(mix,'mix','Mix',txt('Volumes e palavra por palavra','Volumes and word highlighting'));
  settingsRow.classList.add('palco-mix');settingsRow.setAttribute('aria-label',txt('Volumes e aparência','Volumes and appearance'));
  if(!settingsRow.id)settingsRow.id='stageMixPanel';mix?.setAttribute('aria-controls',settingsRow.id);
  if(pc){left.append(lyrics,sync);right.append(vocalFxBtn,score,pitchPanel);}
  else{left.append(mix);right.append(vocalFxBtn,pitchPanel,score);}
  panel.replaceChildren(progress,controls,settingsRow);
  const moreMenu=group('palco-more-menu');moreMenu.id='stageMoreMenu';moreMenu.setAttribute('popover','auto');moreMenu.setAttribute('role','dialog');moreMenu.setAttribute('aria-label',txt('Opções do palco','Stage options'));stage.append(moreMenu);
  let more=null;
  if(!pc){
    more=document.createElement('button');more.id='stageMoreOpen';more.type='button';more.className='hud-btn';more.setAttribute('aria-controls',moreMenu.id);more.setAttribute('aria-expanded','false');paint(more,'more','',txt('Mais opções','More options'));
    headerActions.replaceChildren(...(tv?[lyrics]:[]),more,quickExit);
    if(!tv)moreMenu.append(lyrics);moreMenu.append(sync,vocalFxBtn,hide);if($('mobileStageMode'))moreMenu.append($('mobileStageMode'));
    more.onclick=()=>{
      if(moreOpen()){closeMore();return;}
      closeMix();const anchor=more.getBoundingClientRect(),width=Math.min(280,innerWidth-24);
      moreMenu.style.width=`${width}px`;moreMenu.style.left=`${Math.max(12,Math.min(anchor.right-width,innerWidth-width-12))}px`;moreMenu.style.top=`${anchor.bottom+10}px`;moreMenu.style.maxHeight=`${Math.max(80,innerHeight-anchor.bottom-24)}px`;
      if(moreMenu.showPopover)moreMenu.showPopover();else moreMenu.classList.add('palco-more-fallback');
      more.setAttribute('aria-expanded','true');moreMenu.querySelector('button')?.focus({preventScroll:true});
    };
  }
  const popOpen=node=>Boolean(node?.showPopover)&&node.matches(':popover-open');
  function moreOpen(){return moreMenu.classList.contains('palco-more-fallback')||popOpen(moreMenu);}
  function closeMore(focus=true){if(popOpen(moreMenu))moreMenu.hidePopover();moreMenu.classList.remove('palco-more-fallback');more?.setAttribute('aria-expanded','false');if(focus)more?.focus({preventScroll:true});}
  function closeMix(){panel.classList.remove('mix-open');mix?.setAttribute('aria-expanded','false');}
  moreMenu.addEventListener('click',event=>{if(event.target.closest('button'))closeMore(false);},true);
  moreMenu.addEventListener('toggle',()=>more?.setAttribute('aria-expanded',String(moreOpen())));
  stage.addEventListener('pointerdown',event=>{if(panel.classList.contains('mix-open')&&!panel.contains(event.target))closeMix();if(!moreMenu.showPopover&&moreOpen()&&!moreMenu.contains(event.target)&&!more?.contains(event.target))closeMore(false);});
  let cursorIdleTimer=0,lastCursorActivity=performance.now();
  function refreshStageCursor(){
    clearTimeout(cursorIdleTimer);
    const canHide=stage.classList.contains('show')&&stage.classList.contains('mobile-controls-hidden')&&!stage.classList.contains('sync-editing')&&!$('manualSyncDialog')?.classList.contains('show');
    const remaining=5000-(performance.now()-lastCursorActivity);
    stage.classList.toggle('stage-cursor-idle',canHide&&remaining<=0);
    if(canHide&&remaining>0)cursorIdleTimer=setTimeout(refreshStageCursor,remaining);
  }
  function cursorActivity(){lastCursorActivity=performance.now();refreshStageCursor();}
  window.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')cursorActivity();},{passive:true});
  window.addEventListener('pointerdown',cursorActivity,{passive:true});
  window.addEventListener('keydown',cursorActivity,{passive:true});
  const oldHidden=setStageControlsHidden;let hiddenPaint=null,manualVisibility=null;
  setStageControlsHidden=function(collapsed,source='auto'){
    if(source==='manual'){manualVisibility=Boolean(collapsed);lastCursorActivity=performance.now();}
    collapsed=manualVisibility??Boolean(collapsed);
    stage.dataset.controlsVisibility=manualVisibility===null?'auto':manualVisibility?'hidden':'visible';
    if(stage.classList.contains('mobile-controls-hidden')!==collapsed)oldHidden(collapsed);
    const signature=`${Boolean(collapsed)}:${interfaceLanguage}`;
    if(hiddenPaint!==signature){hide.setAttribute('aria-expanded',String(!collapsed));paint(hide,collapsed?'show':'hide',pc?'':txt(collapsed?'Mostrar controles':'Ocultar controles',collapsed?'Show controls':'Hide controls'),txt(collapsed?'Mostrar controles':'Ocultar controles',collapsed?'Show controls':'Hide controls'));hiddenPaint=signature;}
    if(collapsed){closeMore(false);closeMix();}
    refreshStageCursor();
  };
  hide.onclick=()=>setStageControlsHidden(!stage.classList.contains('mobile-controls-hidden'),'manual');
  setStageControlsHidden(stage.classList.contains('mobile-controls-hidden'));
  function title(){
    $('stageSongTitle').textContent=current?.title||txt('Seu palco','Your stage');$('stageSongArtist').textContent=current?.artist||'';
  }
  new MutationObserver(title).observe($('dispTrack'),{childList:true,characterData:true,subtree:true});title();
  let lyricLayoutFrame=false;
  function refreshLyricLayout(){
    if(lyricLayoutFrame||!current||!stage.classList.contains('show'))return;
    lyricLayoutFrame=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{lyricLayoutFrame=false;if(current&&stage.classList.contains('show')&&!manualSyncState)updateLyrics(playbackPosition());}));
  }
  function updateInsets(){
    const active=stage.classList.contains('show'),portrait=!pc&&!tv&&matchMedia('(orientation:portrait)').matches;
    const height=active?panel.getBoundingClientRect().height:0;stage.style.setProperty('--palco-panel-height',`${height}px`);
    stage.dataset.stagePortrait=String(portrait);
    refreshLyricLayout();
  }
  new ResizeObserver(updateInsets).observe(panel);
  new ResizeObserver(refreshLyricLayout).observe($('lyrics'));
  new ResizeObserver(refreshLyricLayout).observe($('scoreOverlay'));
  window.addEventListener('resize',()=>{closeMore(false);updateInsets();});css.addEventListener('load',updateInsets);
  let wasOpen=false;
  new MutationObserver(()=>{const open=stage.classList.contains('show');if(open&&!wasOpen)lastCursorActivity=performance.now();if(!open&&wasOpen){manualVisibility=null;setStageControlsHidden(false);closeMore(false);closeMix();}wasOpen=open;refreshStageCursor();updateInsets();}).observe(stage,{attributes:true,attributeFilter:['class']});
  stage.addEventListener('click',event=>{
    if(pc||tv||manualSyncState||event.target.closest('button,input,select,textarea,a,#lyrics,#lyricSecondLine,#scoreLaneLyrics,.palco-panel,.palco-more-menu'))return;
    if(event.target===stage||event.target.closest('.display-content,#displayBg,#displayVideoBg'))setStageControlsHidden(!stage.classList.contains('mobile-controls-hidden'),'manual');
  });
  function closeNested(){
    const scanner=document.querySelector('.pc-qr-scanner:not([hidden])');if(scanner){scanner.querySelector('button')?.click();return true;}
    const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);
    if(dialog){const cancel=new Event('cancel',{cancelable:true});if(dialog.dispatchEvent(cancel))dialog.close();return true;}
    const popup=$('playbackTransformPopup');if(popup&&(popOpen(popup)||popup.classList.contains('popup-fallback-open'))){if(popOpen(popup))popup.hidePopover();popup.classList.remove('popup-fallback-open');stage.querySelector('[data-speed-open]')?.focus({preventScroll:true});return true;}
    if(moreOpen()){closeMore();return true;}
    const overlays=[...document.querySelectorAll('.manual-sync-dialog.show,.lyrics-dialog.show,.artwork-dialog.show,.processing-dialog.show,.remote-panel.show,.setup-wizard.show,.profanity-picker-dialog.show')].filter(n=>n.getClientRects().length&&!n.classList.contains('menu-settings-inline'));
    const top=overlays.at(-1);if(top){const close=top.querySelector('.lyrics-close,.x,.wizard-close,#closeManualSync,#closeProcessing,#remotePanelClose,[data-close]');if(close){close.click();return true;}}
    if(panel.classList.contains('mix-open')){closeMix();mix?.focus({preventScroll:true});return true;}return false;
  }
  window.VoxStageStage={closeMore,moreOpen};
  window.voxstageBack=()=>{
    if(tv)return window.voxstageTvKey?.('Back');
    if(closeNested())return true;
    if(stage.classList.contains('show')){$('closeDisplay').click();return true;}
    if(window.VoxStageMenuBack?.())return true;
    try{window.VoxStageMedia?.exitToLauncher();}catch{}return false;
  };
  window.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||tv||!stage.classList.contains('show'))return;
    window.voxstageBack();event.preventDefault();event.stopImmediatePropagation();
  },true);
  title();updateInsets();window.__voxstageStageReady=true;
})();
