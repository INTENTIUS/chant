// #4533: `chant index diff <a> [<b>]` over a local store holding the two fixture versions of
// ../../lifecycle/__fixtures__/index-diff/, read through --store local:<dir> as chant index writes it.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndexDiff } from "./index-diff";

const FIXTURES = join(import.meta.dirname, "..", "..", "lifecycle", "__fixtures__", "index-diff");
const V1 = "20261026T120000Z-aaaaaaaaaaaa.json";
const V2 = "20261026T130000Z-bbbbbbbbbbbb.json";
const V3 = "20261026T140000Z-cccccccccccc.json";
const SCOPE = "cloud/aws/000000000000/5c1f0e2a9b7d";
const OTHER = "cloud/aws/000000000000/0123456789ab";

/** A scratch dir (no chant project) with a local store: SCOPE holds V1 and V2, OTHER holds V1's document as V3. */
function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "chant-index-diff-"));
  for (const [scope, file, as] of [[SCOPE, V1, V1], [SCOPE, V2, V2], [OTHER, V1, V3]] as const) {
    const dir = join(cwd, "store", "index", ...scope.split("/"));
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIXTURES, file), join(dir, as));
  }
  return cwd;
}

async function run(argv: string[]) {
  const cwd = scratch();
  let out = "";
  let err = "";
  const code = await runIndexDiff([...argv, "--store", "local:store"], {
    cwd,
    env: { XDG_DATA_HOME: join(cwd, "none") },
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
  });
  return { code, out, err };
}

describe("chant index diff", () => {
  it("prints the diff of two named versions as JSON", async () => {
    const r = await run([`${SCOPE}/${V1}`, V2, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ diff: "v1", scopeKey: SCOPE, from: { version: V1 }, to: { version: V2 }, counts: { properties: 1, added: 1, removed: 1 } });
  });

  it("a scope alone diffs its last two versions, as text", async () => {
    const r = await run([SCOPE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Index diff: ${SCOPE}`);
    expect(r.out).toContain('attrs.VersioningConfiguration.Status: "Suspended" -> "Enabled"');
    expect(r.out).toContain("(not observed in the to read: read-failed)");
  });

  it("refuses two scopes by name", async () => {
    const r = await run([`${SCOPE}/${V1}`, `${OTHER}/${V3}`, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ error: "index-scope-mismatch", fromScopeKey: SCOPE, toScopeKey: OTHER });
    expect(r.err).toContain("different scopes");
  });

  it("usage errors: no version, an unknown flag", async () => {
    expect((await run([])).code).toBe(2);
    const r = await run([SCOPE, "--apply"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown flag --apply");
  });
});
