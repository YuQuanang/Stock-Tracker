/**
 * Exchange trading-hours and market-open status logic.
 *
 * Determines whether US exchanges (`America/New_York`, 09:30-16:00 ET) and
 * Singapore Exchange (`Asia/Singapore`, 09:00-17:00 SGT) are currently in
 * regular trading hours, closed for the evening, or closed for a weekend or
 * public holiday.
 */

export type MarketRegion = "US" | "SG";

export interface MarketSessionStatus {
  region: MarketRegion;
  timezone: string;
  isOpen: boolean;
  reason: "regular-session" | "weekend" | "holiday" | "outside-hours";
}

export interface ExtendedMarketSessionStatus extends MarketSessionStatus {
  /** ISO-8601 UTC timestamp of the next regular-session open (null when open). */
  nextOpenAt: string | null;
  /** Human-readable next open in `Asia/Singapore` time, e.g. `"Mon 22:30 SGT"`. */
  nextOpenSgtLabel: string | null;
  /** Human-readable regular-session close in `Asia/Singapore` when open, e.g. `"05:00 SGT"`. */
  closesAtSgtLabel: string | null;
}

export interface CombinedMarketOverview {
  asOf: string;
  sgtDate: string;
  anyMarketOpen: boolean;
  /** Concise Apple-style badge text for the app shell. */
  badgeLabel: string;
  /** Detailed subtitle explaining both venues in SGT. */
  detailLabel: string;
  us: ExtendedMarketSessionStatus;
  sg: ExtendedMarketSessionStatus;
  /** Recommended client short-polling intervals (`null` = do not poll). */
  recommendedPollMs: {
    visibleMs: number | null;
    hiddenMs: number | null;
  };
}

/** Known fixed/observed NYSE & SGX market holidays for 2025-2027 (`YYYY-MM-DD`). */
const US_MARKET_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

const SG_MARKET_HOLIDAYS = new Set([
  // 2026 Singapore public holidays falling on weekdays
  "2026-01-01",
  "2026-02-17",
  "2026-02-18",
  "2026-03-21",
  "2026-04-03",
  "2026-05-01",
  "2026-05-27",
  "2026-06-01",
  "2026-08-10",
  "2026-11-09",
  "2026-12-25",
]);

function getWallClockInTimezone(
  instant: Date,
  timeZone: string,
): {
  isoDate: string;
  weekday: string;
  minutesSinceMidnight: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(instant);
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  const year = byType.get("year") ?? "1970";
  const month = byType.get("month") ?? "01";
  const day = byType.get("day") ?? "01";
  const weekday = byType.get("weekday") ?? "Mon";
  const hour = Number(byType.get("hour") ?? "0");
  const minute = Number(byType.get("minute") ?? "0");

  return {
    isoDate: `${year}-${month}-${day}`,
    weekday,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

export function inferMarketRegion(
  symbol: string,
  exchangeCode?: string | null,
): MarketRegion {
  const upperSymbol = symbol.trim().toUpperCase();
  const upperExchange = (exchangeCode ?? "").trim().toUpperCase();
  if (
    upperSymbol.endsWith(".SI") ||
    upperSymbol === "^STI" ||
    upperExchange === "SES" ||
    upperExchange === "SGX"
  ) {
    return "SG";
  }
  return "US";
}

/** Evaluates whether the market for `region` is open at `now`. */
export function getMarketSessionStatus(
  region: MarketRegion,
  now: Date = new Date(),
): MarketSessionStatus {
  const timezone = region === "SG" ? "Asia/Singapore" : "America/New_York";
  const holidays = region === "SG" ? SG_MARKET_HOLIDAYS : US_MARKET_HOLIDAYS;
  const openMinute = region === "SG" ? 9 * 60 : 9 * 60 + 30; // 09:00 SGT vs 09:30 ET
  const closeMinute = region === "SG" ? 17 * 60 : 16 * 60; // 17:00 SGT vs 16:00 ET

  const clock = getWallClockInTimezone(now, timezone);

  if (clock.weekday === "Sat" || clock.weekday === "Sun") {
    return { region, timezone, isOpen: false, reason: "weekend" };
  }

  if (holidays.has(clock.isoDate)) {
    return { region, timezone, isOpen: false, reason: "holiday" };
  }

  const inSession =
    clock.minutesSinceMidnight >= openMinute &&
    clock.minutesSinceMidnight < closeMinute;

  return {
    region,
    timezone,
    isOpen: inSession,
    reason: inSession ? "regular-session" : "outside-hours",
  };
}

/** Returns today's calendar date (`YYYY-MM-DD`) in `Asia/Singapore`. */
export function getSingaporeDateString(now: Date = new Date()): string {
  return getWallClockInTimezone(now, "Asia/Singapore").isoDate;
}

function addDaysToIsoDate(isoDate: string, daysToAdd: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + daysToAdd));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getIsoWeekday(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function resolveRegularOpenUtcForDate(
  isoDate: string,
  region: MarketRegion,
): Date {
  if (region === "SG") {
    return new Date(`${isoDate}T09:00:00+08:00`);
  }

  // US regular session opens at 09:30 America/New_York:
  // 13:30 UTC during EDT (UTC-4) and 14:30 UTC during EST (UTC-5).
  const edtCandidate = new Date(`${isoDate}T13:30:00.000Z`);
  const edtWall = getWallClockInTimezone(edtCandidate, "America/New_York");
  if (edtWall.isoDate === isoDate && edtWall.minutesSinceMidnight === 9 * 60 + 30) {
    return edtCandidate;
  }
  return new Date(`${isoDate}T14:30:00.000Z`);
}

function resolveRegularCloseUtcForDate(
  isoDate: string,
  region: MarketRegion,
): Date {
  if (region === "SG") {
    return new Date(`${isoDate}T17:00:00+08:00`);
  }

  // US regular session closes at 16:00 America/New_York:
  // 20:00 UTC during EDT (UTC-4) and 21:00 UTC during EST (UTC-5).
  const edtCandidate = new Date(`${isoDate}T20:00:00.000Z`);
  const edtWall = getWallClockInTimezone(edtCandidate, "America/New_York");
  if (edtWall.isoDate === isoDate && edtWall.minutesSinceMidnight === 16 * 60) {
    return edtCandidate;
  }
  return new Date(`${isoDate}T21:00:00.000Z`);
}

function formatDayAndTimeInSgt(targetInstant: Date): string {
  const targetSgt = getWallClockInTimezone(targetInstant, "Asia/Singapore");
  const hh = String(Math.floor(targetSgt.minutesSinceMidnight / 60)).padStart(
    2,
    "0",
  );
  const mm = String(targetSgt.minutesSinceMidnight % 60).padStart(2, "0");
  return `${targetSgt.weekday} ${hh}:${mm} SGT`;
}

/**
 * Computes the next regular-session open timestamp (when closed) or current
 * session close time (when open) for `region`, formatted in `Asia/Singapore`
 * (`UTC+8`) with explicit weekday and 24-hour time.
 */
export function getExtendedMarketSessionStatus(
  region: MarketRegion,
  now: Date = new Date(),
): ExtendedMarketSessionStatus {
  const base = getMarketSessionStatus(region, now);
  const localToday = getWallClockInTimezone(now, base.timezone).isoDate;

  if (base.isOpen) {
    const closeInstant = resolveRegularCloseUtcForDate(localToday, region);
    return {
      ...base,
      nextOpenAt: null,
      nextOpenSgtLabel: null,
      closesAtSgtLabel: formatDayAndTimeInSgt(closeInstant),
    };
  }

  const holidays = region === "SG" ? SG_MARKET_HOLIDAYS : US_MARKET_HOLIDAYS;

  for (let offset = 0; offset <= 14; offset += 1) {
    const candidateDate = addDaysToIsoDate(localToday, offset);
    const dayOfWeek = getIsoWeekday(candidateDate);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }
    if (holidays.has(candidateDate)) {
      continue;
    }

    const openInstant = resolveRegularOpenUtcForDate(candidateDate, region);
    if (openInstant.getTime() > now.getTime()) {
      return {
        ...base,
        nextOpenAt: openInstant.toISOString(),
        nextOpenSgtLabel: formatDayAndTimeInSgt(openInstant),
        closesAtSgtLabel: null,
      };
    }
  }

  return {
    ...base,
    nextOpenAt: null,
    nextOpenSgtLabel: null,
    closesAtSgtLabel: null,
  };
}

/**
 * Evaluates both US (`NYSE`/`NASDAQ`) and Singapore (`SGX`) sessions at `now`
 * and produces the unified header badge + client short-polling schedule.
 *
 * When both markets are closed (weekends, public holidays, and overnight SGT
 * gaps), `recommendedPollMs` returns `{ visibleMs: null, hiddenMs: null }` so
 * the browser performs zero background polling.
 */
export function getCombinedMarketOverview(
  now: Date = new Date(),
): CombinedMarketOverview {
  const us = getExtendedMarketSessionStatus("US", now);
  const sg = getExtendedMarketSessionStatus("SG", now);
  const anyMarketOpen = us.isOpen || sg.isOpen;

  let badgeLabel: string;
  let detailLabel: string;

  if (us.isOpen && sg.isOpen) {
    badgeLabel = "US & SGX open";
    detailLabel = "US and Singapore regular sessions are open.";
  } else if (sg.isOpen) {
    badgeLabel = "SGX open";
    detailLabel = us.nextOpenSgtLabel
      ? `SGX open · US opens ${us.nextOpenSgtLabel}`
      : "SGX regular session open.";
  } else if (us.isOpen) {
    badgeLabel = "US market open";
    detailLabel = sg.nextOpenSgtLabel
      ? `US open · SGX opens ${sg.nextOpenSgtLabel}`
      : "US regular session open.";
  } else {
    // Both markets are closed — display whichever market opens sooner in SGT.
    const candidates = [
      us.nextOpenAt
        ? { venue: "US", at: us.nextOpenAt, label: us.nextOpenSgtLabel }
        : null,
      sg.nextOpenAt
        ? { venue: "SGX", at: sg.nextOpenAt, label: sg.nextOpenSgtLabel }
        : null,
    ].filter((c): c is { venue: string; at: string; label: string | null } => c !== null);

    candidates.sort((a, b) => a.at.localeCompare(b.at));
    const earliest = candidates[0];

    badgeLabel = earliest?.label
      ? `Markets closed · Opens ${earliest.label}`
      : "Markets closed";

    const sgSummary = sg.nextOpenSgtLabel
      ? `SGX opens ${sg.nextOpenSgtLabel}`
      : "SGX closed";
    const usSummary = us.nextOpenSgtLabel
      ? `US opens ${us.nextOpenSgtLabel}`
      : "US closed";
    detailLabel = `${sgSummary} · ${usSummary}`;
  }

  return {
    asOf: now.toISOString(),
    sgtDate: getSingaporeDateString(now),
    anyMarketOpen,
    badgeLabel,
    detailLabel,
    us,
    sg,
    recommendedPollMs: anyMarketOpen
      ? { visibleMs: 12_000, hiddenMs: 45_000 }
      : { visibleMs: null, hiddenMs: null },
  };
}

const MONTH_SHORT_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Formats `2026-11-06` into `"6 Nov"` (same year) or `"6 Nov 2021"` (past year). */
export function formatShortMarketDate(
  isoDate: string,
  referenceYear?: number,
): string {
  const [yearStr, monthStr, dayStr] = isoDate.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  const monthLabel = MONTH_SHORT_NAMES[monthIndex] ?? monthStr;
  const currentYear = referenceYear ?? new Date().getUTCFullYear();

  if (year === currentYear) {
    return `${day} ${monthLabel}`;
  }
  return `${day} ${monthLabel} ${year}`;
}

