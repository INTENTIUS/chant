/**
 * Plan and apply cloud identities (#4296): the pull-request jobs plan with
 * one identity and apply with another, per cloud, and the plan job trades
 * its OIDC token before the change's code is checked out.
 *
 * The workspace declaration's `ci.identity.cloud` gives each cloud a list of
 * rules. A rule names environment globs and member globs, and a plan and an
 * apply identity: an AWS role, a GCP service account or an Azure client id.
 * The first rule whose globs match the pipeline's environment and member is
 * the pipeline's ({@link resolveCloudIdentity}). A workspace generates one
 * pull-request pipeline per member and environment, so each member's apply
 * jobs hold that member's apply identity and no other.
 *
 * The plan job runs the pull request's code. Its first step, before the
 * checkout, runs {@link tradeJs} with `node -e`: it asks the forge for an
 * OIDC token, trades it for the plan identity's own credentials, and leaves
 * those credentials for the later steps. Each later step then starts again
 * without the variables a token is requested with ({@link OIDC_REQUEST_VARS},
 * through `dropForgeTokens` in ./ci-handover.ts), so the change's code holds
 * no OIDC token and cannot request one. The plan job's file names no apply
 * identity. The record job plans the merged commit with the plan identity,
 * and the apply jobs trade for the apply identity.
 *
 * The trade is terragucci's `oidc-trade.ts` (INTENTIUS/terragucci e6cb431,
 * packages/terragucci/src/oidc-trade.ts) with these clients:
 *
 *   AWS    STS AssumeRoleWithWebIdentity, as session keys in
 *          AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN
 *   GCP    Google's STS token exchange, then IAM generateAccessToken for the
 *          service account, in GOOGLE_OAUTH_ACCESS_TOKEN and
 *          CLOUDSDK_AUTH_ACCESS_TOKEN
 *   Azure  Entra's client credentials grant with the token as the client
 *          assertion, as an ARM access token in AZURE_ACCESS_TOKEN, with
 *          AZURE_CLIENT_ID and AZURE_TENANT_ID (and ARM_ spellings)
 *
 * terragucci leaves Azure untraded because the azurerm provider takes only
 * the OIDC token. chant trades it, so the change's code never holds a token
 * another client could be traded for; a tool that needs the OIDC token
 * itself cannot plan under this block.
 */

// @ts-ignore: picomatch has no types declaration
import picomatch from "picomatch";

/** The clouds `ci.identity.cloud` names. */
export const CLOUDS = ["aws", "gcp", "azure"] as const;
export type Cloud = (typeof CLOUDS)[number];

/** One rule: the environments and members it covers, and their two identities. */
export interface CloudIdentityRule {
  /** Environment-name globs. Absent: every environment. */
  environments?: string[];
  /** Member-name globs. Absent: every member, and a pipeline outside a workspace member. */
  members?: string[];
  /** The identity the plan and record jobs take. */
  plan: string;
  /** The identity the apply jobs take. */
  apply: string;
}

export interface AwsCloudIdentity {
  /** The STS region. Default `us-east-1`. */
  region?: string;
  /** The OIDC token's audience. Default `sts.amazonaws.com`. */
  audience?: string;
  /** The STS endpoint, for an emulator. Default the region's, or `AWS_ENDPOINT_URL_STS` in the job. */
  endpoint?: string;
  rules: CloudIdentityRule[];
}

export interface GcpCloudIdentity {
  /** The workload identity provider: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  provider: string;
  /** The OIDC token's audience. Default `https://iam.googleapis.com/<provider>`. */
  audience?: string;
  /** Google's STS, for an emulator. Default `https://sts.googleapis.com`. */
  stsEndpoint?: string;
  /** IAM credentials, for an emulator. Default `https://iamcredentials.googleapis.com`. */
  iamEndpoint?: string;
  rules: CloudIdentityRule[];
}

export interface AzureCloudIdentity {
  /** The Entra tenant. */
  tenantId: string;
  /** Set as AZURE_SUBSCRIPTION_ID and ARM_SUBSCRIPTION_ID when given. */
  subscriptionId?: string;
  /** The OIDC token's audience. Default `api://AzureADTokenExchange`. */
  audience?: string;
  /** The Entra authority host, for an emulator. Default `https://login.microsoftonline.com`. */
  authority?: string;
  rules: CloudIdentityRule[];
}

/** `ci.identity.cloud` as the declaration holds it. */
export interface CloudIdentityDeclaration {
  aws?: AwsCloudIdentity;
  gcp?: GcpCloudIdentity;
  azure?: AzureCloudIdentity;
}

/** What one job trades for: per cloud, the one identity and where to trade it. */
export interface CloudTradeSpec {
  aws?: { role: string; region: string; audience: string; endpoint?: string };
  gcp?: { serviceAccount: string; provider: string; audience: string; stsEndpoint?: string; iamEndpoint?: string };
  azure?: { clientId: string; tenantId: string; audience: string; subscriptionId?: string; authority?: string };
}

/** A pipeline's two trades: the plan and record jobs', and the apply jobs'. */
export interface PipelineCloudIdentity {
  plan: CloudTradeSpec;
  apply: CloudTradeSpec;
}

const matches = (globs: readonly string[] | undefined, name: string | undefined): boolean =>
  globs === undefined || (name !== undefined && globs.some((g) => (picomatch(g) as (s: string) => boolean)(name)));

/** The first rule that covers `env` and `member`, or undefined. */
export function ruleFor(rules: readonly CloudIdentityRule[], env: string, member?: string): CloudIdentityRule | undefined {
  return rules.find((r) => matches(r.environments, env) && matches(r.members, member));
}

/** The provider's resource name without the `//iam.googleapis.com/` prefix. */
const providerPath = (p: string): string => p.replace(/^(https:)?\/\/iam\.googleapis\.com\//, "");

/**
 * The plan and apply trades of the pipeline for `env` and `member`, or
 * undefined when no rule of any cloud covers them. A cloud no rule covers
 * is left out of both.
 */
export function resolveCloudIdentity(decl: CloudIdentityDeclaration | undefined, env: string, member?: string): PipelineCloudIdentity | undefined {
  if (!decl) return undefined;
  const plan: CloudTradeSpec = {};
  const apply: CloudTradeSpec = {};
  const aws = decl.aws && ruleFor(decl.aws.rules, env, member);
  if (decl.aws && aws) {
    const at = { region: decl.aws.region ?? "us-east-1", audience: decl.aws.audience ?? "sts.amazonaws.com", ...(decl.aws.endpoint ? { endpoint: decl.aws.endpoint } : {}) };
    plan.aws = { role: aws.plan, ...at };
    apply.aws = { role: aws.apply, ...at };
  }
  const gcp = decl.gcp && ruleFor(decl.gcp.rules, env, member);
  if (decl.gcp && gcp) {
    const provider = providerPath(decl.gcp.provider);
    const at = {
      provider,
      audience: decl.gcp.audience ?? `https://iam.googleapis.com/${provider}`,
      ...(decl.gcp.stsEndpoint ? { stsEndpoint: decl.gcp.stsEndpoint } : {}),
      ...(decl.gcp.iamEndpoint ? { iamEndpoint: decl.gcp.iamEndpoint } : {}),
    };
    plan.gcp = { serviceAccount: gcp.plan, ...at };
    apply.gcp = { serviceAccount: gcp.apply, ...at };
  }
  const azure = decl.azure && ruleFor(decl.azure.rules, env, member);
  if (decl.azure && azure) {
    const at = {
      tenantId: decl.azure.tenantId,
      audience: decl.azure.audience ?? "api://AzureADTokenExchange",
      ...(decl.azure.subscriptionId ? { subscriptionId: decl.azure.subscriptionId } : {}),
      ...(decl.azure.authority ? { authority: decl.azure.authority } : {}),
    };
    plan.azure = { clientId: azure.plan, ...at };
    apply.azure = { clientId: azure.apply, ...at };
  }
  return Object.keys(plan).length > 0 ? { plan, apply } : undefined;
}

/** The clouds a trade covers, in {@link CLOUDS} order. */
export function tradedClouds(spec: CloudTradeSpec): Cloud[] {
  return CLOUDS.filter((c) => spec[c] !== undefined);
}

/** Every identity a trade names: the role, the service account, the client id. */
export function tradeIdentities(spec: CloudTradeSpec): string[] {
  return [spec.aws?.role, spec.gcp?.serviceAccount, spec.azure?.clientId].filter((v): v is string => v !== undefined);
}

/**
 * The problems of a declared `ci.identity.cloud`, each with its JSON
 * pointer: a rule whose plan and apply are one identity, or a plan identity
 * that is another rule's apply identity. Either would let the plan job,
 * which runs the change's code, act as an apply identity.
 */
export function cloudIdentityProblems(decl: CloudIdentityDeclaration): Array<{ pointer: string; message: string }> {
  const out: Array<{ pointer: string; message: string }> = [];
  for (const cloud of CLOUDS) {
    const rules = decl[cloud]?.rules ?? [];
    const applies = new Set(rules.map((r) => r.apply));
    rules.forEach((r, i) => {
      const pointer = `/ci/identity/cloud/${cloud}/rules/${i}`;
      if (r.plan === r.apply) out.push({ pointer, message: `ci.identity.cloud.${cloud}.rules[${i}] plans and applies as ${r.plan}; the plan runs the pull request's code, so give it an identity of its own` });
      else if (applies.has(r.plan)) out.push({ pointer, message: `ci.identity.cloud.${cloud}.rules[${i}] plans as ${r.plan}, which another rule applies as; the plan runs the pull request's code, so give it an identity no rule applies as` });
    });
  }
  return out;
}

/** The variable the trade step reads its {@link CloudTradeSpec} from, as JSON. */
export const TRADE_SPEC_ENV = "CHANT_CLOUD_TRADE";

/** The GitLab `id_tokens` variable a cloud's token comes in: `CHANT_ID_TOKEN_AWS`, `_GCP`, `_AZURE`. */
export function idTokenVar(cloud: Cloud): string {
  return `CHANT_ID_TOKEN_${cloud.toUpperCase()}`;
}

/**
 * The variables a GitHub or Forgejo step requests an OIDC token with, and
 * the GitLab `id_tokens` variables the trade reads. A step that runs the
 * change's code starts without them, once the trade is done.
 */
export const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", ...CLOUDS.map(idTokenVar), TRADE_SPEC_ENV] as const;

/** The variables the trade sets, per cloud. */
export const TRADED_VARS: Record<Cloud, readonly string[]> = {
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"],
  gcp: ["GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN"],
  azure: ["AZURE_ACCESS_TOKEN", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "ARM_CLIENT_ID", "ARM_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "ARM_SUBSCRIPTION_ID"],
};

/**
 * How the trade leaves what it got. `github-env`: `NAME=value` lines
 * appended to the file argv 1 names (`$GITHUB_ENV`), and an `::add-mask::`
 * line for each secret, so every later step of the job has them. `sh`: a
 * file of `export` lines a GitLab script sources, mode 0600.
 */
export type TradeFormat = "github-env" | "sh";

/**
 * The trade, a script for `node -e` with no dependency, so it runs before
 * the checkout and reads none of the change's files. argv 1 is the file it
 * writes and argv 2 its {@link TradeFormat}; {@link TRADE_SPEC_ENV} is the
 * spec. The token comes from a cloud's {@link idTokenVar} when the job has
 * it (GitLab's `id_tokens`), else from the forge's request URL with the
 * cloud's audience. A value that holds anything but printable ASCII with no
 * space is refused, so no answer can add a line of its own to the file. The
 * script never prints a token.
 */
export const TRADE_JS = [
  'const fs=require("fs");',
  "const [out,format]=process.argv.slice(1);",
  "const Q=String.fromCharCode(39);",
  'const fail=(m)=>{console.error("chant: the OIDC trade failed: "+m);process.exit(1)};',
  `let spec;try{spec=JSON.parse(process.env.${TRADE_SPEC_ENV}||"")}catch{fail("${TRADE_SPEC_ENV} is not JSON")}`,
  'const clean=(v)=>typeof v==="string"&&/^[\\x21-\\x7e]+$/.test(v);',
  'const trim=(u)=>String(u).replace(/\\/+$/,"");',
  'const post=async(url,headers,body)=>{const r=await fetch(url,{method:"POST",headers,body});const t=await r.text();if(!r.ok)throw new Error(url+" answered "+r.status+": "+t.slice(0,200).replace(/\\s+/g," "));return t};',
  'const json=(t,what)=>{try{return JSON.parse(t)}catch{throw new Error(what+" answered with no JSON")}};',
  "const idToken=async(cloud,aud)=>{",
  'const named=process.env["CHANT_ID_TOKEN_"+cloud.toUpperCase()];if(named)return named;',
  "const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;",
  'if(!u||!k)throw new Error("the job can request no OIDC token for "+cloud+": it needs id-token: write, and a pull request from a fork gets none");',
  'const r=await fetch(u+(u.includes("?")?"&":"?")+"audience="+encodeURIComponent(aud),{headers:{authorization:"bearer "+k,accept:"application/json"}});',
  'if(!r.ok)throw new Error("the OIDC token request answered "+r.status);',
  'const v=json(await r.text(),"the OIDC token request").value;if(!clean(v))throw new Error("the OIDC token request gave no token");return v};',
  "const vars={},secrets=[],said=[];",
  "const run=async()=>{",
  "if(spec.aws){const a=spec.aws;const tok=await idToken(\"aws\",a.audience);",
  'const ep=trim(a.endpoint||process.env.AWS_ENDPOINT_URL_STS||("https://sts."+a.region+".amazonaws.com"+(a.region.startsWith("cn-")?".cn":"")));',
  'const t=await post(ep+"/",{"content-type":"application/x-www-form-urlencoded",accept:"application/xml"},new URLSearchParams({Action:"AssumeRoleWithWebIdentity",Version:"2011-06-15",RoleArn:a.role,RoleSessionName:"chant-"+(process.env.GITHUB_RUN_ID||process.env.CI_JOB_ID||"job"),WebIdentityToken:tok}).toString());',
  'const g=(k)=>{const m=new RegExp("<"+k+">([^<]+)</"+k+">").exec(t);return m?m[1].trim():undefined};',
  'const id=g("AccessKeyId"),key=g("SecretAccessKey"),st=g("SessionToken");if(!clean(id)||!clean(key)||!clean(st))throw new Error("STS gave no credentials for "+a.role);',
  'Object.assign(vars,{AWS_ACCESS_KEY_ID:id,AWS_SECRET_ACCESS_KEY:key,AWS_SESSION_TOKEN:st,AWS_REGION:a.region,AWS_DEFAULT_REGION:a.region});secrets.push(key,st);said.push(a.role)}',
  "if(spec.gcp){const c=spec.gcp;const tok=await idToken(\"gcp\",c.audience);",
  'const sts=trim(c.stsEndpoint||"https://sts.googleapis.com"),iam=trim(c.iamEndpoint||"https://iamcredentials.googleapis.com");',
  'const fed=json(await post(sts+"/v1/token",{"content-type":"application/json"},JSON.stringify({grantType:"urn:ietf:params:oauth:grant-type:token-exchange",audience:"//iam.googleapis.com/"+c.provider,scope:"https://www.googleapis.com/auth/cloud-platform",requestedTokenType:"urn:ietf:params:oauth:token-type:access_token",subjectToken:tok,subjectTokenType:"urn:ietf:params:oauth:token-type:jwt"})),"Google STS").access_token;',
  'if(!clean(fed))throw new Error("Google STS gave no token");',
  'const at=json(await post(iam+"/v1/projects/-/serviceAccounts/"+encodeURIComponent(c.serviceAccount)+":generateAccessToken",{"content-type":"application/json",authorization:"Bearer "+fed},JSON.stringify({scope:["https://www.googleapis.com/auth/cloud-platform"]})),"IAM credentials").accessToken;',
  'if(!clean(at))throw new Error("IAM credentials gave no token for "+c.serviceAccount);',
  "Object.assign(vars,{GOOGLE_OAUTH_ACCESS_TOKEN:at,CLOUDSDK_AUTH_ACCESS_TOKEN:at});secrets.push(at);said.push(c.serviceAccount)}",
  "if(spec.azure){const z=spec.azure;const tok=await idToken(\"azure\",z.audience);",
  'const host=trim(z.authority||"https://login.microsoftonline.com");',
  'const at=json(await post(host+"/"+encodeURIComponent(z.tenantId)+"/oauth2/v2.0/token",{"content-type":"application/x-www-form-urlencoded"},new URLSearchParams({client_id:z.clientId,scope:"https://management.azure.com/.default",grant_type:"client_credentials",client_assertion_type:"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",client_assertion:tok}).toString()),"Entra").access_token;',
  'if(!clean(at))throw new Error("Entra gave no token for "+z.clientId);',
  "Object.assign(vars,{AZURE_ACCESS_TOKEN:at,AZURE_CLIENT_ID:z.clientId,AZURE_TENANT_ID:z.tenantId,ARM_CLIENT_ID:z.clientId,ARM_TENANT_ID:z.tenantId});",
  "if(z.subscriptionId)Object.assign(vars,{AZURE_SUBSCRIPTION_ID:z.subscriptionId,ARM_SUBSCRIPTION_ID:z.subscriptionId});secrets.push(at);said.push(z.clientId)}",
  'for(const [k,v] of Object.entries(vars))if(!clean(v))throw new Error(k+" is not a value the job can hold");',
  'if(format==="github-env"){for(const s of secrets)console.log("::add-mask::"+s);fs.appendFileSync(out,Object.entries(vars).map(([k,v])=>k+"="+v+"\\n").join(""))}',
  'else fs.writeFileSync(out,Object.entries(vars).map(([k,v])=>"export "+k+"="+Q+v.split(Q).join(Q+"\\\\"+Q+Q)+Q+"\\n").join(""),{mode:0o600});',
  'for(const s of said)console.error("chant: traded the job\\u0027s OIDC token for "+s)};',
  "run().catch((e)=>fail(e&&e.message?e.message:String(e)));",
].join("");

/**
 * The shell line of a trade step: `node -e` from `/`, so no file of the
 * checkout (a `package.json`, an `.npmrc`) is in reach, writing `out` in
 * `format`.
 */
export function tradeLine(out: string, format: TradeFormat): string {
  return `(cd / && node -e '${TRADE_JS}' "${out}" ${format})`;
}

/** The GitLab file the trade writes and the plan script sources, outside the project directory. */
export const GITLAB_TRADE_FILE = "${TMPDIR:-/tmp}/chant-cloud-$CI_JOB_ID.sh";

/**
 * The lines a GitLab job's script starts with when it trades: the trade,
 * the unset of the token variables (and, with `extraUnset`, the forge
 * tokens'), and the source of what the trade wrote, which it then deletes.
 */
export function gitlabTradeLines(extraUnset: readonly string[] = []): string[] {
  return [
    tradeLine(GITLAB_TRADE_FILE, "sh"),
    `unset ${[...extraUnset, ...OIDC_REQUEST_VARS].join(" ")}`,
    `. "${GITLAB_TRADE_FILE}" && rm -f "${GITLAB_TRADE_FILE}"`,
  ];
}

/** GitLab's `id_tokens:` for a trade: one per cloud, with the cloud's audience. */
export function gitlabTradeIdTokens(spec: CloudTradeSpec): Record<string, { aud: string }> {
  return Object.fromEntries(tradedClouds(spec).map((c) => [idTokenVar(c), { aud: spec[c]!.audience }]));
}
