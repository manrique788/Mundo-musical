const $ = (id) => document.getElementById(id);
const audio = $("audio");
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
      .map(s => ({
        ...s,
        genre: classifySong(s),
        audioUrl: String(s.audioUrl || "").replace(/\s+\//g, "/")
      }))
      .filter(s => s && s.title && s.audioUrl);

    if (!songs.length) throw new Error("Catálogo vazio");
    renderGenres();
    renderGenreCards();
    renderSongs();
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
    const originalIndex = songs.indexOf(s);
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
    $("songList").innerHTML = visibleSongs.map(renderRow).join("");
    return;
  }

  const grouped = [...genres(), "Outros"].map(g => ({
    name: g,
    tracks: visibleSongs.filter(s => (s.genre || "Outros") === g)
  })).filter(group => group.tracks.length);

  $("songList").innerHTML = grouped.map((group, groupIndex) => `
    <section class="genre-shelf">
      <div class="genre-shelf-head">
        <div><span class="shelf-kicker">EXPLORE O ESTILO</span><h3>${escapeHtml(group.name)}</h3></div>
        <button class="see-genre" data-genre="${escapeHtml(group.name)}">Ver todas <span>→</span></button>
      </div>
      <div class="shelf-track-list">${group.tracks.map(renderRow).join("")}</div>
    </section>
  `).join("");
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
function playSong(index) {
  const song = songs[index];
  if (!song || !song.audioUrl) return;

  // Começa a buscar e reproduzir o novo áudio antes de redesenhar listas pesadas.
  const requestId = ++playbackRequestId;
  currentIndex = index;
  audio.preload = "auto";
  audio.src = song.audioUrl;
  audio.load();
  const playback = audio.play();

  setScrollingTitle($("currentTitle"), song.title);
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
audio.addEventListener("play", syncPlaybackIcons);
audio.addEventListener("playing", syncPlaybackIcons);
audio.addEventListener("pause", syncPlaybackIcons);
audio.addEventListener("ended", syncPlaybackIcons);
renderGenres();
renderGenreCards();
loadSongs();
