-- Описание и актёры для избранного: в мини-аппе список без них выглядит голым.
ALTER TABLE release_dates ADD COLUMN overview TEXT;
ALTER TABLE release_dates ADD COLUMN actors TEXT;
