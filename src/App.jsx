import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const SERVER = "https://tradeledger-server.YOUR-SUBDOMAIN.workers.dev"; // ← replace with your Cloudflare Worker URL
const WS_URL  = ""; // WebSocket not needed — Cloudflare Worker uses polling
const DEFAULT_WL = ["EURUSD","GBPUSD","USDJPY","XAUUSD","GBPJPY","USDCHF","AUDUSD","BTCUSD"];

const C = {
  green:"#26a69a",  red:"#ef5350",   blue:"#2962ff",
  gold:"#f9a825",   purple:"#7e57c2", orange:"#fb8c00",
  cyan:"#26c6da",   indigo:"#5c6bc0",
  bg:"#131722",     card:"#1e222d",  cardHover:"#2a2e39",
  sidebar:"#131722", border:"#2a2e39",
  borderHover:"#434651",
  text:"#d1d4dc",   muted:"#787b86", subtle:"#434651",
  textDim:"#787b86",
  glowGreen:"none", glowBlue:"none", glowRed:"none",
};

// ── Theme tokens — module-level, mutated each render ────────────────────────
const DARK = {
  bg:"#131722",       card:"#1e222d",     cardHover:"#2a2e39",
  sidebar:"#131722",  border:"#2a2e39",
  text:"#d1d4dc",     textSub:"#b2b5be",
  textDim:"#787b86",
  inputBg:"#2a2e39",
  rowHover:"rgba(255,255,255,0.025)",
  chartGrid:"rgba(255,255,255,0.04)",
};
const LIGHT = {
  bg:"#f0f3fa",       card:"#ffffff",     cardHover:"#f7f8fa",
  sidebar:"#1e222d",  border:"#e0e3eb",
  text:"#131722",     textSub:"#434651",
  textDim:"#787b86",
  inputBg:"#f7f8fa",
  rowHover:"rgba(0,0,0,0.018)",
  chartGrid:"rgba(0,0,0,0.05)",
};
// Mutable module-level theme — updated each render before JSX evaluates
let isDark = true;  // mutated each render — readable by all module-level components
let TH = {...DARK};

// MT5 sends dates as "2026.03.07 14:30" (dots, not dashes) — normalise for JS Date
function parseMT5Date(s){
  if(!s) return null;
  const clean = String(s).replace(/\./g,"-").replace(" ","T");
  const d = new Date(clean);
  return isNaN(d.getTime()) ? null : d;
}
function mt5Day(s){ const d=parseMT5Date(s); return d ? d.toISOString().slice(0,10) : null; }
function mt5Hour(s){ const d=parseMT5Date(s); return d ? d.getUTCHours() : null; }

const NAV = [
  {id:"watchlist", icon:"◈", label:"Watchlist"},
  {id:"dashboard", icon:"▦", label:"Dashboard"},
  {id:"calendar",  icon:"◷", label:"Calendar"},
  {id:"news",      icon:"◉", label:"News"},
  {id:"setup",     icon:"⚙", label:"EA Setup"},
];

/* ── analytics ── */
function computeStats(trades) {
  if (!trades.length) return null;
  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit < 0);
  const net = t => t.profit + (t.swap||0) + (t.commission||0);
  const totalProfit = +trades.reduce((s,t) => s+net(t), 0).toFixed(2);
  const gp = wins.reduce((s,t) => s+t.profit, 0);
  const gl = Math.abs(losses.reduce((s,t) => s+t.profit, 0));
  const pf = gl>0 ? +(gp/gl).toFixed(2) : gp>0 ? 99 : 0;
  const avgWin  = wins.length   ? +(gp/wins.length).toFixed(2)   : 0;
  const avgLoss = losses.length ? +(gl/losses.length).toFixed(2) : 0;
  let bal=10000, peak=10000, maxDD=0;
  const equity = trades.map((t,i) => {
    bal += net(t);
    if (bal>peak) peak=bal;
    const dd = ((peak-bal)/peak)*100;
    if (dd>maxDD) maxDD=dd;
    return {n:i+1, bal:+bal.toFixed(2), date:mt5Day(t.closeTime)||(t.closeTime||"").slice(0,10)};
  });
  const symMap = {};
  trades.forEach(t => {
    if (!symMap[t.symbol]) symMap[t.symbol]={symbol:t.symbol,trades:0,profit:0,wins:0};
    symMap[t.symbol].trades++;
    symMap[t.symbol].profit = +(symMap[t.symbol].profit+t.profit).toFixed(2);
    if (t.profit>0) symMap[t.symbol].wins++;
  });
  const sessions={Asian:0,London:0,NewYork:0,Overlap:0};
  trades.forEach(t => {
    const h=mt5Hour(t.openTime)||0;
    if (h>=0  && h<8)  sessions.Asian   +=t.profit;
    if (h>=8  && h<13) sessions.London  +=t.profit;
    if (h>=13 && h<17) sessions.Overlap +=t.profit;
    if (h>=17 && h<22) sessions.NewYork +=t.profit;
  });
  let maxCW=0,maxCL=0,cw=0,cl=0;
  trades.forEach(t => {
    if (t.profit>0){cw++;cl=0;if(cw>maxCW)maxCW=cw;}
    else           {cl++;cw=0;if(cl>maxCL)maxCL=cl;}
  });
  const expectancy = +((wins.length/trades.length)*avgWin-(losses.length/trades.length)*avgLoss).toFixed(2);
  return {
    total:trades.length, wins:wins.length, losses:losses.length,
    winRate:+((wins.length/trades.length)*100).toFixed(1),
    totalProfit, grossProfit:+gp.toFixed(2), grossLoss:+gl.toFixed(2),
    pf, avgWin, avgLoss, rr:avgLoss>0 ? +(avgWin/avgLoss).toFixed(2) : "—",
    maxDD:+maxDD.toFixed(2), equity,
    bySymbol:Object.values(symMap).sort((a,b)=>b.profit-a.profit),
    sessions:Object.entries(sessions).map(([k,v])=>({name:k,profit:+v.toFixed(2)})),
    maxCW, maxCL, expectancy,
  };
}

/* ── CSV export ── */
function exportTradesToCSV(trades) {
  const headers = ["Ticket","Symbol","Type","OpenTime","CloseTime","OpenPrice","ClosePrice","Lots","Profit","Swap","Commission","Net"];
  const rows = trades.map(t => {
    const net = (t.profit||0)+(t.swap||0)+(t.commission||0);
    return [
      t.ticket, t.symbol, t.type,
      t.openTime||"", t.closeTime||"",
      t.openPrice||"", t.closePrice||"",
      t.lots||"",
      (t.profit||0).toFixed(2),
      (t.swap||0).toFixed(2),
      (t.commission||0).toFixed(2),
      net.toFixed(2)
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "TradeLedger_"+new Date().toISOString().slice(0,10)+".csv";
  a.click(); URL.revokeObjectURL(url);
}
const RAILWAY_SERVER = "https://tradeledger-server-production.up.railway.app";
const PRICE_CACHE_KEY = "tl_price_cache";
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5min max stale in localStorage

function getLocalPriceCache(symbols) {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    const age = Date.now() - (cache.savedAt || 0);
    if (age > PRICE_CACHE_TTL) return null;
    // Check if cached symbols cover what we need
    const needed = symbols.every(s => cache.quotes && cache.quotes[s] !== undefined);
    return needed ? cache.quotes : null;
  } catch { return null; }
}

function saveLocalPriceCache(quotes) {
  try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ quotes, savedAt: Date.now() })); } catch {}
}

async function fetchPriceBatch(symbols, { onCachedHit } = {}) {
  // 1. Return localStorage cache instantly if available
  const cached = getLocalPriceCache(symbols);
  if (cached && onCachedHit) { onCachedHit(cached); }

  // 2. Always fetch fresh in background
  try {
    const r = await fetch(RAILWAY_SERVER + "/api/quote?symbols=" + symbols.join(","), {signal: AbortSignal.timeout(20000)});
    if (!r.ok) return cached || {};
    const data = await r.json();
    const quotes = data.quotes || {};
    if (Object.keys(quotes).length) saveLocalPriceCache(quotes);
    return quotes;
  } catch { return cached || {}; }
}

/* ── shared UI ── */
const Tip = ({active,payload,label}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"10px 14px",fontFamily:"'IBM Plex Sans',sans-serif",fontSize:11,boxShadow:"0 4px 16px rgba(15,23,42,0.1)"}}>
      <div style={{color:TH.textDim,marginBottom:4,fontSize:10}}>{label}</div>
      {payload.map((p,i)=><div key={i} style={{color:TH.text,fontWeight:600}}>{p.name}: {p.value}</div>)}
    </div>
  );
};

function KPI({label,value,sub,color="#26a69a",size=24,th}) {
  const bg  = th?.card    || "#1e222d";
  const bdr = th?.border  || "#2a2e39";
  const dim = th?.textDim || "#787b86";
  return (
    <div className="kpi-card" style={{background:bg,border:"1px solid "+bdr,borderRadius:4,padding:"10px 12px"}}>
      <div style={{fontSize:10,color:dim,textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,marginBottom:5}}>{label}</div>
      <div style={{fontSize:size,fontWeight:600,color,fontFamily:"'IBM Plex Mono',monospace",letterSpacing:-0.3,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:dim,marginTop:4}}>{sub}</div>}
    </div>
  );

/* ── month grid ── */
function CalMonthGrid({month,selected,onSelect}) {
  const todayStr = new Date().toISOString().slice(0,10);
  const yr=month.getFullYear(), mo=month.getMonth();
  const firstDow=(new Date(yr,mo,1).getDay()+6)%7;
  const dim=new Date(yr,mo+1,0).getDate();
  const cells=[];
  for(let i=0;i<firstDow;i++) cells.push(null);
  for(let d=1;d<=dim;d++) cells.push(d);
  while(cells.length%7!==0) cells.push(null);
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
      {cells.map((day,idx)=>{
        if(!day) return <div key={idx}/>;
        const ds=yr+"-"+String(mo+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
        const isT=ds===todayStr, isSel=ds===selected, isW=idx%7>=5, isPast=ds<todayStr;
        return (
          <div key={idx} onClick={()=>onSelect(ds)}
            style={{aspectRatio:"1",display:"flex",alignItems:"center",justifyContent:"center",
              background:isSel?"#26a69a":isT?isDark?"rgba(22,163,74,0.15)":"#f0fdf4":isDark?TH.inputBg:"#ffffff",
              border:"1px solid "+(isSel?"#26a69a":isT?"#86efac":TH.border),
              borderRadius:6,cursor:"pointer",fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",
              color:isSel?"#ffffff":isT?"#26a69a":isW?TH.textDim:isPast?TH.textDim:TH.text,
              fontWeight:isSel||isT?700:400,transition:"all 0.12s",boxShadow:isSel?"0 2px 8px rgba(22,163,74,0.3)":"none"}}
            onMouseEnter={e=>{if(!isSel){e.currentTarget.style.background="#f0fdf4";e.currentTarget.style.borderColor="#86efac";e.currentTarget.style.color="#26a69a";}}}
            onMouseLeave={e=>{if(!isSel){e.currentTarget.style.background=isT?"#f0fdf4":"#ffffff";e.currentTarget.style.borderColor=isT?"#86efac":"#d1d4dc";e.currentTarget.style.color=isT?"#26a69a":isW?"#94a3b8":isPast?"#cbd5e1":"#374151";}}}>
            {day}
          </div>
        );
      })}
    </div>
  );
}

/* ── Trading session helper ── */
const getSessions=()=>{
  const now=new Date();
  const utcH=now.getUTCHours(), utcM=now.getUTCMinutes();
  const utcMins=utcH*60+utcM;
  const sessions=[
    {name:"Sydney",  color:"#38bdf8", open:21*60, close:6*60,  overnight:true},
    {name:"Tokyo",   color:"#ffd700", open:0,      close:9*60,  overnight:false},
    {name:"London",  color:"#2962ff", open:8*60,   close:17*60, overnight:false},
    {name:"New York",color:"#ff9900", open:13*60,  close:22*60, overnight:false},
  ];
  return sessions.map(s=>{
    let active;
    if(s.overnight) active=utcMins>=s.open||utcMins<s.close;
    else active=utcMins>=s.open&&utcMins<s.close;
    // overlap: London+NY 13:00-17:00, Tokyo+Sydney 00:00-06:00
    return {...s,active};
  });
};

/* ── Watchlist symbol catalogue ── */
const WL_SYMBOLS={
  Forex:["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","NZDUSD","USDCAD","EURGBP","EURJPY","GBPJPY","EURCHF","AUDJPY","CADJPY","CHFJPY","GBPCHF","EURCAD","AUDCAD","AUDNZD","NZDJPY","GBPCAD","GBPNZD","GBPAUD","EURAUD","EURNZD","CADCHF","NZDCAD","NZDCHF","AUDCHF","USDMXN","USDZAR","USDNOK","USDSEK","USDDKK","USDPLN","USDTRY"],
  Metals:["XAUUSD","XAGUSD","XPTUSD","XPDUSD"],
  Crypto:["BTCUSD","ETHUSD","BNBUSD","SOLUSD","XRPUSD","ADAUSD","DOTUSD","LNKUSD"],
  Indices:["NAS100","US30","SPX500","UK100","GER40","FRA40","JPN225","AUS200","HK50"],
  Energy:["USOIL","UKOIL","NATGAS"],
  Other:["DXY","USDHKD","USDCNH","USDSGD"],
};
const tvSym=sym=>{
  const m={"XAUUSD":"TVC:GOLD","XAGUSD":"TVC:SILVER","XPTUSD":"TVC:PLATINUM","XPDUSD":"TVC:PALLADIUM","NAS100":"NASDAQ:NDX","US30":"DJ:DJI","SPX500":"SP:SPX","UK100":"INDEX:UKX","GER40":"XETR:DAX","FRA40":"EURONEXT:PX1","JPN225":"TSE:NI225","AUS200":"ASX:XJO","HK50":"HKEX:HSI","USOIL":"TVC:USOIL","UKOIL":"TVC:UKOIL","NATGAS":"TVC:NATURALGAS","DXY":"TVC:DXY","BTCUSD":"BITSTAMP:BTCUSD","ETHUSD":"BITSTAMP:ETHUSD","BNBUSD":"BINANCE:BNBUSDT","SOLUSD":"BINANCE:SOLUSDT","XRPUSD":"BITSTAMP:XRPUSD","ADAUSD":"BINANCE:ADAUSDT","DOTUSD":"BINANCE:DOTUSDT","LNKUSD":"BINANCE:LINKUSDT"};
  return m[sym]||(sym.length===6?"FX:"+sym:"FX:"+sym);
};

/* ══════════════════════════════════════════════════════════════ MAIN APP ═══ */

/* ══════════════════════════════ FEATURE COMPONENTS ══════════════════════════ */

/* ── 1. Daily Risk Lock Overlay ── */
function RiskLockOverlay({trades, riskLimit, onDismiss, onEdit}) {
  if (!riskLimit) return null;
  const todayStr = new Date().toISOString().slice(0,10);
  const todayPnl = trades
    .filter(t => mt5Day(t.closeTime)===todayStr)
    .reduce((s,t) => s+(t.profit||0)+(t.swap||0)+(t.commission||0), 0);
  const hit = todayPnl <= -Math.abs(riskLimit);
  if (!hit) return null;
  return (
    <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(10,5,5,0.92)",backdropFilter:"blur(8px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{fontSize:56,marginBottom:16}}>🛑</div>
      <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:28,fontWeight:900,color:"#ef5350",letterSpacing:2,marginBottom:8,textAlign:"center"}}>DAILY LIMIT HIT</div>
      <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:14,color:"rgba(255,255,255,0.5)",marginBottom:4,textAlign:"center"}}>You've reached your maximum daily loss</div>
      <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:42,fontWeight:700,color:"#ef5350",margin:"16px 0"}}>-${Math.abs(todayPnl).toFixed(2)}</div>
      <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:12,color:"rgba(255,255,255,0.35)",textAlign:"center",maxWidth:320,lineHeight:1.7,marginBottom:24}}>
        Your limit is ${Math.abs(riskLimit)}. Step away, protect your capital, and come back tomorrow with a clear head.
      </div>
      <div style={{display:"flex",gap:12}}>
        <button onClick={onEdit} style={{background:TH.inputBg,border:"1px solid rgba(255,255,255,0.15)",borderRadius:4,padding:"10px 20px",color:"rgba(255,255,255,0.5)",fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>Edit Limit</button>
        <button onClick={onDismiss} style={{background:"linear-gradient(135deg,#ef5350,#991b1b)",border:"none",borderRadius:4,padding:"10px 24px",color:"#fff",fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,boxShadow:"0 4px 16px rgba(220,38,38,0.4)"}}>I Understand — Dismiss</button>
      </div>
    </div>
  );
}

/* ── 2. Pre-Trade Checklist Modal ── */
const DEFAULT_CHECKLIST = [
  "Trend direction confirmed on H1/H4",
  "No high-impact news in next 2 hours",
  "Risk:Reward is at least 1:2",
  "Stop loss placed at a key level",
  "Position size calculated correctly",
  "Not revenge trading — calm mindset",
];

function ChecklistModal({open, onClose, checklist, checklistDone, setChecklistDone, onSaveChecklist}) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState(checklist || DEFAULT_CHECKLIST);
  const [newItem, setNewItem] = useState("");
  if (!open) return null;
  const allDone = items.every((_,i) => checklistDone[i]);
  return (
    <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(10,15,30,0.75)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:TH.card,borderRadius:20,padding:28,width:"100%",maxWidth:380,boxShadow:"0 24px 80px rgba(0,0,0,0.25)",animation:"spinIn 0.2s ease"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5,marginBottom:4}}>PRE-TRADE</div>
            <div style={{fontSize:20,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text}}>CHECKLIST</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setEditing(e=>!e)} style={{background:editing?"#dbeafe":"#d1d4dc",border:"none",borderRadius:4,padding:"6px 12px",fontSize:11,cursor:"pointer",color:editing?"#1d4ed8":"#787b86",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>{editing?"Done":"✎ Edit"}</button>
            <button onClick={onClose} style={{background:TH.inputBg,border:"none",borderRadius:4,padding:"6px 10px",fontSize:14,cursor:"pointer",color:TH.textSub}}>✕</button>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
          {items.map((item,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,background:checklistDone[i]?"#f0fdf4":"#f8fafc",borderRadius:4,padding:"10px 12px",border:"1px solid "+(checklistDone[i]?"#86efac":"#d1d4dc"),transition:"all 0.15s"}}>
              <button onClick={()=>setChecklistDone(d=>({...d,[i]:!d[i]}))} style={{width:20,height:20,borderRadius:6,border:"2px solid "+(checklistDone[i]?"#26a69a":"#cbd5e1"),background:checklistDone[i]?"#26a69a":"transparent",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",transition:"all 0.15s"}}>
                {checklistDone[i]?"✓":""}
              </button>
              {editing?(
                <input value={item} onChange={e=>{const u=[...items];u[i]=e.target.value;setItems(u);}} style={{flex:1,border:"none",background:"transparent",fontSize:12,color:"rgba(241,245,249,0.92)",fontFamily:"'IBM Plex Sans',sans-serif",outline:"none"}}/>
              ):(
                <span style={{fontSize:12,color:checklistDone[i]?"#15803d":"#374151",fontFamily:"'IBM Plex Sans',sans-serif",flex:1,textDecoration:checklistDone[i]?"line-through":"none",transition:"all 0.2s"}}>{item}</span>
              )}
              {editing&&<button onClick={()=>setItems(items.filter((_,j)=>j!==i))} style={{background:"rgba(248,113,113,0.1)",border:"none",borderRadius:5,width:18,height:18,cursor:"pointer",color:"#ef5350",fontSize:12,flexShrink:0}}>×</button>}
            </div>
          ))}
          {editing&&(
            <div style={{display:"flex",gap:8}}>
              <input value={newItem} onChange={e=>setNewItem(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newItem.trim()){setItems([...items,newItem.trim()]);setNewItem("");}}} placeholder="Add rule..." style={{flex:1,border:"1px solid "+TH.border,borderRadius:4,padding:"8px 12px",fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",outline:"none"}}/>
              <button onClick={()=>{if(newItem.trim()){setItems([...items,newItem.trim()]);setNewItem("");}}} style={{background:"#2563eb",border:"none",borderRadius:4,padding:"8px 12px",color:"#fff",cursor:"pointer",fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>+</button>
            </div>
          )}
        </div>
        {editing&&<button onClick={()=>{onSaveChecklist(items);setEditing(false);}} style={{width:"100%",background:isDark?"#131722":"#1e293b",border:"none",borderRadius:4,padding:"12px",color:"#fff",fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,marginBottom:10}}>SAVE RULES</button>}
        <div style={{background:allDone?"linear-gradient(135deg,#26a69a,#047857)":"#d1d4dc",borderRadius:4,padding:"12px",textAlign:"center",transition:"all 0.3s"}}>
          <div style={{fontSize:allDone?13:11,fontWeight:700,color:allDone?"#fff":"#94a3b8",fontFamily:"'IBM Plex Sans',sans-serif"}}>
            {allDone?"✅ ALL CLEAR — Trade with confidence!":items.filter((_,i)=>checklistDone[i]).length+"/"+items.length+" rules passed"}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 3. Trade Mood/Tag Modal ── */
/* ── Trade Quick-Grade Modal (replaces tag system) ── */
// 5 crisp yes/no questions per trade — fast, honest, no emoji guessing
const GRADE_QUESTIONS = [
  {id:"plan",   q:"Did you have a clear plan before entering?",      yes:"✓ Planned",  no:"✗ Impulse"},
  {id:"sl",     q:"Was your stop loss at a logical price level?",     yes:"✓ Logical",  no:"✗ Random"},
  {id:"rr",     q:"Was the potential R:R at least 1:2?",             yes:"✓ Good RR",  no:"✗ Poor RR"},
  {id:"news",   q:"Did you check for high-impact news first?",        yes:"✓ Checked",  no:"✗ Skipped"},
  {id:"exit",   q:"Did you exit at your original target/stop?",       yes:"✓ Disciplined", no:"✗ Moved"},
];

function TradeGradeModal({trade, journals, onSave, onClose}) {
  if (!trade) return null;
  const existing = journals[trade.ticket]?.tradeGrade || {};
  const existingNote = journals[trade.ticket]?.quickNote || "";
  const [answers, setAnswers] = useState(existing);
  const [note, setNote]   = useState(existingNote);

  const answered = Object.keys(answers).length;
  const score    = Object.values(answers).filter(Boolean).length;
  const grade    = answered===0 ? null : score>=5?"A":score>=4?"B":score>=3?"C":score>=2?"D":"F";
  const gradeCol = {"A":"#26a69a","B":"#26a69a","C":"#d97706","D":"#ea580c","F":"#ef5350"}[grade]||"#94a3b8";
  const gradeMsg = {"A":"Perfect execution — nothing to change.","B":"Solid trade, one slip.","C":"Average — review what you skipped.","D":"Two rules broken — journal why.","F":"Full review needed before next trade."}[grade]||"";

  const isBuy   = (trade.type||"").toString().toLowerCase().includes("buy")||trade.type===0;
  const profit  = trade.profit||0;

  return (
    <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(8,12,24,0.82)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:TH.card,borderRadius:22,width:"100%",maxWidth:400,boxShadow:"0 32px 96px rgba(0,0,0,0.28)",animation:"spinIn 0.2s ease",overflow:"hidden"}}>

        {/* Header strip */}
        <div style={{background:isDark?"#131722":TH.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5,marginBottom:3}}>TRADE GRADER</div>
            <div style={{fontSize:17,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:"#fff",letterSpacing:0.5}}>
              {trade.symbol}
              <span style={{fontSize:11,fontWeight:600,color:isBuy?"#26a69a":"#ef5350",marginLeft:8}}>{isBuy?"▲ BUY":"▼ SELL"}</span>
              <span style={{fontSize:11,fontWeight:700,color:profit>=0?"#26a69a":"#ef5350",marginLeft:8}}>{profit>=0?"+":""}${profit.toFixed(2)}</span>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {grade&&<div style={{width:36,height:36,borderRadius:4,background:gradeCol,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:900,fontFamily:"'IBM Plex Sans',sans-serif",color:"#fff",boxShadow:"0 4px 12px "+gradeCol+"66"}}>{grade}</div>}
            <button onClick={onClose} style={{background:"rgba(255,255,255,0.06)",border:"none",borderRadius:4,padding:"6px 10px",fontSize:14,cursor:"pointer",color:"rgba(255,255,255,0.6)"}}>✕</button>
          </div>
        </div>

        <div style={{padding:"20px 20px 0"}}>
          {/* Questions */}
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
            {GRADE_QUESTIONS.map((q,i)=>{
              const ans = answers[q.id];
              return (
                <div key={q.id} style={{border:"1.5px solid "+(ans===true?"#86efac":ans===false?"#ef9a9a":TH.border),borderRadius:4,padding:"10px 14px",background:ans===true?isDark?"rgba(52,211,153,0.08)":"#f0fdf4":ans===false?isDark?"rgba(252,129,129,0.08)":"#fff5f5":TH.inputBg,transition:"all 0.15s"}}>
                  <div style={{fontSize:11,color:"rgba(241,245,249,0.92)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:500,marginBottom:8,lineHeight:1.4}}>{i+1}. {q.q}</div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setAnswers(a=>({...a,[q.id]:true}))}
                      style={{flex:1,padding:"7px",borderRadius:4,border:"1.5px solid "+(ans===true?"#26a69a":TH.border),background:ans===true?"#26a69a":TH.inputBg,color:ans===true?"#fff":TH.textSub,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",transition:"all 0.15s"}}>
                      {q.yes}
                    </button>
                    <button onClick={()=>setAnswers(a=>({...a,[q.id]:false}))}
                      style={{flex:1,padding:"7px",borderRadius:4,border:"1.5px solid "+(ans===false?"#ef5350":TH.border),background:ans===false?"#ef5350":TH.inputBg,color:ans===false?"#fff":TH.textSub,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",transition:"all 0.15s"}}>
                      {q.no}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Score bar */}
          {answered>0&&(
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.textDim,marginBottom:5}}>
                <span>EXECUTION SCORE</span>
                <span style={{color:gradeCol,fontWeight:700}}>{score}/{GRADE_QUESTIONS.length} — Grade {grade}</span>
              </div>
              <div style={{height:6,background:TH.inputBg,borderRadius:4,overflow:"hidden"}}>
                <div style={{height:"100%",width:(score/GRADE_QUESTIONS.length*100)+"%",background:gradeCol,borderRadius:4,transition:"width 0.4s ease"}}/>
              </div>
              <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:5}}>{gradeMsg}</div>
            </div>
          )}

          {/* Quick note */}
          <div style={{marginBottom:16}}>
            <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:6,fontWeight:600}}>QUICK NOTE (optional)</div>
            <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2}
              placeholder="What happened? What would you do differently?"
              style={{width:"100%",border:"1.5px solid #e4e9f0",borderRadius:4,padding:"9px 12px",fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text,resize:"none",outline:"none",background:TH.inputBg,boxSizing:"border-box"}}
              onFocus={e=>e.target.style.borderColor="#2563eb"}
              onBlur={e=>e.target.style.borderColor="#e4e9f0"}/>
          </div>
        </div>

        <div style={{padding:"0 20px 20px"}}>
          <button onClick={()=>onSave(trade.ticket, answers, note, grade)}
            style={{width:"100%",background:grade?"linear-gradient(135deg,"+gradeCol+","+gradeCol+"cc)":isDark?"linear-gradient(135deg,#131722,#1e293b)":"linear-gradient(135deg,#1e222d,#2a3f8a)",border:"none",borderRadius:4,padding:"14px",color:"#fff",fontSize:13,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,boxShadow:grade?"0 4px 16px "+gradeCol+"44":"none",transition:"all 0.3s"}}>
            {grade?"SAVE GRADE "+grade+" TRADE":"SAVE TO JOURNAL"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 4. Trade Replay Mini-Timeline ── */
/* ── Seeded pseudo-random (deterministic per trade) ── */
function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function TradeReplay({trade, onClose}) {
  if (!trade) return null;
  return <TradeReplayInner trade={trade} onClose={onClose}/>;
}

function TradeReplayInner({trade, onClose}) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const animRef = useRef(null);

  const entry  = trade.openPrice  || trade.price  || 0;
  const exit   = trade.closePrice || trade.price  || entry;
  const profit = trade.profit || 0;
  const isBuy  = (trade.type||"").toString().toLowerCase().includes("buy") || trade.type===0;
  const sl     = trade.sl  || (isBuy ? entry * 0.9975 : entry * 1.0025);
  const tp     = trade.tp  || (isBuy ? entry * 1.005  : entry * 0.995);

  const duration = trade.openTime && trade.closeTime
    ? Math.round((new Date(trade.closeTime.replace(/\./g,"-").replace(" ","T"))
       - new Date(trade.openTime.replace(/\./g,"-").replace(" ","T"))) / 60000)
    : null;

  // Determine price precision
  const dec = entry > 1000 ? 2 : entry > 10 ? 3 : entry > 1 ? 5 : 5;
  const fmt = p => p.toFixed(dec);

  // ----- GENERATE CANDLES -----
  // Seed = ticket number for determinism
  const rand = seededRand(parseInt(String(trade.ticket || 1234).replace(/\D/g,"")) || 7777);

  // volatility = distance between entry and SL
  const vol = Math.abs(entry - sl);
  const candleVol = vol * 0.38; // tighter candles — body ~38% of SL distance

  // Helper: build one candle from a "close" price reference
  const makeCandle = (prevClose, bias) => {
    const move    = (rand() - 0.5 + bias * 0.3) * candleVol * 2;
    const close   = prevClose + move;
    const bodyH   = Math.abs(close - prevClose);
    const wickMul = 0.15 + rand() * 0.25;
    const high    = Math.max(close, prevClose) + bodyH * wickMul + rand() * candleVol * 0.2;
    const low     = Math.min(close, prevClose) - bodyH * wickMul - rand() * candleVol * 0.2;
    return { open: prevClose, close, high, low, bull: close >= prevClose };
  };

  // 2 pre-entry candles (slightly trending toward entry)
  const preBias = isBuy ? 0.15 : -0.15;
  const pre1Start = isBuy ? entry - vol * 3 : entry + vol * 3;
  const candle0   = makeCandle(pre1Start, preBias);
  const candle1   = makeCandle(candle0.close, preBias);

  // Entry candle — opens at entry, shows the trigger
  const entryBody  = vol * (0.3 + rand() * 0.3);
  const entryClose = isBuy ? entry + entryBody : entry - entryBody;
  const entryCandle = {
    open:  entry,
    close: entryClose,
    high:  Math.max(entry, entryClose) + vol * 0.15,
    low:   Math.min(entry, entryClose) - vol * 0.1,
    bull:  entryClose >= entry,
    isEntry: true,
  };

  // Trade candles — from after entry to the exit price
  // Number of mid candles depends on duration: ~1 candle per 15 min, min 2, max 8
  const midCount = Math.min(8, Math.max(2, duration ? Math.round(duration / 15) : 4));
  const tradeCandlesRaw = [];
  let prev = entryClose;
  // Progress toward exit linearly with noise
  for (let i = 0; i < midCount; i++) {
    const progress = (i + 1) / (midCount + 1);
    const target   = entry + (exit - entry) * progress;
    const noise    = (rand() - 0.5) * candleVol;
    const close    = prev + (target - prev) * 0.6 + noise;
    const bodyH    = Math.abs(close - prev);
    const wk       = 0.12 + rand() * 0.22;
    const high     = Math.max(close, prev) + bodyH * wk + rand() * candleVol * 0.1;
    const low      = Math.min(close, prev) - bodyH * wk - rand() * candleVol * 0.1;
    tradeCandlesRaw.push({ open: prev, close, high, low, bull: close >= prev });
    prev = close;
  }

  // Exit candle — forcefully reaches the exit price
  const exitCandle = {
    open:   prev,
    close:  exit,
    high:   Math.max(prev, exit) + vol * 0.12,
    low:    Math.min(prev, exit) - vol * 0.12,
    bull:   exit >= prev,
    isExit: true,
    won:    profit >= 0,
  };

  const allCandles = [candle0, candle1, entryCandle, ...tradeCandlesRaw, exitCandle];
  const TOTAL = allCandles.length;

  // ----- CHART DIMENSIONS -----
  const W = 520, H = 260;
  const PAD = { top: 20, bottom: 28, left: 8, right: 62 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  // Price range: all candles + SL + TP with padding
  const allPrices = allCandles.flatMap(c => [c.high, c.low]).concat([sl, tp]).filter(Boolean);
  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const pad    = (rawMax - rawMin) * 0.15;
  const pMin   = rawMin - pad;
  const pMax   = rawMax + pad;
  const py = price => PAD.top + chartH - ((price - pMin) / (pMax - pMin)) * chartH;

  // Candle x positions — slim Japanese-style candles
  const cW    = Math.floor(chartW / TOTAL);
  const bodyW = Math.max(3, Math.min(10, Math.floor(cW * 0.45))); // max 45% of slot, max 10px
  const cx    = i => PAD.left + i * cW + cW / 2;

  // Visible candles (for animation)
  const visible = allCandles.slice(0, visibleCount);

  // Price axis ticks (4 levels)
  const ticks = Array.from({length: 5}, (_, i) => pMin + (pMax - pMin) * i / 4);

  // Animation controls
  const startPlay = () => {
    setVisibleCount(0);
    setPlaying(true);
    let i = 0;
    const step = () => {
      i++;
      setVisibleCount(i);
      if (i < TOTAL) {
        animRef.current = setTimeout(step, 380);
      } else {
        setPlaying(false);
      }
    };
    animRef.current = setTimeout(step, 180);
  };
  useEffect(() => {
    setVisibleCount(TOTAL); // show all on mount
    return () => clearTimeout(animRef.current);
  }, [trade]);
  const reset = () => { clearTimeout(animRef.current); setVisibleCount(0); setPlaying(false); };

  return (
    <div style={{position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
      {/* Backdrop — only covers behind popup */}
      <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(5,8,18,0.72)",backdropFilter:"blur(6px)",zIndex:0,pointerEvents:"all"}}/>
      <div onClick={e=>e.stopPropagation()}
        style={{position:"relative",zIndex:1,pointerEvents:"all",
          background:"#0b1120",borderRadius:22,padding:"20px 22px 18px",
          width:"min(96vw,600px)",maxHeight:"90vh",overflowY:"auto",
          boxShadow:"0 24px 80px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.07)",
          animation:"spinIn 0.22s ease"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:34,height:34,borderRadius:4,background:isBuy?"rgba(74,222,128,0.15)":"rgba(248,113,113,0.15)",border:"1px solid "+(isBuy?"rgba(74,222,128,0.3)":"rgba(248,113,113,0.3)"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{isBuy?"▲":"▼"}</div>
            <div>
              <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5}}>CANDLE REPLAY</div>
              <div style={{fontSize:17,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:"#fff",letterSpacing:0.3}}>
                {trade.symbol} <span style={{fontSize:11,color:isBuy?"#26a69a":"#ef5350",fontWeight:600}}>{isBuy?"LONG":"SHORT"}</span>
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {/* Play/Reset */}
            <button onClick={playing ? ()=>{clearTimeout(animRef.current);setPlaying(false);} : startPlay}
              style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:4,
                padding:"6px 14px",color:"rgba(255,255,255,0.7)",fontSize:11,cursor:"pointer",
                fontFamily:"'IBM Plex Sans',sans-serif",display:"flex",alignItems:"center",gap:5}}>
              {playing ? "⏸ PAUSE" : visibleCount===0 ? "▶ PLAY" : "↺ REPLAY"}
            </button>
            <button onClick={onClose} style={{background:"rgba(255,255,255,0.09)",border:"none",borderRadius:4,padding:"6px 10px",fontSize:14,cursor:"pointer",color:"rgba(255,255,255,0.4)"}}>✕</button>
          </div>
        </div>

        {/* Candlestick SVG Chart */}
        <div style={{background:"#060d1a",borderRadius:4,border:"1px solid rgba(255,255,255,0.05)",overflow:"hidden",marginBottom:14,position:"relative"}}>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
            {/* Grid lines */}
            {ticks.map((t,i)=>(
              <line key={i} x1={PAD.left} x2={W-PAD.right} y1={py(t)} y2={py(t)}
                stroke={TH.chartGrid} strokeWidth="1"/>
            ))}
            {/* Price axis labels */}
            {ticks.map((t,i)=>(
              <text key={i} x={W-PAD.right+6} y={py(t)+3.5}
                fontSize="7.5" fill="rgba(255,255,255,0.25)" fontFamily="DM Mono">{fmt(t)}</text>
            ))}

            {/* SL zone fill */}
            {sl&&(
              <rect x={PAD.left} y={isBuy?py(sl):PAD.top} width={chartW}
                height={isBuy?H-PAD.bottom-py(sl):py(sl)-PAD.top}
                fill="rgba(248,113,113,0.04)"/>
            )}
            {/* TP zone fill */}
            {tp&&(
              <rect x={PAD.left} y={isBuy?PAD.top:py(tp)} width={chartW}
                height={isBuy?py(tp)-PAD.top:H-PAD.bottom-py(tp)}
                fill="rgba(74,222,128,0.04)"/>
            )}

            {/* SL line */}
            {sl&&<>
              <line x1={PAD.left} x2={W-PAD.right} y1={py(sl)} y2={py(sl)}
                stroke="rgba(248,113,113,0.55)" strokeWidth="1" strokeDasharray="4 3"/>
              <text x={W-PAD.right+5} y={py(sl)-3} fontSize="7" fill="#ef5350" fontFamily="DM Mono">SL</text>
              <text x={W-PAD.right+5} y={py(sl)+7} fontSize="7" fill="rgba(248,113,113,0.6)" fontFamily="DM Mono">{fmt(sl)}</text>
            </>}
            {/* TP line */}
            {tp&&<>
              <line x1={PAD.left} x2={W-PAD.right} y1={py(tp)} y2={py(tp)}
                stroke="rgba(74,222,128,0.5)" strokeWidth="1" strokeDasharray="4 3"/>
              <text x={W-PAD.right+5} y={py(tp)-3} fontSize="7" fill="#26a69a" fontFamily="DM Mono">TP</text>
              <text x={W-PAD.right+5} y={py(tp)+7} fontSize="7" fill="rgba(74,222,128,0.6)" fontFamily="DM Mono">{fmt(tp)}</text>
            </>}
            {/* Entry line — dashed white */}
            <line x1={PAD.left} x2={W-PAD.right} y1={py(entry)} y2={py(entry)}
              stroke="rgba(255,255,255,0.3)" strokeWidth="1" strokeDasharray="3 3"/>

            {/* Pre-entry separator */}
            <line x1={PAD.left + 2*cW} x2={PAD.left + 2*cW} y1={PAD.top} y2={H-PAD.bottom}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="2 4"/>
            <text x={PAD.left + 2*cW - 18} y={PAD.top+10} fontSize="6.5" fill="rgba(255,255,255,0.2)" fontFamily="DM Mono">BEFORE</text>
            <text x={PAD.left + 2*cW + 4} y={PAD.top+10} fontSize="6.5" fill="rgba(255,255,255,0.2)" fontFamily="DM Mono">TRADE</text>

            {/* Candles */}
            {visible.map((c, i) => {
              const x   = cx(i);
              const top = py(c.high);
              const bot = py(c.low);
              const bTop = py(Math.max(c.open, c.close));
              const bBot = py(Math.min(c.open, c.close));
              const bH   = Math.max(bBot - bTop, 1.5);
              const isPre = i < 2;
              const isEnt = c.isEntry;
              const isExt = c.isExit;

              const bullColor  = isEnt ? "#60a5fa" : isExt ? (c.won?"#26a69a":"#ef5350") : isPre ? "rgba(100,116,139,0.7)" : "#26a69a";
              const bearColor  = isEnt ? "#60a5fa" : isExt ? (c.won?"#26a69a":"#ef5350") : isPre ? "rgba(100,116,139,0.5)" : "#ef5350";
              const bodyColor  = c.bull ? bullColor : bearColor;
              const wickColor  = isPre ? "rgba(100,116,139,0.5)" : "rgba(255,255,255,0.2)";

              return (
                <g key={i} style={{opacity: 1, animation: "fadeIn 0.2s ease"}}>
                  {/* Wick */}
                  <line x1={x} x2={x} y1={top} y2={bot} stroke={wickColor} strokeWidth="1.2"/>
                  {/* Body */}
                  <rect x={x - bodyW/2} y={bTop} width={bodyW} height={bH}
                    fill={c.bull ? bodyColor : "transparent"}
                    stroke={bodyColor} strokeWidth={c.bull ? 0 : 1.2}
                    rx="1.5"
                    opacity={isPre ? 0.55 : 1}/>
                  {/* Entry marker */}
                  {isEnt && (
                    <g>
                      <circle cx={x} cy={py(entry)} r="4" fill="#3b82f6" opacity="0.9"/>
                      <text x={x+7} y={py(entry)+3.5} fontSize="7" fill="#60a5fa" fontFamily="DM Mono" fontWeight="bold">ENTRY</text>
                    </g>
                  )}
                  {/* Exit marker */}
                  {isExt && (
                    <g>
                      <circle cx={x} cy={py(exit)} r="4" fill={c.won?"#26a69a":"#ef5350"} opacity="0.9"/>
                      <text x={x+7} y={py(exit)+3.5} fontSize="7" fill={c.won?"#26a69a":"#ef5350"} fontFamily="DM Mono" fontWeight="bold">EXIT</text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* Candle count labels at bottom */}
            {allCandles.map((_,i) => (
              <text key={i} x={cx(i)} y={H-6} fontSize="6.5" fill="rgba(255,255,255,0.15)" fontFamily="DM Mono" textAnchor="middle">
                {i===0?"C-2":i===1?"C-1":i===2?"ENT":i===TOTAL-1?"EXT":"·"}
              </text>
            ))}
          </svg>

          {/* Candle count badge */}
          <div style={{position:"absolute",top:8,left:10,fontSize:8,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif"}}>
            {visibleCount}/{TOTAL} candles
          </div>
        </div>

        {/* Stats row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {[
            {label:"P&L",    value:(profit>=0?"+":"")+"$"+profit.toFixed(2), color:profit>=0?"#26a69a":"#ef5350"},
            {label:"ENTRY",  value:fmt(entry),   color:"rgba(255,255,255,0.7)"},
            {label:"EXIT",   value:fmt(exit),    color:profit>=0?"#26a69a":"#ef5350"},
            {label:"DURATION",value:duration!=null?(duration<60?duration+"m":Math.floor(duration/60)+"h"+(duration%60?"  "+duration%60+"m":"")):"–", color:"rgba(255,255,255,0.5)"},
          ].map(r=>(
            <div key={r.label} style={{background:TH.inputBg,borderRadius:4,padding:"9px 11px",border:"1px solid rgba(255,255,255,0.05)"}}>
              <div style={{fontSize:7,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:3,letterSpacing:0.5}}>{r.label}</div>
              <div style={{fontSize:12,fontWeight:700,color:r.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{r.value}</div>
            </div>
          ))}
        </div>

        {/* Outcome tag */}
        <div style={{marginTop:10,padding:"8px 14px",borderRadius:4,
          background:profit>=0?"rgba(74,222,128,0.08)":"rgba(248,113,113,0.08)",
          border:"1px solid "+(profit>=0?"rgba(74,222,128,0.15)":"rgba(248,113,113,0.15)"),
          display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:15}}>{profit>=0?"✅":"❌"}</span>
          <span style={{fontSize:10,color:profit>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>
            {profit>=0?"WINNER":"LOSER"} · {isBuy?"LONG":"SHORT"} · {trade.symbol}
          </span>
          {sl&&<span style={{fontSize:9,color:"rgba(255,255,255,0.25)",fontFamily:"'IBM Plex Sans',sans-serif",marginLeft:"auto"}}>
            SL {fmt(sl)} · TP {fmt(tp)}
          </span>}
        </div>
      </div>
    </div>
  );
}

/* ── 5. Streak & Mindset Banner ── */
function StreakBanner({trades, onClick}) {
  if (!trades.length) return null;
  // Count current streak from most recent trades
  let streak = 0, streakType = null;
  for (let i = trades.length-1; i >= 0; i--) {
    const w = trades[i].profit > 0;
    if (streakType === null) streakType = w;
    if (w === streakType) streak++;
    else break;
  }
  if (streak < 2) return null;
  const isWin = streakType;
  const msgs = isWin
    ? ["Stay disciplined — stick to your rules","Great run! Don't let winners turn to overtrading","You're hot — keep the same process, not just the result"]
    : ["Every pro hits a wall. Rules first, always.","Step back. Is your edge still valid today?","Cut size, protect capital, reset."];
  const msg = msgs[Math.min(streak-2, msgs.length-1)];
  return (
    <div onClick={onClick} style={{background:isWin?"linear-gradient(135deg,rgba(5,150,105,0.12),rgba(5,150,105,0.04))":"linear-gradient(135deg,rgba(225,29,72,0.12),rgba(225,29,72,0.04))",border:"1px solid "+(isWin?"rgba(5,150,105,0.25)":"rgba(225,29,72,0.2)"),borderRadius:4,padding:"10px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:"pointer",transition:"all 0.2s"}}>
      <div style={{fontSize:22,flexShrink:0}}>{isWin?"🔥":"❄️"}</div>
      <div style={{flex:1}}>
        <div style={{fontSize:11,fontWeight:700,color:isWin?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>
          {streak}-TRADE {isWin?"WIN":"LOSS"} STREAK
        </div>
        <div style={{fontSize:10,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:1}}>{msg}</div>
      </div>
      <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>TAP ▸</div>
    </div>
  );
}

/* ── 6. SURPRISE: Daily P&L Speedometer widget ── */
function DailySpeedometer({trades, riskLimit}) {
  const todayStr = new Date().toISOString().slice(0,10);
  const todayTrades = trades.filter(t => mt5Day(t.closeTime)===todayStr);
  const todayPnl = todayTrades.reduce((s,t) => s+(t.profit||0)+(t.swap||0)+(t.commission||0), 0);
  const todayWins = todayTrades.filter(t=>t.profit>0).length;
  const limit = riskLimit ? Math.abs(riskLimit) : 100;
  // Speedometer angle: -120deg (left/loss) to +120deg (right/profit)
  const maxRange = Math.max(limit, Math.abs(todayPnl), 50);
  const angle = Math.max(-118, Math.min(118, (todayPnl / maxRange) * 118));
  const pctUsed = riskLimit ? Math.min(100, Math.abs(Math.min(todayPnl,0)) / limit * 100) : 0;
  const col = todayPnl > 0 ? "#26a69a" : todayPnl < 0 ? "#ef5350" : "#787b86";
  return (
    <div style={{background:TH.card,borderRadius:4,padding:"16px 20px",border:"1px solid "+TH.border,boxShadow:"0 2px 10px rgba(13,17,23,0.07)",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:9,color:TH.textSub,letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>TODAY'S P&L</div>
        <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{todayTrades.length} trades · {todayWins}W/{todayTrades.length-todayWins}L</div>
      </div>
      {/* Speedometer SVG */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
        <svg width="200" height="110" viewBox="0 0 200 110" style={{overflow:"visible"}}>
          {/* Background arc */}
          <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#d1d4dc" strokeWidth="14" strokeLinecap="round"/>
          {/* Loss zone (red) */}
          <path d="M 20 100 A 80 80 0 0 1 100 20" fill="none" stroke="rgba(239,83,80,0.12)" strokeWidth="14" strokeLinecap="round"/>
          {/* Profit zone (green) */}
          <path d="M 100 20 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(38,166,154,0.12)" strokeWidth="14" strokeLinecap="round"/>
          {/* Risk limit tick */}
          {riskLimit&&<line x1="20" y1="100" x2="28" y2="100" stroke="#ef5350" strokeWidth="2" style={{transformOrigin:"100px 100px",transform:"rotate(-120deg)"}}/>}
          {/* Center */}
          <circle cx="100" cy="100" r="6" fill={col} opacity="0.9"/>
          {/* Needle */}
          <line
            x1="100" y1="100"
            x2="100" y2="30"
            stroke={col} strokeWidth="2.5" strokeLinecap="round"
            style={{transformOrigin:"100px 100px",transform:"rotate("+angle+"deg)",transition:"transform 0.8s cubic-bezier(0.34,1.56,0.64,1)"}}/>
          {/* Labels */}
          <text x="12" y="105" fontSize="8" fill="#ef5350" fontFamily="DM Mono">LOSS</text>
          <text x="156" y="105" fontSize="8" fill="#26a69a" fontFamily="DM Mono">PROFIT</text>
        </svg>
      </div>
      <div style={{textAlign:"center",marginBottom:riskLimit?10:0}}>
        <div style={{fontSize:28,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:col,letterSpacing:-1,lineHeight:1}}>{todayPnl>=0?"+":""}{todayPnl.toFixed(2)}</div>
        {!todayTrades.length&&<div style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:4}}>No trades today</div>}
      </div>
      {riskLimit&&(
        <div style={{marginTop:8}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:3}}>
            <span>Daily risk used</span><span style={{color:pctUsed>80?"#ef5350":"#787b86"}}>{pctUsed.toFixed(0)}% of ${limit}</span>
          </div>
          <div style={{height:4,background:TH.inputBg,borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:pctUsed+"%",background:pctUsed>80?"linear-gradient(90deg,#f59e0b,#ef5350)":"#26a69a",borderRadius:4,transition:"width 0.5s ease"}}/>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 7. SURPRISE: Risk Calculator quick widget ── */
function RiskCalc() {
  // Persist balance and risk % across sessions
  const [balance, setBalance] = useState(()=>{try{return localStorage.getItem("tl_balance")||"10000";}catch{return "10000";}});
  const [riskPct, setRiskPct] = useState(()=>{try{return localStorage.getItem("tl_riskpct")||"1";}catch{return "1";}});
  const [entry,   setEntry]   = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [sym,     setSym]     = useState("EURUSD");

  // Symbol metadata: pip size and contract size (standard lot)
  const SYMS = {
    "EURUSD":{pip:0.0001,contract:100000,cat:"Forex"},
    "GBPUSD":{pip:0.0001,contract:100000,cat:"Forex"},
    "AUDUSD":{pip:0.0001,contract:100000,cat:"Forex"},
    "NZDUSD":{pip:0.0001,contract:100000,cat:"Forex"},
    "USDCAD":{pip:0.0001,contract:100000,cat:"Forex"},
    "USDCHF":{pip:0.0001,contract:100000,cat:"Forex"},
    "GBPCHF":{pip:0.0001,contract:100000,cat:"Forex"},
    "EURGBP":{pip:0.0001,contract:100000,cat:"Forex"},
    "USDJPY":{pip:0.01,  contract:100000,cat:"Forex"},
    "GBPJPY":{pip:0.01,  contract:100000,cat:"Forex"},
    "EURJPY":{pip:0.01,  contract:100000,cat:"Forex"},
    "XAUUSD":{pip:0.1,   contract:100,   cat:"Metal"},
    "XAGUSD":{pip:0.001, contract:5000,  cat:"Metal"},
    "BTCUSD":{pip:1,     contract:1,     cat:"Crypto"},
    "ETHUSD":{pip:0.1,   contract:1,     cat:"Crypto"},
    "SOLUSD":{pip:0.01,  contract:1,     cat:"Crypto"},
    "NAS100":{pip:0.25,  contract:20,    cat:"Index"},
    "US30":  {pip:1,     contract:5,     cat:"Index"},
    "SPX500":{pip:0.25,  contract:50,    cat:"Index"},
    "USOIL": {pip:0.01,  contract:1000,  cat:"Energy"},
  };
  const meta = SYMS[sym] || {pip:0.0001,contract:100000,cat:"Forex"};

  const entryN  = parseFloat(entry);
  const slN     = parseFloat(slPrice);
  const balN    = parseFloat(balance) || 0;
  const riskN   = parseFloat(riskPct) || 0;
  const riskAmt = balN * riskN / 100;

  // Distance in price units → pips → lot size
  const priceDist    = (entryN && slN && entryN !== slN) ? Math.abs(entryN - slN) : 0;
  const pipsCount    = priceDist > 0 ? priceDist / meta.pip : 0;
  const pipValPerLot = meta.pip * meta.contract; // $ value of 1 pip per standard lot
  const lots         = (pipsCount > 0 && riskAmt > 0) ? (riskAmt / (pipsCount * pipValPerLot)).toFixed(2) : "–";
  const isBuy        = (entryN && slN) ? entryN > slN : null;

  const saveB = v => { setBalance(v); try{localStorage.setItem("tl_balance",v);}catch{}; };
  const saveR = v => { setRiskPct(v); try{localStorage.setItem("tl_riskpct",v);}catch{}; };

  const field = (label, value, set, opts) => (
    <div>
      <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5,fontWeight:600}}>{label}</div>
      {opts ? (
        <select value={value} onChange={e=>set(e.target.value)}
          style={{width:"100%",background:TH.inputBg,border:"1.5px solid #e4e9f0",borderRadius:9,padding:"9px 10px",fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text,outline:"none",cursor:"pointer"}}>
          {Object.keys(SYMS).map(s=><option key={s} value={s}>{s} <span style={{color:TH.textDim}}>· {SYMS[s].cat}</span></option>)}
        </select>
      ) : (
        <input type="number" value={value} onChange={e=>set(e.target.value)} step="any" placeholder="0"
          style={{width:"100%",background:TH.inputBg,border:"1.5px solid #e4e9f0",borderRadius:9,padding:"9px 10px",fontSize:13,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text,outline:"none",transition:"border-color 0.15s"}}
          onFocus={e=>e.target.style.borderColor="#2563eb"}
          onBlur={e=>e.target.style.borderColor="#e4e9f0"}/>
      )}
    </div>
  );

  return (
    <div style={{background:TH.card,borderRadius:4,padding:"18px 20px",border:"1px solid "+TH.border,boxShadow:"0 2px 10px rgba(13,17,23,0.07)"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <div style={{width:30,height:30,borderRadius:9,background:"linear-gradient(135deg,#2563eb,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,boxShadow:"0 3px 10px rgba(37,99,235,0.3)"}}>⚖</div>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>POSITION CALCULATOR</div>
            <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:1}}>price-based · auto lot size</div>
          </div>
        </div>
        {/* Category badge */}
        <div style={{background:TH.inputBg,borderRadius:6,padding:"3px 8px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.textSub,fontWeight:600}}>{meta.cat}</div>
      </div>

      {/* Row 1: Balance + Risk % */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
        {field("ACCOUNT BALANCE ($)", balance, saveB)}
        {field("RISK PER TRADE (%)", riskPct, saveR)}
      </div>

      {/* Row 2: Symbol full width */}
      <div style={{marginBottom:10}}>{field("SYMBOL", sym, setSym, true)}</div>

      {/* Row 3: Entry + SL price — visually connected with arrow */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 28px 1fr",gap:0,alignItems:"end",marginBottom:12}}>
        <div>
          <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5,fontWeight:600}}>ENTRY PRICE</div>
          <input type="number" value={entry} onChange={e=>setEntry(e.target.value)} step="any"
            placeholder={sym==="XAUUSD"?"2320":sym==="BTCUSD"?"67000":sym==="USDJPY"?"153.20":"1.0850"}
            style={{width:"100%",background: isBuy===true?"#f0fdf4":isBuy===false?"#fff0f3":"#f8fafc",
              border:"1.5px solid "+(isBuy===true?"#86efac":isBuy===false?"#ef9a9a":"#e4e9f0"),
              borderRadius:"9px 0 0 9px",borderRight:"none",padding:"10px 12px",fontSize:13,
              fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text,outline:"none"}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:40,background:isBuy===true?"#f0fdf4":isBuy===false?"#fff0f3":"#f8fafc",border:"1.5px solid "+(isBuy===true?"#86efac":isBuy===false?"#ef9a9a":"#e4e9f0"),borderLeft:"none",borderRight:"none",color:isBuy===true?"#26a69a":isBuy===false?"#ef5350":"#94a3b8",fontSize:10,fontWeight:700}}>
          {isBuy===true?"▲":isBuy===false?"▼":"↕"}
        </div>
        <div>
          <div style={{fontSize:9,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5,fontWeight:600}}>STOP LOSS PRICE</div>
          <input type="number" value={slPrice} onChange={e=>setSlPrice(e.target.value)} step="any"
            placeholder={sym==="XAUUSD"?"2300":sym==="BTCUSD"?"65000":sym==="USDJPY"?"152.50":"1.0820"}
            style={{width:"100%",background:"rgba(248,113,113,0.06)",border:"1.5px solid #ef9a9a",
              borderRadius:"0 9px 9px 0",borderLeft:"none",padding:"10px 12px",fontSize:13,
              fontFamily:"'IBM Plex Sans',sans-serif",color:"#ef5350",outline:"none"}}/>
        </div>
      </div>

      {/* Distance pill — shows when both prices entered */}
      {priceDist > 0 && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:12,padding:"6px 0"}}>
          <div style={{height:1,flex:1,background:"linear-gradient(90deg,transparent,#e4e9f0)"}}/>
          <div style={{background:TH.inputBg,borderRadius:99,padding:"3px 12px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.textSub,fontWeight:700,whiteSpace:"nowrap"}}>
            {pipsCount.toFixed(1)} pips · {priceDist.toFixed(meta.pip < 0.001 ? 1 : meta.pip < 0.01 ? 3 : 5)} price dist
          </div>
          <div style={{height:1,flex:1,background:"linear-gradient(90deg,#e4e9f0,transparent)"}}/>
        </div>
      )}

      {/* Results — 3 cards */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
        <div style={{background:"rgba(239,83,80,0.1)",borderRadius:4,padding:"12px 10px",border:"1px solid #fecdd3",textAlign:"center"}}>
          <div style={{fontSize:7.5,color:"#f43f5e",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.8,marginBottom:5,fontWeight:700}}>RISK $</div>
          <div style={{fontSize:20,fontWeight:800,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1}}>${riskAmt.toFixed(2)}</div>
          <div style={{fontSize:8,color:"#fda4af",fontFamily:"'IBM Plex Sans',sans-serif",marginTop:3}}>{riskPct}% of balance</div>
        </div>
        <div style={{background:"rgba(38,166,154,0.1)",borderRadius:4,padding:"12px 10px",border:"1px solid #86efac",textAlign:"center"}}>
          <div style={{fontSize:7.5,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.8,marginBottom:5,fontWeight:700}}>LOT SIZE</div>
          <div style={{fontSize:20,fontWeight:800,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1}}>{lots}</div>
          <div style={{fontSize:8,color:"#6ee7b7",fontFamily:"'IBM Plex Sans',sans-serif",marginTop:3}}>standard lots</div>
        </div>
        <div style={{background:"linear-gradient(135deg,#eff6ff,#dbeafe)",borderRadius:4,padding:"12px 10px",border:"1px solid #93c5fd",textAlign:"center"}}>
          <div style={{fontSize:7.5,color:"#3d8eff",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.8,marginBottom:5,fontWeight:700}}>PIP VALUE</div>
          <div style={{fontSize:20,fontWeight:800,color:"#3d8eff",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1}}>${pipValPerLot.toFixed(2)}</div>
          <div style={{fontSize:8,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",marginTop:3}}>per lot/pip</div>
        </div>
      </div>
    </div>
  );
}

export default function TradeLedger() {
  const [trades,  setTrades]   = useState([]);
  const [journals,setJournals] = useState({});
  const [_isDark, setIsDark] = useState(()=>{
    try { return localStorage.getItem("tl_theme") !== "light"; } catch { return true; }
  });
  const [tab,     setTab]      = useState("watchlist");
  // Sync module-level vars each render so sub-components see current theme
  isDark = _isDark;
  Object.assign(TH, _isDark ? DARK : LIGHT);
  // Persist theme choice
  useEffect(()=>{ try{localStorage.setItem("tl_theme", _isDark?"dark":"light");}catch{} }, [_isDark]);
  const [serverOk,setServerOk] = useState(false);
  const [wsOk,    setWsOk]     = useState(false);
  const [weeklyAI, setWeeklyAI] = useState(null);   // {text, generatedAt (ISO)}
  const [weeklyAILd, setWeeklyAILd] = useState(false);
  const [appToken,setAppToken] = useState("");
  const [lastSync,setLastSync] = useState(null);
  const [flash,   setFlash]    = useState(false);
  const [sideOpen,setSideOpen] = useState(false);
  const [tradeFilter,setFilter]= useState("all");
  const [selectedTrade,setSel] = useState(null);
  const [jForm,   setJForm]    = useState({notes:"",emotion:"😐 Neutral",rating:3,tags:"",setup:"",postReview:"",screenshot:null});
  const [chartSym,setChartSym] = useState("FX:EURUSD");
  const [pickerOpen,setPickerOpen] = useState(false);
  const [pickerCat, setPickerCat]  = useState("Forex");
  const [chartModal,setChartModal] = useState(null);

  /* watchlist */
  const [watchlist,setWatchlist]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_wl")||JSON.stringify(DEFAULT_WL));}catch{return DEFAULT_WL;}});
  const [prices,   setPrices]  = useState({});
  const [prev,     setPrev]    = useState({});
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const [addSym,   setAddSym]  = useState("");
  const [pFlash,   setPFlash]  = useState({});

  /* calendar */
  const [calMonth, setCalMonth]= useState(new Date());
  const [calSel,   setCalSel]  = useState(null);
  const [calDayEv, setCalDayEv]= useState([]);
  const [calDayLd, setCalDayLd]= useState(false);
  const [calCache, setCalCache] = useState(null); /* cached full week data */
  const [calCacheAt,setCalCacheAt]=useState(null);

  /* news */
  const [todayNews,setTodayNews]=useState([]);
  const [newsFeed, setNewsFeed] =useState([]);
  const [newsLd,   setNewsLd]  =useState(false);
  // Breaking ticker + news archive
  const [tickerIdx, setTickerIdx] = useState(0);
  const [tickerVisible, setTickerVisible] = useState(true);
  const [savedNews, setSavedNews] = useState(()=>{
    try {
      const raw = localStorage.getItem("tl_saved_news");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      const cutoff = Date.now() - 48*60*60*1000;
      return arr.filter(a => new Date(a.savedAt||a.pubDate||0).getTime() > cutoff);
    } catch { return []; }
  });
  // AI briefing
  const [briefing, setBriefing] = useState(()=>{try{return JSON.parse(localStorage.getItem("tl_briefing")||"null");}catch{return null;}});
  const [briefingLd, setBriefingLd] = useState(false);
  // Market Search
  const [searchQuery, setSearchQuery]     = useState("");
  const [searchResults, setSearchResults] = useState(null);  // {query,articles,aiSummary,generatedAt}
  const [searchLd, setSearchLd]           = useState(false);
  const [searchErr, setSearchErr]         = useState(null);
  const [predictions, setPredictions] = useState(null);   // {predictions:[], generatedAt}
  const [predLd, setPredLd] = useState(false);
  const [readModal, setReadModal] = useState(null); // {url, title, loading, blocks, image, source, error}
  const [newsImpactOpen, setNewsImpactOpen] = useState(false);
  const [screenshotZoom, setScreenshotZoom] = useState(null);
  const [sessionTick,setSessionTick]=useState(0);

  const wsRef=useRef(null), reconnRef=useRef(null), priceRef=useRef(null);

  /* ── NEW FEATURES STATE ── */
  // Session countdown
  const [sessionCountdown, setSessionCountdown] = useState({});
  // Daily risk lock
  const [riskLimit, setRiskLimit] = useState(()=>{try{return JSON.parse(localStorage.getItem("tl_risk_limit")||"null");}catch{return null;}});
  const [riskLockDismissed, setRiskLockDismissed] = useState(false);
  // Checklist
  const [checklist, setChecklist] = useState(()=>{try{return JSON.parse(localStorage.getItem("tl_checklist")||"null");}catch{return null;}});
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklistDone, setChecklistDone] = useState({});
  // Trade tags/mood (stored in journals already, just adding modal)
  const [tagModal, setTagModal] = useState(null); // trade ticket
  // Trade replay
  const [replayTrade, setReplayTrade] = useState(null);
  // Streak counter
  const [streakOpen, setStreakOpen] = useState(false);

  const stats = useMemo(()=>computeStats(trades),[trades]);
  const filteredTrades = useMemo(()=>{
    if(tradeFilter==="all")    return trades;
    if(tradeFilter==="wins")   return trades.filter(t=>t.profit>0);
    if(tradeFilter==="losses") return trades.filter(t=>t.profit<=0);
    return trades.filter(t=>t.symbol===tradeFilter);
  },[trades,tradeFilter]);

  /* load journals */
  useEffect(()=>{try{setJournals(JSON.parse(localStorage.getItem("tl_journals")||"{}"));}catch{};},[]);

  /* WebSocket */
  const connectWS=useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN) return;
    const ws=new WebSocket(WS_URL);
    wsRef.current=ws;
    ws.onopen=()=>setWsOk(true);
    ws.onclose=()=>{setWsOk(false);reconnRef.current=setTimeout(connectWS,5000);};
    ws.onerror=()=>ws.close();
    ws.onmessage=e=>{
      try{
        const msg=JSON.parse(e.data);
        const t=msg.type||"";
        if(t==="NEW_TRADE"||t==="new_trade"){
          setTrades(p=>{
            if(p.find(x=>x.ticket===msg.trade.ticket))return p;
            setFlash(true);setTimeout(()=>setFlash(false),2000);
            setLastSync(new Date().toLocaleTimeString());
            return [...p,msg.trade];
          });
        } else if(t==="BULK_TRADES"){
          if(Array.isArray(msg.trades)&&msg.trades.length){
            setTrades(msg.trades);
            setFlash(true);setTimeout(()=>setFlash(false),2000);
            setLastSync(new Date().toLocaleTimeString());
          }
        } else if(t==="CLEARED"){
          setTrades([]);
        }
      }catch{}
    };
  },[]);

  /* fetch trades */
  const fetchAll=useCallback(async()=>{
    try{
      const [tr,st]=await Promise.all([fetch(SERVER+"/api/trades"),fetch(SERVER+"/api/status")]);
      if(!tr.ok||!st.ok)throw new Error();
      const{trades:t}=await tr.json();
      const{token}=await st.json();
      setTrades(t||[]);setAppToken(token||"");setServerOk(true);
    }catch{setServerOk(false);}
  },[]);

  useEffect(()=>{fetchAll();},[fetchAll]);
  // Poll every 30s as safety net (Railway restarts wipe in-memory trades)
  useEffect(()=>{const t=setInterval(fetchAll,30000);return()=>clearInterval(t);},[fetchAll]);
  useEffect(()=>{if(serverOk)connectWS();return()=>{wsRef.current?.close();clearTimeout(reconnRef.current);};},[serverOk,connectWS]);

  /* ── Performance Coach — local rule engine, no API needed ── */
  const genWeeklyAI = (force=false) => {
    if (!stats || trades.length === 0) return;
    if (!force && weeklyAI?.generatedAt) {
      const genDate = new Date(weeklyAI.generatedAt);
      const now = new Date();
      const monday = new Date(now);
      monday.setUTCHours(0,0,0,0);
      monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay()+6)%7));
      if (genDate >= monday) return;
    }
    setWeeklyAI(null);
    const { total, wins, losses, winRate, totalProfit, grossProfit, grossLoss,
            pf, avgWin, avgLoss, rr, maxDD, maxCW, maxCL, expectancy,
            bySymbol, sessions } = stats;
    const symWR = bySymbol.map(s=>({...s, wr:s.trades>0?+(s.wins/s.trades*100).toFixed(1):0}));
    const bestSym  = symWR[0];
    const worstSym = [...symWR].sort((a,b)=>a.profit-b.profit)[0];
    const mostTradedSym = [...symWR].sort((a,b)=>b.trades-a.trades)[0];
    const sessSort = [...sessions].sort((a,b)=>b.profit-a.profit);
    const bestSess  = sessSort[0];
    const worstSess = sessSort[sessSort.length-1];
    const dowProfit={0:0,1:0,2:0,3:0,4:0,5:0,6:0};
    const dowCount={0:0,1:0,2:0,3:0,4:0,5:0,6:0};
    trades.forEach(t=>{
      const d=parseMT5Date(t.openTime); if(!d) return;
      const dow=d.getUTCDay();
      dowProfit[dow]=+(( dowProfit[dow]||0)+(t.profit||0)).toFixed(2);
      dowCount[dow]++;
    });
    const dowNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const dowArr=Object.entries(dowProfit).filter(([d])=>dowCount[d]>0)
      .map(([d,p])=>({day:dowNames[+d],profit:+p.toFixed(2),count:dowCount[d]}))
      .sort((a,b)=>b.profit-a.profit);
    const bestDay=dowArr[0];
    const worstDay=dowArr[dowArr.length-1];
    const durations=trades.filter(t=>t.openTime&&t.closeTime).map(t=>{
      const o=parseMT5Date(t.openTime),c=parseMT5Date(t.closeTime);
      return o&&c?(c-o)/60000:null;
    }).filter(Boolean);
    const avgDurMins=durations.length?Math.round(durations.reduce((s,v)=>s+v,0)/durations.length):0;
    const activeDays=new Set(trades.map(t=>mt5Day(t.openTime)).filter(Boolean)).size;
    const tradesPerDay=activeDays>0?+(total/activeDays).toFixed(1):0;
    let revengeTrades=0;
    for(let i=1;i<trades.length;i++) if(trades[i-1].profit<0&&trades[i].profit<0) revengeTrades++;
    const revengeRate=total>1?+(revengeTrades/(total-1)*100).toFixed(0):0;
    const cuttingWinners = avgWin < avgLoss * 0.8;
    const wideSL = avgLoss > avgWin * 1.5;
    const sections = [];
    // SECTION 1: Risk & Mistakes
    {
      const issues=[], whys=[], steps=[];
      if(maxDD>20){issues.push(`max drawdown of ${maxDD}% is at danger level`);whys.push(`a drawdown above 20% takes a 25% gain just to recover`);steps.push(`Reduce position size by 50% until drawdown falls below 10%`);steps.push(`Set a daily loss limit of ${(maxDD/4).toFixed(1)}% — stop trading for the day if hit`);}
      if(maxCL>=4){issues.push(`${maxCL} consecutive losses recorded`);whys.push(`streaks of ${maxCL}+ losses signal either a strategy flaw or emotional trading`);steps.push(`After 3 losses in a row, stop trading for the day — journal each loss first`);steps.push(`Review the ${maxCL} losing trades — find the common setup pattern and remove it`);}
      if(revengeRate>25){issues.push(`${revengeRate}% back-to-back losses indicate revenge trading`);whys.push(`revenge trades are driven by emotion — they compound losses`);steps.push(`Install a 10-minute mandatory break rule after any losing trade`);steps.push(`Keep a tally — mark each trade before placing it to stay conscious`);}
      if(tradesPerDay>8){issues.push(`averaging ${tradesPerDay} trades/day is overtrading`);whys.push(`more trades = more fees + emotional decisions + diluted focus`);steps.push(`Cap yourself at ${Math.ceil(tradesPerDay/2)} trades per day`);steps.push(`Pre-mark your levels before the session — only trade pre-planned setups`);}
      if(pf<1.2){issues.push(`profit factor of ${pf} — gross loss $${grossLoss} nearly matches profit $${grossProfit}`);whys.push(`a PF below 1.2 is unsustainable — fees will tip you negative`);steps.push(`Target minimum PF of 1.5 — skip setups with less than 1:1.5 R:R`);steps.push(`Review your 5 largest losing trades — were they A+ setups or FOMO entries?`);}
      if(issues.length===0){issues.push(`risk management is solid with PF ${pf} and drawdown at ${maxDD}%`);whys.push(`your discipline shows — protect these numbers as volume scales`);steps.push(`Document your current rules in a written trading plan`);steps.push(`Increase size by max 10% — test the same discipline with higher stakes`);}
      sections.push({id:"risk",icon:"⚠️",label:"WHAT WENT WRONG",color:"#ef5350",bg:"rgba(239,83,80,0.07)",border:"rgba(239,83,80,0.2)",what:issues.slice(0,2).join(" and "),why:whys[0]||"",steps:steps.slice(0,3)});
    }
    // SECTION 2: Session & Timing
    {
      const sessHours={Asian:"00:00–08:00 UTC",London:"08:00–13:00 UTC",Overlap:"13:00–17:00 UTC",NewYork:"17:00–22:00 UTC"};
      const sessProfit=sessions.map(s=>`${s.name}: $${s.profit}`).join(" · ");
      const bestDayStr=bestDay?`${bestDay.day} ($${bestDay.profit} across ${bestDay.count} trades)`:"";
      const worstDayStr=worstDay&&worstDay.profit<0?`${worstDay.day} ($${worstDay.profit})`:"";
      sections.push({id:"session",icon:"🎯",label:"WHEN TO TRADE",color:"#26a69a",bg:"rgba(38,166,154,0.07)",border:"rgba(38,166,154,0.2)",what:bestSess?`${bestSess.name} session is your strongest at $${bestSess.profit}`:"Track session data to find your edge",why:`Session breakdown: ${sessProfit}${bestDayStr?`. Best day: ${bestDayStr}`:""}${worstDayStr?`. Worst day: ${worstDayStr}`:""}`,steps:[bestSess?`Focus 80% of trades on ${bestSess.name} hours (${sessHours[bestSess.name]||""})`:"",(worstSess&&worstSess.profit<0)?`Avoid ${worstSess.name} session — costing $${Math.abs(worstSess.profit)}`:`Log session-specific setups to find your best window`,bestDay?`Prioritise ${bestDay.day}s — your best day by P&L${worstDayStr?`. Rest on ${worstDay.day}s`:""}`:"Track day-of-week results for 20+ more trades"].filter(Boolean).slice(0,3)});
    }
    // SECTION 3: Symbol Focus
    {
      const topSyms=symWR.slice(0,3).map(s=>`${s.symbol} ($${s.profit}, ${s.wr}% WR)`).join(", ");
      const symNote=mostTradedSym&&mostTradedSym.symbol!==bestSym?.symbol?`You trade ${mostTradedSym.symbol} most (${mostTradedSym.trades}x) but ${bestSym?.symbol} earns more`:`${bestSym?.symbol} is both most traded and most profitable`;
      sections.push({id:"symbol",icon:"📊",label:"WHAT TO TRADE",color:"#2962ff",bg:"rgba(41,98,255,0.07)",border:"rgba(41,98,255,0.2)",what:bestSym?`${bestSym.symbol} is your top performer at $${bestSym.profit} (${bestSym.wr}% WR)`:"No profitable symbol yet",why:`Top 3: ${topSyms||"no data"}. ${symNote}. ${worstSym&&worstSym.profit<0?`${worstSym.symbol} is worst at $${worstSym.profit}`:""}`,steps:[bestSym?`Make ${bestSym.symbol} your primary — allocate 60% of daily trades here`:"Pick 2 instruments max and stick to them for a month",worstSym&&worstSym.profit<0?`Drop ${worstSym.symbol} or go demo — bleeding $${Math.abs(worstSym.profit)}`:"Keep symbol list to 3 max",`Study ${bestSym?.symbol||"your best symbol"}: know its S/R levels, news events, and session behaviour`]});
    }
    // SECTION 4: Execution & R:R
    {
      const rrNum=parseFloat(rr)||0;
      const durStr=avgDurMins>0?(avgDurMins<60?`${avgDurMins} mins`:`${Math.round(avgDurMins/60)}h ${avgDurMins%60}m`):"unknown";
      sections.push({id:"execution",icon:"💡",label:"HOW TO IMPROVE",color:"#2962ff",bg:"rgba(41,98,255,0.07)",border:"rgba(41,98,255,0.2)",what:rrNum>=1.5?`R:R of 1:${rr} is healthy — expectancy of $${expectancy}/trade compounds well`:`R:R of 1:${rr} needs work — avg win ($${avgWin}) vs avg loss ($${avgLoss}) is the issue`,why:`${winRate}% WR and 1:${rr} R:R gives $${expectancy}/trade expectancy over ${total} trades. Avg hold: ${durStr}. ${cuttingWinners?"Cutting winners short — avg win is below 80% of avg loss.":wideSL?"Stop losses too wide — tighten them.":"Execution balance looks reasonable."}`,steps:[cuttingWinners?`Move TP further: target 1.5x your SL distance — don't tighten TP once in profit`:rrNum>=1.5?`Protect your R:R — never move SL to BE before price moves 50% toward TP`:`Set minimum R:R rule of 1:1.5 — if TP is not 1.5x the SL, skip the trade`,avgDurMins>0&&avgDurMins<10?`Your ${durStr} avg hold is very short — set a 30-min minimum hold rule`:avgDurMins>480?`${durStr} avg hold has overnight risk — close 50% at 1R and trail the rest`:`Hold time of ${durStr} is reasonable — focus on not exiting early when in profit`,expectancy>0?`Expectancy is positive at $${expectancy}/trade — scale up 1 lot every time account grows 10%`:`Fix negative expectancy before increasing size — trade minimum size until it turns positive for 20+ trades`]});
    }
    const result = { sections, generatedAt: new Date().toISOString(), tradeCount: total };
    setWeeklyAI(result);
    try { localStorage.setItem("tl_weekly_ai", JSON.stringify(result)); } catch {}
  };

  // Load cached weekly AI from localStorage on mount, then check if refresh needed
  useEffect(()=>{
    try {
      const cached = JSON.parse(localStorage.getItem("tl_weekly_ai")||"null");
      if (cached?.text) setWeeklyAI(cached);
    } catch {}
  }, []);
  // Auto-generate when analytics tab opens and stats are ready
  useEffect(()=>{
    if(tab==="dashboard" && stats) genWeeklyAI(false);
  },[tab, stats]);

  /* ── news feed + archive + AI briefing ── */
  const saveToArchive = (articles) => {
    setSavedNews(prev => {
      const cutoff = Date.now() - 48*60*60*1000;
      const existing = prev.filter(a => new Date(a.savedAt||a.pubDate||0).getTime() > cutoff);
      const existingTitles = new Set(existing.map(a=>a.title));
      const newOnes = articles.filter(a=>!existingTitles.has(a.title)).map(a=>({...a,savedAt:new Date().toISOString()}));
      const merged = [...newOnes,...existing].slice(0,200);
      try { localStorage.setItem("tl_saved_news", JSON.stringify(merged)); } catch{}
      return merged;
    });
  };

  const fetchMarketSearch = (q) => {
    const query = (q||searchQuery).trim();
    if (!query) return;
    setSearchLd(true); setSearchErr(null); setSearchResults(null);
    const terms = query.toLowerCase().split(/\s+/);
    const allArticles = [...savedNews, ...newsFeed];
    const seen = new Set();
    const matched = allArticles.filter(a=>{
      const text=((a.title||"")+" "+(a.description||"")).toLowerCase();
      const hit=terms.some(t=>text.includes(t));
      if(hit&&!seen.has(a.title)){seen.add(a.title);return true;}
      return false;
    }).slice(0,10);
    const qLow=query.toLowerCase();
    const symMap={gold:["XAUUSD"],silver:["XAGUSD"],bitcoin:["BTCUSD"],btc:["BTCUSD"],eth:["ETHUSD"],ethereum:["ETHUSD"],oil:["USOIL"],crude:["USOIL"],eurusd:["EURUSD"],eur:["EURUSD"],gbpusd:["GBPUSD"],gbp:["GBPUSD"],usdjpy:["USDJPY"],jpy:["USDJPY"],nasdaq:["NAS100"],nas100:["NAS100"],sp500:["SP500"],dow:["US30"],us30:["US30"]};
    const relSyms=Object.entries(symMap).filter(([k])=>qLow.includes(k)).flatMap(([,v])=>v).filter(Boolean);
    const priceCtx=relSyms.filter(s=>prices[s]?.price).map(s=>{const p=prices[s],chg=parseFloat(p.changePct)||0;return `${s} at ${p.price} (${chg>=0?"+":""}${chg.toFixed(2)}% today)`;}).join("; ");
    const bullWords=["rises","rally","surge","gains","bullish","higher","up","strong","beats","record","growth","boost"];
    const bearWords=["falls","drop","decline","bearish","lower","down","weak","misses","cut","recession","risk","fear","concern","crash"];
    let bull=0,bear=0;
    matched.forEach(a=>{const t=(a.title||"").toLowerCase();bull+=bullWords.filter(w=>t.includes(w)).length;bear+=bearWords.filter(w=>t.includes(w)).length;});
    const sentiment=bull>bear?"bullish":bear>bull?"bearish":"mixed";
    const sentScore=matched.length>0?Math.round(Math.abs(bull-bear)/(bull+bear+1)*100):50;
    const summaryParts=[];
    if(priceCtx) summaryParts.push(`Live prices: ${priceCtx}.`);
    if(matched.length>0){summaryParts.push(`Found ${matched.length} related articles in your 48h archive.`);summaryParts.push(`Headline sentiment for "${query}" is ${sentiment} — ${bull} bullish signals vs ${bear} bearish signals.`);}
    else summaryParts.push(`No articles found for "${query}" in your archive. Try refreshing news or a broader term.`);
    setSearchResults({query,aiSummary:summaryParts.join(" "),sentiment,sentScore,generatedAt:new Date().toISOString(),articles:matched});
    setSearchLd(false);
  };

  const genLocalBriefing = (src) => {
    if (!src.length) return;
    const cats={"Central Banks & Rates":["fed","fomc","rate","boe","ecb","rba","interest","inflation","hike","cut","powell","lagarde"],"Geopolitics & Risk":["war","conflict","sanction","tension","geopolitical","risk","threat","attack","crisis"],"Commodities":["gold","oil","crude","silver","commodity","copper","energy","xauusd","opec"],"Crypto":["bitcoin","btc","ethereum","eth","crypto","blockchain","defi","nft"],"Equities & Indices":["stock","equity","nasdaq","s&p","dow","index","earnings","ipo","shares"],"Forex":["dollar","euro","pound","yen","usd","eur","gbp","jpy","forex","fx","currency"]};
    const catCounts={},catHeadlines={};
    src.forEach(a=>{const t=(a.title||"").toLowerCase();Object.entries(cats).forEach(([cat,kws])=>{if(kws.some(k=>t.includes(k))){catCounts[cat]=(catCounts[cat]||0)+1;if(!catHeadlines[cat])catHeadlines[cat]=[];if(catHeadlines[cat].length<2)catHeadlines[cat].push(a.title);}});});
    const topCats=Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
    const bullWords=["rises","rally","surge","gains","bullish","higher","up","strong","beats","record","growth","boost","optimism"];
    const bearWords=["falls","drop","decline","bearish","lower","down","weak","misses","cut","recession","risk","fear","concern","crash","warning"];
    let bull=0,bear=0;
    src.forEach(a=>{const t=(a.title||"").toLowerCase();bull+=bullWords.filter(w=>t.includes(w)).length;bear+=bearWords.filter(w=>t.includes(w)).length;});
    const sentiment=bull>bear?"bullish":bear>bull?"bearish":"neutral";
    const b={briefing:`Market tone: ${bull>bear?"Risk-On 📈":bear>bull?"Risk-Off 📉":"Neutral ➡️"}. Analysed ${src.length} headlines.`,sections:topCats.map(([cat,count])=>({cat,count,headlines:catHeadlines[cat]||[]})),sentiment,bull,bear,generatedAt:new Date().toISOString()};
    setBriefing(b);try{localStorage.setItem("tl_briefing",JSON.stringify(b));}catch{}
  };
  const fetchBriefing = (articles) => {
    const src=articles||newsFeed;
    if(!src.length) return;
    if(briefing?.generatedAt&&Date.now()-new Date(briefing.generatedAt).getTime()<15*60*1000) return;
    genLocalBriefing(src);
  };

  const fetchNews=async()=>{
    setNewsLd(true);
    try{
      const r=await fetch(SERVER+"/api/news",{signal:AbortSignal.timeout(12000)});
      if(!r.ok) throw new Error("server "+r.status);
      const data=await r.json();
      if(data.articles&&data.articles.length>0){
        setNewsFeed(data.articles);
        saveToArchive(data.articles);
        setTickerIdx(0); setTickerVisible(true);
        setTimeout(()=>genLocalBriefing(data.articles),100);
      }
    }catch(e){ console.warn("News fetch failed:",e.message); }
    setNewsLd(false);
  };

  /* ── analyst predictions for watchlist symbols (max 4) ── */
  const fetchPredictions = async (syms) => {
    const symbols = (syms || watchlist).slice(0,4);
    if (!symbols.length) return;
    setPredLd(true);
    try {
      const resp = await fetch(SERVER+"/api/predictions?symbols="+symbols.join(","), {
        signal: AbortSignal.timeout(30000)
      });
      const data = await resp.json();
      if (data.predictions?.length) {
        setPredictions(data);
        try { localStorage.setItem("tl_predictions", JSON.stringify({...data, version:"v3"})); } catch {}
      }
    } catch(e) { console.warn("Predictions failed:", e.message); }
    setPredLd(false);
  };

  // Load cached predictions + auto-refresh if stale (>1h) or symbols changed
  useEffect(()=>{
    const PRED_VERSION = "v3"; // bump this to force cache clear
    try {
      const cached = JSON.parse(localStorage.getItem("tl_predictions")||"null");
      const age = cached?.generatedAt ? Date.now()-new Date(cached.generatedAt).getTime() : Infinity;
      const cachedSyms = (cached?.symbols||[]).slice().sort().join(",");
      const currentSyms = watchlist.slice(0,4).slice().sort().join(",");
      const versionOk = cached?.version === PRED_VERSION;
      // Only use cache if: correct version, fresh (<1h), same symbols, has live prices
      const haslive = cached?.predictions?.some(p => p.currentPrice);
      if (cached?.predictions?.length && versionOk && haslive && age < 60*60*1000 && cachedSyms===currentSyms) {
        setPredictions(cached);
      } else {
        // Stale, wrong version, no live prices, or different symbols — clear and regenerate
        localStorage.removeItem("tl_predictions");
        fetchPredictions();
      }
    } catch { fetchPredictions(); }
  }, []);

  /* open article in reading view */
  const openArticle = async (article) => {
    setReadModal({url: article.link, title: article.title, loading: true, blocks: [], image: null, source: null, error: null});
    try {
      const r = await fetch(SERVER + "/api/readarticle?url=" + encodeURIComponent(article.link), {signal: AbortSignal.timeout(15000)});
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      if (data.paywalled) {
        setReadModal(m=>({...m, loading: false, paywalled: true, title: article.title, description: article.description||"", source: data.source, blocks: [], error: null}));
        return;
      }
      setReadModal({url: article.link, title: data.title || article.title, loading: false, blocks: data.blocks || [], image: data.image, source: data.source, description: data.description, paywalled: false, error: null});
    } catch(e) {
      setReadModal(m => ({...m, loading: false, error: e.message, blocks: []}));
    }
  };

  /* pre-load FF calendar when calendar tab opens */
  useEffect(()=>{
    if(tab!=="calendar") return;
    const now=Date.now();
    if(calCache&&calCacheAt&&(now-calCacheAt<30*60*1000)) return; /* still fresh */
    const preload=async()=>{
      const urls=["https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json","https://nfs.faireconomy.media/ff_calendar_thisweek.json"];
      for(const url of urls){
        try{
          const r=await fetch(url,{signal:AbortSignal.timeout(8000)});
          const text=await r.text();
          if(text.includes("DOCTYPE")||text.includes("Request Denied")) continue;
          const arr=JSON.parse(text);
          if(Array.isArray(arr)&&arr.length>0){
            const norm=arr.map(e=>({date:e.date||"",currency:e.country||e.currency||"",name:e.title||e.name||"",impact:(e.impact||"").toLowerCase(),actual:(e.actual!=null&&e.actual!=="")?e.actual:null,forecast:(e.forecast!=null&&e.forecast!=="")?e.forecast:null,previous:(e.previous!=null&&e.previous!=="")?e.previous:null}));
            setCalCache(norm);setCalCacheAt(Date.now());
            return;
          }
        }catch{}
      }
    };
    preload();
  },[tab]);

  /* this week's economic events — single call to /api/week-events */
  useEffect(()=>{
    const go=async()=>{
      try{
        const r=await fetch(SERVER+"/api/week-events",{signal:AbortSignal.timeout(20000)});
        if(!r.ok) return;
        const d=await r.json();
        const evs=Array.isArray(d.events)?d.events:[];
        if(evs.length>0){
          setTodayNews(evs.map(e=>({
            time:e.date||"",
            currency:e.currency||"",
            name:e.name||"",
            impact:e.impact||"low",
            forecast:e.forecast,
            actual:e.actual,
          })));
        }
      }catch(e){console.warn("Week events failed:",e.message);}
    };
    go();
    const t=setInterval(go,4*60*60*1000); // refresh every 4h
    return()=>clearInterval(t);
  },[]);

  /* session clock tick every 30s */
  useEffect(()=>{
    const t=setInterval(()=>setSessionTick(n=>n+1),30000);
    return()=>clearInterval(t);
  },[]);

  /* session countdown — recalculate every minute */
  useEffect(()=>{
    const calc = () => {
      const now = new Date();
      const utcMins = now.getUTCHours()*60 + now.getUTCMinutes();
      const sessions = [
        {name:"London",  open:8*60,  close:17*60},
        {name:"New York",open:13*60, close:22*60},
        {name:"Tokyo",   open:0,     close:9*60},
        {name:"Sydney",  open:21*60, close:30*60}, // wraps midnight
      ];
      const result = {};
      sessions.forEach(s => {
        const isActive = s.open <= s.close
          ? utcMins >= s.open && utcMins < s.close
          : utcMins >= s.open || utcMins < s.close;
        if (isActive) {
          // time until close
          let closeAt = s.close > 24*60 ? s.close - 24*60 : s.close;
          let minsLeft = closeAt > utcMins ? closeAt - utcMins : (24*60 - utcMins + closeAt);
          result[s.name] = {active:true, minsLeft, label: minsLeft+"m left"};
        } else {
          // time until open
          let minsUntil = s.open > utcMins ? s.open - utcMins : (24*60 - utcMins + s.open);
          result[s.name] = {active:false, minsLeft: minsUntil, label: "opens in "+minsUntil+"m"};
        }
      });
      setSessionCountdown(result);
    };
    calc();
    const t = setInterval(calc, 60000);
    return () => clearInterval(t);
  }, []);

  const fetchNewsRef = useRef(fetchNews);
  useEffect(()=>{ fetchNewsRef.current=fetchNews; });
  useEffect(()=>{
    fetchNewsRef.current(); /* fire immediately on mount */
    const t=setInterval(()=>fetchNewsRef.current(), 5*60*1000); /* every 5 min */
    // Breaking ticker — advance headline every 5 min
    const ticker = setInterval(()=>{
      setTickerVisible(false);
      setTimeout(()=>{
        setTickerIdx(i => i+1);
        setTickerVisible(true);
      }, 500);
    }, 5*60*1000);
    const ai=setInterval(()=>{ /* AI re-run every 60 min using latest feed */

    }, 60*60*1000);
    return()=>{clearInterval(t);clearInterval(ai);clearInterval(ticker);};
  },[]);

  /* live prices — stale-while-revalidate */
  const refreshPrices = useCallback(async()=>{
    setPriceRefreshing(true);
    const quotes = await fetchPriceBatch(watchlist, {
      onCachedHit: (cached) => {
        // Instantly paint cached prices while fresh fetch is in-flight
        setPrices(p => Object.keys(p).length ? p : cached);
      }
    });
    setPriceRefreshing(false);
    if(!quotes||!Object.keys(quotes).length) return;
    const fl={};
    Object.keys(quotes).forEach(sym=>{
      const q=quotes[sym];
      if(q&&prices[sym]&&prices[sym].price!=null&&q.price!=null)
        fl[sym]=q.price>prices[sym].price?"up":"down";
    });
    setPrev(prices);setPrices(quotes);setPFlash(fl);setTimeout(()=>setPFlash({}),1000);
  },[watchlist,prices]);

  useEffect(()=>{refreshPrices();priceRef.current=setInterval(refreshPrices,15000);return()=>clearInterval(priceRef.current);},[watchlist]);

  const addToWL=()=>{const s=addSym.toUpperCase().trim();if(!s||watchlist.includes(s))return;const u=[...watchlist,s];setWatchlist(u);try{localStorage.setItem("tl_wl",JSON.stringify(u));}catch{};setAddSym("");};
  const rmFromWL=s=>{const u=watchlist.filter(x=>x!==s);setWatchlist(u);try{localStorage.setItem("tl_wl",JSON.stringify(u));}catch{};};
  const saveJournal=()=>{if(!selectedTrade)return;const u={...journals,[selectedTrade.ticket]:{...jForm,savedAt:new Date().toISOString()}};setJournals(u);try{localStorage.setItem("tl_journals",JSON.stringify(u));}catch{};};

  /* ════════════════════════════════════════════════════════ RENDER ═══════ */
  return (
    <div style={{minHeight:"100vh",background:TH.bg,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",transition:"background 0.3s ease,color 0.3s ease"}}>

      {/* ── Breaking News Ticker ── */}
      {newsFeed.length>0&&(()=>{
        const item = newsFeed[tickerIdx % newsFeed.length];
        const d = item.pubDate ? new Date(item.pubDate) : null;
        const minsAgo = d ? Math.floor((Date.now()-d)/60000) : null;
        const age = minsAgo===null?"":minsAgo<2?"LIVE":minsAgo<60?minsAgo+"m ago":Math.floor(minsAgo/60)+"h ago";
        return (
          <div style={{background:isDark?"rgba(21,31,51,0.97)":"rgba(238,242,255,0.98)",backdropFilter:"blur(10px)",color:TH.text,height:36,borderBottom:"1px solid "+TH.border,display:"flex",alignItems:"center",overflow:"hidden",flexShrink:0,zIndex:100,position:"sticky",top:0}}>
            {/* Label */}
            <div style={{background:"linear-gradient(90deg,#ff4060,#ff2040)",padding:"0 14px",height:"100%",display:"flex",alignItems:"center",gap:6,flexShrink:0,boxShadow:"4px 0 20px rgba(248,113,113,0.3)"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:TH.card,animation:"pulse 1s infinite"}}/>
              <span style={{fontSize:8,fontWeight:800,letterSpacing:2,fontFamily:"'IBM Plex Sans',sans-serif"}}>BREAKING</span>
            </div>
            {/* Source badge */}
            <div style={{background:TH.inputBg,padding:"0 12px",height:"100%",display:"flex",alignItems:"center",flexShrink:0,borderRight:"1px solid rgba(255,255,255,0.05)"}}>
              <span style={{fontSize:8,color:"rgba(0,212,255,0.7)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,fontWeight:700}}>{item.source||"NEWS"}</span>
            </div>
            {/* Headline — fade transition */}
            <div style={{flex:1,overflow:"hidden",padding:"0 16px",transition:"opacity 0.4s ease",opacity:tickerVisible?1:0}}>
              <span style={{fontSize:11,fontWeight:500,whiteSpace:"nowrap",cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}
                onClick={()=>openArticle(item)}>{item.title}</span>
            </div>
            {/* Age + nav */}
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"0 12px",flexShrink:0}}>
              {minsAgo!==null&&minsAgo<10&&<span style={{fontSize:8,color:"#26a69a",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>●LIVE</span>}
              <span style={{fontSize:8,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif"}}>{age}</span>
              <span style={{fontSize:8,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif"}}>{(tickerIdx%newsFeed.length)+1}/{newsFeed.length}</span>
              <button onClick={()=>{setTickerVisible(false);setTimeout(()=>{setTickerIdx(i=>(i-1+newsFeed.length)%newsFeed.length);setTickerVisible(true);},300);}}
                style={{background:"none",border:"none",color:TH.textSub,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>‹</button>
              <button onClick={()=>{setTickerVisible(false);setTimeout(()=>{setTickerIdx(i=>(i+1)%newsFeed.length);setTickerVisible(true);},300);}}
                style={{background:"none",border:"none",color:TH.textSub,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>›</button>
              <button onClick={()=>setTab("news")}
                style={{background:TH.inputBg,border:"1px solid #334155",borderRadius:4,color:TH.textDim,cursor:"pointer",fontSize:8,padding:"2px 8px",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>ALL NEWS</button>
            </div>
          </div>
        );
      })()}
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
      {/* Dynamic theme CSS */}
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        html,body,#root{width:100%;min-height:100vh}
        body{
          background:${isDark?"#131722":"#f0f3fa"};
          color:${isDark?"#d1d4dc":"#131722"};
          font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          font-size:13px;line-height:1.5;
        }
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:${isDark?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.12)"};border-radius:2px}
        ::-webkit-scrollbar-track{background:transparent}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes spinIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        /* ── TV nav rail ── */
        .tv-nav-btn{
          width:48px;height:44px;display:flex;flex-direction:column;align-items:center;
          justify-content:center;gap:3px;border:none;background:transparent;
          cursor:pointer;transition:background 0.1s;
          color:${isDark?"#787b86":"#9598a1"};position:relative;
        }
        .tv-nav-btn:hover{background:${isDark?"rgba(255,255,255,0.05)":"rgba(0,0,0,0.04)"};color:${isDark?"#d1d4dc":"#434651"}}
        .tv-nav-btn.active{color:${isDark?"#d1d4dc":"#131722"}}
        .tv-nav-btn.active::after{
          content:'';position:absolute;right:0;top:50%;transform:translateY(-50%);
          width:2px;height:20px;background:#2962ff;
        }
        /* ── KPI cards ── */
        .kpi-card{transition:background 0.1s!important}
        .kpi-card:hover{background:${isDark?"#252930":"#f2f4f7"}!important}
        /* ── Watchlist rows ── */
        .wlr{transition:background 0.1s!important;cursor:pointer}
        .wlr:hover{background:${isDark?"rgba(255,255,255,0.028)":"rgba(0,0,0,0.02)"}!important;border-color:${isDark?"#434651":"#c9ccd2"}!important}
        .rh:hover{background:${isDark?"rgba(255,255,255,0.025)":"rgba(0,0,0,0.018)"}!important}
        /* ── Buttons ── */
        .tl-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border:none;
          border-radius:3px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.1s;
          font-family:'IBM Plex Sans',sans-serif!important}
        .tl-btn-primary{background:#2962ff;color:#fff}
        .tl-btn-primary:hover{background:#1e53e5}
        .tl-btn-ghost{background:transparent;color:${isDark?"#787b86":"#9598a1"};
          border:1px solid ${isDark?"#2a2e39":"#e0e3eb"}}
        .tl-btn-ghost:hover{background:${isDark?"#2a2e39":"#eaecf0"};color:${isDark?"#d1d4dc":"#434651"}}
        /* ── Tags ── */
        .tag{display:inline-flex;align-items:center;padding:1px 5px;border-radius:2px;
          font-size:10px;font-weight:600;letter-spacing:0.2px}
        .tag-green{background:rgba(38,166,154,0.12);color:#26a69a}
        .tag-red{background:rgba(239,83,80,0.12);color:#ef5350}
        .tag-blue{background:rgba(41,98,255,0.12);color:#2962ff}
        .tag-amber{background:rgba(249,168,37,0.12);color:#f9a825}
        .tag-gray{background:${isDark?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.05)"};color:${isDark?"#787b86":"#9598a1"}}
        /* ── Inputs ── */
        a{color:inherit;text-decoration:none}
        input,select,textarea,button{font-family:'IBM Plex Sans',sans-serif!important}
        input,select,textarea{
          background:${isDark?"#2a2e39":"#f0f3fa"}!important;
          border:1px solid ${isDark?"#2a2e39":"#e0e3eb"}!important;
          color:${isDark?"#d1d4dc":"#131722"}!important;
          border-radius:3px!important;padding:6px 10px!important;
          transition:border 0.1s!important;font-size:12px!important;
        }
        input::placeholder,textarea::placeholder{color:${isDark?"#434651":"#b2b5be"}!important}
        input:focus,select:focus,textarea:focus{
          outline:none!important;border-color:#2962ff!important;
          box-shadow:0 0 0 2px rgba(41,98,255,0.15)!important;
        }
        select option{background:${isDark?"#1e222d":"#ffffff"};color:${isDark?"#d1d4dc":"#131722"}}
        .section-head{font-size:14px;font-weight:600;color:${isDark?"#d1d4dc":"#131722"};margin-bottom:14px}
        .chip{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:2px;
          font-size:10px;font-weight:600;border:1px solid currentColor}
        /* ── Responsive ── */
        @media(max-width:768px){
          .desktop-sidebar{display:none!important}
          .mobile-nav{display:flex!important}
          .main-content{padding:10px 12px 72px!important}
        }
        @media(min-width:769px){
          .mobile-nav{display:none!important}
          .desktop-sidebar{display:flex!important}
        }
      `}</style>

      {/* ── Reading View Modal ── */}
      {readModal&&(
        <div onClick={()=>setReadModal(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.85)",backdropFilter:"blur(6px)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"min(720px,96vw)",maxHeight:"90vh",background:TH.card,borderRadius:4,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 32px 80px rgba(0,0,0,0.3)"}}>
            {/* modal header */}
            <div style={{padding:"14px 20px",borderBottom:"1px solid rgba(255,255,255,0.05)",background:TH.inputBg,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexShrink:0}}>
              <div style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1}}>{readModal.source?.replace("www.","").toUpperCase()||"READING VIEW"}</div>
              <div style={{display:"flex",gap:8}}>
                <a href={readModal.url} target="_blank" rel="noopener noreferrer"
                  style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:6,padding:"5px 12px",color:TH.textSub,fontSize:9,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,textDecoration:"none"}}>
                  ↗ OPEN ORIGINAL
                </a>
                <button onClick={()=>setReadModal(null)} style={{background:"rgba(248,113,113,0.1)",border:"1px solid #ef9a9a",borderRadius:6,padding:"5px 11px",color:"#ef5350",fontSize:13,cursor:"pointer",lineHeight:1}}>✕</button>
              </div>
            </div>
            {/* article content */}
            <div style={{overflowY:"auto",padding:"28px 36px 40px",flex:1}}>
              {readModal.loading&&(
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 0",gap:14}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:"#26a69a",animation:"pulse 1s infinite"}}/>
                  <div style={{fontSize:12,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>Loading article...</div>
                </div>
              )}
              {!readModal.loading&&readModal.paywalled&&(
                <div style={{padding:"0 4px"}}>
                  {/* Title */}
                  <h1 style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:22,fontWeight:800,color:TH.text,lineHeight:1.3,marginBottom:14,letterSpacing:-0.3}}>{readModal.title}</h1>
                  {/* Description from RSS — often a good summary */}
                  {readModal.description&&(
                    <p style={{fontSize:15,color:"rgba(241,245,249,0.92)",lineHeight:1.8,marginBottom:20,fontFamily:"'IBM Plex Sans',sans-serif",borderLeft:"3px solid #e2e8f0",paddingLeft:14}}>
                      {readModal.description}
                    </p>
                  )}
                  {/* Notice */}
                  <div style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:4,padding:"14px 16px",display:"flex",gap:12,alignItems:"flex-start",marginBottom:20}}>
                    <div style={{fontSize:18,flexShrink:0}}>🔒</div>
                    <div>
                      <div style={{fontSize:12,fontWeight:600,color:"rgba(241,245,249,0.92)",marginBottom:3,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                        Full article on {readModal.source}
                      </div>
                      <div style={{fontSize:11,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.5}}>
                        This site requires login or blocks server access. The summary above is from the news feed.
                      </div>
                    </div>
                  </div>
                  <a href={readModal.url} target="_blank" rel="noopener noreferrer"
                    style={{display:"block",textAlign:"center",background:isDark?"#131722":"#1e222d",borderRadius:4,padding:"12px 24px",color:"#fff",fontSize:11,textDecoration:"none",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,fontWeight:700}}>
                    READ FULL ARTICLE ↗
                  </a>
                </div>
              )}
              {!readModal.loading&&!readModal.paywalled&&readModal.error&&(
                <div style={{textAlign:"center",padding:"40px 0"}}>
                  <div style={{fontSize:13,color:"#ef5350",marginBottom:8}}>Could not load article</div>
                  <div style={{fontSize:11,color:TH.textDim,marginBottom:20,fontFamily:"'IBM Plex Sans',sans-serif"}}>{readModal.error}</div>
                  <a href={readModal.url} target="_blank" rel="noopener noreferrer"
                    style={{background:"rgba(41,98,255,0.18)",border:"1px solid #dcfce7",borderRadius:4,padding:"10px 20px",color:"#2962ff",fontSize:12,textDecoration:"none",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                    Open in Browser ↗
                  </a>
                </div>
              )}
              {!readModal.loading&&!readModal.paywalled&&!readModal.error&&(
                <div>
                  {readModal.image&&(
                    <img src={readModal.image} alt="" style={{width:"100%",maxHeight:260,objectFit:"cover",borderRadius:4,marginBottom:24}} onError={e=>e.target.style.display="none"}/>
                  )}
                  <h1 style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:24,fontWeight:800,color:TH.text,lineHeight:1.3,marginBottom:16,letterSpacing:-0.5}}>{readModal.title}</h1>
                  {readModal.description&&(
                    <p style={{fontSize:15,color:TH.textDim,lineHeight:1.7,marginBottom:20,fontStyle:"italic",borderLeft:"3px solid #e2e8f0",paddingLeft:14}}>{readModal.description}</p>
                  )}
                  <div style={{borderTop:"1px solid #d1d4dc",paddingTop:20}}>
                    {(readModal.blocks||[]).map((b,i)=>
                      b.type==="heading"
                        ? <h2 key={i} style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:17,fontWeight:700,color:TH.text,margin:"24px 0 10px",lineHeight:1.4}}>{b.text}</h2>
                        : <p key={i} style={{fontSize:15,color:"rgba(241,245,249,0.92)",lineHeight:1.85,marginBottom:16,fontFamily:"'IBM Plex Sans',sans-serif"}}>{b.text}</p>
                    )}
                    {(!readModal.blocks||readModal.blocks.length===0)&&(
                      <div style={{textAlign:"center",padding:"20px 0",color:TH.textDim,fontSize:12}}>
                        Article content unavailable — <a href={readModal.url} target="_blank" rel="noopener noreferrer" style={{color:"#2962ff"}}>open in browser ↗</a>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Screenshot zoom modal ── */}
      {screenshotZoom&&(
        <div onClick={()=>setScreenshotZoom(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20,cursor:"zoom-out"}}>
          <img src={screenshotZoom} alt="screenshot" style={{maxWidth:"95vw",maxHeight:"92vh",objectFit:"contain",borderRadius:4,boxShadow:"0 0 60px rgba(0,0,0,0.8)"}}/>
          <button onClick={()=>setScreenshotZoom(null)} style={{position:"fixed",top:16,right:16,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:4,padding:"6px 12px",color:"#fff",fontSize:13,cursor:"pointer"}}>✕ close</button>
        </div>
      )}

      {/* ── Economic events panel (dropdown from top bar) ── */}
      {newsImpactOpen&&(
        <div onClick={()=>setNewsImpactOpen(false)} style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.25)"}}>
          <div onClick={e=>e.stopPropagation()} style={{position:"fixed",top:36,left:"50%",transform:"translateX(-50%)",width:"min(620px,96vw)",background:TH.card,border:"1px solid "+TH.border,borderRadius:"0 0 16px 16px",boxShadow:"0 20px 60px rgba(0,0,0,0.2)",overflow:"hidden",zIndex:201,maxHeight:"80vh",display:"flex",flexDirection:"column"}}>
            {/* panel header */}
            <div style={{padding:"11px 18px",background:isDark?"#131722":TH.card,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
              <div style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2}}>THIS WEEK'S ECONOMIC EVENTS</div>
              <button onClick={()=>setNewsImpactOpen(false)} style={{background:"none",border:"none",color:TH.textDim,fontSize:15,cursor:"pointer",lineHeight:1,padding:"0 2px"}}>✕</button>
            </div>
            {todayNews.length===0?(
              <div style={{padding:"28px",textAlign:"center",fontSize:11,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>Loading events… or no events this week ✓</div>
            ):(()=>{
              // Group by day
              const todayStr=new Date().toISOString().slice(0,10);
              const byDay={};
              todayNews.forEach(e=>{
                const day=(e.time||"").slice(0,10)||"unknown";
                if(!byDay[day]) byDay[day]=[];
                byDay[day].push(e);
              });
              const days=Object.keys(byDay).sort();
              return (
                <div style={{overflowY:"auto",flex:1}}>
                  {days.map(day=>{
                    const isToday=day===todayStr;
                    const dayLabel=isToday?"TODAY — "+new Date(day+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"})
                      :new Date(day+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});
                    const dayEvs=byDay[day];
                    const dayHigh=dayEvs.filter(e=>(e.impact||"").toLowerCase()==="high").length;
                    return (
                      <div key={day}>
                        {/* Day header */}
                        <div style={{padding:"8px 18px",background:isToday?"#f0fdf4":"#f8fafc",borderBottom:"1px solid rgba(255,255,255,0.05)",borderTop:"1px solid #d1d4dc",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span style={{fontSize:10,fontWeight:700,color:isToday?"#26a69a":"#787b86",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>{dayLabel}</span>
                          {dayHigh>0&&<span style={{fontSize:9,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>🔴 {dayHigh} high</span>}
                        </div>
                        {/* Events */}
                        {dayEvs.sort((a,b)=>a.time?.localeCompare(b.time||"")||0).map((e,i)=>{
                          const ts=e.time?new Date(e.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",timeZone:"UTC"}):"—";
                          const imp=(e.impact||"").toLowerCase();
                          const isH=imp==="high",isM=imp==="medium"||imp==="moderate";
                          return (
                            <div key={i} style={{display:"flex",gap:10,alignItems:"center",padding:"9px 18px",borderBottom:"1px solid #fafafa",background:isH&&isToday?"rgba(220,38,38,0.02)":"transparent"}}>
                              <div style={{fontSize:11,flexShrink:0}}>{isH?"🔴":isM?"🟠":"🟡"}</div>
                              <div style={{minWidth:38,fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0}}>{ts}</div>
                              <div style={{minWidth:34,fontSize:11,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0}}>{e.currency||"—"}</div>
                              <div style={{flex:1,fontSize:11,color:isH?"#374151":"#787b86",lineHeight:1.4}}>{e.name||"—"}</div>
                              <div style={{fontSize:8,fontWeight:700,color:isH?"#ef5350":isM?"#ea580c":"#ca8a04",background:isH?"#fee2e2":isM?"#fff7ed":"#fefce8",borderRadius:99,padding:"1px 7px",fontFamily:"'IBM Plex Sans',sans-serif",whiteSpace:"nowrap",textTransform:"uppercase",flexShrink:0}}>{imp||"low"}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Session + clock bar with live countdown ── */}
      {(()=>{
        const sessions=getSessions();
        const active=sessions.filter(s=>s.active);
        const now=new Date();
        const utcStr=now.toUTCString().slice(17,22)+" UTC";
        const localStr=now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
        const overlap=active.length>1;
        // Find the most relevant countdown — next close if in session, else next open
        const londonC = sessionCountdown["London"];
        const nyC = sessionCountdown["New York"];
        const mainSession = active.find(s=>s.name==="London")||active.find(s=>s.name==="New York")||active[0];
        const cdInfo = mainSession ? sessionCountdown[mainSession.name] : (londonC||nyC);
        return (
          <div style={{background:"#0a0f1e",padding:"5px 20px 5px 68px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",minHeight:34}}>
            <span style={{fontSize:9,color:"rgba(241,245,249,0.75)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5,textTransform:"uppercase",flexShrink:0,fontWeight:600}}>Markets</span>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            {sessions.map(s=>{
              const cd = sessionCountdown[s.name];
              return (
                <div key={s.name} title={cd?cd.label:""} style={{display:"flex",alignItems:"center",gap:4,opacity:s.active?1:0.28,transition:"opacity 0.3s",cursor:"default"}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:s.active?s.color:TH.textDim,boxShadow:s.active?"0 0 7px "+s.color+"aa":"none",transition:"all 0.5s"}}/>
                  <span style={{fontSize:9.5,color:s.active?s.color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:s.active?600:400}}>{s.name}</span>
                  {s.active&&cd&&<span style={{fontSize:7.5,color:isDark?"rgba(255,255,255,0.25)":"rgba(15,23,42,0.35)",fontFamily:"'IBM Plex Sans',sans-serif",marginLeft:1}}>{Math.floor(cd.minsLeft/60)>0?Math.floor(cd.minsLeft/60)+"h ":""}{cd.minsLeft%60}m</span>}
                </div>
              );
            })}
            </div>
            {overlap&&<div style={{fontSize:8.5,color:"#f59e0b",fontFamily:"'IBM Plex Sans',sans-serif",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:99,padding:"1px 9px",fontWeight:700}}>⚡ Overlap</div>}
            {/* News impact pills — always visible, shows today or this week */}
            {(()=>{
              const todayStr=new Date().toISOString().slice(0,10);
              const todayEvs=todayNews.filter(e=>(e.time||"").slice(0,10)===todayStr);
              const show=todayEvs.length>0?todayEvs:todayNews; // fall back to whole week
              const high=show.filter(e=>(e.impact||"").toLowerCase()==="high").length;
              const med=show.filter(e=>{const i=(e.impact||"").toLowerCase();return i==="medium"||i==="moderate";}).length;
              const isToday=todayEvs.length>0;
              return (
                <button onClick={()=>setNewsImpactOpen(o=>!o)}
                  style={{display:"flex",alignItems:"center",gap:5,background:newsImpactOpen?"rgba(255,255,255,0.14)":"rgba(255,255,255,0.07)",border:"1px solid "+(newsImpactOpen?"rgba(255,255,255,0.25)":"rgba(255,255,255,0.06)"),borderRadius:99,padding:"3px 12px",cursor:"pointer",transition:"all 0.15s"}}>
                  {todayNews.length===0
                    ? <span style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>📅 EVENTS</span>
                    : <>
                        {high>0?<span style={{fontSize:9,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>🔴 {high}</span>:<span style={{fontSize:9,color:"#26a69a",fontFamily:"'IBM Plex Sans',sans-serif"}}>✓</span>}
                        {med>0&&<span style={{fontSize:9,color:"#fb923c",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>🟠 {med}</span>}
                        {!isToday&&<span style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginLeft:1}}>WK</span>}
                        <span style={{fontSize:8,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif"}}>▾</span>
                      </>
                  }
                </button>
              );
            })()}
            <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
              {/* Day/Night toggle — lives in header, never overlaps anything */}
              <button onClick={()=>setIsDark(d=>!d)}
                style={{display:"flex",alignItems:"center",gap:4,background:isDark?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.06)",
                  border:"1px solid "+(isDark?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.1)"),
                  borderRadius:99,padding:"3px 10px",cursor:"pointer",transition:"all 0.2s",
                  fontFamily:"'IBM Plex Sans',sans-serif"}}>
                <span style={{fontSize:11}}>{isDark?"☀️":"🌙"}</span>
                <span style={{fontSize:7.5,fontWeight:700,letterSpacing:0.5,
                  color:isDark?"rgba(241,245,249,0.5)":"rgba(15,23,42,0.5)"}}>{isDark?"DAY":"NIGHT"}</span>
              </button>
              <div style={{width:1,height:12,background:isDark?"#334155":"#cbd5e1"}}/>
              <span style={{fontSize:10,color:isDark?"rgba(241,245,249,0.6)":"rgba(15,23,42,0.7)",fontFamily:"'IBM Plex Sans',sans-serif"}}>{utcStr}</span>
              <div style={{width:1,height:12,background:isDark?"#334155":"#cbd5e1"}}/>
              <span style={{fontSize:11,color:isDark?"rgba(241,245,249,0.65)":"rgba(15,23,42,0.75)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>{localStr}</span>
            </div>
          </div>
        );
      })()}

      {/* ── Feature overlays ── */}
      {!riskLockDismissed&&<RiskLockOverlay trades={trades} riskLimit={riskLimit}
        onDismiss={()=>setRiskLockDismissed(true)}
        onEdit={()=>{setRiskLockDismissed(true);setTab("setup");}}/>}
      <ChecklistModal open={checklistOpen} onClose={()=>{setChecklistOpen(false);setChecklistDone({});}}
        checklist={checklist||DEFAULT_CHECKLIST} checklistDone={checklistDone} setChecklistDone={setChecklistDone}
        onSaveChecklist={items=>{setChecklist(items);try{localStorage.setItem("tl_checklist",JSON.stringify(items));}catch{}}}/>
      <TradeGradeModal trade={tagModal} journals={journals} onClose={()=>setTagModal(null)}
        onSave={(ticket,answers,note,grade)=>{
          const u={...journals,[ticket]:{...(journals[ticket]||{}),tradeGrade:answers,quickNote:note,execGrade:grade,savedAt:new Date().toISOString()}};
          setJournals(u);try{localStorage.setItem("tl_journals",JSON.stringify(u));}catch{};
          setTagModal(null);
        }}/>
      <TradeReplay trade={replayTrade} onClose={()=>setReplayTrade(null)}/>

      {!serverOk&&<div style={{background:"rgba(248,113,113,0.08)",borderBottom:"1px solid #fecaca",padding:"9px 24px 9px 70px",fontSize:12,color:"#ef5350",display:"flex",alignItems:"center",gap:8,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:500}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:"#ff2d55",animation:"pulse 1.5s infinite"}}/>
        SERVER OFFLINE
        <button onClick={fetchAll} style={{marginLeft:"auto",background:"rgba(248,113,113,0.1)",border:"1px solid #ef9a9a",borderRadius:6,padding:"4px 14px",color:"#ef5350",fontSize:11,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>RETRY</button>
      </div>}

      <div style={{display:"flex",minHeight:"calc(100vh - 36px)",background:TH.bg,transition:"background 0.3s ease",background:TH.bg}}>

        {/* overlay */}
        {sideOpen&&<div onClick={()=>setSideOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:49}}/>}

        {/* ── TradingView-style icon rail ── */}
        <div className="desktop-sidebar" style={{
          width:48,minWidth:48,
          background:isDark?"#131722":"#ffffff",
          display:"flex",flexDirection:"column",alignItems:"center",
          position:"fixed",top:0,left:0,height:"100vh",zIndex:50,
          borderRight:"1px solid "+(isDark?"#2a2e39":"#e0e3eb"),
        }}>
          {/* Logo */}
          <div style={{width:"100%",height:46,display:"flex",alignItems:"center",justifyContent:"center",
            borderBottom:"1px solid "+(isDark?"#2a2e39":"#e0e3eb"),marginBottom:4,flexShrink:0}}>
            <div style={{width:26,height:26,borderRadius:3,background:"#2962ff",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:9,fontWeight:700,color:"#fff",letterSpacing:-0.3,
              fontFamily:"'IBM Plex Mono',monospace"}}>TL</div>
          </div>
          {/* Nav */}
          <div style={{flex:1,width:"100%",display:"flex",flexDirection:"column",paddingTop:4}}>
            {NAV.map(n=>{
              const icons={watchlist:"⊞",dashboard:"⊟",calendar:"⊡",news:"⊠",setup:"⊹"};
              const labels={watchlist:"Watch",dashboard:"Dash",calendar:"Cal",news:"News",setup:"Setup"};
              return (
                <button key={n.id}
                  onClick={()=>{setTab(n.id);setSideOpen(false);}}
                  className={"tv-nav-btn"+(tab===n.id?" active":"")}
                  title={n.label}
                  style={{width:"100%"}}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0}}>
                    {n.id==="watchlist"&&<path d="M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z" opacity=".9"/>}
                    {n.id==="dashboard"&&<path d="M1 1h6v8H1V1zm8 0h6v4H9V1zM1 11h6v4H1v-4zm8 2h6v2H9v-2z" opacity=".9"/>}
                    {n.id==="calendar"&&<path d="M1 3h14v1H1V3zm0 3h14v9H1V6zm2 2v1h2V8H3zm4 0v1h2V8H7zm4 0v1h2V8h-2zM3 11v1h2v-1H3zm4 0v1h2v-1H7zm4 0v1h2v-1h-2z" opacity=".9"/>}
                    {n.id==="news"&&<path d="M1 2h14v2H1V2zm0 4h9v1H1V6zm0 3h9v1H1V9zm0 3h6v1H1v-1zm11-4h3v5h-3V8z" opacity=".9"/>}
                    {n.id==="setup"&&<path d="M8 5a3 3 0 100 6A3 3 0 008 5zM6 1h4l.5 2.5A5 5 0 0112.5 5L15 4l2 3.5-2 1.5a5 5 0 010 2L15 12.5 13 16l-2.5-1a5 5 0 01-2 1L8 15H6l-.5-2.5a5 5 0 01-2-1L1 13l-1-3.5 2-1.5a5 5 0 010-2L0 4.5 2 1l2.5 1a5 5 0 012-1L6 1z" opacity=".9"/>}
                  </svg>
                  <span style={{fontSize:8,fontWeight:500,letterSpacing:0.2}}>{labels[n.id]}</span>
                </button>
              );
            })}
          </div>
          {/* Bottom */}
          <div style={{width:"100%",borderTop:"1px solid "+(isDark?"#2a2e39":"#e0e3eb"),
            paddingTop:6,paddingBottom:8,display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
            <div title={serverOk?"Connected":"Disconnected"} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,cursor:"default"}}>
              <div style={{width:6,height:6,borderRadius:"50%",
                background:serverOk?"#26a69a":"#ef5350",
                boxShadow:serverOk?"0 0 6px rgba(38,166,154,0.5)":"none"}}/>
              <span style={{fontSize:8,color:isDark?"#434651":"#9598a1"}}>{wsOk?"WS":"OFF"}</span>
            </div>
            <button onClick={()=>setIsDark(d=>!d)}
              style={{background:"none",border:"none",cursor:"pointer",
                fontSize:11,color:isDark?"#434651":"#9598a1",padding:"2px",
                transition:"color 0.1s",lineHeight:1}}
              onMouseEnter={e=>e.currentTarget.style.color=isDark?"#d1d4dc":"#131722"}
              onMouseLeave={e=>e.currentTarget.style.color=isDark?"#434651":"#9598a1"}
            >{isDark?"☀":"☾"}</button>
          </div>
        </div>

        {/* Slide-out label panel */}
        {sideOpen&&(
          <div style={{
            width:180,background:isDark?"#1e222d":"#ffffff",
            position:"fixed",top:0,left:48,height:"100vh",zIndex:50,
            borderRight:"1px solid "+(isDark?"#2a2e39":"#e0e3eb"),
            animation:"slideIn 0.12s ease",display:"flex",flexDirection:"column",
          }}>
            <div style={{height:46,padding:"0 14px",borderBottom:"1px solid "+(isDark?"#2a2e39":"#e0e3eb"),
              display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:13,fontWeight:600,color:isDark?"#d1d4dc":"#131722"}}>TradeLedger</div>
            </div>
            <div style={{flex:1,padding:"6px 4px",overflowY:"auto"}}>
              {NAV.map(n=>(
                <button key={n.id} onClick={()=>{setTab(n.id);setSideOpen(false);}}
                  style={{width:"100%",background:tab===n.id?(isDark?"rgba(41,98,255,0.1)":"rgba(41,98,255,0.07)"):"transparent",
                    border:"none",borderLeft:tab===n.id?"2px solid #2962ff":"2px solid transparent",
                    color:tab===n.id?"#2962ff":isDark?"#787b86":"#9598a1",
                    fontSize:12,fontWeight:tab===n.id?600:400,
                    cursor:"pointer",padding:"8px 12px",display:"flex",alignItems:"center",gap:8,
                    textAlign:"left",transition:"all 0.1s",marginBottom:1}}>
                  <span>{n.label}</span>
                </button>
              ))}
            </div>
            <div style={{padding:"10px 14px",borderTop:"1px solid "+(isDark?"#2a2e39":"#e0e3eb")}}>
              <div style={{fontSize:11,color:isDark?"#434651":"#b2b5be"}}>{trades.length} trades synced</div>
            </div>
          </div>
        )}
        {/* content */}
        <div className="main-content" style={{flex:1,padding:"16px 20px 40px 64px",overflowY:"auto",minWidth:0,background:TH.bg,transition:"background 0.3s ease"}}>

          {/* hamburger */}
          {/* theme toggle moved into header bar */}
          {!sideOpen&&<button onClick={()=>setSideOpen(true)}
            title="Menu"
            style={{position:"fixed",top:13,left:55,zIndex:100,width:22,height:22,
              background:"transparent",border:"none",
              color:isDark?"#434651":"#b2b5be",cursor:"pointer",
              display:"flex",flexDirection:"column",alignItems:"center",
              justifyContent:"center",gap:3,padding:0,transition:"color 0.1s"}}
            onMouseEnter={e=>e.currentTarget.style.color=isDark?"#d1d4dc":"#434651"}
            onMouseLeave={e=>e.currentTarget.style.color=isDark?"#434651":"#b2b5be"}>
            <div style={{width:11,height:1,background:"currentColor"}}/><div style={{width:11,height:1,background:"currentColor"}}/><div style={{width:11,height:1,background:"currentColor"}}/>
          </button>}

          {/* ══ WATCHLIST ══ */}
          {tab==="watchlist"&&(
            <div style={{animation:"slideIn 0.3s ease"}}>

              {/* Streak Banner */}
              <StreakBanner trades={trades} onClick={()=>setTab("analytics")}/>

              {/* Checklist FAB */}
              <div style={{position:"fixed",bottom:28,right:24,zIndex:200,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:10}}>
                <button onClick={()=>setChecklistOpen(true)}
                  style={{background:isDark?"linear-gradient(135deg,#131722,#1e293b)":"linear-gradient(135deg,#1e222d,#2d3f7c)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4,padding:"12px 18px",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",gap:8,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,fontSize:12}}>
                  <span style={{fontSize:16}}>✅</span> Pre-Trade Check
                </button>
              </div>

              {/* Chart modal popup */}
              {chartModal&&(
                <div onClick={()=>setChartModal(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
                  <div onClick={e=>e.stopPropagation()} style={{width:"min(960px,96vw)",height:"min(640px,85vh)",background:TH.card,border:"none",borderRadius:4,overflow:"hidden",position:"relative",boxShadow:"0 24px 80px rgba(0,0,0,0.25)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 18px",background:TH.inputBg,borderBottom:"1px solid "+TH.border}}>
                      <span style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:14,color:TH.text,letterSpacing:0,fontWeight:700}}>{chartModal}</span>
                      <div style={{display:"flex",gap:8}}>
                        <a href={"https://www.tradingview.com/chart/?symbol="+tvSym(chartModal)} target="_blank" rel="noopener noreferrer"
                          style={{background:"rgba(41,98,255,0.2)",border:"1px solid #cbd5e1",borderRadius:3,padding:"4px 10px",color:"#2962ff",fontSize:10,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",textDecoration:"none"}}>
                          ↗ OPEN FULL
                        </a>
                        <button onClick={()=>setChartModal(null)} style={{background:"rgba(248,113,113,0.1)",border:"1px solid #ef9a9a",borderRadius:3,padding:"4px 10px",color:"#ff2d55",fontSize:12,cursor:"pointer"}}>✕</button>
                      </div>
                    </div>
                    <iframe key={chartModal}
                      src={"https://s.tradingview.com/widgetembed/?symbol="+tvSym(chartModal)+"&interval=H1&theme=dark&style=1&locale=en&withdateranges=1&hidesidetoolbar=0&symboledit=1&saveimage=0"}
                      style={{width:"100%",height:"calc(100% - 42px)",border:"none",display:"block"}}
                      allowFullScreen/>
                  </div>
                </div>
              )}

              {/* Symbol picker modal */}
              {pickerOpen&&(
                <div onClick={()=>setPickerOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
                  <div onClick={e=>e.stopPropagation()} style={{width:"min(580px,95vw)",maxHeight:"82vh",background:TH.card,border:"none",borderRadius:4,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 80px rgba(0,0,0,0.2)"}}>
                    <div style={{padding:"18px 22px",borderBottom:"1px solid rgba(255,255,255,0.05)",display:"flex",justifyContent:"space-between",alignItems:"center",background:TH.inputBg}}>
                      <span style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:16,color:TH.text,letterSpacing:-0.3,fontWeight:700}}>ADD SYMBOL</span>
                      <button onClick={()=>setPickerOpen(false)} style={{background:"none",border:"none",color:"#334433",fontSize:16,cursor:"pointer"}}>✕</button>
                    </div>
                    <div style={{display:"flex",borderBottom:"1px solid "+TH.border,overflowX:"auto"}}>
                      {Object.keys(WL_SYMBOLS).map(cat=>(
                        <button key={cat} onClick={()=>setPickerCat(cat)} style={{background:pickerCat===cat?"#eff6ff":"transparent",border:"none",borderBottom:pickerCat===cat?"2px solid #2563eb":"2px solid transparent",padding:"10px 16px",color:pickerCat===cat?"#2563eb":"#787b86",fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:500,whiteSpace:"nowrap",flexShrink:0}}>
                          {cat.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <div style={{padding:14,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,overflowY:"auto"}}>
                      {WL_SYMBOLS[pickerCat].map(sym=>{
                        const already=watchlist.includes(sym);
                        return (
                          <button key={sym} onClick={()=>{
                            const u=already?watchlist.filter(x=>x!==sym):[...watchlist,sym];
                            setWatchlist(u);try{localStorage.setItem("tl_wl",JSON.stringify(u));}catch{}
                          }} style={{background:already?"rgba(0,255,65,0.12)":"rgba(0,255,65,0.03)",border:"1px solid "+(already?"rgba(0,255,65,0.5)":"rgba(0,255,65,0.1)"),borderRadius:4,padding:"10px 6px",color:already?"#2563eb":"#475569",fontSize:11,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:already?600:400,letterSpacing:1,textAlign:"center",transition:"all 0.15s",position:"relative"}}>
                            {already&&<span style={{position:"absolute",top:3,right:5,fontSize:8,color:"#2962ff"}}>✓</span>}
                            {sym}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{padding:"10px 18px",borderTop:"1px solid "+TH.border,fontSize:11,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center"}}>
                      {watchlist.length} symbols · tap to add/remove
                    </div>
                  </div>
                </div>
              )}

              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:20}}>
                <div>
                  <div style={{fontSize:11,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:4}}>/ Home</div>
                  <h1 style={{fontSize:34,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:-1,margin:0,color:TH.text,fontWeight:900,lineHeight:1}}>WATCHLIST</h1>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setPickerOpen(true)} style={{background:"rgba(41,98,255,0.2)",border:"1px solid #64748b",borderRadius:4,padding:"9px 18px",color:"#2962ff",fontSize:11,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1}}>＋ ADD SYMBOL</button>
                  <button onClick={refreshPrices} style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:4,padding:"9px 12px",color:TH.textSub,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}><span style={{display:"inline-block",animation:priceRefreshing?"spin 0.8s linear infinite":"none"}}>↻</span>{priceRefreshing&&<span style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>updating</span>}</button>
                </div>
              </div>

              {/* Stats strip */}
              {stats&&<div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
                <KPI th={TH} label="Net P&L"       value={(stats.totalProfit>=0?"+":"")+"$"+stats.totalProfit} color={stats.totalProfit>=0?"#26a69a":"#ef5350"} sub={stats.total+" trades"}/>
                <KPI th={TH} label="Win Rate"      value={stats.winRate+"%"}  color={"#2962ff"}  sub={stats.wins+"W · "+stats.losses+"L"}/>
                <KPI th={TH} label="Profit Factor" value={stats.pf>=99?"∞":stats.pf} color={"#f9a825"}/>
                <KPI th={TH} label="Max Drawdown"  value={stats.maxDD+"%"}   color={stats.maxDD>15?"#ef5350":"#7e57c2"}/>
              </div>}

              {/* Watchlist rows */}
              <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,overflow:"hidden",boxShadow:"0 1px 6px rgba(15,23,42,0.06)",marginBottom:20}}>
                {/* Table header */}
                <div style={{display:"grid",gridTemplateColumns:"140px 1fr 90px 90px 90px 90px 80px 70px 36px",alignItems:"center",padding:"8px 16px",background:TH.inputBg,borderBottom:"1px solid #e4e9f0"}}>
                  {["SYMBOL","PRICE","CHANGE","CHG %","HIGH","LOW","PREV","P&L",""].map((h,i)=>(
                    <div key={i} style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,fontWeight:700,textAlign:i>=2?"right":"left"}}>{h}</div>
                  ))}
                </div>
                {/* Rows */}
                {watchlist.map((sym,idx)=>{
                  const p=prices[sym], fl=pFlash[sym];
                  const chg=p?.changePct;
                  const isUp=chg!=null&&chg>0, isDn=chg!=null&&chg<0;
                  const flashUp=fl==="up", flashDn=fl==="down";
                  const tc=trades.filter(t=>t.symbol===sym).length;
                  const sp=+trades.filter(t=>t.symbol===sym).reduce((s,t)=>s+t.profit,0).toFixed(0);
                  const dec=sym.includes("JPY")?3:(["XAUUSD","XAGUSD","BTCUSD","ETHUSD","SPX500","US30","NAS100","UK100","GER40","FRA40","JPN225","AUS200","HK50"].includes(sym)?2:5);
                  const accentColor=isUp?"#26a69a":isDn?"#ef5350":"#94a3b8";
                  const rowBg=flashUp?"rgba(22,163,74,0.04)":flashDn?"rgba(220,38,38,0.04)":"transparent";
                  return (
                    <div key={sym} onClick={()=>setChartModal(sym)}
                      style={{display:"grid",gridTemplateColumns:"140px 1fr 90px 90px 90px 90px 80px 70px 36px",alignItems:"center",
                        padding:"11px 16px",borderBottom:idx<watchlist.length-1?"1px solid #f8fafc":"none",
                        background:rowBg,cursor:"pointer",transition:"background 0.15s",
                        borderLeft:"3px solid "+(isUp?"#26a69a":isDn?"#ef5350":"#d1d4dc")}}
                      onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                      onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                      {/* Symbol */}
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:28,height:28,borderRadius:4,background:isUp?"#f0fdf4":isDn?"#fef2f2":"#f8fafc",
                          border:"1px solid "+(isUp?"#dcfce7":isDn?"#fecaca":"#d1d4dc"),
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:8,fontWeight:800,color:accentColor,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0}}>
                          {sym.slice(0,3)}
                        </div>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.3}}>{sym}</div>
                          {tc>0&&<div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{tc} trades</div>}
                        </div>
                      </div>
                      {/* Price */}
                      <div style={{textAlign:"right",paddingRight:8}}>
                        {p?.price!=null
                          ?<div style={{fontSize:15,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,
                              color:flashUp?"#26a69a":flashDn?"#ef5350":TH.text,letterSpacing:-0.3}}>
                            {p.price.toFixed(dec)}
                          </div>
                          :<div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:5}}>
                            <div style={{width:5,height:5,borderRadius:"50%",background:"rgba(255,255,255,0.12)",animation:"pulse 1.5s infinite"}}/>
                            <span style={{fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif"}}>—</span>
                          </div>
                        }
                      </div>
                      {/* Change abs */}
                      <div style={{textAlign:"right",fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,color:accentColor}}>
                        {p?.change!=null?(isUp?"+":"")+p.change.toFixed(dec):"—"}
                      </div>
                      {/* Change % pill */}
                      <div style={{textAlign:"right"}}>
                        {chg!=null
                          ?<span style={{display:"inline-block",background:isUp?"#f0fdf4":isDn?"#fef2f2":"#f8fafc",
                              border:"1px solid "+(isUp?"#bbf7d0":isDn?"#fecaca":"#d1d4dc"),
                              borderRadius:99,padding:"2px 8px",fontSize:10,fontWeight:700,color:accentColor,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                              {isUp?"+":""}{chg.toFixed(2)}%
                            </span>
                          :<span style={{fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif"}}>—</span>
                        }
                      </div>
                      {/* High */}
                      <div style={{textAlign:"right",fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",color:"#2962ff",fontWeight:600}}>
                        {p?.high!=null?p.high.toFixed(dec):"—"}
                      </div>
                      {/* Low */}
                      <div style={{textAlign:"right",fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",color:"#ef5350",fontWeight:600}}>
                        {p?.low!=null?p.low.toFixed(dec):"—"}
                      </div>
                      {/* Prev Close */}
                      <div style={{textAlign:"right",fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.textSub}}>
                        {p?.prevClose!=null?p.prevClose.toFixed(dec):"—"}
                      </div>
                      {/* P&L */}
                      <div style={{textAlign:"right",fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,
                        color:tc===0?"#cbd5e1":sp>=0?"#26a69a":"#ef5350"}}>
                        {tc>0?(sp>=0?"+":"")+"$"+sp:"—"}
                      </div>
                      {/* Remove */}
                      <div style={{textAlign:"right"}}>
                        <button onClick={e=>{e.stopPropagation();const u=watchlist.filter(x=>x!==sym);setWatchlist(u);try{localStorage.setItem("tl_wl",JSON.stringify(u));}catch{}}}
                          style={{background:"none",border:"none",color:TH.text,fontSize:15,cursor:"pointer",padding:"2px 4px",lineHeight:1,borderRadius:4}}
                          onMouseEnter={e=>e.currentTarget.style.color="#ef5350"}
                          onMouseLeave={e=>e.currentTarget.style.color="#d1d4dc"}>×</button>
                      </div>
                    </div>
                  );
                })}
                {/* Add row */}
                <div onClick={()=>setPickerOpen(true)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 16px",cursor:"pointer",
                    borderTop:watchlist.length>0?"1px solid #f8fafc":"none",background:"transparent",transition:"background 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{width:28,height:28,borderRadius:4,border:"2px dashed #e2e8f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"rgba(255,255,255,0.2)"}}>＋</div>
                  <span style={{fontSize:11,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:500}}>Add symbol</span>
                </div>
              </div>

              {/* ── Analyst Predictions Panel ── */}
              <PredictionsPanel watchlist={watchlist} prices={prices} trades={trades}/>

                            {/* AI Market Briefing + Recent Headlines */}
              <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"20px 22px",boxShadow:"none"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:briefingLd?"#fbbf24":"#26a69a",animation:"pulse 2s infinite"}}/>
                    <span style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5}}>AI MARKET BRIEFING</span>
                    {briefing?.generatedAt&&<span style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                      {Math.floor((Date.now()-new Date(briefing.generatedAt).getTime())/60000)}m ago
                    </span>}
                  </div>
                  <button onClick={()=>fetchBriefing([])} disabled={briefingLd}
                    style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:6,padding:"4px 10px",color:TH.textSub,fontSize:8,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                    {briefingLd?"⏳ GENERATING...":"↻ REFRESH"}
                  </button>
                </div>
                {briefingLd&&!briefing&&(
                  <div style={{padding:"16px 0",color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",fontSize:10,animation:"pulse 1s infinite"}}>Analysing latest headlines…</div>
                )}
                {briefing?.briefing&&(
                  <div style={{fontSize:13,color:TH.text,lineHeight:1.6,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:16,borderLeft:"2px solid #2962ff",paddingLeft:12}}>
                    {briefing.briefing}
                  </div>
                )}
                {!briefing&&!briefingLd&&newsFeed.length===0&&(
                  <div style={{color:TH.textDim,fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif",padding:"8px 0"}}>Loading market data…</div>
                )}
                {/* Top 5 recent headlines as quick pills */}
                {newsFeed.length>0&&(
                  <div>
                    <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:8}}>LATEST HEADLINES</div>
                    {newsFeed.slice(0,5).map((a,i)=>{
                      const d=a.pubDate?new Date(a.pubDate):null;
                      const minsAgo=d?Math.floor((Date.now()-d)/60000):null;
                      const age=minsAgo===null?"":minsAgo<2?"LIVE":minsAgo<60?minsAgo+"m":"";
                      return (
                        <div key={i} onClick={()=>openArticle(a)}
                          style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid "+TH.border,cursor:"pointer"}}
                          onMouseEnter={e=>e.currentTarget.style.opacity="0.75"}
                          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                          <div style={{width:16,height:16,borderRadius:4,background:TH.inputBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:TH.textDim,flexShrink:0}}>{i+1}</div>
                          <div style={{flex:1,fontSize:11,color:TH.textSub,lineHeight:1.4,fontFamily:"'IBM Plex Sans',sans-serif"}}>{a.title}</div>
                          {age&&<span style={{fontSize:7,color:minsAgo<5?"#26a69a":TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0,fontWeight:700}}>{age}</span>}
                        </div>
                      );
                    })}
                    <button onClick={()=>setTab("news")} style={{marginTop:10,background:isDark?"rgba(41,98,255,0.12)":"rgba(41,98,255,0.08)",border:"1px solid rgba(41,98,255,0.25)",borderRadius:4,padding:"8px 16px",color:"#2962ff",fontSize:10,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",width:"100%"}}>
                      VIEW ALL {savedNews.length} SAVED ARTICLES →
                    </button>
                  </div>
                )}
              </div>

            </div>
          )}

          {/* ══ DASHBOARD ══ */}
          {tab==="dashboard"&&(
            <div style={{animation:"slideIn 0.3s ease"}}>
              {/* ── Compact header ── */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div>
                  <div style={{fontSize:10,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>Overview</div>
                  <h1 style={{fontSize:26,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:-1,margin:0,color:TH.text,fontWeight:900,lineHeight:1}}>Dashboard</h1>
                </div>
                {trades.length>0&&(
                  <button onClick={()=>exportTradesToCSV(trades)}
                    style={{background:isDark?"rgba(38,166,154,0.1)":"rgba(5,150,105,0.08)",
                      border:"1px solid rgba(52,211,153,0.3)",borderRadius:4,
                      padding:"7px 14px",color:"#26a69a",fontSize:9,cursor:"pointer",
                      fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,fontWeight:700,
                      display:"flex",alignItems:"center",gap:5,transition:"all 0.15s"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=isDark?"rgba(52,211,153,0.18)":"rgba(5,150,105,0.14)";}}
                    onMouseLeave={e=>{e.currentTarget.style.background=isDark?"rgba(38,166,154,0.1)":"rgba(5,150,105,0.08)";}}>
                    ↓ EXPORT CSV
                  </button>
                )}
              </div>

              {/* ── ROW 1: Today P&L + Risk Calc ── */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12,alignItems:"stretch"}}>

                {/* Today P&L (compact speedometer) */}
                {(()=>{
                  const todayStr=new Date().toISOString().slice(0,10);
                  const todayTrades=trades.filter(t=>mt5Day(t.closeTime)===todayStr);
                  const todayPnl=todayTrades.reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0);
                  const todayWins=todayTrades.filter(t=>t.profit>0).length;
                  const limit=riskLimit?Math.abs(riskLimit):100;
                  const maxRange=Math.max(limit,Math.abs(todayPnl),50);
                  const angle=Math.max(-118,Math.min(118,(todayPnl/maxRange)*118));
                  const pctUsed=riskLimit?Math.min(100,Math.abs(Math.min(todayPnl,0))/limit*100):0;
                  const col=todayPnl>0?"#26a69a":todayPnl<0?"#ef5350":"#787b86";
                  return (
                    <div style={{background:TH.card,borderRadius:4,padding:"12px 16px",border:"1px solid "+TH.border,display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                        <div style={{fontSize:9,color:TH.textSub,letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>TODAY'S P&L</div>
                        <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{todayTrades.length}t · {todayWins}W</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <svg width="150" height="82" viewBox="0 0 200 110" style={{overflow:"visible"}}>
                          <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke={isDark?"rgba(255,255,255,0.06)":"#d1d4dc"} strokeWidth="14" strokeLinecap="round"/>
                          <path d="M 20 100 A 80 80 0 0 1 100 20" fill="none" stroke="rgba(239,83,80,0.12)" strokeWidth="14" strokeLinecap="round"/>
                          <path d="M 100 20 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(38,166,154,0.12)" strokeWidth="14" strokeLinecap="round"/>
                          <circle cx="100" cy="100" r="5" fill={col} opacity="0.9"/>
                          <line x1="100" y1="100" x2="100" y2="32" stroke={col} strokeWidth="2.5" strokeLinecap="round" style={{transformOrigin:"100px 100px",transform:"rotate("+angle+"deg)",transition:"transform 0.8s cubic-bezier(0.34,1.56,0.64,1)"}}/>
                          <text x="12" y="108" fontSize="8" fill="#ef5350" fontFamily="monospace">LOSS</text>
                          <text x="153" y="108" fontSize="8" fill="#26a69a" fontFamily="monospace">WIN</text>
                        </svg>
                      </div>
                      <div style={{textAlign:"center"}}>
                        <div style={{fontSize:26,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:col,letterSpacing:-1,lineHeight:1}}>{todayPnl>=0?"+":""}{todayPnl.toFixed(2)}</div>
                        {!todayTrades.length&&<div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:2}}>No trades today</div>}
                      </div>
                      {riskLimit&&(
                        <div style={{marginTop:8}}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:2}}>
                            <span>Risk used</span><span style={{color:pctUsed>80?"#ef5350":"#787b86"}}>{pctUsed.toFixed(0)}% of ${limit}</span>
                          </div>
                          <div style={{height:3,background:TH.inputBg,borderRadius:4,overflow:"hidden"}}>
                            <div style={{height:"100%",width:pctUsed+"%",background:pctUsed>80?"linear-gradient(90deg,#f59e0b,#ef5350)":"#26a69a",borderRadius:4,transition:"width 0.5s"}}/>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Performance Coach placeholder — full card shown below */}
                <div style={{display:"none"}}/>

                {/* Risk Calculator */}
                <RiskCalc trades={trades}/>
              </div>

              {/* ── Performance Coach — full width ── */}
              {(()=>{
                const hasReport = weeklyAI?.sections?.length>0;
                return (
                  <div style={{background:TH.card,borderRadius:4,border:"1px solid "+TH.border,padding:"14px 16px",marginBottom:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:hasReport?12:0}}>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <div style={{width:30,height:30,borderRadius:9,background:TH.inputBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>📈</div>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.text}}>Performance Coach</div>
                          <div style={{fontSize:8.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                            {hasReport?`Based on ${weeklyAI.tradeCount} trades · ${new Date(weeklyAI.generatedAt).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}`:"Full breakdown: what went wrong, when & what to trade, how to improve"}
                          </div>
                        </div>
                      </div>
                      <button onClick={()=>genWeeklyAI(true)} disabled={!stats}
                        style={{background:"linear-gradient(135deg,rgba(41,98,255,0.25),rgba(41,98,255,0.2))",border:"1px solid rgba(41,98,255,0.4)",borderRadius:4,padding:"6px 14px",color:"#2962ff",fontSize:10,cursor:!stats?"not-allowed":"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,opacity:!stats?0.4:1}}>
                        {hasReport?"↻ RE-ANALYSE":"▶ ANALYSE NOW"}
                      </button>
                    </div>
                    {!hasReport&&<div style={{fontSize:11,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",padding:"8px 0"}}>
                      {stats?`${stats.total} trades ready — click Analyse to get your personalised coaching report with specific steps`:"No trades yet — sync your MT5 EA first"}
                    </div>}
                    {hasReport&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10}}>
                        {weeklyAI.sections.map(sec=>(
                          <div key={sec.id} style={{background:sec.bg,border:"1px solid "+sec.border,borderRadius:4,padding:"12px 14px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
                              <span style={{fontSize:14}}>{sec.icon}</span>
                              <span style={{fontSize:8,fontWeight:700,color:sec.color,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5}}>{sec.label}</span>
                            </div>
                            <div style={{fontSize:10.5,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.4,marginBottom:5}}>{sec.what}</div>
                            <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.55,marginBottom:8,paddingBottom:8,borderBottom:"1px solid "+sec.border}}>{sec.why}</div>
                            <div style={{display:"flex",flexDirection:"column",gap:6}}>
                              {sec.steps.map((step,si)=>(
                                <div key={si} style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                                  <div style={{minWidth:17,height:17,borderRadius:5,background:sec.color+"20",border:"1px solid "+sec.color+"50",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7.5,color:sec.color,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0,marginTop:1}}>{si+1}</div>
                                  <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.55}}>{step}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── ROW 2: 10 KPI stats in 5+5 compact grid ── */}
              {!stats?<div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"40px",color:TH.textDim,gap:10}}>
                <div style={{fontSize:36,color:TH.textSub}}>📡</div>
                <div style={{fontSize:13,color:"#3a3f4a"}}>No trades yet — install EA in MT5 to sync</div>
                <button onClick={()=>setTab("setup")} style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:4,padding:"8px 16px",color:"#26a69a",fontSize:11,cursor:"pointer"}}>EA Setup →</button>
              </div>:<>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:8}}>
                  {[
                    {label:"Net P&L",    value:(stats.totalProfit>=0?"+":"")+"$"+stats.totalProfit, color:stats.totalProfit>=0?"#26a69a":"#ef5350", sub:stats.total+" trades"},
                    {label:"Win Rate",   value:stats.winRate+"%",   color:"#2962ff",   sub:stats.wins+"W · "+stats.losses+"L"},
                    {label:"Prof. Factor",value:stats.pf>=99?"∞":stats.pf, color:"#f9a825"},
                    {label:"Max Drawdown",value:stats.maxDD+"%",    color:stats.maxDD>15?"#ef5350":"#7e57c2"},
                    {label:"Expectancy", value:"$"+stats.expectancy,color:stats.expectancy>=0?"#26a69a":"#ef5350"},
                  ].map(k=>(
                    <div key={k.label} style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
                      <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${k.color}80,transparent)`}}/>
                      <div style={{fontSize:8,color:k.color+"99",textTransform:"uppercase",letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,marginBottom:4}}>{k.label}</div>
                      <div style={{fontSize:20,fontWeight:800,color:k.color,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:-0.5,lineHeight:1}}>{k.value}</div>
                      {k.sub&&<div style={{fontSize:8,color:TH.textDim,marginTop:3,fontFamily:"'IBM Plex Sans',sans-serif"}}>{k.sub}</div>}
                    </div>
                  ))}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {label:"Avg Win",    value:"$"+stats.avgWin,  color:"#26a69a"},
                    {label:"Avg Loss",   value:"$"+stats.avgLoss, color:"#ef5350"},
                    {label:"Risk:Reward",value:"1:"+stats.rr,     color:"#f9a825"},
                    {label:"Max C. Wins",value:stats.maxCW,       color:"#26a69a"},
                    {label:"Max C. Loss",value:stats.maxCL,       color:"#ef5350"},
                  ].map(k=>(
                    <div key={k.label} style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
                      <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${k.color}80,transparent)`}}/>
                      <div style={{fontSize:8,color:k.color+"99",textTransform:"uppercase",letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,marginBottom:4}}>{k.label}</div>
                      <div style={{fontSize:20,fontWeight:800,color:k.color,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:-0.5,lineHeight:1}}>{k.value}</div>
                    </div>
                  ))}
                </div>

                {/* ── ROW 3: Equity curve + P&L by Symbol/Session side by side ── */}
                <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:12,marginBottom:12}}>
                  <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"14px 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{fontSize:10,color:"rgba(41,98,255,0.8)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,letterSpacing:1}}>EQUITY CURVE</div>
                      <div style={{fontSize:10,color:stats.totalProfit>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>{stats.totalProfit>=0?"▲":"▼"} ${Math.abs(stats.totalProfit)}</div>
                    </div>
                    <ResponsiveContainer width="100%" height={150}>
                      <AreaChart data={stats.equity}>
                        <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={"#26a69a"} stopOpacity={0.2}/><stop offset="95%" stopColor={"#26a69a"} stopOpacity={0}/></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDark?"rgba(255,255,255,0.04)":"rgba(0,0,0,0.05)"}/>
                        <XAxis dataKey="date" tick={{fill:"#94a3b8",fontSize:9,fontFamily:"'IBM Plex Mono',monospace"}}/>
                        <YAxis tick={{fill:"#94a3b8",fontSize:9,fontFamily:"'IBM Plex Mono',monospace"}} tickFormatter={v=>"$"+v}/>
                        <Tooltip content={<Tip/>}/>
                        <Area type="monotone" dataKey="bal" stroke={"#26a69a"} strokeWidth={2} fill="url(#eg)" dot={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"14px 16px",flex:1}}>
                      <div style={{fontSize:10,color:"rgba(41,98,255,0.8)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,letterSpacing:1,marginBottom:6}}>P&L BY SYMBOL</div>
                      <ResponsiveContainer width="100%" height={60}>
                        <BarChart data={stats.bySymbol.slice(0,6)} margin={{top:0,right:0,left:-20,bottom:0}}>
                          <XAxis dataKey="symbol" tick={{fill:"#94a3b8",fontSize:8,fontFamily:"'IBM Plex Mono',monospace"}}/>
                          <Tooltip content={<Tip/>}/>
                          <Bar dataKey="profit" fill={"#26a69a"} radius={[2,2,0,0]}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"14px 16px",flex:1}}>
                      <div style={{fontSize:10,color:"rgba(41,98,255,0.8)",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,letterSpacing:1,marginBottom:6}}>P&L BY SESSION</div>
                      <ResponsiveContainer width="100%" height={60}>
                        <BarChart data={stats.sessions} margin={{top:0,right:0,left:-20,bottom:0}}>
                          <XAxis dataKey="name" tick={{fill:"#94a3b8",fontSize:8,fontFamily:"'IBM Plex Mono',monospace"}}/>
                          <Tooltip content={<Tip/>}/>
                          <Bar dataKey="profit" fill={"#2962ff"} radius={[2,2,0,0]}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </>}
            </div>
          )}


          {/* ══ ANALYTICS merged into Dashboard below ══ */}
          {tab==="dashboard"&&stats&&(
            <div style={{animation:"slideIn 0.3s ease",marginTop:32}}>
              {/* Section divider */}
              <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:14}}>
                <div style={{height:1,flex:1,background:TH.border}}/>
                <div style={{fontSize:11,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>Deep Dive Analytics</div>
                <div style={{height:1,flex:1,background:TH.border}}/>
              </div>

              {/* Symbol breakdown + Win/Loss */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:10}}>
                  <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px"}}>
                    <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:14}}>Symbol Breakdown</div>
                    {stats.bySymbol.slice(0,8).map(s=>{
                      const maxAbs=Math.max(...stats.bySymbol.slice(0,8).map(x=>Math.abs(x.profit)),1);
                      const pct=Math.min(Math.abs(s.profit)/maxAbs*100,100);
                      return (<div key={s.symbol} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:60,fontFamily:"'IBM Plex Sans',sans-serif",fontSize:10,color:TH.textSub,flexShrink:0}}>{s.symbol}</div>
                        <div style={{flex:1,height:20,background:TH.inputBg,borderRadius:4,position:"relative",overflow:"hidden",border:"1px solid rgba(255,255,255,0.05)"}}>
                          <div style={{position:"absolute",left:0,top:0,bottom:0,width:pct+"%",background:s.profit>=0?"rgba(22,163,74,0.15)":"rgba(220,38,38,0.12)",borderRadius:4}}/>
                          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",paddingLeft:7,fontSize:9,color:s.profit>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>{s.profit>=0?"+":""}${s.profit} · {s.trades}t</div>
                        </div>
                      </div>);
                    })}
                  </div>
                  <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px"}}>
                    <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:6}}>WIN / LOSS</div>
                    <ResponsiveContainer width="100%" height={90}>
                      <PieChart>
                        <Pie data={[{name:"Wins",value:stats.wins},{name:"Losses",value:stats.losses}]} cx="50%" cy="50%" innerRadius={36} outerRadius={60} dataKey="value">
                          <Cell fill={"#26a69a"}/><Cell fill={"#ef5350"}/>
                        </Pie>
                        <Tooltip content={<Tip/>}/>
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{display:"flex",gap:12,justifyContent:"center",fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:10}}>
                      <span style={{color:"#26a69a"}}>■ Wins: {stats.wins}</span>
                      <span style={{color:"#ef5350"}}>■ Losses: {stats.losses}</span>
                    </div>
                    <div style={{background:"rgba(41,98,255,0.18)",borderRadius:4,padding:"7px 10px",fontSize:9,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center"}}>
                      {stats.winRate}% WR × 1:{stats.rr} R:R = profitable edge
                    </div>
                  </div>
                </div>

                {/* Profit / Quality / Streaks */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:10}}>
                  {[
                    {title:"Profit Breakdown",rows:[["Gross Profit","+$"+stats.grossProfit,"#26a69a"],["Gross Loss","-$"+stats.grossLoss,"#ef5350"],["Net P&L","$"+stats.totalProfit,stats.totalProfit>=0?"#26a69a":"#ef5350"]]},
                    {title:"Trade Quality",rows:[["Profit Factor",stats.pf>=99?"∞":stats.pf,"#f9a825"],["Expectancy","$"+stats.expectancy,stats.expectancy>=0?"#26a69a":"#ef5350"],["Risk:Reward","1:"+stats.rr,"#2962ff"]]},
                    {title:"Streaks",rows:[["Max Consec. Wins",stats.maxCW,"#26a69a"],["Max Consec. Loss",stats.maxCL,"#ef5350"],["Max Drawdown",stats.maxDD+"%",stats.maxDD>15?"#ef5350":"#7e57c2"]]},
                  ].map(({title,rows})=>(
                    <div key={title} style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"16px 18px"}}>
                      <div style={{fontSize:10,color:TH.textSub,textTransform:"uppercase",letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:12}}>{title}</div>
                      {rows.map(([l,v,c])=>(
                        <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:9,fontSize:11}}>
                          <span style={{color:TH.textSub}}>{l}</span>
                          <span style={{color:c,fontWeight:700,fontFamily:"'IBM Plex Sans',sans-serif"}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Hourly heatmap — redesigned */}
                {(()=>{
                  const hourData=Array.from({length:24},(_,h)=>{
                    const ht=trades.filter(t=>mt5Hour(t.openTime)===h);
                    const profit=ht.reduce((s,t)=>s+(t.profit||0),0);
                    const wins=ht.filter(t=>(t.profit||0)>0).length;
                    return {h,count:ht.length,profit:+profit.toFixed(2),wr:ht.length?Math.round(wins/ht.length*100):0};
                  });
                  const maxAbs=Math.max(...hourData.map(d=>Math.abs(d.profit)),1);
                  const fmtH=h=>h===0?"12AM":h<12?h+"AM":h===12?"12PM":(h-12)+"PM";
                  const fmtHShort=h=>h===0?"12a":h<12?h+"a":h===12?"12p":(h-12)+"p";
                  const sessionOf=h=>h<8?"asian":h<16?"london":"ny";
                  const sessionColor={asian:"#3b82f6",london:"#26a69a",ny:"#f59e0b"};
                  const sessionBg={asian:"rgba(59,130,246,0.05)",london:"rgba(22,163,74,0.05)",ny:"rgba(245,158,11,0.05)"};
                  const active=hourData.filter(d=>d.count>0);
                  const best=active.length?active.reduce((a,b)=>b.profit>a.profit?b:a):null;
                  const worst=active.length?active.reduce((a,b)=>b.profit<a.profit?b:a):null;
                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px",marginBottom:10}}>
                      {/* Header */}
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
                        <div>
                          <div style={{fontSize:11,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>Hourly Performance</div>
                          <div style={{fontSize:10,color:TH.textDim,marginTop:1}}>P&L by hour of day · {active.length} active hours</div>
                        </div>
                        <div style={{display:"flex",gap:10,fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                          {[["asian","#3b82f6","Asian"],["london","#26a69a","London"],["ny","#f59e0b","NY"]].map(([s,c,l])=>(
                            <div key={s} style={{display:"flex",alignItems:"center",gap:4}}>
                              <div style={{width:8,height:8,borderRadius:"50%",background:c}}/>
                              <span style={{color:TH.textSub}}>{l}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Bar chart */}
                      <div style={{position:"relative",paddingBottom:22}}>
                        {/* Session bg bands */}
                        <div style={{position:"absolute",left:0,right:0,top:0,bottom:22,display:"flex",borderRadius:4,overflow:"hidden",pointerEvents:"none"}}>
                          <div style={{flex:8,background:sessionBg.asian}}/>
                          <div style={{flex:8,background:sessionBg.london}}/>
                          <div style={{flex:8,background:sessionBg.ny}}/>
                        </div>
                        {/* Zero line */}
                        <div style={{position:"absolute",left:0,right:0,top:"50%",height:1,background:isDark?"#2a2e39":"#e0e3eb",zIndex:0}}/>

                        <div style={{display:"flex",gap:2,alignItems:"center",height:130,position:"relative",zIndex:1}}>
                          {hourData.map(d=>{
                            const pct=d.profit===0?0:Math.abs(d.profit)/maxAbs;
                            const barH=Math.max(pct*60,d.count>0?4:1);
                            const isPos=d.profit>=0;
                            const sess=sessionOf(d.h);
                            const sCol=sessionColor[sess];
                            const isBest=best&&d.h===best.h;
                            const isWorst=worst&&d.h===worst.h;
                            const barColor=d.count===0?"rgba(255,255,255,0.07)":isPos?"rgba(22,163,74,"+(0.3+pct*0.65)+")":"rgba(239,68,68,"+(0.3+pct*0.65)+")";
                            return (
                              <div key={d.h} title={d.count?fmtH(d.h)+": "+d.count+" trades · $"+(d.profit>0?"+":"")+d.profit+" · "+d.wr+"% WR":fmtH(d.h)+": no trades"}
                                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",cursor:d.count?"pointer":"default",position:"relative"}}>
                                {/* Top half — positive bars grow up */}
                                <div style={{flex:1,display:"flex",alignItems:"flex-end",width:"100%",paddingBottom:1}}>
                                  {isPos&&d.count>0&&<div style={{
                                    width:"100%",height:barH,
                                    background:barColor,
                                    borderRadius:"3px 3px 0 0",
                                    outline:isBest?"2px solid #26a69a":"none",
                                    outlineOffset:1,
                                    transition:"height 0.3s ease"
                                  }}/>}
                                </div>
                                {/* Bottom half — negative bars grow down */}
                                <div style={{flex:1,display:"flex",alignItems:"flex-start",width:"100%",paddingTop:1}}>
                                  {!isPos&&d.count>0&&<div style={{
                                    width:"100%",height:barH,
                                    background:barColor,
                                    borderRadius:"0 0 3px 3px",
                                    outline:isWorst?"2px solid #ef4444":"none",
                                    outlineOffset:1,
                                    transition:"height 0.3s ease"
                                  }}/>}
                                </div>
                                {/* Trade count dot */}
                                {d.count>0&&<div style={{
                                  position:"absolute",bottom:-14,left:"50%",transform:"translateX(-50%)",
                                  width:d.count>3?7:5,height:d.count>3?7:5,
                                  borderRadius:"50%",background:sCol,opacity:0.7
                                }}/>}
                                {/* Best/worst crown */}
                                {(isBest||isWorst)&&<div style={{position:"absolute",top:isWorst?null:2,bottom:isWorst?2:null,left:"50%",transform:"translateX(-50%)",fontSize:8}}>{isBest?"★":"▼"}</div>}
                              </div>
                            );
                          })}
                        </div>

                        {/* Hour labels */}
                        <div style={{display:"flex",gap:2,marginTop:4}}>
                          {hourData.map(d=>(
                            <div key={d.h} style={{flex:1,textAlign:"center",fontSize:6.5,
                              color:d.h%6===0?sessionColor[sessionOf(d.h)]:"transparent",
                              fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>
                              {d.h%6===0?fmtHShort(d.h):"·"}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Session summary strip */}
                      {active.length>0&&(()=>{
                        const sessSummary=[
                          {label:"Asian",hours:"00–08",color:"#3b82f6",bg:isDark?"rgba(59,130,246,0.08)":"#eff6ff"},
                          {label:"London",hours:"08–16",color:"#2962ff",bg:isDark?"rgba(41,98,255,0.08)":"#f0fdf4"},
                          {label:"New York",hours:"16–24",color:"#f59e0b",bg:isDark?"rgba(245,158,11,0.08)":"#fffbeb"},
                        ].map(({label,hours,color,bg},i)=>{
                          const start=i*8, end=start+8;
                          const sh=hourData.slice(start,end).filter(d=>d.count>0);
                          const total=sh.reduce((s,d)=>s+d.profit,0);
                          const trades=sh.reduce((s,d)=>s+d.count,0);
                          return {label,hours,color,bg,total:+total.toFixed(2),trades};
                        });
                        return (
                          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginTop:16}}>
                            {sessSummary.map(s=>(
                              <div key={s.label} style={{background:s.bg,borderRadius:4,padding:"10px 12px",border:"1px solid "+s.color+"22"}}>
                                <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
                                  <div style={{width:6,height:6,borderRadius:"50%",background:s.color}}/>
                                  <span style={{fontSize:9,fontWeight:700,color:s.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.label.toUpperCase()}</span>
                                  <span style={{fontSize:8,color:TH.textDim,marginLeft:"auto",fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.hours}</span>
                                </div>
                                <div style={{fontSize:14,fontWeight:800,color:s.total>=0?"#26a69a":"#ef4444",fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.total>=0?"+":""}{s.total}</div>
                                <div style={{fontSize:8,color:TH.textDim,marginTop:2}}>{s.trades} trade{s.trades!==1?"s":""}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                      {/* Best/worst callout */}
                      {best&&worst&&best.h!==worst.h&&(
                        <div style={{display:"flex",gap:8,marginTop:10}}>
                          <div style={{flex:1,background:"rgba(41,98,255,0.18)",borderRadius:4,padding:"8px 12px",border:"1px solid #bbf7d0",display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:14}}>★</span>
                            <div>
                              <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>BEST HOUR</div>
                              <div style={{fontSize:11,fontWeight:700,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif"}}>{fmtH(best.h)} &nbsp;+${best.profit}</div>
                            </div>
                            <div style={{marginLeft:"auto",fontSize:9,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif"}}>{best.wr}% WR</div>
                          </div>
                          <div style={{flex:1,background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"8px 12px",border:"1px solid #fecaca",display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:14}}>▼</span>
                            <div>
                              <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>WORST HOUR</div>
                              <div style={{fontSize:11,fontWeight:700,color:"#ef4444",fontFamily:"'IBM Plex Sans',sans-serif"}}>{fmtH(worst.h)} &nbsp;${worst.profit}</div>
                            </div>
                            <div style={{marginLeft:"auto",fontSize:9,color:"#ef4444",fontFamily:"'IBM Plex Sans',sans-serif"}}>{worst.wr}% WR</div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Daily P&L Heatmap */}
                {(()=>{
                  const dayPnl={};
                  trades.forEach(t=>{const d=mt5Day(t.openTime);if(d) dayPnl[d]=(dayPnl[d]||0)+(t.profit||0);});
                  const days=Object.keys(dayPnl).sort();
                  if(days.length<3) return null;
                  const maxA=Math.max(...Object.values(dayPnl).map(Math.abs),1);
                  const firstD=new Date(days[0]+"T00:00:00Z");
                  const endD=new Date(days[days.length-1]+"T00:00:00Z");
                  const startDow=(firstD.getUTCDay()+6)%7;
                  const weeks=[];
                  const cur=new Date(firstD);
                  cur.setUTCDate(cur.getUTCDate()-startDow);
                  while(cur<=endD&&weeks.length<26){
                    const wk=[];
                    for(let i=0;i<7;i++){
                      const ds=cur.toISOString().slice(0,10);
                      wk.push({date:ds,pnl:dayPnl[ds]!==undefined?+dayPnl[ds].toFixed(2):null});
                      cur.setUTCDate(cur.getUTCDate()+1);
                    }
                    weeks.push(wk);
                  }
                  const profDays=Object.values(dayPnl).filter(p=>p>0).length;
                  const lossDays=Object.values(dayPnl).filter(p=>p<=0).length;
                  const totalDays=profDays+lossDays;
                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px",marginBottom:16,overflowX:"auto"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                        <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif"}}>DAILY P&L HEATMAP</div>
                        <div style={{display:"flex",gap:6,alignItems:"center",fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                          <div style={{width:9,height:9,borderRadius:2,background:"rgba(220,38,38,0.6)"}}/>loss
                          <div style={{width:9,height:9,borderRadius:2,background:TH.inputBg}}/>flat
                          <div style={{width:9,height:9,borderRadius:2,background:"rgba(22,163,74,0.6)"}}/>profit
                        </div>
                      </div>
                      <div style={{display:"flex",gap:3}}>
                        <div style={{display:"flex",flexDirection:"column",gap:2,marginRight:2}}>
                          {"MTWTFSS".split("").map((d,i)=>(
                            <div key={i} style={{height:11,width:9,fontSize:7,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",display:"flex",alignItems:"center"}}>{d}</div>
                          ))}
                        </div>
                        {weeks.map((wk,wi)=>(
                          <div key={wi} style={{display:"flex",flexDirection:"column",gap:2}}>
                            {wk.map(day=>{
                              const pct=day.pnl===null?0:Math.abs(day.pnl)/maxA;
                              const bg=day.pnl===null?"#f8fafc":day.pnl>0?"rgba(22,163,74,"+(0.12+pct*0.75)+")":day.pnl<0?"rgba(220,38,38,"+(0.12+pct*0.75)+")":"#d1d4dc";
                              return (<div key={day.date} title={day.pnl!==null?day.date+": $"+(day.pnl>0?"+":"")+day.pnl:day.date}
                                style={{width:11,height:11,borderRadius:2,background:bg,border:"1px solid rgba(0,0,0,0.04)"}}/>);
                            })}
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:10,marginTop:10}}>
                        <div style={{flex:1,background:"rgba(41,98,255,0.18)",borderRadius:4,padding:"7px 10px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                          <span style={{color:TH.textDim}}>GREEN DAYS </span><span style={{color:"#26a69a",fontWeight:700}}>{profDays}/{totalDays} ({Math.round(profDays/totalDays*100)||0}%)</span>
                        </div>
                        <div style={{flex:1,background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"7px 10px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                          <span style={{color:TH.textDim}}>RED DAYS </span><span style={{color:"#ef5350",fontWeight:700}}>{lossDays}/{totalDays} ({Math.round(lossDays/totalDays*100)||0}%)</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Trade Duration Analysis */}
                {(()=>{
                  const withDur=trades.filter(t=>t.openTime&&t.closeTime).map(t=>{
                    const o=parseMT5Date(t.openTime),c=parseMT5Date(t.closeTime);
                    if(!o||!c) return null;
                    return {...t,durMins:Math.max(0,(c-o)/60000)};
                  }).filter(Boolean);
                  if(withDur.length<5) return null;
                  const wins=withDur.filter(t=>t.profit>0);
                  const losses=withDur.filter(t=>t.profit<0);
                  // cap at 24h to exclude bad/open trade data
                  const avgD=arr=>arr.length?Math.round(arr.filter(t=>t.durMins<=1440).reduce((s,t)=>s+t.durMins,0)/Math.max(1,arr.filter(t=>t.durMins<=1440).length)):0;
                  const fmtD=m=>m<60?m+"m":Math.round(m/60*10)/10+"h";
                  const wa=avgD(wins),la=avgD(losses);
                  const bkts=[{l:"<5m",min:0,max:5},{l:"5-15m",min:5,max:15},{l:"15-60m",min:15,max:60},{l:"1-4h",min:60,max:240},{l:"4h+",min:240,max:Infinity}];
                  const bData=bkts.map(b=>{
                    const inB=withDur.filter(t=>t.durMins>=b.min&&t.durMins<b.max);
                    const bW=inB.filter(t=>t.profit>0).length;
                    return {name:b.l,wins:bW,losses:inB.length-bW,wr:inB.length?Math.round(bW/inB.length*100):0};
                  });
                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px",marginBottom:10}}>
                      <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:14}}>TRADE DURATION ANALYSIS</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                        <div style={{background:"rgba(41,98,255,0.18)",borderRadius:4,padding:"10px 12px",textAlign:"center"}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:4}}>AVG WINNER</div>
                          <div style={{fontSize:18,fontWeight:700,color:"#26a69a",fontFamily:"'IBM Plex Sans',sans-serif"}}>{fmtD(wa)}</div>
                        </div>
                        <div style={{background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"10px 12px",textAlign:"center"}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:4}}>AVG LOSER</div>
                          <div style={{fontSize:18,fontWeight:700,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{fmtD(la)}</div>
                        </div>
                        <div style={{background:TH.inputBg,borderRadius:4,padding:"10px 12px",textAlign:"center"}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:4}}>PATTERN</div>
                          <div style={{fontSize:10,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.3}}>{wa<la?"cut losses sooner":"let winners run"}</div>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={80}>
                        <BarChart data={bData} barSize={16}>
                          <XAxis dataKey="name" tick={{fontSize:8,fontFamily:"'IBM Plex Sans',sans-serif",fill:"#94a3b8"}} axisLine={false} tickLine={false}/>
                          <YAxis hide/>
                          <Tooltip content={({active,payload,label})=>active&&payload?.length?<div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"8px 12px",fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif"}}><b>{label}</b><div style={{color:"#26a69a"}}>Wins: {payload[0]?.value}</div><div style={{color:"#ef5350"}}>Losses: {payload[1]?.value}</div><div style={{color:TH.textSub}}>{payload[0]?.payload?.wr}% WR</div></div>:null}/>
                          <Bar dataKey="wins" fill={"#26a69a"} radius={[3,3,0,0]}/>
                          <Bar dataKey="losses" fill={"#ef5350"} radius={[3,3,0,0]}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })()}

                {/* ── Equity Curve ── */}
                {stats.equity.length>1&&(()=>{
                  const data=stats.equity;
                  const start=data[0].bal,end=data[data.length-1].bal;
                  const gain=end-start, gainPct=((gain/start)*100).toFixed(1);
                  const isPos=gain>=0;
                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px",marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div>
                          <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif"}}>EQUITY CURVE</div>
                          <div style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:2}}>{data.length} trades · starting $10,000</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:18,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:isPos?"#26a69a":"#ef5350"}}>{isPos?"+":""}${gain.toFixed(2)}</div>
                          <div style={{fontSize:9,color:isPos?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{isPos?"+":""}{gainPct}% total return</div>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={100}>
                        <AreaChart data={data} margin={{top:4,right:4,bottom:0,left:0}}>
                          <defs>
                            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%"  stopColor={isPos?"#26a69a":"#ef5350"} stopOpacity={0.18}/>
                              <stop offset="95%" stopColor={isPos?"#26a69a":"#ef5350"} stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#d1d4dc" strokeDasharray="3 3" vertical={false}/>
                          <XAxis dataKey="n" tick={{fontSize:8,fontFamily:"'IBM Plex Sans',sans-serif",fill:"#94a3b8"}} axisLine={false} tickLine={false} interval={Math.floor(data.length/5)}/>
                          <YAxis tick={{fontSize:8,fontFamily:"'IBM Plex Sans',sans-serif",fill:"#94a3b8"}} axisLine={false} tickLine={false} tickFormatter={v=>"$"+v.toFixed(0)} width={52}/>
                          <Tooltip content={({active,payload})=>active&&payload?.length?<div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"8px 12px",fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif",boxShadow:"0 4px 12px rgba(0,0,0,0.1)"}}><div style={{color:TH.textDim,marginBottom:2}}>Trade #{payload[0].payload.n}</div><div style={{fontWeight:700,color:isPos?"#26a69a":"#ef5350"}}>${payload[0].value?.toFixed(2)}</div></div>:null}/>
                          <Area type="monotone" dataKey="bal" stroke={isPos?"#26a69a":"#ef5350"} strokeWidth={2} fill="url(#eqGrad)" dot={false} activeDot={{r:4,fill:isPos?"#26a69a":"#ef5350"}}/>
                        </AreaChart>
                      </ResponsiveContainer>
                      {/* Drawdown bar */}
                      <div style={{marginTop:10,display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0}}>MAX DD</span>
                        <div style={{flex:1,height:4,background:TH.inputBg,borderRadius:4,overflow:"hidden"}}>
                          <div style={{height:"100%",width:Math.min(stats.maxDD,100)+"%",background:stats.maxDD>20?"#ef5350":stats.maxDD>10?"#f59e0b":"#26a69a",borderRadius:4}}/>
                        </div>
                        <span style={{fontSize:9,fontWeight:700,color:stats.maxDD>20?"#ef5350":stats.maxDD>10?"#f59e0b":"#26a69a",fontFamily:"'IBM Plex Sans',sans-serif"}}>{stats.maxDD}%</span>
                      </div>
                    </div>
                  );
                })()}

                {/* ── Day of Week + Buy vs Sell ── */}
                {(()=>{
                  // Day of week P&L
                  const DAYS=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
                  const dayData=DAYS.map((d,i)=>{
                    const dt=trades.filter(t=>{const p=parseMT5Date(t.openTime);return p&&((p.getUTCDay()+6)%7)===i;});
                    const profit=dt.reduce((s,t)=>s+(t.profit||0),0);
                    const wins=dt.filter(t=>t.profit>0).length;
                    return {day:d,count:dt.length,profit:+profit.toFixed(2),wr:dt.length?Math.round(wins/dt.length*100):0};
                  });
                  const maxDayAbs=Math.max(...dayData.map(d=>Math.abs(d.profit)),1);
                  // Buy vs Sell
                  const buys=trades.filter(t=>(t.type||"").toString().toLowerCase().includes("buy")||t.type===0);
                  const sells=trades.filter(t=>(t.type||"").toString().toLowerCase().includes("sell")||t.type===1);
                  const bPnl=+buys.reduce((s,t)=>s+(t.profit||0),0).toFixed(2);
                  const sPnl=+sells.reduce((s,t)=>s+(t.profit||0),0).toFixed(2);
                  const bWR=buys.length?Math.round(buys.filter(t=>t.profit>0).length/buys.length*100):0;
                  const sWR=sells.length?Math.round(sells.filter(t=>t.profit>0).length/sells.length*100):0;
                  return (
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:10}}>
                      {/* Day of week */}
                      <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px"}}>
                        <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:14}}>DAY OF WEEK</div>
                        <div style={{display:"flex",gap:6,alignItems:"flex-end",height:80,marginBottom:8}}>
                          {dayData.map(d=>{
                            const h=d.count===0?0:Math.max(Math.abs(d.profit)/maxDayAbs*72,4);
                            const isPos=d.profit>=0;
                            return (
                              <div key={d.day} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%",gap:2}}
                                title={d.count>0?d.day+": "+d.count+"t $"+d.profit+" "+d.wr+"%WR":d.day+": no trades"}>
                                <div style={{width:"100%",height:h,background:d.count===0?"#d1d4dc":isPos?"rgba(22,163,74,"+(0.2+Math.abs(d.profit)/maxDayAbs*0.7)+")":"rgba(220,38,38,"+(0.2+Math.abs(d.profit)/maxDayAbs*0.7)+")",borderRadius:"3px 3px 0 0",transition:"height 0.4s ease"}}/>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          {dayData.map(d=>(
                            <div key={d.day} style={{flex:1,textAlign:"center"}}>
                              <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{d.day}</div>
                              {d.count>0&&<div style={{fontSize:7,color:d.profit>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,marginTop:1}}>{d.wr}%</div>}
                            </div>
                          ))}
                        </div>
                        {(()=>{
                          const best=dayData.filter(d=>d.count>0).reduce((a,b)=>b.profit>a.profit?b:a,{profit:-Infinity,day:"–"});
                          const worst=dayData.filter(d=>d.count>0).reduce((a,b)=>b.profit<a.profit?b:a,{profit:Infinity,day:"–"});
                          return <div style={{display:"flex",gap:8,marginTop:10}}>
                            <div style={{flex:1,background:"rgba(41,98,255,0.18)",borderRadius:7,padding:"6px 10px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                              <span style={{color:TH.textDim}}>BEST </span><span style={{color:"#26a69a",fontWeight:700}}>{best.day} +${best.profit>=0?best.profit.toFixed(0):"–"}</span>
                            </div>
                            <div style={{flex:1,background:"rgba(248,113,113,0.08)",borderRadius:7,padding:"6px 10px",fontSize:9,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                              <span style={{color:TH.textDim}}>WORST </span><span style={{color:"#ef5350",fontWeight:700}}>{worst.day} ${worst.profit<0?worst.profit.toFixed(0):"–"}</span>
                            </div>
                          </div>;
                        })()}
                      </div>

                      {/* Buy vs Sell */}
                      <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px"}}>
                        <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:10}}>BUY vs SELL</div>
                        {[
                          {label:"▲ BUY",count:buys.length,pnl:bPnl,wr:bWR,color:"#26a69a",bg:"#f0fdf4",border:"#bbf7d0"},
                          {label:"▼ SELL",count:sells.length,pnl:sPnl,wr:sWR,color:"#ef5350",bg:"#fef2f2",border:"#fecaca"},
                        ].map(s=>(
                          <div key={s.label} style={{background:s.bg,border:"1px solid "+s.border,borderRadius:4,padding:"14px 16px",marginBottom:10}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                              <span style={{fontSize:12,fontWeight:800,color:s.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.label}</span>
                              <span style={{fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.count} trades</span>
                            </div>
                            <div style={{display:"flex",gap:16}}>
                              <div>
                                <div style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:2}}>NET P&L</div>
                                <div style={{fontSize:16,fontWeight:700,color:s.pnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.pnl>=0?"+":""}${s.pnl}</div>
                              </div>
                              <div>
                                <div style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:2}}>WIN RATE</div>
                                <div style={{fontSize:16,fontWeight:700,color:s.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{s.wr}%</div>
                              </div>
                              <div style={{flex:1,display:"flex",alignItems:"flex-end"}}>
                                <div style={{width:"100%",height:4,background:"rgba(0,0,0,0.06)",borderRadius:4,overflow:"hidden"}}>
                                  <div style={{height:"100%",width:s.wr+"%",background:s.color,borderRadius:4}}/>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                        {buys.length>0&&sells.length>0&&(
                          <div style={{background:TH.inputBg,borderRadius:4,padding:"8px 12px",fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center"}}>
                            {bPnl>sPnl?"▲ BUY trades are more profitable":"▼ SELL trades are more profitable"}
                            {" · edge: "+(bWR>sWR?"better win rate going LONG":"better win rate going SHORT")}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Trading Scorecard ── */}
                {(()=>{
                  // Collect all graded trades
                  const graded = trades.filter(t => journals[t.ticket]?.execGrade);
                  if (graded.length === 0) return null;

                  // Grade distribution
                  const gradeDist = {A:0,B:0,C:0,D:0,F:0};
                  graded.forEach(t => { const g=journals[t.ticket].execGrade; if(gradeDist[g]!==undefined) gradeDist[g]++; });
                  const total = graded.length;

                  // P&L by grade
                  const gradeStats = Object.entries(gradeDist).map(([g,cnt])=>{
                    const ts = graded.filter(t=>journals[t.ticket].execGrade===g);
                    const pnl = +ts.reduce((s,t)=>s+(t.profit||0),0).toFixed(2);
                    const wins = ts.filter(t=>t.profit>0).length;
                    const wr = cnt ? Math.round(wins/cnt*100) : 0;
                    return {g, cnt, pnl, wr};
                  });

                  // Per-question pass rates
                  const qStats = GRADE_QUESTIONS.map(q=>{
                    const answered = graded.filter(t=>journals[t.ticket].tradeGrade?.[q.id]!==undefined);
                    const passed = answered.filter(t=>journals[t.ticket].tradeGrade[q.id]===true);
                    const passRate = answered.length ? Math.round(passed.length/answered.length*100) : null;
                    // P&L when rule followed vs broken
                    const followed = answered.filter(t=>journals[t.ticket].tradeGrade[q.id]===true);
                    const broken   = answered.filter(t=>journals[t.ticket].tradeGrade[q.id]===false);
                    const fPnl = followed.length ? +(followed.reduce((s,t)=>s+(t.profit||0),0)/followed.length).toFixed(2) : null;
                    const bPnl = broken.length   ? +(broken.reduce((s,t)=>s+(t.profit||0),0)/broken.length).toFixed(2)   : null;
                    return {...q, passRate, fPnl, bPnl, followedCnt: followed.length, brokenCnt: broken.length};
                  });

                  const gradeColors = {A:"#26a69a",B:"#26a69a",C:"#d97706",D:"#ea580c",F:"#ef5350"};
                  const avgGradeScore = graded.reduce((s,t)=>{
                    const g=journals[t.ticket].execGrade;
                    return s+({A:5,B:4,C:3,D:2,F:1}[g]||0);
                  },0) / graded.length;
                  const avgLetter = avgGradeScore>=4.5?"A":avgGradeScore>=3.5?"B":avgGradeScore>=2.5?"C":avgGradeScore>=1.5?"D":"F";

                  // Best and worst rule
                  const ruleSorted = qStats.filter(q=>q.passRate!==null).sort((a,b)=>b.passRate-a.passRate);
                  const bestRule = ruleSorted[0], worstRule = ruleSorted[ruleSorted.length-1];

                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,overflow:"hidden",marginBottom:10}}>
                      {/* Header */}
                      <div style={{background:isDark?"linear-gradient(135deg,#131722,#1a2540)":"linear-gradient(135deg,#1e222d,#2a3f8a)",padding:"16px 22px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1.5,marginBottom:4}}>EXECUTION SCORECARD</div>
                          <div style={{fontSize:13,fontWeight:700,fontFamily:"'IBM Plex Sans',sans-serif",color:"#fff",letterSpacing:0.5}}>{graded.length} trades graded</div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <div style={{width:48,height:48,borderRadius:4,background:gradeColors[avgLetter],display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,fontWeight:900,fontFamily:"'IBM Plex Sans',sans-serif",color:"#fff",boxShadow:"0 4px 16px "+gradeColors[avgLetter]+"55"}}>
                            {avgLetter}
                          </div>
                          <div style={{fontSize:7.5,color:"rgba(255,255,255,0.35)",fontFamily:"'IBM Plex Sans',sans-serif"}}>avg grade</div>
                        </div>
                      </div>

                      <div style={{padding:"12px 16px"}}>
                        {/* Grade distribution bars */}
                        <div style={{marginBottom:18}}>
                          <div style={{fontSize:9,color:TH.textSub,letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:10}}>GRADE DISTRIBUTION</div>
                          <div style={{display:"flex",gap:8}}>
                            {gradeStats.map(({g,cnt,pnl,wr})=>(
                              <div key={g} style={{flex:1,textAlign:"center"}}>
                                <div style={{position:"relative",height:60,marginBottom:5,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
                                  <div style={{width:"70%",background:gradeColors[g],borderRadius:"4px 4px 0 0",height:total?Math.max(cnt/total*56,cnt>0?4:0)+"px":"0",transition:"height 0.5s ease",opacity:0.85}}/>
                                </div>
                                <div style={{fontSize:14,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",color:gradeColors[g]}}>{g}</div>
                                <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{cnt}t</div>
                                {cnt>0&&<div style={{fontSize:7,color:pnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,marginTop:1}}>{pnl>=0?"+":""}${pnl}</div>}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Rule-by-rule breakdown */}
                        <div style={{marginBottom:10}}>
                          <div style={{fontSize:9,color:TH.textSub,letterSpacing:1.5,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:10}}>RULE COMPLIANCE</div>
                          <div style={{display:"flex",flexDirection:"column",gap:7}}>
                            {qStats.filter(q=>q.passRate!==null).map(q=>(
                              <div key={q.id}>
                                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                                  <span style={{fontSize:10,color:"rgba(241,245,249,0.92)",fontFamily:"'IBM Plex Sans',sans-serif",flex:1,paddingRight:12,lineHeight:1.3}}>{q.q}</span>
                                  <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                                    {q.fPnl!==null&&<span style={{fontSize:8,color:q.fPnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>✓{q.fPnl>=0?"+":""}${q.fPnl}</span>}
                                    {q.bPnl!==null&&<span style={{fontSize:8,color:q.bPnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>✗{q.bPnl>=0?"+":""}${q.bPnl}</span>}
                                    <span style={{fontSize:10,fontWeight:700,color:q.passRate>=70?"#26a69a":q.passRate>=50?"#d97706":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",minWidth:32,textAlign:"right"}}>{q.passRate}%</span>
                                  </div>
                                </div>
                                <div style={{height:5,background:TH.inputBg,borderRadius:4,overflow:"hidden"}}>
                                  <div style={{height:"100%",width:q.passRate+"%",background:q.passRate>=70?"#26a69a":q.passRate>=50?"#d97706":"#ef5350",borderRadius:4,transition:"width 0.5s ease"}}/>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Insight row */}
                        {bestRule&&worstRule&&(
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                            <div style={{background:"rgba(41,98,255,0.18)",borderRadius:4,padding:"12px 14px",border:"1px solid #bbf7d0"}}>
                              <div style={{fontSize:7.5,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5,fontWeight:700}}>💪 STRONGEST RULE</div>
                              <div style={{fontSize:10,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.4,fontWeight:500}}>{bestRule.q}</div>
                              <div style={{fontSize:9,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",marginTop:4,fontWeight:700}}>{bestRule.passRate}% pass rate</div>
                            </div>
                            <div style={{background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"12px 14px",border:"1px solid #fecaca"}}>
                              <div style={{fontSize:7.5,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5,fontWeight:700}}>⚠ WEAKEST RULE</div>
                              <div style={{fontSize:10,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.4,fontWeight:500}}>{worstRule.q}</div>
                              <div style={{fontSize:9,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",marginTop:4,fontWeight:700}}>{worstRule.passRate}% pass rate — fix this first</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Monthly P&L Calendar Heatmap ── */}
                {(()=>{
                  // Group trades by calendar day
                  const dayMap={};
                  trades.forEach(t=>{
                    const d=mt5Day(t.closeTime||t.openTime);
                    if(!d) return;
                    if(!dayMap[d]) dayMap[d]={profit:0,count:0};
                    dayMap[d].profit=+(dayMap[d].profit+(t.profit||0)).toFixed(2);
                    dayMap[d].count++;
                  });
                  const days=Object.keys(dayMap).sort();
                  if(days.length<3) return null;
                  // Build last 3 months
                  const now=new Date();
                  const months=[];
                  for(let m=2;m>=0;m--){
                    const d=new Date(now.getFullYear(),now.getMonth()-m,1);
                    months.push({yr:d.getFullYear(),mo:d.getMonth()});
                  }
                  const allProfits=Object.values(dayMap).map(d=>d.profit);
                  const maxAbs=Math.max(...allProfits.map(Math.abs),1);
                  const colorFor=p=>{
                    if(p===0) return "#d1d4dc";
                    const intensity=Math.min(Math.abs(p)/maxAbs,1);
                    if(p>0) return "rgba(22,163,74,"+(0.12+intensity*0.55)+")";
                    return "rgba(220,38,38,"+(0.12+intensity*0.55)+")";
                  };
                  const monthNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                  const totalPnl=Object.values(dayMap).reduce((s,d)=>s+d.profit,0);
                  const greenDays=Object.values(dayMap).filter(d=>d.profit>0).length;
                  const totalDays=Object.keys(dayMap).length;
                  return (
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"12px 16px",marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div>
                          <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif"}}>MONTHLY P&L HEATMAP</div>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:2}}>{greenDays}/{totalDays} green days · ${totalPnl.toFixed(2)} total</div>
                        </div>
                        <div style={{display:"flex",gap:6,fontSize:7,fontFamily:"'IBM Plex Sans',sans-serif",alignItems:"center"}}>
                          <div style={{width:8,height:8,borderRadius:2,background:"rgba(220,38,38,0.5)"}}/>loss
                          <div style={{width:8,height:8,borderRadius:2,background:TH.inputBg}}/>flat
                          <div style={{width:8,height:8,borderRadius:2,background:"rgba(22,163,74,0.5)"}}/>profit
                        </div>
                      </div>
                      <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                        {months.map(({yr,mo})=>{
                          const mStr=monthNames[mo]+" "+yr;
                          const dim=new Date(yr,mo+1,0).getDate();
                          const firstDow=(new Date(yr,mo,1).getDay()+6)%7;
                          const cells=[];
                          for(let i=0;i<firstDow;i++) cells.push(null);
                          for(let d=1;d<=dim;d++) cells.push(d);
                          const mPnl=Array.from({length:dim},(_,i)=>{
                            const ds=yr+"-"+String(mo+1).padStart(2,"0")+"-"+String(i+1).padStart(2,"0");
                            return dayMap[ds]?.profit||0;
                          }).reduce((s,v)=>s+v,0);
                          return (
                            <div key={mStr} style={{flex:"1 1 180px"}}>
                              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                                <span style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>{mStr}</span>
                                <span style={{fontSize:9,fontWeight:700,color:mPnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{mPnl>=0?"+":""}${mPnl.toFixed(0)}</span>
                              </div>
                              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
                                {["M","T","W","T","F","S","S"].map((d,i)=><div key={i} style={{fontSize:6,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center"}}>{d}</div>)}
                                {cells.map((day,idx)=>{
                                  if(!day) return <div key={idx}/>;
                                  const ds=yr+"-"+String(mo+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
                                  const info=dayMap[ds];
                                  return (
                                    <div key={idx} title={info?ds+": "+info.count+"t $"+info.profit.toFixed(2):""}
                                      style={{aspectRatio:"1",borderRadius:2,background:info?colorFor(info.profit):"#f8fafc",border:"1px solid rgba(0,0,0,0.04)",cursor:info?"pointer":"default"}}/>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Weekly AI Coach removed here — now shown in Dashboard top row */}
            </div>
          )}

          {/* ══ CALENDAR + JOURNAL ══ */}
          {tab==="calendar"&&(
            <div style={{animation:"slideIn 0.3s ease"}}>
              {/* ── Top: calendar header + nav ── */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:4}}>Calendar & Journal</div>
                  <div style={{fontSize:13,fontWeight:600,color:isDark?"#d1d4dc":"#131722"}}>Calendar & Journal</div>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <button onClick={()=>{const d=new Date(calMonth);d.setMonth(d.getMonth()-1);setCalMonth(d);setCalSel(null);setCalDayEv([]);}} style={{background:"rgba(41,98,255,0.18)",border:"1px solid #cbd5e1",borderRadius:3,padding:"5px 11px",color:"#2962ff",fontSize:13,cursor:"pointer"}}>◀</button>
                  <div style={{fontSize:11,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2,minWidth:140,textAlign:"center"}}>{calMonth.toLocaleString("default",{month:"short",year:"numeric"}).toUpperCase()}</div>
                  <button onClick={()=>{const d=new Date(calMonth);d.setMonth(d.getMonth()+1);setCalMonth(d);setCalSel(null);setCalDayEv([]);}} style={{background:"rgba(41,98,255,0.18)",border:"1px solid #cbd5e1",borderRadius:3,padding:"5px 11px",color:"#2962ff",fontSize:13,cursor:"pointer"}}>▶</button>
                  <button onClick={()=>{setCalMonth(new Date());setCalSel(null);setCalDayEv([]);}} style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:3,padding:"5px 9px",color:TH.textSub,fontSize:9,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>TODAY</button>
                </div>
              </div>

              {/* ── Main 3-col layout: [calendar grid] [day events + trades] [journal form] ── */}
              <div style={{display:"grid",gridTemplateColumns:calSel?"320px 1fr 360px":"320px 1fr",gap:14,alignItems:"start"}}>

                {/* COL 1: Month grid (always visible) */}
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:2}}>
                    {["M","T","W","T","F","S","S"].map((d,i)=>(
                      <div key={i} style={{textAlign:"center",fontSize:9,color:i>=5?"#cbd5e1":"#94a3b8",fontFamily:"'IBM Plex Sans',sans-serif",padding:"3px 0"}}>{d}</div>
                    ))}
                  </div>
                  <CalMonthGrid month={calMonth} selected={calSel} onSelect={dateStr=>{
                    if(calSel===dateStr){setCalSel(null);setCalDayEv([]);setSel(null);return;}
                    setCalSel(dateStr);setSel(null);setJForm({notes:"",emotion:"😐 Neutral",rating:3,tags:"",setup:"",postReview:"",screenshot:null});
                    setCalDayLd(true);setCalDayEv([]);
                    fetch(SERVER+"/api/calendar?date="+dateStr,{signal:AbortSignal.timeout(15000)})
                      .then(r=>r.json()).then(data=>{setCalDayEv(data.events||[]);}).catch(()=>setCalDayEv([])).finally(()=>setCalDayLd(false));
                  }}/>
                  {/* Journaling legend */}
                  <div style={{marginTop:10,fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.8}}>
                    <div>↑ Click any date to see</div>
                    <div style={{color:"#2962ff"}}>● Economic events</div>
                    <div style={{color:"#3d8eff"}}>● Your trades for that day</div>
                    <div>✦ = journaled trade</div>
                  </div>
                </div>

                {/* COL 2: Day panel — economic events + that day's trades */}
                {calSel&&(
                  <div style={{animation:"slideIn 0.2s ease",minWidth:0}}>
                    {/* Day header */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:13,fontWeight:700,color:TH.text,letterSpacing:1}}>
                        {new Date(calSel.replace(/\./g,"-")+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",day:"numeric",month:"long"}).toUpperCase()}
                      </div>
                      <button onClick={()=>{setCalSel(null);setCalDayEv([]);setSel(null);}} style={{background:"none",border:"none",color:TH.textDim,fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
                    </div>

                    {/* Economic events section */}
                    <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:6,overflow:"hidden",marginBottom:12}}>
                      <div style={{padding:"8px 14px",borderBottom:"1px solid rgba(255,255,255,0.05)",display:"flex",justifyContent:"space-between",alignItems:"center",background:TH.inputBg}}>
                        <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2}}>ECONOMIC EVENTS</div>
                        {calDayLd&&<div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",animation:"pulse 1s infinite"}}>LOADING...</div>}
                        {!calDayLd&&calDayEv.length>0&&<div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{calDayEv.length} events</div>}
                      </div>
                      {!calDayLd&&calDayEv.length===0&&(
                        <div style={{padding:"14px",textAlign:"center",fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>No events found</div>
                      )}
                      {!calDayLd&&calDayEv.length>0&&(
                        <div>
                          <div style={{display:"grid",gridTemplateColumns:"44px 50px 20px 1fr 60px 60px",gap:0,padding:"6px 12px",background:TH.inputBg,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                            {["TIME","CUR","","EVENT","ACT","FCST"].map(h=>(
                              <div key={h} style={{fontSize:8,color:TH.textDim,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif"}}>{h}</div>
                            ))}
                          </div>
                          {calDayEv.slice(0,12).map((e,i)=>{
                            const imp=e.impact||"";
                            const isH=imp==="high",isM=imp==="medium"||imp==="moderate";
                            const cur=e.currency||"—";
                            const ts2=e.date?new Date(e.date).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"—";
                            const beat=e.actual!=null&&e.forecast!=null&&parseFloat(e.actual)>=parseFloat(e.forecast);
                            return (
                              <div key={i} style={{display:"grid",gridTemplateColumns:"44px 50px 20px 1fr 60px 60px",gap:0,padding:"7px 12px",borderBottom:"1px solid rgba(0,0,0,0.03)",background:isH?"rgba(220,38,38,0.03)":isM?"rgba(234,88,12,0.02)":"transparent"}}>
                                <div style={{fontSize:9,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif"}}>{ts2}</div>
                                <div style={{fontSize:10,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif"}}>{cur}</div>
                                <div style={{fontSize:10}}>{isH?"🔴":isM?"🟠":"🟡"}</div>
                                <div style={{fontSize:10,color:"rgba(241,245,249,0.75)",lineHeight:1.3,paddingRight:6}}>{e.name||"—"}</div>
                                <div style={{fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif",color:e.actual!=null?(beat?"#26a69a":"#ef5350"):"#94a3b8",fontWeight:e.actual!=null?700:400}}>{e.actual??"-"}</div>
                                <div style={{fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif",color:TH.textDim}}>{e.forecast??"-"}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {!calDayLd&&calDayEv.length>0&&(
                        <div style={{padding:"5px 12px",fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",background:TH.inputBg,borderTop:"1px solid #d1d4dc"}}>
                          {calDayEv[0]?.source==="AI"?"⚡ AI GENERATED":calDayEv[0]?.source==="forexfactory"?"● FOREXFACTORY":"● LIVE DATA"}
                        </div>
                      )}
                    </div>

                    {/* That day's trades section */}
                    {(()=>{
                      const dayTrades = trades.filter(t=>mt5Day(t.openTime)===calSel);
                      const dayPnl = dayTrades.reduce((s,t)=>s+(t.profit||0),0);
                      return (
                        <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:6,overflow:"hidden"}}>
                          <div style={{padding:"8px 14px",borderBottom:"1px solid rgba(255,255,255,0.05)",display:"flex",justifyContent:"space-between",alignItems:"center",background:TH.inputBg}}>
                            <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2}}>YOUR TRADES</div>
                            {dayTrades.length>0&&(
                              <div style={{display:"flex",gap:12,alignItems:"center"}}>
                                <span style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{dayTrades.length} trades</span>
                                <span style={{fontSize:11,fontWeight:700,color:dayPnl>=0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{dayPnl>=0?"+":""}${dayPnl.toFixed(2)}</span>
                              </div>
                            )}
                          </div>
                          {dayTrades.length===0?(
                            <div style={{padding:"20px",textAlign:"center",fontSize:10,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>No trades on this day</div>
                          ):(
                            dayTrades.sort((a,b)=>(parseMT5Date(a.openTime)||0)-(parseMT5Date(b.openTime)||0)).map((t,i)=>{
                              const isSelected = selectedTrade?.ticket===t.ticket;
                              const hasJournal = !!journals[t.ticket];
                              return (
                                <div key={t.ticket||i} onClick={()=>{setSel(t);setJForm(journals[t.ticket]||{notes:"",emotion:"😐 Neutral",rating:3,tags:"",setup:"",postReview:"",screenshot:null}); }}
                                  className="rh"
                                  style={{display:"grid",gridTemplateColumns:"80px 44px 62px 62px 40px 1fr 60px 22px",gap:0,padding:"9px 14px",borderBottom:"1px solid rgba(0,0,0,0.04)",cursor:"pointer",background:isSelected?"rgba(22,163,74,0.06)":"transparent",transition:"background 0.1s"}}>
                                  <div style={{fontSize:12,fontWeight:700,color:isSelected?"#26a69a":"#131722",fontFamily:"'IBM Plex Sans',sans-serif"}}>{t.symbol}</div>
                                  <div style={{fontSize:10,color:t.type==="buy"?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,textTransform:"uppercase"}}>{t.type}</div>
                                  <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{typeof t.openPrice==="number"?t.openPrice.toFixed(4):"-"}</div>
                                  <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{typeof t.closePrice==="number"?t.closePrice.toFixed(4):"-"}</div>
                                  <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{t.lots||"-"}L</div>
                                  <div style={{fontSize:12,fontWeight:700,color:t.profit>0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"right",paddingRight:4}}>{t.profit>0?"+":""}${(t.profit||0).toFixed(2)}</div>
                                  <div style={{display:"flex",alignItems:"center",gap:4,paddingRight:4}}>
                                    <button onClick={e=>{e.stopPropagation();setReplayTrade(t);}} title="Replay trade" style={{background:"rgba(37,99,235,0.08)",border:"none",borderRadius:5,padding:"3px 6px",cursor:"pointer",fontSize:9,color:"#3d8eff"}}>▶</button>
                                    <button onClick={e=>{e.stopPropagation();setTagModal(t);}} title="Grade trade" style={{background:journals[t.ticket]?.execGrade?"rgba(37,99,235,0.1)":"rgba(0,0,0,0.04)",border:"none",borderRadius:5,padding:"3px 6px",cursor:"pointer",fontSize:10,fontWeight:700,color:{"A":"#26a69a","B":"#26a69a","C":"#d97706","D":"#ea580c","F":"#ef5350"}[journals[t.ticket]?.execGrade]||"#94a3b8",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                                      {journals[t.ticket]?.execGrade||"✎"}
                                    </button>
                                  </div>
                                  <div style={{fontSize:11,color:hasJournal?"#26a69a":"#cbd5e1",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                                    {hasJournal?"✦":"·"}
                                    {journals[t.ticket]?.screenshot&&<span style={{fontSize:7,lineHeight:1}}>📸</span>}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* COL 3: Journal form — only shows when a trade is selected */}
                {calSel&&selectedTrade&&(()=>{
                  const t=selectedTrade;
                  const tradeDay=mt5Day(t.openTime);
                  // Only show journal form if selected trade is from this calendar day
                  if(tradeDay!==calSel) return null;
                  return (
                    <div style={{position:"sticky",top:16,animation:"slideIn 0.2s ease"}}>
                      <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"18px",boxShadow:"0 2px 12px rgba(15,23,42,0.08)"}}>
                        {/* Trade summary */}
                        <div style={{marginBottom:14,padding:"10px 12px",background:"rgba(41,98,255,0.18)",borderRadius:4,border:"1px solid #dcfce7"}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                            <span style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:14,fontWeight:700,color:TH.text}}>{t.symbol}</span>
                            <span style={{fontSize:13,color:t.profit>0?"#26a69a":"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>{t.profit>0?"+":""}${(t.profit||0).toFixed(2)}</span>
                          </div>
                          <div style={{display:"flex",gap:8,fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                            <span style={{color:t.type==="buy"?"#26a69a":"#ef5350",fontWeight:600,textTransform:"uppercase"}}>{t.type}</span>
                            <span>{String(t.openTime||"").slice(0,16)}</span>
                          </div>
                        </div>

                        {/* Emotion buttons */}
                        <div style={{marginBottom:11}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5}}>EMOTION</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                            {["😐 Neutral","😊 Confident","😰 Anxious","😤 Frustrated","🎯 Focused","😴 Tired"].map(o=>(
                              <button key={o} onClick={()=>setJForm(p=>({...p,emotion:o}))}
                                style={{background:jForm.emotion===o?"#dcfce7":"#f8fafc",border:"1px solid "+(jForm.emotion===o?"#26a69a":"#d1d4dc"),borderRadius:20,padding:"4px 9px",fontSize:9,cursor:"pointer",color:jForm.emotion===o?"#26a69a":"#475569"}}>
                                {o}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Star rating */}
                        <div style={{marginBottom:11}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:4}}>RATING</div>
                          <div style={{display:"flex",gap:2}}>
                            {[1,2,3,4,5].map(n=>(
                              <button key={n} onClick={()=>setJForm(p=>({...p,rating:String(n)}))}
                                style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:parseInt(jForm.rating)>=n?"#d97706":"#d1d4dc",padding:"0 1px"}}>★</button>
                            ))}
                          </div>
                        </div>

                        {/* Text fields */}
                        {[["SETUP","setup",2,"Describe setup..."],["TAGS","tags",1,"breakout, trend..."],["POST-REVIEW","postReview",2,"What went right/wrong?"],["NOTES","notes",2,"Additional notes..."]].map(([lbl,field,rows,ph])=>(
                          <div key={field} style={{marginBottom:9}}>
                            <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:3}}>{lbl}</div>
                            <textarea value={jForm[field]||""} onChange={e=>setJForm(p=>({...p,[field]:e.target.value}))}
                              rows={rows} placeholder={ph}
                              style={{width:"100%",background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:6,padding:"7px 10px",color:TH.text,fontSize:11,resize:"vertical",outline:"none",fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.5,boxSizing:"border-box"}}/>
                          </div>
                        ))}

                        {/* Screenshot upload */}
                        <div style={{marginBottom:11}}>
                          <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:5}}>SCREENSHOT</div>
                          {jForm.screenshot?(
                            <div style={{position:"relative"}}>
                              <img src={jForm.screenshot} alt="chart screenshot"
                                style={{width:"100%",borderRadius:7,border:"1px solid "+TH.border,display:"block",maxHeight:180,objectFit:"cover",cursor:"pointer"}}
                                onClick={()=>setScreenshotZoom(jForm.screenshot)}/>
                              <button onClick={()=>setJForm(p=>({...p,screenshot:null}))}
                                style={{position:"absolute",top:5,right:5,background:"rgba(220,38,38,0.85)",border:"none",borderRadius:"50%",width:22,height:22,color:"#fff",fontSize:12,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                              <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:3,textAlign:"center"}}>tap image to zoom</div>
                            </div>
                          ):(
                            <label style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5,padding:"16px",border:"2px dashed #e2e8f0",borderRadius:4,cursor:"pointer",background:TH.inputBg,transition:"border-color 0.15s"}}
                              onMouseEnter={e=>e.currentTarget.style.borderColor="#86efac"}
                              onMouseLeave={e=>e.currentTarget.style.borderColor="#d1d4dc"}>
                              <div style={{fontSize:22,lineHeight:1}}>📸</div>
                              <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>TAP TO UPLOAD</div>
                              <div style={{fontSize:8,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif"}}>PNG, JPG or screenshot</div>
                              <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                                const file=e.target.files?.[0];
                                if(!file) return;
                                if(file.size>2*1024*1024){alert("Image too large — max 2MB");return;}
                                const reader=new FileReader();
                                reader.onload=ev=>setJForm(p=>({...p,screenshot:ev.target.result}));
                                reader.readAsDataURL(file);
                                e.target.value="";
                              }}/>
                            </label>
                          )}
                        </div>

                        <button onClick={saveJournal}
                          style={{width:"100%",background:"#26a69a",border:"none",borderRadius:7,padding:"10px",color:"#fff",fontSize:10,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2,fontWeight:700}}>
                          ✦ SAVE ENTRY
                        </button>
                      </div>
                    </div>
                  );
                })()}

              </div>
            </div>
          )}

          {/* ══ EA SETUP ══ */}
          {/* ══ NEWS ══ */}
          {tab==="news"&&(
            <div style={{animation:"slideIn 0.3s ease"}}>
              {/* ── Header ── */}
              <div style={{marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                <div>
                  <div style={{fontSize:11,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600}}>Archive</div>
                  <div style={{fontSize:13,fontWeight:600,color:isDark?"#d1d4dc":"#131722"}}>Market News</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{savedNews.length} articles · 48h archive</div>
                  <button onClick={()=>{setSavedNews([]);try{localStorage.removeItem("tl_saved_news");}catch{}}}
                    style={{background:"rgba(248,113,113,0.08)",border:"1px solid rgba(252,129,129,0.3)",borderRadius:6,padding:"6px 12px",color:"#ef5350",fontSize:9,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                    CLEAR ALL
                  </button>
                  <button onClick={fetchNews} disabled={newsLd}
                    style={{background:"rgba(41,98,255,0.12)",border:"1px solid rgba(41,98,255,0.3)",borderRadius:6,padding:"6px 12px",color:"#2962ff",fontSize:9,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                    {newsLd?"⏳":"↻"} FETCH LATEST
                  </button>
                </div>
              </div>

              {/* ── MARKET PULSE — local category analysis ── */}
              {savedNews.length>0&&briefing?.sections?.length>0&&(
                <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"16px 18px",marginBottom:16,boxShadow:isDark?"0 4px 24px rgba(0,0,0,0.2)":"0 4px 20px rgba(41,98,255,0.08)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <div style={{width:26,height:26,borderRadius:4,background:"linear-gradient(135deg,rgba(41,98,255,0.2),rgba(41,98,255,0.15))",border:"1px solid rgba(41,98,255,0.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>📡</div>
                      <div>
                        <div style={{fontSize:11,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif"}}>Market Pulse</div>
                        <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{savedNews.length} articles analysed · {briefing.generatedAt?Math.floor((Date.now()-new Date(briefing.generatedAt).getTime())/60000)+"m ago":"just now"}</div>
                      </div>
                    </div>
                    <div style={{background:briefing.sentiment==="bullish"?"rgba(52,211,153,0.12)":briefing.sentiment==="bearish"?"rgba(252,129,129,0.12)":"rgba(148,163,184,0.1)",border:"1px solid "+(briefing.sentiment==="bullish"?"rgba(52,211,153,0.35)":briefing.sentiment==="bearish"?"rgba(252,129,129,0.35)":"rgba(148,163,184,0.25)"),borderRadius:99,padding:"4px 14px",fontSize:9,fontWeight:700,fontFamily:"'IBM Plex Sans',sans-serif",color:briefing.sentiment==="bullish"?"#26a69a":briefing.sentiment==="bearish"?"#ef5350":"#94a3b8"}}>
                      {briefing.sentiment==="bullish"?"▲ RISK-ON":briefing.sentiment==="bearish"?"▼ RISK-OFF":"➡ NEUTRAL"}
                    </div>
                  </div>
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:4}}>
                      <span style={{color:"#26a69a"}}>▲ {briefing.bull} bullish signals</span>
                      <span style={{color:"#ef5350"}}>{briefing.bear} bearish signals ▼</span>
                    </div>
                    <div style={{height:5,background:TH.inputBg,borderRadius:3,overflow:"hidden",display:"flex"}}>
                      <div style={{width:((briefing.bull||0)/((briefing.bull||0)+(briefing.bear||0)+0.01)*100)+"%",background:"linear-gradient(90deg,#26a69a,#26a69a)",borderRadius:"3px 0 0 3px",transition:"width 0.5s"}}/>
                      <div style={{flex:1,background:"linear-gradient(90deg,#ef5350,#ef5350)",borderRadius:"0 3px 3px 0"}}/>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    {briefing.sections.map((s,i)=>{
                      const catColors=["#2962ff","#26a69a","#fbbf24","#f472b6","#60a5fa","#2962ff"];
                      const col=catColors[i%catColors.length];
                      return (
                        <div key={i} style={{background:TH.inputBg,borderRadius:9,padding:"10px 12px",borderLeft:"3px solid "+col}}>
                          <div style={{fontSize:8,fontWeight:700,color:col,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5,marginBottom:4}}>{s.cat}</div>
                          <div style={{fontSize:16,fontWeight:800,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1,marginBottom:4}}>{s.count}</div>
                          {s.headlines?.[0]&&<div style={{fontSize:8.5,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.4,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{s.headlines[0]}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── MARKET SEARCH ── */}
              <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"18px 20px",marginBottom:20,
                boxShadow:isDark?"0 4px 24px rgba(0,0,0,0.2)":"0 4px 20px rgba(41,98,255,0.08)"}}>
                <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                  <div style={{width:26,height:26,borderRadius:4,
                    background:isDark?"rgba(41,98,255,0.18)":"rgba(41,98,255,0.1)",
                    border:"1px solid rgba(41,98,255,0.25)",
                    display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>🔍</div>
                  <div>
                    <div style={{fontSize:10,fontWeight:800,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1}}>MARKET SEARCH</div>
                    <div style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>Search any pair or asset for live news + AI briefing</div>
                  </div>
                </div>

                {/* Quick chips */}
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12,marginTop:10}}>
                  {["Gold","Bitcoin","EURUSD","GBPUSD","Oil","Nasdaq","DXY","Fed"].map(chip=>(
                    <button key={chip} onClick={()=>{setSearchQuery(chip);fetchMarketSearch(chip);}}
                      style={{background:isDark?"rgba(41,98,255,0.1)":"rgba(41,98,255,0.07)",
                        border:"1px solid rgba(41,98,255,0.2)",borderRadius:99,
                        padding:"3px 10px",fontSize:8,color:"#2962ff",cursor:"pointer",
                        fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,
                        transition:"all 0.15s"}}>
                      {chip}
                    </button>
                  ))}
                </div>

                {/* Search input */}
                <div style={{display:"flex",gap:8}}>
                  <input
                    value={searchQuery}
                    onChange={e=>setSearchQuery(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter"&&searchQuery.trim())fetchMarketSearch();}}
                    placeholder="e.g. Gold, EURUSD, Bitcoin, Oil, Fed..."
                    style={{flex:1,background:TH.inputBg,border:"1px solid "+TH.border,
                      borderRadius:4,padding:"9px 14px",color:TH.text,fontSize:12,
                      fontFamily:"'IBM Plex Sans',sans-serif",outline:"none"}}/>
                  <button onClick={()=>searchQuery.trim()&&fetchMarketSearch()} disabled={searchLd}
                    style={{background:searchLd?TH.inputBg:"linear-gradient(135deg,#2962ff,#1e53e5)",
                      border:searchLd?"1px solid "+TH.border:"none",
                      borderRadius:4,padding:"9px 18px",color:searchLd?TH.textDim:"#fff",
                      fontSize:11,fontWeight:700,cursor:searchLd?"not-allowed":"pointer",
                      fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.3,transition:"all 0.2s",
                      minWidth:80,opacity:searchLd?0.6:1}}>
                    {searchLd?"SEARCHING…":"SEARCH"}
                  </button>
                </div>

                {/* Error */}
                {searchErr&&<div style={{marginTop:10,fontSize:10,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>{searchErr}</div>}

                {/* Loading spinner */}
                {searchLd&&(
                  <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,padding:"8px 0"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#2962ff",animation:"pulse 0.8s infinite"}}/>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#2962ff",animation:"pulse 0.8s 0.15s infinite"}}/>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#2962ff",animation:"pulse 0.8s 0.3s infinite"}}/>
                    <span style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginLeft:4}}>
                      Fetching live news + generating AI briefing…
                    </span>
                  </div>
                )}

                {/* Results */}
                {searchResults&&!searchLd&&(
                  <div style={{marginTop:14}}>
                    {/* AI Summary */}
                    {searchResults.aiSummary&&(
                      <div style={{background:isDark?"rgba(41,98,255,0.08)":"rgba(41,98,255,0.05)",
                        border:"1px solid rgba(41,98,255,0.2)",borderRadius:4,
                        padding:"12px 16px",marginBottom:14}}>
                        <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8}}>
                          <span style={{fontSize:12}}>✦</span>
                          <span style={{fontSize:8,color:"#2962ff",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,letterSpacing:1}}>
                            AI BRIEFING · {searchResults.query.toUpperCase()}
                          </span>
                          <span style={{fontSize:7,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginLeft:"auto"}}>
                            {new Date(searchResults.generatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                          </span>
                        </div>
                        <div style={{fontSize:12,color:TH.text,lineHeight:1.6,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                          {searchResults.aiSummary}
                        </div>
                      </div>
                    )}

                    {/* Article list */}
                    <div style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1,marginBottom:8}}>
                      {searchResults.articles.length} RELATED ARTICLES
                    </div>
                    {searchResults.articles.length===0?(
                      <div style={{textAlign:"center",padding:"16px 0",color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",fontSize:10}}>
                        No articles found for "{searchResults.query}" — try a different term
                      </div>
                    ):(
                      searchResults.articles.map((a,i)=>{
                        const d = a.pubDate?new Date(a.pubDate):null;
                        const minsAgo = d?Math.floor((Date.now()-d)/60000):null;
                        const age = minsAgo===null?"":minsAgo<2?"LIVE":minsAgo<60?minsAgo+"m ago":Math.floor(minsAgo/60)+"h ago";
                        const srcColor={"Yahoo Finance":"#7c3aed","ForexLive":"#2563eb"}[a.source]||"#787b86";
                        return (
                          <div key={i} onClick={()=>openArticle(a)}
                            style={{background:TH.cardHover,border:"1px solid "+TH.border,borderRadius:9,
                              padding:"11px 14px",marginBottom:7,cursor:"pointer",transition:"all 0.15s"}}
                            onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(41,98,255,0.4)";e.currentTarget.style.transform="translateY(-1px)";}}
                            onMouseLeave={e=>{e.currentTarget.style.borderColor=TH.border;e.currentTarget.style.transform="none";}}>
                            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:5}}>
                              <span style={{background:TH.inputBg,border:"1px solid "+srcColor+"33",borderRadius:4,
                                padding:"1px 7px",fontSize:8,color:srcColor,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>
                                {a.source}
                              </span>
                              {age&&<span style={{fontSize:7.5,color:minsAgo<10?"#26a69a":TH.textDim,
                                fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:minsAgo<10?700:400}}>{age}</span>}
                            </div>
                            <div style={{fontSize:12,fontWeight:600,color:TH.text,lineHeight:1.45,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:3}}>
                              {a.title}
                            </div>
                            {a.description&&<div style={{fontSize:10,color:TH.textSub,lineHeight:1.5}}>
                              {a.description.slice(0,150)}{a.description.length>150?"…":""}
                            </div>}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {savedNews.length===0?(
                <div style={{textAlign:"center",padding:"60px 0",color:TH.textDim}}>
                  <div style={{fontSize:40,marginBottom:12}}>📰</div>
                  <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontSize:11}}>No saved articles yet</div>
                  <div style={{fontSize:10,marginTop:6,color:"rgba(255,255,255,0.2)"}}>Articles auto-save as news loads and stay for 48 hours</div>
                </div>
              ):(()=>{
                // Group by date
                const cutoff = Date.now() - 48*60*60*1000;
                const valid = savedNews.filter(a=>new Date(a.savedAt||a.pubDate||0).getTime()>cutoff);
                const groups = {};
                valid.forEach(a=>{
                  const d = new Date(a.savedAt||a.pubDate||Date.now());
                  const key = d.toDateString();
                  if(!groups[key]) groups[key]=[];
                  groups[key].push(a);
                });
                const sortedKeys = Object.keys(groups).sort((a,b)=>new Date(b)-new Date(a));
                return sortedKeys.map(dateKey=>{
                  const articles = groups[dateKey];
                  const isToday = dateKey===new Date().toDateString();
                  const isYest  = dateKey===new Date(Date.now()-86400000).toDateString();
                  const label   = isToday?"Today":isYest?"Yesterday":dateKey;
                  return (
                    <div key={dateKey} style={{marginBottom:14}}>
                      {/* Date group header */}
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                        <div style={{fontSize:10,fontWeight:700,color:isToday?"#2563eb":"#787b86",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:1}}>{label.toUpperCase()}</div>
                        <div style={{flex:1,height:1,background:isDark?"#2a2e39":"#e0e3eb"}}/>
                        <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{articles.length} articles</div>
                      </div>
                      {/* Article cards */}
                      {articles.map((a,i)=>{
                        const d = a.pubDate?new Date(a.pubDate):null;
                        const timeStr = d?d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";
                        const minsAgo = d?Math.floor((Date.now()-d)/60000):null;
                        const isNew = minsAgo!==null&&minsAgo<30;
                        const srcColor={"Yahoo Finance":"#7c3aed","ForexLive":"#2563eb","FXStreet":"#26a69a","Investing":"#d97706"}[a.source]||"#787b86";
                        // Time until expiry
                        const savedAt = new Date(a.savedAt||a.pubDate||Date.now());
                        const expiresIn = Math.max(0, 48*60 - Math.floor((Date.now()-savedAt)/60000));
                        const expiresStr = expiresIn<60?expiresIn+"m":Math.floor(expiresIn/60)+"h";
                        return (
                          <div key={i} onClick={()=>openArticle(a)}
                            style={{background:TH.card,border:"1px solid rgba(255,255,255,0.05)",borderRadius:4,padding:"14px 18px",marginBottom:8,cursor:"pointer",transition:"all 0.15s",boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}
                            onMouseEnter={e=>{e.currentTarget.style.borderColor="#2962ff";e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.08)";}}
                            onMouseLeave={e=>{e.currentTarget.style.borderColor="#d1d4dc";e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="0 1px 4px rgba(0,0,0,0.04)";}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                              <div style={{flex:1}}>
                                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:5}}>
                                  {isNew&&<span style={{background:"rgba(41,98,255,0.2)",color:"#2962ff",fontSize:7,fontWeight:800,padding:"1px 6px",borderRadius:99,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>NEW</span>}
                                  <span style={{background:TH.inputBg,border:"1px solid "+srcColor+"33",borderRadius:4,padding:"1px 7px",fontSize:8,color:srcColor,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>{a.source}</span>
                                  {timeStr&&<span style={{fontSize:8,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{timeStr}</span>}
                                </div>
                                <div style={{fontSize:13,fontWeight:600,color:TH.text,lineHeight:1.5,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:4}}>{a.title}</div>
                                {a.description&&<div style={{fontSize:11,color:TH.textSub,lineHeight:1.5}}>{a.description.slice(0,180)}</div>}
                              </div>
                              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6,flexShrink:0}}>
                                <span style={{fontSize:10,color:"#3d8eff",fontFamily:"'IBM Plex Sans',sans-serif"}}>READ →</span>
                                <span style={{fontSize:7,color:"rgba(255,255,255,0.2)",fontFamily:"'IBM Plex Sans',sans-serif"}}>expires {expiresStr}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {tab==="setup"&&(
            <div style={{animation:"slideIn 0.3s ease"}}>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:isDark?"#787b86":"#9598a1",textTransform:"uppercase",letterSpacing:0.4,fontWeight:500,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:4}}>Configuration</div>
                  <div style={{fontSize:13,fontWeight:600,color:isDark?"#d1d4dc":"#131722"}}>EA Setup</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"20px",boxShadow:"0 1px 6px rgba(15,23,42,0.06)"}}>
                  <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:14}}>CONNECTION STATUS</div>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:serverOk?"#22c55e":"#ef4444",boxShadow:"none"}}/>
                    <span style={{fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",color:serverOk?"#26a69a":"#ff2d55"}}>Railway Server {serverOk?"ONLINE":"OFFLINE"}</span>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:wsOk?"#26a69a":"#94a3b8",animation:wsOk?"pulse 2s infinite":"none"}}/>
                    <span style={{fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif",color:wsOk?"#26a69a":"#787b86"}}>WebSocket {wsOk?"CONNECTED":"DISCONNECTED"}</span>
                  </div>
                  <div style={{background:"rgba(41,98,255,0.18)",border:"1px solid "+TH.border,borderRadius:3,padding:"12px 14px",marginBottom:12}}>
                    <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:6}}>YOUR TOKEN</div>
                    <div style={{fontSize:16,color:"#3d8eff",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:2,fontWeight:600}}>{appToken||"TL-S7PDZ3UV"}</div>
                  </div>
                  <div style={{fontSize:12,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.8}}>
                    <div>Server: <span style={{color:TH.textSub}}>tradeledger-server-production.up.railway.app</span></div>
                    <div>Trades: <span style={{color:TH.textSub}}>{trades.length} synced</span></div>
                    {lastSync&&<div>Last sync: <span style={{color:TH.textSub}}>{lastSync}</span></div>}
                  </div>
                </div>
                <div style={{background:TH.card,border:"1px solid "+TH.border,borderRadius:4,padding:"20px",boxShadow:"0 1px 6px rgba(15,23,42,0.06)"}}>
                  <div style={{fontSize:11,color:TH.textSub,letterSpacing:1,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:14}}>SETUP STEPS</div>
                  {[["1","Download TradeLedger_EA.mq5"],["2","Copy to MT5 Experts folder"],["3","Compile in MetaEditor (F7)"],["4","Add Railway URL to WebRequests whitelist"],["5","Attach EA to any chart"],["6","Enter token: TL-S7PDZ3UV"],["7","Watch trades sync here!"]].map(([n,step])=>(
                    <div key={n} style={{display:"flex",gap:10,marginBottom:8,fontSize:11,fontFamily:"'IBM Plex Sans',sans-serif"}}>
                      <span style={{color:"#f9a825",minWidth:16}}>{n}.</span>
                      <span style={{color:TH.textSub}}>{step}</span>
                    </div>
                  ))}
                </div>
                {/* Risk Limit + Checklist Settings */}
                <div style={{background:"rgba(248,113,113,0.08)",border:"1px solid #fecaca",borderRadius:4,padding:20,gridColumn:"1 / -1"}}>
                  <div style={{fontSize:9,color:"#ef5350",letterSpacing:2,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:14,fontWeight:700}}>🛡 DAILY RISK PROTECTION</div>
                  <div style={{fontSize:12,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:12,lineHeight:1.6}}>
                    Set a maximum daily loss. When hit, an alert will appear to help you stop trading and protect your capital.
                  </div>
                  <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:140}}>
                      <div style={{fontSize:9,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:6}}>MAX DAILY LOSS ($)</div>
                      <input type="number" min="0" step="10"
                        defaultValue={riskLimit||""}
                        placeholder="e.g. 50"
                        id="riskLimitInput"
                        style={{width:"100%",border:"1px solid #ef9a9a",borderRadius:4,padding:"10px 14px",fontSize:14,fontFamily:"'IBM Plex Sans',sans-serif",color:"#ef5350",fontWeight:700,background:TH.card,outline:"none"}}/>
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:16}}>
                      <button onClick={()=>{
                        const v = parseFloat(document.getElementById("riskLimitInput").value);
                        if(!isNaN(v)&&v>0){setRiskLimit(v);setRiskLockDismissed(false);try{localStorage.setItem("tl_risk_limit",JSON.stringify(v));}catch{};}
                      }} style={{background:"#ef5350",border:"none",borderRadius:4,padding:"10px 18px",color:"#fff",fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700}}>SAVE LIMIT</button>
                      {riskLimit&&<button onClick={()=>{setRiskLimit(null);try{localStorage.removeItem("tl_risk_limit");}catch{};}} style={{background:TH.inputBg,border:"1px solid "+TH.border,borderRadius:4,padding:"10px 14px",color:TH.textSub,fontSize:12,cursor:"pointer",fontFamily:"'IBM Plex Sans',sans-serif"}}>Remove</button>}
                    </div>
                  </div>
                  {riskLimit&&<div style={{marginTop:12,background:TH.card,border:"1px solid #ef9a9a",borderRadius:4,padding:"8px 14px",fontSize:11,color:"#ef5350",fontFamily:"'IBM Plex Sans',sans-serif"}}>
                    🛑 Active limit: ${riskLimit}/day · Checklist: {(checklist||DEFAULT_CHECKLIST).length} rules
                  </div>}
                </div>

                <div style={{background:"rgba(255,181,71,0.07)",border:"1px solid #fde68a",borderRadius:4,padding:20,gridColumn:"1 / -1"}}>
                  <div style={{fontSize:11,color:"#fbbf24",textTransform:"uppercase",letterSpacing:0.5,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,marginBottom:12}}>TROUBLESHOOTING</div>
                  {[["EA shows HTTP -1","Add Railway URL to MT5 WebRequests whitelist"],["Token mismatch","Check TRADELEDGER_TOKEN in Railway Variables"],["No trades sync","Check MT5 Experts tab for error messages"],["App shows offline","Railway server may be sleeping — open /api/status to wake it"]].map(([q,a])=>(
                    <div key={q} style={{marginBottom:10}}>
                      <div style={{fontSize:11,color:TH.textDim,fontWeight:600}}>{q}</div>
                      <div style={{fontSize:12,color:TH.textSub,marginTop:3,lineHeight:1.6}}>{a}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Mobile Bottom Nav */}
      <div className="mobile-nav" style={{position:"fixed",bottom:0,left:0,right:0,height:64,background:isDark?"rgba(21,31,51,0.97)":"rgba(255,255,255,0.97)",backdropFilter:"blur(20px)",borderTop:"1px solid "+TH.border,zIndex:100,display:"none",alignItems:"center",justifyContent:"space-around",padding:"0 8px"}}>
        {NAV.filter(n=>n.id!=="setup").map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)}
            style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"8px 4px",borderTop:tab===n.id?"2px solid #00e5a0":"2px solid transparent",transition:"all 0.15s"}}>
            <span style={{fontSize:16,opacity:tab===n.id?1:0.4}}>{n.icon}</span>
            <span style={{fontSize:9,color:tab===n.id?"#2962ff":"rgba(241,245,249,0.55)",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.3,fontWeight:tab===n.id?700:400}}>{n.label.slice(0,4).toUpperCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
function PredictionsPanel({watchlist, prices, trades}) {
  const predSyms = watchlist.slice(0,4);
  const assetInfo = {
    "XAUUSD":{name:"Gold",emoji:"🥇",type:"metal",pip:0.1},
    "BTCUSD":{name:"Bitcoin",emoji:"₿",type:"crypto",pip:1},
    "ETHUSD":{name:"Ethereum",emoji:"Ξ",type:"crypto",pip:0.1},
    "EURUSD":{name:"EUR/USD",emoji:"€",type:"forex",pip:0.0001},
    "GBPUSD":{name:"GBP/USD",emoji:"£",type:"forex",pip:0.0001},
    "USDJPY":{name:"USD/JPY",emoji:"¥",type:"forex",pip:0.01},
    "GBPJPY":{name:"GBP/JPY",emoji:"🇬🇧",type:"forex",pip:0.01},
    "AUDUSD":{name:"AUD/USD",emoji:"🦘",type:"forex",pip:0.0001},
    "USDCHF":{name:"USD/CHF",emoji:"🇨🇭",type:"forex",pip:0.0001},
    "USDCAD":{name:"USD/CAD",emoji:"🍁",type:"forex",pip:0.0001},
    "NZDUSD":{name:"NZD/USD",emoji:"🥝",type:"forex",pip:0.0001},
    "XAGUSD":{name:"Silver",emoji:"🥈",type:"metal",pip:0.001},
    "NAS100":{name:"Nasdaq 100",emoji:"📈",type:"index",pip:0.1},
    "SP500": {name:"S&P 500",emoji:"📊",type:"index",pip:0.1},
    "US30":  {name:"Dow Jones",emoji:"🏛",type:"index",pip:1},
    "USOIL": {name:"Crude Oil",emoji:"🛢",type:"commodity",pip:0.01},
  };
  const getInfo = s => assetInfo[s] || {name:s, emoji:"◈", type:"forex", pip:0.0001};
  const utcH = new Date().getUTCHours();
  const session = utcH>=0&&utcH<8?"Asian":utcH>=8&&utcH<13?"London":utcH>=13&&utcH<17?"Overlap":"NewYork";
  const sessionLabel = {Asian:"Asian Session",London:"London Session",Overlap:"London/NY Overlap",NewYork:"New York Session"}[session];
  const symStats = {};
  predSyms.forEach(sym=>{
    const st=trades.filter(t=>t.symbol===sym);
    const sw=st.filter(t=>t.profit>0);
    symStats[sym]={total:st.length,winRate:st.length?+(sw.length/st.length*100).toFixed(0):null,netPnl:+st.reduce((s,t)=>s+(t.profit||0),0).toFixed(2),avgWin:sw.length?+(sw.reduce((s,t)=>s+t.profit,0)/sw.length).toFixed(2):0};
  });
  const analyse = (sym) => {
    const info=getInfo(sym), p=prices[sym], hist=symStats[sym];
    if (!p?.price) return null;
    const price=parseFloat(p.price), changePct=parseFloat(p.changePct)||0;
    const high=parseFloat(p.high)||price*1.005, low=parseFloat(p.low)||price*0.995;
    const range=high-low, pip=info.pip;
    const rangePct=range>0?(price-low)/range:0.5, absMov=Math.abs(changePct);
    let signal,bias,confidence;
    if(changePct>0.3&&rangePct>0.6){signal="BUY";bias="bullish";confidence=Math.min(78,52+Math.round(absMov*8));}
    else if(changePct<-0.3&&rangePct<0.4){signal="SELL";bias="bearish";confidence=Math.min(78,52+Math.round(absMov*8));}
    else if(changePct>0.1){signal="BUY";bias="bullish";confidence=54;}
    else if(changePct<-0.1){signal="SELL";bias="bearish";confidence=54;}
    else{signal="HOLD";bias="neutral";confidence=50;}
    const sessionBoost={Asian:["USDJPY","GBPJPY","AUDUSD","NZDUSD","XAUUSD"],London:["EURUSD","GBPUSD","USDCHF","XAUUSD","XAGUSD"],Overlap:["EURUSD","GBPUSD","XAUUSD","BTCUSD","NAS100","SP500"],NewYork:["USOIL","US30","NAS100","SP500","BTCUSD","ETHUSD"]}[session]||[];
    if(sessionBoost.includes(sym)) confidence=Math.min(78,confidence+5);
    const boost=hist.total>=5&&hist.winRate!=null?(hist.winRate>55?4:hist.winRate<40?-4:0):0;
    confidence=Math.max(45,Math.min(78,confidence+boost));
    const dec=pip<0.001?5:pip<0.01?4:pip<0.1?2:2;
    const step=pip*100;
    const support=+(low-step*0.5).toFixed(dec), resistance=+(high+step*0.5).toFixed(dec);
    const target=signal==="BUY"?+(price+range*0.5).toFixed(dec):signal==="SELL"?+(price-range*0.5).toFixed(dec):+price.toFixed(dec);
    const moveDir=changePct>=0?"up":"down", moveStr=absMov>1?"sharply ":"slightly ";
    const catalysts={bullish:[`Price is ${moveStr}${moveDir} ${absMov.toFixed(2)}% — momentum favours buyers in the ${sessionLabel}`,`Trading in upper half of range (${(rangePct*100).toFixed(0)}%) — buyers defending intraday support`],bearish:[`Price is ${moveStr}${moveDir} ${absMov.toFixed(2)}% — sellers in control through ${sessionLabel}`,`Trading in lower half of range (${(rangePct*100).toFixed(0)}%) — sellers capping recovery`],neutral:[`Price is flat (${changePct>=0?"+":""}${changePct.toFixed(2)}%) — no directional momentum in ${sessionLabel}`,`Mid-range consolidation — wait for a breakout before trading`]};
    const catalyst=catalysts[bias][0];
    const isMetal=info.type==="metal";
    const fmtP=v=>(isMetal?"$":"")+parseFloat(v).toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec});
    const slDist=(range*0.3).toFixed(dec);
    const steps=signal==="BUY"?[`Wait for pullback to ${fmtP(support)} — enter long with stop ${slDist} below`,`Set take profit at ${fmtP(target)} (~${((target-price)/price*100).toFixed(2)}% from current)`,`Risk max 1-2% of account. Invalidate if price breaks below ${fmtP(support)}`]:signal==="SELL"?[`Look for bounce toward ${fmtP(resistance)} to enter short — don't chase`,`Target ${fmtP(target)} with stop ${slDist} above entry`,`Risk max 1-2% of account. Exit if price reclaims ${fmtP(resistance)}`]:[`No clear edge — stay flat and watch for break above ${fmtP(resistance)} or below ${fmtP(support)}`,`Break above ${fmtP(resistance)} → consider long targeting ${fmtP(+(resistance+range*0.3).toFixed(dec))}`,`Break below ${fmtP(support)} → consider short targeting ${fmtP(+(support-range*0.3).toFixed(dec))}`];
    const histNote=hist.total>=5?`Your ${sym} history: ${hist.total} trades, ${hist.winRate}% WR, $${hist.netPnl} net`:hist.total>0?`${hist.total} ${sym} trade${hist.total>1?"s":""} — build more history for personalisation`:`No ${sym} trades yet — paper trade first`;
    return {signal,bias,confidence,price,changePct,high,low,target,support,resistance,catalyst,steps,histNote,rangePct};
  };
  const cols=predSyms.length<=1?1:predSyms.length===3?3:2;
  const now=new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" UTC";
  const sc=sig=>sig==="BUY"?"#26a69a":sig==="SELL"?"#ef5350":"#7e57c2";
  const sbg=sig=>sig==="BUY"?"rgba(38,166,154,0.1)":sig==="SELL"?"rgba(239,83,80,0.1)":"rgba(167,139,250,0.1)";
  const sbdr=sig=>sig==="BUY"?"rgba(38,166,154,0.25)":sig==="SELL"?"rgba(239,83,80,0.25)":"rgba(167,139,250,0.3)";
  return (
    <div style={{marginBottom:16,borderRadius:4,overflow:"hidden",border:"1px solid "+TH.border,boxShadow:"none"}}>
      <div style={{background:isDark?"rgba(41,98,255,0.12)":"rgba(41,98,255,0.07)",borderBottom:"1px solid "+TH.border,padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <div style={{width:30,height:30,borderRadius:9,background:"linear-gradient(135deg,rgba(41,98,255,0.25),rgba(41,98,255,0.2))",border:"1px solid rgba(41,98,255,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🔭</div>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>Market Analysis</div>
            <div style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginTop:1}}>{sessionLabel} · {now} · live prices + your trade history</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <div style={{width:5,height:5,borderRadius:"50%",background:"#26a69a"}}/>
          <span style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>Refreshes with prices</span>
        </div>
      </div>
      <div style={{background:TH.card,padding:"14px 14px 12px"}}>
        {predSyms.length===0?(
          <div style={{textAlign:"center",padding:"24px 0",color:TH.textDim,fontSize:10,fontFamily:"'IBM Plex Sans',sans-serif"}}>Add symbols to your watchlist to see analysis</div>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"repeat("+cols+",1fr)",gap:12,marginBottom:10}}>
            {predSyms.map(sym=>{
              const info=getInfo(sym), p=prices[sym], analysis=analyse(sym);
              if (!analysis) return (
                <div key={sym} style={{background:TH.cardHover,borderRadius:4,border:"1px solid "+TH.border,padding:"16px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6}}>
                  <span style={{fontSize:20}}>{info.emoji}</span>
                  <div style={{fontSize:9,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center"}}>{info.name}<br/>Waiting for live price…<div style={{width:5,height:5,borderRadius:"50%",background:"#2962ff",animation:"pulse 1.5s infinite",margin:"6px auto 0"}}/></div>
                </div>
              );
              const {signal,bias,confidence,price:px,changePct,high,low,target,support,resistance,catalyst,steps,histNote,rangePct}=analysis;
              const col=sc(signal),bg=sbg(signal),bdr=sbdr(signal);
              const dec=info.pip<0.001?5:info.pip<0.01?4:info.pip<0.1?2:2;
              const isMetal=info.type==="metal";
              const fmtP=v=>(isMetal?"$":"")+parseFloat(v).toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec});
              const diffPct=(target-px)/px*100;
              return (
                <div key={sym} style={{background:TH.cardHover,borderRadius:4,border:"1px solid "+TH.border,overflow:"hidden",position:"relative",boxShadow:"none"}}>
                  <div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:col}}/>
                  <div style={{padding:"12px 12px 12px 15px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                      <div style={{display:"flex",gap:7,alignItems:"center"}}>
                        <span style={{fontSize:18,lineHeight:1}}>{info.emoji}</span>
                        <div>
                          <div style={{fontSize:11,fontWeight:700,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.1}}>{info.name}</div>
                          <div style={{fontSize:7,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>{sym} · {info.type}</div>
                        </div>
                      </div>
                      <div style={{background:bg,border:"1px solid "+bdr,borderRadius:6,padding:"4px 10px",fontSize:9,fontWeight:800,color:col,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>{signal}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:6}}>
                      <span style={{fontSize:20,fontWeight:800,color:TH.text,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:-0.5,lineHeight:1}}>{fmtP(px)}</span>
                      <span style={{fontSize:9,fontWeight:700,color:changePct>=0?"#26a69a":"#ef5350",background:changePct>=0?"rgba(38,166,154,0.1)":"rgba(239,83,80,0.1)",padding:"2px 6px",borderRadius:4,fontFamily:"'IBM Plex Sans',sans-serif"}}>{changePct>=0?"+":""}{changePct.toFixed(2)}%</span>
                    </div>
                    <div style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:3}}><span>L {fmtP(low)}</span><span style={{color:TH.textSub}}>Day Range</span><span>H {fmtP(high)}</span></div>
                      <div style={{height:4,background:isDark?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.07)",borderRadius:2,position:"relative"}}>
                        <div style={{position:"absolute",left:0,top:0,bottom:0,width:(rangePct*100)+"%",background:`linear-gradient(90deg,${"#ef5350"}60,${col})`,borderRadius:2}}/>
                        <div style={{position:"absolute",top:"50%",left:(rangePct*100)+"%",transform:"translate(-50%,-50%)",width:8,height:8,borderRadius:"50%",background:col,border:"1.5px solid "+TH.card}}/>
                      </div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:10}}>
                      {[{label:"SUPPORT",val:fmtP(support),color:"#26a69a",bg:"rgba(38,166,154,0.07)"},{label:"TARGET",val:fmtP(target),color:col,bg},{label:"RESIST",val:fmtP(resistance),color:"#ef5350",bg:"rgba(239,83,80,0.07)"}].map(lv=>(
                        <div key={lv.label} style={{background:lv.bg,borderRadius:7,padding:"5px 6px",textAlign:"center"}}>
                          <div style={{fontSize:6,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",marginBottom:2}}>{lv.label}</div>
                          <div style={{fontSize:8.5,fontWeight:700,color:lv.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{lv.val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
                      <div style={{fontSize:7,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:0.5}}>POTENTIAL MOVE</div>
                      <div style={{fontSize:9,fontWeight:700,color:col,fontFamily:"'IBM Plex Sans',sans-serif"}}>{diffPct>=0?"+":""}{diffPct.toFixed(2)}%</div>
                    </div>
                    <div style={{marginBottom:10}}>
                      <div style={{height:3,background:isDark?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.07)",borderRadius:2,overflow:"hidden"}}>
                        <div style={{height:"100%",width:confidence+"%",background:confidence>=70?"linear-gradient(90deg,#26a69a,#26a69a)":confidence>=55?"linear-gradient(90deg,#f59e0b,#d97706)":"linear-gradient(90deg,#94a3b8,#64748b)",borderRadius:2,transition:"width 0.6s"}}/>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
                        <span style={{fontSize:6.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif"}}>SIGNAL STRENGTH</span>
                        <span style={{fontSize:6.5,fontWeight:700,fontFamily:"'IBM Plex Sans',sans-serif",color:confidence>=70?"#26a69a":confidence>=55?"#f59e0b":"#94a3b8"}}>{confidence>=70?"Strong":confidence>=55?"Moderate":"Weak"} · {confidence}%</span>
                      </div>
                    </div>
                    <div style={{fontSize:8.5,color:TH.textSub,lineHeight:1.6,fontFamily:"'IBM Plex Sans',sans-serif",borderLeft:"2px solid "+col+"50",paddingLeft:7,marginBottom:10}}>{catalyst}</div>
                    <div style={{background:isDark?"rgba(255,255,255,0.03)":"rgba(0,0,0,0.02)",borderRadius:4,padding:"8px 10px",marginBottom:8}}>
                      <div style={{fontSize:7,color:col,fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,letterSpacing:1,marginBottom:6}}>HOW TO TRADE THIS</div>
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {steps.map((step,si)=>(
                          <div key={si} style={{display:"flex",gap:6,alignItems:"flex-start"}}>
                            <div style={{minWidth:15,height:15,borderRadius:4,background:col+"20",border:"1px solid "+col+"40",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,color:col,fontWeight:800,fontFamily:"'IBM Plex Sans',sans-serif",flexShrink:0,marginTop:1}}>{si+1}</div>
                            <div style={{fontSize:8.5,color:TH.textSub,fontFamily:"'IBM Plex Sans',sans-serif",lineHeight:1.55}}>{step}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{fontSize:7.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",background:isDark?"rgba(41,98,255,0.05)":"rgba(41,98,255,0.04)",borderRadius:6,padding:"5px 8px"}}>📊 {histNote}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{fontSize:6.5,color:TH.textDim,fontFamily:"'IBM Plex Sans',sans-serif",textAlign:"center",paddingTop:6,borderTop:"1px solid "+TH.border,marginTop:4}}>
          ⚠ Technical analysis based on live price data · not financial advice · always apply your own judgement
        </div>
      </div>
    </div>
  );
}
