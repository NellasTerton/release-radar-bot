#!/usr/bin/env node
// Читает keys.txt в корне проекта и раскладывает значения по именам переменных воркера.
//   node scripts/parse-keys.mjs            -> пишет .dev.vars
//   node scripts/parse-keys.mjs --get NAME -> печатает одно значение (для wrangler secret put)
//   node scripts/parse-keys.mjs --list      -> печатает имена найденных переменных
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keysPath = resolve(root, 'keys.txt');
const devVarsPath = resolve(root, '.dev.vars');

// Слева — как строка названа в keys.txt (без учёта регистра и пробелов), справа — имя переменной воркера.
const ALIASES = [
  [/telegram|bot[_ ]?token|release[_ ]?radar/i, 'TELEGRAM_BOT_TOKEN'],
  [/read[_ ]?access[_ ]?token|v4/i, 'TMDB_READ_TOKEN'],
  [/api[_ ]?key.*v3|^tmdb[_ ]?api[_ ]?key$|v3/i, 'TMDB_API_KEY'],
  [/cloudflare/i, 'CLOUDFLARE_API_TOKEN'],
];

function parse() {
  if (!existsSync(keysPath)) {
    console.error('keys.txt не найден в корне проекта');
    process.exit(1);
  }
  const out = {};
  for (const line of readFileSync(keysPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const rawName = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    const alias = ALIASES.find(([re]) => re.test(rawName));
    out[alias ? alias[1] : rawName.replace(/\W+/g, '_').toUpperCase()] = value;
  }
  return out;
}

const vars = parse();

// Секрет для проверки заголовка вебхука. Генерируем один раз и переиспользуем.
if (!vars.TELEGRAM_WEBHOOK_SECRET) {
  const existing = existsSync(devVarsPath)
    ? /^TELEGRAM_WEBHOOK_SECRET=(.+)$/m.exec(readFileSync(devVarsPath, 'utf8'))
    : null;
  vars.TELEGRAM_WEBHOOK_SECRET = existing ? existing[1].trim() : randomBytes(24).toString('hex');
}

const arg = process.argv[2];
if (arg === '--get') {
  const value = vars[process.argv[3]];
  if (!value) process.exit(2);
  process.stdout.write(value);
} else if (arg === '--list') {
  process.stdout.write(Object.keys(vars).join('\n'));
} else {
  const body = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(devVarsPath, `${body}\n`, 'utf8');
  console.log(`.dev.vars записан: ${Object.keys(vars).join(', ')}`);
}
