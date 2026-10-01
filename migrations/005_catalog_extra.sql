-- Тип релиза (прокат/цифра) и внешние рейтинги прямо в витрине,
-- плюс флаг «текст читаем» против арабицы и иероглифов в актёрах и описании:
-- RTL-символы ещё и переключают направление абзаца, ломая вёрстку поста.
ALTER TABLE catalog ADD COLUMN release_kind TEXT;
ALTER TABLE catalog ADD COLUMN digital_date TEXT;
ALTER TABLE catalog ADD COLUMN imdb_id TEXT;
ALTER TABLE catalog ADD COLUMN imdb_rating REAL;
ALTER TABLE catalog ADD COLUMN rt_critics INTEGER;
ALTER TABLE catalog ADD COLUMN rated_at TEXT;
ALTER TABLE catalog ADD COLUMN readable INTEGER DEFAULT 1;
