/**
 * The forge token handover (#4295): no step that runs a pull request's code
 * holds a forge token.
 *
 * A pull request's plan runs its code: the synth of its components, the
 * plans their capabilities run, its build and lint, and its hooks. A token
 * that can post a note or set a status can also push, so the generated plan
 * job uses the job's token for the checkout's fetches alone and drops it
 * before anything else runs. The ordering is terragucci's `handover.ts`
 * (INTENTIUS/terragucci e6cb431, packages/terragucci/src/handover.ts):
 *
 * 1. The checkout is a script ({@link checkoutScript}), not actions/checkout,
 *    whose post step runs at the job's end with the token as its input. The
 *    token reaches its fetches through the environment, never the git config.
 * 2. Every later step starts again without the token variables
 *    ({@link dropForgeTokens}).
 * 3. The plan step is the job's last. A step after it would start beside
 *    whatever the change's code left running, with what it wrote to
 *    GITHUB_ENV and GITHUB_PATH. So the plan step hands its report directory
 *    on as the job's outputs ({@link handoverTrap}) in place of an artifact
 *    upload.
 * 4. A fresh job, `plan-note`, checks out the target branch's commit, takes
 *    the report back ({@link takeOverScript}), keeps it as the artifact, and
 *    posts the note and the status with the token (`chant components
 *    pr-post`, ./pr-post.ts). It reads the report as data.
 *
 * `chant ci run plan` keeps the same rule: no step of the plan job gets a
 * forge token, and the runner posts from the report once the steps settle
 * (../workspace/ci-run.ts).
 */

import type { ForgeKind } from "./pr-forge";

/**
 * The variables a runner, a job or a secret may hold a forge token in.
 * A step that runs the change's code starts without them. The list is
 * terragucci's `STEP_TOKEN_VARS` (render.ts:1787) with chant's own names
 * (`FORGE_TOKEN_ENV` in ./pr-forge.ts) and GitLab's added.
 */
export const FORGE_TOKEN_VARS = [
  "CHANT_FORGE_TOKEN",
  "CHANT_GITHUB_TOKEN",
  "CHANT_FORGEJO_TOKEN",
  "CHANT_GITLAB_TOKEN",
  "CHANT_CHECKOUT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "FORGEJO_TOKEN",
  "GITEA_TOKEN",
  "GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
] as const;

/** `env` without {@link FORGE_TOKEN_VARS}. */
export function withoutForgeTokens<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const name of FORGE_TOKEN_VARS) delete out[name];
  return out;
}

/** Whether `env` holds a forge token under one of {@link FORGE_TOKEN_VARS}. */
export function holdsForgeToken(env: Record<string, string | undefined>): boolean {
  return FORGE_TOKEN_VARS.some((name) => (env[name] ?? "") !== "");
}

/** The marker a step {@link dropForgeTokens} restarted carries. */
export const NO_FORGE_TOKEN_MARKER = "CHANT_NO_FORGE_TOKEN";

/**
 * The first line of a step that runs the change's code: restart the step's
 * shell once without the token variables in its process environment, or,
 * when it cannot restart, unset them. Unsetting alone leaves the values in
 * the shell's own initial environment, which a child reads on Linux from
 * `/proc/<pid>/environ`; the restart replaces it. A forge runs a step's
 * script as a file (`sh -e {0}` in a GitHub or Forgejo container job), so
 * `$0` is that file. terragucci's `restartWithout` (render.ts:1826).
 */
export function dropForgeTokens(shell: "sh" | "bash" = "sh", extra: readonly string[] = []): string {
  const again = shell === "bash" ? 'bash --noprofile --norc -e -o pipefail "$0"' : 'sh -e "$0"';
  const marker = NO_FORGE_TOKEN_MARKER;
  // #4296: a plan job that traded its OIDC token drops the variables a token is requested with too.
  const vars = [...FORGE_TOKEN_VARS, ...extra];
  const can = `[ -z "\${${marker}:-}" ] && [ "\${0#*/}" != "$0" ] && [ -f "$0" ] && ! { [ "\${0##*/}" = sh ] || [ "\${0##*/}" = bash ] || [ "\${0##*/}" = dash ]; } && command -v env >/dev/null 2>&1 && command -v ${shell} >/dev/null 2>&1`;
  return `if ${can}; then exec env ${vars.map((v) => `-u ${v}`).join(" ")} ${marker}=1 ${again}; fi; unset ${vars.join(" ")}`;
}

/** The line a GitLab plan job starts its script with: GitLab runs the script in one shell, so the unset holds for every line after it. */
export const GITLAB_DROP_FORGE_TOKENS = `unset ${FORGE_TOKEN_VARS.join(" ")}`;

/** The forges whose plan job hands its report on through job outputs. GitLab passes the artifact to the next job itself. */
export type HandoverForge = Exclude<ForgeKind, "gitlab">;

/**
 * How many outputs the plan job hands its report on in, and the most
 * characters each holds. Forgejo keeps each output's value to 1 MiB. GitHub
 * keeps a job's outputs to 1 MB together, sized as UTF-16. terragucci's
 * `HANDOVER_LIMITS` (handover.ts).
 */
export const HANDOVER_LIMITS: Record<HandoverForge, { chunk: number; parts: number }> = {
  forgejo: { chunk: 1_000_000, parts: 4 },
  github: { chunk: 450_000, parts: 1 },
};

/** The outputs' names on a forge: report_0, report_1, ... */
export function handoverKeys(forge: HandoverForge): string[] {
  return Array.from({ length: HANDOVER_LIMITS[forge].parts }, (_, i) => `report_${i}`);
}

/** The files the note job reads, which a report too large to hand on whole is cut to. */
export const HANDOVER_NOTE_FILES = ["pr-plan.json", "pr-note.md"] as const;

/**
 * Packs the report directory (argv 1) into the step's output file (argv 2):
 * every regular file, found without following a link, as gzipped JSON in
 * base64, cut into the forge's chunks. A report too large is cut to
 * {@link HANDOVER_NOTE_FILES}, and to none when even those are too large.
 */
export function packJs(forge: HandoverForge): string {
  const { chunk, parts } = HANDOVER_LIMITS[forge];
  return [
    'const fs=require("fs"),p=require("path"),z=require("zlib");',
    "const [dir,out]=process.argv.slice(1);",
    `const CHUNK=${chunk},PARTS=${parts},NOTE=${JSON.stringify(HANDOVER_NOTE_FILES)};`,
    "const all={};",
    'const walk=(d,r)=>{let n=[];try{n=fs.readdirSync(d).sort()}catch{return}for(const x of n){const f=p.join(d,x),k=r?r+"/"+x:x;let s;try{s=fs.lstatSync(f)}catch{continue}if(s.isDirectory())walk(f,k);else if(s.isFile())all[k]=fs.readFileSync(f).toString("base64")}};',
    'walk(dir,"");',
    'const pack=(o)=>z.gzipSync(JSON.stringify(o)).toString("base64");',
    "let b=pack(all);",
    "if(b.length>CHUNK*PARTS){b=pack(Object.fromEntries(Object.entries(all).filter(([k])=>NOTE.includes(k))));",
    'if(b.length>CHUNK*PARTS){b=pack({});console.error("chant: the plan report is too large to hand to the note job, even cut to the report and the note; it hands on none of it")}',
    'else console.error("chant: the plan report is too large to hand to the note job whole; it hands on pr-plan.json and pr-note.md")}',
    'let o="";for(let i=0;i*CHUNK<b.length;i++)o+="report_"+i+"="+b.slice(i*CHUNK,(i+1)*CHUNK)+"\\n";',
    "fs.appendFileSync(out,o);",
  ].join("");
}

/**
 * Writes back, under the directory argv 1 names, the files the plan job
 * handed on: stdin holds its outputs, one JSON string a line. A path is kept
 * only when it is plain segments (no empty one, no `.` or `..`, no backslash
 * or control character), so nothing lands outside the directory.
 */
export const UNPACK_JS = [
  'const fs=require("fs"),p=require("path"),z=require("zlib");',
  "const dir=process.argv[1];",
  'let b="";',
  'for(const l of fs.readFileSync(0,"utf8").split("\\n")){if(!l.trim())continue;let s="";try{s=JSON.parse(l)}catch{}if(typeof s==="string")b+=s}',
  'if(!b){console.log("chant: the plan job handed on no report");process.exit(0)}',
  'let files;try{files=JSON.parse(z.gunzipSync(Buffer.from(b,"base64"),{maxOutputLength:268435456}).toString("utf8"))}catch(e){console.log("chant: the report the plan job handed on does not read: "+e.message);process.exit(0)}',
  'if(!files||typeof files!=="object"||Array.isArray(files)){console.log("chant: the report the plan job handed on is not a set of files");process.exit(0)}',
  "let n=0;",
  'for(const [k,v] of Object.entries(files)){const parts=k.split("/");',
  'if(typeof v!=="string"||k.length>1024||parts.some((x)=>!x||x==="."||x===".."||/[\\\\\\x00-\\x1f]/.test(x))){console.log("chant: left out "+JSON.stringify(k));continue}',
  'try{const f=p.join(dir,...parts);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(v,"base64"));n++}catch(e){console.log("chant: could not write "+JSON.stringify(k)+": "+e.message)}}',
  'console.log("chant: took "+n+" report files from the plan job")',
].join("");

/**
 * The lines of the plan step, after {@link dropForgeTokens}: when the step
 * ends, however it ends, its report directory (`dir`, from the directory the
 * step starts in) goes into the step's outputs.
 */
export function handoverTrap(dir: string, forge: HandoverForge): string[] {
  return [
    `chant_report="$PWD/${dir}"`,
    `chant_handover() { node -e '${packJs(forge)}' "$chant_report" "\${GITHUB_OUTPUT:-/dev/null}" || echo "chant: the plan report could not be handed to the note job" >&2; }`,
    "trap chant_handover EXIT",
  ];
}

/** A job's outputs that carry the report its step `step` handed on. */
export function handoverOutputs(step: string, forge: HandoverForge): Record<string, string> {
  return Object.fromEntries(handoverKeys(forge).map((k) => [k, `\${{ steps.${step}.outputs.${k} }}`]));
}

/**
 * The script of the step that takes the report job `job` handed on into
 * `dir`. Each output comes in as toJSON's string, one line of a quoted
 * heredoc whose end no JSON string can be, so the change's outputs stay data.
 */
export function takeOverScript(job: string, dir: string, forge: HandoverForge): string {
  return [
    "set -u",
    `node -e '${UNPACK_JS}' ${dir} <<'END_OF_REPORT'`,
    ...handoverKeys(forge).map((k) => `\${{ toJSON(needs.${job}.outputs.${k}) }}`),
    "END_OF_REPORT",
  ].join("\n");
}

/** The variable the checkout script reads the job's token from. */
export const CHECKOUT_TOKEN_ENV = "CHANT_CHECKOUT_TOKEN";

/**
 * Checks the run's commit out with git, as actions/checkout does without
 * credentials kept: `GITHUB_SHA` under `GITHUB_REF`. With `history`, every
 * branch and tag too, since the plan measures the change with git. The job's
 * token ({@link CHECKOUT_TOKEN_ENV}) reaches the fetches alone, through the
 * environment, never the git config. A workspace already checked out is
 * cleaned first, as actions/checkout does. terragucci's `checkoutScript`
 * (handover.ts). With `ledger`, the `chant/lifecycle` branch is fetched
 * into a local branch too, while the token is there: the plan reads the
 * gate ledger from it, and a later fetch without the token cannot reach a
 * private repository (`requireLifecycleLedger` in ./lifecycle/git.ts reads
 * the local branch when the fetch fails).
 */
export function checkoutScript(history: boolean, ledger = false): string {
  const fetch = history
    ? `git -c protocol.version=2 fetch -q --prune --no-recurse-submodules origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' "+$want:$target"`
    : 'git -c protocol.version=2 fetch -q --no-tags --prune --no-recurse-submodules --depth=1 origin "+$want:$target"';
  return [
    "set -eu",
    'git config --global --add safe.directory "$PWD" 2>/dev/null || true',
    "[ -d .git ] || git init -q .",
    'git remote get-url origin >/dev/null 2>&1 || git remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"',
    `if [ -n "\${${CHECKOUT_TOKEN_ENV}:-}" ]; then`,
    `  chant_auth="$(printf 'x-access-token:%s' "$${CHECKOUT_TOKEN_ENV}" | base64 | tr -d '\\n')"`,
    '  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $chant_auth"',
    "  unset chant_auth",
    "fi",
    'ref="$GITHUB_REF"',
    'want="$GITHUB_SHA"',
    'case "$ref" in',
    '  refs/heads/*) target="refs/remotes/origin/${ref#refs/heads/}" ;;',
    '  refs/tags/*) target="$ref" ;;',
    '  refs/*) target="refs/remotes/${ref#refs/}" ;;',
    '  *) target="refs/remotes/origin/chant-head" ;;',
    "esac",
    "if git rev-parse -q --verify HEAD >/dev/null; then git clean -ffdxq; fi",
    fetch,
    ...(ledger ? ["git -c protocol.version=2 fetch -q --no-tags origin '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle' 2>/dev/null || true"] : []),
    'case "$ref" in',
    '  refs/heads/*) git checkout -q --force -B "${ref#refs/heads/}" "$target" ;;',
    '  *) git checkout -q --force --detach "$target" ;;',
    "esac",
  ].join("\n");
}
