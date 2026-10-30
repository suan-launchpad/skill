#!/usr/bin/env node
// SUAN Agent Launchpad CLI — check, quote and build calldata for SUAN Agent Launchpad tokens (.ai Agent ID launches on a
// PancakeSwap Infinity hook pool, BSC). Self-contained, zero-dep, Node >= 22. Read-only: it only runs eth_call /
// eth_getBalance / eth_getTransactionReceipt against a BSC node. It never signs or broadcasts — the built
// transaction is executed with `baw contract-call preview` / `execute` (Developer Mode).
//
// Usage: node suan-launchpad.mjs <command> '<json_params>'
//
// Commands:
//   info               Stage (.ai window / hold-cap window / tax period / open), its end times, fees for this wallet,
//                      hold-cap room; for stock memes also the paired bStock, its price and the meme price in it
//   quote-buy          Simulate a buy through the router and build its calldata (stock memes: pay BNB or the bStock)
//   quote-sell         Simulate a token sell through the router and build its calldata (+ approve if needed)
//                      (stock memes: receive BNB or the bStock)
//   receipt            Check a submitted transaction and decode its fee and transfer events
//   bases              Stock memes: the bStocks new launches can pair with (factory allowlist)
//   quote-bnb-to-base  Stock memes: swap BNB to a bStock through the stock router (e.g. to fund a presale)
//   build-create       Stock memes: build the launch (approve the factory for the presale + create)
//   claim-rewards      Holder rewards (BNB, or the bStock for stock memes): pending amount and the claim call
//
// Stock memes are launches paired with an allowlisted bStock instead of BNB. They have their own hook, router and
// factory (`stockHook`, `stockRouter`, `stockFactory` params or SUAN_STOCK_HOOK / SUAN_STOCK_ROUTER /
// SUAN_STOCK_FACTORY). A token is a stock meme when `stockHook.baseOf(token)` is non-zero; the commands detect it.
//
// Quotes are exact simulations of the real swap (router -> Infinity Vault -> hook), run as `eth_call` from the
// wallet so the hook sees the same identity (`tx.origin`) as the real trade.
//
// Addresses: `hook` and `router` params, or SUAN_LAUNCHPAD_HOOK / SUAN_LAUNCHPAD_ROUTER, else the mainnet deployment. RPC: `rpc` param, BSC_RPC_URL, or the
// public BSC endpoints below.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFairmintCommands } from './fairmint.mjs';

// ---- constants ----
/** Per-request RPC timeout; SUAN_RPC_TIMEOUT_MS raises it (a fresh local fork fetches state slowly). */
const TIMEOUT_MS = Number(process.env.SUAN_RPC_TIMEOUT_MS) > 0 ? Number(process.env.SUAN_RPC_TIMEOUT_MS) : 15_000;
const CHAIN_ID = '56';
/** The SUAN Agent Launchpad on BSC mainnet, published on launch.suan.bid. */
const MAINNET = { hook: '0xa8E32E5Bc1d3Ce8aFe6bf3ef2069F1Fc7171c061', router: '0x119dCa55DCbB37998E9bA0845196acc0FFf2FAc2' };
/** The stock-meme launchpad on BSC mainnet: not deployed yet, so it must come from params or env until then. */
const MAINNET_STOCK = { hook: '0x6ddE8C213f0fA67cDB9546bB0de5ef595185c196', router: '0xCFA7D82BfB4Ed21aDaCFC36287b7031264ec9314', factory: '0x55e1c1914D5e11a37Cd10deDF327E56F04ba979C' };
const DEFAULT_RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org', 'https://bsc-dataseed.defibit.io'];
export const AGENT_ID_NFT = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f'; // SPACE ID Agent ID (.ai), non-transferable
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BPS = 10_000n;
const DEFAULT_SLIPPAGE_BPS = 1_000n; // 10%
const ALLOWANCE_SLOT = 1n; // OpenZeppelin ERC20 v5: _balances = 0, _allowances = 1

// PancakeSwap V3: the BNB <-> bStock legs of stock-meme trades.
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const USDT = '0x55d398326f99059ff775485246999027b3197955';
export const V3_QUOTER = '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997'; // QuoterV2: quoteExactInput, simulated
export const USDT_WBNB_FEE = 100; // the deepest USDT/WBNB V3 pool; every via-USDT route goes through it
/**
 * The first batch of bStock bases (Binance-issued tokenized shares, 18 decimals). Fee tiers are the deepest
 * PancakeSwap V3 pools (measured 2026-10-29); quotes compare the routes at run time and take the better one.
 * `wbnbFee: null` = no direct WBNB pool worth routing through. `usdtPool` gives the USD price.
 */
export const STOCK_BASES = [
  { symbol: 'NVDAB', name: 'NVIDIA', address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', usdtFee: 2500, usdtPool: '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', wbnbFee: 2500 },
  { symbol: 'SPCXB', name: 'SpaceX', address: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', usdtFee: 2500, usdtPool: '0x977daffc095b33872e2741c19568925015c35b4d', wbnbFee: 2500 },
  { symbol: 'BNCB', name: 'CEA Industries', address: '0x4902c5ebc598265ed2212b559b042de8a5eeec3f', usdtFee: 2500, usdtPool: '0x32c51041f3d7a66ac14aba7485444efb6e15efe1', wbnbFee: 2500 },
  { symbol: 'TSLAB', name: 'Tesla', address: '0x5b1910eaad6450e50f816082aa078c41f10c292f', usdtFee: 2500, usdtPool: '0xb0f5e5400e8f0f7c242f2b7740c004f020579c41', wbnbFee: 2500 },
  { symbol: 'QQQB', name: 'Invesco QQQ', address: '0x205812cdbed920aff76c6580abd681a46d11efc7', usdtFee: 100, usdtPool: '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693', wbnbFee: 500 },
  { symbol: 'SKHYB', name: 'SK hynix', address: '0xca750ef65f295bbecd685abf54e82caf297bdb61', usdtFee: 2500, usdtPool: '0xd7d30f434b12f7ed9b0ae11ff1c754745a10ad52', wbnbFee: 2500 },
  { symbol: 'AAPLB', name: 'Apple', address: '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a', usdtFee: 2500, usdtPool: '0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365', wbnbFee: 2500 },
  { symbol: 'CRCLB', name: 'Circle', address: '0x80f3d493ebce97e343c53d29a137942416b4ffc0', usdtFee: 2500, usdtPool: '0x29967c54c5bf12e8158c8894376064b30ebab297', wbnbFee: null },
];
/** A base by address or symbol (case-insensitive), or undefined. */
export const stockBaseOf = (x) => {
  const k = String(x ?? '').trim().toLowerCase();
  return STOCK_BASES.find((b) => b.address === k || b.symbol.toLowerCase() === k);
};

export const BASE_FEE_BPS = 100n; // 1% on every trade: 0.5% buys back and burns $SUAN + 0.5% creator (or holders)
export const PERMANENT = (1n << 64n) - 1n; // `taxEnd` of a launch whose tax period never ends

/**
 * Where a launch is, by chain time since launch (every token trades in its one pool from the first block):
 * - `ai-only`: only .ai Agent ID wallets can buy; the token only moves between the pool and .ai wallets (the creator
 *   may also sell);
 * - `hold-cap`: anyone can buy; no address may hold more than 1% of the supply;
 * - `taxed`: .ai wallets pay the .ai rate, others the normal rate; alternative pools are refused;
 * - `open`: the tax period is over; everyone pays the .ai rate and the token may trade anywhere.
 */
export const STAGES = ['none', 'ai-only', 'hold-cap', 'taxed', 'open'];

/** @param nowSec the latest block's timestamp (chain time, not the local clock) */
export function stageOf(info, nowSec) {
  if (!info.exists) return 'none';
  if (nowSec < info.aiOnlyUntil) return 'ai-only';
  if (nowSec < info.holdCapUntil) return 'hold-cap';
  if (nowSec < info.taxEnd) return 'taxed';
  return 'open';
}

export const SEL = {
  launchInfo: '0x8025bf9a',
  poolKeyOf: '0x8652edf9',
  buy: '0xb273b616',
  sell: '0x2be26629',
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
  holdCap: '0x92a4ef32',
  aiOnlyUntil: '0xd95affd5',
  holdCapUntil: '0xea8012b7',
  taxEnd: '0x672a2047',
  symbol: '0x95d89b41',
  rewards: '0x9ec5a894',
  pending: '0x5eebea20',
  claim: '0x4e71d92d',
  // stock memes
  baseOf: '0x23d7b2bc',
  stockBuy: '0x79002279',
  buyWithBnb: '0xae40bdea',
  sellForBnb: '0xca08e600',
  bnbToBase: '0x79e9643f',
  stockCreate: '0x48ddd866',
  launchFee: '0xcf3cf573',
  launchesOpen: '0xdb8bf629',
  startAmountOf: '0xda448f4e',
  quoteExactInput: '0xcdca1753',
  uiMultiplier: '0xa60bf13d',
  slot0: '0x3850c7bd',
};

export const TOPIC = {
  feeTaken: '0x3a1b1562be12b3a218e6bc25a1991d3ceaa8c13b4e904cba7085026416c5fa3b',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  creatorShareToHolders: '0x6d501f87a96491ee759a8c23656a5ac1a4a86c4197167ed55b8576b622e9bfb6',
  swapped: '0xdcabf9061abe380499acc5e5979da8508252dd99b27ab4eca593bf435da8c523',
};

/** Custom errors of the hook, token and router, plus the wrappers PancakeSwap Infinity puts around them. */
export const ERRORS = {
  '0x52f49c95': ['NO_AGENT_ID', 'During the .ai window only wallets holding a .ai Agent ID can buy (and only .ai wallets or the creator can sell)'],
  '0xbf5283aa': ['HOLDING_CAP_REACHED', 'During the hold-cap window no wallet may hold more than 1% of the supply (10,000,000 tokens)'],
  '0x2b36b061': ['TRANSFER_LOCKED', 'During the .ai window tokens only move between the pool and .ai wallets'],
  '0x2e68be39': ['ALT_POOL_BLOCKED', 'During the tax period the token only trades in its own pool'],
  '0x4704aaf8': ['SLIPPAGE', 'Output below the minimum — the price moved'],
  '0xf6806bf8': ['UNKNOWN_LAUNCH', 'This token was not launched through SUAN Agent Launchpad'],
  '0x8edaf477': ['ROUTER_MISMATCH', 'The router reports a different sender than the transaction origin'],
  '0xf7ebfa18': ['EXACT_OUTPUT_UNSUPPORTED', 'Only exact-input swaps are supported'],
  '0xe450d38c': ['INSUFFICIENT_TOKEN_BALANCE', 'The wallet does not hold that many tokens'],
  '0xfb8f41b2': ['INSUFFICIENT_ALLOWANCE', 'Approve the router first'],
  '0x602a9460': ['PRESALE_CAP', 'The creator presale buys at most 3% of the supply'],
  '0xd4c57ec4': ['BUYBACK_TOO_EARLY', 'Buybacks start after the .ai window'],
  '0x93687c0b': ['NOT_CREATOR', 'Only the token creator can do this'],
  '0x9dba2911': ['INVALID_AI_ONLY', 'The .ai window must be 2–30 minutes'],
  '0x99dda1c8': ['INVALID_HOLD_CAP', 'The hold-cap window must be at least the .ai window and at most 24 hours'],
  '0xbdd72a6b': ['INVALID_TAX_PERIOD', 'The tax period must be 15–365 days, or permanent'],
  // stock memes (factory, router)
  '0x4fbfadb9': ['BASE_NOT_ALLOWED', 'This bStock is not allowlisted for new launches (see the `bases` command)'],
  '0x20db8267': ['INVALID_PATH', 'The PancakeSwap V3 path does not start and end at the right tokens'],
  '0xf7139e33': ['UNKNOWN_POOL', 'This pool key is not a stock-meme pool'],
  '0x6f9f068c': ['LAUNCHES_CLOSED', 'Creation is not open to everyone yet'],
  '0xa4082532': ['LAUNCH_FEE_REQUIRED', 'Send exactly the launch fee'],
  '0x84677ce8': ['INVALID_WEIGHTS', 'Tax weights must sum to 100 when taxed, 0 otherwise'],
  '0x37d4ed5b': ['INVALID_TAX', 'The normal rate must be the .ai rate + 3 points, at most 10%'],
  '0x12b3f9a7': ['INVALID_MIN_SHARE', 'The holder-rewards minimum must be at least 10,000 tokens'],
  '0x8bb27af0': ['INVALID_META', 'The meta CID must be at most 128 bytes'],
};
const WRAPPED_ERROR = '0x90bfb865'; // CustomRevert.WrappedError(address target, bytes4 selector, bytes reason, bytes details)
const ERROR_STRING = '0x08c379a0'; // Error(string)
const PANIC = '0x4e487b71'; // Panic(uint256)

// ---- keccak-256 (for storage slots in state overrides) ----
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
    }
    const b = new Array(25);
    for (let i = 0; i < 25; i++) b[PI[i]] = rotl(s[i], ROT[i]);
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[y + x] = b[y + x] ^ (~b[y + ((x + 1) % 5)] & M64 & b[y + ((x + 2) % 5)]);
    }
    s[0] ^= RC[round];
  }
}

/** @param {Uint8Array} bytes @returns {string} 0x-prefixed hash */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let hex = '';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) hex += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, '0');
  return '0x' + hex;
}

/** Storage slot of `_allowances[owner][spender]` in an OpenZeppelin v5 ERC20. */
export const allowanceSlot = (owner, spender) =>
  keccak256(hexToBytes(encAddr(spender) + strip(keccak256(hexToBytes(encAddr(owner) + word(ALLOWANCE_SLOT))))));

export const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/.{1,2}/g) ?? [], (b) => parseInt(b, 16));

// ---- ABI helpers ----
const strip = (h) => h.replace(/^0x/, '');
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const encAddr = (a) => strip(a).toLowerCase().padStart(64, '0');
export const words = (hex) => (strip(hex).match(/.{64}/g) ?? []).map((w) => BigInt('0x' + w));
export const wordAddr = (w) => '0x' + w.toString(16).padStart(40, '0');

/** PoolKey is a static tuple: (currency0, currency1, hooks, poolManager, fee, parameters). */
export const encPoolKey = (k) =>
  encAddr(k.currency0) + encAddr(k.currency1) + encAddr(k.hooks) + encAddr(k.poolManager) + word(k.fee) + strip(k.parameters).padStart(64, '0');

export const decodePoolKey = (hex) => {
  const w = words(hex);
  return {
    currency0: wordAddr(w[0]),
    currency1: wordAddr(w[1]),
    hooks: wordAddr(w[2]),
    poolManager: wordAddr(w[3]),
    fee: Number(w[4]),
    parameters: '0x' + w[5].toString(16).padStart(64, '0'),
  };
};

export function encodeBuy(key, sqrtPriceLimitX96, minOut, recipient) {
  return SEL.buy + encPoolKey(key) + word(sqrtPriceLimitX96) + word(minOut) + encAddr(recipient);
}

export function encodeSell(key, amountIn, minOut, recipient) {
  return SEL.sell + encPoolKey(key) + word(amountIn) + word(minOut) + encAddr(recipient);
}

// ---- stock memes: encoders ----

/** Dynamic `bytes` tail: length word + data right-padded to whole words. */
const encBytesTail = (hex) => {
  const h = strip(hex);
  return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
};
const encStringTail = (str) => encBytesTail(Array.from(new TextEncoder().encode(str), (b) => b.toString(16).padStart(2, '0')).join(''));

/** PancakeSwap V3 path `token | fee (3 bytes) | token | …`. */
export function encodeV3Path(tokens, fees) {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw fail('INVALID_PATH', 'A V3 path needs n tokens and n - 1 fees');
  return '0x' + tokens.map((t, i) => strip(t).toLowerCase() + (i < fees.length ? fees[i].toString(16).padStart(6, '0') : '')).join('');
}

/** Candidate routes WBNB -> base: the direct WBNB pool (if any) and WBNB -> USDT -> base. */
export function routesFromBnb(base) {
  const viaUsdt = { via: 'USDT', tokens: [WBNB, USDT, base.address], fees: [USDT_WBNB_FEE, base.usdtFee] };
  return base.wbnbFee === null ? [viaUsdt] : [{ via: 'WBNB', tokens: [WBNB, base.address], fees: [base.wbnbFee] }, viaUsdt];
}

/** Candidate routes base -> WBNB (selling a stock meme on to BNB). */
export const routesToBnb = (base) => routesFromBnb(base).map((r) => ({ ...r, tokens: [...r.tokens].reverse(), fees: [...r.fees].reverse() }));

export function encodeStockBuy(key, amountIn, minOut, recipient) {
  return SEL.stockBuy + encPoolKey(key) + word(amountIn) + word(minOut) + encAddr(recipient);
}

export function encodeBuyWithBnb(key, path, minBaseOut, minOut, recipient) {
  return SEL.buyWithBnb + encPoolKey(key) + word(10 * 32) + word(minBaseOut) + word(minOut) + encAddr(recipient) + encBytesTail(path);
}

export function encodeSellForBnb(key, amountIn, path, minBnbOut, recipient) {
  return SEL.sellForBnb + encPoolKey(key) + word(amountIn) + word(10 * 32) + word(minBnbOut) + encAddr(recipient) + encBytesTail(path);
}

export function encodeBnbToBase(path, base, minOut, recipient) {
  return SEL.bnbToBase + word(4 * 32) + encAddr(base) + word(minOut) + encAddr(recipient) + encBytesTail(path);
}

export const encodeQuoteExactInput = (path, amountIn) => SEL.quoteExactInput + word(2 * 32) + word(amountIn) + encBytesTail(path);

/** `StockLaunchFactory.create(CreateParams)`: one dynamic tuple of 20 fields (3 strings). */
export function encodeStockCreate(c) {
  const tails = [encStringTail(c.name), encStringTail(c.symbol), encStringTail(c.meta)];
  const offsets = [];
  let off = 20 * 32;
  for (const t of tails) {
    offsets.push(off);
    off += t.length / 2;
  }
  const head = [
    encAddr(c.base), word(c.presaleAmount), word(offsets[0]), word(offsets[1]), word(offsets[2]), encAddr(c.founder),
    word(c.buyTaxBps), word(c.sellTaxBps), word(c.agentBuyTaxBps), word(c.agentSellTaxBps),
    word(c.wFounder), word(c.wHolder), word(c.wBurn), word(c.wLiquidity), word(c.minShare),
    word(c.agentOnlyRewards ? 1 : 0), word(c.antiSniper ? 1 : 0), word(c.aiOnlySeconds), word(c.holdCapSeconds), word(c.taxSeconds),
  ];
  return SEL.stockCreate + word(32) + head.join('') + tails.join('');
}

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

/** Price of one whole meme token in raw bStock wei. The meme can sort either side of the bStock in the pool. */
export function stockPriceWad(sqrtPriceX96, memeIsCurrency0) {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return memeIsCurrency0 ? (sq * WAD) / Q192 : (Q192 * WAD) / sq;
}

/** USD (18 decimals) per raw bStock unit from its USDT V3 pool's sqrtPriceX96 (both tokens 18 decimals). */
export function usdWadFromV3Sqrt(sqrtPriceX96, base) {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return base.toLowerCase() < USDT ? (sq * WAD) / Q192 : (Q192 * WAD) / sq;
}

/** `LaunchView`, a static tuple of 25 words, in order. */
const LAUNCH_FIELDS = [
  'exists', 'creator', 'founder', 'rewards', 'createBlock', 'launchTime', 'aiOnlyUntil', 'holdCapUntil', 'taxEnd',
  'buyTaxBps', 'sellTaxBps', 'agentBuyTaxBps', 'agentSellTaxBps', 'buyTaxNowBps', 'sellTaxNowBps', 'antiSniperBps',
  'antiSniper', 'creatorShareToHolders', 'sqrtPriceX96', 'protocolFee', 'liquidity', 'wFounder', 'wHolder', 'wBurn',
  'wLiquidity',
];
const ADDR_FIELDS = new Set(['creator', 'founder', 'rewards']);
const BOOL_FIELDS = new Set(['exists', 'antiSniper', 'creatorShareToHolders']);

export function decodeLaunchInfo(hex) {
  const w = words(hex);
  if (w.length < LAUNCH_FIELDS.length) throw fail('BAD_HOOK', 'The `hook` address did not answer launchInfo() — wrong address or not a SUAN Agent Launchpad hook');
  const out = {};
  LAUNCH_FIELDS.forEach((f, i) => {
    out[f] = ADDR_FIELDS.has(f) ? wordAddr(w[i]) : BOOL_FIELDS.has(f) ? w[i] === 1n : w[i];
  });
  return out;
}

/** The stock hook's `LaunchView`: 27 words, with `base` and `memeIsCurrency0` after `exists`. */
const STOCK_LAUNCH_FIELDS = ['exists', 'base', 'memeIsCurrency0', ...LAUNCH_FIELDS.slice(1)];

export function decodeStockLaunchInfo(hex) {
  const w = words(hex);
  if (w.length < STOCK_LAUNCH_FIELDS.length) throw fail('BAD_HOOK', 'The `stockHook` address did not answer launchInfo() — wrong address or not a stock-meme hook');
  const out = {};
  STOCK_LAUNCH_FIELDS.forEach((f, i) => {
    out[f] = f === 'base' || ADDR_FIELDS.has(f) ? wordAddr(w[i]) : f === 'memeIsCurrency0' || BOOL_FIELDS.has(f) ? w[i] === 1n : w[i];
  });
  return out;
}

function decodeString(hex) {
  const b = hexToBytes(hex);
  if (b.length < 64) return null;
  const off = Number(words(hex)[0]);
  const len = Number(BigInt('0x' + strip(hex).slice(off * 2, off * 2 + 64)));
  return new TextDecoder().decode(b.slice(off + 32, off + 32 + len));
}

/** Find the innermost known custom error in revert data, unwrapping Infinity's WrappedError. */
export function decodeRevert(data) {
  if (!data || data === '0x') return { code: 'REVERTED', message: 'Execution reverted without data' };
  const d = data.toLowerCase();
  const sel = d.slice(0, 10);
  if (sel === WRAPPED_ERROR) {
    // (address target, bytes4 selector, bytes reason, bytes details)
    const body = '0x' + d.slice(10);
    const w = words(body);
    const reasonOff = Number(w[2]) * 2;
    const reasonLen = Number(BigInt('0x' + body.slice(2 + reasonOff, 2 + reasonOff + 64)));
    const reason = '0x' + body.slice(2 + reasonOff + 64, 2 + reasonOff + 64 + reasonLen * 2);
    const inner = decodeRevert(reason);
    if (inner.code !== 'UNKNOWN_ERROR') return inner;
    return { code: 'WRAPPED_ERROR', message: `Call to ${wordAddr(w[0])} failed`, selector: reason.slice(0, 10) };
  }
  if (sel === ERROR_STRING) return { code: 'REVERTED', message: decodeString('0x' + d.slice(10)) ?? 'Execution reverted', selector: sel };
  if (sel === PANIC) return { code: 'PANIC', message: `Solidity panic 0x${(words('0x' + d.slice(10))[0] ?? 0n).toString(16)}`, selector: sel };
  const known = ERRORS[sel];
  if (!known) return { code: 'UNKNOWN_ERROR', message: 'Unrecognized revert', selector: sel };
  const out = { code: known[0], message: known[1], selector: sel };
  const args = words('0x' + d.slice(10));
  if (sel === '0x602a9460' && args[0] !== undefined) out.maxTokens = args[0];
  return out;
}

// ---- formatting ----
export function formatUnits(v, decimals = 18) {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (x / base).toString() + (frac ? '.' + frac : '');
}

export function parseUnits(s, decimals = 18) {
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw fail('INVALID_PARAM', `Not a positive decimal amount: ${s}`);
  const [i, f = ''] = str.split('.');
  if (f.length > decimals) throw fail('INVALID_PARAM', `Too many decimals: ${s}`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}

const bpsPct = (b) => `${(Number(b) / 100).toFixed(2)}%`;

/** A window end (unix seconds) as an ISO date; `permanent` for a tax period that never ends. */
export function formatTime(ts) {
  if (ts === 0n) return null;
  if (ts === PERMANENT) return 'permanent';
  return new Date(Number(ts) * 1000).toISOString();
}

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, extra });
}

// ---- RPC ----
async function rpcAt(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(t);
  }
}

export function makeRpc(urls) {
  let pinned = null;
  return async function rpc(method, params, { allowRevert = false } = {}) {
    const list = pinned ? [pinned] : urls;
    let lastErr;
    for (const url of list) {
      try {
        const json = await rpcAt(url, method, params);
        pinned = url;
        if (json.error) {
          if (allowRevert && json.error.data) return { revert: json.error.data };
          if (allowRevert && /revert/i.test(json.error.message ?? '')) return { revert: json.error.data ?? '0x' };
          throw fail('RPC_ERROR', json.error.message ?? 'RPC error');
        }
        return json.result;
      } catch (e) {
        if (e.code === 'RPC_ERROR') throw e;
        lastErr = e;
      }
    }
    throw fail('RPC_UNAVAILABLE', `No RPC endpoint answered (${lastErr?.message ?? 'unknown'})`);
  };
}

// ---- context ----
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function optionalAddress(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (!ADDR_RE.test(value)) throw fail('INVALID_PARAM', `\`${name}\` must be a 0x address`);
  return value.toLowerCase();
}

/** Addresses and RPC; `token` is optional here (commands that need one check it). */
function resolveBaseConfig(p) {
  const hook = p.hook ?? process.env.SUAN_LAUNCHPAD_HOOK ?? MAINNET.hook;
  const router = p.router ?? process.env.SUAN_LAUNCHPAD_ROUTER ?? MAINNET.router;
  if (!ADDR_RE.test(hook ?? '')) throw fail('INVALID_PARAM', 'Missing `hook` (or SUAN_LAUNCHPAD_HOOK)');
  if (!ADDR_RE.test(router ?? '')) throw fail('INVALID_PARAM', 'Missing `router` (or SUAN_LAUNCHPAD_ROUTER)');
  if (p.wallet !== undefined && !ADDR_RE.test(p.wallet)) throw fail('INVALID_PARAM', '`wallet` must be a 0x address');
  const stock = {
    hook: optionalAddress(p.stockHook ?? process.env.SUAN_STOCK_HOOK ?? MAINNET_STOCK.hook, 'stockHook'),
    router: optionalAddress(p.stockRouter ?? process.env.SUAN_STOCK_ROUTER ?? MAINNET_STOCK.router, 'stockRouter'),
    factory: optionalAddress(p.stockFactory ?? process.env.SUAN_STOCK_FACTORY ?? MAINNET_STOCK.factory, 'stockFactory'),
  };
  const urls = p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : DEFAULT_RPCS;
  return { hook: hook.toLowerCase(), router: router.toLowerCase(), stock, wallet: p.wallet?.toLowerCase(), rpc: makeRpc(urls) };
}

function resolveConfig(p) {
  const cfg = resolveBaseConfig(p);
  if (!ADDR_RE.test(p.token ?? '')) throw fail('INVALID_PARAM', '`token` must be a 0x address');
  return { ...cfg, token: p.token.toLowerCase() };
}

function requireStock(cfg, ...parts) {
  for (const part of parts) {
    if (!cfg.stock[part]) {
      const env = { hook: 'SUAN_STOCK_HOOK', router: 'SUAN_STOCK_ROUTER', factory: 'SUAN_STOCK_FACTORY' }[part];
      throw fail('STOCK_NOT_CONFIGURED', `Stock memes need \`stock${part[0].toUpperCase()}${part.slice(1)}\` (or ${env})`);
    }
  }
}

const call = (rpc, to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const callWord = async (rpc, to, data) => words(await call(rpc, to, data))[0] ?? 0n;

/** Whether `token` is a stock meme: the stock hook (when configured) returns its base from `baseOf`. */
async function stockBaseOfToken(cfg, token) {
  if (!cfg.stock.hook) return null;
  const base = wordAddr(await callWord(cfg.rpc, cfg.stock.hook, SEL.baseOf + encAddr(token)));
  return BigInt(base) === 0n ? null : base;
}

/** Symbol, `uiMultiplier` and USD price of a bStock (any of them null when unavailable). */
async function loadBase(rpc, address) {
  const meta = stockBaseOf(address);
  const [symHex, multHex, slotHex] = await Promise.all([
    call(rpc, address, SEL.symbol).catch(() => null),
    call(rpc, address, SEL.uiMultiplier).catch(() => null),
    meta ? call(rpc, meta.usdtPool, SEL.slot0).catch(() => null) : null,
  ]);
  const uiMultiplier = multHex ? words(multHex)[0] ?? null : null;
  const usdPerRaw = slotHex ? usdWadFromV3Sqrt(words(slotHex)[0] ?? 0n, address) : null;
  return { address, symbol: (symHex && decodeString(symHex)) || meta?.symbol || null, name: meta?.name ?? null, meta, uiMultiplier, usdPerRaw };
}

async function loadContext(cfg) {
  const { rpc, token, wallet } = cfg;
  const baseAddr = await stockBaseOfToken(cfg, token);
  const kind = baseAddr ? 'stock' : 'bnb';
  const hook = kind === 'stock' ? cfg.stock.hook : cfg.hook;
  if (kind === 'stock') requireStock(cfg, 'router');
  const router = kind === 'stock' ? cfg.stock.router : cfg.router;
  const [infoHex, keyHex, capHex, symHex, block, rewardsHex, base] = await Promise.all([
    call(rpc, hook, SEL.launchInfo + encAddr(token)),
    call(rpc, hook, SEL.poolKeyOf + encAddr(token)),
    call(rpc, token, SEL.holdCap).catch(() => null),
    call(rpc, token, SEL.symbol).catch(() => null),
    rpc('eth_getBlockByNumber', ['latest', false]),
    call(rpc, token, SEL.rewards).catch(() => null),
    baseAddr ? loadBase(rpc, baseAddr) : null,
  ]);
  const info = kind === 'stock' ? decodeStockLaunchInfo(infoHex) : decodeLaunchInfo(infoHex);
  if (!info.exists) throw fail('UNKNOWN_LAUNCH', 'This token was not launched through this SUAN Agent Launchpad hook');
  const now = BigInt(block.timestamp);
  const ctx = {
    ...cfg,
    kind,
    hook,
    router,
    base,
    rewards: rewardsHex ? wordAddr(words(rewardsHex)[0]) : info.rewards,
    info,
    key: decodePoolKey(keyHex),
    holdCap: capHex ? words(capHex)[0] : 0n,
    symbol: symHex ? decodeString(symHex) : null,
    now,
    stage: stageOf(info, now),
  };
  if (wallet) {
    const [agentHex, balHex, bnbHex, allowHex, baseBal, baseAllow, pending] = await Promise.all([
      call(rpc, AGENT_ID_NFT, SEL.balanceOf + encAddr(wallet)),
      call(rpc, token, SEL.balanceOf + encAddr(wallet)),
      rpc('eth_getBalance', [wallet, 'latest']),
      call(rpc, token, SEL.allowance + encAddr(wallet) + encAddr(router)),
      base ? callWord(rpc, base.address, SEL.balanceOf + encAddr(wallet)) : null,
      base ? callWord(rpc, base.address, SEL.allowance + encAddr(wallet) + encAddr(router)) : null,
      callWord(rpc, ctx.rewards, SEL.pending + encAddr(wallet)).catch(() => null),
    ]);
    ctx.walletState = {
      address: wallet,
      hasAgentId: words(agentHex)[0] > 0n,
      tokenBalance: words(balHex)[0],
      bnbBalance: BigInt(bnbHex),
      routerAllowance: words(allowHex)[0],
      baseBalance: baseBal,
      baseRouterAllowance: baseAllow,
      pendingRewards: pending,
      isCreator: wallet === info.creator.toLowerCase(),
    };
  }
  return ctx;
}

/** Fees in bps this wallet pays on a buy / sell right now: the 1% trading fee, plus the .ai rate for .ai wallets or
 *  the rate in force for everyone else (`buyTaxNowBps` / `sellTaxNowBps`: the normal rate during the tax period, the
 *  .ai rate after it). Same for BNB launches and stock memes (only the fee currency differs). */
export function feesFor(info, { hasAgentId }) {
  const buyTax = hasAgentId ? info.agentBuyTaxBps : info.buyTaxNowBps;
  const sellTax = hasAgentId ? info.agentSellTaxBps : info.sellTaxNowBps;
  return {
    baseFeeBps: BASE_FEE_BPS,
    buyTaxBps: buyTax,
    sellTaxBps: sellTax,
    antiSniperBps: info.antiSniperBps,
    buyTotalBps: BASE_FEE_BPS + buyTax + info.antiSniperBps,
    sellTotalBps: BASE_FEE_BPS + sellTax,
    pancakeProtocolFeePips: { buy: info.protocolFee & 0xfffn, sell: info.protocolFee >> 12n },
  };
}

const HINTS = {
  'ai-only': '.ai window: only .ai Agent ID wallets can buy (the creator can also sell). Quote with this CLI and execute via `baw contract-call` (Developer Mode).',
  'hold-cap': 'Hold-cap window: anyone can buy, but no wallet may hold more than 1% of the supply. Quote with this CLI and execute via `baw contract-call`. .ai wallets pay the .ai tax rate.',
  taxed: 'Tax period: anyone can trade in the token\'s own pool; .ai wallets pay the .ai tax rate, others the normal rate. Quote with this CLI and execute via `baw contract-call`.',
  open: 'Open: the tax period is over; everyone pays the .ai rate. Quote with this CLI and execute via `baw contract-call`.',
};

const isCapped = (ctx) => ctx.stage === 'ai-only' || ctx.stage === 'hold-cap';
const baseSym = (ctx) => ctx.base?.symbol ?? 'bStock';
const feeUnit = (ctx) => (ctx.kind === 'stock' ? baseSym(ctx) : 'BNB');

function baseSummary(ctx) {
  const b = ctx.base;
  const priceInBase = stockPriceWad(ctx.info.sqrtPriceX96, ctx.info.memeIsCurrency0);
  const usd = (raw) => (b.usdPerRaw === null ? null : formatUnits((raw * b.usdPerRaw) / WAD));
  return {
    address: b.address,
    symbol: b.symbol,
    name: b.name,
    uiMultiplier: b.uiMultiplier === null ? null : formatUnits(b.uiMultiplier),
    usdPerShare: b.usdPerRaw === null ? null : formatUnits(b.uiMultiplier ? (b.usdPerRaw * WAD) / b.uiMultiplier : b.usdPerRaw),
    memeIsCurrency0: ctx.info.memeIsCurrency0,
    price: {
      inBase: formatUnits(priceInBase),
      inShares: b.uiMultiplier === null ? null : formatUnits((priceInBase * b.uiMultiplier) / WAD),
      usd: usd(priceInBase),
    },
    marketCap: { inBase: formatUnits(priceInBase * 1_000_000_000n), usd: usd(priceInBase * 1_000_000_000n) },
  };
}

function summary(ctx) {
  const i = ctx.info;
  return {
    token: { address: ctx.token, symbol: ctx.symbol, decimals: 18 },
    kind: ctx.kind,
    base: ctx.kind === 'stock' ? baseSummary(ctx) : null,
    feeCurrency: feeUnit(ctx),
    stage: ctx.stage,
    route: 'contract-call',
    hint: HINTS[ctx.stage],
    creator: i.creator,
    founder: i.founder,
    rewards: ctx.rewards,
    windows: {
      launchedAt: formatTime(i.launchTime),
      aiOnlyUntil: formatTime(i.aiOnlyUntil),
      holdCapUntil: formatTime(i.holdCapUntil),
      taxPeriodEndsAt: formatTime(i.taxEnd),
      chainTime: formatTime(ctx.now),
    },
    taxes: {
      buy: bpsPct(i.buyTaxBps),
      sell: bpsPct(i.sellTaxBps),
      agentBuy: bpsPct(i.agentBuyTaxBps),
      agentSell: bpsPct(i.agentSellTaxBps),
      buyNow: bpsPct(i.buyTaxNowBps),
      sellNow: bpsPct(i.sellTaxNowBps),
    },
    baseFee: bpsPct(BASE_FEE_BPS),
    antiSniperNow: bpsPct(i.antiSniperBps),
    creatorShareToHolders: i.creatorShareToHolders,
    holdCap: isCapped(ctx) ? formatUnits(ctx.holdCap) : null,
    contracts: { hook: ctx.hook, router: ctx.router, poolKey: ctx.key },
  };
}

function walletSummary(ctx) {
  const w = ctx.walletState;
  if (!w) return null;
  const fees = feesFor(ctx.info, w);
  const aiOnly = ctx.stage === 'ai-only';
  return {
    address: w.address,
    hasAgentId: w.hasAgentId,
    isCreator: w.isCreator,
    bnbBalance: formatUnits(w.bnbBalance),
    tokenBalance: formatUnits(w.tokenBalance),
    ...(ctx.kind === 'stock' ? { baseBalance: formatUnits(w.baseBalance ?? 0n) } : {}),
    pendingRewards: w.pendingRewards === null ? null : `${formatUnits(w.pendingRewards)} ${feeUnit(ctx)}`,
    canBuy: aiOnly ? w.hasAgentId : true,
    canSell: aiOnly ? w.hasAgentId || w.isCreator : true,
    holdRoom: isCapped(ctx) ? formatUnits(ctx.holdCap > w.tokenBalance ? ctx.holdCap - w.tokenBalance : 0n) : null,
    fees: { buy: bpsPct(fees.buyTotalBps), sell: bpsPct(fees.sellTotalBps), breakdown: stringify(fees) },
  };
}

function stringify(o) {
  return JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const bawCommand = (from, tx) =>
  `baw contract-call preview --binanceChainId ${CHAIN_ID} --from ${from} --to ${tx.to} --value ${tx.value} --inputData ${tx.inputData} --json`;

const txEntry = (purpose, from, tx) => ({ purpose, ...tx, baw: bawCommand(from, tx) });
const approveTx = (token, spender, amount) => ({ to: token, value: '0', inputData: SEL.approve + encAddr(spender) + word(amount) });

function slippageOf(p) {
  if (p.slippageBps === undefined) return DEFAULT_SLIPPAGE_BPS;
  const s = BigInt(p.slippageBps);
  if (s < 0n || s >= BPS) throw fail('INVALID_PARAM', '`slippageBps` must be in [0, 9999]');
  return s;
}

const minOf = (out, slip) => (out * (BPS - slip)) / BPS;

/** Quote every candidate V3 route with QuoterV2 and keep the best; failing routes are skipped. */
export async function bestV3Quote(rpc, routes, amountIn) {
  const quotes = await Promise.all(
    routes.map(async (r) => {
      const path = encodeV3Path(r.tokens, r.fees);
      const res = await rpc('eth_call', [{ to: V3_QUOTER, data: encodeQuoteExactInput(path, amountIn) }, 'latest'], { allowRevert: true }).catch(() => null);
      if (res === null || res.revert !== undefined) return null;
      return { via: r.via, path, out: words(res)[0] ?? 0n };
    }),
  );
  let best = null;
  for (const q of quotes) if (q && q.out > 0n && (!best || q.out > best.out)) best = q;
  if (!best) throw fail('NO_ROUTE', 'No PancakeSwap V3 route quoted a positive amount for this bStock');
  return best;
}

/** OpenZeppelin v5 upgradeable ERC20 `_allowances` (namespaced storage), then plain layouts. */
const OZ_UPGRADEABLE_ALLOWANCES = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace01n;
const BASE_ALLOWANCE_SLOTS = [OZ_UPGRADEABLE_ALLOWANCES, 1n, 2n, 3n, 51n, 52n];

/** Storage slot of `allowances[owner][spender]` for a mapping at `mappingSlot`. */
export const allowanceSlotAt = (owner, spender, mappingSlot) =>
  keccak256(hexToBytes(encAddr(spender) + strip(keccak256(hexToBytes(encAddr(owner) + word(mappingSlot))))));

/** A state override giving `spender` an unlimited allowance on a bStock, found by trying known storage layouts. */
async function baseAllowanceOverride(rpc, token, owner, spender) {
  for (const slot of BASE_ALLOWANCE_SLOTS) {
    const override = { [token]: { stateDiff: { [allowanceSlotAt(owner, spender, slot)]: '0x' + word(MAX_UINT256) } } };
    const res = await rpc('eth_call', [{ to: token, data: SEL.allowance + encAddr(owner) + encAddr(spender) }, 'latest', override], { allowRevert: true });
    if (res.revert === undefined && words(res)[0] === MAX_UINT256) return override;
  }
  throw fail('APPROVE_FIRST', 'Approve the router for the bStock first, then quote again');
}

async function simulateOrFail(ctx, tx, override) {
  const params = [tx, 'latest'];
  if (override) params.push(override);
  const sim = await ctx.rpc('eth_call', params, { allowRevert: true });
  if (sim.revert !== undefined) {
    const err = decodeRevert(sim.revert);
    if (err.code === 'HOLDING_CAP_REACHED') {
      const room = walletSummary(ctx).holdRoom;
      err.message = `Until ${formatTime(ctx.info.holdCapUntil)} no wallet may hold more than 1% of the supply (${formatUnits(ctx.holdCap)} tokens); this wallet can take ${room} more. Buy less (at the launch price 1% is only about 0.04 BNB of buying).`;
    }
    throw fail(err.code, err.message, { ...stringify(err), wallet: walletSummary(ctx) });
  }
  return words(sim)[0];
}

const baseMetaOrFail = (ctx) => {
  const meta = stockBaseOf(ctx.base.address);
  if (!meta) throw fail('UNKNOWN_BASE', `No V3 route table for base ${ctx.base.address}; trade with the bStock directly (pay / receive: "base")`);
  return meta;
};

// ---- commands ----
async function cmdInfo(p) {
  const ctx = await loadContext(resolveConfig(p));
  return { ...summary(ctx), wallet: walletSummary(ctx) };
}

async function buyContext(p) {
  if (!p.wallet) throw fail('INVALID_PARAM', '`wallet` is required (the hook checks the trading wallet)');
  const ctx = await loadContext(resolveConfig(p));
  const w = ctx.walletState;
  if (ctx.stage === 'ai-only' && !w.hasAgentId) {
    throw fail('NO_AGENT_ID', `Until ${formatTime(ctx.info.aiOnlyUntil)} only .ai Agent ID wallets can buy`, { wallet: walletSummary(ctx) });
  }
  const amount = parseUnits(p.amount);
  if (amount === 0n) throw fail('INVALID_PARAM', '`amount` must be > 0');
  const fees = feesFor(ctx.info, w);
  if (fees.buyTotalBps >= BPS) {
    throw fail('ANTI_SNIPER_BLOCK', `Buys in the launch block are blocked by the anti-sniper fee (${bpsPct(fees.buyTotalBps)}); retry in the next block`);
  }
  return { ctx, w, amount, fees, slip: slippageOf(p) };
}

const buyFees = (fees, unit, paidInBase) => ({
  total: bpsPct(fees.buyTotalBps),
  [`total${unit === 'BNB' ? 'Bnb' : 'InBase'}`]: formatUnits((paidInBase * fees.buyTotalBps) / BPS),
  currency: unit,
  base: bpsPct(fees.baseFeeBps),
  tax: bpsPct(fees.buyTaxBps),
  antiSniper: bpsPct(fees.antiSniperBps),
  pancakeProtocolFee: `${Number(fees.pancakeProtocolFeePips.buy) / 10_000}%`,
});

async function cmdQuoteBuy(p) {
  const { ctx, w, amount, fees, slip } = await buyContext(p);
  if (ctx.kind === 'stock') return quoteStockBuy(p, ctx, w, amount, fees, slip);
  if (amount > w.bnbBalance) throw fail('INSUFFICIENT_BNB', `Wallet holds ${formatUnits(w.bnbBalance)} BNB`, { wallet: walletSummary(ctx) });
  const limit = 0n; // no price limit: the pool runs from the launch price to infinity
  const out = await simulateOrFail(ctx, { from: w.address, to: ctx.router, value: '0x' + amount.toString(16), data: encodeBuy(ctx.key, limit, 0n, w.address) });
  const minOut = minOf(out, slip);
  const tx = { to: ctx.router, value: amount.toString(), inputData: encodeBuy(ctx.key, limit, minOut, w.address) };
  return {
    ...summary(ctx),
    wallet: walletSummary(ctx),
    estimate: {
      pay: formatUnits(amount) + ' BNB',
      receive: formatUnits(out) + ' ' + (ctx.symbol ?? 'tokens'),
      receiveRaw: out.toString(),
      minReceive: formatUnits(minOut),
      slippageBps: slip.toString(),
      fees: buyFees(fees, 'BNB', amount),
    },
    transactions: [txEntry('buy', w.address, tx)],
  };
}

/** Stock meme buy: `pay: "BNB"` (default, `buyWithBnb` with the best V3 route) or `pay: "base"` (the bStock itself). */
async function quoteStockBuy(p, ctx, w, amount, fees, slip) {
  const pay = String(p.pay ?? 'BNB').toLowerCase();
  if (pay === 'base') {
    if (amount > w.baseBalance) throw fail('INSUFFICIENT_BASE', `Wallet holds ${formatUnits(w.baseBalance)} ${baseSym(ctx)}`, { wallet: walletSummary(ctx) });
    const needsApprove = w.baseRouterAllowance < amount;
    const override = needsApprove ? await baseAllowanceOverride(ctx.rpc, ctx.base.address, w.address, ctx.router) : undefined;
    const out = await simulateOrFail(ctx, { from: w.address, to: ctx.router, data: encodeStockBuy(ctx.key, amount, 0n, w.address) }, override);
    const minOut = minOf(out, slip);
    const txs = [];
    if (needsApprove) txs.push(txEntry('approve', w.address, approveTx(ctx.base.address, ctx.router, amount)));
    txs.push(txEntry('buy', w.address, { to: ctx.router, value: '0', inputData: encodeStockBuy(ctx.key, amount, minOut, w.address) }));
    return {
      ...summary(ctx),
      wallet: walletSummary(ctx),
      estimate: {
        pay: `${formatUnits(amount)} ${baseSym(ctx)}`,
        receive: formatUnits(out) + ' ' + (ctx.symbol ?? 'tokens'),
        receiveRaw: out.toString(),
        minReceive: formatUnits(minOut),
        slippageBps: slip.toString(),
        fees: buyFees(fees, baseSym(ctx), amount),
      },
      transactions: txs,
    };
  }
  if (pay !== 'bnb') throw fail('INVALID_PARAM', '`pay` must be "BNB" or "base"');
  if (amount > w.bnbBalance) throw fail('INSUFFICIENT_BNB', `Wallet holds ${formatUnits(w.bnbBalance)} BNB`, { wallet: walletSummary(ctx) });
  const leg = await bestV3Quote(ctx.rpc, routesFromBnb(baseMetaOrFail(ctx)), amount);
  const minBaseOut = minOf(leg.out, slip);
  const out = await simulateOrFail(ctx, { from: w.address, to: ctx.router, value: '0x' + amount.toString(16), data: encodeBuyWithBnb(ctx.key, leg.path, 0n, 0n, w.address) });
  const minOut = minOf(out, slip);
  const tx = { to: ctx.router, value: amount.toString(), inputData: encodeBuyWithBnb(ctx.key, leg.path, minBaseOut, minOut, w.address) };
  return {
    ...summary(ctx),
    wallet: walletSummary(ctx),
    estimate: {
      pay: formatUnits(amount) + ' BNB',
      baseLeg: { route: `WBNB -> ${leg.via === 'USDT' ? 'USDT -> ' : ''}${baseSym(ctx)}`, path: leg.path, baseOut: `${formatUnits(leg.out)} ${baseSym(ctx)}`, minBaseOut: formatUnits(minBaseOut) },
      receive: formatUnits(out) + ' ' + (ctx.symbol ?? 'tokens'),
      receiveRaw: out.toString(),
      minReceive: formatUnits(minOut),
      slippageBps: slip.toString(),
      fees: buyFees(fees, baseSym(ctx), leg.out),
    },
    transactions: [txEntry('buy', w.address, tx)],
  };
}

async function cmdQuoteSell(p) {
  if (!p.wallet) throw fail('INVALID_PARAM', '`wallet` is required (the hook checks the trading wallet)');
  const ctx = await loadContext(resolveConfig(p));
  const w = ctx.walletState;
  if (ctx.stage === 'ai-only' && !w.hasAgentId && !w.isCreator) {
    throw fail('NO_AGENT_ID', `Until ${formatTime(ctx.info.aiOnlyUntil)} only .ai Agent ID wallets and the creator can sell`, { wallet: walletSummary(ctx) });
  }
  const amount = parseUnits(p.tokenAmount);
  if (amount === 0n) throw fail('INVALID_PARAM', '`tokenAmount` must be > 0');
  if (amount > w.tokenBalance) throw fail('INSUFFICIENT_TOKEN_BALANCE', `Wallet holds ${formatUnits(w.tokenBalance)}`, { wallet: walletSummary(ctx) });

  // Simulate as if the router were already approved: override the allowance slot for this call only.
  const override = { [ctx.token]: { stateDiff: { [allowanceSlot(w.address, ctx.router)]: '0x' + word(MAX_UINT256) } } };
  const slip = slippageOf(p);
  const fees = feesFor(ctx.info, w);
  const receiveIn = ctx.kind === 'stock' ? String(p.receive ?? 'BNB').toLowerCase() : 'bnb';
  if (receiveIn !== 'bnb' && receiveIn !== 'base') throw fail('INVALID_PARAM', '`receive` must be "BNB" or "base"');
  let out;
  let sellData;
  let leg = null;
  if (ctx.kind === 'bnb' || receiveIn === 'base') {
    out = await simulateOrFail(ctx, { from: w.address, to: ctx.router, data: encodeSell(ctx.key, amount, 0n, w.address) }, override);
    sellData = (minOut) => encodeSell(ctx.key, amount, minOut, w.address);
  } else {
    const baseOut = await simulateOrFail(ctx, { from: w.address, to: ctx.router, data: encodeSell(ctx.key, amount, 0n, ctx.router) }, override);
    leg = await bestV3Quote(ctx.rpc, routesToBnb(baseMetaOrFail(ctx)), baseOut);
    leg.baseIn = baseOut;
    out = await simulateOrFail(ctx, { from: w.address, to: ctx.router, data: encodeSellForBnb(ctx.key, amount, leg.path, 0n, w.address) }, override);
    sellData = (minOut) => encodeSellForBnb(ctx.key, amount, leg.path, minOut, w.address);
  }
  const minOut = minOf(out, slip);
  const txs = [];
  if (w.routerAllowance < amount) txs.push(txEntry('approve', w.address, approveTx(ctx.token, ctx.router, amount)));
  txs.push(txEntry('sell', w.address, { to: ctx.router, value: '0', inputData: sellData(minOut) }));
  const receiveUnit = receiveIn === 'base' ? baseSym(ctx) : 'BNB';
  return {
    ...summary(ctx),
    wallet: walletSummary(ctx),
    estimate: {
      pay: formatUnits(amount) + ' ' + (ctx.symbol ?? 'tokens'),
      ...(leg ? { baseLeg: { route: `${baseSym(ctx)} -> ${leg.via === 'USDT' ? 'USDT -> ' : ''}WBNB`, path: leg.path, baseIn: `${formatUnits(leg.baseIn)} ${baseSym(ctx)}` } } : {}),
      receive: formatUnits(out) + ' ' + receiveUnit,
      receiveRaw: out.toString(),
      minReceive: formatUnits(minOut),
      slippageBps: slip.toString(),
      fees: {
        total: bpsPct(fees.sellTotalBps),
        currency: feeUnit(ctx),
        base: bpsPct(fees.baseFeeBps),
        tax: bpsPct(fees.sellTaxBps),
        pancakeProtocolFee: `${Number(fees.pancakeProtocolFeePips.sell) / 10_000}%`,
      },
    },
    transactions: txs,
  };
}

async function cmdBases(p) {
  const cfg = resolveBaseConfig(p);
  requireStock(cfg, 'factory');
  const [amounts, feeHex, openHex] = await Promise.all([
    Promise.all(STOCK_BASES.map((b) => callWord(cfg.rpc, cfg.stock.factory, SEL.startAmountOf + encAddr(b.address)))),
    call(cfg.rpc, cfg.stock.factory, SEL.launchFee),
    call(cfg.rpc, cfg.stock.factory, SEL.launchesOpen),
  ]);
  return {
    factory: cfg.stock.factory,
    launchFee: formatUnits(words(feeHex)[0]) + ' BNB',
    launchesOpen: words(openHex)[0] === 1n,
    bases: STOCK_BASES.map((b, i) => ({ symbol: b.symbol, name: b.name, address: b.address, allowed: amounts[i] > 0n, startMarketCap: `${formatUnits(amounts[i])} ${b.symbol}` })).filter(
      (b) => b.allowed,
    ),
  };
}

function baseParam(p) {
  const meta = stockBaseOf(p.base);
  if (!meta) throw fail('UNKNOWN_BASE', `\`base\` must be one of ${STOCK_BASES.map((b) => b.symbol).join(', ')} (symbol or address)`);
  return meta;
}

async function cmdQuoteBnbToBase(p) {
  const cfg = resolveBaseConfig(p);
  requireStock(cfg, 'router');
  if (!cfg.wallet) throw fail('INVALID_PARAM', '`wallet` is required (it receives the bStock)');
  const base = baseParam(p);
  const amount = parseUnits(p.amount);
  if (amount === 0n) throw fail('INVALID_PARAM', '`amount` must be > 0');
  const slip = slippageOf(p);
  const leg = await bestV3Quote(cfg.rpc, routesFromBnb(base), amount);
  const minOut = minOf(leg.out, slip);
  const tx = { to: cfg.stock.router, value: amount.toString(), inputData: encodeBnbToBase(leg.path, base.address, minOut, cfg.wallet) };
  return {
    base: { symbol: base.symbol, name: base.name, address: base.address },
    estimate: {
      pay: formatUnits(amount) + ' BNB',
      route: `WBNB -> ${leg.via === 'USDT' ? 'USDT -> ' : ''}${base.symbol}`,
      receive: `${formatUnits(leg.out)} ${base.symbol}`,
      receiveRaw: leg.out.toString(),
      minReceive: formatUnits(minOut),
      slippageBps: slip.toString(),
    },
    transactions: [txEntry('bnbToBase', cfg.wallet, tx)],
  };
}

const DAY = 86_400n;
const intParam = (v, fallback, name) => {
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(String(v))) throw fail('INVALID_PARAM', `\`${name}\` must be a whole number`);
  return BigInt(v);
};

/** The launch parameters, defaulting like the website: .ai rate 0 (normal 3%), weights 40/30/20/10, 2 min / 1 h / 15 days. */
export function stockCreateParams(p, base, creator) {
  const name = String(p.name ?? '').trim();
  const symbol = String(p.symbol ?? '').trim();
  if (!name || name.length > 32) throw fail('INVALID_PARAM', '`name` is required (at most 32 characters)');
  if (!symbol || symbol.length > 12) throw fail('INVALID_PARAM', '`symbol` is required (at most 12 characters)');
  const agentBuyTaxBps = intParam(p.aiBuyTaxBps, 0n, 'aiBuyTaxBps');
  const agentSellTaxBps = intParam(p.aiSellTaxBps, 0n, 'aiSellTaxBps');
  const [wFounder, wHolder, wBurn, wLiquidity] = (p.weights ?? [40, 30, 20, 10]).map((x, i) => intParam(x, 0n, `weights[${i}]`));
  const taxSeconds = p.taxDays === 'permanent' ? PERMANENT : intParam(p.taxDays, 15n, 'taxDays') * DAY;
  return {
    base: base.address,
    presaleAmount: p.presaleAmount ? parseUnits(p.presaleAmount) : 0n,
    name,
    symbol,
    meta: String(p.meta ?? ''),
    founder: optionalAddress(p.founder, 'founder') ?? ZERO_ADDRESS,
    buyTaxBps: agentBuyTaxBps + 300n,
    sellTaxBps: agentSellTaxBps + 300n,
    agentBuyTaxBps,
    agentSellTaxBps,
    wFounder: wFounder ?? 0n,
    wHolder: wHolder ?? 0n,
    wBurn: wBurn ?? 0n,
    wLiquidity: wLiquidity ?? 0n,
    minShare: parseUnits(p.minShare ?? '10000'),
    agentOnlyRewards: p.agentOnlyRewards === true,
    antiSniper: p.antiSniper !== false,
    aiOnlySeconds: intParam(p.aiOnlyMinutes, 2n, 'aiOnlyMinutes') * 60n,
    holdCapSeconds: intParam(p.holdCapMinutes, 60n, 'holdCapMinutes') * 60n,
    taxSeconds,
  };
}

async function cmdBuildCreate(p) {
  const cfg = resolveBaseConfig(p);
  requireStock(cfg, 'factory');
  if (!cfg.wallet) throw fail('INVALID_PARAM', '`wallet` is required (the creator)');
  const base = baseParam(p);
  const c = stockCreateParams(p, base, cfg.wallet);
  const [feeHex, startAmount, baseBal, allowance] = await Promise.all([
    call(cfg.rpc, cfg.stock.factory, SEL.launchFee),
    callWord(cfg.rpc, cfg.stock.factory, SEL.startAmountOf + encAddr(base.address)),
    callWord(cfg.rpc, base.address, SEL.balanceOf + encAddr(cfg.wallet)),
    callWord(cfg.rpc, base.address, SEL.allowance + encAddr(cfg.wallet) + encAddr(cfg.stock.factory)),
  ]);
  if (startAmount === 0n) throw fail('BASE_NOT_ALLOWED', `${base.symbol} is not allowlisted for new launches`);
  if (c.presaleAmount > baseBal) {
    throw fail('INSUFFICIENT_BASE', `Wallet holds ${formatUnits(baseBal)} ${base.symbol}; get more with \`quote-bnb-to-base\` first`);
  }
  const launchFee = words(feeHex)[0];
  const data = encodeStockCreate(c);
  const needsApprove = c.presaleAmount > 0n && allowance < c.presaleAmount;
  const override = needsApprove ? await baseAllowanceOverride(cfg.rpc, base.address, cfg.wallet, cfg.stock.factory) : undefined;
  const params = [{ from: cfg.wallet, to: cfg.stock.factory, value: '0x' + launchFee.toString(16), data }, 'latest'];
  if (override) params.push(override);
  const sim = await cfg.rpc('eth_call', params, { allowRevert: true });
  if (sim.revert !== undefined) {
    const err = decodeRevert(sim.revert);
    throw fail(err.code, err.message, stringify(err));
  }
  const txs = [];
  if (needsApprove) txs.push(txEntry('approve', cfg.wallet, approveTx(base.address, cfg.stock.factory, c.presaleAmount)));
  txs.push(txEntry('create', cfg.wallet, { to: cfg.stock.factory, value: launchFee.toString(), inputData: data }));
  return {
    base: { symbol: base.symbol, name: base.name, address: base.address, startMarketCap: `${formatUnits(startAmount)} ${base.symbol}` },
    launchFee: formatUnits(launchFee) + ' BNB',
    presale: `${formatUnits(c.presaleAmount)} ${base.symbol}`,
    predictedToken: wordAddr(words(sim)[0]),
    params: stringify({ ...c, taxSeconds: c.taxSeconds === PERMANENT ? 'permanent' : c.taxSeconds }),
    note: 'Fees and holder rewards of this launch are paid in ' + base.symbol + '. The token address is predicted from a simulation; read it from the receipt.',
    transactions: txs,
  };
}

async function cmdClaimRewards(p) {
  if (!p.wallet) throw fail('INVALID_PARAM', '`wallet` is required');
  const ctx = await loadContext(resolveConfig(p));
  const pending = ctx.walletState.pendingRewards ?? 0n;
  const tx = { to: ctx.rewards, value: '0', inputData: SEL.claim };
  return {
    token: { address: ctx.token, symbol: ctx.symbol },
    kind: ctx.kind,
    rewards: ctx.rewards,
    pending: `${formatUnits(pending)} ${feeUnit(ctx)}`,
    pendingRaw: pending.toString(),
    transactions: pending > 0n ? [txEntry('claim', ctx.walletState.address, tx)] : [],
  };
}

async function cmdReceipt(p) {
  const hash = String(p.txHash ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw fail('INVALID_PARAM', '`txHash` must be a 0x-prefixed 32-byte hash');
  const urls = p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : DEFAULT_RPCS;
  const rpc = makeRpc(urls);
  const stockHook = optionalAddress(p.stockHook ?? process.env.SUAN_STOCK_HOOK ?? MAINNET_STOCK.hook, 'stockHook');
  const r = await rpc('eth_getTransactionReceipt', [hash]);
  if (!r) return { txHash: hash, status: 'pending', note: 'No receipt yet — not mined (or unknown to this node). Re-check shortly.' };
  const fees = [];
  const transfers = [];
  const trades = [];
  const events = [];
  // Stock-meme hook logs carry amounts in the paired bStock; BNB-hook logs in BNB.
  const units = new Map();
  const unitOf = async (log, token) => {
    if (!stockHook || log.address.toLowerCase() !== stockHook) return 'BNB';
    if (!units.has(token)) {
      units.set(token, (async () => {
        const base = wordAddr(await callWord(rpc, stockHook, SEL.baseOf + encAddr(token)));
        const symHex = await call(rpc, base, SEL.symbol).catch(() => null);
        return (symHex && decodeString(symHex)) || stockBaseOf(base)?.symbol || base;
      })());
    }
    return units.get(token);
  };
  for (const log of r.logs) {
    const t0 = log.topics[0]?.toLowerCase();
    if (t0 === TOPIC.feeTaken && log.topics.length === 3) {
      const [isBuy, base, tax, anti] = words(log.data);
      const token = wordAddr(BigInt(log.topics[1]));
      const unit = await unitOf(log, token);
      const fee = { token, trader: wordAddr(BigInt(log.topics[2])), side: isBuy === 1n ? 'BUY' : 'SELL', currency: unit, base: formatUnits(base), tax: formatUnits(tax), antiSniper: formatUnits(anti) };
      fees.push(unit === 'BNB' ? { ...fee, totalBnb: formatUnits(base + tax + anti) } : { ...fee, total: formatUnits(base + tax + anti) });
    } else if (t0 === TOPIC.transfer && log.topics.length === 3 && (!p.token || log.address.toLowerCase() === p.token.toLowerCase())) {
      transfers.push({ token: log.address, from: wordAddr(BigInt(log.topics[1])), to: wordAddr(BigInt(log.topics[2])), amount: formatUnits(words(log.data)[0] ?? 0n) });
    } else if (t0 === TOPIC.swapped && log.topics.length === 3) {
      const [isBuy, paid, tokens, sqrtPriceX96] = words(log.data);
      const token = wordAddr(BigInt(log.topics[1]));
      const unit = await unitOf(log, token);
      const amount = unit === 'BNB' ? { bnb: formatUnits(paid) } : { currency: unit, baseAmount: formatUnits(paid) };
      trades.push({ token, trader: wordAddr(BigInt(log.topics[2])), side: isBuy === 1n ? 'BUY' : 'SELL', ...amount, tokens: formatUnits(tokens), tokensRaw: tokens.toString(), sqrtPriceX96: sqrtPriceX96.toString() });
    } else if (t0 === TOPIC.creatorShareToHolders && log.topics.length === 2) {
      events.push({ event: 'CreatorShareToHolders', token: wordAddr(BigInt(log.topics[1])) });
    }
  }
  return {
    txHash: hash,
    status: r.status === '0x1' ? 'success' : 'reverted',
    blockNumber: Number(BigInt(r.blockNumber)),
    from: r.from,
    to: r.to,
    gasFeeBnb: r.effectiveGasPrice ? formatUnits(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) : null,
    fees,
    trades,
    transfers,
    events,
  };
}

// ---- SUAN Predictions (pari-mutuel, BNB). Builds the transaction; it never signs or sends. ----
const predictUtf8 = (s) => new TextEncoder().encode(s);
const predictSig = (s) => keccak256(predictUtf8(s)).slice(0, 10);
export const PREDICT_SEL = {
  bet: predictSig('bet(uint256,uint8)'),
  claim: predictSig('claim(uint256)'),
  claimMany: predictSig('claimMany(uint256[])'),
  marketCount: predictSig('marketCount()'),
  marketInfo: predictSig('marketInfo(uint256)'),
  poolsOf: predictSig('poolsOf(uint256)'),
  claimable: predictSig('claimable(uint256,address)'),
};
const PREDICT_STATUS = ['open', 'proposed', 'disputed', 'resolved', 'cancelled'];

/** `bet(uint256,uint8)`. */
export function encodePredictBet(id, outcome) {
  return PREDICT_SEL.bet + word(id) + word(outcome);
}
/** `claim(uint256)`. */
export function encodePredictClaim(id) {
  return PREDICT_SEL.claim + word(id);
}
/** `claimMany(uint256[])`. */
export function encodePredictClaimMany(ids) {
  return PREDICT_SEL.claimMany + word(32) + word(ids.length) + ids.map((id) => word(id)).join('');
}

/**
 * Odds are the pool's share of the total. The multiplier and the quoted payout take 3% of the losing pool only.
 * The quote assumes this amount is the whole stake on `outcome`.
 */
export function quotePredict({ totalWei, poolsWei, outcome, amountWei }) {
  const total = BigInt(totalWei);
  const pools = poolsWei.map((pool) => BigInt(pool));
  const amount = BigInt(amountWei);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= pools.length) throw fail('INVALID_OUTCOME', '`outcome` is not one of this market\'s outcomes');
  const pool = pools[outcome] ?? 0n;
  const oddsBps = total > 0n && pool > 0n ? Number((pool * 10_000n) / total) : 0;
  const feeNow = pool > 0n && total >= pool ? ((total - pool) * 300n) / 10_000n : 0n;
  const multiplierWei = pool > 0n ? ((total - feeNow) * 10n ** 18n) / pool : null;
  const newPool = pool + amount;
  const newTotal = total + amount;
  const fee = newPool > 0n ? ((newTotal - newPool) * 300n) / 10_000n : 0n;
  const payout = amount > 0n && newPool > 0n ? (amount * (newTotal - fee)) / newPool : 0n;
  return {
    outcome,
    oddsBps,
    multiplier: multiplierWei === null ? null : formatUnits(multiplierWei),
    payout: formatUnits(payout),
    payoutWei: payout.toString(),
    feeWei: fee.toString(),
    amount: formatUnits(amount),
  };
}

/** ABI encoding of `MarketView` (11 static words, then two strings). Offsets are from the start of the tuple. */
export function encodeMarketView(v) {
  const strings = [String(v.metaURI ?? ''), String(v.evidenceURI ?? '')];
  const headWords = 13;
  let cursor = headWords * 32;
  const offsets = [];
  const tails = [];
  for (const value of strings) {
    offsets.push(cursor);
    const bytes = predictUtf8(value);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const padded = Math.ceil(bytes.length / 32) * 32;
    tails.push(word(bytes.length) + hex.padEnd(padded * 2, '0'));
    cursor += 32 + padded;
  }
  const head = [v.kind, v.outcomes, v.closeTime, v.resolveAfter, v.proposedAt, v.status, v.proposedOutcome, v.winningOutcome, v.maxPool, v.total, v.fee, offsets[0], offsets[1]];
  return '0x' + head.map((part) => word(part)).join('') + tails.join('');
}

export function decodeMarketView(hex) {
  const w = words(hex);
  if (w.length < 13) throw fail('BAD_PREDICT', 'marketInfo returned a short answer');
  const readString = (offset) => {
    const pos = Number(offset / 32n);
    const len = Number(w[pos] ?? 0n);
    if (len === 0) return '';
    const packed = w.slice(pos + 1).map((part) => part.toString(16).padStart(64, '0')).join('').slice(0, len * 2);
    return new TextDecoder().decode(hexToBytes('0x' + packed));
  };
  return {
    kind: Number(w[0]),
    outcomes: Number(w[1]),
    closeTime: w[2].toString(),
    resolveAfter: w[3].toString(),
    proposedAt: w[4].toString(),
    status: PREDICT_STATUS[Number(w[5])] ?? 'open',
    proposedOutcome: Number(w[6]),
    winningOutcome: Number(w[7]),
    maxPool: w[8].toString(),
    total: w[9].toString(),
    fee: w[10].toString(),
    metaURI: readString(w[11]),
    evidenceURI: readString(w[12]),
  };
}

/** A single `uint256[]` return: offset, length, elements. */
export function decodeUintArray(hex) {
  const w = words(hex);
  if (w.length === 0) return [];
  const start = Number(w[0] / 32n);
  const len = Number(w[start] ?? 0n);
  return w.slice(start + 1, start + 1 + len);
}

function predictAddressOf(p) {
  const value = p.predict ?? process.env.SUAN_PREDICT;
  if (!ADDR_RE.test(value ?? '')) throw fail('PREDICT_NOT_CONFIGURED', 'Pass `predict` (the SuanPredict address) or set SUAN_PREDICT');
  return value.toLowerCase();
}

function predictRpc(p) {
  const urls = p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : DEFAULT_RPCS;
  return makeRpc(urls);
}

function predictOutcome(p) {
  const outcome = Number(p.outcome);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 7) throw fail('INVALID_OUTCOME', '`outcome` must be an integer from 0 to 7');
  return outcome;
}

async function cmdPredictMarkets(p) {
  const predict = predictAddressOf(p);
  const rpc = predictRpc(p);
  const count = words(await call(rpc, predict, PREDICT_SEL.marketCount))[0] ?? 0n;
  const limit = Math.min(Math.max(Number(p.limit ?? 20), 1), 50);
  const items = [];
  const start = count > BigInt(limit) ? count - BigInt(limit) + 1n : 1n;
  for (let id = count; id >= start && id >= 1n; id -= 1n) {
    const info = decodeMarketView(await call(rpc, predict, PREDICT_SEL.marketInfo + word(id)));
    const pools = decodeUintArray(await call(rpc, predict, PREDICT_SEL.poolsOf + word(id)));
    items.push({
      id: id.toString(),
      ...info,
      poolsWei: pools.map((pool) => pool.toString()),
      oddsBps: pools.map((pool) => (BigInt(info.total) > 0n ? Number((pool * 10_000n) / BigInt(info.total)) : 0)),
    });
  }
  return { count: count.toString(), items };
}

async function cmdPredictQuote(p) {
  const predict = predictAddressOf(p);
  const id = BigInt(p.id);
  const outcome = predictOutcome(p);
  const amount = parseUnits(String(p.amount ?? '0'));
  const rpc = predictRpc(p);
  const info = decodeMarketView(await call(rpc, predict, PREDICT_SEL.marketInfo + word(id)));
  const pools = decodeUintArray(await call(rpc, predict, PREDICT_SEL.poolsOf + word(id)));
  const quote = quotePredict({ totalWei: info.total, poolsWei: pools, outcome, amountWei: amount });
  const wallet = p.wallet?.toLowerCase();
  const inputData = encodePredictBet(id, outcome);
  return {
    marketId: id.toString(),
    status: info.status,
    ...quote,
    transaction: wallet && ADDR_RE.test(wallet) ? txEntry('bet', wallet, { to: predict, value: amount.toString(), inputData }) : null,
  };
}

async function cmdPredictBet(p) {
  const predict = predictAddressOf(p);
  if (!ADDR_RE.test(p.wallet ?? '')) throw fail('INVALID_PARAM', '`wallet` must be a 0x address');
  const id = BigInt(p.id);
  const outcome = predictOutcome(p);
  const amount = parseUnits(String(p.amount));
  const inputData = encodePredictBet(id, outcome);
  return { marketId: id.toString(), outcome, amount: formatUnits(amount), transactions: [txEntry('bet', p.wallet.toLowerCase(), { to: predict, value: amount.toString(), inputData })] };
}

async function cmdPredictClaim(p) {
  const predict = predictAddressOf(p);
  if (!ADDR_RE.test(p.wallet ?? '')) throw fail('INVALID_PARAM', '`wallet` must be a 0x address');
  const ids = (Array.isArray(p.ids) ? p.ids : [p.id]).map((id) => BigInt(id));
  if (ids.length === 0 || ids.some((id) => id < 0n)) throw fail('INVALID_PARAM', '`id` or `ids` is required');
  const inputData = ids.length === 1 ? encodePredictClaim(ids[0]) : encodePredictClaimMany(ids);
  let claimable = null;
  if (ids.length === 1) {
    const rpc = predictRpc(p);
    claimable = formatUnits(words(await call(rpc, predict, PREDICT_SEL.claimable + word(ids[0]) + encAddr(p.wallet)))[0] ?? 0n);
  }
  return { ids: ids.map((id) => id.toString()), claimable, transactions: [txEntry('claim', p.wallet.toLowerCase(), { to: predict, value: '0', inputData })] };
}

const COMMANDS = {
  info: cmdInfo,
  'quote-buy': cmdQuoteBuy,
  'quote-sell': cmdQuoteSell,
  receipt: cmdReceipt,
  bases: cmdBases,
  'quote-bnb-to-base': cmdQuoteBnbToBase,
  'build-create': cmdBuildCreate,
  'claim-rewards': cmdClaimRewards,
  'predict-markets': cmdPredictMarkets,
  'predict-quote': cmdPredictQuote,
  'predict-bet': cmdPredictBet,
  'predict-claim': cmdPredictClaim,
  ...createFairmintCommands({
    fail,
    txEntry,
    call,
    makeRpc,
    ADDR_RE,
    defaultRpcs: DEFAULT_RPCS,
    defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
    agentId: AGENT_ID_NFT,
    wbnb: WBNB,
    v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    readFile: (path) => readFileSync(path, 'utf8'),
  }),
};

export async function run(command, params) {
  const fn = COMMANDS[command];
  if (!fn) throw fail('UNKNOWN_COMMAND', `Commands: ${Object.keys(COMMANDS).join(', ')}`);
  return stringify(await fn(params ?? {}));
}

async function main() {
  const [command, json] = process.argv.slice(2);
  let params = {};
  try {
    params = json ? JSON.parse(json) : {};
  } catch {
    console.log(JSON.stringify({ success: false, error: { code: 'INVALID_PARAM', message: 'Params must be a JSON object' } }, null, 2));
    process.exit(2);
  }
  try {
    const data = await run(command, params);
    console.log(JSON.stringify({ success: true, data }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: { code: e.code ?? 'ERROR', message: e.message, ...stringify(e.extra ?? {}) } }, null, 2));
    process.exit(1);
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) main();
