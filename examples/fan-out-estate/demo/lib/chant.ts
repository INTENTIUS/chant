/**
 * chant, for real, outside the pipeline. `chant approve` runs from a fresh
 * clone of the demo repo as the reviewer, with the checkout's chant, so the
 * gate line it pushes to chant/lifecycle is on the demo forge and is the
 * reviewer's. The base is applied in the job image on the stack's network,
 * where floci is `floci:4566`, the address the `demo` environment names.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../steps.js";
import { CHECKOUT, assertOwnRepo, clone, git, remoteWith, run } from "./git.js";
import type { Person } from "./forgejo.js";
import type { ApproveInput, Chant } from "./ports.js";

export interface RealChantOptions {
  forgeUrl: string;
  reviewer: Person;
  /** The reviewer's ssh private key, which seals the approval. */
  reviewerKey: string;
  /** The base tree, a git repository holding the base commit. */
  baseTree: string;
  jobImage: string;
  network: string;
}

/** The checkout's chant CLI. */
export const CHANT_BIN = join(CHECKOUT, "node_modules", ".bin", "chant");

/** The environment for a chant run on the host: none of a CI job's variables, so chant reads the clone alone. */
function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (key === "CI" || key.startsWith("GITHUB_") || key.startsWith("GITLAB_") || key.startsWith("FORGEJO_") || key.startsWith("CHANT_")) delete env[key];
  }
  return env;
}

export class RealChant implements Chant {
  constructor(private readonly o: RealChantOptions) {}

  async approve(input: ApproveInput): Promise<void> {
    const r = this.o.reviewer;
    const dir = await clone(remoteWith(this.o.forgeUrl, r.login, r.token, REPO), "reviewer", [r.token]);
    try {
      await git(dir, ["config", "user.name", r.login]);
      await git(dir, ["config", "user.email", `${r.login}@chant-demo.local`]);
      assertOwnRepo(dir);
      const out = await run(
        CHANT_BIN,
        ["approve", input.op, input.gate, "--plan", input.digest, "--approver", input.approver, "--sign", this.o.reviewerKey],
        { cwd: dir, env: hostEnv(), timeoutMs: 120_000, redact: [r.token] },
      );
      const said = `${out.stdout}\n${out.stderr}`;
      if (/did not land|local only/.test(said)) throw new Error(`chant approve ${input.op} ${input.gate} did not push its gate line: ${said.trim().split("\n").pop()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async applyBase(): Promise<void> {
    assertOwnRepo(this.o.baseTree);
    const script = [
      "set -e",
      "mkdir /w",
      "tar -C /src --exclude ./.git -cf - . | tar -C /w -xf -",
      "cd /w",
      "npm run build >/dev/null",
      "chant run --components all --env demo --no-release-record",
    ].join("; ");
    await run(
      "docker",
      [
        "run", "--rm", "--network", this.o.network,
        "-e", "AWS_ENDPOINT_URL=http://floci:4566",
        "-e", "AWS_ACCESS_KEY_ID=test",
        "-e", "AWS_SECRET_ACCESS_KEY=test",
        "-e", "AWS_REGION=us-east-1",
        "-v", `${this.o.baseTree}:/src:ro`,
        this.o.jobImage, "sh", "-c", script,
      ],
      { timeoutMs: 600_000 },
    );
  }
}
