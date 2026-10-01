const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Сегодняшняя дата 'YYYY-MM-DD' в таймзоне бота. */
export function today(env) {
  const tz = env?.TZ_NAME || 'Europe/Moscow';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/**
 * '2026-03-12' -> '12 марта 2026'.
 * Если передать сегодняшнюю дату и год совпадает — год не пишем: '12 марта'.
 */
export function formatDate(iso, todayIso) {
  if (!iso) return 'дата неизвестна';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.slice(0, 10));
  if (!m) return iso;
  const [, y, mm, dd] = m;
  const sameYear = todayIso && todayIso.slice(0, 4) === y;
  return `${Number(dd)} ${MONTHS[Number(mm) - 1]}${sameYear ? '' : ` ${y}`}`;
}

/** 'через 12 дней' / 'сегодня' / 'завтра' */
export function humanCountdown(days) {
  if (days === null) return '';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days === 2) return 'послезавтра';
  if (days < 0) return `${-days} ${plural(-days, ['день', 'дня', 'дней'])} назад`;
  return `через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

export function year(item) {
  const d = item.release_date || item.first_air_date || '';
  return d ? d.slice(0, 4) : '';
}

export function titleOf(item) {
  return item.title || item.name || item.original_title || item.original_name || 'Без названия';
}

export function truncate(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

export const MEDIA_EMOJI = { movie: '🎬', tv: '📺' };

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Заголовок дня для календаря: «Сегодня», «Завтра», «чт, 17 сен». */
export function dayHeader(iso, todayIso) {
  const days = daysBetween(todayIso, iso);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Завтра';
  if (days === 2) return 'Послезавтра';
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = WEEKDAYS[d.getUTCDay()];
  const label = `${wd}, ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  return todayIso.slice(0, 4) === iso.slice(0, 4) ? label : `${label} ${iso.slice(0, 4)}`;
}

const KIND_WORDS = {
  'цифра': 'онлайн',
  'в кино (огр.)': 'в кино',
  'тв': 'на ТВ',
};

/** Приводит тип релиза к человеческому виду (в базе могут лежать старые подписи). */
export function kindWord(label) {
  const lower = String(label || '').toLowerCase().trim();
  return KIND_WORDS[lower] || lower;
}
