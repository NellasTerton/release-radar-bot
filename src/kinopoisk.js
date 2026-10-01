// Кинопоиск через poiskkino.dev (бывший kinopoisk.dev; старый адрес отвечает 301).
// Официальный API Кинопоиска есть только у партнёров. Даёт оценку русскоязычного
// зрителя — в том числе для зарубежного кино — и счётчик «Ждут»: сколько людей
// нажали «Буду смотреть». Для российских премьер это единственный сигнал интереса,
// у TMDB у них ноль голосов.
//
// Лимит бесплатного ключа — 200 запросов в сутки, зато один запрос принимает сразу
// пачку идентификаторов TMDB и отдаёт до 250 тайтлов.

const BASE = 'https://api.poiskkino.dev/v1.4/movie';
const FIELDS = ['name', 'type', 'isSeries', 'rating', 'votes', 'externalId', 'countries'];
const SERIES_TYPES = new Set(['tv-series', 'animated-series', 'anime']);

function toRow(doc) {
  return {
    tmdb_id: doc.externalId?.tmdb || null,
    media_type: doc.isSeries || SERIES_TYPES.has(doc.type) ? 'tv' : 'movie',
    kp_rating: doc.rating?.kp ? Math.round(doc.rating.kp * 10) / 10 : null,
    kp_votes: doc.votes?.kp || 0,
    kp_await: doc.votes?.await || 0,
    russian: (doc.countries || []).some((c) => c.name === 'Россия'),
  };
}

/**
 * Данные Кинопоиска по пачке идентификаторов TMDB. Один субзапрос на пачку.
 * Ключ результата — `${media_type}:${tmdb_id}`: у фильма и сериала в TMDB
 * бывают одинаковые номера.
 */
export async function kpByTmdb(env, budget, ids) {
  const out = new Map();
  if (!env.KINOPOISK_API_KEY || !ids.length || !budget.has(2)) return out;

  const url = new URL(BASE);
  for (const id of ids) url.searchParams.append('externalId.tmdb', String(id));
  for (const f of FIELDS) url.searchParams.append('selectFields', f);
  url.searchParams.set('limit', '250');

  const res = await budget.fetch(url, { headers: { 'X-API-KEY': env.KINOPOISK_API_KEY } });
  if (!res || !res.ok) {
    console.warn('kinopoisk error', res?.status);
    return out;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return out;
  }
  for (const doc of data.docs || []) {
    const row = toRow(doc);
    if (row.tmdb_id) out.set(`${row.media_type}:${row.tmdb_id}`, row);
  }
  return out;
}

/** Название для сравнения: регистр, ё/е и пунктуация не должны мешать совпадению. */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const ddmmyyyy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// ---------------------------------------------------------------------------
// Кинопоиск как источник каталога для российского
// ---------------------------------------------------------------------------

const DETAIL_FIELDS = [
  'id', 'name', 'alternativeName', 'year', 'description', 'shortDescription', 'type', 'isSeries',
  'poster', 'backdrop', 'genres', 'persons', 'premiere', 'rating', 'votes', 'movieLength',
  'seriesLength', 'countries', 'externalId', 'status',
];

const day = (v) => (v ? String(v).slice(0, 10) : null);

/** Даты релиза: прокат/эфир в России и онлайн (на платформе или «цифра»). */
export function kpDates(doc) {
  const p = doc.premiere || {};
  return {
    cinema: day(p.russia),
    online: day(p.digital) || day(p.kinopoisk?.availabilityDate),
  };
}

export function kpIsSeries(doc) {
  return Boolean(doc.isSeries || SERIES_TYPES.has(doc.type));
}

export function kpActors(doc, limit = 2) {
  return (doc.persons || [])
    .filter((p) => p.enProfession === 'actor' && p.name)
    .slice(0, limit)
    .map((p) => p.name);
}

async function kpGet(env, budget, url) {
  if (!env.KINOPOISK_API_KEY || !budget.has(2)) return null;
  const res = await budget.fetch(url, { headers: { 'X-API-KEY': env.KINOPOISK_API_KEY } });
  if (!res || !res.ok) {
    console.warn('kinopoisk error', res?.status, String(url).slice(0, 120));
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Российские премьеры списком — вместе с постером, описанием и актёрами,
 * так что по каждому тайтлу отдельно ходить не нужно. Один субзапрос.
 * kind: 'cinema' — прокат/эфир в России, 'online' — онлайн-премьера.
 */
export async function kpPremieres(env, budget, { series, kind, fromIso, toIso, limit = 100 }) {
  const url = new URL(BASE);
  url.searchParams.set('countries.name', 'Россия');
  url.searchParams.set(kind === 'online' ? 'premiere.digital' : 'premiere.russia',
    `${ddmmyyyy(fromIso)}-${ddmmyyyy(toIso)}`);
  for (const t of series ? ['tv-series', 'animated-series'] : ['movie', 'cartoon']) {
    url.searchParams.append('type', t);
  }
  url.searchParams.set('sortField', 'votes.await');
  url.searchParams.set('sortType', '-1');
  url.searchParams.set('limit', String(limit));
  for (const f of DETAIL_FIELDS) url.searchParams.append('selectFields', f);
  const data = await kpGet(env, budget, url);
  return data?.docs || [];
}

/** Один тайтл целиком — для карточки, добавления в избранное и обновления даты. */
export async function kpById(env, budget, kpId) {
  return kpGet(env, budget, new URL(`${BASE}/${kpId}`));
}

export function kinopoiskUrl(kpId, isSeries) {
  return `https://www.kinopoisk.ru/${isSeries ? 'series' : 'film'}/${kpId}/`;
}

/**
 * Дата для избранного: ближайшая будущая из проката и онлайна, иначе последняя прошедшая.
 * Серий у Кинопоиска нет — у сериала это дата премьеры.
 */
export function kpReleaseDate(doc, todayIso) {
  const series = kpIsSeries(doc);
  const { cinema, online } = kpDates(doc);
  const dates = [
    cinema && { date: cinema, type: 'В кино' },
    online && { date: online, type: 'Онлайн' },
  ].filter(Boolean);
  const ahead = dates.filter((d) => d.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date))[0];
  const past = dates.filter((d) => d.date < todayIso).sort((a, b) => b.date.localeCompare(a.date))[0];
  const chosen = ahead || past || null;
  return {
    release_date: chosen?.date || null,
    release_type: series ? 'Премьера' : (chosen?.type || 'Релиз'),
    theatrical_date: cinema,
    digital_date: online,
    region: 'RU',
  };
}

/** Российский тайтл: из Кинопоиска (отрицательный id) или помечен российским в каталоге. */
export function isRussianItem(item) {
  return Number(item.tmdb_id ?? item.id) < 0 || Boolean(item.is_russian);
}
