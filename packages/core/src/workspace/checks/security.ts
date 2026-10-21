/**
 * The security group checklists, WSP161 to WSP165 (#4168 step 7).
 *
 * A workspace opts into a security group with `security` in the
 * declaration, at the top level or on a member (../security.ts). Each group
 * has one check here, which reports what the group still lacks in the tree
 * read. A group the declaration does not name is never checked, so a
 * workspace that opts into nothing gets no finding from this file (#4168:
 * security features are opt-in).
 *
 * | Id | Group | Codes |
 * |---|---|---|
 * | WSP161 | `verified-releases` | `security-signers-missing`, `security-release-gate-missing`, `security-publish-allows-unsigned` |
 * | WSP162 | `supply-chain` | `security-sbom-disabled`, `security-sbom-unsourced`, `security-publish-no-provenance`, `security-component-no-sbom`, `security-component-no-verify` |
 * | WSP163 | `who-ran-it` | `security-signed-since-unset`, `security-runner-untrusted`, `security-tick-no-key` |
 * | WSP164 | `review-rules` | `security-review-not-required`, `security-attribution-any`, `security-gate-unsigned` |
 * | WSP165 | `isolated-runners` | `security-runner-start-no-key`, `security-runner-start-no-role`, `security-trust-unreadable` |
 *
 * The checks read files, never run them: a member's `chant.config.ts` and
 * `*.component.ts` are scanned as text, and the pipeline files are the
 * forge files at the workspace root and in each member (`.github/workflows`,
 * `.forgejo/workflows`, `.gitlab-ci.yml`). A command line is one line of a
 * pipeline file that runs `chant release publish`, `chant ci tick` or
 * `chant components pr-apply`.
 */

import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import type { Declaration, Member } from "../declaration";
import type { ReasonCode } from "../reason-codes";
import { securityGroupsOf, type SecurityGroup } from "../security";
import { joinPath, type WorkspaceTree } from "../tree";
import { runnerStartReadiness } from "../ci-runner-start";
import type { RecordSource } from "../record-source";
import { readTrustPolicy, type TrustPolicy } from "../trust/policy";
import { DEFAULT_SIGNERS_PATH, TRUST_CONFIG_PATH } from "../trust/trust-files";

/** The read contract's codes for the security findings, carried as `code` on each. */
export const SECURITY_FINDING_CODES = [
  "security-signers-missing",
  "security-release-gate-missing",
  "security-publish-allows-unsigned",
  "security-sbom-disabled",
  "security-sbom-unsourced",
  "security-publish-no-provenance",
  "security-component-no-sbom",
  "security-component-no-verify",
  "security-signed-since-unset",
  "security-runner-untrusted",
  "security-tick-no-key",
  "security-review-not-required",
  "security-attribution-any",
  "security-gate-unsigned",
  "security-runner-start-no-key",
  "security-runner-start-no-role",
  "security-trust-unreadable",
] as const satisfies readonly ReasonCode[];

type SecurityCode = (typeof SECURITY_FINDING_CODES)[number];

export const WSP_SECURITY_VERIFIED_RELEASES = "WSP161";
export const WSP_SECURITY_SUPPLY_CHAIN = "WSP162";
export const WSP_SECURITY_WHO_RAN_IT = "WSP163";
export const WSP_SECURITY_REVIEW_RULES = "WSP164";
export const WSP_SECURITY_ISOLATED_RUNNERS = "WSP165";

const memberDir = (dir: string) => (dir === "." ? "" : dir);

/** The members under `group`: every member when the top level names it, else those that name it themselves. */
function membersUnder(declaration: Declaration, group: SecurityGroup): Member[] {
  return declaration.members.filter((m) => securityGroupsOf(declaration, m.name).has(group));
}

/** Whether the declaration names `group` anywhere. */
function declares(declaration: Declaration, group: SecurityGroup): boolean {
  return declaration.security.includes(group) || declaration.members.some((m) => m.security.includes(group));
}

/** Where the group is named, for the finding's pointer: the top level, else the first member naming it. */
function groupPointer(declaration: Declaration, group: SecurityGroup): string {
  const top = declaration.security.indexOf(group);
  if (top >= 0) return `/security/${top}`;
  const m = declaration.members.find((e) => e.security.includes(group));
  return m ? `${m.pointer}/security/${m.security.indexOf(group)}` : "/security";
}

export function read(tree: WorkspaceTree, path: string): string | null {
  if (tree.stat(path) !== "file") return null;
  try {
    return tree.read(path);
  } catch {
    return null;
  }
}

/** The forge pipeline files under `dir`, each as its path and lines. */
function pipelineFiles(tree: WorkspaceTree, dir: string): { path: string; lines: string[] }[] {
  const out: { path: string; lines: string[] }[] = [];
  for (const folder of [".github/workflows", ".forgejo/workflows", ".gitea/workflows"]) {
    for (const e of tree.list(joinPath(dir, folder)) ?? []) {
      if (e.type !== "file" || !/\.ya?ml$/.test(e.name)) continue;
      const path = joinPath(dir, folder, e.name);
      const text = read(tree, path);
      if (text !== null) out.push({ path, lines: text.split("\n") });
    }
  }
  const gitlab = read(tree, joinPath(dir, ".gitlab-ci.yml"));
  if (gitlab !== null) out.push({ path: joinPath(dir, ".gitlab-ci.yml"), lines: gitlab.split("\n") });
  return out;
}

/** Every pipeline file of the workspace: its root's, and each member's. */
export function allPipelineFiles(ctx: WorkspaceCheckContext): { path: string; lines: string[] }[] {
  const dirs = new Set(["", ...ctx.declaration.members.map((m) => memberDir(m.dir))]);
  return [...dirs].flatMap((d) => pipelineFiles(ctx.tree, d));
}

/** The lines of the pipeline files that run a chant command, `command` naming it, such as `release publish`. */
export function commandLines(ctx: WorkspaceCheckContext, command: RegExp): { path: string; line: number; text: string }[] {
  return allPipelineFiles(ctx).flatMap((f) => f.lines.flatMap((text, i) => (command.test(text) ? [{ path: f.path, line: i + 1, text }] : [])));
}

/** The member's `*.component.ts` files, walked a few levels down, past node_modules and build output. */
export function componentFiles(tree: WorkspaceTree, dir: string, depth = 4): string[] {
  const out: string[] = [];
  for (const e of tree.list(dir) ?? []) {
    if (e.type === "dir") {
      if (depth > 0 && !["node_modules", "dist", ".git", ".chant", "target"].includes(e.name)) out.push(...componentFiles(tree, joinPath(dir, e.name), depth - 1));
    } else if (e.name.endsWith(".component.ts")) out.push(joinPath(dir, e.name));
  }
  return out;
}

/** Whether a lockfile chant writes an SBOM from is in `dir` or a directory above it in the tree. */
function lockfileAbove(tree: WorkspaceTree, dir: string): boolean {
  let at = dir;
  for (;;) {
    if (["package-lock.json", "pom.xml", "Cargo.lock"].some((f) => tree.stat(joinPath(at, f)) === "file")) return true;
    if (at === "") return false;
    at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  }
}

/** The trust policy in the tree read: `.chant/trust.json` and the signers file it names. */
function treePolicy(tree: WorkspaceTree): TrustPolicy {
  const source: RecordSource = {
    label: tree.label,
    list: (dir) => tree.list(dir)?.filter((e) => e.type === "file").map((e) => e.name),
    read: (path) => tree.read(path),
    bytes: (path) => (tree.bytes ? tree.bytes(path) : new Uint8Array(Buffer.from(tree.read(path), "utf-8"))),
  };
  return readTrustPolicy(source, null);
}

function finding(check: WorkspaceCheck, code: SecurityCode, message: string, at: { pointer: string; entity?: string; treeFile?: string; line?: number }): WorkspaceDiagnostic {
  return {
    checkId: check.id,
    severity: check.severity,
    code,
    message: `${code}: ${message}`,
    pointer: at.pointer,
    ...(at.entity !== undefined ? { entity: at.entity } : {}),
    ...(at.treeFile !== undefined ? { treeFile: at.treeFile, line: at.line ?? 1, column: 1 } : {}),
  };
}

const RELEASE_PUBLISH = /\bchant\b.*\brelease\s+publish\b/;
const CI_TICK = /\bchant\b.*\bci\s+tick\b|main\.ts\s+ci\s+tick\b/;
const PR_APPLY = /\bcomponents\s+pr-apply\b|\bci\s+run\s+apply\b/;

export const SECURITY_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_SECURITY_VERIFIED_RELEASES,
    name: "security-verified-releases",
    description: "Under the verified-releases group: a signers file, a release gate naming a class, and no publish job that passes --allow-unsigned.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      if (!declares(d, "verified-releases")) return [];
      const pointer = groupPointer(d, "verified-releases");
      const out: WorkspaceDiagnostic[] = [];
      if (ctx.tree.stat(DEFAULT_SIGNERS_PATH) !== "file") {
        out.push(finding(this, "security-signers-missing", `the workspace opts into verified-releases, and there is no ${DEFAULT_SIGNERS_PATH}${ctx.tree.label} to verify a release's signature against; add the keys of the people who cut releases to it, in ssh-keygen's allowed_signers format`, { pointer }));
      }
      const gate = d.identity?.gates.release;
      if (!gate?.class) {
        out.push(finding(this, "security-release-gate-missing", gate ? `identity.gates.release names no class, so any signer in ${DEFAULT_SIGNERS_PATH} may cut a release; name the class that may` : "the workspace opts into verified-releases, and identity.gates has no release entry, so a cut is not held to a class of signers", { pointer: gate?.pointer ?? pointer }));
      }
      for (const l of commandLines(ctx, RELEASE_PUBLISH)) {
        if (!/--allow-unsigned\b/.test(l.text)) continue;
        out.push(finding(this, "security-publish-allows-unsigned", `${l.path} runs release publish with --allow-unsigned, which publishes a release whose signature does not verify`, { pointer, treeFile: l.path, line: l.line }));
      }
      return out;
    },
  },
  {
    id: WSP_SECURITY_SUPPLY_CHAIN,
    name: "security-supply-chain",
    description: "Under the supply-chain group: every publish target attaches an SBOM it has a source for, publish jobs require OIDC provenance, and components generate an SBOM and verify what they deploy.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      if (!declares(d, "supply-chain")) return [];
      const pointer = groupPointer(d, "supply-chain");
      const out: WorkspaceDiagnostic[] = [];
      for (const m of membersUnder(d, "supply-chain")) {
        const configPath = joinPath(memberDir(m.dir), "chant.config.ts");
        const config = read(ctx.tree, configPath);
        if (config !== null && /\bpublish\s*:/.test(config)) {
          const lines = config.split("\n");
          const off = lines.findIndex((l) => /\bsbom\s*:\s*false\b/.test(l));
          if (off >= 0) out.push(finding(this, "security-sbom-disabled", `member ${m.name}'s chant.config.ts sets sbom: false on a publish target, so what it publishes carries no SBOM`, { pointer, entity: m.name, treeFile: configPath, line: off + 1 }));
          else if (!/\bsbom\s*:\s*["'`]/.test(config) && !lockfileAbove(ctx.tree, memberDir(m.dir))) {
            out.push(finding(this, "security-sbom-unsourced", `member ${m.name} publishes, names no sbom file and has no package-lock.json, pom.xml or Cargo.lock in its directory or above it, so publish would refuse it as publish-sbom-missing`, { pointer, entity: m.name, treeFile: configPath }));
          }
        }
        const components = componentFiles(ctx.tree, memberDir(m.dir));
        if (components.length === 0) continue;
        const text = components.map((f) => read(ctx.tree, f) ?? "").join("\n");
        if (!/\bgenerateSbom\s*\(|["']generate-sbom["']/.test(text)) {
          out.push(finding(this, "security-component-no-sbom", `member ${m.name}'s components have no generate-sbom step, so what they build carries no SBOM`, { pointer, entity: m.name, treeFile: components[0] }));
        }
        if (!/\bverify\s*\(|["']verify["']/.test(text)) {
          out.push(finding(this, "security-component-no-verify", `member ${m.name}'s components have no verify step, so a signature or attestation is never checked before a deploy`, { pointer, entity: m.name, treeFile: components[0] }));
        }
      }
      for (const l of commandLines(ctx, RELEASE_PUBLISH)) {
        if (/--require-provenance\b/.test(l.text)) continue;
        out.push(finding(this, "security-publish-no-provenance", `${l.path} runs release publish without --require-provenance, so a run with no OIDC token publishes with only a warning`, { pointer, treeFile: l.path, line: l.line }));
      }
      return out;
    },
  },
  {
    id: WSP_SECURITY_WHO_RAN_IT,
    name: "security-who-ran-it",
    description: "Under the who-ran-it group: ci.green.signedSince is set, .chant/trust.json lists a runner key, and the tick signs its tags.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      if (!declares(d, "who-ran-it")) return [];
      const pointer = groupPointer(d, "who-ran-it");
      const out: WorkspaceDiagnostic[] = [];
      if (!d.ci?.green?.signedSince) {
        out.push(finding(this, "security-signed-since-unset", d.ci?.green ? "ci.green sets no signedSince, so an unsigned green tag still counts" : "the workspace opts into who-ran-it, and has no ci.green block, so no commit's green tag is signed", { pointer: d.ci?.green?.pointer ?? pointer }));
      }
      const runners = treePolicy(ctx.tree).runners.filter((r) => r.class === "runner").length;
      if (runners === 0) {
        out.push(finding(this, "security-runner-untrusted", `${TRUST_CONFIG_PATH}${ctx.tree.label} lists no runner key, so no run or tag can be traced to a runner; add one with chant ci serve --setup-key --trust`, { pointer }));
      }
      for (const l of commandLines(ctx, CI_TICK)) {
        const file = allPipelineFiles(ctx).find((f) => f.path === l.path);
        if (/--key\b/.test(l.text) || file?.lines.some((t) => /CHANT_RUNNER_KEY/.test(t))) continue;
        out.push(finding(this, "security-tick-no-key", `${l.path} runs ci tick with no runner key, so its tags are unsigned; regenerate it with chant ci workflow --runner-key-secret <NAME>`, { pointer, treeFile: l.path, line: l.line }));
      }
      return out;
    },
  },
  {
    id: WSP_SECURITY_REVIEW_RULES,
    name: "security-review-rules",
    description: "Under the review-rules group: no apply job turns forge review off, attribution is identified, and every gate an apply job names needs a signed approval.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      if (!declares(d, "review-rules")) return [];
      const pointer = groupPointer(d, "review-rules");
      const out: WorkspaceDiagnostic[] = [];
      const applies = commandLines(ctx, PR_APPLY);
      for (const l of applies) {
        if (!/--no-require-review\b/.test(l.text)) continue;
        out.push(finding(this, "security-review-not-required", `${l.path} passes --no-require-review, which the review-rules group overrides; drop it so the file says what runs`, { pointer, treeFile: l.path, line: l.line }));
      }
      if (d.identity?.attribution !== "identified") {
        out.push(finding(this, "security-attribution-any", "identity.attribution is not identified, so a person-attributed write may name anyone", { pointer: d.identity ? "/identity" : pointer }));
      }
      const signed = new Set(Object.keys(d.identity?.gates ?? {}));
      const named = new Set(applies.flatMap((l) => [...l.text.matchAll(/--(?:wave-)?gate\s+["']?([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!)));
      const unsigned = [...named].filter((g) => !signed.has(g));
      if (unsigned.length > 0) {
        out.push(finding(this, "security-gate-unsigned", `the apply jobs name the gate${unsigned.length > 1 ? "s" : ""} ${unsigned.join(", ")}, which identity.gates does not list, so an unsigned approval passes ${unsigned.length > 1 ? "them" : "it"}`, { pointer }));
      } else if (named.size === 0 && signed.size === 0) {
        out.push(finding(this, "security-gate-unsigned", "identity.gates lists no gate, so every approval may be unsigned", { pointer }));
      }
      return out;
    },
  },
  {
    id: WSP_SECURITY_ISOLATED_RUNNERS,
    name: "security-isolated-runners",
    description: "Under the isolated-runners group: .chant/trust.json lists a runner key whose principal holds the runner role, so an apply job can require a runner-start statement (#4147).",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      if (!declares(d, "isolated-runners")) return [];
      const pointer = groupPointer(d, "isolated-runners");
      const codes = { "no-runner-key": "security-runner-start-no-key", "no-runner-role": "security-runner-start-no-role", "trust-unreadable": "security-trust-unreadable" } as const;
      return runnerStartReadiness(treePolicy(ctx.tree)).gaps.map((g) => finding(this, codes[g.gap], `the workspace opts into isolated-runners, so every apply job requires a runner-start statement, and ${g.reason}`, { pointer }));
    },
  },
];
