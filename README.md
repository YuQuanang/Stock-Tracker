# Kestrel (Folio)

A single-user, multi-currency (`SGD` / `USD`) portfolio tracker for US stocks & ETFs, SGX equities (`.SI`), UK UCITS ETFs (LSE `.L`), and crypto — built with Next.js 16, Drizzle ORM on Turso (libSQL / SQLite), and `decimal.js`.

---

## Core Features

### 1. Multi-Currency FIFO Ledger & Holdings (`/holdings`, `/holdings/[symbol]`, `/transactions`)
- **Exact Decimal FIFO Accounting:** Tracks open lots, realized closed trades, cost basis, brokerage fees, and stock splits (`corporate_action`) across multiple portfolios using `decimal.js` stored as exact decimal strings (zero floating-point drift).
- **Multi-Market & Multi-Asset Coverage:** Supports US equities/ETFs, SGX stocks/REITs (`.SI`), UK UCITS ETFs on LSE (`.L`), and cryptocurrencies with automatic ticker resolution, instrument names, and key statistics.
- **Dual-Currency Valuation (`SGD` & `USD`):** Stores native trade prices alongside historical `USD/SGD` exchange rates so every position, trade, and portfolio summary can be viewed in `SGD` or `USD`.
- **Direct Holding Edits & Portfolio Management:** Create, rename, reorder, or delete portfolios, set a default portfolio across views, and adjust current holding positions directly without manually entering offsetting transactions.
- **Sortable Holdings Table:** Click table column headers to cycle ascending, descending, or default ordering, with sort preferences remembered across visits.
- **Individual Instrument View (`/holdings/[symbol]`):** Interactive price history chart (`1D`–`MAX`), key fundamentals (52-week range, market cap, P/E, dividend yield, beta, volume, sector/industry), and 4 ledger tabs (**Open Lots**, **Closed Trades**, **Dividends Received**, **Transactions**).

### 2. Automatic After-Tax Dividend Tracking
- **Automatic Discovery & Sync:** Discovers historical and newly ex-dividend payouts from Yahoo Finance (`events=div`) based on exact split-adjusted FIFO shares held prior to each `exDate`.
- **Withholding Tax Handling:** Applies **0% tax** to SGX holdings (`.SI` / `SGD`) and **30% withholding tax** to US / `USD` holdings.
- **Return Attribution:** Net after-tax dividends flow automatically into **Dividends Received**, **Total Lifetime Return**, **Profit Summary**, and **XIRR** without inflating open market value or double-counting manual dividend entries.

### 3. Benchmark Comparison & Return Attribution (`/benchmarks`)
- **Total-Return Benchmarks (`SGD` / `USD`):** Compares portfolio performance against dividend-reinvested (`adj_close`) benchmark ETFs (`VOO`, `ES3.SI`, `ONEQ`, `DIA`, plus custom tickers via search) converted with daily `USD/SGD` rates.
- **Same Cash Flows & Period Returns:** Mirrors historical portfolio cash flows into each compared benchmark to contrast invested capital, ending value, dollar profit, and annualized `XIRR`, alongside Time-Weighted Returns (`TWR`) across `1D`, `1W`, `1M`, `3M`, `6M`, `YTD`, `1Y`, `3Y`, `5Y`, and `MAX`.
- **Profit Summary & Risk Metrics:** Breaks down realized P&L, unrealized P&L, after-tax dividends, brokerage fees, timing effect (`XIRR − TWR`), annualized volatility, Sharpe ratio, beta, correlation, and max drawdown.

### 4. Dashboard & Portfolio Analytics (`/dashboard`)
- **Net Worth & Cash Flow Timeline:** Interactive daily market value vs. net contributed capital chart with timeframe filters.
- **Allocation Breakdowns:** Interactive charts by **Instrument**, **Asset Class**, **Sector**, **Currency**, and **Region**.
- **Top Movers & Data Quality:** Daily and all-time gainers/losers plus automated ledger and market-data health checks.

### 5. Watchlist, Alerts & Paper Simulator (`/watchlist`)
- **Unified Search & Add Bar:** Filter existing watchlist items and discover/add new US, SGX, UK UCITS ETF, and crypto tickers directly from one search bar.
- **Live Tracking & Alerts:** Market-hours-aware batch quote polling, inline trend sparklines, 52-week range bars, gain since added (`price_when_added`), and configurable price alert thresholds.
- **Paper Position Simulator:** Simulates hypothetical "if I had bought it" entry dates and amounts compared against a benchmark.

### 6. Lossless CSV Import / Export & Backups (`/import-export`)
- **MSP CSV Round-Trip:** Lossless import and export of My Stocks Portfolio (MSP) CSV files with duplicate handling (`skip`, `replace`, `append`), clean CSV export, and atomic import undo.
- **Full JSON Backups:** One-click full database backup export.

### 7. Authentication & Security (`/login`)
- **Single-User Password Gate:** Scrypt password hashing (`APP_PASSWORD_HASH`) and signed `HttpOnly` session cookies (`SESSION_SECRET`).
- **Database-Backed Rate Limiting:** Tracks failed login attempts in `login_attempt` (per-IP and global 15-minute windows) so limits hold across serverless instances.

---

## Tech Stack

- **Framework:** Next.js 16 (App Router, React 19, TypeScript)
- **Database:** Drizzle ORM with **Turso (`@libsql/client` / SQLite)** in production and local embedded SQLite (`.data/kestrel.db`) fallback for development
- **Financial Math & Validation:** `decimal.js`, Zod
- **Charts & UI:** TradingView Lightweight Charts, Tailwind CSS v4, Framer Motion
- **Testing:** Vitest (23 suites / 127 tests using isolated in-memory libSQL/SQLite migrations)

---

## Quick Start

### 1. Install dependencies & configure environment

```bash
npm install
cp .env.example .env.local
```

Generate a password hash and session secret:

```bash
npm run hash-password
openssl rand -base64 48
```

Fill in `.env.local` (leave `TURSO_DATABASE_URL` empty to use a local SQLite file at `.data/kestrel.db`, or point it to your hosted Turso database).

### 2. Apply database migrations & run

```bash
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `TURSO_DATABASE_URL` | Production | Turso libSQL URL (`libsql://<db>-<org>.turso.io`). Leave empty in local dev to use `.data/kestrel.db`. |
| `TURSO_AUTH_TOKEN` | Production | Turso database auth token (required for remote `libsql://` / `https://` / `wss://` URLs). |
| `APP_PASSWORD_HASH` | Yes* | Scrypt password hash generated via `npm run hash-password` (recommended for production). |
| `APP_PASSWORD` | Dev only* | Plain-text local password alternative (ignored if `APP_PASSWORD_HASH` is set). |
| `SESSION_SECRET` | Production | Random signing secret (at least 32 characters) for session cookies. |
| `FINNHUB_API_KEY` | Optional | Free Finnhub API key used as a fallback US quote provider. |

*\*Provide either `APP_PASSWORD_HASH` or `APP_PASSWORD`.*

---

## Deploying to Vercel

1. Create a Turso database and run `npm run db:migrate` against it (with `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` configured).
2. In **Vercel → Project Settings → Environment Variables**, add:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `APP_PASSWORD_HASH`
   - `SESSION_SECRET`
   - `FINNHUB_API_KEY` *(optional)*
3. Deploy — `next.config.ts` keeps `@libsql/client` external in `serverExternalPackages` and sets strict security headers automatically.

---

## Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production bundle |
| `npm run start` | Start the production server |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Run ESLint across the repository |
| `npm test` | Run the Vitest unit & integration test suite |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run db:generate` | Generate Drizzle SQLite migrations into `db/migrations-sqlite/` |
| `npm run db:migrate` | Apply migrations from `db/migrations-sqlite/` to Turso or `.data/kestrel.db` |
| `npm run hash-password` | Generate a scrypt `APP_PASSWORD_HASH` for authentication |

---

## Directory Layout

- `app/(app)/` — Authenticated pages (`dashboard`, `holdings`, `holdings/[symbol]`, `transactions`, `watchlist`, `benchmarks`, `import-export`, `settings`)
- `app/login/` & `app/api/` — Password-gate login page and REST API routes (`analytics`, `auth`, `corporate-actions`, `holdings`, `import-export`, `instruments`, `market`, `portfolios`, `quotes`, `settings`, `transactions`, `watchlists`)
- `components/` — Feature views, Lightweight Charts components, dialogs/sheets, and navigation shell (`Sidebar`, `TabBar`, `CommandPalette`)
- `db/` — Drizzle SQLite schema (`db/schema.ts`), Turso/libSQL client (`db/client.ts`), migration runner (`db/migrate.ts`), and SQLite migrations (`db/migrations-sqlite/`)
- `lib/finance/` — Pure `decimal.js` financial engine (`fifo.ts`, `twr.ts`, `xirr.ts`, `timeline.ts`, `drawdown.ts`, `risk-metrics.ts`)
- `lib/market-data/` — Yahoo Finance, SGX, LSE/UK UCITS, and crypto quote/history/dividend providers, Frankfurter `USD/SGD` FX service, market-hours gating, and TTL caches
- `lib/services/` — Server services (`analytics`, `csv-import-export`, `dividends`, `fx-sgd`, `holdings`, `ledger`, `settings`, `symbol-ledgers`, `watchlist`)
- `tests/` — Vitest unit and integration test suite
