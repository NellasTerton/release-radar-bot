-- Признак «фильм локализован в России»: русское название есть только у того,
-- что здесь прокатывают или хотя бы переводят. Отсекает инди и видео-премьеры,
-- которые TMDB считает выходящими, но о которых тут никто не услышит.
ALTER TABLE catalog ADD COLUMN localized INTEGER;
-- Для поиска рейтинга по названию, когда у TMDB нет IMDb-идентификатора.
ALTER TABLE catalog ADD COLUMN original_title TEXT;
ALTER TABLE catalog ADD COLUMN first_year TEXT;
