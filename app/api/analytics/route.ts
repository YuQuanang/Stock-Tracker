import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import { computePortfolioAnalytics } from "@/lib/services/analytics";

const analyticsQuerySchema = z.object({
  portfolioId: z.string().trim().min(1).max(64).optional(),
  currency: z.enum(["SGD", "USD"]).optional(),
  benchmarks: z.string().trim().max(320).optional(),
  includeBenchmarks: z.enum(["true", "false"]).optional(),
  includeFundamentals: z.enum(["true", "false"]).optional(),
  forceRefresh: z.enum(["true", "false"]).optional(),
  cacheOnly: z.enum(["true", "false"]).optional(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const params = request.nextUrl.searchParams;
    const parsed = analyticsQuerySchema.parse({
      portfolioId: params.get("portfolioId") ?? undefined,
      currency: params.get("currency") ?? undefined,
      benchmarks: params.get("benchmarks") ?? undefined,
      includeBenchmarks: params.get("includeBenchmarks") ?? undefined,
      includeFundamentals: params.get("includeFundamentals") ?? undefined,
      forceRefresh: params.get("forceRefresh") ?? undefined,
      cacheOnly: params.get("cacheOnly") ?? undefined,
    });

    const benchmarksList = parsed.benchmarks
      ? parsed.benchmarks
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : undefined;

    const snapshot = await computePortfolioAnalytics({
      portfolioId: parsed.portfolioId,
      currency: parsed.currency,
      benchmarks: benchmarksList,
      includeBenchmarks:
        parsed.includeBenchmarks !== undefined
          ? parsed.includeBenchmarks === "true"
          : true,
      includeFundamentals: parsed.includeFundamentals === "true",
      forceRefresh: parsed.forceRefresh === "true",
      cacheOnly: parsed.cacheOnly === "true",
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}

