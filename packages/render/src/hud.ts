import { Container, Graphics, Sprite, type Text, type Texture } from 'pixi.js';
import type { Player } from '@cadabra/engine';
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
  lead?: boolean;
  w?: number;
  fitKey?: string | undefined;
  hot?: boolean;
}

const SAFE_X = 64; // 5% title-safe of 1280
const SAFE_Y = 36; // 5% of 720
const CHIP_H = 56;

function easeOutBack(t: number): number {
  const k = Math.max(0, Math.min(1, t)) - 1;
  return 1 + k * k * (2.7 * k + 1.7);
}

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

  constructor(private W: number, private H: number) {
    this.timer = label('0:00', 38, 0xffffff, { display: true });
    this.teams = [label('0', 46, TEAM_COLORS[0], { display: true }), label('0', 46, TEAM_COLORS[1], { display: true })];
    this.bannerText = label('', 54, 0xffffff, { display: true, stroke: 8 });
    this.bannerText.style.wordWrap = true;
    this.bannerText.style.wordWrapWidth = W - SAFE_X * 4;
    this.bannerRoot.addChild(this.band, this.bannerText);
    this.bannerRoot.visible = false;
    this.root.addChild(this.timerBg, this.timer, ...this.teams, this.bannerRoot);
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
      const w = 150;
      this.timerBg.clear()
        .roundRect(-w / 2, -30, w, 60, 30).fill({ color: 0x0b0b18, alpha: 0.68 })
        .roundRect(-w / 2, -30, w, 60, 30).stroke({ width: 3, color: finale ? col : hexToNum(this.palette.glow), alpha: 0.85 });
    }
    const pulse = finale ? 1 + 0.18 * Math.max(0, 1 - (vt - this.secAt) / 0.35) : 1;
    this.timerBg.position.set(this.W / 2, SAFE_Y + 30);
    this.timer.position.set(this.W / 2, SAFE_Y + 30);
    this.timer.scale.set(pulse);
    this.timerBg.scale.set(pulse);
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
    const w = Math.min(210, (this.W - SAFE_X * 2 - gap * (n - 1)) / n);
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
        const name = label('', 19, 0xffffff, { weight: '700', stroke: 3 });
        name.anchor.set(0, 0.5);
        const score = label('0', 28, 0xffffff, { display: true });
        score.anchor.set(1, 0.5);
        root.addChild(bg, avatar, name, score);
        this.root.addChild(root);
        c = { id: p.id, root, bg, avatar, name, score, x: this.W / 2, shown: p.score, bumpAt: -9 };
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
        c.fitKey = undefined;
      }
      // fit the name between avatar and score (re-measured only when something changed)
      const fitKey = `${p.name}|${w}|${c.score.text}`;
      if (c.fitKey !== fitKey) {
        c.fitKey = fitKey;
        const room = w - 54 - c.score.width - 16;
        let nm = p.name;
        c.name.text = nm;
        while (nm.length > 1 && c.name.width > room) {
          nm = nm.slice(0, -1);
          c.name.text = `${nm.trimEnd()}…`;
        }
      }
      const tex = avatarTex(p);
      if (c.avatar.texture !== tex) c.avatar.texture = tex;
      const ak = 40 / Math.max(1, tex.width, tex.height);
      c.avatar.scale.set(ak);
      c.avatar.position.set(30, CHIP_H / 2);
      c.name.position.set(54, CHIP_H / 2);
      c.score.position.set(w - 12, CHIP_H / 2);
      c.name.visible = w >= 110;
      const target = (this.W - total) / 2 + order.indexOf(p) * (w + gap);
      c.x += (target - c.x) * 0.18;
      c.root.position.set(c.x, y);
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
      const h = Math.max(120, this.bannerText.height + 48);
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
    this.bannerRoot.position.set(this.W / 2, this.H * 0.42);
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

  destroy(): void {
    this.root.destroy({ children: true });
    this.chips.clear();
  }
}
