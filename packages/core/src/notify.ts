/**
 * Notify (#3761): tell people that a wave waits for an approval, that a run
 * was refused or failed, or that drift was found.
 *
 * terragucci and SQL Yodeler each carried a copy of this (#3756). chant owns
 * the event, its signing and the Slack and Teams posting; a product decides
 * when to send and what its summary says. One event shape,
 * `chant.notify/v1` (`./notify.schema.json`), carries what both send: the
 * wave or environment, the targets concerned, the plan digest, the command
 * that approves it and the run's link.
 *
 * ```ts
 * import { makeNotifyEvent, sendNotify } from "@intentius/chant/notify";
 *
 * const event = makeNotifyEvent({ source: "sql-yodeler", event: "waiting", summary: "prod waits for an approval", targets: ["0007_add_index"], digest, approve: { command } });
 * await sendNotify({ webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY", slack: "SLACK_WEBHOOK_URL" }, event);
 * ```
 *
 * The configuration names environment variables, never URLs or keys, and
 * nothing here prints a URL or a key. The generic webhook gets the event as
 * JSON, signed over `<timestamp>.<body>` (`./notify-verify.ts`); it is never
 * posted unsigned. Slack and Teams incoming webhooks get a message rendered
 * from the event, unsigned, since neither checks a signature. A delivery that
 * fails is logged and returned; {@link sendNotify} never throws, so a
 * caller's exit code never depends on it.
 *
 * Bundle-safe: this module reaches only `node:crypto` and
 * `./notify-verify.ts` (`./notify-bundle.test.ts`).
 */

import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_HEADER_PREFIX, signWebhook, webhookHeaderNames } from "./notify-verify";

export { DEFAULT_HEADER_PREFIX, DEFAULT_TOLERANCE_SECONDS, signWebhook, verifyWebhook, webhookHeaderNames } from "./notify-verify";
export type { VerifyWebhookInput, VerifyWebhookResult, WebhookHeaders } from "./notify-verify";

/** The event's `schema` value. A field is only ever added within a version. */
export const NOTIFY_SCHEMA = "chant.notify/v1";
/** The JSON Schema's `$id`. */
export const NOTIFY_SCHEMA_ID = "https://intentius.io/chant/schemas/notify/v1/notify.schema.json";

/** What happened. */
export const NOTIFY_EVENTS = ["waiting", "refused", "failed", "drift"] as const;
export type NotifyEventKind = (typeof NOTIFY_EVENTS)[number];

/** Where the run is: the CI run's page, the forge, the repository and commit. */
export interface NotifyRun {
  url?: string;
  forge?: "github" | "gitlab" | "forgejo";
  /** owner/name on GitHub and Forgejo, the project path on GitLab. */
  repository?: string;
  commit?: string;
  /** The pull or merge request the run is for, when there is one. */
  pr?: number;
}

/** `chant.notify/v1`. The JSON Schema is `./notify.schema.json`. */
export interface NotifyEvent {
  schema: typeof NOTIFY_SCHEMA;
  /** The same for every send of one event about one digest (or drift fingerprint, or commit), so a receiver can drop a repeat. Random when there is none. */
  id: string;
  event: NotifyEventKind;
  /** When it was sent, ISO 8601 UTC. */
  at: string;
  /** The product that sent it: `chant`, `terragucci`, `sql-yodeler`. */
  source: string;
  /** What the run belongs to: the repository, or a name the product gives. */
  project: string;
  /** One line a person can read. */
  summary: string;
  /** The wave, for a product that applies in waves. */
  wave?: { number: number; name?: string; gate?: string };
  /** The environment, for a product that applies per environment. */
  environment?: string;
  /** What the event concerns: the wave's roots or runs, the pending migrations. Empty when the product names none. */
  targets: string[];
  /** The plan digest an approval binds. */
  digest?: string;
  /** On `waiting`: how a person approves it. */
  approve?: {
    /** The command to run, as the product prints it. */
    command: string;
    /** chant's own command for the same approval, when the product's differs. */
    chant?: string;
    /** Under `pr-review`: the pull request whose approving review would approve it. */
    review?: { pr: number; url: string };
  };
  /** The product's own word for the outcome (`gated`, `denied`, `incomplete`). */
  status?: string;
  /** On `refused` and `failed`: why. */
  reason?: string;
  /** The exit code the run ended with. */
  exitCode?: number;
  /** On `drift`: what moved. */
  drift?: { changed: string[]; missing?: string[]; failed?: string[]; fingerprint?: string };
  run?: NotifyRun;
  /** A report page for the run. */
  reportUrl?: string;
  /** The product's own record of the outcome, carried whole for programs that know it. */
  detail?: Record<string, unknown>;
}

/** What a product fills in; {@link makeNotifyEvent} adds the rest. */
export type NotifyFields = Omit<NotifyEvent, "schema" | "id" | "at" | "project" | "targets" | "run"> & {
  id?: string;
  project?: string;
  targets?: string[];
  run?: NotifyRun;
};

/** The CI run, from its environment: GitHub Actions, Forgejo Actions or GitLab CI. */
export function ciRun(env: NodeJS.ProcessEnv): NotifyRun {
  const out: NotifyRun = {};
  if (env.CI_JOB_URL) out.url = env.CI_JOB_URL;
  else if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) out.url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  else if (env.CI_PIPELINE_URL) out.url = env.CI_PIPELINE_URL;
  if (env.GITLAB_CI === "true") out.forge = "gitlab";
  else if (env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true") out.forge = "forgejo";
  else if (env.GITHUB_ACTIONS === "true") out.forge = "github";
  const repository = env.GITHUB_REPOSITORY || env.CI_PROJECT_PATH;
  if (repository) out.repository = repository;
  const commit = env.GITHUB_SHA || env.CI_COMMIT_SHA;
  if (commit) out.commit = commit;
  return out;
}

/**
 * A whole event: the fields, with the schema, the time, the CI run (the
 * product's own `run` fields win) and an id. The id is a hash over the
 * source, project, event, wave, environment and digest (else the drift
 * fingerprint, else the commit), so a re-run sends the same id; with none of
 * the three it is random.
 */
export function makeNotifyEvent(fields: NotifyFields, options: { env?: NodeJS.ProcessEnv; now?: Date } = {}): NotifyEvent {
  const env = options.env ?? process.env;
  const { id: given, project, targets, run: own, ...rest } = fields;
  const run = { ...ciRun(env), ...(own ?? {}) };
  const resolvedProject = project ?? run.repository ?? "this project";
  const key = fields.digest ?? fields.drift?.fingerprint ?? run.commit;
  const id =
    given ??
    (key
      ? createHash("sha256").update(JSON.stringify([fields.source, resolvedProject, fields.event, fields.wave?.number ?? null, fields.environment ?? null, key])).digest("hex")
      : randomUUID());
  return {
    schema: NOTIFY_SCHEMA,
    id,
    at: (options.now ?? new Date()).toISOString(),
    ...rest,
    project: resolvedProject,
    targets: targets ?? [],
    ...(Object.keys(run).length > 0 ? { run } : {}),
  };
}

const HEADLINE: Record<NotifyEventKind, string> = {
  waiting: "waits for an approval",
  refused: "was refused",
  failed: "failed",
  drift: "drifted",
};

/** The first line of every chat message: `<source>: <summary>`, or what happened to what when there is no summary. */
export function notifyHeadline(e: NotifyEvent): string {
  if (e.summary) return `${e.source}: ${e.summary}`;
  const what = e.wave ? `wave ${e.wave.number}${e.wave.name ? ` (${e.wave.name})` : ""} of ${e.project}` : e.environment ? `${e.environment} in ${e.project}` : e.project;
  return `${e.source}: ${what} ${HEADLINE[e.event]}`;
}

/** The label and value lines both chat messages show, in order. */
function facts(e: NotifyEvent): { title: string; value: string; link?: string }[] {
  const out: { title: string; value: string; link?: string }[] = [];
  if (e.approve?.review) out.push({ title: "Review and approve", value: `pull request ${e.approve.review.pr}, then run it again`, link: e.approve.review.url });
  if (e.drift) {
    if (e.drift.changed.length > 0) out.push({ title: "Drifted", value: e.drift.changed.join(", ") });
    if (e.drift.missing?.length) out.push({ title: "Missing", value: e.drift.missing.join(", ") });
    if (e.drift.failed?.length) out.push({ title: "Not refreshed", value: e.drift.failed.join(", ") });
  } else if (e.targets.length > 0) out.push({ title: "Targets", value: e.targets.join(", ") });
  if (e.digest) out.push({ title: "Digest", value: e.digest });
  if (e.approve) out.push({ title: e.approve.review ? "Or approve" : "Approve", value: e.approve.command });
  if (e.reason) out.push({ title: "Reason", value: e.reason });
  if (e.run?.url) out.push({ title: "Run", value: e.run.url, link: e.run.url });
  if (e.reportUrl) out.push({ title: "Report", value: e.reportUrl, link: e.reportUrl });
  return out;
}

/** A Slack incoming webhook's body: one mrkdwn text, with the approve command as code and the links as links. */
export function slackMessage(e: NotifyEvent): { text: string } {
  const lines = [`*${notifyHeadline(e)}*`];
  for (const f of facts(e)) {
    if (f.title === "Review and approve") lines.push(`${f.title}: <${f.link}|pull request ${e.approve!.review!.pr}>, then run it again`);
    else if (f.title === "Approve" || f.title === "Or approve" || f.title === "Digest") lines.push(`${f.title}: \`${f.value}\``);
    else if (f.link) lines.push(`${f.title}: <${f.link}>`);
    else lines.push(`${f.title}: ${f.value}`);
  }
  return { text: lines.join("\n") };
}

/** A Teams incoming webhook's body (a Workflows webhook): one Adaptive Card, with buttons that open the review page and the run. */
export function teamsMessage(e: NotifyEvent): Record<string, unknown> {
  const all = facts(e);
  const actions = [
    ...(e.approve?.review ? [{ type: "Action.OpenUrl", title: "Review and approve", url: e.approve.review.url }] : []),
    ...(e.run?.url ? [{ type: "Action.OpenUrl", title: "Open the run", url: e.run.url }] : []),
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: notifyHeadline(e), weight: "Bolder", wrap: true },
            { type: "FactSet", facts: all.map((f) => ({ title: f.title, value: f.link && f.title === "Review and approve" ? `${f.value}: ${f.link}` : f.value })) },
          ],
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}

/** Where events go. Each value is the NAME of an environment variable; the configuration never holds a URL or a key. */
export interface NotifyConfig {
  /** The variable holding the generic webhook's URL. */
  webhook?: string;
  /** The variable holding the key the webhook's events are signed with. Required with `webhook`. */
  key?: string;
  /** The variable holding a Slack incoming webhook's URL. */
  slack?: string;
  /** The variable holding a Microsoft Teams incoming webhook's (Workflows) URL. */
  teams?: string;
  /** The events to send. Default: all of them. */
  events?: NotifyEventKind[];
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTINGS = ["webhook", "key", "slack", "teams", "events"];

/** The first problem with a {@link NotifyConfig}, or undefined. `where` prefixes the message. */
export function notifyConfigProblem(value: unknown, where = "notify"): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where}: expected { webhook, key, slack, teams, events }`;
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!SETTINGS.includes(k)) return `${where}.${k}: unknown setting (expected ${SETTINGS.join(", ")})`;
  for (const k of ["webhook", "key", "slack", "teams"] as const) {
    const n = v[k];
    if (n === undefined) continue;
    if (typeof n !== "string" || !VARIABLE.test(n)) {
      const what = k === "key" ? "signing key" : "URL";
      return `${where}.${k}: the name of the environment variable that holds the ${what}, never the ${k === "key" ? "key" : "URL"} itself`;
    }
  }
  if (v.webhook !== undefined && v.key === undefined) return `${where}.key: a webhook needs a signing key; name the variable that holds it`;
  if (v.key !== undefined && v.webhook === undefined) return `${where}.webhook: a key is for a webhook; name the variable that holds its URL`;
  if (v.webhook === undefined && v.slack === undefined && v.teams === undefined) return `${where}: name a webhook (with its key), a slack or a teams URL variable`;
  if (v.events !== undefined && !(Array.isArray(v.events) && v.events.every((e) => (NOTIFY_EVENTS as readonly unknown[]).includes(e)))) {
    return `${where}.events: a list of ${NOTIFY_EVENTS.join(", ")}`;
  }
  return undefined;
}

/** The environment variables a configuration names, for a pipeline to map its secrets into. */
export function notifyVariables(config: NotifyConfig | undefined): string[] {
  if (!config) return [];
  return [config.webhook, config.key, config.slack, config.teams].filter((n): n is string => typeof n === "string" && n !== "");
}

/** The request {@link sendNotify} posts to the webhook: the event as JSON, signed with `key` over `<timestamp>.<body>`. */
export function webhookRequest(
  event: NotifyEvent,
  key: string,
  options: { now?: number; prefix?: string; userAgent?: string } = {},
): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(event);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const names = webhookHeaderNames(options.prefix ?? DEFAULT_HEADER_PREFIX);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? event.source,
      [names.event]: event.event,
      [names.delivery]: event.id,
      [names.timestamp]: String(now),
      [names.signature]: signWebhook(key, now, body),
    },
  };
}

/** The part of `fetch` {@link sendNotify} uses. Tests pass their own. */
export type NotifyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface NotifyDelivery {
  target: "webhook" | "slack" | "teams";
  ok: boolean;
  /** `delivered`, the HTTP status, or why there was none. Never a URL or a key. */
  detail: string;
}

export interface SendNotifyOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: NotifyFetch;
  /** Tries per target. A 4xx is not retried. Default 3. */
  attempts?: number;
  /** Waits between tries. Default `setTimeout`, 500 ms times the try. */
  sleep?: (ms: number) => Promise<void>;
  /** Where a failed delivery is written. Default stderr. */
  log?: (line: string) => void;
  /** The webhook headers' prefix. Default `x-chant`. */
  prefix?: string;
  userAgent?: string;
  /** A product's own Slack or Teams body (terragucci's relay buttons), in place of {@link slackMessage} and {@link teamsMessage}. */
  render?: { slack?: (e: NotifyEvent) => unknown; teams?: (e: NotifyEvent) => unknown };
  /** Seconds since the epoch, for the signature's timestamp. Default: the clock. */
  now?: number;
}

/** A failure's message, with every URL it names cut out. */
function redact(message: string, urls: readonly string[]): string {
  let out = message;
  for (const u of urls) if (u) out = out.split(u).join("<url>");
  return out.replace(/https?:\/\/\S+/g, "<url>");
}

async function post(
  fetchFn: NotifyFetch,
  url: string,
  request: { headers: Record<string, string>; body: string },
  attempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  let last = "not attempted";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * i);
    try {
      const res = await fetchFn(url, { method: "POST", ...request, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return undefined;
      last = `HTTP ${String(res.status)}`;
      // A 4xx will not change on a retry: the receiver refused the event.
      if (res.status < 500) return last;
    } catch (e) {
      last = redact(e instanceof Error ? e.message : String(e), [url]);
    }
  }
  return last;
}

const LABEL: Record<NotifyDelivery["target"], string> = { webhook: "the webhook", slack: "Slack", teams: "Teams" };

/**
 * Sends `event` to what `config` names, reading the URLs and the key from
 * the environment at send time. Never throws: each delivery's outcome is
 * returned, and a failed one is logged without its URL.
 */
export async function sendNotify(config: NotifyConfig | undefined, event: NotifyEvent | undefined, options: SendNotifyOptions = {}): Promise<NotifyDelivery[]> {
  if (!config || !event) return [];
  if (config.events && !config.events.includes(event.event)) return [];
  const env = options.env ?? process.env;
  const fetchFn: NotifyFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const out: NotifyDelivery[] = [];
  const deliver = async (target: NotifyDelivery["target"], variable: string, request: () => { headers: Record<string, string>; body: string } | string) => {
    let d: NotifyDelivery;
    try {
      const url = env[variable];
      if (!url) d = { target, ok: false, detail: `${variable} is not set` };
      else {
        const r = request();
        if (typeof r === "string") d = { target, ok: false, detail: r };
        else {
          const failed = await post(fetchFn, url, r, attempts, sleep);
          d = { target, ok: failed === undefined, detail: failed ?? "delivered" };
        }
      }
    } catch (e) {
      d = { target, ok: false, detail: redact(e instanceof Error ? e.message : String(e), [env[variable] ?? ""]) };
    }
    if (!d.ok) log(`notify: the ${event.event} event was not delivered to ${LABEL[target]}: ${d.detail}`);
    out.push(d);
  };
  const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (config.webhook) {
    await deliver("webhook", config.webhook, () => {
      const key = config.key ? env[config.key] : undefined;
      if (!key) return `${config.key ?? "the key variable"} is not set, and an event is never sent unsigned`;
      return webhookRequest(event, key, { ...(options.now !== undefined ? { now: options.now } : {}), ...(options.prefix ? { prefix: options.prefix } : {}), ...(options.userAgent ? { userAgent: options.userAgent } : {}) });
    });
  }
  if (config.slack) await deliver("slack", config.slack, () => json((options.render?.slack ?? slackMessage)(event)));
  if (config.teams) await deliver("teams", config.teams, () => json((options.render?.teams ?? teamsMessage)(event)));
  return out;
}
