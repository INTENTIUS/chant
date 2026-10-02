/**
 * Test support for the trust modules: throwaway git repositories whose commits
 * are signed with throwaway ssh keys. Isolated from the user's git config, so a
 * developer's own signing setup never leaks into a test.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROTATION_NAMESPACE, rotationStatement, signersDigest } from "./rotation";

export const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { stdio: "ignore" }).error === undefined;

export interface Key {
  name: string;
  /** Private key file. */
  file: string;
  /** `ssh-ed25519 AAAA...`, no comment. */
  pub: string;
}

export class TestRepo {
  readonly dir: string;
  private readonly home: string;
  private readonly scratch: string;

  constructor(label: string) {
    this.scratch = mkdtempSync(join(tmpdir(), `chant-2547-${label}-`));
    this.dir = join(this.scratch, "repo");
    this.home = join(this.scratch, "home");
    mkdirSync(this.dir);
    mkdirSync(this.home);
    this.git(["init", "-q", "-b", "main"]);
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      HOME: this.home,
      GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
      ...extra,
    };
  }

  git(args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): string {
    return execFileSync("git", args, { cwd: this.dir, env: this.env(opts.env), input: opts.input, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  }

  key(name: string): Key {
    const file = join(this.scratch, `key-${name}`);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
    const pub = readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ");
    return { name, file, pub };
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }

  /** Stage everything and commit, signed with `key` when given. Returns the commit id. */
  commit(message: string, key?: Key, env: Record<string, string> = {}): string {
    this.git(["add", "-A"]);
    const sign = key ? ["-c", "gpg.format=ssh", "-c", `user.signingkey=${key.file}`, "commit", "-S"] : ["commit", "--no-gpg-sign"];
    this.git([...sign, "-q", "--allow-empty", "-m", message], { env });
    return this.head();
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  /**
   * Write a commit object by hand: the current index's tree, `HEAD` as parent,
   * and `signature` spliced in as the gpgsig header. Returns the new commit,
   * which HEAD then points at.
   */
  forgeCommit(message: string, sign: (payload: Buffer) => string): string {
    this.git(["add", "-A"]);
    const tree = this.git(["write-tree"]).trim();
    const parent = this.head();
    const payload = Buffer.from(
      `tree ${tree}\nparent ${parent}\nauthor t <t@example.test> 1700000000 +0000\ncommitter t <t@example.test> 1700000000 +0000\n\n${message}\n`,
    );
    const sig = sign(payload).trimEnd().split("\n");
    const head = payload.toString("latin1").split("\n\n")[0];
    const body = payload.toString("latin1").slice(head.length);
    const raw = `${head}\ngpgsig ${sig[0]}\n${sig.slice(1).map((l) => ` ${l}`).join("\n")}${body}`;
    const commit = this.git(["hash-object", "-t", "commit", "-w", "--stdin"], { input: Buffer.from(raw, "latin1") }).trim();
    this.git(["update-ref", "HEAD", commit]);
    return commit;
  }

  /** An ssh signature over `payload` in `namespace`, by `key`. */
  sshSign(key: Key, payload: Buffer, namespace: string): string {
    const f = join(this.scratch, `payload-${Math.random().toString(36).slice(2)}`);
    writeFileSync(f, payload);
    execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", namespace, "-f", key.file, f], { stdio: "ignore" });
    return readFileSync(`${f}.sig`, "utf-8");
  }

  cleanup(): void {
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

/**
 * Write `<signers>.rotation.json` for the signers file now in the working
 * tree, as the next version after `previousText`, signed by `by` in the
 * rotation namespace (#2553).
 */
export function writeRotation(
  repo: TestRepo,
  opts: { previousText: string; version: number; threshold?: number; by: Array<[string, Key]>; namespace?: string; signersPath?: string },
): void {
  const path = opts.signersPath ?? ".chant/allowed_signers";
  const text = readFileSync(join(repo.dir, path), "utf-8");
  const rotation = { version: opts.version, previous: signersDigest(opts.previousText), threshold: opts.threshold ?? 1 };
  const statement = rotationStatement(rotation, signersDigest(text));
  const signatures = opts.by.map(([principal, key]) => ({ principal, signature: repo.sshSign(key, statement, opts.namespace ?? ROTATION_NAMESPACE) }));
  repo.write(`${path}.rotation.json`, JSON.stringify({ schema: 1, ...rotation, signatures }, null, 2));
}

/** A record kind reading `records/*.md`, and its schema, written into `repo`. */
export function writeRecordKind(repo: TestRepo): string {
  repo.write(
    "kinds/note.kind.mjs",
    `export const recordKind = {
  name: "note",
  location: { dir: "../records", match: "\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:test:note:1", path: "note.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["open", "closed"],
  closedStates: ["closed"],
  supersedes: { field: "supersedes", key: "note" },
};
`,
  );
  repo.write(
    "kinds/note.schema.json",
    JSON.stringify({ $id: "urn:test:note:1", type: "object", required: ["id", "state"], properties: { id: { type: "string" }, state: { type: "string" } } }),
  );
  return "kinds/note.kind.mjs";
}

export function note(id: string, body = ""): string {
  return `---\nid: ${id}\nstate: open\n---\n${body}\n`;
}
