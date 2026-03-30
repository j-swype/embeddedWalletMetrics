# Privy Funding Report

Measures **conversion from sign-in to first funded embedded/smart wallet** for any Privy app. Checks wallet balances directly on-chain via blockchain RPC — no dependency on Privy's transaction API.

**How it works:** Fetches your app's users via Privy's Management API, then queries each wallet's on-chain balance (native tokens via `eth_getBalance`, ERC20 tokens via `eth_call` balanceOf) across configurable chains. A wallet is considered "funded" if it holds a non-zero balance in any supported asset.

## Supported Chains & Assets

| Chain | Native | ERC20 Tokens |
|-------|--------|-------------|
| Ethereum | ETH | USDC, USDT, EURC |
| Arbitrum | ETH | USDC, USDT, EURC, USDB |
| Base | ETH | USDC, USDT, USDB |
| Optimism | ETH | USDC, USDT, EURC |
| Polygon | POL | USDC, USDT |

## Quick Start

```bash
cd privy-funding-report
npm install
```

Create a `.env` file (see `.env.example`):

```bash
PRIVY_APP_ID=your-app-id
PRIVY_APP_SECRET=your-app-secret
```

Run the report:

```bash
node bin/cli.mjs
```

Or with npx (no install needed):

```bash
npx privy-funding-report
```

## Requirements

- **Node.js 18+** (uses built-in `fetch`)
- **Privy app** with Management API access (list users endpoint; may require a paid plan)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVY_APP_ID` | Yes | — | Privy app ID |
| `PRIVY_APP_SECRET` | Yes | — | Privy app secret |
| `CHAINS` | No | `ethereum,arbitrum,base,optimism,polygon` | Comma-separated chain list |
| `CHAIN_RPC_URL_<CHAIN>` | No | Public LlamaRPC | Override RPC for a specific chain |
| `RPC_DELAY_MS` | No | `200` | Delay between RPC calls (ms) |

### RPC Override Examples

```bash
CHAIN_RPC_URL_ETHEREUM=https://mainnet.infura.io/v3/YOUR_KEY
CHAIN_RPC_URL_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN_RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## CLI Options

```
Usage: node bin/cli.mjs [options]

Options:
  --output <path>     Write final metrics to a JSON file
  --sample <size>     Use statistical sampling when user count exceeds <size>
  --social-only       Only analyze users who signed in via social/email/phone
  --chains <list>     Comma-separated chain list (e.g. ethereum,arbitrum,base)
  --verbose           Enable debug/trace output
  --help, -h          Show help
  --version           Show version
```

## Examples

### Basic run — analyze all users with wallets

```bash
node bin/cli.mjs
```

### Only social sign-in users, save report to file

```bash
node bin/cli.mjs --social-only --output report.json
```

### Scan specific chains with verbose output

```bash
node bin/cli.mjs --chains ethereum,base --verbose
```

### Sample 100 users from a large population

```bash
node bin/cli.mjs --sample 100 --output report.json
```

## Example Output

```
Privy Funding Report — Blockchain RPC Edition
Chains: ethereum, arbitrum, base, optimism, polygon
Social-only filter: OFF (all users with wallets)

Fetching all Privy users...
Fetched 150 total users
Users with embedded/smart wallets: 120
Analyzing all users with wallets

Checking wallet funding via blockchain RPC...
[6/120] did:privy:cm2xyz... — funded so far: 2 (33.3%)
[12/120] did:privy:cm1abc... — funded so far: 5 (41.7%)
...

--- Final Report ---
Total Privy users:       150
Users analyzed:          120
Funded wallets:          48
Conversion rate:         40.0%
Drop-off:                72 users (60.0%)

--- Deposits by Chain ---
  ethereum:usdc    12 deposits from 8 users, total 2,500.00
  arbitrum:usdt    45 deposits from 25 users, total 18,750.50
  base:eth         30 deposits from 20 users, total 4.52

Completed in 145.3s
Report written to report.json
```

## Sampling Mode

For large user bases, use `--sample <size>` to analyze a random subset. The tool uses Fisher-Yates shuffle for uniform random sampling and reports a Wilson score confidence interval at 95% confidence.

```bash
node bin/cli.mjs --sample 200 --output report.json
```

The JSON report includes a `sampling` field with `marginOfErrorPercent`, `conversionLower`, and `conversionUpper`.

## Smart Wallet Support

The tool automatically detects both **embedded wallets** (`privy` client type) and **smart wallets** (`smart_wallet` client type) from Privy user data. All wallet types are checked for on-chain balances.

## Zero Dependencies

This tool uses only Node.js 18+ built-in modules (`fs`, `path`, `fetch`). No npm packages are required at runtime.

## License

MIT
