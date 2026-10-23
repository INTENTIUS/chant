/**
 * A sensitive variable's literal default stays out of what the commands print
 * (chant #4377): the real `chant graph --format ir` and `chant search --show`
 * over `__fixtures__/sensitive-default`, and `chant workspace graph` over a
 * workspace holding the same file, each grepped for every secret.
 */
import { cpSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { runSearch } from "@intentius/chant/cli/handlers/search";
import { cleanScratch, declaration, REPO, repo } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import { workspaceGraph } from "../../../packages/core/src/workspace/graph-cli";
import { SENSITIVE_PLACEHOLDER } from "./hcl/redact";
import { terraformPlugin } from "./plugin";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "sensitive-default");
const SECRETS = ["tok-string-9f3a", "5432917", "admin-map-77", "pw-map-c0ffee"];

async function inFixture(run: () => Promise<number>): Promise<{ exit: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(FIXTURE);
  try {
    return { exit: await run(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    process.chdir(cwd);
    vi.restoreAllMocks();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("the fixture's secrets stay out of the commands' output", () => {
  it("chant graph --format ir", async () => {
    const r = await inFixture(() =>
      runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [terraformPlugin], serializers: [] }),
    );
    expect(r.exit, r.err).toBe(0);
    expect(r.out).toContain(SENSITIVE_PLACEHOLDER);
    expect(r.out).toContain("us-east-1");
    for (const secret of SECRETS) expect(r.out).not.toContain(secret);
  });

  it("chant search --show body,source", async () => {
    const r = await inFixture(() =>
      runSearch({ args: { path: "kind:Terraform::Variable", show: "body,source", json: true } as never, plugins: [terraformPlugin], serializers: [] }),
    );
    expect(r.exit, r.err).toBe(0);
    expect(r.out).toContain("api_token");
    expect(r.out).toContain(SENSITIVE_PLACEHOLDER);
    for (const secret of SECRETS) expect(r.out).not.toContain(secret);
  });
});

describe("chant workspace graph", () => {
  afterAll(cleanScratch);

  it("composes a terraform member without its sensitive defaults", async () => {
    const version = (JSON.parse(readFileSync(join(REPO, "lexicons", "terraform", "package.json"), "utf-8")) as { version: string }).version;
    const root = repo({
      "chant.workspace.json": declaration([{ name: "net", dir: "estates/net", kind: "terraform" }], {
        pins: [{ package: "@intentius/chant-lexicon-terraform", version }],
      }),
      ".gitignore": "node_modules\n",
    });
    cpSync(join(FIXTURE, "net", "main.tf"), join(root, "estates", "net", "main.tf"), { recursive: true });
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    const { doc } = await workspaceGraph({ cwd: root });
    const text = JSON.stringify(doc);
    expect(text).toContain("net/net/var.api_token");
    expect(text).toContain(SENSITIVE_PLACEHOLDER);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }, 240_000);
});
