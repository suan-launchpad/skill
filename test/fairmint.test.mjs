import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from '../scripts/suan-launchpad.mjs';
import {
  FM_SEL,
  costOf,
  createFairmintCommands,
  encodeClaim,
  encodeCreate,
  encodeMint,
  encodeRouterBuy,
  launchPreview,
  priceAt,
  quoteBuy,
  quoteSell,
  tokensPerShare,
  validateParams,
  walletCap,
  zeroTax,
} from '../scripts/fairmint.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const sig = (s) => keccak256(utf8(s)).slice(0, 10);
const ETHER = 10n ** 18n;
const TIERS = [
  { upTo: 600n, price: ETHER / 1000n },
  { upTo: 1000n, price: ETHER / 500n },
];
const NOW = 1_700_000_000n;

function params(over = {}) {
  return {
    name: 'Fair Agent',
    symbol: 'FAIR',
    meta: 'bafy-meta',
    tiers: TIERS,
    maxShares: 1_000n,
    targetShares: 300n,
    deadline: NOW + 86_400n,
    perWallet: 100n,
    inviteBonus: 0n,
    maxInviteBonus: 0n,
    creatorBnbBps: 1_000n,
    creatorTokenBps: 300n,
    vestingSeconds: 30n * 86_400n,
    ...over,
  };
}

test('fairmint selectors match keccak of the contract signatures', () => {
  assert.equal(FM_SEL.mint, sig('mint(uint64,address)'));
  assert.equal(FM_SEL.claim, sig('claim(address[])'));
  assert.equal(FM_SEL.refund, sig('refund()'));
  assert.equal(FM_SEL.buy, sig('buy(address,uint256,address,uint256)'));
  assert.equal(FM_SEL.sell, sig('sell(address,uint256,uint256,address,uint256)'));
  assert.equal(FM_SEL.v2Buy, sig('swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)'));
  assert.equal(FM_SEL.v2Sell, sig('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'));
});

test('pricing matches the numbers asserted in FairMint.t.sol', () => {
  assert.equal(costOf(TIERS, 550n, 100n), 50n * (ETHER / 1000n) + 50n * (ETHER / 500n));
  assert.equal(priceAt(TIERS, 700n), ETHER / 500n);
  assert.equal(tokensPerShare(1_000n, 300n), (1_000_000_000n * ETHER - 30_000_000n * ETHER) / 2_000n);
  assert.equal(walletCap(10n, 6n, 4n), 14n);
  const preview = launchPreview(params(), 1_000n);
  const raised = 600n * (ETHER / 1000n) + 400n * (ETHER / 500n);
  assert.equal(preview.raised, raised);
  assert.equal(preview.fee, (raised * 200n) / 10_000n);
  assert.equal(preview.lpBnb, raised - preview.fee - (raised * 1_000n) / 10_000n);
  const perShare = (preview.lpBnb * tokensPerShare(1_000n, 300n)) / preview.lpTokens;
  assert.ok(perShare + 1n >= ETHER / 500n);
  assert.ok(perShare <= ETHER / 500n + 1_000_000n);
});

test('validateParams uses the factory reasons', () => {
  assert.equal(validateParams(params(), NOW), null);
  assert.equal(validateParams(params({ targetShares: 100n }), NOW), 'targetShares');
  assert.equal(validateParams(params({ tiers: [TIERS[0], { upTo: 1_000n, price: ETHER / 2_000n }] }), NOW), 'tier price');
  assert.equal(validateParams(params({ creatorBnbBps: 1_600n }), NOW), 'creatorBnbBps');
  assert.equal(validateParams(params({ deadline: NOW + 15n * 86_400n }), NOW), 'deadline');
});

test('token tax uses the caller rate and the factory reasons', () => {
  const taxed = { buyBps: 300n, sellBps: 500n, agentBuyBps: 100n, agentSellBps: 200n, burnShareBps: 5_000n, duration: 10n * 86_400n };
  assert.equal(validateParams(params(), NOW), null);
  assert.equal(validateParams(params({ tax: { ...taxed, buyBps: 600n } }), NOW), 'tax');
  assert.equal(validateParams(params({ tax: { ...taxed, buyBps: 300n, sellBps: 300n, agentBuyBps: 400n } }), NOW), 'agent tax');
  assert.equal(validateParams(params({ tax: { buyBps: 300n, sellBps: 300n, agentBuyBps: 0n, agentSellBps: 0n, burnShareBps: 0n, duration: 3_600n } }), NOW), 'taxDuration');
  assert.equal(validateParams(params({ tax: { buyBps: 300n, sellBps: 300n, agentBuyBps: 0n, agentSellBps: 0n, burnShareBps: 0n, duration: (1n << 32n) - 1n } }), NOW), null);
  assert.equal(validateParams(params({ tax: { ...zeroTax(), duration: 10n * 86_400n } }), NOW), 'taxDuration');
  const reserves = { reserveBnb: 10_000n * ETHER, reserveToken: 1_000_000n * ETHER };
  const amount = 1_000n * ETHER;
  const agent = quoteSell(reserves, amount, taxed, true);
  assert.equal(agent.tax, (amount * 200n) / 10_000n);
  assert.equal(agent.platform, agent.tax / 10n);
  assert.equal(quoteSell(reserves, amount, taxed, false).taxBps, 500n);
  assert.equal(quoteBuy(reserves, ETHER / 10n, taxed, true).taxBps, 100n);
  assert.equal(quoteBuy(reserves, ETHER / 10n, taxed, false).taxBps, 300n);
});

test('router quotes take 1% and then the V2 0.25% fee', () => {
  const reserves = { reserveBnb: 10_000n * ETHER, reserveToken: 1_000_000n * ETHER };
  const buy = quoteBuy(reserves, ETHER / 10n);
  assert.equal(buy.fee, ETHER / 1_000n);
  const withFee = buy.poolIn * 9975n;
  assert.equal(buy.amountOut, (withFee * reserves.reserveToken) / (reserves.reserveBnb * 10_000n + withFee));
  const sell = quoteSell(reserves, 1_000n * ETHER);
  assert.equal(sell.fee, sell.gross / 100n);
  assert.equal(sell.amountOut, sell.gross - sell.fee);
});

test('calldata matches cast', () => {
  assert.equal(
    encodeMint(100n, '0x1111111111111111111111111111111111111111'),
    '0x17deeba000000000000000000000000000000000000000000000000000000000000000640000000000000000000000001111111111111111111111111111111111111111',
  );
  assert.equal(
    encodeClaim(['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222']),
    '0x318d9e5d0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222',
  );
  const created = encodeCreate({
    name: 'Fair Agent',
    symbol: 'FAIR',
    meta: 'bafy-meta',
    tiers: [
      { upTo: 600n, price: 1_000_000_000_000_000n },
      { upTo: 1_000n, price: 2_000_000_000_000_000n },
    ],
    maxShares: 1_000n,
    targetShares: 300n,
    deadline: 1_700_000_000n,
    perWallet: 100n,
    inviteBonus: 1n,
    maxInviteBonus: 4n,
    creatorBnbBps: 1_000n,
    creatorTokenBps: 300n,
    vestingSeconds: 2_592_000n,
  });
  assert.equal(
    created,
    '0x0e2a82b00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000032000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000012c000000000000000000000000000000000000000000000000000000006553f10000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000012c0000000000000000000000000000000000000000000000000000000000278d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a46616972204167656e7400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000446414952000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009626166792d6d65746100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000025800000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000071afd498d0000',
  );
  assert.match(encodeRouterBuy('0x2222222222222222222222222222222222222222', 1n, '0x3333333333333333333333333333333333333333', 99n), /^0xb3ffb760/);
});

test('mint-create rejects bad params before any RPC and never reads a key', async () => {
  let rpc = false;
  const commands = createFairmintCommands({
    fail: (code, message) => Object.assign(new Error(message), { code }),
    txEntry: () => { throw new Error('tx'); },
    call: () => { rpc = true; throw new Error('rpc'); },
    makeRpc: () => { rpc = true; throw new Error('rpc'); },
    ADDR_RE: /^0x[0-9a-fA-F]{40}$/,
    defaultRpcs: [],
    defaultSlippageBps: 1000,
    agentId: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
    wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    readFile: (path) => readFileSync(path, 'utf8'),
  });
  const dir = mkdtempSync(join(tmpdir(), 'fm-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, JSON.stringify({
    name: 'Fair Agent', symbol: 'FAIR', meta: 'bafy-meta',
    tiers: [{ upTo: '600', price: '1000000000000000' }, { upTo: '1000', price: '2000000000000000' }],
    maxShares: '1000', targetShares: '100', deadline: String(NOW + 86_400n), perWallet: '100',
    inviteBonus: '0', maxInviteBonus: '0', creatorBnbBps: '1000', creatorTokenBps: '300', vestingSeconds: String(30n * 86_400n),
  }));
  await assert.rejects(commands['mint-create']({ paramsFile: file, wallet: '0x1111111111111111111111111111111111111111', nowSec: String(NOW) }), { code: 'BAD_PARAMS', message: 'targetShares' });
  assert.equal(rpc, false);
  const taxed = join(dir, 'tax.json');
  writeFileSync(taxed, JSON.stringify({
    name: 'Fair Agent', symbol: 'FAIR', meta: 'bafy-meta',
    tiers: [{ upTo: '1000', price: '0.001' }],
    maxShares: '1000', targetShares: '300', deadline: String(NOW + 86_400n), perWallet: '100',
    tax: { buyBps: '600', sellBps: '0', agentBuyBps: '0', agentSellBps: '0', burnShareBps: '0', duration: String(10n * 86_400n) },
  }));
  await assert.rejects(commands['mint-create']({ paramsFile: taxed, wallet: '0x1111111111111111111111111111111111111111', nowSec: String(NOW) }), { code: 'BAD_PARAMS', message: 'tax' });
  assert.equal(rpc, false);
});

test('fm-sell uses the agent rate and slippage on the BNB after tax', async () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const token = '0x2222222222222222222222222222222222222222';
  const pair = '0x3333333333333333333333333333333333333333';
  const router = '0x4444444444444444444444444444444444444444';
  const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  const reserveBnb = 10_000n * ETHER;
  const reserveToken = 1_000_000n * ETHER;
  const wordOf = (v) => BigInt(v).toString(16).padStart(64, '0');
  const ret = (n) => '0x' + wordOf(n);
  const commands = createFairmintCommands({
    fail: (code, message) => Object.assign(new Error(message), { code }),
    txEntry: (name, from, tx) => ({ name, from, ...tx }),
    call: async (_rpc, _to, data) => {
      const sel = data.slice(0, 10);
      if (sel === '0xe6a43905') return '0x' + pair.slice(2).padStart(64, '0');
      if (sel === FM_SEL.getReserves) return '0x' + wordOf(reserveBnb) + wordOf(reserveToken) + wordOf(0);
      if (sel === FM_SEL.token0) return '0x' + wbnb.slice(2).padStart(64, '0');
      if (sel === FM_SEL.buyTaxBps) return ret(300);
      if (sel === FM_SEL.sellTaxBps) return ret(500);
      if (sel === FM_SEL.agentBuyTaxBps) return ret(100);
      if (sel === FM_SEL.agentSellTaxBps) return ret(200);
      if (sel === FM_SEL.burnShareBps) return ret(5_000);
      if (sel === FM_SEL.taxEndsAt) return ret(2_000_000_000n);
      if (sel === FM_SEL.balanceOf) return ret(1);
      throw new Error(`unexpected ${sel}`);
    },
    makeRpc: () => async (method) => {
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_700_000_000).toString(16) };
      throw new Error(method);
    },
    ADDR_RE: /^0x[0-9a-fA-F]{40}$/,
    defaultRpcs: [],
    defaultSlippageBps: 1_000,
    agentId: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
    wbnb,
    v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    readFile: () => { throw new Error('file'); },
  });
  const amount = 1_000n * ETHER;
  const sold = await commands['fm-sell']({ token, wallet, router, amount: amount.toString() });
  const quoted = quoteSell(
    { reserveBnb, reserveToken },
    amount,
    { buyBps: 300n, sellBps: 500n, agentBuyBps: 100n, agentSellBps: 200n, burnShareBps: 5_000n, duration: 0n },
    true,
  );
  assert.equal(sold.isAgent, true);
  assert.equal(sold.taxBps, '200');
  assert.equal(sold.taxWei, quoted.tax.toString());
  assert.equal(sold.platformWei, (quoted.tax / 10n).toString());
  assert.equal(sold.bnbOutWei, quoted.amountOut.toString());
  assert.equal(sold.minOutWei, ((quoted.amountOut * 9_000n) / 10_000n).toString());
  assert.match(sold.transactions[1].inputData, new RegExp(sold.minOutWei === '0' ? 'nope' : wordOf(sold.minOutWei)));
});
