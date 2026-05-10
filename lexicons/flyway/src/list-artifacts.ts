/**
 * Live introspection of applied Flyway migrations via `flyway info -outputType=json`.
 *
 * The Flyway lexicon's chant entities describe migration *configuration*
 * (`Flyway::Project`, `Flyway::Config`, `Flyway::Environment`). The runtime
 * concept — the migration history applied to a target DB — is created by
 * `flyway migrate` outside chant's entity model. This implementation reports
 * the migration history per declared `Flyway::Environment` so `state diff
 * --live` / `WatchOp` can detect manual migrations run outside CI.
 *
 * Per-env query pattern: discovers envs via the `entities` map (see #39's
 * entity-prop pass-through). Failure on one env (DB unreachable, flyway
 * binary missing) is warn-soft; other envs still proceed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

interface FlywayMigration {
  version?: string | null;
  description?: string;
  type?: string;          // "SQL" | "JDBC" | "BASELINE" | ...
  state?: string;         // "Success" | "Failed" | "Pending" | "Baseline" | ...
  installedRank?: number;
  installedOn?: string;
  installedBy?: string;
  executionTime?: number;
  checksum?: number | string;
}

interface FlywayInfoResponse {
  migrations?: FlywayMigration[];
  schemaName?: string;
  database?: string;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export async function listArtifacts(options: {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};

  // Discover declared Flyway::Environment names from the entities map.
  const declaredEnvs: string[] = [];
  for (const [, { entityType, props }] of options.entities) {
    if (entityType !== "Flyway::Environment") continue;
    const name = props.name as string | undefined;
    if (name) declaredEnvs.push(name);
  }

  if (declaredEnvs.length === 0) return result;

  for (const envName of declaredEnvs) {
    const cmd = `flyway info -environments=${envName} -outputType=json`;
    let stdout: string;
    try {
      ({ stdout } = await execAsync(cmd));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[flyway] failed to query info for environment "${envName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    let parsed: FlywayInfoResponse;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[flyway] malformed JSON output for environment "${envName}"`);
      continue;
    }

    for (const migration of parsed.migrations ?? []) {
      const version = migration.version ?? "<unversioned>";
      const key = `migration/${envName}/${version}`;
      result[key] = {
        type: "Flyway::Migration",
        physicalId: `${envName}/${version}`,
        status: migration.state ?? "unknown",
        lastUpdated: migration.installedOn,
        attributes: pruneUndefined({
          environment: envName,
          description: migration.description,
          migrationType: migration.type,
          installedRank: migration.installedRank,
          installedBy: migration.installedBy,
          executionTimeMs: migration.executionTime,
          checksum: migration.checksum,
        }),
      };
    }
  }

  return result;
}
