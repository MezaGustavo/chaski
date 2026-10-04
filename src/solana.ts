import { Buffer } from 'buffer';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  LAMPORTS_PER_SOL, type ParsedInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';

import { checkTransfer, DECIMALS, MEMO_PREFIX, toBaseUnits, type Token, type Verdict } from './verify-core';
export { toBaseUnits, type Token, type Verdict };
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const RELAY_HTTP = import.meta.env.VITE_RELAY_HTTP || `http://${location.hostname}:8787`;
export const RELAY_WS = RELAY_HTTP.replace(/^http/, 'ws');

let conn: Connection;
let mint: PublicKey;
/** Network settings come from the relay, so one build serves devnet and mainnet. */
export const chain = { cluster: 'devnet' as 'devnet' | 'mainnet-beta', faucet: false, priorityMicroLamports: 0 };
export async function initChain() {
  const cfg = await fetch(`${RELAY_HTTP}/config`).then(r => r.json());
  conn = new Connection(cfg.rpc, 'confirmed');
  mint = new PublicKey(cfg.mint);
  chain.cluster = cfg.cluster ?? 'devnet';
  chain.faucet = !!cfg.faucet;
  chain.priorityMicroLamports = Number(cfg.priorityMicroLamports) || 0;
}
export const explorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${chain.cluster === 'mainnet-beta' ? '' : '?cluster=devnet'}`;

export async function getBalances(owner: PublicKey) {
  const lamports = await conn.getBalance(owner);
  let usdc = 0;
  try {
    const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner));
    usdc = bal.value.uiAmount ?? 0;
  } catch { /* no token account yet */ }
  return { sol: lamports / LAMPORTS_PER_SOL, usdc };
}

/**
 * Builds and signs SOL or USDC with a memo binding the transfer to one chat message id.
 * The signature is known before anything is sent, so the chat card can be posted first.
 */
export async function signTransfer(from: Keypair, to: PublicKey, amount: string, token: Token, msgId: string) {
  const units = toBaseUnits(amount, token);
  const tx = new Transaction();
  if (chain.priorityMicroLamports > 0) {
    // ATA create + transfer + memo uses well under 80k CU; a tight limit keeps the priority fee small.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: chain.priorityMicroLamports }));
  }
  if (token === 'SOL') {
    tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: units }));
  } else {
    const src = getAssociatedTokenAddressSync(mint, from.publicKey);
    const dst = getAssociatedTokenAddressSync(mint, to);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dst, to, mint));
    tx.add(createTransferCheckedInstruction(src, mint, dst, from.publicKey, units, DECIMALS.USDC));
  }
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`${MEMO_PREFIX}${msgId}`) }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = from.publicKey;
  tx.sign(from);
  return { tx, txSig: bs58.encode(tx.signature!), lastValidBlockHeight };
}

/** Sends a signed transfer. A confirmation timeout is not a failure until the chain says so. */
export async function submitTransfer(signed: Awaited<ReturnType<typeof signTransfer>>) {
  const { tx, txSig, lastValidBlockHeight } = signed;
  try {
    await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    const res = await conn.confirmTransaction({ signature: txSig, blockhash: tx.recentBlockhash!, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error('failed on-chain');
  } catch (e) {
    const st = (await conn.getSignatureStatus(txSig, { searchTransactionHistory: true })).value;
    if (!st || st.err) throw e;
  }
}

/** Recipient-side check: fetch the transaction and let checkTransfer decide. */
export async function verifyTransfer(txSig: string, from: string, to: string, amount: string, token: Token, msgId: string): Promise<Verdict> {
  const tx = await conn.getParsedTransaction(txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) return { ok: false, reason: 'not found' };
  return checkTransfer(tx.transaction.message.instructions as ParsedInstruction[], tx.meta?.err, {
    from, to, amount, token, msgId,
    mint: mint.toBase58(),
    recipientAta: getAssociatedTokenAddressSync(mint, new PublicKey(to)).toBase58(),
  });
}

export async function requestFaucet(pubkey: string) {
  const r = await fetch(`${RELAY_HTTP}/faucet`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey }),
  });
  return r.json();
}
