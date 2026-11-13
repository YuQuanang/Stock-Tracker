import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      {/* Header + Scope Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Skeleton className="h-9.5 w-44 rounded-full" />
          <Skeleton className="h-9.5 w-32 rounded-full" />
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="space-y-2.5 p-4 sm:p-5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3.5 w-28" />
          </Card>
        ))}
      </div>

      {/* Row 2: Equal-height Valuation Chart & Compact Allocation Donut */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-stretch">
        <Card className="flex h-full flex-col space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3.5 w-52 max-w-full" />
            </div>
            <Skeleton className="h-8 w-44 rounded-full" />
          </div>
          <Skeleton className="h-[260px] w-full flex-1 rounded-[12px]" />
        </Card>

        <Card className="flex h-full flex-col space-y-4 p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-8 w-full rounded-full" />
          <div className="my-auto flex flex-col items-center gap-3 py-2">
            <Skeleton className="h-[196px] w-[196px] rounded-full" />
            <Skeleton className="h-7 w-36 rounded-full" />
          </div>
        </Card>
      </div>

      {/* Row 3: Benchmark Comparison */}
      <Card className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-[10px]" />
          ))}
        </div>
      </Card>

      {/* Row 4: Today's Movers + All-Time Open Performers */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, cardIndex) => (
          <Card key={cardIndex} className="space-y-4 p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, rowIndex) => (
                <div
                  key={rowIndex}
                  className="flex items-center justify-between gap-3"
                >
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* Row 5: Dividends & Risk + Collapsed Data Quality */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <Card className="space-y-3 p-4 sm:p-5">
          <Skeleton className="h-4 w-36" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-14 w-full rounded-[12px]" />
            <Skeleton className="h-14 w-full rounded-[12px]" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-12 w-full rounded-[10px]" />
            <Skeleton className="h-12 w-full rounded-[10px]" />
            <Skeleton className="h-12 w-full rounded-[10px]" />
          </div>
        </Card>
        <Card className="flex items-center justify-between gap-3 p-4 sm:p-5">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3.5 w-36" />
          </div>
          <Skeleton className="h-8 w-20 rounded-full" />
        </Card>
      </div>
    </div>
  );
}

