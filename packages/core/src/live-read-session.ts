/**
 * One command, one read of the account (chant #2498).
 *
 * A `chant graph --live --traffic` against a live root reads the account
 * twice: once for the graph's observation and once for the prediction, and
 * each of those used to run `live-plan` twice for the document and its human
 * render. Four `live-plan` runs for one answer, which on a drifted estate
 * whose provider retries a deleted resource was five minutes against a
 * consumer's three-minute budget.
 *
 * Nothing shared a read because nothing could: a plugin method takes options
 * alone and cannot be handed the documents another method already holds. So
 * the sharing is ambient instead. A command that wants its reads shared runs
 * inside {@link withLiveReadSession}; a read that can be shared calls
 * {@link memoLiveRead} with a key naming everything that would change its
 * answer (root, directory, binary, flags, environment), and gets the pending
 * or settled promise of an identical read made earlier in the same session.
 *
 * The scope is the session, never the process. A watch Op ticking on a
 * schedule runs the same activity every tick and must see the account move,
 * so outside a session {@link memoLiveRead} simply reads. A rejection is
 * never memoised either: the next caller tries again, since a read that
 * failed on credentials or a timeout says nothing about the next one.
 *
 * `AsyncLocalStorage` carries the session across every `await` under the
 * wrapped call, which is how two plugin methods called one after the other
 * by one handler share it without either knowing about the other.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type Memo = Map<string, Promise<unknown>>;

const sessions = new AsyncLocalStorage<Memo>();

/**
 * Run `fn` with a fresh read session, so every {@link memoLiveRead} under
 * it with the same key is one read. A call already inside a session joins
 * it rather than opening a nested one: the outer command is the unit of
 * "once".
 */
export function withLiveReadSession<T>(fn: () => Promise<T>): Promise<T> {
  if (sessions.getStore()) return fn();
  return sessions.run(new Map(), fn);
}

/** Whether the caller is inside a {@link withLiveReadSession} scope. */
export function inLiveReadSession(): boolean {
  return sessions.getStore() !== undefined;
}

/**
 * The result of `read()`, shared with every earlier and later call in the
 * same session that names the same `key`. Outside a session, `read()` and
 * nothing else. A read that rejects is dropped from the session so the next
 * call with its key reads again.
 */
export function memoLiveRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const memo = sessions.getStore();
  if (!memo) return read();
  const shared = memo.get(key);
  if (shared) return shared as Promise<T>;
  const pending = read();
  memo.set(key, pending);
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key);
  });
  return pending;
}

/**
 * A key from the facts that decide a read's answer. Sorted keys, so two
 * callers that spell the same read in a different order share it.
 */
export function liveReadKey(activity: string, facts: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const name of Object.keys(facts).sort()) ordered[name] = facts[name];
  return `${activity}:${JSON.stringify(ordered)}`;
}
