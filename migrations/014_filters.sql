-- Фильтры пользователя: жанры и страны.
-- genre_keys — жанры, сведённые к десяти понятным кнопкам (TMDB называет жанры сериалов
-- иначе, чем у фильмов, а Кинопоиск — по-своему).
-- country_group — страна производства группой: us, gb, eu, ru, kr_jp, in, cn, tr, latam, other.
-- extra — тайтл собран только ради фильтра по стране (индийское, китайское, турецкое):
-- по умолчанию такие не показываются нигде.
ALTER TABLE catalog ADD COLUMN genre_keys TEXT;
ALTER TABLE catalog ADD COLUMN country_group TEXT;
ALTER TABLE catalog ADD COLUMN extra INTEGER NOT NULL DEFAULT 0;

-- Выбор пользователя: списки через запятую, пусто — «всё».
ALTER TABLE users ADD COLUMN filter_genres TEXT;
ALTER TABLE users ADD COLUMN filter_countries TEXT;

CREATE INDEX IF NOT EXISTS idx_catalog_country ON catalog (country_group);
