interface SkeletonProps {
  className?: string;
}

/** Shimmering placeholder. Always preferred over a spinner on a blank screen. */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

