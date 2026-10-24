/**
 * Evidence that cites an ops result (#3171): a run on the Op run ledger, a
 * deploy on an environment's release ledger, a gate answer on a gate ledger,
 * or a release plan in `_plans/`. `attachWorkEvidence` resolves the citation
 * here before it writes anything, so a criterion is only ticked by a record
 * the `chant/lifecycle` branch really holds.
 *
 * The citation names the record the way `chant workspace graph --intent`'s
 * `trace` names its links (#4023): `ref` is the ledger file on the branch,
 * `field` and `value` are what picks the record out of it, and `sha256` is
 * the hash of the record as stored, a ledger line or a plan file. A citation
 * that comes with a `sha256` is refused when the record no longer hashes to
 * it.
 *
 * A run says what it showed: an `ok` run is passing evidence and a `fail`
 * run failing evidence, and the result given must agree. A run that is
 * still gated or waiting has no outcome yet and is refused. A deploy, a gate
 * answer and a plan show what they record; whether that meets the criterion
 * is the citer's `result`.
 *
 * Everything is read from the local `chant/lifecycle` branch. Nothing is
 * fetched, the stance `graph --intent` takes.
 */

import { createHash } from "node:crypto";
import { ledgerDir, readBlobFromPath } from "../lifecycle/git";
import type { EvidenceResult } from "./work";

/** The ledgers evidence can cite. */
export const OPS_EVIDENCE_LEDGERS = ["run", "deploy", "gate", "plan"] as const;
export type OpsEvidenceLedger = (typeof OPS_EVIDENCE_LEDGERS)[number];

/** What a caller cites: which record, in which ledger, and optionally the hash it expects. */
export type OpsCitation = {
  /** The workspace member whose ledger holds the record, when it is not the flat layout. */
  member?: string;
  /** The hash of the record as stored, when the caller already has it. */
  sha256?: string;
} & (
  | { ledger: "run"; env: string; op: string; id: string }
  | { ledger: "deploy"; env: string; runId: string; component?: string }
  | { ledger: "gate"; op: string; gate: string; at: string }
  | { ledger: "plan"; digest: string }
);

/** The citation as the evidence entry stores it, once it resolved. */
export interface OpsEvidence {
  ledger: OpsEvidenceLedger;
  /** The ledger file, as `chant/lifecycle:<path>`. */
  ref: string;
  /** The field of the record that picked it out, and its value. */
  field: string;
  value: string;
  /** Hex SHA-256 of the record as stored. */
  sha256: string;
  /** The environment, for a run or a deploy. */
  env?: string;
  /** The run's status, for a run. */
  outcome?: string;
}

export type OpsCitationError = { code: "write-input-invalid" | "work-evidence-ops-missing" | "work-evidence-ops-mismatch" | "work-evidence-ops-unfinished"; message: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function lines(text: string): { line: string; rec: Record<string, unknown> }[] {
  const out: { line: string; rec: Record<string, unknown> }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) out.push({ line, rec: rec as Record<string, unknown> });
    } catch {
      // A malformed line is skipped, as every ledger reader skips it.
    }
  }
  return out;
}

/** Check a citation's shape, before anything is read. Returns the message for a bad one. */
export function opsCitationProblem(cite: unknown): string | null {
  if (cite === null || typeof cite !== "object" || Array.isArray(cite)) return "ops is an object naming a ledger";
  const c = cite as Record<string, unknown>;
  const str = (k: string) => typeof c[k] === "string" && (c[k] as string) !== "";
  const name = (k: string) => typeof c[k] === "string" && NAME.test(c[k] as string);
  if (!(OPS_EVIDENCE_LEDGERS as readonly string[]).includes(c.ledger as string)) return `ops.ledger is one of ${OPS_EVIDENCE_LEDGERS.join(", ")}, not ${JSON.stringify(c.ledger)}`;
  if (c.member !== undefined && !name("member")) return "ops.member is a member name";
  if (c.sha256 !== undefined && !(typeof c.sha256 === "string" && HEX64.test(c.sha256))) return "ops.sha256 is a hex SHA-256";
  const allowed: Record<OpsEvidenceLedger, { names: string[]; strings: string[]; optional: string[] }> = {
    run: { names: ["env", "op"], strings: ["id"], optional: [] },
    deploy: { names: ["env"], strings: ["runId"], optional: ["component"] },
    gate: { names: ["op"], strings: ["gate", "at"], optional: [] },
    plan: { names: [], strings: ["digest"], optional: [] },
  };
  const spec = allowed[c.ledger as OpsEvidenceLedger];
  for (const k of spec.names) if (!name(k)) return `a ${c.ledger} citation names ops.${k}`;
  for (const k of spec.strings) if (!str(k)) return `a ${c.ledger} citation names ops.${k}`;
  for (const k of spec.optional) if (c[k] !== undefined && !str(k)) return `ops.${k} is a string`;
  const known = new Set(["ledger", "member", "sha256", ...spec.names, ...spec.strings, ...spec.optional]);
  const extra = Object.keys(c).filter((k) => !known.has(k));
  if (extra.length > 0) return `a ${c.ledger} citation takes ${[...known].join(", ")}, not ${extra.join(", ")}`;
  if (c.ledger === "plan" && /[/\\]/.test(c.digest as string)) return "ops.digest is a plan digest, not a path";
  return null;
}

/**
 * Find the cited record on the local `chant/lifecycle` branch and check it
 * against the citation and the result given. Never throws for a refusal.
 */
export async function resolveOpsCitation(cite: OpsCitation, result: EvidenceResult, cwd: string): Promise<{ ops: OpsEvidence } | { error: OpsCitationError }> {
  const problem = opsCitationProblem(cite);
  if (problem) return { error: { code: "write-input-invalid", message: problem } };
  const loc = { cwd, ...(cite.member !== undefined ? { member: cite.member } : {}) };
  const missing = (what: string): { error: OpsCitationError } => ({ error: { code: "work-evidence-ops-missing", message: `the local chant/lifecycle branch has no ${what}` } });

  let found: { dir: string; file: string; text: string; field: string; value: string; env?: string; outcome?: string };
  switch (cite.ledger) {
    case "run": {
      const file = `runs__${cite.op}.jsonl`;
      const content = await readBlobFromPath(cite.env, file, loc);
      const hit = content === null ? undefined : lines(content).find((l) => l.rec.id === cite.id);
      if (!hit) return missing(`run ${cite.id} of ${cite.op} in ${cite.env}`);
      const status = String(hit.rec.status);
      if (status !== "ok" && status !== "fail") {
        return { error: { code: "work-evidence-ops-unfinished", message: `run ${cite.id} of ${cite.op} is ${status}: it has no outcome yet to cite` } };
      }
      const shows: EvidenceResult = status === "ok" ? "pass" : "fail";
      if (shows !== result) {
        return { error: { code: "work-evidence-ops-mismatch", message: `run ${cite.id} of ${cite.op} in ${cite.env} ended ${status}, so it is ${shows} evidence, not ${result}` } };
      }
      found = { dir: cite.env, file, text: hit.line, field: "id", value: cite.id, env: cite.env, outcome: status };
      break;
    }
    case "deploy": {
      const file = "releases.jsonl";
      const content = await readBlobFromPath(cite.env, file, loc);
      const hits = content === null ? [] : lines(content).filter((l) => l.rec.runId === cite.runId && (cite.component === undefined || l.rec.component === cite.component));
      if (hits.length === 0) return missing(`deploy by run ${cite.runId}${cite.component ? ` of ${cite.component}` : ""} in ${cite.env}`);
      if (hits.length > 1) {
        return { error: { code: "write-input-invalid", message: `run ${cite.runId} deployed ${hits.length} components in ${cite.env}: name the one cited in ops.component` } };
      }
      found = { dir: cite.env, file, text: hits[0].line, field: "runId", value: cite.runId, env: cite.env };
      break;
    }
    case "gate": {
      const file = `${cite.op}.jsonl`;
      const content = await readBlobFromPath("_gates", file, loc);
      const hit = content === null ? undefined : lines(content).find((l) => (l.rec.kind ?? "resolution") === "resolution" && l.rec.gate === cite.gate && l.rec.timestamp === cite.at);
      if (!hit) return missing(`answer to gate ${cite.gate} of ${cite.op} at ${cite.at}`);
      found = { dir: "_gates", file, text: hit.line, field: "timestamp", value: cite.at };
      break;
    }
    case "plan": {
      const file = `${cite.digest.replace(/:/g, "_")}.json`;
      const content = await readBlobFromPath("_plans", file, loc);
      if (content === null) return missing(`release plan ${cite.digest}`);
      let digest: unknown;
      try {
        digest = (JSON.parse(content) as { digest?: unknown }).digest;
      } catch {
        digest = undefined;
      }
      if (digest !== cite.digest) return { error: { code: "work-evidence-ops-mismatch", message: `the plan stored for ${cite.digest} names another digest` } };
      found = { dir: "_plans", file, text: content, field: "digest", value: cite.digest };
      break;
    }
  }

  const hash = sha256(found.text);
  if (cite.sha256 !== undefined && cite.sha256 !== hash) {
    return { error: { code: "work-evidence-ops-mismatch", message: `the ${cite.ledger} record cited hashes to ${hash}, not the ${cite.sha256} given: it is another record` } };
  }
  const ref = `chant/lifecycle:${await ledgerDir(found.dir, loc)}/${found.file}`;
  return {
    ops: {
      ledger: cite.ledger,
      ref,
      field: found.field,
      value: found.value,
      sha256: hash,
      ...(found.env !== undefined ? { env: found.env } : {}),
      ...(found.outcome !== undefined ? { outcome: found.outcome } : {}),
    },
  };
}
