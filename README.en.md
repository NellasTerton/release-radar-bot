# Release Radar

[Русский](README.md) | **English**

A Telegram Mini App that tracks release dates for films, series and games and reminds you on the day. The whole backend is a single Cloudflare Worker plus a D1 database, entirely on the free tier.

Bot: [@Your_Release_Radar_Bot](https://t.me/Your_Release_Radar_Bot)

## Features

* **A Mini App instead of chat commands.** Three tabs — Upcoming, Just released, Watchlist. Filters by type, genre (10 groups) and country (9 groups), search, and a title page with posters, cast, ratings and stills. Theme and safe areas come from Telegram.
* **Reminders in chat.** A poster message on release day, a "did you watch it?" nudge three days later, and digests every Monday and Saturday with what's coming this week and this weekend.
* **Four sources, one shelf.** TMDB and OMDb for worldwide titles, Kinopoisk for Russian ones (TMDB barely covers them), IGDB for games. Games are off by default.
* **Ratings** from IMDb, 🍅 Rotten Tomatoes and Kinopoisk, shown as badges in each service's own colours.

## How it works

```
Telegram ──webhook──►  Worker.fetch()     ──►  D1
                       Worker.scheduled() ──►  D1  ──►  TMDB / OMDb / Kinopoisk / IGDB
Mini App ──/api/*───►  Worker.fetch()     ──►  D1
```

* **One Worker, two entry points.** `fetch()` serves the Telegram webhook and the Mini App API; `scheduled()` runs four Cron Triggers.
* **The shelf is built ahead of time.** A Worker is capped at 50 subrequests per invocation, so lists are never assembled on demand: a cron job tops up a catalog table in D1 every half hour, and the app reads only that, answering with zero external calls. A `Budget` class counts subrequests and stops short of the cap; whatever is left over moves to the next run.
* **User verification.** Telegram `initData` is verified with HMAC-SHA256 through WebCrypto inside the Worker.
* **No build step, no runtime dependencies.** ES modules, vanilla JS in the Mini App, SQL migrations.

**Stack:** Cloudflare Workers, D1 (SQLite), Cron Triggers, Telegram Bot API and Mini Apps, TMDB, OMDb, Kinopoisk, IGDB (OAuth via Twitch), Wrangler.

## Problems worth solving

* **A release date is not a single number.** A film has many: theatrical, digital, festival, one per country. The bot follows the worldwide premiere — otherwise a film already a week into its run would show up as "out tomorrow". Re-releases of old films are dropped, and a season dumped all at once is detected for series.
* **A premiere has no rating to judge it by.** An unreleased series has zero votes and low popularity, which makes it indistinguishable from a home video. The platform became the signal instead: a premiere on Netflix, Disney+ or HBO gets through without any votes.
* **Game dates are often vague.** IGDB marks the precision: day, month, quarter or year. The bot writes "Q3 2026" rather than inventing a day, and lists per-platform dates when they differ.
* **Noise in the feed.** TMDB ranks by worldwide popularity, so the first pages fill up with daily soaps. Discovery is split by language and by week, and a title only reaches the shelf if it has a synopsis, a cast and some sign that anyone cares.

Detailed engineering notes (in Russian): [docs/notes.md](docs/notes.md).

## Running it

```bash
npm install
npx wrangler d1 create release_radar          # put the id into wrangler.toml
npx wrangler d1 execute release_radar --remote --file schema.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN    # and the rest of the keys
npx wrangler deploy
```

Keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TMDB_READ_TOKEN`, `OMDB_API_KEY`, `KINOPOISK_API_KEY`, `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`. Everything past the first three is optional — a missing key only disables its own source.
