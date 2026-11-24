import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { lookupExactSymbol } from "@/lib/market-data";
import { syncPortfolioDividends } from "@/lib/services/dividends";
import { adjustPortfolioHolding } from "@/lib/services/ledger";

const decimalStringSchema = z
  .union([z.string(), z.number()])
  .transform((val) => String(val).trim())
  .refine(
    (val) => /^(\d+\.?\d*|\.\d+)$/.test(val),
    "Must be a valid non-negative decimal number.",
  );

const nullablePositiveDecimalSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null || String(val).trim() === "") {
      return null;
    }
    return String(val).trim();
  })
  .refine(
    (val) => val === null || /^(\d+\.?\d*|\.\d+)$/.test(val),
    "Must be a valid positive decimal number.",
  );

const adjustHoldingSchema = z.object({
  portfolioId: z.string().uuid("Please choose a valid holdings portfolio."),
  symbol: z
    .string()
    .trim()
    .min(1, "Ticker symbol is required.")
    .max(24, "Ticker symbol is too long."),
  instrumentName: z.string().trim().max(120).nullish(),
  exchangeCode: z.string().trim().max(24).nullish(),
  currency: z.string().trim().min(3).max(8).optional(),
  targetShares: decimalStringSchema,
  targetAverageCost: decimalStringSchema,
  fxRateToSgd: nullablePositiveDecimalSchema,
  notes: z.string().max(1000).nullish(),
});

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = adjustHoldingSchema.parse(rawBody);

    let resolvedName = parsed.instrumentName ?? undefined;
    let resolvedExchange = parsed.exchangeCode ?? undefined;
    if (!resolvedName || !resolvedExchange) {
      const exactMatch = await lookupExactSymbol(parsed.symbol).catch(
        () => null,
      );
      if (exactMatch) {
        resolvedName = resolvedName || exactMatch.name;
        resolvedExchange = resolvedExchange || exactMatch.exchangeCode;
      }
    }

    const result = await adjustPortfolioHolding({
      ...parsed,
      instrumentName: resolvedName ?? null,
      exchangeCode: resolvedExchange ?? null,
    });

    await syncPortfolioDividends({ instrumentId: result.instrumentId });

    return NextResponse.json({ holding: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
