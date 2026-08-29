import type { RunState, StateTransition } from "../types/index.js";
import { logger } from "../logging/logger.js";

/**
 * Legal transitions. Anything not listed here is a bug in the flow, not a
 * funnel quirk, so it is logged loudly and still recorded.
 */
const ALLOWED: Record<RunState, RunState[]> = {
  INITIALIZING: ["CRAWLING_LANDING_PAGE", "FAILED"],
  CRAWLING_LANDING_PAGE: ["ANALYZING_LANDING_PAGE", "FAILED"],
  ANALYZING_LANDING_PAGE: ["LOCATING_FORM", "ANALYZING_CONFIRMATION_PAGE", "TASK_COMPLETED", "FAILED"],
  LOCATING_FORM: [
    "CRAWLING_LANDING_PAGE",
    "WAITING_FOR_FORM_INPUT",
    "WAITING_FOR_CALENDLY_BOOKING",
    "ANALYZING_CONFIRMATION_PAGE",
    "TASK_COMPLETED",
    "FAILED",
  ],
  WAITING_FOR_FORM_INPUT: ["FORM_SUBMITTED", "ANALYZING_CONFIRMATION_PAGE", "TASK_COMPLETED", "FAILED"],
  FORM_SUBMITTED: [
    "WAITING_FOR_CALENDLY_BOOKING",
    "ANALYZING_CONFIRMATION_PAGE",
    "WAITING_FOR_FORM_INPUT",
    "TASK_COMPLETED",
    "FAILED",
  ],
  WAITING_FOR_CALENDLY_BOOKING: ["BOOKING_CONFIRMED", "ANALYZING_CONFIRMATION_PAGE", "TASK_COMPLETED", "FAILED"],
  BOOKING_CONFIRMED: ["ANALYZING_CONFIRMATION_PAGE", "TASK_COMPLETED", "FAILED"],
  ANALYZING_CONFIRMATION_PAGE: ["TASK_COMPLETED", "FAILED"],
  TASK_COMPLETED: [],
  FAILED: [],
};

export type StateListener = (transition: StateTransition, state: RunState) => void;

export class RunStateMachine {
  private current: RunState = "INITIALIZING";
  private readonly history: StateTransition[] = [];
  private readonly startedAt = Date.now();
  private readonly listeners: StateListener[] = [];

  get state(): RunState {
    return this.current;
  }

  get transitions(): StateTransition[] {
    return [...this.history];
  }

  onTransition(listener: StateListener): void {
    this.listeners.push(listener);
  }

  canTransition(to: RunState): boolean {
    return ALLOWED[this.current].includes(to);
  }

  /** Records the transition even when it is not in the allowed table. */
  transition(to: RunState, opts?: { url?: string | null; note?: string | null }): StateTransition {
    const from = this.current;
    if (from === to) {
      return this.record(from, to, opts, "re-entered");
    }
    if (!this.canTransition(to)) {
      logger.warn(`Unexpected state transition ${from} -> ${to}`);
    }
    this.current = to;
    const transition = this.record(from, to, opts);
    logger.info(`State ${from} -> ${to}${opts?.note ? ` (${opts.note})` : ""}`);
    return transition;
  }

  reached(state: RunState): boolean {
    return this.current === state || this.history.some((item) => item.to === state);
  }

  private record(
    from: RunState,
    to: RunState,
    opts?: { url?: string | null; note?: string | null },
    extra?: string,
  ): StateTransition {
    const transition: StateTransition = {
      from,
      to,
      at: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      url: opts?.url ?? null,
      note: [opts?.note, extra].filter(Boolean).join(" ") || null,
    };
    this.history.push(transition);
    for (const listener of this.listeners) {
      try {
        listener(transition, this.current);
      } catch (error) {
        logger.warn(`State listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return transition;
  }
}
