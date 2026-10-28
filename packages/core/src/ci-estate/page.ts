/**
 * The estate page (#4612): one self-contained `estate.html` and its
 * `estate.json`, from the ledger rows (./rows.ts) and nothing else, with a
 * section per member. Lifted from terragucci's report/estate.ts, whose
 * page is built from its reports bucket. The fields keep that file's names
 * (`projects`, `totals`, `waiting`, `drifted`, `failed`, `recent`) and its
 * schema name under the product's words (`terragucci.estate/v1`), so a
 * product that adds its own sections (terragucci's inventory, versions,
 * states and graph) adds them to the same objects.
 *
 * Per member it shows the waves of the newest commit an op wave applied,
 * each wave's jobs and gate, how long a waiting wave has waited, the newest
 * drift check and whether its schedule is overdue, and the live pull
 * request environments. Below that the newest runs across the estate, and
 * the delivery metrics (./delivery.ts).
 */
import { samePlanDigest } from "../lifecycle/plan-digest";
import { CHANT_WORDS, type CiProductWords } from "../ci-product-words";
import { duration, spanLabel, DORA_FILE, type Dora, type DoraMetrics } from "./delivery";
import type { LedgerOverdue } from "./overdue";
import type { DriftRun, EstateRows, PrEnvLine, WaveJob } from "./rows";

/** `<product>.estate/v1`. */
export const estateSchema = (words: Pick<CiProductWords, "product"> = CHANT_WORDS): string => `${words.product}.estate/v1`;

/** How many of the newest runs the page lists. */
export const RECENT_RUNS = 20;

/** The files the page writes. */
export const ESTATE_FILES = { page: "estate.html", json: "estate.json", dora: DORA_FILE } as const;

/** A run as the page shows it: terragucci's EstateRun, with the fields the ledger holds. */
export interface EstateRun {
  project: string;
  commit: string;
  /** The Op or spec that ran. */
  stage: string;
  wave?: number;
  share?: number;
  finished: string;
  /** The targets it applied, failed, moved or left blocked. For a drift check, the targets it named. */
  roots: number;
  /** Targets applied, or for a drift check the targets that drifted (1 when it names none). */
  changed?: number;
  failed?: number;
  /** Targets whose plan moved since the decision. */
  refused: number;
  approval?: "waiting" | "approved";
  waiting_since?: string;
  applied?: string;
  job_url?: string;
  /** The run record's status. */
  status: string;
  /** The run record's id. */
  run: string;
}

export interface EstateWaiting {
  project: string;
  wave: number;
  commit: string;
  since: string;
  age_seconds: number;
  /** The gate it waits at. */
  gate?: string;
}

/** A live pull request environment. */
export interface EstatePrEnv {
  pr: number;
  env: string;
  commit?: string;
  applied: string;
  expires?: string;
  run_url?: string;
}

export interface EstateProject {
  /** The member. */
  project: string;
  /** `no-index` when the ledger holds nothing for it. */
  status: "ok" | "no-index";
  drift?: EstateRun;
  /** The waves of the newest commit an op wave applied, by wave number. */
  apply?: { commit: string; waves: EstateRun[] };
  waiting: EstateWaiting[];
  /** Targets the newest drift check found drifted. */
  drifted: number;
  /** Targets that failed in the newest commit's waves. */
  failed: number;
  /** Its drift checks whose schedule is overdue. */
  overdue?: LedgerOverdue[];
  /** Its live pull request environments. */
  ephemeral?: EstatePrEnv[];
}

export interface Estate {
  /** {@link estateSchema}. */
  schema: string;
  generated: string;
  source: "ledger";
  totals: { projects: number; waiting: number; drifted_projects: number; drifted_roots: number; failed_roots: number; unreadable: number; overdue: number; ephemeral?: number };
  projects: EstateProject[];
  /** The newest runs across every member, newest first. */
  recent: EstateRun[];
  /** The delivery metrics beside the page. */
  dora?: { file: string; generated: string; deployments: number };
}

export interface EstateOptions {
  words?: Pick<CiProductWords, "product">;
  now?: Date;
  /** The members, in order. Default every member the rows name. */
  members?: readonly string[];
  /** Overdue verdicts from {@link ledgerOverdue}, placed on their members. */
  overdue?: readonly LedgerOverdue[];
  /** Ledger lines that could not be read, from `loadQueryData`'s `malformed`; summed into `totals.unreadable`. */
  malformed?: Record<string, number>;
}

const at = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0);
const secondsSince = (iso: string, now: Date): number => Math.max(0, Math.round((now.getTime() - at(iso)) / 1000));

function waveRun(w: WaveJob, rows: EstateRows): EstateRun {
  const gated = w.status === "gated" || w.status === "waiting";
  const spent = !gated && rows.approved.some((a) => a.member === w.member && a.op === w.spec && w.digest !== undefined && samePlanDigest(a.planDigest, w.digest));
  const since = gated ? pendingSince(w, rows) ?? w.ended : undefined;
  return {
    project: w.member,
    commit: w.commit ?? "",
    stage: w.spec,
    wave: w.wave,
    ...(w.share !== undefined ? { share: w.share } : {}),
    finished: w.ended,
    roots: new Set([...w.applied, ...w.failed, ...w.moved, ...w.blocked]).size,
    changed: w.applied.length,
    failed: w.failed.length,
    refused: w.moved.length,
    ...(gated ? { approval: "waiting" as const, waiting_since: since! } : spent ? { approval: "approved" as const } : {}),
    ...(w.applied.length > 0 && w.failed.length === 0 ? { applied: w.ended } : {}),
    ...(w.runUrl ? { job_url: w.runUrl } : {}),
    status: w.status,
    run: w.id,
  };
}

/** When the gate a waiting job stopped at first asked for this digest. */
function pendingSince(w: WaveJob, rows: EstateRows): string | undefined {
  const asked = rows.gates
    .filter((g) => g.kind === "pending" && g.member === w.member && g.op === w.spec && w.digest !== undefined && g.planDigest !== undefined && samePlanDigest(g.planDigest, w.digest))
    .sort((a, b) => at(a.timestamp) - at(b.timestamp))[0];
  return asked?.timestamp;
}

function driftRun(d: DriftRun): EstateRun {
  const changed = d.drifted ? d.roots.length || 1 : 0;
  return { project: d.member, commit: d.commit ?? "", stage: d.op, finished: d.ended, roots: d.roots.length, changed, refused: 0, ...(d.runUrl ? { job_url: d.runUrl } : {}), status: d.status, run: d.id };
}

const newest = <T extends { ended: string }>(xs: readonly T[]): T | undefined => xs.reduce<T | undefined>((a, x) => (!a || at(x.ended) > at(a.ended) ? x : a), undefined);

/** The pull request environments still live: an `up` that applied with no later `down` that destroyed it. */
function livePrEnvs(lines: readonly PrEnvLine[]): EstatePrEnv[] {
  const by = new Map<string, PrEnvLine>();
  for (const l of [...lines].sort((a, b) => at(a.timestamp) - at(b.timestamp))) {
    if (l.kind === "up" && l.result === "applied") by.set(l.env, l);
    else if (l.kind === "down" && l.result !== "incomplete") by.delete(l.env);
  }
  return [...by.values()].sort((a, b) => a.pr - b.pr).map((l) => ({ pr: l.pr, env: l.env, ...(l.commit ? { commit: l.commit } : {}), applied: l.timestamp, ...(l.expiresAt ? { expires: l.expiresAt } : {}), ...(l.runUrl ? { run_url: l.runUrl } : {}) }));
}

/** One member's section. */
export function memberState(member: string, rows: EstateRows, now: Date, overdue: readonly LedgerOverdue[] = []): EstateProject {
  const waves = rows.waves.filter((w) => w.member === member && w.job !== "decide");
  const checks = rows.drift.filter((d) => d.member === member);
  const envs = livePrEnvs(rows.prEnvs.filter((p) => p.member === member));
  const late = overdue.filter((o) => o.member === member);
  const extra = { ...(late.length ? { overdue: [...late] } : {}), ...(envs.length ? { ephemeral: envs } : {}) };
  if (waves.length === 0 && checks.length === 0) return { project: member, status: rows.members.includes(member) ? "ok" : "no-index", waiting: [], drifted: 0, failed: 0, ...extra };
  // The newest commit that ran a wave holds the member's apply state; an older commit's waiting wave is behind it.
  const last = newest(waves);
  let apply: EstateProject["apply"];
  const waiting: EstateWaiting[] = [];
  if (last) {
    const byJob = new Map<string, WaveJob>();
    for (const w of waves.filter((x) => (x.commit ?? "") === (last.commit ?? ""))) {
      const k = `${w.spec}/${w.wave}/${w.share ?? w.group ?? 0}`;
      const held = byJob.get(k);
      if (!held || at(w.ended) > at(held.ended)) byJob.set(k, w);
    }
    const jobs = [...byJob.values()].sort((a, b) => a.wave - b.wave || (a.share ?? 0) - (b.share ?? 0));
    const runs = jobs.map((w) => waveRun(w, rows));
    apply = { commit: last.commit ?? "", waves: runs };
    for (const [i, r] of runs.entries()) {
      if (r.approval !== "waiting") continue;
      const since = r.waiting_since ?? r.finished;
      waiting.push({ project: member, wave: r.wave ?? 0, commit: r.commit, since, age_seconds: secondsSince(since, now), ...(jobs[i]!.gate ? { gate: jobs[i]!.gate } : {}) });
    }
  }
  const check = newest(checks);
  const drift = check ? driftRun(check) : undefined;
  return {
    project: member,
    status: "ok",
    ...(drift ? { drift } : {}),
    ...(apply ? { apply } : {}),
    waiting,
    drifted: drift?.changed ?? 0,
    failed: apply ? apply.waves.reduce((n, w) => n + (w.failed ?? 0), 0) : 0,
    ...extra,
  };
}

/** The estate page's data from the ledger rows. */
export function buildEstate(rows: EstateRows, dora: Dora | undefined, options: EstateOptions = {}): Estate {
  const now = options.now ?? new Date();
  const members = options.members ?? rows.members;
  const projects = members.map((m) => memberState(m, rows, now, options.overdue));
  const recent = [
    ...rows.waves.filter((w) => w.job !== "decide").map((w) => waveRun(w, rows)),
    ...rows.drift.map(driftRun),
  ]
    .filter((r) => members.includes(r.project))
    .sort((a, b) => at(b.finished) - at(a.finished))
    .slice(0, RECENT_RUNS);
  const ephemeral = projects.reduce((n, p) => n + (p.ephemeral?.length ?? 0), 0);
  return {
    schema: estateSchema(options.words),
    generated: now.toISOString(),
    source: "ledger",
    totals: {
      projects: projects.length,
      waiting: projects.reduce((n, p) => n + p.waiting.length, 0),
      drifted_projects: projects.filter((p) => p.drifted > 0).length,
      drifted_roots: projects.reduce((n, p) => n + p.drifted, 0),
      failed_roots: projects.reduce((n, p) => n + p.failed, 0),
      unreadable: Object.values(options.malformed ?? {}).reduce((n, x) => n + x, 0),
      overdue: projects.reduce((n, p) => n + (p.overdue?.length ?? 0), 0),
      ...(ephemeral ? { ephemeral } : {}),
    },
    projects,
    recent,
    ...(dora ? { dora: { file: DORA_FILE, generated: dora.generated, deployments: dora.estate.deployments } } : {}),
  };
}

// ── the page ────────────────────────────────────────────────────────────────

/** HTML text escaped. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const rate = (r: number | null): string => (r === null ? "none" : `${Math.round(r * 1000) / 10}%`);

function doraRow(name: string, m: DoraMetrics): string {
  const l = m.lead_time;
  const split = l.changes ? `<br><small>before the gate ${duration(l.before_gate_seconds)}, at the gate ${duration(l.at_gate_seconds)}, after it ${duration(l.after_gate_seconds)}</small>` : "";
  const c = m.change_failure;
  const r = m.restore;
  return `<tr><td>${name}</td><td>${m.per_week} <small>(${m.deployments} in ${spanLabel(m.span_seconds)})</small></td><td>${duration(l.median_seconds)}${split}</td><td>${rate(c.rate)} <small>(${c.failed} failed, ${c.drifted} drifted, of ${c.applies})</small></td><td>${duration(r.median_seconds)} <small>(${r.restored} restored${r.open ? `, <span class="warn">${r.open} open</span>` : ""})</small></td></tr>`;
}

/** The delivery section: the definitions, each member's numbers and the estate's, and a row per week. terragucci's renderDoraSection. */
export function renderDeliverySection(dora: Dora, link: (project: string) => string = esc): string {
  const weeks = dora.estate.trend.map(
    (w) => `<tr><td>${esc(w.week)}</td><td>${w.deployments}</td><td>${w.applies}</td><td>${w.failures}</td><td>${duration(w.lead_time_seconds)}</td><td>${duration(w.restore_seconds)}</td></tr>`,
  );
  return `<p>The newest ${dora.weeks} weeks, from the workspace ledger${dora.audit ? "" : `. <span class="warn">The ledger holds no apply record yet, so only drift counts.</span>`}</p>
<dl class="defs">
<dt>Deployment frequency</dt><dd>Applied waves per week, over the span the history covers: from now back to the oldest apply, or to the window's start when the history is older, and at least a day. Beside each rate is the span it divides by. Infrastructure ships less often than an application, so read it as a trend rather than against a tier.</dd>
<dt>Lead time</dt><dd>The median time from a change's first plan to its wave applied: before the gate (the plan to the wave reaching its gate, or to the apply when no gate held it), at the gate (until the approval), and after it (until applied).</dd>
<dt>Change failure rate</dt><dd>Failed applies, plus applied waves whose targets drifted within ${duration(dora.drift_window_seconds)}, over all applies. A refused wave is the gate working and does not count.</dd>
<dt>Time to restore</dt><dd>The median time from a failed apply to the next apply of those targets, and from drift found to the next drift check that found none.</dd>
</dl>
<div class="scroll"><table id="dora"><tr><th>Member</th><th>Deployments per week</th><th>Lead time</th><th>Change failure rate</th><th>Time to restore</th></tr>
${[doraRow("<b>Estate</b>", dora.estate), ...dora.projects.map((p) => doraRow(link(p.project), p))].join("\n")}
</table></div>
<h3>By week</h3>
<div class="scroll"><table id="dora-weeks"><tr><th>Week of</th><th>Deployments</th><th>Applies</th><th>Failed changes</th><th>Lead time</th><th>Time to restore</th></tr>
${weeks.join("\n")}
</table></div>`;
}

const CSS = `body{font:14px/1.45 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1100px;color:#1d1d1f;background:#fff}
h1{font-size:22px}h2{font-size:18px;margin-top:28px}h3{font-size:15px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
.scroll{overflow-x:auto}.warn{color:#b42318}.ok{color:#067647}small{color:#555}
dl.defs dt{font-weight:600;margin-top:6px}dl.defs dd{margin-left:16px}
section.member{border-top:2px solid #eee;margin-top:20px}
@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}td,th{border-color:#333}small{color:#aaa}section.member{border-color:#333}.warn{color:#f97066}.ok{color:#47cd89}}`;

/** A section a product adds: under each member, or at the end of the page. */
export interface EstateSections {
  /** HTML under a member's section, such as terragucci's inventory of a root. */
  member?: (project: EstateProject) => string;
  /** Sections at the end of the page. */
  sections?: { title: string; html: string }[];
}

const shortSha = (s: string): string => esc(s.slice(0, 12));

function runCells(r: EstateRun): string {
  const what = r.wave !== undefined ? `${esc(r.stage)} wave ${r.wave}${r.share !== undefined ? ` share ${r.share}` : ""}` : esc(r.stage);
  const state = r.approval === "waiting" ? `<span class="warn">waiting since ${esc(r.waiting_since ?? r.finished)}</span>` : r.failed ? `<span class="warn">${r.failed} failed</span>` : esc(r.status);
  const job = r.job_url ? ` <a href="${esc(r.job_url)}">job</a>` : "";
  return `<td>${what}</td><td>${shortSha(r.commit)}</td><td>${esc(r.finished)}</td><td>${r.changed ?? 0} of ${r.roots}${r.refused ? `, ${r.refused} moved` : ""}</td><td>${state}${job}</td>`;
}

function memberHtml(p: EstateProject, words: Pick<CiProductWords, "product" | "noun">, extra: EstateSections["member"]): string {
  const parts: string[] = [`<section class="member" id="${esc(`member-${p.project}`)}"><h2>${esc(p.project)}</h2>`];
  if (p.status === "no-index") parts.push(`<p>The ledger holds no run for this ${esc(words.noun[0])} yet.</p>`);
  for (const o of p.overdue ?? []) parts.push(`<p class="warn">${esc(o.message)}</p>`);
  if (p.waiting.length) parts.push(`<ul>${p.waiting.map((w) => `<li class="warn">wave ${w.wave} waits${w.gate ? ` at ${esc(w.gate)}` : ""}, for ${duration(w.age_seconds)}</li>`).join("")}</ul>`);
  if (p.apply) {
    parts.push(`<h3>Waves of ${shortSha(p.apply.commit)}</h3><div class="scroll"><table><tr><th>Wave</th><th>Commit</th><th>Finished</th><th>Applied</th><th>State</th></tr>`);
    for (const w of p.apply.waves) parts.push(`<tr>${runCells(w)}</tr>`);
    parts.push(`</table></div>`);
  }
  if (p.drift) parts.push(`<p>Newest drift check: ${esc(p.drift.stage)} at ${esc(p.drift.finished)}, ${p.drifted ? `<span class="warn">${p.drifted} drifted</span>` : `<span class="ok">no drift</span>`}${p.drift.job_url ? ` <a href="${esc(p.drift.job_url)}">job</a>` : ""}.</p>`);
  if (p.ephemeral?.length) parts.push(`<h3>Pull request environments</h3><ul>${p.ephemeral.map((e) => `<li>${esc(e.env)} (pull request ${e.pr})${e.expires ? `, expires ${esc(e.expires)}` : ""}</li>`).join("")}</ul>`);
  if (extra) parts.push(extra(p));
  parts.push(`</section>`);
  return parts.join("\n");
}

/** The page: a summary, a section per member, the newest runs, the delivery metrics and the product's own sections. */
export function renderEstateHtml(estate: Estate, dora: Dora | undefined, words: Pick<CiProductWords, "product" | "noun"> = CHANT_WORDS, sections: EstateSections = {}): string {
  const t = estate.totals;
  const link = (project: string): string => `<a href="#${esc(`member-${project}`)}">${esc(project)}</a>`;
  const summary = `<p>${t.projects} ${esc(t.projects === 1 ? words.noun[0] : words.noun[1])}, ${t.waiting} waiting, ${t.drifted_projects} drifted, ${t.failed_roots} failed, ${t.overdue} overdue drift checks. Built ${esc(estate.generated)} from the workspace ledger.</p>`;
  const recent = `<h2>Newest runs</h2><div class="scroll"><table><tr><th>${esc(words.noun[0])}</th><th>Run</th><th>Commit</th><th>Finished</th><th>Applied</th><th>State</th></tr>
${estate.recent.map((r) => `<tr><td>${link(r.project)}</td>${runCells(r)}</tr>`).join("\n")}
</table></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(words.product)} estate</title><style>${CSS}</style></head>
<body><h1>${esc(words.product)} estate</h1>
${summary}
${estate.projects.map((p) => memberHtml(p, words, sections.member)).join("\n")}
${recent}
${dora ? `<h2>Delivery</h2>\n${renderDeliverySection(dora, link)}` : ""}
${(sections.sections ?? []).map((s) => `<h2>${esc(s.title)}</h2>\n${s.html}`).join("\n")}
</body></html>
`;
}
