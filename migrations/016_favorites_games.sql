-- В favorites стояла проверка media_type IN ('movie','tv'), и игра туда молча не добавлялась
-- (INSERT OR IGNORE глотает нарушение проверки). SQLite не умеет менять CHECK,
-- поэтому таблица пересоздаётся.
CREATE TABLE favorites_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv','game')),
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

INSERT INTO favorites_new (id, user_id, tmdb_id, media_type, title, created_at)
  SELECT id, user_id, tmdb_id, media_type, title, created_at FROM favorites;

DROP TABLE favorites;
ALTER TABLE favorites_new RENAME TO favorites;

CREATE UNIQUE INDEX IF NOT EXISTS favorites_unique
  ON favorites (user_id, tmdb_id, media_type);
