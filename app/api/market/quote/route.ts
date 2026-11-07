import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import { MarketDataError } from "@/lib/market-data/errors";
import { fetchStockPrice } from "@/lib/market-data/quotes";

const querySchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required.").max(24),
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
    symbol: request.nextUrl.searchParams.get("symbol") ?? "",
    date: request.nextUrl.searchParams.get("date") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid quote query." },
      { status: 400 },
    );
  }

  try {
    const quote = await fetchStockPrice(parsed.data.symbol, {
      date: parsed.data.date ?? null,
    });
    return NextResponse.json({ quote });
  } catch (error) {
    if (error instanceof MarketDataError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Could not fetch stock price.", kind: "upstream" },
      { status: 502 },
    );
  }
}

