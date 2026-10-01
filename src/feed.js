import * as db from './db.js';
import * as tg from './telegram.js';
import { posterUrl } from './tmdb.js';
import { isRussianItem } from './kinopoisk.js';
import { readFeed, catalogSize } from './catalog.js';
import {
  escapeHtml, today, daysBetween, formatDate, humanCountdown, truncate, kindWord, MEDIA_EMOJI,
} from './format.js';

// Восемь тайтлов на пост. В альбом Telegram влезает до десяти картинок, но его
// подпись ограничена 1024 символами — на описания там места нет. Поэтому альбом
// идёт без подписи, а весь текст живёт в сообщении под ним: там лимит 4096,
// и описания с актёрами помещаются целиком.
export const FEED_SIZE = 8;

const TEXT_LIMIT = 3600;
const DESC_LIMIT = 170;

export function defaultFeed() {
  return { type: 'a', page: 1 };
}

export function parseFeed(parts) {
  const [type, page] = parts;
  return {
    type: ['a', 'm', 't'].includes(type) ? type : 'a',
    page: Math.max(1, Math.min(20, Number(page) || 1)),
  };
}

function feedData(state, patch = {}) {
  const s = { ...state, ...patch };
  return `f:${s.type}:${s.page}`;
}

/**
 * Рейтинги с подписями: голая звёздочка не объясняет, чья это оценка.
 * IMDb — зрители, 🍅 Tomatometer — критики, TMDB — запасной вариант,
 * когда в OMDb оценки ещё нет (у будущих релизов её обычно нет вовсе).
 */
function ratingFacts(item) {
  const out = [];
  // Кинопоиск — оценка русскоязычного зрителя; по горстке голосов не показываем.
  if (isRussianItem(item) && item.kp_rating && (item.kp_votes == null || item.kp_votes >= 100)) {
    out.push(`КП ${Number(item.kp_rating).toFixed(1)}`);
  }
  if (item.imdb_rating) out.push(`IMDb ${Number(item.imdb_rating).toFixed(1)}`);
  else if (item.vote_average >= 1 && (item.vote_count || 0) >= 50) {
    out.push(`TMDB ${Number(item.vote_average).toFixed(1)}`);
  }
  if (item.rt_critics) out.push(`🍅 ${item.rt_critics}%`);
  return out;
}

/**
 * Две строки на тайтл. Без отступов пробелами: при переносе длинной строки
 * Telegram их не сохраняет, и колонка разъезжается.
 */
function headLines(item, index, todayIso, mixed) {
  const emoji = MEDIA_EMOJI[item.media_type] || '🎬';
  const days = daysBetween(todayIso, item.release_date);
  const when = days <= 2
    ? `${humanCountdown(days)}, ${formatDate(item.release_date, todayIso)}`
    : `${formatDate(item.release_date, todayIso)} · ${humanCountdown(days)}`;

  // Тип пишем словом: по одной иконке не всегда понятно, фильм это или сериал.
  const kind = item.media_type === 'tv'
    ? (item.episode_label || 'сериал')
    : (mixed ? 'фильм' : null);

  const facts = [when];

  // Для фильма важно, это прокат или цифра: смотреть дома можно только со второй даты.
  if (item.media_type === 'movie' && item.release_kind) {
    facts.push(kindWord(item.release_kind));
    const digital = item.digital_date;
    if (digital && digital !== item.release_date && digital >= todayIso) {
      facts.push(`онлайн ${formatDate(digital, todayIso)}`);
    }
  }

  const genres = (item.genres || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 2);
  if (genres.length) facts.push(genres.join(', ').toLowerCase());
  facts.push(...ratingFacts(item));

  return {
    title: `${index}. ${emoji} <b>${escapeHtml(truncate(item.title || '', 44))}</b>`
      + (kind ? ` · ${escapeHtml(kind)}` : ''),
    facts: escapeHtml(facts.join(' · ')),
  };
}

/**
 * Синопсис режем по концу предложения, а не по счётчику символов:
 * «высмеивает тенденции, знаменитостей и политиков…» — это обрыв на полуслове,
 * от которого текст выглядит сломанным.
 */
function trimSynopsis(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= limit) return clean;

  const head = clean.slice(0, limit + 1);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentenceEnd > limit * 0.4) return head.slice(0, sentenceEnd + 1);

  const wordEnd = head.lastIndexOf(' ');
  const cut = wordEnd > limit * 0.4 ? wordEnd : limit;
  return `${clean.slice(0, cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Актёры и коротко о чём это. */
function description(item, limit) {
  const parts = [];
  if (item.actors) parts.push(`<i>${escapeHtml(item.actors)}</i>`);
  const synopsis = trimSynopsis(item.overview, limit);
  if (synopsis) parts.push(escapeHtml(synopsis));
  return parts.length ? parts.join(' — ') : null;
}

function dateRange(from, to, todayIso) {
  if (from === to) return formatDate(from, todayIso);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${Number(from.slice(8, 10))}–${formatDate(to, todayIso)}`;
  }
  return `${formatDate(from, todayIso)} — ${formatDate(to, todayIso)}`;
}

function buildText(items, state, todayIso) {
  const mixed = state.type === 'a';
  const typeLabel = { a: 'фильмы и сериалы', m: 'только кино', t: 'только сериалы' }[state.type];
  const range = dateRange(items[0].release_date, items[items.length - 1].release_date, todayIso);
  const header = [`🔥 <b>Ближайшие релизы</b> · ${escapeHtml(range)}`, `<i>${typeLabel}</i>`, ''];

  const blocks = items.map((item, index) => {
    const head = headLines(item, index + 1, todayIso, mixed);
    const desc = description(item, DESC_LIMIT);
    return [head.title, head.facts, desc].filter(Boolean).join('\n');
  });
  return truncate([...header, blocks.join('\n\n')].join('\n'), TEXT_LIMIT);
}

function feedKeyboard(items, state, hasMore, env) {
  const titleRows = items.map((item, i) => ([{
    text: truncate(`⭐ ${i + 1}. ${item.title || ''}`, 44),
    callback_data: `a:${item.media_type === 'tv' ? 't' : 'm'}:${item.tmdb_id}`,
  }]));

  const mark = (active, label) => (active ? `✅ ${label}` : label);
  return tg.keyboard([
    ...titleRows,
    [
      { text: mark(state.type === 'a', '🎞 Всё'), callback_data: feedData(state, { type: 'a', page: 1 }) },
      { text: mark(state.type === 'm', '🎬 Кино'), callback_data: feedData(state, { type: 'm', page: 1 }) },
      { text: mark(state.type === 't', '📺 Сериалы'), callback_data: feedData(state, { type: 't', page: 1 }) },
    ],
    [
      state.page > 1
        ? { text: '◀ Назад', callback_data: feedData(state, { page: state.page - 1 }) }
        : { text: '·', callback_data: 'noop' },
      { text: `стр. ${state.page}`, callback_data: 'noop' },
      hasMore
        ? { text: 'Дальше ▶', callback_data: feedData(state, { page: state.page + 1 }) }
        : { text: '·', callback_data: 'noop' },
    ],
    [
      { text: '⭐ Моё ожидание', callback_data: 'cal' },
      { text: '🔎 Найти', callback_data: 'ask' },
    ],
    [{
      text: '🗂 Открыть список',
      web_app: { url: env.APP_URL || 'https://release-radar-bot.release-radar-bot.workers.dev/app' },
    }],
  ]);
}

/**
 * Пост: альбом постеров с общей подписью плюс сообщение с кнопками сразу под ним.
 * Инлайн-кнопки к альбому Telegram не поддерживает, а состав альбома нельзя
 * отредактировать — поэтому «Дальше» удаляет прошлый пост и присылает новый.
 * Данные берутся из каталога в D1, так что внешних запросов тут нет вообще.
 */
export async function sendFeed(env, budget, chatId, userId, state) {
  const todayIso = today(env);
  const { items, hasMore } = await readFeed(env, {
    type: state.type, page: state.page, size: FEED_SIZE,
  });

  const previous = await db.getLastPost(env, userId);
  if (previous.length) await tg.deleteMessages(env, budget, chatId, previous);

  if (!items.length) {
    const total = await catalogSize(env);
    const text = total
      ? 'Дальше пока пусто — вернитесь назад.'
      : 'Витрина ещё наполняется, загляните через пару часов.';
    const res = await tg.sendMessage(env, budget, chatId, text, {
      reply_markup: feedKeyboard([], state, false, env),
    });
    await db.setLastPost(env, userId, res.result?.message_id ? [res.result.message_id] : []);
    return res;
  }

  const ids = [];
  // Альбом идёт без подписи: весь текст ниже, в сообщении с кнопками.
  if (items.length >= 2) {
    const media = items.map((item) => ({
      type: 'photo',
      media: posterUrl(item.poster_path, 'w342'),
    }));
    ids.push(...await tg.sendAlbum(env, budget, chatId, media));
  } else {
    const one = await tg.sendPhoto(env, budget, chatId, posterUrl(items[0].poster_path, 'w342'), '');
    if (one.result?.message_id) ids.push(one.result.message_id);
  }

  const control = await tg.sendMessage(env, budget, chatId, buildText(items, state, todayIso), {
    reply_markup: feedKeyboard(items, state, hasMore, env),
  });
  if (control.result?.message_id) ids.push(control.result.message_id);

  await db.setLastPost(env, userId, ids);
  return control;
}
