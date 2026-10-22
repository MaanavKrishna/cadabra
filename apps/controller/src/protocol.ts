// Screen payloads and replies are defined (and validated) in @cadabra/spec (screens.ts).
// TV → phone: {t:'screen', name, data: ScreenData[name]}.
// Phone → TV: {t:'screen', name: REPLY_SCREEN[reply], data: Reply} built with replyMsg().
import type { Reply } from '@cadabra/spec';

export type { ParsedScreen, PitchOption, Reply, ScreenData, Standing } from '@cadabra/spec';

export type SendReply = (r: Reply) => void;

/** CSS url() for already-validated art (https:/data:image), with quotes and backslashes escaped. */
export function cssUrl(u: string): string {
  return `url("${u.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
}
