import { describe, test, expect } from "vitest";
import { RULE_CATALOG, RULE_CATEGORY, ruleMeta, auditRule, resolveAuditCatalog } from "./catalog";
import { loadPlugins } from "../cli/plugins";

const AUDIT_LEXICONS = ["github", "gitlab", "forgejo", "k8s", "docker", "aws", "azure", "gcp", "helm"];

/** All post-synth check ids the audit can actually surface, from the lexicons. */
async function realCheckIds(): Promise<Set<string>> {
  const plugins = await loadPlugins(AUDIT_LEXICONS);
  const ids = new Set<string>();
  for (const plugin of plugins) {
    for (const check of plugin.postSynthChecks?.() ?? []) {
      ids.add(check.id);
    }
  }
  return ids;
}

/** The effective catalog the auditor uses — core static + every lexicon's contributed entries (#687). */
const aggregate = () => resolveAuditCatalog(AUDIT_LEXICONS);

describe("RULE_CATALOG (aggregated: core static + lexicon-contributed, #687)", () => {
  test("covers every post-synth check the lexicons ship (no missing ids)", async () => {
    const [real, catalog] = [await realCheckIds(), await aggregate()];
    const missing = [...real].filter((id) => !(id in catalog)).sort();
    expect(missing).toEqual([]);
  });

  test("has no stale entries that aren't real checks", async () => {
    const [real, catalog] = [await realCheckIds(), await aggregate()];
    const stale = Object.keys(catalog).filter((id) => !real.has(id)).sort();
    expect(stale).toEqual([]);
  });

  test("every entry has a title, remediation, and valid tier/fixKind/category", async () => {
    for (const [id, m] of Object.entries(await aggregate())) {
      expect(m.id, `${id} id matches key`).toBe(id);
      expect(m.title.length, `${id} has a title`).toBeGreaterThan(0);
      expect(m.remediation.length, `${id} has remediation`).toBeGreaterThan(0);
      expect(["merge-worthy", "report-only"]).toContain(m.tier);
      expect(["deterministic", "guidance"]).toContain(m.fixKind);
      expect(["security", "correctness", "best-practice"], `${id} has a valid category`).toContain(m.category);
    }
  });

  test("core's own static entries are categorized from the curated map (no fallback)", () => {
    // core's `meta()` falls back to "best-practice" only if RULE_CATEGORY is
    // missing an id. Lexicon-contributed entries carry their own category via
    // `auditRule`, so this invariant applies to the core static map only.
    const uncategorized = Object.keys(RULE_CATALOG).filter((id) => !(id in RULE_CATEGORY)).sort();
    expect(uncategorized, "core static rules missing an explicit RULE_CATEGORY entry").toEqual([]);
  });

  test("an authority citation always means security", async () => {
    for (const [id, m] of Object.entries(await aggregate())) {
      if (m.authority && m.authority.length > 0) {
        expect(m.category, `${id} cites an authority, so it is security`).toBe("security");
      }
    }
  });

  test("authority citations only attach to merge-worthy entries", async () => {
    for (const [id, m] of Object.entries(await aggregate())) {
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

  test("deterministic fixes are limited to the safe mechanical set", async () => {
    const deterministic = Object.values(await aggregate())
      .filter((m) => m.fixKind === "deterministic")
      .map((m) => m.id)
      .sort();
    expect(deterministic).toEqual(
      ["GHA017", "GHA021", "GHA029", "GHA030", "GHA033", "WGL031"].sort(),
    );
  });
});

describe("auditRule (lexicon-facing catalog constructor, #687)", () => {
  test("an authority citation forces category=security", () => {
    const r = auditRule("WAW999", "merge-worthy", "guidance", "T", "fix", {
      authority: [{ name: "AWS", url: "https://x" }],
      category: "best-practice", // overridden by the authority
    });
    expect(r.category).toBe("security");
    expect(r.tier).toBe("merge-worthy");
    expect(r.yamlBased).toBe(true);
  });

  test("without authority, the explicit category is used (default best-practice)", () => {
    expect(auditRule("X1", "report-only", "deterministic", "T", "fix", { category: "correctness" }).category).toBe(
      "correctness",
    );
    expect(auditRule("X2", "report-only", "guidance", "T", "fix").category).toBe("best-practice");
  });
});

describe("resolveAuditCatalog (#687 aggregation seam)", () => {
  test("with no lexicons, returns a copy of the static core catalog", async () => {
    const resolved = await resolveAuditCatalog([]);
    expect(resolved).toEqual(RULE_CATALOG);
    expect(resolved).not.toBe(RULE_CATALOG); // a copy, not the same reference
  });

  test("a lexicon's contributed catalog is merged over static, and static ids are preserved", async () => {
    // aws contributes its WAW* block (#687 phase 3): it's absent from the core
    // static catalog but present in the resolved aggregate, and every static id
    // is still intact.
    const resolved = await resolveAuditCatalog(["aws"]);
    expect(RULE_CATALOG.WAW018).toBeUndefined();
    expect(resolved.WAW018?.category).toBe("security"); // authority-backed
    expect(resolved.WAW010?.tier).toBe("report-only");
    for (const [id, m] of Object.entries(RULE_CATALOG)) {
      expect(resolved[id]).toEqual(m);
    }
  });

  test("an unresolvable lexicon package falls back to the static catalog (tolerant)", async () => {
    expect(await resolveAuditCatalog(["definitely-not-a-lexicon"])).toEqual(RULE_CATALOG);
  });
});
