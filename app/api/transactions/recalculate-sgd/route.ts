import { type NextRequest, NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const result = await backfillMissingTransactionSgdTotals({
      forceRetry: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

