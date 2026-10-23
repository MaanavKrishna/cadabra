import { useState } from 'preact/hooks';
import { TWEAK_CHIPS, TWEAK_CHIP_LABELS, TWEAK_TEXT_MAX, type TweakChip } from '@cadabra/spec';
import { avatarUrl } from '../avatars';
import type { ScreenData, SendReply } from '../protocol';
import { Btn, Countdown, Eyebrow, Mark } from '../ui/kit';
import { TextSend } from '../ui/text-send';

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

export function ResultsScreen({ data, reply }: { data: ScreenData['results']; reply: SendReply }) {
  const rank = data.rank;
  const standings = (data.standings ?? []).slice(0, 4);
  const [sent, setSent] = useState<string>();
  return (
    <section class="screen screen-results" data-screen="results">
      <div class="result-hero">
        <Eyebrow>{data.title ?? 'Results'}</Eyebrow>
        {rank !== undefined ? (
          <>
            <div class={`rank rank-${rank}`}>{ordinal(rank)}</div>
            <h1 class="display sm center">{rank === 1 ? <>You <em>won!</em></> : rank === 2 ? 'So close!' : 'Good game!'}</h1>
          </>
        ) : (
          <h1 class="display sm center">Good <em>game!</em></h1>
        )}
      </div>
      {standings.length > 0 && (
        <ol class="standings">
          {standings.map((s, i) => {
            const url = avatarUrl(s.avatar);
            return (
              <li key={i} class={`standing ${s.you ? 'is-you' : ''}`} style={{ '--i': i }}>
                <span class="st-pos">{i + 1}</span>
                <span class="st-av">{url ? <img src={url} alt="" /> : <Mark size={28} />}</span>
                <span class="st-name">{s.name}</span>
                <span class="st-score">{s.score}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div class="dock two">
        <Btn variant="glass" disabled={!!sent} onClick={() => { setSent('remix'); reply({ reply: 'results.pick', action: 'remix' }); }}>Tweak it</Btn>
        <Btn disabled={!!sent} onClick={() => { setSent('again'); reply({ reply: 'results.pick', action: 'again' }); }}>Play again</Btn>
      </div>
      {sent && <p class="hint center">{sent === 'remix' ? 'Opening the tweak menu on the TV…' : 'Sent! The TV will decide with everyone.'}</p>}
    </section>
  );
}

export function RemixScreen({ data, reply }: { data: ScreenData['remix']; reply: SendReply }) {
  const [sent, setSent] = useState<string[]>([]);
  const send = (remix: string) => { reply({ reply: 'remix.add', remix }); setSent((l) => [remix, ...l].slice(0, 5)); };
  return (
    <section class="screen screen-remix" data-screen="remix">
      <div class="screen-head">
        <Eyebrow>Remix</Eyebrow>
        <h1 class="display sm">{data.prompt ?? <>How should we <em>remix</em> it?</>}</h1>
      </div>
      <TextSend placeholder="e.g. all ice" onSend={send} />
      <div class="spark-grid">
        {['Faster!', 'Low gravity', 'Giant mode', 'Chaos'].map((s) => <Btn key={s} variant="glass" onClick={() => send(s)}>{s}</Btn>)}
      </div>
      <ul class="idea-list">{sent.map((s, i) => <li key={`${sent.length - i}`} class="idea">{s}</li>)}</ul>
    </section>
  );
}

const CHIP_ICON: Record<TweakChip, string> = {
  'low-gravity': 'M32 8a24 24 0 1 0 0 48a18 18 0 1 1 0-48z',
  faster: 'M8 20h22M4 32h26M8 44h22M34 14l20 18-20 18z',
  'bigger-arena': 'M10 24V10h14M54 24V10H40M10 40v14h14M54 40v14H40',
  bouncier: 'M8 52h48M20 40a8 8 0 1 0 16 0a8 8 0 1 0-16 0M30 28c4-10 10-16 18-18',
  'more-chaos': 'M32 6l6 18 18-6-12 14 14 10-18 2 2 18-10-14-10 14 2-18-18-2 14-10L8 18l18 6z',
  'harder-for-leader': 'M10 46l10-24 12 14 12-26 10 36zM10 54h44',
};

/**
 * R2 Tweak: between rounds the room changes the rules. `phase` ask: chips + free text (each tap is
 * one request; the TV keeps the first three); rebuilding: a calm wait; done: what changed.
 */
export function TweakScreen({ data, reply }: { data: ScreenData['tweak']; reply: SendReply }) {
  const [sent, setSent] = useState<string[]>([]);
  const phase = data.phase ?? (data.summary ? 'done' : 'rebuilding');
  const chips = (data.chips?.length ? data.chips : [...TWEAK_CHIPS]) as TweakChip[];
  const chip = (c: TweakChip) => {
    if (sent.includes(TWEAK_CHIP_LABELS[c])) return;
    reply({ reply: 'tweak.ask', chip: c });
    setSent((l) => [TWEAK_CHIP_LABELS[c], ...l].slice(0, 6));
  };
  const text = (t: string) => { reply({ reply: 'tweak.ask', text: t }); setSent((l) => [t, ...l].slice(0, 6)); };

  if (phase === 'ask') {
    return (
      <section class="screen screen-tweak" data-screen="tweak" data-phase="ask">
        <div class="screen-head row">
          <div>
            <Eyebrow>{data.message ? `Tweak · ${data.message}` : 'Tweak'}</Eyebrow>
            <h1 class="display sm">Change the <em>rules</em></h1>
          </div>
          <Countdown seconds={data.seconds} />
        </div>
        <div class="tweak-chips">
          {chips.map((c) => (
            <button key={c} type="button" class={`tweak-chip ${sent.includes(TWEAK_CHIP_LABELS[c]) ? 'is-on' : ''}`} onClick={() => { navigator.vibrate?.(15); chip(c); }}>
              <svg viewBox="0 0 64 64" aria-hidden="true"><path d={CHIP_ICON[c]} /></svg>
              <span>{TWEAK_CHIP_LABELS[c]}</span>
            </button>
          ))}
        </div>
        <TextSend placeholder="Or type anything: giant players…" onSend={text} max={TWEAK_TEXT_MAX} />
        <p class="hint">The TV takes the first three ideas from the room.</p>
        <ul class="idea-list">{sent.map((s, i) => <li key={`${sent.length - i}`} class="idea">{s}</li>)}</ul>
      </section>
    );
  }
  if (phase === 'done') {
    return (
      <section class="screen screen-tweak screen-wait" data-screen="tweak" data-phase="done">
        <Eyebrow>What changed</Eyebrow>
        <h1 class="display sm center">{data.summary ?? 'Same rules, round two!'}</h1>
        {(data.changes?.length ?? 0) > 0 && (
          <div class="tweak-tags">{data.changes!.map((c) => <span key={c} class="tweak-tag">{c}</span>)}</div>
        )}
        <p class="lede center">Get your thumbs ready. The new version starts on the TV.</p>
      </section>
    );
  }
  return (
    <section class="screen screen-tweak screen-wait" data-screen="tweak" data-phase="rebuilding">
      <div class="orb" aria-hidden="true"><div class="orb-ring" /><div class="orb-ring r2" /><Mark size={72} /></div>
      <h1 class="display sm center">Rebuilding the <em>game</em></h1>
      <p class="lede center">{data.message ?? 'The AI is patching the rules and the bots are trying them out.'}</p>
      <div class="build"><div class="build-bar is-busy"><i /></div></div>
    </section>
  );
}
