import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { getOrCreateSettings } from "@/lib/services/ledger";
import { updateSettings } from "@/lib/services/settings";

const patchSettingsSchema = z.object({
  baseCurrency: z.enum(["SGD", "USD"]).optional(),
  riskFreeRate: z
    .string()
    .trim()
    .regex(/^(\d+\.?\d*|\.\d+)$/, "Risk-free rate must be numeric.")
    .optional(),
  defaultBenchmark: z.string().trim().min(1).max(24).optional(),
  defaultPortfolioId: z
    .union([
      z.literal("all"),
      z
        .string()
        .trim()
        .uuid("Default portfolio must be 'all' or a valid portfolio ID."),
    ])
    .optional(),
  costBasisMethod: z.enum(["FIFO"]).optional(),
  dividendMode: z.enum(["cash", "shares"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  gainColorScheme: z
    .enum(["green-up", "red-up", "color-blind-safe"])
    .optional(),
  numberFormat: z.enum(["en-SG", "en-US"]).optional(),
  dateFormat: z.enum(["dd MMM yyyy", "yyyy-MM-dd", "MM/dd/yyyy"]).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const current = await getOrCreateSettings();
    return NextResponse.json({ settings: current });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = patchSettingsSchema.parse(rawBody);
    const updated = await updateSettings(parsed);
    return NextResponse.json({ settings: updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}

