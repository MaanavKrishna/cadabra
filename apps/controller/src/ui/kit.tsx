import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic, mountController, ripple } from '@cadabra/couchpad';
import type { ControlWidget, InputFrame } from '@cadabra/spec';

/** Original Cadabra mark: a beam of light falling from a four-point spark. */
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 4 L37 27 L60 32 L37 37 L32 60 L27 37 L4 32 L27 27 Z" fill="#fff" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div class="wordmark">
      <Mark />
      <span>Cadabra</span>
    </div>
  );
}

type BtnProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'glass';
  children: ComponentChildren;
  type?: 'button' | 'submit';
  disabled?: boolean;
};

/** Big glossy button: 72 px+, press scale, ripple and a 15 ms haptic pulse. */
export function Btn({ variant = 'primary', class: cls, children, onPointerDown, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      class={`gbtn gbtn-${variant} ${cls ?? ''}`}
      onPointerDown={(e) => {
        haptic(15);
        ripple(e.currentTarget as HTMLElement, e as unknown as PointerEvent);
        onPointerDown?.(e as any);
      }}
    >
      <span class="gbtn-label">{children}</span>
    </button>
  );
}

export function useCountdown(seconds?: number): number | undefined {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (!seconds || seconds <= 0) { setLeft(undefined); return; }
    const end = Date.now() + seconds * 1000;
    setLeft(seconds);
    const id = setInterval(() => {
      const l = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(l);
      if (l <= 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [seconds]);
  return left;
}

export function Countdown({ seconds }: { seconds?: number }) {
  const left = useCountdown(seconds);
  if (left === undefined || !seconds) return null;
  const C = 2 * Math.PI * 22;
  return (
    <div class={`countdown ${left <= 5 ? 'is-low' : ''}`} aria-label={`${left} seconds left`}>
      <svg viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="22" class="cd-track" />
        <circle cx="26" cy="26" r="22" class="cd-fill" stroke-dasharray={C} stroke-dashoffset={C * (1 - left / seconds)} />
      </svg>
      <span>{left}</span>
    </div>
  );
}

export function Eyebrow({ children }: { children: ComponentChildren }) {
  return <div class="eyebrow">{children}</div>;
}

/** Hosts a couchpad controller for the given widgets; frames go to `onFrame`. */
export function Pad({ widgets, onFrame }: { widgets: ControlWidget[]; onFrame: (f: InputFrame) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onFrame);
  cb.current = onFrame;
  const key = JSON.stringify(widgets);
  useEffect(() => {
    if (!ref.current) return;
    return mountController(ref.current, widgets, (f) => cb.current(f));
  }, [key]);
  return <div class="pad" ref={ref} />;
}
