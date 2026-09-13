import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { generateGithubOpPipeline } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";

/**
 * chant#2331 — the published sample of generated output is checked against the
 * generator.
 *
 * `ops.mdx` publishes the gated-apply workflow `generateGithubOpPipeline`
 * emits. Nothing checked it, and it went stale twice in a single day: #2299
 * added `shell: bash` and the sample still showed the pre-fix YAML — the exact
 * shape #2299 says cannot start under `container:`, so a reader copying it
 * reproduced the bug that had just been fixed. #2321 then removed
 * `set -o pipefail` and `shell: bash` again, and the sample #2322 had just
 * hand-corrected was stale a second time.
 *
 * A published sample of generated output is a promise about what the generator
 * does. Unguarded it drifts toward documenting bugs that were already fixed,
 * which is worse than showing nothing, because it reads as authoritative.
 *
 * ## Why this compares structurally rather than byte for byte
 *
 * The issue asks for a regenerate-and-diff. That cannot be literal here,
 * because the sample deliberately ELIDES two long scripts:
 *
 *     node -e '...set gated/op/gate/approve on $GITHUB_OUTPUT...'
 *     ...find the merged PR for $GITHUB_SHA, post or edit the marker comment...
 *
 * Abbreviating them is right: a reader wants the workflow's shape, not forty
 * lines of embedded JavaScript. So the rule this enforces is not "the sample is
 * the output" but the weaker and more useful one: **the sample may abbreviate,
 * and may not misstate.** A string containing `...` is a wildcard; everything
 * else must match the generator exactly.
 *
 * Both staleness events would have failed here. `shell: bash` is a key, not an
 * elision, and so is the `run:` line that carried `set -o pipefail`.
 */
const DOC = fileURLToPath(new URL("../docs/pages/ops.mdx", import.meta.url));

/** The spec the prose immediately above the sample declares, transcribed. */
const assumeRole = (roleVariable: string) => [
  {
    uses: "aws-actions/configure-aws-credentials@v6",
    with: { "role-to-assume": `\${{ vars.${roleVariable} }}`, "aws-region": "eu-west-1" },
  },
];

/**
 * The sample references `installTerraform` without ever defining it, which is
 * its own small defect in the page. Transcribed here from the `run:` line the
 * sample publishes, so this test pins what the doc shows rather than inventing
 * a step the doc does not.
 */
const installTerraform =
  "curl -fsSL https://releases.hashicorp.com/terraform/1.13.3/terraform_1.13.3_linux_amd64.zip " +
  "-o /tmp/terraform.zip && unzip -q -o /tmp/terraform.zip -d /usr/local/bin && terraform version";

/** Pull the fenced yaml block whose first line names `file`. */
function publishedYaml(doc: string, file: string): string {
  const fence = new RegExp("```yaml\\n# " + file + "\\n([\\s\\S]*?)\\n```");
  const found = fence.exec(doc);
  if (!found) throw new Error(`no \`\`\`yaml block for "${file}" in ops.mdx`);
  return found[1];
}

/**
 * Compare `documented` against `generated`, treating any documented string
 * containing `...` as an elision that matches whatever the generator produced.
 */
function mismatches(documented: unknown, generated: unknown, path = ""): string[] {
  if (typeof documented === "string" && documented.includes("...")) return [];
  if (Array.isArray(documented) || Array.isArray(generated)) {
    if (!Array.isArray(documented) || !Array.isArray(generated)) {
      return [`${path}: documented ${JSON.stringify(documented)}, generated ${JSON.stringify(generated)}`];
    }
    if (documented.length !== generated.length) {
      return [`${path}: documented ${documented.length} items, generated ${generated.length}`];
    }
    return documented.flatMap((d, i) => mismatches(d, generated[i], `${path}[${i}]`));
  }
  if (documented && generated && typeof documented === "object" && typeof generated === "object") {
    const d = documented as Record<string, unknown>;
    const g = generated as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(d), ...Object.keys(g)])];
    return keys.flatMap((k) => {
      const where = path ? `${path}.${k}` : k;
      if (!(k in d)) return [`${where}: the generator emits this and the sample omits it`];
      if (!(k in g)) return [`${where}: the sample shows this and the generator does not emit it`];
      return mismatches(d[k], g[k], where);
    });
  }
  return documented === generated
    ? []
    : [`${path}: documented ${JSON.stringify(documented)}, generated ${JSON.stringify(generated)}`];
}

describe("the ops page's sample matches what the generator emits (chant#2331)", () => {
  const result = generateGithubOpPipeline(
    [
      {
        name: "app-plan",
        trigger: { kind: "pull_request", branches: ["main"] },
        findingMode: "comment",
        setup: assumeRole("AWS_PLAN_ROLE_ARN"),
        permissions: { "id-token": "write" },
      },
      {
        name: "app-apply",
        trigger: { kind: "push", branches: ["main"] },
        setup: assumeRole("AWS_APPLY_ROLE_ARN"),
        permissions: { "id-token": "write" },
        environment: { name: "production" },
      },
    ] as never,
    { beforeScript: [installTerraform] } as never,
  );

  test("the generator still emits the two files the page describes", () => {
    expect(result.files.map((f) => f.name).sort()).toEqual(["app-apply.yml", "app-plan.yml"]);
  });

  test("the published app-apply.yml says nothing the generator does not do", () => {
    const doc = readFileSync(DOC, "utf8");
    const documented = load(publishedYaml(doc, "app-apply.yml"));
    const generated = load(result.files.find((f) => f.name === "app-apply.yml")!.yaml);

    const found = mismatches(documented, generated);
    expect(
      found,
      "lexicons/terraform/docs/pages/ops.mdx publishes a sample of generated output that has " +
        "drifted from the generator. Regenerate the block and resync the derived copy under " +
        "docs/src/content/docs/. An abbreviated script is fine — write `...` inside it — but a " +
        "key or a value that differs is the page promising something the generator does not do.\n\n" +
        found.join("\n"),
    ).toEqual([]);
  });

  test("an elision is a wildcard, and everything else is not", () => {
    // The comparison's own contract, so a future reader does not weaken it by
    // sprinkling `...` to make a failure go away.
    expect(mismatches({ run: "...anything..." }, { run: "a real script" })).toEqual([]);
    expect(mismatches({ shell: "bash" }, { shell: "sh" })).toHaveLength(1);
    expect(mismatches({ a: 1 }, { a: 1, b: 2 })).toHaveLength(1);
  });
});
