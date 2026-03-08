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
          const groqKey = process.env.GROQ_API_KEY || "";
          const weekStr = weekKey;
          const prompt = "You are an economic calendar database. Return the forex economic calendar for the full trading week starting Monday " + weekStr + " (Mon-Fri only).\n\nReturn ONLY a valid JSON array, no markdown, no explanation. Each object must have: date (YYYY-MM-DDThh:mm:00Z), currency (3-letter ISO), name (event name), impact (high/medium/low), forecast (string or null), previous (string or null).\n\nInclude all 5 days, all major currencies, all impact levels. Be realistic.";

          const body = JSON.stringify({
            model: "llama-3.1-8b-instant",
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }]
          });

          const aiTxt = await new Promise((resolve, reject) => {
            const r = https.request({
              hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey, "Content-Length": Buffer.byteLength(body) }
            }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
            r.on("error", reject); r.write(body); r.end();
          });

          const aiData = JSON.parse(aiTxt);
          const txt = aiData.choices?.[0]?.message?.content?.trim() || "";
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

      const body = JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }]
      });
      const groqKey = process.env.GROQ_API_KEY || "";

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey, "Content-Length": Buffer.byteLength(body) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(body); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      const txt = aiData.choices?.[0]?.message?.content?.trim() || "";
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

      const groqKey2 = process.env.GROQ_API_KEY || "";
      const reqBody = JSON.stringify({ model: "llama-3.1-8b-instant", max_tokens: 350, messages: [{ role: "user", content: prompt }] });
      const https = require("https");
      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey2, "Content-Length": Buffer.byteLength(reqBody) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(reqBody); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      if (aiData.error) return json(res, 500, { error: aiData.error.message });
      const text = aiData.choices?.[0]?.message?.content || "";
      if (!text) return json(res, 500, { error: "Empty AI response" });
      return json(res, 200, { briefing: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[BRIEFING] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // POST /api/analysis  — Weekly AI trade coach (Groq free tier)
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

      const https = require("https");
      const groqKey = process.env.GROQ_API_KEY || "";
      const reqBody = JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }]
      });

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey, "Content-Length": Buffer.byteLength(reqBody) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(reqBody); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      if (aiData.error) return json(res, 500, { error: aiData.error.message });
      const text = aiData.choices?.[0]?.message?.content || "";
      if (!text) return json(res, 500, { error: "Empty response from Groq" });
      console.log("[ANALYSIS] Generated via Groq (free)");
      return json(res, 200, { analysis: text, generatedAt: new Date().toISOString() });
    } catch(e) {
      console.warn("[ANALYSIS] Error:", e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/quote-debug — test all price sources with EURUSD
  if (req.method === "GET" && url === "/api/quote-debug") {
    const https = require("https");
    const httpsGet = (host, path, hdrs={}) => new Promise((resolve, reject) => {
      const r = https.request({ hostname: host, path, method: "GET", timeout: 8000,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", ...hdrs }
      }, (resp) => { let d=""; resp.on("data",c=>d+=c); resp.on("end",()=>resolve({d,status:resp.statusCode})); });
      r.on("error",reject); r.on("timeout",()=>{r.destroy();reject(new Error("timeout"));}); r.end();
    });
    const results = {};
    try {
      const ff = await httpsGet("api.frankfurter.app", "/latest?from=USD&to=EUR,GBP,JPY");
      results.frankfurter = { status: ff.status, ok: ff.status===200, sample: ff.d.slice(0,120) };
    } catch(e) { results.frankfurter = { error: e.message }; }
    try {
      const cg = await httpsGet("api.coingecko.com", "/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      results.coingecko = { status: cg.status, ok: cg.status===200, sample: cg.d.slice(0,80) };
    } catch(e) { results.coingecko = { error: e.message }; }
    try {
      const yh = await httpsGet("query1.finance.yahoo.com", "/v8/finance/quote?symbols=EURUSD%3DX&fields=regularMarketPrice", { "Cookie": "B=1", "Referer": "https://finance.yahoo.com/" });
      results.yahoo = { status: yh.status, ok: yh.status===200 && yh.d.includes("regularMarketPrice"), sample: yh.d.slice(0,120) };
    } catch(e) { results.yahoo = { error: e.message }; }
    return json(res, 200, results);
  }

  // GET /api/quote?symbols=EURUSD,XAUUSD,...
  // Sources: 1) Frankfurter (forex ECB) 2) Coingecko (crypto) 3) Yahoo Finance (best-effort)
  if (req.method === "GET" && url.startsWith("/api/quote")) {
    try {
      const qs = new URLSearchParams(fullUrl.split("?")[1]||"");
      const raw = (qs.get("symbols")||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,30);
      if (!raw.length) return json(res, 400, { error: "symbols required" });

      const https = require("https");

      // ── helpers ──────────────────────────────────────────────────────────
      const httpsGet = (host, path, hdrs={}, timeout=10000) => new Promise((resolve, reject) => {
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

      // decimal places per symbol
      const getDec = sym => sym.includes("JPY") ? 3
        : ["XAUUSD","XAGUSD","BTCUSD","ETHUSD","BNBUSD","SOLUSD","SPX500","US30","NAS100",
           "UK100","GER40","FRA40","JPN225","AUS200","HK50","NIFTY50","USOIL","UKOIL"].includes(sym) ? 2 : 5;
      const fmt = (v, dec) => v != null && !isNaN(v) ? parseFloat(parseFloat(v).toFixed(dec)) : null;

      // classify symbols
      const CRYPTO_SYMS  = ["BTCUSD","ETHUSD","BNBUSD","SOLUSD","XRPUSD","ADAUSD","DOTUSD","LNKUSD"];
      const METALS_SYMS  = ["XAUUSD","XAGUSD","XPTUSD","XPDUSD"];
      const INDICES_SYMS = ["NAS100","NASDAQ","US30","SPX500","UK100","GER40","FRA40","JPN225","AUS200","HK50","NIFTY50","DXY"];
      const ENERGY_SYMS  = ["USOIL","UKOIL","NATGAS"];
      const isForex = s => !CRYPTO_SYMS.includes(s) && !METALS_SYMS.includes(s) && !INDICES_SYMS.includes(s) && !ENERGY_SYMS.includes(s);

      const out = {};
      raw.forEach(s => { out[s] = null; });

      // ── SOURCE 1: Frankfurter (ECB forex rates) — always reliable ─────────
      const forexSyms = raw.filter(isForex);
      if (forexSyms.length) {
        try {
          // Build a set of unique base currencies needed
          const bases = [...new Set(forexSyms.map(s => s.slice(0,3)))];
          const quoteCs = [...new Set(forexSyms.map(s => s.slice(3,6)))];
          const allCurrencies = [...new Set([...bases, ...quoteCs])].filter(c => c !== "USD").join(",");

          // Fetch latest rates (base USD, get everything)
          const ffResp = await httpsGet("api.frankfurter.app", "/latest?from=USD&to=" + allCurrencies, {});
          if (ffResp.status === 200) {
            const ffData = JSON.parse(ffResp.text);
            const rates = { USD: 1, ...ffData.rates }; // rates vs USD

            // Also get yesterday for prevClose
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
            if (yesterday.getDay() === 0) yesterday.setDate(yesterday.getDate()-2); // skip Sunday
            if (yesterday.getDay() === 6) yesterday.setDate(yesterday.getDate()-1); // skip Saturday
            const yStr = yesterday.toISOString().slice(0,10);
            let prevRates = { USD: 1 };
            try {
              const prevResp = await httpsGet("api.frankfurter.app", "/" + yStr + "?from=USD&to=" + allCurrencies, {});
              if (prevResp.status === 200) { const pd = JSON.parse(prevResp.text); prevRates = { USD: 1, ...pd.rates }; }
            } catch(e) {}

            forexSyms.forEach(sym => {
              const base = sym.slice(0,3), quote = sym.slice(3,6);
              // Convert: base/quote = (USD/quote) / (USD/base) = rates[quote] / rates[base]
              const baseRate = rates[base] || null;
              const quoteRate = rates[quote] || null;
              if (!baseRate || !quoteRate) return;
              const price = quoteRate / baseRate;
              const prevBase = prevRates[base] || baseRate;
              const prevQuote = prevRates[quote] || quoteRate;
              const prevClose = prevQuote / prevBase;
              const change = price - prevClose;
              const changePct = (change / prevClose) * 100;
              const dec = getDec(sym);
              out[sym] = {
                price:     fmt(price, dec),
                change:    fmt(change, dec),
                changePct: fmt(changePct, 2),
                high:      null, // ECB doesn't provide intraday H/L
                low:       null,
                prevClose: fmt(prevClose, dec),
              };
            });
            console.log("[QUOTE] Frankfurter ok:", forexSyms.filter(s=>out[s]).length, "forex pairs");
          }
        } catch(e) { console.warn("[QUOTE] Frankfurter failed:", e.message); }
      }

      // ── SOURCE 1b: Frankfurter metals (XAU, XAG via ECB) ────────────────────
      const metalSyms = raw.filter(s => METALS_SYMS.includes(s));
      if (metalSyms.length) {
        try {
          // Frankfurter supports XAU (gold) and XAG (silver) as base currencies
          const metResp = await httpsGet("api.frankfurter.app", "/latest?from=USD&to=XAU,XAG", {});
          if (metResp.status === 200) {
            const metData = JSON.parse(metResp.text);
            const rates = metData.rates || {}; // rates[XAU] = how much XAU per 1 USD
            // price of 1 XAU in USD = 1 / rates.XAU
            const xauUsd = rates.XAU ? 1 / rates.XAU : null;
            const xagUsd = rates.XAG ? 1 / rates.XAG : null;
            if (xauUsd && out["XAUUSD"] === null) {
              // Get prev day for change calculation
              const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
              if (yesterday.getDay()===0) yesterday.setDate(yesterday.getDate()-2);
              if (yesterday.getDay()===6) yesterday.setDate(yesterday.getDate()-1);
              const yStr = yesterday.toISOString().slice(0,10);
              let prevXau = xauUsd;
              try {
                const prevResp = await httpsGet("api.frankfurter.app", "/" + yStr + "?from=USD&to=XAU", {});
                if (prevResp.status === 200) {
                  const pd = JSON.parse(prevResp.text);
                  if (pd.rates?.XAU) prevXau = 1 / pd.rates.XAU;
                }
              } catch(e) {}
              const change = xauUsd - prevXau;
              const changePct = (change / prevXau) * 100;
              out["XAUUSD"] = { price: fmt(xauUsd,2), change: fmt(change,2), changePct: fmt(changePct,2), high: null, low: null, prevClose: fmt(prevXau,2) };
              console.log("[QUOTE] Frankfurter XAU/USD:", xauUsd.toFixed(2));
            }
            if (xagUsd && out["XAGUSD"] === null) {
              out["XAGUSD"] = { price: fmt(xagUsd,2), change: null, changePct: null, high: null, low: null, prevClose: null };
            }
          }
        } catch(e) { console.warn("[QUOTE] Frankfurter metals failed:", e.message); }
      }

      // ── SOURCE 2: CoinGecko (crypto) — free, no key ───────────────────────
      const cryptoSyms = raw.filter(s => CRYPTO_SYMS.includes(s));
      if (cryptoSyms.length) {
        try {
          const cgMap = {
            "BTCUSD":"bitcoin","ETHUSD":"ethereum","BNBUSD":"binancecoin",
            "SOLUSD":"solana","XRPUSD":"ripple","ADAUSD":"cardano",
            "DOTUSD":"polkadot","LNKUSD":"chainlink"
          };
          const ids = cryptoSyms.map(s => cgMap[s]).filter(Boolean).join(",");
          if (ids) {
            const cgResp = await httpsGet("api.coingecko.com",
              "/api/v3/coins/markets?vs_currency=usd&ids=" + ids + "&price_change_percentage=24h", {
              "Accept": "application/json"
            });
            if (cgResp.status === 200) {
              const cgData = JSON.parse(cgResp.text);
              const cgById = {};
              cgData.forEach(c => { cgById[c.id] = c; });
              cryptoSyms.forEach(sym => {
                const id = cgMap[sym];
                const c = cgById[id];
                if (!c) return;
                const dec = getDec(sym);
                out[sym] = {
                  price:     fmt(c.current_price, dec),
                  change:    fmt(c.price_change_24h, dec),
                  changePct: fmt(c.price_change_percentage_24h, 2),
                  high:      fmt(c.high_24h, dec),
                  low:       fmt(c.low_24h, dec),
                  prevClose: fmt(c.current_price - c.price_change_24h, dec),
                };
              });
              console.log("[QUOTE] CoinGecko ok:", cryptoSyms.filter(s=>out[s]).length, "crypto");
            }
          }
        } catch(e) { console.warn("[QUOTE] CoinGecko failed:", e.message); }
      }

      // ── SOURCE 3: Yahoo Finance (metals, indices, energy + forex fallback) ─
      const yhNeeded = raw.filter(s => out[s] === null);
      if (yhNeeded.length) {
        try {
          const yhMap = {
            "XAUUSD":"GC=F","XAGUSD":"SI=F","XPTUSD":"PL=F","XPDUSD":"PA=F",
            "USOIL":"CL=F","UKOIL":"BZ=F","NATGAS":"NG=F",
            "NAS100":"^IXIC","NASDAQ":"^IXIC","US30":"^DJI","SPX500":"^GSPC",
            "UK100":"^FTSE","GER40":"^GDAXI","FRA40":"^FCHI","JPN225":"^N225",
            "AUS200":"^AXJO","HK50":"^HSI","NIFTY50":"^NSEI","DXY":"DX-Y.NYB",
          };
          const toYH = s => yhMap[s] || (s.length===6 ? s+"=X" : s);
          const tickers = yhNeeded.map(toYH).join(",");

          // Step 1: get cookies + crumb from Yahoo
          let cookie = "";
          let crumb = "";
          try {
            const consent = await httpsGet("finance.yahoo.com", "/", {
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }, 8000);
            cookie = (consent.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
            // Get crumb
            const crumbResp = await httpsGet("query2.finance.yahoo.com", "/v1/test/getcrumb", {
              "Cookie": cookie, "Referer": "https://finance.yahoo.com/"
            }, 5000);
            if (crumbResp.status === 200 && crumbResp.text && crumbResp.text.length < 20) {
              crumb = crumbResp.text.trim();
            }
          } catch(e) { console.warn("[QUOTE] Yahoo crumb failed:", e.message); }

          const crumbParam = crumb ? "&crumb=" + encodeURIComponent(crumb) : "";
          const quotePath = "/v8/finance/quote?symbols=" + encodeURIComponent(tickers) +
            "&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose" + crumbParam;

          const yhResp = await httpsGet("query1.finance.yahoo.com", quotePath, {
            "Cookie": cookie || "B=1",
            "Referer": "https://finance.yahoo.com/",
          });

          if (yhResp.status === 200 && yhResp.text.includes("regularMarketPrice")) {
            const yhData = JSON.parse(yhResp.text);
            const results = yhData?.quoteResponse?.result || [];
            yhNeeded.forEach(sym => {
              const yh = toYH(sym);
              const q = results.find(r => r.symbol === yh || r.symbol === sym);
              if (!q) return;
              const dec = getDec(sym);
              out[sym] = {
                price:     fmt(q.regularMarketPrice, dec),
                change:    fmt(q.regularMarketChange, dec),
                changePct: fmt(q.regularMarketChangePercent, 2),
                high:      fmt(q.regularMarketDayHigh, dec),
                low:       fmt(q.regularMarketDayLow, dec),
                prevClose: fmt(q.regularMarketPreviousClose, dec),
              };
            });
            console.log("[QUOTE] Yahoo ok:", yhNeeded.filter(s=>out[s]).length, "symbols");
          } else {
            console.warn("[QUOTE] Yahoo returned status", yhResp.status, yhResp.text.slice(0,80));
          }
        } catch(e) { console.warn("[QUOTE] Yahoo failed:", e.message); }
      }

      const filled = raw.filter(s => out[s] !== null).length;
      console.log(`[QUOTE] Done: ${filled}/${raw.length} symbols`);
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

  // GET /api/predictions  — AI analyst predictions for GOLD and BTC using Groq
  if (req.method === "GET" && url === "/api/predictions") {
    try {
      // Cache: regenerate every 4 hours
      if (!global._predCache) global._predCache = { ts: 0, data: null };
      const CACHE_TTL = 4 * 60 * 60 * 1000;
      if (global._predCache.data && (Date.now() - global._predCache.ts) < CACHE_TTL) {
        console.log("[PRED] Cache hit");
        return json(res, 200, global._predCache.data);
      }

      const groqKey = process.env.GROQ_API_KEY || "";
      if (!groqKey) return json(res, 200, { predictions: [], error: "GROQ_API_KEY not set" });

      const https = require("https");
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
      const timeStr = now.toUTCString();

      const prompt = `You are a professional market analyst providing price predictions for today, ${dateStr} (${timeStr}).

Generate realistic analyst-style price predictions for GOLD (XAUUSD) and BTC (BTCUSD).
Base your analysis on typical market patterns, key levels, and current macro environment (rate environment, dollar strength, risk sentiment).

Respond ONLY with a valid JSON array, no markdown, no explanation:
[
  {
    "asset": "XAUUSD",
    "name": "Gold",
    "emoji": "🥇",
    "bias": "bullish" or "bearish" or "neutral",
    "target": number (realistic 1-day price target),
    "support": number (key support level),
    "resistance": number (key resistance level),  
    "confidence": number (50-90, percentage),
    "timeframe": "Today" or "This Week",
    "catalyst": "brief 1-sentence reason (e.g. 'Safe-haven demand ahead of NFP data')",
    "analyst": "a plausible analyst name like 'Goldman Sachs Research' or 'JPMorgan Commodities'",
    "signal": "BUY" or "SELL" or "HOLD"
  },
  {
    "asset": "BTCUSD",
    "name": "Bitcoin",
    "emoji": "₿",
    "bias": "bullish" or "bearish" or "neutral",
    "target": number,
    "support": number,
    "resistance": number,
    "confidence": number,
    "timeframe": "Today" or "This Week",
    "catalyst": "brief 1-sentence reason",
    "analyst": "plausible analyst/firm name",
    "signal": "BUY" or "SELL" or "HOLD"
  }
]`;

      const body = JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }]
      });

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey, "Content-Length": Buffer.byteLength(body) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject);
        r.write(body); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      const txt = aiData.choices?.[0]?.message?.content?.trim() || "";
      const match = txt.match(/\[[\s\S]*\]/);
      if (!match) return json(res, 200, { predictions: [], error: "Parse failed: " + txt.slice(0,100) });

      const predictions = JSON.parse(match[0]);
      const result = { predictions, generatedAt: now.toISOString() };
      global._predCache = { ts: Date.now(), data: result };
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
