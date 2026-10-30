import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, encodePredictBet, encodePredictClaim, encodePredictClaimMany, quotePredict, encodeMarketView, decodeMarketView, decodeUintArray, word, PREDICT_SEL } from '../scripts/suan-launchpad.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const sig = (s) => keccak256(utf8(s)).slice(0, 10);

test('predict selectors match keccak of the contract signatures', () => {
  assert.equal(PREDICT_SEL.bet, sig('bet(uint256,uint8)'));
  assert.equal(PREDICT_SEL.claim, sig('claim(uint256)'));
  assert.equal(PREDICT_SEL.claimMany, sig('claimMany(uint256[])'));
  assert.equal(PREDICT_SEL.marketInfo, sig('marketInfo(uint256)'));
  assert.equal(PREDICT_SEL.poolsOf, sig('poolsOf(uint256)'));
  assert.equal(PREDICT_SEL.claimable, sig('claimable(uint256,address)'));
});

test('predict bet and claim calldata is the selector plus the static arguments', () => {
  assert.equal(encodePredictBet(7n, 1), PREDICT_SEL.bet + word(7) + word(1));
  assert.equal(encodePredictClaim(7n), PREDICT_SEL.claim + word(7));
  assert.equal(encodePredictClaimMany([2n, 9n]), PREDICT_SEL.claimMany + word(32) + word(2) + word(2) + word(9));
});

test('quotePredict takes 3% of the losing pool only', () => {
  const quote = quotePredict({ totalWei: 10_000n, poolsWei: [6_000n, 4_000n], outcome: 0, amountWei: 1_000n });
  assert.equal(quote.oddsBps, 6000);
  assert.equal(quote.payoutWei, '1554');
  assert.equal(quotePredict({ totalWei: 10_000n, poolsWei: [6_000n, 4_000n], outcome: 0, amountWei: 0n }).multiplier, '1.646666666666666666');
  assert.throws(() => quotePredict({ totalWei: 1n, poolsWei: [1n, 0n], outcome: 3, amountWei: 1n }), { code: 'INVALID_OUTCOME' });
});

test('marketInfo and poolsOf round-trip', () => {
  const view = {
    kind: 0, outcomes: 2, closeTime: 100n, resolveAfter: 200n, proposedAt: 0n, status: 0,
    proposedOutcome: 0, winningOutcome: 0, maxPool: 0n, total: 10_000n, fee: 0n, metaURI: 'bafy', evidenceURI: '',
  };
  const decoded = decodeMarketView(encodeMarketView(view));
  assert.equal(decoded.metaURI, 'bafy');
  assert.equal(decoded.evidenceURI, '');
  assert.equal(decoded.total, '10000');
  assert.equal(decoded.status, 'open');
  const pools = '0x' + word(32) + word(2) + word(6000) + word(4000);
  assert.deepEqual(decodeUintArray(pools), [6000n, 4000n]);
});
