/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { z } from "zod";

// The typed plan the advisor (LLM) must return. The advisor has no write
// tools — this plan is purely advisory. The executor re-validates every gate
// before acting, so a malformed or manipulated plan can never widen authority.

export const PrDecisionSchema = z.object({
  number: z.number().int(),
  action: z.enum(["merge", "hold"]),
  reason: z.string(),
  risk: z.enum(["low", "medium", "high"]),
});

export const RepoReleaseDecisionSchema = z.object({
  action: z.enum(["release", "wait"]),
  reason: z.string(),
  // Advisory only — the executor deterministically recomputes the version.
  version: z.string().optional(),
  notes: z.string().optional(),
});

export const RepoPlanSchema = z.object({
  repo: z.string(),
  prDecisions: z.array(PrDecisionSchema),
  release: RepoReleaseDecisionSchema,
});

export const PlanSchema = z.object({
  repos: z.array(RepoPlanSchema),
});

export type PrDecision = z.infer<typeof PrDecisionSchema>;
export type RepoReleaseDecision = z.infer<typeof RepoReleaseDecisionSchema>;
export type RepoPlan = z.infer<typeof RepoPlanSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/**
 * JSON Schema for the Anthropic tool input. This is the ONLY tool the advisor
 * is given, and it merely returns the plan — there is no GitHub-mutating tool.
 */
export const planJsonSchema = {
  type: "object",
  properties: {
    repos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          repo: { type: "string", description: "owner/name" },
          prDecisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "integer" },
                action: { type: "string", enum: ["merge", "hold"] },
                reason: { type: "string" },
                risk: { type: "string", enum: ["low", "medium", "high"] },
              },
              required: ["number", "action", "reason", "risk"],
            },
          },
          release: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["release", "wait"] },
              reason: { type: "string" },
              notes: { type: "string" },
            },
            required: ["action", "reason"],
          },
        },
        required: ["repo", "prDecisions", "release"],
      },
    },
  },
  required: ["repos"],
} as const;
