/**
 * TradeLedger Backend — Railway Edition
 * Receives trades from MT5 EA via HTTP POST
 * Serves them to React frontend via REST + WebSocket
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");

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
      const prompt = "You are an economic calendar database. List the realistic forex economic calendar events for " + dayName + ".\n\nReturn ONLY a valid JSON array — no markdown, no explanation, no extra text. Each object must have exactly these fields:\n- \"time\": \"HH:MM\" in UTC (e.g. \"13:30\")\n- \"currency\": 3-letter ISO code (USD, EUR, GBP, JPY, AUD, CAD, NZD, CHF, CNY)\n- \"name\": official event name (e.g. \"Non-Farm Payrolls\", \"ECB Interest Rate Decision\")\n- \"impact\": \"high\", \"medium\", or \"low\"\n- \"forecast\": forecast value as string, or null\n- \"previous\": previous release value as string, or null\n\nInclude events from all major currencies. Include all impact levels (high, medium, low). If it is a weekend, return an empty array []. Be accurate and realistic based on typical release schedules.";

      const body = JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }]
      });
      const apiKey = process.env.ANTHROPIC_API_KEY || "";

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey,
            "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(body); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      const txt = (aiData.content && aiData.content[0]) ? aiData.content[0].text.trim() : "";
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

      const reqBody = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 350, messages: [{ role: "user", content: prompt }] });
      const apiKey = process.env.ANTHROPIC_API_KEY || "";

      const https = require("https");
      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(reqBody)
          }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject);
        r.write(reqBody);
        r.end();
      });

      const aiData = JSON.parse(aiTxt);
      if (aiData.error) return json(res, 500, { error: aiData.error.message });
      const text = aiData.content && aiData.content[0] ? aiData.content[0].text : "";
      if (!text) return json(res, 500, { error: "Empty AI response" });
      return json(res, 200, { briefing: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[BRIEFING] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // POST /api/analysis  — Weekly AI trade coach analysis
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

      const prompt = `You are a professional forex trading coach. Analyse this trader's data and give exactly 3 bullet points.

DATA:
- Trades: ${s.total} | Win rate: ${s.winRate}% | Net P&L: $${s.totalProfit}
- Profit factor: ${s.pf} | Expectancy: $${s.expectancy} | Avg Win: $${s.avgWin} | Avg Loss: $${s.avgLoss}
- Risk:Reward 1:${s.rr} | Max drawdown: ${s.maxDD}% | Max consec losses: ${s.maxCL}
- Top symbols: ${(s.bySymbol||[]).slice(0,5).map(x=>x.symbol+":"+x.trades+"t $"+x.profit).join(", ")}
- Sessions: ${s.sessions||"unknown"}

Respond with EXACTLY 3 bullet points, no intro, no conclusion:
• MISTAKES: [specific trading mistakes or weaknesses in the data]
• BEST SESSION: [which session (Asian/London/New York) to focus on and why]
• ADVICE: [1-2 concrete steps to improve next week]`;

      const reqBody = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] });
      const apiKey = process.env.ANTHROPIC_API_KEY || "";
      const https = require("https");

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(reqBody) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(reqBody); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      if (aiData.error) return json(res, 500, { error: aiData.error.message });
      const text = (aiData.content && aiData.content[0]) ? aiData.content[0].text : "";
      console.log("[ANALYSIS] Generated weekly analysis");
      return json(res, 200, { analysis: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[ANALYSIS] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/quote?symbols=EURUSD,XAUUSD,...  — Yahoo Finance quotes (server-side)
  if (req.method === "GET" && url.startsWith("/api/quote")) {
    try {
      const qs = new URLSearchParams(fullUrl.split("?")[1]||"");
      const raw = (qs.get("symbols")||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,30);
      if (!raw.length) return json(res, 400, { error: "symbols required" });

      const https = require("https");

      // Map TradeLedger symbol → Yahoo Finance ticker
      const yhMap = {
        "XAUUSD":"GC=F","XAGUSD":"SI=F","XPTUSD":"PL=F","XPDUSD":"PA=F",
        "USOIL":"CL=F","UKOIL":"BZ=F","NATGAS":"NG=F",
        "NAS100":"^IXIC","NASDAQ":"^IXIC","US30":"^DJI","SPX500":"^GSPC",
        "UK100":"^FTSE","GER40":"^GDAXI","FRA40":"^FCHI","JPN225":"^N225",
        "AUS200":"^AXJO","HK50":"^HSI","NIFTY50":"^NSEI","DXY":"DX-Y.NYB",
        "BTCUSD":"BTC-USD","ETHUSD":"ETH-USD","BNBUSD":"BNB-USD",
        "SOLUSD":"SOL-USD","XRPUSD":"XRP-USD","ADAUSD":"ADA-USD",
        "DOTUSD":"DOT-USD","LNKUSD":"LINK-USD",
      };

      // For forex pairs (6-char), use Yahoo =X suffix
      const toYH = s => {
        if (yhMap[s]) return yhMap[s];
        if (s.length === 6) return s + "=X";
        return s;
      };

      const tickers = raw.map(toYH).join(",");
      const path = "/v8/finance/quote?symbols=" + encodeURIComponent(tickers) +
                   "&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose&lang=en-US&region=US";

      const fetchYahoo = () => new Promise((resolve, reject) => {
        const options = {
          hostname: "query1.finance.yahoo.com",
          path,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          timeout: 10000,
        };
        const r = https.request(options, (resp) => {
          // Follow one redirect
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const loc = resp.headers.location;
            const url2 = new URL(loc);
            const opts2 = { ...options, hostname: url2.hostname, path: url2.pathname + url2.search };
            const r2 = https.request(opts2, (resp2) => {
              let d = ""; resp2.on("data", c => d += c); resp2.on("end", () => resolve(d));
            });
            r2.on("error", reject); r2.end(); return;
          }
          let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
        });
        r.on("error", reject);
        r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
        r.end();
      });

      const raw2 = await fetchYahoo();
      const data = JSON.parse(raw2);
      const results = data?.quoteResponse?.result || [];

      const out = {};
      for (let i = 0; i < raw.length; i++) {
        const sym = raw[i];
        const yh = toYH(sym);
        const q = results.find(r => r.symbol === yh || r.symbol === sym);
        if (!q) { out[sym] = null; continue; }
        const dec = sym.includes("JPY") ? 3 : (["XAUUSD","BTCUSD","ETHUSD","SPX500","US30","NAS100","UK100","GER40","FRA40","JPN225","AUS200","HK50"].includes(sym) ? 2 : 5);
        const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;
        out[sym] = {
          price:      fmt(q.regularMarketPrice, dec),
          change:     fmt(q.regularMarketChange, dec),
          changePct:  fmt(q.regularMarketChangePercent, 2),
          high:       fmt(q.regularMarketDayHigh, dec),
          low:        fmt(q.regularMarketDayLow, dec),
          prevClose:  fmt(q.regularMarketPreviousClose, dec),
        };
      }

      console.log(`[QUOTE] ${Object.keys(out).length} symbols fetched`);
      return json(res, 200, { quotes: out, fetchedAt: new Date().toISOString() });
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
      const http = require("http");
      const { URL: URLClass } = require("url");

      const fetchPage = (pageUrl, redirects=0) => new Promise((resolve, reject) => {
        if (redirects > 5) { reject(new Error("too many redirects")); return; }
        const parsed = new URLClass(pageUrl);
        const lib = parsed.protocol === "https:" ? https : http;
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          timeout: 10000,
        };
        const r = lib.request(options, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const loc = resp.headers.location.startsWith("http") ? resp.headers.location : parsed.origin + resp.headers.location;
            resolve(fetchPage(loc, redirects + 1)); return;
          }
          let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve({ html: d, status: resp.statusCode }));
        });
        r.on("error", reject);
        r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
        r.end();
      });

      const { html, status } = await fetchPage(articleUrl);
      if (!html || html.length < 200) return json(res, 422, { error: "Empty page" });

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s*[|\-–—].*$/, "").trim() : "";

      // Extract meta description
      const descMatch = html.match(/<meta[^>]+(?:name|property)="(?:description|og:description)"[^>]+content="([^"]+)"/i)
                     || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name|property)="(?:description|og:description)"/i);
      const description = descMatch ? descMatch[1] : "";

      // Extract og:image
      const imgMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
                    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
      const image = imgMatch ? imgMatch[1] : "";

      // Extract article body — look for <article>, then <main>, then biggest <div>
      let body = "";
      const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      const bodySection = articleMatch?.[1] || mainMatch?.[1] || html;

      // Strip scripts, styles, nav, header, footer, aside
      let clean = bodySection
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<aside[\s\S]*?<\/aside>/gi, "")
        .replace(/<figure[\s\S]*?<\/figure>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "");

      // Extract paragraphs
      const paragraphs = [];
      const pMatches = clean.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
      const h2Matches = clean.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi) || [];

      // Interleave headings and paragraphs preserving order
      const allBlocks = (clean.match(/<(?:p|h[1-4])[^>]*>[\s\S]*?<\/(?:p|h[1-4])>/gi) || [])
        .map(b => {
          const isHeading = /^<h[1-4]/i.test(b);
          const text = b.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
          return text.length > 20 ? { type: isHeading ? "heading" : "paragraph", text } : null;
        })
        .filter(Boolean);

      if (allBlocks.length < 3) {
        // Fallback: strip all HTML and split on double newlines
        const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const words = stripped.split(" ");
        // Find article-like content (dense text)
        for (let i = 0; i < Math.min(words.length, 2000); i += 80) {
          const chunk = words.slice(i, i+80).join(" ").trim();
          if (chunk.length > 100) allBlocks.push({ type: "paragraph", text: chunk });
        }
      }

      console.log(`[READ] ${articleUrl.slice(0,60)} → ${allBlocks.length} blocks`);
      return json(res, 200, { title, description, image, blocks: allBlocks.slice(0, 60), source: new URLClass(articleUrl).hostname });
    } catch(e) {
      console.warn("[READ] Error:", e.message);
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
