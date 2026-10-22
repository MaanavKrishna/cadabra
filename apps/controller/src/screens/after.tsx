import { useState } from 'preact/hooks';
import { avatarUrl } from '../avatars';
import type { ScreenData, SendReply } from '../protocol';
import { Btn, Eyebrow, Mark } from '../ui/kit';
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
        <Btn variant="glass" disabled={!!sent} onClick={() => { setSent('remix'); reply({ reply: 'results.pick', action: 'remix' }); }}>Remix it</Btn>
        <Btn disabled={!!sent} onClick={() => { setSent('again'); reply({ reply: 'results.pick', action: 'again' }); }}>Play again</Btn>
      </div>
      {sent && <p class="hint center">Sent! The TV will decide with everyone.</p>}
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

export function TweakScreen({ data }: { data: ScreenData['tweak'] }) {
  return (
    <section class="screen screen-tweak screen-wait" data-screen="tweak">
      <div class="orb" aria-hidden="true"><div class="orb-ring" /><div class="orb-ring r2" /><Mark size={72} /></div>
      <h1 class="display sm center">Tweaking the <em>game</em></h1>
      <p class="lede center">{data.message ?? 'The host is fine-tuning things on the TV. Get ready!'}</p>
    </section>
  );
}
