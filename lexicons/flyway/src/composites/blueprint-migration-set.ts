/**
 * BlueprintMigrationSet composite — migration file name metadata objects +
 * callback file name metadata objects.
 *
 * A higher-level construct that generates Flyway-convention file names
 * for versioned migrations and SQL callbacks, useful for scaffolding
 * a migration directory layout.
 */

export interface MigrationVersion {
  /** Version string (e.g., "1", "1.1", "2.0.1"). */
  version: string;
  /** Human-readable description (used in file name, spaces become underscores). */
  description: string;
  /** Migration type prefix — "V" for versioned, "U" for undo, "R" for repeatable (default: "V"). */
  type?: "V" | "U" | "R";
}

export interface MigrationFileEntry {
  /** Flyway-convention file name (e.g., "V1__Create_users_table.sql"). */
  fileName: string;
  /** The version string (e.g., "1"). Undefined for repeatable migrations. */
  version?: string;
  /** The description portion of the file name. */
  description: string;
  /** The migration type prefix. */
  type: "V" | "U" | "R";
}

export interface CallbackFileEntry {
  /** Flyway-convention callback file name (e.g., "afterMigrate.sql"). */
  fileName: string;
  /** The callback event name. */
  event: string;
}

export interface BlueprintMigrationSetProps {
  /** List of migration versions to generate file names for. */
  versions: MigrationVersion[];
  /** List of callback event names to generate file names for. */
  callbacks?: string[];
  /** File extension (default: "sql"). */
  extension?: string;
  /** Separator between version and description (default: "__"). */
  separator?: string;
}

export interface BlueprintMigrationSetResult {
  /** Metadata objects for each migration file. */
  migrations: MigrationFileEntry[];
  /** Metadata objects for each callback file. */
  callbacks: CallbackFileEntry[];
}

/**
 * Create a BlueprintMigrationSet composite — returns metadata objects
 * describing Flyway-convention migration and callback file names.
 *
 * This does not create actual files; it produces structured metadata
 * that tooling or codegen can use to scaffold a migration directory.
 *
 * @example
 * ```ts
 * import { BlueprintMigrationSet } from "@intentius/chant-lexicon-flyway";
 *
 * const { migrations, callbacks } = BlueprintMigrationSet({
 *   versions: [
 *     { version: "1", description: "Create users table" },
 *     { version: "2", description: "Add email column" },
 *     { version: "3", description: "Create orders table" },
 *   ],
 *   callbacks: ["afterMigrate", "beforeClean"],
 * });
 *
 * // migrations[0].fileName → "V1__Create_users_table.sql"
 * // callbacks[0].fileName  → "afterMigrate.sql"
 * ```
 */
export function BlueprintMigrationSet(
  props: BlueprintMigrationSetProps,
): BlueprintMigrationSetResult {
  const {
    versions,
    callbacks: callbackEvents = [],
    extension = "sql",
    separator = "__",
  } = props;

  const migrations: MigrationFileEntry[] = versions.map((entry) => {
    const type = entry.type ?? "V";
    const sanitizedDescription = entry.description.replace(/\s+/g, "_");

    let fileName: string;
    if (type === "R") {
      // Repeatable migrations have no version number: R__Description.sql
      fileName = `${type}${separator}${sanitizedDescription}.${extension}`;
    } else {
      fileName = `${type}${entry.version}${separator}${sanitizedDescription}.${extension}`;
    }

    return {
      fileName,
      ...(type !== "R" && { version: entry.version }),
      description: entry.description,
      type,
    };
  });

  const callbacks: CallbackFileEntry[] = callbackEvents.map((event) => ({
    fileName: `${event}.${extension}`,
    event,
  }));

  return { migrations, callbacks };
}
