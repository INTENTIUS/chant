import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { auditFiles, CROSS_FILE, type AuditFinding, type ChecksProvider, type EntitiesProvider } from "@intentius/chant/audit/core";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { collectCandidates, discoverByDetection, type DetectPlugin } from "@intentius/chant/audit/discover";
import { auditTerraformState } from "@intentius/chant/audit/terraform-state";
import { terraformPlugin } from "../plugin";
import { AUDIT_ROOT_NAME } from "../hcl/parse";
import { renderTerraformRoots } from "../hcl/roots";
import { postSynthChecks } from "./post-synth";

/**
 * End-to-end audit test (#2085 acceptance): `chant audit` (`auditFiles` on top
 * of real filesystem discovery, `discoverByDetection`) against the #2083
 * fixture root modules. Real terraform plugin methods are wired in directly
 * as `checksProvider`/`entitiesProvider` (the same seam `packages/core/src/
 * audit/core.test.ts` uses) rather than through `loadPlugin`'s package-name
 * resolution, so this runs against source, not a built `dist/`.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

const terraformDetectPlugin: DetectPlugin = { name: "terraform" };

const checksProvider: ChecksProvider = async (lexicon) =>
  lexicon === "terraform" ? (terraformPlugin.postSynthChecks?.() ?? []) : [];

const entitiesProvider: EntitiesProvider = async (lexicon) =>
  lexicon === "terraform" ? terraformPlugin.auditEntities?.bind(terraformPlugin) : undefined;

describe("chant audit against a discovered terraform root module", () => {
  test("reports TF001 once for the no-backend root", async () => {
    const inputs = discoverByDetection(join(fixtures, "no-backend"), [terraformDetectPlugin]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.lexicon).toBe("terraform");

    const findings = await auditFiles(inputs, { checksProvider, entitiesProvider });
    const tf001 = findings.filter((f) => f.checkId === "TF001");
    expect(tf001).toHaveLength(1);
    expect(tf001[0]!.lexicon).toBe("terraform");
  });

  // #2218: `backend "local"` is the local backend named rather than fallen
  // back into, so it is the same finding as no backend at all. The audit path
  // gets its own case because it parses joined file content rather than a
  // directory, and the label has to survive that parse too.
  test('reports TF001 for a root whose only backend is `backend "local"`', async () => {
    const inputs = discoverByDetection(join(fixtures, "with-backend"), [terraformDetectPlugin]);
    expect(inputs).toHaveLength(1);

    const findings = await auditFiles(inputs, { checksProvider, entitiesProvider });
    const tf001 = findings.filter((f) => f.checkId === "TF001");
    expect(tf001).toHaveLength(1);
    expect(tf001[0]!.message).toContain('the backend it declares is `backend "local"`');
  });

  test("reports nothing for the remote-backend root", async () => {
    const inputs = discoverByDetection(join(fixtures, "remote-backend"), [terraformDetectPlugin]);
    expect(inputs).toHaveLength(1);

    const findings = await auditFiles(inputs, { checksProvider, entitiesProvider });
    expect(findings.filter((f) => f.checkId === "TF001")).toHaveLength(0);
  });
});

/**
 * TF023 (#2110) is audit-only: it reads the file list `chant audit` discovers,
 * never a parsed root module, so it lives in core
 * (`packages/core/src/audit/terraform-state.ts`) beside the other
 * lexicon-independent families. These run the two halves it depends on, the
 * real walk and the real check, over the committed fixture roots.
 */
describe("TF023: Terraform state committed to the repository", () => {
  const tf023 = join(dirname(fileURLToPath(import.meta.url)), "post-synth", "fixtures", "TF023");

  test("fires on a root whose state file is committed beside it", () => {
    // The fixture ships its state as `state.json`: a tracked `terraform.tfstate`
    // is exactly what this rule reports, and the repository's own push rules
    // refuse the name. The test materialises the root the rule is written for.
    const root = mkdtempSync(join(tmpdir(), "chant-tf023-"));
    copyFileSync(join(tf023, "positive", "main.tf"), join(root, "main.tf"));
    copyFileSync(join(tf023, "positive", "state.json"), join(root, "terraform.tfstate"));
    const findings = auditTerraformState(collectCandidates(root));
    rmSync(root, { recursive: true, force: true });
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe("TF023");
    expect(findings[0].file).toBe("terraform.tfstate");
    expect(findings[0].lexicon).toBe("terraform");
  });

  test("says nothing about a root that keeps its state remote", () => {
    expect(auditTerraformState(collectCandidates(join(tf023, "negative")))).toEqual([]);
  });

  test("never runs during a build: it is not one of this lexicon's post-synth checks", () => {
    expect(postSynthChecks.map((c) => c.id)).not.toContain("TF023");
    expect(terraformPlugin.auditCatalog?.()).not.toHaveProperty("TF023");
  });
});

/**
 * #2217: `chant audit` used to hand the plugin one directory's joined text and
 * no directory, so the parse stopped at the root module's own files and every
 * discovered directory parsed under the same fixed scope name. A root and its
 * `modules/*` then merged into one entity map, which produced a finding keyed
 * `<scope>/<address>#2` against the file `(cross-file)` and left the two rules
 * about child modules (TF014, TF015) with no child to see. These run the real
 * discovery and the real audit over the tree fixtures those rules were written
 * for.
 */
describe("chant audit descends a root module's local modules (#2217)", () => {
  const treeFixtures = join(dirname(fileURLToPath(import.meta.url)), "post-synth", "fixtures");

  async function audit(dir: string): Promise<AuditFinding[]> {
    return auditFiles(discoverByDetection(dir, [terraformDetectPlugin]), { checksProvider, entitiesProvider });
  }

  test("a directory the root calls as a module is not audited as a root of its own", () => {
    const inputs = discoverByDetection(join(treeFixtures, "TF014", "positive"), [terraformDetectPlugin]);
    expect(inputs.map((i) => i.path)).toEqual(["."]);
    expect(inputs[0]!.dir).toBe(join(treeFixtures, "TF014", "positive"));
  });

  test("TF014 fires on the positive fixture, named by its call chain", async () => {
    const findings = await audit(join(treeFixtures, "TF014", "positive"));
    const tf014 = findings.filter((f) => f.checkId === "TF014");
    expect(tf014).toHaveLength(1);
    expect(tf014[0]!.entity).toBe("audit-root/module.cdn/provider.aws");
    expect(tf014[0]!.message).toContain("Callers: audit-root -> module.cdn (main.tf:13).");
    expect(tf014[0]!.file).toBe(".");
  });

  test("nothing is attributed to a synthetic cross-file entity any more", async () => {
    const findings = await audit(join(treeFixtures, "TF014", "positive"));
    expect(findings.map((f) => f.file)).not.toContain(CROSS_FILE);
    expect(findings.filter((f) => /#\d+$/.test(f.entity ?? ""))).toEqual([]);
    // The root's own provider block is still the root's: TF002 reports it
    // against the root scope, not against a merge of the two directories.
    const tf002 = findings.filter((f) => f.checkId === "TF002");
    expect(tf002.map((f) => f.entity)).toEqual(["audit-root/provider.aws"]);
  });

  test("TF014 says nothing about the negative fixture's alias-only block", async () => {
    const findings = await audit(join(treeFixtures, "TF014", "negative"));
    expect(findings.filter((f) => f.checkId === "TF014")).toEqual([]);
    expect(findings.map((f) => f.file)).not.toContain(CROSS_FILE);
  });

  test("TF015 fires on a child module that declares a backend", async () => {
    const findings = await audit(join(treeFixtures, "TF015", "positive"));
    expect(findings.map((f) => `${f.checkId} ${f.entity}`)).toEqual(["TF015 audit-root/module.cdn/terraform"]);
    expect(findings[0]!.message).toContain("Callers: audit-root -> module.cdn");
  });

  test("TF015 leaves a child's required_version and required_providers alone", async () => {
    expect(await audit(join(treeFixtures, "TF015", "negative"))).toEqual([]);
  });

  test("TF001 stays root-only: the child module without a backend is not reported", async () => {
    const findings = await audit(join(treeFixtures, "TF014", "positive"));
    expect(findings.filter((f) => f.checkId === "TF001")).toEqual([]);
  });

  test("two roots in one repository are two scopes, each named after its directory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chant-2217-"));
    for (const env of ["prod", "dev"]) {
      mkdirSync(join(repo, "envs", env), { recursive: true });
      writeFileSync(join(repo, "envs", env, "main.tf"), 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
    }
    const findings = await audit(repo);
    rmSync(repo, { recursive: true, force: true });

    const tf001 = findings.filter((f) => f.checkId === "TF001");
    expect(tf001.map((f) => f.missing?.scope).sort()).toEqual(["envs.dev", "envs.prod"]);
    expect(tf001.map((f) => f.file).sort()).toEqual(["envs/dev", "envs/prod"]);
    expect(findings.map((f) => f.file)).not.toContain(CROSS_FILE);
  });
});

/**
 * The regression net for #2217: for every fixture root in the family, the
 * verdict `chant audit` reaches through real discovery is the verdict
 * `chant build` reaches through `renderTerraformRoots`. The two paths parse
 * the same directories with the same checks, so any rule whose behaviour
 * depends on scope (every module-descent rule, and every root-only rule that
 * must NOT follow one) is pinned on both paths at once.
 *
 * The build side renders with no `binary`, so a `live` fixture (TF024 to
 * TF026) is stock on both sides: the audit path does not detect live mode
 * (#2103), and this asserts the two agree, not that either sees an estate.
 */
describe("every fixture root gets the same verdict from chant audit as from chant build (#2217)", () => {
  const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "post-synth", "fixtures");

  function verdictOf(findings: Array<{ checkId: string; entity?: string }>): string[] {
    return findings.map((f) => `${f.checkId} ${f.entity ?? ""}`).sort();
  }

  async function buildVerdict(dir: string): Promise<string[]> {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: dir,
      roots: { [AUDIT_ROOT_NAME]: { dir } },
    });
    const ctx = {
      outputs: new Map(),
      entities,
      buildResult: { outputs: new Map(), entities, warnings, errors: [], sourceFileCount: entities.size },
    } as unknown as PostSynthContext;
    return verdictOf((terraformPlugin.postSynthChecks?.() ?? []).flatMap((check) => check.check(ctx)));
  }

  async function auditVerdict(dir: string): Promise<string[]> {
    const inputs = discoverByDetection(dir, [terraformDetectPlugin]);
    return verdictOf(await auditFiles(inputs, { checksProvider, entitiesProvider }));
  }

  /** Every fixture case: a `<id>/<case>/` tree as it stands, and a `<id>/<case>.tf` copied into a directory of its own. */
  function cases(): Array<{ name: string; materialize: (into: string) => string }> {
    const out: Array<{ name: string; materialize: (into: string) => string }> = [];
    for (const id of readdirSync(fixtureRoot).filter((e) => statSync(join(fixtureRoot, e)).isDirectory()).sort()) {
      for (const entry of readdirSync(join(fixtureRoot, id)).sort()) {
        const full = join(fixtureRoot, id, entry);
        if (statSync(full).isDirectory()) {
          out.push({ name: `${id}/${entry}`, materialize: () => full });
        } else if (entry.endsWith(".tf")) {
          out.push({
            name: `${id}/${entry}`,
            materialize: (into) => {
              copyFileSync(full, join(into, entry));
              return into;
            },
          });
        }
      }
    }
    return out;
  }

  for (const { name, materialize } of cases()) {
    test(name, async () => {
      const scratch = mkdtempSync(join(tmpdir(), "chant-2217-fx-"));
      const dir = materialize(scratch);
      try {
        expect(await auditVerdict(dir)).toEqual(await buildVerdict(dir));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
