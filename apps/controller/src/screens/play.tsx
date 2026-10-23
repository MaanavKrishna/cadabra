import { useEffect, useState } from 'preact/hooks';
import type { ControlWidget, InputFrame } from '@cadabra/spec';
import type { ScreenData, SendReply } from '../protocol';
import { holdWakeLock } from '../wakelock';
import { Btn, Countdown, Eyebrow, Pad } from '../ui/kit';
import { hintsFor, relabel, type Hint, type HintIcon } from '../hints';

function useWakeLock() { useEffect(() => holdWakeLock(), []); }

function NoControls() {
  return <div class="no-controls"><p class="lede center">Watch the TV. Your controls appear here when it's your turn.</p></div>;
}

export function WarmupScreen({ data, reply, onFrame }: { data: ScreenData['warmup']; reply: SendReply; onFrame(f: InputFrame): void }) {
  useWakeLock();
  const widgets: ControlWidget[] = data.widgets;
  const [ready, setReady] = useState(false);
  return (
    <section class="screen screen-play screen-warmup" data-screen="warmup">
      <div class="play-bar">
        <div>
          <Eyebrow>Warm-up</Eyebrow>
          <div class="play-title">{data.title ?? 'Try your controls'}</div>
        </div>
        <Countdown seconds={data.seconds} />
      </div>
      {data.howTo && <p class="howto">{data.howTo}</p>}
      {widgets.length ? <Pad widgets={widgets} onFrame={onFrame} /> : <NoControls />}
      <div class="play-dock">
        <Btn variant={ready ? 'glass' : 'accent'} class="wide" disabled={ready} onClick={() => { setReady(true); reply({ reply: 'warmup.ready' }); }}>
          {ready ? 'Ready ✓' : "I'm ready"}
        </Btn>
      </div>
    </section>
  );
}

const ICON_PATHS: Record<HintIcon, string> = {
  stick: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zm2 5.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7z',
  quiet: 'M5 10v4h3l4 4V6L8 10H5zm12.5 2l2.5-2.5-1-1L16.5 11 14 8.5l-1 1 2.5 2.5L13 14.5l1 1 2.5-2.5 2.5 2.5 1-1z',
  dash: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  pull: 'M3 11h18v2H3zM6 7l-4 5 4 5V7zm12 0v10l4-5-4-5z',
  grab: 'M7 11V5a1.5 1.5 0 0 1 3 0v5h1V3.5a1.5 1.5 0 0 1 3 0V10h1V5a1.5 1.5 0 0 1 3 0v8c0 4-2.5 8-7 8-3 0-5-2-6.5-4.5L4 12.5a1.5 1.5 0 0 1 2.5-1.5z',
  tap: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16zm0 4a4 4 0 1 1 0 8a4 4 0 0 1 0-8z',
  tilt: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v13h8V5z',
  swipe: 'M4 12h13l-4-4 1.5-1.5L21 13l-6.5 6.5L13 18l4-4H4z',
};

function HintIconSvg({ icon }: { icon: HintIcon }) {
  return <svg class="hint-ic" viewBox="0 0 24 24" aria-hidden="true"><path d={ICON_PATHS[icon]} fill="currentColor" fill-rule="evenodd" /></svg>;
}

/** What each control does in this game (TIPTOE = quiet, DASH = shove, PULL = on the beat). */
export function HintStrip({ hints }: { hints: Hint[] }) {
  if (!hints.length) return null;
  return (
    <div class="hints" data-hints>
      {hints.map((h) => (
        <div key={h.id} class={`hint-chip hint-${h.icon}`}>
          <HintIconSvg icon={h.icon} />
          <span><b>{h.label}</b><small>{h.sub}</small></span>
        </div>
      ))}
    </div>
  );
}

export function PlayScreen({ data, onFrame }: { data: ScreenData['play']; onFrame(f: InputFrame): void }) {
  useWakeLock();
  const hints = hintsFor(data.widgets, data.title ?? '');
  const widgets = relabel(data.widgets, hints);
  return (
    <section class="screen screen-play" data-screen="play">
      <div class="play-bar slim">
        <div class="play-title">{data.title ?? ''}</div>
        <span class="live-dot">Live</span>
      </div>
      <HintStrip hints={hints} />
      {widgets.length ? <Pad widgets={widgets} onFrame={onFrame} /> : <NoControls />}
    </section>
  );
}
