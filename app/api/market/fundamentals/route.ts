import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import { fetchInstrumentFundamentals } from "@/lib/market-data/fundamentals";

const querySchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required.").max(24),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const parsed = querySchema.safeParse({
    symbol: request.nextUrl.searchParams.get("symbol") ?? "",
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ?? "Invalid fundamentals query.",
      },
      { status: 400 },
    );
  }

  const fundamentals = await fetchInstrumentFundamentals(parsed.data.symbol);
  return NextResponse.json({ fundamentals });
}

