import { escapeHtml } from './format.js';

export { escapeHtml };

function apiUrl(env, method) {
  // TELEGRAM_API_BASE подменяется только в локальных тестах (см. scripts/mock-telegram.mjs).
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  return `${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Вызов Telegram Bot API через бюджет субзапросов.
 * Никогда не бросает исключение — возвращает { ok, result } либо { ok:false, ... }.
 */
export async function call(env, budget, method, payload) {
  const res = await budget.fetch(apiUrl(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res) return { ok: false, skipped: true };
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error_code: res.status };
  }
  if (!data.ok) {
    console.warn('telegram error', method, data.error_code, data.description);
  }
  return data;
}

export function sendMessage(env, budget, chatId, text, extra = {}) {
  return call(env, budget, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function editMessageText(env, budget, chatId, messageId, text, extra = {}) {
  return call(env, budget, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function sendPhoto(env, budget, chatId, photo, caption, extra = {}) {
  return call(env, budget, 'sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Заменить картинку и подпись в уже отправленном сообщении — карусель без новых сообщений. */
export function editPhoto(env, budget, chatId, messageId, photo, caption, extra = {}) {
  return call(env, budget, 'editMessageMedia', {
    chat_id: chatId,
    message_id: messageId,
    media: { type: 'photo', media: photo, caption, parse_mode: 'HTML' },
    ...extra,
  });
}

/** Альбом. Подпись вешается на первую картинку и показывается под всей пачкой.
 *  Инлайн-кнопки к альбому Telegram не поддерживает — они идут отдельным сообщением. */
export async function sendAlbum(env, budget, chatId, media) {
  const res = await call(env, budget, 'sendMediaGroup', { chat_id: chatId, media });
  return Array.isArray(res.result) ? res.result.map((m) => m.message_id) : [];
}

export function deleteMessages(env, budget, chatId, messageIds) {
  if (!messageIds?.length) return Promise.resolve({ ok: true });
  return call(env, budget, 'deleteMessages', { chat_id: chatId, message_ids: messageIds.slice(0, 100) });
}

export function editReplyMarkup(env, budget, chatId, messageId, markup) {
  return call(env, budget, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: markup || { inline_keyboard: [] },
  });
}

export function answerCallback(env, budget, id, text, showAlert = false) {
  return call(env, budget, 'answerCallbackQuery', {
    callback_query_id: id,
    text: text ? text.slice(0, 200) : undefined,
    show_alert: showAlert,
  });
}

export function setMyCommands(env, budget) {
  return call(env, budget, 'setMyCommands', {
    commands: [
      { command: 'search', description: 'Найти фильм или сериал по названию' },
      { command: 'trending', description: 'Популярное и то, что скоро выходит' },
      { command: 'calendar', description: 'Мой календарь релизов' },
      { command: 'genres', description: 'Жанры для еженедельной подборки' },
      { command: 'help', description: 'Как пользоваться ботом' },
    ],
  });
}

export function keyboard(rows) {
  return { inline_keyboard: rows.filter((r) => r && r.length) };
}

/** Пометить отработавшие кнопки: текст меняется, повторное нажатие уже безопасно. */
export function markButtons(markup, predicate, makeText) {
  const rows = markup?.inline_keyboard || [];
  return {
    inline_keyboard: rows.map((row) => row.map((btn) => (predicate(btn.callback_data || '')
      ? { text: makeText(btn.text || '').slice(0, 60), callback_data: 'cal' }
      : btn))),
  };
}

/** Убрать из клавиатуры ряды, в которых есть кнопка с таким callback_data. */
export function dropRowsWith(markup, predicate) {
  const rows = markup?.inline_keyboard || [];
  return {
    inline_keyboard: rows.filter((row) => !row.some((b) => predicate(b.callback_data || ''))),
  };
}
