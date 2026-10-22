import { zodToJsonSchema } from 'zod-to-json-schema';
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
