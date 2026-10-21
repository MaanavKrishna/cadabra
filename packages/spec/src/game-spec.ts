import { z } from 'zod';
import { ControlWidgetSchema, type ControlWidget } from './controls';

export const SPEC_VERSION = 1;

export type Hex = `#${string}`;

export interface Theme {
  palette: { bg: Hex; primary: Hex; accent: Hex; glow: Hex; text: Hex };
  artStyle: string;
  keyArtPrompt: string;
  sprites: Record<string, string>; // spriteKey -> prompt
  sfxSet: 'arcade' | 'cartoon' | 'spooky' | 'scifi' | 'nature';
}

export interface BlockUse { block: string; params: Record<string, unknown> }

export interface TimelineEvent {
  atSec: number;
  kind: string;
  params: Record<string, unknown>;
  hostLine: string;
}

export interface GameSpec {
  version: 1;
  id: string;
  title: string;
  hook: string;
  theme: Theme;
  arena: { kind: 'topdown' | 'lanes' | 'tug' | 'canvas' | 'quiz'; width: number; height: number };
  teams: 0 | 2;
  durationSec: number;
  blocks: BlockUse[];
  modifiers: BlockUse[];
  win: { type: 'highScore' | 'lastStanding' | 'firstTo' | 'teamScore'; target?: number };
  timeline: TimelineEvent[];
  comeback: { enabled: boolean; strength: number };
  controller: ControlWidget[];
  host: { intro: string; finale: string; tutorial: string };
  origin: { ingredients: string[]; parentId?: string; wild: boolean };
}

export interface Pitch {
  id: string;
  title: string;
  hook: string;
  keyArtPrompt: string;
  palette: Theme['palette'];
  blocksSketch: string[];
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/) as unknown as z.ZodType<Hex>;

export const PaletteSchema = z.object({ bg: hex, primary: hex, accent: hex, glow: hex, text: hex });

export const ThemeSchema: z.ZodType<Theme> = z.object({
  palette: PaletteSchema,
  artStyle: z.string().min(1).max(120),
  keyArtPrompt: z.string().min(1).max(600),
  sprites: z.record(z.string(), z.string().min(1).max(300)),
  sfxSet: z.enum(['arcade', 'cartoon', 'spooky', 'scifi', 'nature']),
});

const params = z.record(z.string(), z.unknown());
const BlockUseSchema: z.ZodType<BlockUse> = z.object({ block: z.string().min(1), params });

const TimelineEventSchema: z.ZodType<TimelineEvent> = z.object({
  atSec: z.number().min(0),
  kind: z.string().min(1),
  params,
  hostLine: z.string().min(1).max(160),
});

export const PitchSchema: z.ZodType<Pitch> = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(40),
  hook: z.string().min(1).max(120),
  keyArtPrompt: z.string().min(1).max(600),
  palette: PaletteSchema,
  blocksSketch: z.array(z.string()).max(8),
});

export const GameSpecSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(40),
    hook: z.string().min(1).max(120),
    theme: ThemeSchema,
    arena: z.object({
      kind: z.enum(['topdown', 'lanes', 'tug', 'canvas', 'quiz']),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    teams: z.union([z.literal(0), z.literal(2)]),
    durationSec: z.number().int().min(60).max(120),
    blocks: z.array(BlockUseSchema).min(1).max(4),
    modifiers: z.array(BlockUseSchema).max(4),
    win: z.object({
      type: z.enum(['highScore', 'lastStanding', 'firstTo', 'teamScore']),
      target: z.number().positive().optional(),
    }),
    timeline: z.array(TimelineEventSchema).min(1).max(4),
    comeback: z.object({ enabled: z.boolean(), strength: z.number().min(0).max(1) }),
    controller: z.array(ControlWidgetSchema).min(1).max(6),
    host: z.object({
      intro: z.string().min(1).max(240),
      finale: z.string().min(1).max(240),
      tutorial: z.string().min(1).max(240),
    }),
    origin: z.object({
      ingredients: z.array(z.string()).max(8),
      parentId: z.string().optional(),
      wild: z.boolean(),
    }),
  })
  .superRefine((spec, ctx) => {
    spec.timeline.forEach((ev, i) => {
      if (ev.atSec >= spec.durationSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timeline', i, 'atSec'],
          message: `must be less than durationSec (${spec.durationSec})`,
        });
      }
    });
  }) as unknown as z.ZodType<GameSpec>;

export function parseSpec(
  x: unknown,
): { ok: true; spec: GameSpec } | { ok: false; errors: string[] } {
  const r = GameSpecSchema.safeParse(x);
  if (r.success) return { ok: true, spec: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
