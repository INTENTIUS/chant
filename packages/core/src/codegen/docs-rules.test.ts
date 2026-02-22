import { describe, test, expect } from "bun:test";
import { generateRuleCatalog, generateRuleDetailPage } from "./docs-rules";
import type { RuleEntry } from "../lint/rule-registry";

const mockEntries: RuleEntry[] = [
  {
    id: "COR001",
    description: "No inline objects in Declarable constructors",
    category: "style",
    defaultSeverity: "warning",
    source: "core",
    phase: "pre-synth",
    hasAutoFix: false,
  },
  {
    id: "WAW018",
    description: "S3 bucket missing public access block",
    category: "security",
    defaultSeverity: "error",
    source: "aws",
    phase: "post-synth",
    hasAutoFix: false,
    helpUri: "https://chant.dev/lint-rules/waw018",
  },
  {
    id: "COR008",
    description: "Export required for declarable instances",
    category: "correctness",
    defaultSeverity: "warning",
    source: "core",
    phase: "pre-synth",
    hasAutoFix: true,
  },
];

describe("generateRuleCatalog", () => {
  test("generates valid MDX with frontmatter", () => {
    const mdx = generateRuleCatalog(mockEntries);

    expect(mdx).toContain("---");
    expect(mdx).toContain('title: "Rule Reference"');
    expect(mdx).toContain("**3** rules");
  });

  test("groups rules by category", () => {
    const mdx = generateRuleCatalog(mockEntries);

    expect(mdx).toContain("## Correctness");
    expect(mdx).toContain("## Security");
    expect(mdx).toContain("## Style");
  });

  test("includes table headers", () => {
    const mdx = generateRuleCatalog(mockEntries);

    expect(mdx).toContain("| ID | Description | Severity | Phase | Fix |");
  });

  test("renders rule entries with correct data", () => {
    const mdx = generateRuleCatalog(mockEntries);

    expect(mdx).toContain("COR001");
    expect(mdx).toContain("No inline objects");
    expect(mdx).toContain("WAW018");
    expect(mdx).toContain("public access");
  });

  test("marks auto-fix rules", () => {
    const mdx = generateRuleCatalog(mockEntries);
    const lines = mdx.split("\n");
    const cor008Line = lines.find((l) => l.includes("COR008"));
    expect(cor008Line).toContain("Yes");
  });

  test("renders helpUri as link", () => {
    const mdx = generateRuleCatalog(mockEntries);
    expect(mdx).toContain("[`WAW018`](https://chant.dev/lint-rules/waw018)");
  });
});

describe("generateRuleDetailPage", () => {
  test("generates valid MDX with frontmatter", () => {
    const mdx = generateRuleDetailPage(mockEntries[0]);

    expect(mdx).toContain("---");
    expect(mdx).toContain("COR001");
    expect(mdx).toContain("No inline objects");
  });

  test("includes metadata table", () => {
    const mdx = generateRuleDetailPage(mockEntries[0]);

    expect(mdx).toContain("| **Severity** | warning |");
    expect(mdx).toContain("| **Category** | style |");
    expect(mdx).toContain("| **Phase** | pre-synth |");
  });

  test("includes configuration example", () => {
    const mdx = generateRuleDetailPage(mockEntries[0]);

    expect(mdx).toContain("## Configuration");
    expect(mdx).toContain('"COR001"');
  });

  test("includes disable syntax", () => {
    const mdx = generateRuleDetailPage(mockEntries[0]);

    expect(mdx).toContain("## Disabling");
    expect(mdx).toContain("chant-disable COR001");
    expect(mdx).toContain("chant-disable-next-line COR001 -- reason");
  });
});
