import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { Context } from 'aws-lambda';
import type { BackendToClient } from '@cadabra/spec';
import { claimForgeRun, type ForgeEvent } from '../forge-room';
import { saveUnplayed } from '../arcade';
import { FORGE_BUDGETS, runForge, type ForgeJob } from '../forge';

/**
 * Forge Lambda (invoked asynchronously by the ws handler on forge.pitch). Streams pitches,
 * progress and ready specs to the room's TV through the API Gateway management API.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = () => process.env.TABLE_NAME!;
/** Finish this long before the Lambda timeout. */
const SAFETY_MS = 4000;
const log = (...a: unknown[]) => console.log('[forge]', ...a);

export async function handler(ev: ForgeEvent, context?: Pick<Context, 'getRemainingTimeInMillis' | 'awsRequestId'>) {
  const t0 = Date.now();
  const claim = await claimForgeRun({ ddb, table: TABLE() }, ev, context?.awsRequestId ?? `local-${t0}`, t0, FORGE_BUDGETS.pitchMs);
  if (claim !== 'ok') {
    log(JSON.stringify({ code: ev.code, forgeId: ev.forgeId, skipped: claim, ageMs: t0 - ev.startedAt }));
    return { skipped: claim };
  }
  const remaining = context?.getRemainingTimeInMillis?.() ?? 120_000;
  const hardStop = t0 + remaining - SAFETY_MS;
  const api = new ApiGatewayManagementApiClient({ endpoint: ev.endpoint });
  const pk = `ROOM#${ev.code}`;

  const live = ((await ddb.send(new QueryCommand({
    TableName: TABLE(),
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': pk, ':p': 'PLAYER#' },
  }))).Items ?? []).filter((p) => typeof p.conn === 'string');
  // Names come from the TV (it knows bots and order); connections from the room.
  const named = ev.players.map((p) => (typeof p === 'string' ? { name: p } : { id: p.id, name: p.name }));
  const players: ForgeJob['players'] = named.map((p) => {
    const m = live.find((l) => ('id' in p && l.playerId === p.id) || l.name === p.name);
    return { id: m?.playerId ?? ('id' in p ? p.id : undefined), name: p.name, conn: m?.conn };
  });
  for (const l of live) {
    if (!players.some((p) => p.conn === l.conn)) players.push({ id: l.playerId, name: l.name, conn: l.conn });
  }

  const job: ForgeJob = {
    code: ev.code, forgeId: ev.forgeId, startedAt: ev.startedAt, hardStop,
    ingredients: ev.ingredients, players, settings: ev.settings,
  };
  const result = await runForge(job, {
    post: async (conn: string, msg: BackendToClient) => {
      try {
        await api.send(new PostToConnectionCommand({ ConnectionId: conn, Data: JSON.stringify(msg) }));
        return true;
      } catch (e) {
        if (e instanceof GoneException || (e as { name?: string })?.name === 'GoneException') return false;
        log('post failed', (e as Error)?.name);
        return true;
      }
    },
    room: async () => {
      const meta = (await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk, sk: 'META' }, ConsistentRead: true }))).Item;
      if (!meta) return {};
      const mine = meta.forgeId === ev.forgeId;
      return {
        tvConn: typeof meta.tvConn === 'string' ? meta.tvConn : undefined,
        winner: mine && typeof meta.forgeWinner === 'string' ? meta.forgeWinner : undefined,
        voteAt: mine && typeof meta.forgeVoteAt === 'number' ? meta.forgeVoteAt : undefined,
      };
    },
    setPitchIds: async (ids) => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE(), Key: { pk, sk: 'META' }, UpdateExpression: 'SET forgePitchIds = :ids',
        ConditionExpression: 'forgeId = :f', ExpressionAttributeValues: { ':ids': ids, ':f': ev.forgeId },
      }));
    },
    done: async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE(), Key: { pk, sk: 'META' }, UpdateExpression: 'REMOVE forgeBusyUntil',
        ConditionExpression: 'forgeId = :f', ExpressionAttributeValues: { ':f': ev.forgeId },
      })).catch(() => {});
    },
    onLoserReady: async (pitch, spec) => {
      // Losing pitches become unplayed Arcade entries for the room's household.
      const meta = (await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk, sk: 'META' } }))).Item;
      if (typeof meta?.household !== 'string') return;
      const saved = await saveUnplayed({ ddb, table: TABLE(), now: () => Math.floor(Date.now() / 1000) }, meta.household, spec);
      log('loser saved to arcade', pitch.id, spec.id, saved);
    },
    log,
  });
  log(JSON.stringify({ code: ev.code, forgeId: ev.forgeId, queuedMs: t0 - ev.startedAt, totalMs: Date.now() - ev.startedAt, ...result }));
  return result;
}
