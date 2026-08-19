/**
 * Static evaluation of GitLab CI `rules:` and `workflow:rules:` against a supplied
 * context (branch, pipeline source, variables). This is the engine behind the
 * "which jobs would run on ref X" simulation.
 *
 * Scope (Phase 3a): evaluates `if:` expressions and `when:`. It deliberately does
 * NOT evaluate `changes:` / `exists:` (those need a file list) nor the legacy
 * `only:`/`except:` syntax — rules carrying only those conditions are treated as
 * matching so the simulation stays optimistic rather than hiding jobs we can't judge.
 */

import type { PipelineModel } from '@gitlab-ci-preview/shared';

export interface RuleContext {
  /** CI variables in scope: CI_COMMIT_BRANCH, CI_PIPELINE_SOURCE, plus pipeline/job variables. */
  variables: Record<string, string>;
}

export type JobOutcome = 'run' | 'manual' | 'never';

// ---------- `if:` expression evaluation ----------

type Token =
  | { t: 'var'; name: string }
  | { t: 'str'; value: string }
  | { t: 'regex'; value: string; flags: string }
  | { t: 'null' }
  | { t: 'op'; op: '==' | '!=' | '=~' | '!~' }
  | { t: 'and' }
  | { t: 'or' }
  | { t: 'lparen' }
  | { t: 'rparen' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (c === '&' && input[i + 1] === '&') { tokens.push({ t: 'and' }); i += 2; continue; }
    if (c === '|' && input[i + 1] === '|') { tokens.push({ t: 'or' }); i += 2; continue; }
    if (c === '=' && input[i + 1] === '=') { tokens.push({ t: 'op', op: '==' }); i += 2; continue; }
    if (c === '!' && input[i + 1] === '=') { tokens.push({ t: 'op', op: '!=' }); i += 2; continue; }
    if (c === '=' && input[i + 1] === '~') { tokens.push({ t: 'op', op: '=~' }); i += 2; continue; }
    if (c === '!' && input[i + 1] === '~') { tokens.push({ t: 'op', op: '!~' }); i += 2; continue; }
    if (c === '$') {
      i++;
      let name = '';
      if (input[i] === '{') { i++; while (i < n && input[i] !== '}') name += input[i++]; i++; }
      else { while (i < n && /[A-Za-z0-9_]/.test(input[i])) name += input[i++]; }
      tokens.push({ t: 'var', name });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c; i++;
      let value = '';
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) { value += input[i + 1]; i += 2; }
        else value += input[i++];
      }
      i++; // closing quote
      tokens.push({ t: 'str', value });
      continue;
    }
    if (c === '/') {
      i++;
      let value = '';
      while (i < n && input[i] !== '/') {
        if (input[i] === '\\' && i + 1 < n) { value += input[i] + input[i + 1]; i += 2; }
        else value += input[i++];
      }
      i++; // closing slash
      let flags = '';
      while (i < n && /[a-z]/.test(input[i])) flags += input[i++];
      tokens.push({ t: 'regex', value, flags });
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let word = '';
      while (i < n && /[A-Za-z]/.test(input[i])) word += input[i++];
      if (word === 'null') tokens.push({ t: 'null' });
      // Unknown bare words (shouldn't occur in valid rules) are ignored.
      continue;
    }
    i++; // skip anything unrecognised
  }
  return tokens;
}

type Operand =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'regex'; value: string; flags: string }
  | { kind: 'null' };

/** Recursive-descent parser → boolean, evaluated against the context. */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly ctx: RuleContext) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  parse(): boolean {
    if (this.tokens.length === 0) return true; // empty `if:` matches
    return this.parseOr();
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.t === 'or') { this.next(); const right = this.parseAnd(); left = left || right; }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parseComparison();
    while (this.peek()?.t === 'and') { this.next(); const right = this.parseComparison(); left = left && right; }
    return left;
  }

  private parseComparison(): boolean {
    if (this.peek()?.t === 'lparen') {
      this.next();
      const inner = this.parseOr();
      if (this.peek()?.t === 'rparen') this.next();
      return inner;
    }
    const left = this.readOperand();
    const op = this.peek();
    if (op && op.t === 'op') {
      this.next();
      const right = this.readOperand();
      return this.applyOp(op.op, left, right);
    }
    // Bare operand → truthiness: a variable is true when defined and non-empty.
    return this.truthy(left);
  }

  private readOperand(): Operand {
    const tok = this.next();
    if (!tok) return { kind: 'null' };
    if (tok.t === 'var') return { kind: 'var', name: tok.name };
    if (tok.t === 'str') return { kind: 'str', value: tok.value };
    if (tok.t === 'regex') return { kind: 'regex', value: tok.value, flags: tok.flags };
    return { kind: 'null' };
  }

  private resolve(o: Operand): string | null {
    if (o.kind === 'var') return o.name in this.ctx.variables ? this.ctx.variables[o.name] : null;
    if (o.kind === 'str') return o.value;
    return null; // null literal (regex handled separately)
  }

  private truthy(o: Operand): boolean {
    const v = this.resolve(o);
    return v !== null && v !== '';
  }

  private applyOp(op: '==' | '!=' | '=~' | '!~', left: Operand, right: Operand): boolean {
    if (op === '=~' || op === '!~') {
      const subject = this.resolve(left) ?? '';
      const re = right.kind === 'regex' ? safeRegex(right.value, right.flags) : null;
      const matched = re ? re.test(subject) : false;
      return op === '=~' ? matched : !matched;
    }
    const l = this.resolve(left);
    const r = this.resolve(right);
    const eq = l === r;
    return op === '==' ? eq : !eq;
  }
}

function safeRegex(pattern: string, flags: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

/** Evaluate a single `if:` expression against the context. Malformed input → false. */
export function evalIf(expr: string, ctx: RuleContext): boolean {
  try {
    return new Parser(tokenize(expr), ctx).parse();
  } catch {
    return false;
  }
}

// ---------- rule / workflow resolution ----------

function whenToOutcome(when: unknown): JobOutcome {
  if (when === 'never') return 'never';
  if (when === 'manual') return 'manual';
  return 'run'; // on_success, delayed, always, undefined
}

type RawRule = { if?: unknown; when?: unknown; changes?: unknown; exists?: unknown };

/** Does a rule's conditions match? Only `if:` is evaluated; `changes`/`exists` are treated as matching. */
function ruleMatches(rule: RawRule, ctx: RuleContext): boolean {
  if (typeof rule.if === 'string') return evalIf(rule.if, ctx);
  return true; // no `if:` (or only changes/exists) → matches
}

/**
 * Resolve a job to run / manual / never given its `rules:`.
 * No rules → 'run' (the job is unconditional, modulo workflow). First matching rule wins.
 */
export function evaluateRules(rules: unknown[] | undefined, ctx: RuleContext): JobOutcome {
  if (!rules || rules.length === 0) return 'run';
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw as RawRule;
    if (ruleMatches(rule, ctx)) return whenToOutcome(rule.when);
  }
  return 'never'; // rules present but none matched → job is excluded
}

/**
 * Evaluate top-level `workflow:rules:`. Returns whether the pipeline would be created.
 * No workflow / no rules → pipeline runs.
 */
export function evaluateWorkflow(workflow: Record<string, unknown> | undefined, ctx: RuleContext): boolean {
  const rules = workflow?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return true;
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw as RawRule;
    if (ruleMatches(rule, ctx)) return whenToOutcome(rule.when) !== 'never';
  }
  return false; // workflow rules present but none matched → no pipeline
}

// ---------- whole-pipeline simulation (webview entry point) ----------

/** The simulation context the user controls in the graph toolbar. */
export interface SimulationInput {
  /** CI_COMMIT_BRANCH / tag name. */
  ref: string;
  /** CI_PIPELINE_SOURCE (push, merge_request_event, schedule, web, …). */
  pipelineSource: string;
}

export interface SimulationResult {
  /** False when `workflow:rules:` would prevent the pipeline from being created. */
  pipelineRuns: boolean;
  /** Per-job outcome keyed by job name. */
  outcomes: Record<string, JobOutcome>;
}

/** GitLab's `CI_COMMIT_REF_SLUG` transform: lowercased, non-alphanumerics → `-`, trimmed, ≤63 chars. */
function refSlug(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

/**
 * Build the CI variable scope for a simulation from the model globals + the user's input.
 * Predefined values that aren't knowable locally (protected status, MR target branch) use
 * reasonable heuristics so common `rules:` still evaluate sensibly — they're approximations.
 */
function buildContext(model: PipelineModel, input: SimulationInput): RuleContext {
  const defaultBranch = model.globalVariables?.CI_DEFAULT_BRANCH ?? 'main';
  const isTag = input.pipelineSource === 'tag';
  const isMr = input.pipelineSource === 'merge_request_event';

  const vars: Record<string, string> = {
    ...model.globalVariables,
    CI: 'true',
    GITLAB_CI: 'true',
    CI_PIPELINE_SOURCE: input.pipelineSource,
    CI_COMMIT_REF_NAME: input.ref,
    CI_COMMIT_REF_SLUG: refSlug(input.ref),
    CI_DEFAULT_BRANCH: defaultBranch,
    // Heuristic: the default branch and tags are commonly protected.
    CI_COMMIT_REF_PROTECTED: input.ref === defaultBranch || isTag ? 'true' : 'false',
  };

  if (isTag) {
    vars.CI_COMMIT_TAG = input.ref;
  } else {
    vars.CI_COMMIT_BRANCH = input.ref;
  }
  if (isMr) {
    vars.CI_MERGE_REQUEST_EVENT_TYPE = 'merged_result';
    vars.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = input.ref;
    vars.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = defaultBranch;
  }
  return { variables: vars };
}

/** Evaluate `workflow:rules:` and every job's `rules:` for the given ref / source. */
export function simulatePipeline(model: PipelineModel, input: SimulationInput): SimulationResult {
  const ctx = buildContext(model, input);
  const pipelineRuns = evaluateWorkflow(model.workflow, ctx);
  const outcomes: Record<string, JobOutcome> = {};
  for (const job of model.jobs) {
    outcomes[job.name] = pipelineRuns ? evaluateRules(job.rules, ctx) : 'never';
  }
  return { pipelineRuns, outcomes };
}

/** Pipeline-source options offered in the simulation toolbar. */
export const PIPELINE_SOURCES = [
  'push', 'merge_request_event', 'schedule', 'web', 'api', 'trigger', 'pipeline', 'tag',
] as const;
