(() => {
"use strict";
const $ = id => document.getElementById(id);
const audio = $("audio");
const API = "https://mundo-musical-api.manriquewb1234.workers.dev/catalog";
const PAGE_SIZE = 100;
const OFFLINE_DB = "music-offline-v2";
const DELETED_SONGS_KEY = "music-deleted-songs-v1";
const DELETED_FOLDERS_KEY = "music-deleted-folders-v1";
let offlineDbPromise = null;
let offlineSyncRunning = false;
let activeObjectUrl = "";
let songs = [];
let folders = [];
let activeFolder = "";
let folderSearchTerm = "";
let queue = [];
let currentIndex = -1;
let shuffleEnabled = false;

let visibleLimit = PAGE_SIZE;
let requestId = 0;
let toastTimer = 0;
const history = [];
const palettes = ["#263f70","#50326f","#155c67","#70432d","#3b4e86","#32664e","#74405c","#315b79"];
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
    if (element.scrollWidth <= element.clientWidth + 2) return;
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
function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
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
function offlineGet(url) {
  return openOfflineDb().then(function(db) { return new Promise(function(resolve,reject) {
    const request = db.transaction("audio").objectStore("audio").get(url);
    request.onsuccess = function() { resolve(request.result ? request.result.blob : null); };
    request.onerror = function() { reject(request.error); };
  }); });
}
function offlinePut(url,blob) {
  return openOfflineDb().then(function(db) { return new Promise(function(resolve,reject) {
    const request = db.transaction("audio","readwrite").objectStore("audio").put({url:url,blob:blob,savedAt:Date.now()});
    request.onsuccess = resolve; request.onerror = function() { reject(request.error); };
  }); });
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
function offlineProgressBusy(done,total,message) {
  const bar = $("offlineProgress");
  if (bar) bar.classList.add("busy");
  offlineProgress(Math.max(1,done),total);
  if (message) offlineStatus(message);
}
function fetchOfflineBlob(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url,{mode:"cors",cache:"no-store",signal:controller.signal}).then(function(response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return Promise.race([response.blob(),new Promise((_,reject) => setTimeout(() => reject(new Error("timeout")),timeoutMs))]);
  }).finally(() => clearTimeout(timer));
}
async function saveSongOffline(song) {
  for (let attempt=1; attempt<=3; attempt++) {
    try { await offlinePut(song.audioUrl,await fetchOfflineBlob(song.audioUrl,30000)); return true; }
    catch (error) { console.warn("Offline tentativa " + attempt + ":",song.title,error); if (attempt < 3) await new Promise(resolve => setTimeout(resolve,700)); }
  }
  return false;
}
async function startOfflineSync() {
  if (offlineSyncRunning) return;
  if (!navigator.onLine) {
    offlineStatus("Sem internet · somente faixas já salvas");
    return;
  }
  if (!songs.length) return;
  offlineSyncRunning = true;
  const total = songs.length;
  let done = 0;
  let failed = 0;
  try {
    await openOfflineDb();
    offlineProgressBusy(0,total,"Preparando carregamento offline…");
    const pending = [];
    for (const song of songs) {
      try {
        if (await offlineGet(song.audioUrl)) done++;
        else pending.push(song);
      } catch (_) { pending.push(song); }
      offlineProgressBusy(done,total,"Verificando músicas offline · " + done + "/" + total);
    }

    const grouped = new Map();
    pending.forEach(function(song) {
      if (!grouped.has(song.folder)) grouped.set(song.folder,[]);
      grouped.get(song.folder).push(song);
    });
    const orderedFolders = folders.map(folder => folder.name).filter(name => grouped.has(name));
    grouped.forEach(function(_,name){ if (!orderedFolders.includes(name)) orderedFolders.push(name); });
    for (const folderName of orderedFolders) {
      const tracks = grouped.get(folderName) || [];
      let folderDone = 0;
      let cursor = 0;
      offlineProgressBusy(done,total,"Salvando " + folderName + " · 0/" + tracks.length);
      async function worker() {
        while (cursor < tracks.length) {
          const song = tracks[cursor++];
          const saved = await saveSongOffline(song);
          if (saved) done++; else failed++;
          folderDone++;
          offlineProgressBusy(done,total,"Salvando " + folderName + " · " + folderDone + "/" + tracks.length + " (" + done + "/" + total + ")");
        }
      }
      await Promise.all([worker(),worker(),worker(),worker()]);
    }
    const savedText = done + "/" + total + " músicas offline";
    offlineProgress(done,total);
    const bar = $("offlineProgress");
    if (bar) bar.classList.remove("busy");
    offlineStatus(failed ? savedText + " · " + failed + " pendentes" : savedText + " · pronto");
  } catch (error) {
    console.error("Falha ao preparar modo offline:",error);
    const bar = $("offlineProgress");
    if (bar) bar.classList.remove("busy");
    offlineStatus(done ? "Carregamento pausado · " + done + "/" + total + " salvas" : "Não foi possível iniciar o modo offline");
  } finally {
    offlineSyncRunning = false;
  }
}
async function loadCatalog() {
  $("genreCards").innerHTML = '<div class="loading-card">Carregando sua biblioteca...</div>';
  try {
    const all = [];
    let cursor = "";
    let pageCount = 0;
    do {
      const url = new URL(API);
      url.searchParams.set("limit","1000");
      if (cursor) url.searchParams.set("cursor",cursor);
      const response = await fetch(url.toString(), {cache:"no-store"});
      if (!response.ok) throw new Error("Catálogo respondeu HTTP " + response.status);
      const data = await response.json();
      if (!Array.isArray(data.songs)) throw new Error("Formato de catálogo inesperado");
      all.push.apply(all,data.songs);
      cursor = data.nextCursor || "";
      pageCount++;
      if (pageCount > 100) throw new Error("Paginação interrompida por segurança");
    } while (cursor);

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
        folder:folderFromSong(Object.assign({},song,{audioUrl:audioUrl})),
        _index:index
      });
    }).filter(Boolean).filter(function(song){ return !deletedSongs.has(song.audioUrl) && !deletedFolders.has(song.folder); }).map(function(song,index){ return Object.assign({},song,{_index:index}); });

    if (!songs.length) throw new Error("Nenhuma faixa válida foi encontrada.");
    const counts = new Map();
    const folderFirstSeen = new Map();
    songs.forEach(function(song,index) {
      counts.set(song.folder,(counts.get(song.folder)||0)+1);
      if (!folderFirstSeen.has(song.folder)) folderFirstSeen.set(song.folder,index);
    });
    folders = Array.from(counts.entries()).map(entry => ({name:entry[0],count:entry[1]}))
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
    renderFolders();
    try { localStorage.setItem("music-catalog-v1",JSON.stringify(songs)); } catch (_) {}
    offlineStatus("Preparando músicas offline…");
    setTimeout(startOfflineSync,800);
    $("trackCount").textContent = songs.length.toLocaleString("pt-BR");
    $("folderCount").textContent = folders.length.toLocaleString("pt-BR");
    $("folderTotal").textContent = folders.length + " pastas disponíveis";
  } catch (error) {
    console.error("Falha ao carregar catálogo:",error);
    try {
      const saved = JSON.parse(localStorage.getItem("music-catalog-v1") || "null");
      if (Array.isArray(saved) && saved.length) {
        songs = saved; const counts = new Map(); songs.forEach(song => counts.set(song.folder,(counts.get(song.folder)||0)+1));
        folders = Array.from(counts.entries()).map(entry => ({name:entry[0],count:entry[1]})); renderFolders();
        $("trackCount").textContent = songs.length.toLocaleString("pt-BR"); $("folderCount").textContent = folders.length.toLocaleString("pt-BR"); $("folderTotal").textContent = folders.length + " pastas disponíveis"; offlineStatus("Catálogo salvo · preparando músicas offline…"); setTimeout(startOfflineSync,800); return;
      }
    } catch (_) {}
    $("genreCards").innerHTML = '<div class="error-card"><strong>Não conseguimos conectar à biblioteca.</strong><span>Abra o Music uma vez com internet para preparar o modo offline.</span><button id="retryCatalog" type="button">Tentar novamente</button></div>';
    $("trackCount").textContent = "Indisponível"; $("folderTotal").textContent = "Catálogo indisponível";
  }
}
function renderFolders() {
  const filteredFolders = folders.filter(folder => folder.name.toLocaleLowerCase("pt-BR").includes(folderSearchTerm));
  $("folderTotal").textContent = folderSearchTerm ? filteredFolders.length + " resultados" : folders.length.toLocaleString("pt-BR") + " estações";
  if (!filteredFolders.length) {
    $("genreCards").innerHTML = '<div class="loading-card">Nenhum estilo encontrado. Tente outra busca.</div>';
    return;
  }
  $("genreCards").innerHTML = filteredFolders.map(function(folder,index) {
    return '<div class="folder-card" data-folder="' + escapeHtml(folder.name) + '" role="button" tabindex="0" style="--folder-color:' + palettes[index % palettes.length] + '">' +
      '<div class="folder-menu-wrap"><button class="folder-menu" type="button" data-folder-menu="' + escapeHtml(folder.name) + '" aria-label="Opções da pasta ' + escapeHtml(folder.name) + '" title="Opções da pasta">⋯</button><div class="folder-menu-popover" data-folder-popover="' + escapeHtml(folder.name) + '" hidden><button type="button" data-delete-folder="' + escapeHtml(folder.name) + '">Excluir</button></div></div>' +
      '<span class="folder-art"><span>♫</span><i></i></span>' +
      '<span class="folder-name">' + escapeHtml(folder.name) + '</span>' +
      '<span class="folder-count">' + folder.count.toLocaleString("pt-BR") + (folder.count === 1 ? " música" : " músicas") + '</span>' +
      '<span class="folder-arrow">▶</span><span class="folder-download" data-download-folder="' + escapeHtml(folder.name) + '" role="button" tabindex="0" title="Baixar pasta" aria-label="Baixar pasta">⇩</span></div>';
  }).join("");
}
function safeFileName(value) {
  return safeText(value).replace(/[\\/:*?"<>|]/g,"-").replace(/\s+/g," ").trim().slice(0,150);
}
async function downloadFolder(folderName) {
  const tracks = songs.filter(song => song.folder === folderName);
  if (!tracks.length || !window.fflate) return;
  if (!window.confirm("Baixar " + tracks.length + " músicas da pasta “" + folderName + "” em um arquivo ZIP?")) return;
  const files = {};
  try {
    for (let i=0; i<tracks.length; i++) {
      showToast("Preparando download: " + (i+1) + "/" + tracks.length);
      const response = await fetch(tracks[i].audioUrl,{mode:"cors",cache:"no-store"});
      if (!response.ok) throw new Error("HTTP " + response.status);
      const path = new URL(tracks[i].audioUrl).pathname;
      const extension = (path.match(/\.[a-z0-9]+$/i) || [".mp3"])[0];
      files[String(i+1).padStart(3,"0") + " - " + safeFileName(tracks[i].title) + extension] = new Uint8Array(await response.arrayBuffer());
    }
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
    const color = palettes[position % palettes.length];
    return '<button type="button" class="song-row ' + (playing ? "playing" : "") + '" data-song-index="' + songIndex + '">' +
      '<span class="song-number">' + String(position+1).padStart(2,"0") + '</span>' +
      '<span class="song-cover" style="--cover-color:' + color + '">♫</span>' +
      '<span class="song-info"><strong>' + escapeHtml(song.title) + '</strong><small>' + escapeHtml(song.artist) + '</small></span>' +
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
    localStorage.setItem("music-catalog-v1",JSON.stringify(remaining));
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
  try { localStorage.setItem("music-catalog-v1",JSON.stringify(remaining)); } catch (_) {}
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

  // Começa imediatamente pela URL online, sem aguardar IndexedDB. Isso preserva
  // a autorização do toque do usuário no Android e evita ficar em 0:00.
  audio.src = song.audioUrl;
  audio.load();
  const playRequest = audio.play();
  if (playRequest && typeof playRequest.then === "function") {
    playRequest.then(function() {
      if (id === requestId) { $("playBtn").textContent = "Ⅱ"; updateMediaState("playing"); }
    }).catch(function(error) {
      if (id !== requestId) return;
      console.warn("Reprodução online falhou:",error);
      tryOfflinePlayback(song,id);
    });
  }

  // O arquivo offline é consultado em paralelo, mas nunca bloqueia o primeiro play.
  // Ele será usado se o dispositivo estiver sem internet ou se a fonte online falhar.
  if (window.indexedDB) offlineGet(song.audioUrl).then(function(blob) {
    if (!blob || id !== requestId || navigator.onLine !== false || !audio.paused) return;
    tryOfflineBlob(blob,song,id);
  }).catch(function(error) {
    console.warn("Não foi possível consultar a cópia offline:",error);
    if (id === requestId && navigator.onLine === false) showToast("Esta música ainda não foi salva offline.");
  });
}
function tryOfflinePlayback(song,id) {
  if (!window.indexedDB) { showToast("Não foi possível carregar esta música."); return; }
  offlineGet(song.audioUrl).then(function(blob) {
    if (!blob || id !== requestId) { showToast("Não foi possível carregar esta música."); return; }
    tryOfflineBlob(blob,song,id);
  }).catch(function() { if (id === requestId) showToast("Não foi possível carregar esta música."); });
}
function tryOfflineBlob(blob,song,id) {
  if (id !== requestId) return;
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(blob);
  audio.src = activeObjectUrl;
  audio.load();
  const retry = audio.play();
  if (retry && typeof retry.catch === "function") retry.catch(function(error) {
    if (id === requestId) { console.warn("Reprodução offline falhou:",error); showToast("Toque novamente para reproduzir esta música."); }
  });
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
    // Após ficar em segundo plano, o navegador pode descartar a fonte/blob atual.
    // Nesse caso, recarrega a faixa pelo IndexedDB antes de tentar reproduzir.
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
audio.addEventListener("error",function(){showToast("Erro ao carregar o áudio. Pulando para a próxima faixa.");});
document.addEventListener("visibilitychange",function(){
  if (!document.hidden && currentIndex >= 0) updateMediaMetadata(songs[currentIndex]);
  if (!document.hidden) setTimeout(startOfflineSync,500);
});
window.addEventListener("online",function(){ offlineStatus("Internet recuperada · retomando carregamento…"); setTimeout(startOfflineSync,300); });
setupMediaSession();
updateButtons();
loadCatalog();
})();
