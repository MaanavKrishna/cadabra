import { z } from 'zod';

export type HostPersonality = 'cheeky' | 'hype' | 'calm';

export interface RoomSettings {
  familySafe: boolean;
  bots: boolean;
  hostVoice: boolean;
  roundSec: number;
  rounds: number;
  hostPersonality: HostPersonality;
}

export const RoomSettingsSchema: z.ZodType<RoomSettings> = z.object({
  familySafe: z.boolean(),
  bots: z.boolean(),
  hostVoice: z.boolean(),
  roundSec: z.number().int().min(60).max(120),
  rounds: z.number().int().min(1).max(10),
  hostPersonality: z.enum(['cheeky', 'hype', 'calm']),
});

export const DEFAULT_SETTINGS: RoomSettings = {
  familySafe: true,
  bots: true,
  hostVoice: true,
  roundSec: 90,
  rounds: 3,
  hostPersonality: 'cheeky',
};
