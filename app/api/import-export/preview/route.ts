import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { previewCsvImport } from "@/lib/services/csv-import-export";

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MB safety ceiling

const previewBodySchema = z.object({
  csvText: z
    .string()
    .min(1, "CSV file content cannot be empty.")
    .max(MAX_CSV_BYTES, "CSV file exceeds the 10 MB upload limit."),
});

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = previewBodySchema.parse(rawBody);
    const preview = await previewCsvImport(parsed.csvText);
    return NextResponse.json({ preview });
  } catch (error) {
    return toErrorResponse(error);
  }
}

