-- Постер нужен мини-аппу: список с обложками читается совсем иначе, чем текстом.
ALTER TABLE release_dates ADD COLUMN poster_path TEXT;
