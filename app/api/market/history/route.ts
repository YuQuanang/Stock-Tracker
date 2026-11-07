import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import {
  type ChartRange,
  ensureInstrumentDailyBars,
  fetchPriceHistoryForRange,
} from "@/lib/market-data/history";

const ALLOWED_RANGES = [
  "1D",
  "5D",
  "1M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "MAX",
] as const;

const querySchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required.").max(24),
  range: z.enum(ALLOWED_RANGES).default("1Y"),
  start: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD.")
    .optional(),
  end: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD.")
    .optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const rawRange = (
    request.nextUrl.searchParams.get("range") ?? "1Y"
  ).toUpperCase();

  const parsed = querySchema.safeParse({
    symbol: request.nextUrl.searchParams.get("symbol") ?? "",
    range: rawRange,
    start: request.nextUrl.searchParams.get("start") ?? undefined,
    end: request.nextUrl.searchParams.get("end") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid history query." },
      { status: 400 },
    );
  }

  if (parsed.data.start) {
    const custom = await ensureInstrumentDailyBars({
      symbol: parsed.data.symbol,
      startDate: parsed.data.start,
      endDate: parsed.data.end,
    });
    return NextResponse.json({
      history: {
        symbol: parsed.data.symbol,
        currency: custom.currency,
        range: parsed.data.range,
        interval: "1d" as const,
        status: custom.status,
        unavailableReason: custom.unavailableReason,
        source: custom.source,
        bars: custom.bars,
      },
    });
  }

  const history = await fetchPriceHistoryForRange({
    symbol: parsed.data.symbol,
    range: parsed.data.range as ChartRange,
  });

  return NextResponse.json({ history });
}

