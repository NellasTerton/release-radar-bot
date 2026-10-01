// Фильтры пользователя: жанры и страны.
//
// Жанры у TMDB для фильмов и сериалов называются по-разному («фантастика» и «НФ и Фэнтези»),
// а Кинопоиск добавляет свои. Чтобы в приложении было десять понятных кнопок, а не тридцать,
// каждый тайтл получает набор ключей — они и лежат в catalog.genre_keys.

export const GENRES = [
  { key: 'action', label: 'Боевик и приключения', match: ['боевик', 'приключ', 'вестерн'] },
  { key: 'comedy', label: 'Комедия', match: ['комеди'] },
  { key: 'drama', label: 'Драма', match: ['драма', 'истори', 'биограф', 'военн', 'война и полит'] },
  { key: 'scifi', label: 'Фантастика и фэнтези', match: ['фантастик', 'фэнтези'] },
  { key: 'horror', label: 'Ужасы', match: ['ужас'] },
  { key: 'thriller', label: 'Триллер и детектив', match: ['триллер', 'детектив', 'криминал'] },
  { key: 'animation', label: 'Мультфильмы', match: ['мультфильм', 'анимац', 'аниме'] },
  { key: 'family', label: 'Семейное', match: ['семейн', 'детск'] },
  { key: 'romance', label: 'Мелодрама', match: ['мелодрам', 'роман'] },
  { key: 'doc', label: 'Документальное', match: ['документ', 'музык', 'спорт'] },
];

const GENRE_KEYS = new Set(GENRES.map((g) => g.key));

/** Жанры тайтла («драма, криминал») — в ключи («drama,thriller»). */
export function genreKeys(genres) {
  const text = String(genres || '').toLowerCase();
  if (!text) return null;
  const keys = GENRES.filter((g) => g.match.some((m) => text.includes(m))).map((g) => g.key);
  return keys.length ? keys.join(',') : null;
}

// Страны — группами: двести стран списком выбирать невозможно.
export const COUNTRIES = [
  { key: 'us', label: 'США', codes: ['US'] },
  { key: 'gb', label: 'Великобритания', codes: ['GB'] },
  {
    key: 'eu',
    label: 'Европа',
    codes: [
      'DE', 'FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'IS', 'IE', 'AT', 'CH',
      'PL', 'CZ', 'SK', 'HU', 'GR', 'RO', 'BG', 'HR', 'RS', 'SI', 'EE', 'LV', 'LT', 'UA',
    ],
  },
  { key: 'ru', label: 'Россия', codes: ['RU'] },
  { key: 'kr_jp', label: 'Корея и Япония', codes: ['KR', 'JP'] },
  { key: 'in', label: 'Индия', codes: ['IN'] },
  { key: 'cn', label: 'Китай', codes: ['CN', 'HK', 'TW'] },
  { key: 'tr', label: 'Турция', codes: ['TR'] },
  { key: 'latam', label: 'Латинская Америка', codes: ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY'] },
];

const COUNTRY_KEYS = new Set(COUNTRIES.map((c) => c.key));
const BY_CODE = new Map();
for (const group of COUNTRIES) for (const code of group.codes) BY_CODE.set(code, group.key);

/**
 * Группа стран по данным TMDB. Берём первую известную страну производства:
 * у копродукции («Великобритания, США») важнее, кто снимал, а не полный список.
 */
export function countryGroup(details) {
  const codes = [
    ...(details?.origin_country || []),
    ...(details?.production_countries || []).map((c) => c.iso_3166_1),
  ];
  for (const code of codes) {
    const group = BY_CODE.get(code);
    if (group) return group;
  }
  // Язык оригинала — запасной признак: у части тайтлов стран в TMDB нет.
  const byLanguage = { ru: 'ru', en: 'us', ja: 'kr_jp', ko: 'kr_jp', hi: 'in', tr: 'tr', zh: 'cn' };
  return byLanguage[details?.original_language] || (codes.length ? 'other' : null);
}

/** Разбор сохранённого выбора: только известные ключи, пустой список — «всё». */
export function parseFilter(value, kind) {
  const known = kind === 'genres' ? GENRE_KEYS : COUNTRY_KEYS;
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => known.has(v));
}

/**
 * Условие для SQL. Жанры: хотя бы один из выбранных. Страны: точное совпадение группы.
 * Тайтлы, собранные только ради фильтра (индийское, китайское, турецкое), показываются,
 * только если их страна выбрана явно.
 */
export function filterSql(genres, countries) {
  const parts = [];
  if (genres.length) {
    parts.push(`(${genres.map((g) => `(',' || genre_keys || ',') LIKE '%,${g},%'`).join(' OR ')})`);
  }
  if (countries.length) {
    parts.push(`country_group IN (${countries.map((c) => `'${c}'`).join(', ')})`);
  } else {
    parts.push('extra = 0');
  }
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}
