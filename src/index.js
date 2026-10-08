import { Budget } from './budget.js';
import { handleUpdate } from './commands.js';
import {
  refreshDates, sendReminders, sendPeriodDigests, localClock,
} from './cron.js';
import { refreshCatalog } from './catalog.js';
import { appPage, handleApi } from './webapp.js';

export default {
  /** Вебхук Telegram. */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Mini App: сама страница и её API. Подпись initData проверяется внутри.
    if (request.method === 'GET' && url.pathname === '/app') return appPage();
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const budget = new Budget();
      return handleApi(request, env, budget, url.pathname.slice(5));
    }

    if (request.method === 'GET') {
      return new Response('release-radar-bot is up', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    // Telegram присылает секрет в заголовке (задаётся при setWebhook).
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      console.warn('webhook: bad secret token', url.pathname);
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    // Отвечаем Telegram сразу, обработку доделываем в фоне — иначе он начнёт ретраить.
    const budget = new Budget();
    ctx.waitUntil(
      handleUpdate(env, budget, update).catch((err) => {
        console.error('handleUpdate failed', err?.stack || err);
      }),
    );
    return new Response('ok');
  },

  /** Крон. Два расписания в одном воркере, различаем по event.cron. */
  async scheduled(event, env, ctx) {
    const budget = new Budget();
    const cron = event.cron;

    const job = (async () => {
      if (cron === (env.WEEK_CRON || '0 6 * * 1')) {
        await sendPeriodDigests(env, budget, 'week');
        return;
      }
      if (cron === (env.WEEKEND_CRON || '0 6 * * 6')) {
        await sendPeriodDigests(env, budget, 'weekend');
        return;
      }
      if (cron === (env.CATALOG_CRON || '7,37 * * * *')) {
        // Витрина ближайших релизов: обход discover и дозагрузка деталей батчами.
        await refreshCatalog(env, budget);
        return;
      }

      await refreshDates(env, budget);

      const clock = localClock(env);
      // Напоминания — только днём. Крон ходит каждые четыре часа, и ночной запуск
      // присылал «выходит сегодня» в три ночи по Москве.
      if (clock.hour >= 9 && clock.hour < 23) await sendReminders(env, budget);

      // Дожимаем подборки тем, кому утренний запуск не успел отправить.
      // Не раньше 9 утра — чтобы не прислать «неделю» ночью.
      if (clock.hour >= 9 && budget.remaining >= 6) {
        if (clock.weekday === 'Mon') await sendPeriodDigests(env, budget, 'week', 5);
        if (clock.weekday === 'Sat') await sendPeriodDigests(env, budget, 'weekend', 5);
      }
    })();

    ctx.waitUntil(
      job.catch((err) => {
        console.error('scheduled failed', err?.stack || err);
      }),
    );
  },
};
