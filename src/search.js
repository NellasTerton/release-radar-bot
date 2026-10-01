import { searchMulti } from './tmdb.js';
import { titleOf } from './format.js';

// TMDB ищет по всем альтернативным названиям, поэтому японский, корейский, ромадзи
// и транслит работают сами по себе. А вот опечатки, год в запросе и не та раскладка —
// нет, поэтому при пустом ответе пробуем запрос в нескольких вариантах.

const EN_TO_RU = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю',
};
const RU_TO_EN = Object.fromEntries(Object.entries(EN_TO_RU).map(([en, ru]) => [ru, en]));

/** Убрать год и лишнюю пунктуацию: «Интерстелар 2014» TMDB не находит, «Интерстелар» — находит. */
export function normalizeQuery(query) {
  return String(query)
    .replace(/\b(18|19|20)\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «L.yf» -> «Дюна»: текст, набранный не в той раскладке. */
export function swapLayout(query) {
  const src = String(query);
  const hasCyrillic = /[а-яё]/i.test(src);
  const map = hasCyrillic ? RU_TO_EN : EN_TO_RU;
  let changed = false;
  const out = [...src].map((ch) => {
    const lower = ch.toLowerCase();
    const mapped = map[lower];
    if (!mapped) return ch;
    changed = true;
    return ch === lower ? mapped : mapped.toUpperCase();
  }).join('');
  return changed ? out : null;
}

function bigrams(text) {
  const s = String(text).toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** Коэффициент Дайса по биграммам: 1 — точное совпадение, 0 — ничего общего. */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common += 1;
  return (2 * common) / (A.size + B.size);
}

function scoreOf(item, query) {
  return Math.max(
    similarity(query, titleOf(item)),
    similarity(query, item.original_title || item.original_name || ''),
  );
}

/** Сортировка по похожести на запрос, при равенстве — по популярности. */
export function rankResults(results, query) {
  return results
    .map((item) => ({ item, score: scoreOf(item, query) }))
    .sort((a, b) => (b.score - a.score) || ((b.item.popularity || 0) - (a.item.popularity || 0)))
    .map((x) => x.item);
}

// Похожесть, при которой считаем, что нашли то самое, и дальше не ищем.
const GOOD_ENOUGH = 0.55;

/**
 * Лестница попыток: исходный запрос, без года и пунктуации, без последнего слова,
 * по самому длинному слову, по префиксу, в другой раскладке. Останавливаемся, как только
 * верхний результат достаточно похож на запрос — обычно это первая же попытка (1 субзапрос),
 * в худшем случае тратим 4.
 */
export async function smartSearch(env, budget, rawQuery) {
  const original = String(rawQuery).trim();
  const normalized = normalizeQuery(original);
  const base = normalized || original;

  // ref — с чем сравнивать найденное. Для обрезанных запросов это полный запрос
  // пользователя, а для смены раскладки — уже исправленная строка: сравнивать
  // «Дюна» с исходным «L.yf» бессмысленно.
  const attempts = [];
  const add = (q, ref) => {
    if (q && q.length >= 2 && !attempts.some((x) => x.q === q)) attempts.push({ q, ref: ref || base });
  };

  add(original);
  add(normalized);
  // Не та раскладка — проверяем до всяких обрезаний: «L.yf» -> «Дюна».
  const swapped = swapLayout(original) || swapLayout(base);
  add(swapped, normalizeQuery(swapped || ''));

  const words = base.split(' ').filter(Boolean);
  if (words.length > 1) {
    // Опечатка чаще всего в конце: «Властелин колц» -> «Властелин».
    add(words.slice(0, -1).join(' '));
    // ...но может быть и в начале: «Гари Поттер» -> «Поттер».
    add(words.slice().sort((a, b) => b.length - a.length)[0]);
  }
  if (base.length >= 5) {
    // Префиксный поиск TMDB работает хорошо: «Дюнна» -> «Дюн».
    add(base.slice(0, Math.max(3, Math.ceil(base.length * 0.6))).trim());
  }

  let best = { results: [], score: -1, usedQuery: original, fuzzy: false };
  for (let i = 0; i < attempts.length; i += 1) {
    if (!budget.has(2)) break; // один субзапрос всегда оставляем на ответ пользователю
    const { q, ref } = attempts[i];
    const results = await searchMulti(env, budget, q);
    if (!results.length) continue;

    const ranked = rankResults(results, ref);
    const score = scoreOf(ranked[0], ref);
    if (score > best.score) {
      best = { results: ranked, score, usedQuery: q, fuzzy: i > 0 };
    }
    if (best.score >= GOOD_ENOUGH) break;
  }
  return best;
}
