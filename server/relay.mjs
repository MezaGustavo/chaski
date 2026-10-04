// Message relay (+ faucet on devnet only).
// The relay is deliberately dumb: it stores and forwards messages, and rejects
// anything whose ed25519 signature does not match the claimed sender pubkey.
// Money never touches it — transfers are verified on-chain by the recipient.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

const PORT = Number(process.env.PORT || 8787);

// CLUSTER=devnet (default) uses the test mint + faucet from `npm run setup:devnet`.
// CLUSTER=mainnet-beta uses Circle's USDC mint and has no faucet: users fund their own wallets.
const CLUSTER = process.env.CLUSTER || 'devnet';
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
if (!['devnet', 'mainnet-beta'].includes(CLUSTER)) throw new Error(`unsupported CLUSTER=${CLUSTER}`);
const devnet = CLUSTER === 'devnet' ? JSON.parse(fs.readFileSync(new URL('./devnet.json', import.meta.url))) : null;
const cfg = {
  cluster: CLUSTER,
  // RPC_URL stays on the server. CLIENT_RPC_URL is what browsers get from /config: it is public,
  // so use a domain-restricted key there, never your private one.
  rpc: process.env.RPC_URL || devnet?.rpc || 'https://api.mainnet-beta.solana.com',
  clientRpc: process.env.CLIENT_RPC_URL || devnet?.rpc || 'https://api.mainnet-beta.solana.com',
  mint: devnet ? devnet.mint : MAINNET_USDC,
  // Priority fee in micro-lamports per CU, sent to clients. Override with PRIORITY_MICROLAMPORTS.
  priorityMicroLamports: Number(process.env.PRIORITY_MICROLAMPORTS ?? (devnet ? 1_000 : 20_000)),
};

// Fixed-window rate limit per client IP: { faucet: 3 per hour, translate: 60 per minute }.
const LIMITS = { faucet: [3, 3_600_000], translate: [60, 60_000], msg: [30, 60_000] };
const MAX_MESSAGES = 5_000, MAX_TRANSLATIONS = 2_000;
const hits = new Map();
function limited(kind, ip) {
  const [max, windowMs] = LIMITS[kind], key = `${kind}|${ip}`, now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  return ++h.n > max;
}
const conn = new Connection(cfg.rpc, 'confirmed');
const faucet = devnet ? Keypair.fromSecretKey(Uint8Array.from(devnet.faucetSecret)) : null;
const mint = new PublicKey(cfg.mint);

const FAUCET_SOL = 0.05;
const FAUCET_USDC = 100;

const profiles = new Map();   // pubkey -> { pubkey, name, lang }
const sockets = new Map();    // pubkey -> Set<ws>
const messages = [];          // signed envelopes, in arrival order
const funded = new Set();
const seenIds = new Set();    // message ids already relayed
const seenTx = new Set();     // transfer signatures already relayed
const translations = new Map(); // cache: "from|to|text" -> translated text

const enc = new TextEncoder();
const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const AMOUNT = /^\d{1,12}(\.\d{1,9})?$/;
/** Only well-formed chat messages are stored and forwarded (a bad one must not crash a client). */
function validMsg(m) {
  if (!m || !str(m.id, 64) || !str(m.from, 44) || !str(m.to, 44) || typeof m.ts !== 'number' || !m.body || typeof m.body !== 'object') return false;
  const b = m.body;
  if (m.kind === 'text') return str(b.text, 2000);
  const money = AMOUNT.test(b.amount) && (b.token === 'SOL' || b.token === 'USDC') && typeof b.note === 'string' && b.note.length <= 200;
  if (m.kind === 'request') return money;
  if (m.kind === 'transfer') return money && str(b.txSig, 100) && (b.requestId === undefined || str(b.requestId, 64));
  return false;
}
function verify(payload, sig, pubkey) {
  try {
    return nacl.sign.detached.verify(enc.encode(JSON.stringify(payload)), bs58.decode(sig), new PublicKey(pubkey).toBytes());
  } catch { return false; }
}

function send(pubkey, data) {
  for (const ws of sockets.get(pubkey) || []) ws.send(JSON.stringify(data));
}
function broadcast(data) {
  for (const set of sockets.values()) for (const ws of set) ws.send(JSON.stringify(data));
}

async function fund(pubkeyStr) {
  const owner = new PublicKey(pubkeyStr);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: faucet.publicKey, toPubkey: owner, lamports: FAUCET_SOL * LAMPORTS_PER_SOL,
  }));
  const solSig = await sendAndConfirmTransaction(conn, tx, [faucet]);
  const ata = await getOrCreateAssociatedTokenAccount(conn, faucet, mint, owner);
  const usdcSig = await mintTo(conn, faucet, mint, ata.address, faucet, FAUCET_USDC * 1e6);
  return { solSig, usdcSig };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/config') {
    return res.end(JSON.stringify({ cluster: cfg.cluster, rpc: cfg.clientRpc, mint: cfg.mint, faucet: !!faucet, priorityMicroLamports: cfg.priorityMicroLamports }));
  }
  const ip = req.socket.remoteAddress;
  if (req.url.startsWith('/translate')) {
    if (limited('translate', ip)) { res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate limited' })); }
    // Translation is a view over the signed original, never a replacement for it.
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').slice(0, 500), from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const key = `${from}|${to}|${q}`;
    if (!translations.has(key)) {
      const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${from}|${to}`).then(r => r.json()).catch(() => null);
      if (translations.size >= MAX_TRANSLATIONS) translations.delete(translations.keys().next().value);
      translations.set(key, r?.responseData?.translatedText || null);
    }
    return res.end(JSON.stringify({ text: translations.get(key) }));
  }
  if (req.url === '/faucet' && req.method === 'POST' && faucet) {
    if (limited('faucet', ip)) { res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate limited' })); }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { pubkey } = JSON.parse(body);
      if (funded.has(pubkey)) { res.statusCode = 429; return res.end(JSON.stringify({ error: 'already funded' })); }
      funded.add(pubkey);
      try {
        return res.end(JSON.stringify(await fund(pubkey)));
      } catch (e) {
        funded.delete(pubkey); // let the user retry
        throw e;
      }
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  res.statusCode = 404; res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  let me = null;
  // Challenge-response login: the client signs a fresh per-socket nonce, so a captured
  // hello cannot be replayed on another connection to impersonate a user or read history.
  let nonce = crypto.randomBytes(16).toString('hex');
  ws.send(JSON.stringify({ t: 'challenge', nonce }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.t === 'hello') {
      const { profile, sig } = data;
      const auth = { t: 'chaski-relay-auth', nonce, profile };
      if (!nonce || !profile?.pubkey || !verify(auth, sig, profile.pubkey)) return ws.send(JSON.stringify({ t: 'error', error: 'bad signature' }));
      nonce = null; // single use
      me = profile.pubkey;
      profiles.set(me, { pubkey: me, name: String(profile.name).slice(0, 40), lang: String(profile.lang).slice(0, 5) });
      if (!sockets.has(me)) sockets.set(me, new Set());
      sockets.get(me).add(ws);
      ws.send(JSON.stringify({ t: 'history', messages: messages.filter(m => m.msg.from === me || m.msg.to === me) }));
      broadcast({ t: 'directory', profiles: [...profiles.values()] });
      return;
    }

    if (data.t === 'msg' && me) {
      const { msg, sig } = data;
      if (!validMsg(msg)) return ws.send(JSON.stringify({ t: 'error', error: 'malformed' }));
      if (msg.from !== me || !verify(msg, sig, me)) return ws.send(JSON.stringify({ t: 'error', error: 'bad signature' }));
      if (limited('msg', me)) return ws.send(JSON.stringify({ t: 'error', error: 'rate limited' }));
      // A signed envelope or a transaction signature is accepted once: no duplicate payment cards.
      const txSig = msg.kind === 'transfer' ? msg.body?.txSig : null;
      if (seenIds.has(msg.id) || (txSig && seenTx.has(txSig))) return ws.send(JSON.stringify({ t: 'error', error: 'duplicate' }));
      seenIds.add(msg.id);
      if (txSig) seenTx.add(txSig);
      const envelope = { msg, sig };
      messages.push(envelope);
      if (messages.length > MAX_MESSAGES) messages.shift();
      send(msg.to, { t: 'msg', ...envelope });
      if (msg.to !== me) send(me, { t: 'msg', ...envelope });
    }
  });
  ws.on('close', () => { if (me) sockets.get(me)?.delete(ws); });
});

server.listen(PORT, () => console.log(`relay on :${PORT} · ${CLUSTER} · mint ${mint.toBase58()} · faucet ${faucet ? faucet.publicKey.toBase58() : 'off'}`));
