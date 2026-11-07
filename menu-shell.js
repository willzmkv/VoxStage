/* VoxStage 2.0: one library and engine, three menu layouts. */
(() => {
  'use strict';
  const body=document.body, topbar=document.querySelector('.topbar');
  const device=presentationDevice;
  body.classList.toggle('mobile-native-app',device!=='pc');
  body.classList.add('voxstage-v2');body.dataset.menuDevice=device;
  const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='menu-shell.css?v=2.0.0';document.head.append(stylesheet);
  const en=()=>interfaceLanguage==='en-US',txt=(pt,english)=>en()?english:pt;
  const paths={library:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',queue:'M4 5h16M4 11h11M4 17h8m6-4v8m-4-4h8',phone:'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 16h4',gear:'m9 3-.5 3-2 1.2-2.8-1-2 3.5L4 12l-1.3 2.3 2 3.5 2.8-1 2 1.2.5 3h4l.5-3 2-1.2 2.8 1 2-3.5L20 12l1.3-2.3-2-3.5-2.8 1-2-1.2L14 3Zm3 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6',help:'M9 8a3 3 0 1 1 5 2.2c-1.4 1-2 1.5-2 3.8m0 3v.2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',plus:'M12 5v14M5 12h14',play:'m9 5 11 7-11 7Z',up:'m6 14 6-6 6 6',close:'m6 6 12 12M18 6 6 18',upload:'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5'};
  const icon=name=>`<svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name]||paths.library}"/></svg>`;
  function button(id,label,name,action){const b=document.createElement('button');b.type='button';b.id=id;b.className='menu-nav-button';b.innerHTML=icon(name)+`<span>${label}</span>`;b.onclick=action;return b;}
  function restyle(node,label,name){if(!node)return;node.classList.add('menu-nav-button');node.innerHTML=icon(name)+`<span>${label}</span>`;node.title=label;node.setAttribute('aria-label',label);}
  const brand=document.querySelector('.corner-brand');
  const nav=document.createElement('nav');nav.id='menuNavigation';nav.className='menu-navigation';nav.setAttribute('aria-label',txt('Menu principal','Main menu'));
  const libraryButton=button('menuLibrary',txt('Biblioteca','Library'),'library',()=>showLibrary(false));
  const favoritesButton=button('menuFavorites',txt('Favoritas','Favorites'),'star',()=>showLibrary(true));
  const queueButton=button('menuQueue',txt('Fila','Queue'),'queue',()=>showQueue());
  const connection=mobileNative?$('syncPcLibrary'):$('remoteOpen');
  restyle(connection,device==='phone'?txt('Conectar','Connect'):txt('Conectar celular','Connect phone'),'phone');
  nav.append(libraryButton,favoritesButton,queueButton);if(connection)nav.append(connection);
  const settings=$('settingsTop'),help=$('openUsageGuide');
  for(const [key,name]of [['Lead',txt('Vocal','Vocal')],['Back','Backing']]){const label=$('vol'+key).closest('label'),node=[...label.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);if(node)node.textContent=name;}
  if(previousPlayerButton){previousPlayerButton.innerHTML=playbackControlSvg('previous');previousPlayerButton.setAttribute('aria-label',txt('Música anterior','Previous song'));}
  if(nextPlayerButton){nextPlayerButton.innerHTML=playbackControlSvg('next');nextPlayerButton.setAttribute('aria-label',txt('Próxima música','Next song'));}
  $('fullscreenBtn').innerHTML='<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  restyle(settings,txt('Configurações','Settings'),'gear');restyle(help,txt('Guia de uso','User guide'),'help');
  const utilities=document.createElement('div');utilities.className='menu-utilities';utilities.append(help,settings);
  const add=$('addTop');add.innerHTML=icon('plus')+`<span>${txt('Adicionar música','Add song')}</span>`;add.title=txt('Adicionar música','Add song');add.setAttribute('aria-label',add.title);
  const actions=document.createElement('div');actions.className='menu-header-actions';actions.append(add);
  const activity=uploadActivityButton;activity.id='menuUploads';restyle(activity,txt('Envios','Transfers'),'upload');
  const welcome=document.querySelector('.welcome'),library=$('grid').parentElement;
  library.classList.add('menu-library');library.id='menuLibrarySection';
  const heading=document.createElement('div');heading.className='menu-section-heading';heading.innerHTML=`<div><span class="eyebrow">${txt('SEU PALCO','YOUR STAGE')}</span><h1 id="menuHeading">${txt('Sua biblioteca','Your library')}</h1><p id="menuSubtitle">${txt('Escolha uma música. O palco é seu.','Pick a song. The stage is yours.')}</p></div>`;
  welcome.replaceChildren(heading,actions);
  document.querySelector('.hero').hidden=true;
  const crumbs=document.createElement('span');crumbs.className='menu-breadcrumb';crumbs.textContent=txt('Biblioteca musical','Music library');
  topbar.replaceChildren(crumbs,utilities);
  library.querySelector('.library-heading').firstChild.textContent=txt('Músicas ','Songs ');
  $('search').placeholder=txt('Buscar na biblioteca…','Search your library…');$('search').setAttribute('aria-label',txt('Buscar na biblioteca','Search library'));
  const tabs=document.createElement('div');tabs.className='menu-lyric-filters';tabs.setAttribute('role','group');tabs.setAttribute('aria-label',txt('Filtrar por letra','Filter by lyrics'));
  for(const [value,pt,english]of[['all','Todas','All'],['ready','Letras prontas','Lyrics ready'],['missing','Sem letra','No lyrics']]){
    const b=button('menuFilter-'+value,txt(pt,english),'library',()=>{libraryLyricsFilter=value;render();});b.dataset.lyricFilter=value;b.setAttribute('aria-pressed',String(value==='all'));tabs.append(b);
  }
  library.querySelector('.filters').after(tabs);
  const layout=document.createElement('div');layout.className='menu-content-layout';library.before(layout);layout.append(library);
  const rail=document.createElement('aside');rail.id='menuQueuePanel';rail.className='menu-queue-panel';rail.setAttribute('aria-label',txt('Fila de reprodução','Playback queue'));
  rail.innerHTML=`<header><div><span class="eyebrow">${txt('NESTA SESSÃO','THIS SESSION')}</span><h2>${txt('Fila de reprodução','Playback queue')}</h2></div><button type="button" class="menu-icon-button" id="menuQueueClose" data-close aria-label="${txt('Fechar fila','Close queue')}">${icon('close')}</button></header><div id="menuQueueNow"></div><div class="menu-queue-heading"><h3 id="menuQueueLabel"></h3><button type="button" id="menuClearQueue">${txt('Limpar','Clear')}</button></div><ol id="menuQueueItems"></ol><p class="menu-queue-note" id="menuQueueNote"></p><div class="menu-queue-footer"></div>`;
  rail.querySelector('h2').tabIndex=-1;
  layout.append(rail);
  const railFooter=rail.querySelector('.menu-queue-footer');railFooter.append(activity);
  const connectHint=document.createElement('p');connectHint.textContent=txt('Seu celular também pode ser o microfone.','Your phone can be your microphone too.');railFooter.append(connectHint);
  const queueDialog=document.createElement('dialog');queueDialog.id='menuQueueDialog';queueDialog.setAttribute('aria-label',txt('Fila de reprodução','Playback queue'));body.append(queueDialog);
  const sidebar=document.createElement('aside');sidebar.className='menu-sidebar';sidebar.append(brand,nav);
  const sidebarBottom=document.createElement('div');sidebarBottom.className='menu-sidebar-bottom';sidebarBottom.innerHTML=`<span class="menu-local-label">${txt('Sua música, no seu dispositivo.','Your music, on your device.')}</span><span class="menu-version">VoxStage ${esc(window.VoxStageBuildInfo?.version||'2.1.0')}</span>`;sidebar.append(sidebarBottom);
  let connectionPage=null,connectionActive=false,activePage=null;
  function notifyPage(key){window.dispatchEvent(new CustomEvent('voxstage-menu-page',{detail:key}));}
  const remoteCard=remotePanel.querySelector('.remote-card');
  function restoreRemotePopup(){
    remotePanel.classList.remove('menu-remote-inline','show');document.body.append(remotePanel);
    remoteCard.setAttribute('role','dialog');remoteCard.setAttribute('aria-modal','true');$('remotePanelClose').hidden=false;
  }
  function leaveConnectionPage(){
    if(!connectionActive)return;
    if(activePage==='connection')activePage=null;
    if(body.dataset.menuPage==='connection')delete body.dataset.menuPage;
    connectionActive=false;connectionPage.hidden=true;welcome.hidden=false;layout.hidden=false;restoreRemotePopup();
    connection?.removeAttribute('aria-current');crumbs.textContent=txt('Biblioteca musical','Music library');
    libraryButton.setAttribute('aria-current',favoriteOnly?'false':'page');favoritesButton.setAttribute('aria-current',favoriteOnly?'page':'false');
  }
  if(device==='pc'||device==='tv'||!mobileNative){
    if(device==='pc'){
      sidebarBottom.prepend(utilities);
      queueButton.remove();restyle(add,txt('Adicionar música','Add song'),'plus');nav.append(add);
      document.querySelector('.app').prepend(sidebar);
    }
    connectionPage=document.createElement('section');connectionPage.id='menuConnectionPage';connectionPage.hidden=true;connectionPage.setAttribute('aria-labelledby','remotePanelTitle');layout.after(connectionPage);
    const transferList=$('remoteTransferList'),transferHeading=transferList.previousElementSibling,requestsHeading=transferHeading.previousElementSibling;
    requestsHeading.before(transferHeading,transferList);
    const oldShowRemote=showRemotePanel,oldCloseRemote=closeRemotePanel;
    const oldRemoteBackdrop=remotePanel.onclick;remotePanel.onclick=event=>{if(!connectionActive)oldRemoteBackdrop(event);};
    function showConnectionPage(){
      activePage='connection';body.dataset.menuPage='connection';notifyPage('connection');
      connectionActive=true;connectionPage.hidden=false;welcome.hidden=true;layout.hidden=true;hero.hidden=true;
      connectionPage.append(remotePanel);remotePanel.classList.add('menu-remote-inline');remoteCard.setAttribute('role','region');remoteCard.removeAttribute('aria-modal');$('remotePanelClose').hidden=device==='pc';
      libraryButton.removeAttribute('aria-current');favoritesButton.removeAttribute('aria-current');connection.setAttribute('aria-current','page');crumbs.textContent=txt('Conectar celular','Connect phone');
      oldShowRemote();if(device==='tv')window.scrollTo(0,0);else connectionPage.scrollIntoView({block:'start'});
    }
    connection.onclick=showConnectionPage;
    // Every pairing entry uses the connection page, including scoring.
    showRemotePanel=function(){
      if($('scoreDialog')?.open)$('scoreDialog').close();
      if($('display').classList.contains('show'))$('closeDisplay').click();
      showConnectionPage();
    };
    closeRemotePanel=function(){if(connectionActive){showLibrary(favoriteOnly);return;}oldCloseRemote();};
    $('remotePanelClose').onclick=()=>closeRemotePanel();
    window.VoxStageScoreHost.connectPhone=()=>showRemotePanel();
  }
  if(device==='phone'){
    restyle(settings,txt('Ajustes','Settings'),'gear');
    topbar.replaceChildren(brand,actions);actions.append(help);
    favoritesButton.onclick=()=>favoriteButton.click();
    tabs.append(favoritesButton,hiddenSongsButton);
    hiddenSongsButton.classList.add('menu-nav-button');
    add.classList.add('menu-primary-action');
    add.querySelector('span').textContent=txt('Adicionar música','Add song');
    nav.replaceChildren(libraryButton,queueButton,add,...(connection?[connection]:[]),settings);body.append(nav);
    const catalogueHeading=document.createElement('div');catalogueHeading.className='menu-catalogue-heading';
    catalogueHeading.innerHTML='<span id="menuMobileCount"></span>';catalogueHeading.append($('sortBtn'));tabs.after(catalogueHeading);
  }
  let featuredId=null,lastQueueKey='',lastNowKey='';
  const hero=document.createElement('section');hero.id='menuTvHero';hero.className='menu-tv-hero';
  hero.innerHTML=`<div class="menu-tv-backdrop"></div><div class="menu-tv-copy"><span class="eyebrow">${txt('HOJE O PALCO É SEU','THE STAGE IS YOURS')}</span><h1 id="menuTvTitle"></h1><p id="menuTvArtist"></p><div class="menu-tv-actions"><button type="button" class="btn" id="menuTvSing">${icon('play')}<span>${txt('Cantar','Sing')}</span></button><button type="button" class="btn secondary" id="menuTvEnqueue">${icon('queue')}<span>${txt('Adicionar à fila','Add to queue')}</span></button></div><p class="menu-tv-hint">${txt('Use as setas para escolher. OK para cantar.','Use the arrows to choose. OK to sing.')}</p></div><div class="menu-tv-art" id="menuTvArt"></div>`;
  if(device==='tv'){welcome.after(hero);utilities.prepend(add);topbar.replaceChildren(brand,nav,utilities);$('remotePanelTitle').textContent=txt('Conecte o celular à TV','Connect your phone to the TV');}
  $('menuTvSing')?.addEventListener('click',()=>{if(featuredId)void playSong(featuredId);else add.click();});
  $('menuTvEnqueue')?.addEventListener('click',()=>{if(featuredId)addToPlaybackQueue(featuredId);});
  function showLibrary(favorites){
    activePage=null;delete body.dataset.menuPage;notifyPage('library');welcome.hidden=false;layout.hidden=false;
    connection?.removeAttribute('aria-current');
    add.removeAttribute('aria-current');settings.removeAttribute('aria-current');crumbs.textContent=txt('Biblioteca musical','Music library');
    leaveConnectionPage();
    if(queueDialog.open)queueDialog.close();
    favoriteOnly=favorites;favoriteButton.classList.toggle('selected',favorites);favoriteButton.textContent=favorites?txt('★ Favoritas','★ Favorites'):txt('☆ Favoritas','☆ Favorites');
    $('search').value='';libraryLyricsFilter='all';render();library.scrollIntoView({block:'start',behavior:'smooth'});
    if(device==='tv')$('search').focus({preventScroll:true});
  }
  function showQueue(){
    refreshQueue();if(device==='pc'&&innerWidth>=1100){rail.scrollIntoView({block:'nearest'});rail.querySelector('h2').focus({preventScroll:true});return;}
    queueDialog.append(rail);if(!queueDialog.open)queueDialog.showModal();$('menuQueueClose').focus();
  }
  $('menuQueueClose').onclick=()=>queueDialog.close();
  queueDialog.addEventListener('close',()=>{layout.append(rail);queueButton.focus({preventScroll:true});});
  queueDialog.addEventListener('click',e=>{if(e.target===queueDialog){const r=queueDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)queueDialog.close();}});
  queueDialog.addEventListener('keydown',e=>{if(!androidTv)e.stopPropagation();});
  $('menuClearQueue').onclick=()=>{remoteSongQueue.splice(0);refreshQueue();};
  function queueArt(song){return song?.cover?`<img src="${esc(mediaUrl(song.cover))}" alt="" loading="lazy">`:`<span>${esc((song?.title||'♫')[0])}</span>`;}
  function refreshQueue(){
    for(let i=remoteSongQueue.length-1;i>=0;i--)if(!songs.some(s=>s.id===remoteSongQueue[i]&&!s.hidden))remoteSongQueue.splice(i,1);
    const pending=remoteSongQueue.length?remoteSongQueue.map(id=>songs.find(s=>s.id===id)).filter(Boolean):followingLibrarySongs();
    const queueKey=JSON.stringify([en(),remoteSongQueue.length,pending.map(s=>[s.id,s.title,s.artist,s.cover])]);
    if(lastQueueKey!==queueKey){
      lastQueueKey=queueKey;const explicit=remoteSongQueue.length>0;
      $('menuQueueLabel').textContent=explicit?txt(`Escolhidas · ${pending.length}`,`Selected · ${pending.length}`):txt('A seguir · biblioteca','Up next · library');
      $('menuClearQueue').hidden=!explicit;
      $('menuQueueItems').innerHTML=pending.length?pending.map((s,i)=>`<li><button type="button" class="menu-queue-song" data-queue-play="${esc(s.id)}" aria-label="${txt('Tocar','Play')} ${esc(s.title)}"><span class="menu-queue-art">${queueArt(s)}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.artist||txt('Artista desconhecido','Unknown artist'))}</small></span></button>${explicit?`<div class="menu-queue-tools"><button type="button" class="menu-icon-button" data-queue-up="${esc(s.id)}" ${i===0?'disabled':''} aria-label="${txt('Subir na fila','Move up')} ${esc(s.title)}">${icon('up')}</button><button type="button" class="menu-icon-button" data-queue-remove="${esc(s.id)}" aria-label="${txt('Remover da fila','Remove from queue')} ${esc(s.title)}">${icon('close')}</button></div>`:''}</li>`).join(''):`<li class="menu-queue-empty">${txt('Escolha uma música para começar a sessão.','Choose a song to start the session.')}</li>`;
      $('menuQueueNote').textContent=explicit?txt('Suas escolhas tocam primeiro. Depois, a biblioteca continua na ordem.','Your choices play first. Then the library continues in order.'):txt('Sem escolhas na fila, as próximas músicas seguem a ordem da biblioteca.','With no selections queued, the next songs follow library order.');
      queueButton.setAttribute('aria-label',txt(`Fila · ${pending.length} músicas`,`Queue · ${pending.length} songs`));
    }
    const nowKey=JSON.stringify([current?.id,current?.title,current?.artist,current?.cover,Boolean(playing),en()]);
    if(lastNowKey!==nowKey){lastNowKey=nowKey;
      $('menuQueueNow').innerHTML=current?`<span class="menu-now-label">${playing?txt('TOCANDO AGORA','NOW PLAYING'):txt('PAUSADA','PAUSED')}</span><button type="button" class="menu-now-song" id="menuReturnStage"><span class="menu-now-art">${queueArt(current)}</span><strong>${esc(current.title)}</strong><small>${esc(current.artist||'')}</small></button>`:`<div class="menu-now-idle">${icon('play')}<strong>${txt('O palco está esperando','The stage is waiting')}</strong><span>${txt('Toque uma música ou monte sua fila.','Play a song or build your queue.')}</span></div>`;
      $('menuReturnStage')?.addEventListener('click',()=>$('fullscreenBtn').click());body.classList.toggle('menu-has-current',Boolean(current));
    }
    sizeQueuePanel();
  }
  function sizeQueuePanel(){
    if(device!=='pc'||layout.hidden||rail.parentElement!==layout)return;
    const top=rail.getBoundingClientRect().top,bottom=document.querySelector('.player').getBoundingClientRect().top;
    rail.style.height=`${Math.max(120,bottom-top-16)}px`;
  }
  rail.addEventListener('click',e=>{
    const play=e.target.closest('[data-queue-play]'),remove=e.target.closest('[data-queue-remove]'),up=e.target.closest('[data-queue-up]');
    if(play){if(queueDialog.open)queueDialog.close();void playSong(play.dataset.queuePlay);}
    if(remove||up){const id=remove?.dataset.queueRemove||up.dataset.queueUp,index=remoteSongQueue.indexOf(id);if(index<0)return;if(remove)remoteSongQueue.splice(index,1);else if(index>0)[remoteSongQueue[index-1],remoteSongQueue[index]]=[remoteSongQueue[index],remoteSongQueue[index-1]];refreshQueue();if(up)rail.querySelector(`[data-queue-up="${CSS.escape(id)}"]`)?.focus({preventScroll:true});else if(!$('menuClearQueue').hidden)$('menuClearQueue').focus();else if(queueDialog.open)$('menuQueueClose').focus();else rail.querySelector('h2').focus();}
  });
  function refreshLibrary(){
    // Anchor both columns' option menus inside the viewport, above the player.
    document.querySelectorAll('[data-menu-toggle]').forEach(b=>{
      const open=b.onclick;b.onclick=e=>{open(e);const menu=document.querySelector(`[data-track-menu="${CSS.escape(b.dataset.menuToggle)}"]`);if(menu&&!menu.hidden)positionSongMenu(b,menu);};
    });
    const visible=songs.filter(s=>!s.hidden);libraryButton.setAttribute('aria-current',activePage||connectionActive||favoriteOnly&&device!=='phone'?'false':'page');
    if(device==='phone'){
      favoritesButton.setAttribute('aria-pressed',String(favoriteOnly));hiddenSongsButton.textContent=txt('Ocultas','Hidden');
      $('menuMobileCount').textContent=txt(`${libraryDisplayOrder.length} músicas`,`${libraryDisplayOrder.length} songs`);
    }else favoritesButton.setAttribute('aria-current',!activePage&&!connectionActive&&favoriteOnly?'page':'false');
    $('filterFavorites').setAttribute('aria-pressed',String(favoriteOnly));tabs.querySelectorAll('[data-lyric-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.lyricFilter===libraryLyricsFilter)));
    $('menuHeading').textContent=favoriteOnly?txt('Suas favoritas','Your favorites'):txt('Sua biblioteca','Your library');
    $('menuSubtitle').textContent=txt(`${visible.length} música${visible.length===1?'':'s'} no seu dispositivo.`,`${visible.length} song${visible.length===1?'':'s'} on your device.`);
    if(device==='tv'){
      const candidates=libraryDisplayOrder.map(id=>songs.find(s=>s.id===id)).filter(Boolean),song=candidates.find(s=>s.id===current?.id)||candidates[0];featuredId=song?.id||null;hero.hidden=Boolean($('search').value.trim()||favoriteOnly||libraryLyricsFilter!=='all');
      $('menuTvTitle').textContent=song?.title||txt('Seu palco começa aqui.','Your stage starts here.');$('menuTvArtist').textContent=song?.artist||txt('Adicione sua primeira música para cantar.','Add your first song to sing.');
      $('menuTvSing').querySelector('span').textContent=song?txt('Cantar','Sing'):txt('Adicionar música','Add song');$('menuTvEnqueue').hidden=!song;
      $('menuTvArt').innerHTML=queueArt(song);hero.querySelector('.menu-tv-backdrop').style.backgroundImage=song?.cover?`url("${mediaUrl(song.cover)}")`:'';
      if(activePage)hero.hidden=true;
    }
    refreshQueue();
  }
  // No additional render loop: the shared engine emits playback transitions.
  const oldRender=render;render=function(){oldRender();refreshLibrary();};
  window.addEventListener('voxstage-queue-changed',refreshQueue);
  window.addEventListener('voxstage-score-playback',()=>queueMicrotask(refreshQueue));
  const oldPlay=playSong;playSong=async function(id){
    if(!songs.some(s=>s.id===id))return;const index=remoteSongQueue.indexOf(id);if(index>=0)remoteSongQueue.splice(index,1);
    try{return await oldPlay(id);}finally{refreshLibrary();}
  };
  const oldStop=stopSong;stopSong=function(){oldStop();$('nowTitle').textContent=txt('Escolha uma música','Choose a song');$('nowArtist').textContent=txt('Seu palco está esperando','The stage is waiting');setMiniStage(null);refreshQueue();};
  const oldNavigate=navigateSong;navigateSong=function(direction){const next=direction>0?nextPlaybackSong():null;if(next){void playSong(next);return;}oldNavigate(direction);};
  function positionSongMenu(button,menu){
    const r=button.getBoundingClientRect(),bottom=Math.min(innerHeight-10,document.querySelector('.player').getBoundingClientRect().top-8);
    menu.style.position='fixed';menu.style.right='auto';menu.style.bottom='auto';menu.style.maxHeight=`${Math.max(120,bottom-12)}px`;menu.style.overflowY='auto';
    const width=menu.getBoundingClientRect().width,height=menu.getBoundingClientRect().height;
    menu.style.left=`${Math.max(10,Math.min(r.right-width,innerWidth-width-10))}px`;
    menu.style.top=`${Math.max(10,Math.min(r.bottom+5,bottom-height))}px`;
  }
  function closeSongMenus(){
    document.querySelectorAll('.track-menu').forEach(menu=>{menu.hidden=true;});
    document.querySelectorAll('[data-menu-toggle]').forEach(b=>b.setAttribute('aria-expanded','false'));
  }
  window.addEventListener('resize',closeSongMenus);
  window.addEventListener('resize',sizeQueuePanel);
  stylesheet.addEventListener('load',sizeQueuePanel);
  document.fonts?.ready.then(sizeQueuePanel);
  window.addEventListener('scroll',()=>{
    sizeQueuePanel();
    const menu=document.querySelector('.track-menu:not([hidden])');if(!menu)return;
    const opener=document.querySelector(`[data-menu-toggle="${CSS.escape(menu.dataset.trackMenu)}"]`);if(opener)positionSongMenu(opener,menu);
  },{passive:true});
  if(device!=='tv')window.addEventListener('keydown',event=>{
    const menu=document.querySelector('.track-menu:not([hidden])');
    if(event.key==='Escape'&&menu){const opener=document.querySelector(`[data-menu-toggle="${CSS.escape(menu.dataset.trackMenu)}"]`);closeSongMenus();opener?.focus({preventScroll:true});event.preventDefault();event.stopImmediatePropagation();}
  },true);
  if(device==='tv')requestAnimationFrame(()=>{if(!document.querySelector('.setup-wizard.show,.remote-panel.show'))$('menuTvSing').focus({preventScroll:true});});
  window.VoxStageMenu={device,icon,txt,get page(){return activePage;},showLibrary:()=>showLibrary(false),openPage(key,label,opener){
    leaveConnectionPage();activePage=key;body.dataset.menuPage=key;notifyPage(key);welcome.hidden=true;layout.hidden=true;hero.hidden=true;
    for(const node of [libraryButton,favoritesButton,add,settings,connection])node?.removeAttribute('aria-current');
    opener?.setAttribute('aria-current','page');crumbs.textContent=label;
    if(queueDialog.open)queueDialog.close();
  }};
  render();window.__voxstageMenuReady=true;
})();
