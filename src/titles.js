import * as db from './db.js';
import {
  getDetails,
  resolveMovieDate,
  resolveTvDate,
  needsTvmazeFallback,
  tvmazeNextEpisode,
  findByImdb,
} from './tmdb.js';
import { fetchRatings } from './omdb.js';
import { kpByTmdb, kpById, kpReleaseDate, kpActors, kpIsSeries } from './kinopoisk.js';
import { today, titleOf } from './format.js';
import { igdbById, igdbDate, igdbPlatforms, igdbStudio, igdbCover } from './igdb.js';

/** Русское описание, иначе английское — как в витрине. */
export function pickOverview(details) {
  const ru = (details?.overview || '').trim();
  if (ru) return ru;
  const list = details?.translations?.translations || [];
  return ((list.find((t) => t.iso_639_1 === 'en')?.data?.overview) || '').trim() || null;
}

/** Посчитать дату выхода по уже полученным деталям TMDB (+ TVmaze, если нужно и есть бюджет). */
export async function resolveDate(env, budget, details, todayIso) {
  if (details.media_type === 'movie') {
    return resolveMovieDate(details, todayIso);
  }
  const fromTmdb = resolveTvDate(details, todayIso);
  if (fromTmdb.release_date && fromTmdb.release_date >= todayIso) return fromTmdb;
  if (needsTvmazeFallback(details)) {
    const imdbId = details.external_ids?.imdb_id;
    const alt = await tvmazeNextEpisode(budget, imdbId);
    if (alt) return alt;
  }
  return fromTmdb;
}

/**
 * Добавить тайтл в избранное: один запрос к TMDB за деталями,
 * сразу же записываем дату и last_checked_at, чтобы крон не тратил на него субзапрос.
 */
/** Игра из IGDB: платформы кладём в поле статуса, подпись про точность даты — в тип релиза. */
async function addGame(env, budget, userId, gameId) {
  const game = await igdbById(env, budget, gameId);
  if (!game) return { ok: false, reason: 'igdb' };

  const { date, note } = igdbDate(game);
  await db.ensureUser(env, userId);
  await db.upsertReleaseDate(env, {
    tmdbId: gameId,
    mediaType: 'game',
    region: null,
    releaseType: note || 'Выход',
    releaseDate: date,
    theatricalDate: null,
    digitalDate: null,
    status: igdbPlatforms(game),
    posterPath: igdbCover(game),
    overview: (game.summary || '').trim() || null,
    actors: igdbStudio(game),
    checked: true,
  });
  const added = await db.addFavorite(env, userId, { tmdbId: gameId, mediaType: 'game', title: game.name });
  return {
    ok: true,
    added,
    title: game.name,
    date: { release_date: date, release_type: note || 'Выход' },
    meta: null,
    details: { media_type: 'game', vote_average: 0 },
  };
}

/**
 * Добавление тайтла из Кинопоиска (отрицательный id): российского, которого нет в TMDB.
 * Всё берём оттуда же — дату, постер, описание, актёров и рейтинг.
 */
async function addKinopoiskTitle(env, budget, userId, mediaType, tmdbId) {
  const doc = await kpById(env, budget, -tmdbId);
  if (!doc) return { ok: false, reason: 'kinopoisk' };

  const date = kpReleaseDate(doc, today(env));
  const title = doc.name || doc.alternativeName || 'Без названия';
  const overview = (doc.description || doc.shortDescription || '').trim() || null;

  await db.ensureUser(env, userId);
  await db.upsertReleaseDate(env, {
    tmdbId,
    mediaType,
    region: date.region,
    releaseType: date.release_type,
    releaseDate: date.release_date,
    theatricalDate: date.theatrical_date,
    digitalDate: date.digital_date,
    status: null,
    posterPath: doc.poster?.previewUrl || doc.poster?.url || null,
    overview,
    actors: kpActors(doc).join(', ') || null,
    checked: true,
  });
  const added = await db.addFavorite(env, userId, { tmdbId, mediaType, title });
  const meta = {
    imdb_rating: doc.rating?.imdb || null,
    kp_rating: doc.rating?.kp ? Math.round(doc.rating.kp * 10) / 10 : null,
    kp_votes: doc.votes?.kp || 0,
  };
  if (meta.kp_rating || meta.imdb_rating) await db.saveTitleMeta(env, tmdbId, mediaType, meta);

  return {
    ok: true,
    added,
    title,
    date,
    meta,
    details: { media_type: kpIsSeries(doc) ? 'tv' : 'movie', vote_average: 0 },
  };
}

export async function addTitle(env, budget, userId, mediaType, tmdbId) {
  if (mediaType === 'game') return addGame(env, budget, userId, tmdbId);
  if (tmdbId < 0) return addKinopoiskTitle(env, budget, userId, mediaType, tmdbId);
  // Просим credits и translations сразу: они не стоят лишнего субзапроса,
  // зато дают описание и актёров для списка в мини-аппе.
  const details = await getDetails(env, budget, mediaType, tmdbId, true);
  if (!details) return { ok: false, reason: 'tmdb' };

  const todayIso = today(env);
  const date = await resolveDate(env, budget, details, todayIso);
  const title = titleOf(details);

  await db.ensureUser(env, userId);
  await db.upsertReleaseDate(env, {
    tmdbId,
    mediaType,
    region: date.region,
    releaseType: date.release_type,
    releaseDate: date.release_date,
    theatricalDate: date.theatrical_date,
    digitalDate: date.digital_date,
    status: details.status || null,
    posterPath: details.poster_path || null,
    overview: pickOverview(details),
    actors: (details.credits?.cast || []).slice(0, 2).map((p) => p.name).join(', ') || null,
    checked: true,
  });
  const added = await db.addFavorite(env, userId, { tmdbId, mediaType, title });
  const meta = await ensureRatings(env, budget, details, tmdbId, mediaType);

  return { ok: true, added, title, date, details, meta };
}

/** Рейтинги IMDb/RT — тянем один раз на тайтл и держим в D1: у OMDb 1000 запросов в сутки. */
export async function ensureRatings(env, budget, details, tmdbId, mediaType) {
  const cached = await db.getTitleMeta(env, tmdbId, mediaType);
  // Готово, только если есть и OMDb, и Кинопоиск (КП добавился позже — старым записям его досчитаем).
  if (cached?.checked_at && cached.kp_rating != null) return cached;

  const meta = { ...(cached || {}) };
  const imdbId = details?.imdb_id || details?.external_ids?.imdb_id;
  if (imdbId && !cached?.checked_at) {
    const ratings = await fetchRatings(env, budget, imdbId);
    if (ratings) Object.assign(meta, { imdb_id: imdbId }, ratings);
  }
  const kp = (await kpByTmdb(env, budget, [tmdbId])).get(`${mediaType}:${tmdbId}`);
  if (kp) Object.assign(meta, { kp_rating: kp.kp_rating, kp_votes: kp.kp_votes });

  if (!meta.imdb_rating && !meta.kp_rating) return cached || null;
  await db.saveTitleMeta(env, tmdbId, mediaType, meta);
  return meta;
}

const TMDB_LINK = /themoviedb\.org\/(movie|tv)\/(\d+)/i;
const IMDB_LINK = /imdb\.com\/title\/(tt\d+)/i;

/** Разобрать внешнюю ссылку на тайтл (TMDB или IMDb). */
export async function parseTitleLink(env, budget, text) {
  const tmdbMatch = TMDB_LINK.exec(text);
  if (tmdbMatch) {
    return { mediaType: tmdbMatch[1].toLowerCase(), tmdbId: Number(tmdbMatch[2]) };
  }
  const imdbMatch = IMDB_LINK.exec(text);
  if (imdbMatch) {
    const found = await findByImdb(env, budget, imdbMatch[1]);
    if (found) return { mediaType: found.media_type, tmdbId: found.id };
    return { notFound: true };
  }
  return null;
}

export function looksLikeLink(text) {
  return /https?:\/\/\S+/i.test(text);
}
