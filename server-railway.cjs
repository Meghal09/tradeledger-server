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
const DATA_FILE = path.join(__dirname, "trades.json");
try { trades = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
function saveTrades() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(trades, null, 2)); } catch {}
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

  const url = req.url.split("?")[0];

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

  // GET /api/calendar?date=YYYY-MM-DD  — Trading Economics + fallbacks
  if (req.method === "GET" && url === "/api/calendar") {
    const qs   = new URL(req.url, "http://x").searchParams;
    const date = qs.get("date");
    if (!date) return json(res, 400, { error: "date param required" });

    const https = require("https");
    const fetchUrl = (u, opts) => new Promise((resolve, reject) => {
      const options = Object.assign({ headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 8000 }, opts || {});
      const r = https.get(u, options, (resp) => {
        let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve({ status: resp.statusCode, text: d }));
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

    // ── Source 1: Trading Economics (guest:guest free tier) ──────────────────
    // Returns current week events. importance: 1=low, 2=medium, 3=high
    try {
      const d = new Date(date + "T00:00:00Z");
      const d2 = new Date(d); d2.setDate(d2.getDate() + 1);
      const fmt = x => x.toISOString().slice(0,10);
      // Major forex countries only to keep response size small
      const countries = "united states,euro area,united kingdom,japan,australia,canada,new zealand,switzerland,china";
      const teUrl = `https://api.tradingeconomics.com/calendar/country/${encodeURIComponent(countries)}/${fmt(d)}/${fmt(d2)}?c=guest:guest&f=json`;
      const { status, text } = await fetchUrl(teUrl);
      if (status === 200 && text && !text.includes("Forbidden")) {
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.length) {
          const impMap = { 1: "low", 2: "medium", 3: "high" };
          const events = arr.map(e => ({
            date:     e.Date || "",
            currency: e.Currency || e.Country || "",
            name:     e.Event || e.Category || "",
            impact:   impMap[e.Importance] || (e.Importance === 3 ? "high" : e.Importance === 2 ? "medium" : "low"),
            actual:   (e.Actual   != null && e.Actual   !== "") ? String(e.Actual)   : null,
            forecast: (e.Forecast != null && e.Forecast !== "") ? String(e.Forecast) : null,
            previous: (e.Previous != null && e.Previous !== "") ? String(e.Previous) : null,
            source:   "tradingeconomics",
          }));
          const hits = filterDay(events, date);
          if (hits.length > 0) {
            console.log(`[CAL] Trading Economics: ${hits.length} events for ${date}`);
            return json(res, 200, { events: hits, source: "tradingeconomics" });
          }
        }
      }
    } catch(e) { console.warn("[CAL] Trading Economics failed:", e.message); }

    // ── Source 2: FF CDN (may still work for current/next week) ─────────────
    const ffUrls = [
      "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://cdn-nfs.faireconomy.media/ff_calendar_nextweek.json",
    ];
    for (const u of ffUrls) {
      try {
        const { text } = await fetchUrl(u);
        if (!text || text.includes("DOCTYPE") || text.includes("Request Denied")) continue;
        const arr = JSON.parse(text);
        if (!Array.isArray(arr) || !arr.length) continue;
        const norm = arr.map(e => ({
          date: e.date || "", currency: e.country || e.currency || "",
          name: e.title || e.name || "", impact: (e.impact || "").toLowerCase(),
          actual:   (e.actual   != null && e.actual   !== "") ? e.actual   : null,
          forecast: (e.forecast != null && e.forecast !== "") ? e.forecast : null,
          previous: (e.previous != null && e.previous !== "") ? e.previous : null,
          source: "forexfactory",
        }));
        const hits = filterDay(norm, date);
        if (hits.length > 0) {
          console.log(`[CAL] ForexFactory CDN: ${hits.length} events for ${date}`);
          return json(res, 200, { events: hits, source: "forexfactory" });
        }
      } catch(e) { console.warn("[CAL] FF failed:", e.message); }
    }

    // ── Source 3: Claude AI fallback ─────────────────────────────────────────
    try {
      const d = new Date(date + "T12:00:00");
      const dayName = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const prompt = "List all major forex economic calendar events for " + dayName + ".\nReturn ONLY a JSON array. Each object must have: time (HH:MM UTC), currency (3-letter ISO code like USD/EUR/GBP/JPY), name, impact (high/medium/low), forecast (string or null), previous (string or null). Include all impact levels. No extra text, only the JSON array.";

      const body = JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
      const apiKey = process.env.ANTHROPIC_API_KEY || "";

      const aiTxt = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
        }, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
        r.on("error", reject); r.write(body); r.end();
      });

      const aiData = JSON.parse(aiTxt);
      const txt = (aiData.content && aiData.content[0]) ? aiData.content[0].text : "";
      const match = txt.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]);
        const events = arr.map(e => ({
          date: date + "T" + (e.time || "00:00") + ":00",
          currency: e.currency || "", name: e.name || "",
          impact: (e.impact || "medium").toLowerCase(),
          actual: null, forecast: e.forecast || null, previous: e.previous || null, source: "AI"
        }));
        console.log(`[CAL] AI generated ${events.length} events for ${date}`);
        return json(res, 200, { events, source: "AI" });
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
