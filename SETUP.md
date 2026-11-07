# Folio setup guide

Folio is a single-user app. You sign in with one password, and your data lives in a free hosted Postgres database so you can open it from your phone while your computer is off.

```
Phone / laptop  ──►  Vercel (Next.js, free)  ──►  Neon or Supabase Postgres (free)
                          │
                          └──►  Yahoo / Finnhub / Stooq / Frankfurter (server-side only)
```

The browser never talks to the database or to market-data providers directly.

---

## 1. Run it locally (2 minutes, no database needed)

Requires Node 22+.

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and set at least:

```
APP_PASSWORD=pick-something-long      # quick local option
```

Leave `DATABASE_URL` empty. Folio then uses an embedded database (PGlite) stored in `.data/pglite` and applies migrations automatically.

```bash
npm run dev          # http://localhost:3000
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript strict check |
| `npm run lint` | ESLint |
| `npm run db:generate` | Create a new SQL migration after editing `db/schema.ts` |
| `npm run db:migrate` | Apply migrations (to `DATABASE_URL` if set, otherwise local PGlite) |
| `npm run hash-password` | Generate a hashed password for `APP_PASSWORD_HASH` |

---

## 2. Create the free database

Pick **one** of the two. Both have a free tier that is plenty for a personal tracker.

### Option A: Neon (recommended)

1. Sign up at <https://neon.tech> and click **Create project**.
2. Choose a region close to you (for Singapore: **AWS Asia Pacific (Singapore)**).
3. On the project dashboard, open **Connect**, tick **Connection pooling**, and copy the connection string. It looks like:
   `postgresql://user:password@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
4. Keep it secret. This is your `DATABASE_URL`.

### Option B: Supabase

1. Sign up at <https://supabase.com> and click **New project**. Save the database password you choose.
2. Go to **Project Settings → Database → Connection string**.
3. Choose **Transaction pooler** (port **6543**) and copy the URI. Replace `[YOUR-PASSWORD]` with your database password.
4. This is your `DATABASE_URL`. Do **not** use the "Direct connection" string on Vercel (it only supports IPv6).
5. Supabase exposes tables through an auto-generated public API. Folio never uses it, so to be safe leave **Data API** disabled (Project Settings → Data API), or enable Row Level Security on every table with no policies.

> Free projects pause or sleep after inactivity (Supabase pauses after about a week without use). Opening the app occasionally keeps it awake; a paused project can be resumed from the dashboard.

---

## 3. Create your password hash and session secret

```bash
npm run hash-password
```

Type your password twice (nothing is echoed). It prints a line like:

```
APP_PASSWORD_HASH=scrypt:32768:8:1:....:....
```

Generate the session-signing secret:

```bash
openssl rand -base64 48
```

Use a password manager. The hash is safe to store; the password itself should not be written anywhere in plain text.

---

## 4. Apply the migrations to the hosted database

Put the real connection string in `.env.local` **temporarily** (or pass it inline), then run:

```bash
DATABASE_URL="postgresql://...your pooled string..." npm run db:migrate
```

You should see `Migrations applied.` Run this again whenever a new milestone adds a migration.

> Never commit `.env.local`. It is already in `.gitignore`.

---

## 5. Deploy on Vercel (free Hobby plan)

1. Push the project to a **private** GitHub repository.
2. Go to <https://vercel.com/new>, import the repository, and keep the default Next.js settings.
3. Before the first deploy, open **Environment Variables** and add (for Production, Preview, and Development):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the pooled connection string from step 2 |
   | `APP_PASSWORD_HASH` | the line from step 3 (value only, after the `=`) |
   | `SESSION_SECRET` | the output of `openssl rand -base64 48` |
   | `FINNHUB_API_KEY` | optional; free key from <https://finnhub.io> |

   Do **not** set `APP_PASSWORD` in production.
4. Click **Deploy**.
5. Open the `*.vercel.app` URL on your phone and sign in. Tip: use **Share → Add to Home Screen** for an app-like icon.

### Changing the password later

Run `npm run hash-password` again, update `APP_PASSWORD_HASH` in Vercel, and redeploy. All existing sessions are signed out automatically.

### Optional hardening

- In Vercel, enable **Deployment Protection** for preview deployments.
- Sessions last 30 days. Delete the cookie or press **Sign out** to end one sooner.
- After 5 wrong passwords from one address (or 20 from anywhere) login is blocked for 15 minutes.

---

## 6. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Page shows "Folio is not configured" | A required environment variable is missing or invalid. The message names it. |
| Login always fails in production | You set `APP_PASSWORD_HASH` with extra quotes or spaces. Paste only the value. |
| "too many connections" from the database | You used the direct connection string. Use the **pooled** one. |
| First request after a long idle is slow | The free database or serverless function is waking up. |
| `ENOENT .data/pglite` locally | Fixed in this project; delete the `.data` folder and restart if it is corrupted. |

