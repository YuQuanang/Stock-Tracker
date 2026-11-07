import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  listCsvImportLogs,
  undoCsvImport,
} from "@/lib/services/csv-import-export";
import { listPortfolios } from "@/lib/services/ledger";

const idSchema = z.string().uuid("Invalid import ID.");

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/import-export/undo/[id]">,
) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const { id } = await context.params;
    const validId = idSchema.parse(id);
    const undone = await undoCsvImport(validId);
    const [portfolios, importLogs] = await Promise.all([
      listPortfolios(),
      listCsvImportLogs(),
    ]);

    return NextResponse.json({
      undone,
      portfolios,
      importLogs,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

