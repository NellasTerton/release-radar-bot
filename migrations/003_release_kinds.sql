-- Раздельные даты кинопроката и цифры: в «Моё ожидание» нужно показывать обе.
ALTER TABLE release_dates ADD COLUMN theatrical_date TEXT;
ALTER TABLE release_dates ADD COLUMN digital_date TEXT;

-- Кеш внешних рейтингов (OMDb): IMDb — это оценка зрителей, RT — критиков.
CREATE TABLE IF NOT EXISTS title_meta (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  imdb_id TEXT,
  imdb_rating REAL,
  imdb_votes INTEGER,
  rt_critics INTEGER,
  checked_at TEXT,
  PRIMARY KEY (tmdb_id, media_type)
);

ALTER TABLE users ADD COLUMN last_post_ids TEXT;
