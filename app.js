const $ = (id) => document.getElementById(id);
const audio = $("audio");
let songs = [];
let visibleSongs = [];
let currentIndex = -1;
let selectedGenre = "Todos";
let favoritesOnly = false;

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
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível carregar o catálogo");
      const page = await response.json();
      if (Array.isArray(page.songs)) allSongs.push(...page.songs);
      cursor = page.nextCursor || "";
    } while (cursor);

    songs = allSongs
      .map(s => ({
        ...s,
        genre: s.genre || s.gênero || "Outros",
        audioUrl: String(s.audioUrl || "").replace(/\s+\//g, "/")
      }))
      .filter(s => s && s.title && s.audioUrl);

    if (!songs.length) throw new Error("Catálogo vazio");
    renderGenres();
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
  return [...new Set(songs.map(s => s.genre || "Outros"))].sort((a,b) => a.localeCompare(b,"pt-BR"));
}
function renderGenres() {
  const all = ["Todos", ...genres()];
  $("genreChips").innerHTML = all.map(g => `<button class="chip ${g===selectedGenre?"selected":""}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("");
  $("sideGenres").innerHTML = genres().slice(0,12).map(g => `<button class="side-genre" data-genre="${escapeHtml(g)}">♫ &nbsp; ${escapeHtml(g)}</button>`).join("");
}
function renderSongs() {
  const query = $("searchInput").value.trim().toLocaleLowerCase("pt-BR");
  visibleSongs = songs.filter(s => {
    const matchesGenre = selectedGenre === "Todos" || (s.genre || "Outros") === selectedGenre;
    const searchable = [s.title,s.artist,s.genre].join(" ").toLocaleLowerCase("pt-BR");
    return matchesGenre && searchable.includes(query);
  });
  $("listTitle").textContent = selectedGenre === "Todos" ? "Todas as músicas" : selectedGenre;
  $("trackCount").textContent = `${visibleSongs.length} ${visibleSongs.length === 1 ? "faixa" : "faixas"}`;
  if (!visibleSongs.length) {
    $("songList").innerHTML = `<div class="empty-card">Nenhuma música encontrada com esse filtro.</div>`;
    return;
  }
  $("songList").innerHTML = visibleSongs.slice(0,300).map((s, i) => {
    const originalIndex = songs.indexOf(s);
    const isPlaying = currentIndex === originalIndex && !audio.paused;
    return `<div class="song-row ${isPlaying?"playing":""}" data-index="${originalIndex}">
      <div class="song-cover">♫</div>
      <div class="song-info"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.artist || "Artista desconhecido")}</span></div>
      <span class="song-genre">${escapeHtml(s.genre || "Outros")}</span>
      <button class="song-play" data-play="${originalIndex}" aria-label="Reproduzir ${escapeHtml(s.title)}">${isPlaying?"Ⅱ":"▶"}</button>
    </div>`;
  }).join("");
}
function playSong(index) {
  const song = songs[index];
  if (!song || !song.audioUrl) return;
  currentIndex = index;
  audio.src = song.audioUrl;
  audio.play().then(() => {
    $("currentTitle").textContent = song.title;
    $("currentArtist").textContent = song.artist || "Artista desconhecido";
    $("currentCover").textContent = "♫";
    $("playBtn").textContent = "Ⅱ";
    renderSongs();
  }).catch(() => {
    $("currentTitle").textContent = song.title;
    $("currentArtist").textContent = "Não foi possível reproduzir. Verifique a URL pública do áudio.";
    $("playBtn").textContent = "▶";
  });
}
function togglePlay() {
  if (currentIndex < 0) {
    const first = visibleSongs[0] || songs[0];
    if (first) playSong(songs.indexOf(first));
    return;
  }
  if (audio.paused) audio.play().then(() => {$("playBtn").textContent="Ⅱ";renderSongs();}).catch(()=>{});
  else { audio.pause(); $("playBtn").textContent="▶"; renderSongs(); }
}
function stepSong(delta) {
  if (!songs.length) return;
  const start = currentIndex < 0 ? 0 : currentIndex;
  playSong((start + delta + songs.length) % songs.length);
}

document.addEventListener("click", event => {
  const genreButton = event.target.closest("[data-genre]");
  if (genreButton) {
    selectedGenre = genreButton.dataset.genre;
    renderGenres(); renderSongs();
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
});
$("progress").addEventListener("input", e => {
  if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration;
});
audio.addEventListener("ended", () => stepSong(1));
audio.addEventListener("play", () => $("playBtn").textContent = "Ⅱ");
audio.addEventListener("pause", () => $("playBtn").textContent = "▶");
loadSongs();
