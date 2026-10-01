import {
  discoverUpcoming, getDetails, filterShowable, networkName, MAJOR_NETWORKS,
} from './tmdb.js';
import { resolveDate, pickOverview } from './titles.js';
import { fetchRatings, fetchRatingsByTitle } from './omdb.js';
import {
  kpByTmdb, kpPremieres, kpDates, kpIsSeries, kpActors, normalizeTitle,
} from './kinopoisk.js';
import { today, shiftDate, titleOf, daysBetween } from './format.js';
import { genreKeys, countryGroup, filterSql } from './filters.js';
import {
  igdbUpcoming, igdbCover, igdbDate, igdbPlatforms, igdbStudio, gameGenres,
} from './igdb.js';

// Сколько страниц discover обходим за один запуск. Премьеры сезонов лежат
// далеко не только на первой странице: в окне 100 дней их около сорока,
// и раскиданы они по пяти-шести страницам.
const DISCOVER_PAGES = { movie: 3, tv: 4 };   // фильмы — по 3 страницы на регион
const FILL_BATCH = 26;      // деталей за один запуск крона
const RATE_BATCH = 10;      // рейтингов OMDb за один запуск
const KP_BATCH = 90;        // тайтлов в одном запросе к Кинопоиску (1 субзапрос)
const WINDOW_DAYS = 365;    // год вперёд: дальние месяцы обходятся по одному (см. enumerate)
const NEAR_DAYS = 90;       // ближние три месяца — каждый запуск целиком

// Англоязычное и европейское (плюс наше и украинское) — эти сериалы ищем глубоко.
const WESTERN_LANGUAGES = [
  'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'is', 'pl', 'cs', 'uk', 'ru',
];

// Страны, которые бот собирает только для фильтра (по одной за запуск).
const EXTRA_COUNTRIES = ['in', 'cn', 'tr', 'kr_jp', 'latam'];

/** Номер получасового запуска — для обхода дальних месяцев и недель по кругу. */
function catalogSlot() {
  const now = new Date();
  return now.getUTCHours() * 2 + (now.getUTCMinutes() >= 30 ? 1 : 0);
}
const RECENT_DAYS = 14;     // «Недавно вышло» — две недели

/** «премьера 24 сезона» / «премьера» — либо null, если это рядовая серия. */
export function premiereLabel(releaseType) {
  if (releaseType === 'Премьера') return 'премьера';
  const match = /^S(\d+)E(\d+)/.exec(releaseType || '');
  if (!match || Number(match[2]) !== 1) return null;
  const season = Number(match[1]);
  return season > 1 ? `премьера ${season} сезона` : 'премьера';
}

/**
 * Читается ли текст здешним пользователем. Арабица и иероглифы в имени актёра
 * или в синопсисе — верный признак, что тайтл сюда попал по ошибке, а RTL-символы
 * вдобавок переключают направление абзаца и ломают вёрстку.
 */
function isReadable(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const familiar = letters.filter((ch) => /[A-Za-zА-Яа-яЁё]/.test(ch)).length;
  return familiar / letters.length >= 0.7;
}

/** Российское производство или русский язык оригинала — по данным TMDB. */
function isRussian(details) {
  if (details.original_language === 'ru') return true;
  if ((details.origin_country || []).includes('RU')) return true;
  return (details.production_countries || []).some((c) => c.iso_3166_1 === 'RU');
}

const pad = (n) => String(n ?? 0).padStart(2, '0');

/** «1 серия», «7 серий», «22 серии». */
function episodeWord(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return 'серия';
  if (!teen && last >= 2 && last <= 4) return 'серии';
  return 'серий';
}

/**
 * Что вышло за последнюю неделю. Отдельно ловим сезон, выложенный целиком:
 * у него нет «следующей серии», и без этого он пропадал из ленты в день выхода.
 * Признак — дата сезона совпадает с датой его последней серии.
 */
function recentRelease(details, date, todayIso) {
  const from = shiftDate(todayIso, -RECENT_DAYS);
  const inRecent = (d) => d && d >= from && d < todayIso;

  if (details.media_type === 'movie') {
    // Любая дата релиза за две недели, самая ранняя в мире: это и есть премьера,
    // наш прокат идёт следом. Онлайн важнее проката — смотреть дома.
    const hits = (date.all_dates || []).filter((c) => inRecent(c.date));
    if (!hits.length) return null;
    const first = (list) => list.sort((x, y) => x.date.localeCompare(y.date))[0];
    const online = first(hits.filter((c) => c.type === 4 || c.type === 6));
    const cinema = first(hits.filter((c) => c.type === 2 || c.type === 3));
    const hit = online || cinema;
    return {
      date: hit.date,
      label: online ? 'вышел онлайн' : 'вышел в кино',
      kind: 'movie',
    };
  }

  const last = details.last_episode_to_air;
  const aired = String(last?.air_date || '').slice(0, 10);
  if (!inRecent(aired)) return null;
  const n = last.season_number;
  const season = (details.seasons || []).find((x) => x.season_number === n);

  if (last.episode_number === 1) {
    return { date: aired, label: n > 1 ? `премьера ${n} сезона` : 'премьера', kind: 'premiere' };
  }
  if (season && String(season.air_date || '').slice(0, 10) === aired) {
    const count = season.episode_count || last.episode_number;
    return {
      date: aired,
      label: `${n > 1 ? `${n} сезон` : 'сезон'} целиком · ${count} серий`,
      kind: 'drop',
    };
  }
  return { date: aired, label: `вышла серия S${pad(n)}E${pad(last.episode_number)}`, kind: 'episode' };
}

/** Шаг 1: собрать id кандидатов. Детали тут не трогаем — это дёшево. */
async function enumerate(env, budget) {
  const statements = [];

  // Фильмы обходим по датам релиза в России и отдельно в США: многие голливудские
  // фильмы российской даты в TMDB не имеют, а у нашего кино нет американской.
  // Ближние три месяца — каждый час; дальше, до года вперёд, — по одному месяцу за запуск
  // по кругу (9 месяцев — 9 часов). Если искать сразу по всему году, популярность
  // «съедает» выдачу ближайшими релизами, и после ноября список пустеет.
  //
  // Сериалы. Если искать по всем языкам, первые страницы занимают аниме, дорамы,
  // турецкие и индийские сериалы с еженедельными сериями — TMDB поднимает их за частоту,
  // и европейское («Вавилон-Берлин» был 126-м) в выборку не попадало. Поэтому:
  //  * глубоко ищем только англоязычное и европейское;
  //  * остальное — только первая страница общего топа (хиты вроде громкой дорамы);
  //  * плюс одна неделя за запуск по кругу: сериал, выложенный сезоном за один день,
  //    соревнуется только с тем, что выходит на той же неделе.
  // Это набор кандидатов, а не витрина: мусор дальше отсекает фильтр качества (QUALITY).
  const slot = catalogSlot();
  const farMonth = slot % 9;
  const far = { fromDays: NEAR_DAYS + farMonth * 30, days: NEAR_DAYS + (farMonth + 1) * 30 };
  const week = (slot % 15) - 2; // от двух недель назад до трёх месяцев вперёд
  const oneWeek = { fromDays: week * 7, days: week * 7 + 7 };
  // Ближние проходы чередуются: чётный запуск — кино, нечётный — сериалы. Каждый всё
  // равно раз в час, а сэкономленные запросы уходят на проверку новых кандидатов.
  const near = slot % 2 === 0
    ? [
      { mediaType: 'movie', region: 'RU', pages: DISCOVER_PAGES.movie },
      { mediaType: 'movie', region: 'US', pages: DISCOVER_PAGES.movie },
    ]
    : [
      { mediaType: 'tv', pages: DISCOVER_PAGES.tv, languages: WESTERN_LANGUAGES },
      { mediaType: 'tv', pages: 1, anyLanguage: true },
    ];
  // Индийское, китайское, турецкое и прочее мы по умолчанию не показываем, но если
  // пользователь выбрал такую страну в фильтрах, оно должно откуда-то взяться. Берём топ‑20
  // одной страны за запуск по кругу и помечаем extra = 1: без явного выбора страны такие
  // тайтлы не видны нигде.
  const extraGroup = EXTRA_COUNTRIES[slot % EXTRA_COUNTRIES.length];
  const passes = [
    ...near,
    {
      mediaType: slot % 2 === 0 ? 'movie' : 'tv',
      pages: 1,
      anyLanguage: true,
      extra: 1,
      country: extraGroup,
    },
    { mediaType: 'tv', pages: 2, languages: WESTERN_LANGUAGES, ...oneWeek },
    // Премьеры на крупных платформах. Ищем по дате начала сериала и только по их сетям:
    // таких сериалов на три месяца около сотни, и «К востоку от рая» с нулём оценок
    // попадает на первую страницу, а не на шестую, как в общей выдаче.
    {
      mediaType: 'tv',
      pages: 3,
      fromDays: 0,
      days: NEAR_DAYS,
      premieres: true,
      networks: [...MAJOR_NETWORKS.keys()],
    },
    { mediaType: 'movie', region: 'RU', pages: 1, ...far },
    { mediaType: 'movie', region: 'US', pages: 2, ...far },
    { mediaType: 'tv', pages: 1, languages: WESTERN_LANGUAGES, ...far },
  ];
  for (const {
    mediaType, region = null, pages, fromDays, days, languages, anyLanguage, country, extra = 0,
    networks, premieres = false,
  } of passes) {
    for (let page = 1; page <= pages; page += 1) {
      if (!budget.remaining) break;
      const data = await discoverUpcoming(env, budget, {
        mediaType,
        page,
        region,
        fromDays,
        languages,
        countries: country,
        networks,
        days: days ?? NEAR_DAYS,
        // byAirDate ловит идущие сериалы по дате серии; для премьер нужна дата начала.
        byAirDate: mediaType === 'tv' && !premieres,
        pastDays: RECENT_DAYS,
      });
      const found = anyLanguage ? data.results.filter((r) => r.poster_path) : filterShowable(data.results);
      for (const item of found) {
        statements.push(env.DB.prepare(`
          INSERT INTO catalog (
            tmdb_id, media_type, title, poster_path, popularity, vote_average, vote_count, extra
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
            title = excluded.title,
            poster_path = excluded.poster_path,
            popularity = excluded.popularity,
            vote_average = excluded.vote_average,
            vote_count = excluded.vote_count
        `).bind(
          item.id,
          mediaType,
          titleOf(item),
          item.poster_path || null,
          item.popularity || 0,
          item.vote_average || 0,
          item.vote_count || 0,
          extra,
        ));
      }
      if (page >= data.total_pages) break;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

/** Шаг 2: дотянуть детали у тех, кого дольше всех не проверяли. */
async function fillDetails(env, budget) {
  const { results } = await env.DB.prepare(`
    SELECT tmdb_id, media_type FROM catalog
    WHERE tmdb_id > 0
    -- Новые — первыми, и из них сначала те, у кого больше оценок: известное важнее.
    ORDER BY (checked_at IS NULL) DESC, checked_at ASC, vote_count DESC
    LIMIT ?
  `).bind(FILL_BATCH).all();

  const todayIso = today(env);
  const horizon = shiftDate(todayIso, WINDOW_DAYS);
  let filled = 0;

  for (const row of results || []) {
    if (budget.remaining <= 2) break;
    const details = await getDetails(env, budget, row.media_type, row.tmdb_id, true);
    if (!details) {
      await env.DB.prepare(
        'UPDATE catalog SET checked_at = ? WHERE tmdb_id = ? AND media_type = ?',
      ).bind(new Date().toISOString(), row.tmdb_id, row.media_type).run();
      continue;
    }

    const date = await resolveDate(env, budget, details, todayIso);
    const label = row.media_type === 'tv' ? premiereLabel(date.release_type) : null;
    // Фильм показываем всегда, сериал — только на премьере сезона.
    const isPremiere = row.media_type === 'movie' ? 1 : (label ? 1 : 0);
    // Повторный прокат или онлайн-релиз старого фильма («Сумерки» 2008 года в кино,
    // «Бэтмен» 1989-го) — не новинка: в витрину его не пускаем. Сравниваем мировую
    // премьеру с сегодняшним днём, а не с выбранной датой: у старого фильма без будущих
    // дат выбранной становится давняя цифровая, и перевыпуск проскакивал. Полтора года
    // запаса — на поздний выход у нас фестивального кино.
    const premiered = String(details.release_date || '').slice(0, 10);
    const rerelease = row.media_type === 'movie' && premiered
      && daysBetween(premiered, todayIso) > 540;
    // Фильм, который где-то уже вышел, не «скоро выйдет», даже если наша дата ещё впереди:
    // «Обитель зла» шла в кино с 18 сентября, а по нашей дате выходила «завтра».
    // Если впереди остался онлайн-релиз — показываем его: это единственное, чего ещё ждут.
    let ahead = date;
    if (row.media_type === 'movie' && (date.all_dates || []).some((c) => c.date < todayIso)) {
      const digital = (date.all_dates || [])
        .filter((c) => (c.type === 4 || c.type === 6) && c.date >= todayIso)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      ahead = digital
        ? { ...date, release_date: digital.date, release_type: 'Онлайн' }
        : { ...date, release_date: null };
    }
    const inWindow = !rerelease && ahead.release_date
      && ahead.release_date >= todayIso
      && ahead.release_date <= horizon;

    const overview = pickOverview(details);
    const recent = rerelease ? null : recentRelease(details, date, todayIso);
    const episodeCode = row.media_type === 'tv'
      ? (/^S\d+E\d+/.exec(date.release_type || '') || [null])[0]
      : null;
    const actors = (details.credits?.cast || []).slice(0, 2).map((p) => p.name).join(', ') || null;
    const imdbId = details.imdb_id || details.external_ids?.imdb_id || null;

    await env.DB.prepare(`
      UPDATE catalog SET
        title = ?, overview = ?, actors = ?, genres = ?, genre_keys = ?, country_group = ?,
        platforms = ?, date_note = ?,
        release_date = ?, episode_label = ?, is_premiere = ?,
        release_kind = ?, digital_date = ?, imdb_id = ?, readable = ?,
        episode_code = ?, recent_date = ?, recent_label = ?, recent_kind = ?,
        localized = ?, original_title = ?, first_year = ?, is_russian = ?, checked_at = ?
      WHERE tmdb_id = ? AND media_type = ?
    `).bind(
      titleOf(details),
      overview,
      actors,
      (details.genres || []).map((g) => g.name).join(', ') || null,
      genreKeys((details.genres || []).map((g) => g.name).join(', ')),
      countryGroup(details),
      // Для сериала в этих полях платформа и число серий: «Netflix · 7 серий».
      row.media_type === 'tv' ? networkName(details) : null,
      row.media_type === 'tv' && details.number_of_episodes
        ? `${details.number_of_episodes} ${episodeWord(details.number_of_episodes)}`
        : null,
      inWindow ? ahead.release_date : null,
      label,
      isPremiere,
      row.media_type === 'movie' ? (ahead.release_type || null) : null,
      date.digital_date || null,
      imdbId,
      isReadable(overview) && isReadable(actors) ? 1 : 0,
      inWindow ? episodeCode : null,
      recent?.date || null,
      recent?.label || null,
      recent?.kind || null,
      /[А-Яа-яЁё]/.test(titleOf(details)) ? 1 : 0,
      details.original_title || details.original_name || null,
      String(details.release_date || details.first_air_date || '').slice(0, 4) || null,
      isRussian(details) ? 1 : 0,
      new Date().toISOString(),
      row.tmdb_id,
      row.media_type,
    ).run();
    filled += 1;
  }
  return filled;
}

/**
 * Шаг 3: рейтинги IMDb и Rotten Tomatoes для того, что реально попадёт в ленту.
 * Одна голая звёздочка TMDB непонятна, а OMDb ограничен 1000 запросов в сутки,
 * поэтому берём небольшими порциями и только для витрины.
 */
async function fillRatings(env, budget) {
  // Нашли оценку — перепроверяем раз в неделю. Не нашли — через сутки:
  // у свежего релиза рейтинг на IMDb появляется в первые дни, а OMDb догоняет с задержкой.
  const { results } = await env.DB.prepare(`
    SELECT tmdb_id, media_type, imdb_id, original_title, first_year FROM catalog
    WHERE (imdb_id IS NOT NULL OR original_title IS NOT NULL)
      AND (release_date >= date('now') OR recent_date >= date('now', '-14 day'))
      AND (
        rated_at IS NULL
        OR (imdb_rating IS NULL AND datetime(rated_at) < datetime('now', '-1 day'))
        OR datetime(rated_at) < datetime('now', '-7 day')
      )
    ORDER BY (rated_at IS NULL) DESC, recent_date DESC, popularity DESC
    LIMIT ?
  `).bind(RATE_BATCH).all();

  let rated = 0;
  for (const row of results || []) {
    if (!budget.has(3)) break;
    let ratings = row.imdb_id
      ? await fetchRatings(env, budget, row.imdb_id)
      : await fetchRatingsByTitle(env, budget, row.original_title, row.first_year, row.media_type);
    // Сезоны антологий TMDB заводит отдельными сериалами («Monster: The Lizzie Borden Story»),
    // а IMDb знает только всю антологию («Monster») — её оценку и берём.
    if (!ratings && !row.imdb_id && row.media_type === 'tv' && /:/.test(row.original_title || '')) {
      const base = row.original_title.split(':')[0].trim();
      if (base.length >= 3) ratings = await fetchRatingsByTitle(env, budget, base, null, 'tv');
    }
    await env.DB.prepare(`
      UPDATE catalog SET imdb_rating = ?, rt_critics = ?, imdb_id = coalesce(imdb_id, ?), rated_at = ?
      WHERE tmdb_id = ? AND media_type = ?
    `).bind(
      ratings?.imdb_rating ?? null,
      ratings?.rt_critics ?? null,
      ratings?.imdb_id ?? null,
      new Date().toISOString(),
      row.tmdb_id,
      row.media_type,
    ).run();
    if (ratings?.imdb_rating) rated += 1;
  }
  return rated;
}

/**
 * Шаг 4: оценки Кинопоиска и «Ждут» — одним запросом на пачку тайтлов.
 * Найденное освежаем раз в три дня: «Ждут» у будущих релизов растёт.
 */
async function fillKinopoisk(env, budget) {
  if (!env.KINOPOISK_API_KEY) return 0;
  const { results } = await env.DB.prepare(`
    SELECT tmdb_id, media_type FROM catalog
    WHERE tmdb_id > 0
      AND (release_date >= date('now') OR recent_date >= date('now', '-14 day'))
      AND (kp_checked_at IS NULL OR datetime(kp_checked_at) < datetime('now', '-3 day'))
    ORDER BY (kp_checked_at IS NULL) DESC, popularity DESC
    LIMIT ?
  `).bind(KP_BATCH).all();
  const rows = results || [];
  if (!rows.length) return 0;

  const found = await kpByTmdb(env, budget, [...new Set(rows.map((r) => r.tmdb_id))]);
  const now = new Date().toISOString();
  const statements = rows.map((row) => {
    const kp = found.get(`${row.media_type}:${row.tmdb_id}`);
    if (!kp) {
      return env.DB.prepare('UPDATE catalog SET kp_checked_at = ? WHERE tmdb_id = ? AND media_type = ?')
        .bind(now, row.tmdb_id, row.media_type);
    }
    return env.DB.prepare(`
      UPDATE catalog SET kp_rating = ?, kp_votes = ?, kp_await = ?, kp_checked_at = ?,
        is_russian = CASE WHEN ? = 1 THEN 1 ELSE is_russian END
      WHERE tmdb_id = ? AND media_type = ?
    `).bind(kp.kp_rating, kp.kp_votes, kp.kp_await, now, kp.russian ? 1 : 0, row.tmdb_id, row.media_type);
  });
  await env.DB.batch(statements);
  return found.size;
}

/** Запись каталога из тайтла Кинопоиска. null — если он не в окне дат. */
function kpCatalogRow(doc, todayIso) {
  const series = kpIsSeries(doc);
  const { cinema, online } = kpDates(doc);
  const from = shiftDate(todayIso, -RECENT_DAYS);
  const horizon = shiftDate(todayIso, WINDOW_DAYS);
  const dates = [
    cinema && { date: cinema, kind: 'cinema' },
    online && { date: online, kind: 'online' },
  ].filter(Boolean);
  const upcoming = dates.filter((d) => d.date >= todayIso && d.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const recent = dates.filter((d) => d.date >= from && d.date < todayIso)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!upcoming && !recent) return null;

  const overview = (doc.description || doc.shortDescription || '').trim() || null;
  const actors = kpActors(doc).join(', ') || null;
  const kindOf = (d) => (d.kind === 'online' ? 'Онлайн' : 'В кино');
  let recentLabel = null;
  if (recent) {
    if (series) recentLabel = 'премьера';
    else recentLabel = recent.kind === 'online' ? 'вышел онлайн' : 'вышел в кино';
  }
  return {
    tmdb_id: -doc.id,
    media_type: series ? 'tv' : 'movie',
    title: doc.name || doc.alternativeName,
    poster_path: doc.poster?.previewUrl || doc.poster?.url || null,
    overview,
    actors,
    genres: (doc.genres || []).map((g) => g.name).join(', ') || null,
    genre_keys: genreKeys((doc.genres || []).map((g) => g.name).join(', ')),
    release_date: upcoming?.date || null,
    release_kind: !series && upcoming ? kindOf(upcoming) : null,
    digital_date: online,
    episode_label: series ? 'премьера' : null,
    // Для сортировки «при одной дате — что популярнее»: у Кинопоиска это «Ждут».
    popularity: doc.votes?.await || 0,
    imdb_rating: doc.rating?.imdb || null,
    kp_rating: doc.rating?.kp ? Math.round(doc.rating.kp * 10) / 10 : null,
    kp_votes: doc.votes?.kp || 0,
    kp_await: doc.votes?.await || 0,
    recent_date: recent?.date || null,
    recent_label: recentLabel,
    recent_kind: recent ? (series ? 'premiere' : 'movie') : null,
    readable: isReadable(overview) && isReadable(actors) ? 1 : 0,
    first_year: doc.year ? String(doc.year) : null,
    kp_tmdb: doc.externalId?.tmdb || null,
  };
}

/**
 * Шаг 0: российское — из Кинопоиска, потому что в TMDB его почти нет.
 * Четыре запроса списком (кино в прокате и онлайн, сериалы в эфире и онлайн),
 * в каждом уже есть постер, описание и актёры. Раз в шесть часов: даты премьер
 * меняются редко, а лимит Кинопоиска — 200 запросов в сутки.
 * Записи TMDB про те же тайтлы помечаются dup_of_kp и в витрину не идут.
 */
async function enumerateKinopoisk(env, budget, force = false) {
  if (!env.KINOPOISK_API_KEY) return 0;
  // Один раз в шесть часов: катушка запускается дважды в час, берём только первый слот.
  if (!force && catalogSlot() % 12 !== 0) {
    const has = await env.DB.prepare('SELECT 1 AS x FROM catalog WHERE tmdb_id < 0 LIMIT 1').first();
    if (has) return 0;
  }

  const todayIso = today(env);
  const fromIso = shiftDate(todayIso, -RECENT_DAYS);
  const toIso = shiftDate(todayIso, WINDOW_DAYS);
  const docs = [];
  for (const query of [
    { series: false, kind: 'cinema', limit: 70 },
    { series: false, kind: 'online', limit: 30 },
    { series: true, kind: 'cinema', limit: 40 },
    { series: true, kind: 'online', limit: 40 },
  ]) {
    docs.push(...await kpPremieres(env, budget, { ...query, fromIso, toIso }));
  }

  const rows = new Map();
  for (const doc of docs) {
    const row = kpCatalogRow(doc, todayIso);
    if (row) rows.set(`${row.media_type}:${row.tmdb_id}`, row);
  }
  if (!rows.size) return 0;

  const now = new Date().toISOString();
  const statements = [...rows.values()].map((r) => env.DB.prepare(`
    INSERT INTO catalog (
      tmdb_id, media_type, title, poster_path, overview, actors, genres, genre_keys, country_group,
      release_date, release_kind, digital_date, episode_label, is_premiere,
      popularity, vote_average, vote_count, imdb_rating, kp_rating, kp_votes, kp_await,
      recent_date, recent_label, recent_kind, readable, localized, is_russian, first_year,
      checked_at, kp_checked_at, rated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ru', ?, ?, ?, ?, 1, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
    ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
      title = excluded.title, poster_path = excluded.poster_path, overview = excluded.overview,
      actors = excluded.actors, genres = excluded.genres, genre_keys = excluded.genre_keys,
      country_group = 'ru', release_date = excluded.release_date,
      release_kind = excluded.release_kind, digital_date = excluded.digital_date,
      episode_label = excluded.episode_label, popularity = excluded.popularity,
      imdb_rating = excluded.imdb_rating, kp_rating = excluded.kp_rating, kp_votes = excluded.kp_votes,
      kp_await = excluded.kp_await, recent_date = excluded.recent_date,
      recent_label = excluded.recent_label, recent_kind = excluded.recent_kind,
      readable = excluded.readable, first_year = excluded.first_year,
      checked_at = excluded.checked_at, kp_checked_at = excluded.kp_checked_at, rated_at = excluded.rated_at
  `).bind(
    r.tmdb_id, r.media_type, r.title, r.poster_path, r.overview, r.actors, r.genres, r.genre_keys,
    r.release_date, r.release_kind, r.digital_date, r.episode_label,
    r.popularity, r.imdb_rating, r.kp_rating, r.kp_votes, r.kp_await,
    r.recent_date, r.recent_label, r.recent_kind, r.readable, r.first_year,
    now, now, now,
  ));

  // Дубли: те же тайтлы, пришедшие из TMDB, — по ссылке на TMDB или по названию.
  const { results: tmdbRussian } = await env.DB.prepare(
    'SELECT tmdb_id, media_type, title FROM catalog WHERE tmdb_id > 0 AND is_russian = 1',
  ).all();
  const kpTitles = new Set([...rows.values()].map((r) => `${r.media_type}:${normalizeTitle(r.title)}`));
  const kpTmdbIds = new Set([...rows.values()].filter((r) => r.kp_tmdb).map((r) => `${r.media_type}:${r.kp_tmdb}`));
  const dups = new Set(kpTmdbIds);
  for (const t of tmdbRussian || []) {
    if (kpTitles.has(`${t.media_type}:${normalizeTitle(t.title)}`)) dups.add(`${t.media_type}:${t.tmdb_id}`);
  }
  for (const key of dups) {
    const [mediaType, id] = key.split(':');
    statements.push(env.DB.prepare('UPDATE catalog SET dup_of_kp = 1 WHERE tmdb_id = ? AND media_type = ?')
      .bind(Number(id), mediaType));
  }

  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return rows.size;
}

/** Запись каталога из игры IGDB. null — если она вне окна дат. */
function gameCatalogRow(game, todayIso) {
  const { date, note } = igdbDate(game);
  if (!date) return null;
  const from = shiftDate(todayIso, -RECENT_DAYS);
  const horizon = shiftDate(todayIso, WINDOW_DAYS);
  if (date < from || date > horizon) return null;

  const summary = (game.summary || '').trim() || null;
  const upcoming = date >= todayIso;
  return {
    tmdb_id: game.id,
    media_type: 'game',
    title: game.name,
    poster_path: igdbCover(game),
    overview: summary,
    // Студия занимает место актёров: в списке это та же строка перед описанием.
    actors: igdbStudio(game),
    genres: gameGenres(game),
    platforms: igdbPlatforms(game),
    date_note: note,
    release_date: upcoming ? date : null,
    recent_date: upcoming ? null : date,
    recent_label: null,
    // hypes — сколько человек ждут игру; до выхода это единственный признак интереса.
    popularity: game.hypes || 0,
    vote_average: game.total_rating ? Math.round(game.total_rating) / 10 : 0,
    vote_count: game.total_rating_count || 0,
    readable: isReadable(summary) ? 1 : 0,
    first_year: date.slice(0, 4),
  };
}

/**
 * Шаг: игры из IGDB. Один запрос на запуск (плюс изредка один за токеном) —
 * в ответе сразу обложка, описание, платформы, студия и оценки.
 * Раз в шесть часов: даты игр меняются редко, а переносы всё равно видны на следующем круге.
 */
async function enumerateGames(env, budget, force = false) {
  if (!env.IGDB_CLIENT_ID) return 0;
  if (!force && catalogSlot() % 12 !== 6) {
    const has = await env.DB.prepare("SELECT 1 AS x FROM catalog WHERE media_type = 'game' LIMIT 1").first();
    if (has) return 0;
  }

  const todayIso = today(env);
  const games = await igdbUpcoming(env, budget, {
    fromIso: shiftDate(todayIso, -RECENT_DAYS),
    toIso: shiftDate(todayIso, WINDOW_DAYS),
    limit: 60,
  });

  const rows = games.map((g) => gameCatalogRow(g, todayIso)).filter(Boolean);
  if (!rows.length) return 0;

  const now = new Date().toISOString();
  const statements = rows.map((r) => env.DB.prepare(`
    INSERT INTO catalog (
      tmdb_id, media_type, title, poster_path, overview, actors, genres, platforms, date_note,
      release_date, recent_date, recent_label, recent_kind, is_premiere,
      popularity, vote_average, vote_count, readable, localized, first_year, checked_at
    ) VALUES (?, 'game', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'game', 1, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
      title = excluded.title, poster_path = excluded.poster_path, overview = excluded.overview,
      actors = excluded.actors, genres = excluded.genres, platforms = excluded.platforms,
      date_note = excluded.date_note, release_date = excluded.release_date,
      recent_date = excluded.recent_date, recent_label = excluded.recent_label,
      popularity = excluded.popularity, vote_average = excluded.vote_average,
      vote_count = excluded.vote_count, readable = excluded.readable,
      first_year = excluded.first_year, checked_at = excluded.checked_at
  `).bind(
    r.tmdb_id, r.title, r.poster_path, r.overview, r.actors, r.genres, r.platforms, r.date_note,
    r.release_date, r.recent_date, r.recent_label,
    r.popularity, r.vote_average, r.vote_count, r.readable, r.first_year, now,
  ));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return rows.length;
}

/** Крон #3: обновление витрины. */
export async function refreshCatalog(env, budget, { forceKinopoisk = false, forceGames = false } = {}) {
  // Кинопоиск первым: его запросов немного, а шаги TMDB расходуют бюджет до конца.
  const fromKp = await enumerateKinopoisk(env, budget, forceKinopoisk);
  const fromIgdb = await enumerateGames(env, budget, forceGames);
  const seen = await enumerate(env, budget);
  const filled = await fillDetails(env, budget);
  const rated = await fillRatings(env, budget);
  const kp = await fillKinopoisk(env, budget);

  // Прошедшее в ленте не нужно, а без уборки таблица будет только расти.
  // Запас в день сверх окна «Недавно вышло»; число берём из RECENT_DAYS, чтобы окно
  // и уборка не разъезжались (уже было: окно стало 14 дней, а уборка стирала всё старше 8).
  await env.DB.prepare(`
    DELETE FROM catalog
    WHERE (release_date IS NULL OR release_date < date('now'))
      AND recent_date IS NOT NULL AND recent_date < date('now', ?)
  `).bind(`-${RECENT_DAYS + 1} day`).run();

  console.log(`refreshCatalog: кинопоиск-каталог ${fromKp}, игры ${fromIgdb}, увидели ${seen}, обновили ${filled}, рейтингов ${rated}, кинопоиск ${kp}, осталось ${budget.remaining}`);
  return filled;
}

// Порог «известности». Популярность у будущего фильма низкая просто потому,
// что до выхода далеко: по ней отсеивались «Джуманджи 3» и «Годзилла».
// Куда надёжнее работает заполненность карточки — описание, читаемый текст
// и названный каст, — а популярность нужна только чтобы отсечь совсем дно.
const QUALITY = `
  checked_at IS NOT NULL
  AND coalesce(dup_of_kp, 0) = 0
  AND overview IS NOT NULL
  AND readable = 1
  AND (actors IS NOT NULL OR media_type = 'game')
  AND (
    -- Игры: до выхода оценок не существует, поэтому судим по числу ожидающих (hypes).
    (media_type = 'game' AND (popularity >= 3 OR vote_count >= 10))
    OR
    -- Российское: TMDB про наш прокат почти ничего не знает (0 голосов, популярность ~3),
    -- поэтому единственный сигнал — Кинопоиск: «Ждут» у будущего, оценки у вышедшего.
    (coalesce(is_russian, 0) = 1 AND (coalesce(kp_await, 0) >= 3000 OR coalesce(kp_votes, 0) >= 1000))
    OR (coalesce(is_russian, 0) = 0 AND (
      -- Премьера на крупной платформе заметна сама по себе: оценок у неё ещё нет.
      (media_type = 'tv' AND (vote_count >= 100 OR popularity >= 60 OR platforms IS NOT NULL))
      OR (media_type = 'movie' AND popularity >= 4 AND (localized = 1 OR popularity >= 50))
    ))
  )`;

/** Буква фильтра — в тип записи: m — кино, t — сериалы, g — игры. */
const mediaTypeOf = (type) => ({ m: 'movie', t: 'tv', g: 'game' }[type] || 'tv');

/** Страница ленты. Ни одного внешнего запроса — всё уже в D1. */
export async function readFeed(env, {
  type, page, size, episodes = false, hideRussian = false, genres = [], countries = [],
  games = false,
}) {
  const offset = (page - 1) * size;
  // Сравниваем с нашей датой, а не с date('now'): она в UTC, и с трёх ночи до трёх утра
  // по Москве вчерашние релизы попадали в «Скоро выйдет» как «1 день назад».
  const todayIso = today(env);
  // По умолчанию сериал попадает в ленту только на премьере сезона; с «Все серии»
  // показывается каждый идущий сериал — одной строкой, с ближайшей серией.
  const { results } = await env.DB.prepare(`
    SELECT * FROM catalog
    WHERE ${QUALITY}
      AND release_date IS NOT NULL
      AND release_date >= ?8
      AND (is_premiere = 1 OR (?5 = 1 AND media_type = 'tv'))
      AND (?1 = 'a' OR media_type = ?2)
      AND (?6 = 0 OR coalesce(is_russian, 0) = 0)
      AND (?7 = 1 OR media_type != 'game')
      ${filterSql(genres, countries)}
    ORDER BY release_date ASC, popularity DESC
    LIMIT ?3 OFFSET ?4
  `).bind(
    type,
    mediaTypeOf(type),
    size + 1, // лишняя строка — чтобы понять, есть ли «Дальше»
    offset,
    episodes ? 1 : 0,
    hideRussian ? 1 : 0,
    games ? 1 : 0,
    todayIso,
  ).all();

  const rows = results || [];
  return { items: rows.slice(0, size), hasMore: rows.length > size };
}

/** «Вышло за неделю»: фильмы, премьеры сезонов, сезоны целиком; рядовые серии — только с «Все серии». */
export async function readRecent(env, {
  type, episodes = false, limit = 24, hideRussian = false, genres = [], countries = [],
  games = false,
}) {
  const todayIso = today(env);
  const { results } = await env.DB.prepare(`
    SELECT * FROM catalog
    WHERE ${QUALITY}
      AND recent_date IS NOT NULL
      AND recent_date >= ?7
      AND recent_date < ?8
      AND (?3 = 1 OR recent_kind != 'episode')
      AND (?1 = 'a' OR media_type = ?2)
      AND (?5 = 0 OR coalesce(is_russian, 0) = 0)
      AND (?6 = 1 OR media_type != 'game')
      ${filterSql(genres, countries)}
    ORDER BY recent_date DESC, popularity DESC
    LIMIT ?4
  `).bind(
    type, mediaTypeOf(type), episodes ? 1 : 0, limit, hideRussian ? 1 : 0, games ? 1 : 0,
    shiftDate(todayIso, -RECENT_DAYS), todayIso,
  ).all();
  return results || [];
}

export async function catalogSize(env) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM catalog
     WHERE checked_at IS NOT NULL AND is_premiere = 1
       AND release_date >= date('now') AND overview IS NOT NULL`,
  ).first();
  return row?.n || 0;
}
