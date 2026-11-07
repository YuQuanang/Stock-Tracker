/**
 * Data-source attribution shown in the footer, and the "not financial advice"
 * disclaimer. Add a line here whenever a new provider is introduced.
 */
export interface DataAttribution {
  name: string;
  url: string;
  usedFor: string;
}

export const DATA_ATTRIBUTIONS: DataAttribution[] = [
  {
    name: "Yahoo Finance",
    url: "https://finance.yahoo.com",
    usedFor: "quotes, history, company metadata (unofficial, may be delayed)",
  },
  {
    name: "Twelve Data",
    url: "https://twelvedata.com",
    usedFor: "ticker and company-name search suggestions only (never displayed prices)",
  },
  {
    name: "Finnhub",
    url: "https://finnhub.io",
    usedFor: "fallback US quotes, search, and company profiles",
  },
  {
    name: "Stooq",
    url: "https://stooq.com",
    usedFor: "fallback end-of-day prices",
  },
  {
    name: "Frankfurter (ECB reference rates)",
    url: "https://frankfurter.dev",
    usedFor: "USD/SGD exchange rates",
  },
];

export const DISCLAIMER_TEXT =
  "Folio is a personal record-keeping tool, not financial advice. Prices may be delayed or unavailable; always verify against your broker.";

