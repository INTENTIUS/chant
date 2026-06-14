import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { analyzeForgejoSecurity, renderSecurityPosture, provenanceToDiagnostics } from "./security";

function analyze(yaml: string) {
  return analyzeForgejoSecurity(parseYAML(yaml), { sourceFile: "ci.yml" });
}

describe("analyzeForgejoSecurity — fate classes", () => {
  test("workflow-level permissions is lost", () => {
    const records = analyze(`on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    const perm = records.filter((r) => r.rule === "MIG-FJ-PERMISSIONS");
    expect(perm).toHaveLength(1);
    expect(perm[0].security.fate).toBe("lost");
  });

  test("continue-on-error is lost (job and step)", () => {
    const records = analyze(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: echo a
        continue-on-error: true
`);
    const coe = records.filter((r) => r.rule === "MIG-FJ-CONTINUE-ON-ERROR");
    expect(coe).toHaveLength(2);
    expect(coe.every((r) => r.security.fate === "lost")).toBe(true);
  });

  test("an unmapped action ref needs review", () => {
    const records = analyze(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/custom-action@v1
`);
    const act = records.filter((r) => r.rule === "MIG-FJ-ACTION-UNRESOLVED");
    expect(act).toHaveLength(1);
    expect(act[0].security.fate).toBe("needs-review");
  });

  test("a mapped action ref produces no finding", () => {
    const records = analyze(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);
    expect(records.filter((r) => r.rule === "MIG-FJ-ACTION-UNRESOLVED")).toHaveLength(0);
  });

  test("an unmapped runner label needs review; a mapped one does not", () => {
    const records = analyze(`on: push
jobs:
  a:
    runs-on: macos-latest
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
    const labels = records.filter((r) => r.rule === "MIG-FJ-RUNNER-LABEL");
    expect(labels).toHaveLength(1);
    expect(labels[0].note).toContain("macos-latest");
  });
});

describe("renderSecurityPosture", () => {
  test("renders a table with fate rows", () => {
    const records = analyze(`on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);
    const md = renderSecurityPosture(records);
    expect(md).toContain("## Security posture");
    expect(md).toContain("MIG-FJ-PERMISSIONS");
    expect(md).toContain("lost");
  });

  test("clean workflow reports no weakening", () => {
    const md = renderSecurityPosture([]);
    expect(md).toContain("No security-relevant properties weaken or drop");
  });
});

describe("provenanceToDiagnostics", () => {
  test("emits one diagnostic per record; --strict escalates to error", () => {
    const records = analyze(`on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(provenanceToDiagnostics(records)).toHaveLength(1);
    expect(provenanceToDiagnostics(records)[0].severity).toBe("warning");
    expect(provenanceToDiagnostics(records, { strict: true })[0].severity).toBe("error");
  });
});
