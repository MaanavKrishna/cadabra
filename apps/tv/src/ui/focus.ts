// D-pad focus on a (row, col) grid. One manager for the whole app; each screen registers its
// focusables on mount and unregisters on unmount. Focus is shown with the `is-focused` class.
export type Dir = 'up' | 'down' | 'left' | 'right';

export interface FocusHandlers {
  /** Select (OK) on this item; default clicks the element. */
  select?: () => void;
  /** Return true to consume the key (e.g. a settings row changing its value). */
  left?: () => boolean;
  right?: () => boolean;
  /** Called when the item gains focus. */
  focus?: () => void;
}

interface Item { el: HTMLElement; row: number; col: number; h: FocusHandlers; seq: number }

export const FOCUS_CLASS = 'is-focused';

export class FocusManager {
  private items: Item[] = [];
  private cur?: Item;
  private seq = 0;
  private backFn?: () => boolean;
  /** Notified after every focus change (screens re-render hero content from it). */
  onChange?: (el: HTMLElement | undefined) => void;

  get current(): HTMLElement | undefined {
    return this.cur?.el;
  }

  /** Add a focusable. The first one registered gets focus. Returns an unregister function. */
  register(el: HTMLElement, row: number, col: number, handlers: FocusHandlers = {}): () => void {
    const old = this.items.find((i) => i.el === el);
    if (old) {
      old.row = row; old.col = col; old.h = handlers;
    } else {
      this.items.push({ el, row, col, h: handlers, seq: this.seq++ });
    }
    if (!this.cur) this.set(this.items.find((i) => i.el === el));
    return () => this.unregister(el);
  }

  unregister(el: HTMLElement): void {
    const it = this.items.find((i) => i.el === el);
    if (!it) return;
    this.items = this.items.filter((i) => i !== it);
    if (this.cur === it) {
      el.classList.remove(FOCUS_CLASS);
      this.cur = undefined;
      this.set(this.nearest(it.row, it.col));
    }
  }

  /** Drop every focusable (screen change). */
  reset(): void {
    this.cur?.el.classList.remove(FOCUS_CLASS);
    this.items = [];
    this.cur = undefined;
    this.backFn = undefined;
  }

  focus(el: HTMLElement): void {
    const it = this.items.find((i) => i.el === el);
    if (it) this.set(it);
  }

  move(dir: Dir): void {
    const c = this.cur;
    if (!c) return this.set(this.items[0]);
    if (dir === 'left' && c.h.left?.()) return;
    if (dir === 'right' && c.h.right?.()) return;
    let next: Item | undefined;
    if (dir === 'left' || dir === 'right') {
      const sign = dir === 'right' ? 1 : -1;
      // same row, next column in that direction; never wraps
      next = this.items
        .filter((i) => i.row === c.row && (i.col - c.col) * sign > 0)
        .sort((a, b) => (a.col - b.col) * sign)[0];
    } else {
      const sign = dir === 'down' ? 1 : -1;
      const rows = [...new Set(this.items.map((i) => i.row))].filter((r) => (r - c.row) * sign > 0).sort((a, b) => (a - b) * sign);
      if (rows.length) next = this.nearestIn(rows[0]!, c.col);
    }
    if (next) this.set(next);
  }

  select(): void {
    const c = this.cur;
    if (!c) return;
    if (c.h.select) c.h.select();
    else c.el.click();
  }

  /** The screen's Back handler; true = handled. */
  setBack(fn: (() => boolean) | undefined): void {
    this.backFn = fn;
  }

  back(): boolean {
    return this.backFn?.() ?? false;
  }

  private nearestIn(row: number, col: number): Item | undefined {
    return this.items
      .filter((i) => i.row === row)
      .sort((a, b) => Math.abs(a.col - col) - Math.abs(b.col - col) || a.col - b.col)[0];
  }

  private nearest(row: number, col: number): Item | undefined {
    return [...this.items].sort(
      (a, b) => Math.abs(a.row - row) - Math.abs(b.row - row) || Math.abs(a.col - col) - Math.abs(b.col - col) || a.seq - b.seq,
    )[0];
  }

  private set(it: Item | undefined): void {
    if (it === this.cur) return;
    this.cur?.el.classList.remove(FOCUS_CLASS);
    this.cur = it;
    if (it) {
      it.el.classList.add(FOCUS_CLASS);
      it.h.focus?.();
    }
    this.onChange?.(it?.el);
  }
}
