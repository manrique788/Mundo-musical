(() => {
"use strict";
const $ = id => document.getElementById(id);
const audio = $("audio");
const API = "https://mundo-musical-api.manriquewb1234.workers.dev/catalog";
const PAGE_SIZE = 100;
const ALL_GENRES = "__all__";
const OFFLINE_DB = "music-offline-v2";
const DELETED_SONGS_KEY = "music-deleted-songs-v1";
const DELETED_FOLDERS_KEY = "music-deleted-folders-v1";
const CATALOG_CACHE_KEY = "music-catalog-v1";
const MUSIC_CACHE_PURGE_KEY = "music-cache-purge-v1";
const MUSIC_CACHE_PURGE_VERSION = "2026-11-20-stream-only-v1";
let offlineDbPromise = null;
let activeObjectUrl = "";
let songs = [];
let folders = [];
let activeFolder = "";
let folderSearchTerm = "";
let activeGenre = ALL_GENRES;
let queue = [];
let currentIndex = -1;
let shuffleEnabled = false;
let lifetimeAccess = false;
let streamingConfigured = false;
let paymentsConfigured = false;
let pendingAccessMessage = "";
let pendingPaymentReturn = false;

let visibleLimit = PAGE_SIZE;
let requestId = 0;
let mediaRecoveryId = -1;
let toastTimer = 0;
const history = [];
const palettes = ["#263f70","#50326f","#155c67","#70432d","#3b4e86","#32664e","#74405c","#315b79"];
const GENERIC_KEY_PREFIXES = new Set(["audio","audios","arquivo","arquivos","biblioteca","catalog","catalogo","files","media","midia","mp3","music","musica","musicas","mundo-musical","music-vip","public","song","songs","track","tracks","upload","uploads"]);
const FAVORITES_KEY = "music-favorites-v1";
function getFavorites(){try{return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY)||"[]"));}catch(_){return new Set();}}
function isFavorite(song){return !!song && getFavorites().has(song.audioUrl);}
function toggleFavorite(){const song=songs[currentIndex];if(!song)return;const favorites=getFavorites();if(favorites.has(song.audioUrl))favorites.delete(song.audioUrl);else favorites.add(song.audioUrl);try{localStorage.setItem(FAVORITES_KEY,JSON.stringify(Array.from(favorites)));}catch(_){}renderDrawer();showToast(favorites.has(song.audioUrl)?"Adicionada aos favoritos":"Removida dos favoritos");}

function safeText(value) { return String(value == null ? "" : value); }
function escapeHtml(value) {
  return safeText(value).replace(/[&<>"']/g, function(c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function formatTime(value) {
  if (!Number.isFinite(value)) return "0:00";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return mins + ":" + String(secs).padStart(2,"0");
}
function displayArtist(value) {
  const artist = safeText(value || "Music").trim();
  return /mundo\s+musical/i.test(artist) ? "Music" : artist;
}
function updateMarquee(element,text) {
  if (!element) return;
  const value = safeText(text);
  element.classList.remove("is-marquee");
  element.textContent = value;
  requestAnimationFrame(function() {
    element.classList.add("is-marquee");
    element.innerHTML = "<span class=\"marquee-track\"><span></span><span aria-hidden=\"true\"></span></span>";
    const spans = element.querySelectorAll(".marquee-track > span");
    spans.forEach(function(span){ span.textContent = value; });
    element.style.setProperty("--marquee-distance", "-" + Math.ceil(spans[0].scrollWidth + 34) + "px");
  });
}
function folderFromSong(song) {
  if (song.genre && song.audioUrl) {
    try {
      const path = new URL(song.audioUrl).pathname.split("/").filter(Boolean);
      if (path.length >= 2) return decodeURIComponent(path[path.length - 2]);
    } catch (_) {}
  }
  const raw = safeText(song.key || song.name || song.audioUrl || "");
  const parts = raw.replace(/\\/g,"/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : safeText(song.genre || "Outros");
}
function normalizeGenre(value) {
  return safeText(value).trim().normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR");
}
function genreFromSong(song) {
  const folder = safeText(song.folder || folderFromSong(song)).trim();
  const explicitGenre = safeText(song.genre).trim();
  if (explicitGenre && normalizeGenre(explicitGenre) !== normalizeGenre(folder)) return explicitGenre;
  const pathFolders = safeText(song.key).replace(/\\/g,"/").split("/").filter(Boolean).slice(0,-1);
  for (const segment of pathFolders) {
    const normalized = normalizeGenre(segment);
    if (!normalized || GENERIC_KEY_PREFIXES.has(normalized) || /^(19|20)\d{2}$/.test(normalized)) continue;
    return segment.trim();
  }
  return folder || "Outros";
}
function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function canAccessSong(song) { return Boolean(song && lifetimeAccess && getAuthToken() && song.streamUrl && navigator.onLine !== false); }
function requestPremiumAccess(message) {
  if (lifetimeAccess) return true;
  pendingAccessMessage = safeText(message || "Este conteúdo exige uma conta e acesso vitalício.");
  const loggedIn = Boolean(getAuthToken());
  openAccount(loggedIn ? "profile" : initialAccountMode());
  $("accountDescription").textContent = loggedIn
    ? pendingAccessMessage + " O acesso completo custa R$ 15,00 em pagamento único."
    : pendingAccessMessage + " Crie sua conta ou entre para ver o plano vitalício de R$ 15,00.";
  return false;
}
function openOfflineDb() {
  if (offlineDbPromise) return offlineDbPromise;
  offlineDbPromise = new Promise(function(resolve,reject) {
    const request = indexedDB.open(OFFLINE_DB,1);
    request.onupgradeneeded = function() { request.result.createObjectStore("audio",{keyPath:"url"}); };
    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function() { reject(request.error); };
  });
  return offlineDbPromise;
}
function getDeletedSongs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DELETED_SONGS_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch (_) { return new Set(); }
}
function rememberDeletedSong(url) {
  const deleted = getDeletedSongs();
  deleted.add(url);
  try { localStorage.setItem(DELETED_SONGS_KEY,JSON.stringify(Array.from(deleted))); } catch (_) {}
}
function getDeletedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(DELETED_FOLDERS_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch (_) { return new Set(); }
}
function rememberDeletedFolder(name) {
  const deleted = getDeletedFolders();
  deleted.add(name);
  try { localStorage.setItem(DELETED_FOLDERS_KEY,JSON.stringify(Array.from(deleted))); } catch (_) {}
}
function offlineDelete(url) {
  return openOfflineDb().then(function(db) { return new Promise(function(resolve) {
    const request = db.transaction("audio","readwrite").objectStore("audio").delete(url);
    request.onsuccess = request.onerror = function() { resolve(); };
  }); }).catch(function() {});
}
async function clearOfflineMusic() {
  if (!window.indexedDB) return;
  const db = await openOfflineDb();
  await new Promise(function(resolve,reject) {
    const transaction = db.transaction("audio","readwrite");
    transaction.objectStore("audio").clear();
    transaction.oncomplete = resolve;
    transaction.onerror = function() { reject(transaction.error); };
    transaction.onabort = function() { reject(transaction.error); };
  });
}
async function purgeLegacyMusicCacheOnce() {
  try {
    if (localStorage.getItem(MUSIC_CACHE_PURGE_KEY) === MUSIC_CACHE_PURGE_VERSION) return;
  } catch (_) {}
  try {
    localStorage.removeItem(CATALOG_CACHE_KEY);
    localStorage.removeItem(DELETED_SONGS_KEY);
    localStorage.removeItem(DELETED_FOLDERS_KEY);
  } catch (_) {}
  try {
    await clearOfflineMusic();
    localStorage.setItem(MUSIC_CACHE_PURGE_KEY,MUSIC_CACHE_PURGE_VERSION);
  } catch (error) {
    console.warn("Não foi possível concluir a limpeza do catálogo offline:",error);
  }
}
function offlineStatus(text) { const el = $("offlineStatus"); if (el) el.textContent = text; const label = $("offlineProgressLabel"); if (label) label.textContent = text; }
function offlineProgress(done,total) {
  const bar = $("offlineProgress");
  const fill = $("offlineProgressFill");
  if (!bar || !fill) return;
  const percent = total ? Math.min(100,Math.round(done / total * 100)) : 0;
  fill.style.width = percent + "%";
  bar.title = total ? "Músicas disponíveis offline: " + done + "/" + total : "Offline";
  bar.classList.toggle("complete",total > 0 && done >= total);
}
function buildFolderList() {
  const counts = new Map();
  const folderFirstSeen = new Map();
  const folderGenres = new Map();
  songs.forEach(function(song,index) {
    counts.set(song.folder,(counts.get(song.folder)||0)+1);
    if (!folderGenres.has(song.folder)) folderGenres.set(song.folder,genreFromSong(song));
    if (!folderFirstSeen.has(song.folder)) folderFirstSeen.set(song.folder,index);
  });
  folders = Array.from(counts.entries()).map(entry => ({name:entry[0],count:entry[1],genre:folderGenres.get(entry[0])||entry[0]}))
    .sort((a,b) => {
      const priority = function(name) {
        const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
        if (normalized.includes("mega funk")) return 1;
        if (normalized.includes("funk") && !normalized.includes("eletro")) return 0;
        return 2;
      };
      return priority(a.name) - priority(b.name) ||
        ((folderFirstSeen.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (folderFirstSeen.get(b.name) ?? Number.MAX_SAFE_INTEGER));
    });
}
function saveCatalogSnapshot(items) {
  const snapshotSongs = (Array.isArray(items) ? items : songs).map(function(song) {
    return {
      key:safeText(song.key),
      title:safeText(song.title),
      artist:displayArtist(song.artist),
      folder:safeText(song.folder),
      audioUrl:safeText(song.audioUrl)
    };
  });
  try {
    localStorage.setItem(CATALOG_CACHE_KEY,JSON.stringify({version:1,lifetimeAccess:Boolean(lifetimeAccess),songs:snapshotSongs}));
  } catch (_) {}
}
function showAuthenticationRequired() {
  accountGateActive=true;
  lifetimeAccess=false;streamingConfigured=false;
  requestId++;audio.pause();audio.removeAttribute("src");audio.load();
  if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";}
  songs=[];folders=[];queue=[];activeFolder="";currentIndex=-1;
  activeGenre=ALL_GENRES;
  $("folderView").hidden=true;document.body.classList.remove("in-folder");
  $("genreTabs").hidden=true;$("genreTabs").innerHTML="";
  $("genreCards").hidden=false;
  $("genreCards").innerHTML='<div class="loading-card">Entre ou crie uma conta para acessar a biblioteca MUSIC VIP.</div>';
  $("trackCount").textContent="—";$("folderCount").textContent="—";$("folderTotal").textContent="Acesso para membros";
  updateMarquee($("currentTitle"),"Acesse sua conta");
  $("currentArtist").textContent="Entre para desbloquear sua música";
  offlineStatus("Entre para acessar a biblioteca");
  updateButtons();
}
async function loadCatalog() {
  await purgeLegacyMusicCacheOnce();
  if(!getAuthToken()){
    showAuthenticationRequired();
    await clearOfflineMusic().catch(()=>{});
    return;
  }
  $("genreCards").innerHTML = '<div class="loading-card">Carregando sua biblioteca...</div>';
  try {
    const all = [];
    let cursor = "";
    let pageCount = 0;
    let catalogAccess = null;
    do {
      const url = new URL(API);
      url.searchParams.set("limit","1000");
      if (cursor) url.searchParams.set("cursor",cursor);
      const headers = {};
      const token = getAuthToken();
      if (token) headers.Authorization = "Bearer " + token;
      const response = await fetch(url.toString(), {headers:headers,cache:"no-store"});
      if (!response.ok) {const error=new Error("Catálogo respondeu HTTP " + response.status);error.status=response.status;throw error;}
      const data = await response.json();
      if (!Array.isArray(data.songs)) throw new Error("Formato de catálogo inesperado");
      if (data.access) catalogAccess = data.access;
      all.push.apply(all,data.songs);
      cursor = data.nextCursor || "";
      pageCount++;
      if (pageCount > 100) throw new Error("Paginação interrompida por segurança");
    } while (cursor);
    lifetimeAccess = Boolean(catalogAccess && catalogAccess.lifetimeAccess);
    streamingConfigured = Boolean(catalogAccess && catalogAccess.streamingConfigured);

    // Uma resposta vazia do servidor é definitiva: não ressuscite cópias antigas do aparelho.
    if (all.length === 0) {
      songs = [];
      folders = [];
      activeGenre = ALL_GENRES;
      renderGenreTabs();
      queue = [];
      activeFolder = "";
      currentIndex = -1;
      requestId++;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = ""; }
      try {
        localStorage.removeItem(CATALOG_CACHE_KEY);
        localStorage.removeItem(DELETED_SONGS_KEY);
        localStorage.removeItem(DELETED_FOLDERS_KEY);
      } catch (_) {}
      try { await clearOfflineMusic(); }
      catch (error) { console.warn("Não foi possível limpar as músicas offline:",error); }
      $("folderView").hidden = true;
      document.body.classList.remove("in-folder");
      $("genreCards").hidden = false;
      updateMarquee($("currentTitle"),"Escolha uma pasta");
      $("currentArtist").textContent = "Nenhuma faixa disponível";
      $("currentCover").innerHTML = "<span>♫</span>";
      $("trackCount").textContent = "0";
      $("folderCount").textContent = "0";
      $("folderTotal").textContent = "0 estações";
      $("genreCards").innerHTML = '<div class="loading-card">Nenhuma pasta de música disponível.</div>';
      offlineProgress(0,0);
      const bar = $("offlineProgress");
      if (bar) bar.classList.remove("busy");
      offlineStatus("Nenhuma música disponível offline");
      updateButtons();
      return;
    }

    const seen = new Set();
    const deletedSongs = getDeletedSongs();
    const deletedFolders = getDeletedFolders();
    songs = all.map(function(song, index) {
      const audioUrl = safeText(song.audioUrl || song.url).trim();
      const title = safeText(song.title || song.name).trim();
      if (!audioUrl || !title) return null;
      const key = audioUrl;
      if (seen.has(key)) return null;
      seen.add(key);
      return Object.assign({}, song, {
        title:title,
        artist:displayArtist(song.artist || "Music"),
        audioUrl:audioUrl,
        streamUrl:safeText(song.streamUrl).trim(),
        folder:safeText(song.folder || folderFromSong(Object.assign({},song,{audioUrl:audioUrl}))),
        _index:index
      });
    }).filter(Boolean).filter(function(song){ return !deletedSongs.has(song.audioUrl) && !deletedFolders.has(song.folder); }).map(function(song,index){ return Object.assign({},song,{_index:index}); });

    if (!songs.length) throw new Error("Nenhuma faixa válida foi encontrada.");
    buildFolderList();
    saveCatalogSnapshot();
    renderFolders();
    offlineStatus("Streaming protegido · reprodução online");
    $("trackCount").textContent = songs.length.toLocaleString("pt-BR");
    $("folderCount").textContent = folders.length.toLocaleString("pt-BR");
    $("folderTotal").textContent = folders.length + " pastas disponíveis";
  } catch (error) {
    console.error("Falha ao carregar catálogo:",error);
    if(error.status===401||error.status===403){
      rememberAccountUse();
      setAuthToken("");
      lifetimeAccess=false;
      await clearOfflineMusic().catch(()=>{});
      showAuthenticationRequired();
      openAccount(initialAccountMode());
      $("accountFeedback").textContent="Sua sessão expirou. Entre novamente para acessar a biblioteca.";
      return;
    }
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || "null"); } catch (_) {}
    const cachedSongs = Array.isArray(cached) ? cached : (cached && Array.isArray(cached.songs) ? cached.songs : []);
    const deletedSongs = getDeletedSongs();
    const deletedFolders = getDeletedFolders();
    lifetimeAccess = false;
    streamingConfigured = false;
    if(getAuthToken()){
      $("accountPlanDisplay").textContent="Plano: conecte-se para validar o acesso";
      $("premiumOffer").hidden=false;
      $("premiumActive").hidden=true;
      $("accountBtn").textContent="Minha conta";
    }
    requestId++;audio.pause();audio.removeAttribute("src");audio.load();
    if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";}
    currentIndex=-1;queue=[];activeFolder="";
    songs = cachedSongs.map(function(song,index) {
      const audioUrl = safeText(song.audioUrl).trim();
      const title = safeText(song.title).trim();
      if (!audioUrl || !title) return null;
      const folder = safeText(song.folder || folderFromSong(Object.assign({},song,{audioUrl:audioUrl})));
      return Object.assign({},song,{title:title,artist:displayArtist(song.artist),folder:folder,audioUrl:audioUrl,streamUrl:"",_index:index});
    }).filter(Boolean).filter(function(song) {
      return !deletedSongs.has(song.audioUrl) && !deletedFolders.has(song.folder);
    }).map(function(song,index){ return Object.assign({},song,{_index:index}); });
    if (songs.length) {
      buildFolderList();
      $("folderView").hidden = true;
      document.body.classList.remove("in-folder");
      $("genreCards").hidden = false;
      renderFolders();
      $("trackCount").textContent = songs.length.toLocaleString("pt-BR");
      $("folderCount").textContent = folders.length.toLocaleString("pt-BR");
      $("folderTotal").textContent = folders.length + " pastas disponíveis";
      offlineStatus(navigator.onLine ? "Servidor indisponível · áudio bloqueado até validar" : "Sem internet · áudio indisponível");
      updateButtons();
      return;
    }
    lifetimeAccess = false;
    songs=[];folders=[];queue=[];activeFolder="";currentIndex=-1;
    activeGenre=ALL_GENRES;
    $("folderView").hidden=true;document.body.classList.remove("in-folder");
    $("genreCards").hidden=false;
    renderGenreTabs();
    $("genreCards").innerHTML = '<div class="error-card"><strong>Não conseguimos conectar à biblioteca.</strong><span>Conecte-se à internet para carregar o catálogo e validar seu acesso. A reprodução de áudio exige uma sessão e autorização ativas no servidor.</span><button id="retryCatalog" type="button">Tentar novamente</button></div>';
    $("trackCount").textContent = "Indisponível"; $("folderCount").textContent="0"; $("folderTotal").textContent = "Catálogo indisponível";
    updateButtons();
  }
}
function renderGenreTabs() {
  const tabs = $("genreTabs");
  if (!tabs) return;
  const counts = new Map();
  folders.forEach(function(folder) {
    const genre = safeText(folder.genre || "Outros").trim() || "Outros";
    counts.set(genre,(counts.get(genre)||0)+1);
  });
  const genres = Array.from(counts.keys()).sort((a,b) => a.localeCompare(b,"pt-BR",{sensitivity:"base"}));
  if (activeGenre !== ALL_GENRES && !counts.has(activeGenre)) activeGenre = ALL_GENRES;
  if (!genres.length) {
    tabs.hidden = true;
    tabs.innerHTML = "";
    return;
  }
  const options = [{value:ALL_GENRES,label:"Todos",count:folders.length}].concat(genres.map(genre => ({value:genre,label:genre,count:counts.get(genre)})));
  tabs.hidden = false;
  tabs.innerHTML = options.map(function(option) {
    return '<button class="genre-tab" type="button" data-genre="' + escapeHtml(option.value) + '" aria-pressed="' + (activeGenre === option.value) + '"><span>' + escapeHtml(option.label) + '</span><span class="genre-tab-count">' + option.count.toLocaleString("pt-BR") + '</span></button>';
  }).join("");
}
function renderFolders() {
  renderGenreTabs();
  const search = normalizeGenre(folderSearchTerm);
  const filteredFolders = folders.filter(function(folder) {
    const matchesGenre = activeGenre === ALL_GENRES || folder.genre === activeGenre;
    const matchesSearch = !search || normalizeGenre(folder.name).includes(search) || normalizeGenre(folder.genre).includes(search);
    return matchesGenre && matchesSearch;
  });
  const count = filteredFolders.length.toLocaleString("pt-BR");
  const noun = filteredFolders.length === 1 ? "pasta" : "pastas";
  $("folderTotal").textContent = search ? count + " " + noun + " encontradas" : activeGenre === ALL_GENRES ? count + " " + noun + " disponíveis" : count + " " + noun + " em " + activeGenre;
  if (!filteredFolders.length) {
    $("genreCards").innerHTML = '<div class="loading-card">Nenhuma pasta encontrada neste gênero. Escolha outro gênero ou ajuste a busca.</div>';
    return;
  }
  $("genreCards").innerHTML = filteredFolders.map(function(folder,index) {
    const badgeText = lifetimeAccess ? "ACESSO LIBERADO" : "DESBLOQUEAR";
    const badgeClass = lifetimeAccess ? "folder-access-badge" : "folder-access-badge is-locked";
    return '<div class="folder-card" data-folder="' + escapeHtml(folder.name) + '" role="button" tabindex="0" style="--folder-color:' + palettes[index % palettes.length] + '">' +
      '<div class="folder-menu-wrap"><button class="folder-menu" type="button" data-folder-menu="' + escapeHtml(folder.name) + '" aria-label="Opções da pasta ' + escapeHtml(folder.name) + '" title="Opções da pasta">⋯</button><div class="folder-menu-popover" data-folder-popover="' + escapeHtml(folder.name) + '" hidden><button type="button" data-delete-folder="' + escapeHtml(folder.name) + '">Excluir</button></div></div>' +
      '<span class="folder-art"><span>♫</span><i></i></span>' +
      '<span class="folder-name">' + escapeHtml(folder.name) + '</span>' +
      '<span class="folder-count">' + folder.count.toLocaleString("pt-BR") + (folder.count === 1 ? " música" : " músicas") + '</span>' +
      '<span class="' + badgeClass + '">' + badgeText + '</span>' +
      '<span class="folder-arrow">▶</span><span class="folder-download" data-download-folder="' + escapeHtml(folder.name) + '" role="button" tabindex="0" title="Baixar pasta" aria-label="Baixar pasta">⇩</span></div>';
  }).join("");
}
function safeFileName(value) {
  return safeText(value).replace(/[\\/:*?"<>|]/g,"-").replace(/\s+/g," ").trim().slice(0,150);
}
async function downloadFolder(folderName) {
  const tracks = songs.filter(song => song.folder === folderName);
  if (!tracks.length || !window.fflate) return;
  if (!lifetimeAccess) { requestPremiumAccess("Para baixar esta pasta, desbloqueie o acesso vitalício por R$ 15,00."); return; }
  if (!confirm("Baixar " + tracks.length + " músicas da pasta “" + folderName + "” em um arquivo ZIP?")) return;
  const files = {};
  try {
    for (let i=0; i<tracks.length; i++) {
      showToast("Preparando download: " + (i+1) + "/" + tracks.length);
      if (!canAccessSong(tracks[i])) throw new Error("O acesso mudou durante o download");
      if (!tracks[i].streamUrl) throw new Error("Streaming seguro indisponível");
      const response = await fetch(tracks[i].streamUrl,{mode:"cors",cache:"no-store"});
      if (!response.ok) throw new Error("HTTP " + response.status);
      const path = new URL(tracks[i].audioUrl).pathname;
      const extension = (path.match(/\.[a-z0-9]+$/i) || [".mp3"])[0];
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!canAccessSong(tracks[i])) throw new Error("O acesso mudou durante o download");
      files[String(i+1).padStart(3,"0") + " - " + safeFileName(tracks[i].title) + extension] = bytes;
    }
    if (!tracks.every(canAccessSong)) throw new Error("O acesso mudou durante o download");
    showToast("Compactando a pasta…");
    const zip = window.fflate.zipSync(files,{level:0});
    const url = URL.createObjectURL(new Blob([zip],{type:"application/zip"}));
    const link = document.createElement("a");
    link.href=url; link.download=safeFileName(folderName)+".zip";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url),60000);
    showToast("Download iniciado");
  } catch (error) {
    console.error(error); showToast("Não foi possível baixar esta pasta");
  }
}
function openFolder(name, shouldPlay) {
  if (!lifetimeAccess) {
    requestPremiumAccess("Esta pasta está bloqueada. Entre na sua conta para ver o plano vitalício.");
    return;
  }
  activeFolder = name;
  document.body.classList.add("in-folder");
  queue = songs.filter(song => song.folder === name).map(song => song._index);
  visibleLimit = PAGE_SIZE;
  $("folderView").hidden = false;
  $("genreCards").hidden = true;
  $("folderView").scrollIntoView({behavior:"smooth",block:"start"});
  $("listTitle").textContent = name;
  $("folderSubtitle").textContent = queue.length.toLocaleString("pt-BR") + " músicas nesta pasta";
  renderSongList();
  if (shouldPlay && queue.length) playSong(queue[0]);
}
function closeFolder() {
  $("folderView").hidden = true;
  document.body.classList.remove("in-folder");
  $("genreCards").hidden = false;
  activeFolder = "";
  queue = [];
  $("genreCards").scrollIntoView({behavior:"smooth",block:"start"});
}
function renderSongList() {
  renderDrawer();
  const shown = queue.slice(0,visibleLimit);
  $("songList").innerHTML = shown.map(function(songIndex,position) {
    const song = songs[songIndex];
    const playing = songIndex === currentIndex && !audio.paused;
    const unlocked = canAccessSong(song);
    const color = palettes[position % palettes.length];
    return '<button type="button" class="song-row ' + (playing ? "playing " : "") + (unlocked ? "" : "is-locked") + '" data-song-index="' + songIndex + '">' +
      '<span class="song-number">' + String(position+1).padStart(2,"0") + '</span>' +
      '<span class="song-cover" style="--cover-color:' + color + '">♫</span>' +
      '<span class="song-info"><strong>' + escapeHtml(song.title) + '</strong><small>' + escapeHtml(song.artist) + '</small></span>' +
      (unlocked ? '' : '<span class="song-access-badge is-locked">ACESSO VITALÍCIO</span>') +
      '<span class="song-play-icon">' + (playing ? "Ⅱ" : "▶") + '</span></button>';
  }).join("");
  const remaining = queue.length - shown.length;
  $("loadMoreSongs").hidden = remaining <= 0;
  $("loadMoreSongs").textContent = remaining > 0 ? "Carregar mais " + Math.min(PAGE_SIZE,remaining) + " músicas · " + remaining + " restantes" : "";
}
function renderDrawer() {
  const title = $("drawerTitle");
  if (!title) return;
  const current = songs[currentIndex];
  updateMarquee(title,current ? current.title : "Nenhuma música selecionada");
  $("drawerArtist").textContent = current ? displayArtist(current.artist) : "Escolha uma música para começar";
  $("drawerFolder").textContent = activeFolder || "Sua música";
  $("drawerShuffleBtn").classList.toggle("active",shuffleEnabled);
  $("drawerShuffleBtn").setAttribute("aria-pressed",String(shuffleEnabled));
  $("drawerShuffleBtn").setAttribute("aria-label",shuffleEnabled?"Aleatório ligado":"Aleatório desligado");
  $("drawerPlayBtn").textContent = audio.paused ? "▶" : "Ⅱ";
  $("drawerPlayBtn").setAttribute("aria-label",audio.paused?"Reproduzir":"Pausar");
  $("drawerFavoriteBtn").textContent = isFavorite(current) ? "♥" : "♡";
  $("drawerFavoriteBtn").classList.toggle("active",isFavorite(current));
  $("drawerFavoriteBtn").setAttribute("aria-pressed",String(isFavorite(current)));
  const cover = $("drawerCover");
  if(cover){cover.innerHTML='<span>♫</span><small>'+escapeHtml(current ? (current.folder || "MUSIC") : "MUSIC")+'</small>';}
  $("drawerVolume").value = String(audio.volume);
}
function deleteCurrentSong() {
  const song = songs[currentIndex];
  if (!song) { showToast("Nenhuma música está tocando."); return; }
  if (!window.confirm("Excluir esta música somente deste aparelho?\n\n" + song.title + "\n\nO arquivo original do servidor não será apagado.")) return;
  const deletedUrl = song.audioUrl;
  rememberDeletedSong(deletedUrl);
  offlineDelete(deletedUrl);
  requestId++;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = ""; }
  currentIndex = -1;
  queue = [];
  const folderToKeep = activeFolder;
  try {
  const remaining = songs.filter(function(item){ return item.audioUrl !== deletedUrl; })
      .map(function(item,index){ return Object.assign({},item,{_index:index}); });
    saveCatalogSnapshot(remaining);
  } catch (_) {}
  showToast("Música excluída deste aparelho");
  loadCatalog().then(function() {
    if (folderToKeep && folders.some(function(folder){ return folder.name === folderToKeep; })) openFolder(folderToKeep,false);
    renderDrawer();
  });
}
function deleteFolder(folderName) {
  const tracks = songs.filter(function(song){ return song.folder === folderName; });
  if (!tracks.length) { showToast("Esta pasta já está vazia."); return; }
  if (!window.confirm("Excluir a pasta “" + folderName + "” deste aparelho?\n\n" + tracks.length + " músicas serão removidas da lista e do armazenamento offline.\n\nOs arquivos originais do servidor não serão apagados.")) return;
  rememberDeletedFolder(folderName);
  tracks.forEach(function(song){ rememberDeletedSong(song.audioUrl); offlineDelete(song.audioUrl); });
  if (activeFolder === folderName || (songs[currentIndex] && songs[currentIndex].folder === folderName)) {
    requestId++;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = ""; }
    currentIndex = -1;
    queue = [];
    activeFolder = "";
  }
  const remaining = songs.filter(function(song){ return song.folder !== folderName; })
    .map(function(song,index){ return Object.assign({},song,{_index:index}); });
  saveCatalogSnapshot(remaining);
  showToast("Pasta excluída deste aparelho");
  loadCatalog();
}
function openPlayerDrawer() {
  renderDrawer();
  $("playerDrawer").hidden = false;
  document.body.classList.add("player-open");
}
function closePlayerDrawer() {
  $("playerDrawer").hidden = true;
  document.body.classList.remove("player-open");
}
function switchFolder(direction) {
  if (!folders.length) return;
  let currentFolderIndex = folders.findIndex(folder => folder.name === activeFolder);
  if (currentFolderIndex < 0) currentFolderIndex = 0;
  const nextIndex = (currentFolderIndex + direction + folders.length) % folders.length;
  if (!lifetimeAccess) {
    requestPremiumAccess("Esta pasta está bloqueada. Entre na sua conta para ver o plano vitalício.");
    return;
  }
  openFolder(folders[nextIndex].name,true);
  renderDrawer();
  showToast("Pasta: " + folders[nextIndex].name);
}
function currentQueuePosition() { return queue.indexOf(currentIndex); }
function nextSongIndex(direction) {
  if (!queue.length) return -1;
  if (shuffleEnabled && direction > 0 && queue.length > 1) {
    const options = queue.filter(index => index !== currentIndex);
    return options[Math.floor(Math.random()*options.length)];
  }
  let pos = currentQueuePosition();
  if (pos < 0) pos = direction > 0 ? -1 : 0;
  let next = pos + direction;
  if (next >= queue.length) return -1;
  if (next < 0) return queue[0];
  return queue[next];
}
function playSong(index) {
  const song = songs[index];
  if (!song) return;
  if (!getAuthToken() || !lifetimeAccess) { requestPremiumAccess("Esta música está bloqueada. Entre ou crie sua conta para ver o plano vitalício."); return; }
  if (navigator.onLine === false || !song.streamUrl) { showToast("Conecte-se para validar o acesso e reproduzir esta música."); return; }
  const id = ++requestId;
  currentIndex = index;
  if (!queue.includes(index)) { activeFolder = song.folder; queue = songs.filter(item => item.folder === activeFolder).map(item => item._index); }
  audio.pause();
  audio.volume = Number($("volume").value || 0.8);
  updateMarquee($("currentTitle"),song.title); $("currentArtist").textContent = displayArtist(song.artist); $("currentCover").innerHTML = "<span>♫</span>"; $("playBtn").textContent = "Ⅱ";
  if (!history.includes(index)) history.unshift(index); if (history.length > 30) history.pop();
  updateMediaMetadata(song); renderSongListIfOpen(); openPlayerDrawer();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = "";

  audio.src = song.streamUrl;
  audio.load();
  const playRequest = audio.play();
  if (playRequest && typeof playRequest.then === "function") {
    playRequest.then(function() {
      if (id === requestId) { $("playBtn").textContent = "Ⅱ"; updateMediaState("playing"); }
    }).catch(function(error) {
      if (id !== requestId) return;
      console.warn("Reprodução online falhou:",error);
      recoverMediaFailure(song,id);
    });
  }
}
async function recoverMediaFailure(song,id) {
  if (!song || id !== requestId || mediaRecoveryId === id) return;
  mediaRecoveryId = id;
  try {
    if (getAuthToken() && navigator.onLine !== false) {
      try {
        const account = await authRequest("/auth/me","GET");
        if (id !== requestId) return;
        const wasLifetime = lifetimeAccess;
        lifetimeAccess = Boolean(account.lifetimeAccess);
        $("accountPlanDisplay").textContent = lifetimeAccess ? "Plano: acesso vitalício ativo" : "Plano: ainda sem acesso vitalício";
        $("premiumOffer").hidden = lifetimeAccess;
        $("premiumActive").hidden = !lifetimeAccess;
        $("accountBtn").textContent = lifetimeAccess ? "Minha conta · VIP" : "Minha conta";
        if (wasLifetime && !lifetimeAccess) {
          accountGateActive=false;
          requestId++;audio.pause();audio.removeAttribute("src");audio.load();
          if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = ""; }
          currentIndex = -1;queue = [];activeFolder = "";
          await clearOfflineMusic().catch(()=>{});
          renderFolders();renderSongListIfOpen();saveCatalogSnapshot();
          showToast("O acesso vitalício não está ativo. Confira o plano de R$ 15,00.");
          openAccount("profile");
          return;
        }
      } catch (error) {
        if (id !== requestId) return;
        if (error.status === 401 || error.status === 403) {
          await refreshAccount();
          showToast("Sua sessão expirou. Entre novamente para continuar.");
          return;
        }
        console.warn("Não foi possível validar a sessão após erro de áudio:",error);
      }
    }
    if (id === requestId) showToast(navigator.onLine === false
      ? "Sem conexão: a reprodução protegida exige internet."
      : "Não foi possível acessar o áudio protegido. Tente novamente.");
  } finally {
    if (mediaRecoveryId === id) mediaRecoveryId = -1;
  }
}
function renderSongListIfOpen() {
  if (!$("folderView").hidden) renderSongList();
}
function togglePlay() {
  if (currentIndex < 0) {
    if (activeFolder && queue.length) playSong(queue[0]);
    else if (folders.length) openFolder(folders[0].name,true);
    return;
  }
  if (audio.paused) {
    if (navigator.onLine === false) { showToast("Conecte-se à internet para reproduzir áudio protegido."); return; }
    if (!canAccessSong(songs[currentIndex])) { playSong(currentIndex); return; }
    if (!audio.src || audio.readyState === 0) {
      playSong(currentIndex);
      return;
    }
    audio.play().catch(() => playSong(currentIndex));
  }
  else audio.pause();
}
function skip(direction) {
  const next = nextSongIndex(direction);
  if (next < 0) {
    audio.pause();
    $("playBtn").textContent = "▶";
    showToast("Fim da pasta. Escolha outra estação para continuar.");
    return;
  }
  playSong(next);
}
function updateMediaMetadata(song) {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:song.title, artist:song.artist, album:"Music Rádio"
    });
  } catch (_) {}
}
function updateMediaState(state) {
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = state; } catch (_) {}
  }
}
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play:togglePlay,
    pause:() => audio.pause(),
    nexttrack:() => skip(1),
    previoustrack:() => skip(-1)
  };
  Object.keys(actions).forEach(function(action) {
    try { navigator.mediaSession.setActionHandler(action,actions[action]); } catch (_) {}
  });
}
function updateButtons() {
  renderDrawer();
  const playing = !audio.paused && !audio.ended;
  $("playBtn").textContent = playing ? "Ⅱ" : "▶";
  $("shuffleBtn").classList.toggle("active",shuffleEnabled);
  if($("drawerPlayBtn")){$("drawerPlayBtn").textContent=playing?"Ⅱ":"▶";$("drawerPlayBtn").setAttribute("aria-label",playing?"Pausar":"Reproduzir");}
}
function setVolume(value) {
  audio.volume = Number(value);
  $("volume").value = String(value);
}
$("genreTabs").addEventListener("click",function(event) {
  const tab = event.target.closest("[data-genre]");
  if (!tab) return;
  activeGenre = tab.dataset.genre || ALL_GENRES;
  renderFolders();
});
$("genreCards").addEventListener("click",function(event) {
  const deleteFolderAction = event.target.closest("[data-delete-folder]");
  if (deleteFolderAction) { event.preventDefault(); event.stopPropagation(); deleteFolder(deleteFolderAction.dataset.deleteFolder); return; }
  const folderMenu = event.target.closest("[data-folder-menu]");
  if (folderMenu) {
    event.preventDefault(); event.stopPropagation();
    const card = folderMenu.closest("[data-folder]");
    const popover = card && card.querySelector("[data-folder-popover]");
    document.querySelectorAll("[data-folder-popover]").forEach(function(item){ if (item !== popover) item.hidden = true; });
    if (popover) popover.hidden = !popover.hidden;
    return;
  }
  const download = event.target.closest("[data-download-folder]");
  if (download) { event.preventDefault(); event.stopPropagation(); downloadFolder(download.dataset.downloadFolder); return; }
  const retry = event.target.closest("#retryCatalog");
  if (retry) { loadCatalog(); return; }
  const card = event.target.closest("[data-folder]");
  if (card) openFolder(card.dataset.folder,false);
});
$("genreCards").addEventListener("keydown",function(event) {
  const card = event.target.closest("[data-folder]");
  if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openFolder(card.dataset.folder,false); }
});
$("backFoldersBtn").addEventListener("click",closeFolder);
$("folderSearch").addEventListener("input",function(event){
  folderSearchTerm = safeText(event.target.value).trim().toLocaleLowerCase("pt-BR");
  renderFolders();
});
$("playFolderBtn").addEventListener("click",function(){if(queue.length)playSong(queue[0]);});
$("loadMoreSongs").addEventListener("click",function(){visibleLimit += PAGE_SIZE;renderSongList();});
$("songList").addEventListener("click",function(event) {
  const row = event.target.closest("[data-song-index]");
  if (row) {
    const index = Number(row.dataset.songIndex);
    if (index === currentIndex && !audio.paused) audio.pause();
    else playSong(index);
  }
});
$("expandPlayerBtn").addEventListener("click",openPlayerDrawer);
$("closePlayerBtn").addEventListener("click",closePlayerDrawer);
$("drawerBackdrop").addEventListener("click",closePlayerDrawer);
$("drawerPlayBtn").addEventListener("click",togglePlay);
$("drawerFavoriteBtn").addEventListener("click",toggleFavorite);
$("drawerVolume").addEventListener("input",event=>{setVolume(event.target.value);});
$("drawerProgress").addEventListener("input",function(event){if(audio.duration)audio.currentTime=audio.duration*Number(event.target.value)/100;});
$("drawerShuffleBtn").addEventListener("click",function(){
  shuffleEnabled = !shuffleEnabled;
  updateButtons(); renderDrawer();
  showToast(shuffleEnabled ? "Aleatório ligado" : "Aleatório desligado");
});
$("drawerPrevFolderBtn").addEventListener("click",function(){switchFolder(-1);});
$("drawerNextFolderBtn").addEventListener("click",function(){switchFolder(1);});

$("prevFolderCompactBtn").addEventListener("click",function(){switchFolder(-1);});
$("nextFolderCompactBtn").addEventListener("click",function(){switchFolder(1);});
$("drawerPrevSongBtn").addEventListener("click",function(){skip(-1);});
$("drawerNextSongBtn").addEventListener("click",function(){skip(1);});
$("playBtn").addEventListener("click",togglePlay);
$("prevBtn").addEventListener("click",function(){skip(-1);});
$("nextBtn").addEventListener("click",function(){skip(1);});
$("shuffleBtn").addEventListener("click",function(){shuffleEnabled = !shuffleEnabled;updateButtons();showToast(shuffleEnabled ? "Aleatório ativado" : "Aleatório desativado");});

$("volume").addEventListener("input",event => setVolume(event.target.value));
$("progress").addEventListener("input",function(event) {
  if (audio.duration) audio.currentTime = audio.duration * Number(event.target.value) / 100;
});
audio.addEventListener("timeupdate",function() {
  $("currentTime").textContent = formatTime(audio.currentTime);
  $("duration").textContent = formatTime(audio.duration);
  $("drawerCurrentTime").textContent = formatTime(audio.currentTime);
  $("drawerDuration").textContent = formatTime(audio.duration);
  const percent = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
  $("drawerProgress").value = percent;
  $("drawerProgress").style.setProperty("--progress-percent",percent + "%");
  $("progress").value = percent;
  $("progress").style.setProperty("--progress-percent",percent + "%");
});
audio.addEventListener("ended",function() {
  skip(1);
});
audio.addEventListener("play",function(){updateButtons();updateMediaState("playing");renderSongListIfOpen();});
audio.addEventListener("pause",function(){updateButtons();updateMediaState("paused");renderSongListIfOpen();});
audio.addEventListener("error",function(){
  const song=songs[currentIndex];
  if(song)recoverMediaFailure(song,requestId);
  else showToast("Erro ao carregar o áudio.");
});
document.addEventListener("visibilitychange",function(){
  if (!document.hidden && currentIndex >= 0) updateMediaMetadata(songs[currentIndex]);
});
window.addEventListener("online",function(){ offlineStatus("Internet recuperada · validando catálogo…"); if(getAuthToken()) loadCatalog(); });

const AUTH_BASE = API.replace(/\/catalog(?:\?.*)?$/, "");
const AUTH_TOKEN_KEY = "music-vip-session-v1";
const ACCOUNT_USED_KEY = "music-vip-account-used-v1";
let accountMode = "login";
let accountGateActive = true;
function getAuthToken(){try{return localStorage.getItem(AUTH_TOKEN_KEY)||"";}catch(_){return "";}}
function setAuthToken(token){try{if(token)localStorage.setItem(AUTH_TOKEN_KEY,token);else localStorage.removeItem(AUTH_TOKEN_KEY);}catch(_){}}
function initialAccountMode(){try{return localStorage.getItem(ACCOUNT_USED_KEY)==="1"?"login":"register";}catch(_){return "register";}}
function rememberAccountUse(){try{localStorage.setItem(ACCOUNT_USED_KEY,"1");}catch(_){}}
function openAccount(mode){
  accountMode = mode || (getAuthToken() ? "profile" : initialAccountMode());
  const modal = $("accountModal"); if(!modal)return;
  modal.hidden = false;
  $("accountClose").hidden = accountGateActive;
  $("accountForm").hidden = accountMode === "profile";
  $("accountProfile").hidden = accountMode !== "profile";
  $("accountSwitch").hidden = accountMode === "profile";
  $("accountTitle").textContent = accountMode === "register" ? "Criar sua conta" : accountMode === "profile" ? "Minha conta" : "Acesse sua conta";
  $("accountDescription").textContent = accountMode === "register" ? "Cadastre-se com e-mail e senha." : accountMode === "profile" ? (pendingAccessMessage || "Seus dados de acesso.") : "Entre para acessar sua conta MUSIC VIP.";
  $("accountSubmit").textContent = accountMode === "register" ? "Criar conta" : "Entrar";
  $("accountPassword").autocomplete = accountMode === "register" ? "new-password" : "current-password";
  $("accountSwitch").textContent = accountMode === "register" ? "Já tem conta? Entrar" : "Ainda não tem conta? Criar conta";
  $("accountFeedback").textContent = "";
  if(accountMode === "profile") refreshAccount();
}
function closeAccount(){if(accountGateActive)return;const modal=$("accountModal");if(modal)modal.hidden=true;}
function returnToMusicFoldersAfterPayment(){
  if(!pendingPaymentReturn)return;
  pendingPaymentReturn=false;
  accountGateActive=false;
  $("accountClose").hidden=false;
  closeAccount();
  closeFolder();
  showToast("Pagamento confirmado. Sua biblioteca MUSIC VIP está liberada.");
}
async function authRequest(path,method,body){
  const headers={"Content-Type":"application/json"};
  const token=getAuthToken(); if(token)headers.Authorization="Bearer "+token;
  const response=await fetch(AUTH_BASE+path,{method,headers,body:body?JSON.stringify(body):undefined,cache:"no-store"});
  let data={};try{data=await response.json();}catch(_){}
  if(!response.ok){const error=new Error(data.error||"Não foi possível concluir. Tente novamente.");error.status=response.status;throw error;}
  return data;
}
async function refreshAccount(){
  try{
    const data=await authRequest("/auth/me","GET");
    rememberAccountUse();
    accountGateActive=false;
    $("accountClose").hidden=false;
    const wasLifetime=lifetimeAccess;
    lifetimeAccess=Boolean(data.lifetimeAccess);
    $("accountEmailDisplay").textContent="E-mail: "+data.user.email;
    $("accountPlanDisplay").textContent=lifetimeAccess?"Plano: acesso vitalício ativo":"Plano: ainda sem acesso vitalício";
    $("premiumOffer").hidden=lifetimeAccess;
    $("premiumActive").hidden=!lifetimeAccess;
    $("accountBtn").textContent=lifetimeAccess?"Minha conta · VIP":"Minha conta";
    if(wasLifetime!==lifetimeAccess){
      renderFolders();renderSongListIfOpen();
      if(lifetimeAccess){
        returnToMusicFoldersAfterPayment();
        await loadCatalog();
      }
      else {audio.pause();audio.removeAttribute("src");audio.load();await clearOfflineMusic();saveCatalogSnapshot();}
    }
    if(lifetimeAccess) returnToMusicFoldersAfterPayment();
    try{
      const payment=await authRequest("/payments/status","GET");
      if(payment.lifetimeAccess){
        const wasLifetime=lifetimeAccess;
        lifetimeAccess=true;$("accountPlanDisplay").textContent="Plano: acesso vitalício ativo";
        $("premiumOffer").hidden=true;$("premiumActive").hidden=false;
        $("accountBtn").textContent="Minha conta · VIP";
        if(!wasLifetime){renderFolders();renderSongListIfOpen();}
        returnToMusicFoldersAfterPayment();
        if(!wasLifetime) await loadCatalog();
      }else if(payment.paymentStatus==="pending"){
        $("paymentFeedback").textContent="Pagamento pendente de confirmação. O acesso será liberado somente após validação pelo servidor.";
      }
    }catch(_){ }
  }catch(error){
    if(error.status!==401&&error.status!==403){
      const hadLifetimeAccess=lifetimeAccess;
      lifetimeAccess=false;
      $("accountPlanDisplay").textContent="Plano: conecte-se para validar o acesso";
      $("premiumOffer").hidden=false;$("premiumActive").hidden=true;
      $("accountBtn").textContent="Minha conta";
      $("accountFeedback").textContent="Não foi possível consultar sua conta agora. Conecte-se para validar a sessão e o acesso.";
      if(hadLifetimeAccess){
        requestId++;audio.pause();audio.removeAttribute("src");audio.load();
        if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";}
        currentIndex=-1;queue=[];activeFolder="";
        await clearOfflineMusic().catch(()=>{});
        renderFolders();renderSongListIfOpen();saveCatalogSnapshot();
      }
      return;
    }
    setAuthToken("");
    rememberAccountUse();
    accountGateActive=true;
    lifetimeAccess=false;
    $("accountBtn").textContent="Entrar";
    $("accountFeedback").textContent="Sua sessão expirou. Entre novamente.";
    openAccount("login");
    $("accountFeedback").textContent="Sua sessão expirou. Entre novamente.";
    requestId++;audio.pause();audio.removeAttribute("src");audio.load();
    if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";}
    currentIndex=-1;queue=[];activeFolder="";
    await clearOfflineMusic().catch(()=>{});
    renderFolders();renderSongListIfOpen();saveCatalogSnapshot();
  }
}
async function checkPaymentAvailability(){
  const button=$("premiumBuy");
  if(!button)return;
  button.disabled=true;
  try{
    const response=await fetch(AUTH_BASE+"/health",{cache:"no-store"});
    const data=await response.json().catch(()=>({}));
    paymentsConfigured=Boolean(response.ok&&data.paymentsConfigured);
    button.disabled=!paymentsConfigured;
    if(!paymentsConfigured)$("paymentFeedback").textContent="Checkout temporariamente indisponível. Tente novamente mais tarde.";
    else if($("paymentFeedback").textContent.includes("Checkout temporariamente"))$("paymentFeedback").textContent="";
  }catch(_){
    paymentsConfigured=false;button.disabled=true;
    $("paymentFeedback").textContent="Checkout temporariamente indisponível. Tente novamente mais tarde.";
  }
}
async function startCheckout(){
  if(!getAuthToken()){requestPremiumAccess("Entre ou crie sua conta para comprar o acesso vitalício.");return;}
  if(lifetimeAccess){await refreshAccount();return;}
  if(!paymentsConfigured){$("paymentFeedback").textContent="Checkout temporariamente indisponível. Tente novamente mais tarde.";return;}
  const button=$("premiumBuy");button.disabled=true;button.textContent="Preparando pagamento…";
  try{
    const data=await authRequest("/payments/checkout","POST",{});
    if(data.lifetimeAccess){await refreshAccount();return;}
    if(!data.checkoutUrl)throw new Error("O Mercado Pago não retornou o link de pagamento.");
    window.location.assign(data.checkoutUrl);
  }catch(error){
    $("paymentFeedback").textContent=error.message;
    button.disabled=!paymentsConfigured;button.textContent="Desbloquear com Mercado Pago";
  }
}
async function handlePaymentReturn(){
  const returnState=new URLSearchParams(window.location.search).get("mp_return");
  if(!returnState)return;
  pendingPaymentReturn = returnState==="success" || returnState==="pending";
  window.history.replaceState(null,"",window.location.pathname+window.location.hash);
  if(!getAuthToken()){
    openAccount("login");
    $("accountDescription").textContent="Entre na conta usada no pagamento para consultar a confirmação.";
    return;
  }
  openAccount("profile");
  const feedback=$("paymentFeedback");
  if(returnState==="failure"){
    feedback.textContent="O pagamento não foi concluído. Você pode tentar novamente.";
    return;
  }
  if(returnState==="pending"){
    feedback.textContent="Pagamento pendente. O acesso só será liberado após confirmação do servidor.";
    return;
  }
  if(returnState!=="success")return;
  feedback.textContent="Conferindo a confirmação do pagamento…";
  let lastStatus=null;
  for(let attempt=0;attempt<7;attempt++){
    try{
      const status=await authRequest("/payments/status","GET");
      lastStatus=status.paymentStatus;
      if(status.lifetimeAccess){
        lifetimeAccess=true;
        $("accountPlanDisplay").textContent="Plano: acesso vitalício ativo";
        $("premiumOffer").hidden=true;$("premiumActive").hidden=false;
        $("accountBtn").textContent="Minha conta · VIP";
        renderFolders();renderSongListIfOpen();
        returnToMusicFoldersAfterPayment();
        try{await loadCatalog();}catch(_){}
        feedback.textContent="Pagamento aprovado e acesso vitalício confirmado.";
        return;
      }
    }catch(_){}
    if(attempt<6)await new Promise(resolve=>setTimeout(resolve,2000));
  }
  feedback.textContent=lastStatus==="approved"
    ? "O Mercado Pago informou aprovação, mas o servidor ainda não confirmou o acesso. Tente verificar novamente em instantes."
    : "Pagamento recebido, mas ainda sem confirmação do servidor. O acesso permanece bloqueado até a validação automática.";
}
$("accountBtn").addEventListener("click",function(){openAccount(getAuthToken()?"profile":initialAccountMode());});
$("accountClose").addEventListener("click",closeAccount);
$("accountBackdrop").addEventListener("click",closeAccount);
$("accountSwitch").addEventListener("click",function(){openAccount(accountMode==="register"?"login":"register");});
$("premiumBuy").addEventListener("click",startCheckout);
$("accountForm").addEventListener("submit",async function(event){
  event.preventDefault();
  const email=$("accountEmail").value.trim().toLowerCase();
  const password=$("accountPassword").value;
  const submit=$("accountSubmit");submit.disabled=true;submit.textContent="Aguarde...";
  $("accountFeedback").textContent="";
  try{
    const route=accountMode==="register"?"/auth/register":"/auth/login";
    const data=await authRequest(route,"POST",{email,password});
    setAuthToken(data.token);
    rememberAccountUse();
    $("accountPassword").value="";
    $("accountFeedback").textContent=accountMode==="register"?"Conta criada com sucesso!":"Login realizado com sucesso!";
    $("accountBtn").textContent="Minha conta";
    await loadCatalog();
    openAccount("profile");
  }catch(error){$("accountFeedback").textContent=error.message;}
  finally{submit.disabled=false;submit.textContent=accountMode==="register"?"Criar conta":"Entrar";}
});
$("accountLogout").addEventListener("click",async function(){
  rememberAccountUse();
  authRequest("/auth/logout","POST",{}).catch(()=>{});
  requestId++;audio.pause();audio.removeAttribute("src");audio.load();
  if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";}
  currentIndex=-1;queue=[];activeFolder="";
  setAuthToken("");accountGateActive=true;lifetimeAccess=false;$("accountBtn").textContent="Entrar";
  await clearOfflineMusic().catch(()=>{});saveCatalogSnapshot();updateButtons();openAccount("login");
  $("accountFeedback").textContent="Você saiu da sua conta.";
  loadCatalog();
});
if(getAuthToken()){
  $("accountBtn").textContent="Minha conta";
  openAccount("profile");
}else{
  $("accountBtn").textContent=initialAccountMode()==="register"?"Criar conta":"Entrar";
  openAccount(initialAccountMode());
}

setupMediaSession();
updateButtons();
checkPaymentAvailability();
loadCatalog();
handlePaymentReturn();
})();
