import { DATA_ATTRIBUTIONS, DISCLAIMER_TEXT } from "@/lib/attribution";

/** Disclaimer plus a data-attribution line for every provider used. */
export function Footer() {
  return (
    <footer className="mt-12 border-t border-line pt-6 text-[12px] leading-relaxed text-ink-3">
      <p>{DISCLAIMER_TEXT}</p>
      <p className="mt-2">
        Data:{" "}
        {DATA_ATTRIBUTIONS.map((source, index) => (
          <span key={source.name}>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-2 underline decoration-line underline-offset-2 hover:text-accent"
              title={source.usedFor}
            >
              {source.name}
            </a>
            {index < DATA_ATTRIBUTIONS.length - 1 ? " · " : ""}
          </span>
        ))}
        .
      </p>
    </footer>
  );
}

