import type { BlockDef } from '../block';
import type { BlockRegistry } from '../registry';
import { arenaMove } from './arena-move';
import { collect } from './collect';
import { dodge } from './dodge';
import { race } from './race';

export { arenaMove } from './arena-move';
export { collect } from './collect';
export { dodge } from './dodge';
export { race } from './race';

/** Every built-in block, in registration order. Task 6 appends its blocks here. */
export const BUILTIN_BLOCKS: BlockDef[] = [arenaMove, collect, dodge, race] as BlockDef[];

export function registerBuiltins(registry: BlockRegistry): void {
  for (const def of BUILTIN_BLOCKS) registry.register(def);
}
