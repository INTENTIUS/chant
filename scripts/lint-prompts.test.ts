import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error: plain .mjs modules with no type declarations
import { checkPrompt, frontPrompt } from "./lint-prompts.mjs";
// @ts-expect-error: plain .mjs modules with no type declarations
import { neverLine, setupPrompt } from "../docs/src/prompts.mjs";

const SCRIPT = join(import.meta.dirname, "lint-prompts.mjs");
const SITE = "https://intentius.io/chant";

let root: string;

function write(path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** A page with front matter; `prompt` is written as a `|` block, or as one line when it has none. */
function page(path: string, fields: string, prompt?: string): void {
  const block = prompt === undefined ? "" : prompt.includes("\n") ? `\nprompt: |\n${prompt.replace(/^/gm, "  ")}` : `\nprompt: ${prompt}`;
  write(path, `---\ntitle: T\n${fields}${block}\n---\n\nBody.\n`);
}

const promptFor = (slug: string, ...lines: string[]) => [`Read ${SITE}/${slug}/.`, ...lines, neverLine].join("\n");

function run(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, CHANT_PROMPTS_ROOT: root }, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-prompts-"));
  write("README.md", "# chant\n\n```text\n" + setupPrompt + "\n```\n");
  write("docs/src/components/Landing.astro", "<AgentPrompt text={setupPrompt} />\n");
  write("docs/src/content/docs/index.mdx", '---\ntitle: chant\n---\n\n## Hand the setup to your coding agent\n\n<Landing part="agent" />\n');
  page("docs/src/content/docs/agents.mdx", "diataxis: how-to", "setup");
  page("docs/src/content/docs/guide/ops.mdx", "diataxis: how-to", promptFor("guide/ops", "Write the Op, run `npx chant build`, and open a pull request."));
  page("docs/src/content/docs/concepts/why.mdx", "diataxis: explanation");
  page("lexicons/aws/docs/pages/nested-stacks.mdx", "diataxis: how-to", promptFor("lexicons/aws/nested-stacks", "Split the template and open a pull request."));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lint-prompts (chant #3996)", () => {
  test("a repository whose task pages all carry good prompts passes", () => {
    const r = run();
    expect(r.out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  });

  test("a how-to page with no prompt fails, core and lexicon", () => {
    page("docs/src/content/docs/guide/linting.mdx", "diataxis: how-to");
    page("lexicons/aws/docs/pages/examples.mdx", "diataxis: tutorial");
    const r = run();
    expect(r.out).toContain("guide/linting.mdx: a how-to page with no `prompt:`");
    expect(r.out).toContain("lexicons/aws/docs/pages/examples.mdx: a tutorial page with no `prompt:`");
    expect(r.status).toBe(1);
  });

  test("reference and explanation pages need no prompt", () => {
    page("docs/src/content/docs/reference/cli.mdx", "diataxis: reference");
    expect(run().status).toBe(0);
  });

  test("a prompt that names another page fails", () => {
    page("docs/src/content/docs/guide/ops.mdx", "diataxis: how-to", promptFor("guide/linting", "Open a pull request."));
    const r = run();
    expect(r.out).toContain(`the prompt does not name its page, ${SITE}/guide/ops/`);
    expect(r.status).toBe(1);
  });

  test("a prompt without the never-line fails and names what it misses", () => {
    page("docs/src/content/docs/guide/ops.mdx", "diataxis: how-to", `Read ${SITE}/guide/ops/.\nOpen a pull request.\nNever merge.`);
    const r = run();
    expect(r.out).toContain("misses");
    expect(r.out).toContain("chant/lifecycle");
    expect(r.status).toBe(1);
  });

  test("prompt: setup stands for the setup prompt on any page", () => {
    page("docs/src/content/docs/getting-started/installation.mdx", "diataxis: how-to", "setup");
    expect(run().status).toBe(0);
  });

  test("the agents page must carry prompt: setup", () => {
    page("docs/src/content/docs/agents.mdx", "diataxis: how-to", promptFor("agents", "Set it up."));
    expect(run().out).toContain("agents.mdx: carry the setup prompt with `prompt: setup`");
  });

  test("a README whose setup prompt drifted fails", () => {
    write("README.md", "```text\nSet up chant.\n```\n");
    expect(run().out).toContain("README.md: the setup prompt is not the one in docs/src/prompts.mjs");
  });

  test("a home page that does not end with the setup card fails", () => {
    write("docs/src/content/docs/index.mdx", '---\ntitle: chant\n---\n\n<Landing part="agent" />\n\n## More\n');
    expect(run().out).toContain('end the home page with <Landing part="agent" />');
  });
});

describe("checkPrompt", () => {
  const url = `${SITE}/guide/ops/`;

  test("a sentence that lets the agent near the signers file fails", () => {
    const p = promptFor("guide/ops", "Add the approver to `.chant/allowed_signers` and open a pull request.");
    expect(checkPrompt(p, url, "x").join("\n")).toContain("only people touch those");
  });

  test("a recorded chant run fails, a no-record one passes", () => {
    expect(checkPrompt(promptFor("guide/ops", "Run `npx chant run deploy --env local`."), url, "x").join("\n")).toContain("pass --no-record");
    expect(checkPrompt(promptFor("guide/ops", "Run `npx chant run deploy --env local --no-record`."), url, "x")).toEqual([]);
    expect(checkPrompt(promptFor("guide/ops", "Run `npx chant run status deploy`."), url, "x")).toEqual([]);
  });

  test("the never-line forbids the release, the ci tags and the flag values (chant #4038)", () => {
    expect(neverLine).toContain("`chant release cut --yes`");
    expect(neverLine).toContain("`chant release publish`");
    expect(neverLine).toContain("`ci/*` tag");
    expect(neverLine).toContain("change the value of an existing flag");
    const old = neverLine.replace(/ never cut or publish a release .*?existing flag;/, "");
    const problems = checkPrompt([`Read ${url}.`, "Open a pull request.", old].join("\n"), url, "x").join("\n");
    expect(problems).toContain("misses the release, the ci/* tags, the flag values");
  });

  test("a sentence that cuts, publishes, pushes a ci tag or flips a flag fails (chant #4038)", () => {
    const fails = (line: string) => checkPrompt(promptFor("guide/ops", line), url, "x").join("\n");
    expect(fails("Run `npx chant release cut v1.4.0 --yes`.")).toContain("cuts a release");
    expect(fails("Then run `npx chant release publish v1.4.0`.")).toContain("publishes a release");
    expect(fails("Run `npx chant ci tick` to tag the commit.")).toContain("pushes ci/* tags");
    expect(fails("Tag it with `git push origin ci/green/abc123`.")).toContain("ci/* tag");
    expect(fails("Delete the ci/revoked tag for the commit.")).toContain("ci/* tag");
    expect(fails("Prune with `npx chant lifecycle gc --yes --push`.")).toContain("prunes chant/lifecycle");
    expect(fails("Turn the new-checkout flag on in prod.")).toContain("change a flag's value");
    expect(fails("Change the flag's prod value to true.")).toContain("change a flag's value");
  });

  test("a dry run, a read of the tags and a new flag record pass (chant #4038)", () => {
    const ok = (line: string) => checkPrompt(promptFor("guide/ops", line), url, "x");
    expect(ok("Run `npx chant release cut v1.4.0` without its confirming flag and show me what it prints.")).toEqual([]);
    expect(ok("Run `npx chant ci tick --dry-run` and `npx chant ci list`.")).toEqual([]);
    expect(ok("Fetch the tags with `git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'`.")).toEqual([]);
    expect(ok("Run `npx chant lifecycle gc` and show me what it would prune.")).toEqual([]);
    expect(ok("Add a flag record with the value off in every environment.")).toEqual([]);
    expect(ok("Do not run `chant release publish` yourself.")).toEqual([]);
  });

  test("frontPrompt reads one-line, block and setup forms", () => {
    expect(frontPrompt("---\ntitle: T\nprompt: setup\n---\n")).toBe(setupPrompt);
    expect(frontPrompt("---\ntitle: T\nprompt: |\n  a\n  b\ndiataxis: how-to\n---\n")).toBe("a\nb");
    expect(frontPrompt("---\ntitle: T\n---\n")).toBeUndefined();
  });
});
