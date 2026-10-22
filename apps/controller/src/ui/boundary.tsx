import { Component, type ComponentChildren } from 'preact';

interface Props { resetKey?: unknown; fallback: ComponentChildren; children: ComponentChildren }

/** A render error inside a screen shows `fallback` until `resetKey` changes (the next TV screen). */
export class ScreenBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error('[controller] screen crashed', err); }
  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
