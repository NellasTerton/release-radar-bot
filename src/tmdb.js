import { today, shiftDate } from './format.js';
import { COUNTRIES } from './filters.js';

const BASE = 'https://api.themoviedb.org/3';
const TVMAZE = 'https://api.tvmaze.com';

function authInit(env, url) {
  // v4 read token (Bearer) предпочтительнее, v3 api_key — запасной вариант.
  if (env.TMDB_READ_TOKEN) {
    return { headers: { authorization: `Bearer ${env.TMDB_READ_TOKEN}`, accept: 'application/json' } };
  }
  url.searchParams.set('api_key', env.TMDB_API_KEY || '');
  return { headers: { accept: 'application/json' } };
}

export async function tmdb(env, budget, path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('language', env.TMDB_LANGUAGE || 'ru-RU');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const init = authInit(env, url);
  const res = await budget.fetch(url, init);
  if (!res) return null;
  if (!res.ok) {
    console.warn('tmdb error', res.status, path);
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function searchMulti(env, budget, query) {
  const data = await tmdb(env, budget, '/search/multi', { query, include_adult: 'false', page: 1 });
  if (!data?.results) return [];
  return data.results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

export async function getDetails(env, budget, mediaType, id, withCredits = false, withImages = false) {
  const path = mediaType === 'movie' ? `/movie/${id}` : `/tv/${id}`;
  const append = [mediaType === 'movie' ? 'release_dates' : 'external_ids'];
  // translations не стоит лишнего субзапроса, зато даёт английское описание,
  // когда русского у тайтла ещё нет.
  if (withCredits) append.push('credits', 'translations');
  // Кадры нужны только на карточке тайтла: в остальных местах они зря раздувают ответ.
  if (withImages) append.push('images');
  const data = await tmdb(env, budget, path, {
    append_to_response: append.join(','),
    // Без этого TMDB отдаёт только картинки с русскими надписями, а их почти нет.
    include_image_language: withImages ? 'ru,en,null' : undefined,
  });
  if (data) data.media_type = mediaType;
  return data;
}

export async function trending(env, budget, page = 1, mediaType = 'all') {
  const data = await tmdb(env, budget, `/trending/${mediaType}/week`, { page });
  if (!data?.results) return { results: [], total_pages: 1 };
  return {
    results: data.results
      .map((r) => ({ ...r, media_type: r.media_type || mediaType }))
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv'),
    total_pages: Math.min(data.total_pages || 1, 10),
  };
}

// TMDB ранжирует по мировой популярности, поэтому в выдачу лезут индийские,
// китайские и турецкие релизы, которых здесь никто не ждёт. Отсеиваем на своей стороне;
// для сериалов ещё и в самом запросе (with_original_language со списком через | —
// в сентябре 2026 проверено, работает), см. enumerate в catalog.js.
const KEEP_LANGUAGES = new Set([
  'en', 'ru', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'nl',
  'sv', 'da', 'no', 'fi', 'pl', 'cs', 'uk', 'is',
]);

/** Отсев для витрин: понятный язык + есть постер (заодно отсекает полупустые записи). */
/**
 * Крупные платформы и телеканалы. Премьера сериала выходит с нулём оценок и низкой
 * популярностью — по ним её не отличить от самоделки. Зато сам факт, что сериал выходит
 * на Netflix, Disney+ или HBO, уже говорит о заметности.
 */
// Только стриминги и крупный кабель. Обычные телеканалы (ABC, NBC, CBS, FOX, The CW,
// BBC, ITV, Channel 4) сюда не входят: у них много местных и малоизвестных сериалов,
// и они забивали список — такие проходят обычным путём, по оценкам и популярности.
export const MAJOR_NETWORKS = new Map([
  [213, 'Netflix'], [1024, 'Prime Video'], [2739, 'Disney+'], [2552, 'Apple TV+'],
  [49, 'HBO'], [3186, 'Max'], [4330, 'Paramount+'], [453, 'Hulu'], [3353, 'Peacock'],
  [67, 'Showtime'], [318, 'Starz'], [174, 'AMC'], [88, 'FX'], [6219, 'MGM+'],
  [1112, 'Crunchyroll'], [2087, 'Sky Atlantic'],
]);

/** Платформа сериала, если это крупная; иначе null. */
export function networkName(details) {
  for (const n of details?.networks || []) {
    const name = MAJOR_NETWORKS.get(n.id);
    if (name) return name;
  }
  return null;
}

export function filterShowable(results) {
  return (results || []).filter((r) => KEEP_LANGUAGES.has(r.original_language) && r.poster_path);
}

export function posterUrl(path, size = 'w500') {
  if (!path) return null;
  // У записей Кинопоиска постер — уже готовая ссылка.
  if (/^https?:/.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

/**
 * Скоро выходящее через discover.
 * byAirDate=true для сериалов даёт эфир в окне, то есть и новые сезоны идущих шоу,
 * а не только премьеры новых сериалов.
 */
export async function discoverUpcoming(env, budget, opts = {}) {
  const {
    mediaType = 'movie', genreIds = [], page = 1, days = 60, byAirDate = false, pastDays = 0,
    region = null, fromDays = null, languages = null, countries = null, networks = null,
  } = opts;
  // pastDays захватывает и недавнее прошлое — для блока «Вышло за неделю».
  // fromDays — начало окна в будущем: для обхода дальних месяцев по одному.
  const from = shiftDate(today(env), fromDays ?? -pastDays);
  const to = shiftDate(today(env), days);
  const common = {
    page,
    sort_by: 'popularity.desc',
    include_adult: 'false',
    with_genres: genreIds.length ? genreIds.join('|') : undefined,
    // Несколько значений через | — TMDB понимает это как «любой из».
    with_original_language: languages?.length ? languages.join('|') : undefined,
    with_origin_country: countryCodes(countries),
    with_networks: networks?.length ? networks.join('|') : undefined,
  };
  const data = mediaType === 'movie'
    ? await tmdb(env, budget, '/discover/movie', {
      ...common,
      with_release_type: '2|3|4|6',
      // С явным регионом ищем по датам релиза в этой стране (прокат, онлайн, ТВ),
      // а не по мировой премьере: иначе фильм, вышедший у нас позже, не находится.
      ...(region
        ? { region, 'release_date.gte': from, 'release_date.lte': to }
        : { region: env.TMDB_REGION || 'RU', 'primary_release_date.gte': from, 'primary_release_date.lte': to }),
    })
    : await tmdb(env, budget, '/discover/tv', {
      ...common,
      // Новости, ток-шоу, реалити и мыльные оперы забивают выдачу локальным эфиром.
      without_genres: '10763,10764,10766,10767',
      [byAirDate ? 'air_date.gte' : 'first_air_date.gte']: from,
      [byAirDate ? 'air_date.lte' : 'first_air_date.lte']: to,
    });
  if (!data?.results) return { results: [], total_pages: 1 };
  return {
    results: data.results.map((r) => ({ ...r, media_type: mediaType })),
    total_pages: Math.min(data.total_pages || 1, 10),
  };
}

/** Группа стран («in», «kr_jp») — в коды для TMDB. */
function countryCodes(group) {
  if (!group) return undefined;
  const codes = COUNTRIES.find((c) => c.key === group)?.codes;
  return codes?.length ? codes.join('|') : undefined;
}

export async function findByImdb(env, budget, imdbId) {
  const data = await tmdb(env, budget, `/find/${imdbId}`, { external_source: 'imdb_id' });
  if (!data) return null;
  const movie = (data.movie_results || [])[0];
  if (movie) return { ...movie, media_type: 'movie' };
  const tv = (data.tv_results || [])[0];
  if (tv) return { ...tv, media_type: 'tv' };
  return null;
}

// ---------------------------------------------------------------------------
// Разбор дат выхода
// ---------------------------------------------------------------------------

// «Цифра» — жаргон прокатчиков; для человека это «онлайн».
const RELEASE_TYPE_LABEL = {
  2: 'В кино',
  3: 'В кино',
  4: 'Онлайн',
  6: 'На ТВ',
};

// Фестивальные премьеры (type 1) и физические носители (5) для нас бесполезны.
const USEFUL_TYPES = [4, 6, 3, 2];

/**
 * Фильм: ориентируемся на мировой прокат, а не на российскую дату. Российская бывает
 * на неделю-две позже мировой премьеры, и фильм, который уже идёт в кино, выглядел бы
 * «выходящим завтра». Берём самую раннюю дату по всем странам; если всё в прошлом —
 * самую раннюю цифровую.
 */
export function resolveMovieDate(details, todayIso) {
  const groups = details?.release_dates?.results || [];
  const picked = groups.map((g) => [g.iso_3166_1, g.release_dates || []]);

  const candidates = [];
  for (const [region, list] of picked) {
    for (const entry of list) {
      if (!USEFUL_TYPES.includes(entry.type)) continue;
      const date = String(entry.release_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      candidates.push({ region, type: entry.type, date });
    }
  }

  // День мирового старта — тот, на который приходится больше всего стран, а не самая
  // ранняя дата: у «Чужой мамы» прокат начинался в Бельгии 7 октября, в 35 странах
  // 8-го и в США 9-го, и по самой ранней дате фильм «выходил» трижды.
  const widest = (types) => {
    const byDay = new Map();
    for (const c of candidates) {
      if (!types.includes(c.type)) continue;
      byDay.set(c.date, (byDay.get(c.date) || 0) + 1);
    }
    if (!byDay.size) return null;
    // При равенстве стран берём более раннюю дату.
    return [...byDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };

  // Прокат и цифру храним отдельно — в избранном нужны обе даты.
  const theatrical = widest([2, 3]);
  const digital = widest([4, 6]);

  const ahead = [
    theatrical && { date: theatrical, label: 'В кино' },
    digital && { date: digital, label: 'Онлайн' },
  ].filter(Boolean);
  const byDate = (a, b) => a.date.localeCompare(b.date);
  const chosen = ahead.filter((c) => c.date >= todayIso).sort(byDate)[0]
    || ahead.sort((a, b) => b.date.localeCompare(a.date))[0];

  if (chosen) {
    return {
      release_date: chosen.date,
      region: null,
      release_type: chosen.label,
      theatrical_date: theatrical,
      digital_date: digital,
      // Все даты по всем странам — нужны, чтобы понять, вышел ли фильм где-нибудь.
      all_dates: candidates,
    };
  }
  const fallback = String(details?.release_date || '').slice(0, 10);
  return {
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : null,
    region: null,
    release_type: 'Релиз',
    theatrical_date: null,
    digital_date: null,
  };
}

/** Сериал: следующий эпизод, иначе будущая премьера, иначе последний вышедший эпизод. */
export function resolveTvDate(details, todayIso) {
  const next = details?.next_episode_to_air;
  if (next?.air_date) {
    return {
      release_date: next.air_date.slice(0, 10),
      region: null,
      release_type: episodeLabel(next),
    };
  }
  const first = String(details?.first_air_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(first) && first >= todayIso) {
    return { release_date: first, region: null, release_type: 'Премьера' };
  }
  const last = details?.last_episode_to_air;
  if (last?.air_date) {
    return {
      release_date: last.air_date.slice(0, 10),
      region: null,
      release_type: `${episodeLabel(last)} — последний`,
    };
  }
  return {
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(first) ? first : null,
    region: null,
    release_type: 'Сериал',
  };
}

function episodeLabel(ep) {
  const s = String(ep.season_number ?? 0).padStart(2, '0');
  const e = String(ep.episode_number ?? 0).padStart(2, '0');
  return `S${s}E${e}`;
}

/** Стоит ли идти в TVmaze: TMDB не знает следующий эпизод, но сериал не закончен. */
export function needsTvmazeFallback(details) {
  if (details?.next_episode_to_air) return false;
  const status = String(details?.status || '');
  return ['Returning Series', 'In Production', 'Planned'].includes(status);
}

/**
 * Резервный источник дат эпизодов. Стоит до 2 субзапросов,
 * поэтому вызывается только когда TMDB молчит.
 */
export async function tvmazeNextEpisode(budget, imdbId) {
  if (!imdbId || !budget.has(2)) return null;
  const res = await budget.fetch(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
  if (!res || !res.ok) return null;
  let show;
  try {
    show = await res.json();
  } catch {
    return null;
  }
  const href = show?._links?.nextepisode?.href;
  if (!href) return null;
  const epRes = await budget.fetch(href);
  if (!epRes || !epRes.ok) return null;
  let ep;
  try {
    ep = await epRes.json();
  } catch {
    return null;
  }
  const date = String(ep?.airdate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    release_date: date,
    region: null,
    release_type: `${episodeLabel({ season_number: ep.season, episode_number: ep.number })} · TVmaze`,
  };
}

export function tmdbUrl(mediaType, id) {
  // Отрицательный id — запись из Кинопоиска (см. schema.sql).
  if (Number(id) < 0) {
    return `https://www.kinopoisk.ru/${mediaType === 'tv' ? 'series' : 'film'}/${-Number(id)}/`;
  }
  return `https://www.themoviedb.org/${mediaType}/${id}`;
}
