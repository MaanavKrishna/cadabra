import {
  ApiGatewayManagementApiClient, PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { runHostMsg, type HostEvent } from '../host-room';

/** Host Lambda: host lines, roast, Polly voice and AI judgements. Invoked async by the ws handler; replies to the TV directly. */
export async function handler(ev: HostEvent) {
  const t0 = Date.now();
  const reply = await runHostMsg(ev.msg);
  if (!reply) return { ok: false };
  const api = new ApiGatewayManagementApiClient({ endpoint: ev.endpoint });
  try {
    await api.send(new PostToConnectionCommand({ ConnectionId: ev.conn, Data: JSON.stringify(reply) }));
  } catch (e) {
    console.warn('[host] post failed', (e as Error)?.name); // TV gone: nothing to do
    return { ok: false };
  }
  console.log('[host]', JSON.stringify({ t: ev.msg.t, ms: Date.now() - t0 }));
  return { ok: true };
}
