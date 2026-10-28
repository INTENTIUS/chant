/**
 * `chant notify relay` (#4611): approve a waiting gate from chat.
 *
 * With `notify.relay` set, a waiting event's Slack message carries Approve
 * and Decline buttons, and its Teams card the reply `approve <token>`
 * (`./notify.ts`). The token is the waiting event's id, source, time, gate
 * and digest, signed with the relay key. Slack posts a click to the relay's
 * `/slack`, signed with the Slack app's signing secret; a Teams outgoing
 * webhook posts the reply to `/teams`, signed with its HMAC key. The relay:
 *
 * 1. refuses a request whose chat signature does not verify (401), and a
 *    Slack request more than five minutes old;
 * 2. refuses a token the relay key did not sign, or one older than its
 *    maximum age, so only a button chant's notify posted approves anything;
 * 3. maps the chat user to a principal: the signers file at base lists
 *    `slack:<team>/<user>` or `teams:<aad object id>` on that person's line.
 *    A user no line lists is refused, and so is the relay's own principal;
 * 4. finds the standing pending fact at the token's gate whose plan or
 *    change set is the token's digest. A digest that moved, or a gate
 *    approved already, approves nothing;
 * 5. refuses the requester of a gated request (#4551), whose own approval
 *    never counts;
 * 6. records the approval as `chant approve <op> <gate> --plan <digest>
 *    --actor <principal> --relayed-by <relay>` does, with every rule that
 *    command applies: the decision point, `identity.gates` (the relay holds
 *    no key, so a sealed gate is refused), the gate policy and the push.
 *
 * Decline records nothing and says who declined. The type-the-name prompt
 * of `chant approve` (#4575) is for a terminal; a signed click is the
 * person's confirmation here. The relay starts no job: the resume job
 * applies the wave once the approval stands.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { CiProductWords } from "./ci-product-words";
import type { GatedRequest } from "./lifecycle/gated-request-digest";
import { readRelayToken, RELAY_APPROVE_ACTION, RELAY_DECLINE_ACTION, type RelayRef } from "./notify";

/** The relay's settings, by environment variable. */
export const RELAY_ENV = {
  /** The key the notify buttons are signed with: the variable `notify.relay` names on the sending side. */
  key: "CHANT_RELAY_KEY",
  slackSecret: "SLACK_SIGNING_SECRET",
  teamsSecret: "TEAMS_WEBHOOK_SECRET",
  /** The principal recorded as `relayedBy`. Default `<product>-relay`. */
  principal: "CHANT_RELAY_PRINCIPAL",
  /** How old a button may be, in seconds. */
  maxAge: "CHANT_RELAY_MAX_AGE",
  host: "CHANT_RELAY_HOST",
  port: "CHANT_RELAY_PORT",
  /** Comma-separated address prefixes a Slack response_url may have. */
  slackResponse: "CHANT_RELAY_SLACK_RESPONSE",
} as const;

/** Slack's own reply hosts: hooks.slack.com, and GovSlack's. */
export const SLACK_RESPONSE_PREFIXES = ["https://hooks.slack.com/", "https://hooks.slack-gov.com/"];
const SLACK_WINDOW_S = 5 * 60;
/** Where the relay listens by default: loopback, so it is reachable only through what the operator puts in front of it. */
export const DEFAULT_RELAY_HOST = "127.0.0.1";
export const DEFAULT_RELAY_PORT = 8787;

// ── chat signatures ──────────────────────────────────────────────────────

const header = (h: Record<string, string | undefined>, name: string): string | undefined => h[name] ?? h[name.toLowerCase()];

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `v0=<hex>`: Slack's signature, HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's signing secret. */
export const slackSignature = (secret: string, timestamp: string, raw: string): string => `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;

/** Why a Slack request is refused, or null when it verifies and is recent. */
export function verifySlackRequest(headers: Record<string, string | undefined>, raw: string, secret: string | undefined, now: number = Date.now()): string | null {
  if (!secret) return `${RELAY_ENV.slackSecret} is empty, so no Slack request can be verified`;
  const ts = header(headers, "x-slack-request-timestamp") ?? "";
  const sig = header(headers, "x-slack-signature") ?? "";
  if (!/^\d+$/.test(ts) || !sig) return "the request is not signed";
  if (Math.abs(now / 1000 - Number(ts)) > SLACK_WINDOW_S) return "the request is more than five minutes old";
  return same(sig, slackSignature(secret, ts, raw)) ? null : "the signature does not verify";
}

/** `HMAC <base64>`: a Teams outgoing webhook's signature, HMAC-SHA256 of the raw body with the key Teams gave (base64). */
export const teamsSignature = (secret: string, raw: string): string => `HMAC ${createHmac("sha256", Buffer.from(secret, "base64")).update(raw).digest("base64")}`;

/** Why a Teams request is refused, or null when it verifies. */
export function verifyTeamsRequest(headers: Record<string, string | undefined>, raw: string, secret: string | undefined): string | null {
  if (!secret) return `${RELAY_ENV.teamsSecret} is empty, so no Teams request can be verified`;
  const auth = header(headers, "authorization") ?? "";
  if (!auth.startsWith("HMAC ")) return "the request is not signed";
  return same(auth, teamsSignature(secret, raw)) ? null : "the signature does not verify";
}

// ── clicks ───────────────────────────────────────────────────────────────

/** One click or reply, read from a verified request. */
export interface RelayClick {
  app: "slack" | "teams";
  /** `slack:<team>/<user>` or `teams:<aad object id>`: what the signers file lists. */
  chatUser: string;
  /** The name chat shows, for the reply. */
  display: string;
  action: "approve" | "decline";
  /** The signed button value. */
  token: string;
  responseUrl?: string;
  thread?: string;
}

/** A Slack `block_actions` payload (the form field `payload`), or why the relay does not read it. */
export function slackRelayClick(raw: string): RelayClick | { error: string } {
  let p: any;
  try {
    p = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return { error: "the request carries no Slack payload" };
  }
  if (p?.type !== "block_actions") return { error: `a Slack ${String(p?.type)} payload is not a button click` };
  const team = p.user?.team_id ?? p.team?.id;
  const user = p.user?.id;
  if (typeof team !== "string" || typeof user !== "string") return { error: "the click names no Slack user" };
  const a = Array.isArray(p.actions) ? p.actions[0] : undefined;
  const action = a?.action_id === RELAY_APPROVE_ACTION ? "approve" : a?.action_id === RELAY_DECLINE_ACTION ? "decline" : undefined;
  if (!action) return { error: `the button ${String(a?.action_id)} is not chant's` };
  if (typeof a.value !== "string" || !a.value) return { error: "the button carries no reference" };
  const thread = p.container?.message_ts ?? p.message?.ts;
  return {
    app: "slack",
    chatUser: `slack:${team}/${user}`,
    display: String(p.user?.username ?? p.user?.name ?? user),
    action,
    token: a.value,
    ...(typeof p.response_url === "string" ? { responseUrl: p.response_url } : {}),
    ...(typeof thread === "string" ? { thread } : {}),
  };
}

/** A Teams message's words, with its mention and markup dropped. */
const teamsWords = (text: string): string[] =>
  text
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** A Teams outgoing webhook's message, `@<relay> approve|decline <token>`, or why it is not one. */
export function teamsRelayClick(raw: string): RelayClick | { error: string } {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return { error: "the request is not a Teams message" };
  }
  const user = m?.from?.aadObjectId;
  if (typeof user !== "string" || !user) return { error: "the message names no Teams user" };
  const [verb, token, extra] = teamsWords(String(m.text ?? ""));
  if ((verb !== "approve" && verb !== "decline") || !token || extra !== undefined) return { error: "reply approve or decline, then the reference from the message: approve <reference>" };
  return { app: "teams", chatUser: `teams:${user}`, display: String(m.from?.name ?? user), action: verb, token };
}

// ── who clicked ──────────────────────────────────────────────────────────

const CHAT_ID = /^(slack|teams):/;
const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/**
 * The principal a chat user maps to: the signers file line that lists the
 * chat id gives the line's first principal that is not a chat id. Undefined
 * when no line lists it, or lines listing it name different principals.
 */
export function relayPrincipalFor(signers: ReadonlyArray<{ principal: string; line: number }>, chatUser: string): string | undefined {
  const id = norm(chatUser);
  const lines = new Map<number, string[]>();
  for (const s of signers) lines.set(s.line, [...(lines.get(s.line) ?? []), norm(s.principal)]);
  const found = new Set<string>();
  for (const principals of lines.values()) {
    if (!principals.includes(id)) continue;
    const p = principals.find((x) => !CHAT_ID.test(x));
    if (p) found.add(p);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// ── deciding ─────────────────────────────────────────────────────────────

/** A standing pending fact the token's digest matched. */
export interface RelayPending {
  op: string;
  gate: string;
  /** The digest the fact asks an approval of: its plan's, else its change set's. */
  digest: string;
  environment?: string;
  /** On a gated request (#4551): the request, whose requester may not approve it. */
  request?: GatedRequest;
}

/** What the relay reads and writes, so a test stands in for the repo. */
export interface RelayDeps {
  /** The signers file at base, and its path for the refusal. */
  signers(): Promise<{ signers: ReadonlyArray<{ principal: string; line: number }>; path: string }>;
  /** The standing pending facts whose plan or change set is `digest`. */
  pending(digest: string): Promise<RelayPending[]>;
  /** Record the approval as `chant approve` does. `error` is why it refused. */
  approve(input: { op: string; gate: string; digest: string; environment?: string; actor: string; relayedBy: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Who the relay records as `relayedBy`. */
  principal: string;
  words: CiProductWords;
  now?: () => Date;
}

export interface RelaySettings {
  /** The relay key: buttons it did not sign are refused. */
  key?: string;
  slackSecret?: string;
  teamsSecret?: string;
  maxAgeSeconds?: number;
  slackResponse?: string[];
}

/** The relay's answer to a click, and the line for the thread. */
export interface RelayAnswer {
  ok: boolean;
  /** What the relay did: `approved`, `declined`, or the refusal's kind. */
  outcome: "approved" | "declined" | "bad-reference" | "stale" | "ineligible" | "moved" | "refused";
  text: string;
  /** The gate's op, when the click reached one. */
  op?: string;
  gate?: string;
  principal?: string;
}

/** Decide a click and record what it approves. Never throws: an error is the answer's text. */
export async function decideRelayClick(click: RelayClick, settings: RelaySettings, deps: RelayDeps): Promise<RelayAnswer> {
  const words = deps.words;
  const checked = readRelayToken(settings.key, click.token, { ...(deps.now ? { now: deps.now() } : {}), ...(settings.maxAgeSeconds !== undefined ? { maxAgeSeconds: settings.maxAgeSeconds } : {}) });
  if (!checked.ok) return { ok: false, outcome: /old|future/.test(checked.reason) ? "stale" : "bad-reference", text: `Refused: ${checked.reason}. Nothing was ${click.action === "approve" ? "approved" : "declined"}.` };
  const ref: RelayRef = checked.ref;
  try {
    const { signers, path } = await deps.signers();
    const principal = relayPrincipalFor(signers, click.chatUser);
    if (!principal) {
      return { ok: false, outcome: "ineligible", gate: ref.gate, text: `Refused: ${click.display} (${click.chatUser}) is not mapped to a principal in ${path} at base, so nothing was recorded. A maintainer adds ${click.chatUser} to that person's line.` };
    }
    if (norm(principal) === norm(deps.principal)) {
      return { ok: false, outcome: "ineligible", gate: ref.gate, principal, text: `Refused: ${principal} is the relay, and the relay never approves.` };
    }
    if (click.action === "decline") {
      return { ok: true, outcome: "declined", gate: ref.gate, principal, text: `${ref.gate} declined by ${principal} for ${ref.digest}. Nothing was recorded; the gate keeps waiting.` };
    }
    const standing = (await deps.pending(ref.digest)).filter((p) => p.gate === ref.gate);
    if (standing.length === 0) {
      return { ok: false, outcome: "moved", gate: ref.gate, principal, text: `Not approved: ${ref.gate} does not wait for ${ref.digest}. The plan moved since this message, or it was approved already. Read the plan waiting now and approve its digest.` };
    }
    if (standing.length > 1) {
      return { ok: false, outcome: "refused", gate: ref.gate, principal, text: `Not approved: ${ref.gate} waits for ${ref.digest} under ${standing.map((p) => p.op).join(", ")}, so the click names no one gate. Approve at a shell with the op named.` };
    }
    const pending = standing[0]!;
    if (pending.request && norm(pending.request.by) === norm(principal)) {
      return { ok: false, outcome: "ineligible", op: pending.op, gate: pending.gate, principal, text: `Refused: ${principal} made the request, and a requester's own approval does not count. Someone else approves it.` };
    }
    const recorded = await deps.approve({ op: pending.op, gate: pending.gate, digest: pending.digest, ...(pending.environment !== undefined ? { environment: pending.environment } : {}), actor: principal, relayedBy: deps.principal });
    if (!recorded.ok) return { ok: false, outcome: "refused", op: pending.op, gate: pending.gate, principal, text: `Not approved: ${recorded.error}` };
    return {
      ok: true,
      outcome: "approved",
      op: pending.op,
      gate: pending.gate,
      principal,
      text: `${pending.gate} on ${pending.op} approved by ${principal}, relayed by ${deps.principal}, for ${pending.digest} and no other plan. The resume job starts the ${words.stages.apply} once the gate passes.`,
    };
  } catch (e) {
    return { ok: false, outcome: "refused", gate: ref.gate, text: `Not recorded: ${(e as Error).message}` };
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────

export interface RelayRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The part of `fetch` the relay posts Slack replies with. */
export type RelayFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

const json = (status: number, body: unknown): RelayResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const plain = (status: number, body: string): RelayResponse => ({ status, headers: { "content-type": "text/plain" }, body });

/**
 * One request: `POST /slack`, `POST /teams`, `GET /healthz`. A Slack answer
 * goes to the click's response_url, in the message's thread, when that is
 * Slack's; a Teams answer is the reply Teams posts under the message.
 */
export async function handleRelayRequest(
  req: RelayRequest,
  settings: RelaySettings,
  deps: RelayDeps,
  options: { post?: RelayFetch; log?: (line: string) => void; now?: number } = {},
): Promise<RelayResponse> {
  const log = options.log ?? (() => {});
  const path = req.path.split("?")[0]!;
  if (req.method === "GET" && path === "/healthz") return plain(200, "ok");
  if (req.method !== "POST" || (path !== "/slack" && path !== "/teams")) return plain(404, "not found");
  if (path === "/slack") {
    const refused = verifySlackRequest(req.headers, req.body, settings.slackSecret, options.now);
    if (refused) {
      log(`slack: refused a request: ${refused}`);
      return plain(401, refused);
    }
    const click = slackRelayClick(req.body);
    if ("error" in click) return plain(400, click.error);
    const answer = await decideRelayClick(click, settings, deps);
    log(`slack: ${click.chatUser} ${click.action}: ${answer.outcome}: ${answer.text}`);
    if (click.responseUrl) {
      const allowed = settings.slackResponse ?? SLACK_RESPONSE_PREFIXES;
      if (!allowed.some((p) => click.responseUrl!.startsWith(p))) log(`slack: the response_url is not Slack's (${allowed.join(", ")}); no reply was posted`);
      else {
        try {
          const post = options.post ?? ((url, init) => globalThis.fetch(url, init));
          const r = await post(click.responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "in_channel", replace_original: false, ...(click.thread ? { thread_ts: click.thread } : {}), text: answer.text }) });
          if (!r.ok) log(`slack: the reply answered ${r.status}`);
        } catch (e) {
          log(`slack: the reply did not land (${(e as Error).message})`);
        }
      }
    }
    return plain(200, "");
  }
  const refused = verifyTeamsRequest(req.headers, req.body, settings.teamsSecret);
  if (refused) {
    log(`teams: refused a request: ${refused}`);
    return plain(401, refused);
  }
  const click = teamsRelayClick(req.body);
  if ("error" in click) return json(200, { type: "message", text: click.error });
  const answer = await decideRelayClick(click, settings, deps);
  log(`teams: ${click.chatUser} ${click.action}: ${answer.outcome}: ${answer.text}`);
  return json(200, { type: "message", text: answer.text });
}

/** The largest request body the relay reads. Slack and Teams send a few kilobytes. */
const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("the request body is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the relay's HTTP server on `host:port` (port 0 picks a free one). Resolves once it listens. */
export async function startRelayServer(
  settings: RelaySettings,
  deps: RelayDeps,
  options: { host?: string; port?: number; post?: RelayFetch; log?: (line: string) => void } = {},
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      let out: RelayResponse;
      try {
        const body = await readBody(req);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        out = await handleRelayRequest({ method: req.method ?? "GET", path: req.url ?? "/", headers, body }, settings, deps, { ...(options.post ? { post: options.post } : {}), ...(options.log ? { log: options.log } : {}) });
      } catch (e) {
        out = plain(400, (e as Error).message);
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    })();
  });
  const host = options.host ?? DEFAULT_RELAY_HOST;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_RELAY_PORT, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? DEFAULT_RELAY_PORT;
  return {
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
