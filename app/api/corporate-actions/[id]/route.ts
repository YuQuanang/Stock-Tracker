import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { deleteCorporateSplit } from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid corporate action ID.");

export async function DELETE(
  request: NextRequest,
  context: RouteContext<"/api/corporate-actions/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    await deleteCorporateSplit(validId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

