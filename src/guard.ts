import type { Token } from './solana';
import type { Msg } from './types';

export type GuardDecision =
  | { action: 'send' }
  | { action: 'confirm'; reason: string }
  | { action: 'block'; reason: string };

/**
 * Runs before every outgoing transfer. A chat makes paying as fast as typing,
 * which is also how people get scammed or fat-finger amounts — this is where
 * the product decides how much friction a payment deserves.
 *
 * @param amount   decimal amount as typed (already validated as a number)
 * @param token    'SOL' | 'USDC'
 * @param history  every message in this conversation, oldest first
 * @param me       my pubkey (to tell my messages from theirs)
 */
export function transferGuard(amount: number, token: Token, history: Msg[], me: string, requestId?: string): GuardDecision {
  if (!(amount > 0)) return { action: 'block', reason: 'Enter an amount greater than zero.' };
  if (amount > (token === 'USDC' ? 10_000 : 100)) return { action: 'block', reason: `That is above the beta limit for ${token}.` };

  // Paying a request they sent: the intent and the amount came from the chat itself.
  const paysRequest = requestId && history.some(m => m.id === requestId && m.kind === 'request' && m.from !== me);
  if (paysRequest) return { action: 'send' };

  const paidBefore = history.some(m => m.kind === 'transfer' && m.from === me);
  if (!paidBefore) return { action: 'confirm', reason: `First payment to this contact: ${amount} ${token}. Check that this is the right person.` };
  if (token === 'USDC' ? amount > 100 : amount > 1) return { action: 'confirm', reason: `Large payment: ${amount} ${token}. Typo check before it settles on-chain.` };
  return { action: 'send' };
}
