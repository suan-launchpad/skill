// Offline unit tests for the SUAN Agent Launchpad CLI. Reference vectors come from Foundry's `cast` (calldata, abi-encode,
// keccak, index). Run: node --test 'test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keccak256,
  allowanceSlot,
  encodeBuy,
  encodeSell,
  decodePoolKey,
  encPoolKey,
  decodeLaunchInfo,
  decodeRevert,
  feesFor,
  stageOf,
  formatTime,
  SEL,
  TOPIC,
  ERRORS,
  formatUnits,
  parseUnits,
  word,
  run,
} from '../scripts/suan-launchpad.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';
const KEY = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: A1,
  hooks: A2,
  poolManager: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',
  fee: 0x800000,
  parameters: '0x00000000000000000000000000000000000000000000000000000000000a0055',
};
const KEY_HEX =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000a0ffb9c1ce1fe56963b0321b32e7a0302114058b000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a0055';

test('keccak256 matches known vectors, including rate-boundary lengths', () => {
  assert.equal(keccak256(utf8('')), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(utf8('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256(utf8('a'.repeat(135))), '0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446');
  assert.equal(keccak256(utf8('a'.repeat(136))), '0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e');
  assert.equal(keccak256(utf8('a'.repeat(300))), '0x5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826');
});

test('keccak256 reproduces the router selectors', () => {
  const sig = (s) => keccak256(utf8(s)).slice(0, 10);
  assert.equal(sig('buy((address,address,address,address,uint24,bytes32),uint160,uint256,address)'), '0xb273b616');
  assert.equal(sig('sell((address,address,address,address,uint24,bytes32),uint256,uint256,address)'), '0x2be26629');
  assert.equal(sig('launchInfo(address)'), '0x8025bf9a');
});

test('allowanceSlot matches cast index for an OpenZeppelin v5 _allowances mapping (slot 1)', () => {
  assert.equal(allowanceSlot(A3, '0x4444444444444444444444444444444444444444'), '0x17f481142a3dce23802e68fd332043773d02b475fb509515e2334960f77c21a4');
});

test('encodeBuy matches cast calldata', () => {
  const expected =
    '0xb273b616' + KEY_HEX + '000000000000000000000000000000000000000000000000112210f47de98115' + word(999) + '0000000000000000000000003333333333333333333333333333333333333333';
  assert.equal(encodeBuy(KEY, 1234567890123456789n, 999n, A3), expected);
});

test('encodeSell matches cast calldata', () => {
  const expected = '0x2be26629' + KEY_HEX + '00000000000000000000000000000000000000000000010f0cf064dd59200000' + word(1) + '0000000000000000000000003333333333333333333333333333333333333333';
  assert.equal(encodeSell(KEY, 5000n * 10n ** 18n, 1n, A3), expected);
});

test('PoolKey round-trips', () => {
  assert.deepEqual(decodePoolKey('0x' + encPoolKey(KEY)), KEY);
});

test('decodeLaunchInfo maps the 25 LaunchView words in order', () => {
  // exists, creator, founder, rewards, createBlock, launchTime, aiOnlyUntil, holdCapUntil, taxEnd, buyTax, sellTax,
  // agentBuyTax, agentSellTax, buyTaxNow, sellTaxNow, antiSniperBps, antiSniper, creatorShareToHolders, sqrtPriceX96,
  // protocolFee, liquidity, wFounder, wHolder, wBurn, wLiquidity
  const vals = [1n, BigInt(A1), BigInt(A2), BigInt(A3), 100n, 1000n, 1120n, 4600n, 1297000n, 300n, 200n, 0n, 50n, 300n, 200n, 0n, 1n, 0n, 7n, 300n, 9n, 40n, 30n, 20n, 10n];
  const info = decodeLaunchInfo('0x' + vals.map(word).join(''));
  assert.equal(info.exists, true);
  assert.equal(info.creator, A1);
  assert.equal(info.founder, A2);
  assert.equal(info.rewards, A3);
  assert.equal(info.launchTime, 1000n);
  assert.equal(info.aiOnlyUntil, 1120n);
  assert.equal(info.holdCapUntil, 4600n);
  assert.equal(info.taxEnd, 1297000n);
  assert.equal(info.agentSellTaxBps, 50n);
  assert.equal(info.sellTaxNowBps, 200n);
  assert.equal(info.antiSniper, true);
  assert.equal(info.creatorShareToHolders, false);
  assert.equal(info.sqrtPriceX96, 7n);
  assert.equal(info.liquidity, 9n);
  assert.equal(info.wLiquidity, 10n);
});

test('decodeLaunchInfo: an unknown token decodes as exists = false', () => {
  assert.equal(decodeLaunchInfo('0x' + word(0).repeat(25)).exists, false);
});

test('stageOf follows chain time through the three windows', () => {
  const info = { exists: true, aiOnlyUntil: 1120n, holdCapUntil: 4600n, taxEnd: 1297000n };
  assert.equal(stageOf({ ...info, exists: false }, 0n), 'none');
  assert.equal(stageOf(info, 1000n), 'ai-only');
  assert.equal(stageOf(info, 1120n), 'hold-cap');
  assert.equal(stageOf(info, 4600n), 'taxed');
  assert.equal(stageOf(info, 1297000n), 'open');
  assert.equal(stageOf({ ...info, taxEnd: (1n << 64n) - 1n }, 10n ** 12n), 'taxed', 'a permanent tax period never opens');
});

test('selectors, topics and error codes match cast sig / cast keccak', () => {
  const sig = (s) => keccak256(utf8(s)).slice(0, 10);
  assert.equal(SEL.aiOnlyUntil, sig('aiOnlyUntil()'));
  assert.equal(SEL.holdCapUntil, sig('holdCapUntil()'));
  assert.equal(SEL.taxEnd, sig('taxEnd()'));
  assert.equal(SEL.holdCap, sig('HOLD_CAP()'));
  assert.equal(SEL.poolKeyOf, sig('poolKeyOf(address)'));
  assert.equal(TOPIC.creatorShareToHolders, keccak256(utf8('CreatorShareToHolders(address)')));
  assert.equal(TOPIC.feeTaken, keccak256(utf8('FeeTaken(address,address,bool,uint256,uint256,uint256)')));
  assert.equal(TOPIC.swapped, keccak256(utf8('Swapped(address,address,bool,uint256,uint256,uint160)')));
  const errs = {
    'NotAgent(address)': 'NO_AGENT_ID',
    'HoldCap(address)': 'HOLDING_CAP_REACHED',
    'TransferLocked()': 'TRANSFER_LOCKED',
    'AltPoolBlocked(address)': 'ALT_POOL_BLOCKED',
    'PresaleCap(uint256)': 'PRESALE_CAP',
    'BuybackTooEarly()': 'BUYBACK_TOO_EARLY',
    'NotCreator()': 'NOT_CREATOR',
    'InvalidAiOnly()': 'INVALID_AI_ONLY',
    'InvalidHoldCap()': 'INVALID_HOLD_CAP',
    'InvalidTaxPeriod()': 'INVALID_TAX_PERIOD',
    'UnknownLaunch()': 'UNKNOWN_LAUNCH',
  };
  for (const [s, code] of Object.entries(errs)) assert.equal(ERRORS[sig(s)]?.[0], code, s);
  assert.equal(Object.keys(ERRORS).length, 16);
});

test('decodeLaunchInfo rejects a short answer as a wrong hook', () => {
  assert.throws(() => decodeLaunchInfo('0x'), { code: 'BAD_HOOK' });
});

test('decodeRevert unwraps a token error wrapped by Infinity (HoldCap during take)', () => {
  const wrapped =
    '0x90bfb8650000000000000000000000002222222222222222222222222222222222222222a9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000024bf5283aa0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004f27f64e400000000000000000000000000000000000000000000000000000000';
  assert.equal(decodeRevert(wrapped).code, 'HOLDING_CAP_REACHED');
});

test('decodeRevert reports an unknown wrapped reason with its target', () => {
  const wrapped =
    '0x90bfb8650000000000000000000000002222222222222222222222222222222222222222a9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000004deadbeef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004a9e35b2f00000000000000000000000000000000000000000000000000000000';
  const r = decodeRevert(wrapped);
  assert.equal(r.code, 'WRAPPED_ERROR');
  assert.equal(r.selector, '0xdeadbeef');
});

test('decodeRevert reads PresaleCap, Error(string) and Panic', () => {
  const cap = decodeRevert('0x602a9460' + word(30_000_000n * 10n ** 18n));
  assert.equal(cap.code, 'PRESALE_CAP');
  assert.equal(cap.maxTokens, 30_000_000n * 10n ** 18n);
  assert.equal(
    decodeRevert('0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000006726566756e640000000000000000000000000000000000000000000000000000').message,
    'refund',
  );
  assert.equal(decodeRevert('0x4e487b710000000000000000000000000000000000000000000000000000000000000011').message, 'Solidity panic 0x11');
  assert.equal(decodeRevert('0x').code, 'REVERTED');
});

test('feesFor: 1% trading fee; .ai wallets pay the .ai rate, others the rate in force now', () => {
  const base = { buyTaxBps: 300n, sellTaxBps: 200n, agentBuyTaxBps: 0n, agentSellTaxBps: 50n, antiSniperBps: 0n, protocolFee: 300n | (300n << 12n) };
  const taxed = { ...base, buyTaxNowBps: 300n, sellTaxNowBps: 200n };
  const agent = feesFor(taxed, { hasAgentId: true });
  assert.equal(agent.baseFeeBps, 100n);
  assert.equal(agent.buyTotalBps, 100n);
  assert.equal(agent.sellTotalBps, 150n);
  const outsider = feesFor(taxed, { hasAgentId: false });
  assert.equal(outsider.buyTotalBps, 400n);
  assert.equal(outsider.sellTotalBps, 300n);
  assert.equal(outsider.pancakeProtocolFeePips.sell, 300n);
  const open = feesFor({ ...base, buyTaxNowBps: 0n, sellTaxNowBps: 50n }, { hasAgentId: false });
  assert.equal(open.buyTotalBps, 100n, 'after the tax period everyone pays the .ai rate');
  assert.equal(open.sellTotalBps, 150n);
  assert.equal(feesFor({ ...taxed, antiSniperBps: 900n }, { hasAgentId: true }).buyTotalBps, 1000n, 'anti-sniper on buys only');
});

test('formatTime: a date, or permanent', () => {
  assert.equal(formatTime(0n), null);
  assert.equal(formatTime(1_700_000_000n), '2023-11-14T22:13:20.000Z');
  assert.equal(formatTime((1n << 64n) - 1n), 'permanent');
});

test('parseUnits / formatUnits', () => {
  assert.equal(parseUnits('0.05'), 5n * 10n ** 16n);
  assert.equal(parseUnits('12'), 12n * 10n ** 18n);
  assert.equal(formatUnits(1234500000000000000n), '1.2345');
  assert.equal(formatUnits(0n), '0');
  assert.throws(() => parseUnits('-1'), { code: 'INVALID_PARAM' });
  assert.throws(() => parseUnits('1e18'), { code: 'INVALID_PARAM' });
  assert.throws(() => parseUnits('0.' + '1'.repeat(19)), { code: 'INVALID_PARAM' });
});

test('commands validate params before touching the network', async () => {
  await assert.rejects(run('nope', {}), { code: 'UNKNOWN_COMMAND' });
  await assert.rejects(run('info', { token: A1, hook: 'abc' }), { code: 'INVALID_PARAM' }); // malformed hook
  await assert.rejects(run('info', { token: 'abc', hook: A2, router: A3 }), { code: 'INVALID_PARAM' });
  await assert.rejects(run('receipt', { txHash: '0x12' }), { code: 'INVALID_PARAM' });
});
