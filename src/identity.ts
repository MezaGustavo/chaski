import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export type Profile = { pubkey: string; name: string; lang: string };

// One embedded wallet per "slot" so two demo users can live in one browser
// (?u=gustavo and ?u=laura). Production: passkey/MPC embedded wallet.
// Demo phones (the ?split stage) live in their own namespace, so a demo reset can never
// touch a real wallet.
const q = new URLSearchParams(location.search);
const slot = q.get('u') || 'default';
const KEY = `${q.has('demo') ? 'chaski.demo.wallet' : 'chaski.wallet'}.${slot}`;

export function loadIdentity(): { kp: Keypair; profile: Profile } | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const { secret, name, lang } = JSON.parse(raw);
  const kp = Keypair.fromSecretKey(bs58.decode(secret));
  return { kp, profile: { pubkey: kp.publicKey.toBase58(), name, lang } };
}

export function createIdentity(name: string, lang: string) {
  const kp = Keypair.generate();
  localStorage.setItem(KEY, JSON.stringify({ secret: bs58.encode(kp.secretKey), name, lang }));
  return { kp, profile: { pubkey: kp.publicKey.toBase58(), name, lang } };
}

/** Every relay payload is signed by the wallet that claims to send it. */
export function sign(kp: Keypair, payload: unknown): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(JSON.stringify(payload)), kp.secretKey));
}

export const short = (pk: string) => `${pk.slice(0, 4)}…${pk.slice(-4)}`;

const AMOUNT = /^\d{1,12}(\.\d{1,9})?$/;
/** Drops anything malformed or not signed by its claimed sender (don't trust the relay either). */
export function verifyEnvelope(e: { msg?: any; sig?: string }): boolean {
  const m = e?.msg, b = m?.body;
  if (!m || typeof m.id !== 'string' || typeof m.from !== 'string' || typeof m.to !== 'string' || !b || typeof b !== 'object') return false;
  const shapeOk = m.kind === 'text' ? typeof b.text === 'string'
    : (m.kind === 'request' || m.kind === 'transfer') && AMOUNT.test(b.amount) && (b.token === 'SOL' || b.token === 'USDC')
      && typeof b.note === 'string' && (m.kind === 'request' || typeof b.txSig === 'string');
  if (!shapeOk || typeof e.sig !== 'string') return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(JSON.stringify(m)), bs58.decode(e.sig), bs58.decode(m.from));
  } catch { return false; }
}
