import jsonpatch, { type Operation } from 'fast-json-patch';
import { z } from 'zod';
import {
  BlockRegistry, kitCatalog, playtest, registerBuiltins, type KitEntry, type PlaytestReport,
} from '@cadabra/engine';
import { parseSpec, type GameSpec } from '@cadabra/spec';
import type { ToolSpec } from './bedrock';

/** Built-in kit (wild blocks were cut): the only blocks the designer may use. */
export const REGISTRY: BlockRegistry = (() => {
  const r = new BlockRegistry();
  registerBuiltins(r);
  return r;
})();
export const CATALOG: KitEntry[] = kitCatalog(REGISTRY);

/**
 * First JSON object or array in model text. Tolerates prose, ```json fences and braces inside
 * strings. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const v = scan(m[1]!);
    if (v !== undefined) return v;
  }
  return scan(text);
}

function scan(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const c = text[start];
    if (c !== '{' && c !== '[') continue;
    const end = matchEnd(text, start);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* try the next opener */
    }
  }
  return undefined;
}

/** Index of the bracket closing the one at `start`, string-aware; -1 if unbalanced. */
function matchEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

const specArg = {
  type: 'object',
  description: 'A full GameSpec object. Omit to use your latest spec.',
} as const;

/** Converse tool specs (JSON schemas). */
export const TOOL_SPECS: ToolSpec[] = [
  {
    toolSpec: {
      name: 'list_blocks',
      description: 'List the kit blocks (id, name, summary, controls, arena kinds). The system prompt already has this; call only if unsure.',
      inputSchema: { json: { type: 'object', properties: {} } },
    },
  },
  {
    toolSpec: {
      name: 'get_block_schema',
      description: "One block's params as JSON Schema with defaults and descriptions, plus the controller widgets it needs.",
      inputSchema: { json: { type: 'object', properties: { block: { type: 'string', description: 'Block id, e.g. "sneak".' } }, required: ['block'] } },
    },
  },
  {
    toolSpec: {
      name: 'validate_spec',
      description: 'Schema-check a spec. Returns {ok, errors}. playtest_spec also validates, so prefer it.',
      inputSchema: { json: { type: 'object', properties: { spec: specArg } } },
    },
  },
  {
    toolSpec: {
      name: 'playtest_spec',
      description: 'Validate, then play a full round with 4 bots (skills 0.4–0.9). Returns {ok, reasons, stats}. Reasons say exactly what to fix.',
      inputSchema: { json: { type: 'object', properties: { spec: specArg } } },
    },
  },
  {
    toolSpec: {
      name: 'patch_spec',
      description: 'Apply RFC 6902 JSON Patch ops to a spec (default: your latest). Returns {spec, validation}. The result becomes your latest spec.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            spec: specArg,
            patch: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
                  path: { type: 'string', description: 'JSON pointer, e.g. /blocks/0/params/hitPenalty' },
                  value: {},
                  from: { type: 'string' },
                },
                required: ['op', 'path'],
              },
            },
          },
          required: ['patch'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'submit_spec',
      description: 'Submit the final spec (default: your latest). Accepted only if it validates and passes the bot playtest; otherwise returns the reasons.',
      inputSchema: { json: { type: 'object', properties: { spec: specArg } } },
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.toolSpec!.name!);

export interface ToolState {
  /** Latest spec the agent wrote or patched (normalized). */
  current?: unknown;
  /** Latest spec that passed validate + playtest. */
  passing?: { spec: GameSpec; report: PlaytestReport; from?: unknown };
  /** Server-owned fields (version, id, origin) are stamped on every spec the agent sends. */
  normalize(spec: unknown): unknown;
  /** Bots in each playtest: the room's head count (2..4), default 4. */
  players?: number;
}

export interface ToolOutcome {
  status: 'success' | 'error';
  result: Record<string, unknown>;
  /** Set when submit_spec accepted the spec: the design is done. */
  submitted?: { spec: GameSpec; report: PlaytestReport };
}

const PatchSchema = z.array(z.object({ op: z.string(), path: z.string(), value: z.unknown().optional(), from: z.string().optional() }));

const err = (error: string, extra: Record<string, unknown> = {}): ToolOutcome => ({ status: 'error', result: { error, ...extra } });

/** Model sometimes sends the spec as a JSON string; accept that too. */
function coerceSpec(x: unknown): unknown {
  return typeof x === 'string' ? extractJson(x) : x;
}

function pickSpec(input: Record<string, unknown>, state: ToolState): unknown {
  const raw = coerceSpec(input.spec);
  if (raw !== undefined && raw !== null) {
    state.current = state.normalize(raw);
  }
  return state.current;
}

export function runPlaytest(spec: unknown, players = 4): { report: PlaytestReport; spec?: GameSpec } {
  const v = parseSpec(spec);
  if (!v.ok) {
    return { report: { ok: false, reasons: v.errors.map((e) => `spec: ${e}`), stats: { scoringPlayers: 0, endedAtSec: 0, events: 0, maxEntities: 0, msWall: 0 } } };
  }
  return { report: playtest(v.spec, REGISTRY, { players }), spec: v.spec };
}

function check(spec: unknown, state: ToolState): ToolOutcome & { spec?: GameSpec; report?: PlaytestReport } {
  const { report, spec: parsed } = runPlaytest(spec, state.players);
  if (report.ok && parsed) state.passing = { spec: parsed, report, from: spec };
  return {
    status: report.ok ? 'success' : 'error',
    result: report.ok
      ? { ok: true, stats: report.stats, next: 'Passed. Call submit_spec with no arguments.' }
      : { ok: false, reasons: report.reasons, stats: report.stats, next: 'Fix every reason with one patch_spec, then playtest_spec.' },
    spec: parsed,
    report,
  };
}

/** Execute one tool call. Never throws: failures are returned to the model as error results. */
export function runTool(name: string, input: unknown, state: ToolState): ToolOutcome {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'list_blocks':
        return { status: 'success', result: { blocks: CATALOG.map(({ params: _p, ...k }) => k) } };
      case 'get_block_schema': {
        const id = String(args.block ?? '');
        const entry = CATALOG.find((k) => k.id === id);
        if (!entry) return err(`unknown block "${id}"`, { known: CATALOG.map((k) => k.id) });
        const def = REGISTRY.get(id)!;
        return {
          status: 'success',
          result: { ...entry, needs: def.requiredControls?.(def.defaults) ?? def.controls.map((kind) => ({ kind, id: '' })) },
        };
      }
      case 'validate_spec': {
        const spec = pickSpec(args, state);
        if (spec === undefined) return err('no spec yet: pass {"spec": {...}}');
        const v = parseSpec(spec);
        return v.ok ? { status: 'success', result: { ok: true } } : { status: 'error', result: { ok: false, errors: v.errors } };
      }
      case 'playtest_spec': {
        const spec = pickSpec(args, state);
        if (spec === undefined) return err('no spec yet: pass {"spec": {...}}');
        const { status, result } = check(spec, state);
        return { status, result };
      }
      case 'patch_spec': {
        const base = pickSpec(args, state);
        if (base === undefined) return err('no spec yet: pass {"spec": {...}, "patch": [...]}');
        const ops = PatchSchema.safeParse(coerceSpec(args.patch));
        if (!ops.success) return err('patch must be an array of {op, path, value?, from?}');
        let next: unknown;
        try {
          next = jsonpatch.applyPatch(structuredClone(base), ops.data as Operation[], true, false).newDocument;
        } catch (e) {
          return err(`patch failed: ${(e as Error).message}`);
        }
        state.current = state.normalize(next);
        const v = parseSpec(state.current);
        return {
          status: 'success',
          result: { spec: state.current, validation: v.ok ? 'ok' : v.errors },
        };
      }
      case 'submit_spec': {
        const spec = pickSpec(args, state);
        // Latest spec unchanged since it passed: no need to play it again.
        if (spec !== undefined && state.passing && state.passing.from === spec) {
          const { spec: ok, report } = state.passing;
          return { status: 'success', result: { accepted: true }, submitted: { spec: ok, report } };
        }
        if (spec === undefined) return err('no spec yet: pass {"spec": {...}}');
        const out = check(spec, state);
        if (out.status !== 'success' || !out.spec || !out.report) {
          return { status: 'error', result: { accepted: false, ...out.result } };
        }
        return { status: 'success', result: { accepted: true }, submitted: { spec: out.spec, report: out.report } };
      }
      default:
        return err(`unknown tool "${name}"`, { tools: TOOL_NAMES });
    }
  } catch (e) {
    return err(`tool ${name} failed: ${(e as Error).message}`);
  }
}
