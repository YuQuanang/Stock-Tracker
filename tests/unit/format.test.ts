import { describe, expect, it } from "vitest";
import { formatCompactFreshness } from "@/lib/format";

describe("formatCompactFreshness", () => {
  it("strips verbose close prefixes while preserving the date", () => {
    expect(formatCompactFreshness("Last close, 13 Nov")).toBe("13 Nov");
    expect(formatCompactFreshness("Cached close, 6 Nov")).toBe("6 Nov");
    expect(formatCompactFreshness("Close on 2 Jan")).toBe("2 Jan");
  });

  it("compacts status labels concisely and handles empty input", () => {
    expect(formatCompactFreshness("Delayed ~15 min")).toBe("Delayed");
    expect(formatCompactFreshness("Manual price")).toBe("Manual");
    expect(formatCompactFreshness("Delisted / Worthless")).toBe("Delisted");
    expect(formatCompactFreshness("Price unavailable")).toBe("Unavailable");
    expect(formatCompactFreshness("Price not found")).toBe("Not found");
    expect(formatCompactFreshness("Live")).toBe("Live");
    expect(formatCompactFreshness(null)).toBe("—");
    expect(formatCompactFreshness("")).toBe("—");
  });
});

