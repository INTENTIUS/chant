/**
 * The terraform lexicon's drift read (behold#995): `LexiconPlugin.readDrift`,
 * which `chant lifecycle drift` calls, and which `chant workspace drift` runs
 * in a `terraform` or `choudoufu` member's reader project. It runs the
 * engine's own reads, one root at a time, and hands each document to the
 * drift-record adapters in `./drift-record.ts` (#4451), so the records say
 * exactly what those adapters say.
 *
 * | root | `--read` | reads | adapter |
 * |---|---|---|---|
 * | stock | `state` (default) | `show -json` over state | `terraformStateDriftRecords` |
 * | stock | `plan` | `plan -input=false -lock=false -out=<tmp>`, `show -json` | `terraformPlanDriftRecords` |
 * | live | `ownership` (default) | `choudoufu live-plan -json`, `live-ls -json` | `choudoufuLiveDriftRecords` |
 * | live | `plan` | live-plan, then the same plan read | `choudoufuLivePlusPlanDriftRecords` |
 * | live | `--resource <addr>` | `choudoufu live-plan -resource=<addr>` | its own stream, decoded by `decodeDriftLines` |
 *
 * Nothing is written in the root. `init` is never run, as on the plan read
 * (`terraformPlanRead`): a root that was never initialised reads
 * not-observed with the init line in the detail. A plan read that fails
 * falls back one depth (the plan to state, live+plan to ownership) and the
 * records carry `fellBackFrom`. A live-ls that fails is left out: it only
 * adds what the estate holds and nothing declares.
 *
 * Each root's records go out as one stream: a `drift-start` whose `expected`
 * is every address the read answered, the records, and a `drift-settle`.
 * `node` stays null; `chant workspace drift` places each record on the
 * member's graph. A pulumi member (`pulumiMember`) is refused: its drift is
 * the pulumi lexicon's (chant#4453).
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  decodeDriftLines,
  driftRecord,
  driftRecordLine,
  driftSettle,
  driftStart,
  type DriftEngine,
  type DriftLine,
  type DriftRead,
  type DriftRecord,
  type ReadDriftOptions,
  type ReadDriftResult,
} from "@intentius/chant/drift-record";
import type { TerraformConfig, TerraformRootConfig } from "./config";
import { declaredOf } from "./describe-resources";
import {
  choudoufuLivePlusPlanDriftRecords,
  choudoufuLiveDriftRecords,
  terraformPlanDriftRecords,
  terraformStateDriftRecords,
} from "./drift-record";
import { RESOURCE_TYPE } from "./hcl/parse";
import { renderTerraformRoots } from "./hcl/roots";
import { readsAsCredentials } from "./live-plan-reasons";
import { detectLiveEstate } from "./op/activities/live-detect";
import {
  choudoufuLiveLs,
  choudoufuLivePlanDocument,
  rootIsInitialised,
  terraformBinary,
  terraformEnvironment,
  terraformInitLine,
  terraformPlanRead,
  terraformShow,
} from "./op/activities/terraform";

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** The reads a root answers, the first its default. */
const ROOT_READS: Record<"stock" | "live", readonly DriftRead[]> = { stock: ["state", "plan"], live: ["ownership", "plan"] };

interface RootContext {
  options: ReadDriftOptions;
  name: string;
  root: TerraformRootConfig;
  binary: string;
  dir: string;
  engine: DriftEngine;
  /** Every declared managed resource's address. */
  declared: string[];
  where: { root: string; cwd: string };
}

/** One root's records as a stream: start, records, settle. */
function asStream(ctx: RootContext, read: DriftRead, records: DriftRecord[], extra: { fellBackFrom?: string; resource?: string } = {}): DriftLine[] {
  const start = driftStart({
    member: ctx.options.member,
    engine: ctx.engine,
    read,
    ...extra,
    at: ctx.options.observedAt,
    expected: records.map((r) => r.address),
    evidence: { tool: ctx.engine },
  });
  const settled = driftSettle(start, records, ctx.options.observedAt);
  return [start, ...settled.records.map(driftRecordLine), settled.line];
}

/** Every declared address not-observed, for a read that could not run at all. */
function unobservedAll(ctx: RootContext, read: DriftRead, err: unknown, command: string): DriftRecord[] {
  const detail = firstLine(err);
  return ctx.declared.map((address) =>
    driftRecord({
      member: ctx.options.member,
      engine: ctx.engine,
      address,
      node: null,
      observedAt: ctx.options.observedAt,
      read,
      status: "not-observed",
      unobserved: { reason: readsAsCredentials(detail) ? "no-credentials" : "read-failed", detail },
      evidence: { tool: ctx.engine, command },
    }),
  );
}

/** A stock root's state read. Never runs init. */
async function stateRecords(ctx: RootContext, fellBackFrom?: string): Promise<DriftRecord[]> {
  const base = { member: ctx.options.member, observedAt: ctx.options.observedAt, engine: ctx.engine as "terraform" | "tofu", declared: ctx.declared, ...(fellBackFrom ? { fellBackFrom } : {}) };
  const env = { ...process.env, ...terraformEnvironment(ctx.root) };
  if (!rootIsInitialised(ctx.dir, env)) {
    const line = terraformInitLine({ binary: ctx.binary, dir: ctx.dir, ...(ctx.root.backendConfig ? { backendConfig: ctx.root.backendConfig } : {}) });
    return terraformStateDriftRecords({ ...base, failed: { reason: "read-failed", detail: `${ctx.dir} has never been initialised: run \`${line}\` first; chant never runs init on a read` } });
  }
  try {
    const shown = await terraformShow(ctx.where);
    return terraformStateDriftRecords({ ...base, state: shown.json });
  } catch (err) {
    const detail = firstLine(err);
    return terraformStateDriftRecords({ ...base, failed: { reason: readsAsCredentials(detail) ? "no-credentials" : "read-failed", detail } });
  }
}

async function stockRoot(ctx: RootContext, read: DriftRead): Promise<DriftLine[]> {
  if (read === "state") return asStream(ctx, "state", await stateRecords(ctx));
  try {
    const plan = await terraformPlanRead(ctx.where);
    return asStream(ctx, "plan", terraformPlanDriftRecords({ member: ctx.options.member, observedAt: ctx.options.observedAt, engine: ctx.engine as "terraform" | "tofu", plan: plan.json }));
  } catch (err) {
    // One depth down: what the last apply recorded, said as such.
    process.stderr.write(`terraform.roots.${ctx.name}: the plan read failed (${firstLine(err)}), so the state read answered\n`);
    return asStream(ctx, "state", await stateRecords(ctx, "plan"), { fellBackFrom: "plan" });
  }
}

async function liveOwnership(ctx: RootContext, fellBackFrom?: string): Promise<{ records: DriftRecord[]; livePlan?: unknown; liveLs?: unknown }> {
  let livePlan: unknown;
  try {
    livePlan = (await choudoufuLivePlanDocument(ctx.where)).json;
  } catch (err) {
    return { records: unobservedAll(ctx, "ownership", err, "choudoufu live-plan -json") };
  }
  let liveLs: unknown;
  try {
    liveLs = (await choudoufuLiveLs({ ...ctx.where, consistent: true })).json;
  } catch (err) {
    process.stderr.write(`terraform.roots.${ctx.name}: live-ls failed (${firstLine(err)}); what the estate holds and nothing declares is left out\n`);
  }
  const base = { member: ctx.options.member, observedAt: ctx.options.observedAt, livePlan, ...(liveLs !== undefined ? { liveLs } : {}), ...(fellBackFrom ? { fellBackFrom } : {}) };
  return { records: choudoufuLiveDriftRecords(base), livePlan, liveLs };
}

async function liveRoot(ctx: RootContext, read: DriftRead): Promise<DriftLine[]> {
  if (read === "ownership") return asStream(ctx, "ownership", (await liveOwnership(ctx)).records);
  const owned = await liveOwnership(ctx);
  if (owned.livePlan === undefined) return asStream(ctx, "ownership", owned.records, { fellBackFrom: "live+plan" });
  try {
    const plan = await terraformPlanRead(ctx.where);
    const records = choudoufuLivePlusPlanDriftRecords({
      member: ctx.options.member,
      observedAt: ctx.options.observedAt,
      livePlan: owned.livePlan,
      plan: plan.json,
      ...(owned.liveLs !== undefined ? { liveLs: owned.liveLs } : {}),
    });
    return asStream(ctx, "plan", records);
  } catch (err) {
    process.stderr.write(`terraform.roots.${ctx.name}: the plan read failed (${firstLine(err)}), so live-plan alone answered\n`);
    const fell = choudoufuLiveDriftRecords({
      member: ctx.options.member,
      observedAt: ctx.options.observedAt,
      livePlan: owned.livePlan,
      ...(owned.liveLs !== undefined ? { liveLs: owned.liveLs } : {}),
      fellBackFrom: "live+plan",
    });
    return asStream(ctx, "ownership", fell, { fellBackFrom: "live+plan" });
  }
}

/** `choudoufu live-plan -resource=<addr>`'s own stream (choudoufu#2245), decoded, with the workspace member's name on every line. */
async function liveResource(ctx: RootContext, address: string): Promise<DriftLine[]> {
  // `-estate` only for a root that names its estate in chant.config and not in its HCL: choudoufu refuses the flag beside a declaration.
  const estateFlag = ctx.root.estate !== undefined && detectLiveEstate(ctx.dir) === undefined ? [`-estate=${ctx.root.estate}`] : [];
  const argv = ["live-plan", ...estateFlag, `-resource=${address}`];
  const command = `${ctx.binary} ${argv.join(" ")}`;
  const ran = await new Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>((done) => {
    const child = spawn(ctx.binary, argv, { cwd: ctx.dir, env: { ...process.env, ...terraformEnvironment(ctx.root) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (error) => done({ code: null, stdout, stderr, error }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  if (ran.stderr.trim()) process.stderr.write(ran.stderr.endsWith("\n") ? ran.stderr : `${ran.stderr}\n`);
  // 2 is live-plan's "changes present" under -detailed-exitcode; the stream is what answers.
  if (ran.error === undefined && (ran.code === 0 || ran.code === 2) && ran.stdout.trim()) {
    try {
      return decodeDriftLines(ran.stdout).map((line) => ({ ...line, member: ctx.options.member }));
    } catch (err) {
      return asStream(ctx, "plan", [unobservedOne(ctx, address, `${command} printed a line that is not drift: ${firstLine(err)}`, command)], { resource: address });
    }
  }
  const why = ran.error?.message ?? (ran.stderr.trim().split("\n").pop() || `exit ${ran.code}`);
  return asStream(ctx, "plan", [unobservedOne(ctx, address, `${command} failed: ${why}`, command)], { resource: address });
}

function unobservedOne(ctx: RootContext, address: string, detail: string, command: string): DriftRecord {
  return driftRecord({
    member: ctx.options.member,
    engine: "choudoufu",
    address,
    node: null,
    observedAt: ctx.options.observedAt,
    read: "plan",
    status: "not-observed",
    unobserved: { reason: readsAsCredentials(detail) ? "no-credentials" : "read-failed", detail },
    evidence: { tool: "choudoufu", command },
  });
}

/** `LexiconPlugin.readDrift` for the terraform lexicon. */
export async function readTerraformDrift(options: ReadDriftOptions): Promise<ReadDriftResult> {
  const namespace = (options.config as { terraform?: TerraformConfig }).terraform;
  const roots = Object.entries(namespace?.roots ?? {});
  if (roots.length === 0) return { refused: { code: "no-drift-read", message: "terraform.roots declares no root" } };
  const binary = terraformBinary(namespace);
  const live = (root: TerraformRootConfig, dir: string) => binary === "choudoufu" && (detectLiveEstate(dir) !== undefined || root.estate !== undefined);

  const contexts: Array<RootContext & { live: boolean }> = [];
  for (const [name, root] of roots) {
    const dir = resolve(options.projectRoot, root.dir);
    const rendered = await renderTerraformRoots({
      projectRoot: options.projectRoot,
      roots: { [name]: root },
      binary: namespace?.binary,
      callModuleType: namespace?.callModuleType,
      moduleRoot: namespace?.moduleRoot,
    });
    const declared = [...rendered.entities.entries()]
      .map(([key, entity]) => declaredOf(key, entity as unknown as { entityType: string; props: Record<string, unknown> }))
      .filter((d) => d.type === RESOURCE_TYPE)
      .map((d) => d.address);
    const isLive = live(root, dir);
    contexts.push({ options, name, root, binary, dir, engine: isLive ? "choudoufu" : binary === "tofu" ? "tofu" : "terraform", declared: [...new Set(declared)].sort(), where: { root: name, cwd: options.projectRoot }, live: isLive });
  }

  for (const ctx of contexts) {
    const reads = ROOT_READS[ctx.live ? "live" : "stock"];
    if (options.read !== undefined && !reads.includes(options.read)) {
      return { refused: { code: "read-unsupported", message: `terraform.roots.${ctx.name} is a ${ctx.live ? "live (choudoufu)" : "stock"} root, which answers ${reads.join(" or ")}, not ${options.read}` } };
    }
    if (options.resource !== undefined && !ctx.live) {
      return { refused: { code: "resource-unsupported", message: `terraform.roots.${ctx.name} is a stock root; one resource is read through choudoufu live-plan -resource, on a live root` } };
    }
  }

  const lines: DriftLine[] = [];
  for (const ctx of contexts) {
    const read = options.read ?? ROOT_READS[ctx.live ? "live" : "stock"][0];
    if (options.resource !== undefined) lines.push(...(await liveResource(ctx, options.resource)));
    else if (ctx.live) lines.push(...(await liveRoot(ctx, read)));
    else lines.push(...(await stockRoot(ctx, read)));
  }
  return { lines };
}
