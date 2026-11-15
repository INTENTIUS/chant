/**
 * `comment_allow` on GitHub and Forgejo (INTENTIUS/terragucci#1461): who may
 * run `plan`, `apply`, `lock`, `unlock` and `agent` beyond write access.
 *
 * Every comment command already needs write access. A product that wants a
 * narrower rule gives the pipeline a map of command to logins and teams
 * (`commentAllow` in `productPipelineJobs`), and `default` for every one of
 * the five it does not name:
 *
 *     { apply: ["team:acme/release", "alice"], default: ["team:acme/engineering"] }
 *
 * An entry is a login, or `team:<org>/<team>`. The generator writes the map
 * into the jobs that answer those commands as {@link COMMENT_ALLOW_ENV}, so
 * it is read from the workflow on the default branch, which an
 * `issue_comment` run uses, and a pull request cannot add its own author.
 * Team membership is read from the forge with {@link COMMENT_ALLOW_TOKEN_ENV}
 * when the pipeline names a secret for it, else the job's own token; when the
 * forge cannot answer (a token that cannot read the team, a team that does
 * not exist) nothing runs and the reply says what to fix.
 *
 * Where it is checked:
 *
 * - the comment job (./ci-comment-commands.ts), after the write-access check,
 *   for every command it answers: apply, lock, unlock, and plan and agent
 *   that other jobs run. It posts the reply, so one job speaks;
 * - the product plan's re-plan decision (`replanDecideJs({ allow })`), which
 *   runs before the checkout with the token alone, in a script of its own
 *   ({@link COMMENT_ALLOW_GATE_JS}) that makes the same requests;
 * - the agent's prepare step (`prepareAgentRun`).
 *
 * The apply before merge of the plain pull request loop and chant's comment
 * lock jobs run without this check, so a list for what they answer is refused
 * when the pipeline is built.
 */

/** The commands a list names, besides `default`. */
export const COMMENT_ALLOW_COMMANDS = ["plan", "apply", "lock", "unlock", "agent"] as const;
export type CommentAllowCommand = (typeof COMMENT_ALLOW_COMMANDS)[number];

/** A list of logins and `team:<org>/<team>` entries per command, and `default` for the commands it does not name. */
export type CommentAllow = Partial<Record<CommentAllowCommand | "default", string[]>>;

/** The variable the jobs read the map from, as JSON ({@link CommentAllow}). */
export const COMMENT_ALLOW_ENV = "CHANT_COMMENT_ALLOW";
/** The variable team membership is read with, when the pipeline names a secret for it. Absent: the job's own token. */
export const COMMENT_ALLOW_TOKEN_ENV = "CHANT_COMMENT_ALLOW_TOKEN";
/** The forge the re-plan's script reads teams from: `github` or `forgejo`. */
export const COMMENT_ALLOW_FORGE_ENV = "CHANT_COMMENT_ALLOW_FORGE";

/** A read that could not answer: the message says what to fix. */
export class TeamReadError extends Error {}

const LOGIN_ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;
const TEAM_ENTRY = /^team:([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})$/;

/** Why an entry is not a login or a team, or undefined when it is one. */
export function commentAllowEntryProblem(entry: unknown): string | undefined {
  if (typeof entry !== "string") return "must be a login or team:<org>/<team>";
  if (entry.startsWith("team:")) return TEAM_ENTRY.test(entry) ? undefined : `${JSON.stringify(entry)} is not a team: write team:<org>/<team>`;
  return LOGIN_ENTRY.test(entry) ? undefined : `${JSON.stringify(entry)} is not a login or a team: write a login, or team:<org>/<team>`;
}

/** The problems with a map, each naming its path under `where`. */
export function commentAllowProblems(v: unknown, where: string): string[] {
  const names = [...COMMENT_ALLOW_COMMANDS, "default"];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [`${where} must be a map of command to a list of logins and teams (commands: ${names.join(", ")})`];
  const out: string[] = [];
  for (const [k, list] of Object.entries(v)) {
    if (!names.includes(k)) {
      out.push(`${where}.${k} is not a command this limit covers (commands: ${names.join(", ")})`);
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) {
      out.push(`${where}.${k} must be a list of logins and teams with at least one entry, since an empty list would let nobody run it`);
      continue;
    }
    list.forEach((e, i) => {
      const p = commentAllowEntryProblem(e);
      if (p) out.push(`${where}.${k}[${i}] ${p}`);
    });
  }
  return out;
}

/** The map from {@link COMMENT_ALLOW_ENV}'s value, checked. Undefined when the variable is empty. Throws on a value that is not a map, so a broken value never turns the limit off. */
export function commentAllowFromEnv(raw: string | undefined): CommentAllow | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${COMMENT_ALLOW_ENV} is JSON: a map of command to a list of logins and teams`);
  }
  const problems = commentAllowProblems(v, COMMENT_ALLOW_ENV);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return v as CommentAllow;
}

/** The list that governs `command`: its own, else `default`. Undefined: every writer may run it. */
export function commentAllowList(allow: CommentAllow | undefined, command: CommentAllowCommand): string[] | undefined {
  const list = allow?.[command] ?? allow?.default;
  return list && list.length > 0 ? list : undefined;
}

/** The commands whose list is not empty: the ones `allow` names, or all five with a `default`. */
export function commentAllowCovers(allow: CommentAllow | undefined): CommentAllowCommand[] {
  return COMMENT_ALLOW_COMMANDS.filter((c) => commentAllowList(allow, c) !== undefined);
}

/** The reads a decision makes: whether a login is in a team. */
export interface CommentAllowReads {
  teamMember?(team: string, login: string): Promise<boolean>;
}

export type CommentAllowDecision = { ok: true } | { ok: false; reason: string; fail?: true };

/**
 * Whether `user`, who already passed the write-access check, may run
 * `command`. No list for it (and no `default`): yes. A listed login needs no
 * read; a team is read one at a time, stopping at the first that holds the
 * user. A team the forge cannot answer for fails closed (`fail`), whatever
 * the other teams say.
 */
export async function decideCommentAllow(allow: CommentAllow | undefined, command: CommentAllowCommand, user: string, reads: CommentAllowReads | undefined): Promise<CommentAllowDecision> {
  const list = commentAllowList(allow, command);
  if (!list) return { ok: true };
  const me = user.toLowerCase();
  if (list.some((e) => !e.startsWith("team:") && e.toLowerCase() === me)) return { ok: true };
  const teams = list.filter((e) => e.startsWith("team:")).map((e) => e.slice(5));
  const refused = (): CommentAllowDecision => ({ ok: false, reason: `${user} may not run \`${command}\` here: it is limited to ${list.map((e) => `\`${e}\``).join(", ")} (the pipeline's comment limits, read from the default branch)` });
  if (teams.length === 0) return refused();
  if (!reads?.teamMember) return { ok: false, fail: true, reason: `could not read team membership for ${user}, so nothing runs: this forge's reads cannot answer for a team` };
  let unreadable: string | undefined;
  for (const team of teams) {
    try {
      if (await reads.teamMember(team, user)) return { ok: true };
    } catch (err) {
      if (!(err instanceof TeamReadError)) throw err;
      unreadable ??= err.message;
    }
  }
  if (unreadable) return { ok: false, fail: true, reason: `could not read team membership for ${user}, so nothing runs (${unreadable}). ${COMMENT_ALLOW_TOKEN_ENV}, or the job's token, must be able to read the team's members` };
  return refused();
}

/**
 * The script the re-plan's decision runs (`node -e`, before the checkout):
 * `commentAllowRefusal(who, command)` answers undefined when `who` may run
 * `command` and the refusal's text otherwise, and throws when a team cannot
 * be read. It makes the requests {@link decideCommentAllow}'s reads make, from
 * the same variables, with `fetch`.
 */
export const COMMENT_ALLOW_GATE_JS = [
  "const commentAllowRefusal=async(who,command)=>{",
  `let allow;try{allow=JSON.parse(process.env.${COMMENT_ALLOW_ENV}||"null")}catch{throw new Error("${COMMENT_ALLOW_ENV} is not JSON, so nothing runs")}`,
  "const list=allow&&(allow[command]||allow.default);",
  "if(!Array.isArray(list)||list.length===0)return undefined;",
  "const me=String(who).toLowerCase();",
  'if(list.some((e)=>!e.startsWith("team:")&&e.toLowerCase()===me))return undefined;',
  'const teams=list.filter((e)=>e.startsWith("team:")).map((e)=>e.slice(5));',
  'const refused=who+" may not run `"+command+"` here: it is limited to "+list.map((e)=>"`"+e+"`").join(", ")+" (the pipeline\\u0027s comment limits, read from the default branch)";',
  "if(teams.length===0)return refused;",
  `const api=String(process.env.GITHUB_API_URL||"").replace(/\\/+$/,""),tok=process.env.${COMMENT_ALLOW_TOKEN_ENV}||process.env.CHANT_REPLAN_TOKEN,forgejo=process.env.${COMMENT_ALLOW_FORGE_ENV}==="forgejo";`,
  'const hit=async(p)=>fetch(api+p,{headers:{authorization:(forgejo?"token ":"Bearer ")+tok,accept:forgejo?"application/json":"application/vnd.github+json"}});',
  "const bad=(what,r)=>new Error(what+\" answered \"+r.status+(r.status===404?\": the team does not exist, or the token cannot see it\":\"\"));",
  "let unreadable;",
  "for(const team of teams){try{",
  'const cut=team.lastIndexOf("/"),org=encodeURIComponent(team.slice(0,cut)),slug=team.slice(cut+1);',
  "if(forgejo){",
  'const s=await hit("/orgs/"+org+"/teams/search?q="+encodeURIComponent(slug)+"&limit=50");if(!s.ok)throw bad("searching "+team.slice(0,cut)+\"\\u0027s teams\",s);',
  "const b=await s.json();const t=(Array.isArray(b&&b.data)?b.data:[]).find((x)=>x&&String(x.name).toLowerCase()===slug.toLowerCase());",
  'if(!t||typeof t.id!=="number")throw new Error(team.slice(0,cut)+" has no team named "+slug+", or the token cannot see it");',
  'const m=await hit("/teams/"+t.id+"/members/"+encodeURIComponent(who));if(m.status===404)continue;if(!m.ok)throw bad("team "+team+"\\u0027s member list",m);return undefined;',
  "}",
  'const f=await hit("/orgs/"+org+"/teams/"+encodeURIComponent(slug));if(!f.ok)throw bad("GitHub team "+team,f);',
  'const m=await hit("/orgs/"+org+"/teams/"+encodeURIComponent(slug)+"/memberships/"+encodeURIComponent(who));if(m.status===404)continue;if(!m.ok)throw bad("team "+team+"\\u0027s membership of "+who,m);',
  'const b=await m.json();if(b&&b.state==="active")return undefined;',
  "}catch(err){unreadable=unreadable||(err&&err.message?err.message:String(err))}}",
  `if(unreadable)throw new Error("could not read team membership for "+who+", so nothing runs ("+unreadable+"). ${COMMENT_ALLOW_TOKEN_ENV}, or the job\\u0027s token, must be able to read the team\\u0027s members");`,
  "return refused;",
  "};",
].join("");
