import * as db from './db.js';
import * as tg from './telegram.js';
import { getDetails, posterUrl } from './tmdb.js';
import { readFeed } from './catalog.js';
import { kpById, kpReleaseDate, kpActors } from './kinopoisk.js';
import { igdbById, igdbDate, igdbPlatforms, igdbStudio, igdbCover } from './igdb.js';
import { resolveDate, pickOverview } from './titles.js';
import { short } from './commands.js';
import {
  escapeHtml, today, shiftDate, formatDate, dayHeader, kindWord, truncate, MEDIA_EMOJI,
} from './format.js';

// Батч дат: 30 записей × 1 субзапрос к TMDB + запас на TVmaze и на уведомления.
// Верхняя граница всё равно держится бюджетом, батч — просто разумный размер выборки.
const DATE_BATCH = 30;
const RESERVE_FOR_NOTIFICATIONS = 10;
const MAX_NOTIFICATIONS = 8;

/** Крон #1: обновить даты у части избранного (самое давно не проверявшееся). */
export async function refreshDates(env, budget) {
  const rows = await db.pickStaleTitles(env, DATE_BATCH);
  const todayIso = today(env);
  let updated = 0;
  let kpRefreshed = 0;

  for (const row of rows) {
    // Останавливаемся заранее: остаток бюджета нужен уведомлениям.
    if (budget.remaining <= RESERVE_FOR_NOTIFICATIONS) break;

    if (row.media_type === 'game') {
      const game = await igdbById(env, budget, row.tmdb_id);
      if (!game) {
        await db.touchReleaseDate(env, row.tmdb_id, row.media_type);
        continue;
      }
      const { date, note } = igdbDate(game);
      await db.upsertReleaseDate(env, {
        tmdbId: row.tmdb_id,
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
      updated += 1;
      continue;
    }

    // Записи Кинопоиска (отрицательный id) обновляем оттуда же, но не больше пяти за запуск:
    // у его ключа 200 запросов в сутки.
    if (row.tmdb_id < 0) {
      if (kpRefreshed >= 5) continue;
      kpRefreshed += 1;
      const doc = await kpById(env, budget, -row.tmdb_id);
      if (!doc) {
        await db.touchReleaseDate(env, row.tmdb_id, row.media_type);
        continue;
      }
      const kpDate = kpReleaseDate(doc, todayIso);
      await db.upsertReleaseDate(env, {
        tmdbId: row.tmdb_id,
        mediaType: row.media_type,
        region: kpDate.region,
        releaseType: kpDate.release_type,
        releaseDate: kpDate.release_date,
        theatricalDate: kpDate.theatrical_date,
        digitalDate: kpDate.digital_date,
        status: null,
        posterPath: doc.poster?.previewUrl || doc.poster?.url || null,
        overview: (doc.description || doc.shortDescription || '').trim() || null,
        actors: kpActors(doc).join(', ') || null,
        checked: true,
      });
      updated += 1;
      continue;
    }

    const details = await getDetails(env, budget, row.media_type, row.tmdb_id, true);
    if (!details) {
      // TMDB не ответил или бюджет кончился — помечаем проверку, чтобы не залипнуть на одной записи.
      await db.touchReleaseDate(env, row.tmdb_id, row.media_type);
      continue;
    }
    const date = await resolveDate(env, budget, details, todayIso);
    await db.upsertReleaseDate(env, {
      tmdbId: row.tmdb_id,
      mediaType: row.media_type,
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
    updated += 1;
  }

  console.log(`refreshDates: ${updated}/${rows.length}, субзапросов осталось ${budget.remaining}`);
  return updated;
}

// Уведомления:
//   понедельник, утро — что из избранного выходит на этой неделе (альбом постеров + список);
//   суббота, утро — что выходит на выходных;
//   в день выхода — короткое напоминание с постером;
//   через три дня — «посмотрели?».
// Отдельные «за 3 дня / за сутки» убраны: их роль теперь играют подборки.

function appButton(env) {
  return {
    text: '🎬 Открыть приложение',
    web_app: { url: env.APP_URL || 'https://release-radar-bot.release-radar-bot.workers.dev/app' },
  };
}

function reactionKeyboard(item) {
  const id = `${short(item.media_type)}:${item.tmdb_id}:${item.release_date}`;
  return tg.keyboard([[
    { text: '👍 Понравилось', callback_data: `r:${id}:l` },
    { text: '👎 Не зашло', callback_data: `r:${id}:d` },
  ], [
    { text: '🙈 Не смотрел', callback_data: `r:${id}:n` },
  ]]);
}

/** Что именно вышло: серия, прокат или онлайн. */
function releaseWhat(item) {
  if (item.media_type === 'tv') {
    return /^S\d/.test(item.release_type || '') ? `вышла серия ${item.release_type}` : 'премьера';
  }
  const kind = kindWord(item.release_type);
  return kind === 'онлайн' ? 'вышел онлайн' : kind === 'в кино' ? 'премьера в кино' : 'премьера';
}

/** Одно напоминание: в день выхода — постер и строка, через три дня — «посмотрели?». */
async function deliverReminder(env, budget, chatId, item, todayIso) {
  const name = escapeHtml(item.title);
  if (item.stage === 'd0') {
    // Коротко и с постером: одного взгляда достаточно, чтобы понять, что вышло.
    const caption = `🔔 <b>${name}</b> — ${escapeHtml(releaseWhat(item))} сегодня`;
    const photo = posterUrl(item.poster_path, 'w342');
    const markup = tg.keyboard([[appButton(env)]]);
    return photo
      ? tg.sendPhoto(env, budget, chatId, photo, caption, { reply_markup: markup })
      : tg.sendMessage(env, budget, chatId, caption, { reply_markup: markup });
  }
  const text = `🍿 <b>${name}</b> вышло ${formatDate(item.release_date, todayIso)}. Успели посмотреть?`;
  return tg.sendMessage(env, budget, chatId, text, { reply_markup: reactionKeyboard(item) });
}

/** Крон #1b: напоминание в день выхода и вопрос через три дня. */
export async function sendReminders(env, budget) {
  const due = await db.pickDueReminders(env, MAX_NOTIFICATIONS);
  const todayIso = today(env);
  let sent = 0;

  for (const item of due) {
    if (!budget.has(1)) break;
    const res = await deliverReminder(env, budget, item.user_id, item, todayIso);
    if (res.skipped) break;
    // Логируем и при ошибке доставки (например, бот заблокирован) — иначе будем долбиться вечно.
    await db.logNotification(env, item.user_id, item.tmdb_id, item.media_type, item.release_date, item.stage);
    if (res.ok) sent += 1;
  }

  console.log(`sendReminders: ${sent}/${due.length}`);
  return sent;
}

const PERIODS = {
  week: {
    column: 'week_digest_on',
    days: 6,
    title: '📅 <b>На этой неделе у вас</b>',
  },
  weekend: {
    column: 'weekend_digest_on',
    days: 1,
    title: '🍿 <b>На выходных у вас</b>',
  },
};

function periodLine(item, todayIso) {
  const emoji = MEDIA_EMOJI[item.media_type] || '🎬';
  const bits = [];
  if (item.media_type === 'tv') {
    if (/^S\d/.test(item.release_type || '')) bits.push(item.release_type);
  } else if (item.release_type) {
    bits.push(kindWord(item.release_type));
    const other = item.theatrical_date === item.release_date ? item.digital_date : null;
    if (other && other > item.release_date) bits.push(`онлайн ${formatDate(other, todayIso)}`);
  }
  return `${emoji} ${escapeHtml(item.title)}${bits.length ? ` · ${escapeHtml(bits.join(' · '))}` : ''}`;
}

function periodText(kind, items, from, to, todayIso) {
  let range = `${formatDate(from, todayIso)} — ${formatDate(to, todayIso)}`;
  if (from === to) range = formatDate(from, todayIso);
  else if (from.slice(0, 7) === to.slice(0, 7)) range = `${Number(from.slice(8, 10))}–${formatDate(to, todayIso)}`;
  const lines = [`${PERIODS[kind].title} · ${range}`];
  let day = null;
  for (const item of items) {
    if (item.release_date !== day) {
      day = item.release_date;
      lines.push('', `<b>${dayHeader(day, todayIso)}</b>`);
    }
    lines.push(periodLine(item, todayIso));
  }
  return truncate(lines.join('\n'), 3900);
}

/** Альбом постеров и под ним список по дням. */
async function deliverPeriod(env, budget, chatId, kind, items, from, to, todayIso) {
  const posters = items.map((i) => posterUrl(i.poster_path, 'w342')).filter(Boolean).slice(0, 10);
  if (posters.length >= 2) {
    await tg.sendAlbum(env, budget, chatId, posters.map((url) => ({ type: 'photo', media: url })));
  } else if (posters.length === 1) {
    await tg.sendPhoto(env, budget, chatId, posters[0], '');
  }
  return tg.sendMessage(env, budget, chatId, periodText(kind, items, from, to, todayIso), {
    reply_markup: tg.keyboard([[appButton(env)]]),
  });
}

/**
 * Подборка по избранному за период. Альбом постеров и под ним список по дням.
 * Кто уже получил подборку сегодня — пропускается, поэтому вызывать можно
 * сколько угодно раз: утренний запуск шлёт основную массу, дневные дожимают остальных.
 */
export async function sendPeriodDigests(env, budget, kind, maxUsers = 15) {
  const period = PERIODS[kind];
  const from = today(env);
  const to = shiftDate(from, period.days);
  const users = await db.pickUsersForPeriod(env, period.column, from, to, maxUsers);
  let sent = 0;

  for (const userId of users) {
    if (budget.remaining < 3) break;
    const items = await db.favoritesInRange(env, userId, from, to);
    await db.markPeriodSent(env, userId, period.column, from);
    if (!items.length) continue;

    const res = await deliverPeriod(env, budget, userId, kind, items, from, to, from);
    if (res.ok) sent += 1;
  }

  console.log(`sendPeriodDigests(${kind}): ${sent}/${users.length}`);
  return sent;
}

/** День недели и час в часовом поясе бота. */
export function localClock(env) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TZ_NAME || 'Europe/Moscow', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { weekday: get('weekday'), hour: Number(get('hour')) };
}

/**
 * /preview — прислать себе все виды уведомлений прямо сейчас, в настоящем оформлении.
 * Берёт ваше избранное (а если оно пустое — ближайшие релизы из витрины).
 * Ничего не помечает как отправленное: настоящие уведомления придут по расписанию как обычно.
 */
export async function sendPreview(env, budget, userId) {
  const todayIso = today(env);
  let items = (await db.listFavorites(env, userId))
    .filter((i) => i.release_date && i.release_date.slice(0, 10) >= todayIso)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .slice(0, 8);
  let source = 'из вашего избранного';

  if (!items.length) {
    const { items: feed } = await readFeed(env, { type: 'a', page: 1, size: 6 });
    items = feed.map((row) => ({
      ...row,
      release_type: row.media_type === 'movie' ? row.release_kind : null,
      theatrical_date: row.release_kind === 'В кино' ? row.release_date : null,
    }));
    source = 'из ближайших релизов — избранное пока пустое';
  }
  if (!items.length) {
    return tg.sendMessage(env, budget, userId, 'Показать пока нечего: витрина ещё наполняется.');
  }
  items = items.map((i) => ({ ...i, release_date: i.release_date.slice(0, 10) }));

  await tg.sendMessage(env, budget, userId, [
    '🧪 <b>Пример уведомлений</b>',
    '',
    `Так они выглядят. Данные — ${source}, даты настоящие.`,
    'По расписанию придут сами: понедельник и суббота в 9 утра и в день выхода.',
  ].join('\n'));

  const first = items[0].release_date;
  const last = items[items.length - 1].release_date;
  await deliverPeriod(env, budget, userId, 'week', items, first, last, todayIso);
  await deliverPeriod(env, budget, userId, 'weekend', items.slice(0, 3), first,
    items.slice(0, 3).at(-1).release_date, todayIso);
  await deliverReminder(env, budget, userId, { ...items[0], stage: 'd0' }, todayIso);
  await deliverReminder(env, budget, userId, { ...items[0], stage: 'a3' }, todayIso);
  return { ok: true };
}
