import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { vendorPull, vendorCheck, MANIFEST_FILE } from "../commands/vendor";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * Where the lineage lock lives (`../../workspace/lineage-lock.ts` owns the
 * constant). Repeated here so that finding out whether a lock exists loads no
 * workspace module: a project with only `vendor.json` must see today's
 * `chant vendor` exactly (#2525 rule 2).
 */
const LOCK_FILE = ".chant/workspace.lock.json";

/**
 * `chant vendor [pull|check|migrate]` — pull pinned, checksummed patterns into
 * the repo, check vendored targets against their pin, or move `vendor.json`
 * into the lineage lock. Defaults to `pull`.
 *
 * `vendor.json` and the lock both live in the current directory. With no lock,
 * `pull` and `check` read `vendor.json` exactly as before. With a lock, its
 * vendor scopes are pulled file by file (local edits are kept, conflicts
 * become manual steps), and any `vendor.json` entries not yet migrated are
 * still pulled the old way (#2540).
 */
export async function runVendor(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  // `chant vendor` → pull; `chant vendor pull|check|migrate [name]`.
  const sub = args.path === "." ? "pull" : args.path;
  const manifestDir = resolve(".");

  try {
    if (sub === "migrate") return await runMigrate(manifestDir);
    const locked = await hasVendorScopes(manifestDir);
    if (sub === "pull") return locked ? await runLockedPull(manifestDir, args.extraPositional) : await runPull(manifestDir, args.extraPositional);
    if (sub === "check") return locked ? await runLockedCheck(manifestDir) : runCheck(manifestDir);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatError({
    message: `Unknown vendor subcommand: ${sub}`,
    hint: "Available: chant vendor pull [name], chant vendor check, chant vendor migrate",
  }));
  return 1;
}

/**
 * Whether the lock holds any vendor scope. Without a lock file this loads
 * nothing; a lock with no vendor scope (say, one `chant init --template`
 * wrote) leaves `chant vendor` on `vendor.json` as before.
 */
async function hasVendorScopes(root: string): Promise<boolean> {
  if (!existsSync(join(root, LOCK_FILE))) return false;
  const { readLock } = await import("../../workspace/lineage-lock");
  const lock = readLock(root);
  return !!lock && Object.values(lock.scopes).some((l) => l.kind === "vendor");
}

// ── vendor.json only: unchanged ──────────────────────────────────────────────

async function runPull(manifestDir: string, only?: string): Promise<number> {
  const result = await vendorPull(manifestDir, only);
  if (!result.success) {
    console.error(formatError({ message: result.output }));
    return 1;
  }
  console.log(result.output);
  console.error(formatSuccess(`Vendored ${result.pulled.length} artifact(s)`));
  return 0;
}

function runCheck(manifestDir: string): number {
  const result = vendorCheck(manifestDir);
  console.log(result.output);
  if (!result.drift) {
    console.error(formatSuccess("All vendored artifacts match their pin"));
    return 0;
  }
  // Drift is allowed (you may edit vendored files); fail only in CI so a
  // pipeline catches unrecorded changes, warn locally.
  if (process.env.CI) {
    console.error(formatError({ message: "Vendored content drifted from the manifest pin" }));
    return 1;
  }
  console.error(formatWarning({ message: "Vendored content drifted from the manifest pin (run `chant vendor pull` to re-pin)" }));
  return 0;
}

// ── With a lineage lock ──────────────────────────────────────────────────────

const MIGRATE_HINT = `${MANIFEST_FILE} entries are not in ${LOCK_FILE} yet, and pull still overwrites their targets. Run \`chant vendor migrate\` to move them.`;

async function runLockedPull(root: string, only?: string): Promise<number> {
  const lv = await import("../../workspace/lineage-vendor");
  const hasManifest = lv.manifestPresent(root);
  const legacy = hasManifest ? (await import("../commands/vendor")).loadManifest(root).manifest.vendored : [];
  const legacyMatch = only ? legacy.some((e) => e.name === only) : legacy.length > 0;

  const pulled = await lv.pullLockedScopes(root, only);
  if (only && pulled.length === 0 && !legacyMatch) {
    console.error(formatError({ message: `no vendored entry named "${only}"` }));
    return 1;
  }
  const lines = pulled.map(lv.formatLockedPull);
  let count = pulled.length;
  if (legacyMatch) {
    const result = await vendorPull(root, only);
    lines.push(result.output);
    count += result.pulled.length;
  }
  if (lines.length > 0) console.log(lines.join("\n"));
  if (legacyMatch) console.error(formatWarning({ message: MIGRATE_HINT }));

  const steps = pulled.reduce((n, p) => n + p.manualSteps.length, 0);
  if (steps > 0) {
    console.error(formatWarning({
      message: `Vendored ${count} artifact(s); ${steps} file(s) changed both here and upstream were left as they are`,
    }));
    console.error("  Merge each by hand, then run `chant workspace lineage resolve <path>`.");
    return 0;
  }
  console.error(formatSuccess(`Vendored ${count} artifact(s)`));
  return 0;
}

async function runLockedCheck(root: string): Promise<number> {
  const lv = await import("../../workspace/lineage-vendor");
  const checks = lv.checkLockedScopes(root);
  const lines = checks.map(lv.formatLockedCheck);
  let drift = checks.some(lv.lockedCheckFails);
  if (lv.manifestPresent(root)) {
    const legacy = vendorCheck(root);
    if (legacy.output) lines.push(legacy.output);
    drift ||= legacy.drift;
    console.error(formatWarning({ message: MIGRATE_HINT }));
  }
  if (lines.length > 0) console.log(lines.join("\n"));
  if (!drift) {
    console.error(formatSuccess("All vendored artifacts match their pin, or carry local edits"));
    return 0;
  }
  const message = "Vendored content has open manual steps or missing targets";
  if (process.env.CI) {
    console.error(formatError({ message }));
    return 1;
  }
  console.error(formatWarning({ message: `${message} (see \`chant workspace lineage\`)` }));
  return 0;
}

async function runMigrate(root: string): Promise<number> {
  const { migrateVendorManifest } = await import("../../workspace/lineage-vendor");
  const result = await migrateVendorManifest(root);
  for (const m of result.migrated) {
    console.log(`  ${m.name} → ${m.target} (${m.pinned ? `${m.files} file(s)` : "unpinned"})`);
  }
  console.error(
    formatSuccess(
      `Moved ${result.migrated.length} vendored artifact(s) from ${MANIFEST_FILE} into ${LOCK_FILE}${result.lockCreated ? " (created)" : ""}; ${MANIFEST_FILE} removed`,
    ),
  );
  return 0;
}
