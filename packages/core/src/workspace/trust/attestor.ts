/**
 * Attestors and provenance levels (#2524 D5).
 *
 * An attestor answers one question about a commit: does it carry an
 * attestation that the policy read at base accepts? Concrete attestors are
 * plugins. Core ships the contract and the first one, ssh-signed commits
 * (./ssh-commit.ts). Plugin attestors will arrive the way kinds do, through
 * `workspaceKinds` (#2525 rule 5), once the declaration can name them (#2534,
 * #2535); until then {@link registerAttestor} is the entry point.
 *
 * What counts as proof: a signature the attestor checked against a key the
 * base policy lists. Never a trailer, a typed-in name, an author field or an
 * environment variable.
 */

import { UNATTESTED_APPROVER } from "../../lifecycle/gate-origin";
import type { TrustPolicy } from "./policy";

/**
 * How far a record's authorship is established. The list is closed and
 * ordered from strongest to weakest; a gate may require `attested`.
 *
 * - `attested`: an attestor verified a signature by a signer the base policy lists.
 * - `attested-unverifiable-here`: there is a signature, but nothing here can
 *   check it (a signature format no attestor handles, or a missing tool).
 * - `adopted`: not attested, but inside a commit range the base policy admits.
 * - `unattested`: none of the above. The same word, with the same meaning, as
 *   the approver a gate resolution records when its channel cannot attest to a
 *   name (#2384, {@link UNATTESTED_APPROVER}); D5 keeps that meaning.
 */
export const PROVENANCE_LEVELS = ["attested", "attested-unverifiable-here", "adopted", UNATTESTED_APPROVER] as const;
export type ProvenanceLevel = (typeof PROVENANCE_LEVELS)[number];

/** What one attestor says about one commit. */
export interface CommitAttestation {
  level: "attested" | "attested-unverifiable-here" | "unattested";
  /** The attestor that gave this answer. */
  attestor: string;
  /** The principal whose key verified, when `attested`. */
  principal?: string;
  /** The key's fingerprint, when known. */
  key?: string;
  /** Why the level is what it is, in a sentence. */
  reason: string;
}

/** Read access to the repository an attestor checks. */
export interface AttestorContext {
  /** The repository's top directory. */
  repo: string;
  /** The policy read at base. */
  policy: TrustPolicy;
}

/** A commit attestor. Plugins implement this. */
export interface CommitAttestor {
  /** A stable name, such as `ssh-commit`. */
  readonly name: string;
  attestCommit(ctx: AttestorContext, commit: string): CommitAttestation;
}

const registered: CommitAttestor[] = [];

/** Add an attestor. Later registrations are asked after earlier ones. */
export function registerAttestor(attestor: CommitAttestor): void {
  if (!registered.some((a) => a.name === attestor.name)) registered.push(attestor);
}

/** Remove every attestor registered by {@link registerAttestor}. For tests. */
export function resetAttestors(): void {
  registered.length = 0;
}

/**
 * Ask each attestor in turn. The first `attested` answer wins; otherwise
 * `attested-unverifiable-here` beats `unattested`, so a signature nobody here
 * can check is still reported as there.
 */
export function attestCommit(ctx: AttestorContext, commit: string, attestors: readonly CommitAttestor[]): CommitAttestation {
  let best: CommitAttestation | undefined;
  for (const a of attestors) {
    const r = a.attestCommit(ctx, commit);
    if (r.level === "attested") return r;
    if (!best || (best.level === "unattested" && r.level === "attested-unverifiable-here")) best = r;
  }
  return best ?? { level: "unattested", attestor: "none", reason: "no attestor is registered" };
}

/** The attestors in use: the built-in ones first, then any registered. */
export async function activeAttestors(): Promise<CommitAttestor[]> {
  const { sshCommitAttestor } = await import("./ssh-commit");
  return [sshCommitAttestor, ...registered.filter((a) => a.name !== sshCommitAttestor.name)];
}
