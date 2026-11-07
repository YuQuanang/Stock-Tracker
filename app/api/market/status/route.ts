import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getCombinedMarketOverview } from "@/lib/market-data/hours";
import { globalProviderChain } from "@/lib/market-data/provider-chain";

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) {
    return denied;
  }

  const now = new Date();
  return NextResponse.json({
    market: getCombinedMarketOverview(now),
    providers: globalProviderChain.getHealthSnapshots(now.getTime()),
  });
}

