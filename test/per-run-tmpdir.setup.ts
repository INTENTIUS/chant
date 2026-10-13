import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest globalSetup (chant #2864). Gives each suite run its own temp
 * directory and removes it when the run ends.
 *
 * Every worker, and every process a test spawns with the inherited
 * environment, sees TMPDIR (TMP and TEMP on Windows) pointing here, so
 * `os.tmpdir()` resolves inside it. Two things end up inside it that used to
 * pile up in the machine's temp directory:
 *
 * - tsx's transform cache, `<tmpdir>/tsx-<uid>`. tsx never evicts it, and the
 *   suite copies fixture projects to fresh temp paths on every run, so each
 *   run added entries. At about a million entries every tsx start took
 *   minutes and the suite failed on timeouts.
 * - the `chant-*` directories tests create with mkdtemp and do not all remove.
 *
 * A run killed before teardown leaves its directory behind; the next run
 * removes any such directory older than a day.
 *
 * Vitest can call this more than once in a run (the root config's globalSetup
 * is inherited by the projects that extend it), so a later call finds the
 * first's directory already in place and keeps it. Nesting a second one
 * inside would also push tsx's IPC socket path, `<tmpdir>/tsx-<uid>/<pid>.pipe`,
 * past macOS's 104-byte limit for a socket path.
 */
const PREFIX = "chant-run-";
const MARK = "CHANT_TEST_RUN_TMPDIR";
const STALE_MS = 24 * 60 * 60 * 1000;

export default function setup(): (() => void) | undefined {
  if (process.env[MARK]) return undefined;
  const parent = tmpdir();
  sweepStale(parent);

  const dir = mkdtempSync(join(parent, PREFIX));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, [MARK]: undefined };
  process.env[MARK] = dir;
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;

  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}

function sweepStale(parent: string): void {
  const now = Date.now();
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(PREFIX)) continue;
    const path = join(parent, entry);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or another run's; leave it.
    }
  }
}
