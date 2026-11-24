/**
 * Historical USD -> SGD Exchange Rate Persistence & Transaction SGD Snapshot Engine.
 *
 * Ensures every transaction in Folio — whether manually entered or imported from
 * `MSP-Portfolios-*.csv` / plain CSV — has an accurate `fxRateToSgd` and
 * `totalCostSgd` calculated using the historical `USD -> SGD` exchange rate on
 * the transaction date (stepping back to the nearest prior business day on
 * weekends and public holidays):
 *
 *  - `Buy`:      `quantity * buyPrice * fxRate(purchaseDate)`
 *  - `Sell`:     `quantity * salePrice * fxRate(saleDate)`
 *  - `Sell All`: `fifoDisposedShares * salePrice * fxRate(saleDate)`
 *  - `Dividend`: `cashDividend * fxRate(dividendDate)` (or `shares * price * fxRate` in DRIP mode)
 *
 * Importantly, CSV-imported `purchaseFxRate` and `purchaseFxCurrencies` columns
 * are never overwritten when empty in the source CSV, preserving 100% lossless
 * byte-for-byte `MSP-Portfolios-*.csv` exports.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import { fxRate, instrument, settings, transaction } from "@/db/schema";
import {
  type DecimalValue,
  formatInstantInOffset,
  FxRateBook,
  lookupFxRate,
  resolveSellAllSourceId,
  toDecimal,
  toDecimalString,
  ZERO,
} from "@/lib/finance";
import { fetchUsdToSgdTimeSeries } from "@/lib/market-data/fx";
import { TtlCache } from "@/lib/market-data/cache";
import { evaluateInstrumentAcrossPortfolios } from "@/lib/services/symbol-ledgers";

const BACKFILL_FAILURE_COOLDOWN_MS = 60 * 1000; // 60s cooldown if offline
const FX_RANGE_SYNC_FRESHNESS_MS = 10 * 60 * 1000; // 10m cooldown after checking latest ECB FX
let lastNetworkFailureAt = 0;

interface FxSyncWindow {
  minDate: string;
  maxDate: string;
}
const fxRangeSyncCache = new TtlCache<FxSyncWindow>(20, "fx-range-sync");

export function clearHistoricalFxSyncCache(): void {
  fxRangeSyncCache.clear();
  lastNetworkFailureAt = 0;
}

function daysBetweenIsoDates(earlier: string, later: string): number {
  const [y1, m1, d1] = earlier.split("-").map(Number);
  const [y2, m2, d2] = later.split("-").map(Number);
  const ms1 = Date.UTC(y1, m1 - 1, d1);
  const ms2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((ms2 - ms1) / 86_400_000);
}

function isWeekendIsoDate(isoDate: string): boolean {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

export interface EnsureHistoricalFxResult {
  fxBook: FxRateBook;
  sourceByDate: Map<string, string>;
  fetchedCount: number;
  fetchFailed: boolean;
}

/**
 * Ensures the `fx_rate` database table holds daily `USD -> SGD` rates covering
 * all `dates` (`YYYY-MM-DD`), fetching any missing span in a single time-series
 * call to Frankfurter (or Yahoo `SGD=X` fallback).
 */
export async function ensureHistoricalUsdSgdRates(params: {
  dates: readonly string[];
  database: Database;
  fetchImpl?: typeof fetch;
  cacheOnly?: boolean;
  forceSync?: boolean;
}): Promise<EnsureHistoricalFxResult> {
  const validDates = [
    ...new Set(params.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))),
  ].sort();

  const existingRows = await params.database.select().from(fxRate);
  let fxBook = new FxRateBook(existingRows);
  const sourceByDate = new Map<string, string>();
  let maxCachedUsdSgdDate: string | null = null;

  for (const row of existingRows) {
    if (row.fromCurrency === "USD" && row.toCurrency === "SGD") {
      sourceByDate.set(row.date, row.source);
      if (maxCachedUsdSgdDate === null || row.date > maxCachedUsdSgdDate) {
        maxCachedUsdSgdDate = row.date;
      }
    }
  }

  if (validDates.length === 0) {
    return { fxBook, sourceByDate, fetchedCount: 0, fetchFailed: false };
  }

  // Identify dates not yet reliably covered by the cached `fx_rate` rows.
  const uncoveredDates = validDates.filter((date) => {
    const exact = fxBook.getExact(date, "USD", "SGD");
    if (exact !== null) {
      return false;
    }

    // If `date` is beyond the newest cached business day, only treat it as
    // covered when it is an immediate weekend day right after Friday's rate.
    if (maxCachedUsdSgdDate !== null && date > maxCachedUsdSgdDate) {
      const gap = daysBetweenIsoDates(maxCachedUsdSgdDate, date);
      if (isWeekendIsoDate(date) && gap <= 2) {
        return false;
      }
      return true;
    }

    const resolved = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date,
      rateBook: fxBook,
      maxLookbackDays: 10,
    });
    return resolved.rate === null;
  });

  if (uncoveredDates.length === 0 || params.cacheOnly) {
    return { fxBook, sourceByDate, fetchedCount: 0, fetchFailed: false };
  }

  const minUncovered = uncoveredDates[0];
  const maxUncovered = uncoveredDates[uncoveredDates.length - 1];

  const syncedWindow =
    !params.fetchImpl && !params.forceSync
      ? fxRangeSyncCache.get("usd-sgd")
      : undefined;
  if (
    syncedWindow &&
    syncedWindow.minDate <= minUncovered &&
    syncedWindow.maxDate >= maxUncovered
  ) {
    return { fxBook, sourceByDate, fetchedCount: 0, fetchFailed: false };
  }

  try {
    const fetchedBars = await fetchUsdToSgdTimeSeries({
      startDate: minUncovered,
      endDate: maxUncovered,
      fetchImpl: params.fetchImpl,
    });

    const BATCH_SIZE = 150;
    for (let i = 0; i < fetchedBars.length; i += BATCH_SIZE) {
      const chunk = fetchedBars.slice(i, i + BATCH_SIZE);
      await params.database
        .insert(fxRate)
        .values(
          chunk.map((bar) => ({
            date: bar.date,
            fromCurrency: bar.fromCurrency,
            toCurrency: bar.toCurrency,
            rate: bar.rate,
            source: bar.source,
          })),
        )
        .onConflictDoNothing();
    }

    const refreshedRows = await params.database.select().from(fxRate);
    fxBook = new FxRateBook(refreshedRows);
    sourceByDate.clear();
    for (const row of refreshedRows) {
      if (row.fromCurrency === "USD" && row.toCurrency === "SGD") {
        sourceByDate.set(row.date, row.source);
      }
    }

    if (!params.fetchImpl) {
      fxRangeSyncCache.set(
        "usd-sgd",
        {
          minDate:
            syncedWindow && syncedWindow.minDate < minUncovered
              ? syncedWindow.minDate
              : minUncovered,
          maxDate:
            syncedWindow && syncedWindow.maxDate > maxUncovered
              ? syncedWindow.maxDate
              : maxUncovered,
        },
        FX_RANGE_SYNC_FRESHNESS_MS,
      );
    }

    return {
      fxBook,
      sourceByDate,
      fetchedCount: fetchedBars.length,
      fetchFailed: false,
    };
  } catch {
    if (!params.fetchImpl) {
      fxRangeSyncCache.set(
        "usd-sgd",
        { minDate: minUncovered, maxDate: maxUncovered },
        BACKFILL_FAILURE_COOLDOWN_MS,
      );
    }
    return {
      fxBook,
      sourceByDate,
      fetchedCount: 0,
      fetchFailed: true,
    };
  }
}

export interface LedgerPairIdentifier {
  portfolioId: string;
  instrumentId: string;
  symbol?: string;
}

/**
 * Computes and persists `fxRateToSgd`, `fxAsOf`, `fxSource`, and `totalCostSgd`
 * for every transaction in the given `(portfolioId, instrumentId)` pairs,
 * including `Sell All` rows whose disposed share count comes from FIFO matching.
 */
export async function reconcileLedgerPairsSgdTotals(params: {
  pairs: readonly LedgerPairIdentifier[];
  database: Database;
  dividendMode: "cash" | "shares";
  fxBook: FxRateBook;
  sourceByDate: ReadonlyMap<string, string>;
}): Promise<number> {
  let updatedCount = 0;

  // A `Sell All` closes the symbol in every portfolio, so its disposed share
  // count (and SGD total) is computed once per instrument across all portfolios.
  const soldSharesCache = new Map<string, Map<string, DecimalValue>>();

  async function getSoldSharesBySourceTxId(
    instrumentId: string,
    symbol: string,
  ): Promise<Map<string, DecimalValue>> {
    const cached = soldSharesCache.get(instrumentId);
    if (cached) {
      return cached;
    }

    const evaluations = await evaluateInstrumentAcrossPortfolios({
      database: params.database,
      instrumentId,
      symbol,
      dividendMode: params.dividendMode,
      onValidationError: "clamp-and-flag",
    });

    const soldSharesByTxId = new Map<string, DecimalValue>();
    for (const evaluation of evaluations) {
      for (const match of evaluation.fifo.closedLotMatches) {
        const sourceId = resolveSellAllSourceId(match.sellTransactionId);
        const prev = soldSharesByTxId.get(sourceId) ?? ZERO;
        soldSharesByTxId.set(sourceId, prev.plus(match.sharesMatched));
      }
    }

    soldSharesCache.set(instrumentId, soldSharesByTxId);
    return soldSharesByTxId;
  }

  for (const pair of params.pairs) {
    const rows = await params.database
      .select()
      .from(transaction)
      .where(
        and(
          eq(transaction.portfolioId, pair.portfolioId),
          eq(transaction.instrumentId, pair.instrumentId),
        ),
      );

    if (rows.length === 0) {
      continue;
    }

    const soldSharesByTxId = await getSoldSharesBySourceTxId(
      pair.instrumentId,
      pair.symbol ?? "Instrument",
    );

    for (const tx of rows) {
      const executedAt = new Date(tx.executedAt);
      const { localDate } = formatInstantInOffset(
        executedAt,
        tx.originalOffset,
      );
      const upperCurrency = tx.currency.trim().toUpperCase();

      let effectiveFx: DecimalValue | null = null;
      let nextFxAsOf: Date | null = tx.fxAsOf ? new Date(tx.fxAsOf) : null;
      let nextFxSource: string | null = tx.fxSource ?? null;

      if (upperCurrency === "SGD") {
        effectiveFx = toDecimal(1);
        nextFxAsOf = nextFxAsOf ?? executedAt;
        nextFxSource = nextFxSource ?? "native-sgd";
      } else if (tx.isManualFxRate && tx.fxRateToSgd !== null) {
        effectiveFx = toDecimal(tx.fxRateToSgd);
        nextFxSource = "manual";
      } else if (tx.fxRateToSgd !== null) {
        effectiveFx = toDecimal(tx.fxRateToSgd);
      } else {
        // Resolve from explicit CSV purchaseFxRate if present, otherwise look up
        // the historical USD -> SGD rate on `localDate` (or prior business day).
        const lookup = lookupFxRate({
          fromCurrency: upperCurrency,
          toCurrency: "SGD",
          date: localDate,
          explicitRate: tx.purchaseFxRate,
          explicitCurrencies: tx.purchaseFxCurrencies,
          rateBook: params.fxBook,
          maxLookbackDays: 10,
        });

        if (lookup.rate !== null) {
          effectiveFx = lookup.rate;
          const resolvedDate = lookup.effectiveDate ?? localDate;
          nextFxAsOf = new Date(`${resolvedDate}T00:00:00.000Z`);
          if (lookup.source === "transaction") {
            nextFxSource = "csv-import";
          } else {
            nextFxSource =
              params.sourceByDate.get(resolvedDate) ?? "frankfurter";
          }
        }
      }

      if (effectiveFx === null) {
        continue;
      }

      const nextFxRateToSgd = toDecimalString(effectiveFx, 12);
      const qtyDec = toDecimal(tx.quantity);
      const priceDec = toDecimal(tx.price);

      let nativeGross: DecimalValue;
      if (tx.type === "Sell All") {
        const disposedShares = soldSharesByTxId.get(tx.id) ?? ZERO;
        nativeGross = disposedShares.mul(priceDec);
      } else if (tx.type === "Dividend") {
        const grossDiv =
          params.dividendMode === "shares" ? qtyDec.mul(priceDec) : qtyDec;
        const commVal =
          tx.commissionValue !== null && tx.commissionValue !== undefined
            ? toDecimal(tx.commissionValue)
            : ZERO;
        const commAmt = tx.commissionIsPercent
          ? grossDiv.mul(commVal).div(toDecimal(100))
          : commVal;
        nativeGross =
          params.dividendMode === "shares"
            ? grossDiv.plus(commAmt)
            : grossDiv.minus(commAmt);
      } else {
        nativeGross = qtyDec.mul(priceDec);
      }

      const nextTotalCostSgd = toDecimalString(
        nativeGross.mul(effectiveFx),
        12,
      );

      const currentFxString = tx.fxRateToSgd
        ? toDecimalString(toDecimal(tx.fxRateToSgd), 12)
        : null;
      const currentTotalString = tx.totalCostSgd
        ? toDecimalString(toDecimal(tx.totalCostSgd), 12)
        : null;

      if (
        currentFxString !== nextFxRateToSgd ||
        currentTotalString !== nextTotalCostSgd ||
        tx.fxSource !== nextFxSource
      ) {
        await params.database
          .update(transaction)
          .set({
            fxRateToSgd: nextFxRateToSgd,
            fxAsOf: nextFxAsOf,
            fxSource: nextFxSource,
            totalCostSgd: nextTotalCostSgd,
          })
          .where(eq(transaction.id, tx.id));
        updatedCount += 1;
      }
    }
  }

  return updatedCount;
}

/**
 * Scans the ledger for any transactions missing `totalCostSgd` or `fxRateToSgd`
 * (for example, rows imported earlier before historical FX rates were cached),
 * fetches the required historical `USD -> SGD` range once, and populates them.
 */
export async function backfillMissingTransactionSgdTotals(
  options: {
    db?: Database;
    fetchImpl?: typeof fetch;
    forceRetry?: boolean;
  } = {},
): Promise<{ updatedCount: number; fetchFailed: boolean }> {
  const database = options.db ?? (await getDb());

  // Check for incomplete SGD transactions and `Sell All` totals concurrently.
  const [incompleteRows, sellAllRows] = await Promise.all([
    database
      .select({
        id: transaction.id,
        portfolioId: transaction.portfolioId,
        instrumentId: transaction.instrumentId,
        executedAt: transaction.executedAt,
        originalOffset: transaction.originalOffset,
        currency: transaction.currency,
        fxRateToSgd: transaction.fxRateToSgd,
        symbol: instrument.symbol,
      })
      .from(transaction)
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .where(
        or(
          isNull(transaction.totalCostSgd),
          and(
            eq(transaction.currency, "USD"),
            isNull(transaction.fxRateToSgd),
          ),
        ),
      ),
    database
      .select({
        portfolioId: transaction.portfolioId,
        instrumentId: transaction.instrumentId,
        symbol: instrument.symbol,
      })
      .from(transaction)
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .where(eq(transaction.type, "Sell All")),
  ]);

  if (incompleteRows.length === 0 && sellAllRows.length === 0) {
    return { updatedCount: 0, fetchFailed: false };
  }

  const nowMs = Date.now();
  const skipNetworkBecauseRecentFailure =
    !options.forceRetry &&
    !options.fetchImpl &&
    lastNetworkFailureAt > 0 &&
    nowMs - lastNetworkFailureAt < BACKFILL_FAILURE_COOLDOWN_MS;

  const usdDatesToFetch: string[] = [];
  const pairMap = new Map<string, LedgerPairIdentifier>();

  for (const row of sellAllRows) {
    pairMap.set(`${row.portfolioId}::${row.instrumentId}`, {
      portfolioId: row.portfolioId,
      instrumentId: row.instrumentId,
      symbol: row.symbol,
    });
  }

  for (const row of incompleteRows) {
    const pairKey = `${row.portfolioId}::${row.instrumentId}`;
    if (!pairMap.has(pairKey)) {
      pairMap.set(pairKey, {
        portfolioId: row.portfolioId,
        instrumentId: row.instrumentId,
        symbol: row.symbol,
      });
    }

    if (row.currency.toUpperCase() === "USD" && row.fxRateToSgd === null) {
      const { localDate } = formatInstantInOffset(
        new Date(row.executedAt),
        row.originalOffset,
      );
      usdDatesToFetch.push(localDate);
    }
  }

  const settingsRows = await database
    .select()
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  const dividendMode = settingsRows[0]?.dividendMode ?? "cash";

  const fxResult = await ensureHistoricalUsdSgdRates({
    dates: skipNetworkBecauseRecentFailure ? [] : usdDatesToFetch,
    database,
    fetchImpl: options.fetchImpl,
  });

  if (fxResult.fetchFailed && !options.fetchImpl) {
    lastNetworkFailureAt = nowMs;
  } else if (!fxResult.fetchFailed) {
    lastNetworkFailureAt = 0;
  }

  const updatedCount = await reconcileLedgerPairsSgdTotals({
    pairs: [...pairMap.values()],
    database,
    dividendMode,
    fxBook: fxResult.fxBook,
    sourceByDate: fxResult.sourceByDate,
  });

  return {
    updatedCount,
    fetchFailed: fxResult.fetchFailed,
  };
}

