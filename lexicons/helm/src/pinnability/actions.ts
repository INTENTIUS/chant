/**
 * Go template action extraction and control-flow scoping (#1234, epic #1228).
 *
 * The pinnability gate inspects template ACTIONS (`{{ ... }}`), never raw
 * text. That distinction is finding 9: cert-manager carries 52 textual
 * "lookup" occurrences, all comment prose, and a real template-action count
 * of 0 — a text-matching gate refuses a chart that is perfectly pinnable.
 *
 * Beyond extraction, this module reconstructs the control-flow structure of a
 * template file — which `if` / `with` / `range` blocks enclose each action —
 * so the classifier can ask whether a construct is REACHABLE under the
 * supplied values, not merely present. Reachability is what separates
 * "unpinnable" from "pinnable with a recorded conditional hazard": bundled
 * grafana's control-flow `lookup` sits behind `persistence.enabled`, off by
 * default, so a default-values render never consults the cluster.
 */

export type ActionKind =
  | "if"
  | "elseif"
  | "else"
  | "with"
  | "range"
  | "define"
  | "block"
  | "end"
  | "other";

export interface TemplateAction {
  /** Path of the file the action was found in (as given by the caller). */
  file: string;
  /** 1-based line the action starts on. */
  line: number;
  /** The action body between `{{` and `}}`, trim markers stripped. */
  body: string;
  /** Structural role of the action, from its leading keyword. */
  kind: ActionKind;
}

/**
 * One enclosing control-flow frame for an action. `conditions` are the
 * expressions that must hold for the frame's branch to run; `negatedConditions`
 * are prior branch conditions that must NOT hold (an `else` / `else if`
 * branch runs only when every earlier branch condition was false).
 */
export interface ScopeFrame {
  kind: "if" | "with" | "range" | "define" | "block" | "dependency-condition";
  conditions: string[];
  negatedConditions: string[];
  /**
   * When a `with` block pins the dot to a `.Values` subtree, the path of that
   * subtree — so bare `.enabled` inside `with .Values.persistence` resolves
   * to `persistence.enabled`. `undefined` means the dot is unresolvable
   * (a `range` element, a non-values `with`, a `define` invoked from an
   * unknown context).
   */
  dotValuesPath?: string[];
  /** Dot is rebound to something we cannot resolve (range element etc.). */
  dotUnresolvable?: boolean;
}

export interface ScopedAction {
  action: TemplateAction;
  /** Enclosing frames, outermost first. Empty for top-level actions. */
  frames: ScopeFrame[];
}

const KIND_RE =
  /^(if\b|else\s+if\b|else\b|with\b|range\b|define\b|block\b|end\b)/;

function kindOf(body: string): ActionKind {
  const m = body.match(KIND_RE);
  if (!m) return "other";
  const kw = m[1].replace(/\s+/g, " ").trim();
  if (kw === "else if") return "elseif";
  return kw.replace(/\b\s.*$/, "") as ActionKind;
}

/**
 * Extract template actions from a source file, skipping comment actions
 * (`{{/* ... *\/}}`). Text outside actions — including YAML `#` comments,
 * where finding 9's 52 false positives lived — is never inspected by any
 * scan built on this.
 */
export function extractActions(source: string, file: string): TemplateAction[] {
  const actions: TemplateAction[] = [];
  let i = 0;
  let line = 1;
  let lineScanPos = 0;
  const lineAt = (pos: number): number => {
    // Incremental line counting: `pos` is monotonically increasing.
    for (; lineScanPos < pos; lineScanPos++) {
      if (source[lineScanPos] === "\n") line += 1;
    }
    return line;
  };
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) break;
    const actionLine = lineAt(open);
    // Body starts after `{{` and an optional trim marker.
    let bodyStart = open + 2;
    if (source[bodyStart] === "-") bodyStart += 1;
    const rest = source.slice(bodyStart);
    // Comment action: {{/* ... */}} — skip to its closing */}}.
    if (/^\s*\/\*/.test(rest)) {
      const closeComment = source.indexOf("*/", bodyStart);
      if (closeComment === -1) break;
      const close = source.indexOf("}}", closeComment);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    const close = source.indexOf("}}", bodyStart);
    if (close === -1) break;
    let body = source.slice(bodyStart, close);
    if (body.endsWith("-")) body = body.slice(0, -1);
    body = body.trim();
    actions.push({ file, line: actionLine, body, kind: kindOf(body) });
    i = close + 2;
  }
  return actions;
}

/**
 * The pipeline of an action, structural keyword and variable assignment
 * stripped: `if X` → `X`, `range $i, $v := X` → `X`, `$pw := X` → `X`.
 * This is what condition evaluation and call-reachability parse.
 */
export function actionPipeline(action: TemplateAction): string {
  let expr = action.body.replace(KIND_RE, "").trim();
  // `range $i, $v := .Values.x` / `$pw := .Values.x` — the pipeline is what
  // follows the assignment.
  const assign = expr.match(/^\$[\w]*\s*(?:,\s*\$[\w]*\s*)?:?=\s*(.*)$/);
  if (assign) expr = assign[1].trim();
  return expr;
}


/** `.Values.a.b` (or `$.Values.a.b`) as a path array, else undefined. */
function valuesPathOf(expr: string): string[] | undefined {
  const m = expr.match(/^\$?\.Values((?:\.[A-Za-z0-9_-]+)+)$/);
  return m ? m[1].slice(1).split(".") : undefined;
}

interface BranchState {
  frame: ScopeFrame;
  /** All branch conditions seen so far in this if-chain. */
  chain: string[];
}

/**
 * Walk a file's actions and attach the enclosing control-flow frames to each.
 * `else` / `else if` branches carry the prior branch conditions as
 * `negatedConditions`. Structure that cannot be tracked (an unbalanced
 * `end`, template text split across files) degrades to fewer frames — which
 * only ever makes the classifier MORE conservative, never less: a missing
 * frame means a gate we cannot prove closed.
 */
export function scopeActions(actions: TemplateAction[]): ScopedAction[] {
  const scoped: ScopedAction[] = [];
  const stack: BranchState[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case "if": {
        const cond = actionPipeline(action);
        // The `if` action itself is evaluated in the ENCLOSING scope.
        scoped.push({ action, frames: stack.map((s) => s.frame) });
        stack.push({
          frame: { kind: "if", conditions: [cond], negatedConditions: [] },
          chain: [cond],
        });
        break;
      }
      case "elseif": {
        scoped.push({
          action,
          frames: stack.slice(0, -1).map((s) => s.frame),
        });
        const top = stack[stack.length - 1];
        const cond = action.body.replace(/^else\s+if\b/, "").trim();
        if (top) {
          top.frame = {
            kind: "if",
            conditions: [cond],
            negatedConditions: [...top.chain],
          };
          top.chain.push(cond);
        }
        break;
      }
      case "else": {
        scoped.push({
          action,
          frames: stack.slice(0, -1).map((s) => s.frame),
        });
        const top = stack[stack.length - 1];
        if (top) {
          top.frame = {
            kind: top.frame.kind === "if" ? "if" : top.frame.kind,
            conditions: [],
            negatedConditions: [...top.chain],
          };
        }
        break;
      }
      case "with": {
        const expr = actionPipeline(action);
        scoped.push({ action, frames: stack.map((s) => s.frame) });
        const path = valuesPathOf(expr);
        stack.push({
          frame: {
            kind: "with",
            conditions: [expr],
            negatedConditions: [],
            dotValuesPath: path,
            dotUnresolvable: path === undefined,
          },
          chain: [expr],
        });
        break;
      }
      case "range": {
        const expr = actionPipeline(action);
        scoped.push({ action, frames: stack.map((s) => s.frame) });
        stack.push({
          frame: {
            kind: "range",
            conditions: [expr],
            negatedConditions: [],
            dotUnresolvable: true,
          },
          chain: [expr],
        });
        break;
      }
      case "define":
      case "block": {
        scoped.push({ action, frames: stack.map((s) => s.frame) });
        // A define body runs with whatever context `include`/`template`
        // passes. Most charts pass the root context; the frame records
        // nothing to gate on, so constructs inside a define are treated as
        // reachable unless gated within the define itself.
        stack.push({
          frame: { kind: action.kind, conditions: [], negatedConditions: [] },
          chain: [],
        });
        break;
      }
      case "end": {
        scoped.push({
          action,
          frames: stack.slice(0, -1).map((s) => s.frame),
        });
        stack.pop();
        break;
      }
      default:
        scoped.push({ action, frames: stack.map((s) => s.frame) });
    }
  }
  return scoped;
}
