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
        artist:safeText(song.artist || "Mundo Musical"),
        audioUrl:audioUrl,
        folder:folderFromSong(Object.assign({},song,{audioUrl:audioUrl})),
        _index:index
      });
    }).filter(Boolean).map(function(song,index){ return Object.assign({},song,{_index:index}); });

    if (!songs.length) throw new Error("Nenhuma faixa válida foi encontrada.");
    const counts = new Map();
    songs.forEach(song => counts.set(song.folder,(counts.get(song.folder)||0)+1));
    folders = Array.from(counts.entries()).map(entry => ({name:entry[0],count:entry[1]}))
      .sort((a,b) => a.name.localeCompare(b.name,"pt-BR"));
    renderFolders();
    $("trackCount").textContent = songs.length.toLocaleString("pt-BR");
    $("folderCount").textContent = folders.length.toLocaleString("pt-BR");
    $("folderTotal").textContent = folders.length + " pastas disponíveis";
  } catch (error) {
    console.error("Falha ao carregar catálogo:",error);
    $("genreCards").innerHTML = '<div class="error-card"><strong>Não conseguimos conectar à biblioteca.</strong><span>Verifique a conexão e tente novamente.</span><button id="retryCatalog" type="button">Tentar novamente</button></div>';
    $("trackCount").textContent = "Indisponível";
    $("folderTotal").textContent = "Catálogo indisponível";
  }
}
function renderFolders() {
  $("genreCards").innerHTML = folders.map(function(folder,index) {
    return '<button class="folder-card" type="button" data-folder="' + escapeHtml(folder.name) + '" style="--folder-color:' + palettes[index % palettes.length] + '">' +
      '<span class="folder-art"><span>♫</span><i></i></span>' +
      '<span class="folder-name">' + escapeHtml(folder.name) + '</span>' +
      '<span class="folder-count">' + folder.count.toLocaleString("pt-BR") + (folder.count === 1 ? " música" : " músicas") + '</span>' +
      '<span class="folder-arrow">▶</span></button>';
  }).join("");
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
function playSong(index) {
  const song = songs[index];
  if (!song) return;
  const id = ++requestId;
  currentIndex = index;
  if (!queue.includes(index)) {
    activeFolder = song.folder;
    queue = songs.filter(item => item.folder === activeFolder).map(item => item._index);
  }
  audio.pause();
  audio.src = song.audioUrl;
  audio.load();
  $("currentTitle").textContent = song.title;
  $("currentArtist").textContent = song.artist;
  $("currentCover").innerHTML = "<span>♫</span>";
  $("playBtn").textContent = "Ⅱ";
  if (!history.includes(index)) history.unshift(index);
  if (history.length > 30) history.pop();
  updateMediaMetadata(song);
  renderSongListIfOpen();
  audio.play().then(function() {
    if (id !== requestId) return;
    $("playBtn").textContent = "Ⅱ";
    updateMediaState("playing");
  }).catch(function(error) {
    if (id !== requestId) return;
    console.warn("Não foi possível iniciar o áudio:",error);
    $("playBtn").textContent = "▶";
    showToast("Não foi possível tocar esta faixa. Confira o acesso ao arquivo.");
    updateMediaState("paused");
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
      title:song.title, artist:song.artist, album:"Mundo Musical Rádio"
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
audio.addEventListener("play",function(){updateButtons();updateMediaState("playing");});
audio.addEventListener("pause",function(){updateButtons();updateMediaState("paused");});
audio.addEventListener("error",function(){showToast("Erro ao carregar o áudio. Pulando para a próxima faixa.");});
document.addEventListener("visibilitychange",function(){
  if (!document.hidden && currentIndex >= 0) updateMediaMetadata(songs[currentIndex]);
});
setupMediaSession();
updateButtons();
loadCatalog();
})();