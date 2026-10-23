// Tweaked and remixed games keep their family's look: a remix of Ring Out still uses Ring Out's
// baked still, intro steps and motif. A tweak gets a new spec id (origin.parentId = the original),
// so lookups keyed by a built-in id resolve through this lineage first.
import type { GameSpec } from '@cadabra/spec';

const parents = new Map<string, string>();

/** Remember that `child` was made from `parent` (tweak results, arcade loads). */
export function noteLineage(child: string, parent: string | undefined): void {
  if (parent && parent !== child) parents.set(child, parent);
}

/** Local tweak ids look like `<root>--t<stamp>`. */
const SUFFIX = /--t[0-9a-z]+$/;

/**
 * The oldest known ancestor's id: follows origin.parentId and the lineage map (cycle-safe), and
 * strips local tweak suffixes. A plain game is its own root.
 */
export function rootId(spec: { id: string; origin?: { parentId?: string | undefined } | undefined }): string {
  let id = spec.id;
  const first = spec.origin?.parentId;
  if (first && first !== id) { noteLineage(id, first); }
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const up = parents.get(id) ?? (SUFFIX.test(id) ? id.replace(SUFFIX, '') : undefined);
    if (!up) break;
    id = up;
  }
  return id;
}

/** A fresh id for a locally tweaked copy of `spec` (<= 64 chars, keeps the root readable). */
export function tweakId(spec: Pick<GameSpec, 'id' | 'origin'>, now = Date.now()): string {
  const root = rootId(spec).slice(0, 48);
  return `${root}--t${now.toString(36)}`.slice(0, 64);
}
