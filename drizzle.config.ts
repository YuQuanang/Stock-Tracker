import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  // Only needed for `drizzle-kit studio` / `push`. `generate` does not connect.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/folio",
  },
});

