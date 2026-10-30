/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { watchKey } from "../../core/slug.js";
import type { Topic } from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";

// Every internal path, built here and nowhere else (AD-39).
//
// A page that concatenates `/repo/${slug}` by hand is one edit away from a
// second spelling of the same route, and a query value typed inline is one
// edit away from a filter the overview does not recognise. So the paths are
// functions, and the repository is emitted through `watchKey` (the one folding
// every layer agrees on, AD-33).

/** The overview. */
export function overviewPath(): string {
  return "/";
}

/** The per-repository page. The slug is already folded; each segment is encoded. */
export function repoPath(slug: string): string {
  return `/repo/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * An internal path joined to TRICORDER_BASE_URL, for a link that leaves the
 * dashboard (a notification, Epic 4). The base's own path is kept and its
 * trailing slashes dropped, so a deployment under a prefix still lands. The
 * path must be one of the helpers' above, which all start with `/`; anything
 * else is a programming error, not a link.
 */
export function absoluteUrl(base: URL, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`absoluteUrl needs a path starting with /: ${path}`);
  }
  return `${base.href.replace(/\/+$/, "")}${path}`;
}

/** The overview box a topic falls under. CI and issues have none. */
const TOPIC_KIND: Partial<Readonly<Record<Topic, string>>> = {
  security: "SECURITY",
  dependencies: "PULL REQUESTS",
  pulls: "PULL REQUESTS",
  reviews: "PULL REQUESTS",
};

/** Where a topic's tile or chip leads: the overview, filtered as far as it can be. */
export function topicPath(topic: Topic, repo?: RepoRef): string {
  const params = new URLSearchParams();
  const kind = TOPIC_KIND[topic];
  if (kind !== undefined) params.set("kind", kind);
  // Review requests land outside the allowlist, so they stay unnarrowed.
  if (repo !== undefined && topic !== "reviews") {
    params.set("repo", watchKey(repo));
  }
  const query = params.toString();
  return query === "" ? overviewPath() : `${overviewPath()}?${query}`;
}
