/**
 * An in-memory stand-in for a JFrog Artifactory Terraform module repository
 * (chant#4605), for the Artifactory module target's tests here and in
 * terragucci#1302. It is a fetch function: nothing listens on a port and
 * nothing leaves the process.
 *
 * It answers the calls terragucci#1299's research found in JFrog's docs:
 *
 *   GET  /.well-known/terraform.json        {"modules.v1": "/artifactory/api/terraform/v1/modules/"}
 *   PUT  /artifactory/<repo>/<ns>/<name>/<system>/<version>.zip
 *   GET  /artifactory/<repo>/<ns>/<name>/<system>/<version>.zip
 *   GET  /artifactory/api/terraform/v1/modules/<repo>__<ns>/<name>/<system>/versions
 *   GET  /artifactory/api/terraform/v1/modules/<repo>__<ns>/<name>/<system>/<version>/download   204, X-Terraform-Get
 *
 * The deploy takes basic `user:token` credentials only; the reads take those
 * or a bearer token the fake knows. An unknown credential gets 401, and a
 * user without deploy rights on the repository 403. A deploy body that is
 * not a zip holding a `.tf` file gets 400. A redeploy of a version is
 * refused with 409 unless `redeploy` is set. `indexAfter` keeps a new
 * version out of the versions list for that many reads, as Artifactory's
 * index recalculation does. `failNext` answers the next requests with a
 * status (401, 403, 409, 5xx). Every request is kept, headers and body
 * included.
 */
import { readZip } from "./zip";
import { basicOf, bearerOf, bodyOf, headersOf, jsonAnswer, type FakeFetch, type FakeRequest } from "./fake-http";

export interface FakeArtifactoryOptions {
  /** The host, such as `acme.jfrog.io`. */
  host: string;
  /** The local Terraform repositories' keys. */
  repos: string[];
  /** Users and their access tokens. */
  users: Record<string, string>;
  /** The users who may deploy, per repository. Default: every user on every repository. */
  deployers?: Record<string, string[]>;
  /** Whether reads go without a credential (Artifactory's anonymous access). Default false. */
  anonymousReads?: boolean;
  /** Whether a deploy over an existing version is taken. Default false: 409. */
  redeploy?: boolean;
  /** How many versions reads a new version stays unlisted for. Default 0. */
  indexAfter?: number;
}

export interface FakeArtifactory {
  fetch: FakeFetch;
  requests: FakeRequest[];
  /** What the repositories hold, keyed `<repo>/<ns>/<name>/<system>/<version>`. */
  modules: Map<string, Uint8Array>;
  /** Put a version in directly, as a deploy by hand would. */
  seed(repo: string, ns: string, name: string, system: string, version: string, bytes: Uint8Array): void;
  /** Answer the next `count` requests with `status`. */
  failNext(status: number, count?: number): void;
}

export const FAKE_ARTIFACTORY_MODULES_V1 = "/artifactory/api/terraform/v1/modules/";

export function createFakeArtifactory(o: FakeArtifactoryOptions): FakeArtifactory {
  const requests: FakeRequest[] = [];
  const modules = new Map<string, Uint8Array>();
  const unlisted = new Map<string, number>();
  let failures: { status: number; count: number } | undefined;
  const tokens = new Set(Object.values(o.users));

  const userOf = (headers: Record<string, string>): string | undefined => {
    const b = basicOf(headers.authorization);
    return b && o.users[b.user] === b.password ? b.user : undefined;
  };
  const mayRead = (headers: Record<string, string>): boolean => {
    if (o.anonymousReads) return true;
    if (userOf(headers)) return true;
    const bearer = bearerOf(headers.authorization);
    return bearer !== undefined && tokens.has(bearer);
  };
  const mayDeploy = (user: string, repo: string) => !o.deployers || (o.deployers[repo] ?? []).includes(user);

  const seed: FakeArtifactory["seed"] = (repo, ns, name, system, version, bytes) => void modules.set(`${repo}/${ns}/${name}/${system}/${version}`, bytes);

  const fetch: FakeFetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = headersOf(init.headers);
    const body = bodyOf(init.body);
    requests.push({ method, url, headers, ...(body ? { body } : {}) });
    const u = new URL(url);
    if (u.host !== o.host) throw new TypeError(`fetch failed: the fake answers only ${o.host}, not ${u.host}`);
    if (failures && failures.count > 0) {
      failures.count--;
      return jsonAnswer(failures.status, { errors: [{ status: failures.status, message: "set by failNext" }] });
    }
    const path = decodeURIComponent(u.pathname);

    if (method === "GET" && path === "/.well-known/terraform.json") return jsonAnswer(200, { "modules.v1": FAKE_ARTIFACTORY_MODULES_V1 });

    if (path.startsWith(FAKE_ARTIFACTORY_MODULES_V1)) {
      if (method !== "GET") return jsonAnswer(405, { errors: [{ status: 405 }] });
      if (!mayRead(headers)) return jsonAnswer(401, { errors: [{ status: 401, message: "Unauthorized" }] });
      const rest = path.slice(FAKE_ARTIFACTORY_MODULES_V1.length).split("/");
      const joined = /^(.+?)__(.+)$/.exec(rest[0] ?? "");
      if (!joined || !o.repos.includes(joined[1]!)) return jsonAnswer(404, { errors: [{ status: 404 }] });
      const prefix = `${joined[1]}/${joined[2]}/${rest[1]}/${rest[2]}/`;
      if (rest.length === 4 && rest[3] === "versions") {
        const listed = [...modules.keys()]
          .filter((k) => k.startsWith(prefix))
          .filter((k) => {
            const left = unlisted.get(k) ?? 0;
            if (left > 0) unlisted.set(k, left - 1);
            return left === 0;
          })
          .map((k) => k.slice(prefix.length));
        if (listed.length === 0) return jsonAnswer(404, { errors: [{ status: 404 }] });
        return jsonAnswer(200, { modules: [{ versions: listed.map((version) => ({ version })) }] });
      }
      if (rest.length === 5 && rest[4] === "download") {
        if (!modules.has(`${prefix}${rest[3]}`)) return jsonAnswer(404, { errors: [{ status: 404 }] });
        return new Response(null, { status: 204, headers: { "X-Terraform-Get": `/artifactory/${prefix}${rest[3]}.zip` } });
      }
      return jsonAnswer(404, { errors: [{ status: 404 }] });
    }

    const deploy = /^\/artifactory\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.zip$/.exec(path);
    if (deploy) {
      const [repo, ns, name, system, version] = deploy.slice(1) as [string, string, string, string, string];
      const k = `${repo}/${ns}/${name}/${system}/${version}`;
      if (method === "GET") {
        if (!mayRead(headers)) return jsonAnswer(401, { errors: [{ status: 401, message: "Unauthorized" }] });
        const stored = modules.get(k);
        if (!stored || !o.repos.includes(repo)) return jsonAnswer(404, { errors: [{ status: 404, message: "Not Found" }] });
        return new Response(new Uint8Array(stored), { status: 200, headers: { "content-type": "application/zip" } });
      }
      if (method !== "PUT") return jsonAnswer(405, { errors: [{ status: 405 }] });
      const user = userOf(headers);
      if (!user) return jsonAnswer(401, { errors: [{ status: 401, message: "Bad credentials" }] });
      if (!o.repos.includes(repo)) return jsonAnswer(404, { errors: [{ status: 404, message: `repository ${repo} not found` }] });
      if (!mayDeploy(user, repo)) return jsonAnswer(403, { errors: [{ status: 403, message: "Not enough permissions to deploy" }] });
      if (!body || body.length === 0) return jsonAnswer(400, { errors: [{ status: 400, message: "empty body" }] });
      try {
        if (!readZip(body).entries.some((e) => !e.dir && e.path.endsWith(".tf"))) return jsonAnswer(400, { errors: [{ status: 400, message: "the zip holds no .tf file" }] });
      } catch {
        return jsonAnswer(400, { errors: [{ status: 400, message: "not a zip archive" }] });
      }
      if (modules.has(k) && !o.redeploy) return jsonAnswer(409, { errors: [{ status: 409, message: "Redeploy is not allowed" }] });
      modules.set(k, body);
      if (o.indexAfter) unlisted.set(k, o.indexAfter);
      return jsonAnswer(201, { repo, path: `/${ns}/${name}/${system}/${version}.zip` });
    }
    return jsonAnswer(404, { errors: [{ status: 404 }] });
  };

  return {
    fetch,
    requests,
    modules,
    seed,
    failNext(status, count = 1) {
      failures = { status, count };
    },
  };
}
