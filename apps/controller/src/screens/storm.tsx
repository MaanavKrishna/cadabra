import { useState } from 'preact/hooks';
import { cssUrl, type PitchOption, type ScreenData, type SendReply } from '../protocol';
import { Btn, Countdown, Eyebrow } from '../ui/kit';
import { TextSend } from '../ui/text-send';

const SPARKS = ['Lava floor', 'Space cats', 'Ninja kitchen', 'Robot zoo'];

export function StormScreen({ data, reply }: { data: ScreenData['storm']; reply: SendReply }) {
  const [ideas, setIdeas] = useState<string[]>([]);
  const send = (idea: string) => { reply({ reply: 'storm.add', idea }); setIdeas((l) => [idea, ...l].slice(0, 8)); };
  return (
    <section class="screen screen-storm" data-screen="storm">
      <div class="screen-head row">
        <div>
          <Eyebrow>Idea Storm</Eyebrow>
          <h1 class="display sm">{data.prompt ?? <>What should we <em>play?</em></>}</h1>
        </div>
        <Countdown seconds={data.seconds} />
      </div>
      <TextSend placeholder="Throw in an idea…" onSend={send} />
      <div class="spark-grid">
        {SPARKS.map((s) => <Btn key={s} variant="glass" onClick={() => send(s)}>{s}</Btn>)}
      </div>
      <ul class="idea-list" aria-live="polite">
        {ideas.map((i, n) => <li key={`${ideas.length - n}`} class="idea">{i}</li>)}
      </ul>
    </section>
  );
}

const opt = (o: PitchOption): Exclude<PitchOption, string> => (typeof o === 'string' ? { title: o } : o);

export function VoteScreen({ data, reply }: { data: ScreenData['vote']; reply: SendReply }) {
  const [pick, setPick] = useState<number>();
  const options = data.options.map(opt);
  return (
    <section class="screen screen-vote" data-screen="vote">
      <div class="screen-head row">
        <div>
          <Eyebrow>Vote</Eyebrow>
          <h1 class="display sm">Pick the <em>next game</em></h1>
        </div>
        <Countdown seconds={data.seconds} />
      </div>
      <div class="pitch-list" role="radiogroup">
        {options.map((o, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={pick === i}
            class={`pitch ${pick === i ? 'is-on' : ''}`}
            style={o.art ? { '--art': cssUrl(o.art) } : undefined}
            onClick={() => { setPick(i); navigator.vibrate?.(15); reply({ reply: 'vote.cast', vote: i }); }}
          >
            <span class="pitch-art" aria-hidden="true" />
            <span class="pitch-badge">{String.fromCharCode(65 + i)}</span>
            <span class="pitch-text">
              <span class="pitch-title">{o.title}</span>
              {o.tagline && <span class="pitch-tag">{o.tagline}</span>}
            </span>
            <span class="pitch-check" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p class="hint center">{pick === undefined ? 'Tap a card. You can change your mind.' : 'Vote in! Tap another to switch.'}</p>
    </section>
  );
}
