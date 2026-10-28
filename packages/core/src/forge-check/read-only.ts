/**
 * The forge check's one way out (#4608): every request it makes passes
 * {@link assertReadOnly} first. GET and HEAD go through, and a POST only
 * when it is an AWS Query API read named in {@link READ_ACTIONS}. Anything
 * else is refused before it is sent, so the check cannot write to a forge,
 * a cloud or Pulumi Cloud.
 *
 * Lifted from terragucci's `forge check` (INTENTIUS/terragucci
 * packages/terragucci/src/forge-check.ts, `assertReadOnly` and `readOnly`).
 */

import type { ForgeFetch } from "../pr-forge";

/** The AWS Query API actions a request may name: reads alone. */
export const READ_ACTIONS: readonly string[] = ["GetRole"];

export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

/**
 * Refuse any request that could write: a method other than GET or HEAD, or an
 * AWS Query action (`Action=` in the query or a form body) not in
 * READ_ACTIONS. A POST passes only as such a read action, which the Query API
 * takes as GET or POST alike. `command` names the command in the message.
 */
export function assertReadOnly(url: string, method: string, body?: string, command = "chant ci forge-check"): void {
  const m = method.toUpperCase();
  let queryAction: string | null = null;
  try {
    queryAction = new URL(url).searchParams.get("Action");
  } catch {
    throw new ReadOnlyError(`${command} refuses ${m} ${url}: not a URL`);
  }
  const named = (a: string | null): boolean => a === null || READ_ACTIONS.includes(a);
  if (m === "GET" || m === "HEAD") {
    if (named(queryAction)) return;
    throw new ReadOnlyError(`${command} is read-only: it refuses the action ${queryAction} (${m} ${url}); it may call ${READ_ACTIONS.join(", ")}`);
  }
  if (m === "POST" && typeof body === "string") {
    const bodyAction = new URLSearchParams(body).get("Action");
    if (bodyAction !== null && READ_ACTIONS.includes(bodyAction) && named(queryAction)) return;
  }
  throw new ReadOnlyError(`${command} is read-only: it refuses ${m} ${url}`);
}

/** `fetch`, refusing every request {@link assertReadOnly} refuses before it is sent. */
export function readOnly(fetch: ForgeFetch, command?: string): ForgeFetch {
  return async (url, init) => {
    assertReadOnly(url, init.method, init.body, command);
    return fetch(url, init);
  };
}
