import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTransfer, toBaseUnits, type Expected } from '../src/verify-core.ts';

// A real 25 USDC (devnet test mint) Chaski payment, fetched with getParsedTransaction.
const fx = JSON.parse(readFileSync(new URL('./fixtures/devnet-usdc-payment.json', import.meta.url), 'utf8'));
const xfer = fx.instructions.find((i: any) => i.parsed?.type === 'transferChecked').parsed.info;
const ata = fx.instructions.find((i: any) => i.parsed?.type === 'createIdempotent').parsed.info;

const expected: Expected = {
  from: xfer.authority, to: ata.wallet, amount: '25', token: 'USDC',
  msgId: fx.instructions.find((i: any) => i.program === 'spl-memo').parsed.replace('chaski:', ''),
  mint: xfer.mint, recipientAta: xfer.destination,
};
const clone = () => structuredClone(fx.instructions);

test('accepts the real devnet payment', () => {
  assert.deepEqual(checkTransfer(fx.instructions, fx.err, expected), { ok: true });
});

test('rejects a failed transaction', () => {
  assert.equal(checkTransfer(fx.instructions, { InstructionError: [1, 'Custom'] }, expected).ok, false);
});

test('rejects the same signature replayed into another chat message (memo mismatch)', () => {
  assert.deepEqual(checkTransfer(fx.instructions, null, { ...expected, msgId: 'other-message' }), { ok: false, reason: 'memo mismatch' });
});

test('rejects a different amount, recipient, sender or mint', () => {
  for (const patch of [{ amount: '250' }, { amount: '24.999999' }, { recipientAta: expected.from }, { from: expected.to }, { mint: '11111111111111111111111111111111' }]) {
    assert.equal(checkTransfer(fx.instructions, null, { ...expected, ...patch }).ok, false, JSON.stringify(patch));
  }
});

test('rejects a transaction whose memo was stripped', () => {
  const ixs = clone().filter((i: any) => i.program !== 'spl-memo');
  assert.equal(checkTransfer(ixs, null, expected).ok, false);
});

test('toBaseUnits parses decimals exactly, without floats', () => {
  assert.equal(toBaseUnits('25', 'USDC'), 25_000_000n);
  assert.equal(toBaseUnits('0.1', 'USDC'), 100_000n);
  assert.equal(toBaseUnits('1.000000001', 'SOL'), 1_000_000_001n);
  assert.throws(() => toBaseUnits('1.0000001', 'USDC'));
  assert.throws(() => toBaseUnits('-1', 'USDC'));
  assert.throws(() => toBaseUnits('1e3', 'USDC'));
  assert.throws(() => toBaseUnits('5.0.999', 'USDC'));
  assert.throws(() => toBaseUnits('.5', 'USDC'));
});
