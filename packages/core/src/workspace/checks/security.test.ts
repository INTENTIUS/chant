/**
 * The security group checklists, WSP161 to WSP165 (#4168 step 7).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-security-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const member = (extra: Record<string, unknown> = {}) => ({ name: "app", dir: "app", kind: "other", because: "the app", ...extra });
const declaration = (extra: Record<string, unknown> = {}, members = [member()]) => JSON.stringify({ name: "acme", schema: 1, members, ...extra }, null, 2);

/** The security findings as [id, code, entity]. */
const found = async (root: string) =>
  (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => /^WSP16/.test(d.ruleId)).map((d) => [d.ruleId, d.code, d.entity ?? null]);

describe("security groups (WSP161 to WSP165)", () => {
  test("a workspace that opts into no group gets no security finding", async () => {
    const root = repo({ "chant.workspace.json": declaration(), "app/chant.config.ts": "export default { release: { publish: [{ npm: {} , sbom: false }] } };" });
    expect(await found(root)).toEqual([]);
  });

  test("verified-releases with nothing set reports the signers file and the release gate", async () => {
    const root = repo({ "chant.workspace.json": declaration({ security: ["verified-releases"] }), "app/x": "" });
    expect(await found(root)).toEqual([
      ["WSP161", "security-signers-missing", null],
      ["WSP161", "security-release-gate-missing", null],
    ]);
  });

  test("verified-releases passes with signers and a release gate, and flags --allow-unsigned in a publish job", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["verified-releases"], identity: { gates: { release: { class: "person" } } } }),
      ".chant/allowed_signers": "",
      ".github/workflows/publish.yml": "jobs:\n  publish:\n    steps:\n      - run: npx chant release publish v1 --allow-unsigned\n",
      "app/x": "",
    });
    expect(await found(root)).toEqual([["WSP161", "security-publish-allows-unsigned", null]]);
  });

  test("a member's group applies to that member only", async () => {
    const root = repo({
      "chant.workspace.json": declaration({}, [member({ security: ["supply-chain"] }), member({ name: "web", dir: "web" })]),
      "app/chant.config.ts": "export default { release: { publish: [{ forge: {}, sbom: false }] } };",
      "web/chant.config.ts": "export default { release: { publish: [{ forge: {}, sbom: false }] } };",
    });
    expect(await found(root)).toEqual([["WSP162", "security-sbom-disabled", "app"]]);
  });

  test("supply-chain reports an unsourced SBOM, missing component steps and a publish without provenance", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["supply-chain"] }),
      "app/chant.config.ts": "export default { release: { publish: [{ forge: {} }] } };",
      "app/src/api.component.ts": "export const api = component({ deploy: [shell({ cmd: 'x' })] });",
      ".github/workflows/publish.yml": "      - run: chant release publish v1\n",
    });
    expect((await found(root)).map((f) => f[1]).sort()).toEqual(["security-component-no-sbom", "security-component-no-verify", "security-publish-no-provenance", "security-sbom-unsourced"]);
  });

  test("a Cargo.lock above the member is an SBOM source", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["supply-chain"] }),
      "Cargo.lock": "version = 4\n",
      "app/chant.config.ts": "export default { release: { publish: [{ forge: {} }] } };",
    });
    expect(await found(root)).toEqual([]);
  });

  test("who-ran-it reports signedSince, the runner key and an unsigned tick", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["who-ran-it"], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"] } } }),
      ".github/workflows/chant-ci-green.yml": "        run: npx --yes @intentius/chant@1 ci tick\n",
      "app/x": "",
    });
    expect((await found(root)).map((f) => f[1]).sort()).toEqual(["security-runner-untrusted", "security-signed-since-unset", "security-tick-no-key"]);
  });

  test("who-ran-it passes with signedSince, a trusted runner and a keyed tick", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["who-ran-it"], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], signedSince: "abc1234" } } }),
      ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "chant-runner:box", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl", class: "runner" }] }),
      ".github/workflows/chant-ci-green.yml": "        env:\n          CHANT_RUNNER_KEY: ${{ secrets.K }}\n        run: npx chant ci tick\n",
      "app/x": "",
    });
    expect(await found(root)).toEqual([]);
  });

  test("review-rules reports --no-require-review, attribution and an unsigned gate", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["review-rules"] }),
      ".github/workflows/pr.yml": "      - run: chant components pr-apply --base \"$BASE_SHA\" --env prod --gate deploy --forge github --no-require-review\n",
      "app/x": "",
    });
    expect(await found(root)).toEqual([
      ["WSP164", "security-review-not-required", null],
      ["WSP164", "security-attribution-any", null],
      ["WSP164", "security-gate-unsigned", null],
    ]);
  });

  test("review-rules passes with identified attribution and the apply gate signed", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["review-rules"], identity: { attribution: "identified", gates: { deploy: { class: "person" } } } }),
      ".github/workflows/pr.yml": "      - run: chant components pr-apply --base \"$BASE_SHA\" --env prod --gate deploy --forge github\n",
      "app/x": "",
    });
    expect(await found(root)).toEqual([]);
  });

  test("isolated-runners reports a missing runner key, then a runner without the runner role, then passes", async () => {
    const files = { "chant.workspace.json": declaration({ security: ["isolated-runners"] }), "app/x": "" };
    expect(await found(repo(files))).toEqual([["WSP165", "security-runner-start-no-key", null]]);
    const runner = { principal: "chant-runner:box", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl", class: "runner" };
    expect(await found(repo({ ...files, ".chant/trust.json": JSON.stringify({ schema: 1, runners: [runner] }) }))).toEqual([["WSP165", "security-runner-start-no-role", null]]);
    expect(await found(repo({ ...files, ".chant/trust.json": JSON.stringify({ schema: 1, runners: [runner], roles: { runner: ["chant-runner:box"] } }) }))).toEqual([]);
  });

  test("isolated-runners reports a trust.json that does not read", async () => {
    expect(await found(repo({ "chant.workspace.json": declaration({ security: ["isolated-runners"] }), ".chant/trust.json": "{", "app/x": "" }))).toEqual([["WSP165", "security-trust-unreadable", null]]);
  });
});
