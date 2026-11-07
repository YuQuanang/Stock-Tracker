import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  createCorporateSplit,
  listCorporateActions,
} from "@/lib/services/ledger";

const createSplitSchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required.").max(24),
  exDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Ex-date must be YYYY-MM-DD."),
  ratioNumerator: z.number().int().min(1).max(10_000),
  ratioDenominator: z.number().int().min(1).max(10_000),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const actions = await listCorporateActions();
    return NextResponse.json({ actions });
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
    const parsed = createSplitSchema.parse(rawBody);
    const created = await createCorporateSplit(parsed);
    return NextResponse.json({ action: created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

