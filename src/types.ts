import type { Token } from './solana';

export type Msg =
  | Base & { kind: 'text'; body: { text: string } }
  | Base & { kind: 'request'; body: { amount: string; token: Token; note: string } }
  | Base & { kind: 'transfer'; body: { amount: string; token: Token; note: string; txSig: string; requestId?: string } };

type Base = { id: string; from: string; to: string; ts: number };
export type Envelope = { msg: Msg; sig: string };
