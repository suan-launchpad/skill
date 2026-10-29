---
name: suan-launchpad
description: Trade tokens launched on SUAN Agent Launchpad, the .ai Agent ID launch protocol on BNB Chain (PancakeSwap Infinity hook pool), including stock memes paired with a bStock (tokenized share such as NVDAB). Use when the user wants to check, quote, buy or sell a SUAN Agent Launchpad token, see its stage (.ai window, hold-cap window, tax period), time windows or fees, check a SUAN Agent Launchpad trade, claim holder rewards, or launch a stock meme. Builds the transaction and executes it with the Binance Agentic Wallet (`baw contract-call`, Developer Mode).
---

# SUAN Agent Launchpad

Each SUAN Agent Launchpad token trades in one locked PancakeSwap Infinity hooked pool from its first block: the whole 1B
supply sits in a single position from the launch price (market cap 4.2 BNB) upward. During the first minutes only
wallets holding a **.ai Agent ID** can buy, and .ai wallets pay a lower tax than everyone else.

**Stock memes** are a second kind of launch: the token is paired with an allowlisted **bStock** (a tokenized US share
on BSC, e.g. NVDAB, TSLAB) instead of BNB. Same rules and time windows; the differences are the pool's base asset, a
start price of about the same USD market cap, and that every fee and holder reward is paid **in that bStock**. Users can
still pay and receive BNB: the stock router swaps BNB ⇄ bStock on PancakeSwap V3 in the same transaction. Every command
detects the kind itself (`kind: "bnb" | "stock"` in the output).

`scripts/suan-launchpad.mjs` is a self-contained, read-only CLI (Node ≥ 22, no dependencies). It reads the chain,
simulates the exact trade, and prints the transaction. It never signs or sends anything: the wallet does that with
`baw contract-call preview` → `baw contract-call execute`.

```bash
node scripts/suan-launchpad.mjs <command> '<json_params>'
```

Every command prints `{"success": true, "data": …}` or `{"success": false, "error": {"code", "message", …}}`.

## Configuration

| Setting | Param | Env var | Default |
|---|---|---|---|
| Hook (launch registry and pool hook) | `hook` | `SUAN_LAUNCHPAD_HOOK` | mainnet `0xa8E32E5Bc1d3Ce8aFe6bf3ef2069F1Fc7171c061` |
| Router (buy / sell entry point) | `router` | `SUAN_LAUNCHPAD_ROUTER` | mainnet `0x119dCa55DCbB37998E9bA0845196acc0FFf2FAc2` |
| Stock-meme hook | `stockHook` | `SUAN_STOCK_HOOK` | mainnet `0x6ddE8C213f0fA67cDB9546bB0de5ef595185c196` |
| Stock-meme router | `stockRouter` | `SUAN_STOCK_ROUTER` | mainnet `0xCFA7D82BfB4Ed21aDaCFC36287b7031264ec9314` |
| Stock-meme factory | `stockFactory` | `SUAN_STOCK_FACTORY` | mainnet `0x55e1c1914D5e11a37Cd10deDF327E56F04ba979C` |
| BSC RPC | `rpc` | `BSC_RPC_URL` | public `bsc-dataseed` endpoints |

The defaults are the SUAN Agent Launchpad on BSC mainnet, as published on https://launch.suan.bid. Only override
them when the user explicitly gives other addresses; never guess them. A token that does not answer through the hook fails with `UNKNOWN_LAUNCH`.

The stock-meme defaults are the mainnet stock contracts above (also published on https://launch.suan.bid). A token
is a stock meme when the stock hook knows it (`baseOf`); otherwise it is a BNB launch.

## Time windows

Everything that changes is measured from the launch time, in chain time (the latest block's timestamp). `info` shows
the current `stage` and the end of each window under `windows`:

| Stage | Until | Who can buy | Who can sell | Rules |
|---|---|---|---|---|
| `ai-only` | `aiOnlyUntil` (2 min default, 2–30 min) | .ai Agent ID wallets | .ai wallets and the creator | Tokens only move between the pool and .ai wallets; 1% cap |
| `hold-cap` | `holdCapUntil` (1 h default, at most 24 h) | anyone | anyone | No address may hold more than **1% of the supply** (10,000,000 tokens) |
| `taxed` | `taxPeriodEndsAt` (15 days default, 15–365 days, or `"permanent"`) | anyone | anyone | The token refuses other pools |
| `open` | — | anyone | anyone | Everyone pays the .ai rate; other pools are allowed |

- The 1% cap applies during the .ai window too. At the launch price 1% is only about 0.04 BNB of buying; selling frees
  room again. `holdRoom` in `info` shows what this wallet can still take.
- During the tax period the token refuses PancakeSwap and Uniswap V2/V3 pools, Uniswap v4, LikwidVault and any other
  Infinity pool, so trading stays in the hooked pool. A launch can make the tax period permanent (`"permanent"`); the
  token then only ever trades in its own pool. Aggregators and the PancakeSwap Universal Router work once the hold-cap
  window is over, as long as the route goes through the hooked pool.
- The anti-sniper surcharge applies in the first 5 blocks after creation (`antiSniperNow`). Buys in the creation block
  itself are blocked.

## Fees

All fees are taken in the launch's base: BNB for BNB launches, the paired bStock for stock memes (`feeCurrency` in
`info`). The rates are the same.

| Fee | Rate | Goes to |
|---|---|---|
| Trading fee (`baseFee`) | 1% on every trade | 0.5% buys back and burns $SUAN (the platform's share, from the first trade) + 0.5% creator, or holders once the creator switched its share to holders (`creatorShareToHolders: true`, one-way) |
| Tax | Everyone: the .ai rate (0–7%, default 0) | Split by the launch weights: founder, holder rewards, buyback-and-burn of the token, platform treasury |
| Surcharge | Wallets without .ai, during the tax period only: +3 points (`taxes.buyNow` / `taxes.sellNow` include it) | All to buyback-and-burn; no one receives it |
| Anti-sniper | four.meme's ladder in the first 5 blocks, buys only | Buyback-and-burn |

Platform fees: 100% buy back and burn $SUAN. That is the 0.5% platform share of every trade plus the one-time 0.005 BNB
launch fee. For stock memes the platform share is collected in the bStock and converted to BNB before the $SUAN buyback;
the launch fee is still 0.005 BNB. Creator fees, holder rewards and the token's own buyback use the bStock.
PancakeSwap's own protocol fee (`pancakeProtocolFee`) is on top and is already included in the quote.

## Commands

| Command | Params | What it does |
|---|---|---|
| `info` | `token`, `wallet?` | Stage, time windows, fees, creator-share switch, hold-cap room, pending holder rewards, and whether this wallet can buy / sell. Stock memes: `base` (symbol, name, USD per share, meme price in the bStock, in shares and in USD, market cap) |
| `quote-buy` | `token`, `wallet`, `amount`, `pay?`, `slippageBps?` | Simulates the buy and builds the router call. `amount` is BNB; for stock memes `pay: "base"` pays `amount` of the bStock instead (plus an `approve` first if needed) |
| `quote-sell` | `token`, `wallet`, `tokenAmount`, `receive?`, `slippageBps?` | Simulates the sell and builds the router call, plus an `approve` first when the router's allowance is too low. Stock memes receive BNB by default, or the bStock with `receive: "base"` |
| `receipt` | `txHash`, `token?` | Status, trades (`Swapped`: amount paid or received, tokens), fees taken (`FeeTaken`), token transfers and `CreatorShareToHolders` events of a submitted transaction. Stock-meme amounts carry `currency` (the bStock) |
| `claim-rewards` | `token`, `wallet` | Pending holder rewards (BNB, or the bStock for stock memes) and the `claim` call when there is something to claim |
| `bases` | — | Stock memes: the bStocks new launches can pair with, their start market cap, the launch fee and whether creation is open |
| `quote-bnb-to-base` | `base` (symbol or address), `wallet`, `amount` (BNB), `slippageBps?` | Stock memes: swap BNB to a bStock through the stock router, e.g. to fund a creator presale |
| `build-create` | `base`, `wallet`, `name`, `symbol`, `meta?`, `presaleAmount?` (bStock), `aiBuyTaxBps?`, `aiSellTaxBps?`, `weights?` ([founder, holder, burn, liquidity], default [40,30,20,10]), `taxDays?` (15–365 or `"permanent"`), `aiOnlyMinutes?` (2), `holdCapMinutes?` (60), `antiSniper?` (true), `minShare?`, `agentOnlyRewards?`, `founder?` | Stock memes: simulates the launch and builds `approve` (presale) + `create` (value = the BNB launch fee) |

Amounts are decimal strings (`"0.05"`), not wei. `slippageBps` defaults to 1000 (10%) and sets `minReceive`.

Stock-meme quotes with BNB pick the better PancakeSwap V3 route between BNB and the bStock (the direct WBNB pool or via
USDT), shown under `estimate.baseLeg`; the same slippage sets the least bStock out of that leg.

Quotes are not estimates from a formula: the CLI runs the real router call with `eth_call` from the user's wallet, so
the hook and token apply the same .ai check, hold cap and fees as the real trade. Buys pass no price limit. For sells it adds a
temporary allowance in the simulation only, so a quote works before the approval exists.

## Workflow

### Prerequisites

1. The user has a Binance Agentic Wallet with **Developer Mode** on, since `contract-call` needs it. Developer Mode has
   its own daily limit and balance cap, which the user sets in the Binance App.
2. To buy during the .ai window, and for the lower .ai tax at any time, the wallet holds a .ai Agent ID. Check
   `data.wallet.hasAgentId` from `info`. If it is `false`, the user claims one through the Binance Agentic Wallet
   skill's Agent ID flow first. It is free, one per user, and non-transferable.

### Buy

1. `info {token, wallet}`. Show the stage and when it ends, the fees this wallet pays (`data.wallet.fees`) and,
   during the .ai and hold-cap windows, `holdRoom`. Stop if `canBuy` is `false` and explain why (no .ai Agent ID
   during the .ai window: claim one, or wait until `windows.aiOnlyUntil`).
2. `quote-buy {token, wallet, amount}`. Show `estimate.receive`, `estimate.minReceive` and `estimate.fees`.
3. Run `transactions[0].baw` (that is, `baw contract-call preview --binanceChainId 56 --from <wallet> --to <router>
   --value <wei> --inputData <hex> --json`). Show the user the preview's balance changes and any `risks`.
4. Only after the user confirms, run `baw contract-call execute --requestId <requestId> --json`. If the preview has
   `requireConfirmation: true`, tell the user to approve the order in the Binance App.
5. `receipt {txHash, token}` to report the fees paid and tokens received.

### Sell

1. `quote-sell {token, wallet, tokenAmount}`. If `transactions` starts with `approve`, preview and execute it first,
   then run `quote-sell` again so the sell is built from fresh state.
2. Preview and execute the `sell` transaction as in the buy flow.

### Stock memes

- Trading works as above; `info` tells you the kind and the bStock. Show prices and fees in that bStock (and its USD
  value from `base.price.usd`). Default to paying and receiving BNB; use `pay` / `receive: "base"` only when the user
  holds or wants the bStock itself.
- Per-share figures use the bStock's `uiMultiplier` (`base.uiMultiplier`): raw balances never change, corporate actions
  only change the multiplier.

### Launch a stock meme

1. `bases` to show what can be paired and the launch fee. Ask for name, symbol and the base.
2. For a presale, the creator needs the bStock: `quote-bnb-to-base {base, wallet, amount}`, preview, execute. The
   presale buys at most 3% of the supply.
3. `build-create {base, wallet, name, symbol, presaleAmount?, …}`. Preview and execute `approve` (if present), then
   `create`. Read the token address from the receipt (`predictedToken` is only a simulation).

### Holder rewards

`claim-rewards {token, wallet}` shows what is pending; preview and execute the `claim` transaction to receive it.

## Safety

- Never call `execute` without showing the preview and getting the user's confirmation for that trade.
- Never execute an intercepted preview. A preview that fails with `351803` (`AGENT_DEV_MODE_RISK_BLOCKED`) has no
  `requestId`; tell the user the wallet's risk engine blocked it and stop.
- Re-quote if more than a minute has passed or the user changes the amount. During the first blocks the anti-sniper
  fee falls every block, so an older quote only underestimates the output.
- Do not raise `slippageBps` above 1000 unless the user asks for it.
- The contracts are unaudited; say so when the user asks about safety.

## Errors

| Code | Meaning | What to tell the user |
|---|---|---|
| `NO_AGENT_ID` | The .ai window is running and the wallet has no .ai Agent ID (sells: and is not the creator) | Claim a .ai Agent ID first, or wait until `windows.aiOnlyUntil` |
| `HOLDING_CAP_REACHED` | The buy would take the wallet over 1% of supply during the hold-cap window | Buy less; `holdRoom` shows the room left, and the cap ends at `windows.holdCapUntil` |
| `ANTI_SNIPER_BLOCK` | Buys in the creation block cost 100% or more | Retry from the next block |
| `SLIPPAGE` | The price moved past `minReceive` | Re-quote |
| `INSUFFICIENT_BNB` / `INSUFFICIENT_TOKEN_BALANCE` | Not enough funds | Show the balance from `info` |
| `INSUFFICIENT_ALLOWANCE` | The router is not approved | Run the `approve` transaction from `quote-sell` |
| `TRANSFER_LOCKED` / `ALT_POOL_BLOCKED` | The token only moves through its own pool right now (.ai window / tax period) | Trade through this skill's router call |
| `PRESALE_CAP` | The creator presale asks for more than 3% of supply (`maxTokens`) | Launch with a smaller presale |
| `NOT_CREATOR` / `BUYBACK_TOO_EARLY` | Creator-only call, or a buyback before the .ai window ended | Not something a trade can fix |
| `INVALID_AI_ONLY` / `INVALID_HOLD_CAP` / `INVALID_TAX_PERIOD` | Launch parameters out of range (2–30 min; ≥ .ai window and ≤ 24 h; 15–365 days or permanent) | Fix the launch parameters |
| `UNKNOWN_LAUNCH` / `BAD_HOOK` | Not a SUAN Agent Launchpad token, or wrong hook address | Check the addresses |
| `STOCK_NOT_CONFIGURED` | A stock command without the stock contract addresses | Pass `stockHook` / `stockRouter` / `stockFactory` from launch.suan.bid |
| `BASE_NOT_ALLOWED` / `UNKNOWN_BASE` | The bStock is not allowlisted for new launches, or not in this skill's table | Pick one from `bases` |
| `NO_ROUTE` | No PancakeSwap V3 route quoted the BNB ⇄ bStock leg | Trade with the bStock directly (`pay` / `receive: "base"`), or retry later |
| `INSUFFICIENT_BASE` | Not enough of the bStock | Get it with `quote-bnb-to-base`, or pay with BNB |
| `APPROVE_FIRST` | The bStock allowance could not be simulated | Approve the router (or factory) first, then quote again |
| `LAUNCHES_CLOSED` / `LAUNCH_FEE_REQUIRED` / `INVALID_TAX` / `INVALID_WEIGHTS` / `INVALID_MIN_SHARE` / `INVALID_META` | Launch parameters rejected | Fix the launch parameters |
| `RPC_UNAVAILABLE` | No RPC answered | Retry, or pass `rpc` |

`references/contracts.md` lists the contract interface, selectors, events and fee rules.
