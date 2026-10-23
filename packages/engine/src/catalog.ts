import { zodToJsonSchema } from 'zod-to-json-schema';
import { PHYSICS_DEFAULTS, THEME_LOOKS, WorldSpecSchema } from '@cadabra/spec';
import type { BlockDef } from './block';
import type { BlockRegistry } from './registry';

export interface KitEntry {
  id: string;
  name: string;
  summary: string;
  controls: BlockDef['controls'];
  arenaKinds: BlockDef['arenaKinds'];
  /** JSON Schema (draft-07) of the block's params, with per-param `description` and `default`. */
  params: object;
}

type JsonSchema = { properties?: Record<string, Record<string, unknown>>; [k: string]: unknown };

/** The AI designer's toolbox: every registered block, its params as JSON Schema with defaults. */
export function kitCatalog(registry: BlockRegistry): KitEntry[] {
  return registry.list().map((def) => {
    const schema = zodToJsonSchema(def.paramsSchema, { target: 'jsonSchema7', $refStrategy: 'none' }) as JsonSchema;
    delete schema.$schema;
    const defaults = (def.defaults ?? {}) as Record<string, unknown>;
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (key in defaults) prop.default = JSON.parse(JSON.stringify(defaults[key])) as unknown;
    }
    return {
      id: def.id,
      name: def.name,
      summary: def.summary,
      controls: [...def.controls],
      arenaKinds: [...def.arenaKinds],
      params: schema,
    };
  });
}

/**
 * The AI designer's guide to `spec.world` (rigid-body physics + physics props) and the theme
 * looks: JSON Schema (draft-07) with per-field `description` and `default`, plus usage notes.
 */
export function worldCatalog(): { schema: object; looks: readonly string[]; notes: string[] } {
  const schema = zodToJsonSchema(WorldSpecSchema, { target: 'jsonSchema7', $refStrategy: 'none' }) as JsonSchema;
  delete schema.$schema;
  const phys = schema.properties?.physics as JsonSchema | undefined;
  for (const [key, prop] of Object.entries(phys?.properties ?? {})) {
    if (key in PHYSICS_DEFAULTS) prop.default = PHYSICS_DEFAULTS[key as keyof typeof PHYSICS_DEFAULTS];
  }
  return {
    schema,
    looks: THEME_LOOKS,
    notes: [
      'world.physics turns on rigid-body physics (planck.js): players become round bodies, bumps carry momentum and spin, props roll, bounce, topple and explode. Omit `world` for classic arcade movement.',
      'Top-down arenas: leave gravity at 0 for a flat table; gravityY 200–600 = a sloped table everything slides down.',
      'Feel presets: floaty / low gravity = linearDamping 0.2, restitution 0.9, arena-move friction 2; bouncy = restitution 1.0–1.2; heavy = playerMass 2, knockback 0.7; chaos = knockback 2, bumperKick 900.',
      'world.props spawns balls, crates, bumpers (static pinball kickers) and barrels (explode when dashed into or slammed). Keep the total ≤ 40.',
      'ball-sport needs no world.physics (it turns physics on itself); arena-move `crates` also turns it on.',
      'theme.look picks the art: neon (glowing vector arcade), toybox (glossy plastic toys), cosmos (deep space), retro (pixel-art CRT). Set theme.sfxSet to the same id for matching music and sfx.',
    ],
  };
}
