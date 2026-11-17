import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { addWatchlistItem, reorderWatchlistItems } from "@/lib/services/watchlist";

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

const addWatchlistItemSchema = z.object({
  portfolioId: z.string().uuid("Please choose a valid watchlist."),
  symbol: z
    .string()
    .trim()
    .min(1, "Ticker symbol is required.")
    .max(24, "Ticker symbol is too long."),
  name: z.string().trim().max(120).nullish(),
  instrumentName: z.string().trim().max(120).nullish(),
  exchangeCode: z.string().trim().max(24).nullish(),
  currency: z.enum(["USD", "SGD"]).nullish(),
  priceWhenAdded: nullablePositiveDecimalSchema,
  alertAbove: nullablePositiveDecimalSchema,
  alertBelow: nullablePositiveDecimalSchema,
});

const reorderWatchlistSchema = z.object({
  portfolioId: z.string().uuid("Please choose a valid watchlist."),
  orderedInstrumentIds: z
    .array(z.string().uuid("Invalid instrument id."))
    .min(1, "Provide at least one instrument id to reorder."),
});

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const json = await request.json();
    const parsed = addWatchlistItemSchema.parse(json);

    const item = await addWatchlistItem({
      portfolioId: parsed.portfolioId,
      symbol: parsed.symbol,
      name: parsed.name ?? parsed.instrumentName ?? null,
      exchangeCode: parsed.exchangeCode ?? null,
      currency: parsed.currency ?? null,
      priceWhenAdded: parsed.priceWhenAdded,
      alertAbove: parsed.alertAbove,
      alertBelow: parsed.alertBelow,
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const json = await request.json();
    const parsed = reorderWatchlistSchema.parse(json);

    await reorderWatchlistItems({
      portfolioId: parsed.portfolioId,
      orderedInstrumentIds: parsed.orderedInstrumentIds,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

