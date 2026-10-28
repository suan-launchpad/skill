#!/usr/bin/env node
// SUAN Agent Launchpad CLI — check, quote and build calldata for SUAN Agent Launchpad tokens (.ai Agent ID launches on a
// PancakeSwap Infinity hook pool, BSC). Self-contained, zero-dep, Node >= 22. Read-only: it only runs eth_call /
// eth_getBalance / eth_getTransactionReceipt against a BSC node. It never signs or broadcasts — the built
// transaction is executed with `baw contract-call preview` / `execute` (Developer Mode).
//
// Usage: node suan-launchpad.mjs <command> '<json_params>'
//
// Commands:
//   info        Stage (.ai window / hold-cap window / tax period / open), its end times, fees for this wallet,
//               hold-cap room
//   quote-buy   Simulate a BNB buy through the router and build its calldata
//   quote-sell  Simulate a token sell through the router and build its calldata (+ approve if needed)
//   receipt     Check a submitted transaction and decode its fee and transfer events
//
// Quotes are exact simulations of the real swap (router -> Infinity Vault -> hook), run as `eth_call` from the
// wallet so the hook sees the same identity (`tx.origin`) as the real trade.
//
// Addresses: `hook` and `router` params, or SUAN_LAUNCHPAD_HOOK / SUAN_LAUNCHPAD_ROUTER, else the mainnet deployment. RPC: `rpc` param, BSC_RPC_URL, or the
// public BSC endpoints below.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---- constants ----
const TIMEOUT_MS = 15_000;
const CHAIN_ID = '56';
/** The SUAN Agent Launchpad on BSC mainnet, published on launch.suan.bid. */
const MAINNET = { hook: '0xa8E32E5Bc1d3Ce8aFe6bf3ef2069F1Fc7171c061', router: '0x119dCa55DCbB37998E9bA0845196acc0FFf2FAc2' };
const DEFAULT_RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org', 'https://bsc-dataseed.defibit.io'];
export const AGENT_ID_NFT = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f'; // SPACE ID Agent ID (.ai), non-transferable
const MAX_UINT256 = (1n << 256n) - 1n;
const BPS = 10_000n;
const DEFAULT_SLIPPAGE_BPS = 1_000n; // 10%
const ALLOWANCE_SLOT = 1n; // OpenZeppelin ERC20 v5: _balances = 0, _allowances = 1

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
function resolveConfig(p) {
  const hook = p.hook ?? process.env.SUAN_LAUNCHPAD_HOOK ?? MAINNET.hook;
  const router = p.router ?? process.env.SUAN_LAUNCHPAD_ROUTER ?? MAINNET.router;
  if (!/^0x[0-9a-fA-F]{40}$/.test(hook ?? '')) throw fail('INVALID_PARAM', 'Missing `hook` (or SUAN_LAUNCHPAD_HOOK)');
  if (!/^0x[0-9a-fA-F]{40}$/.test(router ?? '')) throw fail('INVALID_PARAM', 'Missing `router` (or SUAN_LAUNCHPAD_ROUTER)');
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.token ?? '')) throw fail('INVALID_PARAM', '`token` must be a 0x address');
  if (p.wallet !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(p.wallet)) throw fail('INVALID_PARAM', '`wallet` must be a 0x address');
  const urls = p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : DEFAULT_RPCS;
  return { hook: hook.toLowerCase(), router: router.toLowerCase(), token: p.token.toLowerCase(), wallet: p.wallet?.toLowerCase(), rpc: makeRpc(urls) };
}

const call = (rpc, to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);

async function loadContext(cfg) {
  const { rpc, hook, token, wallet } = cfg;
  const [infoHex, keyHex, capHex, symHex, block] = await Promise.all([
    call(rpc, hook, SEL.launchInfo + encAddr(token)),
    call(rpc, hook, SEL.poolKeyOf + encAddr(token)),
    call(rpc, token, SEL.holdCap).catch(() => null),
    call(rpc, token, SEL.symbol).catch(() => null),
    rpc('eth_getBlockByNumber', ['latest', false]),
  ]);
  const info = decodeLaunchInfo(infoHex);
  if (!info.exists) throw fail('UNKNOWN_LAUNCH', 'This token was not launched through this SUAN Agent Launchpad hook');
  const now = BigInt(block.timestamp);
  const ctx = {
    ...cfg,
    info,
    key: decodePoolKey(keyHex),
    holdCap: capHex ? words(capHex)[0] : 0n,
    symbol: symHex ? decodeString(symHex) : null,
    now,
    stage: stageOf(info, now),
  };
  if (wallet) {
    const [agentHex, balHex, bnbHex, allowHex] = await Promise.all([
      call(rpc, AGENT_ID_NFT, SEL.balanceOf + encAddr(wallet)),
      call(rpc, token, SEL.balanceOf + encAddr(wallet)),
      rpc('eth_getBalance', [wallet, 'latest']),
      call(rpc, token, SEL.allowance + encAddr(wallet) + encAddr(cfg.router)),
    ]);
    ctx.walletState = {
      address: wallet,
      hasAgentId: words(agentHex)[0] > 0n,
      tokenBalance: words(balHex)[0],
      bnbBalance: BigInt(bnbHex),
      routerAllowance: words(allowHex)[0],
      isCreator: wallet === info.creator.toLowerCase(),
    };
  }
  return ctx;
}

/** Fees in bps this wallet pays on a buy / sell right now: the 1% trading fee, plus the .ai rate for .ai wallets or
 *  the rate in force for everyone else (`buyTaxNowBps` / `sellTaxNowBps`: the normal rate during the tax period, the
 *  .ai rate after it). */
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

function summary(ctx) {
  const i = ctx.info;
  return {
    token: { address: ctx.token, symbol: ctx.symbol, decimals: 18 },
    stage: ctx.stage,
    route: 'contract-call',
    hint: HINTS[ctx.stage],
    creator: i.creator,
    founder: i.founder,
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

function slippageOf(p) {
  if (p.slippageBps === undefined) return DEFAULT_SLIPPAGE_BPS;
  const s = BigInt(p.slippageBps);
  if (s < 0n || s >= BPS) throw fail('INVALID_PARAM', '`slippageBps` must be in [0, 9999]');
  return s;
}

// ---- commands ----
async function cmdInfo(p) {
  const ctx = await loadContext(resolveConfig(p));
  return { ...summary(ctx), wallet: walletSummary(ctx) };
}

async function cmdQuoteBuy(p) {
  if (!p.wallet) throw fail('INVALID_PARAM', '`wallet` is required (the hook checks the trading wallet)');
  const ctx = await loadContext(resolveConfig(p));
  const w = ctx.walletState;
  if (ctx.stage === 'ai-only' && !w.hasAgentId) {
    throw fail('NO_AGENT_ID', `Until ${formatTime(ctx.info.aiOnlyUntil)} only .ai Agent ID wallets can buy`, { wallet: walletSummary(ctx) });
  }
  const amount = parseUnits(p.amount);
  if (amount === 0n) throw fail('INVALID_PARAM', '`amount` must be > 0');
  if (amount > w.bnbBalance) throw fail('INSUFFICIENT_BNB', `Wallet holds ${formatUnits(w.bnbBalance)} BNB`, { wallet: walletSummary(ctx) });
  const fees = feesFor(ctx.info, w);
  if (fees.buyTotalBps >= BPS) {
    throw fail('ANTI_SNIPER_BLOCK', `Buys in the launch block are blocked by the anti-sniper fee (${bpsPct(fees.buyTotalBps)}); retry in the next block`);
  }
  const limit = 0n; // no price limit: the pool runs from the launch price to infinity

  const sim = await ctx.rpc('eth_call', [{ from: w.address, to: ctx.router, value: '0x' + amount.toString(16), data: encodeBuy(ctx.key, limit, 0n, w.address) }, 'latest'], { allowRevert: true });
  if (sim.revert !== undefined) {
    const err = decodeRevert(sim.revert);
    if (err.code === 'HOLDING_CAP_REACHED') {
      const room = walletSummary(ctx).holdRoom;
      err.message = `Until ${formatTime(ctx.info.holdCapUntil)} no wallet may hold more than 1% of the supply (${formatUnits(ctx.holdCap)} tokens); this wallet can take ${room} more. Buy less (at the launch price 1% is only about 0.04 BNB).`;
    }
    throw fail(err.code, err.message, { ...stringify(err), wallet: walletSummary(ctx) });
  }
  const out = words(sim)[0];
  const slip = slippageOf(p);
  const minOut = (out * (BPS - slip)) / BPS;
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
      fees: {
        total: bpsPct(fees.buyTotalBps),
        totalBnb: formatUnits((amount * fees.buyTotalBps) / BPS),
        base: bpsPct(fees.baseFeeBps),
        tax: bpsPct(fees.buyTaxBps),
        antiSniper: bpsPct(fees.antiSniperBps),
        pancakeProtocolFee: `${Number(fees.pancakeProtocolFeePips.buy) / 10_000}%`,
      },
    },
    transactions: [{ purpose: 'buy', ...tx, baw: bawCommand(w.address, tx) }],
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
  const sim = await ctx.rpc('eth_call', [{ from: w.address, to: ctx.router, data: encodeSell(ctx.key, amount, 0n, w.address) }, 'latest', override], { allowRevert: true });
  if (sim.revert !== undefined) {
    const err = decodeRevert(sim.revert);
    throw fail(err.code, err.message, { ...stringify(err), wallet: walletSummary(ctx) });
  }
  const out = words(sim)[0];
  const slip = slippageOf(p);
  const minOut = (out * (BPS - slip)) / BPS;
  const fees = feesFor(ctx.info, w);
  const txs = [];
  if (w.routerAllowance < amount) {
    const approve = { to: ctx.token, value: '0', inputData: SEL.approve + encAddr(ctx.router) + word(amount) };
    txs.push({ purpose: 'approve', ...approve, baw: bawCommand(w.address, approve) });
  }
  const sell = { to: ctx.router, value: '0', inputData: encodeSell(ctx.key, amount, minOut, w.address) };
  txs.push({ purpose: 'sell', ...sell, baw: bawCommand(w.address, sell) });
  return {
    ...summary(ctx),
    wallet: walletSummary(ctx),
    estimate: {
      pay: formatUnits(amount) + ' ' + (ctx.symbol ?? 'tokens'),
      receive: formatUnits(out) + ' BNB',
      receiveRaw: out.toString(),
      minReceive: formatUnits(minOut),
      slippageBps: slip.toString(),
      fees: {
        total: bpsPct(fees.sellTotalBps),
        base: bpsPct(fees.baseFeeBps),
        tax: bpsPct(fees.sellTaxBps),
        pancakeProtocolFee: `${Number(fees.pancakeProtocolFeePips.sell) / 10_000}%`,
      },
    },
    transactions: txs,
  };
}

async function cmdReceipt(p) {
  const hash = String(p.txHash ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw fail('INVALID_PARAM', '`txHash` must be a 0x-prefixed 32-byte hash');
  const urls = p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : DEFAULT_RPCS;
  const rpc = makeRpc(urls);
  const r = await rpc('eth_getTransactionReceipt', [hash]);
  if (!r) return { txHash: hash, status: 'pending', note: 'No receipt yet — not mined (or unknown to this node). Re-check shortly.' };
  const fees = [];
  const transfers = [];
  const trades = [];
  const events = [];
  for (const log of r.logs) {
    const t0 = log.topics[0]?.toLowerCase();
    if (t0 === TOPIC.feeTaken && log.topics.length === 3) {
      const [isBuy, base, tax, anti] = words(log.data);
      fees.push({ token: wordAddr(BigInt(log.topics[1])), trader: wordAddr(BigInt(log.topics[2])), side: isBuy === 1n ? 'BUY' : 'SELL', base: formatUnits(base), tax: formatUnits(tax), antiSniper: formatUnits(anti), totalBnb: formatUnits(base + tax + anti) });
    } else if (t0 === TOPIC.transfer && log.topics.length === 3 && (!p.token || log.address.toLowerCase() === p.token.toLowerCase())) {
      transfers.push({ token: log.address, from: wordAddr(BigInt(log.topics[1])), to: wordAddr(BigInt(log.topics[2])), amount: formatUnits(words(log.data)[0] ?? 0n) });
    } else if (t0 === TOPIC.swapped && log.topics.length === 3) {
      const [isBuy, bnb, tokens, sqrtPriceX96] = words(log.data);
      trades.push({ token: wordAddr(BigInt(log.topics[1])), trader: wordAddr(BigInt(log.topics[2])), side: isBuy === 1n ? 'BUY' : 'SELL', bnb: formatUnits(bnb), tokens: formatUnits(tokens), tokensRaw: tokens.toString(), sqrtPriceX96: sqrtPriceX96.toString() });
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

const COMMANDS = { info: cmdInfo, 'quote-buy': cmdQuoteBuy, 'quote-sell': cmdQuoteSell, receipt: cmdReceipt };

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
