# Folio

A personal stock and portfolio tracker for a single investor (US + SGX stocks, ETFs, indices; USD and SGD). Single-user password gate, Postgres storage, free to host on Vercel.

> **Not financial advice.** Market data comes from free, sometimes unofficial sources and may be delayed or unavailable. Always verify against your broker.

**Start here: [SETUP.md](./SETUP.md)** for local setup, creating the free database, Vercel environment variables, migrations and deployment.

## Status

| Milestone | State |
|---|---|
| 1. Foundation (scaffold, tokens, password gate, schema, theming, app shell) | Done |
| 2. Ledger and finance core | Done |
| 3. CSV import/export (original MSP format, round trip) | Next |
| 4. Market data layer (Yahoo, Finnhub/Stooq, Frankfurter; short polling) | |
| 5. Holdings and stock detail | |
| 6. Watchlist and paper positions | |
| 7. Analytics and benchmarks | |
| 8. Polish, accessibility, PWA, final README | |

## Architecture notes

- **Next.js 16 (App Router), TypeScript strict, Tailwind v4.** In Next 16 `middleware` was renamed to `proxy`; see `proxy.ts`.
- **Auth:** one password (scrypt hash in `APP_PASSWORD_HASH`), signed httpOnly session cookie, DB-backed login rate limiting, same-origin check on all state-changing requests. `proxy.ts` blocks everything unauthenticated, and API handlers call `requireSession()` as a second layer.
- **Database:** Drizzle ORM. PGlite locally, Postgres via `DATABASE_URL` in production. Server-only. No `user_id` anywhere (single user).
- **Live prices:** short polling from the browser to our own API (planned, Milestone 4). No long-lived connections, so it fits Vercel's free plan.
- **Data sources (planned):** Yahoo Finance, then Finnhub/Stooq for equities, SGX and indices; Frankfurter for USD/SGD. No crypto price fetching: crypto rows in the CSV are kept for lossless round-tripping and use manual prices.

## Layout

```
app/            routes: (app)/dashboard, holdings, watchlist, benchmarks, transactions,
                import-export, settings, more; login; api/auth
components/     app-shell (sidebar, tab bar, command palette), ui primitives
db/             schema.ts, client.ts, migrate.ts, migrations/
lib/auth/       password, session, rate-limit, guard
lib/            env.ts, motion.ts, theme.ts, attribution.ts
proxy.ts        authentication + CSRF front door
tests/          unit/, fixtures/MSP-Portfolios-2026-11-07.csv
```
