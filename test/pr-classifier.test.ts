/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPullRequest,
  isConfiguredBot,
  normaliseActor,
} from "../src/core/pr-classifier.js";

// One pull request, one kind (#167). The partition both lanes read.

/** The estate's real configuration spelling, from repos.example.yaml. */
const CONFIGURED = ["app/dependabot", "app/renovate"];

describe("normaliseActor", () => {
  it("folds the three spellings of one actor onto one value", () => {
    // Not three arbitrary strings: `app/dependabot` is what a search
    // qualifier wants and what repos.yaml carries, `dependabot[bot]` is what
    // GitHub's payloads carry, and `dependabot` is what some GraphQL nodes
    // answer. Comparing any two raw says "different actor", which files one
    // pull request under both kinds at once.
    expect(normaliseActor("app/dependabot")).toBe("dependabot");
    expect(normaliseActor("dependabot[bot]")).toBe("dependabot");
    expect(normaliseActor("dependabot")).toBe("dependabot");
  });

  it("folds case and surrounding space, because logins are case-insensitive", () => {
    expect(normaliseActor("App/Dependabot")).toBe("dependabot");
    expect(normaliseActor("  DEPENDABOT[bot] ")).toBe("dependabot");
  });

  it("strips the prefix and the suffix together, not one or the other", () => {
    // Nothing stops `app/dependabot[bot]` being written into repos.yaml, and
    // it names the same actor. A fold that returned after the prefix would
    // leave `dependabot[bot]` and match nothing.
    expect(normaliseActor("app/dependabot[bot]")).toBe("dependabot");
  });

  it("leaves a human login alone", () => {
    // No substring rule: `apple` does not begin with the `app/` prefix, and
    // `robot` does not end with the `[bot]` suffix.
    expect(normaliseActor("apple")).toBe("apple");
    expect(normaliseActor("robot")).toBe("robot");
    expect(normaliseActor("a-contributor")).toBe("a-contributor");
  });
});

describe("isConfiguredBot", () => {
  it("matches the config's spelling against the payload's", () => {
    // The measured pair on this estate: config says `app/dependabot`,
    // every one of the 19 open pull requests says `dependabot[bot]`.
    expect(isConfiguredBot("dependabot[bot]", CONFIGURED)).toBe(true);
    expect(isConfiguredBot("renovate[bot]", CONFIGURED)).toBe(true);
  });

  it("answers false for everyone when nothing is configured", () => {
    // AD-19: no bot literal exists in source, so an empty list means no
    // actor is a bot and every pull request is a human one. The entrypoint
    // says so loudly; this is the behaviour it is loud about.
    expect(isConfiguredBot("dependabot[bot]", [])).toBe(false);
    expect(isConfiguredBot("a-contributor", [])).toBe(false);
  });

  it("answers false for an actor nobody configured", () => {
    expect(isConfiguredBot("a-contributor", CONFIGURED)).toBe(false);
    // A bot by every convention, and still not one here: the list is the
    // whole of what this system knows about bots.
    expect(isConfiguredBot("some-other[bot]", CONFIGURED)).toBe(false);
  });
});

describe("classifyPullRequest", () => {
  it("partitions the open pull requests between the two lanes", () => {
    expect(classifyPullRequest("dependabot[bot]", CONFIGURED)).toBe(
      "dependency_update_pr",
    );
    expect(classifyPullRequest("a-contributor", CONFIGURED)).toBe(
      "pull_request",
    );
  });

  it("makes every pull request a human one when no actor is configured", () => {
    expect(classifyPullRequest("dependabot[bot]", [])).toBe("pull_request");
  });
});

describe("AD-19: no bot login literal in the classifier", () => {
  it("names no bot anywhere in its source", () => {
    // The rule this module exists to keep. A literal here would make
    // `bots:` decorative: adding Renovate to the config must make its pull
    // requests classify with no code change, and removing every entry must
    // make every pull request a human one.
    //
    // Read from disk rather than asserted about behaviour, because a
    // hard-coded fallback is invisible from the outside on any input that
    // also matches the configuration.
    const source = readFileSync(
      join(import.meta.dirname, "../src/core/pr-classifier.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      // Comments name the bots on purpose: the whole point of the module is
      // explained by the three spellings of one, and a rule that banned them
      // from the prose would be a rule against documenting the reason.
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const bot of ["dependabot", "renovate"]) {
      expect(code.toLowerCase()).not.toContain(bot);
    }
    // `app/` and `[bot]` ARE in the code, and must be: they are GitHub's own
    // qualifier prefix and account-type suffix, which is what the fold is
    // for. AD-19 is about naming an ACTOR, not about knowing how GitHub
    // spells one.
    expect(code).toContain("[bot]");
  });
});
