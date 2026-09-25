import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { parseDeclaration, WorkspaceReadError } from "../declaration";
import { gitTree } from "../tree";
import { isCredentialKey, isSecretReference, literalSecretsInCode, literalSecretsInText } from "./boxes";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-box-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// Built at run time so no credential-shaped literal sits in this file.
const ANTHROPIC_KEY = ["sk", "ant", "api03", "A".repeat(40)].join("-");
const GITHUB_TOKEN = ["ghp", "B".repeat(36)].join("_");

const BROKERED = { capabilities: [{ name: "inference", broker: "lobby", scope: ["agent", "vault", "conversations", "sandboxes"] }] };

const declaration = (box: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "acme", schema: 1, members: [{ name: "spec", dir: "spec", kind: "other", because: "the box's declarations", box, ...extra }] }, null, 2);

/** A chaff-style box declaration: a service whose env has `apiKey`. */
const spec = (apiKey: string) => `import { Service, Capability } from "@intentius/chant-lexicon-chaff";

export const app = new Service({
  start: ["node", "app/server.mjs"],
  env: {
    HUD_SRC: "\${HOME}/alecraso/hud-live",
    ANTHROPIC_API_KEY: ${JSON.stringify(apiKey)},
  },
});

export const inference = new Capability({ provider: "brokered", credential: "$INFERENCE_TOKEN", endpoint: "$INFERENCE_URL" });
`;

/** The findings, less WSP009, which every member of kind other gets. */
const found = async (root: string) => (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => d.ruleId !== "WSP009");

describe("box-credential-declared (WSP121)", () => {
  test("a literal API key in a service's env fails the box", async () => {
    const root = repo({ "chant.workspace.json": declaration(BROKERED), "spec/box.ts": spec(ANTHROPIC_KEY) });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.code, x.entity, x.file, x.line])).toEqual([["WSP121", "box-credential-declared", "spec", "spec/box.ts", 7]]);
    expect(d[0].message).toContain("an Anthropic API key");
    // The message names what was found, never the value.
    expect(d[0].message).not.toContain(ANTHROPIC_KEY);
  });

  test("the same box with the key as a reference and the capability brokered passes", async () => {
    for (const ref of ["${ANTHROPIC_API_KEY}", "$ANTHROPIC_API_KEY", "op://box/anthropic/key", "bws://0f5b/anthropic", "infisical:///dev/ANTHROPIC_API_KEY"]) {
      const root = repo({ "chant.workspace.json": declaration(BROKERED), "spec/box.ts": spec(ref) });
      expect(await found(root), ref).toEqual([]);
    }
  });

  test("a literal of no known shape under a credential key fails, and so does a vault secret's literal value", async () => {
    const root = repo({
      "chant.workspace.json": declaration(BROKERED),
      "spec/box.ts": `export const box = Box({
  envVars: { GITHUB_TOKEN: "hunter2hunter2" },
  vault: { secrets: [{ key: "STUDIO_SECRET", value: "plain-text" }, { key: "OK", value: "\${STUDIO_SECRET}" }] },
  repo: { url: "https://github.com/x/y", secretKey: "GIT_TOKEN" },
  names: { credential: "INFERENCE_TOKEN", tokenPath: "/run/secrets/t", token: "~/box/llm-token", endpoint: { apiKey: "https://broker.local/key" } },
  process: { token: process.env.TOKEN! },
});
`,
    });
    const d = await found(root);
    expect(d.map((x) => `${x.line}: ${x.message.split(" holds ")[1].split(", and")[0]}`)).toEqual([
      "2: a literal value for GITHUB_TOKEN",
      "3: a literal vault secret value for STUDIO_SECRET",
    ]);
  });

  test("an env file and a shell script in the box's directory are read too; prose only for credential shapes", async () => {
    const root = repo({
      "chant.workspace.json": declaration(BROKERED),
      "spec/.env": `FOUNTAIN_API_KEY=abc123def456\nPORT=8080\nGIT_TOKEN=\${CHUD_GIT_TOKEN}\n`,
      "spec/run.sh": `#!/bin/sh\nexport GITHUB_TOKEN=${GITHUB_TOKEN}\necho "password=$GIT_TOKEN"\nTOKEN=$1\ntoken=~/box/llm-token\nSECRET=/run/secrets/x\n`,
      "spec/README.md": `Token: rotate it monthly.\n`,
      "spec/node_modules/pkg/index.js": `export const k = ${JSON.stringify(ANTHROPIC_KEY)};\n`,
    });
    const d = await found(root);
    expect(d.map((x) => `${x.file}:${x.line}`)).toEqual(["spec/.env:1", "spec/run.sh:2"]);
  });

  test("a member without a box block is not read, and a box's finding can't be suppressed", async () => {
    const plain = repo({
      "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "spec", dir: "spec", kind: "other", because: "x" }] }),
      "spec/box.ts": spec(ANTHROPIC_KEY),
    });
    expect(await found(plain)).toEqual([]);
    const suppressed = repo({
      "chant.workspace.json": declaration(BROKERED, { suppress: [{ check: "WSP121", because: "a test key" }] }),
      "spec/box.ts": spec(ANTHROPIC_KEY),
    });
    expect((await found(suppressed)).map((x) => x.ruleId).sort()).toEqual(["WSP011", "WSP121"]);
  });

  test("under --at the revision's files are read", async () => {
    const root = repo({ "chant.workspace.json": declaration(BROKERED), "spec/box.ts": spec(ANTHROPIC_KEY) });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "box"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "spec/box.ts"), spec("${ANTHROPIC_API_KEY}"));
    expect(await found(root)).toEqual([]);
    const at = await runDeclarationChecks(root, (f) => f, { tree: gitTree(root, commit) });
    expect(at.diagnostics.map((x) => x.ruleId).filter((id) => id !== "WSP009")).toEqual(["WSP121"]);
  });
});

describe("box-capability-unbrokered (WSP122)", () => {
  test("a capability with no broker fails, at the capability", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ capabilities: [{ name: "fountain", broker: "lobby", scope: ["agent"] }, { name: "inference" }] }),
      "spec/box.ts": spec("${ANTHROPIC_API_KEY}"),
    });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.code, x.entity])).toEqual([["WSP122", "box-capability-unbrokered", "spec"]]);
    expect(d[0].message).toContain("needs inference and names no broker");
  });

  test("it can be turned down, since a box may be moving to a broker", async () => {
    const root = repo({
      "chant.workspace.json": JSON.stringify({
        name: "acme",
        schema: 1,
        checks: { WSP122: "warning" },
        members: [{ name: "spec", dir: "spec", kind: "other", because: "x", box: { capabilities: [{ name: "inference" }] } }],
      }),
      "spec/box.ts": "",
    });
    const report = await runDeclarationChecks(root, (f) => f, { gather: false });
    expect(report.ok).toBe(true);
    expect(report.diagnostics.filter((x) => x.ruleId !== "WSP009").map((x) => `${x.ruleId}:${x.severity}`)).toEqual(["WSP122:warning"]);
  });
});

describe("the box block in the declaration", () => {
  test("parses, with the broker null and the scope empty when left out", () => {
    const d = parseDeclaration(declaration({ capabilities: [{ name: "fountain", broker: "lobby", scope: ["agent", "vault"] }, { name: "inference" }] }), "chant.workspace.json");
    expect(d.members[0].box).toEqual({
      pointer: "/members/0/box",
      capabilities: [
        { name: "fountain", broker: "lobby", scope: ["agent", "vault"], pointer: "/members/0/box/capabilities/0" },
        { name: "inference", broker: null, scope: [], pointer: "/members/0/box/capabilities/1" },
      ],
    });
    expect(parseDeclaration(JSON.stringify({ name: "a", schema: 1, members: [{ name: "m", dir: "m", kind: "chant" }] }), "chant.workspace.json").members[0].box).toBeNull();
  });

  test("a capability named twice, or an unknown field, is declaration-invalid", () => {
    const twice = () => parseDeclaration(declaration({ capabilities: [{ name: "fountain", broker: "lobby" }, { name: "fountain", broker: "door" }] }), "chant.workspace.json");
    expect(twice).toThrow(WorkspaceReadError);
    expect(twice).toThrow(/lists the capability fountain twice/);
    expect(() => parseDeclaration(declaration({ capabilities: [{ name: "fountain", credential: "x" }] }), "chant.workspace.json")).toThrow(/unknown field "credential"/);
  });
});

describe("what counts as a literal secret", () => {
  test("references are not secrets", () => {
    for (const v of ["${X}", "${HOME}/.config", "$X", "$1", "$(cat f)", "op://v/i/f", "bws://id", "infisical:///dev/X", "{{chant:name}}", ""]) {
      expect(isSecretReference(v), v).toBe(true);
    }
    for (const v of ["hunter2", "abc${", "sk-live"]) expect(isSecretReference(v), v).toBe(v === "abc${");
  });

  test("keys that name a credential, and keys that name where one is", () => {
    for (const k of ["API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "apiKey", "token", "credential", "password", "AWS_SECRET_ACCESS_KEY", "authToken", "clientSecret"]) {
      expect(isCredentialKey(k), k).toBe(true);
    }
    for (const k of ["secretKey", "secret_key", "TOKEN_FILE", "tokenHash", "HUD_IDENTITY_PATH", "CHAFF_AGENT_VAULT", "key", "value", "maxTokens"]) {
      expect(isCredentialKey(k), k).toBe(false);
    }
  });

  test("a credential shape is found anywhere in code, and not in a template with a substitution", () => {
    const code = `const a = [${JSON.stringify(GITHUB_TOKEN)}];\nconst b = \`\${prefix}${"x".repeat(3)}\`;\n`;
    expect(literalSecretsInCode(code, "a.ts", ts.ScriptKind.TS).map((s) => [s.line, s.what])).toEqual([[1, "a GitHub token"]]);
    expect(literalSecretsInText(`# nothing\nkey: ${GITHUB_TOKEN}\n`).map((s) => s.line)).toEqual([2]);
  });
});
