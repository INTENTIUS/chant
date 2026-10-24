/**
 * Options that hold a credential. A foreign data wrapper's or server's
 * `OPTIONS (...)` can carry any name, and a password in one would be written
 * into a schema file by import and sent to every reader of the plan. The
 * environment supplies credentials, in a user mapping (which is not declared)
 * or its own secret store, as for a role's password (`./entities.ts`).
 */

/** Whether an option name reads as a credential: `password`, `sslpassword`, `secret_key`, `api_token`. */
export const isSecretOption = (name: string): boolean => /pass(word|wd)?|secret|token|api[_-]?key|credential/i.test(name);
