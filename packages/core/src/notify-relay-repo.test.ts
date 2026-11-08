/**
 * #4759: `chant notify relay --repo <url> --token-env <VAR>` checks its token
 * and clones the repo itself. The forge is a loopback server that answers the
 * forge's REST calls and serves a local bare repository over git's smart
 * HTTP protocol (`git http-backend`), so the clone, the fetch before each
 * click and the ledger push all carry the token as a header. No real forge.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { CHANT_WORDS } from "./ci-product-words";
import { checkoutRelayDeps } from "./cli/handlers/notify-relay";
import { parseArgs } from "./cli/parse-args";
import { relayToken } from "./notify";
import { decideRelayClick } from "./notify-relay";
import { checkRelayToken, prepareRelayCheckout, relayGitAuthEnv, relayRepo, type RelayRepo } from "./notify-relay-repo";
import { cleanScratch, git, scratchDir, writeFiles } from "./workspace/__fixtures__/contract-repo";

afterAll(cleanScratch);

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const TOKEN = "relay-token-for-tests";
const RELAY_KEY = "relay-key-for-tests";
const D = `jcs1-sha256:${"a".repeat(64)}`;

/** A route's answer: the JSON body, and any response headers. */
type Route = { body: unknown; headers?: Record<string, string> };

interface LoopbackForge {
  url: string;
  /** REST routes by path, as the client asks them (encoded). Anything else answers 404. */
  routes: Map<string, Route>;
  /** Every request's method, path and Authorization header. */
  seen: Array<{ method: string; path: string; auth: string | undefined }>;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks)));
  });

/** One loopback server: the forge's REST API, and `<owner>/<name>.git` from `gitRoot` through git http-backend. */
async function loopbackForge(gitRoot?: string): Promise<LoopbackForge> {
  const routes = new Map<string, Route>();
  const seen: LoopbackForge["seen"] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path, query = ""] = (req.url ?? "/").split("?");
      seen.push({ method: req.method ?? "GET", path: path!, auth: req.headers.authorization });
      const body = await readBody(req);
      if (gitRoot && /\.git\//.test(path!)) {
        const cgi = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: gitRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            // http-backend serves a push only to an authenticated user.
            REMOTE_USER: "relay",
            PATH_INFO: decodeURIComponent(path!),
            QUERY_STRING: query,
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(body.length),
            ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
          },
        });
        const out: Buffer[] = [];
        cgi.stdout.on("data", (c: Buffer) => out.push(c));
        cgi.stdin.end(body);
        await new Promise((done) => cgi.on("close", done));
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, split).toString("utf-8");
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split("\r\n")) {
          const at = line.indexOf(":");
          const name = line.slice(0, at).trim();
          const value = line.slice(at + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
          else headers[name] = value;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(split + 4));
        return;
      }
      const hit = routes.get(path!);
      res.writeHead(hit ? 200 : 404, { "content-type": "application/json", ...(hit?.headers ?? {}) });
      res.end(JSON.stringify(hit ? hit.body : { message: "Not Found" }));
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    routes,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const forges: LoopbackForge[] = [];
afterEach(async () => {
  for (const f of forges.splice(0)) await f.close();
});
async function forge(routes: Record<string, Route | unknown> = {}, gitRoot?: string): Promise<LoopbackForge> {
  const f = await loopbackForge(gitRoot);
  for (const [p, r] of Object.entries(routes)) f.routes.set(p, r && typeof r === "object" && "body" in r ? (r as Route) : { body: r });
  forges.push(f);
  return f;
}
const repoAt = (f: LoopbackForge, kind: "github" | "gitlab" | "forgejo"): RelayRepo => {
  const r = relayRepo(`${f.url}/acme/infra.git`, kind);
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("the relay's token (#4759)", () => {
  test("on Forgejo, takes a token whose user neither administers the repo nor may push to the default branch, and pushes as that user", async () => {
    const ok = await forge({ "/api/v1/user": { login: "relay-bot" }, "/api/v1/repos/acme/infra": { permissions: { admin: false, push: true } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: false } });
    expect(await checkRelayToken(repoAt(ok, "forgejo"), TOKEN, "main")).toEqual({ user: "relay-bot" });
    expect(ok.seen.every((s) => s.auth === `token ${TOKEN}`)).toBe(true);
    const admin = await forge({ "/api/v1/user": { login: "root" }, "/api/v1/repos/acme/infra": { permissions: { admin: true } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: true } });
    expect(await checkRelayToken(repoAt(admin, "forgejo"), TOKEN, "main")).toEqual({ error: "the token's user administers acme/infra" });
    const pusher = await forge({ "/api/v1/user": { login: "dev" }, "/api/v1/repos/acme/infra": { permissions: { admin: false } }, "/api/v1/repos/acme/infra/branches/main": { user_can_push: true } });
    expect(await checkRelayToken(repoAt(pusher, "forgejo"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/may push to main/) });
    // A branch read that does not say counts as a push.
    const silent = await forge({ "/api/v1/user": { login: "dev" }, "/api/v1/repos/acme/infra": { permissions: { admin: false } }, "/api/v1/repos/acme/infra/branches/main": {} });
    expect(await checkRelayToken(repoAt(silent, "forgejo"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/may push to main/) });
  });

  test("on GitHub, refuses a classic token, an admin, and an unprotected default branch", async () => {
    const routes = { "/api/v3/repos/acme/infra": { permissions: { admin: false, push: true } }, "/api/v3/repos/acme/infra/branches/main": { protected: true } };
    const ok = await forge(routes);
    expect(await checkRelayToken(repoAt(ok, "github"), TOKEN, "main")).toEqual({ user: "x-access-token" });
    expect(ok.seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    const classic = await forge({ ...routes, "/api/v3/repos/acme/infra": { body: { permissions: { admin: false } }, headers: { "x-oauth-scopes": "repo" } } });
    expect(await checkRelayToken(repoAt(classic, "github"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/classic token/) });
    const admin = await forge({ ...routes, "/api/v3/repos/acme/infra": { permissions: { admin: true } } });
    expect(await checkRelayToken(repoAt(admin, "github"), TOKEN, "main")).toEqual({ error: "the token's account administers acme/infra" });
    const open = await forge({ ...routes, "/api/v3/repos/acme/infra/branches/main": { protected: false } });
    expect(await checkRelayToken(repoAt(open, "github"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/not protected/) });
  });

  test("on GitLab, refuses the api scope, a Maintainer, an unprotected branch, and a push level the user holds", async () => {
    const base = {
      "/api/v4/personal_access_tokens/self": { scopes: ["write_repository", "read_api"] },
      "/api/v4/projects/acme%2Finfra": { permissions: { project_access: { access_level: 30 } } },
      "/api/v4/projects/acme%2Finfra/protected_branches/main": { push_access_levels: [{ access_level: 40 }] },
    };
    const ok = await forge(base);
    expect(await checkRelayToken(repoAt(ok, "gitlab"), TOKEN, "main")).toEqual({ user: "oauth2" });
    expect(ok.seen.length).toBe(3);
    const api = await forge({ ...base, "/api/v4/personal_access_tokens/self": { scopes: ["api"] } });
    expect(await checkRelayToken(repoAt(api, "gitlab"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/scopes api/) });
    const maintainer = await forge({ ...base, "/api/v4/projects/acme%2Finfra": { permissions: { project_access: { access_level: 30 }, group_access: { access_level: 40 } } } });
    expect(await checkRelayToken(repoAt(maintainer, "gitlab"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/Maintainer/) });
    const unprotected = await forge({ "/api/v4/personal_access_tokens/self": base["/api/v4/personal_access_tokens/self"], "/api/v4/projects/acme%2Finfra": base["/api/v4/projects/acme%2Finfra"] });
    expect(await checkRelayToken(repoAt(unprotected, "gitlab"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/not a protected branch/) });
    const developers = await forge({ ...base, "/api/v4/projects/acme%2Finfra/protected_branches/main": { push_access_levels: [{ access_level: 30 }] } });
    expect(await checkRelayToken(repoAt(developers, "gitlab"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/may push to main/) });
  });

  test("a forge that will not answer refuses the token", async () => {
    const none = await forge();
    expect(await checkRelayToken(repoAt(none, "github"), TOKEN, "main")).toMatchObject({ error: expect.stringMatching(/could not be read with the token .*answered 404/) });
  });

  test("refuses a clone address that carries a credential or names no forge, and keeps the token out of every file", () => {
    expect(relayRepo("https://bot:t@github.com/acme/infra.git")).toMatchObject({ error: expect.stringMatching(/must not carry a credential/) });
    expect(relayRepo("git@github.com:acme/infra.git")).toMatchObject({ error: expect.stringMatching(/https clone address/) });
    expect(relayRepo("https://git.example.com/acme/infra.git")).toMatchObject({ error: expect.stringMatching(/pass --forge/) });
    expect(relayRepo("https://gitlab.com/acme/platform/infra.git")).toMatchObject({ forge: "gitlab", path: "acme/platform/infra", apiBase: "https://gitlab.com/api/v4" });
    expect(relayRepo("https://github.com/acme/infra")).toMatchObject({ forge: "github", path: "acme/infra", apiBase: "https://api.github.com" });
    const basic = `Authorization: Basic ${Buffer.from("relay-bot:tok").toString("base64")}`;
    expect(relayGitAuthEnv("relay-bot", "tok")).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: basic, GIT_TERMINAL_PROMPT: "0" });
    // Entries the environment already has are kept.
    expect(relayGitAuthEnv("relay-bot", "tok", { GIT_CONFIG_COUNT: "2" })).toEqual({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "http.extraHeader", GIT_CONFIG_VALUE_2: basic, GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("the relay's flags (#4759)", () => {
  test("--repo takes a clone address for the relay and owner/name for ci serve", () => {
    expect(parseArgs(["notify", "relay", "--repo", "https://github.com/acme/infra.git", "--token-env", "RELAY_TOKEN", "--host", "0.0.0.0", "--port", "8080"])).toMatchObject({ repoUrl: "https://github.com/acme/infra.git", tokenEnv: "RELAY_TOKEN", host: "0.0.0.0", port: ["8080"] });
    expect(parseArgs(["ci", "serve", "--repo", "acme/infra"])).toMatchObject({ ciRepo: "acme/infra" });
    expect(() => parseArgs(["notify", "relay", "--token-env", "not a name"])).toThrow(/--token-env needs a variable's name/);
  });
});

describe("the relay's own checkout (#4759)", () => {
  const SIGNERS = `alice@acme.com,slack:T1/U1 ssh-ed25519 ${KEY}\nbob@acme.com ssh-ed25519 ${KEY}\n`;
  const T = (h: number): string => new Date(Date.now() - 3600_000 + h * 3600_000).toISOString();
  const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: T(1), expiresAt: T(49), planDigest: D };

  /** A bare `acme/infra.git` under a scratch root: main with the signers file, and chant/lifecycle with one pending fact. */
  function bareRepo(): { root: string; bare: string; work: string } {
    const root = scratchDir("chant-relay-forge-");
    const bare = join(root, "acme", "infra.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "main", work);
    writeFiles(work, { ".chant/allowed_signers": SIGNERS });
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "main");
    git(work, "push", "-q", bare, "main");
    git(work, "checkout", "-q", "--orphan", "chant/lifecycle");
    git(work, "rm", "-rq", "--cached", ".");
    writeFiles(work, { "_gates/tf-apply.jsonl": `${JSON.stringify(pending)}\n` });
    git(work, "add", "_gates");
    git(work, "commit", "-q", "-m", "ledger");
    git(work, "push", "-q", bare, "chant/lifecycle");
    git(work, "checkout", "-q", "-f", "main");
    return { root, bare, work };
  }

  const githubRoutes = { "/api/v3/repos/acme/infra": { permissions: { admin: false, push: true } }, "/api/v3/repos/acme/infra/branches/main": { protected: true } };

  test("refuses an over-scoped token before it clones anything", async () => {
    const { root } = bareRepo();
    const f = await forge({ ...githubRoutes, "/api/v3/repos/acme/infra/branches/main": { protected: false } }, root);
    const parent = scratchDir();
    const made = await prepareRelayCheckout({ url: `${f.url}/acme/infra.git`, token: TOKEN, forge: "github", parent });
    expect(made).toMatchObject({ error: expect.stringMatching(/^the relay holds only an approve-only token, and this one is more: main is not protected/) });
    // Only the default branch was asked (ls-remote); nothing was cloned.
    expect(readdirSync(parent)).toEqual([]);
  });

  test("clones the default branch with the token as a header only, reads a signer added since at the tip, and pushes the approval", async () => {
    const { root, bare, work } = bareRepo();
    const f = await forge(githubRoutes, root);
    const made = await prepareRelayCheckout({ url: `${f.url}/acme/infra.git`, token: TOKEN, forge: "github", env: { ...process.env, GIT_CONFIG_COUNT: "0" }, parent: scratchDir() });
    if ("error" in made) throw new Error(made.error);
    expect(made).toMatchObject({ branch: "main", user: "x-access-token" });
    // Every git request carried the token as Basic auth; the checkout's files do not hold it.
    const gitCalls = f.seen.filter((s) => s.path.includes(".git/"));
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.every((s) => s.auth === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`)).toBe(true);
    expect(readFileSync(join(made.dir, ".git", "config"), "utf-8")).not.toContain(TOKEN);
    expect(readFileSync(join(made.dir, ".git", "config"), "utf-8")).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(git(made.dir, "remote", "get-url", "origin")).toBe(`${f.url}/acme/infra.git`);

    // A signer added on main after the clone.
    writeFiles(work, { ".chant/allowed_signers": `${SIGNERS}carol@acme.com,slack:T1/U3 ssh-ed25519 ${KEY}\n` });
    git(work, "commit", "-qam", "add carol");
    git(work, "push", "-q", bare, "main");

    const prev = { env: { ...process.env }, cwd: process.cwd() };
    Object.assign(process.env, made.gitEnv, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    // As chant notify relay runs it: in the checkout, since chant approve writes the ledger of the process's directory (#4760).
    process.chdir(made.dir);
    try {
      const deps = checkoutRelayDeps(made.dir, "chant-relay");
      expect(deps.words).toEqual(CHANT_WORDS);
      const click = (user: string) => ({ app: "slack" as const, chatUser: user, display: user, action: "approve" as const, token: relayToken(RELAY_KEY, { id: "e1", source: "chant", at: new Date().toISOString(), gate: "wave-1", digest: D }) });
      const a = await decideRelayClick(click("slack:T1/U3"), { key: RELAY_KEY }, deps);
      expect(a).toMatchObject({ ok: true, outcome: "approved", principal: "carol@acme.com" });
      const ledger = git(root, "--git-dir", bare, "show", "chant/lifecycle:_gates/tf-apply.jsonl");
      expect(ledger).toMatch(/"resolvedBy":"carol@acme\.com"/);
      expect(ledger).toMatch(/"relayedBy":"chant-relay"/);
    } finally {
      process.chdir(prev.cwd);
      for (const k of Object.keys(process.env)) if (!(k in prev.env)) delete process.env[k];
      Object.assign(process.env, prev.env);
    }
  });

  test("a click whose fetch of the default branch fails records nothing", async () => {
    const { root } = bareRepo();
    const f = await forge(githubRoutes, root);
    const made = await prepareRelayCheckout({ url: `${f.url}/acme/infra.git`, token: TOKEN, forge: "github", parent: scratchDir() });
    if ("error" in made) throw new Error(made.error);
    // Without the header, the loopback forge still serves git, so point origin somewhere that answers nothing.
    git(made.dir, "remote", "set-url", "origin", "http://127.0.0.1:9/acme/infra.git");
    const deps = checkoutRelayDeps(made.dir, "chant-relay");
    const token = relayToken(RELAY_KEY, { id: "e1", source: "chant", at: new Date().toISOString(), gate: "wave-1", digest: D });
    const a = await decideRelayClick({ app: "slack", chatUser: "slack:T1/U1", display: "alice", action: "approve", token }, { key: RELAY_KEY }, deps);
    expect(a).toMatchObject({ ok: false, outcome: "refused", text: expect.stringMatching(/^Not recorded: cannot fetch main to read the signers at its tip/) });
  });
});
