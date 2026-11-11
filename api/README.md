# noumen-api

Phase 1: Postgres schema + migrations. Legacy `../server.py` is untouched.

## Run

1. Postgres, one of:
   - Docker: `docker compose up -d`
   - Termux: `pkg install postgresql`, then create user/db `noumen` and match `.env`
   - Hosted (Neon, Railway): put its URL in `.env` (keep `?sslmode=require`)
2. `cp .env.example .env`
3. `npm install`
4. `npm run migrate`

Migrations live in `db/migrations/NNNN_name.sql`, apply in order, run once each
(tracked in `schema_migrations`). Forward-only: fix mistakes with a new file.
