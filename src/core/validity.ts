/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// What GitHub's own validity check says about a leaked credential (#158).
//
// In core because two layers act on the same two words and may not import
// each other: the adapter maps them at the boundary, and the queue builder
// reads one of them to decide whether the finding reaches `now`. A literal
// in each would be the drift AD-22 is about, one field over - the mapper
// could start writing `Inactive` and the queue would go on promoting it.

/**
 * The token status GitHub reports, or ours where it reported none.
 *
 * `unknown` is BOTH a value GitHub sends and what an absent field maps to,
 * because the schema makes `validity` optional and also gives it this
 * literal. The two mean the same thing to a reader and must store the same
 * value, or one repository's finding would read differently from its
 * identical neighbour's.
 */
export const VALIDITY_UNKNOWN = "unknown";

/**
 * GitHub checked the credential and it no longer works.
 *
 * The one value that costs a finding its urgency. GitHub keeps the alert
 * `state: "open"` after reporting this - it stays open until a human closes
 * it by hand - so a lane that asks only for open alerts goes on collecting a
 * credential nobody can use any more.
 */
export const VALIDITY_INACTIVE = "inactive";
