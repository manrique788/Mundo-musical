const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* Equalizador profissional de 10 bandas com caminho seco de segurança. */
let enhancerContext=null, enhancerSource=null, enhancerFilters=[], enhancerCompressor=null, enhancerPreamp=null, enhancerDryGain=null, enhancerWetGain=null;
let enhancerEnabled=false, enhancerCrossOriginReady=false;
const EQ_BANDS=[
 {id:"eq32",freq:32,type:"lowshelf"},{id:"eq64",freq:64,type:"peaking"},{id:"eq125",freq:125,type:"peaking"},
 {id:"eq250",freq:250,type:"peaking"},{id:"eq500",freq:500,type:"peaking"},{id:"eq1000",freq:1000,type:"peaking"},
 {id:"eq2000",freq:2000,type:"peaking"},{id:"eq4000",freq:4000,type:"peaking"},{id:"eq8000",freq:8000,type:"peaking"},{id:"eq16000",freq:16000,type:"highshelf"}
];
const EQ_PRESETS={
 smart:{name:"Inteligente",preamp:-1,gains:[1,2,2,0,-1,0,1,2,2,1]},
 flat:{name:"Flat (neutro)",preamp:0,gains:[0,0,0,0,0,0,0,0,0,0]},
 pop:{name:"Pop",preamp:-2,gains:[2,2,1,0,-1,0,2,2,1,2]},
 rock:{name:"Rock",preamp:-2,gains:[3,2,-1,-2,0,1,2,3,2,2]},
 hiphop:{name:"Hip-hop / Funk",preamp:-3,gains:[4,4,3,1,-1,0,1,2,1,1]},
 electronic:{name:"Eletrônica / Mega Funk",preamp:-3,gains:[4,3,1,0,-1,0,2,2,3,3]},
 voice:{name:"Voz clara",preamp:-1,gains:[-2,-1,0,1,2,3,3,2,1,0]},
 bass:{name:"Graves reforçados",preamp:-3,gains:[5,4,3,1,0,0,0,1,1,0]},
 classical:{name:"Clássico",preamp:-1,gains:[2,1,0,-1,-1,0,1,2,2,3]}
};
function enhancerStatus(message,isError=false){const el=$("audioEnhancerStatus");if(el){el.textContent=message;el.classList.toggle("error",isError);}}
function selectedEnhancerLabel(){const mode=$("audioEnhancerMode")?.value||"smart";return EQ_PRESETS[mode]?.name||"Inteligente";}
function formatDb(value){const n=Number(value);return (n>0?"+":n<0?"−":"")+Math.abs(n)+" dB";}
function applyEnhancerSettings(){
 const preampInput=$("enhancerPreamp");
 if(preampInput){const db=Number(preampInput.value);if($("enhancerPreampValue"))$("enhancerPreampValue").textContent=formatDb(db);if(enhancerPreamp)enhancerPreamp.gain.setTargetAtTime(Math.pow(10,db/20),enhancerContext.currentTime,.025);}
 EQ_BANDS.forEach((band,index)=>{
  const input=$(band.id),out=$(band.id+"Value");if(!input)return;
  const gain=Number(input.value);if(out)out.textContent=formatDb(gain);
  if(enhancerFilters[index])enhancerFilters[index].gain.setTargetAtTime(gain,enhancerContext.currentTime,.025);
 });
}
function setEnhancerEnabled(enabled){
 enhancerEnabled=enabled;
 if(enhancerDryGain&&enhancerWetGain){const now=enhancerContext.currentTime;enhancerDryGain.gain.setTargetAtTime(enabled?0:1,now,.025);enhancerWetGain.gain.setTargetAtTime(enabled?1:0,now,.025);}
 const button=$("audioEnhancerToggle");if(button){button.textContent=enabled?"Desativar melhoria":"Ativar melhoria";button.classList.toggle("enabled",enabled);button.setAttribute("aria-pressed",String(enabled));}
 enhancerStatus(enabled?"Equalizador ativo • "+selectedEnhancerLabel():(enhancerCrossOriginReady?"Desligado • som original":"Desligado • CORS ainda não verificado"));
}
function applyEnhancerPreset(){
 const preset=EQ_PRESETS[$("audioEnhancerMode")?.value||"smart"]||EQ_PRESETS.smart;
 if($("enhancerPreamp"))$("enhancerPreamp").value=String(preset.preamp);
 EQ_BANDS.forEach((band,index)=>{const input=$(band.id);if(input)input.value=String(preset.gains[index]);});
 applyEnhancerSettings();
 if(enhancerEnabled)enhancerStatus("Equalizador ativo • "+preset.name);
}
function setFlatEqualizer(){
 $("audioEnhancerMode").value="flat";
 applyEnhancerPreset();
}
async function enableAudioEnhancer(){
 if(enhancerEnabled){setEnhancerEnabled(false);return;}
 if(!songs.length||currentIndex<0||!audio.currentSrc){enhancerStatus("Reproduza uma música antes de ativar.",true);return;}
 const button=$("audioEnhancerToggle");
 if(button){button.disabled=true;button.textContent="Ativando…";}
 enhancerStatus("Preparando equalizador…");
 try{
  if(!enhancerContext){
   const AudioContextClass=window.AudioContext||window.webkitAudioContext;
   if(!AudioContextClass)throw new Error("este navegador não oferece Web Audio API");
   enhancerContext=new AudioContextClass();
   enhancerSource=enhancerContext.createMediaElementSource(audio);

   // Liga primeiro o caminho original: se a criação de algum filtro falhar,
   // o áudio continua audível sem efeitos.
   enhancerDryGain=enhancerContext.createGain();
   enhancerWetGain=enhancerContext.createGain();
   enhancerDryGain.gain.value=1;
   enhancerWetGain.gain.value=0;
   enhancerSource.connect(enhancerDryGain);
   enhancerDryGain.connect(enhancerContext.destination);

   enhancerPreamp=enhancerContext.createGain();
   enhancerPreamp.gain.value=1;
   enhancerFilters=EQ_BANDS.map(band=>{
    const filter=enhancerContext.createBiquadFilter();
    filter.type=band.type;
    filter.frequency.value=band.freq;
    if(band.type==="peaking")filter.Q.value=1.05;
    filter.gain.value=0;
    return filter;
   });
   enhancerCompressor=enhancerContext.createDynamicsCompressor();
   enhancerCompressor.threshold.value=-10;
   enhancerCompressor.knee.value=8;
   enhancerCompressor.ratio.value=2.5;
   enhancerCompressor.attack.value=.004;
   enhancerCompressor.release.value=.2;
   let previous=enhancerPreamp;
   enhancerSource.connect(enhancerPreamp);
   for(const filter of enhancerFilters){previous.connect(filter);previous=filter;}
   previous.connect(enhancerCompressor);
   enhancerCompressor.connect(enhancerWetGain);
   enhancerWetGain.connect(enhancerContext.destination);
  }
  if(enhancerContext.state==="suspended")await enhancerContext.resume();
  enhancerCrossOriginReady=true;
  applyEnhancerSettings();
  setEnhancerEnabled(true);
 }catch(error){
  console.warn("Equalizador não ativado:",error);
  const detail=(error&&error.message)?String(error.message):"erro desconhecido";
  // Mantém o caminho seco ativo e não troca/recarrega a faixa que está tocando.
  if(enhancerDryGain&&enhancerContext){
   try{enhancerDryGain.gain.setValueAtTime(1,enhancerContext.currentTime);}catch(_){}
   if(enhancerWetGain)try{enhancerWetGain.gain.setValueAtTime(0,enhancerContext.currentTime);}catch(_){}
  }
  enhancerEnabled=false;
  enhancerStatus("Equalizador indisponível: "+detail+" • música mantida sem efeitos.",true);
 }finally{
  if(button)button.disabled=false;
  if(button&&!enhancerEnabled){button.textContent="Ativar melhoria";button.setAttribute("aria-pressed","false");}
 }
}

let songs = [];
let visibleSongs = [];
let currentIndex = -1;
let selectedGenre = "Todos";
let favoritesOnly = false;

function classifySong(song) {
  // Usa a pasta real do arquivo no caminho armazenado no Cloudflare.
  const rawPath = String(song.audioUrl || song.url || song.key || song.name || "").split(/[?#]/)[0];
  let decodedPath = rawPath;
  try { decodedPath = decodeURIComponent(rawPath); } catch (_) {}
  const parts = decodedPath.split("/").filter(Boolean);
  const filename = String(song.title || "").toLowerCase();
  // Se o caminho termina no nome do arquivo, a pasta imediatamente anterior é a categoria.
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (parent && !/^https?:$/i.test(parent) && parent !== "catalog") return parent;
  }
  // Algumas respostas do catálogo podem fornecer a chave completa separadamente.
  const key = String(song.key || song.name || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (key.length >= 2) return key[key.length - 2];
  return "Sem pasta";
}


const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const formatTime = seconds => {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2,"0")}`;
};

async function loadSongs() {
  try {
    const api = "https://mundo-musical-api.manriquewb1234.workers.dev/catalog";
    const allSongs = [];
    let cursor = "";

    do {
      const url = new URL(api);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { cache: "default" });
      if (!response.ok) throw new Error("Não foi possível carregar o catálogo");
      const page = await response.json();
      if (Array.isArray(page.songs)) allSongs.push(...page.songs);
      cursor = page.nextCursor || "";
    } while (cursor);

    songs = allSongs
      .map((s, index) => ({
        ...s,
        _index: index,
        genre: classifySong(s),
        audioUrl: String(s.audioUrl || "").replace(/\s+\//g, "/")
      }))
      .filter(s => s && s.title && s.audioUrl)
      .map((s, index) => ({ ...s, _index: index }));

    if (!songs.length) throw new Error("Catálogo vazio");
    renderGenres();
    renderGenreCards();
    renderSongs();
    setupMediaSession();
    $("trackCount").textContent = `${songs.length} músicas disponíveis`;
  } catch (error) {
    console.error(error);
    $("trackCount").textContent = "Não foi possível carregar o catálogo";
    $("songList").innerHTML = `<div class="empty-card">Não foi possível conectar ao catálogo de músicas.</div>`;
    $("sideGenres").innerHTML = "";
  }
}

function genres() {
  return [...new Set(songs.map(s => s.genre || "Sem pasta"))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}
function renderGenres() {
  const all = ["Todos", ...genres()];
  $("genreChips").innerHTML = all.map(g => `<button class="chip ${g===selectedGenre?"selected":""}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("");
  $("sideGenres").innerHTML = genres().slice(0,12).map(g => `<button class="side-genre" data-genre="${escapeHtml(g)}">♫ &nbsp; ${escapeHtml(g)}</button>`).join("");
}

function renderGenreCards() {
  const palettes = [
    "linear-gradient(135deg,#5632a8,#1a1735)", "linear-gradient(135deg,#a13c72,#30162f)",
    "linear-gradient(135deg,#147d86,#102c3d)", "linear-gradient(135deg,#a45c23,#392018)",
    "linear-gradient(135deg,#315ca7,#171f45)", "linear-gradient(135deg,#39834f,#132b22)"
  ];
  const symbols = ["♫","♪","♬","𝄞","🎧","♩"];
  const list = genres();
  const target = $("genreCards");
  if (!target) return;
  const counts = new Map();
  for (const song of songs) {
    const name = song.genre || "Sem pasta";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  target.innerHTML = list.map((g, i) => {
    const count = counts.get(g) || 0;
    return `<button class="genre-card ${g===selectedGenre?"active":""}" data-genre="${escapeHtml(g)}" data-folder-play="${escapeHtml(g)}" style="--genre-bg:${palettes[i % palettes.length]}">
      <span class="genre-card-art" aria-hidden="true">${symbols[i % symbols.length]}</span>
      <span class="genre-card-name">${escapeHtml(g)}</span>
      <span class="genre-card-count">${count} ${count === 1 ? "música" : "músicas"}</span>
      <span class="genre-card-play" aria-hidden="true">${currentIndex >= 0 && songs[currentIndex] && (songs[currentIndex].genre || "Sem pasta") === g && !audio.paused ? "Ⅱ" : "▶"}</span>
    </button>`;
  }).join("");
  target.querySelectorAll(".genre-card").forEach(card => {
    card.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const folderName = card.dataset.folderPlay || card.dataset.genre;
      if (!folderName) return;
      selectedGenre = folderName;
      $("searchInput").value = "";
      renderGenres(); renderSongs();
      const currentFolder = currentIndex >= 0 && songs[currentIndex] ? (songs[currentIndex].genre || "Sem pasta") : "";
      if (currentFolder === folderName) {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        renderGenreCards();
        return;
      }
      const firstIndex = songs.findIndex(song => (song.genre || "Sem pasta") === folderName);
      if (firstIndex >= 0) playSong(firstIndex);
      else console.error("Nenhuma música encontrada para a pasta:", folderName);
    });
  });
}
function renderSongs() {
  visibleTrackLimit = INITIAL_TRACK_LIMIT;
  const query = $("searchInput").value.trim().toLocaleLowerCase("pt-BR");
  visibleSongs = songs.filter(s => {
    const matchesGenre = selectedGenre === "Todos" || (s.genre || "Outros") === selectedGenre;
    const searchable = [s.title,s.artist,s.genre].join(" ").toLocaleLowerCase("pt-BR");
    return matchesGenre && searchable.includes(query);
  });
  $("listTitle").textContent = selectedGenre === "Todos" ? (query ? "Resultados da busca" : "Explore todas as músicas") : selectedGenre;
  $("trackCount").textContent = `${visibleSongs.length} ${visibleSongs.length === 1 ? "música" : "músicas"}`;
  if (!visibleSongs.length) {
    $("songList").innerHTML = `<div class="empty-card">Nenhuma música encontrada com esse filtro.</div>`;
    return;
  }

  const palettes = [
    "linear-gradient(135deg,#7148d8,#21143d)",
    "linear-gradient(135deg,#d44d88,#421b43)",
    "linear-gradient(135deg,#159ca0,#143b51)",
    "linear-gradient(135deg,#d07b36,#4a251f)",
    "linear-gradient(135deg,#4d77d5,#202653)",
    "linear-gradient(135deg,#4da66b,#183a31)"
  ];
  const renderRow = (s, i) => {
    const originalIndex = s._index;
    const isPlaying = currentIndex === originalIndex && !audio.paused;
    const palette = palettes[(originalIndex < 0 ? i : originalIndex) % palettes.length];
    return `<div class="song-row ${isPlaying?"playing":""}" data-index="${originalIndex}">
      <div class="song-cover" style="--cover-bg:${palette}"><span>♫</span></div>
      <div class="song-info"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.artist || "Artista desconhecido")}</span></div>
      <span class="song-genre">${escapeHtml(s.genre || "Outros")}</span>
      <button class="song-play" data-play="${originalIndex}" aria-label="Reproduzir ${escapeHtml(s.title)}">${isPlaying?"Ⅱ":"▶"}</button>
    </div>`;
  };

  if (selectedGenre !== "Todos" || query) {
    renderVisibleTrackPage(renderRow);
    return;
  }

  // Agrupa em uma única passagem e mostra uma prévia por gênero na página inicial.
  // O botão "Ver todas" abre a lista completa daquele gênero.
  const groupedMap = new Map();
  for (const song of visibleSongs) {
    const name = song.genre || "Outros";
    if (!groupedMap.has(name)) groupedMap.set(name, []);
    groupedMap.get(name).push(song);
  }
  const grouped = [...groupedMap.entries()].map(([name, tracks]) => ({ name, tracks }));

  $("songList").innerHTML = grouped.map(group => `
    <section class="genre-shelf">
      <div class="genre-shelf-head">
        <div><span class="shelf-kicker">EXPLORE O ESTILO</span><h3>${escapeHtml(group.name)}</h3></div>
        <button class="see-genre" data-genre="${escapeHtml(group.name)}">Ver todas <span>→</span></button>
      </div>
      <div class="shelf-track-list">${group.tracks.slice(0, 12).map(renderRow).join("")}</div>
    </section>
  `).join("");
}

function renderVisibleTrackPage(renderRow) {
  const shown = visibleSongs.slice(0, visibleTrackLimit);
  const remaining = visibleSongs.length - shown.length;
  $("songList").innerHTML = shown.map(renderRow).join("") +
    (remaining > 0 ? `<div class="load-more-wrap"><button type="button" id="loadMoreSongs" class="see-genre">Carregar mais músicas (${remaining})</button></div>` : "");
}
function sameTrackText(a, b) {
  const normalize = value => String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "").trim();
  const first = normalize(a), second = normalize(b);
  return !!first && !!second && (first === second || first.includes(second) || second.includes(first));
}
function setScrollingTitle(element, title) {
  if (!element) return;
  const text = title || "Escolha uma música";
  const safeTitle = escapeHtml(text);
  element.innerHTML = '<span class="player-title-window"><span class="player-title-track"><span>' + safeTitle + '</span><span aria-hidden="true">' + safeTitle + '</span></span></span>';
  const windowEl = element.querySelector(".player-title-window");
  const track = element.querySelector(".player-title-track");
  const firstCopy = track && track.firstElementChild;
  if (!windowEl || !track || !firstCopy) return;
  const measureAndSet = () => {
    const available = windowEl.clientWidth;
    const textWidth = firstCopy.scrollWidth;
    if (textWidth > available + 2) {
      const distance = textWidth + 48;
      const duration = Math.max(14, Math.min(32, distance / 18));
      track.style.setProperty("--title-distance", distance + "px");
      track.style.setProperty("--title-duration", duration + "s");
      track.classList.add("is-overflowing");
    } else {
      track.classList.remove("is-overflowing");
      track.style.removeProperty("--title-distance");
      track.style.removeProperty("--title-duration");
    }
  };
  measureAndSet();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(measureAndSet);
}
function syncExpandedPlayer() {
  setScrollingTitle($("expandedTitle"), currentIndex >= 0 && songs[currentIndex] ? songs[currentIndex].title : "Escolha uma música");
  $("expandedArtist").textContent = currentIndex >= 0 && songs[currentIndex] ? ((songs[currentIndex].artist && !sameTrackText(songs[currentIndex].artist, songs[currentIndex].title)) ? songs[currentIndex].artist : "") : "Sua próxima favorita começa aqui";
  $("expandedPlayBtn").textContent = audio.paused ? "▶" : "Ⅱ";
  $("expandedCover").textContent = "♫";
}
function openExpandedPlayer() {
  syncExpandedPlayer();
  $("playerOverlay").classList.add("open");
  $("playerOverlay").setAttribute("aria-hidden","false");
}
function closeExpandedPlayer() {
  $("playerOverlay").classList.remove("open");
  $("playerOverlay").setAttribute("aria-hidden","true");
}
let playbackRequestId = 0;
let shuffleEnabled = false;
const INITIAL_TRACK_LIMIT = 100;
let visibleTrackLimit = INITIAL_TRACK_LIMIT;
// Mantém apenas a próxima faixa aquecida em segundo plano. Assim a troca fica
// rápida sem tentar baixar as 486 músicas do catálogo de uma vez.
const nextAudio = document.createElement("audio");
nextAudio.preload = "auto";
nextAudio.muted = true;
let preloadedIndex = -1;
let preloadTimer = 0;
function canPreloadNextTrack() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return !(connection && (connection.saveData || /^(slow-2g|2g)$/i.test(connection.effectiveType || "")));
}
function preloadTrack(index) {
  const song = songs[index];
  if (!song || !song.audioUrl || !canPreloadNextTrack()) return;
  if (preloadedIndex === index && nextAudio.src === song.audioUrl) return;
  nextAudio.pause();
  nextAudio.src = song.audioUrl;
  nextAudio.load();
  preloadedIndex = index;
}
function preloadNextTrack(index) {
  clearTimeout(preloadTimer);
  if (!songs.length || !canPreloadNextTrack()) return;
  const nextIndex = (index + 1) % songs.length;
  // Dá prioridade total à faixa atual antes de aquecer a próxima.
  preloadTimer = window.setTimeout(() => preloadTrack(nextIndex), 1200);
}
function updateShuffleButton() {
  const button = $("shuffleBtn");
  if (!button) return;
  button.classList.toggle("active", shuffleEnabled);
  button.setAttribute("aria-pressed", String(shuffleEnabled));
  button.textContent = shuffleEnabled ? "🔀 Aleatório: ligado" : "🔀 Aleatório: desligado";
}
function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title || "Mundo Musical",
        artist: song.artist || "Artista desconhecido",
        album: "Mundo Musical"
      });
    }
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  } catch (error) {
    console.warn("Não foi possível atualizar os controles de mídia:", error);
  }
}
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play: () => {
      if (currentIndex >= 0) audio.play().catch(() => {});
      else if (songs.length) playSong(0);
    },
    pause: () => audio.pause(),
    nexttrack: () => stepSong(1),
    previoustrack: () => stepSong(-1)
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) {
      console.debug("Ação de mídia não suportada:", action);
    }
  }
}

function playSong(index) {
  const song = songs[index];
  if (!song || !song.audioUrl) return;

  // Começa a buscar e reproduzir o novo áudio antes de redesenhar listas pesadas.
  const requestId = ++playbackRequestId;
  currentIndex = index;
  setupMediaSession();
  updateMediaSession(song);
  // Encerra a faixa anterior antes de trocar a origem, evitando disputas entre
  // solicitações quando o usuário toca várias vezes em "próxima".
  audio.pause();
  audio.preload = "auto";
  // CORS deve ser definido antes de carregar a faixa para permitir Web Audio sem reabri-la depois.
  // Não forçar CORS aqui: sem cabeçalhos CORS no R2 isso pode bloquear o áudio.
  // Para usar Web Audio/equalizador, configure CORS no bucket antes de ativá-lo.
  audio.src = song.audioUrl;
  audio.load();
  const playback = audio.play();

  // Mantém o nome da faixa sempre visível no mini player, inclusive no Android.
  const miniTitle = $("currentTitle");
  miniTitle.textContent = song.title || "Música sem título";
  miniTitle.setAttribute("aria-label", song.title || "Música sem título");
  $("currentArtist").textContent = (song.artist && !sameTrackText(song.artist, song.title)) ? song.artist : "Carregando música…";
  $("currentCover").textContent = "♫";
  $("playBtn").textContent = "Ⅱ";
  syncExpandedPlayer();
  updatePlaybackRows();

  if (playback && typeof playback.then === "function") {
    playback.then(() => {
      if (requestId !== playbackRequestId) return;
      $("playBtn").textContent = "Ⅱ";
      $("currentArtist").textContent = (song.artist && !sameTrackText(song.artist, song.title)) ? song.artist : "";
      if ($("expandedPlayBtn")) $("expandedPlayBtn").textContent = "Ⅱ";
      syncExpandedPlayer();
      updatePlaybackRows();
      preloadNextTrack(index);
    }).catch(() => {
      if (requestId !== playbackRequestId) return;
      $("playBtn").textContent = "▶";
      $("currentArtist").textContent = "Não foi possível reproduzir. Verifique a URL pública do áudio.";
      syncExpandedPlayer();
      updatePlaybackRows();
    });
  }
}
function updatePlaybackRows() {
  document.querySelectorAll(".song-row").forEach(row => {
    const index = Number(row.dataset.index);
    const active = index === currentIndex && !audio.paused && !audio.ended;
    row.classList.toggle("playing", active);
    const button = row.querySelector("[data-play]");
    if (button) button.textContent = active ? "Ⅱ" : "▶";
  });
  document.querySelectorAll(".genre-card").forEach(card => {
    const genre = card.dataset.genre;
    const icon = card.querySelector(".genre-card-play");
    const active = currentIndex >= 0 && songs[currentIndex] && songs[currentIndex].genre === genre && !audio.paused;
    if (icon) icon.textContent = active ? "Ⅱ" : "▶";
  });
}
function togglePlay() {
  if (currentIndex < 0) {
    const first = visibleSongs[0] || songs[0];
    if (first) playSong(songs.indexOf(first));
    return;
  }
  if (audio.paused) {
    audio.play().catch(error => console.error("Falha ao retomar áudio:", error));
  } else {
    audio.pause();
  }
  syncPlaybackIcons();
}
function stepSong(delta) {
  if (!songs.length) return;
  if (shuffleEnabled && delta > 0) {
    let next = currentIndex;
    if (songs.length > 1) {
      while (next === currentIndex) next = Math.floor(Math.random() * songs.length);
    }
    playSong(next < 0 ? 0 : next);
    return;
  }
  const start = currentIndex < 0 ? 0 : currentIndex;
  playSong((start + delta + songs.length) % songs.length);
}

function stepFolder(delta) {
  const folders = genres();
  if (!folders.length) return;
  const currentFolder = currentIndex >= 0 && songs[currentIndex] ? (songs[currentIndex].genre || "Sem pasta") : selectedGenre;
  let folderIndex = folders.indexOf(currentFolder);
  if (folderIndex < 0) folderIndex = folders.indexOf(selectedGenre);
  if (folderIndex < 0) folderIndex = 0;
  const nextFolder = folders[(folderIndex + delta + folders.length) % folders.length];
  selectedGenre = nextFolder;
  $("searchInput").value = "";
  renderGenres(); renderGenreCards(); renderSongs();
  const firstIndex = songs.findIndex(song => (song.genre || "Sem pasta") === nextFolder);
  if (firstIndex >= 0) playSong(firstIndex);
}

document.addEventListener("click", event => {
  const loadMoreButton = event.target.closest("#loadMoreSongs");
  if (loadMoreButton) {
    visibleTrackLimit += INITIAL_TRACK_LIMIT;
    const query = $("searchInput").value.trim().toLocaleLowerCase("pt-BR");
    const renderRow = (s, i) => {
      const originalIndex = s._index;
      const isPlaying = currentIndex === originalIndex && !audio.paused;
      const palettes = ["linear-gradient(135deg,#7148d8,#21143d)","linear-gradient(135deg,#d44d88,#421b43)","linear-gradient(135deg,#159ca0,#143b51)","linear-gradient(135deg,#d07b36,#4a251f)","linear-gradient(135deg,#4d77d5,#202653)","linear-gradient(135deg,#4da66b,#183a31)"];
      const palette = palettes[(originalIndex < 0 ? i : originalIndex) % palettes.length];
      return `<div class="song-row ${isPlaying?"playing":""}" data-index="${originalIndex}"><div class="song-cover" style="--cover-bg:${palette[originalIndex % palettes.length]}"><span>♫</span></div><div class="song-info"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.artist || "Artista desconhecido")}</span></div><span class="song-genre">${escapeHtml(s.genre || "Outros")}</span><button class="song-play" data-play="${originalIndex}" aria-label="Reproduzir ${escapeHtml(s.title)}">${isPlaying?"Ⅱ":"▶"}</button></div>`;
    };
    renderVisibleTrackPage(renderRow);
    return;
  }
  const genreButton = event.target.closest("[data-genre]");
  if (genreButton) {
    selectedGenre = genreButton.dataset.genre;
    renderGenres(); renderGenreCards(); renderSongs();
    return;
  }
  const playButton = event.target.closest("[data-play]");
  if (playButton) { playSong(Number(playButton.dataset.play)); return; }
  const row = event.target.closest(".song-row");
  if (row) playSong(Number(row.dataset.index));
});
$("searchInput").addEventListener("input", renderSongs);
$("exploreBtn").addEventListener("click", () => $("songList").scrollIntoView({behavior:"smooth",block:"start"}));
$("homeBtn").addEventListener("click", () => {selectedGenre="Todos";$("searchInput").value="";renderGenres();renderSongs();});
$("libraryBtn").addEventListener("click", () => {
  $("songList").innerHTML = `<div class="empty-card">Sua biblioteca pessoal poderá ser adicionada em uma próxima etapa.</div>`;
  $("listTitle").textContent = "Minha biblioteca";
});
$("playBtn").addEventListener("click", togglePlay);
$("prevBtn").addEventListener("click", () => stepSong(-1));
$("nextBtn").addEventListener("click", () => stepSong(1));
$("volume").addEventListener("input", e => audio.volume = Number(e.target.value));
audio.volume = 0.8;
audio.addEventListener("timeupdate", () => {
  $("currentTime").textContent = formatTime(audio.currentTime);
  $("duration").textContent = formatTime(audio.duration);
  $("progress").value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  $("progress").style.setProperty("--progress-percent", $("progress").value + "%");
  $("expandedCurrentTime").textContent = formatTime(audio.currentTime);
  $("expandedDuration").textContent = formatTime(audio.duration);
  $("expandedProgress").value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
});
$("expandedProgress").addEventListener("input", e => { if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration; });
$("expandedVolume").addEventListener("input", e => { audio.volume = Number(e.target.value); $("volume").value = e.target.value; });
$("openPlayerBtn").addEventListener("click", openExpandedPlayer);
$("closePlayerBtn").addEventListener("click", closeExpandedPlayer);
$("playerOverlay").addEventListener("click", e => { if (e.target.id === "playerOverlay") closeExpandedPlayer(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeExpandedPlayer(); });
$("expandedPlayBtn").addEventListener("click", togglePlay);
$("expandedPrevBtn").addEventListener("click", () => stepSong(-1));
$("expandedNextBtn").addEventListener("click", () => stepSong(1));
$("shuffleBtn").addEventListener("click", () => { shuffleEnabled = !shuffleEnabled; updateShuffleButton(); });
$("enhancerPanelToggle").addEventListener("click",()=>{
 const panel=$("audioEnhancerPanel"),opening=panel.hidden;
 panel.hidden=!opening;
 $("enhancerPanelToggle").setAttribute("aria-expanded",String(opening));
 $("enhancerPanelArrow").textContent=opening?"−":"＋";
});
$("audioEnhancerToggle").addEventListener("click",enableAudioEnhancer);
$("audioEnhancerMode").addEventListener("change",applyEnhancerPreset);
$("enhancerPreamp").addEventListener("input",()=>{applyEnhancerSettings();if(enhancerEnabled)enhancerStatus("Equalizador ativo • "+selectedEnhancerLabel());});
EQ_BANDS.forEach(band=>$(band.id).addEventListener("input",()=>{applyEnhancerSettings();if(enhancerEnabled)enhancerStatus("Equalizador ativo • ajuste personalizado");}));
$("eqResetBtn").addEventListener("click",applyEnhancerPreset);
$("eqFlatBtn").addEventListener("click",setFlatEqualizer);
applyEnhancerSettings();
updateShuffleButton();
$("prevFolderBtn").addEventListener("click", () => stepFolder(-1));
$("nextFolderBtn").addEventListener("click", () => stepFolder(1));
const progressBar = $("progress");
let progressHideTimer;
function showProgressThumb() {
  progressBar.classList.add("seek-touched");
  clearTimeout(progressHideTimer);
}
function hideProgressThumbSoon() {
  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(() => progressBar.classList.remove("seek-touched"), 650);
}
progressBar.addEventListener("pointerdown", showProgressThumb);
progressBar.addEventListener("pointerup", hideProgressThumbSoon);
progressBar.addEventListener("pointercancel", hideProgressThumbSoon);
progressBar.addEventListener("touchstart", showProgressThumb, { passive: true });
progressBar.addEventListener("touchend", hideProgressThumbSoon, { passive: true });
progressBar.addEventListener("blur", () => progressBar.classList.remove("seek-touched"));
progressBar.addEventListener("keydown", showProgressThumb);
progressBar.addEventListener("keyup", hideProgressThumbSoon);
$("progress").addEventListener("input", e => {
  e.currentTarget.style.setProperty("--progress-percent", e.currentTarget.value + "%");
  if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration;
});
audio.addEventListener("ended", () => stepSong(1));
function syncPlaybackIcons() {
  const playing = !audio.paused && !audio.ended;
  $("playBtn").textContent = playing ? "Ⅱ" : "▶";
  if ($("expandedPlayBtn")) $("expandedPlayBtn").textContent = playing ? "Ⅱ" : "▶";
  updatePlaybackRows();
}
audio.addEventListener("play", () => { syncPlaybackIcons(); if (currentIndex >= 0) updateMediaSession(songs[currentIndex]); });
audio.addEventListener("playing", () => {
  syncPlaybackIcons();
  if (currentIndex >= 0 && songs[currentIndex]) {
    const miniTitle = $("currentTitle");
    if (miniTitle && !miniTitle.textContent.trim()) miniTitle.textContent = songs[currentIndex].title || "Música sem título";
  }
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => { syncPlaybackIcons(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
audio.addEventListener("ended", syncPlaybackIcons);
renderGenres();
renderGenreCards();
loadSongs();


// Instalação como aplicativo (PWA) no Android e em navegadores compatíveis.
let deferredInstallPrompt = null;
const installButton = document.getElementById('installButton');
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installButton) installButton.hidden = false;
});
if (installButton) {
  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      alert('Para instalar no Android: toque nos três pontos (⋮) do Chrome e escolha “Instalar aplicativo” ou “Adicionar à tela inicial”.');
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });
}
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installButton) installButton.hidden = true;
});
