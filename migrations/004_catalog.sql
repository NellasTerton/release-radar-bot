-- Витрина ближайших релизов больше не собирается на лету.
-- Премьеры сезонов рассыпаны по десяткам страниц discover, и узнать дату серии
-- можно только запросив детали шоу — за один вебхук столько не успеть.
-- Поэтому крон наполняет каталог, а лента читает готовое из D1.
CREATE TABLE IF NOT EXISTS catalog (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  title TEXT,
  poster_path TEXT,
  overview TEXT,
  actors TEXT,               -- два-три имени через запятую
  genres TEXT,               -- названия жанров через запятую
  release_date TEXT,         -- дата, по которой тайтл попадает в ленту
  episode_label TEXT,        -- «премьера 24 сезона» для сериалов
  is_premiere INTEGER DEFAULT 1,
  popularity REAL,
  vote_average REAL,
  vote_count INTEGER,
  checked_at TEXT,           -- NULL = знаем только id, детали ещё не тянули
  PRIMARY KEY (tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS catalog_release ON catalog (release_date);
CREATE INDEX IF NOT EXISTS catalog_stale ON catalog (checked_at);
