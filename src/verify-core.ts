// Pure, dependency-free payment checks shared by the client and the unit tests.

export type Token = 'SOL' | 'USDC';
export const DECIMALS: Record<Token, number> = { SOL: 9, USDC: 6 };
export const MEMO_PREFIX = 'chaski:';

/** "12.5" -> 12500000n (USDC). Exact decimal parsing, no floats. */
export function toBaseUnits(amount: string, token: Token): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  const d = DECIMALS[token];
  if (!m || (m[2] ?? '').length > d) throw new Error('invalid amount');
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, '0') || '0');
}

/** Subset of a jsonParsed instruction that the check reads. */
export type ParsedIx = { program?: string; parsed?: any };

export type Expected = {
  from: string; to: string; amount: string; token: Token; msgId: string;
  mint: string;          // USDC mint for this cluster
  recipientAta: string;  // associated token account of `to` for `mint` (USDC only)
};

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * The chat message only claims a payment; this decides. The transaction must carry the
 * memo for this message id (no replay into another message) and move exactly `amount`
 * of `token` from `from` to `to`.
 */
export function checkTransfer(ixs: ParsedIx[], txErr: unknown, e: Expected): Verdict {
  if (txErr) return { ok: false, reason: 'failed on-chain' };
  const units = toBaseUnits(e.amount, e.token).toString();

  const memoOk = ixs.some(ix => ix.program === 'spl-memo' && ix.parsed === `${MEMO_PREFIX}${e.msgId}`);
  if (!memoOk) return { ok: false, reason: 'memo mismatch' };

  const moved = ixs.some(ix => {
    const info = ix.parsed?.info;
    if (!info) return false;
    if (e.token === 'SOL') {
      return ix.program === 'system' && ix.parsed.type === 'transfer'
        && info.source === e.from && info.destination === e.to && String(info.lamports) === units;
    }
    return ix.program === 'spl-token' && ix.parsed.type === 'transferChecked'
      && info.authority === e.from && info.mint === e.mint
      && info.destination === e.recipientAta && info.tokenAmount?.amount === units;
  });
  return moved ? { ok: true } : { ok: false, reason: 'amount/recipient mismatch' };
}
