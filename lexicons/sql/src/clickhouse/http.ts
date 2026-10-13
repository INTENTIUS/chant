/**
 * The smallest ClickHouse client chant needs: one SQL statement over the HTTP
 * interface, rows back as JSON objects.
 *
 * No driver dependency. ClickHouse's HTTP interface takes the statement as the
 * request body and `default_format=JSONEachRow` returns one JSON object per
 * line, which is all generation (and, later, observation and import) reads.
 */

import type { CredentialSource } from "../token-source";

/** Where a server answers, and as whom. */
export interface ClickHouseEndpoint {
  /** Base URL of the HTTP interface, e.g. `http://127.0.0.1:8123`. */
  url: string;
  user?: string;
  password?: string;
  /** Mints the password for each request, in place of `password` (a profile's token source, #3685). */
  token?: CredentialSource;
}

/** A query the server refused, with the server's own message. */
export class ClickHouseQueryError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
    readonly sql: string,
  ) {
    super(`ClickHouse answered ${status}: ${serverMessage.trim().split("\n")[0]}`);
    this.name = "ClickHouseQueryError";
  }
}

/** Per-query options. */
export interface QueryOptions {
  /**
   * The query's id on the server (`system.processes`, `KILL QUERY`). The
   * server refuses a second query with an id that is still running, which is
   * what a caller that must never run one statement twice at once relies on.
   */
  queryId?: string;
  /** Server settings for this query alone, e.g. `{ mutations_sync: "2" }`. */
  settings?: Record<string, string>;
  /** Abandons the request. The server may go on running a statement it already started. */
  signal?: AbortSignal;
}

/** Run one statement and return its rows. A statement that returns nothing yields `[]`. */
export async function clickhouseQuery<Row = Record<string, unknown>>(
  endpoint: ClickHouseEndpoint,
  sql: string,
  opts: QueryOptions = {},
): Promise<Row[]> {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (endpoint.user !== undefined) headers["X-ClickHouse-User"] = endpoint.user;
  const password = endpoint.token ? await endpoint.token.get() : endpoint.password;
  if (password !== undefined) headers["X-ClickHouse-Key"] = password;
  const params = new URLSearchParams({ default_format: "JSONEachRow", ...(opts.queryId !== undefined ? { query_id: opts.queryId } : {}), ...opts.settings });
  const res = await fetch(`${endpoint.url.replace(/\/$/, "")}/?${params.toString()}`, {
    method: "POST",
    headers,
    body: sql,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // A refused token is not reused: the next request mints another.
    if (endpoint.token && (res.status === 401 || res.status === 403 || /AUTHENTICATION_FAILED|Code: 516/.test(text))) endpoint.token.invalidate();
    throw new ClickHouseQueryError(res.status, text, sql);
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Row);
}

/** True when the server answers `/ping`. */
export async function clickhousePing(endpoint: ClickHouseEndpoint): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.url.replace(/\/$/, "")}/ping`);
    return res.ok;
  } catch {
    return false;
  }
}
