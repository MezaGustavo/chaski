// Spins up the relay (mainnet-beta mode: no faucet, no chain calls) and attacks its auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_ = `ws://localhost:${PORT}`;
let relay;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const sign = (kp, o) => bs58.encode(nacl.sign.detached(enc(o), kp.secretKey));

before(async () => {
  relay = spawn(process.execPath, ['server/relay.mjs'], { env: { ...process.env, CLUSTER: 'mainnet-beta', PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((res) => relay.stdout.on('data', (d) => String(d).includes('relay on') && res()));
});
after(() => relay.kill());

/** Opens a socket and resolves with { ws, nonce, next() } where next() awaits the next server frame. */
function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_), queue = [], waiters = [];
    ws.on('message', (raw) => { const d = JSON.parse(raw); waiters.length ? waiters.shift()(d) : queue.push(d); });
    const next = () => new Promise((r) => (queue.length ? r(queue.shift()) : waiters.push(r)));
    ws.on('open', async () => { const c = await next(); resolve({ ws, nonce: c.nonce, next }); });
  });
}
const hello = (kp, nonce, signer = kp) => {
  const profile = { pubkey: kp.publicKey.toBase58(), name: 'Laura', lang: 'pt' };
  return { t: 'hello', profile, sig: sign(signer, { t: 'chaski-relay-auth', nonce, profile }) };
};

test('accepts a hello signed over this socket nonce', async () => {
  const laura = Keypair.generate(), c = await connect();
  c.ws.send(JSON.stringify(hello(laura, c.nonce)));
  assert.equal((await c.next()).t, 'history');
  c.ws.close();
});

test('rejects a hello signed by a different key (impersonation)', async () => {
  const c = await connect();
  c.ws.send(JSON.stringify(hello(Keypair.generate(), c.nonce, Keypair.generate())));
  assert.deepEqual(await c.next(), { t: 'error', error: 'bad signature' });
  c.ws.close();
});

test('rejects a captured hello replayed on another connection', async () => {
  const laura = Keypair.generate(), a = await connect();
  const captured = hello(laura, a.nonce);
  a.ws.send(JSON.stringify(captured));
  assert.equal((await a.next()).t, 'history');
  const b = await connect();
  b.ws.send(JSON.stringify(captured));
  assert.deepEqual(await b.next(), { t: 'error', error: 'bad signature' });
  a.ws.close(); b.ws.close();
});

test('rejects the same signed message twice', async () => {
  const laura = Keypair.generate(), c = await connect();
  c.ws.send(JSON.stringify(hello(laura, c.nonce)));
  await c.next(); // history
  const msg = { id: 'm1', from: laura.publicKey.toBase58(), to: laura.publicKey.toBase58(), ts: 1, kind: 'text', body: { text: 'hi' } };
  const env = { t: 'msg', msg, sig: sign(laura, msg) };
  c.ws.send(JSON.stringify(env));
  let d; do { d = await c.next(); } while (d.t === 'directory');
  assert.equal(d.t, 'msg');
  c.ws.send(JSON.stringify(env));
  do { d = await c.next(); } while (d.t === 'directory');
  assert.deepEqual(d, { t: 'error', error: 'duplicate' });
  c.ws.close();
});
