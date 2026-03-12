/**
 * TradeLedger Backend — Railway Edition
 * Receives trades from MT5 EA via HTTP POST
 * Serves them to React frontend via REST + WebSocket
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");

// ─── AI helper — OpenRouter (free tier, OpenAI-compatible format) ────────────
// Get free key at openrouter.ai — set OPENROUTER_API_KEY in Railway Variables
// Free models: meta-llama/llama-3.3-8b-instruct:free  (fast, good quality)
//              mistralai/mistral-7b-instruct:free      (fallback)
const AI_MODELS = [
  "meta-llama/llama-3.3-8b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "google/gemma-2-9b-it:free",
];

async function groqChat(messages, { maxTokens = 1024 } = {}) {
  const https = require("https");

  // Try OpenRouter first (free, reliable)
  const orKey = process.env.OPENROUTER_API_KEY || "";
  if (orKey) {
    for (const model of AI_MODELS) {
      try {
        const body = JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        });
        const result = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: "openrouter.ai",
            path: "/api/v1/chat/completions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + orKey,
              "HTTP-Referer": "https://tradeledger.app",
              "X-Title": "TradeLedger",
              "Content-Length": Buffer.byteLength(body),
            },
          }, (resp) => {
            let d = "";
            resp.on("data", c => d += c);
            resp.on("end", () => {
              try {
                console.log("[AI] OpenRouter status:", resp.statusCode, "model:", model);
                const parsed = JSON.parse(d);
                if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
                const text = parsed.choices?.[0]?.message?.content || "";
                if (!text) throw new Error("Empty response from model");
                resolve(text);
              } catch (e) {
                console.warn("[AI] OpenRouter parse error:", e.message, "raw:", d.slice(0, 200));
                reject(e);
              }
            });
          });
          r.on("error", reject);
          r.write(body);
          r.end();
        });
        return result; // success — return immediately
      } catch (e) {
        console.warn("[AI] OpenRouter model", model, "failed:", e.message, "— trying next");
      }
    }
    throw new Error("All OpenRouter free models failed");
  }

  // Fallback: Gemini (if GEMINI_API_KEY set)
  const gemKey = process.env.GEMINI_API_KEY || "";
  if (gemKey) {
    const contents = messages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    const body = JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } });
    return new Promise((resolve, reject) => {
      const r = https.request({
        hostname: "generativelanguage.googleapis.com",
        path: "/v1beta/models/gemini-2.0-flash-lite:generateContent?key=" + gemKey,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (resp) => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => {
          try {
            console.log("[AI] Gemini fallback status:", resp.statusCode);
            const parsed = JSON.parse(d);
            if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
            resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || "");
          } catch (e) { reject(e); }
        });
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });
  }

  throw new Error("No AI API key set. Add OPENROUTER_API_KEY in Railway Variables (free at openrouter.ai)");
}

const PORT      = process.env.PORT || 3001;
const TOKEN_KEY = "TRADELEDGER_TOKEN";

// ─── Token: use env var on Railway, generate locally ─────────────────────────
function getToken() {
  if (process.env[TOKEN_KEY]) return process.env[TOKEN_KEY];
  const file = path.join(__dirname, "token.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const t = "TL-" + Math.random().toString(36).slice(2, 10).toUpperCase();
  fs.writeFileSync(file, t);
  return t;
}
const APP_TOKEN = getToken();

// ─── In-memory trades + optional file persistence ────────────────────────────
let trades = [];
// Use /data volume if mounted (Railway persistent volume), else fallback to local
const DATA_DIR  = fs.existsSync("/data") ? "/data" : __dirname;
const DATA_FILE = path.join(DATA_DIR, "trades.json");
try {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  trades = JSON.parse(raw);
  console.log(`[BOOT] Loaded ${trades.length} trades from ${DATA_FILE}`);
} catch { console.log("[BOOT] No existing trades file, starting fresh"); }
function saveTrades() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(trades)); } catch(e) { console.warn("[SAVE] Failed:", e.message); }
}

// ─── WebSocket clients ────────────────────────────────────────────────────────
const wsClients = new Set();
function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const crypto = require("crypto");
  const accept = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  wsClients.add(socket);
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
}
function wsBroadcast(data) {
  const payload = Buffer.from(JSON.stringify(data));
  const frame   = Buffer.alloc(payload.length + 2);
  frame[0] = 0x81; frame[1] = payload.length;
  payload.copy(frame, 2);
  for (const s of wsClients) { try { s.write(frame); } catch { wsClients.delete(s); } }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TradeLedger-Token");
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function cleanTrade(trade) {
  return {
    ticket:     Number(trade.ticket),
    symbol:     String(trade.symbol     || "").toUpperCase(),
    type:       String(trade.type       || "buy").toLowerCase(),
    lots:       Number(trade.lots       || 0),
    openPrice:  Number(trade.openPrice  || 0),
    closePrice: Number(trade.closePrice || 0),
    openTime:   String(trade.openTime   || ""),
    closeTime:  String(trade.closeTime  || ""),
    profit:     Number(trade.profit     || 0),
    swap:       Number(trade.swap       || 0),
    commission: Number(trade.commission || 0),
    comment:    String(trade.comment    || ""),
    account:    String(trade.account    || ""),
    broker:     String(trade.broker     || ""),
    source:     "EA",
    receivedAt: new Date().toISOString(),
  };
}

// ─── In-memory price cache (stale-while-revalidate) ─────────────────────────
// Cache stores the last successful quote response per symbol-set key
const priceCache = new Map(); // key -> { quotes, fetchedAt, ttl }
const CACHE_TTL_MS  = 30 * 1000;  // 30s — fresh threshold
const CACHE_STALE_MS = 5 * 60 * 1000; // 5min — max stale we'll serve

// Background refresh tracker — avoids duplicate fetches in-flight
const refreshInFlight = new Set();

function getCacheKey(symbols) { return symbols.slice().sort().join(","); }

function getCached(key) {
  const entry = priceCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  if (age > CACHE_STALE_MS) { priceCache.delete(key); return null; } // too old
  return { ...entry, isStale: age > CACHE_TTL_MS };
}

// ─── fetchQuotes(symbols) — core price fetching logic ────────────────────────
async function fetchQuotes(raw) {
  const https = require("https");
  const TD_KEY = process.env.TWELVE_DATA_KEY || "";

  const httpsGet = (host, path, hdrs={}, timeout=12000) => new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method: "GET", timeout,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "identity",
        ...hdrs
      }
    };
    const r = https.request(opts, (resp) => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => resolve({ text: d, status: resp.statusCode, headers: resp.headers || {} }));
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    r.end();
  });

  const getDec = sym => sym.includes("JPY") ? 3
    : ["XAUUSD","XAGUSD","BTCUSD","ETHUSD","BNBUSD","SOLUSD","SPX500","US30","NAS100",
       "UK100","GER40","FRA40","JPN225","AUS200","HK50","NIFTY50","USOIL","UKOIL","NATGAS"].includes(sym) ? 2 : 5;
  const fmt = (v, dec) => v != null && !isNaN(v) ? parseFloat(parseFloat(v).toFixed(dec)) : null;

  const TD_MAP = {
    "EURUSD":"EUR/USD","GBPUSD":"GBP/USD","USDJPY":"USD/JPY","USDCHF":"USD/CHF",
    "AUDUSD":"AUD/USD","NZDUSD":"NZD/USD","USDCAD":"USD/CAD","EURGBP":"EUR/GBP",
    "EURJPY":"EUR/JPY","GBPJPY":"GBP/JPY","EURCHF":"EUR/CHF","AUDJPY":"AUD/JPY",
    "CADJPY":"CAD/JPY","CHFJPY":"CHF/JPY","GBPCHF":"GBP/CHF","EURCAD":"EUR/CAD",
    "AUDCAD":"AUD/CAD","AUDNZD":"AUD/NZD","NZDJPY":"NZD/JPY","GBPCAD":"GBP/CAD",
    "GBPNZD":"GBP/NZD","GBPAUD":"GBP/AUD","EURAUD":"EUR/AUD","EURNZD":"EUR/NZD",
    "CADCHF":"CAD/CHF","NZDCAD":"NZD/CAD","NZDCHF":"NZD/CHF","AUDCHF":"AUD/CHF",
    "USDMXN":"USD/MXN","USDZAR":"USD/ZAR","USDNOK":"USD/NOK","USDSEK":"USD/SEK",
    "USDDKK":"USD/DKK","USDPLN":"USD/PLN","USDTRY":"USD/TRY","USDSGD":"USD/SGD",
    "USDHKD":"USD/HKD","USDCNH":"USD/CNH",
    "XAUUSD":"XAU/USD","XAGUSD":"XAG/USD","XPTUSD":"XPT/USD","XPDUSD":"XPD/USD",
    "BTCUSD":"BTC/USD","ETHUSD":"ETH/USD","BNBUSD":"BNB/USD","SOLUSD":"SOL/USD",
    "XRPUSD":"XRP/USD","ADAUSD":"ADA/USD","DOTUSD":"DOT/USD","LNKUSD":"LINK/USD",
    "NAS100":"NDX","SPX500":"SPX","US30":"DJI","UK100":"UKX","GER40":"DAX",
    "FRA40":"CAC40","JPN225":"N225","AUS200":"AS51","HK50":"HSI",
    "USOIL":"WTI","UKOIL":"BRENT","NATGAS":"NGAS",
  };

  const out = {};
  raw.forEach(s => { out[s] = null; });

  // ── SOURCE 1: Twelve Data ─────────────────────────────────────────────────
  if (TD_KEY) {
    try {
      const tdSymbols = raw.map(s => TD_MAP[s]).filter(Boolean);
      const tdByOurs  = {};
      raw.forEach(s => { if (TD_MAP[s]) tdByOurs[TD_MAP[s]] = s; });

      if (tdSymbols.length) {
        // Twelve Data free tier: max 8 symbols per call — batch if needed
        const batchSize = 8;
        const batches = [];
        for (let i=0; i<tdSymbols.length; i+=batchSize) batches.push(tdSymbols.slice(i,i+batchSize));
        const allPriceMap = {}, allQuoteMap = {};
        for (const batch of batches) {
          const [priceResp, quoteResp] = await Promise.all([
            httpsGet("api.twelvedata.com",
              "/price?symbol=" + encodeURIComponent(batch.join(",")) + "&apikey=" + TD_KEY + "&dp=5"),
            httpsGet("api.twelvedata.com",
              "/quote?symbol=" + encodeURIComponent(batch.join(",")) + "&apikey=" + TD_KEY + "&dp=5"),
          ]);
          const isSingle = batch.length===1;
          if (priceResp.status===200) {
            const pm = isSingle ? {[batch[0]]:JSON.parse(priceResp.text)} : JSON.parse(priceResp.text);
            Object.assign(allPriceMap, pm);
          }
          if (quoteResp.status===200) {
            const qm = isSingle ? {[batch[0]]:JSON.parse(quoteResp.text)} : JSON.parse(quoteResp.text);
            Object.assign(allQuoteMap, qm);
          }
        }
        const [priceResp, quoteResp] = [{status:200,text:"batched"},{status:200,text:"batched"}];
        const isSingle = false;
        const priceMap = allPriceMap, quoteMap = allQuoteMap;



        tdSymbols.forEach(tdSym => {
          const ourSym = tdByOurs[tdSym];
          if (!ourSym) return;
          const p = priceMap[tdSym];
          const q = quoteMap[tdSym];
          const price = parseFloat(p?.price);
          if (!price || isNaN(price) || price <= 0) return;
          const dec       = getDec(ourSym);
          const prevClose = q?.previous_close ? parseFloat(q.previous_close) : null;
          const high      = q?.high  ? parseFloat(q.high)  : null;
          const low       = q?.low   ? parseFloat(q.low)   : null;
          const change    = prevClose ? price - prevClose : null;
          const changePct = prevClose && change ? (change / prevClose) * 100 : null;
          out[ourSym] = {
            price:     fmt(price, dec),
            change:    fmt(change, dec),
            changePct: fmt(changePct, 2),
            high:      fmt(high, dec),
            low:       fmt(low, dec),
            prevClose: fmt(prevClose, dec),
          };
        });
        console.log("[QUOTE] TwelveData:", raw.filter(s=>out[s]).length + "/" + raw.length);
      }
    } catch(e) { console.warn("[QUOTE] TwelveData failed:", e.message); }
  }

  // ── SOURCE 2: CoinGecko (crypto fallback) ────────────────────────────────
  const cryptoNeeded = raw.filter(s => out[s]===null &&
    ["BTCUSD","ETHUSD","BNBUSD","SOLUSD","XRPUSD","ADAUSD","DOTUSD","LNKUSD"].includes(s));
  if (cryptoNeeded.length) {
    try {
      const cgMap = {"BTCUSD":"bitcoin","ETHUSD":"ethereum","BNBUSD":"binancecoin",
        "SOLUSD":"solana","XRPUSD":"ripple","ADAUSD":"cardano","DOTUSD":"polkadot","LNKUSD":"chainlink"};
      const ids = cryptoNeeded.map(s=>cgMap[s]).filter(Boolean).join(",");
      const cgResp = await httpsGet("api.coingecko.com",
        "/api/v3/coins/markets?vs_currency=usd&ids="+ids+"&price_change_percentage=24h");
      if (cgResp.status===200) {
        const byId = {};
        JSON.parse(cgResp.text).forEach(c => { byId[c.id] = c; });
        cryptoNeeded.forEach(sym => {
          const c = byId[cgMap[sym]];
          if (!c) return;
          const dec = getDec(sym);
          out[sym] = { price:fmt(c.current_price,dec), change:fmt(c.price_change_24h,dec),
            changePct:fmt(c.price_change_percentage_24h,2), high:fmt(c.high_24h,dec),
            low:fmt(c.low_24h,dec), prevClose:fmt(c.current_price-c.price_change_24h,dec) };
        });
        console.log("[QUOTE] CoinGecko fallback:", cryptoNeeded.filter(s=>out[s]).length);
      }
    } catch(e) { console.warn("[QUOTE] CoinGecko failed:", e.message); }
  }

  // ── SOURCE 3: Frankfurter (forex + metals fallback) ──────────────────────
  const ffNeeded = raw.filter(s => out[s]===null);
  if (ffNeeded.length) {
    try {
      const ffForex  = ffNeeded.filter(s => s.length===6 && !s.startsWith("XA") && !s.startsWith("XP"));
      const ffMetals = ffNeeded.filter(s => ["XAUUSD","XAGUSD"].includes(s));
      const codes = [...new Set([
        ...ffForex.map(s=>s.slice(0,3)), ...ffForex.map(s=>s.slice(3,6)),
        ...(ffMetals.length ? ["XAU","XAG"] : [])
      ])].filter(c=>c!=="USD").join(",");
      if (codes) {
        const [latestR, prevR] = await Promise.all([
          httpsGet("api.frankfurter.app", "/latest?from=USD&to="+codes),
          (()=>{ const yd=new Date(); yd.setDate(yd.getDate()-1);
            if(yd.getDay()===0)yd.setDate(yd.getDate()-2);
            if(yd.getDay()===6)yd.setDate(yd.getDate()-1);
            return httpsGet("api.frankfurter.app","/"+yd.toISOString().slice(0,10)+"?from=USD&to="+codes); })()
        ]);
        const rates = latestR.status===200 ? {USD:1,...JSON.parse(latestR.text).rates} : {USD:1};
        const prev  = prevR.status===200   ? {USD:1,...JSON.parse(prevR.text).rates}   : rates;
        ffForex.forEach(sym => {
          const b=sym.slice(0,3),q=sym.slice(3,6),bR=rates[b],qR=rates[q];
          if(!bR||!qR) return;
          const price=qR/bR, pc=(prev[q]||qR)/(prev[b]||bR), dec=getDec(sym);
          out[sym]={price:fmt(price,dec),change:fmt(price-pc,dec),changePct:fmt((price-pc)/pc*100,2),high:null,low:null,prevClose:fmt(pc,dec)};
        });
        ["XAUUSD","XAGUSD"].forEach(sym=>{
          if(!ffNeeded.includes(sym)) return;
          const key=sym==="XAUUSD"?"XAU":"XAG", r=rates[key], p=prev[key]||r;
          if(!r) return;
          const price=1/r, pc=1/p;
          out[sym]={price:fmt(price,2),change:fmt(price-pc,2),changePct:fmt((price-pc)/pc*100,2),high:null,low:null,prevClose:fmt(pc,2)};
        });
        console.log("[QUOTE] Frankfurter fallback:", ffNeeded.filter(s=>out[s]).length);
      }
    } catch(e) { console.warn("[QUOTE] Frankfurter failed:", e.message); }
  }

  // ── SOURCE 4: Yahoo Finance fallback for indices/oil (TD rate-limited) ──
  const yahooNeeded = raw.filter(s => out[s]===null &&
    ["NAS100","SPX500","US30","USOIL","UKOIL","UK100","GER40","JPN225","NAS100"].includes(s));
  if (yahooNeeded.length) {
    try {
      const YH_MAP = {
        "NAS100":"^NDX","SPX500":"^GSPC","US30":"^DJI",
        "USOIL":"CL=F","UKOIL":"BZ=F","UK100":"^FTSE",
        "GER40":"^GDAXI","JPN225":"^N225","AUS200":"^AXJO",
      };
      for (const sym of yahooNeeded) {
        const yhSym = YH_MAP[sym]; if (!yhSym) continue;
        try {
          const resp = await httpsGet("query1.finance.yahoo.com",
            "/v8/finance/chart/"+encodeURIComponent(yhSym)+"?interval=1d&range=2d");
          if (resp.status!==200) continue;
          const data = JSON.parse(resp.text);
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) continue;
          const price = meta.regularMarketPrice;
          const prev  = meta.previousClose || meta.chartPreviousClose;
          if (!price) continue;
          const dec = getDec(sym);
          const chg = prev ? price - prev : 0;
          const chgP = prev ? (chg/prev)*100 : 0;
          out[sym] = { price:fmt(price,dec), change:fmt(chg,dec), changePct:fmt(chgP,2), high:null, low:null, prevClose:fmt(prev,dec) };
        } catch(e) { /* skip this symbol */ }
      }
      console.log("[QUOTE] Yahoo fallback:", yahooNeeded.filter(s=>out[s]).length);
    } catch(e) { console.warn("[QUOTE] Yahoo fallback failed:", e.message); }
  }

  console.log("[QUOTE] Final:", raw.filter(s=>out[s]!==null).length+"/"+raw.length+" filled");
  return out;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];   // path only (for routing)
  const fullUrl = req.url;              // includes ?querystring (for qs parsing)

  // GET /api/status
  if (req.method === "GET" && url === "/api/status") {
    return json(res, 200, { status: "online", token: APP_TOKEN, tradeCount: trades.length, serverTime: new Date().toISOString() });
  }

  // GET /api/trades
  if (req.method === "GET" && url === "/api/trades") {
    return json(res, 200, { trades, count: trades.length });
  }

  // DELETE /api/trades
  if (req.method === "DELETE" && url === "/api/trades") {
    trades = []; saveTrades();
    wsBroadcast({ type: "CLEARED" });
    return json(res, 200, { ok: true });
  }

  // POST /api/trades/bulk
  if (req.method === "POST" && url === "/api/trades/bulk") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const reqToken = payload.token || req.headers["x-tradeledger-token"];
      if (reqToken !== APP_TOKEN) return json(res, 401, { error: "Invalid token" });
      const incoming = payload.trades || [];
      let added = 0;
      incoming.forEach(t => {
        if (trades.find(x => x.ticket === Number(t.ticket))) return;
        trades.push(cleanTrade(t)); added++;
      });
      saveTrades();
      wsBroadcast({ type: "BULK_TRADES", trades, count: added });
      console.log(`[BULK] +${added} trades (total: ${trades.length})`);
      return json(res, 201, { ok: true, added, total: trades.length });
    });
    return;
  }

  // POST /api/trades
  if (req.method === "POST" && url === "/api/trades") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let trade;
      try { trade = JSON.parse(body); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const reqToken = trade.token || req.headers["x-tradeledger-token"];
      if (reqToken !== APP_TOKEN) return json(res, 401, { error: "Invalid token" });
      if (trades.find(t => t.ticket === Number(trade.ticket))) return json(res, 200, { ok: true, duplicate: true });
      const clean = cleanTrade(trade);
      trades.push(clean); saveTrades();
      wsBroadcast({ type: "NEW_TRADE", trade: clean });
      console.log(`[SYNC] +1 ${clean.symbol} ${clean.type} $${clean.profit}`);
      return json(res, 201, { ok: true, ticket: clean.ticket });
    });
    return;
  }

  // GET /api/week-events — fetch Mon-Fri of current week in one call
  if (req.method === "GET" && url === "/api/week-events") {
    try {
      const now = new Date();
      const day = now.getUTCDay();
      const mon = new Date(now);
      mon.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
      mon.setUTCHours(0, 0, 0, 0);

      // Check if we have a whole-week cache
      const weekKey = mon.toISOString().slice(0, 10);
      if (!global._weekCache) global._weekCache = {};
      if (global._weekCache[weekKey] && (Date.now() - global._weekCache[weekKey].ts) < 3600000) {
        return json(res, 200, { events: global._weekCache[weekKey].events, source: "cache" });
      }

      // Try ForexFactory CDN first — get both this week and next week files
      const https = require("https");
      const httpGet = (u) => new Promise((resolve, reject) => {
        const r = https.get(u, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }, (resp) => {
          let d = ""; resp.on("data", c => d += c);
          resp.on("end", () => resolve({ status: resp.statusCode, text: d }));
        });
        r.on("error", reject);
        r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
      });

      const ffUrls = [
        "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
        "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      ];

      let allEvents = [];

      for (const u of ffUrls) {
        try {
          const { status, text } = await httpGet(u);
          if (status !== 200 || !text || text.includes("<!DOCTYPE") || text.includes("Request Denied")) continue;
          const arr = JSON.parse(text);
          if (!Array.isArray(arr) || !arr.length) continue;
          allEvents = arr.map(e => ({
            date:     e.date || "",
            currency: e.country || e.currency || "",
            name:     e.title || e.name || "",
            impact:   (e.impact || "").toLowerCase(),
            actual:   (e.actual   != null && e.actual   !== "") ? String(e.actual)   : null,
            forecast: (e.forecast != null && e.forecast !== "") ? String(e.forecast) : null,
            previous: (e.previous != null && e.previous !== "") ? String(e.previous) : null,
            source:   "forexfactory",
          }));
          console.log("[WEEK] FF CDN: " + allEvents.length + " events");
          break;
        } catch(e) { console.warn("[WEEK] FF failed:", e.message); }
      }

      // If FF failed or empty, use AI to generate whole week at once
      if (allEvents.length === 0) {
        try {
          const weekStr = weekKey;
          const prompt = "You are an economic calendar database. Return the forex economic calendar for the full trading week starting Monday " + weekStr + " (Mon-Fri only).\n\nReturn ONLY a valid JSON array, no markdown, no explanation. Each object must have: date (YYYY-MM-DDThh:mm:00Z), currency (3-letter ISO), name (event name), impact (high/medium/low), forecast (string or null), previous (string or null).\n\nInclude all 5 days, all major currencies, all impact levels. Be realistic.";

          const txt = await groqChat([{ role: "user", content: prompt }], { maxTokens: 4000 });
          const match = txt.match(/\[[\s\S]*\]/);
          if (match) {
            const arr = JSON.parse(match[0]);
            if (Array.isArray(arr)) {
              allEvents = arr.filter(e => e.currency && e.name).map(e => ({
                date:     e.date || (weekStr + "T12:00:00Z"),
                currency: (e.currency || "").toUpperCase(),
                name:     e.name || "",
                impact:   (e.impact || "medium").toLowerCase(),
                actual:   null,
                forecast: e.forecast ? String(e.forecast) : null,
                previous: e.previous ? String(e.previous) : null,
                source:   "AI",
              }));
              console.log("[WEEK] AI: " + allEvents.length + " events");
            }
          }
        } catch(e) { console.warn("[WEEK] AI failed:", e.message); }
      }

      allEvents.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      global._weekCache[weekKey] = { events: allEvents, ts: Date.now() };
      return json(res, 200, { events: allEvents, source: allEvents[0]?.source || "none" });
    } catch(e) {
      console.warn("[WEEK] Error:", e.message);
      return json(res, 200, { events: [], source: "error" });
    }
  }

  // GET /api/calendar?date=YYYY-MM-DD
  // FF CDN (live, this/next week) → Claude AI (any date, cached in-memory)
  if (req.method === "GET" && url === "/api/calendar") {
    const qs   = new URL(req.url, "http://x").searchParams;
    const date = qs.get("date");
    if (!date) return json(res, 400, { error: "date param required" });

    const https = require("https");

    // In-memory cache — avoids re-calling AI for the same date
    if (!global._calCache) global._calCache = {};
    if (global._calCache[date]) {
      console.log("[CAL] Cache hit for " + date);
      return json(res, 200, global._calCache[date]);
    }

    const httpGet = (u) => new Promise((resolve, reject) => {
      const r = https.get(u, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }, (resp) => {
        let d = ""; resp.on("data", c => d += c);
        resp.on("end", () => resolve({ status: resp.statusCode, text: d }));
      });
      r.on("error", reject);
      r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    });

    const filterDay = (arr, ds) => arr.filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date);
      const loc = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
      return loc === ds;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Source 1: ForexFactory CDN (real live data, current/next week only)
    const ffUrls = [
      "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://cdn-nfs.faireconomy.media/ff_calendar_nextweek.json",
      "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
    ];
    for (const u of ffUrls) {
      try {
        const { status, text } = await httpGet(u);
        if (status !== 200 || !text || text.includes("<!DOCTYPE") || text.includes("Request Denied") || text.includes("Forbidden")) continue;
        const arr = JSON.parse(text);
        if (!Array.isArray(arr) || !arr.length) continue;
        const norm = arr.map(e => ({
          date:     e.date || "",
          currency: e.country || e.currency || "",
          name:     e.title || e.name || "",
          impact:   (e.impact || "").toLowerCase(),
          actual:   (e.actual   != null && e.actual   !== "") ? String(e.actual)   : null,
          forecast: (e.forecast != null && e.forecast !== "") ? String(e.forecast) : null,
          previous: (e.previous != null && e.previous !== "") ? String(e.previous) : null,
          source:   "forexfactory",
        }));
        const hits = filterDay(norm, date);
        if (hits.length > 0) {
          const payload = { events: hits, source: "forexfactory" };
          global._calCache[date] = payload;
          console.log("[CAL] FF CDN: " + hits.length + " events for " + date);
          return json(res, 200, payload);
        }
      } catch(e) { console.warn("[CAL] FF failed:", e.message); }
    }

    // Source 2: Claude AI — works for ANY date, past or future, cached per date
    try {
      const d = new Date(date + "T12:00:00Z");
      const dayName = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
      const prompt = "You are an economic calendar database. List realistic forex economic calendar events for " + dayName + ". Return ONLY a valid JSON array, no markdown. Each object: time (HH:MM UTC), currency (3-letter ISO), name (event name), impact (high/medium/low), forecast (string or null), previous (string or null). If weekend, return [].";

      const txt = await groqChat([{ role: "user", content: prompt }], { maxTokens: 2500 });
      const match = txt.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          const events = arr
            .filter(e => e.currency && e.name)
            .map(e => ({
              date:     date + "T" + (e.time || "00:00") + ":00Z",
              currency: (e.currency || "").toUpperCase(),
              name:     e.name || "",
              impact:   (e.impact || "medium").toLowerCase(),
              actual:   null,
              forecast: e.forecast ? String(e.forecast) : null,
              previous: e.previous ? String(e.previous) : null,
              source:   "AI",
            }))
            .sort((a, b) => a.date.localeCompare(b.date));
          const payload = { events, source: "AI" };
          global._calCache[date] = payload;
          console.log("[CAL] AI: " + events.length + " events for " + date);
          return json(res, 200, payload);
        }
      }
    } catch(e) { console.warn("[CAL] AI failed:", e.message); }

    return json(res, 200, { events: [], source: "none" });
  }

  // POST /api/briefing  — AI market briefing from news articles
  if (req.method === "POST" && url === "/api/briefing") {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = "";
        req.on("data", c => d += c);
        req.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        req.on("error", reject);
      });

      const articles = (body.articles || []).slice(0, 15);
      if (!articles.length) return json(res, 400, { error: "No articles provided" });

      const now = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
      const src = articles[0]?.source || "news feed";
      const digest = articles.map((a, i) => {
        const d = a.pubDate ? new Date(a.pubDate) : null;
        const timeTag = d ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : "";
        const body2 = a.description && a.description.length > 20 ? a.title + " — " + a.description.slice(0, 150) : a.title;
        return (i + 1) + ". [" + timeTag + "] " + body2;
      }).join("\n");

      const prompt = "You are a forex market analyst. It is " + now + ". Summarise these " + articles.length + " headlines from " + src + " in 3-4 sentences: what is happening, which currencies/pairs are affected, and the near-term directional bias. Be factual and concise — only reference what is in the headlines.\n\nHeadlines:\n" + digest;

      const text = await groqChat([{ role: "user", content: prompt }], { maxTokens: 350 });
      if (!text) return json(res, 500, { error: "Empty AI response" });
      return json(res, 200, { briefing: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[BRIEFING] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // POST /api/analysis  — Weekly AI trade coach (OpenAI)
  if (req.method === "POST" && url === "/api/analysis") {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = "";
        req.on("data", c => d += c);
        req.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        req.on("error", reject);
      });

      const s = body.stats;
      if (!s) return json(res, 400, { error: "stats required" });

      const prompt = "You are a professional forex trading coach. Analyse this trader's data and give exactly 3 bullet points.\n\nDATA:\n- Trades: " + s.total + " | Win rate: " + s.winRate + "% | Net P&L: $" + s.totalProfit + "\n- Profit factor: " + s.pf + " | Expectancy: $" + s.expectancy + " | Avg Win: $" + s.avgWin + " | Avg Loss: $" + s.avgLoss + "\n- Risk:Reward 1:" + s.rr + " | Max drawdown: " + s.maxDD + "% | Max consec losses: " + s.maxCL + "\n- Top symbols: " + (s.bySymbol||[]).slice(0,5).map(x=>x.symbol+":"+x.trades+"t $"+x.profit).join(", ") + "\n- Sessions: " + (s.sessions||"unknown") + "\n\nRespond with EXACTLY 3 bullet points, no intro, no conclusion:\n\u2022 MISTAKES: [specific trading mistakes or weaknesses in the data]\n\u2022 BEST SESSION: [which session to focus on and why]\n\u2022 ADVICE: [1-2 concrete steps to improve next week]";

      const text = await groqChat([{ role: "user", content: prompt }], { maxTokens: 400 });
      if (!text) return json(res, 500, { error: "Empty response from Groq" });
      console.log("[ANALYSIS] Generated via Groq");
      return json(res, 200, { analysis: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[ANALYSIS] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/quote-debug — test all price sources
  if (req.method === "GET" && url === "/api/quote-debug") {
    const https = require("https");
    const httpsGet = (host, path, hdrs={}) => new Promise((resolve, reject) => {
      const r = https.request({ hostname: host, path, method: "GET", timeout: 8000,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", ...hdrs }
      }, (resp) => { let d=""; resp.on("data",c=>d+=c); resp.on("end",()=>resolve({d,status:resp.statusCode})); });
      r.on("error",reject); r.on("timeout",()=>{r.destroy();reject(new Error("timeout"));}); r.end();
    });
    const TD_KEY = process.env.TWELVE_DATA_KEY || "";
    const results = { twelve_data_key_set: !!TD_KEY, key_preview: TD_KEY ? TD_KEY.slice(0,8)+"..." : "NOT SET" };
    try {
      const td = await httpsGet("api.twelvedata.com",
        "/price?symbol=EUR%2FUSD,XAU%2FUSD,BTC%2FUSD,NDX,WTI&apikey=" + TD_KEY + "&dp=5");
      const parsed = td.status===200 ? JSON.parse(td.d) : {};
      results.twelve_data = {
        status: td.status, ok: td.status===200 && !parsed.code,
        eurusd: parsed["EUR/USD"]?.price || "missing",
        xauusd: parsed["XAU/USD"]?.price || "missing",
        btcusd: parsed["BTC/USD"]?.price || "missing",
        nas100: parsed["NDX"]?.price     || "missing",
        wti:    parsed["WTI"]?.price     || "missing",
        error:  parsed.message || parsed.code || null,
      };
    } catch(e) { results.twelve_data = { error: e.message }; }
    try {
      const ff = await httpsGet("api.frankfurter.app", "/latest?from=USD&to=EUR,GBP,JPY,XAU");
      results.frankfurter = { status: ff.status, ok: ff.status===200, sample: ff.d.slice(0,150) };
    } catch(e) { results.frankfurter = { error: e.message }; }
    try {
      const cg = await httpsGet("api.coingecko.com", "/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd");
      results.coingecko = { status: cg.status, ok: cg.status===200, sample: cg.d.slice(0,100) };
    } catch(e) { results.coingecko = { error: e.message }; }
    return json(res, 200, { results, timestamp: new Date().toISOString() });
  }

  // GET /api/ai-debug — test AI connectivity
  if (req.method === "GET" && url === "/api/ai-debug") {
    const orKey = process.env.OPENROUTER_API_KEY || "";
    const gemKey = process.env.GEMINI_API_KEY || "";
    if (!orKey && !gemKey) return json(res, 200, {
      ok: false,
      error: "No AI key found. Add OPENROUTER_API_KEY in Railway Variables.",
      fix: "Go to openrouter.ai → sign up free → Dashboard → API Keys → Create Key → paste as OPENROUTER_API_KEY in Railway Variables"
    });
    try {
      const result = await groqChat([{ role: "user", content: "Reply with exactly: OK" }], { maxTokens: 10 });
      return json(res, 200, { ok: true, response: result, using: orKey ? "OpenRouter" : "Gemini fallback" });
    } catch(e) {
      return json(res, 200, { ok: false, error: e.message, fix: "Check your OPENROUTER_API_KEY at openrouter.ai" });
    }
  }
  // Sources: 1) Twelve Data (primary) 2) CoinGecko (crypto fallback) 3) Frankfurter (forex/metals fallback)
  // Strategy: stale-while-revalidate — serve cached data immediately, refresh in background
  if (req.method === "GET" && url.startsWith("/api/quote")) {
    try {
      const qs = new URLSearchParams(fullUrl.split("?")[1]||"");
      const raw = (qs.get("symbols")||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,30);
      if (!raw.length) return json(res, 400, { error: "symbols required" });

      const cacheKey = getCacheKey(raw);
      const cached   = getCached(cacheKey);

      // ── Serve cached data immediately if available ────────────────────
      if (cached) {
        // Respond immediately with cached data (fresh or stale)
        json(res, 200, { quotes: cached.quotes, fetchedAt: new Date(cached.fetchedAt).toISOString(), cached: true, stale: cached.isStale });

        // If stale, kick off background refresh (only one at a time per symbol set)
        if (cached.isStale && !refreshInFlight.has(cacheKey)) {
          refreshInFlight.add(cacheKey);
          fetchQuotes(raw).then(quotes => {
            priceCache.set(cacheKey, { quotes, fetchedAt: Date.now() });
            console.log("[QUOTE] Background refresh done:", cacheKey.slice(0,60));
          }).catch(e => {
            console.warn("[QUOTE] Background refresh failed:", e.message);
          }).finally(() => {
            refreshInFlight.delete(cacheKey);
          });
        }
        return; // response already sent
      }

      // ── No cache — must wait for fresh fetch ─────────────────────────
      const quotes = await fetchQuotes(raw);
      priceCache.set(cacheKey, { quotes, fetchedAt: Date.now() });
      return json(res, 200, { quotes, fetchedAt: new Date().toISOString(), cached: false });

    } catch(e) {
      console.warn("[QUOTE] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/readarticle?url=...  — Fetch & clean article for reading view
  if (req.method === "GET" && url.startsWith("/api/readarticle")) {
    try {
      const qs = new URLSearchParams(fullUrl.split("?")[1]||"");
      const articleUrl = qs.get("url");
      if (!articleUrl) return json(res, 400, { error: "url required" });

      const https = require("https");
      const http  = require("http");
      const { URL: URLClass } = require("url");
      const hostname = new URLClass(articleUrl).hostname.replace("www.","");

      // ── helper: raw fetch with redirect follow ────────────────────────
      const fetchRaw = (pageUrl, hdrs={}, redirects=0) => new Promise((resolve, reject) => {
        if (redirects > 5) { reject(new Error("too many redirects")); return; }
        const parsed = new URLClass(pageUrl);
        const lib = parsed.protocol === "https:" ? https : http;
        const r = lib.request({
          hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          method: "GET", timeout: 12000,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "identity",
            "Cache-Control": "no-cache",
            ...hdrs
          }
        }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const loc = resp.headers.location.startsWith("http") ? resp.headers.location : parsed.origin + resp.headers.location;
            resolve(fetchRaw(loc, hdrs, redirects+1)); return;
          }
          let d = ""; resp.on("data", c => d += c);
          resp.on("end", () => resolve({ html: d, status: resp.statusCode }));
        });
        r.on("error", reject);
        r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
        r.end();
      });

      // ── helper: detect consent/paywall/block pages ────────────────────
      const isBlocked = (html) => {
        const s = html.slice(0, 8000).toLowerCase();
        return [
          // GDPR consent walls (Yahoo, Google, etc.)
          "je privacy is belangrijk","uw privacy is belangrijk","privacy is important to us",
          "cookie consent","consent.yahoo.com","guce.yahoo.com","privacy dashboard",
          "cookiewall","manage privacy settings","accept all cookies","cookie-wall",
          "privacyinstellingen","cookiebeleid","toestemming","privacybeleid",
          // Bot protection
          "captcha-delivery","geo.captcha","datadome","dd={'rt'","__cf_bm",
          "enable js and disable any ad blocker","please enable javascript",
          "cf-browser-verification","bot protection","access denied",
          // Paywalls
          "subscribe to read","subscription required","subscriber-only",
          "sign in to read","create account to continue","log in to read",
          "paywall","metered-content","piano-paywall","register to read",
          "you've used","free articles","article limit",
        ].some(b => s.includes(b)) || (html.length < 1500);
      };

      // ── helper: extract readable content from HTML ────────────────────
      const extractContent = (html, sourceUrl) => {
        // Title
        const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleM ? titleM[1].replace(/\s*[|\-–—].*$/, "").trim() : "";

        // Meta description
        const descM = html.match(/<meta[^>]+(?:name|property)="(?:og:description|description)"[^>]+content="([^"]{20,})"/i)
                   || html.match(/<meta[^>]+content="([^"]{20,})"[^>]+(?:name|property)="(?:og:description|description)"/i);
        const description = descM ? descM[1] : "";

        // og:image
        const imgM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
                  || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
        const image = imgM ? imgM[1] : "";

        // Article body
        const articleM = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        const mainM    = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
        let section = (articleM?.[1] || mainM?.[1] || html)
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "")
          .replace(/<aside[\s\S]*?<\/aside>/gi, "")
          .replace(/<figure[\s\S]*?<\/figure>/gi, "")
          .replace(/<!--[\s\S]*?-->/g, "");

        const blocks = [];
        const all = section.match(/<(?:p|h[1-4])[^>]*>[\s\S]*?<\/(?:p|h[1-4])>/gi) || [];
        all.forEach(b => {
          const isH = /^<h[1-4]/i.test(b);
          const text = b.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
            .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
            .replace(/\s+/g," ").trim();
          if (text.length > 25) blocks.push({ type: isH ? "heading" : "paragraph", text });
        });

        return { title, description, image, blocks: blocks.slice(0,60), source: hostname };
      };

      // ── STRATEGY 1: use archive.ph / 12ft.io for paywalled/GDPR sites ─
      // Known problematic domains that need bypass
      const needsBypass = [
        "yahoo.com","finance.yahoo.com","wsj.com","ft.com","bloomberg.com",
        "nytimes.com","economist.com","seekingalpha.com","barrons.com"
      ];
      const requiresBypass = needsBypass.some(d => hostname.includes(d));

      if (requiresBypass) {
        // Try 12ft.io reader proxy (strips paywalls and consent walls)
        try {
          const proxyUrl = "https://12ft.io/proxy?q=" + encodeURIComponent(articleUrl);
          const { html, status } = await fetchRaw(proxyUrl, {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
          });
          if (status === 200 && html.length > 3000 && !isBlocked(html)) {
            const content = extractContent(html, articleUrl);
            if (content.blocks.length >= 2) {
              console.log("[READ] 12ft.io ok:", content.blocks.length, "blocks for", hostname);
              return json(res, 200, { ...content, paywalled: false });
            }
          }
        } catch(e) { console.warn("[READ] 12ft failed:", e.message); }

        // 12ft failed — return paywalled with RSS data (caller has title+description already)
        console.log("[READ] Bypass failed for", hostname, "— returning paywalled");
        return json(res, 200, { title:"", description:"", image:"", blocks:[], source: hostname, paywalled: true });
      }

      // ── STRATEGY 2: Direct fetch for open sites ───────────────────────
      const { html, status } = await fetchRaw(articleUrl);
      if (!html || html.length < 500) {
        return json(res, 200, { title:"", description:"", image:"", blocks:[], source: hostname, paywalled: true });
      }

      if (isBlocked(html)) {
        console.log("[READ] Blocked page detected for", hostname);
        return json(res, 200, { title:"", description:"", image:"", blocks:[], source: hostname, paywalled: true });
      }

      const content = extractContent(html, articleUrl);
      console.log("[READ] Direct ok:", content.blocks.length, "blocks for", hostname);
      return json(res, 200, { ...content, paywalled: content.blocks.length < 2 });
    } catch(e) {
      console.warn("[READ] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/predictions?symbols=XAUUSD,BTCUSD,...  — AI predictions anchored to live prices
  if (req.method === "GET" && url.startsWith("/api/predictions")) {
    try {
      const qs = new URLSearchParams(fullUrl.split("?")[1]||"");
      const rawSyms = (qs.get("symbols")||"XAUUSD,BTCUSD").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,4);

      // Cache: 30min per symbol-set; ?bust=1 forces regeneration
      if (!global._predCache) global._predCache = {};
      const cacheKey = rawSyms.slice().sort().join(",");
      const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
      const forceBust = qs.get("bust") === "1";
      const cached = global._predCache[cacheKey];
      if (!forceBust && cached && (Date.now() - cached.ts) < CACHE_TTL) {
        console.log("[PRED] Cache hit for", cacheKey);
        return json(res, 200, cached.data);
      }
      if (forceBust) { delete global._predCache[cacheKey]; console.log("[PRED] Cache busted for", cacheKey); }

      const geminiKey = process.env.GEMINI_API_KEY || "";
      if (!geminiKey) return json(res, 200, { predictions: [], error: "GEMINI_API_KEY not set in Railway Variables" });

      const https = require("https");
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });

      // ── STEP 1: Fetch real live prices for all requested symbols ─────────
      const ASSET_META = {
        XAUUSD:{name:"Gold",type:"commodity",cgId:null,ffBase:"XAU"},
        XAGUSD:{name:"Silver",type:"commodity",cgId:null,ffBase:"XAG"},
        BTCUSD:{name:"Bitcoin",type:"crypto",cgId:"bitcoin"},
        ETHUSD:{name:"Ethereum",type:"crypto",cgId:"ethereum"},
        BNBUSD:{name:"BNB",type:"crypto",cgId:"binancecoin"},
        SOLUSD:{name:"Solana",type:"crypto",cgId:"solana"},
        XRPUSD:{name:"XRP",type:"crypto",cgId:"ripple"},
        EURUSD:{name:"EUR/USD",type:"forex",ffPair:"EUR"},
        GBPUSD:{name:"GBP/USD",type:"forex",ffPair:"GBP"},
        USDJPY:{name:"USD/JPY",type:"forex",ffPair:"JPY",invert:true},
        GBPJPY:{name:"GBP/JPY",type:"forex"},
        AUDUSD:{name:"AUD/USD",type:"forex",ffPair:"AUD"},
        USDCHF:{name:"USD/CHF",type:"forex",ffPair:"CHF",invert:true},
        USDCAD:{name:"USD/CAD",type:"forex",ffPair:"CAD",invert:true},
        NZDUSD:{name:"NZD/USD",type:"forex",ffPair:"NZD"},
        NAS100:{name:"Nasdaq 100",type:"index"},
        SPX500:{name:"S&P 500",type:"index"},
        US30:{name:"Dow Jones",type:"index"},
        USOIL:{name:"WTI Crude Oil",type:"commodity"},
      };

      const httpsGetSimple = (host, path) => new Promise((resolve, reject) => {
        const r = https.request({ hostname:host, path, method:"GET", timeout:8000,
          headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}
        }, resp => { let d=""; resp.on("data",c=>d+=c); resp.on("end",()=>resolve({status:resp.statusCode,text:d})); });
        r.on("error", reject);
        r.on("timeout", ()=>{ r.destroy(); reject(new Error("timeout")); });
        r.end();
      });

      const livePrices = {}; // symbol -> {price, changeP}
      const TD_KEY = process.env.TWELVE_DATA_KEY || "";

      // Twelve Data symbol map (same as quote endpoint)
      const TD_SYM_MAP = {
        "XAUUSD":"XAU/USD","XAGUSD":"XAG/USD","BTCUSD":"BTC/USD","ETHUSD":"ETH/USD",
        "BNBUSD":"BNB/USD","SOLUSD":"SOL/USD","XRPUSD":"XRP/USD",
        "EURUSD":"EUR/USD","GBPUSD":"GBP/USD","USDJPY":"USD/JPY","GBPJPY":"GBP/JPY",
        "AUDUSD":"AUD/USD","USDCHF":"USD/CHF","USDCAD":"USD/CAD","NZDUSD":"NZD/USD",
        "NAS100":"NDX","SPX500":"SPX","US30":"DJI","USOIL":"WTI",
      };

      // ── PRIMARY: Twelve Data (covers everything in one call) ─────────────
      if (TD_KEY) {
        try {
          const tdSyms = rawSyms.map(s=>TD_SYM_MAP[s]).filter(Boolean);
          const tdBack = {}; // TD sym → our sym
          rawSyms.forEach(s=>{ if (TD_SYM_MAP[s]) tdBack[TD_SYM_MAP[s]]=s; });
          if (tdSyms.length) {
            const tdResp = await httpsGetSimple("api.twelvedata.com",
              "/price?symbol=" + encodeURIComponent(tdSyms.join(",")) + "&apikey=" + TD_KEY + "&dp=5");
            if (tdResp.status===200) {
              const tdData = JSON.parse(tdResp.text);
              const isSingle = tdSyms.length===1;
              const priceMap = isSingle ? { [tdSyms[0]]: tdData } : tdData;
              tdSyms.forEach(ts => {
                const ourSym = tdBack[ts];
                if (!ourSym) return;
                const price = parseFloat(priceMap[ts]?.price);
                if (!price || isNaN(price)) return;
                livePrices[ourSym] = { price, changeP: 0 };
              });
            }
            // Also grab 24h change from /quote
            try {
              const tqResp = await httpsGetSimple("api.twelvedata.com",
                "/quote?symbol=" + encodeURIComponent(tdSyms.join(",")) + "&apikey=" + TD_KEY + "&dp=5");
              if (tqResp.status===200) {
                const tqData = JSON.parse(tqResp.text);
                const isSingle = tdSyms.length===1;
                const qMap = isSingle ? { [tdSyms[0]]: tqData } : tqData;
                tdSyms.forEach(ts=>{
                  const ourSym=tdBack[ts];
                  if (!ourSym||!livePrices[ourSym]) return;
                  const q=qMap[ts];
                  if (!q) return;
                  const prev=parseFloat(q.previous_close);
                  const price=livePrices[ourSym].price;
                  if (prev&&prev>0) livePrices[ourSym].changeP=+((price-prev)/prev*100).toFixed(2);
                });
              }
            } catch(e) {}
            console.log("[PRED] TwelveData prices:", rawSyms.filter(s=>livePrices[s]).join(","));
          }
        } catch(e) { console.warn("[PRED] TwelveData failed:", e.message); }
      }

      // ── FALLBACK: CoinGecko (crypto only, if TD missed any) ──────────────
      const cryptoSyms = rawSyms.filter(s=>ASSET_META[s]?.cgId && !livePrices[s]);
      if (cryptoSyms.length) {
        try {
          const ids = cryptoSyms.map(s=>ASSET_META[s].cgId).join(",");
          const cgResp = await httpsGetSimple("api.coingecko.com",
            "/api/v3/simple/price?ids="+ids+"&vs_currencies=usd&include_24hr_change=true");
          if (cgResp.status===200) {
            const cgData = JSON.parse(cgResp.text);
            cryptoSyms.forEach(s=>{
              const id=ASSET_META[s].cgId, d=cgData[id];
              if (d?.usd) livePrices[s]={price:d.usd,changeP:+(d.usd_24h_change||0).toFixed(2)};
            });
            console.log("[PRED] CoinGecko fallback:", cryptoSyms.filter(s=>livePrices[s]).join(","));
          }
        } catch(e) { console.warn("[PRED] CoinGecko fallback failed:", e.message); }
      }

      // ── FALLBACK: Frankfurter (forex/metals if still missing) ────────────
      const metalForexSyms = rawSyms.filter(s=>!livePrices[s]&&(ASSET_META[s]?.ffBase||ASSET_META[s]?.ffPair));
      if (metalForexSyms.length) {
        try {
          const currencies=[...new Set(metalForexSyms.map(s=>ASSET_META[s]?.ffBase||ASSET_META[s]?.ffPair).filter(Boolean))];
          const ffResp=await httpsGetSimple("api.frankfurter.app","/latest?from=USD&to="+currencies.join(","));
          if (ffResp.status===200) {
            const rates=JSON.parse(ffResp.text).rates||{};
            metalForexSyms.forEach(s=>{
              const m=ASSET_META[s], code=m?.ffBase||m?.ffPair;
              if (!code||!rates[code]) return;
              const price=m?.invert?rates[code]:(m?.ffBase?1/rates[code]:1/rates[code]);
              livePrices[s]={price:+price.toFixed(m?.ffBase?2:5),changeP:0};
            });
            console.log("[PRED] Frankfurter fallback:", metalForexSyms.filter(s=>livePrices[s]).join(","));
          }
        } catch(e) { console.warn("[PRED] Frankfurter fallback failed:", e.message); }
      }

      // ── STEP 2: Build prompt with REAL prices injected ───────────────────
      const symLines = rawSyms.map(s=>{
        const m = ASSET_META[s]||{name:s,type:"instrument"};
        const lp = livePrices[s];
        const pip = m.type==="crypto" ? (lp?.price > 1000 ? 1 : 0.01) : m.type==="commodity" ? (s==="XAUUSD"?0.1:0.001) : 0.0001;
        const priceStr = lp
          ? `LIVE PRICE: ${lp.price} | 24h change: ${lp.changeP>0?"+":""}${lp.changeP}%`
          : "price: unknown — use your best realistic estimate";
        return `- ${s} (${m.name}, type: ${m.type}): ${priceStr}`;
      }).join("\n");

      const now2 = new Date();
      const utcH = now2.getUTCHours();
      const sessionCtx = utcH>=0&&utcH<8?"Asian session active":utcH>=8&&utcH<13?"London session active":utcH>=13&&utcH<17?"London/NY overlap — highest volatility":utcH>=17&&utcH<22?"New York session active":"off-hours — low liquidity";

      const prompt = `You are a senior FX and multi-asset analyst. Today is ${dateStr}. Current market session: ${sessionCtx}.

LIVE MARKET PRICES (verified real-time data):
${symLines}

Task: Generate intraday/short-term technical bias for each instrument above.

Rules:
1. support and resistance MUST be realistic key levels near the current price (within 0.5% for forex, 2% for gold, 5% for crypto)
2. target MUST be between current price and the resistance (for BUY) or between support and current price (for SELL)
3. confidence should reflect genuine uncertainty — range 52-78 only. Never above 80.
4. bias the signal toward the session context (e.g. JPY pairs are more active in Asian session)
5. catalyst must be a real, specific, plausible reason — not generic phrases like "market sentiment"
6. Do NOT copy historical price levels — all levels must be within the ranges implied by the live prices above

Respond ONLY with a valid JSON array of exactly ${rawSyms.length} objects, no markdown, no preamble:
[
  {
    "asset": "<exact symbol>",
    "name": "<Asset Name>",
    "currentPrice": <live price number from above>,
    "bias": "bullish|bearish|neutral",
    "signal": "BUY|SELL|HOLD",
    "target": <number — realistic intraday target>,
    "support": <number — key support level below current price>,
    "resistance": <number — key resistance level above current price>,
    "confidence": <integer 52-78>,
    "timeframe": "Today",
    "catalyst": "<specific 1-sentence reason based on session, recent 24h move, or macro context>"
  }
]`;

      const txt = await groqChat([{ role: "user", content: prompt }], { maxTokens: 900 });
      const match = txt.match(/\[[\s\S]*\]/);
      if (!match) return json(res, 200, { predictions: [], error: "Parse failed: " + txt.slice(0,120) });

      let predictions = JSON.parse(match[0]);

      // ── STEP 3: Override currentPrice with actual live data (don't trust AI for this) ─
      predictions = predictions.map(p => {
        const live = livePrices[p.asset];
        if (live) p.currentPrice = live.price;
        return p;
      });

      const result = { predictions, generatedAt: now.toISOString(), symbols: rawSyms, livePrices };
      global._predCache[cacheKey] = { ts: Date.now(), data: result };
      console.log("[PRED] Generated", predictions.length, "predictions for", cacheKey, "with live prices:", Object.keys(livePrices));
      console.log("[PRED] Generated", predictions.length, "predictions");
      return json(res, 200, result);
    } catch(e) {
      console.warn("[PRED] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/news  — Yahoo Finance top stories (server-side, no CORS)
  if (req.method === "GET" && url === "/api/news") {
    try {
      const https = require("https");
      const sources = [
        { url: "https://finance.yahoo.com/news/rssindex", label: "Yahoo Finance" },
        { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US", label: "Yahoo Finance" },
        { url: "https://www.forexlive.com/feed/news", label: "ForexLive" },
      ];

      const fetchRSS = (rssUrl) => new Promise((resolve) => {
        const parsed = new URL(rssUrl);
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TradeLedger/1.0)",
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
          },
          timeout: 8000,
        };
        const r = https.request(options, (resp) => {
          // Follow redirects
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            resolve(fetchRSS(resp.headers.location));
            return;
          }
          let d = "";
          resp.on("data", c => d += c);
          resp.on("end", () => resolve(d));
        });
        r.on("error", () => resolve(""));
        r.on("timeout", () => { r.destroy(); resolve(""); });
        r.end();
      });

      const parseRSS = (xml, label) => {
        const items = [];
        const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        for (const item of itemMatches.slice(0, 20)) {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/)|| [])[1]?.trim() || "";
          const link = (item.match(/<link>(.*?)<\/link>/) || item.match(/<link href="(.*?)"/) || [])[1]?.trim() || "";
          const desc = ((item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || "")
            .replace(/<[^>]*>/g, "").trim().slice(0, 220);
          const pub = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
          if (title.length > 8) items.push({ title, link, description: desc, pubDate: pub, source: label });
        }
        return items;
      };

      // Try sources in order, return first that gives 5+ articles
      for (const src of sources) {
        try {
          const xml = await fetchRSS(src.url);
          if (!xml || xml.includes("Access Denied") || xml.includes("<!DOCTYPE")) continue;
          const items = parseRSS(xml, src.label);
          if (items.length >= 5) {
            console.log(`[NEWS] ${src.label}: ${items.length} articles`);
            return json(res, 200, { articles: items, source: src.label, fetchedAt: new Date().toISOString() });
          }
        } catch(e) { console.warn("[NEWS] failed:", src.url, e.message); }
      }
      return json(res, 200, { articles: [], source: "none", fetchedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[NEWS] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }


  // GET /api/marketsearch?q=gold  — Search news + AI summary for any market/pair
  if (req.method === "GET" && url.startsWith("/api/marketsearch")) {
    // Hard timeout: respond within 18s no matter what
    const searchTimeout = setTimeout(() => {
      if (!res.headersSent) json(res, 200, { query:"timeout", articles:[], aiSummary:null, generatedAt:new Date().toISOString() });
    }, 18000);
    try {
      const q = (new URL("http://x" + url).searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return json(res, 400, { error: "Missing query param q" });

      const https = require("https");

      // Map common pair names to search terms
      const synonyms = {
        "gold":"gold XAU forex","xauusd":"gold XAU price","xau":"gold XAU market",
        "silver":"silver XAG forex","xagusd":"silver XAG","btc":"bitcoin crypto",
        "bitcoin":"bitcoin BTC","eth":"ethereum crypto","ethereum":"ethereum ETH",
        "eurusd":"EUR USD euro dollar forex","eur":"euro EUR forex",
        "gbpusd":"GBP USD pound dollar forex","gbp":"British pound GBP",
        "usdjpy":"USD JPY dollar yen forex","jpy":"Japanese yen JPY",
        "gbpjpy":"GBP JPY pound yen forex","audusd":"AUD USD Australian dollar",
        "usdchf":"USD CHF dollar franc","usdcad":"USD CAD dollar Canadian",
        "nzdusd":"NZD USD New Zealand dollar","oil":"crude oil WTI price",
        "usoil":"crude oil WTI","nas100":"nasdaq 100 tech stocks",
        "nasdaq":"nasdaq 100 stocks","sp500":"S&P 500 US stocks",
        "us30":"dow jones industrial","dow":"dow jones stocks",
        "dxy":"US dollar index DXY","dollar":"US dollar DXY forex",
        "fed":"Federal Reserve interest rates","nfp":"non-farm payrolls jobs report",
        "cpi":"inflation CPI consumer prices","fomc":"Federal Reserve FOMC meeting",
      };
      const searchTerm = synonyms[q] || (q + " forex market news");

      // Fetch Yahoo Finance RSS search
      const rssUrls = [
        "https://finance.yahoo.com/news/rssindex",
        "https://www.forexlive.com/feed/news",
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",
      ];

      const fetchRSS = (rssUrl) => new Promise((resolve) => {
        const parsed = new URL(rssUrl);
        const r = https.request({
          hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "GET",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeLedger/1.0)", "Accept": "application/rss+xml,*/*" },
          timeout: 5000,
        }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) { resolve(fetchRSS(resp.headers.location)); return; }
          let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
        });
        r.on("error", () => resolve("")); r.on("timeout", () => { r.destroy(); resolve(""); }); r.end();
      });
      // Race all feeds — return as soon as ANY gives 5+ results (don't wait for all)
      const raceFeeds = (urls, labels) => new Promise((resolve) => {
        let done = false; let results = [];
        const check = () => { if (!done && results.length === urls.length) { done = true; resolve(results.flat()); } };
        urls.forEach((u, i) => {
          fetchRSS(u).then(xml => {
            if (!xml || xml.includes("Access Denied")) { results.push([]); check(); return; }
            const items = parseRSS(xml, labels[i]);
            results.push(items);
            // If we already have 10+ good items, resolve early
            const total = results.flat().length;
            if (!done && total >= 10) { done = true; resolve(results.flat()); }
            else check();
          });
        });
      });

      const parseRSS = (xml, label) => {
        const items = [];
        const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        for (const item of itemMatches.slice(0, 30)) {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1]?.trim() || "";
          const link  = (item.match(/<link>(.*?)<\/link>/) || [])[1]?.trim() || "";
          const desc  = ((item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || "").replace(/<[^>]*>/g,"").trim().slice(0,220);
          const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
          if (title.length > 8) items.push({ title, link, description: desc, pubDate: pub, source: label });
        }
        return items;
      };

      // Filter articles relevant to the query
      const filterRelevant = (articles, query) => {
        const words = query.toLowerCase().split(" ").filter(w => w.length > 2);
        const scored = articles.map(a => {
          const text = (a.title + " " + a.description).toLowerCase();
          const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
          return { ...a, _score: score };
        });
        const relevant = scored.filter(a => a._score > 0).sort((a,b) => b._score - a._score);
        // If we have relevant results, return them; otherwise return all (might be about the topic anyway)
        return (relevant.length >= 3 ? relevant : scored).slice(0,12);
      };

      // Fetch all RSS sources — resolve as soon as we have enough results
      const labels = ["Yahoo Finance","ForexLive","Yahoo Finance"];
      const allArticles = await raceFeeds(rssUrls, labels);
      const relevant = filterRelevant(allArticles, searchTerm);

      // Generate AI summary using Groq
      let aiSummary = null;
      if (relevant.length > 0) {
        try {
          const digest = relevant.slice(0,10).map((a,i) => (i+1)+". "+a.title+(a.description?" — "+a.description.slice(0,120):"")).join("\n");
          const now = new Date().toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" UTC";
          const prompt = "You are a professional forex/market analyst. It is "+now+". A trader just searched for '"+q.toUpperCase()+"'.\n\nBased on these recent headlines, give a sharp 3-4 sentence market briefing about "+q.toUpperCase()+" right now: what is the current situation, what key factors are driving it, and what is the near-term bias (bullish/bearish/neutral). Be specific and concise.\n\nHeadlines:\n"+digest;
          aiSummary = await groqChat([{ role: "user", content: prompt }], { maxTokens: 300 });
        } catch(e) { console.warn("[MARKETSEARCH] AI error:", e.message); }
      }

      clearTimeout(searchTimeout);
      console.log("[MARKETSEARCH] q="+q+" articles="+relevant.length+" ai="+(aiSummary?"yes":"no"));
      return json(res, 200, {
        query: q,
        articles: relevant,
        aiSummary,
        generatedAt: new Date().toISOString(),
      });
    } catch(e) {
      clearTimeout(searchTimeout);
      console.warn("[MARKETSEARCH] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: "Not found" });
});

server.on("upgrade", (req, socket) => {
  if (req.url === "/ws") wsHandshake(req, socket);
  else socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║     TradeLedger Server — Railway       ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`\n  Port:  ${PORT}`);
  console.log(`  Token: ${APP_TOKEN}`);
  console.log(`\n  Set this in Railway env vars:`);
  console.log(`  TRADELEDGER_TOKEN=${APP_TOKEN}`);
  console.log(`\n  Trades loaded: ${trades.length}\n`);
});
