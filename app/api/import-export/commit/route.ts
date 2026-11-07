import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  commitCsvImport,
  listCsvImportLogs,
} from "@/lib/services/csv-import-export";
import { listPortfolios } from "@/lib/services/ledger";

const MAX_CSV_BYTES = 10 * 1024 * 1024;

const commitBodySchema = z.object({
  filename: z.string().trim().min(1, "Filename is required.").max(255),
  csvText: z
    .string()
    .min(1, "CSV file content cannot be empty.")
    .max(MAX_CSV_BYTES, "CSV file exceeds the 10 MB upload limit."),
  duplicateMode: z.enum(["skip", "replace", "append"]).default("skip"),
});

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = commitBodySchema.parse(rawBody);
    const result = await commitCsvImport(parsed);
    const [portfolios, importLogs] = await Promise.all([
      listPortfolios(),
      listCsvImportLogs(),
    ]);
    return NextResponse.json({
      result,
      portfolios,
      importLogs,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
