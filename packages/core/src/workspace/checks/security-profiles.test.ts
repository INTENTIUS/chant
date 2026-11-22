/**
 * The security profile checks, WSP166 and WSP167 (#5464).
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { loadRunnerKey } from "../trust/dsse";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-profile-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  // ci.green.signedSince names a commit the clone has.
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text.replaceAll("__HEAD__", head));
  }
  return root;
}

const member = { name: "app", dir: "app", kind: "other", because: "the app" };
const declaration = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "acme", schema: 1, members: [member], ...extra }, null, 2);

const diagnostics = async (root: string) => {
  const all = (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics;
  // A declaration that does not read would leave every check silent.
  expect(all.filter((d) => d.ruleId === "WSP001").map((d) => d.message)).toEqual([]);
  return all.filter((d) => /^WSP16/.test(d.ruleId));
};
/** The findings as [id, code]. */
const found = async (root: string) => (await diagnostics(root)).map((d) => [d.ruleId, d.code]);

const p256 = loadRunnerKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()).publicKey;
const ed25519 = loadRunnerKey(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString()).publicKey;

/** Everything the groups and the profile look for, set. */
const complete = (security: string[], runnerKey = p256) => ({
  "chant.workspace.json": declaration({
    security,
    retention: { changeSets: { days: 90 }, releases: { days: 365 } },
    identity: { attribution: "identified", gates: { release: { class: "human" }, deploy: { class: "human" } } },
    ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], signedSince: "__HEAD__" } },
  }),
  ".chant/allowed_signers": "",
  ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "chant-runner:box", key: runnerKey, class: "runner" }], roles: { runner: ["chant-runner:box"] } }),
  ".github/workflows/pr.yml": '      - run: chant components pr-apply --base "$BASE_SHA" --env prod --gate deploy --forge github\n',
  "app/package-lock.json": "{}",
});

describe("the fedramp-moderate profile (WSP166)", () => {
  test("with nothing else set, it reports what every group lacks and what the profile looks for", async () => {
    const root = repo({ "chant.workspace.json": declaration({ security: ["fedramp-moderate"] }), "app/x": "" });
    const all = await found(root);
    // The groups the profile turns on report as their own checks.
    expect(new Set(all.map((f) => f[0]))).toEqual(new Set(["WSP161", "WSP163", "WSP164", "WSP165", "WSP166"]));
    expect(all.filter((f) => f[0] === "WSP166")).toEqual([
      ["WSP166", "profile-retention-short"],
      ["WSP166", "profile-retention-short"],
      ["WSP166", "profile-gate-not-human"],
    ]);
    const messages = (await diagnostics(root)).filter((d) => d.ruleId === "WSP166").map((d) => d.message);
    expect(messages[0]).toMatch(/^profile-retention-short: under fedramp-moderate, retention\.changeSets\.days is unset .* \[AU-11\]$/);
    expect(messages[2]).toMatch(/the release gate has no identity\.gates entry.* \[AC-5, CM-3\(4\)\]$/);
    expect(messages.join("\n")).not.toMatch(/\b(meets|satisfies|compliant)\b/i);
  });

  test("reports none once everything is set", async () => {
    expect(await found(repo(complete(["fedramp-moderate"])))).toEqual([]);
  });

  test("a gate held to no class, to a class an agent holds, or passed by an agent alone is reported", async () => {
    const files = complete(["fedramp-moderate"]);
    const with_ = (gates: Record<string, unknown>) => ({ ...files, "chant.workspace.json": declaration({ ...JSON.parse(files["chant.workspace.json"]), identity: { attribution: "identified", gates } }) });
    const codes = async (gates: Record<string, unknown>) => (await diagnostics(repo(with_(gates)))).filter((d) => d.ruleId === "WSP166").map((d) => d.message);
    expect(await codes({ release: { class: "human" } })).toEqual([expect.stringContaining("the gate deploy, which an apply job waits on, has no identity.gates entry")]);
    expect(await codes({ release: {}, deploy: { class: "human" } })).toEqual([expect.stringContaining("identity.gates.release names no class")]);
    expect(await codes({ release: { class: "agent" }, deploy: { class: "human" } })).toEqual([expect.stringContaining("names the agent class, which is not people")]);
    expect(await codes({ release: { class: "human" }, deploy: { class: "human", agentPassesAlone: true } })).toEqual([expect.stringContaining("identity.gates.deploy sets agentPassesAlone")]);
  });

  test("an Ed25519 runner key is reported toward SC-13", async () => {
    const messages = (await diagnostics(repo(complete(["fedramp-moderate"], ed25519)))).map((d) => d.message);
    expect(messages).toEqual([expect.stringMatching(/^profile-runner-key-eddsa: under fedramp-moderate, .*Ed25519 key for chant-runner:box under runners.* \[SC-13\]$/)]);
  });

  test("a release config that turns the scan or signing off, leaves the database unbounded, or signs with the upstream cosign is reported", async () => {
    const base = complete(["fedramp-moderate"]);
    const config = (release: string) => found(repo({ ...base, "app/chant.config.ts": `export default { release: { ${release}, publish: [{ type: "oci", image: "dist/api.tar", repository: "ghcr.io/acme/api" }] } };` }));
    expect(await config("scan: false, signing: false")).toEqual([
      ["WSP166", "profile-scan-off"],
      ["WSP166", "profile-signing-off"],
    ]);
    expect(await config('scan: { db: "/var/grype" }, signing: { kms: "awskms:///alias/release" }')).toEqual([["WSP166", "profile-scan-db-unbounded"]]);
    expect(await config('scan: { db: "/var/grype", dbMaxAgeHours: 48 }, signing: { kms: "awskms:///alias/release" }')).toEqual([["WSP166", "profile-scan-db-unbounded"]]);
    expect(await config('scan: { db: "/var/grype", dbMaxAgeHours: 12 }, signing: { kms: "awskms:///alias/release" }')).toEqual([]);
    expect(await config("signing: true")).toEqual([["WSP166", "profile-signing-module"]]);
    expect(await config('signing: true, setup: [], env: { CHANT_COSIGN: "/opt/cosign-fips/cosign" }')).toEqual([]);
  });

  test("a workspace with no profile gets no profile finding", async () => {
    expect((await found(repo({ "chant.workspace.json": declaration(), "app/x": "" }))).filter((f) => f[0] === "WSP166" || f[0] === "WSP167")).toEqual([]);
  });
});

describe("the cccs-medium profile (WSP167)", () => {
  test("reports under its own check, with CCCS Medium's ids: no SR family", async () => {
    const root = repo({ ...complete(["cccs-medium"]), "app/chant.config.ts": 'export default { release: { signing: false, publish: [{ type: "forge" }] } };' });
    const d = await diagnostics(root);
    expect(d.map((x) => [x.ruleId, x.code])).toEqual([["WSP167", "profile-signing-off"]]);
    expect(d[0]!.message).toMatch(/\[SA-10\(1\), SI-7\]$/);
  });

  test("with both profiles named, each reports under its own check with its own ids", async () => {
    const root = repo({ ...complete(["fedramp-moderate", "cccs-medium"]), "app/chant.config.ts": 'export default { release: { signing: false, publish: [{ type: "forge" }] } };' });
    expect((await diagnostics(root)).map((x) => [x.ruleId, x.message.slice(x.message.lastIndexOf("["))])).toEqual([
      ["WSP166", "[SI-7, SR-11]"],
      ["WSP167", "[SA-10(1), SI-7]"],
    ]);
  });
});
