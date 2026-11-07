/**
 * Plain CSV template generator for investors who want to import transactions
 * from spreadsheets without using the 19-column Microsoft Start format.
 */

export const PLAIN_CSV_TEMPLATE_HEADER =
  "Symbol,Name,Exchange,Portfolio,Currency,Type,Shares,Price,Commission,Date,Time,Notes";

export function generatePlainCsvTemplate(): string {
  const sampleLines = [
    PLAIN_CSV_TEMPLATE_HEADER,
    '"AAPL","Apple Inc.","NMS","US Stocks","USD","Buy","10","185.50","1.00","2025-02-05","09:30:00","Initial US tech position"',
    '"ES3.SI","SPDR Straits Times Index ETF","SES","SG Stocks","SGD","Buy","100","3.32","2.50","2025-02-10","10:15:00","SGX index core holding"',
    '"ES3.SI","SPDR Straits Times Index ETF","SES","SG Stocks","SGD","Dividend","6.50","3.40","0","2025-08-25","09:00:00","Semi-annual cash distribution"',
  ];

  return `${sampleLines.join("\n")}\n`;
}

