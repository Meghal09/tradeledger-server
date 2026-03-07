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
const server = http.createServer((req, res) => {
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

  // GET /api/calendar?date=YYYY-MM-DD  — server-side FF fetch + AI fallback
  if (req.method === "GET" && url === "/api/calendar") {
    const qs   = new URL(req.url, "http://x").searchParams;
    const date = qs.get("date");
    if (!date) return json(res, 400, { error: "date param required" });

    const https = require("https");
    const fetchUrl = (u) => new Promise((resolve, reject) => {
      const r = https.get(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 6000 }, (resp) => {
        let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
      });
      r.on("error", reject);
      r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    });

    const normalise = (arr) => arr.map(e => ({
      date: e.date || "", currency: e.country || e.currency || "",
      name: e.title || e.name || "", impact: (e.impact || "").toLowerCase(),
      actual:   (e.actual   != null && e.actual   !== "") ? e.actual   : null,
      forecast: (e.forecast != null && e.forecast !== "") ? e.forecast : null,
      previous: (e.previous != null && e.previous !== "") ? e.previous : null,
    }));

    const filterDay = (arr, ds) => arr.filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date);
      const loc = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
      return loc === ds;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    // 1. Try FF CDN feeds
    const ffUrls = [
      "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      "https://cdn-nfs.faireconomy.media/ff_calendar_nextweek.json",
      "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
    ];
    for (const u of ffUrls) {
      try {
        const txt = await fetchUrl(u);
        if (txt.includes("DOCTYPE") || txt.includes("Request Denied")) continue;
        const arr = JSON.parse(txt);
        if (!Array.isArray(arr) || !arr.length) continue;
        const hits = filterDay(normalise(arr), date);
        if (hits.length > 0) {
          console.log(`[CAL] FF hit ${hits.length} events for ${date}`);
          return json(res, 200, { events: hits, source: "forexfactory" });
        }
      } catch(e) { console.warn("[CAL] FF failed:", e.message); }
    }

    // 2. Fallback: Claude AI
    try {
      const d = new Date(date + "T12:00:00");
      const dayName = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const prompt = "List all major forex economic calendar events for " + dayName + ".\nReturn ONLY a JSON array. Each object must have: time (HH:MM EST), currency (3-letter code), name, impact (high/medium/low), forecast (string or null), previous (string or null). Include all impact levels. No extra text, only the JSON array.";

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
