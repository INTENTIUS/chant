/**
 * WSP081, WSP082 and WSP083 (#2542; ws-040, ws-042): one declarer per
 * generated file, generated files inside their member or on a forge path,
 * and linked members that share an environment name.
 */

import { afterEach, describe, expect, test } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { runDeclarationChecks } from "../checks";
import { join, resolve } from "node:path";
import { readDeclaration } from "../declaration";
import { recordGeneratedFiles } from "../member-pipeline";
import { workingTree } from "../tree";
import { twoMemberWorkspace } from "../__fixtures__/two-member-workspace";
import {
  checkGeneratedPlacement,
  checkLinkedEnvironments,
  checkOneDeclarer,
  checkPipelines,
  gatherPipelineFacts,
  isForgePath,
  type MemberPipelineFacts,
} from "./pipelines";

const facts = (name: string, dir: string, generated: string[] = [], environments: string[] = []): MemberPipelineFacts => ({
  name,
  dir,
  generated,
  environments,
});

describe("isForgePath: the narrow exemption", () => {
  test.each([".github/workflows/a.yml", ".forgejo/workflows/a.yaml", ".gitea/workflows/a.yml", ".gitlab-ci.yml", ".gitlab/ci/api.gitlab-ci.yml"])("%s is a forge path", (p) => {
    expect(isForgePath(p)).toBe(true);
  });
  test.each([".github/CODEOWNERS", ".github/workflows/nested/a.yml", "ci/a.yml", "docs/.gitlab-ci.yml", ".github/actions/x/action.yml"])("%s is not", (p) => {
    expect(isForgePath(p)).toBe(false);
  });
});

describe("WSP081: one declarer per generated file", () => {
  test("two members declaring one file is an error naming both", () => {
    const findings = checkOneDeclarer([
      facts("api", "services/api", [".github/workflows/deploy.yml"]),
      facts("web", "apps/web", [".github/workflows/deploy.yml", ".github/workflows/chant-web-prod.yml"]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "WSP081", severity: "error", members: ["api", "web"], path: ".github/workflows/deploy.yml" });
  });

  test("each member with its own file is fine", () => {
    expect(checkOneDeclarer([facts("api", "services/api", ["a.yml"]), facts("web", "apps/web", ["b.yml"])])).toEqual([]);
  });
});

describe("WSP082: generated files sit in the member or on a forge path", () => {
  test("a file in another member's directory is an error", () => {
    const findings = checkGeneratedPlacement([facts("api", "services/api", ["services/api/gen.ts", ".github/workflows/x.yml", "apps/web/gen.ts"])]);
    expect(findings).toEqual([expect.objectContaining({ id: "WSP082", members: ["api"], path: "apps/web/gen.ts" })]);
  });

  test("the root member may declare anything", () => {
    expect(checkGeneratedPlacement([facts("platform", ".", ["anything/at/all.yml"])])).toEqual([]);
  });
});

describe("WSP083: linked members share an environment name", () => {
  const members = [facts("api", "services/api", [], ["staging", "prod"]), facts("web", "apps/web", [], ["stage", "production"]), facts("jobs", "jobs", [], ["prod"])];

  test("a link between members with no common name is a warning", () => {
    const findings = checkLinkedEnvironments(members, [{ consumer: "web", producer: "api" }]);
    expect(findings).toEqual([
      expect.objectContaining({ id: "WSP083", severity: "warning", members: ["api", "web"], message: expect.stringMatching(/api \(prod, staging\) and web \(production, stage\)/) }),
    ]);
  });

  test("one shared name is enough, and a member with no environments is skipped", () => {
    expect(checkLinkedEnvironments(members, [{ consumer: "jobs", producer: "api" }])).toEqual([]);
    expect(checkLinkedEnvironments([...members, facts("docs", "docs")], [{ consumer: "docs", producer: "api" }])).toEqual([]);
  });

  test("members that aren't linked are never compared", () => {
    expect(checkLinkedEnvironments(members, [])).toEqual([]);
  });
});

describe("gathering from a checkout", () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("each member's generated-file record is read, with its environments", () => {
    repo = twoMemberWorkspace();
    recordGeneratedFiles(join(repo, "services/api"), [{ path: ".github/workflows/chant-api-staging.yml", command: "c", env: "staging" }]);
    recordGeneratedFiles(join(repo, "apps/web"), [
      { path: ".github/workflows/chant-api-staging.yml", command: "c", env: "staging" },
      { path: ".github/workflows/chant-web-prod.yml", command: "c", env: "prod" },
    ]);
    const gathered = gatherPipelineFacts(repo, readDeclaration(workingTree(repo)));
    expect(gathered).toEqual([
      { name: "api", dir: "services/api", generated: [".github/workflows/chant-api-staging.yml"], environments: ["staging"] },
      { name: "web", dir: "apps/web", generated: [".github/workflows/chant-api-staging.yml", ".github/workflows/chant-web-prod.yml"], environments: ["staging", "prod"] },
    ]);
    expect(checkPipelines(gathered).map((f) => `${f.id}:${f.path}`)).toEqual(["WSP081:.github/workflows/chant-api-staging.yml"]);
  });

  test("WSP083 reads the declared member links: two linked members with no shared environment name (#2539)", async () => {
    repo = twoMemberWorkspace();
    const file = join(repo, "chant.workspace.json");
    const decl = JSON.parse(readFileSync(file, "utf-8")) as { members: Record<string, unknown>[] };
    decl.members.find((m) => m.name === "web")!.links = [{ member: "api", output: "ApiUrl" }];
    writeFileSync(file, JSON.stringify(decl, null, 2));
    writeFileSync(join(repo, "services/api/src/infra.ts"), `import { output } from "@intentius/chant-lexicon-aws";\nexport const url = output("u", "ApiUrl");\n`);
    recordGeneratedFiles(join(repo, "services/api"), [{ path: "services/api/ci/api-staging.yml", command: "c", env: "staging" }]);
    recordGeneratedFiles(join(repo, "apps/web"), [{ path: "apps/web/ci/web-production.yml", command: "c", env: "production" }]);
    const report = await runDeclarationChecks(repo);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.severity}`)).toEqual(["WSP083:warning"]);
    expect(report.diagnostics[0].message).toMatch(/api \(staging\) and web \(production\)/);

    // Without the link, the two are never compared.
    delete decl.members.find((m) => m.name === "web")!.links;
    writeFileSync(file, JSON.stringify(decl, null, 2));
    expect((await runDeclarationChecks(repo)).diagnostics).toEqual([]);
  });

  test("the chant repository's own declaration has no findings (#2557)", () => {
    const root = resolve(__dirname, "../../../../..");
    const declaration = readDeclaration(workingTree(root));
    expect(checkPipelines(gatherPipelineFacts(root, declaration))).toEqual([]);
  });
});
