import { useEffect, useState } from 'preact/hooks';
import type { ControlWidget, InputFrame } from '@cadabra/spec';
import type { ScreenData, SendReply } from '../protocol';
import { holdWakeLock } from '../wakelock';
import { Btn, Countdown, Eyebrow, Pad } from '../ui/kit';

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

export function PlayScreen({ data, onFrame }: { data: ScreenData['play']; onFrame(f: InputFrame): void }) {
  useWakeLock();
  const widgets = data.widgets;
  return (
    <section class="screen screen-play" data-screen="play">
      <div class="play-bar slim">
        <div class="play-title">{data.title ?? ''}</div>
        <span class="live-dot">Live</span>
      </div>
      {widgets.length ? <Pad widgets={widgets} onFrame={onFrame} /> : <NoControls />}
    </section>
  );
}
