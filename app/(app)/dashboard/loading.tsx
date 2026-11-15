import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      {/* Hero Band Skeleton */}
      <Card className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-6 w-64 max-w-full" />
            <Skeleton className="h-3.5 w-48 max-w-full" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-40 rounded-[10px]" />
            <Skeleton className="h-9 w-24 rounded-[10px]" />
            <Skeleton className="h-9 w-22 rounded-[10px]" />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-9 w-44" />
              <Skeleton className="h-6 w-32 rounded-[8px]" />
            </div>
          </div>
          <Skeleton className="h-14 w-36 rounded-[12px]" />
        </div>
      </Card>

      {/* 3 Secondary Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Card key={index} className="space-y-2.5 p-4 sm:p-5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-3.5 w-32" />
          </Card>
        ))}
      </div>

      {/* Equal-height Valuation Chart & Compact Allocation Donut */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-stretch">
        <Card className="flex h-full flex-col space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-8 w-44 rounded-[10px]" />
          </div>
          <Skeleton className="h-[270px] w-full flex-1 rounded-[12px]" />
        </Card>

        <Card className="flex h-full flex-col space-y-4 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-8 w-full rounded-[10px]" />
          <div className="my-auto flex flex-col items-center gap-3 py-2">
            <Skeleton className="h-[196px] w-[196px] rounded-full" />
            <Skeleton className="h-8 w-36 rounded-[10px]" />
          </div>
        </Card>
      </div>

      {/* Benchmark Comparison */}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-6 w-20 rounded-[8px]" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-[10px]" />
          ))}
        </div>
      </Card>
    </div>
  );
}
