# SUAN Agent Launchpad contracts reference

BNB Chain (chainId 56). PancakeSwap Infinity: Vault `0x238a358808379702088667322f80aC48bAd5e6c4`, CLPoolManager
`0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b`. .ai Agent ID NFT (SPACE ID): `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`.

The hook and router addresses come from the deployment (`SUAN_LAUNCHPAD_HOOK`, `SUAN_LAUNCHPAD_ROUTER`).

## Pool

Each token has one pool: `currency0` = native BNB (`0x0`), `currency1` = the token, `hooks` = the hook,
`poolManager` = CLPoolManager, dynamic fee (`0x800000`), tick spacing 10. The pool's own LP fee is 0; the hook
withholds every fee in BNB. Buying is `zeroForOne`. Read the key with `poolKeyOf(token)`.

At launch the factory puts the whole 1B supply into this pool as one single-sided position from the launch price
(market cap 4.2 BNB) up to infinity, locked forever. The token trades from its first block. The position's liquidity is
the same for every token (`factory.position()`).

## Time windows

Measured from the launch time, in chain time. The token and the hook's `launchInfo` both expose the end times.

| Window | Ends at | Default / range | Rules |
|---|---|---|---|
| .ai window | `aiOnlyUntil` | 2 min / 2–30 min | Only .ai Agent ID wallets can buy (checked on `tx.origin`); the token only moves Vault → .ai wallet (buy) and .ai wallet or creator → Vault (sell), each covered by a swap in its own pool in the same transaction |
| Hold-cap window | `holdCapUntil` | 1 h / ≥ the .ai window, ≤ 24 h | No address may hold more than `HOLD_CAP` (1% of supply). The hook delivers bought tokens itself as ERC20 so every buy passes the cap |
| Tax period | `taxEnd` | 15 days / 15–365 days, or permanent (`type(uint64).max`) | .ai wallets pay the .ai rate, others the normal rate; the token refuses alternative pools (PancakeSwap / Uniswap V2 / V3, Uniswap v4, LikwidVault) and Vault transfers not covered by a swap in its own pool |

After the tax period everyone pays the .ai rate and the token may trade anywhere. Stage from chain time `now`:
`now < aiOnlyUntil` → `ai-only`, `now < holdCapUntil` → `hold-cap`, `now < taxEnd` → `taxed`, else `open`.

## Hook (`AgentCurveHook`)

| Function | Selector | Notes |
|---|---|---|
| `launchInfo(address token) returns (LaunchView)` | `0x8025bf9a` | One-call snapshot, see below; all zero for an unknown token |
| `poolKeyOf(address token) returns (PoolKey)` | `0x8652edf9` | `(address,address,address,address,uint24,bytes32)` |
| `setCreatorShareToHolders(address token)` | `0x2d10f002` | Creator only, one-way: the creator's 0.5% trading-fee share goes to holder rewards from then on |

`LaunchView` is a static tuple of 25 words, in this order: `exists`, `creator`, `founder`, `rewards`, `createBlock`,
`launchTime`, `aiOnlyUntil`, `holdCapUntil`, `taxEnd`, `buyTaxBps`, `sellTaxBps`, `agentBuyTaxBps`,
`agentSellTaxBps`, `buyTaxNowBps`, `sellTaxNowBps` (the rates a wallet without .ai pays right now), `antiSniperBps`
(current block), `antiSniper`, `creatorShareToHolders`, `sqrtPriceX96`, `protocolFee` (PancakeSwap; low 12 bits for
buys, high 12 bits for sells, in pips), `liquidity`, then the tax split weights `wFounder`, `wHolder`, `wBurn`,
`wLiquidity`. The creator presale emits `FeeTaken` like any buy.

## Router (`AgentRouter`)

| Function | Selector | Notes |
|---|---|---|
| `buy(PoolKey key, uint160 sqrtPriceLimitX96, uint256 minOut, address recipient) payable returns (uint256)` | `0xb273b616` | Pays `msg.value`; pass limit 0 (no limit) |
| `sell(PoolKey key, uint256 amountIn, uint256 minOut, address recipient) returns (uint256)` | `0x2be26629` | Pulls `amountIn` with `transferFrom`; approve the router first |
| `msgSender() returns (address)` | `0xd737d0c7` | The caller of the current swap; during the .ai window the hook requires it to equal `tx.origin` |

Exact input only. The hook identifies the trader by `tx.origin`, so the wallet must send the transaction itself.

During the hold-cap window the hook delivers bought tokens itself, as ERC20, to the recipient the router passes as hook
data (`abi.encode(recipient)`, default `tx.origin`). The swapper gets no token balance in the Vault, so `buy` returns
the recipient's balance change. PancakeSwap's Universal Router does not pass that hook data, so use it (or an
aggregator) only after the hold-cap window.

## Token (`AgentToken`, OpenZeppelin ERC20 v5)

`MAX_SUPPLY` 1,000,000,000 (18 decimals), all in the pool. `HOLD_CAP()` `0x92a4ef32` (10,000,000 tokens),
`launchTime()` `0x790ca413`, `aiOnlyUntil()` `0xd95affd5`, `holdCapUntil()` `0xea8012b7`, `taxEnd()` `0x672a2047`
(`type(uint64).max` = permanent), `creator()` `0x02d05d3f`, `rewards()` `0x9ec5a894`, `isAgent(address)`
`0x1ffbb064`, `meta()` `0xc885044e` (IPFS CID of image, description and links). Storage: `_balances` slot 0,
`_allowances` slot 1.

## Fees (in BNB, per trade)

| Fee | Rate and destination |
|---|---|
| Trading fee (`BASE_FEE_BPS` = 100, 1%) | 0.5% buys back and burns $SUAN: booked per launch in `suanOwedOf(token)` from the first trade and paid to `suanSink()` (`SuanBuyBurn`) by `dispatch(token)`. 0.5% creator (or holders after `setCreatorShareToHolders`) |
| Tax (.ai rate 0–7% each side, set by the creator) | During the tax period .ai wallets pay the .ai rate and others always pay it + 3 points (the factory enforces `normalRate`); after it everyone pays the .ai rate. The .ai-rate part is split by the launch's weights; the 3-point surcharge always goes to buyback & burn of the token |
| Anti-sniper (if enabled, buys only) | four.meme's ladder by block offset: 100%, 50%, 25%, 15%, 10%, 5% total, minus the 1% trading fee; nothing from block 6. Goes to buyback & burn of the token |
| Launch fee (one-time, 0.005 BNB) | 100% to `SuanBuyBurn`: buy back and burn $SUAN |

Platform fees: 100% buy back and burn $SUAN. The tax is split by the launch weights: founder, holders (BNB rewards,
optionally .ai holders only), buyback-and-burn of the token, and the platform treasury (`wLiquidity`, paid to
`treasury()` by `dispatch`). `SuanBuyBurn` buys $SUAN (`0xC561DC47b9c1C036E77EcffDDE66B8f451847777`) through the
Flap Portal and sends it to `0x…dEaD`; only its keeper can trigger a buy, with a minimum burned, and it has no
withdrawal.
The creator may buy a presale in the launch transaction (no .ai needed, at most 3% of supply).

## Events

| Event | Topic 0 |
|---|---|
| `Swapped(address indexed token, address indexed trader, bool isBuy, uint256 bnbAmount, uint256 tokenAmount, uint160 sqrtPriceX96)`: every trade, including the presale and buybacks (trader = hook); BNB paid with all fees, or received after all fees | `0xdcabf9061abe380499acc5e5979da8508252dd99b27ab4eca593bf435da8c523` |
| `FeeTaken(address indexed token, address indexed trader, bool isBuy, uint256 base, uint256 tax, uint256 antiSniper)` | `0x3a1b1562be12b3a218e6bc25a1991d3ceaa8c13b4e904cba7085026416c5fa3b` |
| `CreatorShareToHolders(address indexed token)` | `0x6d501f87a96491ee759a8c23656a5ac1a4a86c4197167ed55b8576b622e9bfb6` |
| `BuybackBurned(address indexed token, uint256 bnbIn, uint256 tokensBurned)` | `0x9974e18439e1be35bed06dd8c03ef340ed502fa7438ba3a9f14fcd44ae9d104a` |
| `Dispatched(address indexed token, uint256 founder, uint256 holders, uint256 treasury)` | `0xa928e92a93df6c44b0e8b38dd5ff5303e6fd0a1610fa9bcbcfeff1ec99d71236` |
| `SuanDispatched(address indexed token, uint256 amount)`: the platform's 0.5% share reached `SuanBuyBurn` | `0xebcccd32c2e4b2dc88ec4ec3993d86bad15aa23fa3e6260039501dd7f5bfa327` |
| `SuanBurned(uint256 bnbIn, uint256 suanBurned)` (emitted by `SuanBuyBurn`) | `0x9d39bd1270e8e932c883a6a5b93d37beddb29bba456aed43a76ca0154247536c` |
| `LaunchRegistered(address indexed token, bytes32 indexed poolId, address creator)` | `0x590dca3aa49ea02366a430d78bfaf831dd38eda69cb984c9545aac0087ff5e42` |
| `TokenLaunched(address indexed token, address indexed creator, address rewards, string name, string symbol, string meta)` (factory; `meta` = IPFS CID) | `0x32c15d1c183cf0da38d5e6cb211cf0eb44ddd9a5a93d44322d6ad20acf774063` |
| `Transfer(address indexed from, address indexed to, uint256 value)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

## Errors

Hook errors reach the caller wrapped by PancakeSwap Infinity as
`WrappedError(address target, bytes4 selector, bytes reason, bytes details)` (`0x90bfb865`); token errors raised during
`take` / `settle` are wrapped the same way. The CLI unwraps `reason`.

| Error | Selector | Raised by |
|---|---|---|
| `NotAgent(address)` | `0x52f49c95` | hook (buyer during the .ai window) or token (recipient / seller during the .ai window) |
| `HoldCap(address)` | `0xbf5283aa` | token (hold-cap window) |
| `TransferLocked()` | `0x2b36b061` | token (.ai window) |
| `AltPoolBlocked(address)` | `0x2e68be39` | token (tax period) |
| `ExactOutputUnsupported()` | `0xf7ebfa18` | hook |
| `RouterMismatch()` | `0x8edaf477` | hook |
| `UnknownLaunch()` | `0xf6806bf8` | hook |
| `PresaleCap(uint256 maxTokens)` | `0x602a9460` | hook (creator presale over 3%) |
| `BuybackTooEarly()` | `0xd4c57ec4` | hook (`buyback` during the .ai window) |
| `NotCreator()` | `0x93687c0b` | hook (`setCreatorShareToHolders`) |
| `InvalidAiOnly()` | `0x9dba2911` | factory (`create`) |
| `InvalidHoldCap()` | `0x99dda1c8` | factory (`create`) |
| `InvalidTaxPeriod()` | `0xbdd72a6b` | factory (`create`) |
| `TooLittleReceived(uint256)` | `0x4704aaf8` | router |
| `ERC20InsufficientBalance` / `ERC20InsufficientAllowance` | `0xe450d38c` / `0xfb8f41b2` | token |

## Stock memes (`StockCurveHook`, `StockRouter`, `StockLaunchFactory`)

A second, separate set of contracts: launches paired with an allowlisted bStock (Binance-issued tokenized share,
18 decimals, ERC-8056 `uiMultiplier()` `0xa60bf13d`) instead of BNB. Addresses: `SUAN_STOCK_HOOK`,
`SUAN_STOCK_ROUTER`, `SUAN_STOCK_FACTORY`. Same windows, rates and events as above; every fee and payout is in the
bStock.

### Pool

`currency0` / `currency1` are the meme and the bStock sorted by address, so the meme can be either side
(`memeIsCurrency0` in `launchInfo`). When the meme is currency0 `sqrtPriceX96` is bStock per meme and buys raise it;
otherwise it is meme per bStock and buys lower it. Price of one meme in raw bStock: `sqrtP² / 2^192` (meme is
currency0) or `2^192 / sqrtP²`. The start market cap is the factory's per-base `startAmountOf(base)` (≈ $3K).

### Hook

| Function | Selector | Notes |
|---|---|---|
| `baseOf(address token) returns (address)` | `0x23d7b2bc` | The bStock of a stock meme, `0x0` for anything else: how the CLI tells the kinds apart |
| `launchInfo(address token) returns (LaunchView)` | `0x8025bf9a` | 27 words: `exists`, `base`, `memeIsCurrency0`, then the 24 words of the BNB `LaunchView` after `exists` |
| `poolKeyOf(address token)` | `0x8652edf9` | As above |
| `owedOf(address)` / `suanOwedOf(address)` | `0x228db984` / `0xc17d873a` | bStock owed per bucket; `dispatch` pays the platform share to `StockFeeSink`, which converts it to BNB for `SuanBuyBurn` |

### Router

| Function | Selector | Notes |
|---|---|---|
| `buy(PoolKey key, uint256 amountIn, uint256 minOut, address recipient)` | `0x79002279` | Pays `amountIn` of the bStock (approve the router first) |
| `buyWithBnb(PoolKey key, bytes path, uint256 minBaseOut, uint256 minOut, address recipient) payable` | `0xae40bdea` | Wraps `msg.value`, swaps WBNB → bStock on PancakeSwap V3 along `path` (at least `minBaseOut`), buys the meme; leftover bStock goes back to the caller |
| `sell(PoolKey key, uint256 amountIn, uint256 minOut, address recipient)` | `0x2be26629` | Meme → bStock |
| `sellForBnb(PoolKey key, uint256 amountIn, bytes path, uint256 minBnbOut, address recipient)` | `0xca08e600` | Meme → bStock → WBNB on V3 → BNB to the recipient |
| `bnbToBase(bytes path, address base, uint256 minOut, address recipient) payable` | `0x79e9643f` | BNB → bStock only (fund a presale) |

`path` is the PancakeSwap V3 encoding `token (20 bytes) | fee (3 bytes) | token …`, starting and ending at the right
tokens (`InvalidPath()` `0x20db8267` otherwise). The CLI quotes each candidate route with QuoterV2
(`0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997`, `quoteExactInput(bytes,uint256)` `0xcdca1753`, simulated) and takes the
best: the direct bStock/WBNB pool, or WBNB –100– USDT (`0x55d398326f99059fF775485246999027B3197955`) – bStock.

| bStock | Address | USDT pool fee | WBNB pool fee |
|---|---|---|---|
| NVDAB (NVIDIA) | `0x02fca66c1d1afb4e2a7884261eb00f63598a7436` | 2500 | 2500 |
| SPCXB (SpaceX) | `0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1` | 2500 | 2500 |
| BNCB (CEA Industries) | `0x4902c5ebc598265ed2212b559b042de8a5eeec3f` | 2500 | 2500 |
| TSLAB (Tesla) | `0x5b1910eaad6450e50f816082aa078c41f10c292f` | 2500 | 2500 |
| QQQB (Invesco QQQ) | `0x205812cdbed920aff76c6580abd681a46d11efc7` | 100 | 500 |
| SKHYB (SK hynix) | `0xca750ef65f295bbecd685abf54e82caf297bdb61` | 2500 | 2500 |
| AAPLB (Apple) | `0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a` | 2500 | 2500 |
| CRCLB (Circle) | `0x80f3d493ebce97e343c53d29a137942416b4ffc0` | 2500 | — |

The factory's allowlist (`startAmountOf(base)` `0xda448f4e`, non-zero = allowed) is the source of truth; the owner adds
or removes bases for new launches only.

### Factory

`create(CreateParams)` `0x48ddd866`, `CreateParams` = `(address base, uint256 presaleAmount, string name,
string symbol, string meta, address founder, uint16 buyTaxBps, uint16 sellTaxBps, uint16 agentBuyTaxBps,
uint16 agentSellTaxBps, uint8 wFounder, uint8 wHolder, uint8 wBurn, uint8 wLiquidity, uint256 minShare,
bool agentOnlyRewards, bool antiSniper, uint64 aiOnlySeconds, uint64 holdCapSeconds, uint64 taxSeconds)`.
`msg.value` = `launchFee()` (`0xcf3cf573`, 0.005 BNB, to `SuanBuyBurn`); `presaleAmount` of the bStock is pulled from
the creator with `transferFrom` (approve the factory first). `launchesOpen()` `0xdb8bf629`.
`TokenLaunched(address indexed token, address indexed creator, address indexed base, address rewards, string name,
string symbol, string meta)` — topic `0x16d6307226677bbd19237ea7d54cbba35d46bce786def5a8ac9694416680f7df`.
`LaunchRegistered(address indexed token, bytes32 indexed poolId, address creator, address base, bool memeIs0)` —
topic `0x8dfbdf4c0689fc6673474c1eab825a2893bcea1b41fbaf9f7db1118fd537b9c9`. `Swapped` and `FeeTaken` have the same
signatures (and topics) as above, with amounts in the bStock.

### Holder rewards (`StockHolderRewards`)

Paid in the bStock. `pending(address)` `0x5eebea20`, `claim()` `0x4e71d92d`; the token's `rewards()` `0x9ec5a894`
gives the address. A claim the bStock refuses stays claimable.

| Error | Selector | Raised by |
|---|---|---|
| `BaseNotAllowed(address)` | `0x4fbfadb9` | factory (base not allowlisted) |
| `LaunchesClosed()` / `LaunchFeeRequired(uint256)` | `0x6f9f068c` / `0xa4082532` | factory |
| `InvalidTax()` / `InvalidWeights()` / `InvalidMinShare()` / `InvalidMeta()` | `0x37d4ed5b` / `0x84677ce8` / `0x12b3f9a7` / `0x8bb27af0` | factory |
| `UnknownPool()` / `InvalidPath()` | `0xf7139e33` / `0x20db8267` | router |
