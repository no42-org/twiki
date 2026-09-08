/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/**
 * What one workflow run means.
 *
 * `hung` is a WORKFLOW RUN that never finished. The word `stalled` stays
 * reserved for a collection lane run in Collection health; using one word for
 * both would make "3 stalled" on the health table and "3 stalled" on the CI
 * section look like the same fact about the same thing.
 */
export type RunVerdict = "failed" | "passed" | "hung" | "other";

/**
 * The parts of a run this decision reads. Deliberately structural rather than
 * the port's `RawWorkflowRun`: core may not import the adapter's types, and
 * the stored observation has the same three fields under the same names.
 */
export interface VerdictRun {
  /**
   * queued, in_progress, completed, waiting, requested or pending, as GitHub
   * reports it. Only the first two can hang; see HANGABLE_STATUSES.
   */
  status: string;
  /** success, failure, cancelled... or null while the run is not completed. */
  conclusion: string | null;
  createdAt: string;
}

/**
 * The conclusions that mean the build is broken.
 *
 * `timed_out` and `startup_failure` are here because a reader looking at main
 * cares that it did not go green, not by which mechanism: a workflow whose
 * job hit the six-hour ceiling and one whose YAML would not parse are both
 * "nothing shipped from this".
 */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * The only statuses a run can hang in: it is executing, or it is waiting for
 * a runner to pick it up. Either way nothing but the run itself is holding it
 * up, so age is evidence.
 *
 * An allowlist rather than "anything but completed", because the statuses
 * left out are held DELIBERATELY. A run sits in `waiting` for a deployment
 * environment's approval, in `requested` for a required reviewer and in
 * `pending` behind a concurrency group, and GitHub parks runs there for days
 * - a wait for a human is not a hang, and calling it one would put a red main
 * on the overview for every repository that gates its production deploy.
 * Anything GitHub adds later is `other` until somebody decides otherwise,
 * which is the answer that cannot invent a failure.
 */
const HANGABLE_STATUSES = new Set(["queued", "in_progress"]);

/**
 * The hung threshold a caller uses when it has nothing better.
 *
 * Twice the Actions lane's hourly cadence, which is the derivation the
 * wiring makes from `ACTIONS_CADENCE_MS` and passes explicitly to both the
 * lane and the web role. The literal is here rather than the constant
 * because the cadence lives in an entrypoint and nothing may import one
 * (AD-5); a caller that knows the real cadence should pass it, and a caller
 * that does not gets the same answer as production rather than a threshold
 * derived from some other lane's cadence.
 *
 * Changing `ACTIONS_CADENCE_MS` without changing this makes the two drift,
 * which is why the wiring passes the derived value rather than leaning on
 * this default.
 */
export const DEFAULT_HUNG_AFTER_MS = 2 * 60 * 60_000;

/**
 * One verdict for one workflow run.
 *
 * Meant to become the ONE place that reads `conclusion`, and not yet that.
 * Today two other readings exist and they already disagree: `isFailing` in
 * `src/twiki/gates.ts` counts `cancelled` as a failure (right for a merge
 * gate, which must not merge on an inconclusive run) and this function counts
 * it as `other` (right for a dashboard, which must not paint a cancelled run
 * as a broken main). `src/tricorder/web/components.tsx` reads the verdict as
 * of this change and no longer reads `conclusion` itself.
 *
 * The intended end state is that every gitricorder reading comes through
 * here - the lane's `failing` counter, Story 2.3's `broken` rank term, Epic
 * 3's stuck pull-request term - so that the readings cannot drift further.
 * twiki's gate is a separate judgement with a separate purpose and is not
 * planned to fold into this one.
 *
 * Pure, and it owns no clock: `now` is passed in so a test drives it exactly
 * as production does.
 *
 * @param hungAfterMs How long a run may sit unfinished before it counts as
 *   hung. Callers pass twice the Actions cadence, so one missed sweep is not
 *   yet evidence of a hang.
 */
export function runVerdict(
  run: VerdictRun,
  now: Date,
  hungAfterMs: number,
): RunVerdict {
  // A stated conclusion decides, whatever the status says. GitHub sets one
  // only when it has concluded something, so this cannot swallow the hung
  // case below - and reading the status first would let a `completed` run
  // with a `failure` conclusion be judged on its status instead.
  if (run.conclusion !== null) {
    if (FAILED_CONCLUSIONS.has(run.conclusion)) return "failed";
    if (run.conclusion === "success") return "passed";
    // cancelled, skipped, neutral, action_required, stale, and anything
    // GitHub adds later. None of them is a failure of main, and guessing
    // that a word we do not know is one would invent red builds.
    return "other";
  }

  // Not a status age says anything about. `completed` with no conclusion at
  // all is over, whatever it left behind - falling through would turn such a
  // row into a permanent `hung` the moment it aged past the threshold, a
  // failure invented out of a missing field. `waiting`, `requested` and
  // `pending` are runs held for a person, and however long that takes it is
  // not a hang.
  if (!HANGABLE_STATUSES.has(run.status)) return "other";

  const created = Date.parse(run.createdAt);
  // A timestamp we cannot read is not evidence that the run is old. Verdicts
  // feed the rank chain, so the answer here must be the one that cannot
  // manufacture a red main out of a bad string.
  //
  // Stated rather than load-bearing, and checked: deleting this line changes
  // no answer, because every comparison against NaN below is false and the
  // fall-through already returns `other`. It is here because that is an
  // accident of JavaScript rather than a decision, and the next person to
  // rewrite the comparison should not have to rediscover it.
  if (Number.isNaN(created)) return "other";

  // Strictly older: at exactly the threshold the run has used its whole
  // allowance and not yet exceeded it.
  return now.getTime() - created > hungAfterMs ? "hung" : "other";
}

/**
 * Whether a verdict is one the CI signal treats as a broken build.
 *
 * Named once so the lane's counter and (in Story 2.3) the `broken` term
 * cannot disagree about whether a hung run counts.
 */
export function isBrokenVerdict(verdict: RunVerdict): boolean {
  return verdict === "failed" || verdict === "hung";
}
