/**
 * Cloud login steps from the OIDC token file (#4788): a CI job's step that
 * writes the forge's OIDC token to a file and points each cloud's own tools
 * at it, for AWS, GCP and Azure, on GitHub, GitLab and Forgejo.
 *
 * ./ci-identity.ts trades the token for short-lived credentials before the
 * checkout. This is the other way a CI product logs in: the job keeps the
 * token in a file and the cloud's SDK, command line or Terraform provider
 * trades it itself, again whenever its credentials run out. That is what
 * the AWS SDKs' web identity provider, Google's `external_account`
 * credentials and the azurerm provider's OIDC read, and what terragucci's
 * `oidcScript`, `gcpScript` and `azureScript` and SQL Yodeler's Forgejo
 * login wrote for themselves.
 *
 * The step runs {@link LOGIN_JS} with `node -e` from `/`, so it reads none
 * of the checkout's files and needs nothing installed. Per cloud it takes
 * the token from, in order: the cloud's `tokenFile`, a file the runner
 * provides (left where it is, so a runner that refreshes it keeps the job
 * logged in); the GitLab `id_tokens` variable {@link idTokenVar}; the forge's
 * token request URL with the cloud's audience (GitHub, and Forgejo 15 with
 * Forgejo Runner 12.5 and `enable-openid-connect: true`). A token it got
 * goes to a file of its own under `RUNNER_TEMP` (else `TMPDIR`, else
 * `/tmp`), mode 0600. Then it sets:
 *
 *   AWS    AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_SESSION_NAME,
 *          with `region` AWS_REGION and AWS_DEFAULT_REGION (else the job
 *          keeps its own, #4930), and AWS_ENDPOINT_URL_STS with
 *          `endpoint`. With no role the job gets the token file and the
 *          session name alone, for a tool that assumes its own roles,
 *          such as Terragrunt's `credentials` (#4930)
 *   GCP    GOOGLE_APPLICATION_CREDENTIALS and
 *          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, an `external_account`
 *          file per service account that trades the token at Google's STS
 *          and impersonates the account
 *   Azure  AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
 *          (the Azure SDKs), ARM_USE_OIDC, ARM_CLIENT_ID, ARM_TENANT_ID,
 *          ARM_OIDC_TOKEN_FILE_PATH (azurerm), the subscription in
 *          AZURE_SUBSCRIPTION_ID and ARM_SUBSCRIPTION_ID, and with `cli`
 *          `az login --federated-token` for the `az` command line
 *
 * gcloud reads CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, so it needs no
 * `gcloud auth login`. On GitHub and Forgejo the variables go to
 * `$GITHUB_ENV`, which later steps read; on GitLab the script evaluates the
 * `export` lines the login prints, which name files and hold no token, then
 * unsets the token variables and the spec. No file of variables is left to
 * delete. With {@link CloudLoginOptions.sameStep} every forge takes the
 * GitLab form, so the step that logs in can run the tool too (#4930).
 *
 * Per target and per stage: the spec is a {@link CloudTradeSpec} without
 * Pulumi, the plan or apply side of what `resolveCloudIdentity` gives, so a
 * product passes the stage's own. A cloud's `targets` name the identities
 * other targets take (#4332). The step then writes the
 * {@link CLOUD_TARGETS_ENV} file the trade writes, each identity's
 * variables in it, and a product hands each target's tool its own with
 * `targetCloudEnv`, as after the trade. The login sets no
 * `CLOUD_TRADED_ENV`, which the trade does, so a product tells the login's
 * targets file from a trade's (#4930).
 *
 * The functions return {@link OpWaveRunStep}s and the job's `idTokens`, the
 * shape `OpWavesPipelineOptions.waveJobs[].before` and `recordPlans` take
 * (#4791), so a product passes the login to chant's generators instead of
 * writing it into their files.
 */

import {
  CLOUD_TARGETS_ENV,
  IDENTITY_KEY,
  idTokenVar,
  type Cloud,
  type CloudTradeSpec,
} from "./ci-identity";
import type { OpWaveRunStep } from "./lexicon";

/** The variable the login step reads its {@link CloudLoginSpec} from, as JSON. */
export const LOGIN_SPEC_ENV = "CHANT_CLOUD_LOGIN";

/** The forges a login step is rendered for. */
export type LoginForge = "github" | "gitlab" | "forgejo";

/** What a cloud's login may add to its trade spec: a token file the runner provides. */
interface TokenFileOption {
  /**
   * A file holding the job's OIDC token for this cloud, which the runner
   * provides, such as a Forgejo runner's own. A leading `$NAME` or
   * `${NAME}` is the job's variable. The job then requests no token for
   * this cloud.
   */
  tokenFile?: string;
}

/** One job's login, per cloud: a {@link CloudTradeSpec}'s AWS, GCP and Azure parts, with defaults, and the login's own options. */
export interface CloudLoginSpec {
  aws?: Omit<NonNullable<CloudTradeSpec["aws"]>, "region" | "audience"> &
    TokenFileOption & {
      /** AWS_REGION and AWS_DEFAULT_REGION. Unset: the job keeps its own region (#4930). */
      region?: string;
      /** The token's audience. Default `sts.amazonaws.com`. */
      audience?: string;
      /** AWS_ROLE_SESSION_NAME, 2 to 64 of letters, digits and `+=,.@_-`. Default `chant`. */
      sessionName?: string;
    };
  gcp?: Omit<NonNullable<CloudTradeSpec["gcp"]>, "audience"> &
    TokenFileOption & {
      /** The token's audience. Default `https://iam.googleapis.com/<provider>`. */
      audience?: string;
    };
  azure?: Omit<NonNullable<CloudTradeSpec["azure"]>, "audience" | "database"> &
    TokenFileOption & {
      /** The token's audience. Default `api://AzureADTokenExchange`. */
      audience?: string;
      /** Also `az login --service-principal --federated-token` as the job's own client, for the `az` command line. Default false. */
      cli?: boolean;
    };
}

/** How a login is rendered. */
export interface CloudLoginOptions {
  /**
   * The login's variables in the step that runs it (#4930). GitHub and
   * Forgejo then evaluate the `export` lines the login prints, as GitLab
   * does, and nothing goes to `$GITHUB_ENV`: a product that logs in and
   * runs its tool in one step (terragucci's, after it fetched its tokens
   * and restarted the step without the token request variables) puts
   * `steps[0].run` in that step. The lines stop the step on a failed login
   * with `|| exit 1`, for a script that runs with `-e` off. Default false.
   */
  sameStep?: boolean;
}

/** A job's login: its steps, and the OIDC tokens the job requests. */
export interface CloudLoginSteps {
  /**
   * The steps, in order. GitHub and Forgejo: each one `run:` step, its lines
   * joined by newlines. GitLab, and any forge with `sameStep`: their lines
   * in the job's script or step.
   */
  steps: OpWaveRunStep[];
  /**
   * The tokens the job requests, `{ <variable>: <audience> }`, as
   * `recordPlans.idTokens` and a wave's `idTokens` take them: GitLab
   * `id_tokens:`, and on GitHub and Forgejo the job's `id-token: write`
   * (Forgejo `enable-openid-connect: true`). Empty when every cloud names a
   * `tokenFile`.
   */
  idTokens: Record<string, string>;
}

const LOGIN_CLOUDS = ["aws", "gcp", "azure"] as const satisfies readonly Cloud[];

/** The provider's resource name without the `//iam.googleapis.com/` prefix, as ci-identity reads it. */
const providerPath = (p: string): string => p.replace(/^(https:)?\/\/iam\.googleapis\.com\//, "");

/** A value the login writes to a job's environment: printable ASCII with no space or quote. */
const SAFE = /^[\x21-\x7e]+$/;
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;
const TOKEN_FILE = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)?[\w./-]+$/;

/** `spec` with every default filled, as the login script reads it, refused when a value cannot be held by the job. */
export function cloudLoginSpec(spec: CloudLoginSpec): CloudLoginSpec {
  const extra = Object.keys(spec).filter((k) => !(LOGIN_CLOUDS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`a cloud login covers ${LOGIN_CLOUDS.join(", ")}; ${extra.join(", ")} ${extra.includes("pulumi") ? "(Pulumi Cloud) is traded, with ci-identity's trade step" : "is no cloud it knows"}`);
  if ((spec.azure as { database?: unknown } | undefined)?.database) throw new Error("a cloud login gives Azure no database token: trade the token with ci-identity's trade step for azure.database");
  const out: CloudLoginSpec = {};
  // #4930: no default region, so the job's own stays. A named one stays where the spec put it, so the step renders as before.
  if (spec.aws) out.aws = { ...spec.aws, audience: spec.aws.audience ?? "sts.amazonaws.com" };
  if (spec.gcp) {
    const provider = providerPath(spec.gcp.provider);
    out.gcp = { ...spec.gcp, provider, audience: spec.gcp.audience ?? `https://iam.googleapis.com/${provider}` };
  }
  if (spec.azure) out.azure = { ...spec.azure, audience: spec.azure.audience ?? "api://AzureADTokenExchange" };
  for (const cloud of LOGIN_CLOUDS) {
    const c = out[cloud] as (Record<string, unknown> & { targets?: Array<Record<string, unknown>> }) | undefined;
    if (!c) continue;
    const key = IDENTITY_KEY[cloud];
    const ids = [c[key], ...(c.targets ?? []).map((t) => t[key])].filter((v) => v !== undefined);
    // #4930: AWS with no role is the token file alone. GCP's credential file and Azure's variables name an identity.
    if (ids.length === 0 && cloud !== "aws") throw new Error(`the ${cloud} login names no identity: give it ${key}, or targets`);
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === "string" && !SAFE.test(v)) throw new Error(`the ${cloud} login's ${k} is ${JSON.stringify(v)}; a job holds printable ASCII with no space`);
    }
    for (const id of ids) if (typeof id !== "string" || !SAFE.test(id)) throw new Error(`the ${cloud} login's identity ${JSON.stringify(id)} is not one a job can hold`);
    if (c.tokenFile !== undefined && !TOKEN_FILE.test(String(c.tokenFile))) throw new Error(`the ${cloud} login's tokenFile ${JSON.stringify(c.tokenFile)} is not a file path`);
  }
  if (out.aws?.sessionName !== undefined && !SESSION_NAME.test(out.aws.sessionName)) throw new Error(`the aws login's sessionName ${JSON.stringify(out.aws.sessionName)} is not 2 to 64 of letters, digits and +=,.@_-`);
  if (out.azure?.cli && !out.azure.clientId) throw new Error("the azure login's cli logs the az command line in as the job's own client, so it needs clientId");
  return out;
}

/**
 * The login, a script for `node -e` with no dependency. argv 1 is the file
 * it writes, argv 2 its format (`github-env` appends `NAME=value` lines to
 * the file; `sh` prints `export` lines, and argv 1 is `-`), argv 3 the forge, for what a job
 * with no token is told. {@link LOGIN_SPEC_ENV} is the spec, defaults filled
 * ({@link cloudLoginSpec}). It never prints a token.
 */
export const LOGIN_JS = [
  'const fs=require("fs"),crypto=require("crypto");',
  "const [out,format,forge]=process.argv.slice(1);",
  "const Q=String.fromCharCode(39);",
  'const fail=(m)=>{console.error("chant: the cloud login failed: "+m);process.exit(1)};',
  `let spec;try{spec=JSON.parse(process.env.${LOGIN_SPEC_ENV}||"")}catch{fail("${LOGIN_SPEC_ENV} is not JSON")}`,
  'const clean=(v)=>typeof v==="string"&&/^[\\x21-\\x7e]+$/.test(v);',
  'const trim=(u)=>String(u).replace(/\\/+$/,"");',
  'const tmp=trim(process.env.RUNNER_TEMP||process.env.TMPDIR||"/tmp");',
  'const rand=()=>crypto.randomBytes(8).toString("hex");',
  'const NO={github:"it needs permissions: id-token: write, and a pull request from a fork gets none",forgejo:"Forgejo serves one from version 15, with Forgejo Runner 12.5 or later, to a job with enable-openid-connect: true; on an older Forgejo give the cloud a tokenFile the runner provides"};',
  // A cloud's token: the runner's file, else GitLab's id_tokens variable, else the forge's request URL, into a file of its own.
  "const tokenFile=async(cloud,s)=>{",
  'if(s.tokenFile){const f=s.tokenFile.replace(/^\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?/,(m,v)=>process.env[v]||"");let t;try{t=fs.readFileSync(f,"utf8").trim()}catch{throw new Error(cloud+"\\u0027s tokenFile "+f+" cannot be read")}if(!t)throw new Error(cloud+"\\u0027s tokenFile "+f+" is empty");return f}',
  'const name="CHANT_ID_TOKEN_"+cloud.toUpperCase();let v=process.env[name];',
  'if(!v){if(forge==="gitlab")throw new Error("the job has no "+name+": it needs id_tokens: "+name+": aud: "+s.audience);',
  "const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;",
  'if(!u||!k)throw new Error("the job can request no OIDC token for "+cloud+": "+(NO[forge]||NO.github));',
  'const r=await fetch(u+(u.includes("?")?"&":"?")+"audience="+encodeURIComponent(s.audience),{headers:{authorization:"bearer "+k,accept:"application/json"}});',
  'if(!r.ok)throw new Error("the OIDC token request answered "+r.status);',
  'try{v=JSON.parse(await r.text()).value}catch{throw new Error("the OIDC token request answered with no JSON")}}',
  'if(!clean(v))throw new Error("the job\\u0027s OIDC token for "+cloud+" is not a token");',
  'const f=tmp+"/chant-oidc-"+cloud+"-"+rand();fs.writeFileSync(f,v,{mode:0o600,flag:"wx"});return f};',
  `const KEY=${JSON.stringify(IDENTITY_KEY)};`,
  'const ids=(c)=>{const s=spec[c],l=[];if(s[KEY[c]])l.push(s[KEY[c]]);for(const t of s.targets||[])if(!l.includes(t[KEY[c]]))l.push(t[KEY[c]]);return l};',
  "const vars={},said=[],by={};",
  "const run=async()=>{",
  'if(spec.aws){const a=spec.aws;const f=await tokenFile("aws",a);by.aws={};',
  // #4930: the region only when the spec names one; with no role of the job's own, the token file and session name alone.
  'const base={AWS_WEB_IDENTITY_TOKEN_FILE:f,AWS_ROLE_SESSION_NAME:a.sessionName||"chant",...(a.region?{AWS_REGION:a.region,AWS_DEFAULT_REGION:a.region}:{}),...(a.endpoint?{AWS_ENDPOINT_URL_STS:trim(a.endpoint)}:{})};',
  'for(const role of ids("aws")){by.aws[role]={AWS_ROLE_ARN:role,...base};said.push(role)}',
  'if(a.role)Object.assign(vars,by.aws[a.role]);else{Object.assign(vars,base);console.error("chant: wrote the aws OIDC token file, with no role of the job\\u0027s own")}}',
  'if(spec.gcp){const c=spec.gcp;const f=await tokenFile("gcp",c);by.gcp={};',
  'const sts=trim(c.stsEndpoint||"https://sts.googleapis.com"),iam=trim(c.iamEndpoint||"https://iamcredentials.googleapis.com");',
  'for(const sa of ids("gcp")){const cf=tmp+"/chant-gcp-"+rand()+".json";',
  'fs.writeFileSync(cf,JSON.stringify({type:"external_account",audience:"//iam.googleapis.com/"+c.provider,subject_token_type:"urn:ietf:params:oauth:token-type:jwt",token_url:sts+"/v1/token",service_account_impersonation_url:iam+"/v1/projects/-/serviceAccounts/"+sa+":generateAccessToken",credential_source:{file:f}})+"\\n",{mode:0o600,flag:"wx"});',
  "by.gcp[sa]={GOOGLE_APPLICATION_CREDENTIALS:cf,CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:cf};said.push(sa)}",
  "if(c.serviceAccount)Object.assign(vars,by.gcp[c.serviceAccount])}",
  'if(spec.azure){const z=spec.azure;const f=await tokenFile("azure",z);by.azure={};',
  "for(const cid of ids(\"azure\")){by.azure[cid]={AZURE_CLIENT_ID:cid,AZURE_TENANT_ID:z.tenantId,AZURE_FEDERATED_TOKEN_FILE:f,ARM_USE_OIDC:\"true\",ARM_CLIENT_ID:cid,ARM_TENANT_ID:z.tenantId,ARM_OIDC_TOKEN_FILE_PATH:f,...(z.subscriptionId?{AZURE_SUBSCRIPTION_ID:z.subscriptionId,ARM_SUBSCRIPTION_ID:z.subscriptionId}:{}),...(z.authority?{AZURE_AUTHORITY_HOST:trim(z.authority)}:{})};said.push(cid)}",
  "if(z.clientId)Object.assign(vars,by.azure[z.clientId]);",
  // The az command line keeps a login of its own; the token goes on its argv, as `az login` takes it.
  'if(z.cli){const r=require("child_process").spawnSync("az",["login","--service-principal","--username",z.clientId,"--tenant",z.tenantId,"--federated-token",fs.readFileSync(f,"utf8").trim(),"--allow-no-subscriptions","--output","none"],{stdio:["ignore","ignore","inherit"]});',
  'if(r.error)throw new Error("az login could not run: "+r.error.message);if(r.status!==0)throw new Error("az login exited "+r.status);',
  'if(z.subscriptionId){const s=require("child_process").spawnSync("az",["account","set","--subscription",z.subscriptionId],{stdio:["ignore","ignore","inherit"]});if(s.status!==0)throw new Error("az account set exited "+s.status)}}}',
  // #4332: with targets, every identity's variables go in the trade's targets file, which targetCloudEnv reads.
  'const clouds=Object.keys(by);if(clouds.some((c)=>(spec[c].targets||[]).length>0)){',
  'const doc={version:1,clouds:{}};for(const c of clouds){const s=spec[c];doc.clouds[c]={...(s[KEY[c]]?{default:s[KEY[c]]}:{}),targets:(s.targets||[]).map((t)=>({targets:t.targets,identity:t[KEY[c]]})),vars:by[c]}}',
  `const tf=tmp+"/chant-cloud-targets-"+rand()+".json";fs.writeFileSync(tf,JSON.stringify(doc),{mode:0o600,flag:"wx"});vars.${CLOUD_TARGETS_ENV}=tf}`,
  'for(const [k,v] of Object.entries(vars))if(!clean(v))throw new Error(k+" is not a value the job can hold");',
  'if(format==="github-env")fs.appendFileSync(out,Object.entries(vars).map(([k,v])=>k+"="+v+"\\n").join(""));',
  'else process.stdout.write(Object.entries(vars).map(([k,v])=>"export "+k+"="+Q+v.split(Q).join(Q+"\\\\"+Q+Q)+Q+"\\n").join(""));',
  'for(const s of said)console.error("chant: logged in from the OIDC token file as "+s)};',
  "run().catch((e)=>fail(e&&e.message?e.message:String(e)));",
].join("");

const sh = (s: string): string => `'${s.split("'").join(`'\\''`)}'`;

/** The tokens a login's job requests: one per cloud with no `tokenFile`, with the cloud's audience. */
function loginIdTokens(spec: CloudLoginSpec): Record<string, string> {
  return Object.fromEntries(LOGIN_CLOUDS.filter((c) => spec[c] && spec[c]!.tokenFile === undefined).map((c) => [idTokenVar(c), spec[c]!.audience!]));
}

/** The step's name: which clouds it logs in to. */
const stepName = (spec: CloudLoginSpec): string => `Cloud login (chant ci-login: ${LOGIN_CLOUDS.filter((c) => spec[c]).join(", ")})`;

/** The shell line that runs the login from `/`, writing `out` in `format`. */
export function loginLine(out: string, format: "github-env" | "sh", forge: LoginForge): string {
  return `(cd / && node -e '${LOGIN_JS}' "${out}" ${format} ${forge})`;
}

/**
 * The lines that log in and evaluate the variables in the shell that runs
 * them, then unset what held them and `unset`: GitLab's script, and with
 * `sameStep` (#4930) any forge's step. `exit` stops a script with `-e` off.
 */
function shellLines(spec: CloudLoginSpec, forge: LoginForge, unset: readonly string[], exit: boolean): string[] {
  return [
    `export ${LOGIN_SPEC_ENV}=${sh(JSON.stringify(spec))}`,
    // An assignment's status is its command substitution's, so a failed login stops the script.
    `${GITLAB_LOGIN_VARS}="$${loginLine("-", "sh", forge)}"${exit ? " || exit 1" : ""}`,
    `eval "$${GITLAB_LOGIN_VARS}"`,
    `unset ${[GITLAB_LOGIN_VARS, LOGIN_SPEC_ENV, ...unset].join(" ")}`,
  ];
}

/** A GitHub Actions or Forgejo Actions login: one step that appends the variables to `$GITHUB_ENV`, or with `sameStep` exports them in its own shell. */
function actionsLogin(forge: "github" | "forgejo", given: CloudLoginSpec, options: CloudLoginOptions = {}): CloudLoginSteps {
  const spec = cloudLoginSpec(given);
  if (Object.keys(spec).length === 0) return { steps: [], idTokens: {} };
  if (options.sameStep) return { steps: [{ name: stepName(spec), run: shellLines(spec, forge, [], true) }], idTokens: loginIdTokens(spec) };
  return {
    steps: [{ name: stepName(spec), run: [`export ${LOGIN_SPEC_ENV}=${sh(JSON.stringify(spec))}`, loginLine("$GITHUB_ENV", "github-env", forge)] }],
    idTokens: loginIdTokens(spec),
  };
}

/**
 * A GitHub Actions job's cloud login (#4788): one step that requests the
 * OIDC token per cloud, writes each to a file and appends the clouds'
 * variables to `$GITHUB_ENV`, so every later step has them. The job needs
 * `id-token: write`, which `idTokens` asks chant's generators for.
 */
export function githubCloudLogin(spec: CloudLoginSpec, options?: CloudLoginOptions): CloudLoginSteps {
  return actionsLogin("github", spec, options);
}

/**
 * A Forgejo Actions job's cloud login (#4788), as on GitHub. Forgejo 15 with
 * Forgejo Runner 12.5 serves the token to a job with
 * `enable-openid-connect: true`, which the forgejo lexicon sets for a job
 * that asks for `id-token: write`. On an older Forgejo, give each cloud a
 * `tokenFile` the runner provides; the job then requests none.
 */
export function forgejoCloudLogin(spec: CloudLoginSpec, options?: CloudLoginOptions): CloudLoginSteps {
  return actionsLogin("forgejo", spec, options);
}

/** The variable the login's `export` lines are kept in until the script evaluates them: GitLab's, and with `sameStep` any forge's (#4930). */
export const GITLAB_LOGIN_VARS = "CHANT_CLOUD_LOGIN_VARS";

/**
 * A GitLab CI job's cloud login (#4788): script lines that write each
 * cloud's `id_tokens` token to a file, evaluate the clouds' variables, and
 * unset the token variables and the spec, so later lines hold the token
 * only in its file. The job's `id_tokens:` are `idTokens`, each
 * `{ aud: <audience> }`.
 */
export function gitlabCloudLogin(given: CloudLoginSpec, options: CloudLoginOptions = {}): CloudLoginSteps {
  const spec = cloudLoginSpec(given);
  if (Object.keys(spec).length === 0) return { steps: [], idTokens: {} };
  const idTokens = loginIdTokens(spec);
  // A GitLab script is one shell already; sameStep adds `|| exit 1`, for a script with -e off.
  return { steps: [{ name: stepName(spec), run: shellLines(spec, "gitlab", Object.keys(idTokens), options.sameStep === true) }], idTokens };
}

/** A job's cloud login on `forge` (#4788): {@link githubCloudLogin}, {@link gitlabCloudLogin} or {@link forgejoCloudLogin}. */
export function cloudLogin(forge: LoginForge, spec: CloudLoginSpec, options?: CloudLoginOptions): CloudLoginSteps {
  return forge === "gitlab" ? gitlabCloudLogin(spec, options) : actionsLogin(forge, spec, options);
}

