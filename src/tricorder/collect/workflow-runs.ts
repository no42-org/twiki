/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { isDefaultBranchRun } from "../../core/branch.js";
import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import {
  isBrokenVerdict,
  type RunVerdict,
  runVerdict,
} from "../../core/run-verdict.js";
import { actionsSubject, nodeSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  type GitHubReadPort,
  type RawWorkflowRun,
  type RequestValidator,
  workflowRunsUrl,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";

// The Actions lane (CAP: build failures), story 15's shape: one installation,
// one REST call per watched repository, and the real cost written down.
//
// This is the lane the spine prices at a hard per-repo floor (AD-15: no org
// variant of the endpoint exists, and GraphQL's WorkflowRun carries no
// status), which makes it the lane where the AD-25 validator cache matters
// most: a quiet repository answers 304, which is free.

export const LANE = "rest-actions-runs";

export interface WorkflowRunObservation {
  repo: string;
  workflowId: number;
  workflowName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  event: string;
  htmlUrl: string;
  createdAt: string;
}

/**
 * The workflow-run shape check, shared by this lane and by every page that
 * reads the rows it writes (re-exported from `attention/payloads.ts`, where
 * the other payload guards live).
 *
 * It lives HERE, beside the type it guards and the lane that writes it,
 * because the lane reads stored rows through it and a collect lane may not
 * import the attention directory: attention is the read side and depends on
 * collect, never the other way round (AD-34).
 *
 * `conclusion` is legitimately null while a run is still going, which is a
 * state the page shows rather than a defect. `workflowId` and `createdAt` are
 * checked because the retention depends on both: the workflow id is half the
 * bucket a row is superseded within, and the timestamp is what `runVerdict`
 * reads to tell a hung run from a fresh one, and what the confirm pass
 * compares against the page's window. A row that answered `undefined` for
 * either would be filed into a bucket of its own and never superseded.
 *
 * The two nullable fields are checked inline rather than through the
 * `stringOrNull` helper in `attention/payloads.ts`, for the same layering
 * reason: importing it here is the edge this move exists to remove.
 */
export function readWorkflowRun(
  payload: unknown,
): WorkflowRunObservation | null {
  const r = payload as WorkflowRunObservation | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (typeof r.repo !== "string") return null;
  if (typeof r.workflowId !== "number") return null;
  if (typeof r.workflowName !== "string") return null;
  if (typeof r.runNumber !== "number") return null;
  if (typeof r.status !== "string") return null;
  if (r.conclusion !== null && typeof r.conclusion !== "string") return null;
  if (r.headBranch !== null && typeof r.headBranch !== "string") return null;
  if (typeof r.htmlUrl !== "string") return null;
  if (typeof r.createdAt !== "string") return null;
  // The bucket reads it, so the guard checks it: same rule that brought
  // `workflowId` and `createdAt` here when the verdict started reading them.
  if (typeof r.event !== "string") return null;
  return r;
}

/**
 * Per-repository confirmation: this repository was swept, and this is what
 * it had. Written for every repository the sweep actually reached.
 *
 * Without it, a repository with no workflows and a repository the sweep
 * yielded before reaching are both "no run rows", which is the confident
 * zero this dashboard exists to refuse (AD-28). It is also the clock the
 * next sweep orders by, so a bounded sweep resumes where the last one
 * stopped instead of re-walking the same prefix forever.
 */
export interface ActionsRepoObservation {
  repo: string;
  /**
   * Workflows RETAINED for this repository - counted once per workflow, not
   * once per row, because a workflow with a default-branch run and a
   * pull-request run keeps two rows and is still one workflow. NULL when the
   * sweep reached this repository but could not vouch for what it found -
   * the read threw, or its payloads did not map.
   *
   * Null rather than zero, and written rather than omitted, because the two
   * halves solve different problems. Zero would be a confident zero stated
   * with a fresh badge, which is worse than the ambiguity it replaced
   * (AD-28). Omitting the row entirely would leave a deterministically
   * failing repository - Actions disabled, a permissions 403 - permanently
   * least-recently-confirmed, so it would head every bounded sweep forever
   * and starve the repositories behind it: the exact failure the ordering
   * exists to prevent, moved from a fixed prefix to a failing one.
   */
  workflows: number | null;
  /**
   * Retained DEFAULT-BRANCH rows whose verdict is `failed` or `hung`. Null
   * beside a null `workflows`, for the same reason.
   *
   * A failure on any other branch is deliberately not counted: this number
   * exists to say whether main is broken, and folding a failing feature
   * branch into it would make a healthy repository read red. Nothing renders
   * it yet; Story 2.3 decides where a failing count belongs.
   *
   * Judged at the sweep's own clock, and so not a function of the listing
   * alone: `hung` counts here, and a run becomes hung by ageing rather than
   * by anything GitHub sends. This number can therefore move between two
   * sweeps that were told the listing had not changed, which is correct - the
   * page ages the same run the same way, off the same verdict.
   */
  failing: number | null;
}

export interface ActionsDeps extends LaneRunDeps {
  github: GitHubReadPort;
  watchedIn: (installation: string) => readonly RepoRef[];
  /**
   * The configured default branch of a repository, which in production is
   * `resolveDefaultBranch` bound to the loaded config (AD-33). Taken as a
   * function rather than as the config so the lane keeps depending on
   * nothing it could write through, exactly as doctor does.
   *
   * Required, with no default. A default of `main` would make dropping the
   * binding at the wiring site compile and pass, and then file every
   * `master` repository's runs into the wrong bucket - silently, because
   * both buckets look plausible from the outside.
   */
  defaultBranchOf: (repo: RepoRef) => string;
  /**
   * How long a run may sit unfinished before it counts as hung. Bound at the
   * wiring site to twice this lane's cadence, so one missed sweep is not yet
   * evidence of a hang.
   */
  hungAfterMs: number;
}

export interface ActionsResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  /** Latest runs stored or confirmed this sweep. */
  runs: number;
  unreadable: number;
  /**
   * Repositories whose listing was actually downloaded (a 200). This is the
   * number that costs budget: a 304 is free, so a bare request count would
   * measure nothing about cost.
   */
  fetched: number;
  /** Repositories that answered 304. What the AD-25 cache saved. */
  notModified: number;
  /** Repositories whose read failed. Each degrades the run to partial. */
  failedRepos: number;
  /** Repositories this sweep reached, of the installation's watched set. */
  reached: number;
  /** Watched repositories in this installation. */
  watched: number;
  /** True when the sweep stopped early on its own bound rather than finishing. */
  yielded: boolean;
  /**
   * Core budget left after the sweep, from GET /rate_limit (AD-24's honest
   * source; the endpoint is free and does not charge itself). Null when the
   * reading failed, which never fails the sweep: a diagnostic that took a
   * lane down would be worse than the number is useful.
   */
  budgetRemaining: number | null;
}

/**
 * The retention key: a repository's rows are replaced only within their own
 * bucket, and a bucket is one workflow on one side of the default-branch
 * line.
 *
 * Not the subject key. Rows stay keyed by node id (AD-22); this is what the
 * lane compares to decide which stored row a freshly observed one REPLACES.
 *
 * The repository is NOT in the key, and the caller is what makes that safe:
 * `storedByRepo` groups rows by repository slug first, so every comparison
 * happens inside one repository's list and two repositories that share a
 * workflow id are never compared. A caller that compared these keys across
 * repositories would supersede rows in one repository from runs observed in
 * another - so if you need that, put the slug in the key rather than
 * assuming this one already carries it.
 */
export function retentionKey(
  workflowId: number,
  onDefaultBranch: boolean,
): string {
  return `${workflowId}:${onDefaultBranch ? "default" : "other"}`;
}

/** A run the lane means to keep, with the bucket it belongs to. */
export interface RetainedRun {
  run: RawWorkflowRun;
  onDefaultBranch: boolean;
}

/**
 * The newest run per workflow PER BUCKET, from one newest-first page: the
 * newest run on the configured default branch, and the newest on anything
 * else.
 *
 * Two rows rather than one because a single row per workflow makes a busy
 * repository forget that main is broken. Any pull-request run is newer than
 * the failed push that broke main within minutes, so a repository with an
 * active branch superseded its own red main and the store held a green
 * feature-branch run instead. Splitting the page the lane ALREADY fetches
 * costs no second call.
 *
 * The page is a 100-run window, so a workflow whose last run predates the
 * window simply does not appear; that is a fact about the window, not about
 * the workflow, and nothing downstream may treat its absence as "gone".
 */
export function latestPerBucket(
  runs: readonly RawWorkflowRun[],
  defaultBranch: string,
): RetainedRun[] {
  const seen = new Set<string>();
  const latest: RetainedRun[] = [];
  for (const run of runs) {
    // Through the shared predicate, never a bare === : the lane and the rank
    // chain must decide "is this a build of main" the same way (AD-33). It
    // reads the EVENT as well as the branch, because a pull request from a
    // fork's own `main` reports `head_branch: "main"` here (#141).
    const onDefaultBranch = isDefaultBranchRun(run, defaultBranch);
    const key = retentionKey(run.workflowId, onDefaultBranch);
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push({ run, onDefaultBranch });
  }
  return latest;
}

/** A row the sweep ends up holding for one repository, judged. */
interface RetainedRow {
  workflowId: number;
  onDefaultBranch: boolean;
  verdict: RunVerdict;
}

/**
 * Distinct workflows among the rows held, not the row count: two buckets
 * of one workflow are one workflow, and reporting two would put a count on
 * the page that nothing on it explains.
 */
function countWorkflows(rows: readonly RetainedRow[]): number {
  return new Set(rows.map((r) => r.workflowId)).size;
}

/**
 * The creation time of the oldest run on a page, or null when the page holds
 * no run this build could read a time from.
 *
 * Computed rather than taken from the last element: GitHub answers
 * newest-first and this lane leans on that for selection, but the confirm
 * pass below decides whether a stored row may be badged fresh, and leaning on
 * an ordering GitHub only documents would make that a guess.
 */
function oldestCreatedAt(runs: readonly RawWorkflowRun[]): number | null {
  let oldest: number | null = null;
  for (const run of runs) {
    const at = Date.parse(run.createdAt);
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * Whether a stored row falls inside the window a page is evidence about.
 *
 * False for an empty page and for a row whose own timestamp will not parse:
 * both are "we cannot tell", and the caller answers that by leaving the row
 * to age rather than by vouching for it.
 */
function coveredBy(createdAt: string, windowFrom: number | null): boolean {
  if (windowFrom === null) return false;
  const at = Date.parse(createdAt);
  return !Number.isNaN(at) && at >= windowFrom;
}

/** Retained default-branch rows whose verdict says the build is broken. */
function countFailing(rows: readonly RetainedRow[]): number {
  return rows.filter((r) => r.onDefaultBranch && isBrokenVerdict(r.verdict))
    .length;
}

export function normaliseRun(run: RawWorkflowRun): ObservationInput {
  const payload: WorkflowRunObservation = {
    repo: `${run.repo.owner}/${run.repo.name}`.toLowerCase(),
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runNumber: run.runNumber,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    event: run.event,
    htmlUrl: run.htmlUrl,
    createdAt: run.createdAt,
  };
  return { subject: nodeSubject("workflow_run", run.nodeId), payload };
}

/**
 * Collect the latest workflow run per workflow for one installation's
 * watched repositories. Nothing throws past this boundary (AD-16); one
 * repository's failure degrades the run to partial, never ends it.
 *
 * Tombstoning is by SUPERSESSION, not window absence (AD-23): a stored run
 * leaves current state only when a newer run of the same workflow in the
 * same repository ON THE SAME SIDE OF THE DEFAULT-BRANCH LINE was actually
 * observed. A workflow absent from the 100-run window is a fact about the
 * window, and treating it as "gone" would tombstone every dormant workflow's
 * last known state.
 *
 * Two rows per workflow, not one, and the bucket is half the reason: keyed by
 * workflow alone, a repository with an open pull request superseded its own
 * failed default-branch run within minutes and the store forgot main was
 * broken. Both rows come out of the one page this lane already fetches; there
 * is no second call and no branch query parameter.
 */
export interface SweepBound {
  /**
   * The instant this sweep must stop by, ISO-8601. Compared against the
   * lane's own clock, so a test drives it exactly like production does.
   *
   * The bound is wall-clock rather than a request count because wall-clock
   * is what actually binds: measured 2026-08-18, a call costs ~1.3s whether
   * it answers 200 or 304, so 941 repositories take 20-25 minutes and the
   * budget barely moves (a 304 is free). AD-24 asks a lane that would
   * exceed its budget to yield and record a partial run; this is that.
   */
  deadlineAt?: string;
  /**
   * Yield before starting if the core budget is below this. Read from
   * GET /rate_limit, the only honest source (AD-24): a 304's headers are
   * stale by GitHub's own documentation.
   */
  budgetFloor?: number;
}

export async function collectWorkflowRuns(
  deps: ActionsDeps,
  installation: string,
  scope: RunScope,
  bound: SweepBound = {},
): Promise<ActionsResult> {
  const log = safeLog(deps.log);

  return withLaneRun<ActionsResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    {
      installation,
      outcome: "failed",
      runs: 0,
      unreadable: 0,
      fetched: 0,
      notModified: 0,
      failedRepos: 0,
      budgetRemaining: null,
      reached: 0,
      watched: 0,
      yielded: false,
    },
    async (run, startedAt) => {
      // startedAt is the run's own start, taken once by the wrapper: this is
      // the sweep's clock, and it is what every verdict below is judged
      // against, so one sweep cannot call the same run fresh for one
      // repository and hung for the next.
      const sweptAt = new Date(startedAt);

      // Stored present runs for this installation, grouped by repo slug, read
      // once. Node keys carry no owner, so the payload answers (AD-23).
      //
      // Through the same guard the pages read these rows with, so a row the
      // lane retains cannot be one the page later refuses: `readWorkflowRun`
      // validates the head branch this bucketing depends on and the timestamp
      // the verdict depends on.
      const storedByRepo = new Map<
        string,
        { key: string; payload: WorkflowRunObservation }[]
      >();
      for (const c of deps.store.currentByType("workflow_run")) {
        if (c.state !== "present") continue;
        const p = readWorkflowRun(c.payload);
        if (p === null) continue;
        const slug = p.repo.toLowerCase();
        const list = storedByRepo.get(slug) ?? [];
        list.push({ key: c.subject.key, payload: p });
        storedByRepo.set(slug, list);
      }

      const observations: ObservationInput[] = [];
      const confirmations: ObservationInput[] = [];
      const confirmed: { type: "workflow_run"; key: string }[] = [];
      const gone: { type: "workflow_run"; key: string }[] = [];
      // Deferred until the rows they vouch for are committed. A validator
      // written inside the loop would survive a recordObservations failure and
      // then 304-confirm rows that were never written: a red build rendering
      // green and fresh for as long as the repository stays quiet. The alert
      // lane saves after its writes for the same reason.
      const validatorOps: {
        url: string;
        validator: RequestValidator | null;
      }[] = [];
      let unreadable = 0;
      let fetched = 0;
      let notModified = 0;
      let failedRepos = 0;

      // Least-recently-confirmed first, never-confirmed before that. A sweep
      // that yields must not re-walk the same prefix next time: with a fixed
      // order the tail would never be reached at all, and its repositories
      // would sit permanently uncollected while the sweep reported success.
      const confirmedAt = new Map<string, string>();
      for (const c of deps.store.currentByType("repository_actions")) {
        if (c.state === "present") confirmedAt.set(c.subject.key, c.verifiedAt);
      }
      const order = [...deps.watchedIn(installation)].sort((a, b) => {
        const at = confirmedAt.get(`${a.owner}/${a.name}`.toLowerCase());
        const bt = confirmedAt.get(`${b.owner}/${b.name}`.toLowerCase());
        if (at === undefined && bt === undefined) return 0;
        if (at === undefined) return -1;
        if (bt === undefined) return 1;
        return at.localeCompare(bt);
      });

      let yielded = false;
      let reached = 0;

      // The budget check happens once, up front, and never mid-sweep: this
      // lane is bounded by wall-clock, not by budget (a 304 costs nothing and
      // a full estate is ~941 calls against 5800/hour), so the floor exists to
      // keep a lane that is ALREADY starved from taking the last of it from
      // the security lanes, which have no cheaper route.
      if (bound.budgetFloor !== undefined) {
        try {
          const { remaining } = await deps.github.rateLimit(installation);
          if (remaining < bound.budgetFloor) {
            yielded = true;
            log(
              `${LANE} ${installation}: yielding before starting, ${remaining} budget left`,
            );
          }
        } catch {
          // Unreadable budget is not evidence of a low one. Proceeding is the
          // conservative choice here: the deadline still bounds the sweep, and
          // refusing to run on a failed diagnostic would let one flaky
          // endpoint silently stop collection altogether.
        }
      }

      for (const repo of yielded ? [] : order) {
        // Checked before the call, not after: stopping once the deadline has
        // already been blown past would make the bound advisory.
        if (bound.deadlineAt && deps.now() >= bound.deadlineAt) {
          yielded = true;
          break;
        }
        const slug = `${repo.owner}/${repo.name}`.toLowerCase();
        const url = workflowRunsUrl(repo);
        try {
          // Inside the try, because the resolver is the caller's: a throw here
          // must degrade this one repository like a failed read, not end the
          // sweep for the ones behind it.
          //
          // Declared, never stored (AD-10): the lane reads what repos.yaml
          // says this repository calls its default branch and writes it
          // nowhere.
          const defaultBranch = deps.defaultBranchOf(repo);
          // The stored rows, sorted into their buckets and judged. An old
          // store reclassifies here and nowhere else: every row already
          // carries the head branch this reads, so one sweep is enough and no
          // row is lost for having been written before the buckets existed.
          const stored = (storedByRepo.get(slug) ?? []).map((s) => ({
            key: s.key,
            workflowId: s.payload.workflowId,
            createdAt: s.payload.createdAt,
            // The same predicate as the page's runs, over the payload's own
            // event, so a row stored under the old branch-only rule moves to
            // the bucket it belongs in on the first sweep that reads it (#141).
            onDefaultBranch: isDefaultBranchRun(s.payload, defaultBranch),
            verdict: runVerdict(s.payload, sweptAt, deps.hungAfterMs),
          }));
          const page = await deps.github.listRepoWorkflowRuns(
            repo,
            deps.store.loadValidator(installation, url),
          );

          if (page.notModified) {
            // Nothing changed since the sweep that stored these rows: the
            // stored latest runs are still the latest. Confirm, free.
            notModified++;
            reached++;
            for (const s of stored) {
              confirmed.push({ type: "workflow_run", key: s.key });
            }
            // Reached and confirmed, so the repository's own attestation
            // advances too: a 304 is evidence about this repository exactly as
            // a 200 is, and leaving it behind would send the next sweep back
            // to a repository that is already current.
            confirmations.push({
              subject: actionsSubject(repo),
              payload: {
                repo: slug,
                // Over the rows the store HOLDS, judged at this sweep's clock -
                // the same set, by the same rule, as the 200 path below (#142).
                //
                // Not carried forward from the last confirmation, though a 304
                // does mean the listing has not changed: `failing` counts hung
                // runs, and a run becomes hung by the clock rather than by the
                // listing. A run ageing past the threshold while GitHub keeps
                // answering 304 would be painted red by the page and never
                // counted here, which is the disagreement between the lane and
                // the page that this whole change exists to remove.
                workflows: countWorkflows(stored),
                failing: countFailing(stored),
              } satisfies ActionsRepoObservation,
            });
            if (page.validator) {
              validatorOps.push({ url, validator: page.validator });
            }
            continue;
          }

          fetched++;
          unreadable += page.unreadable;
          const latest = latestPerBucket(page.runs, defaultBranch);
          observations.push(...latest.map((l) => normaliseRun(l.run)));

          // Supersession, per bucket: a stored run is replaced only by a
          // DIFFERENT run of the same workflow on the same side of the
          // default-branch line. Same-key rows are updates, not replacements,
          // and stay. Keyed by workflow alone - as it was - a pull-request run
          // displaced the default-branch row it has nothing to say about.
          const latestKeys = new Set(latest.map((l) => l.run.nodeId));
          const observedBuckets = new Set(
            latest.map((l) =>
              retentionKey(l.run.workflowId, l.onDefaultBranch),
            ),
          );

          // The window this page is evidence about: everything from the oldest
          // run on it forward. Null for an empty page, which is evidence about
          // nothing at all.
          const windowFrom = oldestCreatedAt(page.runs);

          // What this repository HOLDS after the sweep: the rows just
          // observed, plus every carried row that survives supersession below.
          //
          // The rows held, not the narrower set this sweep can vouch the
          // freshness of. The two are different questions with different
          // answers, and counting the narrow one made the count depend on
          // which way GitHub answered (#142). It is the held set the page
          // renders from, so counting it is what makes the lane and the page
          // agree about a repository by construction.
          const held: RetainedRow[] = latest.map((l) => ({
            workflowId: l.run.workflowId,
            onDefaultBranch: l.onDefaultBranch,
            verdict: runVerdict(l.run, sweptAt, deps.hungAfterMs),
          }));

          // Both the tombstones and the touch are gated on a COMPLETE page: an
          // unreadable payload might have been the newer run of a bucket, so
          // neither superseding nor vouching for what is left is honest. A
          // partial page changes nothing.
          if (page.unreadable === 0) {
            for (const s of stored) {
              // Rewritten by the observation above, which advances its own
              // freshness. Touching it again would be harmless and confusing.
              if (latestKeys.has(s.key)) continue;
              if (
                observedBuckets.has(
                  retentionKey(s.workflowId, s.onDefaultBranch),
                )
              ) {
                gone.push({ type: "workflow_run", key: s.key });
                continue;
              }
              // Its bucket had no run on this page. That is proof the row is
              // still the latest in its bucket ONLY where the page can see -
              // from the oldest run on it forward. A row older than that sits
              // outside the window, and with more than a hundred newer runs a
              // newer default-branch run can sit outside it too: touching
              // freshness there would badge a red main as current long after
              // somebody fixed it, on a page that never saw the fix.
              //
              // So a row the window cannot cover is left entirely alone. It
              // stays present, it ages into stale, and the page says so - the
              // honest reading of "we did not look far enough back".
              //
              // Held either way: the window decides whether this sweep may
              // touch the row's freshness, not whether the store still has it.
              // The page shows the row whatever the window said, so the count
              // includes it whatever the window said.
              held.push(s);
              if (!coveredBy(s.createdAt, windowFrom)) continue;
              confirmed.push({ type: "workflow_run", key: s.key });
            }
          }

          reached++;
          // Vouched for only when every payload mapped. `page.runs` excludes
          // what could not be read, so counting it on a page with unreadable
          // payloads would publish "no runs recorded", freshly badged, for a
          // repository whose runs we simply failed to parse.
          confirmations.push({
            subject: actionsSubject(repo),
            payload:
              page.unreadable === 0
                ? {
                    repo: slug,
                    workflows: countWorkflows(held),
                    failing: countFailing(held),
                  }
                : { repo: slug, workflows: null, failing: null },
          });

          // Save-or-purge, exactly as the alert lane (AD-25): a 200 that
          // rewrote rows without earning a validator must not leave the old
          // one describing a listing that no longer matches stored state.
          validatorOps.push({
            url,
            validator: page.unreadable === 0 ? page.validator : null,
          });
        } catch (err) {
          // The repository's stored rows were not rewritten, so its stored
          // validator still describes stored state: left alone, like the rows.
          failedRepos++;
          reached++;
          // Reached, and nothing learned. The row advances this repository's
          // place in the sweep order without vouching for anything, so a
          // repository that fails every time cannot camp at the head of a
          // bounded sweep and starve the ones behind it.
          confirmations.push({
            subject: actionsSubject(repo),
            payload: { repo: slug, workflows: null, failing: null },
          });
          log(
            `${LANE} ${installation}: ${slug} failed, ${redact(
              err instanceof Error ? err.message : String(err),
            )}`,
          );
        }
      }

      deps.store.recordObservations(run, deps.now(), [
        ...observations,
        ...confirmations,
      ]);
      if (confirmed.length > 0) {
        deps.store.touchVerified(confirmed, deps.now());
      }
      if (gone.length > 0) {
        deps.store.recordTombstones(run, deps.now(), gone);
      }
      // Only now, with every row committed, may a validator vouch for them.
      for (const op of validatorOps) {
        if (op.validator) {
          deps.store.saveValidator(
            installation,
            op.url,
            op.validator,
            deps.now(),
          );
        } else {
          deps.store.deleteValidator(installation, op.url);
        }
      }

      // Best-effort, after the writes: story 15 asks for the remaining budget
      // in as many words, and this is the only endpoint that answers honestly
      // (a 304's headers are stale by GitHub's own documentation).
      let budgetRemaining: number | null = null;
      try {
        budgetRemaining = (await deps.github.rateLimit(installation)).remaining;
      } catch (err) {
        log(
          `${LANE} ${installation}: budget unreadable, ${redact(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }

      // A yielded sweep is partial by construction: it did not look at every
      // watched repository, so the ones it never reached must go on ageing
      // rather than be treated as confirmed (AD-16). The unreached
      // repositories keep their own attestations, which is what makes them
      // render stale rather than zero.
      const watchedCount = order.length;
      const outcome =
        failedRepos > 0 || unreadable > 0 || yielded ? "partial" : "ok";
      // Composed, not chosen. A degraded sweep is exactly the one likely to
      // yield AND fail repositories, and reporting only the yield would leave
      // the failures visible nowhere but a log line nobody kept.
      const notes = [
        yielded
          ? `yielded after ${reached} of ${watchedCount} repositories; the rest keep ageing`
          : null,
        failedRepos > 0 ? `${failedRepos} repositories failed` : null,
        unreadable > 0 ? `${unreadable} run payloads could not be read` : null,
      ].filter((n): n is string => n !== null);
      const detail = notes.length > 0 ? notes.join("; ") : undefined;
      deps.store.finishRun(run, outcome, deps.now(), detail);

      const runsSeen = observations.length + confirmed.length;
      // The measurement story 15 exists for. A bare request count would be
      // tautological (one per watched repository, always) AND misleading: a
      // 304 is not charged against the primary rate limit, so what costs
      // budget is `fetched`, and `notModified` is exactly what the AD-25
      // cache saved.
      log(
        `${LANE} ${installation}: ${runsSeen} latest runs across ` +
          `${deps.watchedIn(installation).length} repositories, ` +
          `${reached} of ${watchedCount} reached, ` +
          `${fetched} fetched, ${notModified} not modified, ${failedRepos} failed` +
          (gone.length > 0 ? `, ${gone.length} superseded` : "") +
          (unreadable > 0 ? `, ${unreadable} unreadable` : "") +
          (budgetRemaining === null
            ? ", budget unknown"
            : `, ${budgetRemaining} budget left`),
      );
      return {
        installation,
        outcome,
        runs: runsSeen,
        unreadable,
        fetched,
        notModified,
        failedRepos,
        budgetRemaining,
        reached,
        watched: watchedCount,
        yielded,
      };
    },
  );
}
