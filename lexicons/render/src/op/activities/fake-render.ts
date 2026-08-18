/**
 * An in-memory stand-in for the Render Public API, for tests. Implements the
 * slice of routes the applier and the observation seam use — list/create/
 * patch/delete for every collection in the catalog, service env vars, env
 * group vars and links, deploys, connection-info, owners — with Render's list
 * envelope (`[{ service: {...}, cursor }]`) and id prefixes. Not an emulator of
 * Render's semantics beyond what chant relies on; it exists so the reconcile
 * loop is tested end to end without an account.
 */

import type { RenderHttp } from "./render-apply";

type Rec = Record<string, unknown>;

interface Collection {
  key: string;
  prefix: string;
  items: Map<string, Rec>;
}

export class FakeRender {
  readonly owners: Rec[] = [{ id: "tea-1", name: "Acme", email: "ops@acme.test", type: "team" }];
  readonly collections: Record<string, Collection> = {
    "/services": { key: "service", prefix: "srv", items: new Map() },
    "/postgres": { key: "postgres", prefix: "dpg", items: new Map() },
    "/key-value": { key: "keyValue", prefix: "red", items: new Map() },
    "/env-groups": { key: "envGroup", prefix: "evg", items: new Map() },
    "/projects": { key: "project", prefix: "prj", items: new Map() },
    "/environments": { key: "environment", prefix: "evm", items: new Map() },
    "/disks": { key: "disk", prefix: "dsk", items: new Map() },
    "/registrycredentials": { key: "registryCredential", prefix: "rgc", items: new Map() },
    "/webhooks": { key: "webhook", prefix: "whk", items: new Map() },
  };
  /** serviceId → env vars */
  readonly serviceEnv = new Map<string, Array<{ key: string; value: string }>>();
  /** serviceId → deploys (newest first) */
  readonly deploys = new Map<string, Array<{ id: string; status: string }>>();
  /** serviceId → custom domains */
  readonly domains = new Map<string, Rec[]>();
  /** Every call, for assertions. */
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Deploys go live after this many polls (0 = immediately). */
  deployPolls = 0;
  private counter = 0;

  id(prefix: string): string {
    this.counter++;
    return `${prefix}-${String(this.counter).padStart(20, "0")}`;
  }

  /** Seed a resource directly. */
  seed(collection: string, rec: Rec): Rec {
    const c = this.collections[collection];
    const id = typeof rec.id === "string" ? rec.id : this.id(c.prefix);
    const full = { id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...rec };
    c.items.set(id, full);
    if (collection === "/services") {
      this.serviceEnv.set(id, [...((rec.envVars as Array<{ key: string; value: string }>) ?? [])]);
      this.deploys.set(id, [{ id: this.id("dep"), status: "live" }]);
    }
    return full;
  }

  service(name: string): Rec | undefined {
    return [...this.collections["/services"].items.values()].find((s) => s.name === name);
  }

  http(): RenderHttp {
    return async (method, url, body) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v1/, "");
      this.calls.push({ method, path, body });
      return this.route(method, path, u.searchParams, body);
    };
  }

  private json(status: number, value: unknown): { status: number; text: string } {
    return { status, text: value === undefined ? "" : JSON.stringify(value) };
  }

  private route(method: string, path: string, q: URLSearchParams, body: unknown): { status: number; text: string } {
    const b = (body ?? {}) as Rec;

    if (path === "/owners" && method === "GET") {
      return this.json(200, this.owners.map((o) => ({ owner: o, cursor: String(o.id) })));
    }

    // Service sub-resources.
    let m = path.match(/^\/services\/([^/]+)\/env-vars$/);
    if (m) {
      const id = m[1];
      if (!this.collections["/services"].items.has(id)) return this.json(404, { message: "not found" });
      if (method === "GET") {
        return this.json(200, (this.serviceEnv.get(id) ?? []).map((e) => ({ envVar: e, cursor: e.key })));
      }
      if (method === "PUT") {
        const list = (body as Array<{ key: string; value?: string; generateValue?: boolean }>).map((e) => ({
          key: e.key,
          value: e.value ?? (e.generateValue ? `gen-${e.key}` : ""),
        }));
        this.serviceEnv.set(id, list);
        return this.json(200, list.map((e) => ({ envVar: e, cursor: e.key })));
      }
    }
    m = path.match(/^\/services\/([^/]+)\/deploys$/);
    if (m && method === "GET") {
      const list = this.deploys.get(m[1]) ?? [];
      return this.json(200, list.map((d) => ({ deploy: this.tickDeploy(d), cursor: d.id })));
    }
    m = path.match(/^\/services\/([^/]+)\/deploys\/([^/]+)$/);
    if (m && method === "GET") {
      const d = (this.deploys.get(m[1]) ?? []).find((x) => x.id === m![2]);
      if (!d) return this.json(404, { message: "not found" });
      return this.json(200, this.tickDeploy(d));
    }
    m = path.match(/^\/services\/([^/]+)\/custom-domains$/);
    if (m) {
      const id = m[1];
      if (!this.collections["/services"].items.has(id)) return this.json(404, { message: "not found" });
      const list = this.domains.get(id) ?? [];
      if (method === "GET") return this.json(200, list.map((d) => ({ customDomain: d, cursor: d.id })));
      if (method === "POST") {
        const d = { id: this.id("cd"), name: b.name, domainType: "apex", verificationStatus: "unverified", createdAt: "2026-01-01T00:00:00Z" };
        list.push(d);
        this.domains.set(id, list);
        return this.json(201, [d]);
      }
    }
    m = path.match(/^\/services\/([^/]+)\/custom-domains\/([^/]+)$/);
    if (m && method === "DELETE") {
      const list = this.domains.get(m[1]) ?? [];
      const idx = list.findIndex((d) => d.id === m![2] || d.name === m![2]);
      if (idx < 0) return this.json(404, {});
      list.splice(idx, 1);
      return this.json(204, undefined);
    }

    // Datastore connection info.
    m = path.match(/^\/(postgres|key-value)\/([^/]+)\/connection-info$/);
    if (m && method === "GET") {
      const c = this.collections[`/${m[1]}`];
      const rec = c.items.get(m[2]);
      if (!rec) return this.json(404, {});
      return this.json(200, {
        internalConnectionString: `internal://${rec.name}`,
        externalConnectionString: `external://${rec.name}`,
        psqlCommand: `psql ${rec.name}`,
        cliCommand: `redis-cli ${rec.name}`,
      });
    }

    // Env group vars and links.
    m = path.match(/^\/env-groups\/([^/]+)\/env-vars\/([^/]+)$/);
    if (m) {
      const grp = this.collections["/env-groups"].items.get(m[1]);
      if (!grp) return this.json(404, {});
      const vars = (grp.envVars as Array<{ key: string; value: string }>) ?? [];
      const key = decodeURIComponent(m[2]);
      if (method === "PUT") {
        const value = typeof b.value === "string" ? b.value : `gen-${key}`;
        const idx = vars.findIndex((v) => v.key === key);
        if (idx >= 0) vars[idx] = { key, value };
        else vars.push({ key, value });
        grp.envVars = vars;
        return this.json(200, { key, value });
      }
      if (method === "DELETE") {
        grp.envVars = vars.filter((v) => v.key !== key);
        return this.json(204, undefined);
      }
    }
    m = path.match(/^\/env-groups\/([^/]+)\/services\/([^/]+)$/);
    if (m && method === "POST") {
      const grp = this.collections["/env-groups"].items.get(m[1]);
      if (!grp) return this.json(404, {});
      const links = (grp.serviceLinks as Rec[]) ?? [];
      if (!links.some((l) => l.id === m![2])) links.push({ id: m[2], name: m[2], type: "web_service" });
      grp.serviceLinks = links;
      return this.json(200, grp);
    }

    // Collections.
    for (const [collection, c] of Object.entries(this.collections)) {
      if (path === collection) {
        if (method === "GET") {
          let items = [...c.items.values()];
          const name = q.get("name");
          const ownerId = q.get("ownerId");
          const projectId = q.get("projectId");
          const serviceId = q.get("serviceId");
          if (name) items = items.filter((i) => i.name === name);
          // Disks/domains carry no ownerId field on the wire; Render scopes them
          // server-side. The fake has one owner, so only filter what has one.
          if (ownerId) items = items.filter((i) => (i.ownerId === undefined && i.owner === undefined) || i.ownerId === ownerId || (i.owner as Rec | undefined)?.id === ownerId);
          if (projectId) items = items.filter((i) => i.projectId === projectId);
          if (serviceId) items = items.filter((i) => i.serviceId === serviceId);
          return this.json(200, items.map((i) => ({ [c.key]: i, cursor: String(i.id) })));
        }
        if (method === "POST") {
          const id = this.id(c.prefix);
          const rec: Rec = { ...b, id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
          if (collection === "/services") {
            const env = ((b.envVars as Array<{ key: string; value?: string; generateValue?: boolean }>) ?? []).map((e) => ({
              key: e.key,
              value: e.value ?? `gen-${e.key}`,
            }));
            delete rec.envVars;
            delete rec.secretFiles;
            rec.dashboardUrl = `https://dashboard.render.com/web/${id}`;
            rec.slug = String(b.name);
            rec.suspended = "not_suspended";
            this.serviceEnv.set(id, env);
            const dep = { id: this.id("dep"), status: this.deployPolls > 0 ? "build_in_progress" : "live" };
            this.deploys.set(id, [dep]);
            c.items.set(id, rec);
            return this.json(201, { service: rec, deployId: dep.id });
          }
          if (collection === "/env-groups") {
            rec.envVars = ((b.envVars as Array<{ key: string; value?: string; generateValue?: boolean }>) ?? []).map((e) => ({
              key: e.key,
              value: e.value ?? `gen-${e.key}`,
            }));
            rec.serviceLinks = ((b.serviceIds as string[]) ?? []).map((sid) => ({ id: sid, name: sid, type: "web_service" }));
            delete rec.serviceIds;
          }
          if (collection === "/projects") {
            rec.owner = { id: b.ownerId, name: "Acme", email: "", type: "team" };
            rec.environmentIds = [];
          }
          if (collection === "/postgres" || collection === "/key-value") {
            rec.owner = { id: b.ownerId, name: "Acme", email: "", type: "team" };
            rec.status = "available";
            rec.dashboardUrl = `https://dashboard.render.com/d/${id}`;
          }
          c.items.set(id, rec);
          return this.json(201, rec);
        }
      }
      const one = path.match(new RegExp(`^${collection.replace(/[-/]/g, "\\$&")}/([^/]+)$`));
      if (one) {
        const id = one[1];
        const rec = c.items.get(id);
        if (!rec) return this.json(404, { message: "not found" });
        if (method === "GET") return this.json(200, rec);
        if (method === "PATCH") {
          const updated: Rec = { ...rec, ...b, updatedAt: "2026-01-02T00:00:00Z" };
          if (rec.serviceDetails && b.serviceDetails) {
            updated.serviceDetails = { ...(rec.serviceDetails as Rec), ...(b.serviceDetails as Rec) };
          }
          c.items.set(id, updated);
          if (collection === "/services") {
            const deps = this.deploys.get(id) ?? [];
            deps.unshift({ id: this.id("dep"), status: "live" });
          }
          return this.json(200, updated);
        }
        if (method === "DELETE") {
          c.items.delete(id);
          return this.json(204, undefined);
        }
      }
    }

    return this.json(404, { message: `fake-render: no route for ${method} ${path}` });
  }

  /** Advance a pending deploy toward `live` on each poll. */
  private tickDeploy(d: { id: string; status: string }): { id: string; status: string } {
    if (d.status !== "live" && this.deployPolls > 0) {
      this.deployPolls--;
      if (this.deployPolls === 0) d.status = "live";
    }
    return { ...d };
  }
}
