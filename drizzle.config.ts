import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "turso",
  schema: "./db/schema.ts",
  out: "./db/migrations-sqlite",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? "file:.data/kestrel.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
