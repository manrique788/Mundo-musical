(() => {
"use strict";
const $ = id => document.getElementById(id);
const audio = $("audio");
const API = "https://mundo-musical-api.manriquewb1234.workers.dev/catalog";
const PAGE_SIZE = 100;
let songs = [];
let folders = [];
let activeFolder = "";
let queue = [];
let currentIndex = -1;
let shuffleEnabled = false;
let repeatMode = "off";
let visibleLimit = PAGE_SIZE;
let requestId = 0;
let toastTimer = 0;
const history = [];
const palettes = ["#263f70","#50326f","#155c67","#70432d","#3b4e86","#32664e","#74405c","#315b79"];

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
function offlineStatus(text) { const el = $("offlineStatus"); if (el) el.textContent = text; }
function offlineProgress(done,total) {
  const bar = $("offlineProgress");
  const fill = $("offlineProgressFill");
  if (!bar || !fill) return;
  const percent = total ? Math.min(100,Math.round(done / total * 100)) : 0;
  fill.style.width = percent + "%";
  bar.title = total ? "Músicas disponíveis offline: " + done + "/" + total : "Offline";
  bar.classList.toggle("complete",total > 0 && done >= total);
}
function startOfflineSync() {
  if (offlineSyncRunning || !songs.length || !navigator.onLine || !window.indexedDB) return;
  offlineSyncRunning = true;
  (async function() {
    let ready = 0;
    offlineProgress(0,songs.length);
    for (let i=0; i<songs.length; i++) {
      const song = songs[i];
      try {
        if (await offlineGet(song.audioUrl)) { ready++; }
        else { const response = await fetch(song.audioUrl,{mode:"cors",cache:"no-store"}); if (response.ok) { await offlinePut(song.audioUrl,await response.blob()); ready++; } }
      } catch (error) { console.warn("Offline: falha ao guardar",song.title,error); }
      offlineProgress(ready,songs.length);
      offlineStatus("Preparando offline: " + ready + "/" + songs.length);
    }
    offlineStatus(ready === songs.length ? "Offline pronto" : "Offline: " + ready + "/" + songs.length);
    offlineSyncRunning = false;
  })();
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
    songs = all.map(function(song, index) {
      const audioUrl = safeText(song.audioUrl || song.url).trim();
      const title = safeText(song.title || song.name).trim();
      if (!audioUrl || !title) return null;
      const key = audioUrl;
      if (seen.has(key)) return null;
      seen.add(key);
      return Object.assign({}, song, {
        title:title,
        artist:safeText(song.artist || "Music"),
        audioUrl:audioUrl,
        folder:folderFromSong(Object.assign({},song,{audioUrl:audioUrl})),
        _index:index
      });
    }).filter(Boolean).map(function(song,index){ return Object.assign({},song,{_index:index}); });

    if (!songs.length) throw new Error("Nenhuma faixa válida foi encontrada.");
    const counts = new Map();
    songs.forEach(song => counts.set(song.folder,(counts.get(song.folder)||0)+1));
    folders = Array.from(counts.entries()).map(entry => ({name:entry[0],count:entry[1]}))
      .sort((a,b) => {
        const priority = name => {
          const normalized = name.normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase();
          if (normalized.includes("mega funk")) return 1;
          if (normalized.includes("funk")) return 0;
          return 2;
        };
        const difference = priority(a.name) - priority(b.name);
        return difference || a.name.localeCompare(b.name,"pt-BR");
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
        $("trackCount").textContent = songs.length.toLocaleString("pt-BR"); $("folderCount").textContent = folders.length.toLocaleString("pt-BR"); $("folderTotal").textContent = folders.length + " pastas disponíveis"; offlineStatus("Modo offline"); return;
      }
    } catch (_) {}
    $("genreCards").innerHTML = '<div class="error-card"><strong>Não conseguimos conectar à biblioteca.</strong><span>Abra o Music uma vez com internet para preparar o modo offline.</span><button id="retryCatalog" type="button">Tentar novamente</button></div>';
    $("trackCount").textContent = "Indisponível"; $("folderTotal").textContent = "Catálogo indisponível";
  }
}
function renderFolders() {
  $("genreCards").innerHTML = folders.map(function(folder,index) {
    return '<button class="folder-card" type="button" data-folder="' + escapeHtml(folder.name) + '" style="--folder-color:' + palettes[index % palettes.length] + '">' +
      '<span class="folder-art"><span>♫</span><i></i></span>' +
      '<span class="folder-name">' + escapeHtml(folder.name) + '</span>' +
      '<span class="folder-count">' + folder.count.toLocaleString("pt-BR") + (folder.count === 1 ? " música" : " músicas") + '</span>' +
      '<span class="folder-arrow">▶</span><span class="folder-download" data-download-folder="' + escapeHtml(folder.name) + '" role="button" tabindex="0" title="Baixar pasta" aria-label="Baixar pasta">⇩</span></button>';
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
  title.textContent = current ? current.title : "Nenhuma música selecionada";
  $("drawerArtist").textContent = current ? current.artist : "Escolha uma pasta para começar";
  $("drawerFolder").textContent = activeFolder || "Nenhuma pasta";
  $("drawerQueueCount").textContent = queue.length.toLocaleString("pt-BR") + (queue.length === 1 ? " música" : " músicas");
  $("drawerShuffleBtn").classList.toggle("active",shuffleEnabled);
  $("drawerShuffleBtn").setAttribute("aria-pressed",String(shuffleEnabled));
  $("drawerShuffleBtn").innerHTML = "⤨ <span>Aleatório " + (shuffleEnabled ? "ligado" : "desligado") + "</span>";
  $("drawerQueue").innerHTML = queue.map(function(songIndex,position) {
    const song = songs[songIndex];
    const isCurrent = songIndex === currentIndex;
    return '<button type="button" class="drawer-queue-row ' + (isCurrent ? "current" : "") + '" data-queue-index="' + songIndex + '">' +
      '<span class="drawer-queue-number">' + (isCurrent && !audio.paused ? "♫" : String(position+1).padStart(2,"0")) + '</span>' +
      '<span class="drawer-queue-info"><strong>' + escapeHtml(song.title) + '</strong><small>' + escapeHtml(song.artist) + '</small></span>' +
      '<span class="drawer-queue-state">' + (isCurrent && !audio.paused ? "TOCANDO" : "▶") + '</span></button>';
  }).join("") || '<div class="drawer-empty">Abra uma pasta para ver as músicas da fila.</div>';
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
  if (repeatMode === "one" && direction > 0) return currentIndex;
  if (shuffleEnabled && direction > 0 && queue.length > 1) {
    const options = queue.filter(index => index !== currentIndex);
    return options[Math.floor(Math.random()*options.length)];
  }
  let pos = currentQueuePosition();
  if (pos < 0) pos = direction > 0 ? -1 : 0;
  let next = pos + direction;
  if (next >= queue.length) return repeatMode === "all" ? queue[0] : -1;
  if (next < 0) return repeatMode === "all" ? queue[queue.length-1] : queue[0];
  return queue[next];
}
async function playSong(index) {
  const song = songs[index];
  if (!song) return;
  const id = ++requestId;
  currentIndex = index;
  if (!queue.includes(index)) { activeFolder = song.folder; queue = songs.filter(item => item.folder === activeFolder).map(item => item._index); }
  audio.pause();
  audio.volume = Number($("volume").value || 0.8);
  $("currentTitle").textContent = song.title; $("currentArtist").textContent = song.artist; $("currentCover").innerHTML = "<span>♫</span>"; $("playBtn").textContent = "Ⅱ";
  if (!history.includes(index)) history.unshift(index); if (history.length > 30) history.pop();
  updateMediaMetadata(song); renderSongListIfOpen();
  try {
    const blob = window.indexedDB ? await offlineGet(song.audioUrl) : null;
    if (id !== requestId) return;
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = blob ? URL.createObjectURL(blob) : "";
    audio.src = activeObjectUrl || song.audioUrl;
  } catch (_) { audio.src = song.audioUrl; }
  if (id !== requestId) return;
  audio.load();
  audio.play().then(function() { if (id === requestId) { $("playBtn").textContent = "Ⅱ"; updateMediaState("playing"); } }).catch(function(error) {
    if (id !== requestId) return; console.warn("Não foi possível iniciar o áudio:",error); $("playBtn").textContent = "▶"; showToast("Não foi possível tocar esta faixa. Confira sua conexão ou o preparo offline."); updateMediaState("paused");
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
  if (audio.paused) audio.play().catch(() => showToast("Não foi possível retomar a música."));
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
  $("repeatBtn").classList.toggle("active",repeatMode !== "off");
  $("repeatBtn").textContent = repeatMode === "one" ? "↻¹" : "↻";
}
function setVolume(value) {
  audio.volume = Number(value);
  $("volume").value = String(value);
}
$("genreCards").addEventListener("click",function(event) {
  const download = event.target.closest("[data-download-folder]");
  if (download) { event.preventDefault(); event.stopPropagation(); downloadFolder(download.dataset.downloadFolder); return; }
  const retry = event.target.closest("#retryCatalog");
  if (retry) { loadCatalog(); return; }
  const card = event.target.closest("[data-folder]");
  if (card) openFolder(card.dataset.folder,true);
});
$("backFoldersBtn").addEventListener("click",closeFolder);
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
$("drawerShuffleBtn").addEventListener("click",function(){
  shuffleEnabled = !shuffleEnabled;
  updateButtons(); renderDrawer();
  showToast(shuffleEnabled ? "Aleatório ligado" : "Aleatório desligado");
});
$("drawerPrevFolderBtn").addEventListener("click",function(){switchFolder(-1);});
$("drawerNextFolderBtn").addEventListener("click",function(){switchFolder(1);});
$("prevFolderCompactBtn").addEventListener("click",function(){switchFolder(-1);});
$("nextFolderCompactBtn").addEventListener("click",function(){switchFolder(1);});
$("drawerQueue").addEventListener("click",function(event){
  const row = event.target.closest("[data-queue-index]");
  if (row) playSong(Number(row.dataset.queueIndex));
});
$("playBtn").addEventListener("click",togglePlay);
$("prevBtn").addEventListener("click",function(){skip(-1);});
$("nextBtn").addEventListener("click",function(){skip(1);});
$("shuffleBtn").addEventListener("click",function(){shuffleEnabled = !shuffleEnabled;updateButtons();showToast(shuffleEnabled ? "Aleatório ativado" : "Aleatório desativado");});
$("repeatBtn").addEventListener("click",function(){
  repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
  updateButtons();
  showToast(repeatMode === "off" ? "Repetição desligada" : repeatMode === "all" ? "Repetir pasta" : "Repetir música");
});
$("volume").addEventListener("input",event => setVolume(event.target.value));
$("progress").addEventListener("input",function(event) {
  if (audio.duration) audio.currentTime = audio.duration * Number(event.target.value) / 100;
});
audio.addEventListener("timeupdate",function() {
  $("currentTime").textContent = formatTime(audio.currentTime);
  $("duration").textContent = formatTime(audio.duration);
  const percent = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
  $("progress").value = percent;
  $("progress").style.setProperty("--progress-percent",percent + "%");
});
audio.addEventListener("ended",function() {
  if (repeatMode === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  skip(1);
});
audio.addEventListener("play",function(){updateButtons();updateMediaState("playing");renderSongListIfOpen();});
audio.addEventListener("pause",function(){updateButtons();updateMediaState("paused");renderSongListIfOpen();});
audio.addEventListener("error",function(){showToast("Erro ao carregar o áudio. Pulando para a próxima faixa.");});
document.addEventListener("visibilitychange",function(){
  if (!document.hidden && currentIndex >= 0) updateMediaMetadata(songs[currentIndex]);
});
setupMediaSession();
updateButtons();
loadCatalog();
})();
