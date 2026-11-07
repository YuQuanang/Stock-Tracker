import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveTransactionBodySchema } from "@/app/api/transactions/route";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  deleteTransaction,
  getEnrichedTransactionById,
  updateTransaction,
} from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid transaction ID.");

export async function PUT(
  request: NextRequest,
  context: RouteContext<"/api/transactions/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    const rawBody = await request.json().catch(() => null);
    const parsed = saveTransactionBodySchema.parse(rawBody);
    const updated = await updateTransaction(validId, parsed);
    const enriched = await getEnrichedTransactionById(updated.id);
    return NextResponse.json({ transaction: enriched ?? updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/transactions/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    await deleteTransaction(validId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

