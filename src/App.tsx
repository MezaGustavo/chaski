import { useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { createIdentity, loadIdentity, sign, short, verifyEnvelope, type Profile } from './identity';
import { chain, explorer, getBalances, initChain, requestFaucet, RELAY_HTTP, RELAY_WS, signTransfer, submitTransfer, verifyTransfer, type Token, type Verdict } from './solana';
import { transferGuard } from './guard';
import type { Envelope, Msg } from './types';
import { onCue } from './director';

type Status = 'sending' | 'verifying' | Verdict;
const uid = () => crypto.randomUUID().slice(0, 12);

export default function App() {
  const [id, setId] = useState(loadIdentity);
  const [ready, setReady] = useState(false);
  useEffect(() => { initChain().then(() => setReady(true)); }, []);
  if (!ready) return <Splash text="Connecting to Solana…" />;
  if (!id) return <Onboarding onDone={setId} />;
  return <Messenger kp={id.kp} me={id.profile} />;
}

function Splash({ text }: { text: string }) {
  return <div className="splash"><Logo big /><p>{text}</p></div>;
}

// Product name lives here only (working name; see hackathon/naming.md).
const BRAND = { name: 'CHASKI', accent: 5, tag: '' };

function Logo({ big }: { big?: boolean }) {
  const { name, accent, tag } = BRAND;
  return (
    <div className={`logo ${big ? 'big' : ''}`}>
      <span className="bubble"><i /><i /><i /></span>
      <b>{name.slice(0, accent)}<em>{name[accent]}</em>{name.slice(accent + 1)}</b>{tag && <small>{tag}</small>}
    </div>
  );
}

function Onboarding({ onDone }: { onDone: (v: { kp: Keypair; profile: Profile }) => void }) {
  const [name, setName] = useState(new URLSearchParams(location.search).get('u')?.replace(/^\w/, c => c.toUpperCase()) || '');
  const [lang, setLang] = useState('es');
  const [busy, setBusy] = useState(false);
  useEffect(() => onCue('onboard', c => { setName(c.name!); setLang(c.lang!); go(c.name, c.lang); }), []);
  async function go(n = name, l = lang) {
    setBusy(true);
    const ident = createIdentity(n.trim(), l);
    if (chain.faucet) await requestFaucet(ident.profile.pubkey).catch(() => null);
    onDone(ident);
  }
  return (
    <div className="onboard">
      <Logo big />
      <h1>Your chat is your wallet.</h1>
      <p className="muted">No seed phrase, no bank. Pick a name and we create a Solana wallet for you in this device.</p>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="Gustavo" /></label>
      <label>Language
        <select value={lang} onChange={e => setLang(e.target.value)}>
          <option value="es">Español</option><option value="en">English</option><option value="pt">Português</option>
        </select>
      </label>
      <button className="primary" disabled={!name.trim() || busy} onClick={() => go()}>
        {busy ? (chain.faucet ? 'Creating wallet & funding on devnet…' : 'Creating wallet…') : 'Create my account'}
      </button>
      <p className="fine">🔒 Your key never leaves this device.{chain.faucet ? ' Devnet demo funds included.' : ' Fund it with USDC and a little SOL for fees.'}</p>
    </div>
  );
}

function Messenger({ kp, me }: { kp: Keypair; me: Profile }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [peer, setPeer] = useState<string | null>(null);
  const [bal, setBal] = useState({ sol: 0, usdc: 0 });
  const ws = useRef<WebSocket | null>(null);

  const refreshBal = () => getBalances(kp.publicKey).then(setBal).catch(() => {});

  async function check(m: Msg) {
    if (m.kind !== 'transfer') return;
    setStatus(s => ({ ...s, [m.id]: 'verifying' }));
    // The tx may not be visible yet (just sent, or the RPC node lags): retry before calling it failed.
    let v: Verdict = { ok: false, reason: 'not found' };
    for (let i = 0; i < 8; i++) {
      v = await verifyTransfer(m.body.txSig, m.from, m.to, m.body.amount, m.body.token, m.id).catch(() => ({ ok: false, reason: 'rpc error' } as Verdict));
      if (v.ok || (v.reason !== 'not found' && v.reason !== 'rpc error')) break;
      await new Promise(r => setTimeout(r, 1000 + i * 750));
    }
    setStatus(s => ({ ...s, [m.id]: v }));
    refreshBal();
  }

  useEffect(() => {
    refreshBal();
    const sock = new WebSocket(RELAY_WS);
    ws.current = sock;
    sock.onmessage = (e) => {
      const data = JSON.parse(e.data);
      // Log in by signing the relay's one-time nonce (replay-safe).
      if (data.t === 'challenge') sock.send(JSON.stringify({ t: 'hello', profile: me, sig: sign(kp, { t: 'chaski-relay-auth', nonce: data.nonce, profile: me }) }));
      if (data.t === 'directory') setProfiles(data.profiles.filter((p: Profile) => p.pubkey !== me.pubkey));
      if (data.t === 'history') {
        const ok = (data.messages as Envelope[]).filter(verifyEnvelope).map(x => x.msg);
        setMsgs(ok); ok.forEach(check);
      }
      if (data.t === 'msg' && !verifyEnvelope(data)) return; // unsigned or malformed: never rendered
      if (data.t === 'msg') {
        setMsgs(prev => prev.some(m => m.id === data.msg.id) ? prev : [...prev, data.msg]);
        if (data.msg.from !== me.pubkey) check(data.msg);
      }
    };
    return () => sock.close();
  }, []);

  function post(msg: Msg) {
    ws.current?.send(JSON.stringify({ t: 'msg', msg, sig: sign(kp, msg) }));
  }

  async function pay(to: string, amount: string, token: Token, note: string, requestId?: string) {
    const id = uid();
    setStatus(s => ({ ...s, [id]: 'sending' }));
    const pending: Msg = { id, from: me.pubkey, to, ts: Date.now(), kind: 'transfer', body: { amount, token, note, txSig: '', requestId } };
    setMsgs(prev => [...prev, pending]);
    try {
      // Sign first, post the card with its signature, then send: the card can't be lost after
      // the money moves, and nobody can claim this memo id before we do.
      const signed = await signTransfer(kp, new PublicKey(to), amount, token, id);
      const msg: Msg = { ...pending, body: { ...pending.body, txSig: signed.txSig } };
      setMsgs(prev => prev.map(m => m.id === id ? msg : m));
      post(msg);
      await submitTransfer(signed);
      check(msg);
    } catch (e) {
      setStatus(s => ({ ...s, [id]: { ok: false, reason: (e as Error).message.slice(0, 80) } }));
    }
  }

  // ?chat=laura opens that conversation directly (demo recordings, deep links).
  useEffect(() => {
    const want = new URLSearchParams(location.search).get('chat');
    const hit = want && !peer && findContact(profiles, want);
    if (hit) setPeer(hit.pubkey);
  }, [profiles]);

  useEffect(() => onCue('open', c => {
    const hit = findContact(profiles, c.name!);
    if (hit) setPeer(hit.pubkey);
  }), [profiles]);

  const peerProfile = profiles.find(p => p.pubkey === peer);
  const thread = useMemo(() => msgs.filter(m => (m.from === peer && m.to === me.pubkey) || (m.to === peer && m.from === me.pubkey)), [msgs, peer]);
  const lastBy = (pk: string) => [...msgs].reverse().find(m => m.from === pk || m.to === pk);

  return (
    <div className={`app ${peer ? 'in-chat' : ''}`}>
      <aside className="side">
        <header>
          <Logo />
          <div className="me">
            <span className="avatar">{me.name[0]}</span>
            <div><b>{me.name}</b><code title={me.pubkey}>{short(me.pubkey)}</code></div>
          </div>
          <div className="balances">
            <div><small>USDC</small><b>{bal.usdc.toFixed(2)}</b></div>
            <div><small>SOL</small><b>{bal.sol.toFixed(3)}</b></div>
          </div>
        </header>
        <div className="section">Chats</div>
        <ul className="contacts">
          {profiles.length === 0 && <li className="empty">Waiting for friends to join…</li>}
          {profiles.map(p => {
            const last = lastBy(p.pubkey);
            return (
              <li key={p.pubkey} className={p.pubkey === peer ? 'active' : ''} onClick={() => setPeer(p.pubkey)}>
                <span className="avatar">{p.name[0]}</span>
                <div><b>{p.name}</b><small>{last ? preview(last, me.pubkey) : short(p.pubkey)}</small></div>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="chat">
        {peerProfile ? (
          <Chat me={me} peer={peerProfile} thread={thread} status={status}
            onBack={() => setPeer(null)}
            onText={text => post({ id: uid(), from: me.pubkey, to: peerProfile.pubkey, ts: Date.now(), kind: 'text', body: { text } })}
            onRequest={(amount, token, note) => post({ id: uid(), from: me.pubkey, to: peerProfile.pubkey, ts: Date.now(), kind: 'request', body: { amount, token, note } })}
            onPay={(amount, token, note, requestId) => pay(peerProfile.pubkey, amount, token, note, requestId)}
          />
        ) : <div className="placeholder"><Logo big /><p>Pick a chat. Every contact is a Solana wallet.</p></div>}
      </main>
    </div>
  );
}

/** Deep links name a contact by public key. A display name is accepted only when exactly one
 *  online contact uses it: names are self-chosen and must never pick a wallet on their own. */
function findContact(profiles: Profile[], key: string) {
  const byKey = profiles.find(p => p.pubkey === key);
  if (byKey) return byKey;
  const named = profiles.filter(p => p.name.toLowerCase() === key.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

function preview(m: Msg, me: string) {
  if (m.kind === 'text') return m.body.text;
  if (m.kind === 'request') return `💸 Request ${m.body.amount} ${m.body.token}`;
  return `${m.from === me ? 'You sent' : 'Received'} ${m.body.amount} ${m.body.token}`;
}

type ChatProps = {
  me: Profile; peer: Profile; thread: Msg[]; status: Record<string, Status>;
  onBack: () => void; onText: (t: string) => void;
  onRequest: (a: string, t: Token, n: string) => void;
  onPay: (a: string, t: Token, n: string, requestId?: string) => void;
};

function Chat({ me, peer, thread, status, onBack, onText, onRequest, onPay }: ChatProps) {
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<null | { mode: 'pay' | 'request'; amount?: string; token?: Token; note?: string; requestId?: string }>(null);
  const [confirm, setConfirm] = useState<null | { reason: string; run: () => void }>(null);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, which React would treat as a cleanup fn.
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread.length, status]);

  useEffect(() => onCue('type', async c => {
    const full = c.text!;
    for (let i = 1; i <= full.length; i++) { setText(full.slice(0, i)); await new Promise(r => setTimeout(r, 38)); }
    await new Promise(r => setTimeout(r, 350));
    submit(full);
  }), [thread]);
  useEffect(() => onCue('pay-request', () => {
    const req = [...thread].reverse().find(m => m.kind === 'request' && m.from === peer.pubkey && !paidRequests.has(m.id) && !pendingRequests.has(m.id));
    if (req && req.kind === 'request') guardedPay(req.body.amount, req.body.token, req.body.note, req.id);
  }), [thread]);

  // A request counts as paid only by a transfer that verified on-chain, came from the person
  // asked to pay, and matches the requested amount and token. A claim in the chat is not enough.
  const requests = new Map(thread.flatMap(m => m.kind === 'request' ? [[m.id, m] as const] : []));
  const paidRequests = new Set(thread.flatMap(m => {
    if (m.kind !== 'transfer' || !m.body.requestId) return [];
    const req = requests.get(m.body.requestId);
    const st = status[m.id];
    const verified = typeof st === 'object' && st.ok;
    return req && verified && m.from === req.to && m.body.amount === req.body.amount && m.body.token === req.body.token ? [req.id] : [];
  }));
  // Transfers for a request that are still in flight (not failed): hide Pay to avoid double payment.
  const pendingRequests = new Set(thread.flatMap(m => {
    if (m.kind !== 'transfer' || !m.body.requestId || m.from !== requests.get(m.body.requestId)?.to) return [];
    const st = status[m.id];
    return typeof st === 'object' && !st.ok ? [] : [m.body.requestId];
  }));

  function guardedPay(amount: string, token: Token, note: string, requestId?: string) {
    const d = transferGuard(Number(amount), token, thread, me.pubkey, requestId);
    if (d.action === 'block') return alert(d.reason);
    if (d.action === 'confirm') return setConfirm({ reason: d.reason, run: () => onPay(amount, token, note, requestId) });
    onPay(amount, token, note, requestId);
  }

  function submit(raw = text) {
    const t = raw.trim();
    if (!t) return;
    // Slash commands: "/pay 5 usdc lunch" · "/request 10 usdc rent"
    const cmd = t.match(/^\/(pay|request)\s+(\d+(?:\.\d+)?)\s*(usdc|sol)?\s*(.*)$/i);
    if (cmd) {
      const [, mode, amount, tok, note] = cmd;
      const token = (tok || 'usdc').toUpperCase() as Token;
      mode.toLowerCase() === 'pay' ? guardedPay(amount, token, note) : onRequest(amount, token, note);
    } else onText(t);
    setText('');
  }

  return (
    <>
      <header className="chat-head">
        <button className="back" onClick={onBack}>‹</button>
        <span className="avatar">{peer.name[0]}</span>
        <div><b>{peer.name}</b><code title={peer.pubkey}>◎ {short(peer.pubkey)} · signs every message</code></div>
      </header>
      <div className="thread">
        <div className="e2e">🔒 Messages are signed by each wallet. Payments settle on Solana.</div>
        {thread.map(m => {
          const mine = m.from === me.pubkey;
          if (m.kind === 'text') return mine || peer.lang === me.lang
            ? <div key={m.id} className={`bubble-msg ${mine ? 'mine' : ''}`}>{m.body.text}</div>
            : <Translated key={m.id} text={m.body.text} from={peer.lang} to={me.lang} />;
          if (m.kind === 'request') {
            const paid = paidRequests.has(m.id);
            return (
              <div key={m.id} className={`card request ${mine ? 'mine' : ''}`}>
                <small>{mine ? 'You requested' : `${peer.name} requests`}</small>
                <div className="amount">{m.body.amount} <span>{m.body.token}</span></div>
                {m.body.note && <p>{m.body.note}</p>}
                {paid ? <div className="pill ok">✓ Paid</div>
                  : pendingRequests.has(m.id) ? <div className="pill">⏳ Verifying payment…</div>
                  : mine ? <div className="pill">Waiting for payment</div>
                  : <button className="primary" onClick={() => guardedPay(m.body.amount, m.body.token, m.body.note, m.id)}>Pay {m.body.amount} {m.body.token}</button>}
              </div>
            );
          }
          const st = status[m.id];
          return (
            <div key={m.id} className={`card transfer ${mine ? 'mine' : ''}`}>
              <small>{mine ? 'You sent' : `${peer.name} sent you`}</small>
              <div className="amount">{m.body.amount} <span>{m.body.token}</span></div>
              {m.body.note && <p>{m.body.note}</p>}
              <StatusPill st={st} />
              {m.body.txSig && <a href={explorer(m.body.txSig)} target="_blank" rel="noreferrer">View on Solana Explorer ↗</a>}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <footer className="composer">
        <button className="money" title="Send or request money" onClick={() => setSheet({ mode: 'pay' })}>$</button>
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Message · try /pay 5 usdc" />
        <button className="send" onClick={() => submit()}>➤</button>
      </footer>
      {sheet && <PaySheet peer={peer} init={sheet} onClose={() => setSheet(null)}
        onSubmit={(mode, amount, token, note) => { setSheet(null); mode === 'pay' ? guardedPay(amount, token, note) : onRequest(amount, token, note); }} />}
      {confirm && (
        <div className="sheet-bg" onClick={() => setConfirm(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <h3>Double-check this payment</h3>
            <p className="muted">{confirm.reason}</p>
            <button className="primary" onClick={() => { confirm.run(); setConfirm(null); }}>Yes, send it</button>
            <button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

const LANG: Record<string, string> = { es: 'Spanish', en: 'English', pt: 'Portuguese' };

function Translated({ text, from, to }: { text: string; from: string; to: string }) {
  const [out, setOut] = useState<string | null>(null);
  const [orig, setOrig] = useState(false);
  useEffect(() => {
    fetch(`${RELAY_HTTP}/translate?q=${encodeURIComponent(text)}&from=${from}&to=${to}`)
      .then(r => r.json()).then(r => setOut(r.text || text)).catch(() => setOut(text));
  }, [text, from, to]);
  return (
    <div className="bubble-msg">
      {orig || !out ? text : out}
      <button className="tr" onClick={() => setOrig(o => !o)}>
        🌐 {orig ? 'Show translation' : `Translated from ${LANG[from] || from} · see original`}
      </button>
    </div>
  );
}

function StatusPill({ st }: { st?: Status }) {
  if (!st || st === 'verifying') return <div className="pill">⏳ Verifying on-chain…</div>;
  if (st === 'sending') return <div className="pill">⚡ Sending on Solana…</div>;
  return st.ok ? <div className="pill ok">✓ Verified on-chain</div> : <div className="pill bad">✕ {st.reason}</div>;
}

function PaySheet({ peer, init, onClose, onSubmit }: {
  peer: Profile; init: { mode: 'pay' | 'request' };
  onClose: () => void; onSubmit: (m: 'pay' | 'request', a: string, t: Token, n: string) => void;
}) {
  const [mode, setMode] = useState(init.mode);
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState<Token>('USDC');
  const [note, setNote] = useState('');
  const valid = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="seg">
          <button className={mode === 'pay' ? 'on' : ''} onClick={() => setMode('pay')}>Send</button>
          <button className={mode === 'request' ? 'on' : ''} onClick={() => setMode('request')}>Request</button>
        </div>
        <p className="muted">{mode === 'pay' ? 'to' : 'from'} <b>{peer.name}</b> · {short(peer.pubkey)}</p>
        <div className="big-amount">
          <input autoFocus inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(',', '.'))} placeholder="0" />
          <div className="seg small">
            {(['USDC', 'SOL'] as Token[]).map(t => <button key={t} className={token === t ? 'on' : ''} onClick={() => setToken(t)}>{t}</button>)}
          </div>
        </div>
        <input className="note" value={note} onChange={e => setNote(e.target.value)} placeholder="What's it for? (optional)" />
        <button className="primary" disabled={!valid} onClick={() => onSubmit(mode, amount, token, note)}>
          {mode === 'pay' ? `Send ${amount || 0} ${token}` : `Request ${amount || 0} ${token}`}
        </button>
        <p className="fine">Settles in ~1s on Solana · fee &lt; $0.001</p>
      </div>
    </div>
  );
}
