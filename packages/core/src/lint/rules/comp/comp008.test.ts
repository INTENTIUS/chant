/**
 * COMP008 (#4490): a component's terraform-apply step deploys a root the
 * project marks signalOnly. The check runs over fixture components with the
 * marked roots handed in, the way `chant lint` hands them; the config read
 * (`signalOnlyRootsOf`) runs over a temporary workspace.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runComponentChecks, type SignalOnlyRoot } from "../../component-checks";
import { comp008AppliesSignalOnlyRootRule, signalOnlyRootsOf } from "./comp008-applies-signal-only-root";

const FIXTURES = join(import.meta.dirname, "..", "__fixtures__", "comp", "comp008");
const MARKED = new Map<string, SignalOnlyRoot>([["azure", { dir: "../azure", owner: "azure" }]]);

describe("COMP008: applies-signal-only-root", () => {
  it("warns on a terraform-apply step deploying a signalOnly root, naming the root and its owner", async () => {
    const diagnostics = await runComponentChecks(join(FIXTURES, "fail"), [comp008AppliesSignalOnlyRootRule], { signalOnlyRoots: MARKED });
    expect(diagnostics).toHaveLength(1);
    const [d] = diagnostics;
    expect(d.checkId).toBe("COMP008");
    expect(d.severity).toBe("warning");
    expect(d.component).toBe("dns");
    expect(d.message).toContain('root "azure"');
    expect(d.message).toContain('workspace member "azure" owns it');
  });

  it("says no owner was found when the workspace names none", async () => {
    const roots = new Map<string, SignalOnlyRoot>([["azure", { dir: "../azure" }]]);
    const [d] = await runComponentChecks(join(FIXTURES, "fail"), [comp008AppliesSignalOnlyRootRule], { signalOnlyRoots: roots });
    expect(d.message).toContain("no workspace member was found to own it");
  });

  it("passes a component that deploys only its own roots", async () => {
    const diagnostics = await runComponentChecks(join(FIXTURES, "pass"), [comp008AppliesSignalOnlyRootRule], { signalOnlyRoots: MARKED });
    expect(diagnostics).toHaveLength(0);
  });

  it("flags nothing when no marked roots were resolved", async () => {
    expect(await runComponentChecks(join(FIXTURES, "fail"), [comp008AppliesSignalOnlyRootRule])).toHaveLength(0);
  });
});

describe("signalOnlyRootsOf", () => {
  const ws = mkdtempSync(join(tmpdir(), "comp008-"));
  afterAll(() => rmSync(ws, { recursive: true, force: true }));
  // findWorkspaceRoot walks up to the git root, so the workspace root holds a .git.
  mkdirSync(join(ws, ".git"));
  mkdirSync(join(ws, "dns"));
  mkdirSync(join(ws, "azure"));
  writeFileSync(
    join(ws, "chant.workspace.json"),
    JSON.stringify({
      name: "estate",
      schema: 1,
      members: [
        { name: "dns", dir: "dns", kind: "chant", because: "the dns zone" },
        { name: "azure", dir: "azure", kind: "chant", because: "the azure estate" },
      ],
    }),
  );
  writeFileSync(
    join(ws, "dns", "chant.config.json"),
    JSON.stringify({ terraform: { roots: { dns: { dir: "./estate" }, azure: { dir: "../azure", signalOnly: true } } } }),
  );

  it("lists only the marked roots, with the member whose directory holds each", async () => {
    const roots = await signalOnlyRootsOf(join(ws, "dns"));
    expect([...roots]).toEqual([["azure", { dir: "../azure", owner: "azure" }]]);
  });

  it("gives an empty map for a project with no config", async () => {
    expect((await signalOnlyRootsOf(join(ws, "azure"))).size).toBe(0);
  });
});
