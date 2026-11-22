/**
 * Where each workspace member's state lives, per environment (#5456).
 *
 * `chant workspace state` answers one question for a reader that draws an
 * estate: for each member, and each environment the member's own read names,
 * which substrate holds its state (a Terraform backend, a CloudFormation
 * stack, a record store), where that is, how it is locked, and whether the
 * read with the caller's credentials could reach it.
 *
 * chant computes none of it. Each lexicon reads its own configuration (the
 * terraform lexicon the backend block, the aws lexicon the stacks a member
 * names) and publishes the answer on the `stateLocations` key of its member
 * graph's `meta`, as {@link StateLocation} entries. The command reads every
 * member through `chant workspace graph`, so each member is read under its own
 * chant, and projects those entries into one document. A member whose lexicon
 * publishes none is listed with `published: false`, never with an invented
 * location.
 *
 * Values that carry a secret are masked here, whatever the lexicon sent: a key
 * that names a credential is replaced with `***`, and the user and password of
 * a URL are removed.
 */

import { NEXT_RELEASE } from "../release-floors";
import type { ComposedMember, MemberReason, WorkspaceGraph } from "./compose-graph";

/**
 * The first chant with `chant workspace state`: for each member and environment, the substrate, backend, location, lock and reach of its state, read from the `stateLocations` each member's lexicon publishes on its graph `meta`, with `--json` and the `state` output schema (#5456).
 */
export const WORKSPACE_STATE_LOCATIONS_FLOOR = NEXT_RELEASE;

/** The version of the `state` document this chant writes. */
export const STATE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const STATE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/state/v1/state.schema.json";

/** The `meta` key a lexicon publishes its members' state locations under. */
export const STATE_LOCATIONS_META_KEY = "stateLocations";

/** What a location value holds. */
export type StateScalar = string | number | boolean | null;

/** Whether the read with the caller's credentials could reach the state. */
export type StateReach =
  /** The read reached it. */
  | { status: "reachable" }
  /** The read tried and could not; `reason` says why. */
  | { status: "unreachable"; reason: string }
  /** Nothing tried: finding the location reads configuration only. `reason` may say why a check is not made. */
  | { status: "unchecked"; reason?: string };

/** One place a member's state lives, in one environment. */
export interface StateLocation {
  /** The environment, or null when the member declares none. */
  environment: string | null;
  /** The part of the member this is, when it has several: a Terraform root, a stack. */
  unit?: string;
  /** The lexicon that read it: `terraform`, `aws`. */
  substrate: string;
  backend: {
    /** What holds the state: `s3`, `gcs`, `azurerm`, `http`, `local`, `cloud`, `cloudformation-stack`, `choudoufu-record-store:s3`. */
    kind: string;
    /** Where, as the backend names it: a bucket and key, a stack and region. Secrets are masked. */
    location: Record<string, StateScalar>;
  };
  /** How the state is locked, or null when it is not. */
  lock: { mechanism: string; location?: Record<string, StateScalar> } | null;
  reach: StateReach;
}

/** One member in the document. */
export interface StateMember {
  member: string;
  kind: string;
  /** `read` when the member's graph was read, `skipped` for a kind the per-member reads don't run, `failed` when it could not be read. */
  status: "read" | "skipped" | "failed";
  reason: MemberReason | null;
  /** Whether the member's lexicon publishes state locations. False for a member read that published none. */
  published: boolean;
  /** One entry per environment and unit. Empty when `published` is false. */
  states: StateLocation[];
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

/** What `chant workspace state --json` prints. */
export type StateDocument =
  | (Head & {
      at: string | null;
      workspace: { name: string; root: string; repo?: string | null };
      /** The `--env` the read was asked for, or null for every environment each member names. */
      environment: string | null;
      members: StateMember[];
      summary: { members: number; published: number; locations: number; unreachable: number };
    })
  | (Head & { error: { code: string; message: string; location: unknown } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A key whose value is a credential. */
const SECRET_KEY = /(secret|token|password|passwd|credential|private[_-]?key|api[_-]?key|access[_-]?key|account[_-]?key|sas|bearer|authorization)/i;

/** The user and password of a URL, removed. Anything that is not a URL with credentials is returned as it was. */
export function withoutUrlCredentials(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, "$1");
}

function maskValue(key: string, value: unknown): StateScalar {
  if (SECRET_KEY.test(key)) return value === null || value === undefined || value === "" ? null : "***";
  if (typeof value === "string") return withoutUrlCredentials(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}

function maskLocation(v: unknown): Record<string, StateScalar> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, StateScalar> = {};
  for (const key of Object.keys(v).sort()) out[key] = maskValue(key, v[key]);
  return out;
}

function reachOf(v: unknown): StateReach {
  if (isObject(v)) {
    if (v.status === "reachable") return { status: "reachable" };
    if (v.status === "unreachable" && typeof v.reason === "string") return { status: "unreachable", reason: v.reason };
    if (v.status === "unchecked") return typeof v.reason === "string" ? { status: "unchecked", reason: v.reason } : { status: "unchecked" };
  }
  return { status: "unchecked" };
}

/**
 * The entries a lexicon published, checked and masked. An entry without a
 * substrate, a backend kind and a location is dropped: a reader never gets a
 * half-formed location.
 */
export function readStateLocations(meta: Record<string, unknown> | undefined): { published: boolean; states: StateLocation[] } {
  const raw = meta?.[STATE_LOCATIONS_META_KEY];
  if (!Array.isArray(raw)) return { published: false, states: [] };
  const states: StateLocation[] = [];
  for (const e of raw) {
    if (!isObject(e) || typeof e.substrate !== "string" || !isObject(e.backend) || typeof e.backend.kind !== "string") continue;
    const location = maskLocation(e.backend.location);
    if (!location) continue;
    const lockRaw = e.lock;
    const lock = isObject(lockRaw) && typeof lockRaw.mechanism === "string"
      ? { mechanism: lockRaw.mechanism, ...(maskLocation(lockRaw.location) ? { location: maskLocation(lockRaw.location)! } : {}) }
      : null;
    states.push({
      environment: typeof e.environment === "string" ? e.environment : null,
      ...(typeof e.unit === "string" ? { unit: e.unit } : {}),
      substrate: e.substrate,
      backend: { kind: e.backend.kind, location },
      lock,
      reach: reachOf(e.reach),
    });
  }
  states.sort((a, b) => (a.environment ?? "").localeCompare(b.environment ?? "") || (a.unit ?? "").localeCompare(b.unit ?? "") || a.backend.kind.localeCompare(b.backend.kind));
  return { published: true, states };
}

/** One composed member as a state member. */
export function stateMember(m: ComposedMember, environment: string | null): StateMember {
  const status = m.status === "composed" ? "read" : m.status;
  if (m.status !== "composed") return { member: m.name, kind: m.kind, status, reason: m.reason, published: false, states: [] };
  const { published, states } = readStateLocations(m.meta);
  return { member: m.name, kind: m.kind, status, reason: null, published, states: environment === null ? states : states.filter((s) => s.environment === null || s.environment === environment) };
}

/** The document for a composed workspace graph. */
export function stateDocument(graph: WorkspaceGraph, head: Head & { at: string | null }, environment: string | null): Extract<StateDocument, { members: unknown }> {
  const members = graph.members.map((m) => stateMember(m, environment)).sort((a, b) => a.member.localeCompare(b.member));
  const locations = members.flatMap((m) => m.states);
  return {
    ...head,
    workspace: graph.workspace,
    environment,
    members,
    summary: {
      members: members.length,
      published: members.filter((m) => m.published).length,
      locations: locations.length,
      unreachable: locations.filter((s) => s.reach.status === "unreachable").length,
    },
  };
}
