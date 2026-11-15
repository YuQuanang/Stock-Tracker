import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  clearFundamentalsCacheForSymbol,
  clearHistoryCacheForInstrument,
  clearQuoteCacheForSymbol,
} from "@/lib/market-data";
import { migrateInstrumentSymbol } from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid instrument ID.");

const migrateBodySchema = z.object({
  targetSymbol: z.string().trim().min(1, "Target ticker symbol is required."),
  targetName: z.string().max(120).nullable().optional(),
  applyConsolidationSplit: z.boolean().optional(),
  exDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Ex-date must be YYYY-MM-DD.")
    .optional(),
  ratioNumerator: z.number().int().positive().optional(),
  ratioDenominator: z.number().int().positive().optional(),
});

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/instruments/[id]/migrate">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    const rawBody = await request.json().catch(() => null);
    const parsed = migrateBodySchema.parse(rawBody);
    const result = await migrateInstrumentSymbol(validId, parsed);

    clearQuoteCacheForSymbol(result.previousSymbol);
    clearQuoteCacheForSymbol(result.instrument.symbol);
    clearFundamentalsCacheForSymbol(result.previousSymbol);
    clearFundamentalsCacheForSymbol(result.instrument.symbol);
    clearHistoryCacheForInstrument(validId, result.previousSymbol);
    clearHistoryCacheForInstrument(
      result.instrument.id,
      result.instrument.symbol,
    );

    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

