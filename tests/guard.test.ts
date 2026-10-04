import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferGuard } from '../src/guard.ts';

const ME = 'me', THEM = 'them';
const request = { id: 'r1', from: THEM, to: ME, ts: 0, kind: 'request', body: { amount: '25', token: 'USDC', note: '' } } as const;
const paidBefore = { id: 't1', from: ME, to: THEM, ts: 0, kind: 'transfer', body: { amount: '5', token: 'USDC', note: '', txSig: 'x' } } as const;

test('paying a request they sent goes straight through', () => {
  assert.equal(transferGuard(25, 'USDC', [request as any], ME, 'r1').action, 'send');
});
test('first payment to a contact asks for confirmation', () => {
  assert.equal(transferGuard(5, 'USDC', [], ME).action, 'confirm');
});
test('large payments ask for confirmation, small repeat ones do not', () => {
  assert.equal(transferGuard(500, 'USDC', [paidBefore as any], ME).action, 'confirm');
  assert.equal(transferGuard(20, 'USDC', [paidBefore as any], ME).action, 'send');
});
test('absurd or non-positive amounts are blocked', () => {
  assert.equal(transferGuard(0, 'USDC', [], ME).action, 'block');
  assert.equal(transferGuard(50_000, 'USDC', [], ME).action, 'block');
});
test('a request id that is not theirs does not skip the checks', () => {
  assert.equal(transferGuard(25, 'USDC', [], ME, 'r1').action, 'confirm');
});
