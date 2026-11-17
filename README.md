# Kestrel (Folio)

A multi-currency (`SGD` / `USD`) stock and ETF portfolio tracker built with Next.js 16, Drizzle ORM (Neon PostgreSQL & PGlite), and `decimal.js`.

---

## Core Features

### 1. Multi-Currency FIFO Ledger & Holdings
- **Exact Decimal FIFO Accounting:** Tracks open lots, realized closed trades, cost basis, brokerage fees, and stock splits (`corporate_action`) across multiple portfolios using `decimal.js`.
- **Dual-Currency (`SGD` & `USD`):** Stores native execution prices alongside historical `USD/SGD` exchange rates so every position, trade, and portfolio summary can be viewed in either `SGD` or `USD`.
- **Individual Stock Breakdown (`/holdings/[symbol]`):** Interactive price chart, live fundamentals, and 4 position tabs: **Open Lots**, **Closed Trades**, **Dividends Received**, and **Transactions**.

### 2. Automatic After-Tax Dividend Tracking
- **Automatic Discovery & Sync:** Discovers historical and newly ex-dividend payouts from Yahoo Finance (`events=div`) based on exact split-adjusted FIFO shares held at the close prior to each `exDate`.
- **Automatic Withholding Tax:** Applies **0% tax** to SGX holdings (`.SI` / `SGD`) and **30% withholding tax** to US / `USD` holdings (including ADRs like `TCEHY`).
- **Accurate Return Attribution:** Net after-tax dividends flow automatically into **Dividends Received**, **Total Lifetime Return**, **Profit Summary**, and **XIRR** without inflating open share **Market Value** or double-counting against manual dividend entries.

### 3. Fair Benchmark Comparison & Return Attribution (`/benchmarks`)
- **Total-Return Benchmark ETFs (`SGD`):** Compares portfolio performance against dividend-reinvested (`adj_close`) benchmark funds converted to `SGD` using daily `USD/SGD` rates:
  - **S&P 500:** `VOO`
  - **STI:** `ES3.SI`
  - **NASDAQ Composite:** `ONEQ`
  - **Dow Jones:** `DIA`
  - Plus any custom ETF or stock ticker via search.
- **Same Cash Flows Simulation:** Mirrors every historical buy and sell (`SGD` amount) into the selected focus fund (capping simulated sells at available shares so positions never go negative) and compares total money put in, money taken out, current value, dollar profit, and annualized `XIRR` side by side.
- **Profit Summary & Timing Effect:**
  - **Profit Summary:** Breaks down dollar profit into realized profit, unrealized profit, after-tax dividends, and brokerage fees alongside annualized `XIRR`.
  - **Timing Effect (`XIRR − TWR`):** Measures whether deposit/withdrawal timing helped or hurt annualized returns, compared directly against the same-cash-flows benchmark simulation.
  - **Money Invested Chart:** Plots cumulative net capital invested (`SGD`) with buy and sell markers beneath the portfolio value curve.
- **Period Returns (`TWR`) & Risk Metrics:** Compares Time-Weighted Returns across `1D`, `1W`, `1M`, `3M`, `6M`, `YTD`, `1Y`, `3Y`, `5Y`, and `ALL`, plus annualized volatility, Sharpe/Sortino ratios, beta, correlation, and max drawdown.

### 4. Dashboard & Portfolio Analytics (`/`)
- **Net Worth & Cash Flow Timeline:** Interactive daily market value vs. net contributed capital chart with range selectors (`1M`, `3M`, `6M`, `YTD`, `1Y`, `ALL`).
- **Allocation Breakdowns:** Interactive allocation rings by **Instrument**, **Asset Class**, **Sector**, **Currency**, and **Region** (`US` vs. `SG`).
- **Top Movers & Data Quality:** Daily gainers/losers and automated ledger/market data health checks.

### 5. Watchlist, Alerts & Paper Simulator (`/watchlist`)
- **Multi-Watchlist Tracking:** Live batch quote polling (respecting US and SGX trading hours), 52-week range bars, and inline trend sparklines.
- **Gain Since Added & Paper Simulator:** Tracks performance from `priceWhenAdded` and simulates hypothetical position sizing against benchmarks.
- **Price Alerts:** Configurable target price and daily % move alerts.

### 6. Lossless CSV Import / Export & Backups (`/import-export`)
- **MSP CSV Round-Trip:** Lossless import and export of My Stocks Portfolio (MSP) CSV files with duplicate detection (`skip`, `replace`, `append`) and atomic import undo.
- **Full JSON Backups:** One-click full ledger JSON export and restore.

---

## Tech Stack

- **Framework:** Next.js 16 (App Router, React 19, TypeScript)
- **Database:** Drizzle ORM with Neon PostgreSQL (`ap-southeast-1`) and local embedded `PGlite` fallback
- **Financial Math & Validation:** `decimal.js`, Zod
- **Charts & UI:** TradingView Lightweight Charts, Tailwind CSS v4, Framer Motion
- **Testing:** Vitest (unit & integration suite with in-memory `PGlite` migrations)

---

## Quick Start

```bash
npm install
npm run dev
```

### Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production bundle |
| `npm run start` | Start the production server |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Run ESLint across the repository |
| `npm test` | Run the Vitest test suite |
| `npm run db:generate` | Generate Drizzle SQL migrations |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run hash-password` | Generate a password hash for `.env.local` authentication |

---

## Directory Layout

- `app/` — Next.js App Router pages (`dashboard`, `holdings`, `holdings/[symbol]`, `transactions`, `watchlist`, `benchmarks`, `import-export`, `settings`, `login`) and API routes (`app/api/*`)
- `components/` — Feature views, Lightweight Charts components, dialogs/sheets, and responsive navigation shell (`Sidebar`, `TabBar`, `CommandPalette`)
- `db/` — Drizzle schema (`db/schema.ts`), SQL migrations (`db/migrations/`), and database client (`db/client.ts`)
- `lib/finance/` — Pure `decimal.js` financial engine (`fifo.ts`, `twr.ts`, `xirr.ts`, `timeline.ts`, `drawdown.ts`, `risk-metrics.ts`)
- `lib/market-data/` — Yahoo Finance & SGX quote/history/dividend providers, Frankfurter `USD/SGD` FX service, market-hours gating, and TTL caches
- `lib/services/` — Server services for `holdings`, `analytics`, `dividends`, `ledger`, `fx-sgd`, `watchlist`, `csv-import-export`, and `settings`
- `tests/` — Vitest unit and integration test suite
