/**
 * #2131 deletes this file.
 *
 * What is left here is not part of `chant run` any more — #2116 removed the
 * Temporal runtime, and with it every core caller of this module. It survives
 * one issue longer because `lexicons/temporal`'s `describe-resources.ts` and
 * `deep-observe.ts` import these four names, and that lexicon has to keep
 * building against core until #2131 removes the directory. Nothing in
 * `packages/core` imports this file; do not add a caller.
 */

/** Subset of a worker profile these two lexicon readers need. */
export interface WorkerProfile {
  address: string;
  namespace: string;
  taskQueue: string;
  tls?: boolean | { serverNameOverride?: string };
  apiKey?: string | { env: string };
  autoStart?: boolean;
}

/**
 * Deliberately loose: both callers immediately cast to their own richer shape,
 * because what they reach for (`workflowService`, `operatorService`,
 * `scheduleClient`) was never modelled here.
 */
export interface TemporalClientModule {
  Connection: { connect(opts: Record<string, unknown>): Promise<unknown> };
  Client: new (opts: Record<string, unknown>) => unknown;
}

/** Dynamically import the client from the user's project node_modules. */
export async function loadTemporalClient(): Promise<TemporalClientModule> {
  try {
    // Variable specifier so tsc does not statically resolve the optional dep.
    const mod = "@temporalio/client";
    return await import(mod) as unknown as TemporalClientModule;
  } catch {
    throw new Error("@temporalio/client is not installed. Run: npm install @temporalio/client");
  }
}

/** Build a `Connection.connect()` options object from a worker profile. */
export function connectionOptions(profile: WorkerProfile): Record<string, unknown> {
  const apiKey =
    typeof profile.apiKey === "object" && profile.apiKey !== null
      ? process.env[(profile.apiKey as { env: string }).env]
      : (profile.apiKey as string | undefined);

  return {
    address: profile.address,
    ...(profile.tls && {
      tls: typeof profile.tls === "object" ? profile.tls : {},
      metadata: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }),
  };
}

/** Resolve a named profile from the chant config; falls back to defaultProfile then "local". */
export function resolveProfile(
  config: Record<string, unknown>,
  profileName?: string,
): WorkerProfile {
  const temporal = (config as { temporal?: Record<string, unknown> }).temporal;
  if (!temporal?.profiles) {
    throw new Error("No temporal.profiles found in chant.config.ts.");
  }
  const profiles = temporal.profiles as Record<string, WorkerProfile>;
  const name = profileName ?? (temporal.defaultProfile as string | undefined) ?? "local";
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ")}`);
  }
  return profile;
}
