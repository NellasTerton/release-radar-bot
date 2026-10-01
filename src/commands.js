import * as db from './db.js';
import * as tg from './telegram.js';
import { tmdbUrl } from './tmdb.js';
import { smartSearch } from './search.js';
import { addTitle, parseTitleLink, looksLikeLink } from './titles.js';
import { sendFeed, defaultFeed, parseFeed } from './feed.js';
import { GENRES, parsePrefs, serializePrefs, genreBySlug } from './genres.js';
import { ratingLine } from './omdb.js';
import { sendPreview } from './cron.js';
import {
  escapeHtml, today, daysBetween, formatDate, humanCountdown, dayHeader, kindWord,
  titleOf, year, truncate, MEDIA_EMOJI,
} from './format.js';

const SEARCH_RESULTS = 8;
// Столько ближайших показываем в чате; остальное — в приложении.
const CALENDAR_PREVIEW = 8;

// Постоянной клавиатуры под полем ввода больше нет: две панели кнопок сразу
// (своя внизу экрана и своя в сообщении) выглядели тяжело. Навигация живёт
// в самих сообщениях, команды — в меню Telegram.
const WELCOME = [
  '👋 Я слежу за датами выхода фильмов и сериалов.',
  '',
  'Смотреть и добавлять — в приложении, кнопка ниже.',
  'А сюда буду присылать:',
  '• по понедельникам — что из вашего избранного выходит на неделе;',
  '• по субботам — что выходит на выходных;',
  '• в день выхода — короткое напоминание с постером.',
].join('\n');

const HELP = [
  '<b>Как пользоваться</b>',
  '',
  '🔥 /trending — лента ближайших релизов: 8 проектов в посте, кнопки-номера добавляют в ожидание,',
  'фильтры переключают кино и сериалы, стрелки листают на три месяца вперёд.',
  '⭐ /calendar — ваш список по датам: серии избранных сериалов, у фильмов — прокат и цифра.',
  '🔎 /search Дюна — поиск по названию: терпит опечатки, год в запросе и любой язык.',
  '🎚 /genres — жанры для еженедельной подборки.',
  '',
  'Ещё понимаю ссылки с themoviedb.org и imdb.com — добавлю сразу.',
].join('\n');

// ---------------------------------------------------------------------------
// Роутинг
// ---------------------------------------------------------------------------

export async function handleUpdate(env, budget, update) {
  if (update.message) return handleMessage(env, budget, update.message);
  if (update.callback_query) return handleCallback(env, budget, update.callback_query);
  return undefined;
}

async function handleMessage(env, budget, message) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = (message.text || '').trim();
  if (!chatId || !userId || !text) return;

  await db.ensureUser(env, userId);

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];
  const args = rest.join(' ').trim();

  switch (command) {
    case '/start':
      // Без ленты-поста: всё смотрится в приложении, чат — для уведомлений.
      return tg.sendMessage(env, budget, chatId, WELCOME, {
        reply_markup: tg.keyboard([[{ ...openAppButton(env), text: '🎬 Открыть приложение' }]]),
      });
    case '/preview':
      return sendPreview(env, budget, userId);
    case '/help':
    case '/menu':
      return tg.sendMessage(env, budget, chatId, HELP, { reply_markup: navKeyboard(env) });
    case '/search':
      if (!args) return askForQuery(env, budget, chatId);
      return sendSearch(env, budget, chatId, args);
    case '/trending':
    case '/feed':
      return sendFeed(env, budget, chatId, userId, defaultFeed());
    case '/calendar':
      return sendCalendar(env, budget, chatId, userId);
    case '/genres':
      return sendGenres(env, budget, { chatId }, userId);
    default:
      break;
  }

  if (command.startsWith('/')) {
    return tg.sendMessage(env, budget, chatId, 'Не знаю такую команду. Вот что есть:', {
      reply_markup: navKeyboard(env),
    });
  }

  if (looksLikeLink(text)) return handleLink(env, budget, chatId, userId, text);
  return sendSearch(env, budget, chatId, text);
}

function appUrl(env) {
  return env.APP_URL || 'https://release-radar-bot.release-radar-bot.workers.dev/app';
}

/** Кнопка, открывающая мини-апп прямо внутри Telegram. */
function openAppButton(env) {
  return { text: '🗂 Открыть список', web_app: { url: appUrl(env) } };
}

function navKeyboard(env) {
  return tg.keyboard([
    [openAppButton(env)],
    [{ text: '🔥 Скоро выходит', callback_data: 'f:a:1' }],
    [{ text: '⭐ Моё ожидание', callback_data: 'cal' }, { text: '🔎 Найти', callback_data: 'ask' }],
  ]);
}

function askForQuery(env, budget, chatId) {
  return tg.sendMessage(
    env, budget, chatId,
    '🔎 Напишите название — найду.',
    { reply_markup: { force_reply: true, input_field_placeholder: 'Например: Дюна' } },
  );
}

// ---------------------------------------------------------------------------
// Поиск и ссылки
// ---------------------------------------------------------------------------

async function sendSearch(env, budget, chatId, query) {
  const { results, fuzzy, usedQuery } = await smartSearch(env, budget, query);

  if (!results.length) {
    return tg.sendMessage(env, budget, chatId, `😕 Ничего не нашлось по «${escapeHtml(query)}».`, {
      reply_markup: navKeyboard(env),
    });
  }

  const header = fuzzy
    ? `🔎 Точного совпадения нет, ближайшее — по «${escapeHtml(usedQuery)}»:`
    : '🔎 Нашёл. Нажмите, чтобы добавить в ожидание:';
  const rows = results.slice(0, SEARCH_RESULTS).map((item) => {
    const type = item.media_type === 'tv' ? 'tv' : 'movie';
    const y = year(item);
    return [{
      text: truncate(`${MEDIA_EMOJI[type]} ${titleOf(item)}${y ? ` (${y})` : ''}`, 52),
      callback_data: `a:${short(type)}:${item.id}`,
    }];
  });
  rows.push([{ text: '🔥 Скоро выходит', callback_data: 'f:a:1' }]);
  return tg.sendMessage(env, budget, chatId, header, { reply_markup: tg.keyboard(rows) });
}

async function handleLink(env, budget, chatId, userId, text) {
  const parsed = await parseTitleLink(env, budget, text);
  if (!parsed) {
    return tg.sendMessage(
      env, budget, chatId,
      'Понимаю ссылки на themoviedb.org и imdb.com. Или просто пришлите название.',
    );
  }
  if (parsed.notFound) return tg.sendMessage(env, budget, chatId, 'Не нашёл этот тайтл в TMDB.');

  const res = await addTitle(env, budget, userId, parsed.mediaType, parsed.tmdbId);
  if (!res.ok) return tg.sendMessage(env, budget, chatId, 'TMDB сейчас недоступен, попробуйте позже.');
  await db.recordDigestDecision(env, userId, parsed.tmdbId, parsed.mediaType, 'added');
  return tg.sendMessage(env, budget, chatId, addedText(res, env), {
    reply_markup: tg.keyboard([[
      { text: '⭐ Моё ожидание', callback_data: 'cal' },
      { text: '🗑 Убрать', callback_data: `x:${short(parsed.mediaType)}:${parsed.tmdbId}` },
    ]]),
  });
}

function addedText(res, env) {
  const emoji = MEDIA_EMOJI[res.details.media_type] || '🎬';
  const date = res.date.release_date;
  const todayIso = today(env);
  const days = date ? daysBetween(todayIso, date) : null;
  const when = date
    ? `${formatDate(date, todayIso)}${days !== null && days >= 0 ? ` · ${humanCountdown(days)}` : ''}`
    : 'дата пока неизвестна — сообщу, как появится';
  const rating = ratingLine(res.meta, res.details.vote_average);
  return [
    `${emoji} <b>${escapeHtml(res.title)}</b>`,
    res.added ? 'Добавил — напомню заранее.' : 'Уже в вашем списке.',
    `🗓 ${when}`,
    rating ? `📊 ${rating}` : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// ⭐ Моё ожидание — по датам, как настенный календарь
// ---------------------------------------------------------------------------

/** Строка тайтла: у сериала — номер серии, у фильма — прокат и цифра. */
function favoriteLine(item, todayIso, archive = false) {
  const emoji = MEDIA_EMOJI[item.media_type] || '🎬';
  const facts = [];
  if (archive && item.date) facts.push(formatDate(item.date, todayIso));

  if (item.media_type === 'tv') {
    if (item.release_type && /^S\d/.test(item.release_type)) facts.push(item.release_type);
    else if (item.release_type === 'Премьера') facts.push('премьера');
    // Чтобы не гадать, ждать ли ещё серий.
    if (['Ended', 'Canceled'].includes(item.status)) facts.push('сериал завершён');
  } else {
    const isTheatrical = item.theatrical_date && item.theatrical_date === item.date;
    const isDigital = item.digital_date && item.digital_date === item.date;
    if (isTheatrical) facts.push('в кино');
    else if (isDigital) facts.push('онлайн');

    const other = isTheatrical ? item.digital_date : item.theatrical_date;
    const label = isTheatrical ? 'онлайн' : 'в кино';
    if (other && other !== item.date && other >= todayIso) {
      facts.push(`${label} — ${formatDate(other, todayIso)}`);
    }
  }

  const rating = ratingLine(item);
  if (rating) facts.push(rating);

  return `${emoji} ${escapeHtml(item.title)}${facts.length ? ` · <i>${escapeHtml(facts.join(' · '))}</i>` : ''}`;
}

/** Разложить избранное на «впереди», «дата неизвестна» и «уже вышло». */
function splitFavorites(favorites, todayIso) {
  const upcoming = [];
  const released = [];
  const unknown = [];
  for (const f of favorites) {
    const date = f.release_date ? f.release_date.slice(0, 10) : null;
    if (!date) unknown.push({ ...f, date: null });
    else if (date >= todayIso) upcoming.push({ ...f, date });
    else released.push({ ...f, date });
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  released.sort((a, b) => b.date.localeCompare(a.date));
  return { upcoming, released, unknown };
}

/**
 * В чате список только показывается — коротко и без единой кнопки на строке.
 * Всё управление (листание, удаление, архив, поиск) уехало в мини-апп:
 * в переписке простыня из корзин была нечитаемой.
 */
async function sendCalendar(env, budget, chatId, userId, messageId) {
  const todayIso = today(env);
  const favorites = await db.listFavorites(env, userId);
  const { upcoming, released, unknown } = splitFavorites(favorites, todayIso);
  const ahead = [...upcoming, ...unknown];

  const lines = ['⭐ <b>Моё ожидание</b>'];
  if (!ahead.length) {
    lines.push('', released.length
      ? 'Впереди пусто — всё, что вы ждали, уже вышло.'
      : 'Пока пусто. Добавьте что-нибудь — напомню заранее.');
  }

  let currentDay = null;
  for (const item of ahead.slice(0, CALENDAR_PREVIEW)) {
    const key = item.date || 'unknown';
    if (key !== currentDay) {
      currentDay = key;
      if (item.date) {
        const days = daysBetween(todayIso, item.date);
        lines.push('', `<b>${dayHeader(item.date, todayIso)}</b>${days > 2 ? ` · через ${days} дн.` : ''}`);
      } else {
        lines.push('', '<b>Дата пока неизвестна</b>');
      }
    }
    lines.push(favoriteLine(item, todayIso));
  }

  const rest = Math.max(0, ahead.length - CALENDAR_PREVIEW);
  const tail = [];
  if (rest) tail.push(`ещё ${rest} впереди`);
  if (released.length) tail.push(`${released.length} уже вышло`);
  if (tail.length) lines.push('', `<i>И ${tail.join(', ')} — в приложении.</i>`);

  return editOrSend(env, budget, chatId, messageId, {
    text: truncate(lines.join('\n'), 3900),
    markup: tg.keyboard([
      [openAppButton(env)],
      [
        { text: '🔥 Скоро выходит', callback_data: 'f:a:1' },
        { text: '🔎 Найти', callback_data: 'ask' },
      ],
    ]),
  });
}

/** Отредактировать сообщение, а если не вышло (например, это было фото) — отправить новое. */
async function editOrSend(env, budget, chatId, messageId, payload) {
  if (messageId) {
    const res = await tg.editMessageText(env, budget, chatId, messageId, payload.text, {
      reply_markup: payload.markup,
    });
    if (res.ok || res.skipped || /not modified/i.test(res.description || '')) return res;
  }
  return tg.sendMessage(env, budget, chatId, payload.text, { reply_markup: payload.markup });
}

// ---------------------------------------------------------------------------
// Жанры
// ---------------------------------------------------------------------------

async function sendGenres(env, budget, target, userId) {
  const user = await db.getUser(env, userId);
  const selected = new Set(parsePrefs(user?.genre_prefs));
  return editOrSend(env, budget, target.chatId, target.messageId, {
    text: genresText(selected),
    markup: genresKeyboard(selected),
  });
}

function genresText(selected) {
  const chosen = GENRES.filter((g) => selected.has(g.slug)).map((g) => g.label);
  return [
    '🎚 <b>Ваши жанры</b>',
    '',
    'Нужны для еженедельной подборки новинок.',
    '',
    chosen.length
      ? `Выбрано: <b>${escapeHtml(chosen.join(', '))}</b>`
      : 'Пока ничего не выбрано — подборка будет общей.',
  ].join('\n');
}

function genresKeyboard(selected) {
  const rows = [];
  for (let i = 0; i < GENRES.length; i += 2) {
    rows.push(GENRES.slice(i, i + 2).map((g) => ({
      text: `${selected.has(g.slug) ? '✅' : '▫️'} ${g.label}`,
      callback_data: `g:${g.slug}`,
    })));
  }
  rows.push([
    { text: '🧹 Сбросить', callback_data: 'gc' },
    { text: '✔️ Готово', callback_data: 'gd' },
  ]);
  return tg.keyboard(rows);
}

// ---------------------------------------------------------------------------
// Callback-кнопки
// ---------------------------------------------------------------------------

const TYPE_BY_SHORT = { m: 'movie', t: 'tv' };
const VERDICTS = { l: 'liked', d: 'disliked', n: 'skipped' };
const VERDICT_LABEL = { l: '👍 Понравилось', d: '👎 Не зашло', n: '🙈 Не смотрел' };

function short(mediaType) {
  return mediaType === 'tv' ? 't' : 'm';
}

async function handleCallback(env, budget, query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const userId = query.from?.id;
  if (!chatId || !userId) return tg.answerCallback(env, budget, query.id);

  await db.ensureUser(env, userId);
  const [kind, a, b, c, d] = data.split(':');

  switch (kind) {
    case 'noop':
      return tg.answerCallback(env, budget, query.id);

    case 'ask':
      await tg.answerCallback(env, budget, query.id);
      return askForQuery(env, budget, chatId);

    case 'f':
      await tg.answerCallback(env, budget, query.id);
      return sendFeed(env, budget, chatId, userId, parseFeed([a, b]));

    case 'a': {
      const mediaType = TYPE_BY_SHORT[a];
      const tmdbId = Number(b);
      if (!mediaType || !tmdbId) return tg.answerCallback(env, budget, query.id, 'Странная кнопка');
      const res = await addTitle(env, budget, userId, mediaType, tmdbId);
      if (!res.ok) return tg.answerCallback(env, budget, query.id, 'TMDB недоступен, попробуйте позже', true);
      await db.recordDigestDecision(env, userId, tmdbId, mediaType, 'added');
      const when = res.date.release_date ? formatDate(res.date.release_date) : 'дата пока неизвестна';
      const toast = res.added
        ? `✅ ${truncate(res.title, 40)}\n🗓 ${when}\n\nНапомню за три дня, за сутки и в день выхода.`
        : 'Уже в вашем списке';
      await tg.answerCallback(env, budget, query.id, toast, true);
      return markRowDone(env, budget, query, chatId, messageId, tmdbId);
    }

    case 'h': {
      const mediaType = TYPE_BY_SHORT[a];
      const tmdbId = Number(b);
      if (!mediaType || !tmdbId) return tg.answerCallback(env, budget, query.id);
      await db.recordDigestDecision(env, userId, tmdbId, mediaType, 'hidden');
      await tg.answerCallback(env, budget, query.id, '🙈 Больше не покажу');
      return markRowDone(env, budget, query, chatId, messageId, tmdbId, true);
    }

    case 'r': {
      // Ответ на «вы посмотрели?»: r:<m|t>:<id>:<дата>:<l|d|n>
      const mediaType = TYPE_BY_SHORT[a];
      const tmdbId = Number(b);
      const verdict = VERDICTS[d];
      if (!mediaType || !tmdbId || !verdict) return tg.answerCallback(env, budget, query.id);
      await db.saveReaction(env, userId, tmdbId, mediaType, c, verdict);
      await tg.answerCallback(env, budget, query.id, 'Записал, спасибо!');
      return tg.editReplyMarkup(env, budget, chatId, messageId, {
        inline_keyboard: [[{ text: VERDICT_LABEL[d], callback_data: 'noop' }]],
      });
    }

    case 'x': {
      const mediaType = TYPE_BY_SHORT[a];
      const tmdbId = Number(b);
      if (!mediaType || !tmdbId) return tg.answerCallback(env, budget, query.id);
      // Название нужно заранее: после удаления его уже негде взять для кнопки «Вернуть».
      const removed = await db.removeFavorite(env, userId, tmdbId, mediaType);
      await tg.answerCallback(env, budget, query.id, removed ? '🗑 Убрал' : 'Этого и не было');
      return sendCalendar(env, budget, chatId, userId, messageId);
    }

    case 'u': {
      const mediaType = TYPE_BY_SHORT[a];
      const tmdbId = Number(b);
      if (!mediaType || !tmdbId) return tg.answerCallback(env, budget, query.id);
      const res = await addTitle(env, budget, userId, mediaType, tmdbId);
      await tg.answerCallback(env, budget, query.id, res.ok ? '↩️ Вернул' : 'Не вышло, попробуйте позже');
      return sendCalendar(env, budget, chatId, userId, messageId);
    }

    // Без номера страницы кнопка пришла с другого экрана (например, из ленты) —
    // тогда список отправляем новым сообщением, а не затираем чужое.
    case 'cal':
    case 'arc': // 'arc' и 'cale' остались в уже отправленных сообщениях
    case 'cale':
      await tg.answerCallback(env, budget, query.id);
      return sendCalendar(env, budget, chatId, userId, a ? messageId : null);

    case 'gopen':
      await tg.answerCallback(env, budget, query.id);
      return sendGenres(env, budget, { chatId }, userId);

    case 'g': {
      if (!genreBySlug(a)) return tg.answerCallback(env, budget, query.id);
      const user = await db.getUser(env, userId);
      const selected = new Set(parsePrefs(user?.genre_prefs));
      if (selected.has(a)) selected.delete(a);
      else selected.add(a);
      await db.setGenrePrefs(env, userId, serializePrefs([...selected]));
      await tg.answerCallback(env, budget, query.id);
      return tg.editMessageText(env, budget, chatId, messageId, genresText(selected), {
        reply_markup: genresKeyboard(selected),
      });
    }

    case 'gc':
      await db.setGenrePrefs(env, userId, '');
      await tg.answerCallback(env, budget, query.id, 'Сбросил');
      return tg.editMessageText(env, budget, chatId, messageId, genresText(new Set()), {
        reply_markup: genresKeyboard(new Set()),
      });

    case 'gd': {
      const user = await db.getUser(env, userId);
      const chosen = parsePrefs(user?.genre_prefs);
      await tg.answerCallback(env, budget, query.id, chosen.length ? 'Сохранил' : 'Подборка будет общей');
      const labels = GENRES.filter((g) => chosen.includes(g.slug)).map((g) => g.label);
      const text = labels.length
        ? `🎚 Жанры сохранены: <b>${escapeHtml(labels.join(', '))}</b>`
        : '🎚 Жанры не выбраны — подборка будет общей.';
      return tg.editMessageText(env, budget, chatId, messageId, text, { reply_markup: navKeyboard(env) });
    }

    default:
      return tg.answerCallback(env, budget, query.id);
  }
}

/** Пометить отработавшую кнопку тайтла (в ленте, подборке и списке поиска). */
function markRowDone(env, budget, query, chatId, messageId, tmdbId, hidden = false) {
  const markup = query.message?.reply_markup;
  if (!markup || !messageId) return undefined;
  const matches = (cd) => /^[ah]:[mt]:\d+$/.test(cd) && cd.endsWith(`:${tmdbId}`);
  if (!markup.inline_keyboard.some((row) => row.some((btn) => matches(btn.callback_data || '')))) {
    return undefined;
  }
  const next = tg.markButtons(markup, matches, (text) => (hidden
    ? '🙈'
    : `✅${text.replace(/^[⭐➕✅]\s*/u, ' ')}`));
  return tg.editReplyMarkup(env, budget, chatId, messageId, next);
}

export { short, tmdbUrl };
