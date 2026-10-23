# AI designer and Tweak loop

The AI in Cadabra is a game designer, not a programmer. It produces a `GameSpec`: data that composes blocks from the [game kit](game-kit.html), a physics world and a look. The TV's engine runs that data. Nothing the model writes is ever executed.

## Why specs, not code

- **It can check its own work.** The engine is seeded and deterministic, so a full round with four bots runs in milliseconds inside Lambda. That makes a playtest cheap enough to run on every answer.
- **It can't ship a broken game.** A spec only reaches the TV after bots finish a full round with it.
- **It stays fast.** Composing tested blocks is a small job, so a typical design is one model reply.

## The tools

The designer runs in the `ForgeFn` Lambda (`apps/backend/src/ai/designer.ts` and `tools.ts`). Its system prompt lists the block kit, the four looks, the physics world schema (generated from the zod `.describe()` text) and a few fun rules: a clear goal, risk and reward, a comeback, physical comedy. Design and tweak jobs share the system prompt and tools, so they hit the same prompt cache.

| Tool | What it does |
|---|---|
| `list_blocks` | The kit: block id, summary, controls, arena kinds |
| `get_block_schema` | One block's params as JSON Schema with defaults, plus the controller widgets it needs |
| `validate_spec` | Schema check, returns `{ok, errors}` |
| `playtest_spec` | Validates, then plays a full round with 4 bots (skills 0.4 to 0.9). Returns `{ok, reasons, stats}` |
| `patch_spec` | RFC 6902 JSON Patch on the latest spec. Tweak jobs also pass a `summary` and `changes` tags |
| `submit_spec` | Kept for compatibility. A passing playtest of the latest spec already counts as the submission |

## The playtest gate

`playtest()` in `packages/engine/src/playtest.ts` rejects a spec when:

- the schema, block params, arena kind or controller widgets are wrong, for example a duplicate widget id or a block without the widget it needs;
- the round throws, is too heavy to simulate, or puts too many entities on screen;
- fewer than 2 bots scored (the message names the blocks that penalised or eliminated them);
- a timed round ended before most of its duration.

Each reason says what to change, such as "only 1 of 4 bots scored; the hazard penalised them", so the model fixes the spec in its next tool call. The same gate checks every Tweak result and every local chip preset, at the real seat count.

## The Forge, step by step

1. The TV sends `forge.pitch` with the Idea Storm ingredients, the seats and the settings. `WsFn` takes a forge lock with a conditional DynamoDB write and invokes `ForgeFn` asynchronously.
2. Guardrails screens the ingredients. Blocked ones are dropped and that player's phone shows a "blocked" screen.
3. Claude Haiku 5.5 writes three pitches, each with a title, a hook, blocks and a look. Budget: 8 s, else fallback pitches. Measured: about 6 s.
4. All three designs start in parallel as soon as the pitches go out, with Claude Sonnet 5.5. Progress streams to the TV as `forge.progress`.
5. The room votes. The winner is usually ready 4 to 7 s after the vote.
6. If the winner is not ready 25 s after the vote, a built-in game is reskinned from the pitch (title, hook, look, palette) and sent as `forge.ready {fallback: true}`. The room never waits on the AI.
7. Losing pitches that finish are saved to the household Arcade.

## The Tweak loop

After a round, phones get a 10 s window with three request slots. Each phone can tap a chip or type up to 80 characters.

**Chips:** Low gravity, Faster, Bigger arena, Bouncier, More chaos, Harder for leader.

1. The TV sends `forge.tweak` with the current spec, the requests, the seat count and the mode.
2. Typed text goes through Guardrails, which fails closed.
3. The model gets a tweak brief plus a hint from the matching chip preset, and answers with `patch_spec` and `playtest_spec` in one reply. One repair reply is allowed.
4. The first passing patched spec wins. The TV shows a "What changed" card (for example Gravity x0.4, Bounce up, Chaos up) and replays.

Live timings over 16 runs: p50 5.7 s, p90 8.5 s.

> [!TIP]
> **The room never waits.** If the AI misses its deadline (about 12 s), deterministic chip presets run instead, first at full strength and then at half strength, each playtest-checked. The hard cap is 15 s. The TV keeps its own copy of the presets for offline play, backend errors, or no answer in 16.5 s.

**Remix** uses the same flow from the Home row or the Arcade, and saves the result as a new Arcade entry. A changed spec gets a new id with `origin.parentId`, so the Arcade keeps the lineage.

## Bedrock first, Anthropic API as fallback

`apps/backend/src/ai/bedrock.ts` exposes one `converse()` for two roles: `designer` (Sonnet 5.5) and `fast` (Haiku 5.5). Each role has an ordered chain of model ids and inference profiles (`anthropic.`, `in.`, `global.`).

- `ValidationException`, `AccessDeniedException` and `ResourceNotFoundException` mean "this id is unusable here", and the next id is tried.
- If the whole chain fails with an access, not-found or throttling error, `anthropic.ts` sends the same Converse-shaped request to the Anthropic Messages API and translates tool use both ways. The key lives in Secrets Manager.
- The choice is remembered for 2 minutes after throttling and 10 minutes after access errors. Then Bedrock is tried first again, so the system moves back to Bedrock on its own once quotas arrive.
- The Bedrock client uses `maxAttempts: 1`. A throttled probe took 1.5 s with SDK retries and 0.17 s without, and the pitch and tweak budgets cannot afford the difference.

> [!NOTE]
> On the hackathon account every Bedrock Claude quota was 0, so the live game runs on the fallback. The [friction log](friction-log.html) has the full story.

## Guardrails

- One guardrail, `cadabra-family-safe`, deployed by CDK and called with `ApplyGuardrail`. It covers hate, insults, sexual content, violence, misconduct, prompt attacks and a profanity word list.
- It screens Idea Storm ingredients, typed tweaks, pitches, tweak summaries and change tags, host captions and the roast.
- It runs on AWS whichever model provider answers.
- With family-safe on, any intervention blocks and screening fails closed. With it off, only HATE and SEXUAL at HIGH confidence block.
