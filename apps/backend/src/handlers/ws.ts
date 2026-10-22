import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { ClientToBackendSchema } from '@cadabra/spec';
import { createRoom, disconnect, forward, joinRoom, resumeRoom, type Ctx } from '../rooms';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ok = (body = ''): APIGatewayProxyResult => ({ statusCode: 200, body });

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult> {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  if (routeKey === '$connect') return ok();

  const api = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  const ctx: Ctx = {
    ddb,
    table: process.env.TABLE_NAME!,
    now: () => Math.floor(Date.now() / 1000),
    send: async (conn, msg) => {
      try {
        await api.send(new PostToConnectionCommand({ ConnectionId: conn, Data: JSON.stringify(msg) }));
        return true;
      } catch (e) {
        if (e instanceof GoneException || (e as any)?.name === 'GoneException') return false;
        throw e;
      }
    },
  };

  if (routeKey === '$disconnect') {
    await disconnect(ctx, connectionId);
    return ok();
  }

  // $default: JSON message from client (a plain "health" body doubles as a smoke test)
  let raw: unknown;
  try { raw = JSON.parse(event.body ?? ''); } catch { raw = undefined; }
  const parsed = ClientToBackendSchema.safeParse(raw);
  if (!parsed.success) {
    try {
      await ctx.send(connectionId, { t: 'error', code: 'room.badRequest', message: 'invalid message' });
    } catch { /* best-effort */ }
    return ok();
  }
  const m = parsed.data;
  switch (m.t) {
    case 'room.create': await createRoom(ctx, connectionId, m.household); break;
    case 'room.resume': await resumeRoom(ctx, connectionId, m); break;
    case 'room.join': await joinRoom(ctx, connectionId, m); break;
    case 'signal':
    case 'relay': await forward(ctx, connectionId, m); break;
    case 'ping': await ctx.send(connectionId, { t: 'pong' }); break;
  }
  return ok();
}
