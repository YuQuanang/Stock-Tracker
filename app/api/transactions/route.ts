import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { requireSession } from "@/lib/auth/guard";
import {
  computeLedgerSummaries,
  createTransaction,
  getEnrichedTransactionById,
  listEnrichedTransactions,
} from "@/lib/services/ledger";

const decimalStringSchema = z
  .union([z.string(), z.number()])
  .transform((val) => String(val).trim())
  .refine(
    (val) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(val),
    "Must be a valid decimal number.",
  );

const nullableDecimalStringSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null || String(val).trim() === "") {
      return null;
    }
    return String(val).trim();
  })
  .refine(
    (val) => val === null || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(val),
    "Must be a valid decimal number.",
  );

export const saveTransactionBodySchema = z.object({
  portfolioId: z.string().uuid("Please choose a valid portfolio."),
  symbol: z
    .string()
    .trim()
    .min(1, "Ticker symbol is required.")
    .max(24, "Ticker symbol is too long."),
  instrumentName: z.string().trim().max(120).nullish(),
  exchangeCode: z.string().trim().max(24).nullish(),
  type: z.enum(["Buy", "Sell", "Sell All", "Dividend"]),
  quantity: decimalStringSchema,
  price: decimalStringSchema,
  commission: z.string().trim().max(24).nullish(),
  date: z.string().trim().min(10, "Transaction date is required.").max(32),
  time: z.string().trim().max(16).nullish(),
  offset: z.string().trim().max(8).optional(),
  currency: z.enum(["USD", "SGD"]).optional(),
  purchaseFxRate: nullableDecimalStringSchema,
  purchaseFxCurrencies: z.string().trim().max(16).nullish(),
  priceAsOf: z.string().trim().max(64).nullish(),
  priceStatus: z.string().trim().max(32).nullish(),
  fxRateToSgd: nullableDecimalStringSchema,
  fxAsOf: z.string().trim().max(64).nullish(),
  fxSource: z.string().trim().max(32).nullish(),
  isManualPrice: z.boolean().optional(),
  isManualFxRate: z.boolean().optional(),
  notes: z.string().max(1000).nullish(),
});

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const rawPortfolioId = searchParams.get("portfolioId") || undefined;
    const rawInstrumentId = searchParams.get("instrumentId") || undefined;

    if (rawPortfolioId) {
      z.string().uuid().parse(rawPortfolioId);
    }
    if (rawInstrumentId) {
      z.string().uuid().parse(rawInstrumentId);
    }

    const [transactions, summary] = await Promise.all([
      listEnrichedTransactions({
        portfolioId: rawPortfolioId,
        instrumentId: rawInstrumentId,
      }),
      computeLedgerSummaries(rawPortfolioId),
    ]);

    return NextResponse.json({
      transactions,
      positions: summary.positions,
      zeroCostBuys: summary.zeroCostBuys,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = saveTransactionBodySchema.parse(rawBody);
    const created = await createTransaction(parsed);
    const enriched = await getEnrichedTransactionById(created.id);
    return NextResponse.json(
      { transaction: enriched ?? created },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

