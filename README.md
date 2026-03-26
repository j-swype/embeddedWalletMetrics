# Privy Funding Report (Swype)

One-time report that measures **conversion from non-wallet sign-in to first funded** for any [Privy](https://privy.io) app. "Non-wallet" = users who signed in with email, phone, or social (Google, Twitter, Telegram, Farcaster, etc.). "Funded" = their embedded wallet has received at least one incoming transfer on any supported chain.

Supported chains: Ethereum, Arbitrum, Base, Optimism, Polygon, Linea, Solana. Assets: USDC, USDT, ETH, POL, EURC, USDB, SOL.

**Powered by [Swype](https://swype.io).**

## Run

```bash
cd privy-funding-report
npm install
node bin/cli.mjs
```

Or with npx (no install needed):

```bash
npx privy-funding-report
```

## Requirements

- **Node 18+**
- **Privy app:** Your app must have the Privy API enabled (list users, list wallet transactions). Some endpoints may require a paid Privy plan.

## Environment

Set your Privy credentials in a `.env` file in the directory from which you run the command, or export them in your shell:

- `PRIVY_APP_ID` — Your Privy app ID (from Privy Dashboard → App settings).
- `PRIVY_APP_SECRET` — Your Privy app secret.

See `.env.example` for a template.

## Options

- `--output <path>` — Write metrics to a JSON file after the run. Example: `node bin/cli.mjs --output report.json`

## Example output

```
─────────────────────────────────────
  Swype · Funding Report for Privy
  Sign-up → first funding conversion
─────────────────────────────────────

Fetching all Privy users...
Total Privy users: 10
Non-wallet sign-in users (denominator): 8
[Swype] Checking funded: 8/8 (did:privy:cm...)

--- Metrics ---
Social created: 8
Social funded: 6
Conversion: 75.0%
Drop-off: 2 (25.0%)

--- Deposits by Chain ---
  ethereum (USDC):   2 deposits from 1 users, total 500.00 USDC
  arbitrum (USDT):  12 deposits from 5 users, total 5,230.50 USDT
  base     (USDC):   4 deposits from 3 users, total 1,100.00 USDC

Powered by Swype · https://swype.io
```

## License

MIT
