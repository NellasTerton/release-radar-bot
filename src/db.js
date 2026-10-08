// Тонкий слой над D1. Все запросы собраны здесь, чтобы SQL не расползался по хендлерам.

export async function ensureUser(env, telegramId) {
  await env.DB.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)')
    .bind(telegramId)
    .run();
}

export async function getUser(env, telegramId) {
  return env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(telegramId).first();
}

export async function setGenrePrefs(env, telegramId, prefs) {
  await env.DB.prepare('UPDATE users SET genre_prefs = ? WHERE telegram_id = ?')
    .bind(prefs || null, telegramId)
    .run();
}

export async function addFavorite(env, userId, { tmdbId, mediaType, title }) {
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO favorites (user_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?)',
  ).bind(userId, tmdbId, mediaType, title).run();
  return (res.meta?.changes ?? 0) > 0; // false = уже было в избранном
}

export async function getFavorite(env, userId, tmdbId, mediaType) {
  return env.DB.prepare(
    'SELECT * FROM favorites WHERE user_id = ? AND tmdb_id = ? AND media_type = ?',
  ).bind(userId, tmdbId, mediaType).first();
}

export async function removeFavorite(env, userId, tmdbId, mediaType) {
  const res = await env.DB.prepare(
    'DELETE FROM favorites WHERE user_id = ? AND tmdb_id = ? AND media_type = ?',
  ).bind(userId, tmdbId, mediaType).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function isFavorite(env, userId, tmdbId, mediaType) {
  const row = await env.DB.prepare(
    'SELECT 1 AS x FROM favorites WHERE user_id = ? AND tmdb_id = ? AND media_type = ?',
  ).bind(userId, tmdbId, mediaType).first();
  return Boolean(row);
}

export async function listFavorites(env, userId) {
  const { results } = await env.DB.prepare(`
    SELECT f.tmdb_id, f.media_type, f.title, f.created_at,
           r.release_date, r.release_type, r.region,
           r.theatrical_date, r.digital_date, r.status, r.poster_path,
           r.overview, r.actors,
           m.imdb_rating, m.rt_critics, m.kp_rating, m.kp_votes,
           (SELECT c.is_russian FROM catalog c
             WHERE c.tmdb_id = f.tmdb_id AND c.media_type = f.media_type) AS is_russian
    FROM favorites f
    LEFT JOIN release_dates r
      ON r.tmdb_id = f.tmdb_id AND r.media_type = f.media_type
    LEFT JOIN title_meta m
      ON m.tmdb_id = f.tmdb_id AND m.media_type = f.media_type
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).bind(userId).all();
  return results || [];
}

export async function upsertReleaseDate(env, item) {
  const {
    tmdbId, mediaType, region, releaseType, releaseDate,
    theatricalDate, digitalDate, status, posterPath, overview, actors, checked,
  } = item;
  await env.DB.prepare(`
    INSERT INTO release_dates
      (tmdb_id, media_type, region, release_type, release_date,
       theatrical_date, digital_date, status, poster_path, overview, actors, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
      region = excluded.region,
      release_type = excluded.release_type,
      release_date = excluded.release_date,
      theatrical_date = excluded.theatrical_date,
      digital_date = excluded.digital_date,
      status = excluded.status,
      poster_path = coalesce(excluded.poster_path, release_dates.poster_path),
      overview = coalesce(excluded.overview, release_dates.overview),
      actors = coalesce(excluded.actors, release_dates.actors),
      last_checked_at = excluded.last_checked_at
  `).bind(
    tmdbId,
    mediaType,
    region ?? null,
    releaseType ?? null,
    releaseDate ?? null,
    theatricalDate ?? null,
    digitalDate ?? null,
    status ?? null,
    posterPath ?? null,
    overview ?? null,
    actors ?? null,
    checked ? new Date().toISOString() : null,
  ).run();
}

export async function getTitleMeta(env, tmdbId, mediaType) {
  return env.DB.prepare(
    'SELECT * FROM title_meta WHERE tmdb_id = ? AND media_type = ?',
  ).bind(tmdbId, mediaType).first();
}

export async function saveTitleMeta(env, tmdbId, mediaType, meta) {
  await env.DB.prepare(`
    INSERT INTO title_meta
      (tmdb_id, media_type, imdb_id, imdb_rating, imdb_votes, rt_critics, kp_rating, kp_votes, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
      imdb_id = coalesce(excluded.imdb_id, title_meta.imdb_id),
      imdb_rating = coalesce(excluded.imdb_rating, title_meta.imdb_rating),
      imdb_votes = coalesce(excluded.imdb_votes, title_meta.imdb_votes),
      rt_critics = coalesce(excluded.rt_critics, title_meta.rt_critics),
      kp_rating = coalesce(excluded.kp_rating, title_meta.kp_rating),
      kp_votes = coalesce(excluded.kp_votes, title_meta.kp_votes),
      checked_at = excluded.checked_at
  `).bind(
    tmdbId, mediaType,
    meta.imdb_id ?? null,
    meta.imdb_rating ?? null,
    meta.imdb_votes ?? null,
    meta.rt_critics ?? null,
    meta.kp_rating ?? null,
    meta.kp_votes ?? null,
  ).run();
}

export async function getHideRussian(env, userId) {
  const row = await env.DB.prepare('SELECT hide_russian FROM users WHERE telegram_id = ?').bind(userId).first();
  return Boolean(row?.hide_russian);
}

/** Выбранные фильтры пользователя: списки ключей через запятую в users. */
export async function getFilters(env, userId) {
  const row = await env.DB.prepare(
    'SELECT filter_genres, filter_countries FROM users WHERE telegram_id = ?',
  ).bind(userId).first();
  return { genres: row?.filter_genres || '', countries: row?.filter_countries || '' };
}

export async function setFilters(env, userId, { genres, countries }) {
  await env.DB.prepare(
    'UPDATE users SET filter_genres = ?, filter_countries = ? WHERE telegram_id = ?',
  ).bind(genres.join(',') || null, countries.join(',') || null, userId).run();
}

export async function getShowGames(env, userId) {
  const row = await env.DB.prepare('SELECT show_games FROM users WHERE telegram_id = ?').bind(userId).first();
  return Boolean(row?.show_games);
}

export async function setShowGames(env, userId, value) {
  await env.DB.prepare('UPDATE users SET show_games = ? WHERE telegram_id = ?')
    .bind(value ? 1 : 0, userId).run();
}

export async function setHideRussian(env, userId, value) {
  await env.DB.prepare('UPDATE users SET hide_russian = ? WHERE telegram_id = ?')
    .bind(value ? 1 : 0, userId).run();
}

/** id сообщений текущей ленты — чтобы «Дальше» заменяло пост, а не плодило их. */
export async function getLastPost(env, userId) {
  const row = await env.DB.prepare('SELECT last_post_ids FROM users WHERE telegram_id = ?')
    .bind(userId).first();
  return String(row?.last_post_ids || '').split(',').map(Number).filter(Boolean);
}

export async function setLastPost(env, userId, ids) {
  await env.DB.prepare('UPDATE users SET last_post_ids = ? WHERE telegram_id = ?')
    .bind((ids || []).join(','), userId).run();
}

export async function touchReleaseDate(env, tmdbId, mediaType) {
  await env.DB.prepare(
    'UPDATE release_dates SET last_checked_at = ? WHERE tmdb_id = ? AND media_type = ?',
  ).bind(new Date().toISOString(), tmdbId, mediaType).run();
}

/**
 * Батч для крона: дольше всех не проверявшиеся тайтлы (NULL — в первую очередь).
 * Вышедшие фильмы исключаем — их дата уже не изменится, незачем жечь субзапросы.
 */
export async function pickStaleTitles(env, limit) {
  const { results } = await env.DB.prepare(`
    SELECT r.tmdb_id, r.media_type, r.release_date, r.last_checked_at
    FROM release_dates r
    WHERE EXISTS (
      SELECT 1 FROM favorites f
      WHERE f.tmdb_id = r.tmdb_id AND f.media_type = r.media_type
    )
    AND NOT (
      r.media_type = 'movie'
      AND r.release_date IS NOT NULL
      AND date(r.release_date) < date('now', '-7 day')
    )
    -- Законченный сериал проверяем раз в неделю, а не каждые четыре часа:
    -- новый сезон объявляют не так внезапно, чтобы жечь на это субзапросы.
    AND NOT (
      r.media_type = 'tv'
      AND r.status IN ('Ended', 'Canceled')
      AND r.last_checked_at IS NOT NULL
      AND datetime(r.last_checked_at) > datetime('now', '-7 day')
    )
    ORDER BY (r.last_checked_at IS NULL) DESC, r.last_checked_at ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

/**
 * Что пора отправить. Ступени: за 3 дня, за сутки, в день выхода, через 3 дня («посмотрели?»).
 * Не раньше, чем пользователь добавил тайтл, и только то, чего ещё не отправляли.
 */
export async function pickDueReminders(env, limit) {
  // Ступени: в день выхода и через три дня («посмотрели?»). Заранее предупреждают
  // подборки понедельника и субботы, отдельные «за 3 дня / за сутки» были бы дублем.
  const { results } = await env.DB.prepare(`
    SELECT d.* FROM (
      SELECT f.user_id, f.tmdb_id, f.media_type, f.title,
             r.release_date, r.release_type, r.poster_path,
             CASE
               WHEN date(r.release_date) = date('now') THEN 'd0'
               WHEN date(r.release_date) = date('now', '-3 day') THEN 'a3'
             END AS stage
      FROM favorites f
      JOIN release_dates r
        ON r.tmdb_id = f.tmdb_id AND r.media_type = f.media_type
      WHERE r.release_date IS NOT NULL
        AND date(r.release_date) >= date(f.created_at, '-1 day')
    ) AS d
    WHERE d.stage IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM notifications_log n
        WHERE n.user_id = d.user_id
          AND n.tmdb_id = d.tmdb_id
          AND n.media_type = d.media_type
          AND n.stage = d.stage
          AND (
            n.release_date = d.release_date
            -- У фильма и игры релиз один, но его дата плавает: у «Чужой мамы» прокат
            -- в России был 7 октября, а на следующий день ближайшей датой стало 8-е,
            -- и «выходит сегодня» пришло дважды. Поэтому для них хватает того, что
            -- такое же сообщение уже уходило в последний месяц.
            -- У сериала release_date — дата серии, и каждая серия должна прийти своя.
            OR (d.media_type != 'tv'
                AND date(n.release_date) >= date(d.release_date, '-30 day'))
          )
      )
    ORDER BY d.release_date ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

/** Пользователи, у которых в избранном что-то выходит в окне и подборка ещё не уходила. */
export async function pickUsersForPeriod(env, column, from, to, limit) {
  const { results } = await env.DB.prepare(`
    SELECT DISTINCT f.user_id
    FROM favorites f
    JOIN release_dates r ON r.tmdb_id = f.tmdb_id AND r.media_type = f.media_type
    JOIN users u ON u.telegram_id = f.user_id
    WHERE r.release_date BETWEEN ? AND ?
      AND (u.${column} IS NULL OR u.${column} < ?)
    LIMIT ?
  `).bind(from, to, from, limit).all();
  return (results || []).map((r) => r.user_id);
}

export async function favoritesInRange(env, userId, from, to) {
  const { results } = await env.DB.prepare(`
    SELECT f.tmdb_id, f.media_type, f.title,
           r.release_date, r.release_type, r.theatrical_date, r.digital_date, r.poster_path
    FROM favorites f
    JOIN release_dates r ON r.tmdb_id = f.tmdb_id AND r.media_type = f.media_type
    WHERE f.user_id = ? AND r.release_date BETWEEN ? AND ?
    ORDER BY r.release_date ASC, f.title ASC
  `).bind(userId, from, to).all();
  return results || [];
}

export async function markPeriodSent(env, userId, column, dateIso) {
  await env.DB.prepare(`UPDATE users SET ${column} = ? WHERE telegram_id = ?`)
    .bind(dateIso, userId).run();
}

export async function logNotification(env, userId, tmdbId, mediaType, releaseDate, stage) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO notifications_log (user_id, tmdb_id, media_type, release_date, stage)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, tmdbId, mediaType, releaseDate, stage).run();
}

export async function saveReaction(env, userId, tmdbId, mediaType, releaseDate, verdict) {
  await env.DB.prepare(`
    INSERT INTO reactions (user_id, tmdb_id, media_type, release_date, verdict)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tmdb_id, media_type, release_date) DO UPDATE SET
      verdict = excluded.verdict,
      reacted_at = datetime('now')
  `).bind(userId, tmdbId, mediaType, releaseDate, verdict).run();
}

export async function recordDigestDecision(env, userId, tmdbId, mediaType, decision) {
  await env.DB.prepare(`
    INSERT INTO digest_decisions (user_id, tmdb_id, media_type, decision)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, tmdb_id, media_type) DO UPDATE SET
      decision = excluded.decision,
      decided_at = datetime('now')
  `).bind(userId, tmdbId, mediaType, decision).run();
}

/** Пользователи, которым пора слать подборку (последняя была неделю назад или никогда). */
export async function pickUsersForDigest(env, limit) {
  const { results } = await env.DB.prepare(`
    SELECT telegram_id, genre_prefs
    FROM users
    WHERE digest_sent_at IS NULL
       OR datetime(digest_sent_at) <= datetime('now', '-7 day')
    ORDER BY (digest_sent_at IS NULL) DESC, digest_sent_at ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

export async function markDigestSent(env, userId) {
  await env.DB.prepare('UPDATE users SET digest_sent_at = ? WHERE telegram_id = ?')
    .bind(new Date().toISOString(), userId)
    .run();
}

/** Множество ключей "type:id", которые пользователю больше показывать не надо. */
export async function seenByUser(env, userId) {
  const { results } = await env.DB.prepare(`
    SELECT media_type, tmdb_id FROM favorites WHERE user_id = ?
    UNION
    SELECT media_type, tmdb_id FROM digest_decisions WHERE user_id = ?
  `).bind(userId, userId).all();
  return new Set((results || []).map((r) => `${r.media_type}:${r.tmdb_id}`));
}
