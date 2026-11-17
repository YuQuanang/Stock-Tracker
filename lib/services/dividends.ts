/**
 * Automatic Dividend Discovery & Ledger Sync Engine (`lib/services/dividends.ts`).
 *
 * Discovers historical cash dividends from Yahoo Finance (`events=div`),
 * evaluates exact split-adjusted FIFO shares held at the close prior to each
 * `exDate` for every `(portfolio, instrument)` bucket, applies default
 * withholding tax (`0%` for SGX `.SI` / `SGD` holdings, `30%` for US / `USD`
 * holdings including `TCEHY`), and idempotently syncs `Dividend` transactions
 * into the ledger without double-counting manual or previously synced entries.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  corporateAction,
  instrument,
  type Instrument,
  portfolio,
  transaction,
  type Transaction,
} from "@/db/schema";
import {
  applySymbolWideSellAll,
  computeTransactionDedupeHash,
  evaluateFifoLedger,
  formatInstantInOffset,
  type LedgerTransactionInput,
  QUANTITY_EPSILON,
  type SplitAction,
  toDecimal,
  toDecimalString,
  ZERO,
} from "@/lib/finance";
import { TtlCache } from "@/lib/market-data/cache";
import { fetchProviderJson } from "@/lib/market-data/errors";
import { getSingaporeDateString, inferMarketRegion } from "@/lib/market-data/hours";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";

export const AUTO_DIVIDEND_METHOD = "auto-dividend";

export interface YahooDividendEvent {
  exDate: string;
  amount: string;
}

export interface SyncDividendsOptions {
  db?: Database;
  instrumentId?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  cacheOnly?: boolean;
  forceRefresh?: boolean;
}

export interface SyncDividendsResult {
  insertedCount: number;
  updatedCount: number;
  deletedCount: number;
}

interface YahooDividendChartResponse {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        currency?: string;
        exchangeTimezoneName?: string;
      };
      events?: {
        dividends?: Record<
          string,
          {
            amount?: number;
            date?: number;
          }
        >;
      };
    }[];
  };
}

const DIVIDEND_EVENTS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const dividendEventsCache = new TtlCache<YahooDividendEvent[]>(
  120,
  "dividend-events",
);
const syncedSignatureCache = new TtlCache<string>(
  120,
  "dividend-sync-signature",
);

export function clearDividendSyncCaches(): void {
  dividendEventsCache.clear();
  syncedSignatureCache.clear();
}

/**
 * Returns the default dividend withholding tax percentage (`0` to `100`):
 *  - `0%` for SGX (`.SI` symbols, `SES` exchange, or native `SGD` instruments)
 *  - `30%` for US / `USD` holdings (including `TCEHY`)
 */
export function resolveDividendWithholdingTaxPercent(params: {
  symbol: string;
  currency: string;
  exchangeCode?: string | null;
}): number {
  const sym = params.symbol.trim().toUpperCase();
  const cur = params.currency.trim().toUpperCase();
  const exch = (params.exchangeCode ?? "").trim().toUpperCase();

  if (sym.endsWith(".SI") || cur === "SGD" || exch === "SES" || exch === "SGX") {
    return 0;
  }
  return 30;
}

function addCalendarDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function daysBetweenIsoDates(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  const ms1 = Date.UTC(y1, m1 - 1, d1);
  const ms2 = Date.UTC(y2, m2 - 1, d2);
  return Math.abs(Math.round((ms2 - ms1) / 86_400_000));
}

function toIsoDateInTimezone(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function mapDbTransactionToFifoInput(tx: Transaction): LedgerTransactionInput {
  return {
    id: tx.id,
    type: tx.type,
    quantity: tx.quantity,
    price: tx.price,
    commissionRaw: tx.commissionRaw,
    commissionValue: tx.commissionValue,
    commissionIsPercent: tx.commissionIsPercent,
    executedAt: new Date(tx.executedAt),
    originalOffset: tx.originalOffset,
    currency: tx.currency,
    purchaseFxRate: tx.purchaseFxRate,
    purchaseFxCurrencies: tx.purchaseFxCurrencies,
    fxRateToSgd: tx.fxRateToSgd,
    sourceRowId: tx.sourceRowId,
    createdAt: new Date(tx.createdAt),
  };
}

function formatCompactDec(raw: string): string {
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return num.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Fetches historical dividend events (`exDate` and per-share `amount`) from
 * Yahoo Finance across `[startDate, endDate]`, deduplicating any adjacent-day
 * duplicate entries within 5 calendar days.
 */
export async function fetchYahooDividendEvents(params: {
  symbol: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
}): Promise<YahooDividendEvent[] | null> {
  const [sy, sm, sd] = params.startDate.split("-").map(Number);
  const [ey, em, ed] = params.endDate.split("-").map(Number);
  const period1 = Math.floor(Date.UTC(sy, sm - 1, sd, 0, 0, 0) / 1000) - 86_400 * 3;
  const period2 =
    Math.floor(Date.UTC(ey, em - 1, ed, 23, 59, 59) / 1000) + 86_400;

  const hosts = params.fetchImpl
    ? ["query1.finance.yahoo.com"]
    : ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  let payload: YahooDividendChartResponse | null = null;
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      params.symbol,
    )}?interval=1d&period1=${period1}&period2=${period2}&events=div`;
    try {
      payload = await fetchProviderJson<YahooDividendChartResponse>({
        provider: "Yahoo Finance",
        url,
        timeoutMs: 8_000,
        fetchImpl: params.fetchImpl,
      });
      break;
    } catch {
      // Fall back to secondary Yahoo host or return null on offline/404.
    }
  }

  const result = payload?.chart?.result?.[0];
  if (!result) {
    return null;
  }
  const rawDividends = result.events?.dividends;
  if (!rawDividends) {
    return [];
  }

  const region = inferMarketRegion(result?.meta?.symbol ?? params.symbol);
  const exchangeTz =
    result?.meta?.exchangeTimezoneName ??
    (region === "SG" ? "Asia/Singapore" : "America/New_York");

  const byDate = new Map<string, string>();
  for (const entry of Object.values(rawDividends)) {
    const rawAmount = entry?.amount;
    const rawTs = entry?.date;
    if (
      typeof rawAmount !== "number" ||
      !Number.isFinite(rawAmount) ||
      rawAmount <= 0 ||
      typeof rawTs !== "number" ||
      !Number.isFinite(rawTs)
    ) {
      continue;
    }
    const exDate = toIsoDateInTimezone(rawTs, exchangeTz);
    if (exDate < params.startDate || exDate > params.endDate) {
      continue;
    }
    byDate.set(exDate, toDecimalString(toDecimal(rawAmount).toDecimalPlaces(6), 6));
  }

  const sorted = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([exDate, amount]) => ({ exDate, amount }));

  // Deduplicate occasional adjacent-day Yahoo duplicate entries within <= 5 days.
  const deduped: YahooDividendEvent[] = [];
  for (const item of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && daysBetweenIsoDates(prev.exDate, item.exDate) <= 5) {
      continue;
    }
    deduped.push(item);
  }

  return deduped;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

/**
 * Synchronizes historical cash dividends into the `transaction` ledger for all
 * held stocks/ETFs (or a single `instrumentId`).
 */
export async function syncPortfolioDividends(
  options: SyncDividendsOptions = {},
): Promise<SyncDividendsResult> {
  if (options.cacheOnly && !options.forceRefresh) {
    return { insertedCount: 0, updatedCount: 0, deletedCount: 0 };
  }

  const database = options.db ?? (await getDb());
  const now = options.now ?? new Date();
  const todayIso = getSingaporeDateString(now);

  const [txRows, splitRows] = await Promise.all([
    database
      .select({
        tx: transaction,
        portfolioName: portfolio.name,
        portfolioType: portfolio.type,
        instr: instrument,
      })
      .from(transaction)
      .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id))
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .where(
        options.instrumentId
          ? eq(transaction.instrumentId, options.instrumentId)
          : undefined,
      )
      .orderBy(asc(transaction.executedAt)),
    options.instrumentId
      ? database
          .select()
          .from(corporateAction)
          .where(eq(corporateAction.instrumentId, options.instrumentId))
      : database.select().from(corporateAction),
  ]);

  const splitsByInstrument = new Map<string, SplitAction[]>();
  for (const s of splitRows) {
    const list = splitsByInstrument.get(s.instrumentId) ?? [];
    list.push({
      id: s.id,
      exDate: s.exDate,
      ratioNumerator: s.ratioNumerator,
      ratioDenominator: s.ratioDenominator,
    });
    splitsByInstrument.set(s.instrumentId, list);
  }

  const byInstrument = new Map<
    string,
    {
      instr: Instrument;
      groupsByPortfolio: Map<
        string,
        {
          portfolioId: string;
          portfolioName: string;
          txs: Transaction[];
        }
      >;
    }
  >();

  for (const row of txRows) {
    if (row.portfolioType !== "holdings") {
      continue;
    }
    if (
      row.instr.assetType === "crypto" ||
      row.instr.isDelisted ||
      row.instr.priceNotFoundAt !== null
    ) {
      continue;
    }

    let instEntry = byInstrument.get(row.instr.id);
    if (!instEntry) {
      instEntry = {
        instr: row.instr,
        groupsByPortfolio: new Map(),
      };
      byInstrument.set(row.instr.id, instEntry);
    }

    let pGroup = instEntry.groupsByPortfolio.get(row.tx.portfolioId);
    if (!pGroup) {
      pGroup = {
        portfolioId: row.tx.portfolioId,
        portfolioName: row.portfolioName,
        txs: [],
      };
      instEntry.groupsByPortfolio.set(row.tx.portfolioId, pGroup);
    }
    pGroup.txs.push(row.tx);
  }

  const instrumentsToProcess: {
    instr: Instrument;
    earliestBuyDate: string;
    nonDivSignature: string;
    groups: {
      portfolioId: string;
      portfolioName: string;
      txs: Transaction[];
    }[];
  }[] = [];
  const toDeleteIds: string[] = [];

  for (const { instr, groupsByPortfolio } of byInstrument.values()) {
    const groups = [...groupsByPortfolio.values()];
    let earliestBuyDate: string | null = null;
    const sigParts: string[] = [];

    for (const g of groups) {
      for (const tx of g.txs) {
        if (tx.type !== "Dividend") {
          const localDate = formatInstantInOffset(
            new Date(tx.executedAt),
            tx.originalOffset,
          ).localDate;
          if (tx.type === "Buy") {
            if (earliestBuyDate === null || localDate < earliestBuyDate) {
              earliestBuyDate = localDate;
            }
          }
          sigParts.push(
            `${tx.id}:${tx.type}:${tx.quantity}:${tx.executedAt.toISOString()}`,
          );
        }
      }
    }

    if (!earliestBuyDate || earliestBuyDate > todayIso) {
      for (const g of groups) {
        for (const tx of g.txs) {
          if (
            tx.type === "Dividend" &&
            tx.accountingMethod === AUTO_DIVIDEND_METHOD
          ) {
            toDeleteIds.push(tx.id);
          }
        }
      }
      syncedSignatureCache.delete(instr.id);
      continue;
    }

    const splits = splitsByInstrument.get(instr.id) ?? [];
    for (const sp of splits) {
      sigParts.push(`sp:${sp.id}:${sp.exDate}:${sp.ratioNumerator}:${sp.ratioDenominator}`);
    }

    const nonDivSignature = `${earliestBuyDate}|${todayIso}|${sigParts.join(",")}`;
    const lastSig =
      !options.forceRefresh && !options.fetchImpl
        ? syncedSignatureCache.get(instr.id, now.getTime())
        : undefined;
    if (lastSig === nonDivSignature) {
      continue;
    }

    instrumentsToProcess.push({
      instr,
      earliestBuyDate,
      nonDivSignature,
      groups,
    });
  }

  if (instrumentsToProcess.length === 0 && toDeleteIds.length === 0) {
    return { insertedCount: 0, updatedCount: 0, deletedCount: 0 };
  }

  const fetchedEventsByInstrumentId = new Map<
    string,
    YahooDividendEvent[] | null
  >();
  await mapWithConcurrency(instrumentsToProcess, 8, async (item) => {
    const cacheKey = `${item.instr.symbol}::${item.earliestBuyDate}::${todayIso}`;
    const cachedEvents =
      !options.forceRefresh && !options.fetchImpl
        ? dividendEventsCache.get(cacheKey, now.getTime())
        : undefined;
    if (cachedEvents) {
      fetchedEventsByInstrumentId.set(item.instr.id, cachedEvents);
      return;
    }

    const events = await fetchYahooDividendEvents({
      symbol: item.instr.symbol,
      startDate: item.earliestBuyDate,
      endDate: todayIso,
      fetchImpl: options.fetchImpl,
    });
    if (events !== null && !options.fetchImpl) {
      dividendEventsCache.set(
        cacheKey,
        events,
        DIVIDEND_EVENTS_CACHE_TTL_MS,
        now.getTime(),
      );
    }
    fetchedEventsByInstrumentId.set(item.instr.id, events);
  });

  let insertedCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  const toInsert: (typeof transaction.$inferInsert)[] = [];

  for (const item of instrumentsToProcess) {
    const { instr, groups, nonDivSignature } = item;
    const rawEvents = fetchedEventsByInstrumentId.get(instr.id) ?? null;
    let events: YahooDividendEvent[];
    if (rawEvents !== null) {
      events = rawEvents;
    } else {
      // Offline / provider unreachable: preserve known dividend exDates & rates
      // from existing auto-dividend rows so valid rows are not wiped while trade
      // edits/deletions still recalculate or clean up accurately.
      const fallbackByDate = new Map<string, string>();
      for (const g of groups) {
        for (const tx of g.txs) {
          if (
            tx.type === "Dividend" &&
            tx.accountingMethod === AUTO_DIVIDEND_METHOD
          ) {
            const exKey =
              tx.accountingExecutionIds?.trim() ||
              formatInstantInOffset(new Date(tx.executedAt), tx.originalOffset)
                .localDate;
            if (exKey >= item.earliestBuyDate && exKey <= todayIso) {
              fallbackByDate.set(
                exKey,
                toDecimalString(toDecimal(tx.price).toDecimalPlaces(6), 6),
              );
            }
          }
        }
      }
      events = [...fallbackByDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([exDate, amount]) => ({ exDate, amount }));
    }
    const splits = splitsByInstrument.get(instr.id) ?? [];
    const taxPct = resolveDividendWithholdingTaxPercent({
      symbol: instr.symbol,
      currency: instr.currency,
      exchangeCode: instr.exchangeCode,
    });

    // Expand symbol-wide Sell All across portfolios on non-dividend transactions
    const expandedNonDiv = applySymbolWideSellAll(
      groups.map((g) => ({
        portfolioId: g.portfolioId,
        transactions: g.txs
          .filter((t) => t.type !== "Dividend")
          .map(mapDbTransactionToFifoInput),
      })),
      { symbol: instr.symbol, dividendMode: "cash", splits },
    );

    for (const group of groups) {
      const expandedLedger = expandedNonDiv.find(
        (l) => l.portfolioId === group.portfolioId,
      );
      const nonDivTxs = expandedLedger?.transactions ?? [];

      const manualDivDates: string[] = [];
      const autoDividendsByExDate = new Map<string, Transaction>();

      for (const tx of group.txs) {
        if (tx.type !== "Dividend") continue;
        const localDate = formatInstantInOffset(
          new Date(tx.executedAt),
          tx.originalOffset,
        ).localDate;
        if (tx.accountingMethod === AUTO_DIVIDEND_METHOD) {
          const exKey = tx.accountingExecutionIds?.trim() || localDate;
          if (autoDividendsByExDate.has(exKey)) {
            // Remove any unexpected duplicate auto-dividend for the same exDate
            toDeleteIds.push(tx.id);
          } else {
            autoDividendsByExDate.set(exKey, tx);
          }
        } else {
          manualDivDates.push(localDate);
        }
      }

      const eligibleExDates = new Set<string>();

      for (const ev of events) {
        // Skip if a manual dividend already exists within +-5 days of exDate
        const hasManualMatch = manualDivDates.some(
          (md) => daysBetweenIsoDates(md, ev.exDate) <= 5,
        );
        if (hasManualMatch) {
          continue;
        }

        // Shares must be held at the end of the day prior to exDate
        const priorDay = addCalendarDays(ev.exDate, -1);
        const fifoBeforeEx = evaluateFifoLedger(nonDivTxs, {
          symbol: instr.symbol,
          dividendMode: "cash",
          splits,
          asOfDate: priorDay,
          onValidationError: "clamp-and-flag",
        });

        const sharesHeld = fifoBeforeEx.sharesHeld;
        if (!sharesHeld.gt(QUANTITY_EPSILON)) {
          continue;
        }

        const divPerShare = toDecimal(ev.amount);
        const grossAmount = sharesHeld.mul(divPerShare).toDecimalPlaces(6);
        if (!grossAmount.gt(ZERO)) {
          continue;
        }

        eligibleExDates.add(ev.exDate);

        const quantityStr = toDecimalString(grossAmount, 12);
        const priceStr = toDecimalString(divPerShare, 12);
        const commissionRaw = `${taxPct}%`;
        const commissionValue = toDecimalString(toDecimal(taxPct), 12);
        const executedAt = new Date(`${ev.exDate}T09:00:00+08:00`);
        const currencyPrefix = instr.currency.toUpperCase() === "SGD" ? "S$" : "$";
        const taxNote = taxPct > 0 ? `${taxPct}% WHT` : "0% tax";
        const notes = `Auto-dividend · ${formatCompactDec(toDecimalString(sharesHeld, 6))} sh × ${currencyPrefix}${formatCompactDec(ev.amount)}/sh (${taxNote})`;

        const existingAuto = autoDividendsByExDate.get(ev.exDate);
        if (existingAuto) {
          const sameQty =
            toDecimal(existingAuto.quantity).toDecimalPlaces(6).eq(grossAmount);
          const samePrice =
            toDecimal(existingAuto.price)
              .toDecimalPlaces(6)
              .eq(divPerShare.toDecimalPlaces(6));
          const sameTax =
            Number(existingAuto.commissionValue ?? 0) === taxPct &&
            Boolean(existingAuto.commissionIsPercent);

          if (!sameQty || !samePrice || !sameTax) {
            const dedupeHash = computeTransactionDedupeHash({
              portfolioName: group.portfolioName,
              symbol: instr.symbol,
              type: "Dividend",
              quantity: quantityStr,
              price: priceStr,
              executedAt,
            });
            await database
              .update(transaction)
              .set({
                quantity: quantityStr,
                price: priceStr,
                commissionRaw,
                commissionValue,
                commissionIsPercent: true,
                totalCostSgd: null,
                notes,
                dedupeHash,
                updatedAt: new Date(),
              })
              .where(eq(transaction.id, existingAuto.id));
            updatedCount += 1;
          }
        } else {
          const dedupeHash = computeTransactionDedupeHash({
            portfolioName: group.portfolioName,
            symbol: instr.symbol,
            type: "Dividend",
            quantity: quantityStr,
            price: priceStr,
            executedAt,
          });
          toInsert.push({
            portfolioId: group.portfolioId,
            instrumentId: instr.id,
            type: "Dividend",
            quantity: quantityStr,
            price: priceStr,
            commissionRaw,
            commissionValue,
            commissionIsPercent: true,
            executedAt,
            originalOffset: "+0800",
            currency: instr.currency,
            accountingMethod: AUTO_DIVIDEND_METHOD,
            accountingExecutionIds: ev.exDate,
            notes,
            dedupeHash,
          });
        }
      }

      // Delete any stale auto-dividend whose exDate is no longer eligible
      for (const [exDate, autoRow] of autoDividendsByExDate.entries()) {
        if (!eligibleExDates.has(exDate)) {
          toDeleteIds.push(autoRow.id);
        }
      }
    }

    if (rawEvents !== null && !options.fetchImpl) {
      syncedSignatureCache.set(
        instr.id,
        nonDivSignature,
        DIVIDEND_EVENTS_CACHE_TTL_MS,
        now.getTime(),
      );
    }
  }

  if (toDeleteIds.length > 0) {
    await database
      .delete(transaction)
      .where(inArray(transaction.id, toDeleteIds));
    deletedCount += toDeleteIds.length;
  }

  if (toInsert.length > 0) {
    await database.insert(transaction).values(toInsert);
    insertedCount += toInsert.length;
  }

  if (insertedCount > 0 || updatedCount > 0) {
    await backfillMissingTransactionSgdTotals({
      db: database,
      fetchImpl: options.fetchImpl,
    });
  }

  return { insertedCount, updatedCount, deletedCount };
}
