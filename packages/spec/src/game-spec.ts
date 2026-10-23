import { z } from 'zod';
import { ControlWidgetSchema, type ControlWidget } from './controls';

export const SPEC_VERSION = 1;

export type Hex = `#${string}`;

/** The default look: neon arcade (deep navy, cyan, magenta, lime, amber, red). */
export const NEON_PALETTE = { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#F4F7FF' } as const;
/** Extra neon tones for warnings and hazards. */
export const NEON_EXTRA = { amber: '#FFB020', red: '#FF3355' } as const;
/** Entity art keys the neon renderer draws procedurally. */
export const NEON_ART_KEYS = ['player', 'gem', 'core', 'core-unstable', 'spike', 'laser', 'boost', 'base', 'tile', 'hole', 'finish'] as const;

/**
 * Procedural art themes the TV renderer draws (packages/render). Pick the one that fits the
 * ingredients: neon = glowing vector arcade on deep navy; toybox = glossy plastic toys, bright
 * primaries on a light floor (lego, toys, food, animals, sports); cosmos = deep space, starfield,
 * nebula, astronaut orbs (space, aliens, planets, magic, night); retro = crisp pixel-art CRT arcade
 * (8-bit, arcade, robots, dungeons, classic games).
 */
export const THEME_LOOKS = ['neon', 'toybox', 'cosmos', 'retro'] as const;
export type ThemeLook = (typeof THEME_LOOKS)[number];
export const SFX_SETS = ['neon', 'toybox', 'cosmos', 'retro', 'arcade', 'cartoon', 'spooky', 'scifi', 'nature'] as const;

/** Default palette per look (the AI may re-tint; keep bg dark for neon/cosmos/retro, light for toybox). */
export const THEME_PALETTES: Readonly<Record<ThemeLook, { bg: Hex; primary: Hex; accent: Hex; glow: Hex; text: Hex }>> = {
  neon: { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#F4F7FF' },
  toybox: { bg: '#F3EEE4', primary: '#1E6BFF', accent: '#FF3B30', glow: '#FFC400', text: '#1B1F3B' },
  cosmos: { bg: '#070B1F', primary: '#7C5CFF', accent: '#FF7A59', glow: '#5CF2E6', text: '#EEF0FF' },
  retro: { bg: '#141021', primary: '#3EE0A0', accent: '#FF4F6D', glow: '#FFD23F', text: '#F7F1E3' },
};

export interface Theme {
  palette: { bg: Hex; primary: Hex; accent: Hex; glow: Hex; text: Hex };
  artStyle: string;
  keyArtPrompt: string;
  sprites: Record<string, string>; // spriteKey -> prompt
  sfxSet: (typeof SFX_SETS)[number];
  /** Procedural art theme (default neon). */
  look?: ThemeLook;
}

/** Physics props the runtime spawns (planck.js rigid bodies). */
export const PROP_KINDS = ['ball', 'crate', 'bumper', 'barrel'] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export interface WorldPhysics {
  enabled?: boolean;
  gravityX?: number;
  gravityY?: number;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  playerMass?: number;
  spin?: boolean;
  knockback?: number;
  walls?: boolean;
  bumperKick?: number;
  barrelPower?: number;
}

export interface WorldProp {
  kind: PropKind;
  count: number;
  layout?: 'scatter' | 'center' | 'ring' | 'edges' | 'corners';
  size?: number;
  radius?: number;
  respawnSec?: number;
}

export interface WorldSpec {
  physics?: WorldPhysics;
  props?: WorldProp[];
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
  /** Rigid-body physics and physics props (optional; absent = classic arcade movement). */
  world?: WorldSpec;
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
  sfxSet: z.enum(SFX_SETS),
  look: z.enum(THEME_LOOKS).optional(),
}) as unknown as z.ZodType<Theme>;

/** Defaults for every `world.physics` field (top-down: no gravity). */
export const PHYSICS_DEFAULTS: Required<WorldPhysics> = {
  enabled: true,
  gravityX: 0,
  gravityY: 0,
  restitution: 0.6,
  friction: 0.3,
  linearDamping: 1.2,
  angularDamping: 1.5,
  playerMass: 1,
  spin: true,
  knockback: 1,
  walls: true,
  bumperKick: 520,
  barrelPower: 900,
};

export const WorldPhysicsSchema: z.ZodType<WorldPhysics> = z.object({
  enabled: z.boolean().optional().describe('Rigid-body physics on (default true when world.physics is present). Players become round bodies; bumps transfer momentum and spin.'),
  gravityX: z.number().min(-1500).max(1500).optional().describe('Sideways pull on loose props (ball, crates, barrels) in px/s² (top-down default 0). Non-zero tilts the arena: things slide that way; players feel a gentle drift.'),
  gravityY: z.number().min(-1500).max(1500).optional().describe('Downward (+) / upward (-) pull on loose props in px/s² (top-down default 0). E.g. 400 = a sloped table everything rolls down.'),
  restitution: z.number().min(0).max(1.2).optional().describe('Bounciness of every body and wall: 0 = dead thud, 0.6 = default, 1 = superball, >1 = pinball chaos.'),
  friction: z.number().min(0).max(1).optional().describe('Contact friction: how much grazing hits make things spin and drag along walls (0 = ice, 1 = rubber).'),
  linearDamping: z.number().min(0).max(10).optional().describe('How fast loose props slow down (0 = slide forever / floaty low-gravity feel, 1.2 = default, 5 = mud). Also scales how long knocked players slide.'),
  angularDamping: z.number().min(0).max(10).optional().describe('How fast spinning stops (0 = spins forever).'),
  playerMass: z.number().min(0.25).max(4).optional().describe('Player body mass relative to a crate (1). Heavy players bulldoze props and shrug off knockback; light players fly.'),
  spin: z.boolean().optional().describe('Bodies rotate and spin on grazing hits (false = fixed rotation).'),
  knockback: z.number().min(0.25).max(4).optional().describe('Multiplier on every player knock: bumps, dash shoves, bumper kicks and barrel blasts (2 = twice the chaos).'),
  walls: z.boolean().optional().describe('Arena edges are solid bouncy walls for props (false = props can leave the arena).'),
  bumperKick: z.number().min(0).max(1500).optional().describe('Extra px/s a pinball bumper fires anything that hits it.'),
  barrelPower: z.number().min(0).max(2500).optional().describe('Blast strength of an explosive barrel (px/s at the centre, falling off to 0 at 220 px).'),
}) as unknown as z.ZodType<WorldPhysics>;

export const WorldPropSchema: z.ZodType<WorldProp> = z.object({
  kind: z.enum(PROP_KINDS).describe('ball = round bouncy body; crate = box that slides, rotates and spins; bumper = static pinball bumper that kicks; barrel = explodes with a radial blast when dashed into or slammed.'),
  count: z.number().int().min(1).max(12).describe('How many (all props together at most 40).'),
  layout: z.enum(['scatter', 'center', 'ring', 'edges', 'corners']).optional().describe('Where they spawn: scatter (random, default), center (clustered in the middle), ring (evenly on a circle of `radius` around the centre), edges (along the walls), corners.'),
  size: z.number().min(0.5).max(2.5).optional().describe('Size multiplier (1 = about a player).'),
  radius: z.number().min(40).max(500).optional().describe('ring layout: circle radius in px (default 200).'),
  respawnSec: z.number().min(0).max(30).optional().describe('Barrels/balls that explode or leave come back at their spawn after this many seconds (0 = never; default 6).'),
}) as unknown as z.ZodType<WorldProp>;

export const WorldSpecSchema: z.ZodType<WorldSpec> = z.object({
  physics: WorldPhysicsSchema.optional(),
  props: z.array(WorldPropSchema).max(4).optional(),
}) as unknown as z.ZodType<WorldSpec>;

/** world.physics with defaults filled in, or undefined when physics is off. */
export function resolvePhysics(spec: Pick<GameSpec, 'world'>, force = false): Required<WorldPhysics> | undefined {
  const p = spec.world?.physics;
  const on = p ? p.enabled !== false : force || (spec.world?.props?.length ?? 0) > 0;
  if (!on) return undefined;
  const out = { ...PHYSICS_DEFAULTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p ?? {})) if (v !== undefined) out[k] = v;
  out.enabled = true;
  return out as Required<WorldPhysics>;
}

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
    // 30..45 s rounds are quick-fire party mode; designed games use 60..120
    durationSec: z.number().int().min(30).max(120),
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
    world: WorldSpecSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const props = (spec.world?.props ?? []).reduce((n, p) => n + p.count, 0);
    if (props > 40) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['world', 'props'], message: `at most 40 props in total (got ${props})` });
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
