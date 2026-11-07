/**
 * Timezone-offset-preserving date and time helpers.
 *
 * The CSV stores dates as `"YYYY-MM-DD GMT+0800"` and times as `"HH:MM:SS"`.
 * Internally we store `executedAt` as a UTC `Date` instant plus `originalOffset`
 * (for example `"+0800"`) so chronological sorting is exact across timezones
 * while exports reproduce the exact original date, time, and offset strings.
 */

export interface ParsedOffsetTimestamp {
  /** Exact UTC instant. */
  executedAt: Date;
  /** Canonical 5-character offset string such as `"+0800"` or `"-0400"`. */
  originalOffset: string;
  /** Calendar date in the original offset (`YYYY-MM-DD`), used for FX lookup. */
  localDate: string;
  /** Wall-clock time in the original offset (`HH:MM:SS`). */
  localTime: string;
}

const OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/;
const CSV_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\s+GMT([+-]\d{4}))?$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Normalises an offset like `"+08:00"` or `"+0800"` into `"+0800"`. */
export function normalizeUtcOffset(offset: string): string {
  const match = OFFSET_PATTERN.exec(offset.trim());
  if (!match) {
    throw new Error(
      `Invalid UTC offset "${offset}". Expected a format like +0800 or -0500.`,
    );
  }
  const [, sign, hours, minutes] = match;
  const hoursNum = Number(hours);
  const minutesNum = Number(minutes);
  if (hoursNum > 14 || minutesNum > 59) {
    throw new Error(`UTC offset "${offset}" is out of range.`);
  }
  return `${sign}${hours}${minutes}`;
}

/** Converts a normalized offset (`"+0800"`) to signed minutes east of UTC. */
export function offsetToMinutes(normalizedOffset: string): number {
  const match = OFFSET_PATTERN.exec(normalizedOffset);
  if (!match) {
    throw new Error(`Invalid normalized offset "${normalizedOffset}".`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes);
}

/**
 * Combines a date string (`"2021-11-03 GMT+0800"` or `"2021-11-03"`), a time
 * string (`"08:13:00"` or `"08:13"`), and a fallback offset (default `"+0800"`
 * for Asia/Singapore) into a single UTC instant plus preserved offset metadata.
 */
export function parseDateAndTimeWithOffset(
  dateInput: string,
  timeInput: string | null | undefined,
  fallbackOffset: string = "+0800",
): ParsedOffsetTimestamp {
  const dateMatch = CSV_DATE_PATTERN.exec(dateInput.trim());
  if (!dateMatch) {
    throw new Error(
      `Invalid transaction date "${dateInput}". Expected YYYY-MM-DD or YYYY-MM-DD GMT+0800.`,
    );
  }

  const localDate = dateMatch[1];
  const embeddedOffset = dateMatch[2];
  const originalOffset = normalizeUtcOffset(embeddedOffset ?? fallbackOffset);

  const rawTime =
    timeInput && timeInput.trim() !== "" ? timeInput.trim() : "00:00:00";
  const timeMatch = TIME_PATTERN.exec(rawTime);
  if (!timeMatch) {
    throw new Error(
      `Invalid transaction time "${timeInput}". Expected HH:MM or HH:MM:SS.`,
    );
  }

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? "00");
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`Transaction time "${rawTime}" is out of range.`);
  }

  const [yearStr, monthStr, dayStr] = localDate.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  // Validate that the calendar date itself is real (e.g. reject 2023-02-30).
  const utcWallClock = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, seconds),
  );
  if (
    utcWallClock.getUTCFullYear() !== year ||
    utcWallClock.getUTCMonth() !== month - 1 ||
    utcWallClock.getUTCDate() !== day
  ) {
    throw new Error(`Calendar date "${localDate}" does not exist.`);
  }

  const offsetMinutes = offsetToMinutes(originalOffset);
  const instantMilliseconds =
    utcWallClock.getTime() - offsetMinutes * 60 * 1000;

  const localTime = [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");

  return {
    executedAt: new Date(instantMilliseconds),
    originalOffset,
    localDate,
    localTime,
  };
}

/**
 * Splits a UTC `Date` instant back into its local date (`YYYY-MM-DD`), CSV date
 * (`YYYY-MM-DD GMT+0800`), and time (`HH:MM:SS`) in the stored original offset.
 */
export function formatInstantInOffset(
  instant: Date,
  originalOffset: string = "+0800",
): {
  localDate: string;
  csvDate: string;
  localTime: string;
  offset: string;
} {
  const normalized = normalizeUtcOffset(originalOffset);
  const offsetMinutes = offsetToMinutes(normalized);
  const shifted = new Date(instant.getTime() + offsetMinutes * 60 * 1000);

  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");

  const localDate = `${year}-${month}-${day}`;
  return {
    localDate,
    csvDate: `${localDate} GMT${normalized}`,
    localTime: `${hours}:${minutes}:${seconds}`,
    offset: normalized,
  };
}

