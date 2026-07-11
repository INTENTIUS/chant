/**
 * In-process Sprites emulator (#762, S7) — a v0 fake of the Sprites REST surface
 * for offline, Docker-free integration tests.
 *
 * It models the lifecycle state machine and checkpoint/restore semantics, not
 * real Firecracker VMs or real code execution (that fidelity is out of scope).
 * A sprite's filesystem is a `Record<string, string>`; `exec` runs a small
 * scripted interpreter that can write/modify an `fs` key so checkpoint/restore
 * is observable; `checkpoint` deep-copies `fs` under a label; `restore` replaces
 * `fs` with that copy. Started in-process by a test and reached via
 * `SPRITES_BASE_URL`, so the same activities that hit real Sprites hit the fake.
 *
 * TODO(confirm against sprites.dev API): the endpoint shapes mirror the
 * provisional surface in `sprites.ts` (S6); align both together once confirmed.
 */

import { createServer, type Server } from "node:http";

type SpriteStatus = "starting" | "running" | "paused" | "destroyed";

interface SpriteState {
  id: string;
  status: SpriteStatus;
  url: string;
  /** Filesystem model: path → contents. */
  fs: Record<string, string>;
  /** Checkpoints keyed by label; each a full copy of `fs` at checkpoint time. */
  checkpoints: Map<string, Record<string, string>>;
  policy?: unknown;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one command against a sprite's `fs`. Not a real shell: it recognizes a
 * small set of forms so a test (and the example `guarded-task` Op) can write a
 * key, then overwrite/fail it, and prove restore rewinds. Segments split on
 * `;` run in order; the exit code is the last segment's (shell `;` semantics).
 */
export function fakeExec(sprite: SpriteState, cmd: string): ExecResult {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const raw of cmd.split(";")) {
    const seg = raw.trim();
    if (!seg) continue;

    let m: RegExpMatchArray | null;
    if ((m = seg.match(/^echo\s+(.+?)\s*>\s*(\S+)$/))) {
      sprite.fs[m[2]] = unquote(m[1]);
      exitCode = 0;
    } else if ((m = seg.match(/^echo\s+(.+)$/))) {
      stdout += `${unquote(m[1])}\n`;
      exitCode = 0;
    } else if ((m = seg.match(/^cat\s+(\S+)$/))) {
      stdout += sprite.fs[m[1]] ?? "";
      exitCode = 0;
    } else if ((m = seg.match(/^rm\s+(?:-f\s+)?(\S+)$/))) {
      delete sprite.fs[m[1]];
      exitCode = 0;
    } else if (seg === "false") {
      exitCode = 1;
    } else if (seg === "true") {
      exitCode = 0;
    } else if (seg === "./risky.sh") {
      // A scripted failing job: mutates the workspace, then exits non-zero, so
      // the example guarded-task Op demonstrates checkpoint-as-compensation.
      sprite.fs["/work/output"] = "partial-corrupt";
      stderr += "risky.sh: failed\n";
      exitCode = 1;
    } else {
      // Unknown command → echo it back (a no-op success), never real execution.
      stdout += `${seg}\n`;
      exitCode = 0;
    }
  }

  return { stdout, stderr, exitCode };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** A full copy of an `fs` map. Values are strings, so a shallow spread copies them. */
function copyFs(fs: Record<string, string>): Record<string, string> {
  return { ...fs };
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Start the in-process Sprites fake on an ephemeral port. Returns its base
 * `url` (feed it to `SPRITES_BASE_URL`) and a `close()`.
 */
export function createSpritesFake(): Promise<{ url: string; close(): Promise<void> }> {
  const sprites = new Map<string, SpriteState>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  async function handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const host = req.headers.host ?? "localhost";
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    };

    // POST /v1/sprites — create.
    if (method === "POST" && /^\/v1\/sprites\/?$/.test(path)) {
      const body = ((await readBody(req)) ?? {}) as { name?: string; policy?: unknown };
      const id = body.name;
      if (!id) return send(400, { error: "name is required" });
      const sprite: SpriteState = {
        id,
        status: "running",
        url: `http://${host}/s/${encodeURIComponent(id)}`,
        fs: {},
        checkpoints: new Map(),
        policy: body.policy,
      };
      sprites.set(id, sprite);
      return send(201, { id: sprite.id, url: sprite.url });
    }

    const m = path.match(/^\/v1\/sprites\/([^/]+)(\/exec|\/checkpoints|\/restore)?\/?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];
      const sprite = sprites.get(id);
      if (!sprite || sprite.status === "destroyed") return send(404, { error: `no sprite ${id}` });

      // POST /v1/sprites/{id}/exec
      if (method === "POST" && sub === "/exec") {
        const body = ((await readBody(req)) ?? {}) as { cmd?: string };
        const result = fakeExec(sprite, body.cmd ?? "");
        return send(200, result);
      }

      // POST /v1/sprites/{id}/checkpoints — deep-copy fs under the label.
      if (method === "POST" && sub === "/checkpoints") {
        const body = ((await readBody(req)) ?? {}) as { label?: string };
        const label = body.label ?? `cp-${sprite.checkpoints.size + 1}`;
        sprite.checkpoints.set(label, copyFs(sprite.fs));
        return send(201, { checkpointId: label });
      }

      // POST /v1/sprites/{id}/restore — replace fs with the labeled checkpoint's copy.
      if (method === "POST" && sub === "/restore") {
        const body = ((await readBody(req)) ?? {}) as { checkpoint?: string };
        const label = body.checkpoint;
        if (!label || !sprite.checkpoints.has(label)) {
          return send(404, { error: `no checkpoint "${label}" for sprite ${id}` });
        }
        sprite.fs = copyFs(sprite.checkpoints.get(label)!);
        sprite.status = "running";
        return send(200, {});
      }

      // DELETE /v1/sprites/{id}
      if (method === "DELETE" && !sub) {
        sprite.status = "destroyed";
        return send(200, {});
      }

      // GET /v1/sprites/{id} — inspection (fs + checkpoints), used by tests/verify.
      if (method === "GET" && !sub) {
        return send(200, {
          id: sprite.id,
          status: sprite.status,
          url: sprite.url,
          fs: sprite.fs,
          checkpoints: [...sprite.checkpoints.keys()],
        });
      }
    }

    return send(404, { error: `not found: ${method} ${path}` });
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
