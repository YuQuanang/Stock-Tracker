import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { createPortfolio, listPortfolios } from "@/lib/services/ledger";

const createPortfolioSchema = z.object({
  name: z.string().trim().min(1, "Portfolio name is required.").max(80),
  type: z.enum(["holdings", "watchlist"]).default("holdings"),
  defaultCurrency: z.enum(["USD", "SGD"]).default("USD"),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const portfolios = await listPortfolios();
    return NextResponse.json({ portfolios });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = createPortfolioSchema.parse(rawBody);
    const created = await createPortfolio(parsed);
    return NextResponse.json({ portfolio: created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

