/**
 * Capabilities across a declared workspace (#4375).
 *
 * `platform` declares a role whose policy reads a bucket by ARN string, and
 * `data` declares that bucket. Searched member by member, neither sees the
 * other, so no answer could join them. A capability term runs its rules once,
 * under the workspace's chant, over the graph `chant workspace graph`
 * composes, so `reaches` crosses from one member into the other.
 *
 * Also: `chant workspace search --capabilities --json` is the `capabilities`
 * document, and chant's MCP `capabilities` tool returns it unchanged.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { workspaceSearch } from "@intentius/chant/workspace/search-cli";
import { readerBin, type Toolchain } from "@intentius/chant/workspace/member-commands";
import { createCapabilitiesHandler } from "@intentius/chant/cli/mcp/tools/capabilities";
import { contract } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import searchSchema from "../../../packages/core/src/workspace/search.schema.json";
import capabilitiesSchema from "../../../packages/core/src/workspace/capabilities.schema.json";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const TIMEOUT = 240_000;
const chant = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const reader: Toolchain = { command: chant, identity: realpathSync(readerBin()), source: "reader" };

let root: string;

function member(name: string, rootDir: string, tf: string): void {
  mkdirSync(join(root, name, rootDir), { recursive: true });
  writeFileSync(
    join(root, name, "chant.config.ts"),
    `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";
export default { lexicons: ["terraform"], terraform: { roots: { ${rootDir}: { dir: "./${rootDir}" } } } } satisfies ChantConfig;
`,
  );
  writeFileSync(join(root, name, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  writeFileSync(join(root, name, rootDir, "main.tf"), tf);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-cap-ws-")));
  mkdirSync(join(root, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(REPO, "packages", "core"), join(root, "node_modules", "@intentius", "chant"), "dir");
  symlinkSync(join(REPO, "lexicons", "terraform"), join(root, "node_modules", "@intentius", "chant-lexicon-terraform"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify({ name: "split", schema: 1, members: [{ name: "platform", dir: "platform", kind: "chant" }, { name: "data", dir: "data", kind: "chant" }] }),
  );
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
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  process.env.CHANT_CACHE_DIR = join(root, ".cache");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

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
