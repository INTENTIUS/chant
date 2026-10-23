/**
 * Capabilities across a declared workspace (#4375, #4378).
 *
 * `platform` declares a role whose policy reads a bucket by ARN string, and
 * `data` declares that bucket. Searched member by member, neither sees the
 * other, so no answer could join them. A capability term runs its rules once,
 * under the workspace's chant, over the graph `chant workspace graph`
 * composes, so `reaches` crosses from one member into the other.
 *
 * Each member's view is mapped by its own chant (#4378): two members whose
 * terraform lexicons map classification tags differently each answer by
 * their own mapping, and a member whose chant predates the view is
 * `member-chant-too-old`, not an empty answer.
 *
 * Also: `chant workspace search --capabilities --json` is the `capabilities`
 * document, and chant's MCP `capabilities` tool returns it unchanged.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { workspaceSearch } from "@intentius/chant/workspace/search-cli";
import { workspaceGraph } from "@intentius/chant/workspace/graph-cli";
import { readerBin, type Toolchain } from "@intentius/chant/workspace/member-commands";
import { createCapabilitiesHandler } from "@intentius/chant/cli/mcp/tools/capabilities";
import { contract } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import searchSchema from "../../../packages/core/src/workspace/search.schema.json";
import capabilitiesSchema from "../../../packages/core/src/workspace/capabilities.schema.json";
import graphSchema from "../../../packages/core/src/workspace/graph.schema.json";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const TIMEOUT = 240_000;
const chant = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const reader: Toolchain = { command: chant, identity: realpathSync(readerBin()), source: "reader" };

let root: string;
let mapped: string;

function member(name: string, rootDir: string, tf: string, at = root, lexicon = `"terraform"`): void {
  mkdirSync(join(at, name, rootDir), { recursive: true });
  writeFileSync(
    join(at, name, "chant.config.ts"),
    `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";
export default { lexicons: [${lexicon}], terraform: { roots: { ${rootDir}: { dir: "./${rootDir}" } } } } satisfies ChantConfig;
`,
  );
  writeFileSync(join(at, name, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  writeFileSync(join(at, name, rootDir, "main.tf"), tf);
}

/** A workspace root with chant and the terraform lexicon installed, committed once its members are written. */
function workspace(prefix: string, name: string, members: string[]): string {
  const at = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(at, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(REPO, "packages", "core"), join(at, "node_modules", "@intentius", "chant"), "dir");
  symlinkSync(join(REPO, "lexicons", "terraform"), join(at, "node_modules", "@intentius", "chant-lexicon-terraform"), "dir");
  writeFileSync(join(at, ".gitignore"), "node_modules/\n");
  writeFileSync(join(at, "chant.workspace.json"), JSON.stringify({ name, schema: 1, members: members.map((m) => ({ name: m, dir: m, kind: "chant" })) }));
  return at;
}

function commit(at: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: at, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

/** Two buckets, one tagged the way the stock mapping reads classification, one the way the `legacy` mapping does. */
const BUCKETS = `resource "aws_s3_bucket" "by_classification" {
  bucket = "BUCKET-a"
  tags   = { "data-classification" = "restricted" }
}
resource "aws_s3_bucket" "by_sensitivity" {
  bucket = "BUCKET-b"
  tags   = { "sensitivity" = "restricted" }
}
`;

beforeAll(() => {
  root = workspace("chant-cap-ws-", "split", ["platform", "data"]);
  member(
    "platform",
    "net",
    `resource "aws_iam_role" "app" {
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "app" {
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::split-customer-data/*" }]
  })
}
`,
  );
  member(
    "data",
    "store",
    `resource "aws_s3_bucket" "customers" {
  bucket = "split-customer-data"
  tags   = { "data-classification" = "restricted" }
}
`,
  );
  commit(root);
  process.env.CHANT_CACHE_DIR = join(root, ".cache");

  // A second workspace (#4378). `stock` loads the terraform lexicon as
  // installed. `legacy` loads it through a module of its own whose mapping
  // reads classification from a `sensitivity` tag, as a lexicon version
  // with a different mapping would. `old` runs a chant from before
  // --capability-view: it has no member-run and refuses the flag, as every
  // chant since #1127 refuses one it doesn't know.
  mapped = workspace("chant-cap-ws-mapped-", "mapped", ["stock", "legacy", "old"]);
  member("stock", "store", BUCKETS.replace(/BUCKET/g, "stock"), mapped);
  member("legacy", "store", BUCKETS.replace(/BUCKET/g, "legacy"), mapped, `{ name: "terraform", module: "./terraform-lexicon.ts" }`);
  writeFileSync(
    join(mapped, "legacy", "terraform-lexicon.ts"),
    `import { terraformPlugin } from "@intentius/chant-lexicon-terraform";
const pack = terraformPlugin.capabilityPack!;
export const legacyTerraform = { ...terraformPlugin, capabilityPack: { ...pack, mapping: { ...pack.mapping, classificationTags: ["sensitivity"] } } };
`,
  );
  member("old", "store", BUCKETS.replace(/BUCKET/g, "old"), mapped);
  mkdirSync(join(mapped, "old", "node_modules", ".bin"), { recursive: true });
  const oldChant = join(mapped, "old", "node_modules", ".bin", "chant");
  writeFileSync(
    oldChant,
    `#!/bin/sh
case " $* " in
  *" member-run "*) exit 1 ;;
  *" --capability-view "*) echo 'Unknown flag: --capability-view' >&2; echo 'Run "chant --help" to see supported flags.' >&2; exit 1 ;;
esac
exec ${chant.map((a) => `'${a}'`).join(" ")} "$@"
`,
  );
  chmodSync(oldChant, 0o755);
  writeFileSync(join(mapped, ".gitignore"), "node_modules/\n!old/node_modules/\n");
  commit(mapped);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(mapped, { recursive: true, force: true });
});

describe("workspace search with a capability", () => {
  test(
    "reaches crosses from the member that declares the role into the one that declares the bucket",
    async () => {
      const { doc, failed } = await workspaceSearch({ cwd: root, query: "cap:holds-secret <-[cap=reaches]kind:aws_iam_role", reader });
      contract(searchSchema).expectValid(doc);
      expect(failed).toBe(false);
      if ("error" in doc) throw new Error(doc.error.message);
      const d = doc as unknown as {
        matches: { id: string; member: string; displayId: string; paths: { term: string; hops: { from: string; to: string; edge?: string }[] }[] }[];
        members: { name: string; status: string; alone?: boolean }[];
        capabilities: { name: string }[];
      };
      expect(d.matches.map((m) => [m.id, m.member, m.displayId])).toEqual([["data/store/aws_s3_bucket.customers", "data", "store/aws_s3_bucket.customers"]]);
      const path = d.matches[0].paths.find((p) => p.term.startsWith("<-"))!;
      expect(path.hops.map((h) => [h.from, h.edge])).toEqual([
        ["platform/net/aws_iam_role_policy.app#policy[0].Statement[0]", "resource"],
        ["platform/net/aws_iam_role_policy.app", "statement"],
        ["platform/net/aws_iam_role_policy.app", "attachedTo"],
      ]);
      expect(d.members.map((m) => [m.name, m.status, m.alone ?? false])).toEqual([
        ["platform", "searched", false],
        ["data", "searched", false],
      ]);
      expect(d.capabilities.map((c) => c.name)).toEqual(["holds-secret", "reaches"]);
    },
    TIMEOUT,
  );

  test("a capability term over a workspace refuses a live read", async () => {
    const { doc } = await workspaceSearch({ cwd: root, query: "cap:holds-secret", flags: { live: true, env: "dev" }, reader });
    expect(doc).toMatchObject({ error: { code: "usage-invalid" } });
  });
});

describe("each member mapped by its own chant (#4378)", () => {
  test(
    "two members whose lexicons map classification differently each answer by their own mapping, and a chant from before the view is member-chant-too-old",
    async () => {
      const { doc, failed } = await workspaceSearch({ cwd: mapped, query: "cap:holds-secret", reader });
      contract(searchSchema).expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      const d = doc as unknown as {
        matches: { id: string }[];
        members: { name: string; status: string; reason: { code: string; message: string } | null; matches?: string[] }[];
      };
      // The workspace's chant would read both members through the stock
      // mapping and answer stock's and legacy's by_classification.
      expect(d.matches.map((m) => m.id)).toEqual(["legacy/store/aws_s3_bucket.by_sensitivity", "stock/store/aws_s3_bucket.by_classification"]);
      expect(d.members.map((m) => [m.name, m.status, m.reason?.code ?? null])).toEqual([
        ["stock", "searched", null],
        ["legacy", "searched", null],
        ["old", "failed", "member-chant-too-old"],
      ]);
      expect(d.members.find((m) => m.name === "old")!.matches).toBeUndefined();
      expect(failed).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "workspace graph --capability-view carries each member's view with composed ids, and null for the chant that printed none",
    async () => {
      const { doc } = await workspaceGraph({ cwd: mapped, reader, args: { detail: 3, capabilityView: true }, noCache: true });
      contract(graphSchema).expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      const members = doc.members as unknown as { name: string; status: string; capabilityView?: { lexicons: string[]; nodes: { id: string; label: string; attrs: Record<string, unknown> }[] } | null }[];
      const classified = (name: string) =>
        members.find((m) => m.name === name)!.capabilityView!.nodes.filter((n) => n.label === "Bucket" && n.attrs.classification !== undefined).map((n) => n.id);
      expect(classified("stock")).toEqual(["stock/store/aws_s3_bucket.by_classification"]);
      expect(classified("legacy")).toEqual(["legacy/store/aws_s3_bucket.by_sensitivity"]);
      const old = members.find((m) => m.name === "old")!;
      expect([old.status, old.capabilityView]).toEqual(["composed", null]);
      // Without the flag the members carry no view at all.
      const plain = await workspaceGraph({ cwd: mapped, reader, args: { detail: 3 } });
      if ("error" in plain.doc) throw new Error(plain.doc.error.message);
      expect(plain.doc.members.every((m) => !("capabilityView" in m))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("the capabilities document in a workspace", () => {
  test(
    "workspace search --capabilities prints it for the members' lexicons, and the MCP tool returns it unchanged",
    async () => {
      const cli = JSON.parse(
        execFileSync(chant[0], [...chant.slice(1), "workspace", "search", "--capabilities", "--json"], { cwd: root, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } }),
      );
      contract(capabilitiesSchema).expectValid(cli);
      expect(cli.capabilities.find((c: { name: string }) => c.name === "reaches").lexicons).toEqual({ terraform: "supported" });
      const viaMcp = await createCapabilitiesHandler(root, chant)({});
      expect(viaMcp).toEqual(cli);
    },
    TIMEOUT,
  );
});
