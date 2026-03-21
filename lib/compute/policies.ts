/**
 * Runtime Policies — Declarative sandbox lifecycle specifications.
 *
 * Each session type has a policy that tells the runtime controller
 * what to do with its sandbox at each lifecycle stage. Consumers
 * never call destroy/hibernate directly — they publish facts
 * (claims, heartbeats) and the controller reads the policy.
 */

export type RuntimePolicy = {
  /** What to do when the last claim is released (job completes, no more work). */
  afterLastClaim: "destroy" | "hibernate" | "keep_idle";
  /** How long to keep an idle sandbox before the controller acts (ms). */
  idleGraceMs: number;
  /** Absolute maximum sandbox lifetime regardless of claims (ms). */
  hardTtlMs: number;
  /** Whether this sandbox can be snapshotted for later resume. */
  hibernatable: boolean;
};

/**
 * Built-in policies keyed by session/job type.
 * The controller looks up the policy for each runtime and acts accordingly.
 */
export const RUNTIME_POLICIES = {
  /** PR reviews: ephemeral, short-lived, no state worth preserving. */
  ephemeral_review: {
    afterLastClaim: "destroy",
    idleGraceMs: 2 * 60 * 1000, // 2 minutes grace for queued reviews
    hardTtlMs: 30 * 60 * 1000, // 30 min hard cap
    hibernatable: false,
  },

  /** Coding tasks: ephemeral but needs sandbox during postprocess. */
  ephemeral_coding: {
    afterLastClaim: "destroy",
    idleGraceMs: 5 * 60 * 1000, // 5 min for postprocess
    hardTtlMs: 2 * 60 * 60 * 1000, // 2 hours hard cap
    hibernatable: false,
  },

  /** Interactive sessions: long-lived, hibernate on idle. */
  interactive: {
    afterLastClaim: "hibernate",
    idleGraceMs: 30 * 60 * 1000, // 30 min idle before hibernate
    hardTtlMs: 8 * 60 * 60 * 1000, // 8 hours hard cap
    hibernatable: true,
  },
} as const satisfies Record<string, RuntimePolicy>;

export type RuntimePolicyName = keyof typeof RUNTIME_POLICIES;

/**
 * Resolve a policy name from session/job context.
 * Falls back to ephemeral_review (safest default — short-lived).
 */
export function resolveRuntimePolicy(context: {
  sessionType?: string;
  jobType?: string;
}): RuntimePolicyName {
  // Interactive sessions get the long-lived policy
  if (context.sessionType === "interactive") return "interactive";

  // Job-type based
  if (context.jobType === "coding_task") return "ephemeral_coding";
  if (context.jobType === "review") return "ephemeral_review";

  // Default: shortest-lived policy (fail safe)
  return "ephemeral_review";
}
