/**
 * Env teardown for the fly lexicon (chant #1222) — both halves of the
 * `teardownOwned` / `executeTeardown` capability pair, over the applier's own
 * flaps primitives (op/activities/fly-apply.ts).
 *
 * Selection follows the two-tier ownership convention (#743, D2):
 *
 *   - Machines carry the primary marker in `config.metadata`
 *     (`managed-by: chant` + `chant-stack` + `chant-env`), so a machine is a
 *     candidate exactly when its own metadata reads back the requested
 *     stack + env identity.
 *   - The app is the boundary for everything metadata-less (volumes, IPs,
 *     certificates, secrets). An app becomes a candidate only when it has at
 *     least one machine and EVERY machine in it carries the requested
 *     identity — an app also hosting a foreign or other-env machine is never
 *     deleted whole; only its matching machines are.
 *
 * Enumeration lists apps via `GET /v1/apps` (mudflaps serves it as-is; real
 * flaps wants `?org_slug=`, appended from FLY_ORG / FLY_ORG_SLUG when set)
 * and each app's machines. An unlistable app is a hole (#1089) — unknown,
 * never absent.
 *
 * Execution deletes machines first (lease → destroy → wait, the applier's
 * `destroyMachine`) and apps last (`deleteApp`, which takes the app-scoped
 * volumes/IPs/certs with it). Before every delete the live side is re-read
 * and the identity re-verified; already-gone is `deleted` (teardown is
 * idempotent), an identity mismatch is `not-prunable`, never a delete.
 */

import type {
  TeardownCandidate,
  TeardownEnumeration,
  TeardownExecution,
  TeardownHole,
  TeardownOutcome,
} from "@intentius/chant/lexicon";
import { readOwnership, type OwnershipMarker } from "@intentius/chant/ownership";
import { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";
import {
  resolveEndpoint,
  defaultFlyHttp,
  listMachines,
  destroyMachine,
  deleteApp,
  type ApplyCtx,
  type FlapsMachine,
  type FlyHttp,
  type WaitOpts,
} from "./op/activities/fly-apply";

const APP_TYPE = "Fly::Machines::App";
const MACHINE_TYPE = "Fly::Machines::Machine";

/** Live machine states that mean the machine is gone or on its way out. */
const TERMINAL_STATES = new Set(["destroyed", "destroying"]);

export interface FlyTeardownOptions {
  environment: string;
  marker: OwnershipMarker;
}

/** Injection seam for tests: scripted http, explicit endpoint, shrunk waits. */
export interface FlyTeardownDeps {
  http?: FlyHttp;
  endpoint?: string;
  wait?: WaitOpts;
}

/** True when a machine's own metadata reads back exactly the requested identity. */
function matchesMarker(machine: FlapsMachine, marker: OwnershipMarker): boolean {
  const read = readOwnership(machine.config?.metadata, FLY_METADATA_OWNERSHIP_KEYS);
  return read !== undefined && read.stack === marker.stack && read.env === marker.env;
}

/** Machines that are actually live — terminal ones are already gone. */
function liveMachines(machines: FlapsMachine[]): FlapsMachine[] {
  return machines.filter((m) => !TERMINAL_STATES.has(m.state));
}

/** `GET /v1/apps`, with `?org_slug=` appended when the env names an org. */
async function listApps(
  ctx: ApplyCtx,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<string[]> {
  const org = process.env.FLY_ORG || process.env.FLY_ORG_SLUG;
  const url = `${ctx.base}/v1/apps${org ? `?org_slug=${encodeURIComponent(org)}` : ""}`;
  const res = await http("GET", url, undefined, undefined, signal);
  if (res.status >= 300) throw new Error(`app list failed (${res.status}): ${res.text}`);
  const body = JSON.parse(res.text) as { apps?: Array<{ name?: string }> };
  return (body.apps ?? []).map((a) => a.name).filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Enumerate the env's marker-matching machines and whole-app boundaries — the
 * fly half of `chant lifecycle teardown <env>` planning.
 */
export async function teardownOwned(
  options: FlyTeardownOptions,
  deps: FlyTeardownDeps = {},
): Promise<TeardownEnumeration> {
  const http = deps.http ?? defaultFlyHttp();
  const ctx: ApplyCtx = { base: resolveEndpoint({ ...(deps.endpoint ? { endpoint: deps.endpoint } : {}) }) };

  const candidates: TeardownCandidate[] = [];
  const holes: TeardownHole[] = [];

  const apps = await listApps(ctx, http); // a failed app list throws — core turns it into a whole-lexicon hole

  for (const app of apps) {
    let machines: FlapsMachine[];
    try {
      machines = liveMachines(await listMachines(ctx, app, http));
    } catch (err) {
      holes.push({
        name: app,
        type: APP_TYPE,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const matching = machines.filter((m) => matchesMarker(m, options.marker));
    for (const m of matching) {
      candidates.push({
        name: `${app}/${m.name}`,
        type: MACHINE_TYPE,
        physicalId: m.id,
        marker: readOwnership(m.config?.metadata, FLY_METADATA_OWNERSHIP_KEYS)!,
      });
    }

    // The app boundary: whole-app delete only when every live machine carries
    // the requested identity. Its marker is read back off its machines — the
    // only channel an app has (#743).
    if (machines.length > 0 && matching.length === machines.length) {
      candidates.push({
        name: app,
        type: APP_TYPE,
        marker: readOwnership(matching[0].config?.metadata, FLY_METADATA_OWNERSHIP_KEYS)!,
      });
    }
  }

  return { candidates, ...(holes.length > 0 ? { holes } : {}) };
}

/**
 * Delete the handed-over candidates: machines first, apps last. One outcome
 * per candidate, always.
 */
export async function executeTeardown(
  options: FlyTeardownOptions & { candidates: TeardownCandidate[] },
  deps: FlyTeardownDeps = {},
): Promise<TeardownExecution> {
  const http = deps.http ?? defaultFlyHttp();
  const ctx: ApplyCtx = { base: resolveEndpoint({ ...(deps.endpoint ? { endpoint: deps.endpoint } : {}) }) };

  const outcomes: TeardownOutcome[] = [];

  for (const candidate of options.candidates.filter((c) => c.type === MACHINE_TYPE)) {
    outcomes.push(await destroyMachineCandidate(ctx, candidate, options.marker, http, deps.wait));
  }
  for (const candidate of options.candidates.filter((c) => c.type === APP_TYPE)) {
    outcomes.push(await deleteAppCandidate(ctx, candidate, options.marker, http));
  }
  for (const candidate of options.candidates) {
    if (candidate.type === MACHINE_TYPE || candidate.type === APP_TYPE) continue;
    outcomes.push({
      name: candidate.name,
      type: candidate.type,
      outcome: "not-prunable",
      detail: `fly teardown deletes machines and apps; ${candidate.type} is app-scoped and goes with its app`,
    });
  }

  return { outcomes };
}

async function destroyMachineCandidate(
  ctx: ApplyCtx,
  candidate: TeardownCandidate,
  marker: OwnershipMarker,
  http: FlyHttp,
  wait?: WaitOpts,
): Promise<TeardownOutcome> {
  const base = {
    name: candidate.name,
    type: candidate.type,
    ...(candidate.physicalId ? { physicalId: candidate.physicalId } : {}),
  };
  const slash = candidate.name.indexOf("/");
  if (slash <= 0) {
    return { ...base, outcome: "not-prunable", detail: "machine candidate name is not app/machine-shaped" };
  }
  const app = candidate.name.slice(0, slash);
  const machineName = candidate.name.slice(slash + 1);

  let machines: FlapsMachine[];
  try {
    machines = await listMachines(ctx, app, http);
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }

  const live = liveMachines(machines).find((m) =>
    candidate.physicalId ? m.id === candidate.physicalId : m.name === machineName,
  );
  if (!live) {
    return { ...base, outcome: "deleted", detail: "already absent" };
  }
  // Re-verify right before destroying — a delete is not undoable.
  if (!matchesMarker(live, marker)) {
    return {
      ...base,
      outcome: "not-prunable",
      detail: "the live machine no longer carries the requested marker identity",
    };
  }

  try {
    await destroyMachine(ctx, app, live.id, http, undefined, wait ?? {});
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ...base, outcome: "deleted" };
}

async function deleteAppCandidate(
  ctx: ApplyCtx,
  candidate: TeardownCandidate,
  marker: OwnershipMarker,
  http: FlyHttp,
): Promise<TeardownOutcome> {
  const base = { name: candidate.name, type: candidate.type };
  const app = candidate.name;

  // The boundary re-check: an app that (still, or again) hosts any machine
  // outside the requested identity is not deleted whole. Machines this same
  // execution just destroyed are gone by now — destroyMachine waits.
  let machines: FlapsMachine[];
  try {
    machines = liveMachines(await listMachines(ctx, app, http));
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  const foreign = machines.filter((m) => !matchesMarker(m, marker));
  if (foreign.length > 0) {
    return {
      ...base,
      outcome: "not-prunable",
      detail: `the app hosts ${foreign.length} machine(s) outside the requested identity`,
    };
  }

  try {
    const result = await deleteApp(ctx, app, http);
    return result.deleted ? { ...base, outcome: "deleted" } : { ...base, outcome: "deleted", detail: "already absent" };
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
