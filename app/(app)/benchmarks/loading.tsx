import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function BenchmarksLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading benchmarks">
      {/* Header + Scope Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Skeleton className="h-9.5 w-44 rounded-full" />
          <Skeleton className="h-9.5 w-32 rounded-full" />
        </div>
      </div>

      {/* Preset Chips & Controls */}
      <Card className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-24 rounded-full" />
            ))}
          </div>
          <Skeleton className="h-9 w-56 rounded-full" />
        </div>
        <Skeleton className="h-[320px] w-full rounded-[12px]" />
      </Card>

      {/* CAPM & Period Return Cards */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <Card key={index} className="space-y-3 p-5 sm:p-6">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-40 w-full rounded-[12px]" />
          </Card>
        ))}
      </div>
    </div>
  );
}

