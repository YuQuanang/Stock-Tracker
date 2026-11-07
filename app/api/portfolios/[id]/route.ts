import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { deletePortfolio, updatePortfolio } from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid portfolio ID.");

const patchPortfolioSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  defaultCurrency: z.enum(["USD", "SGD"]).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/portfolios/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    const rawBody = await request.json().catch(() => null);
    const parsed = patchPortfolioSchema.parse(rawBody);
    const updated = await updatePortfolio(validId, parsed);
    return NextResponse.json({ portfolio: updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/portfolios/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    await deletePortfolio(validId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

