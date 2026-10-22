import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

process.env.TABLE_NAME = 'T';
process.env.AWS_REGION = 'ap-south-1';
const { handler } = await import('../src/handlers/ws');
const api = mockClient(ApiGatewayManagementApiClient);

const ev = (routeKey: string, body?: string) => ({
  requestContext: { routeKey, connectionId: 'c1', domainName: 'x.execute-api.ap-south-1.amazonaws.com', stage: 'prod' },
  body,
}) as any;

describe('ws handler', () => {
  beforeEach(() => { api.reset(); api.on(PostToConnectionCommand).resolves({}); });

  test.each([['not json'], ['{"t":"nope"}'], [undefined]])('bad input %s -> room.badRequest, no throw', async (body) => {
    const r = await handler(ev('$default', body));
    expect(r.statusCode).toBe(200);
    const call = api.commandCalls(PostToConnectionCommand)[0]!;
    expect(JSON.parse(call.args[0].input.Data as string)).toMatchObject({ t: 'error', code: 'room.badRequest' });
  });

  test('$connect is ok', async () => {
    expect((await handler(ev('$connect'))).statusCode).toBe(200);
  });
});
