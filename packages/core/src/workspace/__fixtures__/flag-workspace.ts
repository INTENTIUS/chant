/**
 * A workspace with feature flags (#4024), for the flag tests: a throwaway git
 * repository with a decision kind, the reference workspace's work kind, and
 * the canonical flag kind chant ships at `reference-kinds/flag`.
 *
 * - The decision kind closes `confirmed` and `superseded`. d-001 is
 *   confirmed, d-002 is only decided.
 * - W-001 implements d-001, so its work is settled. W-002 implements d-002.
 * - The flag `old-banner` hides W-001, so it is due for removal (stale).
 * - The flag `new-checkout` hides W-002 and backs the build parameter
 *   `newCheckout` of member `shop`: on in dev, off in prod, and no value in
 *   staging.
 * - Member `shop` has a component whose deploy declares a gate, so every
 *   environment it builds for has one. Member `blog` has a component with
 *   no gate.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, repo } from "./contract-repo";

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const REF = join(REPO_ROOT, "reference-workspace");
const ref = (path: string) => readFileSync(join(REF, path), "utf-8");
const canonical = (file: string) => readFileSync(join(HERE, "..", "reference-kinds", "flag", file), "utf-8");

const DECISION_KIND = `export const recordKind = {
  name: "decision",
  location: { dir: ".", match: "^d-[0-9]{3}-.+\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:test:decision:1", path: "decision.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "decided", "confirmed", "superseded"],
  closedStates: ["confirmed", "superseded"],
  approval: { proposed: 0, decided: 1, confirmed: 2, superseded: 2 },
  supersedes: { field: "supersedes" },
};
`;

const DECISION_SCHEMA = JSON.stringify(
  {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "urn:test:decision:1",
    type: "object",
    required: ["id", "state"],
    properties: { id: { type: "string" }, state: { type: "string" }, supersedes: { type: "array", items: { type: "string" } } },
  },
  null,
  2,
);

const decision = (id: string, state: string) => `---\nid: "${id}"\nstate: "${state}"\nsupersedes: []\n---\n\n# ${id}\n`;

export function workItem(id: string, implementsIds: string[], state = "in-progress"): string {
  const data = {
    schema: 1,
    id,
    title: `Work ${id}`,
    state,
    implements: implementsIds,
    needs: [],
    constrains: ["member:shop"],
    evidence: [],
    owner: "alice",
    opened_on: "2026-10-01",
    ...(state === "done" ? { closed_on: "2026-10-10" } : {}),
    source: { kind: "workspace", member: "shop" },
    supersedes: [],
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

export function flagRecord(id: string, fields: { work: string; member: string; param: string; values: Record<string, string | number | boolean>; owner?: string }): string {
  const data = { schema: 1, id, owner: fields.owner ?? "alice", work: fields.work, member: fields.member, param: fields.param, values: fields.values };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

/** A component file whose deploy declares a gate when `gated` is set. */
export function componentFile(name: string, gated: boolean): string {
  const steps = gated ? `[{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/${name}.json" }]` : `[{ kind: "apply", template: "dist/${name}.json" }]`;
  return `export const ${name} = { name: "${name}", dependsOn: [], deploy: [{ phase: "Apply", steps: ${steps} }] };\n`;
}

/** The flag workspace's files, with `overrides` laid over them (a null value removes a file). */
export function flagWorkspaceFiles(overrides: Record<string, string | null> = {}): Record<string, string> {
  const files: Record<string, string | null> = {
    "chant.workspace.json": JSON.stringify(
      {
        name: "flags",
        schema: 1,
        members: [
          { name: "shop", dir: "shop", kind: "chant" },
          { name: "blog", dir: "blog", kind: "chant" },
        ],
        records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }, { kind: "flags/flag.kind.mjs" }],
      },
      null,
      2,
    ),
    "shop/chant.config.ts": `export default { environments: ["dev", "staging", "prod"] };\n`,
    "shop/shop.component.ts": componentFile("shop", true),
    "blog/chant.config.ts": `export default { environments: ["dev", "prod"] };\n`,
    "blog/blog.component.ts": componentFile("blog", false),
    "decisions/decision.kind.mjs": DECISION_KIND,
    "decisions/decision.schema.json": DECISION_SCHEMA,
    "decisions/d-001-the-banner.md": decision("d-001", "confirmed"),
    "decisions/d-002-the-checkout.md": decision("d-002", "decided"),
    "work/work.kind.mjs": ref("work/work.kind.mjs").replace('    answers: "../answers/answer.kind.mjs",\n', ""),
    "work/work.schema.json": ref("work/work.schema.json"),
    "work/W-001-the-banner.md": workItem("W-001", ["d-001"], "done"),
    "work/W-002-the-checkout.md": workItem("W-002", ["d-002"]),
    "flags/flag.kind.mjs": canonical("flag.kind.mjs"),
    "flags/flag.schema.json": canonical("flag.schema.json"),
    "flags/old-banner.flag.md": flagRecord("old-banner", { work: "W-001", member: "blog", param: "banner", values: { dev: true, prod: true } }),
    "flags/new-checkout.flag.md": flagRecord("new-checkout", { work: "W-002", member: "shop", param: "newCheckout", values: { dev: true, prod: false } }),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => e[1] !== null));
}

/** The flag workspace in a new git repository, committed. */
export function flagWorkspace(overrides: Record<string, string | null> = {}): string {
  const root = repo(flagWorkspaceFiles(overrides));
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "flags");
  return root;
}
