import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  exportCleanCsvFromDb,
  exportFullBackupJson,
  exportMspCsvFromDb,
  exportPlainTemplateCsv,
} from "@/lib/services/csv-import-export";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";

const exportQuerySchema = z.object({
  format: z.enum(["msp", "clean", "backup", "template"]).default("msp"),
  portfolioId: z.string().uuid("Invalid portfolio ID.").optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawFormat = request.nextUrl.searchParams.get("format") ?? "msp";
    const rawPortfolioId =
      request.nextUrl.searchParams.get("portfolioId") ?? undefined;

    const query = exportQuerySchema.parse({
      format: rawFormat,
      portfolioId: rawPortfolioId || undefined,
    });

    if (query.format === "template") {
      const file = exportPlainTemplateCsv();
      return new NextResponse(file.content, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (query.format === "backup") {
      await backfillMissingTransactionSgdTotals();
      const file = await exportFullBackupJson();
      return new NextResponse(file.content, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (query.format === "clean") {
      await backfillMissingTransactionSgdTotals();
      const file = await exportCleanCsvFromDb({
        portfolioId: query.portfolioId,
      });
      return new NextResponse(file.content, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const file = await exportMspCsvFromDb({
      portfolioId: query.portfolioId,
    });
    return new NextResponse(file.content, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

