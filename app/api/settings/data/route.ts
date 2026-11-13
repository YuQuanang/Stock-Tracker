import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { deleteAllPortfolioData } from "@/lib/services/settings";

const deleteConfirmSchema = z.object({
  confirmation: z.literal("DELETE ALL DATA"),
});

export async function DELETE(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    deleteConfirmSchema.parse(rawBody);
    await deleteAllPortfolioData();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

