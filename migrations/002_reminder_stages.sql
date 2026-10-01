-- Многоступенчатые напоминания: одно и то же событие теперь шлётся несколько раз
-- (за 3 дня, за сутки, в день выхода, через 3 дня), поэтому stage входит в ключ.

CREATE TABLE IF NOT EXISTS notifications_log_v2 (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  release_date TEXT NOT NULL,
  stage TEXT NOT NULL,          -- d3 | d1 | d0 | a3
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type, release_date, stage)
);

INSERT OR IGNORE INTO notifications_log_v2 (user_id, tmdb_id, media_type, release_date, stage, sent_at)
  SELECT user_id, tmdb_id, media_type, release_date, 'd0', sent_at FROM notifications_log;

DROP TABLE notifications_log;
ALTER TABLE notifications_log_v2 RENAME TO notifications_log;

-- Ответ на вопрос «вы посмотрели?» через 3 дня после выхода.
CREATE TABLE IF NOT EXISTS reactions (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  release_date TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('liked','disliked','skipped')),
  reacted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type, release_date)
);
