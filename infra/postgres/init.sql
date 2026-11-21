-- Runs once, when the compose Postgres volume is first created.
-- voicebot (POSTGRES_DB) is created by the image; add the test database.
-- The vector extension is created by `pnpm db:migrate` / tests/setup.ts.
CREATE DATABASE voicebot_test;
