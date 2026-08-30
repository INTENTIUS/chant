/**
 * `r2-sync` — bulk object upload to a Cloudflare R2 bucket (chant #1293,
 * epic #1296), the direct analogue of `s3-sync`
 * (lexicons/aws/src/components/apply.ts): same input shape (`from`/`to`/
 * `delete`), same mutating-no-native-rollback disposition
 * (`rollbackPolicy: "needs-opt-out"`, ../../lint/rules/comp/comp003-mutating-no-rollback.ts),
 * learnable as the same idea per #1293's own verification bullet. See
 * ./wrangler.ts's module doc for why this lives in core rather than a
 * cloudflare lexicon.
 *
 * R2 has no first-party bulk-sync CLI the way S3 has `aws s3 sync`, but its
 * API is S3-compatible, so it takes any S3-compatible sync tool — this wraps
 * `rclone` (its `sync`/`copy` distinguish "mirror, deleting extras" from
 * "upload only" exactly the way `s3-sync`'s `delete` flag does) through the
 * same injectable `ProcessRunner` (./process-runner.ts) `./sign.ts` and
 * `./wrangler.ts` use. No live `rclone`, no network, ever, in a test run —
 * every test substitutes `MockProcessRunner`.
 */

import type { Capability } from "../capability";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "./process-runner";

const RCLONE_TOOL = "rclone";

/** Matches an `r2://bucket[/prefix]` destination — mirrors `s3-sync`'s `s3://bucket/prefix` shape. */
const R2_URI_RE = /^r2:\/\/([^/]+)(?:\/(.*))?$/;

/** Thrown when `R2SyncInput.to` is not an `r2://bucket[/prefix]` URI. */
export class R2SyncInvalidDestinationError extends Error {
  constructor(public readonly to: string) {
    super(
      `r2-sync: destination "${to}" is not an "r2://bucket[/prefix]" URI — mirror s3-sync's "s3://bucket/prefix" shape.`,
    );
    this.name = "R2SyncInvalidDestinationError";
  }
}

/**
 * Translate an `r2://bucket/prefix` destination to rclone's `<remote>:<path>`
 * form. `remote` is the name of an rclone remote already configured against
 * R2's S3-compatible endpoint (`<account-id>.r2.cloudflarestorage.com`) —
 * out of this capability's scope the same way `s3-sync` doesn't configure
 * AWS credentials; default `"r2"` is the conventional alias. Exported for
 * tests, mirroring ./sign.ts's `buildSignArgs`.
 */
export function toRcloneDest(to: string, remote = "r2"): string {
  const match = R2_URI_RE.exec(to);
  if (!match) throw new R2SyncInvalidDestinationError(to);
  const [, bucket, prefix] = match;
  return `${remote}:${bucket}${prefix ? `/${prefix}` : ""}`;
}

export interface R2SyncInput {
  /** Local path, or archive-relative path, to sync from. */
  from: string;
  /** Destination bucket URI, `"r2://bucket/prefix"` — mirrors `s3-sync`'s `S3SyncInput.to` shape. */
  to: string;
  /** Delete destination keys not present in the source. Default: false. */
  delete?: boolean;
  /** rclone remote name pointed at R2. Default: `"r2"`. */
  remote?: string;
}

export interface R2SyncOutput {
  /** Number of objects uploaded (new or changed). */
  uploaded: number;
  /** Number of objects deleted (only possible when `delete: true`). */
  deleted: number;
}

/**
 * Build the `rclone` invocation for `input`. `rclone sync` deletes
 * destination-only files by default (matching `s3-sync`'s opt-in `delete:
 * true`); `rclone copy` never deletes (matching the `s3-sync` default) — so
 * the verb dispatches on `input.delete` rather than passing a `--delete`
 * flag rclone doesn't have. `-v` gives the per-file action lines
 * `parseRcloneStats` reads. Exported for tests, mirroring ./sign.ts's
 * `buildSignArgs`.
 */
export function buildR2SyncArgs(input: R2SyncInput): string {
  const dest = toRcloneDest(input.to, input.remote);
  const verb = input.delete ? "sync" : "copy";
  return `rclone ${verb} ${q(input.from)} ${q(dest)} -v`;
}

// rclone's `-v` per-file log lines end e.g. "path/to/file: Copied (new)",
// "path/to/file: Copied (replaced existing)", "path/to/file: Deleted".
const COPIED_NEW_RE = /: Copied \(new\)/g;
const COPIED_REPLACED_RE = /: Copied \(replaced existing\)/g;
const DELETED_RE = /: Deleted$/gm;

/** Count uploaded/deleted objects out of `rclone -v`'s stdout. Exported for tests. */
export function parseRcloneStats(stdout: string): R2SyncOutput {
  const uploaded = (stdout.match(COPIED_NEW_RE) ?? []).length + (stdout.match(COPIED_REPLACED_RE) ?? []).length;
  const deleted = (stdout.match(DELETED_RE) ?? []).length;
  return { uploaded, deleted };
}

/**
 * Bulk-sync a directory of objects to an R2 bucket via `rclone`
 * (endpoint-aware only through the rclone remote's own config — this
 * capability never touches R2 credentials directly). Mutating, no native
 * undo (an overwritten or deleted object is gone), so — like `s3-sync` —
 * `rollbackPolicy: "needs-opt-out"`: COMP003 requires the component to
 * acknowledge the compensation gap explicitly (a `noRollback` reason, a
 * component-level `rollback` phase, or a sibling `rollback-previous`/
 * `snapshot-before` step).
 */
export function createR2SyncCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<R2SyncInput, R2SyncOutput> {
  return {
    kind: "r2-sync",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      await requireTool(processRunner, RCLONE_TOOL, `sync ${input.from} to ${input.to}`);
      const { stdout } = await processRunner.run(buildR2SyncArgs(input));
      return parseRcloneStats(stdout);
    },
  };
}

/** Default `r2-sync` capability, backed by the real `ProcessRunner`. */
export const r2SyncCapability: Capability<R2SyncInput, R2SyncOutput> = createR2SyncCapability();
