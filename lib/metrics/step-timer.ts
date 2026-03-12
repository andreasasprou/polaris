/**
 * Lightweight step-level timing for pipeline instrumentation.
 * Records per-step durations, counts, and metadata into a single
 * JSONB-friendly object stored on automation_runs.metrics.
 */

export type StepMetrics = {
  steps: Record<string, number>;
  counts: Record<string, number>;
  meta: Record<string, string | number | boolean | null>;
  totalMs: number;
};

export function createStepTimer() {
  const createdAt = Date.now();
  const steps: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const meta: Record<string, string | number | boolean | null> = {};

  return {
    /** Wrap an async step, recording its duration under `name`. */
    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = Date.now();
      const result = await fn();
      steps[name] = Date.now() - start;
      return result;
    },

    /** Record a duration manually (for polling loops, etc.). */
    record(name: string, ms: number) {
      steps[name] = ms;
    },

    /** Set a count metric. */
    count(name: string, value: number) {
      counts[name] = value;
    },

    /** Set a metadata value. */
    setMeta(name: string, value: string | number | boolean | null) {
      meta[name] = value;
    },

    /** Finalize and return the metrics object. */
    finalize(): StepMetrics {
      return { steps, counts, meta, totalMs: Date.now() - createdAt };
    },
  };
}
