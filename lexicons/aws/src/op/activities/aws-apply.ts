import { readFileSync } from "node:fs";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

const DEFAULT_REGION = "us-east-1";
const CFN_API_VERSION = "2010-05-15";
const DEFAULT_CAPABILITIES = ["CAPABILITY_NAMED_IAM"];

export interface AwsApplyArgs {
  /** Path to a built CloudFormation template (JSON/YAML). */
  templatePath: string;
  /** CloudFormation stack name — the deploy boundary. */
  stackName: string;
  /** CFN endpoint override (e.g. Floci `http://localhost:4566`). Default: real CloudFormation. */
  endpoint?: string;
  /** Region (real CFN host + `Version` context). Default: `us-east-1`. */
  region?: string;
  /** Capabilities to acknowledge. Default: `["CAPABILITY_NAMED_IAM"]`. */
  capabilities?: string[];
  /** Stack-settle timeout in ms. Default: `300000`. */
  timeoutMs?: number;
  /** Poll interval in ms. Default: `3000`. */
  intervalMs?: number;
}

/** Injectable CFN transport — a form POST returning the raw XML. Mirrors the az/gcp appliers so tests avoid the network. */
export type AwsHttp = (url: string, form: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

const defaultHttp: AwsHttp = async (url, form, signal) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal,
  });
  return { status: res.status, text: await res.text() };
};

// ── Pure helpers (CFN Query protocol) ─────────────────────────────────────────

/** The CloudFormation endpoint URL — the override, or the real regional host. */
export function cfnUrl(endpoint?: string, region = DEFAULT_REGION): string {
  return `${(endpoint ?? `https://cloudformation.${region}.amazonaws.com`).replace(/\/$/, "")}/`;
}

/** A CFN Query-protocol form body: `Action` + `Version` + params. */
export function cfnForm(action: string, params: Record<string, string>): Record<string, string> {
  return { Action: action, Version: CFN_API_VERSION, ...params };
}

/** Capabilities as the CFN `Capabilities.member.N` list params. */
export function capabilityParams(capabilities: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  capabilities.forEach((c, i) => (out[`Capabilities.member.${i + 1}`] = c));
  return out;
}

/**
 * First `<tag>…</tag>` text in a CFN XML response.
 *
 * Assumes flat scalar fields — the CloudFormation Query API returns simple
 * `<StackStatus>…</StackStatus>` style leaves, so `[^<]*` is sufficient. It does
 * NOT handle nested tags or XML entities in the value; if a field ever carries
 * either, replace this with a real XML parser.
 */
export function xmlField(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
}

export const stackStatus = (xml: string): string | undefined => xmlField(xml, "StackStatus");
export const stackId = (xml: string): string | undefined => xmlField(xml, "StackId");
export const cfnErrorMessage = (xml: string): string | undefined => xmlField(xml, "Message");

/** A DescribeStacks error for an absent stack (drives create-vs-update). */
export const isStackMissing = (xml: string): boolean => /does not exist/i.test(xml);
/** The real-AWS UpdateStack no-op error (Floci returns 200 instead). */
export const isNoUpdates = (xml: string): boolean => /No updates are to be performed/i.test(xml);

const SUCCESS_STATUS = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);
export const isSuccessStatus = (status: string): boolean => SUCCESS_STATUS.has(status);
export const isFailureStatus = (status: string): boolean => /FAILED|ROLLBACK/.test(status);
/** A settled stack state — success, failure, or deleted. Transient `*_IN_PROGRESS` states aren't. */
export const isTerminalStatus = (status: string): boolean =>
  isSuccessStatus(status) || isFailureStatus(status) || status === "DELETE_COMPLETE";

// ── Poll ──────────────────────────────────────────────────────────────────────

/** Poll DescribeStacks until the stack reaches a terminal state; returns that status. */
export async function waitForStackSettled(
  url: string,
  stackName: string,
  http: AwsHttp,
  opts: { timeoutMs: number; intervalMs: number },
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("awsApply aborted");
    safeHeartbeat({ step: "awsApply", stack: stackName });
    const res = await http(url, cfnForm("DescribeStacks", { StackName: stackName }), signal);
    const status = stackStatus(res.text);
    if (status && isTerminalStatus(status)) return status;
    await sleep(opts.intervalMs, signal);
  }
  throw new Error(`CloudFormation stack ${stackName} did not settle within ${opts.timeoutMs}ms`);
}

// ── Apply / delete ──────────────────────────────────────────────────────────

/**
 * The native AWS applier — deploy a built CloudFormation template by calling the
 * CloudFormation API directly (create-or-update + poll to a settled stack),
 * targeting a local Floci emulator or real AWS by endpoint override. The direct
 * twin of `azApply`/`gcpApply`: it speaks the CloudFormation Query API over HTTP
 * rather than shelling `aws cloudformation deploy` (that CLI path is still
 * available via `nativeApply({ target: "cloudformation" })`). The stack is the
 * ownership boundary, so deletes ride CloudFormation itself — no separate prune.
 * `http` is injectable for tests.
 */
export async function awsApply(
  args: AwsApplyArgs,
  signal?: AbortSignal,
  http: AwsHttp = defaultHttp,
): Promise<{ stackName: string; status: string; action: "created" | "updated" | "unchanged" }> {
  const url = cfnUrl(args.endpoint, args.region);
  const capabilities = args.capabilities ?? DEFAULT_CAPABILITIES;
  const templateBody = readFileSync(args.templatePath, "utf8");
  const timeoutMs = args.timeoutMs ?? 300_000;
  const intervalMs = args.intervalMs ?? 3_000;

  const desc = await http(url, cfnForm("DescribeStacks", { StackName: args.stackName }), signal);
  if (desc.status >= 300 && !isStackMissing(desc.text)) {
    throw new Error(`CloudFormation DescribeStacks failed (${desc.status}): ${cfnErrorMessage(desc.text) ?? desc.text}`);
  }
  const exists = desc.status < 300;

  const params = { StackName: args.stackName, TemplateBody: templateBody, ...capabilityParams(capabilities) };
  let action: "created" | "updated";
  if (!exists) {
    const res = await http(url, cfnForm("CreateStack", params), signal);
    if (res.status >= 300) {
      throw new Error(`CloudFormation CreateStack failed (${res.status}): ${cfnErrorMessage(res.text) ?? res.text}`);
    }
    action = "created";
  } else {
    const res = await http(url, cfnForm("UpdateStack", params), signal);
    if (res.status >= 300) {
      if (isNoUpdates(res.text)) {
        console.log(`unchanged: ${args.stackName} (no updates)`);
        return { stackName: args.stackName, status: "UPDATE_COMPLETE", action: "unchanged" };
      }
      throw new Error(`CloudFormation UpdateStack failed (${res.status}): ${cfnErrorMessage(res.text) ?? res.text}`);
    }
    action = "updated";
  }

  const status = await waitForStackSettled(url, args.stackName, http, { timeoutMs, intervalMs }, signal);
  if (isFailureStatus(status)) {
    throw new Error(`CloudFormation stack ${args.stackName} ${action} → ${status}`);
  }
  console.log(`${action}: ${args.stackName} (${status}) [${url}]`);
  return { stackName: args.stackName, status, action };
}

/**
 * The inverse of {@link awsApply} — DeleteStack, then poll until the stack is
 * gone. Idempotent: an already-absent stack is a no-op. `http` is injectable.
 */
export async function awsDelete(
  args: AwsApplyArgs,
  signal?: AbortSignal,
  http: AwsHttp = defaultHttp,
): Promise<{ stackName: string; deleted: boolean }> {
  const url = cfnUrl(args.endpoint, args.region);
  const timeoutMs = args.timeoutMs ?? 300_000;
  const intervalMs = args.intervalMs ?? 3_000;

  const res = await http(url, cfnForm("DeleteStack", { StackName: args.stackName }), signal);
  if (res.status >= 300 && !isStackMissing(res.text)) {
    throw new Error(`CloudFormation DeleteStack failed (${res.status}): ${cfnErrorMessage(res.text) ?? res.text}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("awsDelete aborted");
    safeHeartbeat({ step: "awsDelete", stack: args.stackName });
    const d = await http(url, cfnForm("DescribeStacks", { StackName: args.stackName }), signal);
    if (d.status >= 300 && isStackMissing(d.text)) return { stackName: args.stackName, deleted: true };
    const status = stackStatus(d.text);
    if (status === "DELETE_COMPLETE") return { stackName: args.stackName, deleted: true };
    if (status === "DELETE_FAILED") throw new Error(`CloudFormation stack ${args.stackName} delete → DELETE_FAILED`);
    await sleep(intervalMs, signal);
  }
  throw new Error(`CloudFormation stack ${args.stackName} delete did not complete within ${timeoutMs}ms`);
}
