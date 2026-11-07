import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fxRate } from "@/db/schema";
import { requireSession } from "@/lib/auth/guard";
import { MarketDataError } from "@/lib/market-data/errors";
import { fetchExchangeRateToSgd } from "@/lib/market-data/fx";

const querySchema = z.object({
  from: z.enum(["USD", "SGD"]).default("USD"),
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.")
    .optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const parsed = querySchema.safeParse({
    from: request.nextUrl.searchParams.get("from") ?? "USD",
    date: request.nextUrl.searchParams.get("date") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid FX query." },
      { status: 400 },
    );
  }

  try {
    const fx = await fetchExchangeRateToSgd({
      from: parsed.data.from,
      date: parsed.data.date ?? null,
    });

    // Warm the persistent `fx_rate` table with every live/historical USD -> SGD quote
    if (
      fx.source !== "native-sgd" &&
      /^\d{4}-\d{2}-\d{2}$/.test(fx.effectiveDate)
    ) {
      try {
        const database = await getDb();
        await database
          .insert(fxRate)
          .values({
            date: fx.effectiveDate,
            fromCurrency: "USD",
            toCurrency: "SGD",
            rate: fx.rate,
            source: fx.source,
          })
          .onConflictDoNothing();
      } catch {
        // Non-fatal: still return the fetched FX rate to the caller
      }
    }

    return NextResponse.json({ fx });
  } catch (error) {
    if (error instanceof MarketDataError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Could not fetch USD/SGD exchange rate.", kind: "upstream" },
      { status: 502 },
    );
  }
}

