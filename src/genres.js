// Жанры для /genres и еженедельной подборки.
// movie/tv — id жанров TMDB; у сериалов часть жанров отсутствует (пустой массив = не фильтруем этот тип).

export const GENRES = [
  { slug: 'action',    label: 'Боевик',        movie: [28],    tv: [10759] },
  { slug: 'adventure', label: 'Приключения',   movie: [12],    tv: [10759] },
  { slug: 'animation', label: 'Аниме и мульт', movie: [16],    tv: [16] },
  { slug: 'comedy',    label: 'Комедия',       movie: [35],    tv: [35] },
  { slug: 'crime',     label: 'Криминал',      movie: [80],    tv: [80] },
  { slug: 'doc',       label: 'Документалки',  movie: [99],    tv: [99] },
  { slug: 'drama',     label: 'Драма',         movie: [18],    tv: [18] },
  { slug: 'family',    label: 'Семейное',      movie: [10751], tv: [10751] },
  { slug: 'fantasy',   label: 'Фэнтези',       movie: [14],    tv: [10765] },
  { slug: 'history',   label: 'Историческое',  movie: [36],    tv: [10768] },
  { slug: 'horror',    label: 'Ужасы',         movie: [27],    tv: [] },
  { slug: 'mystery',   label: 'Детектив',      movie: [9648],  tv: [9648] },
  { slug: 'romance',   label: 'Ромком и мело', movie: [10749, 35], tv: [35] },
  { slug: 'scifi',     label: 'Фантастика',    movie: [878],   tv: [10765] },
  { slug: 'thriller',  label: 'Триллер',       movie: [53],    tv: [9648] },
  { slug: 'war',       label: 'Военное',       movie: [10752], tv: [10768] },
  { slug: 'western',   label: 'Вестерн',       movie: [37],    tv: [37] },
];

const BY_SLUG = new Map(GENRES.map((g) => [g.slug, g]));

export function parsePrefs(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => BY_SLUG.has(s));
}

export function serializePrefs(slugs) {
  const set = new Set(slugs.filter((s) => BY_SLUG.has(s)));
  return GENRES.filter((g) => set.has(g.slug)).map((g) => g.slug).join(',');
}

export function labelsFor(slugs) {
  return parsePrefs(slugs.join ? slugs.join(',') : slugs).map((s) => BY_SLUG.get(s).label);
}

/** Список id жанров TMDB для discover по конкретному типу. */
export function tmdbGenreIds(slugs, mediaType) {
  const ids = new Set();
  for (const slug of parsePrefs(slugs.join ? slugs.join(',') : slugs)) {
    for (const id of BY_SLUG.get(slug)[mediaType] || []) ids.add(id);
  }
  return [...ids];
}

export function genreBySlug(slug) {
  return BY_SLUG.get(slug) || null;
}
