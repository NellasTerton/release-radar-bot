-- «Вышло за неделю» и переключатель «Все серии».
ALTER TABLE catalog ADD COLUMN episode_code TEXT;   -- S02E09 ближайшей серии у любого сериала
ALTER TABLE catalog ADD COLUMN recent_date TEXT;    -- что вышло за последние 7 дней
ALTER TABLE catalog ADD COLUMN recent_label TEXT;   -- «вышел 3 сезон целиком · 8 серий»
ALTER TABLE catalog ADD COLUMN recent_kind TEXT;    -- movie | premiere | drop | episode
CREATE INDEX IF NOT EXISTS catalog_recent ON catalog (recent_date);
