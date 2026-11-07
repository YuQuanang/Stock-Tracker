import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { updateInstrumentOverrides } from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid instrument ID.");

const patchInstrumentSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  manualPrice: z.union([z.string(), z.number(), z.null()]).optional(),
  isDelisted: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/instruments/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    const rawBody = await request.json().catch(() => null);
    const parsed = patchInstrumentSchema.parse(rawBody);
    const updated = await updateInstrumentOverrides(validId, parsed);
    return NextResponse.json({ instrument: updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}

