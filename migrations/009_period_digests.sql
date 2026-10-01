-- Подборки по избранному: понедельник — неделя, суббота — выходные.
-- Дата последней отправки нужна, чтобы 4-часовой крон дожимал тех, кому
-- утренний запуск не успел отправить (лимит субзапросов), и не слал дважды.
ALTER TABLE users ADD COLUMN week_digest_on TEXT;
ALTER TABLE users ADD COLUMN weekend_digest_on TEXT;
