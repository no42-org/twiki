/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { watchKey } from "../../core/slug.js";
import type { Topic } from "../../core/topics.js";
import { TOPICS } from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";

// Every internal path, built here and nowhere else (AD-39).
//
// A page that concatenates `/repo/${slug}` by hand is one edit away from a
// second spelling of the same route, and a query value typed inline is one
// edit away from a filter the queue does not recognise. So the paths are
// functions, the repository is emitted through `watchKey` (the one folding
// every layer agrees on, AD-33), and the topic value comes from TOPICS.

/** The per-repository page. The slug is already folded; each segment is encoded. */
export function repoPath(slug: string): string {
  return `/repo/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The queue, filtered by topic and optionally by repository.
 *
 * Reviews has no queue filter (it is not in the queue), so asking for its
 * path here is a programming error, not a page state.
 */
export function queuePath(topic: Topic, repo?: RepoRef): string {
  const query = TOPICS.find((t) => t.topic === topic)?.query;
  if (query === undefined || query === null) {
    throw new Error(`topic ${topic} has no queue filter`);
  }
  const params = new URLSearchParams();
  if (repo !== undefined) params.set("repo", watchKey(repo));
  params.set("topic", query);
  return `/queue?${params.toString()}`;
}

/** The review-request page. */
export function reviewsPath(): string {
  return "/reviews";
}

/** Where a topic's tile or chip leads: the queue filter, or /reviews. */
export function topicPath(topic: Topic, repo?: RepoRef): string {
  return topic === "reviews" ? reviewsPath() : queuePath(topic, repo);
}
