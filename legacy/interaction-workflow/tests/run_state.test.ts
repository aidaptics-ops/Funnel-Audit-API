import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunStateMachine } from "../src/crawler/run_state.js";

describe("run state machine", () => {
  it("walks the manual funnel path", () => {
    const state = new RunStateMachine();
    const path = [
      "CRAWLING_LANDING_PAGE",
      "ANALYZING_LANDING_PAGE",
      "LOCATING_FORM",
      "WAITING_FOR_FORM_INPUT",
      "FORM_SUBMITTED",
      "WAITING_FOR_CALENDLY_BOOKING",
      "BOOKING_CONFIRMED",
      "ANALYZING_CONFIRMATION_PAGE",
      "TASK_COMPLETED",
    ] as const;

    for (const next of path) {
      assert.equal(state.canTransition(next), true, `expected ${state.state} -> ${next} to be allowed`);
      state.transition(next);
    }

    assert.equal(state.state, "TASK_COMPLETED");
    assert.equal(state.transitions.length, path.length);
    assert.equal(state.reached("WAITING_FOR_CALENDLY_BOOKING"), true);
    assert.equal(state.reached("FAILED"), false);
  });

  it("allows funnels without a scheduling step to skip the booking states", () => {
    const state = new RunStateMachine();
    state.transition("CRAWLING_LANDING_PAGE");
    state.transition("ANALYZING_LANDING_PAGE");
    state.transition("LOCATING_FORM");
    state.transition("WAITING_FOR_FORM_INPUT");
    state.transition("FORM_SUBMITTED");
    assert.equal(state.canTransition("ANALYZING_CONFIRMATION_PAGE"), true);
    state.transition("ANALYZING_CONFIRMATION_PAGE");
    state.transition("TASK_COMPLETED");
    assert.equal(state.reached("BOOKING_CONFIRMED"), false);
    assert.equal(state.state, "TASK_COMPLETED");
  });

  it("allows a funnel with no form to finish after the landing analysis", () => {
    const state = new RunStateMachine();
    state.transition("CRAWLING_LANDING_PAGE");
    state.transition("ANALYZING_LANDING_PAGE");
    state.transition("LOCATING_FORM");
    assert.equal(state.canTransition("TASK_COMPLETED"), true);
  });

  it("records an unexpected transition instead of throwing", () => {
    const state = new RunStateMachine();
    assert.equal(state.canTransition("BOOKING_CONFIRMED"), false);
    state.transition("BOOKING_CONFIRMED", { note: "forced" });
    assert.equal(state.state, "BOOKING_CONFIRMED");
    assert.equal(state.transitions[0]?.note, "forced");
  });

  it("notifies listeners with the transition", () => {
    const state = new RunStateMachine();
    const seen: string[] = [];
    state.onTransition((transition) => seen.push(`${transition.from}->${transition.to}`));
    state.transition("CRAWLING_LANDING_PAGE");
    state.transition("FAILED", { note: "network down" });
    assert.deepEqual(seen, ["INITIALIZING->CRAWLING_LANDING_PAGE", "CRAWLING_LANDING_PAGE->FAILED"]);
  });
});
