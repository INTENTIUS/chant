/**
 * In-process Sprites fake (#762, #766, S7) — a fake of the faithful Sprites API
 * surface for offline, Docker-free integration tests.
 *
 * It models the lifecycle state machine and checkpoint/restore semantics, not
 * real Firecracker VMs or real code execution (that fidelity is out of scope).
 * A sprite's filesystem is a `Record<string, string>`; `exec` runs a small
 * scripted interpreter that can write/modify an `fs` key so checkpoint/restore
 * is observable; `checkpoint` deep-copies `fs` under a version id; `restore`
 * replaces `fs` with that copy. Started in-process by a test and reached via
 * `SPRITES_BASE_URL`, so the same activities that hit real Sprites hit the fake.
 *
 * The wire surface matches the released `spritzer:0.3.1` image so the CI
 * fake-based test and the docker test exercise the same protocol:
 *  - `exec` over the control WebSocket with `[StreamID][payload]` binary framing;
 *  - `POST /checkpoint` (singular) returning NDJSON progress + a `complete` event;
 *  - `GET /checkpoints` returning a bare array of `{ id, comment, create_time, is_auto }`;
 *  - `POST /checkpoints/{id}/restore` returning NDJSON.
 * Checkpoint ids are server versions (`v1`, `v2`, ...).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

type SpriteStatus = "starting" | "running" | "paused" | "destroyed";

interface StoredCheckpoint {
  id: string;
  comment: string;
  create_time: string;
  is_auto: boolean;
  fs: Record<string, string>;
}

interface SpriteState {
  id: string;
  status: SpriteStatus;
  url: string;
  /** Filesystem model: path → contents. */
  fs: Record<string, string>;
  /** Checkpoints in creation order; each holds a full copy of `fs` at that time. */
  checkpoints: StoredCheckpoint[];
  /** Monotonic version counter for `v<N>` ids. */
  version: number;
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

// Stream ids for the non-PTY exec framing (mirror sprites.ts).
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const STREAM_EXIT = 3;

function frame(stream: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.of(stream), payload]);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
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

  // The control WebSocket exec endpoint. noServer + a manual `upgrade` handler so
  // the same http server serves both the REST/NDJSON routes and the exec socket.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const m = url.pathname.match(/^\/v1\/sprites\/([^/]+)\/exec\/?$/);
    if (!m) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => runExec(ws, sprites.get(id), url));
  });

  function runExec(ws: WebSocket, sprite: SpriteState | undefined, url: URL): void {
    if (!sprite || sprite.status === "destroyed") {
      ws.send(frame(STREAM_STDERR, Buffer.from(`no sprite\n`)));
      ws.send(frame(STREAM_EXIT, Buffer.of(127)));
      ws.close();
      return;
    }
    // argv arrives as repeated `cmd` params; reconstruct the script the small
    // interpreter understands (the tokens round-trip for the space-separated
    // command forms the example Ops use).
    const argv = url.searchParams.getAll("cmd");
    const script = argv.join(" ");
    const result = fakeExec(sprite, script);
    if (result.stdout) ws.send(frame(STREAM_STDOUT, Buffer.from(result.stdout)));
    if (result.stderr) ws.send(frame(STREAM_STDERR, Buffer.from(result.stderr)));
    ws.send(frame(STREAM_EXIT, Buffer.of(result.exitCode & 0xff)));
    ws.close();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const host = req.headers.host ?? "localhost";
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    };
    // NDJSON progress stream: an `info` line then a terminal `complete` line.
    const sendNdjson = (status: number, events: Array<Record<string, unknown>>): void => {
      res.writeHead(status, { "content-type": "application/x-ndjson" });
      res.end(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
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
        checkpoints: [],
        version: 0,
        policy: body.policy,
      };
      sprites.set(id, sprite);
      return send(201, { id: sprite.id, url: sprite.url });
    }

    const m = path.match(/^\/v1\/sprites\/([^/]+)(\/checkpoint|\/checkpoints(?:\/([^/]+)(\/restore)?)?)?\/?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];
      const cpId = m[3] ? decodeURIComponent(m[3]) : undefined;
      const isRestore = Boolean(m[4]);
      const sprite = sprites.get(id);
      if (!sprite || sprite.status === "destroyed") return send(404, { error: `no sprite ${id}` });

      // POST /v1/sprites/{id}/checkpoint — snapshot fs under a new version id.
      if (method === "POST" && sub === "/checkpoint") {
        const body = ((await readBody(req)) ?? {}) as { comment?: string };
        sprite.version += 1;
        const cp: StoredCheckpoint = {
          id: `v${sprite.version}`,
          comment: body.comment ?? "",
          create_time: new Date().toISOString(),
          is_auto: false,
          fs: copyFs(sprite.fs),
        };
        sprite.checkpoints.push(cp);
        // Mirror real Sprites: `{type, data}` progress lines carrying the
        // version id in the message text, not a structured field.
        return sendNdjson(200, [
          { type: "info", data: "Creating checkpoint..." },
          { type: "info", data: "Checkpoint created successfully" },
          { type: "info", data: `  ID: ${cp.id}` },
          { type: "complete", data: `Checkpoint ${cp.id} created successfully` },
        ]);
      }

      // GET /v1/sprites/{id}/checkpoints — bare array (auto excluded).
      if (method === "GET" && sub === "/checkpoints" && !cpId) {
        return send(
          200,
          sprite.checkpoints
            .filter((c) => !c.is_auto)
            .map((c) => ({ id: c.id, comment: c.comment, create_time: c.create_time, is_auto: c.is_auto })),
        );
      }

      // GET /v1/sprites/{id}/checkpoints/{cp} — a single checkpoint.
      if (method === "GET" && cpId && !isRestore) {
        const cp = sprite.checkpoints.find((c) => c.id === cpId);
        if (!cp) return send(404, { error: `no checkpoint ${cpId} for sprite ${id}` });
        return send(200, { id: cp.id, comment: cp.comment, create_time: cp.create_time });
      }

      // POST /v1/sprites/{id}/checkpoints/{cp}/restore — replace fs with the snapshot.
      if (method === "POST" && cpId && isRestore) {
        const cp = sprite.checkpoints.find((c) => c.id === cpId);
        if (!cp) return send(404, { error: `no checkpoint ${cpId} for sprite ${id}` });
        sprite.fs = copyFs(cp.fs);
        sprite.status = "running";
        return sendNdjson(200, [
          { type: "info", data: `Restoring checkpoint ${cpId}...` },
          { type: "complete", data: `Checkpoint ${cpId} restored successfully` },
        ]);
      }

      // DELETE /v1/sprites/{id}
      if (method === "DELETE" && !sub) {
        sprite.status = "destroyed";
        return send(200, {});
      }

      // GET /v1/sprites/{id} — inspection (fs + checkpoint ids), used by tests/verify.
      if (method === "GET" && !sub) {
        return send(200, {
          id: sprite.id,
          status: sprite.status,
          url: sprite.url,
          fs: sprite.fs,
          checkpoints: sprite.checkpoints.map((c) => c.id),
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
            wss.close();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
