import type { BlockDef } from './block';

export class BlockRegistry {
  private defs = new Map<string, BlockDef>();

  register(def: BlockDef): void {
    if (this.defs.has(def.id)) throw new Error(`duplicate block: ${def.id}`);
    this.defs.set(def.id, def);
  }

  get(id: string): BlockDef | undefined {
    return this.defs.get(id);
  }

  list(): BlockDef[] {
    return [...this.defs.values()];
  }
}
