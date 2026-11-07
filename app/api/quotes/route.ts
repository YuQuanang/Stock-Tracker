import { asc } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fxRate, instrument } from "@/db/schema";
import { requireSession } from "@/lib/auth/guard";
import { resolveQuotesForSymbols } from "@/lib/market-data/batch-quotes";
import {
  type ExchangeRateSnapshot,
  fetchExchangeRateToSgd,
} from "@/lib/market-data/fx";
import { getCombinedMarketOverview } from "@/lib/market-data/hours";

const querySchema = z.object({
  symbols: z.string().trim().optional(),
  scope: z.enum(["explicit", "tracked"]).default("explicit"),
  sparklines: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

const MAX_BATCH_SYMBOLS = 100;

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const parsed = querySchema.safeParse({
    symbols: request.nextUrl.searchParams.get("symbols") ?? undefined,
    scope: request.nextUrl.searchParams.get("scope") ?? "explicit",
    sparklines: request.nextUrl.searchParams.get("sparklines") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid quotes query." },
      { status: 400 },
    );
  }

  const database = await getDb();
  let requestedSymbols: string[];

  if (parsed.data.scope === "tracked" && !parsed.data.symbols) {
    const trackedRows = await database
      .select({ symbol: instrument.symbol })
      .from(instrument)
      .orderBy(asc(instrument.symbol));
    requestedSymbols = trackedRows.map((row) => row.symbol);
  } else {
    requestedSymbols = (parsed.data.symbols ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const uniqueSymbols = [...new Set(requestedSymbols)];
  if (uniqueSymbols.length > MAX_BATCH_SYMBOLS) {
    return NextResponse.json(
      {
        error: `Batch quote request exceeds maximum of ${MAX_BATCH_SYMBOLS} symbols.`,
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const market = getCombinedMarketOverview(now);

  const [quotes, fxResult] = await Promise.all([
    resolveQuotesForSymbols({
      symbols: uniqueSymbols,
      db: database,
      now,
      includeSparklines: parsed.data.sparklines,
    }),
    fetchExchangeRateToSgd({ from: "USD", now }).catch(
      (): ExchangeRateSnapshot | null => null,
    ),
  ]);

  if (
    fxResult &&
    fxResult.source !== "native-sgd" &&
    /^\d{4}-\d{2}-\d{2}$/.test(fxResult.effectiveDate)
  ) {
    try {
      await database
        .insert(fxRate)
        .values({
          date: fxResult.effectiveDate,
          fromCurrency: "USD",
          toCurrency: "SGD",
          rate: fxResult.rate,
          source: fxResult.source,
        })
        .onConflictDoNothing();
    } catch {
      // Non-fatal cache write
    }
  }

  return NextResponse.json({
    quotes,
    fxUsdToSgd: fxResult,
    market,
    fetchedAt: now.toISOString(),
  });
}

