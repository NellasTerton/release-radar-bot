-- Release Radar Bot - схема D1
-- Идемпотентна: можно накатывать повторно.

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  genre_prefs TEXT,               -- слаги жанров через запятую (см. src/genres.js)
  digest_sent_at TEXT,            -- когда последний раз уходила еженедельная подборка
  last_post_ids TEXT,             -- id сообщений текущей ленты «Скоро выходит»
  week_digest_on TEXT,            -- когда ушла понедельничная подборка по избранному
  weekend_digest_on TEXT,         -- когда ушла субботняя подборка
  hide_russian INTEGER DEFAULT 0, -- не показывать российские фильмы и сериалы
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv','game')),
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

-- один тайтл на пользователя (нужно для INSERT OR IGNORE при повторном нажатии кнопки)
CREATE UNIQUE INDEX IF NOT EXISTS favorites_unique
  ON favorites (user_id, tmdb_id, media_type);

CREATE TABLE IF NOT EXISTS release_dates (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  region TEXT,
  release_type TEXT,              -- Digital / Theatrical / S03E07 и т.п.
  release_date TEXT,              -- ближайшая значимая дата (для сортировки и напоминаний)
  theatrical_date TEXT,           -- отдельно прокат
  digital_date TEXT,              -- отдельно цифра
  status TEXT,                    -- статус сериала: Ended / Canceled / Returning Series
  poster_path TEXT,               -- обложка для мини-аппа
  overview TEXT,                  -- синопсис
  actors TEXT,                    -- пара имён
  last_checked_at TEXT,           -- ключевое поле для батчинга крона (NULL = ни разу не проверяли)
  PRIMARY KEY (tmdb_id, media_type)
);

-- Кеш внешних рейтингов (OMDb): IMDb — оценка зрителей, RT — критиков.
CREATE TABLE IF NOT EXISTS title_meta (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  imdb_id TEXT,
  imdb_rating REAL,
  imdb_votes INTEGER,
  rt_critics INTEGER,
  kp_rating REAL,
  kp_votes INTEGER,
  checked_at TEXT,
  PRIMARY KEY (tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS release_dates_checked
  ON release_dates (last_checked_at);

-- media_type, release_date и stage входят в ключ:
--   * id фильмов и сериалов в TMDB пересекаются (есть и movie 1399, и tv 1399);
--   * для сериала уведомление нужно на каждый новый эпизод, а не один раз навсегда;
--   * про одно событие пишем несколько раз: за 3 дня, за сутки, в день выхода и через 3 дня.
CREATE TABLE IF NOT EXISTS notifications_log (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  release_date TEXT NOT NULL,
  stage TEXT NOT NULL,          -- d3 | d1 | d0 | a3
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type, release_date, stage)
);

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

CREATE TABLE IF NOT EXISTS digest_decisions (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('added','hidden')),
  decided_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type)   -- чтобы не показывать повторно в след. подборке
);

-- Кинопоиск — второй источник каталога для российского: у таких записей tmdb_id
-- отрицательный (= -id Кинопоиска).
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
  release_kind TEXT,         -- «В кино» / «Цифра» для фильмов
  digital_date TEXT,         -- когда выйдет в цифре, если известно
  imdb_id TEXT,
  imdb_rating REAL,
  rt_critics INTEGER,
  rated_at TEXT,
  readable INTEGER DEFAULT 1, -- 0 = описание или актёры не на латинице/кириллице
  episode_code TEXT,         -- S02E09 ближайшей серии у любого сериала
  recent_date TEXT,          -- что вышло за последние 7 дней
  recent_label TEXT,         -- «вышел 3 сезон целиком · 8 серий»
  recent_kind TEXT,          -- movie | premiere | drop | episode
  localized INTEGER,         -- 1 = есть русское название (фильм тут переводят)
  original_title TEXT,       -- для поиска рейтинга по названию
  first_year TEXT,
  is_russian INTEGER,        -- российское производство или язык
  kp_rating REAL,            -- Кинопоиск
  kp_votes INTEGER,
  kp_await INTEGER,          -- «Ждут» на Кинопоиске
  kp_checked_at TEXT,
  dup_of_kp INTEGER,         -- 1 = этот тайтл TMDB уже пришёл из Кинопоиска, показываем версию оттуда
  is_premiere INTEGER DEFAULT 1,
  popularity REAL,
  vote_average REAL,
  vote_count INTEGER,
  checked_at TEXT,           -- NULL = знаем только id, детали ещё не тянули
  PRIMARY KEY (tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS catalog_release ON catalog (release_date);
CREATE INDEX IF NOT EXISTS catalog_stale ON catalog (checked_at);
CREATE INDEX IF NOT EXISTS catalog_recent ON catalog (recent_date);
