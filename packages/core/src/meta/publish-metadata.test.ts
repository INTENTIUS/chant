import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

/**
 * Every publishable package carries the identity block npm provenance
 * validates at publish time.
 *
 * The k3d lexicon's first publish failed with E422: sigstore provenance
 * checks `repository.url` against the repo the workflow ran from, and the
 * newborn package.json had no `repository` at all — an error that surfaces
 * only on the publish runner, after a release is already tagged, which is
 * the most expensive place to learn a field is missing (chant-v0.41.14
 * shipped 13 of 14 packages). The peer-deps guard next door exists for the
 * same reason: a newborn package copies whichever fields its author
 * remembered, and the registry's requirements are not in anyone's head.
 *
 * So: what provenance actually validates (repository.url), plus the fields
 * whose absence makes a published page anonymous (license, description),
 * checked per package, in CI, before any tag exists.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const REPO_URL = "https://github.com/INTENTIUS/chant.git";

/** Every workspace package that publishes (publishConfig or not private). */
function publishablePackages(): Array<{ dir: string; pkg: Record<string, any> }> {
  const out: Array<{ dir: string; pkg: Record<string, any> }> = [];
  for (const parent of ["packages", "lexicons"]) {
    const parentDir = join(repoRoot, parent);
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir)) {
      const p = join(parentDir, name, "package.json");
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.private) continue;
      out.push({ dir: join(parent, name), pkg });
    }
  }
  return out;
}

describe("publishable packages carry the identity provenance validates", () => {
  test.each(publishablePackages().map((e) => [e.dir, e] as const))(
    "%s has repository/license/description",
    (_dir, entry) => {
      const { dir, pkg } = entry;
      expect(pkg.repository?.url, `${dir}: repository.url is what sigstore provenance checks`).toBe(REPO_URL);
      expect(pkg.repository?.directory, `${dir}: repository.directory should name the package's home`).toBe(dir);
      expect(pkg.license, `${dir}: license`).toBe("Apache-2.0");
      expect(typeof pkg.description, `${dir}: description`).toBe("string");
      expect((pkg.description ?? "").length, `${dir}: description is not empty`).toBeGreaterThan(0);
    },
  );
});
