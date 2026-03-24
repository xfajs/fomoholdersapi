# FOMO Holders API

Backend worker that indexes wallets paying FOMO fees and exposes query endpoints.

What it does:
- Continuously indexes FOMO wallets into KV from fee-vault transaction flow.
- Returns FOMO wallet concentration for a token (`/query/:mint`).
- Returns simple wallet membership check (`/query/wallet/:wallet`).

This service powers the FOMO Holders frontend.
