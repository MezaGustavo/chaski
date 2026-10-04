// One-time devnet setup: creates a dedicated faucet wallet (funded from the
// local CLI keypair) and a 6-decimal test stablecoin ("dUSDC") it can mint.
// The CLI keypair never leaves this script; the relay only sees the faucet key.
import fs from 'node:fs';
import os from 'node:os';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const OUT = new URL('./devnet.json', import.meta.url);
const conn = new Connection(RPC, 'confirmed');

if (fs.existsSync(OUT)) { console.log('already set up:', JSON.parse(fs.readFileSync(OUT)).mint); process.exit(0); }

const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const faucet = Keypair.generate();
const FUND_SOL = Number(process.env.FUND_SOL || 3);

await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: faucet.publicKey, lamports: FUND_SOL * LAMPORTS_PER_SOL })
), [funder]);
const mint = await createMint(conn, faucet, faucet.publicKey, null, 6);

fs.writeFileSync(OUT, JSON.stringify({ rpc: RPC, mint: mint.toBase58(), faucetSecret: Array.from(faucet.secretKey) }));
console.log('faucet', faucet.publicKey.toBase58(), `funded ${FUND_SOL} SOL`);
console.log('mint  ', mint.toBase58());
