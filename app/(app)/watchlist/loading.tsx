import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function WatchlistLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading watchlist">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28 rounded-[10px]" />
          <Skeleton className="h-9 w-28 rounded-[10px]" />
          <Skeleton className="h-9 w-32 rounded-[10px]" />
        </div>
      </div>

      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9.5 w-60 max-w-full rounded-[10px]" />
          <Skeleton className="h-9.5 w-52 max-w-full rounded-[10px]" />
        </div>

        <div className="space-y-3 pt-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center justify-between gap-4 border-b border-line pb-3 last:border-b-0 last:pb-0"
            >
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3.5 w-40" />
              </div>
              <Skeleton className="hidden h-7 w-24 sm:block" />
              <div className="space-y-1.5 text-right">
                <Skeleton className="ml-auto h-4 w-20" />
                <Skeleton className="ml-auto h-3.5 w-16" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

