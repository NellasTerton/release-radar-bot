// OMDb отдаёт то, чего нет в TMDB: оценку IMDb (это и есть голоса обычных зрителей,
// сотни тысяч человек) и Tomatometer с Rotten Tomatoes (это критики).
// Пользовательский Audience Score с RT официально не отдаёт никто — его в API нет.
// Бесплатный ключ: 1000 запросов в сутки, поэтому всё, что получили, кладём в D1.

import { isRussianItem } from './kinopoisk.js';

const BASE = 'https://www.omdbapi.com/';

function parseRatings(data) {
  const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
  const imdbRating = Number.parseFloat(data.imdbRating);
  const votes = Number.parseInt(String(data.imdbVotes || '').replace(/[^\d]/g, ''), 10);
  return {
    imdb_rating: Number.isFinite(imdbRating) ? imdbRating : null,
    imdb_votes: Number.isFinite(votes) ? votes : null,
    rt_critics: rt ? Number.parseInt(rt.Value, 10) || null : null,
  };
}

/** Рейтинги по imdb_id. Возвращает null, если ключа нет, бюджет кончился или тайтл неизвестен. */
export async function fetchRatings(env, budget, imdbId) {
  if (!env.OMDB_API_KEY || !imdbId || !budget.has(2)) return null;
  const url = new URL(BASE);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('apikey', env.OMDB_API_KEY);
  const res = await budget.fetch(url);
  if (!res || !res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.Response === 'False') return null;
  return parseRatings(data);
}

/**
 * Запасной путь, когда у TMDB нет IMDb-идентификатора (так было у «Лиззи Борден»):
 * OMDb официально ищет по точному названию и году. Возвращает и найденный imdb_id.
 */
export async function fetchRatingsByTitle(env, budget, title, year, mediaType) {
  if (!env.OMDB_API_KEY || !title || !budget.has(2)) return null;
  const url = new URL(BASE);
  url.searchParams.set('t', title);
  if (year) url.searchParams.set('y', year);
  url.searchParams.set('type', mediaType === 'tv' ? 'series' : 'movie');
  url.searchParams.set('apikey', env.OMDB_API_KEY);
  const res = await budget.fetch(url);
  if (!res || !res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.Response === 'False') return null;
  return { imdb_id: data.imdbID || null, ...parseRatings(data) };
}

/** Короткая строка рейтингов для подписи: зрители (IMDb) и критики (RT). */
export function ratingLine(meta, tmdbVote) {
  const parts = [];
  if (meta && isRussianItem(meta) && meta.kp_rating && (meta.kp_votes == null || meta.kp_votes >= 100)) {
    parts.push(`КП ${Number(meta.kp_rating).toFixed(1)}`);
  }
  if (meta?.imdb_rating) parts.push(`IMDb ${meta.imdb_rating.toFixed(1)}`);
  else if (tmdbVote) parts.push(`TMDB ${Number(tmdbVote).toFixed(1)}`);
  if (meta?.rt_critics) parts.push(`🍅 ${meta.rt_critics}%`);
  return parts.join(' · ');
}
