/**
 * Resilient Market-Data Provider Chain with Per-Provider Circuit Breakers
 * and Exponential Backoff.
 *
 * Why this exists:
 * Free market-data endpoints (Yahoo Finance, Finnhub, Stooq, Frankfurter) can
 * transiently rate-limit (HTTP 429) or time out. When fetching a batch of 30+
 * holdings, a naive fallback loop would hammer a rate-limited primary provider
 * 30 times before falling back on each symbol.
 *
 * How the circuit breaker works:
 *  - `"not_found"` errors (a ticker simply isn't listed on that venue) NEVER
 *    trip the provider's circuit breaker — the provider itself is healthy.
 *  - `"rate_limit"` (HTTP 429) opens the circuit immediately for at least 30s,
 *    doubling on repeated 429s up to `maxCooldownMs` (5 minutes).
 *  - `"network"` / `"upstream"` errors increment `consecutiveFailures` and open
 *    the circuit once `failureThreshold` (default 3) is reached, backing off
 *    exponentially (`baseCooldownMs * 2^(failures - threshold)`).
 *  - If every candidate provider currently has an open circuit, the chain
 *    probes the provider whose cooldown expires soonest (half-open recovery)
 *    so the system self-heals without getting permanently stuck.
 */
import { MarketDataError } from "@/lib/market-data/errors";

export interface ProviderStep<T> {
  /** Stable provider identifier, e.g. `"yahoo"`, `"finnhub"`, `"stooq"`. */
  provider: string;
  /** Async function that fetches the data from this provider. */
  execute: () => Promise<T>;
}

export interface ProviderHealthSnapshot {
  provider: string;
  state: "closed" | "open";
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}

interface InternalCircuitState {
  consecutiveFailures: number;
  openUntilMs: number;
  lastError: string | null;
  lastSuccessMs: number | null;
}

export interface ProviderChainOptions {
  /** Consecutive network/upstream failures before opening circuit (default 3). */
  failureThreshold?: number;
  /** Initial cooldown duration in milliseconds (default 15,000 ms). */
  baseCooldownMs?: number;
  /** Minimum cooldown on HTTP 429 rate-limit responses (default 30,000 ms). */
  rateLimitCooldownMs?: number;
  /** Maximum backoff cap in milliseconds (default 300,000 ms = 5 minutes). */
  maxCooldownMs?: number;
}

export class ProviderChain {
  private readonly circuits = new Map<string, InternalCircuitState>();
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(options: ProviderChainOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.baseCooldownMs = options.baseCooldownMs ?? 15_000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 30_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 300_000;
  }

  private getOrCreateState(provider: string): InternalCircuitState {
    const key = provider.toLowerCase();
    const existing = this.circuits.get(key);
    if (existing) {
      return existing;
    }
    const created: InternalCircuitState = {
      consecutiveFailures: 0,
      openUntilMs: 0,
      lastError: null,
      lastSuccessMs: null,
    };
    this.circuits.set(key, created);
    return created;
  }

  public isCircuitOpen(provider: string, nowMs: number = Date.now()): boolean {
    const state = this.circuits.get(provider.toLowerCase());
    if (!state) {
      return false;
    }
    return state.openUntilMs > nowMs;
  }

  public recordSuccess(provider: string, nowMs: number = Date.now()): void {
    const state = this.getOrCreateState(provider);
    state.consecutiveFailures = 0;
    state.openUntilMs = 0;
    state.lastError = null;
    state.lastSuccessMs = nowMs;
  }

  public recordFailure(
    provider: string,
    error: unknown,
    nowMs: number = Date.now(),
  ): void {
    // Missing-symbol responses mean the provider is reachable and working;
    // do not penalize its circuit state for other symbols.
    if (error instanceof MarketDataError && error.kind === "not_found") {
      return;
    }

    const state = this.getOrCreateState(provider);
    state.consecutiveFailures += 1;
    state.lastError =
      error instanceof Error ? error.message : "Unknown provider failure";

    if (error instanceof MarketDataError && error.kind === "rate_limit") {
      const exponent = Math.max(0, state.consecutiveFailures - 1);
      const backoff = Math.min(
        this.maxCooldownMs,
        this.rateLimitCooldownMs * Math.pow(2, exponent),
      );
      state.openUntilMs = nowMs + backoff;
      return;
    }

    if (state.consecutiveFailures >= this.failureThreshold) {
      const exponent = state.consecutiveFailures - this.failureThreshold;
      const backoff = Math.min(
        this.maxCooldownMs,
        this.baseCooldownMs * Math.pow(2, exponent),
      );
      state.openUntilMs = nowMs + backoff;
    }
  }

  /**
   * Executes `steps` in priority order, skipping providers whose circuit is
   * currently open. If every step has an open circuit, probes the step whose
   * cooldown expires soonest so recovery happens automatically.
   */
  public async execute<T>(
    steps: readonly ProviderStep<T>[],
    nowMs: number = Date.now(),
  ): Promise<{ value: T; provider: string }> {
    if (steps.length === 0) {
      throw new MarketDataError(
        "upstream",
        "ProviderChain",
        "No market-data providers configured for this request.",
      );
    }

    const healthySteps = steps.filter(
      (step) => !this.isCircuitOpen(step.provider, nowMs),
    );

    // If all providers are cooling down, probe the one closest to recovery.
    const stepsToTry: ProviderStep<T>[] =
      healthySteps.length > 0
        ? healthySteps
        : [
            [...steps].sort((left, right) => {
              const leftUntil =
                this.circuits.get(left.provider.toLowerCase())?.openUntilMs ?? 0;
              const rightUntil =
                this.circuits.get(right.provider.toLowerCase())?.openUntilMs ?? 0;
              return leftUntil - rightUntil;
            })[0],
          ];

    let primaryError: unknown = null;

    for (const step of stepsToTry) {
      try {
        const value = await step.execute();
        this.recordSuccess(step.provider, nowMs);
        return { value, provider: step.provider };
      } catch (error) {
        this.recordFailure(step.provider, error, nowMs);
        if (primaryError === null) {
          primaryError = error;
        }
      }
    }

    throw (
      primaryError ??
      new MarketDataError(
        "upstream",
        steps[0].provider,
        "All configured market-data providers failed.",
      )
    );
  }

  public getHealthSnapshots(
    nowMs: number = Date.now(),
  ): ProviderHealthSnapshot[] {
    const snapshots: ProviderHealthSnapshot[] = [];
    for (const [provider, state] of this.circuits.entries()) {
      const isOpen = state.openUntilMs > nowMs;
      snapshots.push({
        provider,
        state: isOpen ? "open" : "closed",
        consecutiveFailures: state.consecutiveFailures,
        cooldownUntil: isOpen ? new Date(state.openUntilMs).toISOString() : null,
        lastError: state.lastError,
        lastSuccessAt:
          state.lastSuccessMs !== null
            ? new Date(state.lastSuccessMs).toISOString()
            : null,
      });
    }
    return snapshots;
  }

  public reset(): void {
    this.circuits.clear();
  }
}

/** Shared singleton circuit-breaker registry across server route handlers. */
export const globalProviderChain = new ProviderChain();

