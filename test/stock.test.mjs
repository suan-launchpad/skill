// Offline unit tests for the stock-meme commands of the SUAN Agent Launchpad CLI. Reference vectors come from Foundry's
// `cast` (calldata, sig, index). Run: node --test 'skill/suan-launchpad/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keccak256,
  allowanceSlotAt,
  decodePoolKey,
  decodeStockLaunchInfo,
  encodeBnbToBase,
  encodeBuyWithBnb,
  encodeQuoteExactInput,
  encodeSellForBnb,
  encodeStockBuy,
  encodeStockCreate,
  encodeV3Path,
  encPoolKey,
  ERRORS,
  routesFromBnb,
  routesToBnb,
  run,
  SEL,
  STOCK_BASES,
  stockBaseOf,
  stockCreateParams,
  stockPriceWad,
  usdWadFromV3Sqrt,
  WBNB,
  word,
} from '../scripts/suan-launchpad.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const sig = (s) => keccak256(utf8(s)).slice(0, 10);
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';
const NVDAB = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const KEY = {
  currency0: A1,
  currency1: NVDAB,
  hooks: A2,
  poolManager: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',
  fee: 0x800000,
  parameters: '0x00000000000000000000000000000000000000000000000000000000000a0055',
};
const KEY_HEX =
  '000000000000000000000000111111111111111111111111111111111111111100000000000000000000000002fca66c1d1afb4e2a7884261eb00f63598a74360000000000000000000000002222222222222222222222222222222222222222000000000000000000000000a0ffb9c1ce1fe56963b0321b32e7a0302114058b000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a0055';
// WBNB -100- USDT -2500- NVDAB (cast concat-hex)
const PATH = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00006455d398326f99059ff775485246999027b31979550009c402fca66c1d1afb4e2a7884261eb00f63598a7436';
const PATH_TAIL = '0000000000000000000000000000000000000000000000000000000000000042' + PATH.slice(2) + '0'.repeat(60);
const R = '000000000000000000000000' + A3.slice(2);

test('stock selectors match cast sig', () => {
  const K = '(address,address,address,address,uint24,bytes32)';
  assert.equal(SEL.baseOf, sig('baseOf(address)'));
  assert.equal(SEL.stockBuy, sig(`buy(${K},uint256,uint256,address)`));
  assert.equal(SEL.buyWithBnb, sig(`buyWithBnb(${K},bytes,uint256,uint256,address)`));
  assert.equal(SEL.sellForBnb, sig(`sellForBnb(${K},uint256,bytes,uint256,address)`));
  assert.equal(SEL.bnbToBase, sig('bnbToBase(bytes,address,uint256,address)'));
  assert.equal(SEL.quoteExactInput, sig('quoteExactInput(bytes,uint256)'));
  assert.equal(SEL.stockCreate, sig('create((address,uint256,string,string,string,address,uint16,uint16,uint16,uint16,uint8,uint8,uint8,uint8,uint256,bool,bool,uint64,uint64,uint64))'));
  assert.equal(SEL.startAmountOf, sig('startAmountOf(address)'));
  assert.equal(SEL.uiMultiplier, sig('uiMultiplier()'));
  assert.equal(SEL.pending, sig('pending(address)'));
  assert.equal(SEL.claim, sig('claim()'));
  for (const [s, code] of Object.entries({ 'BaseNotAllowed(address)': 'BASE_NOT_ALLOWED', 'InvalidPath()': 'INVALID_PATH', 'UnknownPool()': 'UNKNOWN_POOL', 'LaunchesClosed()': 'LAUNCHES_CLOSED' })) {
    assert.equal(ERRORS[sig(s)]?.[0], code, s);
  }
});

test('encodeV3Path matches cast concat-hex; routes go direct or via USDT', () => {
  const nvdab = stockBaseOf('NVDAB');
  const [direct, viaUsdt] = routesFromBnb(nvdab);
  assert.equal(encodeV3Path(viaUsdt.tokens, viaUsdt.fees), PATH);
  assert.equal(encodeV3Path(direct.tokens, direct.fees), WBNB + '0009c4' + NVDAB.slice(2));
  assert.equal(routesFromBnb(stockBaseOf('CRCLB')).length, 1, 'no direct WBNB pool for CRCLB');
  const [back] = routesToBnb(nvdab);
  assert.equal(back.tokens[0], NVDAB);
  assert.equal(back.tokens.at(-1), WBNB);
  assert.throws(() => encodeV3Path([WBNB], []), { code: 'INVALID_PATH' });
});

test('stock router calldata matches cast calldata', () => {
  assert.equal(encodeStockBuy(KEY, 1000n, 999n, A3), '0x79002279' + KEY_HEX + word(1000) + word(999) + R);
  assert.equal(encodeBuyWithBnb(KEY, PATH, 77n, 999n, A3), '0xae40bdea' + KEY_HEX + word(320) + word(77) + word(999) + R + PATH_TAIL);
  assert.equal(encodeSellForBnb(KEY, 5000n * 10n ** 18n, PATH, 1n, A3), '0xca08e600' + KEY_HEX + '00000000000000000000000000000000000000000000010f0cf064dd59200000' + word(320) + word(1) + R + PATH_TAIL);
  assert.equal(encodeBnbToBase(PATH, NVDAB, 42n, A3), '0x79e9643f' + word(128) + '000000000000000000000000' + NVDAB.slice(2) + word(42) + R + PATH_TAIL);
  assert.equal(encodeQuoteExactInput(PATH, 10n ** 18n), '0xcdca1753' + word(64) + word(10n ** 18n) + PATH_TAIL);
});

test('encodeStockCreate matches cast calldata for the dynamic CreateParams tuple', () => {
  const expected =
    '0x48ddd866000000000000000000000000000000000000000000000000000000000000002000000000000000000000000002fca66c1d1afb4e2a7884261eb00f63598a743600000000000000000000000000000000000000000000000014d1120d7b160000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012c000000000000000000000000000000000000000000000000000000000000012c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000021e19e0c9bab24000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000780000000000000000000000000000000000000000000000000000000000000e10000000000000000000000000000000000000000000000000000000000013c680000000000000000000000000000000000000000000000000000000000000000b4e7669646961204d656d6500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064e564d454d45000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000116261666b7265696578616d706c65636964000000000000000000000000000000';
  const c = stockCreateParams({ name: 'Nvidia Meme', symbol: 'NVMEME', meta: 'bafkreiexamplecid', presaleAmount: '1.5' }, stockBaseOf('nvdab'), A3);
  assert.equal(encodeStockCreate(c), expected);
  assert.equal(c.buyTaxBps, 300n, 'normal rate = .ai rate + 3 points');
  assert.equal(stockCreateParams({ name: 'x', symbol: 'X', taxDays: 'permanent' }, stockBaseOf('nvdab'), A3).taxSeconds, (1n << 64n) - 1n);
  assert.throws(() => stockCreateParams({ symbol: 'X' }, stockBaseOf('nvdab'), A3), { code: 'INVALID_PARAM' });
});

test('allowanceSlotAt matches cast index for the OpenZeppelin upgradeable ERC20 namespace', () => {
  assert.equal(
    allowanceSlotAt(A3, '0x4444444444444444444444444444444444444444', 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace01n),
    '0xb8e0ce898f86981d322c96886a780d2a960ef7313d823ee7c1a552bf4e100f27',
  );
});

test('decodeStockLaunchInfo maps the 27 words, with base and orientation after exists', () => {
  const vals = [1n, BigInt(NVDAB), 1n, BigInt(A1), BigInt(A2), BigInt(A3), 100n, 1000n, 1120n, 4600n, 1297000n, 300n, 300n, 0n, 0n, 300n, 300n, 0n, 1n, 0n, 7n, 0n, 9n, 40n, 30n, 20n, 10n];
  const info = decodeStockLaunchInfo('0x' + vals.map(word).join(''));
  assert.equal(info.base, NVDAB);
  assert.equal(info.memeIsCurrency0, true);
  assert.equal(info.creator, A1);
  assert.equal(info.rewards, A3);
  assert.equal(info.taxEnd, 1297000n);
  assert.equal(info.sqrtPriceX96, 7n);
  assert.equal(info.wLiquidity, 10n);
  assert.throws(() => decodeStockLaunchInfo('0x' + word(0).repeat(25)), { code: 'BAD_HOOK' });
});

test('prices: meme in base for both orientations, base in USD from its USDT pool', () => {
  const Q96 = 1n << 96n;
  assert.equal(stockPriceWad(Q96 * 1000n, false), 10n ** 12n, '1e6 meme per base');
  assert.equal(stockPriceWad(Q96 >> 10n, true), 10n ** 18n >> 20n, 'base per meme when the meme is currency0');
  const sqrt200 = 1120455419495722798374638764549n; // sqrt(200) * 2^96
  assert.equal(usdWadFromV3Sqrt(sqrt200, NVDAB) / 10n ** 10n, 19_999_999_999n, 'NVDAB sorts before USDT');
});

test('base table: eight bases, lookup by symbol or address', () => {
  assert.equal(STOCK_BASES.length, 8);
  assert.equal(stockBaseOf('nvdab').address, NVDAB);
  assert.equal(stockBaseOf(NVDAB.toUpperCase().replace('0X', '0x')).symbol, 'NVDAB');
  assert.equal(decodePoolKey('0x' + encPoolKey(KEY)).currency1, NVDAB);
});

test('stock commands validate params before the network', async () => {
  await assert.rejects(run('quote-bnb-to-base', { stockRouter: A2, base: 'XYZ', wallet: A3, amount: '0.1' }), { code: 'UNKNOWN_BASE' });
  await assert.rejects(run('build-create', { stockFactory: A2, base: 'NVDAB' }), { code: 'INVALID_PARAM' });
  await assert.rejects(run('info', { token: A1, stockHook: 'nope' }), { code: 'INVALID_PARAM' });
});
