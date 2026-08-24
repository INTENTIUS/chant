/**
 * The aws `ReceiptStore` (#1835, epic #1703) — core's injectable receipt seam
 * (#1834, `@intentius/chant/op/receipt-store`) implemented over SSM Parameter
 * Store, plain `String`, at the path identity ./effect-receipt-row.ts derives
 * from the ownership marker fields.
 *
 * The transport is the lexicon's own read/apply transport (./api/read-client,
 * #1206), pointed at the SSM JSON API: `fetch`, SigV4 when credentials
 * resolve, and the one endpoint-override rule (#1694) — the `endpoint`
 * option, else `AWS_ENDPOINT_URL_SSM`, else `AWS_ENDPOINT_URL` — so a local
 * emulator lane reads and writes receipts without any store-specific wiring.
 *
 * Write discipline (epic decision 3): `write` exists for the `effect()` step
 * alone — the step's read-compare-run-write is the only path that reaches it,
 * on success, last. `PutParameter` is `Type: "String"` always; the first
 * write creates the parameter with the ownership tags, and a later write
 * overwrites the value (SSM refuses `Overwrite` and `Tags` in one call, so
 * tags ride creation only — they never change after).
 *
 * Identity: the parameter name needs `<stack>` and `<env>`, which the
 * activity args deliberately do not carry (the `EffectReceiptRef` is
 * identity-of-the-effect, not identity-of-the-deployment). The store resolves
 * them once, lazily, at first use: an explicit option, else `CHANT_ENV` (what
 * `chant run --env` sets) and the project's `ownership` block — the same
 * fields that stamp markers (epic decision 4). Nothing resolving is an error,
 * never a guessed segment.
 */

import { loadChantConfigUpward, resolveOwnershipStack } from "@intentius/chant/config";
import { ownershipEntries } from "@intentius/chant/ownership";
import type { EffectReceiptRef, ReceiptStore } from "@intentius/chant/op/receipt-store";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import type { UnobservedReason } from "@intentius/chant/observation";
import {
  AwsReadError,
  requestHeaders,
  serviceUrl,
  withEndpointOverride,
  type AwsCredentialSource,
  type AwsReadClientOptions,
  type AwsReadHttp,
} from "./api/read-client";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";
import { AWS_EFFECT_RECEIPT_ENTITY_TYPE, EFFECT_RECEIPTS_METADATA_KEY, receiptParameterName } from "./effect-receipt-row";

const SSM_SERVICE = "ssm";
const SSM_TARGET_PREFIX = "AmazonSSM";

/** Options for {@link awsReceiptStore}. All optional: the default store reads
 * its identity from the project and its endpoint from the environment. */
export interface AwsReceiptStoreOptions {
  /** The path's `<stack>` segment. Omitted, the project's `ownership.stack`
   * (chant.config.ts, found upward from `cwd`) answers. */
  stack?: string;
  /** The path's `<env>` segment — explicit by decision 4. Omitted, `CHANT_ENV`
   * (set by `chant run --env`) answers, then a literal `ownership.env`. */
  environment?: string;
  /** Where to look for chant.config.ts. Defaults to the working directory. */
  cwd?: string;
  /** Endpoint override; omitted, `AWS_ENDPOINT_URL[_SSM]` answers (#1694). */
  endpoint?: string;
  /** Region for the real-AWS host. */
  region?: string;
  /** Injectable HTTP, mirroring the read client's. Tests avoid the network. */
  http?: AwsReadHttp;
  /** Environment record the endpoint/credential/identity fallbacks read.
   * Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** What to sign with — same seam as the read client. */
  credentials?: AwsCredentialSource;
  /** Sign even against an endpoint override — for an override that is real AWS. */
  signEndpointOverride?: boolean;
}

/** One SSM JSON call. Exported for the observation leg (plugin.ts), which
 * reads the same parameters the store writes. */
export async function ssmCall(
  action: string,
  payload: Record<string, unknown>,
  options: AwsReadClientOptions,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const settled = withEndpointOverride(SSM_SERVICE, options);
  const url = serviceUrl(SSM_SERVICE, settled.endpoint, settled.region);
  const body = JSON.stringify(payload);
  const base = {
    "content-type": "application/x-amz-json-1.1",
    "x-amz-target": `${SSM_TARGET_PREFIX}.${action}`,
  };
  const headers = requestHeaders(SSM_SERVICE, url, body, base, settled);
  const http: AwsReadHttp =
    settled.http ??
    (async (u, init, signal) => {
      const res = await fetch(u, { method: "POST", headers: init.headers, body: init.body, signal });
      return { status: res.status, text: await res.text() };
    });
  const res = await http(url, { headers, body }, settled.signal);
  let json: Record<string, unknown> = {};
  try {
    json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {};
  } catch {
    if (res.status < 400) {
      throw new AwsReadError(`SSM ${action}: unparseable response (status ${res.status})`, res.status);
    }
  }
  return { status: res.status, json };
}

/** The API's own error code from a JSON-protocol error body — `__type`, with
 * any `namespace#` prefix stripped. */
export function ssmErrorCode(json: Record<string, unknown>): string | undefined {
  const type = json.__type;
  if (typeof type !== "string") return undefined;
  return type.includes("#") ? type.slice(type.indexOf("#") + 1) : type;
}

function ssmError(action: string, status: number, json: Record<string, unknown>): AwsReadError {
  const code = ssmErrorCode(json);
  const message = typeof json.message === "string" ? json.message : typeof json.Message === "string" ? json.Message : "";
  return new AwsReadError(`SSM ${action} failed (status ${status})${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, status, code);
}

/**
 * `GetParameter` by name. Absent (`ParameterNotFound`) is `undefined` — a real
 * answer, distinct from a failed read, which throws.
 */
export async function ssmGetParameter(
  name: string,
  options: AwsReadClientOptions = {},
): Promise<string | undefined> {
  const { status, json } = await ssmCall("GetParameter", { Name: name }, options);
  if (status >= 400) {
    if (ssmErrorCode(json) === "ParameterNotFound") return undefined;
    throw ssmError("GetParameter", status, json);
  }
  const value = (json.Parameter as { Value?: unknown } | undefined)?.Value;
  return typeof value === "string" ? value : undefined;
}

/**
 * `PutParameter`, plain `String`. Creation carries `tags`; an existing
 * parameter is overwritten (`Overwrite: true`) without them — SSM refuses
 * `Overwrite` and `Tags` in the same call, and ownership tags never change.
 */
export async function ssmPutParameter(
  name: string,
  value: string,
  tags: Record<string, string>,
  options: AwsReadClientOptions = {},
): Promise<void> {
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  const create = await ssmCall(
    "PutParameter",
    { Name: name, Value: value, Type: "String", ...(tagList.length > 0 ? { Tags: tagList } : {}) },
    options,
  );
  if (create.status < 400) return;
  if (ssmErrorCode(create.json) !== "ParameterAlreadyExists") {
    throw ssmError("PutParameter", create.status, create.json);
  }
  const overwrite = await ssmCall(
    "PutParameter",
    { Name: name, Value: value, Type: "String", Overwrite: true },
    options,
  );
  if (overwrite.status >= 400) throw ssmError("PutParameter", overwrite.status, overwrite.json);
}

/** The resolved path identity plus the tags a creation stamps. */
interface ReceiptIdentity {
  stack: string;
  env: string;
}

async function resolveIdentity(options: AwsReceiptStoreOptions): Promise<ReceiptIdentity> {
  const processEnv = options.env ?? process.env;
  let stack = options.stack;
  let env = options.environment ?? processEnv.CHANT_ENV;
  if (!stack || !env) {
    let config;
    try {
      config = (await loadChantConfigUpward(options.cwd ?? process.cwd())).config;
    } catch {
      config = undefined;
    }
    if (config) {
      stack = stack ?? resolveOwnershipStack(config);
      // Only a literal env can answer here: a `{ param }` reference resolves
      // per build, and an op run has no build parameters — `--env` does.
      const configEnv = config.ownership?.env;
      env = env ?? (typeof configEnv === "string" ? configEnv : undefined);
    }
  }
  if (!stack) {
    throw new Error(
      "aws receipt store: no stack identity — the receipt path is " +
        "/chant-receipts/<stack>/<env>/<effect>, derived from the same ownership fields that stamp " +
        "markers (chant #1703, decision 4). Set ownership: { stack } in chant.config.ts.",
    );
  }
  if (!env) {
    throw new Error(
      "aws receipt store: no environment resolved — the receipt path's <env> segment is explicit " +
        "(chant #1703, decision 4). Run with --env <name>, set CHANT_ENV, or set a literal " +
        "ownership.env in chant.config.ts.",
    );
  }
  return { stack, env };
}

/** What the observation leg learned about the declared receipt rows. */
export interface ReceiptRowObservation {
  resources: Record<string, ResourceMetadata>;
  unobserved: Record<string, { type: string; reason: UnobservedReason; detail: string }>;
}

/**
 * The plan-side live read of the receipt rows (#1835's observation leg).
 *
 * A receipt is not a stack member — the applier never writes it (#1832) — so
 * `describe-stack-resources` honestly reports it absent even while the
 * parameter exists. The serializer renders each receipt's derived path into
 * the template's `Metadata` (./serializer.ts), so this leg reads the paths
 * back from the build output — one derivation, decision 4 — and asks SSM
 * `GetParameter` for each. Present maps the stored value onto
 * `attributes.value` (core's `RECEIPT_VALUE_ATTRIBUTE`); `ParameterNotFound`
 * is a real absence and stays one; a failed read is an `unobserved` hole,
 * never a wrong answer — a receipt nobody could read must not arrive
 * downstream as "the effect never ran".
 */
export async function observeReceiptRows(
  entityNames: string[],
  buildOutput: string,
  options: AwsReadClientOptions = {},
): Promise<ReceiptRowObservation> {
  const out: ReceiptRowObservation = { resources: {}, unobserved: {} };
  let rows: Record<string, { Properties?: { Name?: unknown } }> | undefined;
  try {
    const template = JSON.parse(buildOutput) as { Metadata?: Record<string, unknown> };
    const block = template.Metadata?.[EFFECT_RECEIPTS_METADATA_KEY];
    if (typeof block === "object" && block !== null) {
      rows = block as Record<string, { Properties?: { Name?: unknown } }>;
    }
  } catch {
    rows = undefined; // Not a JSON template — no receipt rows to read.
  }
  if (!rows) return out;

  for (const name of entityNames) {
    const rendered = rows[name]?.Properties?.Name;
    if (typeof rendered !== "string") continue;
    try {
      const value = await ssmGetParameter(rendered, options);
      if (value === undefined) continue; // Confirmed absent — the effect has not stamped it yet.
      out.resources[name] = {
        type: AWS_EFFECT_RECEIPT_ENTITY_TYPE,
        physicalId: rendered,
        // Live outside the stack by design — the same word the identity
        // fallback (#1647) uses for a resource CloudFormation does not hold.
        status: "EXTERNAL",
        // GetParameter returns no tags, so the marker channel is unreadable
        // here; `unknown` is the total verdict, never a guess (#1089).
        ownership: "unknown",
        attributes: { value },
      };
    } catch (err) {
      const detail =
        err instanceof AwsReadError && err.code
          ? `${err.code}: ${err.message}`
          : String(err instanceof Error ? err.message : err);
      const reason: UnobservedReason = /credential|token|expired|AccessDenied|not authorized|Unauthorized/i.test(detail)
        ? "no-credentials"
        : "read-failed";
      out.unobserved[name] = {
        type: AWS_EFFECT_RECEIPT_ENTITY_TYPE,
        reason,
        detail: `GetParameter failed for receipt "${rendered}": ${detail}`,
      };
    }
  }
  return out;
}

/**
 * The `ReceiptStore` over SSM. Bind it once in the op activities barrel —
 * `receiptActivities(awsReceiptStore())` — and the registry resolves
 * `receiptRead`/`receiptWrite`/`receiptStaleness` by name, exactly like
 * `ensureSecret` (#1830). Identity and endpoint resolve lazily at first use,
 * so module load never reads the project or the environment.
 */
export function awsReceiptStore(options: AwsReceiptStoreOptions = {}): ReceiptStore {
  let identity: Promise<ReceiptIdentity> | undefined;
  const identityOf = () => (identity ??= resolveIdentity(options));

  const client = (): AwsReadClientOptions => ({
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.http !== undefined ? { http: options.http } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options.signEndpointOverride !== undefined ? { signEndpointOverride: options.signEndpointOverride } : {}),
  });

  return {
    async read(receipt: EffectReceiptRef): Promise<string | undefined> {
      const { stack, env } = await identityOf();
      return ssmGetParameter(receiptParameterName(stack, env, receipt.effect), client());
    },

    async write(receipt: EffectReceiptRef, expectation: string): Promise<void> {
      const { stack, env } = await identityOf();
      const tags = ownershipEntries(AWS_TAG_OWNERSHIP_KEYS, { stack, env });
      await ssmPutParameter(receiptParameterName(stack, env, receipt.effect), expectation, tags, client());
    },
  };
}
