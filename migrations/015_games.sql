-- Игры из IGDB (база Twitch). Хранятся в том же каталоге с media_type = 'game',
-- tmdb_id — это id игры в IGDB.
-- platforms — «PS5 · Xbox · PC», date_note — подпись, когда точного дня ещё нет
-- («в декабре 2026», «в 2027»).
ALTER TABLE catalog ADD COLUMN platforms TEXT;
ALTER TABLE catalog ADD COLUMN date_note TEXT;

-- Игры выключены, пока пользователь сам их не включит.
ALTER TABLE users ADD COLUMN show_games INTEGER NOT NULL DEFAULT 0;

-- Токен IGDB живёт около двух месяцев: держим его здесь, чтобы не просить каждый раз.
CREATE TABLE IF NOT EXISTS service_tokens (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
