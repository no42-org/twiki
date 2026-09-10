/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Topic } from "../../core/topics.js";
import { LANE as CODE_SCANNING_LANE } from "../collect/code-scanning.js";
import { LANE as COVERAGE_LANE } from "../collect/coverage.js";
import { LANE as ALERTS_LANE } from "../collect/dependabot-alerts.js";
import { LANE as ISSUES_LANE } from "../collect/issues.js";
import { KEV_INSTALLATION, LANE as KEV_LANE } from "../collect/kev.js";
import { LANE as PULL_REQUESTS_LANE } from "../collect/pull-requests.js";
import {
  REVIEWS_INSTALLATION,
  LANE as REVIEWS_LANE,
} from "../collect/review-requests.js";
import { LANE as SECRET_SCANNING_LANE } from "../collect/secret-scanning.js";
import { LANE as UPDATE_PRS_LANE } from "../collect/update-prs.js";
import { LANE as UPDATE_STATUS_LANE } from "../collect/update-status.js";
import { LANE as WORKFLOW_RUNS_LANE } from "../collect/workflow-runs.js";

// Which tile a lane's failure belongs on (AD-32).
//
// A failed or stalled lane is listed in the Collection health table, but the
// reader looks at the tiles, and a low Security count over a failed alerts
// sweep reads as a quiet estate. This map is what lets the tile say so. It is
// keyed by the `LANE` constants and never by a string literal: a lane rename
// would otherwise silently detach its warning from its tile, and nothing
// would fail.

export interface LaneTopic {
  topic: Topic;
  /** The lane in plain words, for the tile's warning line. */
  word: string;
  /**
   * The one installation the lane always runs under, for a lane that does
   * not run per installation; null for one that does. The warning names the
   * installation only when it distinguishes anything.
   */
  installation: string | null;
}

/**
 * Every lane, and the topic its failure warns on.
 *
 * Coverage and the KEV catalogue both feed the Security tile: a coverage
 * probe that failed may have lost a `not covered`, and a stale catalogue
 * turns every KEV verdict unknown. A test walks every `LANE` export under
 * collect/ against this map, so a new lane cannot ship without a tile.
 */
export const LANE_TOPIC: ReadonlyMap<string, LaneTopic> = new Map<
  string,
  LaneTopic
>([
  [ALERTS_LANE, { topic: "security", word: "alerts", installation: null }],
  [
    CODE_SCANNING_LANE,
    { topic: "security", word: "code scanning", installation: null },
  ],
  [
    SECRET_SCANNING_LANE,
    { topic: "security", word: "secret scanning", installation: null },
  ],
  [
    UPDATE_PRS_LANE,
    { topic: "dependencies", word: "update PRs", installation: null },
  ],
  [
    UPDATE_STATUS_LANE,
    { topic: "dependencies", word: "update status", installation: null },
  ],
  [
    PULL_REQUESTS_LANE,
    { topic: "pulls", word: "pull requests", installation: null },
  ],
  [ISSUES_LANE, { topic: "issues", word: "issues", installation: null }],
  [
    REVIEWS_LANE,
    {
      topic: "reviews",
      word: "review requests",
      installation: REVIEWS_INSTALLATION,
    },
  ],
  [
    WORKFLOW_RUNS_LANE,
    { topic: "ci", word: "workflow runs", installation: null },
  ],
  [COVERAGE_LANE, { topic: "security", word: "coverage", installation: null }],
  [
    KEV_LANE,
    {
      topic: "security",
      word: "KEV catalogue",
      installation: KEV_INSTALLATION,
    },
  ],
]);

/** The tile a lane warns on, or undefined for a lane this map does not know. */
export function laneTopic(lane: string): LaneTopic | undefined {
  return LANE_TOPIC.get(lane);
}
