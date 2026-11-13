import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { previewPaperSimulation } from "@/lib/services/watchlist";

const simulateQuerySchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required.").max(24),
  entryDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Entry date must be YYYY-MM-DD."),
  amount: z
    .string()
    .trim()
    .regex(/^(\d+\.?\d*|\.\d+)$/, "Amount must be a positive decimal."),
  benchmark: z.string().trim().max(24).optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const parsed = simulateQuerySchema.parse({
      symbol: searchParams.get("symbol") ?? "",
      entryDate: searchParams.get("entryDate") ?? "",
      amount: searchParams.get("amount") ?? "",
      benchmark: searchParams.get("benchmark") || undefined,
    });

    const preview = await previewPaperSimulation({
      symbol: parsed.symbol,
      entryDate: parsed.entryDate,
      amount: parsed.amount,
      benchmarkSymbol: parsed.benchmark,
    });

    return NextResponse.json({ preview });
  } catch (error) {
    return toErrorResponse(error);
  }
}

