# fomoholdersapi

Indexer + query worker for FOMO-holder percentage.

You said manual GitHub/dashboard deploy (no Wrangler), so this repo is just plain Worker code + docs.

## Files

- `src/worker.js` — Worker entry
- `docs/DEPLOY.md` — manual Cloudflare dashboard setup
- `docs/API.md` — endpoints

## What it does (v1)

1. Indexer tick (`POST /indexer/tick`)
   - scans signatures for FOMO program
   - extracts probable signer wallets
   - stores `wallet:<address>=1` in KV

2. Query (`GET /query/:mint`)
   - fetches token top holders
   - resolves holder owner wallets
   - intersects with indexed FOMO wallet set in KV
   - returns `% of top holders held by FOMO wallets`

## Notes

- This is conservative by design (index warmth matters).
- Cache TTL for query results is currently 60s.
- You can trigger `/indexer/tick` from a cron job or external scheduler.
