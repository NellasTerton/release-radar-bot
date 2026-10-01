#!/usr/bin/env node
// Заглушка Telegram Bot API для локальной отладки: печатает то, что бот собирался отправить.
//   node scripts/mock-telegram.mjs [порт]
//   npx wrangler dev --var TELEGRAM_API_BASE:http://127.0.0.1:8899
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8899);
let counter = 1000;

function renderKeyboard(markup) {
  if (!markup) return '';
  const rows = markup.inline_keyboard || markup.keyboard || [];
  if (!rows.length) {
    if (markup.force_reply) return '    [поле ввода в фокусе]\n';
    if (markup.remove_keyboard) return '    [нижняя клавиатура убрана]\n';
    return '';
  }
  const kind = markup.inline_keyboard ? 'inline' : 'reply';
  return `${rows.map((row) => `    [${kind}] ${row.map((b) => b.text || b).join(' | ')}`).join('\n')}\n`;
}

const strip = (s) => String(s).replace(/<[^>]+>/g, '');

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* пусто */ }

    const group = Array.isArray(payload.media) ? payload.media : null;
    const text = payload.text
      || payload.caption
      || payload.media?.caption
      || group?.find((m) => m.caption)?.caption
      || '';

    console.log(`\n=== ${method} ===`);
    if (Array.isArray(payload.message_ids)) console.log(`  удаляет сообщения: ${payload.message_ids.join(', ')}`);
    if (payload.photo) console.log(`  [фото] ${payload.photo}`);
    if (payload.media?.media) console.log(`  [фото] ${payload.media.media}`);
    if (group) console.log(group.map((m, i) => `  [постер ${i + 1}] ${m.media}`).join('\n'));
    if (text) console.log(strip(text));
    if (payload.show_alert !== undefined) console.log(`  всплывашка: ${strip(payload.text || '(пусто)')}`);
    const kb = renderKeyboard(payload.reply_markup);
    if (kb) process.stdout.write(kb);

    // sendMediaGroup отдаёт массив сообщений — бот запоминает их id, чтобы потом удалить.
    let result;
    if (group) {
      result = group.map(() => { counter += 1; return { message_id: counter, chat: { id: payload.chat_id } }; });
    } else {
      counter += 1;
      result = { message_id: counter, date: 0, chat: { id: payload.chat_id } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock telegram на http://127.0.0.1:${port}`));
