import { describe, test, expect } from "vitest";
import { RULE_CATALOG, ruleMeta } from "./catalog";
import { loadPlugins } from "../cli/plugins";

/** All post-synth check ids the audit can actually surface, from the lexicons. */
async function realCheckIds(): Promise<Set<string>> {
  const plugins = await loadPlugins(["github", "gitlab", "forgejo", "k8s", "docker", "aws", "azure", "gcp"]);
  const ids = new Set<string>();
  for (const plugin of plugins) {
    for (const check of plugin.postSynthChecks?.() ?? []) {
      ids.add(check.id);
    }
  }
  return ids;
}

describe("RULE_CATALOG", () => {
  test("covers every post-synth check the lexicons ship (no missing ids)", async () => {
    const real = await realCheckIds();
    const missing = [...real].filter((id) => !(id in RULE_CATALOG)).sort();
    expect(missing).toEqual([]);
  });

  test("has no stale entries that aren't real checks", async () => {
    const real = await realCheckIds();
    const stale = Object.keys(RULE_CATALOG).filter((id) => !real.has(id)).sort();
    expect(stale).toEqual([]);
  });

  test("every entry has a title, remediation, and valid tier/fixKind", () => {
    for (const [id, m] of Object.entries(RULE_CATALOG)) {
      expect(m.id, `${id} id matches key`).toBe(id);
      expect(m.title.length, `${id} has a title`).toBeGreaterThan(0);
      expect(m.remediation.length, `${id} has remediation`).toBeGreaterThan(0);
      expect(["merge-worthy", "report-only"]).toContain(m.tier);
      expect(["deterministic", "guidance"]).toContain(m.fixKind);
    }
  });

  test("authority citations only attach to merge-worthy entries", () => {
    for (const [id, m] of Object.entries(RULE_CATALOG)) {
      if (m.authority && m.authority.length > 0) {
        expect(m.tier, `${id} with authority is merge-worthy`).toBe("merge-worthy");
        for (const a of m.authority) {
          expect(a.name.length).toBeGreaterThan(0);
          expect(a.url.startsWith("https://")).toBe(true);
        }
      }
    }
  });

  test("flagship security rules carry an authority citation", () => {
    const flagship = ["GHA017", "GHA021", "GHA029", "GHA033", "GHA034", "GHA036", "GHA037", "WGL016", "WGL029"];
    for (const id of flagship) {
      const m = ruleMeta(id);
      expect(m, `${id} present`).toBeDefined();
      expect(m!.tier).toBe("merge-worthy");
      expect((m!.authority?.length ?? 0), `${id} has authority`).toBeGreaterThan(0);
    }
  });

  test("deterministic fixes are limited to the safe mechanical set", () => {
    const deterministic = Object.values(RULE_CATALOG)
      .filter((m) => m.fixKind === "deterministic")
      .map((m) => m.id)
      .sort();
    expect(deterministic).toEqual(
      ["GHA017", "GHA021", "GHA029", "GHA030", "GHA033", "WGL031"].sort(),
    );
  });
});
