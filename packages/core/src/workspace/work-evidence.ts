/**
 * Evidence attached to a work item's acceptance criterion by the run that
 * holds its lease (#2772).
 *
 * A work kind with acceptance criteria (`work.acceptance` in the kind, read in
 * `./work.ts`) lists what done means on the record: each criterion has an id,
 * its text and the verification it expects. Evidence in the kind's pins field
 * meets a criterion when it names it, carries `result: pass` and has the
 * criterion's verification. {@link attachWorkEvidence} appends one such entry
 * for a run under the item's work lease (an Op with `workLease`, #2748, such
 * as a steward's), through `records amend`, so the record is written the way
 * a person's amendment writes it.
 *
 * It writes only for the lease's holder, under the token the run was given:
 * a run whose lease expired or went to someone else is refused, as a renewal
 * would be. It refuses a criterion the record doesn't list, and a `manual`
 * one: the run holding the lease is the item's implementer, and a manual
 * verdict comes from someone else. A person records that verdict with
 * `records amend`, naming themselves in `by`.
 */

import { relative, sep } from "node:path";
import { activeWorkLeases } from "../lifecycle/work-lease";
import type { ReasonCode } from "./reason-codes";
import { pinFile } from "./records-cli";
import { AMEND_ERROR_CODES, amendRecord } from "./records-write";
import { acceptanceCriteria, EVIDENCE_RESULTS, workAcceptance, type EvidenceResult, type VerificationType, type WorkAcceptance } from "./work";
import { findWorkItem, WorkError } from "./work-cli";

/** Why evidence was not attached. Closed. Nothing is written with any of them. */
export const WORK_EVIDENCE_ERROR_CODES = [
  ...AMEND_ERROR_CODES,
  "work-kind-missing",
  "work-kind-ambiguous",
  "work-item-unknown",
  "work-item-closed",
  "work-criterion-unknown",
  "work-acceptance-self-verified",
  "lease-held",
  "lease-not-held",
  "lease-token-mismatch",
  "not-a-git-repository",
] as const satisfies readonly ReasonCode[];
export type WorkEvidenceErrorCode = (typeof WORK_EVIDENCE_ERROR_CODES)[number];

export interface AttachWorkEvidenceRequest {
  /** Where the workspace is found, and what `path` and `kind` resolve against. */
  cwd: string;
  /** The work item. */
  item: string;
  /** The work kind file, when the declaration names more than one with the item. */
  kind?: string;
  /** The lease the run holds: its holder and fencing token. */
  holder: string;
  token: string;
  /** The criterion the evidence is for, by id. */
  criterion: string;
  result: EvidenceResult;
  title: string;
  /** A public link, or */
  url?: string;
  /** a workspace file, pinned by the hash of its bytes now. */
  path?: string;
  /** When the evidence was taken, as an ISO 8601 timestamp. Now by default. */
  asOf?: string;
}

/** The version of the attach document this chant writes. */
export const WORK_EVIDENCE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the attach document, shipped beside this file. */
export const WORK_EVIDENCE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/work-evidence/v1/work-evidence.schema.json";

interface DocHead {
  $schema: string;
  contract: number;
}

/** What {@link attachWorkEvidence} returns: the entry written, or why nothing was. */
export type WorkEvidenceDocument = DocHead &
  (
    | {
        item: string;
        /** The work kind file, from the repository root. */
        kind: string;
        /** The record, from the repository root. */
        path: string;
        /** The entry appended to the kind's pins field. */
        evidence: Record<string, unknown>;
        /** The record's criteria with the new entry counted. */
        acceptance: WorkAcceptance;
      }
    | { error: { code: WorkEvidenceErrorCode; message: string } }
  );

class EvidenceError extends Error {
  constructor(
    readonly code: WorkEvidenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Append one piece of evidence for a criterion to a leased work item. Never throws for a refusal. */
export async function attachWorkEvidence(req: AttachWorkEvidenceRequest): Promise<WorkEvidenceDocument> {
  const head = { $schema: WORK_EVIDENCE_OUTPUT_SCHEMA_ID, contract: WORK_EVIDENCE_CONTRACT_VERSION };
  try {
    if (typeof req.criterion !== "string" || req.criterion === "") throw new EvidenceError("write-usage-invalid", "the evidence names no criterion");
    if (!(EVIDENCE_RESULTS as readonly string[]).includes(req.result)) {
      throw new EvidenceError("write-usage-invalid", `result is pass or fail, not ${JSON.stringify(req.result)}`);
    }
    if (typeof req.title !== "string" || req.title.trim() === "") throw new EvidenceError("write-usage-invalid", "the evidence has no title");
    if ((req.url === undefined) === (req.path === undefined)) throw new EvidenceError("write-usage-invalid", "the evidence is a url or a path, exactly one of them");
    if (req.url !== undefined && !req.url.startsWith("https://")) throw new EvidenceError("write-input-invalid", `evidence links are https://, not ${JSON.stringify(req.url)}`);

    const found = await findWorkItem(req.item, req.cwd, req.kind);
    const { kind } = found.loaded;
    const data = found.record.data;
    if (found.state !== null && (kind.closedStates ?? []).includes(found.state)) {
      throw new EvidenceError("work-item-closed", `${req.item} is ${found.state}, a closed state, so no evidence is added to it`);
    }

    // The lease, as the local refs hold it: the run claimed it here, so they are current.
    const lease = (await activeWorkLeases(found.loaded.file)).get(req.item);
    if (!lease) throw new EvidenceError("lease-not-held", `nobody holds a live lease on ${req.item}: it expired, was released or was never claimed`);
    if (lease.holder !== req.holder) throw new EvidenceError("lease-held", `${lease.holder} holds the lease on ${req.item}, not ${req.holder}`);
    if (lease.token !== req.token) throw new EvidenceError("lease-token-mismatch", `the lease on ${req.item} carries another token than the one given: it changed hands`);

    const spec = kind.work?.acceptance;
    if (!spec || !kind.pins) throw new EvidenceError("work-criterion-unknown", `the ${kind.name} kind has no acceptance criteria, so evidence can't name ${req.criterion}`);
    const criterion = acceptanceCriteria(data, spec.field).find((c) => c.id === req.criterion);
    if (!criterion) throw new EvidenceError("work-criterion-unknown", `${req.item} lists no acceptance criterion ${req.criterion}`);
    if (criterion.verification === "manual") {
      throw new EvidenceError(
        "work-acceptance-self-verified",
        `${req.criterion} is verified by a person, and ${req.holder} holds ${req.item}'s lease, so it is the implementer: a manual verdict comes from someone else, with records amend`,
      );
    }

    let pin: Record<string, unknown>;
    if (req.path !== undefined) {
      const pinned = pinFile(req.path, req.cwd);
      if ("error" in pinned) throw new EvidenceError("write-input-invalid", pinned.error);
      pin = { path: pinned.path, sha256: pinned.sha256 };
    } else {
      pin = { url: req.url };
    }
    const entry: Record<string, unknown> = {
      title: req.title,
      ...pin,
      as_of: req.asOf ?? new Date().toISOString(),
      criterion: criterion.id,
      verification: criterion.verification as VerificationType,
      result: req.result,
      by: req.holder,
    };
    const before = Array.isArray(data?.[kind.pins.field]) ? (data![kind.pins.field] as unknown[]) : [];
    const evidence = [...before, entry];
    const amended = await amendRecord({ kind: found.loaded.file, id: req.item, fields: JSON.stringify({ [kind.pins.field]: evidence }), cwd: req.cwd });
    if ("error" in amended) throw new EvidenceError(amended.error.code, amended.error.message);
    const { acceptance } = workAcceptance({ ...data, [kind.pins.field]: evidence }, spec, kind.pins.field);
    const kindPath = relative(found.root, found.loaded.file).split(sep).join("/");
    return { ...head, item: req.item, kind: kindPath, path: amended.path, evidence: entry, acceptance: acceptance! };
  } catch (err) {
    if (err instanceof EvidenceError || err instanceof WorkError) return { ...head, error: { code: err.code, message: err.message } };
    throw err;
  }
}
