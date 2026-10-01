// Игры — IGDB (база Twitch; именно на ней держатся Twitch и большинство игровых сайтов).
// Бесплатно, лимит только по скорости (около четырёх запросов в секунду), которого нам
// хватает с запасом. Доступ по паре Client ID + Client Secret из консоли разработчика Twitch:
// по ним раз в два месяца берётся токен, он и лежит в service_tokens.
//
// Главное, ради чего выбран IGDB: даты хранятся отдельно по каждой платформе и с пометкой
// точности. Игра, у которой известен только квартал, не превращается в выдуманное число.

const GAMES = 'https://api.igdb.com/v4/games';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

const FIELDS = [
  'name', 'summary', 'first_release_date', 'hypes', 'total_rating', 'total_rating_count',
  'cover.url', 'genres.name', 'platforms.abbreviation', 'involved_companies.company.name',
  'involved_companies.developer', 'release_dates.date', 'release_dates.date_format.format',
  'release_dates.platform.abbreviation',
].join(', ');

/** Токен приложения Twitch: из базы, а если протух — новый. Стоит один субзапрос. */
async function token(env, budget) {
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) return null;
  const saved = await env.DB.prepare(
    "SELECT token FROM service_tokens WHERE name = 'igdb' AND datetime(expires_at) > datetime('now')",
  ).first();
  if (saved?.token) return saved.token;

  const url = new URL(TOKEN_URL);
  url.searchParams.set('client_id', env.IGDB_CLIENT_ID);
  url.searchParams.set('client_secret', env.IGDB_CLIENT_SECRET);
  url.searchParams.set('grant_type', 'client_credentials');
  const res = await budget.fetch(url, { method: 'POST' });
  if (!res || !res.ok) {
    console.warn('igdb token error', res?.status);
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!data?.access_token) return null;

  // Просим базу забыть токен на день раньше срока — чтобы не поймать отказ на границе.
  const days = Math.max(1, Math.floor((data.expires_in || 0) / 86400) - 1);
  await env.DB.prepare(`
    INSERT INTO service_tokens (name, token, expires_at) VALUES ('igdb', ?, datetime('now', ?))
    ON CONFLICT(name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
  `).bind(data.access_token, `+${days} day`).run();
  return data.access_token;
}

async function query(env, budget, body) {
  const key = await token(env, budget);
  if (!key || !budget.has(2)) return [];
  const res = await budget.fetch(GAMES, {
    method: 'POST',
    headers: { 'Client-ID': env.IGDB_CLIENT_ID, authorization: `Bearer ${key}` },
    body,
  });
  if (!res || !res.ok) {
    console.warn('igdb error', res?.status);
    return [];
  }
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

const stamp = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

/**
 * Игры с датой выхода в окне. hypes — сколько человек добавили игру в список ожидания;
 * у игр это единственный заранее известный признак интереса, оценок до выхода нет.
 */
export async function igdbUpcoming(env, budget, { fromIso, toIso, limit = 40, minHypes = 3 }) {
  return query(env, budget, `fields ${FIELDS};
    where first_release_date >= ${stamp(fromIso)}
      & first_release_date <= ${stamp(toIso)}
      & (hypes >= ${minHypes} | total_rating_count >= 10)
      & game_type = 0;
    sort hypes desc; limit ${limit};`);
}

/** Одна игра целиком — для карточки, избранного и обновления даты. */
export async function igdbById(env, budget, id) {
  const rows = await query(env, budget, `fields ${FIELDS}; where id = ${Number(id)}; limit 1;`);
  return rows[0] || null;
}

export function igdbCover(game, size = 't_cover_big') {
  const url = game?.cover?.url;
  if (!url) return null;
  return `https:${url.replace('t_thumb', size)}`;
}

export function igdbUrl(id) {
  return `https://www.igdb.com/games/${id}`;
}

const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const MONTHS = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
];

/**
 * Дата выхода и, если точного дня ещё нет, человеческая подпись вместо выдуманного числа.
 * IGDB помечает точность: YYYYMMDD — день известен, YYYYMMM — только месяц, YYYY — только год,
 * YYYYQ1 — квартал. Берём самую раннюю дату по всем платформам: игра выходит везде сразу
 * или сначала на PC, и ждут именно первую.
 */
export function igdbDate(game) {
  const list = (game.release_dates || []).filter((r) => r.date);
  const first = list.sort((a, b) => a.date - b.date)[0];
  const seconds = first?.date || game.first_release_date;
  if (!seconds) return { date: null, note: null };

  const format = first?.date_format?.format || 'YYYYMMDD';
  const date = day(seconds);
  if (format === 'YYYYMMDD') return { date, note: null };

  const d = new Date(seconds * 1000);
  const year = d.getUTCFullYear();
  if (format === 'YYYYMMM') return { date, note: `в ${MONTHS[d.getUTCMonth()]} ${year}` };
  if (format.startsWith('YYYYQ')) return { date, note: `в ${format.slice(-1)} квартале ${year}` };
  return { date, note: `в ${year} году` };
}

/** Платформы одной строкой: «PS5 · Xbox · PC». */
export function igdbPlatforms(game) {
  const seen = [];
  for (const p of game.platforms || []) {
    const short = String(p.abbreviation || '')
      .replace('Series X|S', 'Xbox')
      .replace('XONE', 'Xbox One');
    if (short && !seen.includes(short)) seen.push(short);
  }
  return seen.slice(0, 5).join(' · ') || null;
}

export function igdbStudio(game) {
  const made = (game.involved_companies || []).find((c) => c.developer);
  return made?.company?.name || null;
}

// Жанры IGDB приходят по-английски: переводим, а невнятные («Indie») отбрасываем.
const GENRE_NAMES = {
  Shooter: 'шутер',
  'Role-playing (RPG)': 'ролевая',
  Adventure: 'приключения',
  Platform: 'платформер',
  Puzzle: 'головоломка',
  Strategy: 'стратегия',
  'Real Time Strategy (RTS)': 'стратегия',
  'Turn-based strategy (TBS)': 'пошаговая стратегия',
  Tactical: 'тактика',
  Simulator: 'симулятор',
  Sport: 'спорт',
  Racing: 'гонки',
  Fighting: 'файтинг',
  Arcade: 'аркада',
  'Point-and-click': 'квест',
  'Visual Novel': 'визуальная новелла',
  'Card & Board Game': 'карточная',
  Music: 'музыкальная',
  MOBA: 'MOBA',
};

export function gameGenres(game) {
  const names = (game.genres || []).map((g) => GENRE_NAMES[g.name]).filter(Boolean);
  return [...new Set(names)].slice(0, 3).join(', ') || null;
}
