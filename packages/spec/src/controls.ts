import { z } from 'zod';

/** Phone -> TV input sample. `t` is a sender-local timestamp in ms. */
export interface InputFrame {
  t: number;
  axes?: { x: number; y: number };
  buttons?: Record<string, boolean>;
  tilt?: { x: number; y: number };
  swipe?: 'up' | 'down' | 'left' | 'right';
  draw?: string; // png dataURL
  vote?: number;
  text?: string;
}

const xy = z.object({ x: z.number(), y: z.number() });

export const InputFrameSchema: z.ZodType<InputFrame> = z.object({
  t: z.number(),
  axes: xy.optional(),
  buttons: z.record(z.string(), z.boolean()).optional(),
  tilt: xy.optional(),
  swipe: z.enum(['up', 'down', 'left', 'right']).optional(),
  draw: z.string().optional(),
  vote: z.number().int().optional(),
  text: z.string().optional(),
});

export type ControlWidget =
  | { kind: 'joystick'; id: string }
  | { kind: 'button'; id: string; label: string }
  | { kind: 'hold'; id: string; label: string }
  | { kind: 'tilt'; id: string }
  | { kind: 'swipe'; id: string }
  | { kind: 'draw'; id: string; prompt: string }
  | { kind: 'vote'; id: string; options: string[] }
  | { kind: 'text'; id: string; placeholder: string };

const id = z.string().min(1).max(32);

export const ControlWidgetSchema: z.ZodType<ControlWidget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('joystick'), id }),
  z.object({ kind: z.literal('button'), id, label: z.string().min(1).max(20) }),
  z.object({ kind: z.literal('hold'), id, label: z.string().min(1).max(20) }),
  z.object({ kind: z.literal('tilt'), id }),
  z.object({ kind: z.literal('swipe'), id }),
  z.object({ kind: z.literal('draw'), id, prompt: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('vote'), id, options: z.array(z.string().min(1).max(40)).min(2).max(6) }),
  z.object({ kind: z.literal('text'), id, placeholder: z.string().max(60) }),
]);
