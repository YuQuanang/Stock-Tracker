import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function HoldingsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading holdings">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-9.5 w-36 rounded-[10px]" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="space-y-2.5 p-4 sm:p-5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3.5 w-20" />
          </Card>
        ))}
      </div>

      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9.5 w-56 rounded-[10px]" />
          <Skeleton className="h-9.5 w-44 rounded-[10px]" />
        </div>
        <div className="space-y-3 pt-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center justify-between gap-4 border-b border-line pb-3 last:border-b-0 last:pb-0"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-[10px]" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-36" />
                </div>
              </div>
              <div className="space-y-1.5 text-right">
                <Skeleton className="ml-auto h-4 w-24" />
                <Skeleton className="ml-auto h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

