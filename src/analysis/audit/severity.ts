import type { IssueSeverity } from "../landing_types.js";

const ORDER: IssueSeverity[] = ["critical", "high", "medium", "low", "informational"];

export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/** Move a severity down the scale (towards informational) by `steps`. */
export function downgrade(severity: IssueSeverity, steps = 1): IssueSeverity {
  const index = Math.min(ORDER.length - 1, SEVERITY_RANK[severity] + Math.max(0, steps));
  return ORDER[index] as IssueSeverity;
}

/** Move a severity up the scale (towards critical) by `steps`. */
export function upgrade(severity: IssueSeverity, steps = 1): IssueSeverity {
  const index = Math.max(0, SEVERITY_RANK[severity] - Math.max(0, steps));
  return ORDER[index] as IssueSeverity;
}

/**
 * A low-confidence funnel classification must not drive a high-severity,
 * funnel-specific judgement. Below 0.5 the finding is softened by one step.
 */
export function temperByConfidence(severity: IssueSeverity, confidence: number): IssueSeverity {
  if (confidence >= 0.5) return severity;
  if (severity === "critical" || severity === "high") return downgrade(severity);
  return severity;
}
