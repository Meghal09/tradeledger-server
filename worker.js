/**
 * TradeLedger — Cloudflare Worker
 * Full port of the Railway server
 * 
 * KV Namespace: TRADELEDGER_KV  (bind in dashboard as TRADELEDGER_KV)
 * Env vars to set in Cloudflare Dashboard → Workers → Settings → Variables:
 *   TRADELEDGER_TOKEN   = TL-S7PDZ3UV   (your EA token)
 *   OPENROUTER_API_KEY  = (optional, for AI features)
 *   TWELVEDATA_API_KEY  = (optional, for live quotes)
 *   GEMINI_API_KEY      = (optional, AI fallback)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-tradeledger-token",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function cors() {
  return new Response(null, { status: 204, headers: CORS });
}

function cleanTrade(t) {
  return {
    ticket:     Number(t.ticket)     || 0,
    symbol:     String(t.symbol     || "").toUpperCase(),
    type:       String(t.type       || "").toLowerCase(),
    openTime:   String(t.openTime   || t.open_time   || ""),
    closeTime:  String(t.closeTime  || t.close_time  || ""),
    openPrice:  Number(t.openPrice  || t.open_price  || 0),
    closePrice: Number(t.closePrice || t.close_price || 0),
    lots:       Number(t.lots       || t.volume      || 0),
    profit:     Number(t.profit     || 0),
    swap:       Number(t.swap       || 0),
    commission: Number(t.commission || 0),
    sl:         Number(t.sl         || 0),
    tp:         Number(t.tp         || 0),
    comment:    String(t.comment    || ""),
    magic:      Number(t.magic      || 0),
    token:      undefined,
  };
}

// ── KV trade persistence ──────────────────────────────────────────────────────
async function getTrades(env) {
  try {
    const raw = await env.TRADELEDGER_KV.get("trades");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveTrades(env, trades) {
  await env.TRADELEDGER_KV.put("trades", JSON.stringify(trades));
}

// ── KV cache helpers ─────────────────────────────────────────────────────────
async function getCache(env, key) {
  try {
    const raw = await env.TRADELEDGER_KV.get("cache:" + key);
    if (!raw) return null;
    const { data, ts, ttl } = JSON.parse(raw);
    if (Date.now() - ts > ttl) return null;
    return data;
  } catch { return null; }
}

async function setCache(env, key, data, ttlMs = 300000) {
  try {
    await env.TRADELEDGER_KV.put("cache:" + key, JSON.stringify({ data, ts: Date.now(), ttl: ttlMs }), { expirationTtl: Math.ceil(ttlMs / 1000) + 60 });
  } catch {}
}

// ── AI helper (OpenRouter → Gemini fallback) ──────────────────────────────────
const AI_MODELS = [
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-4-maverick:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

async function aiChat(messages, env, maxTokens = 800) {
  const orKey = env.OPENROUTER_API_KEY || "";
  if (orKey) {
    for (const model of AI_MODELS) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + orKey,
            "HTTP-Referer": "https://tradeledger.app",
            "X-Title": "TradeLedger",
          },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
        const text = d.choices?.[0]?.message?.content || "";
        if (!text) throw new Error("Empty response");
        return text;
      } catch (e) {
        console.warn("[AI] Model failed:", model, e.message);
      }
    }
  }

  // Gemini fallback
  const gemKey = env.GEMINI_API_KEY || "";
  if (gemKey) {
    try {
      const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gemKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
      });
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) return text;
    } catch (e) { console.warn("[AI] Gemini failed:", e.message); }
  }

  throw new Error("No AI key configured. Set OPENROUTER_API_KEY in Cloudflare Worker environment variables.");
}

// ── RSS helpers ───────────────────────────────────────────────────────────────
function parseRSS(xml, label) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of matches.slice(0, 25)) {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1]?.trim() || "";
    const link  = (item.match(/<link>(.*?)<\/link>/)                   || [])[1]?.trim() || "";
    const desc  = ((item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || "")
      .replace(/<[^>]*>/g, "").trim().slice(0, 220);
    const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
    if (title.length > 8) items.push({ title, link, description: desc, pubDate: pub, source: label });
  }
  return items;
}

async function fetchRSS(url, label) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeLedger/1.0)", "Accept": "application/rss+xml,*/*" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) return [];
    const xml = await r.text();
    if (!xml || xml.includes("Access Denied") || xml.includes("<!DOCTYPE")) return [];
    return parseRSS(xml, label);
  } catch { return []; }
}

// ── Quote fetching ────────────────────────────────────────────────────────────
const FOREX_PAIRS  = ["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD","GBPJPY","EURJPY","EURGBP"];
const CRYPTO_IDS   = { BTCUSD:"bitcoin", ETHUSD:"ethereum", XRPUSD:"ripple" };
const METAL_BASE   = { XAUUSD:1800, XAGUSD:23 };

async function fetchQuotes(symbols, env) {
  const tdKey = env.TWELVEDATA_API_KEY || "";
  const quotes = {};

  // TwelveData for forex + metals + indices
  if (tdKey) {
    try {
      const sym = symbols.filter(s => !CRYPTO_IDS[s]).join(",");
      if (sym) {
        const r = await fetch(`https://api.twelvedata.com/price?symbol=${sym}&apikey=${tdKey}`);
        const d = await r.json();
        for (const s of sym.split(",")) {
          const entry = symbols.length === 1 ? d : d[s];
          if (entry?.price) quotes[s] = { price: entry.price, symbol: s };
        }
      }
    } catch(e) { console.warn("[QUOTE] TwelveData error:", e.message); }
  }

  // CoinGecko for crypto (free, no key)
  const cryptoSymbols = symbols.filter(s => CRYPTO_IDS[s]);
  if (cryptoSymbols.length > 0) {
    try {
      const ids = cryptoSymbols.map(s => CRYPTO_IDS[s]).join(",");
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      const d = await r.json();
      for (const s of cryptoSymbols) {
        const id = CRYPTO_IDS[s];
        if (d[id]) {
          quotes[s] = {
            price: String(d[id].usd),
            changePct: String((d[id].usd_24h_change || 0).toFixed(4)),
            symbol: s,
          };
        }
      }
    } catch(e) { console.warn("[QUOTE] CoinGecko error:", e.message); }
  }

  // Frankfurter for forex fallback (free, no key)
  const missingForex = symbols.filter(s => !quotes[s] && FOREX_PAIRS.includes(s));
  if (missingForex.length > 0) {
    try {
      const r = await fetch("https://api.frankfurter.app/latest?from=USD");
      const d = await r.json();
      for (const s of missingForex) {
        const base = s.slice(0, 3), quote = s.slice(3);
        if (quote === "USD" && d.rates[base]) {
          quotes[s] = { price: String((1 / d.rates[base]).toFixed(5)), symbol: s };
        } else if (base === "USD" && d.rates[quote]) {
          quotes[s] = { price: String(d.rates[quote].toFixed(5)), symbol: s };
        }
      }
    } catch(e) { console.warn("[QUOTE] Frankfurter error:", e.message); }
  }

  return quotes;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const method = request.method;
    if (method === "OPTIONS") return cors();

    const url   = new URL(request.url);
    const path  = url.pathname;
    const TOKEN = env.TRADELEDGER_TOKEN || "TL-S7PDZ3UV";

    // ── GET /api/status ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/api/status") {
      const trades = await getTrades(env);
      return json({ status: "online", token: TOKEN, tradeCount: trades.length, serverTime: new Date().toISOString(), runtime: "cloudflare-worker" });
    }

    // ── GET /api/trades ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/api/trades") {
      const trades = await getTrades(env);
      return json({ trades, count: trades.length });
    }

    // ── DELETE /api/trades ───────────────────────────────────────────────────
    if (method === "DELETE" && path === "/api/trades") {
      await saveTrades(env, []);
      return json({ ok: true });
    }

    // ── POST /api/trades/bulk ────────────────────────────────────────────────
    if (method === "POST" && path === "/api/trades/bulk") {
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const reqToken = payload.token || request.headers.get("x-tradeledger-token");
      if (reqToken !== TOKEN) return json({ error: "Invalid token" }, 401);

      const trades = await getTrades(env);
      const incoming = payload.trades || [];
      let added = 0;
      for (const t of incoming) {
        if (trades.find(x => x.ticket === Number(t.ticket))) continue;
        trades.push(cleanTrade(t));
        added++;
      }
      await saveTrades(env, trades);
      console.log(`[BULK] +${added} trades (total: ${trades.length})`);
      return json({ ok: true, added, total: trades.length }, 201);
    }

    // ── POST /api/trades ─────────────────────────────────────────────────────
    if (method === "POST" && path === "/api/trades") {
      let trade;
      try { trade = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const reqToken = trade.token || request.headers.get("x-tradeledger-token");
      if (reqToken !== TOKEN) return json({ error: "Invalid token" }, 401);

      const trades = await getTrades(env);
      if (trades.find(t => t.ticket === Number(trade.ticket))) {
        return json({ ok: true, duplicate: true });
      }
      const clean = cleanTrade(trade);
      trades.push(clean);
      await saveTrades(env, trades);
      console.log(`[SYNC] +1 ${clean.symbol} ${clean.type} $${clean.profit}`);
      return json({ ok: true, ticket: clean.ticket }, 201);
    }

    // ── GET /api/week-events ─────────────────────────────────────────────────
    if (method === "GET" && path === "/api/week-events") {
      try {
        const now = new Date();
        const day = now.getUTCDay();
        const mon = new Date(now);
        mon.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
        mon.setUTCHours(0, 0, 0, 0);
        const weekKey = "week:" + mon.toISOString().slice(0, 10);

        const cached = await getCache(env, weekKey);
        if (cached) return json({ events: cached, source: "cache" });

        const ffUrls = [
          "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
          "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
        ];

        let allEvents = [];
        for (const u of ffUrls) {
          try {
            const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!r.ok) continue;
            const text = await r.text();
            if (!text || text.includes("<!DOCTYPE") || text.includes("Request Denied")) continue;
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
            break;
          } catch(e) { console.warn("[WEEK] FF failed:", e.message); }
        }

        // AI fallback
        if (allEvents.length === 0) {
          try {
            const weekStr = mon.toISOString().slice(0, 10);
            const txt = await aiChat([{ role: "user", content: `Return the forex economic calendar for the full trading week starting Monday ${weekStr}. Return ONLY a valid JSON array. Each object must have: date (YYYY-MM-DDThh:mm:00Z), currency, name, impact (high/medium/low), forecast (string or null), previous (string or null). Include all major currencies.` }], env, 3000);
            const match = txt.match(/\[[\s\S]*\]/);
            if (match) {
              const arr = JSON.parse(match[0]);
              if (Array.isArray(arr)) {
                allEvents = arr.filter(e => e.currency && e.name).map(e => ({
                  date: e.date || (weekStr + "T12:00:00Z"),
                  currency: (e.currency || "").toUpperCase(),
                  name: e.name || "",
                  impact: (e.impact || "medium").toLowerCase(),
                  actual: null,
                  forecast: e.forecast ? String(e.forecast) : null,
                  previous: e.previous ? String(e.previous) : null,
                  source: "AI",
                }));
              }
            }
          } catch(e) { console.warn("[WEEK] AI fallback failed:", e.message); }
        }

        allEvents.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        await setCache(env, weekKey, allEvents, 3600000); // 1 hour cache
        return json({ events: allEvents, source: allEvents[0]?.source || "none" });
      } catch(e) {
        return json({ events: [], source: "error", error: e.message });
      }
    }

    // ── GET /api/calendar?date=YYYY-MM-DD ─────────────────────────────────────
    if (method === "GET" && path === "/api/calendar") {
      const date = url.searchParams.get("date");
      if (!date) return json({ error: "date param required" }, 400);

      const cacheKey = "cal:" + date;
      const cached = await getCache(env, cacheKey);
      if (cached) return json(cached);

      // Try ForexFactory CDN
      let events = [];
      const ffUrls = [
        "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
        "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
        "https://cdn-nfs.faireconomy.media/ff_calendar_nextweek.json",
      ];

      const filterDay = (arr) => arr.filter(e => {
        if (!e.date) return false;
        const d = new Date(e.date);
        const loc = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
        return loc === date;
      }).sort((a, b) => new Date(a.date) - new Date(b.date));

      for (const u of ffUrls) {
        try {
          const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (!r.ok) continue;
          const text = await r.text();
          if (!text || text.includes("<!DOCTYPE")) continue;
          const arr = JSON.parse(text);
          if (!Array.isArray(arr)) continue;
          const mapped = arr.map(e => ({
            date: e.date || "", time: e.date ? new Date(e.date).toUTCString().slice(17, 22) : "",
            currency: e.country || e.currency || "", name: e.title || e.name || "",
            impact: (e.impact || "").toLowerCase(),
            actual: e.actual != null ? String(e.actual) : null,
            forecast: e.forecast != null ? String(e.forecast) : null,
            previous: e.previous != null ? String(e.previous) : null,
          }));
          const dayEvents = filterDay(mapped);
          if (dayEvents.length > 0) { events = dayEvents; break; }
        } catch {}
      }

      // AI fallback
      if (events.length === 0) {
        try {
          const dow = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
          const txt = await aiChat([{ role: "user", content: `Return forex economic events for ${dow} ${date}. Return ONLY a valid JSON array. Each object: time (HH:MM UTC), currency, name, impact (high/medium/low), forecast, previous. Include all major events.` }], env, 1500);
          const match = txt.match(/\[[\s\S]*\]/);
          if (match) {
            const arr = JSON.parse(match[0]);
            if (Array.isArray(arr)) {
              events = arr.filter(e => e.name).map(e => ({
                date: date + "T" + (e.time || "12:00") + ":00Z",
                time: e.time || "12:00",
                currency: (e.currency || "").toUpperCase(),
                name: e.name,
                impact: (e.impact || "medium").toLowerCase(),
                actual: null,
                forecast: e.forecast ? String(e.forecast) : null,
                previous: e.previous ? String(e.previous) : null,
              }));
            }
          }
        } catch(e) { console.warn("[CAL] AI failed:", e.message); }
      }

      const result = { date, events, count: events.length };
      await setCache(env, cacheKey, result, 1800000); // 30 min
      return json(result);
    }

    // ── GET /api/quote?symbols=EURUSD,XAUUSD,... ────────────────────────────
    if (method === "GET" && path.startsWith("/api/quote")) {
      try {
        const raw = (url.searchParams.get("symbols") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
        if (!raw.length) return json({ error: "symbols required" }, 400);

        const cacheKey = "quotes:" + raw.sort().join(",");
        const cached = await getCache(env, cacheKey);
        if (cached) return json({ quotes: cached, cached: true, fetchedAt: new Date().toISOString() });

        const quotes = await fetchQuotes(raw, env);
        await setCache(env, cacheKey, quotes, 60000); // 60s cache
        return json({ quotes, cached: false, fetchedAt: new Date().toISOString() });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /api/news ─────────────────────────────────────────────────────────
    if (method === "GET" && path === "/api/news") {
      const cacheKey = "news:feed";
      const cached = await getCache(env, cacheKey);
      if (cached) return json({ articles: cached, source: "cache", fetchedAt: new Date().toISOString() });

      const sources = [
        { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US", label: "Yahoo Finance" },
        { url: "https://finance.yahoo.com/news/rssindex", label: "Yahoo Finance" },
        { url: "https://www.forexlive.com/feed/news", label: "ForexLive" },
      ];

      for (const src of sources) {
        const items = await fetchRSS(src.url, src.label);
        if (items.length >= 5) {
          await setCache(env, cacheKey, items, 600000); // 10 min
          return json({ articles: items, source: src.label, fetchedAt: new Date().toISOString() });
        }
      }
      return json({ articles: [], source: "none", fetchedAt: new Date().toISOString() });
    }

    // ── GET /api/marketsearch?q=gold ─────────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/marketsearch")) {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return json({ error: "Missing query param q" }, 400);

      const synonyms = {
        "gold":"gold XAU forex","xauusd":"gold XAU price","xau":"gold XAU market",
        "silver":"silver XAG forex","btc":"bitcoin crypto","bitcoin":"bitcoin BTC",
        "eth":"ethereum crypto","ethereum":"ethereum ETH","eurusd":"EUR USD euro dollar",
        "eur":"euro EUR forex","gbpusd":"GBP USD pound","gbp":"British pound GBP",
        "usdjpy":"USD JPY dollar yen","jpy":"Japanese yen JPY","oil":"crude oil WTI",
        "usoil":"crude oil WTI","nas100":"nasdaq 100 tech","nasdaq":"nasdaq 100",
        "sp500":"S&P 500 US stocks","us30":"dow jones","fed":"Federal Reserve rates",
        "nfp":"non-farm payrolls","cpi":"inflation CPI","fomc":"Federal Reserve FOMC",
      };
      const searchTerm = synonyms[q] || (q + " forex market news");

      const rssFeeds = [
        { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US", label: "Yahoo Finance" },
        { url: "https://www.forexlive.com/feed/news", label: "ForexLive" },
      ];

      const allArticles = (await Promise.all(rssFeeds.map(f => fetchRSS(f.url, f.label)))).flat();
      const words = searchTerm.toLowerCase().split(" ").filter(w => w.length > 2);
      const scored = allArticles.map(a => {
        const text = (a.title + " " + a.description).toLowerCase();
        const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
        return { ...a, _score: score };
      });
      const relevant = scored.filter(a => a._score > 0).sort((a, b) => b._score - a._score).slice(0, 12);
      const final = relevant.length >= 3 ? relevant : scored.slice(0, 10);

      return json({ query: q, articles: final, aiSummary: null, generatedAt: new Date().toISOString() });
    }

    // ── POST /api/analysis (Performance Coach — local in frontend, kept for compat) ──
    if (method === "POST" && path === "/api/analysis") {
      return json({ analysis: "", note: "Analysis is now local in the frontend" });
    }

    // ── POST /api/briefing (Market briefing — local in frontend, kept for compat) ──
    if (method === "POST" && path === "/api/briefing") {
      return json({ briefing: "", note: "Briefing is now local in the frontend" });
    }

    // ── GET /api/readarticle?url=... ─────────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/readarticle")) {
      try {
        const articleUrl = url.searchParams.get("url");
        if (!articleUrl) return json({ error: "url required" }, 400);

        const r = await fetch(articleUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
            "Accept": "text/html,*/*",
          },
        });
        if (!r.ok) return json({ error: "Failed to fetch article" }, 502);

        const html = await r.text();

        // Strip scripts, styles, nav, headers, footers
        const clean = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000);

        const hostname = new URL(articleUrl).hostname.replace("www.", "");
        return json({ text: clean, hostname, url: articleUrl });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return json({ error: "Not found", path }, 404);
  },
};
