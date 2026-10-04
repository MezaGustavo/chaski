import { useEffect, useRef, useState } from 'react';
import { RELAY_HTTP } from './solana';
import type { Cue } from './director';

// Demo stage: two phones, two wallets, one screen — for live demos and recording.
const params = new URLSearchParams(location.search);
const users = params.get('split')?.split(',').filter(Boolean) || [];
const [a, b] = users.length === 2 ? users : ['gustavo', 'laura'];
const open = params.has('open');         // start both phones inside their chat
const autoplay = params.has('autoplay'); // run the scripted scenario below
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// [delay before cue (ms), phone index, cue]
const SCRIPT: [number, 0 | 1, Cue][] = [
  [1500, 0, { demo: 'onboard', name: cap(a), lang: 'es' }],
  [600, 1, { demo: 'onboard', name: cap(b), lang: 'pt' }],
  [9000, 1, { demo: 'open', name: a }],
  [300, 0, { demo: 'open', name: b }],
  [1200, 1, { demo: 'type', text: 'Oi Gustavo! Terminei o design do logo 🎨' }],
  [4500, 0, { demo: 'type', text: '¡Quedó increíble! ¿Cuánto te debo?' }],
  [4500, 1, { demo: 'type', text: '/request 25 usdc Logo design' }],
  [4000, 0, { demo: 'pay-request' }],
  [9000, 1, { demo: 'type', text: 'Recebido na hora. Obrigada! 🙌' }],
];

export default function Split() {
  const frames = useRef<(HTMLIFrameElement | null)[]>([]);
  // Autoplay resets wallets, so it only runs against devnet, and only for the two demo slots.
  const [mode, setMode] = useState<'checking' | 'play' | 'manual'>(autoplay ? 'checking' : 'manual');
  useEffect(() => {
    if (!autoplay) return;
    fetch(`${RELAY_HTTP}/config`).then(r => r.json()).then(cfg => {
      if (cfg.cluster !== 'devnet') return setMode('manual');
      for (const u of [a, b]) localStorage.removeItem(`chaski.demo.wallet.${u}`);
      setMode('play');
    }).catch(() => setMode('manual'));
  }, []);
  useEffect(() => {
    if (mode !== 'play') return;
    let cancelled = false;
    (async () => {
      for (const [delay, i, cue] of SCRIPT) {
        await new Promise(r => setTimeout(r, delay));
        if (cancelled) return;
        frames.current[i]?.contentWindow?.postMessage(cue, location.origin);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);
  if (mode === 'checking') return <div className="stage"><p className="muted">Checking network…</p></div>;
  return (
    <div className="stage">
      <div className="stage-title">
        <h1>Send money like a message.</h1>
        <p>Two phones · two Solana wallets · real {autoplay && mode === 'manual' ? 'transactions (autoplay is devnet-only)' : 'devnet transactions'}</p>
      </div>
      <div className="phones">
        {[[a, b], [b, a]].map(([u, other], i) => (
          <div className="phone" key={u}>
            <div className="notch" />
            <iframe ref={el => { frames.current[i] = el; }} title={u} src={`/?demo&u=${u}${open ? `&chat=${other}` : ''}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
