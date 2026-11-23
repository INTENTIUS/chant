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

  test("supply-chain reports a release image whose FROM is not pinned by digest, and passes it once pinned (#5457)", async () => {
    const config = 'export default { release: { images: [{ name: "app", dockerfile: "docker/Dockerfile" }] } };';
    const unpinned = repo({ "chant.workspace.json": declaration({ security: ["supply-chain"] }), "app/chant.config.ts": config, "app/docker/Dockerfile": "FROM node:22\nRUN true\n" });
    expect(await found(unpinned)).toEqual([["WSP162", "security-image-base-unpinned", "app"]]);
    const pinned = repo({ "chant.workspace.json": declaration({ security: ["supply-chain"] }), "app/chant.config.ts": config, "app/docker/Dockerfile": `FROM node:22@sha256:${"b".repeat(64)} AS build\nFROM build\n` });
    expect(await found(pinned)).toEqual([]);
    // Without the group nothing is checked.
    expect(await found(repo({ "chant.workspace.json": declaration(), "app/chant.config.ts": config, "app/docker/Dockerfile": "FROM node:22\n" }))).toEqual([]);
  });

  test("supply-chain reads a root project's release images when no member holds the root", async () => {
    const config = 'export default { rootOnly: true, release: { images: [{ name: "app", dockerfile: "Dockerfile" }] } };';
    const unpinned = repo({ "chant.workspace.json": declaration({ security: ["supply-chain"] }, []), "chant.config.ts": config, Dockerfile: "FROM alpine:3.22\n" });
    expect(await found(unpinned)).toEqual([["WSP162", "security-image-base-unpinned", null]]);
    const pinned = repo({ "chant.workspace.json": declaration({ security: ["supply-chain"] }, []), "chant.config.ts": config, Dockerfile: `FROM alpine:3.22@sha256:${"c".repeat(64)}\n` });
    expect(await found(pinned)).toEqual([]);
  });

  test("a Cargo.lock above the member is an SBOM source", async () => {
    const root = repo({
      "chant.workspace.json": declaration({ security: ["supply-chain"] }),
      "Cargo.lock": "version = 4\n",
      "app/chant.config.ts": "export default { release: { publish: [{ forge: {} }] } };",
    });
    expect(await found(root)).toEqual([]);
  });

  test("a lockfile is no SBOM source for an npm package, which must carry its own (#5518)", async () => {
    const npm = 'export default { release: { publish: [{ type: "npm", packages: ["."] }] } };';
    const base = { "chant.workspace.json": declaration({ security: ["supply-chain"] }), "package-lock.json": "{}", "app/chant.config.ts": npm, "app/package.json": '{ "name": "@acme/app", "version": "1.0.0" }' };
    const bare = repo(base);
    const all = (await runDeclarationChecks(bare, (f) => f, { gather: false })).diagnostics.filter((d) => d.code === "security-sbom-unsourced");
    expect(all.map((d) => [d.ruleId, d.entity])).toEqual([["WSP162", "app"]]);
    expect(all[0]!.message).toContain("publishes the npm package ., which holds none of sbom.spdx.json, sbom.cdx.json, sbom.cyclonedx.json at the root");
    // Carrying one passes, and so does naming the file the build writes.
    expect(await found(repo({ ...base, "app/sbom.spdx.json": "{}" }))).toEqual([]);
    expect(await found(repo({ ...base, "app/chant.config.ts": 'export default { release: { publish: [{ type: "npm", packages: ["."], sbom: "sbom.spdx.json" }] } };' }))).toEqual([]);
    // A private package is the publish's to refuse, and a forge target still takes the lockfile.
    expect(await found(repo({ ...base, "app/package.json": '{ "name": "@acme/app", "private": true }' }))).toEqual([]);
    expect(await found(repo({ ...base, "app/chant.config.ts": "export default { release: { publish: [{ forge: {} }] } };" }))).toEqual([]);
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
    const trust = JSON.stringify({ schema: 1, runners: [{ principal: "chant-runner:box", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl", class: "runner" }] });
    const tick = "        env:\n          CHANT_RUNNER_KEY: ${{ secrets.K }}\n        run: npx chant ci tick\n";
    // signedSince must name a commit in the clone, or the declaration does not read and no security check runs.
    const root = repo({ ".chant/trust.json": trust, ".github/workflows/chant-ci-green.yml": tick, "app/x": "" });
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "first"], { cwd: root, env });
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    const green = { branch: "main", phases: { test: ["test"] }, require: ["test"] };
    writeFileSync(join(root, "chant.workspace.json"), declaration({ security: ["who-ran-it"], ci: { green: { ...green, signedSince: first } } }));
    const all = (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics;
    expect(all.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);
    expect(await found(root)).toEqual([]);
    // The same tree without signedSince is reported, so the check ran on the declaration above.
    writeFileSync(join(root, "chant.workspace.json"), declaration({ security: ["who-ran-it"], ci: { green } }));
    expect((await found(root)).map((f) => f[1])).toEqual(["security-signed-since-unset"]);
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
