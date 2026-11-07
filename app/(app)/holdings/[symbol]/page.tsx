import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { StockDetailView } from "@/components/holdings/stock-detail-view";
import { getStockDetailSnapshot } from "@/lib/services/holdings";

interface StockDetailPageProps {
  params: Promise<{ symbol: string }>;
}

export async function generateMetadata({
  params,
}: StockDetailPageProps): Promise<Metadata> {
  const { symbol: rawSymbol } = await params;
  const decoded = decodeURIComponent(rawSymbol).trim();
  return {
    title: decoded ? `${decoded} · Holdings` : "Holding Detail",
  };
}

export default async function StockDetailPage({
  params,
}: StockDetailPageProps) {
  await connection();
  const { symbol: rawSymbol } = await params;
  const symbol = decodeURIComponent(rawSymbol);

  const snapshot = await getStockDetailSnapshot(symbol);
  if (!snapshot) {
    notFound();
  }

  return <StockDetailView {...snapshot} />;
}

