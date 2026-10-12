const $ = (id) => document.getElementById(id);
const audio = $("audio");
let songs = [];
let visibleSongs = [];
let currentIndex = -1;
let selectedGenre = "Todos";
let favoritesOnly = false;

const CATEGORIES = ["Funk", "Mega funk", "Sertanejo", "Rap", "Trap", "House", "Piseiro", "Forró", "Pagode", "Phonk", "Brazilian Phonk", "Eletrofunk", "Reggaeton", "Pop", "Techno", "Deep House", "Drill", "Arrocha"];

function classifySong(song) {
  const rawGenre = String(song.genre || song.gênero || song.genero || song.category || "").toLocaleLowerCase("pt-BR");
  const details = [rawGenre, song.title, song.artist, song.audioUrl, song.key, song.name].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR");
  // As categorias mais específicas são verificadas antes das mais amplas.
  if (/brazilian[\s_-]*phonk|phonk[\s_-]*brasileiro/.test(details)) return "Brazilian Phonk";
  if (/mega[\s_-]*funk|megafunk/.test(details)) return "Mega funk";
  if (/eletro[\s_-]*funk|electro[\s_-]*funk/.test(details)) return "Eletrofunk";
  if (/deep[\s_-]*house/.test(details)) return "Deep House";
  if (/\bdrill\b/.test(details)) return "Drill";
  if (/\bphonk\b/.test(details)) return "Phonk";
  if (/\btechno\b/.test(details)) return "Techno";
  if (/reggaeton|reguet[oó]n/.test(details)) return "Reggaeton";
  if (/\barrocha\b/.test(details)) return "Arrocha";
  if (/\bpiseiro\b|pisadinha/.test(details)) return "Piseiro";
  if (/forr[oó]|\bxote\b|bai[aã]o/.test(details)) return "Forró";
  if (/pagode|\bsamba\b/.test(details)) return "Pagode";
  if (/\bpop\b|pop[\s_-]*rock/.test(details)) return "Pop";
  if (/sertanejo|mod[aã]o|universit[aá]rio|sofr[eê]ncia/.test(details)) return "Sertanejo";
  if (/\btrap\b/.test(details)) return "Trap";
  if (/\brap\b|hip[\s-]*hop|boom[\s-]*bap/.test(details)) return "Rap";
  if (/\bhouse\b/.test(details)) return "House";
  if (/\bfunk\b|mandel[aã]o|ostenta[cç][aã]o/.test(details)) return "Funk";
  return "Outros";
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
      const response = await fetch(url, { cache: "no-store" });
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
  return CATEGORIES;
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
  target.innerHTML = list.map((g, i) => {
    const count = songs.filter(s => s.genre === g).length;
    return `<button class="genre-card ${g===selectedGenre?"active":""}" data-genre="${escapeHtml(g)}" style="--genre-bg:${palettes[i % palettes.length]}">
      <span class="genre-card-art" aria-hidden="true">${symbols[i % symbols.length]}</span>
      <span class="genre-card-name">${escapeHtml(g)}</span>
      <span class="genre-card-count">${count} ${count === 1 ? "música" : "músicas"}</span>
      <span class="genre-card-play" aria-hidden="true">▶</span>
    </button>`;
  }).join("");
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

function syncExpandedPlayer() {
  $("expandedTitle").textContent = currentIndex >= 0 && songs[currentIndex] ? songs[currentIndex].title : "Escolha uma música";
  $("expandedArtist").textContent = currentIndex >= 0 && songs[currentIndex] ? (songs[currentIndex].artist || "Artista desconhecido") : "Sua próxima favorita começa aqui";
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
    syncExpandedPlayer();
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
$("progress").addEventListener("input", e => {
  if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration;
});
audio.addEventListener("ended", () => stepSong(1));
audio.addEventListener("play", () => { $("playBtn").textContent = "Ⅱ"; if ($("expandedPlayBtn")) $("expandedPlayBtn").textContent = "Ⅱ"; });
audio.addEventListener("pause", () => { $("playBtn").textContent = "▶"; if ($("expandedPlayBtn")) $("expandedPlayBtn").textContent = "▶"; });
renderGenres();
renderGenreCards();
loadSongs();
