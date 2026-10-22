// Screen data the TV sends with {t:'screen', name, data}, and the phone's replies.
// Replies reuse the same envelope: phone → TV {t:'screen', name:<screen>, data:<Reply>}.
// Gameplay input (warmup/play) goes as InputFrames instead.
import { ControlWidgetSchema, type ControlWidget, type ScreenName } from '@cadabra/spec';

export interface Themed { themeVars?: Record<string, string> }

export interface PitchOption { title: string; tagline?: string; art?: string }
export interface Standing { name: string; score: number; avatar?: string; you?: boolean }

export interface ScreenData {
  join: Themed;
  avatar: Themed & { taken?: string[] };
  storm: Themed & { prompt?: string; seconds?: number };
  vote: Themed & { options?: (PitchOption | string)[]; seconds?: number };
  warmup: Themed & { title?: string; howTo?: string; widgets?: ControlWidget[]; seconds?: number };
  play: Themed & { title?: string; widgets?: ControlWidget[] };
  results: Themed & { title?: string; rank?: number; standings?: Standing[] };
  remix: Themed & { prompt?: string };
  tweak: Themed & { message?: string };
  wait: Themed & { message?: string; sub?: string };
  blocked: Themed & { message?: string };
}

export interface Replies {
  avatar: { avatar: string } | { selfie: true };
  storm: { idea: string };
  vote: { vote: number };
  warmup: { ready: true };
  results: { action: 'again' | 'remix' };
  remix: { remix: string };
}

export type Reply = <K extends keyof Replies>(name: K, data: Replies[K]) => void;

/** Keep only valid widgets (max 6); a bad entry never crashes the phone. */
export function parseWidgets(v: unknown): ControlWidget[] {
  if (!Array.isArray(v)) return [];
  const out: ControlWidget[] = [];
  for (const w of v.slice(0, 6)) {
    const r = ControlWidgetSchema.safeParse(w);
    if (r.success) out.push(r.data);
  }
  return out;
}

export const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type AnyScreen = { name: ScreenName; data: Record<string, unknown> };
