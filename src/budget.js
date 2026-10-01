// Cloudflare Workers Free: не более 50 внешних fetch за одно выполнение
// (subrequests per invocation). Все исходящие запросы идут через этот счётчик,
// чтобы воркер сам останавливался, а не падал на 51-м запросе.

export const MAX_SUBREQUESTS = 50;

export class Budget {
  constructor(max = MAX_SUBREQUESTS, safety = 5) {
    this.left = Math.max(0, max - safety);
    this.used = 0;
  }

  get remaining() {
    return this.left;
  }

  has(n = 1) {
    return this.left >= n;
  }

  take(n = 1) {
    if (this.left < n) return false;
    this.left -= n;
    this.used += n;
    return true;
  }

  /** Выполнить fetch, если бюджет позволяет. Иначе вернуть null. */
  async fetch(url, init) {
    if (!this.take(1)) {
      console.warn('subrequest budget exhausted, skipping', String(url).slice(0, 120));
      return null;
    }
    return fetch(url, init);
  }
}
