import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  removeWatchlistItem,
  updateWatchlistItem,
} from "@/lib/services/watchlist";

const nullablePositiveDecimalSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined) {
      return undefined;
    }
    if (val === null || String(val).trim() === "") {
      return null;
    }
    return String(val).trim();
  })
  .refine(
    (val) =>
      val === undefined || val === null || /^(\d+\.?\d*|\.\d+)$/.test(val),
    "Must be a valid positive decimal number.",
  );

const updateWatchlistItemSchema = z.object({
  priceWhenAdded: nullablePositiveDecimalSchema,
  alertAbove: nullablePositiveDecimalSchema,
  alertBelow: nullablePositiveDecimalSchema,
  paperEntryDate: z.string().trim().max(16).nullish(),
  paperAmount: nullablePositiveDecimalSchema,
  paperShares: nullablePositiveDecimalSchema,
  clearPaperPosition: z.boolean().optional(),
});

const paramsSchema = z.object({
  portfolioId: z.string().uuid("Invalid watchlist id."),
  instrumentId: z.string().uuid("Invalid instrument id."),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ portfolioId: string; instrumentId: string }> },
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawParams = await context.params;
    const { portfolioId, instrumentId } = paramsSchema.parse(rawParams);
    const json = await request.json();
    const parsed = updateWatchlistItemSchema.parse(json);

    const item = await updateWatchlistItem({
      portfolioId,
      instrumentId,
      priceWhenAdded: parsed.priceWhenAdded,
      alertAbove: parsed.alertAbove,
      alertBelow: parsed.alertBelow,
      paperEntryDate: parsed.paperEntryDate,
      paperAmount: parsed.paperAmount,
      paperShares: parsed.paperShares,
      clearPaperPosition: parsed.clearPaperPosition,
    });

    return NextResponse.json({ item });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ portfolioId: string; instrumentId: string }> },
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawParams = await context.params;
    const { portfolioId, instrumentId } = paramsSchema.parse(rawParams);

    await removeWatchlistItem({ portfolioId, instrumentId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

