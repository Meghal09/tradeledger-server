# TradeLedger — Cloudflare Worker Setup

## Steps to deploy (takes ~5 minutes)

### 1. Create a Cloudflare account
Go to https://cloudflare.com and sign up (free)

### 2. Create a KV Namespace
- Dashboard → Workers & Pages → KV
- Click "Create namespace"
- Name it: `tradeledger-kv`
- Copy the ID shown (looks like: a1b2c3d4e5f6...)

### 3. Create the Worker
- Dashboard → Workers & Pages → Create
- Choose "Hello World" template
- Name it: `tradeledger-server`
- Click "Deploy"

### 4. Paste the worker code
- Click "Edit Code" in the Worker dashboard
- Select all existing code and delete it
- Paste the entire contents of `worker.js`
- Click "Save and Deploy"

### 5. Bind the KV namespace
- Go to Worker → Settings → Bindings
- Click "Add binding" → KV Namespace
- Variable name: `TRADELEDGER_KV`
- KV Namespace: select `tradeledger-kv`
- Save

### 6. Set environment variables
- Worker → Settings → Variables
- Add these:
  - `TRADELEDGER_TOKEN` = `TL-S7PDZ3UV`
  - `OPENROUTER_API_KEY` = (get free at openrouter.ai — optional, for AI features)
  - `TWELVEDATA_API_KEY` = (get free at twelvedata.com — optional, for live prices)

### 7. Get your Worker URL
Your worker URL will be:
`https://tradeledger-server.YOUR-SUBDOMAIN.workers.dev`

### 8. Update your React app
In App.jsx, find this line near the top:
```
const SERVER = "https://tradeledger-server-production.up.railway.app";
```
Change it to your Cloudflare Worker URL:
```
const SERVER = "https://tradeledger-server.YOUR-SUBDOMAIN.workers.dev";
```

### 9. Update your MT5 EA
In MetaEditor, find the server URL and update it to the Cloudflare Worker URL.

## Why Cloudflare Workers?
- ✅ Free tier: 100,000 requests/day
- ✅ Global edge network — faster than Railway
- ✅ No cold starts
- ✅ KV storage for trade persistence
- ✅ No monthly billing surprises
- ✅ Scales automatically

## Notes
- WebSocket (/ws) is NOT supported in the Worker — the frontend uses polling instead (already works)
- Trade data is stored in Cloudflare KV (persists forever)
- Calendar/news data is cached in KV with TTL
