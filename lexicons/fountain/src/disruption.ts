/**
 * What applying a pending fountain update costs (#1665, #2128).
 *
 * fountain has no registry schema to read replacement semantics out of, the way
 * the AWS row reads `createOnlyProperties`. What it has is routes, and the
 * routes say which fields a PATCH accepts and which ones are the resource's
 * identity. So this is a hand-maintained table, in the same spirit as the deep
 * observation noise rules next door, and it is deliberately narrow: it answers
 * for the three team-side kinds and says `unknown` for everything else rather
 * than inventing a claim. `unknown` is the contract's default and the only
 * value a lexicon is allowed to be wrong in the safe direction with.
 *
 * The one verdict worth arguing about is the teammate's. A teammate's
 * environment and vault are what its persistent sandbox was provisioned from,
 * and fountain retires that machine when either moves — the api doc's
 * "Sandboxes" section: a `PATCH /api/agents/:id` that moves `environment_id`,
 * or a `DELETE` on the environment or the vault, resets the machine the
 * conversation runs on. The roster entry survives the call, but the thing an
 * operator cares about does not: the sandbox is rebuilt, whatever was on its
 * disk is gone, and a long-running turn is interrupted. That is `replace`, not
 * `in-place`, and reporting it as `in-place` would be exactly the failure the
 * disruption contract exists to prevent.
 *
 * A schedule, by contrast, is a row the scheduler reads on its next tick.
 * Changing the cron, the prompt, or whether it is enabled rewrites that row —
 * `PATCH /api/team/{agent_id}/schedules/{id}` — and disturbs nothing that is
 * running. That is the `in-place` end of the vocabulary, which is what "none"
 * means here: chant's levels have no separate `none`, and `in-place` is the
 * level that says the resource keeps its identity and nothing is interrupted.
 */

import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lexicon";
import { TEAMMATE_TYPE, SCHEDULE_TYPE, WEBHOOK_TYPE } from "./deep-observe-hooks";

/**
 * Per kind, the properties that cannot change without something being rebuilt,
 * and the sentence that explains why. Names are matched in both vocabularies —
 * the wire id and the prop a chant author writes — because a delta path can
 * arrive from either reader.
 */
const REBUILDS: Readonly<Record<string, { properties: readonly string[]; detail: string }>> = {
  [TEAMMATE_TYPE]: {
    properties: ["environment", "environment_id", "vault", "vault_id", "agent", "agent_id"],
    detail:
      "a teammate's agent, environment and vault are what its persistent sandbox was provisioned from — fountain retires the machine when one moves, so the conversation resumes on a fresh disk",
  },
  [SCHEDULE_TYPE]: {
    properties: ["teammate", "agent_id"],
    detail:
      "a schedule belongs to the teammate in its route (POST /api/team/{agent_id}/schedules) — moving it to another teammate is a new schedule, not an edit to this one",
  },
};

/** Kinds whose remaining properties fountain patches without disturbing anything. */
const PATCHABLE: Readonly<Record<string, string>> = {
  [TEAMMATE_TYPE]: "PATCH /api/team/{agent_id} rewrites the roster entry in place",
  [SCHEDULE_TYPE]:
    "PATCH /api/team/{agent_id}/schedules/{id} rewrites the row the scheduler reads on its next tick — the cron, the prompt and the enabled flag all change without interrupting anything",
  [WEBHOOK_TYPE]:
    "PATCH /api/webhooks/{id} rewrites the endpoint in place — the id and the signing secret survive it",
};

/**
 * The property a delta path names. Thin-read paths arrive as
 * `attributes.<key>`; a bare property name is accepted too, so a path from any
 * other reader classifies the same way.
 */
export function propertyOf(path: string): string {
  const withoutPrefix = path.startsWith("attributes.") ? path.slice("attributes.".length) : path;
  const dot = withoutPrefix.indexOf(".");
  const head = dot === -1 ? withoutPrefix : withoutPrefix.slice(0, dot);
  return head.replace(/\[\d*\]$/, "");
}

/**
 * Envelope fields the observation reports about the record rather than the
 * configuration on it. A resource whose only delta is one of these has not been
 * reconfigured at all.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "physicalId",
  "lastUpdated",
  "id",
  "inserted_at",
  "updated_at",
]);

/** Classify one pending update. Pure — no I/O, no live read. */
export function classifyFountainChange(query: DisruptionQuery): DisruptionVerdict {
  const patchable = query.type ? PATCHABLE[query.type] : undefined;
  if (!patchable) {
    return {
      disruption: "unknown",
      detail: query.type
        ? `the fountain lexicon publishes no replacement semantics for ${query.type}`
        : "the observation reported no resource type",
    };
  }

  const considered = query.deltas
    .map((delta) => ({ path: delta.path, property: propertyOf(delta.path) }))
    .filter((c) => !ENVELOPE_FIELDS.has(c.property));

  const rebuilds = REBUILDS[query.type!];
  if (rebuilds) {
    const forced = considered.filter((c) => rebuilds.properties.includes(c.property));
    if (forced.length > 0) {
      return {
        disruption: "replace",
        because: forced.map((c) => c.path),
        detail: rebuilds.detail,
      };
    }
  }

  if (considered.length === 0) {
    return {
      disruption: "in-place",
      detail: "no configured property differs — only the record's identity or timestamps moved",
    };
  }

  return { disruption: "in-place", detail: patchable };
}

/**
 * `LexiconPlugin.classifyDisruption` for fountain. A table lookup per change,
 * no live call, and a partial answer by design: a kind this table does not
 * cover comes back `unknown` with the reason, never a guess.
 */
export function fountainDisruption(options: {
  environment: string;
  changes: DisruptionQuery[];
}): Record<string, DisruptionVerdict> {
  const out: Record<string, DisruptionVerdict> = {};
  for (const change of options.changes) {
    out[change.name] = classifyFountainChange(change);
  }
  return out;
}
