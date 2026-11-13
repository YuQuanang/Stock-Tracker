import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function StockDetailLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading stock detail">
      {/* Back button + Title + Price Header */}
      <div className="space-y-4">
        <Skeleton className="h-8 w-28 rounded-full" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <Skeleton className="h-4 w-56 max-w-full" />
            <div className="flex items-baseline gap-3 pt-1">
              <Skeleton className="h-9 w-36" />
              <Skeleton className="h-6 w-28 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-9.5 w-36 rounded-full" />
        </div>
      </div>

      {/* Price Chart Card */}
      <Card className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-8 w-72 max-w-full rounded-full" />
        </div>
        <Skeleton className="h-[320px] w-full rounded-[12px]" />
      </Card>

      {/* Position Summary + Key Statistics */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <Card key={index} className="space-y-4 p-5 sm:p-6">
            <Skeleton className="h-5 w-40" />
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, cellIndex) => (
                <div key={cellIndex} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-5 w-28" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

