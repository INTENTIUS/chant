/**
 * The `search` document of the read contract (#4374, ws-017): what
 * `chant search --json` and `chant workspace search` print, described by
 * `search.schema.json` beside this file.
 *
 * Both forms print one document. `chant search` answers over one project, and
 * `chant workspace search` runs that same command in every member, under the
 * member's own chant (ws-021), and composes the answers with the `<member>/<id>`
 * ids `chant workspace graph` gives the same nodes (`search-cli.ts`).
 *
 * This module holds the constants both forms share and imports nothing heavy,
 * since `cli/handlers/search.ts` loads it on every `--json` run.
 */

import type { ReasonCode } from "./reason-codes";

/** The version of the `search` document this chant writes. */
export const SEARCH_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const SEARCH_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json";

/**
 * Why `chant search` printed no answer. A member's own refusal under
 * `chant workspace search` carries the same code as its reason.
 */
export const SEARCH_ERROR_CODES = [
  /** No query, a term the grammar refuses, or a --count-by that is not a grouping. */
  "query-invalid",
  /** A flag that needs another, or two that exclude each other. */
  "usage-invalid",
  /** --env names an environment the project's config does not declare. */
  "environment-unknown",
  /** --snapshot (or plain search's --at) names nothing replay can answer from. */
  "snapshot-unavailable",
  /** The build, or a build root, failed: the graph would be incomplete. */
  "build-failed",
  /** --index names no index version the store holds, or one stamped for another scope (#4525). */
  "index-unavailable",
] as const satisfies readonly ReasonCode[];
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/**
 * Why `chant workspace search` printed no answer: the declaration's codes and
 * `--at`'s, the two times given together, and a query or usage refused before
 * any member ran.
 */
export const WORKSPACE_SEARCH_ERROR_CODES = [
  "declaration-missing",
  "declaration-ambiguous",
  "declaration-unparseable",
  "declaration-invalid",
  "placement-invalid",
  "reader-too-old",
  "root-chant-required",
  "not-a-git-repository",
  "revision-unknown",
  "live-at-revision",
  "snapshot-at-revision",
  "query-invalid",
  "usage-invalid",
] as const satisfies readonly ReasonCode[];
export type WorkspaceSearchErrorCode = (typeof WORKSPACE_SEARCH_ERROR_CODES)[number];

/** Every `error.code` a `search` document can carry, in either form. */
export const SEARCH_DOCUMENT_ERROR_CODES = [...new Set<ReasonCode>([...WORKSPACE_SEARCH_ERROR_CODES, ...SEARCH_ERROR_CODES])];

/**
 * Why a member of `chant workspace search` has no answer. A member that ran
 * and refused carries its own {@link SEARCH_ERROR_CODES} code; the rest are
 * the per-member codes `workspace graph` uses, and `member-chant-too-old`.
 */
export const SEARCH_MEMBER_REASON_CODES = [
  "kind-not-run",
  "dir-missing",
  "unknown-kind",
  "kind-probe-failed",
  "command-failed",
  "output-unreadable",
  "member-chant-too-old",
  ...SEARCH_ERROR_CODES,
] as const satisfies readonly ReasonCode[];
export type SearchMemberReasonCode = (typeof SEARCH_MEMBER_REASON_CODES)[number];

/** The head every `search` document opens with. */
export interface SearchHead {
  $schema: typeof SEARCH_OUTPUT_SCHEMA_ID;
  contract: typeof SEARCH_CONTRACT_VERSION;
  /** The chant that wrote the document. */
  chant: string;
}

/** A refusal: no answer, exit 1. `hint` is the line stderr prints after the error, when there is one. */
export interface SearchFailure extends SearchHead {
  query: string;
  error: { code: string; message: string; hint?: string };
}
