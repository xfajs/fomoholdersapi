# Manual Deploy (Cloudflare Dashboard, no Wrangler)

## 1) Create Worker

- Cloudflare Dashboard → Workers & Pages → Create Worker
- Paste contents of `src/worker.js`
- Deploy

## 2) Add KV namespace

Create KV namespace (example: `fomoholders-kv`), then bind it to Worker as:

- Variable name: `FOMO_KV`

## 3) Add RPC endpoint env var

Worker Settings → Variables → Add:

- `RPC_ENDPOINT` = your Solana RPC URL (Helius/Triton/etc)

Example:
- `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`

## 4) Test endpoints

- `GET /health`
- `POST /indexer/tick?limit=25`
- `GET /query/<MINT_CA>`

## 5) Add Cron Trigger (recommended)

Workers & Pages → your Worker → Triggers → Cron Triggers → Add:

Examples:
- `* * * * *` (every minute)
- `*/2 * * * *` (every 2 minutes)

The worker has a `scheduled()` handler that runs one index batch automatically each cron run.

## Optional manual tick (debug only)

- `POST /indexer/tick?limit=25`

## Important

If you keep `/indexer/tick` exposed publicly, add auth (API key header or Cloudflare Access).
