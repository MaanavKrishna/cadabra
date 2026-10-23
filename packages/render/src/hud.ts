import { Container, Graphics, Sprite, type Text, type Texture } from 'pixi.js';
import type { Player } from '@cadabra/engine';
import { easeOutBack } from './ease';
import { label } from './entities';
import { TEAM_COLORS, darken, hexToNum, lighten, playerColor, type Palette } from './theme';

interface Chip {
  id: string;
  root: Container;
  bg: Graphics;
  avatar: Sprite;
  name: Text;
  score: Text;
  x: number;
  shown: number;
  bumpAt: number;
  born: number;
  /** A flown-in score popup landed: a bigger bump. */
  hitAt: number;
  lead?: boolean;
  w?: number;
  fitKey?: string | undefined;
  hot?: boolean;
}

const SAFE_X = 64; // 5% title-safe of 1280
const SAFE_Y = 30; // 5% of 720 (less the timer pill's own padding)
const CHIP_H = 60;
/** Room kept for the score digits when fitting a name (fixed: refitting on every score change re-rasterised text). */
const SCORE_ROOM = 58;


/** Timer, score chips and the snapshot banner. Steady (never shaken), title-safe. */
export class Hud {
  readonly root = new Container();
  private timerBg = new Graphics();
  private timer: Text;
  private lastSec = -1;
  private secAt = -9;
  private teams: [Text, Text];
  private chips = new Map<string, Chip>();
  private bannerRoot = new Container();
  private band = new Graphics();
  private bannerText: Text;
  private banner = '';
  private bannerAt = -9;
  private bannerOutAt = -9;
  private palette!: Palette;
  private multText: Text;
  private mult = 1;
  private multAt = -9;

  constructor(private W: number, private H: number) {
    this.timer = label('0:00', 38, 0xffffff, { display: true });
    this.teams = [label('0', 46, TEAM_COLORS[0], { display: true }), label('0', 46, TEAM_COLORS[1], { display: true })];
    this.bannerText = label('', 44, 0xffffff, { display: true, stroke: 7 });
    this.bannerText.style.wordWrap = true;
    this.bannerText.style.wordWrapWidth = W - SAFE_X * 4;
    this.bannerRoot.addChild(this.band, this.bannerText);
    this.bannerRoot.visible = false;
    this.multText = label('×2 POINTS', 22, 0x0b0b18, { display: true, stroke: 0 });
    this.multText.visible = false;
    this.root.addChild(this.timerBg, this.timer, this.multText, ...this.teams, this.bannerRoot);
  }

  /** Final-10 double points: a badge under the timer (1 = off). */
  setMultiplier(m: number, vt: number): void {
    if (m === this.mult) return;
    this.mult = m;
    this.multAt = vt;
    this.multText.visible = m > 1;
    if (m > 1) this.multText.text = `×${m} POINTS`;
    this.lastSec = -1;
  }

  setPalette(p: Palette): void {
    this.palette = p;
    this.lastSec = -1;
    for (const c of this.chips.values()) c.lead = undefined;
  }

  update(players: Player[], remaining: number, banner: string | undefined, vt: number, avatarTex: (p: Player) => Texture): void {
    this.updateTimer(remaining, vt);
    this.updateTeams(players);
    this.updateChips(players, vt, avatarTex);
    this.updateBanner(banner ?? '', vt);
  }

  private updateTimer(remaining: number, vt: number): void {
    const sec = Math.ceil(remaining);
    const finale = remaining <= 10 && remaining > 0;
    if (sec !== this.lastSec) {
      this.lastSec = sec;
      this.secAt = vt;
      this.timer.text = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      const col = finale ? hexToNum(this.palette.accent) : 0xffffff;
      this.timer.style.fill = col;
      const w = 160;
      this.timerBg.clear()
        .roundRect(-w / 2, -32, w, 64, 32).fill({ color: finale ? darken(col, 0.55) : 0x0b0b18, alpha: 0.82 })
        .roundRect(-w / 2, -32, w, 64, 32).stroke({ width: finale ? 5 : 3, color: finale ? col : hexToNum(this.palette.glow), alpha: 0.95 });
      if (this.mult > 1) {
        this.timerBg.roundRect(-74, 30, 148, 30, 15).fill({ color: hexToNum(this.palette.glow) });
      }
    }
    // final 10: a heartbeat on every second, stronger as it runs out
    const k = Math.max(0, 1 - (vt - this.secAt) / 0.4);
    const pulse = finale ? 1 + (0.16 + 0.03 * (10 - Math.min(10, remaining))) * k : 1;
    this.timerBg.position.set(this.W / 2, SAFE_Y + 32);
    this.timer.position.set(this.W / 2, SAFE_Y + 32);
    this.timer.scale.set(pulse);
    this.timerBg.scale.set(pulse);
    if (this.multText.visible) {
      const m = vt - this.multAt;
      this.multText.position.set(this.W / 2, SAFE_Y + 32 + 45 * pulse);
      this.multText.scale.set((m < 0.4 ? easeOutBack(m / 0.4) : 1) * pulse);
    }
  }

  private updateTeams(players: Player[]): void {
    const has = players.some((p) => p.team !== undefined);
    const tot: [number, number] = [0, 0];
    for (const p of players) if (p.team !== undefined) tot[p.team] += p.score;
    this.teams.forEach((t, i) => {
      t.visible = has;
      if (!has) return;
      const s = String(tot[i]);
      if (t.text !== s) t.text = s;
      t.position.set(this.W / 2 + (i === 0 ? -150 : 150), SAFE_Y + 30);
    });
  }

  private updateChips(players: Player[], vt: number, avatarTex: (p: Player) => Texture): void {
    const n = players.length;
    if (n === 0) return;
    const gap = 10;
    const w = Math.min(230, (this.W - SAFE_X * 2 - gap * (n - 1)) / n);
    const order = [...players].sort((a, b) => b.score - a.score);
    const top = order[0]!.score > 0 && (order.length < 2 || order[0]!.score > order[1]!.score) ? order[0]!.id : '';
    const total = n * w + (n - 1) * gap;
    const y = this.H - SAFE_Y - CHIP_H;
    const live = new Set<string>();
    players.forEach((p, idx) => {
      live.add(p.id);
      let c = this.chips.get(p.id);
      if (!c) {
        const root = new Container();
        const bg = new Graphics();
        const avatar = new Sprite();
        avatar.anchor.set(0.5);
        const name = label('', 20, 0xffffff, { weight: '800', stroke: 3 });
        name.anchor.set(0, 0.5);
        const score = label('0', 32, 0xffffff, { display: true });
        score.anchor.set(1, 0.5);
        root.addChild(bg, avatar, name, score);
        this.root.addChild(root);
        c = { id: p.id, root, bg, avatar, name, score, x: this.W / 2, shown: p.score, bumpAt: -9, born: vt, hitAt: -9 };
        this.chips.set(p.id, c);
      }
      const color = p.team !== undefined ? TEAM_COLORS[p.team] : playerColor(idx, this.palette);
      const lead = p.id === top;
      if (c.lead !== lead || c.w !== w) {
        c.lead = lead;
        c.w = w;
        c.bg.clear()
          .roundRect(0, 0, w, CHIP_H, 18).fill({ color: lead ? darken(hexToNum(this.palette.glow), 0.55) : 0x0b0b18, alpha: 0.72 })
          .roundRect(0, 0, 6, CHIP_H, 3).fill({ color })
          .roundRect(0, 0, w, CHIP_H, 18).stroke({ width: lead ? 3 : 1.5, color: lead ? hexToNum(this.palette.glow) : lighten(color, 0.2), alpha: lead ? 1 : 0.5 });
      }
      if (p.score !== c.shown) {
        c.shown = p.score;
        c.score.text = String(p.score);
        c.bumpAt = vt;
      }
      // fit the name between avatar and a fixed score slot: only when the name or width changes
      const fitKey = `${p.name}|${w}`;
      if (c.fitKey !== fitKey) {
        c.fitKey = fitKey;
        c.name.text = fitName(p.name, w - 58 - SCORE_ROOM - 12, 11);
      }
      const tex = avatarTex(p);
      if (c.avatar.texture !== tex) c.avatar.texture = tex;
      const ak = 46 / Math.max(1, tex.width, tex.height);
      c.avatar.scale.set(ak);
      c.avatar.position.set(32, CHIP_H / 2);
      c.name.position.set(60, CHIP_H / 2);
      c.score.position.set(w - 12, CHIP_H / 2);
      c.name.visible = w >= 110;
      const target = (this.W - total) / 2 + order.indexOf(p) * (w + gap);
      c.x += (target - c.x) * 0.18;
      // chips rise in with a little overshoot, staggered left to right
      const rise = easeOutBack((vt - c.born - idx * 0.06) / 0.45);
      const hb = vt - c.hitAt;
      const hit = hb < 0.3 ? 1 + 0.12 * Math.sin((hb / 0.3) * Math.PI) : 1;
      c.root.pivot.set(w / 2, CHIP_H / 2);
      c.root.position.set(c.x + w / 2, y + CHIP_H / 2 + (1 - rise) * 80);
      c.root.scale.set(hit);
      const b = vt - c.bumpAt;
      const bump = b < 0.35 ? 1 + 0.35 * Math.sin((b / 0.35) * Math.PI) : 1;
      c.score.scale.set(bump);
      // style writes re-rasterise Text: only on the hot/cold transition
      const hot = b < 0.5;
      if (c.hot !== hot) {
        c.hot = hot;
        c.score.style.fill = hot ? hexToNum(this.palette.glow) : 0xffffff;
      }
      c.root.alpha = p.connected ? 1 : 0.5;
    });
    for (const [id, c] of this.chips) {
      if (live.has(id)) continue;
      c.root.destroy({ children: true });
      this.chips.delete(id);
    }
  }

  private updateBanner(text: string, vt: number): void {
    if (text && text !== this.banner) {
      this.banner = text;
      this.bannerAt = vt;
      this.bannerOutAt = -9;
      this.bannerText.text = text;
      const h = Math.max(96, this.bannerText.height + 36);
      const glow = hexToNum(this.palette.glow);
      this.band.clear()
        .rect(-this.W / 2, -h / 2, this.W, h).fill({ color: 0x0b0b18, alpha: 0.62 })
        .rect(-this.W / 2, -h / 2, this.W, 3).fill({ color: glow, alpha: 0.9 })
        .rect(-this.W / 2, h / 2 - 3, this.W, 3).fill({ color: glow, alpha: 0.9 });
      this.bannerRoot.visible = true;
    } else if (!text && this.banner) {
      this.banner = '';
      this.bannerOutAt = vt;
    }
    if (!this.bannerRoot.visible) return;
    this.bannerRoot.position.set(this.W / 2, this.H * 0.26);
    const kin = (vt - this.bannerAt) / 0.4;
    this.band.scale.set(1, Math.min(1, kin * 1.6));
    this.bannerText.scale.set(kin < 1 ? 1.35 - 0.35 * easeOutBack(kin) : 1);
    this.bannerText.alpha = Math.min(1, kin * 2);
    if (this.bannerOutAt > 0) {
      const k = (vt - this.bannerOutAt) / 0.3;
      this.bannerRoot.alpha = Math.max(0, 1 - k);
      if (k >= 1) {
        this.bannerRoot.visible = false;
        this.bannerRoot.alpha = 1;
        this.bannerOutAt = -9;
      }
    } else this.bannerRoot.alpha = 1;
  }

  /** Screen centre of a player's chip (where big score popups fly); false if none. */
  chipCenter(id: string, out: { x: number; y: number }): boolean {
    const c = this.chips.get(id);
    if (!c || c.w === undefined) return false;
    out.x = c.x + c.w / 2;
    out.y = this.H - SAFE_Y - CHIP_H / 2;
    return true;
  }

  /** A popup reached this player's chip: punch it. */
  bump(id: string, vt: number): void {
    const c = this.chips.get(id);
    if (c) c.hitAt = vt;
  }

  /** Forget the current game's chips and banner (new game). */
  clear(): void {
    for (const c of this.chips.values()) c.root.destroy({ children: true });
    this.chips.clear();
    this.banner = '';
    this.bannerRoot.visible = false;
    this.lastSec = -1;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.chips.clear();
  }
}

/**
 * Truncate a name to fit `room` px without measuring text (measuring a Pixi Text re-rasterises
 * it; doing that in a loop on every score change caused frame hitches). Approximate glyph width.
 */
export function fitName(name: string, room: number, px: number): string {
  const max = Math.max(2, Math.floor(room / px));
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}
