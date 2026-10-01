-- Кинопоиск: оценка русскоязычного зрителя и счётчик «Ждут» — сигнал интереса
-- к будущему релизу, которого нет у TMDB (у российских премьер там 0 голосов).
ALTER TABLE catalog ADD COLUMN is_russian INTEGER;     -- российское производство или язык
ALTER TABLE catalog ADD COLUMN kp_rating REAL;
ALTER TABLE catalog ADD COLUMN kp_votes INTEGER;
ALTER TABLE catalog ADD COLUMN kp_await INTEGER;       -- «Ждут» на Кинопоиске
ALTER TABLE catalog ADD COLUMN kp_checked_at TEXT;

ALTER TABLE title_meta ADD COLUMN kp_rating REAL;
ALTER TABLE title_meta ADD COLUMN kp_votes INTEGER;

-- Постоянная настройка пользователя: не показывать российские фильмы и сериалы.
ALTER TABLE users ADD COLUMN hide_russian INTEGER DEFAULT 0;
