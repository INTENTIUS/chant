/**
 * A stand-in for a ClickHouse server's HTTP interface, for tests: answers the
 * catalog queries chant's live reads make from a fixed set of objects.
 * Not a SQL engine.
 */

import { createServer, type Server } from "node:http";

export interface FakeObject {
  database?: string;
  name: string;
  engine: string;
  statement: string;
  comment?: string;
}

export interface FakeServer {
  url: string;
  queries: string[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Answer every query with this status and body (an auth failure, say). */
  fail?: { status: number; body: string };
  version?: string;
}

const row = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const unquote = (s: string) => s.replace(/^`|`$/g, "").replace(/``/g, "`");

export async function fakeClickHouse(objects: FakeObject[], options: FakeOptions = {}): Promise<FakeServer> {
  const queries: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      queries.push(body);
      if (options.fail) {
        res.statusCode = options.fail.status;
        res.end(options.fail.body);
        return;
      }
      if (/version\(\)/.test(body)) return res.end(row({ v: options.version ?? "26.8.15.10" }));
      if (/FROM system\.databases/.test(body)) {
        return res.end(
          objects
            .filter((o) => o.database === undefined)
            .map((o) => row({ name: o.name, engine: o.engine, uuid: "00000000-0000-0000-0000-000000000000", comment: o.comment ?? "" }))
            .join(""),
        );
      }
      if (/FROM system\.tables/.test(body)) {
        return res.end(
          objects
            .filter((o) => o.database !== undefined)
            .map((o) => row({ database: o.database, name: o.name, engine: o.engine, uuid: "00000000-0000-0000-0000-000000000000", comment: o.comment ?? "" }))
            .join(""),
        );
      }
      const show = /^SHOW CREATE (DATABASE|TABLE) (`(?:[^`]|``)*`)(?:\.(`(?:[^`]|``)*`))?$/.exec(body.trim());
      if (show) {
        const [db, name] = show[3] ? [unquote(show[2]!), unquote(show[3])] : [undefined, unquote(show[2]!)];
        const o = objects.find((x) => x.database === db && x.name === name);
        if (o) return res.end(row({ statement: o.statement }));
        res.statusCode = 404;
        return res.end(`Code: 60. DB::Exception: Table ${name} does not exist. (UNKNOWN_TABLE)`);
      }
      res.statusCode = 400;
      res.end(`fake ClickHouse cannot answer: ${body.slice(0, 80)}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, queries, close: () => new Promise((r) => server.close(() => r())) };
}
