/**
 * Pure export helpers for the fly lexicon — strip live flaps state to the
 * authored shape and build import IR from it. All flaps I/O stays in the caller
 * (`../export-resources`); this module is deterministic and unit-testable.
 *
 * The strip mirrors the read-only field lists the parser drops, so a live
 * machine/app reaches the same declared shape a user would have written. Machine
 * ownership is a per-resource marker (`managed-by: chant` in `config.metadata`,
 * read via `isChantOwned`); the app carries no marker, so under the `owned`
 * filter its ownership is inferred at the app boundary (an app is chant-managed
 * when one of its machines is), and the limitation is logged rather than
 * silently returning everything — the seam contract, matching gcp/aws.
 *
 * `verbatim` is inert for fly (the core contract permits this for targets whose
 * importable surface is already the declared shape): the App/Machine
 * constructors accept only the writable surface, so server-written fields are
 * not constructor parameters and cannot round-trip into the generated code. The
 * option is accepted for signature parity.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { isChantOwned, type FlapsMachine } from "../op/activities/fly-apply";
import {
  FlyParser,
  MACHINE_SERVER_FIELDS,
  APP_SERVER_FIELDS,
} from "./parser";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Drop server-written read-only machine fields to reach the authored shape. Returns a new object. */
export function stripMachineServerFields(machine: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(machine)) as Record<string, unknown>;
  for (const f of MACHINE_SERVER_FIELDS) delete clone[f];
  return clone;
}

/** Drop server-written read-only app fields, keeping `name`/`org_slug`. Returns a new object. */
export function stripAppServerFields(app: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(app)) as Record<string, unknown>;
  // Carry the org slug down before dropping the organization object it rides on.
  if (clone.org_slug === undefined && isRecord(clone.organization) && typeof clone.organization.slug === "string") {
    clone.org_slug = clone.organization.slug;
  }
  for (const f of APP_SERVER_FIELDS) delete clone[f];
  return clone;
}

/**
 * Build export IR from one app's live flaps state. Reuses {@link FlyParser} as
 * the single wire→authoring mapping authority by feeding it a cleaned
 * app-with-machines bundle.
 *
 * `opts.owned` keeps only machines carrying the chant marker, and includes the
 * app only when it is chant-managed (a machine is). `opts.verbatim` keeps server
 * fields. Pure: logging is delegated to `opts.onBoundaryInference`, which the
 * I/O caller wires to a single warn.
 */
export function buildExportFromApp(
  app: Record<string, unknown> | undefined,
  machines: FlapsMachine[],
  opts: {
    verbatim?: boolean;
    selector?: ResourceSelector;
    owned?: boolean;
    onBoundaryInference?: () => void;
  } = {},
): ExportedTemplate {
  const appManaged = machines.some((m) => isChantOwned(m.config?.metadata));

  const keptMachines = opts.owned
    ? machines.filter((m) => isChantOwned(m.config?.metadata))
    : machines;

  // The app has no per-resource marker; under `owned` it rides the app boundary.
  let keptApp = app;
  if (opts.owned && app) {
    opts.onBoundaryInference?.();
    if (!appManaged) keptApp = undefined;
  }

  // The parser maps to the writable surface regardless; the explicit strip here
  // keeps the pure cleaning layer visible and testable. `verbatim` is inert (see
  // module header) — server fields are not App/Machine constructor parameters.
  const cleanMachines = keptMachines.map((m) =>
    stripMachineServerFields(m as unknown as Record<string, unknown>),
  );
  const cleanApp = keptApp ? stripAppServerFields(keptApp) : keptApp;

  const bundle: Record<string, unknown> = { ...(cleanApp ?? {}), machines: cleanMachines };
  const ir = new FlyParser().parse(JSON.stringify(bundle));

  const selector = opts.selector;
  if (!selector || (selector.type === undefined && selector.name === undefined)) {
    return ir;
  }
  return {
    ...ir,
    resources: ir.resources.filter(
      (r) =>
        (selector.type === undefined || r.type === selector.type) &&
        (selector.name === undefined || r.logicalId === selector.name),
    ),
  };
}
