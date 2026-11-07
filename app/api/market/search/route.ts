import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import { MarketDataError } from "@/lib/market-data/errors";
import { lookupExactSymbol, searchSymbols } from "@/lib/market-data/search";

const querySchema = z.object({
  q: z.string().trim().min(1, "Search query is required.").max(60),
  exact: z.enum(["0", "1"]).optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    exact: request.nextUrl.searchParams.get("exact") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid search query." },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.exact === "1") {
      const match = await lookupExactSymbol(parsed.data.q);
      if (!match) {
        return NextResponse.json(
          {
            match: null,
            error: `No stock or ETF found with exact ticker "${parsed.data.q.toUpperCase()}".`,
          },
          { status: 404 },
        );
      }
      return NextResponse.json({ match });
    }

    const matches = await searchSymbols(parsed.data.q, { limit: 8 });
    return NextResponse.json({ matches });
  } catch (error) {
    if (error instanceof MarketDataError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Symbol search failed. Please try again.", kind: "upstream" },
      { status: 502 },
    );
  }
}

