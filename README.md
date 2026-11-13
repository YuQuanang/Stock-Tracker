# Folio

A personal stock and crypto portfolio tracker with multi-currency (`USD` / `SGD`) accounting, live quote polling, benchmark comparison, CSV import/export, and PWA installability.

## Tech Stack

- **Framework:** Next.js 16 (App Router, React 19, TypeScript)
- **Styling & Motion:** Tailwind CSS v4, Framer Motion (`MotionConfig reducedMotion="user"`)
- **Charts:** TradingView Lightweight Charts + responsive SVG sparklines & allocation rings
- **Database:** Drizzle ORM with local `PGlite` (embedded Postgres) or external PostgreSQL
- **Validation & Math:** Zod, `decimal.js`
- **Testing:** Vitest

## Quick Start

```bash
npm install
npm run dev
```

Available scripts:

- `npm run dev` — Start the Next.js development server
- `npm run build` — Build the production bundle
- `npm run start` — Start the production server
- `npm run lint` — Run ESLint across the repository
- `npm run typecheck` — Run TypeScript type checking (`tsc --noEmit`)
- `npm test` — Run the Vitest test suite
- `npm run db:generate` / `npm run db:migrate` — Generate or apply Drizzle migrations
- `npm run hash-password` — Generate a password hash for `.env.local` authentication config

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Design tokens, Apple HIG shell (`Sidebar`, `TabBar`, `CommandPalette`), DB schema, auth & session proxy | Done |
| 2. Ledger & CSV Engine | FIFO lots, corporate actions (splits/dividends), XIRR, TWR, drawdown, MSP CSV import/export | Done |
| 3. Live Market Data | Multi-provider quote/history/FX chain, market-hours gating, batch polling & caching | Done |
| 4. Transactions & Cash | Portfolio/transaction CRUD, transaction entry & edit sheets, corporate actions manager, currency toggle | Done |
| 5. Dashboard & Holdings | Net worth & cash flow charts, asset allocation donut, Equal-scale TWR/XIRR cards, holdings & stock detail pages | Done |
| 6. Watchlist & Alerts | Multiple watchlists, live quote polling, inline trend sparklines, price alert rules & simulation sheet | Done |
| 7. Analytics & Benchmarks | Portfolio vs. S&P 500 / NASDAQ / STI TWR & cashflow benchmark comparison, risk metrics, settings & attribution | Done |
| 8. Polish, A11y & PWA | Snappy Apple-grade motion tuning, keyboard & ARIA polish, `manifest.webmanifest`, generated app icons & safe static SW | Done |

## Architecture & PWA Notes

- **Security & Proxy (`proxy.ts`):** Protects application and `/api/*` routes while permitting unauthenticated access to `/login`, `/_next/static`, `manifest.webmanifest`, `/sw.js`, `/icon/*`, `/icons/*`, and `/apple-icon`.
- **Service Worker (`public/sw.js`):** Registered in production via `components/providers.tsx`. Caches only static immutable bundle chunks (`/_next/static/`) and app icon assets (`/icons/`, `/icon/`, `/apple-icon`)—authenticated HTML documents, RSC payloads, and `/api/*` responses always go straight to the network.
- **Accessibility:** Supports system light/dark themes, `prefers-reduced-motion`, skip-to-content navigation, distinct navigation landmarks, and full keyboard navigation (including `⌘K` / `Ctrl+K` Command Palette with `ArrowUp`/`ArrowDown`/`Home`/`End`).

## Directory Layout

- `app/` — App Router pages (`(app)/dashboard`, `holdings`, `transactions`, `watchlist`, `benchmarks`, `import-export`, `settings`, `more`, `login`), API routes (`app/api/*`), PWA metadata (`manifest.ts`, `icon.tsx`, `apple-icon.tsx`)
- `components/` — Feature views, Lightweight Charts components, Apple-style sheets, segmented controls, and navigation shell
- `db/` — Drizzle schema, migrations, and database client (`PGlite` / PostgreSQL)
- `lib/` — Financial engine (`fifo.ts`, `twr.ts`, `xirr.ts`, `drawdown.ts`, `risk-metrics.ts`), CSV parsers/writers, market-data providers, auth, formatting, and motion presets (`motion.ts`)
- `public/` — Static SVG app icon (`icons/icon.svg`) and static-asset service worker (`sw.js`)
