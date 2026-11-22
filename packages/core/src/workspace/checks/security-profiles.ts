/**
 * The security profile checks, WSP166 (`fedramp-moderate`) and WSP167
 * (`cccs-medium`) (#5464).
 *
 * A profile named in the declaration's top-level `security` turns on every
 * group, so WSP161 to WSP165 report what the groups lack. These checks report
 * what the profile looks for beyond them ({@link PROFILE_CHECKS}). Each
 * finding ends with the control ids it bears on in the profile's baseline:
 * the records it asks for produce evidence toward those controls, and an
 * assessor decides whether a control is met.
 *
 * | Code | Reads |
 * |---|---|
 * | `profile-retention-short` | the declaration's `retention` |
 * | `profile-gate-not-human` | `identity.gates`, the gates the pipeline files' apply lines name, and the role grants in `.chant/trust.json` |
 * | `profile-scan-off`, `profile-scan-db-unbounded` | each member's `chant.config.ts`, as text |
 * | `profile-signing-off`, `profile-signing-module` | each member's `chant.config.ts`, as text |
 * | `profile-runner-key-eddsa` | the `runners` and `local.keys` lines of `.chant/trust.json` |
 *
 * Whether the forge protects `chant/lifecycle` (AU-9) is a forge setting,
 * which `chant release doctor` reads as `lifecycle-protected` under either
 * profile, since a profile turns on `verified-releases` and `who-ran-it`.
 */

import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import type { Declaration, SignedGate } from "../declaration";
import { DEFAULT_RETENTION } from "../../lifecycle/retention-policy";
import { CORE_PRINCIPAL_CLASSES } from "../identity-gate-rule";
import { PROFILE_CHECKS, PROFILE_SPECS, profileControls, type SecurityProfile } from "../security-profiles";
import { joinPath } from "../tree";
import { TRUST_CONFIG_PATH } from "../trust/trust-files";
import type { TrustPolicy } from "../trust/policy";
import { commandLines, memberDir, PR_APPLY, read, treePolicy } from "./security";

export const WSP_PROFILE_FEDRAMP_MODERATE = "WSP166";
export const WSP_PROFILE_CCCS_MEDIUM = "WSP167";

type ProfileCode = (typeof PROFILE_CHECKS)[number]["code"];

/** The principals that are not people: those the trust file grants the agent, runner or service role, the runner keys' principals, and the declaration's agent sessions. */
function nonPeople(policy: TrustPolicy, declaration: Declaration): Set<string> {
  const out = new Set<string>();
  for (const role of CORE_PRINCIPAL_CLASSES) if (role !== "human") for (const p of policy.roles[role] ?? []) out.add(p);
  for (const r of policy.runners) out.add(r.principal);
  for (const a of declaration.agents ?? []) for (const p of a.principals) out.add(p);
  return out;
}

/**
 * Why `gate` does not hold its approvals to people, or null when it does:
 * `human`, or a domain class whose role no agent, runner or service
 * principal holds.
 */
function notHuman(ctx: WorkspaceCheckContext, gate: SignedGate, policy: TrustPolicy, others: Set<string>): string | null {
  if (gate.agentPassesAlone === true) return `identity.gates.${gate.gate} sets agentPassesAlone, so an agent's permit passes it with no person approving`;
  if (gate.class === null) return `identity.gates.${gate.gate} names no class, so any signer may approve it`;
  if (gate.class === "human") return null;
  if ((CORE_PRINCIPAL_CLASSES as readonly string[]).includes(gate.class)) return `identity.gates.${gate.gate} names the ${gate.class} class, which is not people`;
  const cls = ctx.classes?.get(gate.class);
  if (!cls?.role) return `identity.gates.${gate.gate} names the class ${gate.class}, which no pinned package supplies, so who holds it can't be read`;
  const held = (policy.roles[cls.role] ?? []).filter((p) => others.has(p));
  if (held.length > 0) return `identity.gates.${gate.gate} names the class ${gate.class}, whose role ${cls.role} ${TRUST_CONFIG_PATH} grants to ${held.join(", ")}, which ${held.length > 1 ? "are" : "is"} not people`;
  return null;
}

/** The directories whose `chant.config.ts` a profile reads: the workspace root's and each member's. */
function configDirs(declaration: Declaration): Array<{ dir: string; member: string | null }> {
  const out = new Map<string, string | null>([["", null]]);
  for (const m of declaration.members) out.set(memberDir(m.dir), m.name);
  return [...out].map(([dir, member]) => ({ dir, member }));
}

/** The 1-based line of the first match of `re` in `text`, or 1. */
function lineOf(text: string, re: RegExp): number {
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : 1;
}

function profileCheck(id: string, profile: SecurityProfile): WorkspaceCheck {
  const spec = PROFILE_SPECS[profile];
  const controls = (code: ProfileCode) => profileControls(profile, PROFILE_CHECKS.find((c) => c.code === code)!.controls);
  return {
    id,
    name: `security-profile-${profile}`,
    description: `Under the ${profile} security profile: retention of at least ${spec.retentionDays} days, release and apply gates held to people, the release scan on with a database no older than ${spec.scanDbMaxAgeHours} hours, signing on in a crypto module the team names, and ECDSA P-256 runner keys. Each finding names the ${spec.baseline} controls it produces evidence toward.`,
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      const at = d.security.indexOf(profile);
      if (at < 0) return [];
      const pointer = `/security/${at}`;
      const out: WorkspaceDiagnostic[] = [];
      const push = (code: ProfileCode, message: string, where: { pointer?: string; entity?: string; treeFile?: string; line?: number } = {}) => {
        const ids = controls(code);
        if (ids.length === 0) return;
        out.push({
          checkId: this.id,
          severity: this.severity,
          code,
          message: `${code}: under ${profile}, ${message} [${ids.join(", ")}]`,
          pointer: where.pointer ?? pointer,
          ...(where.entity !== undefined ? { entity: where.entity } : {}),
          ...(where.treeFile !== undefined ? { treeFile: where.treeFile, line: where.line ?? 1, column: 1 } : {}),
        });
      };

      // AU-11: the declaration says the days gc keeps.
      for (const kind of ["changeSets", "releases"] as const) {
        const days = d.retention?.[kind]?.days;
        if (days !== undefined && days >= spec.retentionDays) continue;
        const said = days === undefined ? `retention.${kind}.days is unset (the default is ${DEFAULT_RETENTION[kind].days})` : `retention.${kind}.days is ${days}`;
        push("profile-retention-short", `${said}; chant lifecycle gc keeps them ${spec.retentionDays} days under the profile, so set ${spec.retentionDays} or more for the declaration to say what is kept`, { pointer: d.retention ? "/retention" : pointer });
      }

      // AC-5, CM-3(4): the release gate and every gate an apply job names take approvals from people.
      const policy = treePolicy(ctx.tree);
      const others = nonPeople(policy, d);
      const gates = d.identity?.gates ?? {};
      const applied = new Set(commandLines(ctx, PR_APPLY).flatMap((l) => [...l.text.matchAll(/--(?:wave-)?gate\s+["']?([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!)));
      for (const name of ["release", ...[...applied].filter((g) => g !== "release").sort()]) {
        const gate = gates[name];
        const what = name === "release" ? "the release gate" : `the gate ${name}, which an apply job waits on,`;
        if (!gate) {
          push("profile-gate-not-human", `${what} has no identity.gates entry, so nothing holds its approvals to people; set identity.gates.${name} with class "human"`, { pointer: d.identity ? "/identity" : pointer });
          continue;
        }
        const why = notHuman(ctx, gate, policy, others);
        if (why) push("profile-gate-not-human", why, { pointer: gate.pointer });
      }

      // RA-5, RA-5(2), SI-7, SA-10(1), SR-11, SC-13: each release config, read as text.
      for (const { dir, member } of configDirs(d)) {
        const path = joinPath(dir, "chant.config.ts");
        const config = read(ctx.tree, path);
        if (config === null || !/\bpublish\s*:/.test(config)) continue;
        const where = { ...(member !== null ? { entity: member } : {}), treeFile: path };
        const who = member !== null ? `member ${member}'s chant.config.ts` : "the workspace root's chant.config.ts";
        if (/\bscan\s*:\s*false\b/.test(config)) {
          push("profile-scan-off", `${who} sets release.scan: false, so what it publishes is not scanned for known vulnerabilities`, { ...where, line: lineOf(config, /\bscan\s*:\s*false\b/) });
        } else {
          const hours = /\bdbMaxAgeHours\s*:\s*(\d+(?:\.\d+)?)/.exec(config);
          if (/\bdb\s*:\s*["'`]/.test(config) && !hours) {
            push("profile-scan-db-unbounded", `${who} names release.scan.db and no dbMaxAgeHours; a publish refuses a database older than ${spec.scanDbMaxAgeHours} hours under the profile, so set dbMaxAgeHours to ${spec.scanDbMaxAgeHours} or less for the config to say so`, { ...where, line: lineOf(config, /\bdb\s*:\s*["'`]/) });
          } else if (hours && Number(hours[1]) > spec.scanDbMaxAgeHours) {
            push("profile-scan-db-unbounded", `${who} sets release.scan.dbMaxAgeHours to ${hours[1]}, and the profile takes a database no older than ${spec.scanDbMaxAgeHours} hours, which a publish holds it to`, { ...where, line: lineOf(config, /\bdbMaxAgeHours\s*:/) });
          }
        }
        if (/\bsigning\s*:\s*false\b/.test(config)) {
          push("profile-signing-off", `${who} sets release.signing: false, so its images and forge assets carry no Sigstore signature or SLSA statement`, { ...where, line: lineOf(config, /\bsigning\s*:\s*false\b/) });
        } else if (/\btype\s*:\s*["'`](?:oci|forge)["'`]/.test(config) && !/\bkms\s*:\s*["'`]/.test(config) && !/\bCHANT_COSIGN\b/.test(config)) {
          const mode = /\bkey\s*:\s*["'`]/.test(config) ? "with a cosign key" : "keylessly";
          push("profile-signing-module", `${who} signs ${mode} with the upstream cosign build, which is not a FIPS build; sign with release.signing.kms, whose KMS makes the signature, or name a cosign build in CHANT_COSIGN in the release config`, { ...where, line: lineOf(config, /\bsigning\s*:|\btype\s*:\s*["'`](?:oci|forge)/) });
        }
      }

      // SC-13: runner and local evidence keys are ECDSA P-256.
      const eddsa = [...policy.runners.map((r) => ({ principal: r.principal, key: r.key, under: "runners" })), ...(policy.local?.keys ?? []).map((k) => ({ principal: k.principal, key: k.key, under: "local.keys" }))].filter((k) => k.key.startsWith("ssh-ed25519 "));
      for (const k of eddsa) {
        push("profile-runner-key-eddsa", `${TRUST_CONFIG_PATH}${ctx.tree.label} lists an Ed25519 key for ${k.principal} under ${k.under}; the validated OpenSSL FIPS providers list EdDSA as non-approved, so make an ECDSA P-256 key with chant ci serve --setup-key --key-type ecdsa-p256 and list it beside or in place of this one`);
      }
      return out;
    },
  };
}

export const PROFILE_CHECKS_WSP: readonly WorkspaceCheck[] = [profileCheck(WSP_PROFILE_FEDRAMP_MODERATE, "fedramp-moderate"), profileCheck(WSP_PROFILE_CCCS_MEDIUM, "cccs-medium")];
