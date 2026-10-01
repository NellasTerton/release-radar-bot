-- Статус сериала из TMDB (Ended / Canceled / Returning Series).
-- Нужен, чтобы в списке было видно «сериал завершён», а крон не проверял
-- законченные шоу так же часто, как идущие. Удалять их мы не удаляем:
-- если объявят новый сезон, next_episode_to_air появится сам.
ALTER TABLE release_dates ADD COLUMN status TEXT;
