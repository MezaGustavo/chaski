// Demo director: the split stage drives each phone through postMessage, and the
// app executes the same code paths a user's taps would (real devnet txs).
export const bus = new EventTarget();
export type Cue = { demo: 'onboard' | 'open' | 'type' | 'pay-request'; name?: string; lang?: string; text?: string };

window.addEventListener('message', (e: MessageEvent<Cue>) => {
  if (e.origin === location.origin && e.data?.demo) bus.dispatchEvent(new CustomEvent(e.data.demo, { detail: e.data }));
});

export function onCue(name: Cue['demo'], fn: (c: Cue) => void) {
  const h = (e: Event) => fn((e as CustomEvent<Cue>).detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
}
