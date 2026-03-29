import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from "recharts";

const SERVER = "https://tradeledger-server-production.up.railway.app";
const WS_URL  = "wss://tradeledger-server-production.up.railway.app/ws";
const RAILWAY_SERVER = SERVER;
const DEFAULT_WL = ["EURUSD","GBPUSD","USDJPY","XAUUSD","GBPJPY","USDCHF","AUDUSD","BTCUSD","ETHUSD","XRPUSD","SOLUSD","BNBUSD"];
const PRICE_CACHE_KEY = "tl_price_cache";
const PRICE_CACHE_TTL = 5 * 60 * 1000;

const LIGHT = {
  bg:"#f0f2f8", surface:"#ffffff", raised:"#f7f8fc",
  border:"rgba(0,0,0,0.07)", borderHover:"rgba(0,0,0,0.14)",
  text:"#1a1d2e", textSub:"#6b7280", textDim:"#9ca3af",
  green:"#00c48c", greenBg:"rgba(0,196,140,0.1)", greenBorder:"rgba(0,196,140,0.25)",
  red:"#ff5b5b", redBg:"rgba(255,91,91,0.1)", redBorder:"rgba(255,91,91,0.25)",
  blue:"#4f80ff", blueBg:"rgba(79,128,255,0.1)",
  amber:"#f59e0b", amberBg:"rgba(245,158,11,0.1)",
  purple:"#8b5cf6", purpleBg:"rgba(139,92,246,0.1)",
  cyan:"#06b6d4",
};
const DARK = {
  bg:"#0e1117", surface:"#161b22", raised:"#1c2230",
  border:"rgba(255,255,255,0.08)", borderHover:"rgba(255,255,255,0.16)",
  text:"#e6edf3", textSub:"#8b949e", textDim:"#4a5568",
  green:"#00c48c", greenBg:"rgba(0,196,140,0.12)", greenBorder:"rgba(0,196,140,0.3)",
  red:"#ff5b5b", redBg:"rgba(255,91,91,0.12)", redBorder:"rgba(255,91,91,0.3)",
  blue:"#4f80ff", blueBg:"rgba(79,128,255,0.12)",
  amber:"#f59e0b", amberBg:"rgba(245,158,11,0.12)",
  purple:"#8b5cf6", purpleBg:"rgba(139,92,246,0.12)",
  cyan:"#06b6d4",
};
let T = {...LIGHT};

function parseMT5Date(s){if(!s)return null;const d=new Date(String(s).replace(/\./g,"-").replace(" ","T"));return isNaN(d.getTime())?null:d;}
function mt5Day(s){const d=parseMT5Date(s);return d?d.toISOString().slice(0,10):null;}
function mt5Hour(s){const d=parseMT5Date(s);return d?d.getUTCHours():null;}
// localDay() — always returns YYYY-MM-DD in the user's LOCAL timezone (fixes UTC off-by-one)
function localDay(d=new Date()){
  const dt=d instanceof Date?d:new Date(d);
  return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
}

async function fetchPriceBatch(symbols,{onCachedHit}={}){
  try{const raw=localStorage.getItem(PRICE_CACHE_KEY);if(raw){const c=JSON.parse(raw);if(Date.now()-(c.savedAt||0)<PRICE_CACHE_TTL&&symbols.every(s=>c.quotes?.[s]!==undefined)&&onCachedHit)onCachedHit(c.quotes);}}catch{}
  try{const r=await fetch(RAILWAY_SERVER+"/api/quote?symbols="+symbols.join(","),{signal:AbortSignal.timeout(20000)});if(!r.ok)return{};const data=await r.json();const q=data.quotes||{};if(Object.keys(q).length)try{localStorage.setItem(PRICE_CACHE_KEY,JSON.stringify({quotes:q,savedAt:Date.now()}));}catch{}return q;}catch{return{};}
}

function computeStats(trades){
  if(!trades.length)return null;
  const wins=trades.filter(t=>t.profit>0),losses=trades.filter(t=>t.profit<0);
  const net=t=>t.profit+(t.swap||0)+(t.commission||0);
  const totalProfit=+trades.reduce((s,t)=>s+net(t),0).toFixed(2);
  const gp=wins.reduce((s,t)=>s+t.profit,0),gl=Math.abs(losses.reduce((s,t)=>s+t.profit,0));
  const pf=gl>0?+(gp/gl).toFixed(2):gp>0?99:0;
  const avgWin=wins.length?+(gp/wins.length).toFixed(2):0;
  const avgLoss=losses.length?+(gl/losses.length).toFixed(2):0;
  let bal=10000,peak=10000,maxDD=0;
  const equity=trades.map((t)=>{bal+=net(t);if(bal>peak)peak=bal;const dd=((peak-bal)/peak)*100;if(dd>maxDD)maxDD=dd;return{bal:+bal.toFixed(2)};});
  const symMap={};
  trades.forEach(t=>{if(!symMap[t.symbol])symMap[t.symbol]={symbol:t.symbol,trades:0,profit:0,wins:0};symMap[t.symbol].trades++;symMap[t.symbol].profit=+(symMap[t.symbol].profit+t.profit).toFixed(2);if(t.profit>0)symMap[t.symbol].wins++;});
  const sessions={Asian:0,London:0,NewYork:0,Overlap:0};
  trades.forEach(t=>{const h=mt5Hour(t.openTime)||0;if(h>=0&&h<8)sessions.Asian+=t.profit;if(h>=8&&h<13)sessions.London+=t.profit;if(h>=13&&h<17)sessions.Overlap+=t.profit;if(h>=17&&h<22)sessions.NewYork+=t.profit;});
  const dayMap={Mon:{wins:0,losses:0,profit:0},Tue:{wins:0,losses:0,profit:0},Wed:{wins:0,losses:0,profit:0},Thu:{wins:0,losses:0,profit:0},Fri:{wins:0,losses:0,profit:0}};
  trades.forEach(t=>{const d=parseMT5Date(t.closeTime||t.openTime);if(!d)return;const k=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];if(dayMap[k]){dayMap[k].profit+=net(t);if(t.profit>0)dayMap[k].wins++;else dayMap[k].losses++;}});
  const pnlByDay={};
  trades.forEach(t=>{const d=mt5Day(t.closeTime);if(!d)return;if(!pnlByDay[d])pnlByDay[d]={date:d,profit:0,trades:0};pnlByDay[d].profit+=+net(t).toFixed(2);pnlByDay[d].trades++;});
  const dailyPnl=Object.values(pnlByDay).sort((a,b)=>a.date.localeCompare(b.date)).slice(-30);
  let maxCW=0,maxCL=0,cw=0,cl=0;
  trades.forEach(t=>{if(t.profit>0){cw++;cl=0;if(cw>maxCW)maxCW=cw;}else{cl++;cw=0;if(cl>maxCL)maxCL=cl;}});
  const expectancy=+((wins.length/trades.length)*avgWin-(losses.length/trades.length)*avgLoss).toFixed(2);
  // Deep stats
  const sortedProfits=[...trades].map(t=>net(t)).sort((a,b)=>b-a);
  const largestWin=sortedProfits[0]||0, largestLoss=sortedProfits[sortedProfits.length-1]||0;
  const activeDays=new Set(trades.map(t=>mt5Day(t.openTime)).filter(Boolean)).size;
  const tradesPerDay=activeDays>0?+(trades.length/activeDays).toFixed(1):0;
  // Drawdown series
  let ddBal=10000,ddPeak=10000;
  const drawdownSeries=trades.map((t,i)=>{ddBal+=net(t);if(ddBal>ddPeak)ddPeak=ddBal;const dd=((ddPeak-ddBal)/ddPeak)*100;return{n:i+1,dd:+dd.toFixed(2)};});
  // Monthly P&L
  const monthMap={};
  trades.forEach(t=>{const d=mt5Day(t.closeTime);if(!d)return;const m=d.slice(0,7);if(!monthMap[m])monthMap[m]={month:m,profit:0,trades:0,wins:0};monthMap[m].profit+=+net(t).toFixed(2);monthMap[m].trades++;if(t.profit>0)monthMap[m].wins++;});
  const monthlyPnl=Object.values(monthMap).sort((a,b)=>a.month.localeCompare(b.month));
  const bestMonth=monthlyPnl.length?[...monthlyPnl].sort((a,b)=>b.profit-a.profit)[0]:null;
  const worstMonth=monthlyPnl.length?[...monthlyPnl].sort((a,b)=>a.profit-b.profit)[0]:null;
  return{total:trades.length,wins:wins.length,losses:losses.length,winRate:+((wins.length/trades.length)*100).toFixed(1),totalProfit,grossProfit:+gp.toFixed(2),grossLoss:+gl.toFixed(2),pf,avgWin,avgLoss,rr:avgLoss>0?+(avgWin/avgLoss).toFixed(2):"--",maxDD:+maxDD.toFixed(2),equity,drawdownSeries,dailyPnl,monthlyPnl,bestMonth,worstMonth,bySymbol:Object.values(symMap).sort((a,b)=>b.profit-a.profit),sessions:Object.entries(sessions).map(([k,v])=>({name:k,profit:+v.toFixed(2)})),byDayOfWeek:dayMap,maxCW,maxCL,expectancy,largestWin:+largestWin.toFixed(2),largestLoss:+largestLoss.toFixed(2),tradesPerDay,activeDays};
}

const getSessions=()=>{const now=new Date(),u=now.getUTCHours()*60+now.getUTCMinutes();return[{name:"Sydney",color:T.cyan,open:21*60,close:6*60,overnight:true},{name:"Tokyo",color:T.amber,open:0,close:9*60,overnight:false},{name:"London",color:T.green,open:8*60,close:17*60,overnight:false},{name:"New York",color:T.purple,open:13*60,close:22*60,overnight:false}].map(s=>({...s,active:s.overnight?(u>=s.open||u<s.close):(u>=s.open&&u<s.close)}));};
const getAssetInfo=s=>({XAUUSD:{name:"Gold",type:"metal",pip:0.1},BTCUSD:{name:"Bitcoin",type:"crypto",pip:1},ETHUSD:{name:"Ethereum",type:"crypto",pip:0.1},EURUSD:{name:"EUR/USD",type:"forex",pip:0.0001},GBPUSD:{name:"GBP/USD",type:"forex",pip:0.0001},USDJPY:{name:"USD/JPY",type:"forex",pip:0.01},GBPJPY:{name:"GBP/JPY",type:"forex",pip:0.01},AUDUSD:{name:"AUD/USD",type:"forex",pip:0.0001},USDCHF:{name:"USD/CHF",type:"forex",pip:0.0001},USDCAD:{name:"USD/CAD",type:"forex",pip:0.0001},NZDUSD:{name:"NZD/USD",type:"forex",pip:0.0001},XAGUSD:{name:"Silver",type:"metal",pip:0.001},NAS100:{name:"Nasdaq",type:"index",pip:0.1},SPX500:{name:"S&P 500",type:"index",pip:0.1},US30:{name:"Dow Jones",type:"index",pip:1},USOIL:{name:"Crude Oil",type:"commodity",pip:0.01}}[s]||{name:s,type:"forex",pip:0.0001});
const WL_SYMBOLS={Forex:["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","NZDUSD","USDCAD","EURGBP","EURJPY","GBPJPY","AUDJPY","CADJPY"],Metals:["XAUUSD","XAGUSD"],Crypto:["BTCUSD","ETHUSD","XRPUSD"],Indices:["NAS100","US30","SPX500","GER40"],Energy:["USOIL","UKOIL"]};
const DEFAULT_CHECKLIST=["Checked economic calendar","Confirmed trend direction","Set stop loss","Risk < 1% of account","No revenge trading mindset","Entry aligns with setup rules"];

// ── CSS ──────────────────────────────────────────────────────
const GlobalStyles=({dark})=>(
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body,#root{height:100%;overflow:hidden;}
    body{background:${T.bg};color:${T.text};font-family:'Inter',sans-serif;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;transition:background .3s,color .3s;}
    ::-webkit-scrollbar{width:5px;height:5px;}
    ::-webkit-scrollbar-track{background:transparent;}
    ::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:3px;}
    ::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.25);}
    input,button,select,textarea{font-family:'Inter',sans-serif;}
    input::placeholder,textarea::placeholder{color:${T.textDim};}
    input:focus,textarea:focus{outline:none;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
    @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
    @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
    @keyframes shimmer{0%{background-position:-200% center;}100%{background-position:200% center;}}
    .page{animation:fadeUp .2s ease both;}
    .tab-content{animation:fadeUp .18s ease both;}
    .trow{transition:background .12s;}
    @media(max-width:768px){
      .sidebar-desktop{display:none!important;}
      .bottom-nav{display:flex!important;}
      .mobile-grid-1{grid-template-columns:1fr!important;}
      .mobile-grid-2{grid-template-columns:1fr 1fr!important;}
      .mobile-hide{display:none!important;}
      .mobile-full{width:100%!important;max-width:100%!important;}
    }
    @media(min-width:769px){
      .bottom-nav{display:none!important;}
    }
    .bottom-nav{position:fixed;bottom:0;left:0;right:0;height:56px;background:${T.surface};border-top:1px solid ${T.border};align-items:center;justify-content:space-around;z-index:100;display:none;}
    .bottom-nav-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 8px;border:none;background:none;cursor:pointer;font-family:inherit;flex:1;}
    .card{background:#fff;border-radius:14px;border:1px solid ${T.border};box-shadow:0 1px 3px rgba(0,0,0,0.04);}
    .card:hover{border-color:${T.borderHover};}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:1px solid ${T.border};background:#fff;color:${T.text};font-size:12px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap;}
    .btn:hover{background:${T.bg};border-color:${T.borderHover};}
    .btn-primary{background:${T.blue};border-color:${T.blue};color:#fff;font-weight:600;}
    .btn-primary:hover{background:#3b6ee8;border-color:#3b6ee8;}
    .btn:disabled{opacity:.35;cursor:not-allowed;}
    .input{background:#fff;border:1px solid ${T.border};border-radius:8px;padding:8px 12px;color:${T.text};font-size:13px;transition:border-color .15s;width:100%;}
    .input:focus{border-color:${T.blue};box-shadow:0 0 0 3px rgba(79,128,255,0.1);}
    .tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;font-family:'JetBrains Mono',monospace;}
    .tag-green{background:${T.greenBg};color:${T.green};border:1px solid ${T.greenBorder};}
    .tag-red{background:${T.redBg};color:${T.red};border:1px solid ${T.redBorder};}
    .tag-gray{background:${T.bg};color:${T.textSub};border:1px solid ${T.border};}
    .tag-blue{background:${T.blueBg};color:${T.blue};border:1px solid rgba(79,128,255,.25);}
    .tag-amber{background:${T.amberBg};color:${T.amber};border:1px solid rgba(245,158,11,.25);}
    .skeleton{background:linear-gradient(90deg,${T.bg} 25%,#e9ecf3 50%,${T.bg} 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;}
    .nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;cursor:pointer;transition:all .12s;font-size:13px;font-weight:500;color:${T.textSub};border:none;background:none;width:100%;}
    .nav-item:hover{background:${T.bg};color:${T.text};}
    .nav-item.active{background:${T.blueBg};color:${T.blue};font-weight:600;}
    .trow{border-bottom:1px solid ${T.border};transition:background .1s;}
    .trow:last-child{border-bottom:none;}
    .trow:hover{background:${T.bg};}
  `}</style>
);

// ── Shared components ─────────────────────────────────────────
const Spinner=({size=14,color=T.blue})=><div style={{width:size,height:size,border:"2px solid rgba(0,0,0,0.1)",borderTopColor:color,borderRadius:"50%",animation:"spin .7s linear infinite",flexShrink:0}}/>;
const Badge=({children,color="gray"})=><span className={`tag tag-${color}`}>{children}</span>;

const ChartTip=({active,payload,label})=>{
  if(!active||!payload?.length)return null;
  return <div style={{background:"#fff",border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 14px",fontFamily:"'JetBrains Mono',monospace",fontSize:11,boxShadow:"0 4px 16px rgba(0,0,0,0.1)"}}><div style={{color:T.textDim,marginBottom:4}}>{label}</div>{payload.map((p,i)=><div key={i} style={{color:p.color||T.text}}>{p.name}: {typeof p.value==="number"?p.value.toFixed(2):p.value}</div>)}</div>;
};

function MiniDonut({wins,losses,size=80,stroke=10}){
  const total=wins+losses;
  if(!total)return <div style={{width:size,height:size,borderRadius:"50%",border:`${stroke}px solid ${T.bg}`}}/>;
  const data=[{value:(wins/total)*100,fill:T.green},{value:(losses/total)*100,fill:T.red}];
  return <PieChart width={size} height={size}><Pie data={data} cx={size/2-1} cy={size/2-1} innerRadius={size/2-stroke-2} outerRadius={size/2-2} dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>{data.map((d,i)=><Cell key={i} fill={d.fill}/>)}</Pie></PieChart>;
}

function KpiCard({label,value,sub,color}){
  const col=color||T.blue;
  return (
    <div className="card" style={{padding:"16px 18px",position:"relative",overflow:"hidden",flex:1,minWidth:0}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:col}}/>
      <div style={{fontSize:11,color:T.textSub,fontWeight:500,marginBottom:5,marginTop:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,color:col,fontFamily:"'JetBrains Mono',monospace",letterSpacing:"-0.5px",lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:T.textDim,marginTop:4}}>{sub}</div>}
    </div>
  );
}

// ── DASHBOARD ────────────────────────────────────────────────
function DashboardTab({trades,stats,serverOk,lastSync}){
  const todayStr=localDay();
  const [period,setPeriod]=useState("all");
  const periods=[{k:"today",l:"Today"},{k:"yesterday",l:"Yesterday"},{k:"week",l:"This Week"},{k:"lastweek",l:"Last Week"},{k:"month",l:"This Month"},{k:"lastmonth",l:"Last Month"},{k:"year",l:"This Year"},{k:"all",l:"All Time"}];

  const filteredTrades=useMemo(()=>{
    // mt5Day() already normalises "2024.03.15 14:22" → "2024-03-15" via parseMT5Date
    const getDay=t=>mt5Day(t.closeTime)||mt5Day(t.openTime)||"";
    const weekAgo=localDay(new Date(Date.now()-7*86400000));
    const monthAgo=localDay(new Date(Date.now()-30*86400000));
    const ydStr=localDay(new Date(Date.now()-86400000));
    if(period==="today")return trades.filter(t=>getDay(t)===todayStr);
    if(period==="yesterday")return trades.filter(t=>getDay(t)===ydStr);
    if(period==="week")return trades.filter(t=>getDay(t)>=weekAgo);
    if(period==="lastweek"){const s=localDay(new Date(Date.now()-14*86400000));return trades.filter(t=>{const d=getDay(t);return d>=s&&d<weekAgo;});}
    if(period==="month")return trades.filter(t=>getDay(t)>=monthAgo);
    if(period==="lastmonth"){const s=localDay(new Date(Date.now()-60*86400000));return trades.filter(t=>{const d=getDay(t);return d>=s&&d<monthAgo;});}
    if(period==="year"){const y=new Date();y.setFullYear(y.getFullYear()-1);return trades.filter(t=>getDay(t)>=localDay(y));}
    return trades;
  },[trades,period,todayStr]);

  const fStats=useMemo(()=>computeStats(filteredTrades),[filteredTrades]);
  const fPnl=fStats?fStats.totalProfit:0;
  const fColor=fPnl>=0?T.green:T.red;
  const recent=[...trades].reverse().slice(0,15);

  const symCounts=useMemo(()=>{
    const m={};
    filteredTrades.forEach(t=>{
      if(!m[t.symbol])m[t.symbol]={symbol:t.symbol,count:0,profit:0};
      m[t.symbol].count++;
      m[t.symbol].profit+=(t.profit||0);
    });
    return Object.values(m).sort((a,b)=>b.count-a.count).slice(0,6).map(x=>({...x,profit:+x.profit.toFixed(2)}));
  },[filteredTrades]);

  const avgDurMins=useMemo(()=>{
    const durs=filteredTrades.filter(t=>t.openTime&&t.closeTime).map(t=>{const o=parseMT5Date(t.openTime),c=parseMT5Date(t.closeTime);return o&&c?(c-o)/60000:null;}).filter(Boolean);
    if(!durs.length)return 0;
    return Math.round(durs.reduce((s,v)=>s+v,0)/durs.length);
  },[filteredTrades]);
  const durStr=avgDurMins>0?(avgDurMins<60?avgDurMins+"m":avgDurMins<1440?Math.floor(avgDurMins/60)+"h"+(avgDurMins%60?avgDurMins%60+"m":""):Math.floor(avgDurMins/1440)+"d"):"--";

  const bentoScore=useMemo(()=>{
    if(!fStats)return null;
    let s=50;
    if(fStats.pf>=2)s+=15;else if(fStats.pf>=1.5)s+=10;else if(fStats.pf>=1)s+=5;else s-=10;
    if(fStats.winRate>=60)s+=15;else if(fStats.winRate>=50)s+=8;else s-=5;
    if(fStats.maxDD<5)s+=10;else if(fStats.maxDD<10)s+=5;else if(fStats.maxDD>20)s-=15;
    if(fStats.rr&&parseFloat(fStats.rr)>=1.5)s+=10;else if(fStats.rr&&parseFloat(fStats.rr)>=1)s+=5;
    return Math.max(0,Math.min(100,Math.round(s)));
  },[fStats]);
  const bentoColor=bentoScore===null?T.textDim:bentoScore>=70?T.green:bentoScore>=50?T.amber:T.red;

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>

      {/* HEADER with inline DNA badge */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:3}}>
            <h1 style={{fontSize:22,fontWeight:700,letterSpacing:"-0.5px"}}>Dashboard</h1>
            {fStats&&(()=>{
              const rr=parseFloat(fStats.rr)||0;
              const dnaLabel=fStats.winRate>=60&&rr<1.2?"Sniper":fStats.winRate<45&&rr>=1.5?"Swing Hunter":fStats.winRate>=55&&rr>=1.3?"Balanced":fStats.maxDD>15?"Risk-Taker":fStats.tradesPerDay>6?"Overtrader":"Developing";
              const dnaColor=fStats.totalProfit>=0?T.blue:T.amber;
              const dnaBg=fStats.totalProfit>=0?T.blueBg:T.amberBg;
              const dnaBorder=fStats.totalProfit>=0?"rgba(79,128,255,.3)":"rgba(245,158,11,.3)";
              return <span title="Your trader personality type — derived from your stats" style={{fontSize:11,fontWeight:700,color:dnaColor,background:dnaBg,border:"1px solid "+dnaBorder,borderRadius:6,padding:"3px 10px",cursor:"default",letterSpacing:"0.03em",display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:9,opacity:.7}}>DNA</span>{dnaLabel}
              </span>;
            })()}
          </div>
          <div style={{fontSize:12,color:T.textSub}}>Welcome back — {new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {fStats&&(()=>{
            const todayTrades=trades.filter(t=>mt5Day(t.closeTime)===todayStr);
            const todayPnl=+todayTrades.reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0).toFixed(2);
            const c=todayPnl>=0?T.green:T.red;
            const bg=todayPnl>=0?T.greenBg:T.redBg;
            const border=todayPnl>=0?T.greenBorder:T.redBorder;
            return todayTrades.length>0?<div style={{background:bg,border:"1px solid "+border,borderRadius:20,padding:"3px 12px",fontSize:11,fontWeight:700,color:c,fontFamily:"'JetBrains Mono',monospace"}}>{todayPnl>=0?"+":""}{todayPnl} today</div>:null;
          })()}
          <div style={{display:"flex",alignItems:"center",gap:6,background:serverOk?T.greenBg:T.redBg,border:"1px solid "+(serverOk?T.greenBorder:T.redBorder),borderRadius:20,padding:"3px 12px",fontSize:11,fontWeight:600,color:serverOk?T.green:T.red}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:serverOk?T.green:T.red,animation:serverOk?"none":"pulse 1.5s infinite"}}/>
            {serverOk?"Live":"Offline"}
          </div>
        </div>
      </div>

      {/* PERIOD FILTER — matching screenshot tabs */}
      <div style={{display:"flex",gap:2,marginBottom:16,background:"#fff",borderRadius:10,padding:4,border:"1px solid "+T.border,width:"fit-content",overflowX:"auto"}}>
        {periods.map(p=>(
          <button key={p.k} onClick={()=>setPeriod(p.k)}
            style={{padding:"5px 14px",borderRadius:7,border:"none",cursor:"pointer",fontSize:12,fontWeight:period===p.k?700:400,background:period===p.k?T.blue:"transparent",color:period===p.k?"#fff":T.textSub,transition:"all .15s",whiteSpace:"nowrap"}}>
            {p.l}
          </button>
        ))}
      </div>

      {/* ROW 1: Overall PnL (wide) | Bento Score | Profit Factor | Win Rate */}
      <div style={{display:"grid",gridTemplateColumns:"2fr 1.2fr 1fr 1.2fr",gap:12,marginBottom:12}}>

        {/* Overall P&L — left wide card with sparkline */}
        <div className="card" style={{padding:"18px 20px",overflow:"hidden"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div style={{fontSize:11,color:T.textSub,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Overall P&L</div>
            <div style={{background:T.blueBg,border:"1px solid rgba(79,128,255,.25)",borderRadius:20,padding:"2px 10px",fontSize:11,fontWeight:600,color:T.blue}}>Total Trades: {filteredTrades.length}</div>
          </div>
          <div style={{display:"flex",gap:28,marginTop:8,marginBottom:12}}>
            <div>
              <div style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>$ Gain</div>
              <div style={{fontSize:28,fontWeight:800,color:fColor,fontFamily:"'JetBrains Mono',monospace",letterSpacing:"-1px",lineHeight:1}}>{fPnl>=0?"+":""}{fPnl.toFixed(2)}</div>
            </div>
            <div>
              <div style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>% Gain</div>
              <div style={{fontSize:22,fontWeight:700,color:fColor,fontFamily:"'JetBrains Mono',monospace"}}>{fStats?((fPnl/10000)*100).toFixed(2)+"%":"--"}</div>
            </div>
            <div>
              <div style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>Avg Duration</div>
              <div style={{fontSize:22,fontWeight:700,color:T.text,fontFamily:"'JetBrains Mono',monospace"}}>{durStr}</div>
            </div>
          </div>
          <div style={{height:80,marginLeft:-8,marginRight:-8}}>
            {fStats&&fStats.equity.length>1?(
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fStats.equity} margin={{left:0,right:0,top:2,bottom:0}}>
                  <defs><linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={fColor} stopOpacity={.25}/><stop offset="100%" stopColor={fColor} stopOpacity={0}/></linearGradient></defs>
                  <Area type="monotone" dataKey="bal" stroke={fColor} strokeWidth={2.5} fill="url(#spark)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            ):(
              <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12}}>Connect MT5 EA to see data</div>
            )}
          </div>
        </div>

        {/* Bento Score */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div style={{fontSize:11,color:T.textSub,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>Bento Score</div>
          <div style={{fontSize:11,color:T.textDim,marginBottom:12}}>Custom scoring based on account statistics</div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <div style={{fontSize:30,fontWeight:800,color:bentoColor,fontFamily:"'JetBrains Mono',monospace",lineHeight:1}}>{bentoScore!==null?bentoScore:"--"}</div>
            {bentoScore!==null&&<div style={{background:bentoColor+"20",border:"1px solid "+bentoColor+"40",borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700,color:bentoColor}}>{bentoScore>=70?"Good":bentoScore>=50?"Average":"Needs Work"}</div>}
          </div>
          <div style={{fontSize:11,fontWeight:600,color:T.textSub,marginBottom:8}}>Strategy Values</div>
          {fStats?[
            {l:"Profit Factor",v:fStats.pf},
            {l:"Win Rate",v:fStats.winRate+"%"},
            {l:"Avg Profit Per Trade",v:"$"+(fStats.totalProfit/Math.max(1,fStats.total)).toFixed(2)},
            {l:"PnL",v:"$"+fStats.totalProfit}
          ].map(x=>(
            <div key={x.l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{fontSize:11,color:T.textDim}}>{x.l}</span>
              <span style={{fontSize:11,fontWeight:600,color:T.text,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</span>
            </div>
          )):<div style={{fontSize:12,color:T.textDim,textAlign:"center",paddingTop:12}}>No data</div>}
        </div>

        {/* Profit Factor */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div style={{fontSize:11,color:T.textSub,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>Profit Factor</div>
          <div style={{fontSize:36,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:fStats?(fStats.pf>=1.5?T.green:fStats.pf>=1?T.amber:T.red):T.textDim,marginBottom:16,lineHeight:1.1}}>{fStats?fStats.pf:"--"}</div>
          {fStats&&<>
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.green,fontWeight:600}}>Gross Profit</span>
                <span style={{fontSize:11,fontWeight:700,color:T.green,fontFamily:"'JetBrains Mono',monospace"}}>${fStats.grossProfit.toFixed(2)}</span>
              </div>
              <div style={{height:5,background:T.greenBg,borderRadius:3}}><div style={{height:"100%",width:(fStats.grossProfit/(fStats.grossProfit+fStats.grossLoss||1)*100)+"%",background:`linear-gradient(90deg,${T.blue},${T.green})`,borderRadius:3}}/></div>
            </div>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.red,fontWeight:600}}>Gross Loss</span>
                <span style={{fontSize:11,fontWeight:700,color:T.red,fontFamily:"'JetBrains Mono',monospace"}}>${fStats.grossLoss.toFixed(2)}</span>
              </div>
              <div style={{height:5,background:T.redBg,borderRadius:3}}><div style={{height:"100%",width:(fStats.grossLoss/(fStats.grossProfit+fStats.grossLoss||1)*100)+"%",background:T.red,borderRadius:3}}/></div>
            </div>
          </>}
        </div>

        {/* Win Rate */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div style={{fontSize:11,color:T.textSub,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>Win Rate</div>
          <div style={{fontSize:36,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:fStats?(fStats.winRate>=50?T.green:T.red):T.textDim,marginBottom:14,lineHeight:1.1}}>{fStats?fStats.winRate+"%":"--"}</div>
          {fStats&&<>
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.textSub}}>Wins</span>
                <span style={{fontSize:11,fontWeight:600,color:T.text,fontFamily:"'JetBrains Mono',monospace"}}>{fStats.wins}</span>
              </div>
              <div style={{height:8,background:T.bg,borderRadius:4}}><div style={{height:"100%",width:(fStats.wins/Math.max(1,fStats.total)*100)+"%",background:`linear-gradient(90deg,${T.blue},${T.green})`,borderRadius:4}}/></div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.textSub}}>Losses</span>
                <span style={{fontSize:11,fontWeight:600,color:T.text,fontFamily:"'JetBrains Mono',monospace"}}>{fStats.losses}</span>
              </div>
              <div style={{height:8,background:T.bg,borderRadius:4}}><div style={{height:"100%",width:(fStats.losses/Math.max(1,fStats.total)*100)+"%",background:T.red,borderRadius:4}}/></div>
            </div>
            <div style={{borderTop:"1px solid "+T.border,paddingTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[{l:"Avg Win",v:"$"+fStats.avgWin,c:T.green},{l:"Avg Loss",v:"$"+fStats.avgLoss,c:T.red},{l:"R:R Ratio",v:"1:"+fStats.rr},{l:"Expectancy",v:"$"+fStats.expectancy,c:fStats.expectancy>=0?T.green:T.red}].map(x=>(
                <div key={x.l} style={{background:T.bg,borderRadius:7,padding:"6px 8px"}}>
                  <div style={{fontSize:9,color:T.textDim,marginBottom:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{x.l}</div>
                  <div style={{fontSize:11,fontWeight:700,color:x.c||T.text,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                </div>
              ))}
            </div>
          </>}
        </div>
      </div>

      {/* ROW 2: Daily P&L | Account Growth | Most Traded Symbols */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr 1fr",gap:12,marginBottom:12}}>

        {/* Daily P&L bars */}
        <div className="card" style={{height:260,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,flexShrink:0}}>
            <div style={{fontSize:13,fontWeight:600}}>Daily P&L</div>
            <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Daily and hourly profit</div>
          </div>
          <div style={{flex:1,padding:"8px 4px 4px",minHeight:0}}>
            {fStats&&fStats.dailyPnl&&fStats.dailyPnl.length>0?(
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fStats.dailyPnl} barSize={10} margin={{left:0,right:4,top:8,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                  <XAxis dataKey="date" tick={{fill:T.textDim,fontSize:9}} tickFormatter={d=>d.slice(5)} axisLine={false} tickLine={false} interval={3}/>
                  <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={44}/>
                  <Tooltip content={<ChartTip/>}/>
                  <Bar dataKey="profit" name="P&L" radius={[3,3,0,0]}>{fStats.dailyPnl.map((d,i)=><Cell key={i} fill={d.profit>=0?T.green:T.red} fillOpacity={.85}/>)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            ):<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12}}>No daily data yet</div>}
          </div>
        </div>

        {/* Account Growth */}
        <div className="card" style={{height:260,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600}}>Account Growth</div>
              <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Cumulative growth over time</div>
            </div>
            {fStats&&<span style={{fontSize:13,fontWeight:700,color:fColor,fontFamily:"'JetBrains Mono',monospace"}}>{fPnl>=0?"+":""}{fPnl.toFixed(2)}</span>}
          </div>
          <div style={{flex:1,padding:"8px 4px 4px",minHeight:0}}>
            {fStats&&fStats.equity.length>1?(
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fStats.equity} margin={{left:0,right:4,top:4,bottom:0}}>
                  <defs><linearGradient id="growth" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={fColor} stopOpacity={.22}/><stop offset="100%" stopColor={fColor} stopOpacity={0.02}/></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                  <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={50}/>
                  <Tooltip content={<ChartTip/>}/>
                  <Area type="monotone" dataKey="bal" name="Balance" stroke={fColor} strokeWidth={2.5} fill="url(#growth)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            ):<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12}}>Connect MT5 EA to see growth</div>}
          </div>
        </div>

        {/* Most Traded Symbols */}
        <div className="card" style={{height:260,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,flexShrink:0}}>
            <div style={{fontSize:13,fontWeight:600}}>Most Traded Symbols</div>
            <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Symbol count and total profit</div>
          </div>
          <div style={{flex:1,padding:"8px 4px 4px",minHeight:0}}>
            {symCounts.length>0?(
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={symCounts} barSize={22} margin={{left:0,right:4,top:16,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                  <XAxis dataKey="symbol" tick={{fill:T.textSub,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={s=>s.slice(0,6)}/>
                  <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={24}/>
                  <Tooltip content={<ChartTip/>}/>
                  <Bar dataKey="count" name="Trades" radius={[4,4,0,0]}>{symCounts.map((d,i)=><Cell key={i} fill={d.profit>=0?T.green:T.red} fillOpacity={0.85}/>)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            ):<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12}}>No symbol data yet</div>}
          </div>
        </div>
      </div>

      {/* ROW 3: Calendar heatmap + Recent Trades */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 380px",gap:12}}>

        {/* Calendar heatmap */}
        <div className="card" style={{padding:"16px 18px"}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:14}}>Calendar</div>
          {(()=>{
            const now=new Date(),year=now.getFullYear(),month=now.getMonth();
            const firstDay=new Date(year,month,1),lastDay=new Date(year,month+1,0);
            const startOffset=(firstDay.getDay()+6)%7;
            const days=[];
            for(let i=0;i<startOffset;i++)days.push(null);
            for(let i=1;i<=lastDay.getDate();i++)days.push(new Date(year,month,i));
            const tradesByDay={};
            trades.forEach(t=>{
              const d=mt5Day(t.closeTime);
              if(!d)return;
              if(!tradesByDay[d])tradesByDay[d]={profit:0,count:0};
              tradesByDay[d].profit+=(t.profit||0)+(t.swap||0)+(t.commission||0);
              tradesByDay[d].count++;
            });
            return (
              <>
                <div style={{textAlign:"center",fontSize:13,fontWeight:600,marginBottom:10,color:T.text}}>
                  {now.toLocaleString("default",{month:"long",year:"numeric"})}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:4}}>
                  {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=><div key={d} style={{textAlign:"center",fontSize:10,color:T.textDim,fontWeight:600,padding:"3px 0"}}>{d}</div>)}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
                  {days.map((day,i)=>{
                    if(!day)return <div key={i}/>;
                    const dStr=localDay(day);
                    const td=tradesByDay[dStr];
                    const isToday=dStr===todayStr;
                    const isWe=day.getDay()===0||day.getDay()===6;
                    const hasProfit=td&&td.profit>0;
                    return (
                      <div key={i} style={{
                        display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                        borderRadius:8,
                        background:isToday?T.blueBg:td?(hasProfit?"rgba(0,196,140,0.12)":"rgba(255,91,91,0.1)"):"transparent",
                        border:"1px solid "+(isToday?"rgba(79,128,255,.4)":td?(hasProfit?T.greenBorder:T.redBorder):"transparent"),
                        padding:"6px 2px",minHeight:52,position:"relative"
                      }}>
                        <span style={{fontSize:12,fontWeight:isToday?700:400,color:isToday?T.blue:isWe?T.textDim:T.text,lineHeight:1}}>{day.getDate()}</span>
                        {td&&<>
                          <span style={{fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:hasProfit?T.green:T.red,fontWeight:700,lineHeight:1,marginTop:2}}>{hasProfit?"+":""}{td.profit.toFixed(0)}</span>
                          <span style={{fontSize:9,color:T.textDim,lineHeight:1,marginTop:1}}>{td.count}t</span>
                        </>}
                        {td&&<div style={{position:"absolute",top:3,right:3,width:4,height:4,borderRadius:"50%",background:hasProfit?T.green:T.red}}/>}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>

        {/* Recent Trades */}
        <div className="card" style={{overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:400}}>
          <div style={{padding:"14px 16px",borderBottom:"1px solid "+T.border,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600}}>Recent Trades</div>
              <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Last 15 trades</div>
            </div>
            <span style={{fontSize:11,color:T.textDim,fontFamily:"'JetBrains Mono',monospace"}}>{trades.length} total</span>
          </div>
          <div style={{overflowY:"auto",flex:1}}>
            {recent.length===0&&<div style={{padding:24,textAlign:"center",color:T.textDim,fontSize:12}}>No trades yet — connect your MT5 EA</div>}
            {recent.length>0&&(
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,zIndex:1}}>
                  <tr style={{background:T.bg}}>
                    {["Symbol","Type","Size","Profit"].map((h,i)=>(
                      <th key={i} style={{padding:"7px 12px",fontSize:10,color:T.textDim,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",textAlign:i>=2?"right":"left"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t,i)=>{
                    const pnl=(t.profit||0)+(t.swap||0)+(t.commission||0);
                    return (
                      <tr key={i} className="trow">
                        <td style={{padding:"8px 12px",fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace",color:T.text}}>{t.symbol}</td>
                        <td style={{padding:"8px 12px"}}><Badge color={t.type==="buy"||t.type==="BUY"?"green":"red"}>{(t.type||"").slice(0,4).toUpperCase()}</Badge></td>
                        <td style={{padding:"8px 12px",textAlign:"right",fontSize:11,color:T.textSub,fontFamily:"'JetBrains Mono',monospace"}}>{t.lots||t.volume||"--"}</td>
                        <td style={{padding:"8px 12px",textAlign:"right",fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:pnl>=0?T.green:T.red}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


// ── PRICE ALERTS (standalone component — hooks at top level) ──
function PriceAlerts({watchlist, prices}){
  const [alertSym,setAlertSym]=useState(watchlist[0]||"");
  const [alertPrice,setAlertPrice]=useState("");
  const [alertDir,setAlertDir]=useState("above");
  const [alerts,setAlerts]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_price_alerts")||"[]");}catch{return[];}});

  // Keep alertSym in sync when watchlist changes
  useEffect(()=>{if(!alertSym&&watchlist[0])setAlertSym(watchlist[0]);},[watchlist]);

  // Check alerts against live prices
  useEffect(()=>{
    if(!alerts.length)return;
    let changed=false;
    const next=alerts.map(al=>{
      if(al.triggered)return al;
      const q=prices[al.sym];if(!q?.price)return al;
      const cur=parseFloat(q.price);
      const hit=(al.dir==="above"&&cur>=al.price)||(al.dir==="below"&&cur<=al.price);
      if(hit){
        changed=true;
        if(Notification.permission==="granted"){
          try{new Notification("TradeLedger Alert",{body:al.sym+" hit $"+al.price+" — now $"+cur});}catch{}
        }
        return{...al,triggered:true};
      }
      return al;
    });
    if(changed){setAlerts(next);try{localStorage.setItem("tl_price_alerts",JSON.stringify(next));}catch{}}
  },[prices]);

  const saveAlert=()=>{
    if(!alertSym||!alertPrice)return;
    const a={id:Date.now(),sym:alertSym,price:parseFloat(alertPrice),dir:alertDir,triggered:false};
    const next=[...alerts,a];setAlerts(next);
    try{localStorage.setItem("tl_price_alerts",JSON.stringify(next));}catch{}
    setAlertPrice("");
    if(Notification.permission==="default")Notification.requestPermission();
  };
  const removeAlert=id=>{
    const next=alerts.filter(a=>a.id!==id);
    setAlerts(next);try{localStorage.setItem("tl_price_alerts",JSON.stringify(next));}catch{}
  };

  return (
    <div className="card" style={{padding:"16px 18px"}}>
      <div style={{fontSize:13,fontWeight:600,marginBottom:3}}>Price Alerts</div>
      <div style={{fontSize:11,color:T.textSub,marginBottom:12}}>Get a browser notification when any symbol crosses your target price</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 90px 120px auto",gap:8,alignItems:"end",marginBottom:alerts.length?12:0}}>
        <div>
          <div style={{fontSize:10,color:T.textDim,marginBottom:3}}>Symbol</div>
          <select className="input" value={alertSym} onChange={e=>setAlertSym(e.target.value)} style={{fontSize:12}}>
            {watchlist.map(s=><option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:T.textDim,marginBottom:3}}>Direction</div>
          <select className="input" value={alertDir} onChange={e=>setAlertDir(e.target.value)} style={{fontSize:12}}>
            <option value="above">Above</option>
            <option value="below">Below</option>
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:T.textDim,marginBottom:3}}>Target Price</div>
          <input className="input" type="number" step="any" placeholder="e.g. 1.1000"
            value={alertPrice} onChange={e=>setAlertPrice(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter")saveAlert();}}
            style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}/>
        </div>
        <button className="btn btn-primary" onClick={saveAlert} disabled={!alertPrice||!alertSym} style={{fontSize:11}}>+ Alert</button>
      </div>
      {alerts.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:5,marginTop:10}}>
          {alerts.map(al=>{
            const q=prices[al.sym],cur=q?parseFloat(q.price):null;
            const pct=cur?+((cur-al.price)/al.price*100).toFixed(2):null;
            return (
              <div key={al.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,background:al.triggered?T.greenBg:T.bg,border:"1px solid "+(al.triggered?T.greenBorder:T.border)}}>
                <div style={{flex:1}}>
                  <span style={{fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{al.sym}</span>
                  <span style={{fontSize:11,color:T.textSub,marginLeft:6}}>{al.dir} ${al.price}</span>
                  {pct!==null&&!al.triggered&&<span style={{fontSize:10,color:Math.abs(pct)<0.5?T.amber:T.textDim,marginLeft:6}}>{pct>=0?"+":""}{pct}% away</span>}
                </div>
                {al.triggered?<Badge color="green">Triggered</Badge>:<span style={{fontSize:10,color:T.textDim}}>Watching</span>}
                <button onClick={()=>removeAlert(al.id)} style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:15,lineHeight:1,padding:"0 2px"}}>x</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── TRADINGVIEW MODAL ─────────────────────────────────────────────────────
function TVModal({symbol, onClose}){
  // Map MT5 symbols to TradingView format
  const tvMap = {
    "EURUSD":"FX:EURUSD","GBPUSD":"FX:GBPUSD","USDJPY":"FX:USDJPY","USDCHF":"FX:USDCHF",
    "AUDUSD":"FX:AUDUSD","NZDUSD":"FX:NZDUSD","USDCAD":"FX:USDCAD","GBPJPY":"FX:GBPJPY",
    "EURJPY":"FX:EURJPY","EURGBP":"FX:EURGBP","XAUUSD":"OANDA:XAUUSD","XAGUSD":"OANDA:XAGUSD",
    "BTCUSD":"BITSTAMP:BTCUSD","ETHUSD":"BITSTAMP:ETHUSD","SOLUSD":"BINANCE:SOLUSDT",
    "BNBUSD":"BINANCE:BNBUSDT","NAS100":"NASDAQ:NDX","SPX500":"SP:SPX",
    "US30":"DJ:DJI","USOIL":"TVC:USOIL","UKOIL":"TVC:UKOIL",
  };
  const tvSym = tvMap[symbol] || (symbol.length===6?"FX:"+symbol.slice(0,3)+symbol.slice(3,6):symbol);
  const isDark = T.bg==="#0e1117";
  const theme = isDark?"dark":"light";
  // Use TradingView embed URL — works without loading external scripts
  const src = "https://www.tradingview.com/widgetembed/?frameElementId=tv_widget&symbol="+encodeURIComponent(tvSym)+"&interval=60&hidesidetoolbar=0&hidetoptoolbar=0&symboledit=1&saveimage=0&toolbarbg="+(isDark?"1C2030":"f1f3f6")+"&studies=[]&theme="+theme+"&style=1&timezone=Etc%2FUTC&locale=en";

  // Close on Escape key
  useEffect(()=>{
    const h=e=>{if(e.key==="Escape")onClose();};
    window.addEventListener("keydown",h);
    return()=>window.removeEventListener("keydown",h);
  },[onClose]);

  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:"fixed",inset:0,zIndex:2000,background:"rgba(0,0,0,.75)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:T.surface,borderRadius:16,border:"1px solid "+T.border,width:"min(1100px,96vw)",height:"min(680px,92vh)",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 40px 100px rgba(0,0,0,.5)"}}>
        <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{symbol}</span>
            <span style={{fontSize:10,color:T.textDim,background:T.bg,border:"1px solid "+T.border,borderRadius:5,padding:"2px 7px"}}>TradingView · 1H</span>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <a href={"https://www.tradingview.com/chart/?symbol="+encodeURIComponent(tvSym)} target="_blank" rel="noopener noreferrer"
              style={{fontSize:11,color:T.blue,textDecoration:"none",fontWeight:600}}>Open in TradingView</a>
            <button onClick={onClose} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:T.textDim,lineHeight:1,padding:"0 4px",display:"flex",alignItems:"center"}}>×</button>
          </div>
        </div>
        <iframe src={src} style={{flex:1,border:"none",minHeight:0}} allowTransparency="true" scrolling="no"/>
      </div>
    </div>
  );
}

// ── WATCHLIST ─────────────────────────────────────────────────
function WatchlistTab({watchlist,prices,pFlash,onAddSymbol,onRemoveSymbol,analyseSymbol,trades}){
  const [pickerOpen,setPickerOpen]=useState(false);
  const [tvSym,setTvSym]=useState(null);
  const [pickerCat,setPickerCat]=useState("Forex");
  const [selectedSym,setSelectedSym]=useState(null);
  const [sizerOpen,setSizerOpen]=useState(false);
  const [sizerSym,setSizerSym]=useState("");
  const [sizerAccount,setSizerAccount]=useState("10000");
  const [sizerRisk,setSizerRisk]=useState("1");
  const [sizerSlPips,setSizerSlPips]=useState("20");
  const [indicators,setIndicators]=useState({});
  const [sparklines,setSparklines]=useState({});
  const [indInterval,setIndInterval]=useState("1h");

  // Fetch real RSI+EMA from Twelve Data for selected symbol
  useEffect(()=>{
    if(!selectedSym)return;
    const load=async()=>{
      try{
        const r=await fetch(SERVER+"/api/indicators?symbol="+selectedSym+"&interval="+indInterval,{signal:AbortSignal.timeout(12000)});
        if(r.ok){const d=await r.json();setIndicators(prev=>({...prev,[selectedSym+indInterval]:d}));}
      }catch{}
      try{
        const r=await fetch(SERVER+"/api/sparkline?symbol="+selectedSym+"&interval="+indInterval+"&bars=48",{signal:AbortSignal.timeout(12000)});
        if(r.ok){const d=await r.json();setSparklines(prev=>({...prev,[selectedSym+indInterval]:d.candles||[]}));}
      }catch{}
    };
    load();
  },[selectedSym,indInterval]);

  // Streak analysis
  const getStreak=(sym)=>{
    const symTrades=[...trades].filter(t=>t.symbol===sym).reverse();
    if(!symTrades.length)return null;
    let streak=0,type=symTrades[0].profit>0?"W":"L";
    for(const t of symTrades){if((t.profit>0&&type==="W")||(t.profit<=0&&type==="L"))streak++;else break;}
    return{streak,type};
  };

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      {tvSym&&<TVModal symbol={tvSym} onClose={()=>setTvSym(null)}/>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Watchlist</h1>
          {(()=>{
            const alertCount=JSON.parse(localStorage.getItem("tl_price_alerts")||"[]").filter(a=>!a.triggered).length;
            return <span title="Price alerts active" style={{fontSize:11,fontWeight:700,color:alertCount>0?T.amber:T.textDim,background:alertCount>0?T.amberBg:T.bg,border:"1px solid "+(alertCount>0?"rgba(245,158,11,.3)":T.border),borderRadius:6,padding:"3px 10px",cursor:"default",display:"flex",alignItems:"center",gap:5,letterSpacing:"0.03em"}}>
              <span style={{fontSize:9,opacity:.7}}>ALERTS</span>{alertCount>0?alertCount+" active":"none"}
            </span>;
          })()}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {(()=>{
            const now=new Date(),u=now.getUTCHours()*60+now.getUTCMinutes();
            const sess=[{n:"Sydney",c:T.cyan,open:21*60,close:6*60,ov:true},{n:"Tokyo",c:T.amber,open:0,close:9*60,ov:false},{n:"London",c:T.green,open:8*60,close:17*60,ov:false},{n:"New York",c:T.purple,open:13*60,close:22*60,ov:false}];
            const active=sess.filter(s=>s.ov?(u>=s.open||u<s.close):(u>=s.open&&u<s.close));
            if(!active.length)return <span style={{fontSize:10,color:T.textDim,background:T.bg,border:"1px solid "+T.border,borderRadius:6,padding:"3px 8px"}}>No session</span>;
            return <div style={{display:"flex",gap:4}}>{active.map(s=><span key={s.n} style={{fontSize:10,fontWeight:600,color:s.c,background:s.c+"15",border:"1px solid "+s.c+"30",borderRadius:6,padding:"3px 8px"}}>{s.n}</span>)}</div>;
          })()}
          <button className="btn" onClick={()=>setSizerOpen(p=>!p)}>Position Sizer</button>
          <button className="btn btn-primary" onClick={()=>setPickerOpen(p=>!p)}>+ Add Symbol</button>
        </div>
      </div>

      {/* POSITION SIZER */}
      {sizerOpen&&(()=>{
        const sizerInfo=getAssetInfo(sizerSym||watchlist[0]||"EURUSD");
        const pipVal=sizerInfo.pip;
        const slPips=sizerSlPips?parseFloat(sizerSlPips):0;
        const acctSize=sizerAccount?parseFloat(sizerAccount):10000;
        const riskPct=sizerRisk?parseFloat(sizerRisk):1;
        const riskAmt=acctSize*(riskPct/100);
        const pipValue=pipVal<0.01?0.01:pipVal<0.1?0.1:1;
        const lots=slPips>0?(riskAmt/(slPips*pipValue/pipVal*10)).toFixed(2):0;
        const maxLoss=(lots*(slPips*pipValue/pipVal*10)).toFixed(2);
        return (
          <div className="card" style={{padding:"16px 18px",marginBottom:14,background:"linear-gradient(135deg,rgba(79,128,255,.04),rgba(139,92,246,.04))"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:600}}>Position Sizer <span style={{fontSize:11,color:T.textDim,fontWeight:400}}>— never risk more than you plan</span></div>
              <button onClick={()=>setSizerOpen(false)} style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:18,lineHeight:1}}>x</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr auto",gap:10,alignItems:"end"}}>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Symbol</div>
                <select className="input" value={sizerSym||watchlist[0]||""} onChange={e=>setSizerSym(e.target.value)} style={{fontSize:12}}>
                  {watchlist.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Account ($)</div>
                <input className="input" type="number" placeholder="10000" value={sizerAccount} onChange={e=>setSizerAccount(e.target.value)} style={{fontSize:12}}/>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Risk %</div>
                <input className="input" type="number" placeholder="1" step="0.1" value={sizerRisk} onChange={e=>setSizerRisk(e.target.value)} style={{fontSize:12}}/>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Stop Loss (pips)</div>
                <input className="input" type="number" placeholder="20" value={sizerSlPips} onChange={e=>setSizerSlPips(e.target.value)} style={{fontSize:12}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <div style={{background:T.blueBg,border:"1px solid rgba(79,128,255,.25)",borderRadius:8,padding:"8px 16px",textAlign:"center"}}>
                  <div style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>Lot Size</div>
                  <div style={{fontSize:20,fontWeight:800,color:T.blue,fontFamily:"'JetBrains Mono',monospace"}}>{lots}</div>
                </div>
              </div>
            </div>
            {lots>0&&<div style={{marginTop:10,fontSize:11,color:T.textSub}}>
              Risk: <strong style={{color:T.red}}>${maxLoss}</strong> ({riskPct}% of ${acctSize.toFixed(0)}) &nbsp;·&nbsp;
              Pip value: ~${pipValue.toFixed(2)}/pip &nbsp;·&nbsp;
              {parseFloat(lots)>0.1?<span style={{color:T.amber}}>Standard lot</span>:<span style={{color:T.green}}>Micro lot</span>}
            </div>}
          </div>
        );
      })()}

      {pickerOpen&&(
        <div className="card" style={{padding:14,flexShrink:0}}>
          <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
            {Object.keys(WL_SYMBOLS).map(cat=><button key={cat} className="btn" style={{fontSize:11,background:pickerCat===cat?T.blue:"",borderColor:pickerCat===cat?T.blue:"",color:pickerCat===cat?"#fff":""}} onClick={()=>setPickerCat(cat)}>{cat}</button>)}
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {WL_SYMBOLS[pickerCat]?.filter(s=>!watchlist.includes(s)).map(s=><button key={s} className="btn" style={{fontSize:11,padding:"3px 9px",fontFamily:"'JetBrains Mono',monospace"}} onClick={()=>{onAddSymbol(s);}}>{s}</button>)}
          </div>
        </div>
      )}

      {/* Two column layout: price list + analysis panel */}
      <div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:12,minHeight:400}}>
        {/* Left: price table */}
        <div className="card" style={{overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:480}}>
          <div style={{padding:"10px 14px",borderBottom:`1px solid ${T.border}`,flexShrink:0,background:T.bg}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 90px 70px 28px",gap:4}}>
              {["Symbol","Price","24h %",""].map((h,i)=><div key={i} style={{fontSize:10,color:T.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>0?"right":"left"}}>{h}</div>)}
            </div>
          </div>
          <div style={{overflowY:"auto",flex:1}}>
            {watchlist.map(sym=>{
              const q=prices[sym],flash=pFlash[sym],chg=parseFloat(q?.changePct),isUp=chg>0,isDown=chg<0;
              const a=analyseSymbol(sym),info=getAssetInfo(sym);
              const streak=getStreak(sym);
              const isSelected=selectedSym===sym;
              return (
                <div key={sym} className="trow" onClick={()=>setSelectedSym(isSelected?null:sym)} style={{cursor:"pointer",padding:"10px 14px",display:"grid",gridTemplateColumns:"1fr 90px 70px 28px",gap:4,alignItems:"center",background:isSelected?T.blueBg:flash?(flash==="up"?"rgba(0,196,140,0.04)":"rgba(255,91,91,0.04)"):"transparent",borderLeft:isSelected?`3px solid ${T.blue}`:"3px solid transparent"}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:28,height:28,borderRadius:7,background:T.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:T.textSub,fontFamily:"'JetBrains Mono',monospace",flexShrink:0}}>{sym.slice(0,3)}</div>
                      <div>
                        <div style={{fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{sym}</div>
                        <div style={{fontSize:9,color:T.textDim}}>{info.name}</div>
                      </div>
                    </div>
                    {a&&<div style={{display:"flex",gap:4,marginTop:3,marginLeft:34}}>
                      <span style={{fontSize:9,fontWeight:700,color:a.signal==="BUY"?T.green:a.signal==="SELL"?T.red:T.purple,background:a.signal==="BUY"?T.greenBg:a.signal==="SELL"?T.redBg:T.purpleBg,padding:"1px 5px",borderRadius:3}}>{a.signal}</span>
                      {streak&&<span style={{fontSize:9,color:streak.type==="W"?T.green:T.red,fontWeight:600}}>{streak.streak}{streak.type} streak</span>}
                    </div>}
                  </div>
                  <div style={{textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>
                    {q?<span style={{fontSize:12,fontWeight:600,color:isUp?T.green:isDown?T.red:T.text}}>{q.price}</span>:<span className="skeleton" style={{width:60,height:13,display:"inline-block"}}/>}
                  </div>
                  <div style={{textAlign:"right"}}>
                    {q?<Badge color={isUp?"green":isDown?"red":"gray"}>{isUp?"+":""}{q.changePct}%</Badge>:<span className="skeleton" style={{width:36,height:17,display:"inline-block",borderRadius:4}}/>}
                  </div>
                  <div style={{textAlign:"right",display:"flex",gap:4,justifyContent:"flex-end"}}>
                    <button onClick={e=>{e.stopPropagation();setTvSym(sym);}} style={{background:"none",border:"none",color:T.blue,cursor:"pointer",fontSize:11,padding:2,lineHeight:1,fontWeight:600}}>TV</button>
                    <button onClick={e=>{e.stopPropagation();onRemoveSymbol(sym);}} style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:15,padding:2,lineHeight:1}}>x</button>
                  </div>
                </div>
              );
            })}
            {watchlist.length===0&&<div style={{padding:32,textAlign:"center",color:T.textDim,fontSize:12}}>Add symbols to track live prices</div>}
            {watchlist.length>0&&<div style={{padding:"6px 14px",borderTop:"1px solid "+T.border,fontSize:9,color:T.textDim,textAlign:"center",letterSpacing:"0.03em"}}>Press D·W·A·X·J·C·N·S to switch tabs</div>}
          </div>

          {/* CORRELATION MATRIX */}
          {watchlist.length>=3&&(()=>{
            // Build correlation from recent trades by symbol
            // Use price change % from prices prop as proxy for same-day moves
            const syms=watchlist.slice(0,6);
            // For each pair, compute correlation from last 30 daily changes in prices
            // Since we only have current price, use known structural correlations as baseline
            // then overlay with actual trade profit direction correlations
            const KNOWN={
              "EURUSD-GBPUSD":0.89,"EURUSD-AUDUSD":0.72,"EURUSD-NZDUSD":0.68,
              "EURUSD-USDJPY":-0.78,"EURUSD-USDCHF":-0.92,"EURUSD-USDCAD":-0.61,
              "GBPUSD-AUDUSD":0.65,"GBPUSD-USDJPY":-0.71,"GBPUSD-USDCHF":-0.85,
              "USDJPY-USDCHF":0.82,"USDJPY-USDCAD":0.58,"AUDUSD-NZDUSD":0.88,
              "XAUUSD-USDJPY":-0.45,"XAUUSD-USDCHF":-0.38,"XAUUSD-EURUSD":0.42,
              "BTCUSD-ETHUSD":0.94,"BTCUSD-SOLUSD":0.87,"ETHUSD-SOLUSD":0.91,
              "NAS100-SPX500":0.96,"NAS100-US30":0.88,"SPX500-US30":0.93,
              "USOIL-USDCAD":-0.62,"USOIL-NZDUSD":0.31,
            };
            const getCorr=(a,b)=>{
              const key1=a+"-"+b, key2=b+"-"+a;
              if(a===b)return 1;
              // Check trades for same-day correlation
              const tradeCorr=(()=>{
                if(!trades.length)return null;
                const days=[...new Set(trades.map(t=>mt5Day(t.closeTime)).filter(Boolean))].slice(-30);
                if(days.length<5)return null;
                const seriesA=[], seriesB=[];
                days.forEach(d=>{
                  const ta=trades.filter(t=>mt5Day(t.closeTime)===d&&t.symbol===a);
                  const tb=trades.filter(t=>mt5Day(t.closeTime)===d&&t.symbol===b);
                  if(ta.length&&tb.length){
                    seriesA.push(ta.reduce((s,t)=>s+(t.profit||0),0));
                    seriesB.push(tb.reduce((s,t)=>s+(t.profit||0),0));
                  }
                });
                if(seriesA.length<4)return null;
                const meanA=seriesA.reduce((s,v)=>s+v,0)/seriesA.length;
                const meanB=seriesB.reduce((s,v)=>s+v,0)/seriesB.length;
                const num=seriesA.reduce((s,v,i)=>s+(v-meanA)*(seriesB[i]-meanB),0);
                const denA=Math.sqrt(seriesA.reduce((s,v)=>s+(v-meanA)**2,0));
                const denB=Math.sqrt(seriesB.reduce((s,v)=>s+(v-meanB)**2,0));
                return(denA&&denB)?+(num/(denA*denB)).toFixed(2):null;
              })();
              if(tradeCorr!==null)return tradeCorr;
              return KNOWN[key1]??KNOWN[key2]??0;
            };
            const corrColor=v=>{
              if(v===1)return T.blue;
              if(v>0.7)return T.red;
              if(v>0.4)return T.amber;
              if(v>-0.4)return T.green;
              if(v>-0.7)return T.cyan;
              return T.purple;
            };
            const corrBg=v=>{
              const abs=Math.abs(v);
              if(v===1)return"rgba(79,128,255,.2)";
              const intensity=Math.round(abs*180);
              return v>0?"rgba(255,91,91,"+abs*0.35+")":"rgba(0,196,140,"+abs*0.35+")";
            };
            return(
              <div className="card" style={{overflow:"hidden",marginTop:0}}>
                <div style={{padding:"11px 14px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:600}}>Correlation Matrix</div>
                    <div style={{fontSize:10,color:T.textDim,marginTop:1}}>How your symbols move together · red = correlated, green = uncorrelated</div>
                  </div>
                </div>
                <div style={{padding:"12px",overflowX:"auto"}}>
                  <table style={{borderCollapse:"collapse",fontSize:10,width:"100%"}}>
                    <thead>
                      <tr>
                        <td style={{padding:"4px 6px"}}/>
                        {syms.map(s=><th key={s} style={{padding:"4px 6px",fontWeight:700,color:T.textSub,textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:9}}>{s.slice(0,6)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {syms.map(a=>(
                        <tr key={a}>
                          <th style={{padding:"4px 6px",fontWeight:700,color:T.textSub,textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontSize:9,whiteSpace:"nowrap"}}>{a.slice(0,6)}</th>
                          {syms.map(b=>{
                            const v=getCorr(a,b);
                            return(
                              <td key={b} style={{padding:"3px",textAlign:"center"}}>
                                <div style={{width:44,height:36,borderRadius:6,background:corrBg(v),display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"default",transition:"transform .1s"}}
                                  title={a+" vs "+b+": "+(v*100).toFixed(0)+"% correlation"}>
                                  <div style={{fontSize:10,fontWeight:700,color:corrColor(v),fontFamily:"'JetBrains Mono',monospace"}}>{v===1?"—":(v>0?"+":"")+v.toFixed(2)}</div>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{display:"flex",gap:12,marginTop:10,flexWrap:"wrap"}}>
                    {[{c:T.red,l:"0.7+ Highly correlated (avoid doubling up)"},
                      {c:T.amber,l:"0.4–0.7 Moderate correlation"},
                      {c:T.green,l:"−0.4 to 0.4 Low correlation (diversified)"},
                      {c:T.cyan,l:"−0.7 to −0.4 Inverse"},
                    ].map(x=>(
                      <div key={x.l} style={{display:"flex",alignItems:"center",gap:5}}>
                        <div style={{width:8,height:8,borderRadius:2,background:x.c,flexShrink:0}}/>
                        <span style={{fontSize:9,color:T.textDim}}>{x.l}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* keep existing keyboard hint (already there, just close the watchlist symbol list div) */}
          <div style={{display:"none"}}>
          </div>
        </div>

        {/* Right: analysis panel */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {selectedSym?(()=>{
            const a=analyseSymbol(selectedSym);
            const info=getAssetInfo(selectedSym);
            const q=prices[selectedSym];
            const symTrades=trades.filter(t=>t.symbol===selectedSym);
            const symWins=symTrades.filter(t=>t.profit>0);
            if(!a)return <div className="card" style={{padding:32,textAlign:"center",color:T.textDim,fontSize:13}}>Waiting for live price data...</div>;
            const isBull=a.signal==="BUY",isBear=a.signal==="SELL",sc=isBull?T.green:isBear?T.red:T.purple;
            return (
              <>
                {/* Signal header */}
                <div className="card" style={{padding:"18px 20px",position:"relative",overflow:"hidden"}}>
                  <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,background:sc}}/>
                  <div style={{paddingLeft:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                      <div>
                        <div style={{fontSize:16,fontWeight:700}}>{info.name} <span style={{fontSize:12,color:T.textSub,fontWeight:400}}>({selectedSym})</span></div>
                        <div style={{display:"flex",alignItems:"baseline",gap:10,marginTop:4}}>
                          <span style={{fontSize:26,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",letterSpacing:"-1px",color:T.text}}>{a.fmtP(a.price)}</span>
                          <span style={{fontSize:13,fontWeight:600,color:a.changePct>=0?T.green:T.red}}>{a.changePct>=0?"+":""}{a.changePct.toFixed(2)}%</span>
                        </div>
                      </div>
                      <div style={{background:isBull?T.greenBg:isBear?T.redBg:T.purpleBg,border:`1px solid ${isBull?T.greenBorder:isBear?T.redBorder:"rgba(139,92,246,.3)"}`,borderRadius:8,padding:"6px 14px",fontSize:13,fontWeight:800,color:sc,letterSpacing:"0.05em"}}>{a.signal}</div>
                    </div>
                    {/* Day range bar */}
                    <div style={{marginBottom:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:4}}><span>Low {a.fmtP(a.low)}</span><span>High {a.fmtP(a.high)}</span></div>
                      <div style={{height:5,background:T.bg,borderRadius:3,position:"relative"}}>
                        <div style={{position:"absolute",left:0,top:0,bottom:0,width:(a.rangePct*100)+"%",background:`linear-gradient(90deg,${T.red}50,${sc})`,borderRadius:3}}/>
                        <div style={{position:"absolute",top:"50%",left:(a.rangePct*100)+"%",transform:"translate(-50%,-50%)",width:10,height:10,borderRadius:"50%",background:sc,border:"2px solid #fff",boxShadow:"0 1px 4px rgba(0,0,0,.15)"}}/>
                      </div>
                    </div>
                    {/* S/T/R */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                      {[{l:"Support",v:a.fmtP(a.support),c:T.green,bg:T.greenBg},{l:"Target",v:a.fmtP(a.target),c:sc,bg:isBull?T.greenBg:isBear?T.redBg:T.purpleBg},{l:"Resistance",v:a.fmtP(a.resistance),c:T.red,bg:T.redBg}].map(lv=>(
                        <div key={lv.l} style={{background:lv.bg,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                          <div style={{fontSize:9,color:T.textDim,marginBottom:3,textTransform:"uppercase",letterSpacing:"0.05em"}}>{lv.l}</div>
                          <div style={{fontSize:12,fontWeight:700,color:lv.c,fontFamily:"'JetBrains Mono',monospace"}}>{lv.v}</div>
                        </div>
                      ))}
                    </div>
                    {/* Confidence */}
                    <div style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:4}}>
                        <span>Signal Confidence</span>
                        <span style={{fontWeight:600,color:a.confidence>=70?T.green:a.confidence>=55?T.amber:T.textDim}}>{a.confidence>=70?"Strong":a.confidence>=55?"Moderate":"Weak"} — {a.confidence}%</span>
                      </div>
                      <div style={{height:4,background:T.bg,borderRadius:2}}><div style={{height:"100%",width:a.confidence+"%",background:a.confidence>=70?T.green:a.confidence>=55?T.amber:T.textDim,borderRadius:2,transition:"width .6s"}}/></div>
                    </div>
                    {/* Interval selector */}
                    <div style={{display:"flex",gap:4,marginBottom:10}}>
                      {["15min","1h","4h","1day"].map(iv=>(
                        <button key={iv} onClick={()=>setIndInterval(iv)} style={{padding:"3px 10px",borderRadius:6,border:"none",cursor:"pointer",fontSize:10,fontWeight:indInterval===iv?700:400,background:indInterval===iv?T.blue:"transparent",color:indInterval===iv?"#fff":T.textSub,transition:"all .12s"}}>{iv}</button>
                      ))}
                    </div>
                    {/* Real RSI + EMA from Twelve Data */}
                    {(()=>{
                      const ind=indicators[selectedSym+indInterval];
                      if(!ind||ind.error)return <div style={{fontSize:11,color:T.textDim,marginBottom:10}}>Loading indicators... (requires Twelve Data key)</div>;
                      const rsiN=parseFloat(ind.rsi||50);
                      const rsiColor=rsiN>=70?T.red:rsiN<=30?T.green:T.amber;
                      const macdBull=ind.macd&&ind.macdSignal&&parseFloat(ind.macd)>parseFloat(ind.macdSignal);
                      return (
                        <div style={{marginBottom:12}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:8}}>
                            {[
                              {l:"RSI(14)",v:ind.rsi||"--",c:rsiColor,note:rsiN>=70?"Overbought":rsiN<=30?"Oversold":"Neutral"},
                              {l:"EMA 20",v:ind.ema20?parseFloat(ind.ema20).toFixed(4):"--",c:T.blue},
                              {l:"EMA 50",v:ind.ema50?parseFloat(ind.ema50).toFixed(4):"--",c:T.purple},
                              {l:"MACD",v:macdBull?"Bullish":"Bearish",c:macdBull?T.green:T.red},
                            ].map(x=>(
                              <div key={x.l} style={{background:T.bg,borderRadius:7,padding:"6px 8px",textAlign:"center"}}>
                                <div style={{fontSize:8,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>{x.l}</div>
                                <div style={{fontSize:11,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                                {x.note&&<div style={{fontSize:8,color:x.c,marginTop:1}}>{x.note}</div>}
                              </div>
                            ))}
                          </div>
                          {/* Real signal from TD indicators */}
                          {ind.signal&&ind.signal!=="HOLD"&&<div style={{fontSize:11,color:T.textSub,background:T.bg,borderRadius:7,padding:"6px 10px",borderLeft:"3px solid "+(ind.signal==="BUY"?T.green:T.red)}}>
                            Real signal ({indInterval}): <strong style={{color:ind.signal==="BUY"?T.green:T.red}}>{ind.signal}</strong> — confidence {ind.confidence}% based on RSI + EMA crossover{ind.macd?" + MACD":""}
                          </div>}
                        </div>
                      );
                    })()}
                    {/* Catalyst */}
                    <div style={{fontSize:12,color:T.textSub,lineHeight:1.65,borderLeft:`3px solid ${sc}40`,paddingLeft:10}}>{a.catalyst}</div>
                  </div>
                </div>
                {/* Sparkline OHLCV chart */}
                {sparklines[selectedSym+indInterval]?.length>4&&(()=>{
                  const candles=sparklines[selectedSym+indInterval];
                  const closes=candles.map(c=>c.c);
                  const minC=Math.min(...closes),maxC=Math.max(...closes),range=maxC-minC||1;
                  const W=400,H=80,pad=4;
                  const x=(i)=>pad+(i/(candles.length-1))*(W-pad*2);
                  const y=(v)=>H-pad-(v-minC)/range*(H-pad*2);
                  const isUp=closes[closes.length-1]>=closes[0];
                  const lineColor=isUp?T.green:T.red;
                  const points=closes.map((c,i)=>x(i)+","+y(c)).join(" ");
                  const areaPoints="0,"+H+" "+points+" "+x(closes.length-1)+","+H;
                  return (
                    <div className="card" style={{overflow:"hidden",marginBottom:12}}>
                      <div style={{padding:"8px 14px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <span style={{fontSize:11,fontWeight:600}}>{selectedSym} · {indInterval} chart</span>
                        <span style={{fontSize:10,color:T.textDim}}>{candles.length} bars · Twelve Data</span>
                      </div>
                      <div style={{padding:"8px 4px 4px",background:T.bg}}>
                        <svg viewBox={"0 0 "+W+" "+H} style={{width:"100%",height:80,display:"block"}}>
                          <defs>
                            <linearGradient id={"sg"+selectedSym} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={lineColor} stopOpacity="0.25"/>
                              <stop offset="100%" stopColor={lineColor} stopOpacity="0.02"/>
                            </linearGradient>
                          </defs>
                          <polygon points={areaPoints} fill={"url(#sg"+selectedSym+")"} />
                          <polyline points={points} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round"/>
                          {/* Current price dot */}
                          <circle cx={x(closes.length-1)} cy={y(closes[closes.length-1])} r="3" fill={lineColor} stroke={T.surface} strokeWidth="1.5"/>
                        </svg>
                      </div>
                    </div>
                  );
                })()}

                {/* How to trade */}
                <div className="card" style={{padding:"16px 18px"}}>
                  <div style={{fontSize:12,fontWeight:600,color:sc,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em"}}>How to Trade This</div>
                  {a.steps.map((step,si)=>(
                    <div key={si} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:si<a.steps.length-1?8:0}}>
                      <div style={{minWidth:18,height:18,borderRadius:4,background:sc+"20",border:`1px solid ${sc}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:sc,fontWeight:800,flexShrink:0,marginTop:1}}>{si+1}</div>
                      <div style={{fontSize:12,color:T.textSub,lineHeight:1.6}}>{step}</div>
                    </div>
                  ))}
                </div>
                {/* Your history for this symbol */}
                {symTrades.length>0&&(
                  <div className="card" style={{padding:"16px 18px"}}>
                    <div style={{fontSize:12,fontWeight:600,marginBottom:10}}>Your {selectedSym} History</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                      {[{l:"Trades",v:symTrades.length},{l:"Win Rate",v:`${symTrades.length?Math.round((symWins.length/symTrades.length)*100):0}%`,c:symWins.length/symTrades.length>=0.5?T.green:T.red},{l:"Net P&L",v:`$${symTrades.reduce((s,t)=>s+(t.profit||0),0).toFixed(2)}`,c:symTrades.reduce((s,t)=>s+(t.profit||0),0)>=0?T.green:T.red},{l:"Avg P&L",v:`$${symTrades.length?(symTrades.reduce((s,t)=>s+(t.profit||0),0)/symTrades.length).toFixed(2):0}`}].map(x=>(
                        <div key={x.l} style={{background:T.bg,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                          <div style={{fontSize:9,color:T.textDim,marginBottom:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{x.l}</div>
                          <div style={{fontSize:13,fontWeight:700,color:x.c||T.text,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })():(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {/* Price Alerts — proper component so hooks are legal */}
              <PriceAlerts watchlist={watchlist} prices={prices}/>
              <div className="card" style={{padding:24,textAlign:"center",color:T.textSub,fontSize:13}}>
                <div style={{fontSize:24,opacity:0.2,marginBottom:8}}>◈</div>
                <div style={{fontWeight:600,color:T.text,marginBottom:4}}>Select a symbol</div>
                <div style={{fontSize:12}}>Click any row on the left to see detailed market analysis, support/resistance levels, and your trade history.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── PDF EXPORT ────────────────────────────────────────────────────────────
function exportPDF(trades, stats){
  const d=new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
  const pnlColor=stats.totalProfit>=0?"#00c48c":"#ff5b5b";
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>TradeLedger Report — ${d}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#1a1d2e;background:#fff;padding:32px;}
    h1{font-size:24px;font-weight:800;letter-spacing:-0.5px;margin-bottom:4px;}
    .sub{font-size:12px;color:#6b7280;margin-bottom:24px;}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
    .kpi{border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;}
    .kpi-label{font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;}
    .kpi-value{font-size:20px;font-weight:700;font-family:'Courier New',monospace;}
    .section{margin-bottom:24px;}
    .section-title{font-size:13px;font-weight:700;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #f0f2f8;}
    table{width:100%;border-collapse:collapse;font-size:11px;}
    th{background:#f0f2f8;padding:8px 10px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;}
    td{padding:7px 10px;border-bottom:1px solid #f0f2f8;}
    .badge-w{background:#d1fae5;color:#065f46;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700;}
    .badge-l{background:#fee2e2;color:#991b1b;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700;}
    .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
    .stat{background:#f9fafb;border-radius:8px;padding:10px 12px;}
    .stat-l{font-size:9px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;}
    .stat-v{font-size:14px;font-weight:700;font-family:'Courier New',monospace;}
    .footer{margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;display:flex;justify-content:space-between;}
    @media print{body{padding:16px;} .no-print{display:none;}}
  </style></head><body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
    <div>
      <h1>TradeLedger</h1>
      <div class="sub">Performance Report — Generated ${d}</div>
    </div>
    <div style="text-align:right;font-size:11px;color:#6b7280;">
      <div style="font-size:22px;font-weight:800;color:${pnlColor};font-family:'Courier New',monospace;">${stats.totalProfit>=0?"+":""}$${stats.totalProfit}</div>
      <div>Net P&L · ${stats.total} trades</div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Win Rate</div><div class="kpi-value" style="color:${stats.winRate>=50?"#00c48c":"#ff5b5b"}">${stats.winRate}%</div></div>
    <div class="kpi"><div class="kpi-label">Profit Factor</div><div class="kpi-value" style="color:${stats.pf>=1.5?"#00c48c":stats.pf>=1?"#f59e0b":"#ff5b5b"}">${stats.pf}</div></div>
    <div class="kpi"><div class="kpi-label">Max Drawdown</div><div class="kpi-value" style="color:${stats.maxDD>15?"#ff5b5b":"#f59e0b"}">${stats.maxDD}%</div></div>
    <div class="kpi"><div class="kpi-label">Expectancy</div><div class="kpi-value" style="color:${stats.expectancy>=0?"#00c48c":"#ff5b5b"}">$${stats.expectancy}</div></div>
  </div>

  <div class="section">
    <div class="section-title">Key Statistics</div>
    <div class="stats-grid">
      ${[["Gross Profit","$"+stats.grossProfit,"#00c48c"],["Gross Loss","$"+stats.grossLoss,"#ff5b5b"],["Avg Win","$"+stats.avgWin,"#00c48c"],["Avg Loss","$"+stats.avgLoss,"#ff5b5b"],["Max Win Streak",stats.maxCW,"#00c48c"],["Max Loss Streak",stats.maxCL,"#ff5b5b"],["R:R Ratio",stats.rr,""],["Best Month",stats.bestMonth?"$"+stats.bestMonth.profit.toFixed(0):"--","#00c48c"],["Active Days",stats.activeDays,""]].map(([l,v,c])=>`<div class="stat"><div class="stat-l">${l}</div><div class="stat-v" style="color:${c||"#1a1d2e"}">${v}</div></div>`).join("")}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Symbol Breakdown</div>
    <table><thead><tr><th>Symbol</th><th>Trades</th><th>Win Rate</th><th>Net P&L</th><th>Avg P&L</th></tr></thead>
    <tbody>${stats.bySymbol.slice(0,10).map(s=>{
      const wr=s.trades?Math.round(s.wins/s.trades*100):0;
      const avg=s.trades?(s.profit/s.trades).toFixed(2):0;
      return `<tr><td style="font-weight:700;font-family:'Courier New',monospace">${s.symbol}</td><td>${s.trades}</td><td style="color:${wr>=50?"#00c48c":"#ff5b5b"};font-weight:700">${wr}%</td><td style="color:${s.profit>=0?"#00c48c":"#ff5b5b"};font-weight:700;font-family:'Courier New',monospace">${s.profit>=0?"+":""}$${s.profit}</td><td style="font-family:'Courier New',monospace">${parseFloat(avg)>=0?"+":""}$${avg}</td></tr>`;
    }).join("")}</tbody></table>
  </div>

  <div class="section">
    <div class="section-title">Recent Trades (last 20)</div>
    <table><thead><tr><th>Symbol</th><th>Type</th><th>Open</th><th>Close</th><th>Profit</th><th>Result</th></tr></thead>
    <tbody>${[...trades].reverse().slice(0,20).map(t=>{
      const net=(t.profit||0)+(t.swap||0)+(t.commission||0);
      return `<tr><td style="font-weight:700;font-family:'Courier New',monospace">${t.symbol}</td><td>${(t.type||"").toUpperCase()}</td><td style="font-family:'Courier New',monospace;font-size:10px">${(t.openTime||"").slice(0,16)}</td><td style="font-family:'Courier New',monospace;font-size:10px">${(t.closeTime||"").slice(0,16)}</td><td style="font-weight:700;font-family:'Courier New',monospace;color:${net>=0?"#00c48c":"#ff5b5b"}">${net>=0?"+":""}$${net.toFixed(2)}</td><td><span class="${net>=0?"badge-w":"badge-l"}">${net>=0?"WIN":"LOSS"}</span></td></tr>`;
    }).join("")}</tbody></table>
  </div>

  <div class="footer">
    <span>TradeLedger Performance Report · ${d}</span>
    <span>tradeledger.app · Generated automatically</span>
  </div>
  <script>window.onload=()=>window.print();</script>
  </body></html>`;
  const win=window.open("","_blank");
  if(win){win.document.write(html);win.document.close();}
}

// ── ANALYTICS ────────────────────────────────────────────────
function exportCSV(trades){
  const rows=[["#","Symbol","Type","Open Time","Close Time","Lots","Open Price","Close Price","Profit","Swap","Commission","Net P&L"]];
  trades.forEach((t,i)=>{
    const net=(t.profit||0)+(t.swap||0)+(t.commission||0);
    rows.push([i+1,t.symbol,t.type,t.openTime,t.closeTime,t.lots||t.volume||"",t.openPrice||"",t.closePrice||"",t.profit||0,t.swap||0,t.commission||0,net.toFixed(2)]);
  });
  const csv=rows.map(r=>r.map(v=>JSON.stringify(v||"")).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="tradeledger-export-"+localDay()+".csv";a.click();
}

function AnalyticsTab({trades,stats,weeklyAI,genWeeklyAI}){
  const [activeSection,setActiveSection]=useState("overview");
  if(!stats) return (
    <div className="page" style={{overflowY:"auto",height:"100%"}}>
      <h1 style={{fontSize:20,fontWeight:700,marginBottom:20}}>Analytics</h1>
      <div style={{textAlign:"center",padding:48,color:T.textDim}}>No trade data — connect your MT5 EA</div>
    </div>
  );
  const pnlColor=stats.totalProfit>=0?T.green:T.red;
  const hourMap={};
  trades.forEach(t=>{const h=mt5Hour(t.openTime);if(h!==null){if(!hourMap[h])hourMap[h]={hour:h,profit:0,trades:0};hourMap[h].profit+=t.profit;hourMap[h].trades++;}});
  const hourData=Array.from({length:24},(_,h)=>({hour:h,profit:+(hourMap[h]?.profit||0).toFixed(2),trades:hourMap[h]?.trades||0}));
  const sections=[{k:"overview",l:"Overview"},{k:"deepstats",l:"Deep Stats"},{k:"drawdown",l:"Drawdown"},{k:"monthly",l:"Monthly"},{k:"ruin",l:"Risk of Ruin"},{k:"coach",l:"AI Coach"}];

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Analytics</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>{stats.total} trades analysed</p></div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn" style={{fontSize:11}} onClick={()=>exportCSV(trades)}>Export CSV</button>
          {stats&&<button className="btn btn-primary" style={{fontSize:11}} onClick={()=>exportPDF(trades,stats)}>Export PDF</button>}
        </div>
      </div>

      {/* Section tabs */}
      <div style={{display:"flex",gap:2,marginBottom:14,background:T.surface,borderRadius:10,padding:4,border:"1px solid "+T.border,width:"fit-content"}}>
        {sections.map(s=><button key={s.k} onClick={()=>setActiveSection(s.k)} style={{padding:"5px 16px",borderRadius:7,border:"none",cursor:"pointer",fontSize:12,fontWeight:activeSection===s.k?700:400,background:activeSection===s.k?T.blue:"transparent",color:activeSection===s.k?"#fff":T.textSub,transition:"all .15s"}}>{s.l}</button>)}
      </div>

      {/* KPI grid — always visible */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        <KpiCard label="Net P&L" value={"$"+stats.totalProfit} color={pnlColor}/>
        <KpiCard label="Win Rate" value={stats.winRate+"%"} color={stats.winRate>=50?T.green:T.red}/>
        <KpiCard label="Profit Factor" value={stats.pf} color={stats.pf>=1.5?T.green:stats.pf>=1?T.amber:T.red}/>
        <KpiCard label="Expectancy" value={"$"+stats.expectancy} color={stats.expectancy>=0?T.green:T.red}/>
        <KpiCard label="Avg Win" value={"$"+stats.avgWin} color={T.green}/>
        <KpiCard label="Avg Loss" value={"$"+stats.avgLoss} color={T.red}/>
        <KpiCard label="Max Drawdown" value={stats.maxDD+"%"} color={stats.maxDD>10?T.red:T.amber}/>
        <KpiCard label="Max Loss Streak" value={stats.maxCL} color={stats.maxCL>=4?T.red:T.amber}/>
      </div>

      {/* DEEP STATS TABLE */}
      {activeSection==="deepstats"&&(
        <div style={{marginBottom:14}}>
          <div className="card" style={{overflow:"hidden",marginBottom:12}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,fontSize:13,fontWeight:600}}>Complete Statistics</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0}}>
              {[
                {label:"Total Trades",value:stats.total,note:"All closed trades"},
                {label:"Winning Trades",value:stats.wins,note:`${stats.winRate}% win rate`,color:T.green},
                {label:"Losing Trades",value:stats.losses,note:`${(100-stats.winRate).toFixed(1)}% loss rate`,color:T.red},
                {label:"Gross Profit",value:"$"+stats.grossProfit,color:T.green},
                {label:"Gross Loss",value:"$"+stats.grossLoss,color:T.red},
                {label:"Net P&L",value:"$"+stats.totalProfit,color:stats.totalProfit>=0?T.green:T.red},
                {label:"Profit Factor",value:stats.pf,color:stats.pf>=1.5?T.green:stats.pf>=1?T.amber:T.red},
                {label:"Expected Payoff",value:"$"+stats.expectancy,color:stats.expectancy>=0?T.green:T.red},
                {label:"R:R Ratio",value:"1:"+stats.rr},
                {label:"Avg Win",value:"$"+stats.avgWin,color:T.green},
                {label:"Avg Loss",value:"$"+stats.avgLoss,color:T.red},
                {label:"Largest Win",value:"$"+stats.largestWin,color:T.green},
                {label:"Largest Loss",value:"$"+stats.largestLoss,color:T.red},
                {label:"Max Consec. Wins",value:stats.maxCW,color:T.green},
                {label:"Max Consec. Losses",value:stats.maxCL,color:stats.maxCL>=4?T.red:T.amber},
                {label:"Max Drawdown",value:stats.maxDD+"%",color:stats.maxDD>10?T.red:T.amber},
                {label:"Active Trading Days",value:stats.activeDays},
                {label:"Avg Trades/Day",value:stats.tradesPerDay,note:"On active days"},
                {label:"Best Month",value:stats.bestMonth?"$"+stats.bestMonth.profit.toFixed(2)+"  ("+stats.bestMonth.month+")":"--",color:T.green},
                {label:"Worst Month",value:stats.worstMonth?"$"+stats.worstMonth.profit.toFixed(2)+"  ("+stats.worstMonth.month+")":"--",color:T.red},
                {label:"Avg Win/Loss Ratio",value:stats.avgLoss>0?+(stats.avgWin/stats.avgLoss).toFixed(2)+"x":"--"},
                {label:"Recovery Factor",value:stats.maxDD>0?+(stats.totalProfit/stats.maxDD).toFixed(2):"--",note:"P&L / Max DD"},
              ].map((row,i)=>(
                <div key={row.label} style={{padding:"11px 16px",borderBottom:"1px solid "+T.border,borderRight:i%3<2?"1px solid "+T.border:"none",background:i%2===0?T.bg+"80":"transparent"}}>
                  <div style={{fontSize:10,color:T.textDim,marginBottom:3,textTransform:"uppercase",letterSpacing:"0.04em"}}>{row.label}</div>
                  <div style={{fontSize:14,fontWeight:700,color:row.color||T.text,fontFamily:"'JetBrains Mono',monospace"}}>{row.value}</div>
                  {row.note&&<div style={{fontSize:10,color:T.textDim,marginTop:2}}>{row.note}</div>}
                </div>
              ))}
            </div>
          </div>
          {/* Symbol breakdown table */}
          <div className="card" style={{overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,fontSize:13,fontWeight:600}}>Symbol Breakdown</div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{background:T.bg}}>{["Symbol","Trades","Wins","Win %","Net P&L","Avg P&L","Best","Worst"].map((h,i)=><th key={h} style={{padding:"8px 14px",fontSize:10,color:T.textDim,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",textAlign:i===0?"left":"right"}}>{h}</th>)}</tr></thead>
              <tbody>{stats.bySymbol.map((s,i)=>{
                const symT=trades.filter(t=>t.symbol===s.symbol);
                const symPnls=symT.map(t=>(t.profit||0)+(t.swap||0)+(t.commission||0));
                const best=symPnls.length?Math.max(...symPnls):0,worst=symPnls.length?Math.min(...symPnls):0;
                const avg=symPnls.length?+(symPnls.reduce((a,b)=>a+b,0)/symPnls.length).toFixed(2):0;
                const wr=s.trades?Math.round(s.wins/s.trades*100):0;
                return <tr key={s.symbol} className="trow"><td style={{padding:"9px 14px",fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{s.symbol}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12}}>{s.trades}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12,color:T.green}}>{s.wins}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12,color:wr>=50?T.green:T.red,fontWeight:600}}>{wr}%</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:s.profit>=0?T.green:T.red}}>{s.profit>=0?"+":""}{s.profit}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:avg>=0?T.green:T.red}}>{avg>=0?"+":""}{avg}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:T.green}}>+{best.toFixed(2)}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:T.red}}>{worst.toFixed(2)}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* DRAWDOWN CHART */}
      {activeSection==="drawdown"&&(
        <div style={{marginBottom:14}}>
          <div className="card" style={{height:300,display:"flex",flexDirection:"column",overflow:"hidden",marginBottom:12}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:13,fontWeight:600}}>Drawdown Chart</div><div style={{fontSize:11,color:T.textSub,marginTop:1}}>How far below peak equity at each trade</div></div>
              <div style={{background:T.redBg,border:"1px solid "+T.redBorder,borderRadius:8,padding:"4px 12px",fontSize:12,fontWeight:700,color:T.red}}>Max DD: {stats.maxDD}%</div>
            </div>
            <div style={{flex:1,padding:"8px 4px 4px",minHeight:0}}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.drawdownSeries} margin={{left:0,right:4,top:4,bottom:0}}>
                  <defs><linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.red} stopOpacity={.3}/><stop offset="100%" stopColor={T.red} stopOpacity={0.02}/></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                  <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={40} tickFormatter={v=>v.toFixed(1)+"%"} reversed/>
                  <Tooltip content={({active,payload})=>active&&payload?.length?<div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:8,padding:"8px 12px",fontSize:11}}><div style={{color:T.textDim,marginBottom:3}}>Trade #{payload[0]?.payload?.n}</div><div style={{color:T.red,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>Drawdown: {payload[0]?.value?.toFixed(2)}%</div></div>:null}/>
                  <Area type="monotone" dataKey="dd" name="Drawdown %" stroke={T.red} strokeWidth={2} fill="url(#ddGrad)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          {/* Drawdown stats */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
            {[
              {l:"Max Drawdown",v:stats.maxDD+"%",c:stats.maxDD>20?T.red:stats.maxDD>10?T.amber:T.green},
              {l:"Recovery Factor",v:stats.maxDD>0?+(stats.totalProfit/stats.maxDD).toFixed(2)+"x":"--",c:T.blue},
              {l:"Largest Loss",v:"$"+stats.largestLoss,c:T.red},
              {l:"Consecutive Losses",v:stats.maxCL,c:stats.maxCL>=4?T.red:T.amber},
            ].map(x=><KpiCard key={x.l} label={x.l} value={x.v} color={x.c}/>)}
          </div>
        </div>
      )}

      {/* MONTHLY P&L */}
      {activeSection==="monthly"&&(
        <div style={{marginBottom:14}}>
          <div className="card" style={{height:280,display:"flex",flexDirection:"column",overflow:"hidden",marginBottom:12}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,flexShrink:0,fontSize:13,fontWeight:600}}>Monthly P&L</div>
            <div style={{flex:1,padding:"8px 4px 4px"}}>
              {stats.monthlyPnl.length>0?(
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.monthlyPnl} barSize={28} margin={{left:0,right:4,top:8,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                    <XAxis dataKey="month" tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={50}/>
                    <Tooltip content={({active,payload})=>active&&payload?.length?<div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:8,padding:"8px 12px",fontSize:11}}><div style={{color:T.textDim,marginBottom:3}}>{payload[0]?.payload?.month}</div><div style={{fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:payload[0]?.value>=0?T.green:T.red}}>P&L: ${payload[0]?.value?.toFixed(2)}</div><div style={{color:T.textDim}}>{payload[0]?.payload?.trades} trades · {payload[0]?.payload?.trades?Math.round(payload[0]?.payload?.wins/payload[0]?.payload?.trades*100):0}% WR</div></div>:null}/>
                    <Bar dataKey="profit" name="P&L" radius={[4,4,0,0]}>{stats.monthlyPnl.map((d,i)=><Cell key={i} fill={d.profit>=0?T.green:T.red} fillOpacity={.85}/>)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              ):<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12}}>Not enough data</div>}
            </div>
          </div>
          <div className="card" style={{overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,fontSize:12,fontWeight:600}}>Month by Month</div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{background:T.bg}}>{["Month","Trades","Win Rate","Net P&L","Status"].map((h,i)=><th key={h} style={{padding:"8px 14px",fontSize:10,color:T.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i===0?"left":"right"}}>{h}</th>)}</tr></thead>
              <tbody>{[...stats.monthlyPnl].reverse().map(m=>{
                const wr=m.trades?Math.round(m.wins/m.trades*100):0;
                return <tr key={m.month} className="trow"><td style={{padding:"9px 14px",fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{m.month}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12}}>{m.trades}</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:12,color:wr>=50?T.green:T.red,fontWeight:600}}>{wr}%</td><td style={{padding:"9px 14px",textAlign:"right",fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:m.profit>=0?T.green:T.red}}>{m.profit>=0?"+":""}{m.profit.toFixed(2)}</td><td style={{padding:"9px 14px",textAlign:"right"}}><Badge color={m.profit>=0?"green":"red"}>{m.profit>=0?"Profit":"Loss"}</Badge></td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* OVERVIEW SECTION */}
      {(activeSection==="overview")&&<>
      {/* Charts row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div className="card" style={{height:200,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,flexShrink:0,fontSize:12,fontWeight:600}}>Equity Curve</div>
          <div style={{flex:1,padding:"6px 4px 4px"}}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.equity} margin={{left:0,right:0,top:2,bottom:0}}>
                <defs><linearGradient id="eg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={pnlColor} stopOpacity={.18}/><stop offset="100%" stopColor={pnlColor} stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={44}/>
                <Tooltip content={<ChartTip/>}/>
                <Area type="monotone" dataKey="bal" name="Balance" stroke={pnlColor} strokeWidth={2} fill="url(#eg2)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card" style={{height:200,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,flexShrink:0,fontSize:12,fontWeight:600}}>Hourly Performance</div>
          <div style={{flex:1,padding:"6px 4px 4px"}}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourData} barSize={8} margin={{left:0,right:0,top:2,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                <XAxis dataKey="hour" tick={{fill:T.textDim,fontSize:9}} tickFormatter={h=>h+"h"} axisLine={false} tickLine={false} interval={2}/>
                <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false} width={40}/>
                <Tooltip content={<ChartTip/>}/>
                <Bar dataKey="profit" name="P&L" radius={[3,3,0,0]}>{hourData.map((d,i)=><Cell key={i} fill={d.profit>=0?T.green:T.red} fillOpacity={.85}/>)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Symbol + Session */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div className="card" style={{overflow:"hidden"}}>
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,fontSize:12,fontWeight:600}}>By Symbol</div>
          {stats.bySymbol.slice(0,8).map(s=>(
            <div key={s.symbol} className="trow" style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{s.symbol}</span>
                <span style={{fontSize:10,color:T.textDim}}>{s.trades}t · {s.trades?Math.round(s.wins/s.trades*100):0}%wr</span>
              </div>
              <span style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:s.profit>=0?T.green:T.red}}>{s.profit>=0?"+":""}{s.profit}</span>
            </div>
          ))}
        </div>
        <div className="card" style={{padding:"12px 14px"}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Session Performance</div>
          {stats.sessions.map(s=>{
            const max=Math.max(...stats.sessions.map(x=>Math.abs(x.profit)),1);
            const pct=(Math.abs(s.profit)/max)*100;
            return (
              <div key={s.name} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span style={{fontSize:12,color:T.textSub}}>{s.name}</span>
                  <span style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:s.profit>=0?T.green:T.red}}>{s.profit>=0?"+":""}{s.profit}</span>
                </div>
                <div style={{height:5,background:T.bg,borderRadius:3}}><div style={{height:"100%",width:pct+"%",background:s.profit>=0?T.green:T.red,borderRadius:3,transition:"width .6s"}}/></div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Hour x Day of Week Heatmap */}
      {trades.length>0&&(()=>{
        const matrix={};
        const days=["Mon","Tue","Wed","Thu","Fri"];
        const hours=Array.from({length:24},(_,i)=>i);
        days.forEach(d=>hours.forEach(h=>{matrix[d+h]={profit:0,count:0};}));
        trades.forEach(t=>{
          const d=parseMT5Date(t.openTime);if(!d)return;
          const dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
          if(!days.includes(dow))return;
          const h=d.getUTCHours();
          const k=dow+h;
          if(matrix[k]){matrix[k].profit+=(t.profit||0);matrix[k].count++;}
        });
        const vals=Object.values(matrix).map(v=>v.profit).filter(v=>v!==0);
        const maxAbs=vals.length?Math.max(...vals.map(Math.abs),0.01):1;
        return (
          <div className="card" style={{marginBottom:14,overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600}}>Trade Heatmap</div>
                <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Profitability by hour (UTC) and day of week</div>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center",fontSize:10,color:T.textDim}}>
                <span style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:10,height:10,borderRadius:2,background:T.red}}/> Loss</span>
                <span style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:10,height:10,borderRadius:2,background:T.green}}/> Profit</span>
              </div>
            </div>
            <div style={{padding:"12px 16px",overflowX:"auto"}}>
              <div style={{display:"grid",gridTemplateColumns:"40px repeat(24,1fr)",gap:2,minWidth:600}}>
                <div/>
                {hours.map(h=><div key={h} style={{textAlign:"center",fontSize:8,color:T.textDim,padding:"2px 0"}}>{h}h</div>)}
                {days.map(day=>[
                  <div key={day+"lbl"} style={{fontSize:10,fontWeight:600,color:T.textSub,display:"flex",alignItems:"center"}}>{day}</div>,
                  ...hours.map(h=>{
                    const k=day+h;const cell=matrix[k]||{profit:0,count:0};
                    const intensity=cell.count>0?Math.min(1,Math.abs(cell.profit)/maxAbs):0;
                    const isProfit=cell.profit>0;
                    const bg=cell.count===0?"transparent":isProfit?`rgba(0,196,140,${0.1+intensity*0.75})`:`rgba(255,91,91,${0.1+intensity*0.75})`;
                    return <div key={k} title={cell.count>0?`${day} ${h}:00 UTC
${cell.count} trades
$${cell.profit.toFixed(2)}`:"No trades"} style={{height:20,borderRadius:3,background:bg,border:"1px solid rgba(0,0,0,0.04)",cursor:cell.count>0?"help":"default"}}/>;
                  })
                ])}
              </div>
              <div style={{marginTop:8,fontSize:10,color:T.textDim}}>Hover over a cell to see profit details. Darker = more profitable or more loss.</div>
            </div>
          </div>
        );
      })()}

      </>}

      {/* BEST SETUP FINDER */}
      {(activeSection==="overview"||activeSection==="deepstats")&&trades.length>=10&&(()=>{
        // Find best combination of hour + day + symbol
        const combos={};
        trades.forEach(t=>{
          const h=mt5Hour(t.openTime);
          const d=parseMT5Date(t.openTime);
          if(h===null||!d||!t.symbol)return;
          const dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
          const session=h>=0&&h<8?"Asian":h>=8&&h<13?"London":h>=13&&h<17?"Overlap":"NY";
          const key=t.symbol+"|"+session+"|"+dow;
          if(!combos[key])combos[key]={sym:t.symbol,session,dow,wins:0,losses:0,profit:0,trades:0};
          combos[key].trades++;
          combos[key].profit+=((t.profit||0)+(t.swap||0)+(t.commission||0));
          if(t.profit>0)combos[key].wins++;else combos[key].losses++;
        });
        const ranked=Object.values(combos).filter(c=>c.trades>=3).map(c=>({...c,profit:+c.profit.toFixed(2),wr:Math.round(c.wins/c.trades*100)})).sort((a,b)=>b.profit-a.profit);
        const best=ranked.slice(0,3),worst=ranked.filter(c=>c.profit<0).sort((a,b)=>a.profit-b.profit).slice(0,2);
        if(!best.length)return null;
        return (
          <div className="card" style={{marginBottom:14,overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:13,fontWeight:600}}>Best Trade Setup Finder</div><div style={{fontSize:11,color:T.textSub,marginTop:1}}>Your most profitable symbol + session + day combinations</div></div>
            </div>
            <div style={{padding:"14px 16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <div>
                <div style={{fontSize:10,color:T.green,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Double Down On These</div>
                {best.map((c,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,background:T.greenBg,border:"1px solid "+T.greenBorder,marginBottom:6}}>
                    <div style={{width:22,height:22,borderRadius:6,background:T.green+"25",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:T.green}}>{i+1}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{c.sym} <span style={{fontSize:10,fontWeight:400,color:T.textSub}}>· {c.session} · {c.dow}</span></div>
                      <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{c.trades} trades · {c.wr}% WR</div>
                    </div>
                    <div style={{fontSize:13,fontWeight:700,color:T.green,fontFamily:"'JetBrains Mono',monospace"}}>+${c.profit}</div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{fontSize:10,color:T.red,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Avoid These Completely</div>
                {worst.length?worst.map((c,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,background:T.redBg,border:"1px solid "+T.redBorder,marginBottom:6}}>
                    <div style={{width:22,height:22,borderRadius:6,background:T.red+"25",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:T.red}}>!</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{c.sym} <span style={{fontSize:10,fontWeight:400,color:T.textSub}}>· {c.session} · {c.dow}</span></div>
                      <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{c.trades} trades · {c.wr}% WR</div>
                    </div>
                    <div style={{fontSize:13,fontWeight:700,color:T.red,fontFamily:"'JetBrains Mono',monospace"}}>{c.profit}</div>
                  </div>
                )):<div style={{fontSize:12,color:T.textDim,padding:"10px 0"}}>No consistently losing combos found.</div>}
              </div>
            </div>
          </div>
        );
      })()}

      {/* AI COACH section */}
      {(activeSection==="coach"||activeSection==="overview")&&<div className="card" style={{marginBottom:4}}>
        <div style={{padding:"14px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:13,fontWeight:600}}>AI Trading Coach</div>
            <div style={{fontSize:11,color:T.textSub,marginTop:1}}>Generated from your own trade data — no API needed</div>
          </div>
          <button className="btn btn-primary" disabled={!stats} onClick={()=>genWeeklyAI(true)} style={{fontSize:11}}>Refresh Analysis</button>
        </div>
        <div style={{padding:"16px"}}>
          {!weeklyAI&&(
            <div style={{textAlign:"center",padding:"20px 0"}}>
              <div style={{fontSize:12,color:T.textDim,marginBottom:12}}>Click Refresh to analyse your trading performance</div>
              <button className="btn btn-primary" onClick={()=>genWeeklyAI(true)}>Generate Analysis</button>
            </div>
          )}
          {weeklyAI?.sections&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {weeklyAI.tradeCount&&<div style={{gridColumn:"1/-1",fontSize:11,color:T.textDim}}>Based on {weeklyAI.tradeCount} trades · generated {new Date(weeklyAI.generatedAt).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</div>}
              {weeklyAI.sections.map(sec=>(
                <div key={sec.id} style={{background:sec.bg,border:`1px solid ${sec.border}`,borderRadius:12,padding:"14px 16px"}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                    <div style={{width:20,height:20,borderRadius:5,background:sec.color+"25",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:sec.color,flexShrink:0}}>{sec.icon}</div>
                    <div style={{fontSize:11,color:sec.color,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"}}>{sec.label}</div>
                  </div>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:5,lineHeight:1.4}}>{sec.what}</div>
                  <div style={{fontSize:11,color:T.textSub,lineHeight:1.7,marginBottom:sec.steps?.length?10:0}}>{sec.why}</div>
                  {sec.steps?.length>0&&(
                    <div style={{display:"flex",flexDirection:"column",gap:5}}>
                      {sec.steps.map((step,si)=>(
                        <div key={si} style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                          <div style={{minWidth:16,height:16,borderRadius:4,background:sec.color+"20",border:`1px solid ${sec.color}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:sec.color,fontWeight:800,flexShrink:0,marginTop:1}}>{si+1}</div>
                          <div style={{fontSize:11,color:T.textSub,lineHeight:1.6}}>{step}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

// ── CALENDAR ─────────────────────────────────────────────────
function CalendarTab({trades,todayNews}){
  const [calMonth,setCalMonth]=useState(new Date());
  const [selectedDay,setSelectedDay]=useState(null);
  const year=calMonth.getFullYear(),month=calMonth.getMonth();
  const firstDay=new Date(year,month,1),lastDay=new Date(year,month+1,0);
  const startOffset=(firstDay.getDay()+6)%7;
  const days=[];for(let i=0;i<startOffset;i++)days.push(null);for(let i=1;i<=lastDay.getDate();i++)days.push(new Date(year,month,i));

  // Build trade data per day
  const tradesByDay={};
  trades.forEach(t=>{
    const d=mt5Day(t.closeTime)||(t.closeTime||"").slice(0,10);
    if(!d)return;
    if(!tradesByDay[d])tradesByDay[d]={profit:0,count:0,trades:[]};
    const net=(t.profit||0)+(t.swap||0)+(t.commission||0);
    tradesByDay[d].profit+=net;
    tradesByDay[d].count++;
    tradesByDay[d].trades.push(t);
  });

  const todayStr=localDay();
  const selectedData=selectedDay?tradesByDay[selectedDay]:null;

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      {/* Week comparison strip */}
      {(()=>{
        const now=new Date();
        const thisMonStart=new Date(now);thisMonStart.setDate(now.getDate()-((now.getDay()+6)%7));thisMonStart.setHours(0,0,0,0);
        const lastMonStart=new Date(thisMonStart);lastMonStart.setDate(lastMonStart.getDate()-7);
        const lastMonEnd=new Date(thisMonStart);
        const thisW=trades.filter(t=>{const d=parseMT5Date(t.closeTime);return d&&d>=thisMonStart;});
        const lastW=trades.filter(t=>{const d=parseMT5Date(t.closeTime);return d&&d>=lastMonStart&&d<lastMonEnd;});
        const thisPnl=+thisW.reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0).toFixed(2);
        const lastPnl=+lastW.reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0).toFixed(2);
        const diff=+(thisPnl-lastPnl).toFixed(2);
        if(!thisW.length&&!lastW.length)return null;
        return (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
            {[{l:"This Week",v:"$"+thisPnl,t:thisW.length+" trades",c:thisPnl>=0?T.green:T.red},{l:"Last Week",v:"$"+lastPnl,t:lastW.length+" trades",c:lastPnl>=0?T.green:T.red},{l:"Week-on-Week",v:(diff>=0?"+":"")+diff,t:diff>0?"Better":"Worse",c:diff>=0?T.green:T.red}].map(x=>(
              <div key={x.l} className="card" style={{padding:"11px 14px",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:x.c}}/>
                <div style={{fontSize:10,color:T.textSub,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,marginTop:2}}>{x.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{x.t}</div>
              </div>
            ))}
          </div>
        );
      })()}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Calendar</h1>
          {todayNews.filter(e=>(e.impact||"").toLowerCase()==="high").length>0&&(
            <span style={{fontSize:11,fontWeight:700,color:T.red,background:T.redBg,border:"1px solid "+T.redBorder,borderRadius:6,padding:"3px 10px",display:"flex",alignItems:"center",gap:5}}>
              <div style={{width:5,height:5,borderRadius:"50%",background:T.red,animation:"pulse 1.5s infinite"}}/>
              {todayNews.filter(e=>(e.impact||"").toLowerCase()==="high").length} HIGH impact today
            </span>
          )}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button className="btn" style={{padding:"6px 10px"}} onClick={()=>{const d=new Date(calMonth);d.setMonth(d.getMonth()-1);setCalMonth(d);setSelectedDay(null);}}>prev</button>
          <span style={{fontSize:13,fontWeight:600,minWidth:140,textAlign:"center"}}>{calMonth.toLocaleString("default",{month:"long",year:"numeric"})}</span>
          <button className="btn" style={{padding:"6px 10px"}} onClick={()=>{const d=new Date(calMonth);d.setMonth(d.getMonth()+1);setCalMonth(d);setSelectedDay(null);}}>next</button>
          <button className="btn btn-primary" onClick={()=>{setCalMonth(new Date());setSelectedDay(todayStr);}} style={{fontSize:11}}>Today</button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 200px 300px",gap:14,marginBottom:14}}>
        {/* Calendar grid */}
        <div className="card" style={{padding:16}}>
          {/* Day headers */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginBottom:6}}>
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=><div key={d} style={{textAlign:"center",fontSize:11,color:T.textDim,fontWeight:600,padding:"4px 0"}}>{d}</div>)}
          </div>
          {/* Date cells */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
            {days.map((day,i)=>{
              if(!day)return <div key={i}/>;
              const dStr=localDay(day);
              const td=tradesByDay[dStr];
              const isToday=dStr===todayStr;
              const isSelected=dStr===selectedDay;
              const isWe=day.getDay()===0||day.getDay()===6;
              const hasProfit=td&&td.profit>0;
              const hasLoss=td&&td.profit<0;
              return (
                <div key={i} onClick={()=>setSelectedDay(isSelected?null:dStr)}
                  style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",borderRadius:10,
                    background:isSelected?T.blue:isToday?"rgba(79,128,255,0.1)":td?"rgba(0,0,0,0.02)":"transparent",
                    border:`2px solid ${isSelected?T.blue:isToday?"rgba(79,128,255,0.3)":td?T.border:"transparent"}`,
                    cursor:td||isToday?"pointer":"default",padding:"6px 4px",position:"relative",
                    minHeight:52,transition:"all .1s"}}>
                  <span style={{fontSize:13,fontWeight:isToday||isSelected?700:400,color:isSelected?"#fff":isToday?T.blue:isWe?T.textDim:T.text}}>{day.getDate()}</span>
                  {td&&(
                    <>
                      <span style={{fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:isSelected?"rgba(255,255,255,0.9)":hasProfit?T.green:T.red,fontWeight:700,marginTop:2}}>{hasProfit?"+":""}{td.profit.toFixed(0)}</span>
                      <span style={{fontSize:9,color:isSelected?"rgba(255,255,255,0.7)":T.textDim,marginTop:1}}>{td.count}t</span>
                    </>
                  )}
                  {td&&<div style={{position:"absolute",top:4,right:4,width:5,height:5,borderRadius:"50%",background:isSelected?"rgba(255,255,255,0.8)":hasProfit?T.green:T.red}}/>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right panel: day detail + events */}
        {/* Weekly Totals */}
        <div className="card" style={{padding:"14px 16px",overflowY:"auto"}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Weekly Totals</div>
          {(()=>{
            const tradesByDay={};
            trades.forEach(t=>{const d=mt5Day(t.closeTime);if(!d)return;if(!tradesByDay[d])tradesByDay[d]={profit:0,count:0};tradesByDay[d].profit+=(t.profit||0)+(t.swap||0)+(t.commission||0);tradesByDay[d].count++;});
            const now=new Date(),year=now.getFullYear(),month=now.getMonth();
            const weeks=[];let week=[];
            const firstDay=new Date(year,month,1),lastDay=new Date(year,month+1,0);
            const startOffset=(firstDay.getDay()+6)%7;
            for(let i=0;i<startOffset;i++)week.push(null);
            for(let i=1;i<=lastDay.getDate();i++){
              week.push(new Date(year,month,i));
              if(week.length===7){weeks.push(week);week=[];}
            }
            if(week.length)weeks.push(week);
            return weeks.map((wk,wi)=>{
              const tradingDays=wk.filter(d=>d&&[1,2,3,4,5].includes(d.getDay()));
              let wProfit=0,wCount=0;
              tradingDays.forEach(d=>{const k=localDay(d);if(tradesByDay[k]){wProfit+=tradesByDay[k].profit;wCount+=tradesByDay[k].count;}});
              if(wCount===0&&wi>0)return null;
              return (
                <div key={wi} style={{marginBottom:12,paddingBottom:12,borderBottom:wi<weeks.length-1?"1px solid "+T.border:"none"}}>
                  <div style={{fontSize:10,color:T.textDim,fontWeight:600,marginBottom:4}}>Week {wi+1}</div>
                  <div style={{fontSize:16,fontWeight:700,color:wProfit>=0?T.green:T.red,fontFamily:"'JetBrains Mono',monospace"}}>{wProfit>=0?"+":""}{wProfit.toFixed(2)}</div>
                  <div style={{fontSize:11,color:T.textDim,marginTop:2}}>{wCount} trades</div>
                </div>
              );
            });
          })()}
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {/* Selected day trades */}
          {selectedDay&&(
            <div className="card" style={{overflow:"hidden"}}>
              <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,background:T.blueBg}}>
                <div style={{fontSize:13,fontWeight:600,color:T.blue}}>{selectedDay===todayStr?"Today":new Date(selectedDay+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"})}</div>
                {selectedData&&<div style={{fontSize:12,color:T.textSub,marginTop:2}}>{selectedData.count} trades &nbsp;·&nbsp; <span style={{color:selectedData.profit>=0?T.green:T.red,fontWeight:600}}>{selectedData.profit>=0?"+":""}{selectedData.profit.toFixed(2)}</span></div>}
              </div>
              {!selectedData?(
                <div style={{padding:20,textAlign:"center",color:T.textDim,fontSize:12}}>No trades on this day</div>
              ):(
                <div>
                  {selectedData.trades.map((t,i)=>{
                    const pnl=(t.profit||0)+(t.swap||0)+(t.commission||0);
                    return (
                      <div key={i} className="trow" style={{padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}>
                            <span style={{fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{t.symbol}</span>
                            <Badge color={t.type==="buy"||t.type==="BUY"?"green":"red"}>{(t.type||"").toUpperCase()}</Badge>
                          </div>
                          <div style={{fontSize:10,color:T.textDim,fontFamily:"'JetBrains Mono',monospace"}}>{(t.openTime||"").slice(11,16)} - {(t.closeTime||"").slice(11,16)}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:pnl>=0?T.green:T.red}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</div>
                          <div style={{fontSize:10,color:T.textDim}}>{t.lots||t.volume||""} lots</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {!selectedDay&&(
            <div className="card" style={{padding:24,textAlign:"center",color:T.textSub,fontSize:12}}>
              <div style={{fontSize:24,opacity:0.2,marginBottom:8}}>◷</div>
              Click any date to see trades for that day
            </div>
          )}

          {/* Economic events — grouped by impact for SELECTED day */}
          {(()=>{
            // Show events for the selected day, falling back to today
            const targetDay=selectedDay||localDay();
            // Filter from the full week feed stored on window, or fall back to todayNews
            const weekEvents=window._weekEvents||todayNews;
            // ForexFactory date is "2026-03-31T08:30:00Z" — slice(0,10) = "2026-03-31"
            // But selectedDay is local date — we need to compare carefully
            // Use UTC date from event, compare to targetDay treating it as UTC too
            const dayEvents=weekEvents.filter(e=>{
              const evtDate=e.date||e.time||e.datetime||"";
              if(!evtDate)return false;
              // Try UTC slice first (ForexFactory format)
              const utcSlice=(evtDate||"").slice(0,10);
              if(utcSlice===targetDay)return true;
              // Try parsing as local
              try{return localDay(new Date(evtDate))===targetDay;}catch{return false;}
            });
            const eventsToShow=dayEvents.length>0?dayEvents:(targetDay===localDay()?todayNews:[]);
            if(!eventsToShow.length)return null;
            const grouped={high:eventsToShow.filter(e=>(e.impact||"").toLowerCase()==="high"),medium:eventsToShow.filter(e=>(e.impact||"").toLowerCase()==="medium"),low:eventsToShow.filter(e=>!["high","medium"].includes((e.impact||"").toLowerCase()))};
            const fmtTime=e=>{const d=e.date||e.time;if(!d)return"";try{const t=new Date(d);return isNaN(t)?"":" · "+t.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}catch{return"";}};
            const rowBg=imp=>imp==="high"?T.redBg:imp==="medium"?T.amberBg:T.bg;
            const rowBorder=imp=>imp==="high"?T.redBorder:imp==="medium"?"rgba(245,158,11,.2)":T.border;
            const rowColor=imp=>imp==="high"?T.red:imp==="medium"?T.amber:T.textDim;
            const badgeColor=imp=>imp==="high"?"red":imp==="medium"?"amber":"gray";
            const badgeLabel=imp=>imp==="high"?"HIGH":imp==="medium"?"MED":"LOW";
            const renderRow=(e,imp,i)=>(
              <div key={i} className="trow" style={{padding:"10px 14px",display:"grid",gridTemplateColumns:"1fr auto",gap:12,alignItems:"start"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:imp==="high"?600:500,color:imp==="high"?T.text:T.textSub,lineHeight:1.45,marginBottom:3}}>{e.title||e.event||e.name||"Unnamed Event"}</div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    {(e.country||e.currency)&&<span style={{fontSize:10,fontWeight:600,color:T.textDim}}>{e.country||e.currency}</span>}
                    {fmtTime(e)&&<span style={{fontSize:10,color:T.textDim,fontFamily:"'JetBrains Mono',monospace"}}>{fmtTime(e)}</span>}
                  </div>
                  {(e.actual!=null||e.forecast!=null||e.previous!=null)&&(
                    <div style={{display:"flex",gap:12,marginTop:5,padding:"4px 8px",background:T.bg,borderRadius:5,width:"fit-content"}}>
                      {e.actual!=null&&<span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}><span style={{color:T.textDim}}>Act </span><span style={{color:T.green,fontWeight:700}}>{e.actual}</span></span>}
                      {e.forecast!=null&&<span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}><span style={{color:T.textDim}}>Fcst </span><span style={{color:T.text}}>{e.forecast}</span></span>}
                      {e.previous!=null&&<span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}><span style={{color:T.textDim}}>Prev </span><span style={{color:T.textSub}}>{e.previous}</span></span>}
                    </div>
                  )}
                </div>
                <Badge color={badgeColor(imp)}>{badgeLabel(imp)}</Badge>
              </div>
            );
            return (
              <div className="card" style={{overflow:"hidden"}}>
                <div style={{padding:"12px 14px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:12,fontWeight:600}}>Economic Events Today</div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {grouped.high.length>0&&<span style={{fontSize:10,color:T.red,fontWeight:700,background:T.redBg,border:"1px solid "+T.redBorder,borderRadius:5,padding:"1px 6px"}}>{grouped.high.length} HIGH</span>}
                    {grouped.medium.length>0&&<span style={{fontSize:10,color:T.amber,fontWeight:700,background:T.amberBg,border:"1px solid rgba(245,158,11,.25)",borderRadius:5,padding:"1px 6px"}}>{grouped.medium.length} MED</span>}
                    <span style={{fontSize:11,color:T.textDim}}>{eventsToShow.length} events</span>
                  </div>
                </div>
                {grouped.high.length>0&&<>
                  <div style={{padding:"6px 14px",background:T.redBg,borderBottom:"1px solid "+T.redBorder,display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:T.red,boxShadow:"0 0 6px "+T.red}}/>
                    <span style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.06em"}}>High Impact — {grouped.high.length} event{grouped.high.length>1?"s":""}</span>
                  </div>
                  {grouped.high.map((e,i)=>renderRow(e,"high",i))}
                </>}
                {grouped.medium.length>0&&<>
                  <div style={{padding:"6px 14px",background:T.amberBg,borderBottom:"1px solid rgba(245,158,11,.2)",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:T.amber}}/>
                    <span style={{fontSize:10,fontWeight:700,color:T.amber,textTransform:"uppercase",letterSpacing:"0.06em"}}>Medium Impact — {grouped.medium.length} event{grouped.medium.length>1?"s":""}</span>
                  </div>
                  {grouped.medium.map((e,i)=>renderRow(e,"medium",i))}
                </>}
                {grouped.low.length>0&&<>
                  <div style={{padding:"6px 14px",background:T.bg,borderBottom:"1px solid "+T.border,display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:T.textDim}}/>
                    <span style={{fontSize:10,fontWeight:700,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.06em"}}>Low Impact — {grouped.low.length} event{grouped.low.length>1?"s":""}</span>
                  </div>
                  {grouped.low.map((e,i)=>renderRow(e,"low",i))}
                </>}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ── NEWS ──────────────────────────────────────────────────────
function NewsTab({savedNews,setSavedNews,fetchNews,newsLd,openArticle,searchQuery,setSearchQuery,searchResults,searchLd,searchErr,fetchMarketSearch}){
  const chips=["Gold","Bitcoin","EURUSD","GBPUSD","Oil","Nasdaq","DXY","Fed","CPI","NFP"];
  const [localQ,setLocalQ]=useState(searchQuery);
  const doSearch=()=>{if(localQ.trim()){setSearchQuery(localQ);fetchMarketSearch(localQ);}};

  // Group saved news by date
  const cutoff=Date.now()-48*60*60*1000;
  const valid=savedNews.filter(a=>new Date(a.savedAt||a.pubDate||0).getTime()>cutoff);
  const groups={};
  valid.forEach(a=>{
    const k=new Date(a.savedAt||a.pubDate||Date.now()).toDateString();
    if(!groups[k])groups[k]=[];
    groups[k].push(a);
  });
  const sortedDates=Object.keys(groups).sort((a,b)=>new Date(b)-new Date(a));

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>News</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>Market intelligence & AI search</p></div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn" style={{fontSize:11}} onClick={()=>{setSavedNews([]);try{localStorage.removeItem("tl_saved_news");}catch{}}}>Clear archive</button>
          <button className="btn btn-primary" disabled={newsLd} onClick={fetchNews} style={{fontSize:11}}>{newsLd?<><Spinner size={11} color="#fff"/> Fetching...</>:"Fetch Latest"}</button>
        </div>
      </div>

      {/* Market Sentiment bar */}
      <div className="card" style={{padding:"12px 18px",marginBottom:14,background:"linear-gradient(135deg,rgba(79,128,255,.03),rgba(139,92,246,.03))"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600}}>Market Mood</div>
          <div style={{fontSize:10,color:T.textDim}}>Based on recent news sentiment</div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {[
            {l:"USD",s:savedNews.filter(a=>(a.title||"").toLowerCase().match(/dollar|usd|fed|fomc/)).length},
            {l:"GOLD",s:savedNews.filter(a=>(a.title||"").toLowerCase().match(/gold|xau/)).length},
            {l:"BTC",s:savedNews.filter(a=>(a.title||"").toLowerCase().match(/bitcoin|btc|crypto/)).length},
            {l:"EUR",s:savedNews.filter(a=>(a.title||"").toLowerCase().match(/euro|eur|ecb/)).length},
            {l:"GBP",s:savedNews.filter(a=>(a.title||"").toLowerCase().match(/pound|gbp|boe/)).length},
          ].map(({l,s})=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:5,background:T.bg,border:"1px solid "+T.border,borderRadius:7,padding:"4px 10px"}}>
              <span style={{fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:T.textSub}}>{l}</span>
              <div style={{display:"flex",gap:2}}>
                {Array.from({length:Math.min(5,s)}).map((_,i)=><div key={i} style={{width:4,height:12,borderRadius:1,background:s>3?T.red:s>1?T.amber:T.green}}/>)}
                {s===0&&<span style={{fontSize:10,color:T.textDim}}>quiet</span>}
              </div>
              <span style={{fontSize:10,color:T.textDim}}>{s} articles</span>
            </div>
          ))}
        </div>
      </div>

      {/* Search bar */}
      <div className="card" style={{padding:16,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:3}}>Market Search</div>
        <p style={{fontSize:11,color:T.textSub,marginBottom:12}}>Search any asset for live news + AI briefing</p>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
          {chips.map(c=><button key={c} className="btn" style={{fontSize:11,padding:"3px 9px",fontFamily:"'JetBrains Mono',monospace"}} onClick={()=>{setLocalQ(c);setSearchQuery(c);fetchMarketSearch(c);}}>{c}</button>)}
        </div>
        <div style={{display:"flex",gap:8}}>
          <input className="input" value={localQ} onChange={e=>setLocalQ(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter")doSearch();}}
            placeholder="e.g. Gold, EURUSD, Fed..." style={{fontSize:12}}/>
          <button className="btn btn-primary" disabled={searchLd} onClick={doSearch} style={{minWidth:80,fontSize:11,justifyContent:"center"}}>{searchLd?<><Spinner size={11} color="#fff"/> Searching...</>:"Search"}</button>
        </div>
        {searchErr&&<div style={{fontSize:12,color:T.red,marginTop:8}}>{searchErr}</div>}
      </div>

      {/* Search results */}
      {searchLd&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"16px 0",color:T.textSub,fontSize:12}}><Spinner/>Searching for {localQ}...</div>}
      {searchResults&&!searchLd&&(
        <div className="card" style={{marginBottom:20,overflow:"hidden"}}>
          {searchResults.aiSummary&&(
            <div style={{padding:"14px 16px",background:T.greenBg,borderBottom:`1px solid ${T.greenBorder}`}}>
              <div style={{fontSize:11,color:T.green,fontWeight:700,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>AI Briefing — {(searchResults.query||"").toUpperCase()}</div>
              <p style={{fontSize:13,color:T.text,lineHeight:1.75}}>{searchResults.aiSummary}</p>
            </div>
          )}
          <div style={{padding:"8px 0"}}>
            <div style={{padding:"6px 16px",fontSize:10,color:T.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>{searchResults.articles?.length||0} Related Articles</div>
            {searchResults.articles?.slice(0,8).map((a,i)=>{
              const d=a.pubDate?new Date(a.pubDate):null;
              const minsAgo=d?Math.floor((Date.now()-d)/60000):null;
              const age=minsAgo===null?"":minsAgo<2?"LIVE":minsAgo<60?minsAgo+"m ago":Math.floor(minsAgo/60)+"h ago";
              return (
                <div key={i} className="trow" style={{padding:"11px 16px",cursor:"pointer"}} onClick={()=>openArticle(a)}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                    <Badge color="gray">{a.source}</Badge>
                    {age&&<span style={{fontSize:10,color:minsAgo!==null&&minsAgo<10?T.green:T.textDim,fontFamily:"'JetBrains Mono',monospace"}}>{age}</span>}
                    <span style={{marginLeft:"auto",fontSize:11,color:T.blue}}>Read</span>
                  </div>
                  <div style={{fontSize:12,fontWeight:500,color:T.text,lineHeight:1.5}}>{a.title}</div>
                  {a.description&&<div style={{fontSize:11,color:T.textSub,lineHeight:1.4,marginTop:3}}>{a.description.slice(0,140)}...</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Symbol news radar — latest headline per saved symbol */}
      {savedNews.length>0&&(()=>{
        const watched=["XAUUSD","BTCUSD","EURUSD","GBPUSD","USDJPY","NAS100","USOIL"];
        const keywordMap={XAUUSD:["gold","xau","bullion"],BTCUSD:["bitcoin","btc","crypto"],EURUSD:["euro","eur","ecb"],GBPUSD:["pound","gbp","boe"],USDJPY:["yen","jpy","japan","boj"],NAS100:["nasdaq","tech","nasdaq100"],USOIL:["oil","crude","opec","wti"]};
        const matches=watched.map(sym=>{const kws=keywordMap[sym]||[sym.toLowerCase()];const latest=savedNews.find(a=>{const t=(a.title||"").toLowerCase()+" "+(a.description||"").toLowerCase();return kws.some(k=>t.includes(k));});return latest?{sym,article:latest}:null;}).filter(Boolean).slice(0,4);
        if(!matches.length)return null;
        return (
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Symbol News Radar</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {matches.map(({sym,article})=>{
                const d=article.pubDate?new Date(article.pubDate):null;
                const minsAgo=d?Math.floor((Date.now()-d)/60000):null;
                const age=minsAgo===null?"":minsAgo<60?minsAgo+"m ago":Math.floor(minsAgo/60)+"h ago";
                const isNew=minsAgo!==null&&minsAgo<60;
                return (
                  <div key={sym} className="card" style={{padding:"11px 13px",cursor:"pointer",borderLeft:"3px solid "+(isNew?T.green:T.border)}} onClick={()=>openArticle(article)}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                      <span style={{fontSize:11,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:isNew?T.green:T.textSub}}>{sym}</span>
                      <span style={{fontSize:9,color:isNew?T.green:T.textDim,fontFamily:"'JetBrains Mono',monospace"}}>{age}</span>
                    </div>
                    <div style={{fontSize:11,color:T.text,lineHeight:1.5,fontWeight:500}}>{(article.title||"").slice(0,80)}{(article.title||"").length>80?"...":""}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Archive header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <span style={{fontSize:11,fontWeight:700,color:T.textDim,letterSpacing:"0.06em",textTransform:"uppercase"}}>48h Archive</span>
        <div style={{flex:1,height:1,background:T.border}}/>
        <span style={{fontSize:11,color:T.textDim}}>{valid.length} articles</span>
      </div>

      {/* No articles */}
      {valid.length===0&&(
        <div className="card" style={{padding:32,textAlign:"center",color:T.textSub,fontSize:12}}>
          <div style={{marginBottom:12,fontSize:14,fontWeight:500}}>No saved articles yet</div>
          <div style={{color:T.textDim,marginBottom:16,fontSize:12}}>Fetch the latest news to populate your archive</div>
          <button className="btn btn-primary" onClick={fetchNews}>{newsLd?"Fetching...":"Fetch News"}</button>
        </div>
      )}

      {/* Date-grouped articles */}
      {sortedDates.map(dk=>{
        const arts=groups[dk];
        const isToday=dk===new Date().toDateString();
        const isYest=dk===new Date(Date.now()-86400000).toDateString();
        const label=isToday?"Today":isYest?"Yesterday":new Date(dk).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
        return (
          <div key={dk} style={{marginBottom:24}}>
            {/* Date header */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,position:"sticky",top:-1,background:T.bg,zIndex:2,padding:"4px 0"}}>
              <div style={{fontSize:13,fontWeight:700,color:isToday?T.blue:T.text}}>{label}</div>
              <div style={{flex:1,height:1,background:T.border}}/>
              <div style={{fontSize:11,color:T.textDim,background:T.surface,border:`1px solid ${T.border}`,borderRadius:20,padding:"2px 10px"}}>{arts.length} articles</div>
            </div>
            {/* Articles for this date */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:10}}>
              {arts.map((a,i)=>{
                const d=a.pubDate?new Date(a.pubDate):null;
                const timeStr=d?d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";
                const minsAgo=d?Math.floor((Date.now()-d)/60000):null;
                const isNew=minsAgo!==null&&minsAgo<30;
                const srcColors={"Yahoo Finance":T.purple,"ForexLive":T.blue,"FXStreet":T.green,"Reuters":T.amber,"Bloomberg":T.cyan};
                const srcColor=srcColors[a.source]||T.textSub;
                return (
                  <div key={i} className="card" style={{padding:"13px 15px",cursor:"pointer",transition:"box-shadow .15s"}} onClick={()=>openArticle(a)}>
                    <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:7}}>
                      {isNew&&<Badge color="green">NEW</Badge>}
                      <span style={{fontSize:11,color:srcColor,fontWeight:600}}>{a.source}</span>
                      {timeStr&&<span style={{fontSize:10,color:T.textDim,fontFamily:"'JetBrains Mono',monospace",marginLeft:"auto"}}>{timeStr}</span>}
                    </div>
                    <div style={{fontSize:12,fontWeight:600,lineHeight:1.5,color:T.text,marginBottom:a.description?5:0}}>{a.title}</div>
                    {a.description&&<div style={{fontSize:11,color:T.textSub,lineHeight:1.5}}>{a.description.slice(0,130)}...</div>}
                    <div style={{marginTop:8,fontSize:11,color:T.blue,fontWeight:500}}>Read article</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── JOURNAL ───────────────────────────────────────────────────
function JournalTab({trades}){
  const STORAGE_KEY = "tl_journal_entries";
  const [journalTvSym, setJournalTvSym]=useState(null);
  const [entries, setEntries] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]"); }catch{ return []; }
  });
  const [view, setView] = useState("list"); // "list"|"new"|"detail"|"coaching"
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all"); // "all"|"win"|"loss"
  const [search, setSearch] = useState("");
  const [coaching, setCoaching] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("tl_journal_coaching")||"null"); }catch{ return null; }
  });
  const [coachingLd, setCoachingLd] = useState(false);

  // Form state
  const EMPTY_FORM = {
    date: localDay(),
    symbol: "", type: "buy", outcome: "win",
    pnl: "", setup: "", reason: "", emotion: "",
    mistakes: "", lessons: "", rating: 3,
    screenshot: null, tags: ""
  };
  const [form, setForm] = useState(EMPTY_FORM);
  const fileRef = useRef();

  const save = (entries) => {
    setEntries(entries);
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }catch{}
  };

  const submitEntry = () => {
    if (!form.symbol.trim()) return;
    const entry = {
      ...form,
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      pnl: parseFloat(form.pnl)||0,
      tags: form.tags.split(",").map(t=>t.trim()).filter(Boolean)
    };
    save([entry, ...entries]);
    setForm(EMPTY_FORM);
    setView("list");
  };

  const deleteEntry = (id) => {
    save(entries.filter(e=>e.id!==id));
    if(selected?.id===id){ setSelected(null); setView("list"); }
  };

  // Generate weekly coaching from journal entries
  const genCoaching = () => {
    if(!entries.length) return;
    setCoachingLd(true);
    const wins = entries.filter(e=>e.outcome==="win");
    const losses = entries.filter(e=>e.outcome==="loss");
    const wr = entries.length ? Math.round(wins.length/entries.length*100) : 0;
    const totalPnl = entries.reduce((s,e)=>s+(e.pnl||0),0);
    const avgWinPnl = wins.length ? (wins.reduce((s,e)=>s+(e.pnl||0),0)/wins.length).toFixed(2) : 0;
    const avgLossPnl = losses.length ? (Math.abs(losses.reduce((s,e)=>s+(e.pnl||0),0)/losses.length)).toFixed(2) : 0;

    // Most common setup / emotion
    const setupCounts = {}; entries.forEach(e=>{if(e.setup)setupCounts[e.setup]=(setupCounts[e.setup]||0)+1;});
    const topSetup = Object.entries(setupCounts).sort((a,b)=>b[1]-a[1])[0];
    const emotionCounts = {}; entries.forEach(e=>{if(e.emotion)emotionCounts[e.emotion]=(emotionCounts[e.emotion]||0)+1;});
    const topEmotion = Object.entries(emotionCounts).sort((a,b)=>b[1]-a[1])[0];

    // Common mistakes
    const allMistakes = entries.filter(e=>e.mistakes).map(e=>e.mistakes);
    const allLessons = entries.filter(e=>e.lessons).map(e=>e.lessons);
    const ratingAvg = entries.length ? (entries.reduce((s,e)=>s+(e.rating||3),0)/entries.length).toFixed(1) : "—";

    // Symbol performance from journal
    const symMap = {};
    entries.forEach(e=>{
      if(!symMap[e.symbol])symMap[e.symbol]={wins:0,losses:0,pnl:0};
      if(e.outcome==="win")symMap[e.symbol].wins++;
      else symMap[e.symbol].losses++;
      symMap[e.symbol].pnl+=e.pnl||0;
    });
    const symArr = Object.entries(symMap).map(([sym,d])=>({sym,...d,pnl:+d.pnl.toFixed(2)})).sort((a,b)=>b.pnl-a.pnl);
    const bestSym = symArr[0], worstSym = [...symArr].sort((a,b)=>a.pnl-b.pnl)[0];

    // Build sections
    const sections = [];

    // Section 1: Performance summary
    sections.push({
      id:"perf", icon:"=", label:"PERFORMANCE SUMMARY",
      color: totalPnl>=0 ? T.green : T.red,
      bg: totalPnl>=0 ? T.greenBg : T.redBg,
      border: totalPnl>=0 ? T.greenBorder : T.redBorder,
      what: `${wr}% win rate across ${entries.length} journalled trades — net P&L $${totalPnl.toFixed(2)}`,
      why: `Avg win: $${avgWinPnl} · Avg loss: $${avgLossPnl} · Self-rating avg: ${ratingAvg}/5${topSetup?` · Most used setup: ${topSetup[0]} (${topSetup[1]}x)`:""}`,
      steps: [
        wr>=60 ? `Strong win rate — protect it by only trading your A+ setup: ${topSetup?topSetup[0]:"your best setup"}` :
                 `Win rate of ${wr}% needs work — focus on setup quality, not quantity`,
        `Avg win $${avgWinPnl} vs avg loss $${avgLossPnl}${parseFloat(avgWinPnl)>parseFloat(avgLossPnl)?" — R:R is positive, keep it":" — work on cutting losses faster or holding winners longer"}`,
        `Journal ${Math.max(0,20-entries.length)} more trades to get statistically reliable coaching`
      ].filter(Boolean)
    });

    // Section 2: Best & worst symbols
    if(symArr.length>0) sections.push({
      id:"sym", icon:"o", label:"SYMBOL INSIGHTS",
      color: T.blue, bg: T.blueBg, border: "rgba(79,128,255,.25)",
      what: bestSym ? `${bestSym.sym} is your best journalled symbol: $${bestSym.pnl} P&L (${bestSym.wins}W/${bestSym.losses}L)` : "Not enough symbol data",
      why: symArr.map(s=>`${s.sym}: $${s.pnl} (${s.wins}W/${s.losses}L)`).slice(0,4).join(" · "),
      steps: [
        bestSym ? `Focus on ${bestSym.sym} — you clearly understand this market` : "",
        worstSym&&worstSym.pnl<0 ? `Stop or paper trade ${worstSym.sym} — losing $${Math.abs(worstSym.pnl)} in your journal` : "",
        `Cross-reference journal symbol data with your MT5 trade history`
      ].filter(Boolean)
    });

    // Section 3: Emotional patterns
    if(topEmotion||allMistakes.length) sections.push({
      id:"emotion", icon:"!", label:"EMOTIONAL PATTERNS",
      color: T.amber, bg: T.amberBg, border: "rgba(245,158,11,.25)",
      what: topEmotion ? `Most common emotional state: "${topEmotion[0]}" (${topEmotion[1]} entries)` : "Track your emotions per trade for pattern detection",
      why: allMistakes.length ? `Recurring mistakes noted in ${allMistakes.length} entries. Most recent: "${allMistakes[allMistakes.length-1]?.slice(0,80)}"` : "No mistakes logged yet",
      steps: [
        topEmotion&&["fear","anxious","nervous","fomo","greedy"].some(w=>topEmotion[0].toLowerCase().includes(w)) ?
          `"${topEmotion[0]}" is your top emotion — add a 5-min pause rule before any trade when feeling this way` :
          topEmotion ? `Note whether "${topEmotion[0]}" correlates with wins or losses — check your journal entries` : "Log your emotional state on every trade — patterns emerge after 10+ entries",
        allMistakes.length>=3 ? `You've logged ${allMistakes.length} mistakes — identify the top 1-2 patterns and add a checklist rule` : "Keep logging mistakes — self-awareness is the first step to fixing them",
        allLessons.length ? `You've captured ${allLessons.length} lessons — review them weekly and pick 1 to implement` : "Write a lesson for every losing trade"
      ].filter(Boolean)
    });

    // Section 4: Lessons & improvement
    sections.push({
      id:"improve", icon:">", label:"HOW TO IMPROVE",
      color: T.purple, bg: T.purpleBg, border: "rgba(139,92,246,.25)",
      what: allLessons.length ? `${allLessons.length} lessons captured — here is your action plan` : "Start capturing lessons from every trade",
      why: allLessons.slice(-3).join(" | ") || "No lessons logged yet",
      steps: [
        parseFloat(ratingAvg)<3 ? `Average self-rating ${ratingAvg}/5 — you know your trades could be better. Raise the bar: only enter when you'd rate the setup 4+` :
          `Self-rating ${ratingAvg}/5 is good — track whether high-rated trades produce better P&L`,
        `Review this journal weekly. Delete entries older than 90 days that no longer teach you anything new`,
        `Take a screenshot of every trade — visual review each Sunday finds patterns your notes miss`
      ]
    });

    const result = { sections, generatedAt: new Date().toISOString(), tradeCount: entries.length };
    setCoaching(result);
    try{ localStorage.setItem("tl_journal_coaching", JSON.stringify(result)); }catch{}
    setCoachingLd(false);
    setView("coaching");
  };

  const filtered = entries
    .filter(e=> filter==="all" || e.outcome===filter)
    .filter(e=> !search || e.symbol.toLowerCase().includes(search.toLowerCase()) || (e.setup||"").toLowerCase().includes(search.toLowerCase()) || (e.reason||"").toLowerCase().includes(search.toLowerCase()));

  const outcomeColor = o => o==="win"?T.green:o==="loss"?T.red:T.amber;
  const ratingStars = r => "★".repeat(r)+"☆".repeat(5-r);
  const EMOTIONS = ["Confident","Neutral","Anxious","FOMO","Greedy","Patient","Impulsive","Disciplined","Fear","Excited"];
  const SETUPS = ["Breakout","Pullback","Reversal","Support/Resistance","News Trade","Trend Follow","Range","Scalp","ICT/SMC","Other"];

  if(view==="coaching") return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Journal Coaching</h1>
          <div style={{fontSize:12,color:T.textSub,marginTop:2}}>Generated from {coaching?.tradeCount} journalled trades · {coaching&&new Date(coaching.generatedAt).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn" onClick={()=>setView("list")}>Back to Journal</button>
          <button className="btn btn-primary" onClick={genCoaching} disabled={coachingLd}>{coachingLd?"Analysing...":"Refresh"}</button>
        </div>
      </div>
      {coaching?.sections&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {coaching.sections.map(sec=>(
            <div key={sec.id} style={{background:sec.bg,border:`1px solid ${sec.border}`,borderRadius:12,padding:"16px 18px"}}>
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                <div style={{width:22,height:22,borderRadius:6,background:sec.color+"25",border:`1px solid ${sec.color}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:sec.color,flexShrink:0}}>{sec.icon}</div>
                <div style={{fontSize:11,color:sec.color,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase"}}>{sec.label}</div>
              </div>
              <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:5,lineHeight:1.4}}>{sec.what}</div>
              <div style={{fontSize:11,color:T.textSub,lineHeight:1.7,marginBottom:sec.steps?.length?12:0}}>{sec.why}</div>
              {sec.steps?.length>0&&(
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {sec.steps.map((step,si)=>(
                    <div key={si} style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                      <div style={{minWidth:17,height:17,borderRadius:4,background:sec.color+"20",border:`1px solid ${sec.color}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:sec.color,fontWeight:800,flexShrink:0,marginTop:1}}>{si+1}</div>
                      <div style={{fontSize:11,color:T.textSub,lineHeight:1.6}}>{step}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if(view==="detail"&&selected) return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>
      {journalTvSym&&<TVModal symbol={journalTvSym} onClose={()=>setJournalTvSym(null)}/>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button className="btn" onClick={()=>{setSelected(null);setView("list");}}>Back</button>
          <div>
            <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>{selected.symbol} — {selected.date}</h1>
            <div style={{fontSize:12,color:T.textSub,marginTop:1}}>{selected.type?.toUpperCase()} trade</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {selected.symbol&&<button className="btn" style={{fontSize:11}} onClick={()=>setJournalTvSym(selected.symbol)}>Chart</button>}
          {selected.symbol&&selected.date&&(()=>{
            const [replayData,setReplayData]=useState(null);
            const [replayOpen,setReplayOpen]=useState(false);
            const loadReplay=async()=>{
              if(replayData){setReplayOpen(true);return;}
              try{
                const r=await fetch(SERVER+"/api/sparkline?symbol="+selected.symbol+"&interval=1h&bars=48");
                if(r.ok){const d=await r.json();setReplayData(d.candles||[]);setReplayOpen(true);}
              }catch{}
            };
            return(
              <>
                <button className="btn" style={{fontSize:11}} onClick={loadReplay}>Replay</button>
                {replayOpen&&replayData&&replayData.length>0&&(()=>{
                  const closes=replayData.map(c=>c.c);
                  const minP=Math.min(...replayData.map(c=>c.l));
                  const maxP=Math.max(...replayData.map(c=>c.h));
                  const range=maxP-minP||1;
                  const W=480,H=120,pad=8;
                  const xp=i=>pad+(i/(replayData.length-1))*(W-pad*2);
                  const yp=v=>H-pad-(v-minP)/range*(H-pad*2);
                  // Find closest candle to entry/exit
                  const entryPrice=parseFloat(selected.entryPrice)||null;
                  const exitPrice=parseFloat(selected.pnl)>0?closes[closes.length-1]:null;
                  const isWin=(selected.pnl||0)>0;
                  const lineColor=isWin?T.green:T.red;
                  const areaPoints=closes.map((c,i)=>xp(i)+","+yp(c)).join(" ");
                  return(
                    <div style={{position:"fixed",inset:0,zIndex:2000,background:"rgba(0,0,0,.7)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={e=>{if(e.target===e.currentTarget)setReplayOpen(false);}}>
                      <div style={{background:T.surface,borderRadius:16,border:"1px solid "+T.border,width:"min(560px,95vw)",overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,.4)"}}>
                        <div style={{padding:"12px 16px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <span style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{selected.symbol}</span>
                            <span style={{fontSize:11,color:T.textDim,marginLeft:8}}>{selected.date} · 1H replay</span>
                          </div>
                          <button onClick={()=>setReplayOpen(false)} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:T.textDim}}>×</button>
                        </div>
                        <div style={{padding:"16px",background:T.bg}}>
                          <svg viewBox={"0 0 "+W+" "+H} style={{width:"100%",height:H,display:"block",borderRadius:8}}>
                            <defs>
                              <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={lineColor} stopOpacity="0.3"/>
                                <stop offset="100%" stopColor={lineColor} stopOpacity="0.02"/>
                              </linearGradient>
                            </defs>
                            <polygon points={"0,"+H+" "+areaPoints+" "+(W-pad)+","+H} fill="url(#rg)"/>
                            <polyline points={areaPoints} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round"/>
                            {/* Current price dot */}
                            <circle cx={xp(closes.length-1)} cy={yp(closes[closes.length-1])} r="3.5" fill={lineColor} stroke={T.surface} strokeWidth="1.5"/>
                            {/* Price labels */}
                            <text x={pad+2} y={yp(maxP)-4} fontSize="8" fill={T.textDim}>${maxP.toFixed(maxP>100?2:5)}</text>
                            <text x={pad+2} y={yp(minP)+12} fontSize="8" fill={T.textDim}>${minP.toFixed(minP>100?2:5)}</text>
                          </svg>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>
                            {[
                              {l:"Outcome",v:(selected.pnl>0?"WIN":"LOSS"),c:isWin?T.green:T.red},
                              {l:"P&L",v:(selected.pnl>0?"+":"")+selected.pnl,c:isWin?T.green:T.red},
                              {l:"Symbol",v:selected.symbol,c:T.blue},
                            ].map(x=>(
                              <div key={x.l} style={{background:T.surface,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                                <div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",marginBottom:3}}>{x.l}</div>
                                <div style={{fontSize:13,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            );
          })()}
          {selected.needsReview&&!selected.reviewed&&(
            <button className="btn btn-primary" style={{fontSize:11,background:T.green,borderColor:T.green}} onClick={()=>{
              const updated=entries.map(e=>e.id===selected.id?{...e,reviewed:true,needsReview:false}:e);
              save(updated);setSelected({...selected,reviewed:true,needsReview:false});
            }}>Mark Reviewed</button>
          )}
          <button className="btn" style={{color:T.red,borderColor:T.redBorder}} onClick={()=>deleteEntry(selected.id)}>Delete</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {/* Screenshot */}
          {selected.screenshot&&(
            <div className="card" style={{overflow:"hidden"}}>
              <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,fontSize:12,fontWeight:600}}>Chart Screenshot</div>
              <img src={selected.screenshot} alt="trade screenshot" style={{width:"100%",maxHeight:400,objectFit:"contain",background:T.bg}}/>
            </div>
          )}
          {/* Narrative */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Trade Notes</div>
            {[{l:"Why I took this trade",v:selected.reason},{l:"Setup",v:selected.setup},{l:"Emotional state",v:selected.emotion},{l:"Mistakes made",v:selected.mistakes},{l:"Lessons learned",v:selected.lessons}].map(x=>x.v?(
              <div key={x.l} style={{marginBottom:12}}>
                <div style={{fontSize:10,color:T.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{x.l}</div>
                <div style={{fontSize:13,color:T.text,lineHeight:1.65}}>{x.v}</div>
              </div>
            ):null)}
            {selected.tags?.length>0&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                {selected.tags.map(t=><span key={t} style={{background:T.blueBg,border:`1px solid rgba(79,128,255,.25)`,borderRadius:5,padding:"2px 8px",fontSize:11,color:T.blue}}>{t}</span>)}
              </div>
            )}
          </div>
        </div>
        {/* Right stats panel */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Trade Result</div>
            <div style={{fontSize:28,fontWeight:800,color:outcomeColor(selected.outcome),fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>{selected.pnl>=0?"+":""}{(selected.pnl||0).toFixed(2)}</div>
            <div style={{marginBottom:12}}><Badge color={selected.outcome==="win"?"green":selected.outcome==="loss"?"red":"amber"}>{selected.outcome?.toUpperCase()}</Badge></div>
            {[{l:"Symbol",v:selected.symbol},{l:"Direction",v:selected.type?.toUpperCase()},{l:"Date",v:selected.date},{l:"Self Rating",v:ratingStars(selected.rating||3)}].map(x=>(
              <div key={x.l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
                <span style={{fontSize:12,color:T.textDim}}>{x.l}</span>
                <span style={{fontSize:12,fontWeight:600,color:T.text,fontFamily:x.l==="Self Rating"?"initial":"'JetBrains Mono',monospace"}}>{x.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  if(view==="new") return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>
      {(()=>{
        const drafts=entries.filter(e=>e.needsReview&&!e.reviewed);
        if(!drafts.length||view!=="new")return null;
        return (
          <div style={{background:T.blueBg,border:"1px solid rgba(79,128,255,.25)",borderRadius:10,padding:"10px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:12,color:T.blue}}><strong>{drafts.length} auto draft{drafts.length>1?"s":""}</strong> waiting — or fill in the form below for a manual entry</div>
            <button className="btn" style={{fontSize:11}} onClick={()=>{setSelected(drafts[0]);setView("detail");}}>Go to Draft</button>
          </div>
        );
      })()}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>New Journal Entry</h1>
        <div style={{display:"flex",gap:8}}>
          <button className="btn" onClick={()=>{setForm(EMPTY_FORM);setView("list");}}>Cancel</button>
          <button className="btn btn-primary" onClick={submitEntry} disabled={!form.symbol.trim()}>Save Entry</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        {/* Left column */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Trade Details</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Symbol *</div>
                <input className="input" placeholder="e.g. EURUSD" value={form.symbol} onChange={e=>setForm(f=>({...f,symbol:e.target.value.toUpperCase()}))} style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}/>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Date</div>
                <input className="input" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Direction</div>
                <div style={{display:"flex",gap:4}}>
                  {["buy","sell"].map(t=><button key={t} onClick={()=>setForm(f=>({...f,type:t}))} style={{flex:1,padding:"7px 0",borderRadius:7,border:"1px solid "+(form.type===t?(t==="buy"?T.greenBorder:T.redBorder):T.border),background:form.type===t?(t==="buy"?T.greenBg:T.redBg):"transparent",color:form.type===t?(t==="buy"?T.green:T.red):T.textSub,fontSize:12,fontWeight:600,cursor:"pointer",textTransform:"uppercase"}}>{t}</button>)}
                </div>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Outcome</div>
                <div style={{display:"flex",gap:4}}>
                  {["win","loss","breakeven"].map(o=><button key={o} onClick={()=>setForm(f=>({...f,outcome:o}))} style={{flex:1,padding:"7px 0",borderRadius:7,border:"1px solid "+(form.outcome===o?"rgba(79,128,255,.3)":T.border),background:form.outcome===o?T.blueBg:"transparent",color:form.outcome===o?T.blue:T.textSub,fontSize:10,fontWeight:600,cursor:"pointer",textTransform:"uppercase"}}>{o==="breakeven"?"BE":o}</button>)}
                </div>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>P&L ($)</div>
                <input className="input" type="number" step="any" placeholder="e.g. 45.20" value={form.pnl} onChange={e=>setForm(f=>({...f,pnl:e.target.value}))} style={{fontFamily:"'JetBrains Mono',monospace"}}/>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Setup Type</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {SETUPS.map(s=><button key={s} onClick={()=>setForm(f=>({...f,setup:f.setup===s?"":s}))} style={{padding:"4px 10px",borderRadius:6,border:"1px solid "+(form.setup===s?"rgba(79,128,255,.4)":T.border),background:form.setup===s?T.blueBg:"transparent",color:form.setup===s?T.blue:T.textSub,fontSize:11,cursor:"pointer",fontWeight:form.setup===s?600:400}}>{s}</button>)}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Self Rating</div>
              <div style={{display:"flex",gap:6}}>
                {[1,2,3,4,5].map(r=><button key={r} onClick={()=>setForm(f=>({...f,rating:r}))} style={{fontSize:22,background:"none",border:"none",cursor:"pointer",color:r<=form.rating?T.amber:T.border,padding:0,transition:"color .1s"}}>{r<=form.rating?"★":"☆"}</button>)}
                <span style={{fontSize:12,color:T.textDim,alignSelf:"center",marginLeft:4}}>{["","Bad","Below avg","Average","Good","Excellent"][form.rating]}</span>
              </div>
            </div>
          </div>

          {/* Emotion picker */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:10}}>Emotional State</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {EMOTIONS.map(em=><button key={em} onClick={()=>setForm(f=>({...f,emotion:f.emotion===em?"":em}))} style={{padding:"5px 12px",borderRadius:20,border:"1px solid "+(form.emotion===em?"rgba(139,92,246,.4)":T.border),background:form.emotion===em?T.purpleBg:"transparent",color:form.emotion===em?T.purple:T.textSub,fontSize:12,cursor:"pointer",fontWeight:form.emotion===em?600:400}}>{em}</button>)}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {/* Screenshot upload */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:10}}>Chart Screenshot</div>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
              const file=e.target.files?.[0];
              if(!file)return;
              const reader=new FileReader();
              reader.onload=ev=>setForm(f=>({...f,screenshot:ev.target.result}));
              reader.readAsDataURL(file);
              e.target.value="";
            }}/>
            {form.screenshot?(
              <div style={{position:"relative"}}>
                <img src={form.screenshot} alt="screenshot" style={{width:"100%",maxHeight:220,objectFit:"contain",borderRadius:8,background:T.bg,border:`1px solid ${T.border}`}}/>
                <button onClick={()=>setForm(f=>({...f,screenshot:null}))} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.5)",border:"none",color:"#fff",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:12}}>Remove</button>
              </div>
            ):(
              <div onClick={()=>fileRef.current?.click()} style={{border:`2px dashed ${T.border}`,borderRadius:10,padding:"32px",textAlign:"center",cursor:"pointer",background:T.bg,transition:"border-color .15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.blue} onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <div style={{fontSize:28,marginBottom:8,opacity:.3}}>+</div>
                <div style={{fontSize:13,color:T.textSub,fontWeight:500}}>Click to upload chart screenshot</div>
                <div style={{fontSize:11,color:T.textDim,marginTop:4}}>PNG, JPG, WebP supported</div>
              </div>
            )}
          </div>

          {/* Text notes */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Trade Notes</div>
            {[
              {k:"reason",l:"Why did you take this trade?",ph:"Describe the setup, confluence, reasoning..."},
              {k:"mistakes",l:"Any mistakes made?",ph:"What could you have done better?"},
              {k:"lessons",l:"Key lesson from this trade",ph:"What will you apply next time?"}
            ].map(f=>(
              <div key={f.k} style={{marginBottom:12}}>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>{f.l}</div>
                <textarea className="input" placeholder={f.ph} rows={3} value={form[f.k]} onChange={e=>setForm(ff=>({...ff,[f.k]:e.target.value}))} style={{resize:"vertical",lineHeight:1.6}}/>
              </div>
            ))}
            <div>
              <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Tags (comma separated)</div>
              <input className="input" placeholder="e.g. news trade, revenge, perfect setup" value={form.tags} onChange={e=>setForm(f=>({...f,tags:e.target.value}))}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // LIST VIEW
  const weekWins = entries.filter(e=>{const d=new Date(e.date);const wa=new Date(Date.now()-7*86400000);return d>=wa&&e.outcome==="win";}).length;
  const weekLosses = entries.filter(e=>{const d=new Date(e.date);const wa=new Date(Date.now()-7*86400000);return d>=wa&&e.outcome==="loss";}).length;
  const weekPnl = entries.filter(e=>{const d=new Date(e.date);return d>=new Date(Date.now()-7*86400000);}).reduce((s,e)=>s+(e.pnl||0),0);

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Trade Journal</h1>
          <div style={{fontSize:12,color:T.textSub,marginTop:2}}>{entries.length} entries logged</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {entries.length>=3&&<button className="btn" onClick={genCoaching} disabled={coachingLd}>{coachingLd?"Analysing...":"AI Coaching"}</button>}
          {coaching&&<button className="btn" onClick={()=>setView("coaching")}>View Coaching</button>}
          {entries.length>=5&&(()=>{
            const emotionMap={};
            entries.filter(e=>e.emotion).forEach(e=>{
              if(!emotionMap[e.emotion])emotionMap[e.emotion]={emotion:e.emotion,pnl:0,count:0};
              emotionMap[e.emotion].pnl+=(e.pnl||0);
              emotionMap[e.emotion].count++;
            });
            const ranked=Object.values(emotionMap).map(e=>({...e,avg:+(e.pnl/e.count).toFixed(2)})).sort((a,b)=>b.avg-a.avg);
            if(ranked.length<2)return null;
            const best=ranked[0],worst=ranked[ranked.length-1];
            return <div title={"Best: "+best.emotion+" ($"+best.avg+"/trade) | Worst: "+worst.emotion+" ($"+worst.avg+"/trade)"} style={{fontSize:11,color:T.textSub,background:T.bg,border:"1px solid "+T.border,borderRadius:7,padding:"4px 10px",cursor:"default",display:"flex",alignItems:"center",gap:5}}>
              <span style={{color:T.green}}>↑</span><strong style={{color:T.green}}>{best.emotion}</strong>
              <span style={{color:T.textDim}}>vs</span>
              <strong style={{color:T.red}}>{worst.emotion}</strong><span style={{color:T.red}}>↓</span>
            </div>;
          })()}
          {trades.length>0&&<button className="btn" style={{fontSize:11}} onClick={()=>{const t=[...trades].reverse()[0];setForm(f=>({...f,symbol:t.symbol||"",type:t.type||"buy",pnl:((t.profit||0)+(t.swap||0)+(t.commission||0)).toFixed(2),outcome:(t.profit||0)>0?"win":(t.profit||0)<0?"loss":"breakeven",date:mt5Day(t.closeTime)||localDay()}));setView("new");}}>Import MT5</button>}
          <button className="btn btn-primary" onClick={()=>setView("new")}>+ New Entry</button>
        </div>
      </div>

      {/* Week summary strip */}
      {entries.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
          {[
            {l:"This Week Trades",v:weekWins+weekLosses,c:T.blue},
            {l:"This Week Wins",v:weekWins,c:T.green},
            {l:"This Week Losses",v:weekLosses,c:T.red},
            {l:"This Week P&L",v:`$${weekPnl.toFixed(2)}`,c:weekPnl>=0?T.green:T.red}
          ].map(x=>(
            <div key={x.l} className="card" style={{padding:"12px 14px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:x.c}}/>
              <div style={{fontSize:10,color:T.textSub,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,marginTop:2}}>{x.l}</div>
              <div style={{fontSize:20,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Discipline Score */}
      {entries.length>=5&&(()=>{
        const recent=entries.slice(0,10);
        const logsWithEmotion=recent.filter(e=>e.emotion).length;
        const logsWithReason=recent.filter(e=>e.reason).length;
        const logsWithLesson=recent.filter(e=>e.lessons).length;
        const logsWithScreenshot=recent.filter(e=>e.screenshot).length;
        const logsWithMistakes=recent.filter(e=>e.mistakes).length;
        const score=Math.round((logsWithEmotion+logsWithReason+logsWithLesson+logsWithScreenshot+logsWithMistakes)/(recent.length*5)*100);
        const scoreColor=score>=80?T.green:score>=50?T.amber:T.red;
        const scoreLabel=score>=80?"Elite":score>=60?"Disciplined":score>=40?"Developing":"Inconsistent";
        // Current streak
        let streak=0,streakType=entries[0]?.outcome;
        for(const e of entries){if(e.outcome===streakType)streak++;else break;}
        const avgRating=entries.length?+(entries.slice(0,10).reduce((s,e)=>s+(e.rating||3),0)/Math.min(entries.length,10)).toFixed(1):0;
        return (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10,marginBottom:14}}>
            {[
              {l:"Discipline Score",v:score+"%",sub:scoreLabel,c:scoreColor},
              {l:"Current Streak",v:streak+(streakType==="win"?" W":" L"),sub:streakType==="win"?"Winning":"Losing",c:streakType==="win"?T.green:T.red},
              {l:"Avg Self Rating",v:avgRating+"/5",sub:"Last 10 trades",c:avgRating>=4?T.green:avgRating>=3?T.amber:T.red},
              {l:"Journal Quality",v:Math.round((logsWithScreenshot+logsWithLesson)/Math.min(entries.length,10)/2*100)+"%",sub:"Screenshot + lessons",c:T.blue},
            ].map(x=>(
              <div key={x.l} className="card" style={{padding:"12px 14px",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:x.c}}/>
                <div style={{fontSize:9,color:T.textSub,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,marginTop:2}}>{x.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{x.sub}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Emotion → P&L breakdown */}
      {entries.length>=5&&(()=>{
        const emotionMap={};
        entries.filter(e=>e.emotion).forEach(e=>{
          if(!emotionMap[e.emotion])emotionMap[e.emotion]={emotion:e.emotion,pnl:0,count:0,wins:0};
          emotionMap[e.emotion].pnl+=(e.pnl||0);
          emotionMap[e.emotion].count++;
          if((e.pnl||0)>0)emotionMap[e.emotion].wins++;
        });
        const data=Object.values(emotionMap).map(e=>({...e,avg:+(e.pnl/e.count).toFixed(2),wr:Math.round(e.wins/e.count*100)})).sort((a,b)=>b.avg-a.avg);
        if(data.length<2)return null;
        const maxAbs=Math.max(...data.map(d=>Math.abs(d.avg)),0.01);
        return (
          <div className="card" style={{padding:"14px 16px",marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:3}}>Emotion → P&L Impact</div>
            <div style={{fontSize:11,color:T.textSub,marginBottom:12}}>How your emotional state affects your results</div>
            {data.map(d=>(
              <div key={d.emotion} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:11,fontWeight:600,color:T.text}}>{d.emotion}</span>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    <span style={{fontSize:10,color:T.textDim}}>{d.count} trades · {d.wr}% WR</span>
                    <span style={{fontSize:12,fontWeight:700,color:d.avg>=0?T.green:T.red,fontFamily:"'JetBrains Mono',monospace"}}>{d.avg>=0?"+":""}{d.avg}/trade</span>
                  </div>
                </div>
                <div style={{height:5,background:T.bg,borderRadius:3,position:"relative"}}>
                  <div style={{position:"absolute",left:d.avg<0?(100-Math.abs(d.avg)/maxAbs*50)+"%":"50%",width:(Math.abs(d.avg)/maxAbs*50)+"%",height:"100%",background:d.avg>=0?T.green:T.red,borderRadius:3,transition:"width .5s"}}/>
                  <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1,background:T.border}}/>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Needs review banner */}
      {(()=>{
        const needsReview=entries.filter(e=>e.needsReview&&!e.reviewed);
        if(!needsReview.length)return null;
        return (
          <div style={{background:"linear-gradient(135deg,rgba(79,128,255,.08),rgba(139,92,246,.06))",border:"1px solid rgba(79,128,255,.25)",borderRadius:12,padding:"12px 16px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:T.blue,marginBottom:2}}>{needsReview.length} trade{needsReview.length>1?"s":""} auto-added from MT5</div>
              <div style={{fontSize:11,color:T.textSub}}>Add your notes, emotion and screenshot to complete {needsReview.length>1?"them":"it"}</div>
            </div>
            <button className="btn btn-primary" style={{fontSize:11}} onClick={()=>{setSelected(needsReview[0]);setView("detail");}}>Review Now</button>
          </div>
        );
      })()}

      {entries.length===0?(
        <div className="card" style={{padding:"48px 24px",textAlign:"center"}}>
          <div style={{fontSize:40,opacity:.15,marginBottom:16,fontWeight:800}}>J</div>
          <div style={{fontSize:16,fontWeight:600,color:T.text,marginBottom:8}}>Start your trading journal</div>
          <div style={{fontSize:13,color:T.textSub,maxWidth:360,margin:"0 auto 24px"}}>Log your trades with notes, screenshots, and emotions. Get AI coaching based on your own patterns after 3+ entries.</div>
          <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
            <button className="btn btn-primary" onClick={()=>setView("new")}>Log Your First Trade</button>
            {trades.length>0&&<button className="btn" onClick={()=>{const t=trades[trades.length-1];setForm(f=>({...f,symbol:t.symbol||"",type:t.type||"buy",pnl:((t.profit||0)+(t.swap||0)+(t.commission||0)).toFixed(2),outcome:(t.profit||0)>0?"win":(t.profit||0)<0?"loss":"breakeven",date:(t.closeTime||new Date().toISOString()).slice(0,10)}));setView("new");}}>Import Last MT5 Trade</button>}
          </div>
        </div>
      ):(
        <>
          {/* Quick import from latest MT5 trade */}
          {trades.length>0&&<div style={{background:"linear-gradient(135deg,rgba(79,128,255,.05),rgba(139,92,246,.05))",border:"1px solid rgba(79,128,255,.2)",borderRadius:10,padding:"10px 14px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:12,color:T.textSub}}>Latest MT5 trade: <strong style={{fontFamily:"'JetBrains Mono',monospace"}}>{([...trades].reverse()[0]?.symbol)||""}</strong> — add notes and screenshot to journal it</div>
            <button className="btn" style={{fontSize:11}} onClick={()=>{const t=[...trades].reverse()[0];setForm(f=>({...f,symbol:t.symbol||"",type:t.type||"buy",pnl:((t.profit||0)+(t.swap||0)+(t.commission||0)).toFixed(2),outcome:(t.profit||0)>0?"win":(t.profit||0)<0?"loss":"breakeven",date:(t.closeTime||new Date().toISOString()).slice(0,10)}));setView("new");}}>Import & Journal</button>
          </div>}

          {/* Filter + search */}
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",gap:3,background:"#fff",borderRadius:8,padding:3,border:`1px solid ${T.border}`}}>
              {[{k:"all",l:"All"},{k:"win",l:"Wins"},{k:"loss",l:"Losses"}].map(f=>(
                <button key={f.k} onClick={()=>setFilter(f.k)} style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:12,fontWeight:filter===f.k?700:400,background:filter===f.k?T.blue:"transparent",color:filter===f.k?"#fff":T.textSub}}>
                  {f.l}
                </button>
              ))}
            </div>
            <input className="input" placeholder="Search symbol, setup..." value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:220,fontSize:12}}/>
            <span style={{fontSize:11,color:T.textDim,marginLeft:"auto"}}>{filtered.length} entries</span>
          </div>

          {/* Entry cards */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {filtered.map(entry=>(
              <div key={entry.id} className="card" style={{display:"flex",gap:0,overflow:"hidden",cursor:"pointer",transition:"box-shadow .15s"}}
                onClick={()=>{setSelected(entry);setView("detail");}}>
                {/* Colour stripe */}
                <div style={{width:4,background:outcomeColor(entry.outcome),flexShrink:0}}/>
                <div style={{flex:1,padding:"12px 16px",display:"grid",gridTemplateColumns:"100px 1fr 1fr 120px 100px 80px",gap:12,alignItems:"center"}}>
                  {/* Symbol + date */}
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{entry.symbol}</span>
                      {entry.auto&&!entry.reviewed&&<span style={{fontSize:9,fontWeight:700,color:T.blue,background:T.blueBg,border:"1px solid rgba(79,128,255,.25)",borderRadius:4,padding:"1px 5px"}}>AUTO</span>}
                      {entry.needsReview&&!entry.reviewed&&<span style={{fontSize:9,fontWeight:700,color:T.amber,background:T.amberBg,border:"1px solid rgba(245,158,11,.25)",borderRadius:4,padding:"1px 5px"}}>REVIEW</span>}
                    </div>
                    <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{entry.date}</div>
                  </div>
                  {/* Setup */}
                  <div>
                    <div style={{fontSize:11,color:T.textDim,marginBottom:2}}>Setup</div>
                    <div style={{fontSize:12,color:T.text}}>{entry.setup||"—"}</div>
                  </div>
                  {/* Reason snippet */}
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:11,color:T.textDim,marginBottom:2}}>Reason</div>
                    <div style={{fontSize:12,color:T.textSub,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{entry.reason||"No notes"}</div>
                  </div>
                  {/* Direction + outcome */}
                  <div style={{display:"flex",gap:5}}>
                    <Badge color={entry.type==="buy"?"green":"red"}>{(entry.type||"").toUpperCase()}</Badge>
                    <Badge color={entry.outcome==="win"?"green":entry.outcome==="loss"?"red":"gray"}>{entry.outcome?.toUpperCase()}</Badge>
                  </div>
                  {/* P&L */}
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:outcomeColor(entry.outcome)}}>{(entry.pnl||0)>=0?"+":""}{(entry.pnl||0).toFixed(2)}</div>
                    <div style={{fontSize:10,color:T.textDim,marginTop:1}}>{ratingStars(entry.rating||3)}</div>
                  </div>
                  {/* Screenshot indicator */}
                  <div style={{textAlign:"right"}}>
                    {entry.screenshot&&<span style={{fontSize:10,background:T.blueBg,color:T.blue,border:`1px solid rgba(79,128,255,.25)`,borderRadius:5,padding:"2px 7px",fontWeight:600}}>IMG</span>}
                    <button onClick={e=>{e.stopPropagation();deleteEntry(entry.id);}} style={{display:"block",marginLeft:"auto",marginTop:4,background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:16,lineHeight:1}}>x</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ── CRYPTO ────────────────────────────────────────────────────

const CRYPTO_COINS = [
  {id:"BTC",  name:"Bitcoin",   color:"#f7931a", bg:"rgba(247,147,26,0.1)"},
  {id:"ETH",  name:"Ethereum",  color:"#627eea", bg:"rgba(98,126,234,0.1)"},
  {id:"XRP",  name:"XRP",       color:"#00aae4", bg:"rgba(0,170,228,0.1)"},
  {id:"SOL",  name:"Solana",    color:"#9945ff", bg:"rgba(153,69,255,0.1)"},
  {id:"BNB",  name:"BNB",       color:"#f3ba2f", bg:"rgba(243,186,47,0.1)"},
  {id:"ADA",  name:"Cardano",   color:"#0033ad", bg:"rgba(0,51,173,0.1)"},
  {id:"DOGE", name:"Dogecoin",  color:"#c2a633", bg:"rgba(194,166,51,0.1)"},
  {id:"LTC",  name:"Litecoin",  color:"#b0b0b0", bg:"rgba(176,176,176,0.1)"},
];

const EXCHANGES = [
  {id:"bybit",    name:"Bybit",    color:"#f7a600", logo:"B", url:"https://api.bybit.com"},
  {id:"binance",  name:"Binance",  color:"#f0b90b", logo:"N", url:"https://api.binance.com"},
  {id:"coinbase", name:"Coinbase", color:"#0052ff", logo:"C", url:"https://api.coinbase.com"},
  {id:"okx",      name:"OKX",      color:"#000000", logo:"O", url:"https://www.okx.com"},
  {id:"kucoin",   name:"KuCoin",   color:"#00a550", logo:"K", url:"https://api.kucoin.com"},
];

// Fetch price from Bybit public API (no key needed for prices)
async function fetchBybitPrice(symbol){
  try{
    const r=await fetch("https://api.bybit.com/v5/market/tickers?category=spot&symbol="+symbol+"USDT",{signal:AbortSignal.timeout(8000)});
    const d=await r.json();
    const t=d?.result?.list?.[0];
    if(!t)return null;
    return{price:parseFloat(t.lastPrice),chg:parseFloat(t.price24hPcnt)*100,high:parseFloat(t.highPrice24h),low:parseFloat(t.lowPrice24h),vol:parseFloat(t.volume24h),turnover:parseFloat(t.turnover24h)};
  }catch{return null;}
}

// Fetch price from Binance public API (no key needed)
async function fetchBinancePrice(symbol){
  try{
    const r=await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol="+symbol+"USDT",{signal:AbortSignal.timeout(8000)});
    const d=await r.json();
    if(!d||d.code)return null;
    return{price:parseFloat(d.lastPrice),chg:parseFloat(d.priceChangePercent),high:parseFloat(d.highPrice),low:parseFloat(d.lowPrice),vol:parseFloat(d.volume),turnover:parseFloat(d.quoteVolume)};
  }catch{return null;}
}

// Fetch from Coinbase public API
async function fetchCoinbasePrice(symbol){
  try{
    const r=await fetch("https://api.coinbase.com/v2/prices/"+symbol+"-USD/spot",{signal:AbortSignal.timeout(8000)});
    const d=await r.json();
    if(!d?.data?.amount)return null;
    return{price:parseFloat(d.data.amount),chg:0,high:0,low:0,vol:0,turnover:0};
  }catch{return null;}
}

// Fetch portfolio from exchange using API key — server-side proxy
async function fetchExchangePortfolio(exchange, apiKey, apiSecret, passphrase){
  try{
    let url=SERVER+"/api/crypto-portfolio?exchange="+exchange+"&key="+encodeURIComponent(apiKey)+"&secret="+encodeURIComponent(apiSecret||"");
    if(passphrase)url+="&passphrase="+encodeURIComponent(passphrase);
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
    const data=await r.json();
    if(!r.ok)return{error:data?.error||"Server error "+r.status};
    return data;
  }catch(e){return{error:e.message};}
}

// Fear & Greed derived from BTC movement
function fearGreedFromPrice(btcData){
  if(!btcData)return null;
  const chg=btcData.chg||0, vol=btcData.high&&btcData.low&&btcData.price?(btcData.high-btcData.low)/btcData.price*100:0;
  let score=50;
  if(chg>5)score+=25;else if(chg>2)score+=14;else if(chg>0.5)score+=7;
  else if(chg<-5)score-=25;else if(chg<-2)score-=14;else if(chg<-0.5)score-=7;
  if(vol>8)score-=8;else if(vol<2)score+=4;
  return Math.max(0,Math.min(100,Math.round(score)));
}

function CryptoTab({prices, pFlash, onAddSymbol}){
  const [selected, setSelected]=useState("BTC");
  const [cryptoPrices, setCryptoPrices]=useState({});
  const [loading, setLoading]=useState(false);
  const [activeExchange, setActiveExchange]=useState(()=>{try{return localStorage.getItem("tl_cx_active")||"bybit";}catch{return"bybit";}});
  const [apiKeys, setApiKeys]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_cx_keys")||"{}");}catch{return{};}});
  const [showConnect, setShowConnect]=useState(false);
  const [connectExchange, setConnectExchange]=useState("bybit");
  const [connectKey, setConnectKey]=useState("");
  const [connectSecret, setConnectSecret]=useState("");
  const [connectPassphrase, setConnectPassphrase]=useState("");
  const [portfolio, setPortfolio]=useState(null);
  const [portfolioLd, setPortfolioLd]=useState(false);
  const [portfolioErr, setPortfolioErr]=useState(null);
  const [cryptoTrades, setCryptoTrades]=useState(null);
  const [cryptoTradesLd, setCryptoTradesLd]=useState(false);
  const [cryptoTradesErr, setCryptoTradesErr]=useState(null);
  const [tradeView, setTradeView]=useState("overview"); // overview | history | analysis

  const selCoin=CRYPTO_COINS.find(c=>c.id===selected)||CRYPTO_COINS[0];
  const selData=cryptoPrices[selected];

  // Load crypto prices — prefer Twelve Data via server, fallback to exchange public APIs
  const loadPrices=useCallback(async()=>{
    setLoading(true);
    // Try Twelve Data first (via our server /api/quote)
    try{
      const syms=CRYPTO_COINS.map(c=>c.id+"USD").join(",");
      const r=await fetch(SERVER+"/api/quote?symbols="+syms,{signal:AbortSignal.timeout(10000)});
      if(r.ok){
        const d=await r.json();
        const quotes=d.quotes||{};
        const results={};
        CRYPTO_COINS.forEach(coin=>{
          const q=quotes[coin.id+"USD"];
          if(q?.price){
            results[coin.id]={
              price:parseFloat(q.price),
              chg:parseFloat(q.changePct)||0,
              high:parseFloat(q.high)||0,
              low:parseFloat(q.low)||0,
              vol:0,turnover:0
            };
          }
        });
        if(Object.keys(results).length>=4){
          setCryptoPrices(results);
          setLoading(false);
          return;
        }
      }
    }catch{}
    // Fallback: fetch from exchange public APIs
    const results={};
    const fetcher=activeExchange==="binance"?fetchBinancePrice:activeExchange==="coinbase"?fetchCoinbasePrice:fetchBybitPrice;
    await Promise.all(CRYPTO_COINS.map(async coin=>{
      const d=await fetcher(coin.id);
      if(d)results[coin.id]=d;
    }));
    setCryptoPrices(results);
    setLoading(false);
  },[activeExchange]);

  useEffect(()=>{loadPrices();},[loadPrices]);
  useEffect(()=>{const t=setInterval(loadPrices,30000);return()=>clearInterval(t);},[loadPrices]);

  // Load portfolio if API key saved
  const loadPortfolio=useCallback(async()=>{
    const keys=apiKeys[activeExchange];
    if(!keys?.key)return;
    setPortfolioLd(true);setPortfolioErr(null);
    const res=await fetchExchangePortfolio(activeExchange,keys.key,keys.secret||"",keys.passphrase||"");
    if(res.error)setPortfolioErr(res.error);
    else setPortfolio(res);
    setPortfolioLd(false);
  },[activeExchange,apiKeys]);

  const loadCryptoTrades=useCallback(async()=>{
    const keys=apiKeys[activeExchange];
    if(!keys?.key)return;
    setCryptoTradesLd(true);setCryptoTradesErr(null);
    try{
      let url=SERVER+"/api/crypto-trades?exchange="+activeExchange+"&key="+encodeURIComponent(keys.key)+"&secret="+encodeURIComponent(keys.secret||"");
      if(keys.passphrase)url+="&passphrase="+encodeURIComponent(keys.passphrase);
      const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
      const d=await r.json();
      if(!r.ok)setCryptoTradesErr(d?.error||"Server error "+r.status);
      else setCryptoTrades(d);
    }catch(e){setCryptoTradesErr(e.message);}
    setCryptoTradesLd(false);
  },[activeExchange,apiKeys]);

  useEffect(()=>{loadPortfolio();loadCryptoTrades();},[loadPortfolio,loadCryptoTrades]);

  const saveApiKey=()=>{
    if(!connectKey.trim())return;
    const nk={...apiKeys,[connectExchange]:{key:connectKey.trim(),secret:connectSecret.trim(),passphrase:connectPassphrase.trim()}};
    setApiKeys(nk);try{localStorage.setItem("tl_cx_keys",JSON.stringify(nk));}catch{}
    setActiveExchange(connectExchange);try{localStorage.setItem("tl_cx_active",connectExchange);}catch{}
    setShowConnect(false);setConnectKey("");setConnectSecret("");setConnectPassphrase("");
    setTimeout(loadPortfolio,500);
  };

  const removeKey=()=>{
    const nk={...apiKeys};delete nk[activeExchange];
    setApiKeys(nk);try{localStorage.setItem("tl_cx_keys",JSON.stringify(nk));}catch{}
    setPortfolio(null);
  };

  const connectedExchanges=Object.keys(apiKeys).filter(k=>apiKeys[k]?.key);
  const fgScore=fearGreedFromPrice(cryptoPrices["BTC"]);
  const fgLabel=fgScore===null?"--":fgScore>=80?"Extreme Greed":fgScore>=60?"Greed":fgScore>=45?"Neutral":fgScore>=25?"Fear":"Extreme Fear";
  const fgColor=fgScore===null?T.textDim:fgScore>=60?T.green:fgScore>=45?T.amber:T.red;

  // Signal from live data
  const sig=selData?(()=>{
    const {price,chg,high,low}=selData;
    const range=(high||price*1.02)-(low||price*0.98);
    const rangePct=range>0?(price-(low||price*0.98))/range:0.5;
    const abs=Math.abs(chg);
    let signal,conf;
    if(chg>3&&rangePct>0.6){signal="BUY";conf=Math.min(82,56+Math.round(abs*3));}
    else if(chg<-3&&rangePct<0.4){signal="SELL";conf=Math.min(82,56+Math.round(abs*3));}
    else if(chg>1){signal="BUY";conf=57;}
    else if(chg<-1){signal="SELL";conf=57;}
    else{signal="HOLD";conf=48;}
    const dec=price>10000?0:price>100?2:price>1?4:6;
    const fmt=v=>"$"+v.toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec});
    const sup=+(price*(1-range/price*0.4)).toFixed(dec);
    const res=+(price*(1+range/price*0.4)).toFixed(dec);
    const tgt=signal==="BUY"?+(price*(1+range/price*0.5)).toFixed(dec):signal==="SELL"?+(price*(1-range/price*0.5)).toFixed(dec):price;
    return {signal,conf,sup,res,tgt,fmt,dec,rangePct};
  })():null;

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:20}}>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Crypto</h1>
          {cryptoPrices["BTC"]&&(()=>{
            const btc=cryptoPrices["BTC"],eth=cryptoPrices["ETH"],sol=cryptoPrices["SOL"];
            const btcChg=btc?.chg||0,ethChg=eth?.chg||0,solChg=sol?.chg||0;
            const altsSurging=ethChg>btcChg+2||solChg>btcChg+2;
            const altsWeak=ethChg<btcChg-2||solChg<btcChg-2;
            const altsFollowing=Math.abs(ethChg-btcChg)<1.5&&Math.abs(solChg-btcChg)<2;
            const label=altsWeak?"BTC Season":altsSurging?"Alt Season":altsFollowing?"Correlated":"Diverging";
            const color=altsSurging?T.purple:altsWeak?T.amber:altsFollowing?T.blue:T.textDim;
            const bg=altsSurging?T.purpleBg:altsWeak?T.amberBg:altsFollowing?T.blueBg:T.bg;
            const border=altsSurging?"rgba(139,92,246,.3)":altsWeak?"rgba(245,158,11,.3)":altsFollowing?"rgba(79,128,255,.3)":T.border;
            return <span title={altsWeak?"Alts lagging BTC — trade BTC/ETH only":altsSurging?"Alts outperforming — alt setups valid":altsFollowing?"BTC dictates direction — follow BTC trend":"Mixed signals — wait for clarity"}
              style={{fontSize:11,fontWeight:700,color,background:bg,border:"1px solid "+border,borderRadius:6,padding:"3px 10px",cursor:"default",display:"flex",alignItems:"center",gap:5,letterSpacing:"0.03em"}}>
              <span style={{fontSize:9,opacity:.7}}>REGIME</span>{label}
            </span>;
          })()}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {/* Fear & Greed */}
          <div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:10,padding:"8px 14px",display:"flex",alignItems:"center",gap:10}}>
            <div>
              <div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:1}}>Market Sentiment</div>
              <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                <span style={{fontSize:20,fontWeight:800,color:fgColor,fontFamily:"'JetBrains Mono',monospace"}}>{fgScore===null?"--":fgScore}</span>
                <span style={{fontSize:11,fontWeight:600,color:fgColor}}>{fgLabel}</span>
              </div>
            </div>
          </div>
          {/* Exchange switcher */}
          <div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:10,padding:"4px"}}>
            <div style={{display:"flex",gap:2}}>
              {EXCHANGES.slice(0,3).map(ex=>{
                const connected=!!apiKeys[ex.id]?.key;
                const active=activeExchange===ex.id;
                return <button key={ex.id} onClick={()=>{setActiveExchange(ex.id);try{localStorage.setItem("tl_cx_active",ex.id);}catch{}}}
                  style={{padding:"5px 10px",borderRadius:7,border:"none",cursor:"pointer",fontSize:11,fontWeight:active?700:400,background:active?ex.color:"transparent",color:active?"#fff":T.textSub,transition:"all .15s",display:"flex",alignItems:"center",gap:4}}>
                  {connected&&<div style={{width:5,height:5,borderRadius:"50%",background:active?"rgba(255,255,255,.7)":T.green}}/>}
                  {ex.name}
                </button>;
              })}
            </div>
          </div>
          <button className="btn btn-primary" onClick={()=>setShowConnect(true)} style={{fontSize:11}}>Connect Exchange</button>
        </div>
      </div>

      {/* Connect Exchange Modal */}
      {showConnect&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.4)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:16,padding:28,width:"min(480px,95vw)",boxShadow:"0 24px 64px rgba(0,0,0,0.2)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:15,fontWeight:700}}>Connect Exchange</div>
              <button onClick={()=>setShowConnect(false)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:T.textDim,lineHeight:1}}>x</button>
            </div>

            {/* Exchange picker */}
            <div style={{fontSize:11,color:T.textDim,fontWeight:600,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.04em"}}>Select Exchange</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:18}}>
              {EXCHANGES.map(ex=>{
                const connected=!!apiKeys[ex.id]?.key;
                return (
                  <div key={ex.id} onClick={()=>setConnectExchange(ex.id)}
                    style={{border:"2px solid "+(connectExchange===ex.id?ex.color:T.border),borderRadius:10,padding:"10px 8px",cursor:"pointer",textAlign:"center",background:connectExchange===ex.id?ex.color+"12":"transparent",transition:"all .15s"}}>
                    <div style={{width:32,height:32,borderRadius:8,background:ex.color+"20",border:"1px solid "+ex.color+"40",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:ex.color,margin:"0 auto 6px"}}>{ex.logo}</div>
                    <div style={{fontSize:11,fontWeight:600,color:T.text}}>{ex.name}</div>
                    {connected&&<div style={{fontSize:9,color:T.green,marginTop:2,fontWeight:600}}>Connected</div>}
                  </div>
                );
              })}
            </div>

            {/* Key fields */}
            <div style={{background:T.bg,borderRadius:10,padding:"14px 16px",marginBottom:18}}>
              <div style={{fontSize:12,color:T.textSub,marginBottom:12,lineHeight:1.6}}>
                Use <strong>read-only</strong> API keys — TradeLedger only reads your balances and trade history. It cannot place orders.
              </div>
              <div style={{marginBottom:10}}>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:600}}>API Key</div>
                <input className="input" placeholder="Paste your API key..." value={connectKey} onChange={e=>setConnectKey(e.target.value)} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12}}/>
              </div>
              <div>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:600}}>API Secret (optional for price data)</div>
                <input className="input" type="password" placeholder="Paste your API secret..." value={connectSecret} onChange={e=>setConnectSecret(e.target.value)} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12}}/>
              </div>
            </div>

            {/* How to get keys */}
            <div style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:600,color:T.textDim,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.04em"}}>How to get your API key</div>
              {({bybit:"1. Bybit → Profile → API Management → Create New Key → select 'Read-Only' → copy API Key and Secret",binance:"1. Binance → Profile → API Management → Create API → enable 'Read Only' → copy Key and Secret",coinbase:"1. Coinbase → Settings → API → New API Key → check 'wallet:accounts:read' → copy Key",okx:"1. OKX → Account → API → Create API Key → select Read permission → copy Key and Secret",kucoin:"1. KuCoin → Profile → API Management → Create API → select Read-Only → copy Key, Secret, Passphrase"})[connectExchange].split("\n").map((s,i)=>(
                <div key={i} style={{fontSize:11,color:T.textSub,lineHeight:1.6,marginBottom:4}}>{s}</div>
              ))}
            </div>

            <div style={{display:"flex",gap:8}}>
              <button className="btn" style={{flex:1,justifyContent:"center"}} onClick={()=>setShowConnect(false)}>Cancel</button>
              <button className="btn btn-primary" style={{flex:1,justifyContent:"center"}} disabled={!connectKey.trim()} onClick={saveApiKey}>Connect {EXCHANGES.find(e=>e.id===connectExchange)?.name}</button>
            </div>
          </div>
        </div>
      )}

      {/* Main layout */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:14}}>

        {/* Left: prices + analysis */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          {/* Coin grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {CRYPTO_COINS.map(coin=>{
              const d=cryptoPrices[coin.id];
              const isSelected=selected===coin.id;
              const chg=d?.chg||0;
              return (
                <div key={coin.id} onClick={()=>setSelected(coin.id)}
                  style={{cursor:"pointer",background:isSelected?coin.color+"18":T.surface,border:"2px solid "+(isSelected?coin.color:T.border),borderRadius:12,padding:"12px 14px",transition:"all .15s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div style={{width:32,height:32,borderRadius:8,background:coin.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:coin.color}}>{coin.id.slice(0,3)}</div>
                    {d&&<span style={{fontSize:10,fontWeight:700,color:chg>=0?T.green:T.red,background:chg>=0?T.greenBg:T.redBg,padding:"2px 6px",borderRadius:4}}>{chg>=0?"+":""}{chg.toFixed(2)}%</span>}
                  </div>
                  <div style={{fontSize:11,fontWeight:600,color:isSelected?coin.color:T.textSub,marginBottom:2}}>{coin.id}</div>
                  {loading&&!d?<div className="skeleton" style={{height:16,width:"80%",borderRadius:4}}/>:
                  d?<div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:T.text}}>${d.price.toLocaleString(undefined,{maximumFractionDigits:d.price>100?2:4})}</div>:
                  <div style={{fontSize:11,color:T.textDim}}>No data</div>}
                  {d?.vol>0&&<div style={{fontSize:9,color:T.textDim,marginTop:2}}>Vol: {d.vol>1e9?(d.vol/1e9).toFixed(1)+"B":d.vol>1e6?(d.vol/1e6).toFixed(1)+"M":d.vol.toFixed(0)}</div>}
                </div>
              );
            })}
          </div>

          {/* Selected coin analysis */}
          {selData&&sig&&(
            <div className="card" style={{padding:"20px 22px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,background:sig.signal==="BUY"?T.green:sig.signal==="SELL"?T.red:T.purple}}/>
              <div style={{position:"absolute",top:0,right:0,width:160,height:160,borderRadius:"50%",background:selCoin.bg,transform:"translate(30%,-30%)",pointerEvents:"none",opacity:.6}}/>
              <div style={{paddingLeft:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    <div style={{width:44,height:44,borderRadius:12,background:selCoin.bg,border:"1px solid "+selCoin.color+"40",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:800,color:selCoin.color}}>{selCoin.id}</div>
                    <div>
                      <div style={{fontSize:16,fontWeight:700}}>{selCoin.name}</div>
                      <div style={{fontSize:11,color:T.textDim}}>via {EXCHANGES.find(e=>e.id===activeExchange)?.name} · 24h data</div>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{background:sig.signal==="BUY"?T.greenBg:sig.signal==="SELL"?T.redBg:T.purpleBg,border:"1px solid "+(sig.signal==="BUY"?T.greenBorder:sig.signal==="SELL"?T.redBorder:"rgba(139,92,246,.3)"),borderRadius:8,padding:"5px 16px",fontSize:14,fontWeight:800,color:sig.signal==="BUY"?T.green:sig.signal==="SELL"?T.red:T.purple}}>{sig.signal}</div>
                    <div style={{fontSize:10,color:T.textDim,marginTop:3,textAlign:"center"}}>Confidence {sig.conf}%</div>
                  </div>
                </div>
                {/* Price */}
                <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:14}}>
                  <span style={{fontSize:36,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",letterSpacing:"-1.5px"}}>{sig.fmt(selData.price)}</span>
                  <span style={{fontSize:15,fontWeight:700,color:selData.chg>=0?T.green:T.red,background:selData.chg>=0?T.greenBg:T.redBg,padding:"3px 10px",borderRadius:6}}>{selData.chg>=0?"+":""}{selData.chg.toFixed(2)}%</span>
                </div>
                {/* 24h range */}
                {selData.high>0&&selData.low>0&&(
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:4}}>
                      <span>24h Low: {sig.fmt(selData.low)}</span>
                      <span>24h High: {sig.fmt(selData.high)}</span>
                    </div>
                    <div style={{height:6,background:T.bg,borderRadius:3,position:"relative"}}>
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:(sig.rangePct*100)+"%",background:"linear-gradient(90deg,"+T.red+"50,"+selCoin.color+")",borderRadius:3}}/>
                      <div style={{position:"absolute",top:"50%",left:(sig.rangePct*100)+"%",transform:"translate(-50%,-50%)",width:12,height:12,borderRadius:"50%",background:selCoin.color,border:"2px solid "+T.surface,boxShadow:"0 2px 6px rgba(0,0,0,.2)"}}/>
                    </div>
                  </div>
                )}
                {/* Key levels */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                  {[{l:"Support",v:sig.fmt(sig.sup),c:T.green,bg:T.greenBg},{l:"Target",v:sig.fmt(sig.tgt),c:selCoin.color,bg:selCoin.bg},{l:"Resistance",v:sig.fmt(sig.res),c:T.red,bg:T.redBg}].map(lv=>(
                    <div key={lv.l} style={{background:lv.bg,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontSize:9,color:T.textDim,marginBottom:3,textTransform:"uppercase",letterSpacing:"0.05em"}}>{lv.l}</div>
                      <div style={{fontSize:12,fontWeight:700,color:lv.c,fontFamily:"'JetBrains Mono',monospace"}}>{lv.v}</div>
                    </div>
                  ))}
                </div>
                {/* Confidence */}
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:4}}>
                    <span>Signal Strength</span>
                    <span style={{fontWeight:600,color:sig.conf>=70?T.green:sig.conf>=55?T.amber:T.textDim}}>{sig.conf>=70?"Strong":sig.conf>=55?"Moderate":"Weak"} · {sig.conf}%</span>
                  </div>
                  <div style={{height:4,background:T.bg,borderRadius:2}}><div style={{height:"100%",width:sig.conf+"%",background:sig.conf>=70?T.green:sig.conf>=55?T.amber:T.textDim,borderRadius:2,transition:"width .6s"}}/></div>
                </div>
                {/* Volume */}
                {selData.turnover>0&&(
                  <div style={{display:"flex",gap:20,padding:"10px 12px",background:T.bg,borderRadius:8}}>
                    <div><div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>24h Volume</div><div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:T.text}}>{selData.vol>1e6?(selData.vol/1e6).toFixed(2)+"M":selData.vol.toFixed(0)} {selCoin.id}</div></div>
                    <div><div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>24h Turnover</div><div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:T.text}}>${selData.turnover>1e9?(selData.turnover/1e9).toFixed(2)+"B":selData.turnover>1e6?(selData.turnover/1e6).toFixed(2)+"M":selData.turnover.toFixed(0)}</div></div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* How to trade */}
          {sig&&selData&&(
            <div className="card" style={{padding:"16px 18px"}}>
              <div style={{fontSize:12,fontWeight:700,color:sig.signal==="BUY"?T.green:sig.signal==="SELL"?T.red:T.purple,marginBottom:12,textTransform:"uppercase",letterSpacing:"0.05em"}}>How to Trade {selCoin.name} Now</div>
              {(sig.signal==="BUY"?[
                `Look for a pullback toward ${sig.fmt(sig.sup)} — enter long on green candle confirmation`,
                `Target ${sig.fmt(sig.tgt)} (~${((sig.tgt-selData.price)/selData.price*100).toFixed(1)}% upside) · stop loss below ${sig.fmt(sig.sup)}`,
                `Size down — crypto volatility is 5–10x higher than forex. Risk max 1% of account`,
                `Watch BTC — if Bitcoin drops while ${selCoin.id} is bullish, wait for BTC to stabilise first`,
              ]:sig.signal==="SELL"?[
                `Wait for a bounce toward ${sig.fmt(sig.res)} before entering short — never chase the move`,
                `Target ${sig.fmt(sig.tgt)} with stop above ${sig.fmt(sig.res)} — trail stop as price falls`,
                `Crypto downtrends are fast — use market orders, not limit orders, to exit`,
                `Check funding rates on your exchange — negative funding accelerates the downside`,
              ]:[
                `${selCoin.name} is consolidating between ${sig.fmt(sig.sup)} support and ${sig.fmt(sig.res)} resistance`,
                `Wait for a decisive break — bullish above ${sig.fmt(sig.res)}, bearish below ${sig.fmt(sig.sup)}`,
                `Volume is key: a breakout on high volume is real · on low volume it's a fakeout`,
              ]).map((step,i)=>(
                <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i<3?8:0}}>
                  <div style={{minWidth:18,height:18,borderRadius:5,background:selCoin.color+"25",border:"1px solid "+selCoin.color+"40",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:selCoin.color,fontWeight:800,flexShrink:0,marginTop:1}}>{i+1}</div>
                  <div style={{fontSize:12,color:T.textSub,lineHeight:1.65}}>{step}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: portfolio + trade analysis */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          {/* Tab switcher */}
          <div style={{display:"flex",gap:2,background:T.surface,borderRadius:10,padding:3,border:"1px solid "+T.border}}>
            {[{k:"overview",l:"Portfolio"},{k:"history",l:"Trade History"},{k:"analysis",l:"My Analysis"}].map(t=>(
              <button key={t.k} onClick={()=>setTradeView(t.k)} style={{flex:1,padding:"5px 0",borderRadius:7,border:"none",cursor:"pointer",fontSize:11,fontWeight:tradeView===t.k?700:400,background:tradeView===t.k?T.blue:"transparent",color:tradeView===t.k?"#fff":T.textSub,transition:"all .15s"}}>{t.l}</button>
            ))}
          </div>

          {/* Connected exchange + portfolio */}
          {tradeView==="overview"&&<div className="card" style={{overflow:"hidden"}}>
            <div style={{padding:"12px 14px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,fontWeight:600}}>Portfolio</div>
                <div style={{fontSize:10,color:T.textDim,marginTop:1}}>{EXCHANGES.find(e=>e.id===activeExchange)?.name}</div>
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {apiKeys[activeExchange]?.key?(
                  <>
                    <div style={{width:6,height:6,borderRadius:"50%",background:T.green}}/>
                    <span style={{fontSize:10,color:T.green,fontWeight:600}}>Connected</span>
                    <button onClick={removeKey} style={{fontSize:10,background:"none",border:"none",color:T.textDim,cursor:"pointer",marginLeft:4}}>Disconnect</button>
                  </>
                ):(
                  <button className="btn" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setShowConnect(true)}>Connect</button>
                )}
              </div>
            </div>
            <div style={{padding:"14px"}}>
              {!apiKeys[activeExchange]?.key&&(
                <div style={{textAlign:"center",padding:"24px 0"}}>
                  <div style={{fontSize:24,opacity:.15,marginBottom:8,fontWeight:800}}>◈</div>
                  <div style={{fontSize:12,color:T.textSub,marginBottom:12,lineHeight:1.6}}>Connect your {EXCHANGES.find(e=>e.id===activeExchange)?.name} account to see your real portfolio balance and positions</div>
                  <button className="btn btn-primary" style={{fontSize:11}} onClick={()=>setShowConnect(true)}>Connect {EXCHANGES.find(e=>e.id===activeExchange)?.name}</button>
                </div>
              )}
              {portfolioLd&&<div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:12,padding:"8px 0"}}><Spinner size={13}/>Loading portfolio...</div>}
              {portfolioErr&&<div style={{fontSize:12,color:T.red,padding:"8px 0"}}>{portfolioErr}</div>}
              {portfolio&&!portfolioLd&&(()=>{
                const balances=portfolio.balances||portfolio.assets||[];
                const totalUSD=portfolio.totalUSD||portfolio.total||0;
                return (
                  <>
                    <div style={{fontSize:22,fontWeight:800,color:T.text,fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>${totalUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                    <div style={{fontSize:11,color:T.textDim,marginBottom:12}}>Total portfolio value (USD)</div>
                    {balances.filter(b=>parseFloat(b.free||b.amount||0)>0).slice(0,8).map((b,i)=>(
                      <div key={i} className="trow" style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{width:26,height:26,borderRadius:6,background:(CRYPTO_COINS.find(c=>c.id===b.coin||c.id===b.asset)?.bg)||T.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:(CRYPTO_COINS.find(c=>c.id===b.coin||c.id===b.asset)?.color)||T.textDim}}>
                            {(b.coin||b.asset||"?").slice(0,3)}
                          </div>
                          <div>
                            <div style={{fontSize:11,fontWeight:600}}>{b.coin||b.asset}</div>
                            <div style={{fontSize:9,color:T.textDim}}>{parseFloat(b.free||b.amount||0).toFixed(4)}</div>
                          </div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>${(parseFloat(b.usdValue||b.free_usd||0)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                        </div>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          </div>


          }

          {/* TRADE HISTORY VIEW */}
          {tradeView==="history"&&(
            <div className="card" style={{overflow:"hidden"}}>
              <div style={{padding:"12px 14px",borderBottom:"1px solid "+T.border,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:12,fontWeight:600}}>Trade History</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {apiKeys[activeExchange]?.key&&<button className="btn" style={{fontSize:10,padding:"3px 8px"}} onClick={loadCryptoTrades}>{cryptoTradesLd?"Loading...":"Refresh"}</button>}
                </div>
              </div>
              <div style={{padding:"12px 14px"}}>
                {!apiKeys[activeExchange]?.key&&<div style={{textAlign:"center",padding:"20px 0",color:T.textDim,fontSize:12}}>Connect an exchange to see your trade history</div>}
                {cryptoTradesLd&&<div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:12}}><Spinner size={13}/>Loading trades...</div>}
                {cryptoTradesErr&&<div style={{fontSize:12,color:T.red}}>{cryptoTradesErr}</div>}
                {cryptoTrades&&!cryptoTradesLd&&(()=>{
                  const trades=cryptoTrades.trades||[];
                  if(!trades.length)return <div style={{fontSize:12,color:T.textDim,textAlign:"center",padding:"20px 0"}}>No closed trades found</div>;
                  return (
                    <>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12}}>
                        {[
                          {l:"Total Trades",v:trades.length,c:T.blue},
                          {l:"Buy Orders",v:trades.filter(t=>t.side==="buy").length,c:T.green},
                          {l:"Sell Orders",v:trades.filter(t=>t.side==="sell").length,c:T.red},
                        ].map(x=><div key={x.l} style={{background:T.bg,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                          <div style={{fontSize:9,color:T.textDim,marginBottom:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{x.l}</div>
                          <div style={{fontSize:16,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                        </div>)}
                      </div>
                      <div style={{overflowY:"auto",maxHeight:340}}>
                        <table style={{width:"100%",borderCollapse:"collapse"}}>
                          <thead><tr style={{background:T.bg,position:"sticky",top:0}}>
                            {["Symbol","Side","Qty","Price","PnL","Time"].map((h,i)=><th key={h} style={{padding:"6px 8px",fontSize:9,color:T.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em",textAlign:i===0?"left":"right"}}>{h}</th>)}
                          </tr></thead>
                          <tbody>{trades.slice(0,50).map((t,i)=>{
                            const hasPnl=t.pnl!==null&&t.pnl!==undefined;
                            return <tr key={t.id||i} className="trow">
                              <td style={{padding:"7px 8px",fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{t.symbol}</td>
                              <td style={{padding:"7px 8px",textAlign:"right"}}><span style={{fontSize:10,fontWeight:700,color:t.side==="buy"?T.green:T.red,background:t.side==="buy"?T.greenBg:T.redBg,padding:"1px 6px",borderRadius:4}}>{(t.side||"").toUpperCase()}</span></td>
                              <td style={{padding:"7px 8px",textAlign:"right",fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:T.textSub}}>{t.qty?.toFixed(4)}</td>
                              <td style={{padding:"7px 8px",textAlign:"right",fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>${t.price?.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
                              <td style={{padding:"7px 8px",textAlign:"right",fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:hasPnl?(t.pnl>=0?T.green:T.red):T.textDim}}>{hasPnl?(t.pnl>=0?"+":"")+t.pnl.toFixed(2):"—"}</td>
                              <td style={{padding:"7px 8px",textAlign:"right",fontSize:9,color:T.textDim}}>{t.time?new Date(t.time).toLocaleDateString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}</td>
                            </tr>;
                          })}</tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* MY ANALYSIS VIEW — derived from trade history */}
          {tradeView==="analysis"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {!apiKeys[activeExchange]?.key?(
                <div className="card" style={{padding:"24px 16px",textAlign:"center",color:T.textDim,fontSize:12}}>
                  Connect an exchange to see your personal crypto analysis
                </div>
              ):cryptoTradesLd?(
                <div className="card" style={{padding:20,display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:12}}><Spinner size={13}/>Analysing your trades...</div>
              ):cryptoTradesErr?(
                <div className="card" style={{padding:16,fontSize:12,color:T.red}}>{cryptoTradesErr}</div>
              ):cryptoTrades&&(()=>{
                const trades=cryptoTrades.trades||[];
                if(!trades.length)return <div className="card" style={{padding:20,fontSize:12,color:T.textDim,textAlign:"center"}}>No trade history to analyse yet</div>;
                // Symbol breakdown
                const symMap={};
                trades.forEach(t=>{
                  const s=t.symbol||"?";
                  if(!symMap[s])symMap[s]={symbol:s,trades:0,buys:0,sells:0,volume:0,pnl:0,hasPnl:false};
                  symMap[s].trades++;
                  if(t.side==="buy")symMap[s].buys++;else symMap[s].sells++;
                  symMap[s].volume+=t.total||0;
                  if(t.pnl!==null&&t.pnl!==undefined){symMap[s].pnl+=t.pnl;symMap[s].hasPnl=true;}
                });
                const syms=Object.values(symMap).sort((a,b)=>b.trades-a.trades);
                const totalVol=trades.reduce((s,t)=>s+(t.total||0),0);
                const totalPnl=trades.filter(t=>t.pnl!==null).reduce((s,t)=>s+(t.pnl||0),0);
                const hasPnlData=trades.some(t=>t.pnl!==null);
                // Most active day
                const dayMap={};
                trades.forEach(t=>{if(!t.time)return;const d=new Date(t.time).toLocaleDateString("en-US",{weekday:"short"});dayMap[d]=(dayMap[d]||0)+1;});
                const topDay=Object.entries(dayMap).sort((a,b)=>b[1]-a[1])[0];
                // Most active hour
                const hrMap={};
                trades.forEach(t=>{if(!t.time)return;const h=new Date(t.time).getHours();hrMap[h]=(hrMap[h]||0)+1;});
                const topHour=Object.entries(hrMap).sort((a,b)=>b[1]-a[1])[0];
                return (
                  <>
                    {/* Summary KPIs */}
                    <div className="card" style={{overflow:"hidden"}}>
                      <div style={{padding:"11px 14px",borderBottom:"1px solid "+T.border,fontSize:12,fontWeight:600}}>Your Crypto Analysis</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>
                        {[
                          {l:"Total Trades",v:trades.length,c:T.blue},
                          {l:"Total Volume",v:"$"+(totalVol>1e6?(totalVol/1e6).toFixed(1)+"M":totalVol.toFixed(0)),c:T.text},
                          hasPnlData&&{l:"Realised PnL",v:(totalPnl>=0?"+":"")+totalPnl.toFixed(2),c:totalPnl>=0?T.green:T.red},
                          {l:"Most Traded",v:syms[0]?.symbol||"—",c:T.amber},
                          topDay&&{l:"Most Active Day",v:topDay[0]+" ("+topDay[1]+"t)",c:T.purple},
                          topHour&&{l:"Most Active Hour",v:topHour[0]+":00 UTC",c:T.cyan},
                        ].filter(Boolean).map((x,i,arr)=>(
                          <div key={x.l} style={{padding:"12px 14px",borderBottom:i<arr.length-2?"1px solid "+T.border:"none",borderRight:i%2===0?"1px solid "+T.border:"none"}}>
                            <div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4}}>{x.l}</div>
                            <div style={{fontSize:15,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Per-symbol breakdown */}
                    <div className="card" style={{overflow:"hidden"}}>
                      <div style={{padding:"11px 14px",borderBottom:"1px solid "+T.border,fontSize:12,fontWeight:600}}>Per Coin Breakdown</div>
                      {syms.slice(0,8).map((s,i)=>{
                        const coin=CRYPTO_COINS.find(c=>c.id===s.symbol||s.symbol.startsWith(c.id));
                        const barW=Math.round(s.trades/syms[0].trades*100);
                        return (
                          <div key={s.symbol} className="trow" style={{padding:"9px 14px"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <div style={{display:"flex",alignItems:"center",gap:7}}>
                                <div style={{width:22,height:22,borderRadius:6,background:coin?.bg||T.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:800,color:coin?.color||T.textDim}}>{s.symbol.slice(0,3)}</div>
                                <span style={{fontSize:12,fontWeight:700}}>{s.symbol}</span>
                                <span style={{fontSize:10,color:T.textDim}}>{s.trades} trades</span>
                              </div>
                              <div style={{textAlign:"right"}}>
                                {s.hasPnl&&<div style={{fontSize:12,fontWeight:700,color:s.pnl>=0?T.green:T.red,fontFamily:"'JetBrains Mono',monospace"}}>{s.pnl>=0?"+":""}{s.pnl.toFixed(2)}</div>}
                                <div style={{fontSize:10,color:T.textDim}}>${s.volume.toFixed(0)} vol</div>
                              </div>
                            </div>
                            <div style={{height:3,background:T.bg,borderRadius:2}}>
                              <div style={{height:"100%",width:barW+"%",background:coin?.color||T.blue,borderRadius:2,transition:"width .5s"}}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* Crypto rules — only in overview */}
          {tradeView==="overview"&&<div className="card" style={{padding:"14px 16px",background:"linear-gradient(135deg,rgba(247,147,26,0.05),rgba(98,126,234,0.05))"}}>
            <div style={{fontSize:11,fontWeight:700,color:T.textSub,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>Crypto Risk Rules</div>
            {["BTC leads — always check BTC direction first","Size down: crypto is 5–10x more volatile than forex","Never risk more than 1-2% per crypto trade","Funding rates matter — check before holding overnight","News & Twitter move crypto 40%+ in minutes"].map((tip,i)=>(
              <div key={i} style={{display:"flex",gap:7,marginBottom:i<4?6:0,fontSize:11,color:T.textSub,lineHeight:1.5}}>
                <span style={{color:T.amber,fontWeight:700,flexShrink:0}}>{i+1}.</span><span>{tip}</span>
              </div>
            ))}
          </div>}
        </div>
      </div>
    </div>
  );
}

// ── SETUP ─────────────────────────────────────────────────────
function SetupTab({serverOk,trades,riskLimit,setRiskLimit,goals,setGoals,accounts,setAccounts,activeAccount,setActiveAccount,prices}){
  const [rlInput,setRlInput]=useState(riskLimit||"");
  const [telegramChatId,setTelegramChatId]=useState(()=>{try{return localStorage.getItem("tl_telegram_chat")||"";}catch{return "";}});
  const [telegramTesting,setTelegramTesting]=useState(false);
  const [telegramStatus,setTelegramStatus]=useState(null);
  return (
    <div className="page" style={{overflowY:"auto",height:"100%"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Setup</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>Configure your MT5 connection and preferences</p></div>
        <div style={{fontSize:10,color:T.textDim,textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>
          <div style={{marginBottom:2}}>TradeLedger v2.0</div>
          <div style={{color:T.textDim}}>{trades.length} trades · {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
        </div>
      </div>
      {/* Health strip */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
        {[
          {l:"Railway Server",v:serverOk?"Connected":"Disconnected",c:serverOk?T.green:T.red,sub:serverOk?`${trades.length} trades synced`:"Check your server URL"},
          {l:"Trades Loaded",v:trades.length,c:trades.length>0?T.blue:T.textDim,sub:trades.length>0?`Last: ${mt5Day([...trades].reverse()[0]?.closeTime)||"unknown"}`:"No trades yet"},
          {l:"WebSocket",v:"Auto-sync",c:T.green,sub:"Pushes trades in real time"}
        ].map(x=>(
          <div key={x.l} className="card" style={{padding:"12px 16px",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:x.c}}/>
            <div style={{fontSize:10,color:T.textSub,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,marginTop:2}}>{x.l}</div>
            <div style={{fontSize:18,fontWeight:700,color:x.c,fontFamily:"'JetBrains Mono',monospace"}}>{x.v}</div>
            <div style={{fontSize:11,color:T.textDim,marginTop:2}}>{x.sub}</div>
          </div>
        ))}
      </div>

      {/* System Health Check */}
      <div className="card" style={{padding:"14px 18px",marginBottom:14,background:"linear-gradient(135deg,rgba(79,128,255,.04),rgba(0,196,140,.03))"}}>
        <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>System Health Check</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {[
            {l:"Railway Server",ok:serverOk,msg:serverOk?"Connected and receiving data":"Server unreachable — check Railway deployment"},
            {l:"Trade Data",ok:trades.length>0,msg:trades.length>0?trades.length+" trades loaded — EA is working":"No trades received — is your MT5 EA running?"},
            {l:"Live Prices",ok:Object.keys(prices||{}).length>0,msg:Object.keys(prices||{}).length>0?Object.keys(prices||{}).length+" symbols loading":"Prices not loading — check your internet connection"},
            {l:"Auth Token",ok:true,msg:"Token TL-S7PDZ3UV is set"},
          ].map(item=>(
            <div key={item.l} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,background:item.ok?T.greenBg:T.redBg,border:"1px solid "+(item.ok?T.greenBorder:T.redBorder)}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:item.ok?T.green:T.red,flexShrink:0}}/>
              <div style={{flex:1}}>
                <span style={{fontSize:12,fontWeight:600,color:item.ok?T.green:T.red}}>{item.l}</span>
                <span style={{fontSize:11,color:T.textSub,marginLeft:8}}>{item.msg}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <div className="card" style={{padding:20}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:14}}>Connection Status</div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><div style={{width:8,height:8,borderRadius:"50%",background:serverOk?T.green:T.red,animation:serverOk?"none":"pulse 1.5s infinite"}}/><span style={{fontSize:13,color:serverOk?T.green:T.red,fontWeight:600}}>Railway Server {serverOk?"ONLINE":"OFFLINE"}</span></div>
          <div style={{fontSize:12,color:T.textSub,marginBottom:16}}>{serverOk?`${trades.length} trades loaded`:"Server not reachable"}</div>
          <div style={{fontSize:11,color:T.textDim,marginBottom:6,fontWeight:500}}>Server URL</div>
          <div className="input" style={{fontSize:11,color:T.textSub,fontFamily:"'JetBrains Mono',monospace"}}>{SERVER}</div>
        </div>
        <div className="card" style={{padding:20}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:14}}>Auth Token</div>
          <div style={{fontSize:12,color:T.textSub,marginBottom:12}}>Use in your MT5 EA and Railway environment variables.</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,color:T.green,background:T.greenBg,border:`1px solid ${T.greenBorder}`,borderRadius:8,padding:"10px 14px",marginBottom:10}}>TL-S7PDZ3UV</div>
          <div style={{fontSize:11,color:T.textDim}}>Set as <code style={{fontFamily:"'JetBrains Mono',monospace",color:T.textSub}}>TRADELEDGER_TOKEN</code> in Railway</div>
        </div>
        {/* GOALS */}
        <div className="card" style={{padding:20,gridColumn:"1/-1"}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>Goals & Targets</div>
          <div style={{fontSize:12,color:T.textSub,marginBottom:14}}>Set monthly targets — shown as progress bars on your dashboard.</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
            {[{k:"monthlyProfit",l:"Monthly Profit Target ($)",ph:"e.g. 500"},{k:"winRate",l:"Win Rate Goal (%)",ph:"e.g. 60"},{k:"maxDD",l:"Max Drawdown Limit (%)",ph:"e.g. 10"}].map(g=>(
              <div key={g.k}>
                <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>{g.l}</div>
                <div style={{display:"flex",gap:8}}>
                  <input className="input" type="number" placeholder={g.ph} value={goals[g.k]||""} onChange={e=>{const v=parseFloat(e.target.value)||0;const ng={...goals,[g.k]:v};setGoals(ng);try{localStorage.setItem("tl_goals",JSON.stringify(ng));}catch{}}}/>
                  {goals[g.k]>0&&<button className="btn" style={{color:T.red,borderColor:T.redBorder,padding:"4px 8px",fontSize:12}} onClick={()=>{const ng={...goals,[g.k]:0};setGoals(ng);try{localStorage.setItem("tl_goals",JSON.stringify(ng));}catch{}}}>x</button>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* MULTI-ACCOUNT */}
        <div className="card" style={{padding:20,gridColumn:"1/-1"}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>Multiple Accounts</div>
          <div style={{fontSize:12,color:T.textSub,marginBottom:14}}>Switch between Live, Demo, and Prop firm accounts. Each stores its own trades.</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
            {accounts.map(acc=>(
              <div key={acc.id} style={{display:"flex",gap:10,alignItems:"center",padding:"10px 14px",borderRadius:10,border:"2px solid "+(activeAccount===acc.id?T.blue:T.border),background:activeAccount===acc.id?T.blueBg:T.surface,transition:"all .15s"}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:activeAccount===acc.id?T.blue:T.text}}>{acc.label}</div>
                  <div style={{fontSize:11,color:T.textDim,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{acc.token}</div>
                </div>
                {activeAccount!==acc.id&&<button className="btn btn-primary" style={{fontSize:11}} onClick={()=>{setActiveAccount(acc.id);try{localStorage.setItem("tl_active_account",acc.id);}catch{}}}>Switch</button>}
                {activeAccount===acc.id&&<Badge color="blue">Active</Badge>}
                {accounts.length>1&&<button className="btn" style={{fontSize:11,color:T.red,borderColor:T.redBorder}} onClick={()=>{const na=accounts.filter(a=>a.id!==acc.id);setAccounts(na);try{localStorage.setItem("tl_accounts",JSON.stringify(na));}catch{};if(activeAccount===acc.id){setActiveAccount(na[0].id);try{localStorage.setItem("tl_active_account",na[0].id);}catch{}};}}>Remove</button>}
              </div>
            ))}
          </div>
          <button className="btn" onClick={()=>{const label=prompt("Account name (e.g. Demo, Prop Firm, Live):","");if(!label)return;const token=prompt("Auth token for this account:","TL-");if(!token)return;const na=[...accounts,{id:Date.now().toString(),label,token,trades:[]}];setAccounts(na);try{localStorage.setItem("tl_accounts",JSON.stringify(na));}catch{}}}>+ Add Account</button>
        </div>

        {/* TELEGRAM ALERTS */}
        <div className="card" style={{padding:20,gridColumn:"1/-1"}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>Telegram Alerts</div>
          {/* Step by step instructions */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            {[
              {n:"1",t:"Create your bot",d:"Open Telegram → search @BotFather → send /newbot → choose a name → copy the token it gives you"},
              {n:"2",t:"Add token to Railway",d:"Go to Railway → your server → Variables → add TELEGRAM_BOT_TOKEN = your token"},
              {n:"3",t:"Find your Chat ID",d:"Open Telegram → search @userinfobot → send /start → it replies with your numeric ID (e.g. 123456789)"},
              {n:"4",t:"Paste ID below & test",d:"Enter your Chat ID in the field below → click Test & Save → you get a Telegram message instantly"},
            ].map(s=>(
              <div key={s.n} style={{display:"flex",gap:10,padding:"10px 12px",background:T.bg,borderRadius:9,border:"1px solid "+T.border}}>
                <div style={{width:22,height:22,borderRadius:6,background:T.blueBg,border:"1px solid rgba(79,128,255,.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:T.blue,flexShrink:0}}>{s.n}</div>
                <div><div style={{fontSize:11,fontWeight:700,marginBottom:2}}>{s.t}</div><div style={{fontSize:11,color:T.textSub,lineHeight:1.6}}>{s.d}</div></div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,maxWidth:500,marginBottom:10}}>
            <div>
              <div style={{fontSize:11,color:T.textDim,marginBottom:4,fontWeight:500}}>Your Telegram Chat ID <span style={{color:T.textDim,fontWeight:400}}>(from @userinfobot)</span></div>
              <input className="input" type="text" placeholder="e.g. 123456789" value={telegramChatId} onChange={e=>setTelegramChatId(e.target.value)} style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}/>
            </div>
            <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
              <button className="btn btn-primary" style={{fontSize:11}} disabled={!telegramChatId||telegramTesting} onClick={async()=>{
                setTelegramTesting(true);setTelegramStatus(null);
                try{const r=await fetch(SERVER+"/api/telegram/test?chatId="+telegramChatId);const d=await r.json();
                  if(d.ok){
                    try{localStorage.setItem("tl_telegram_chat",telegramChatId);}catch{}
                    // Also register chat ID with server scheduler for news alerts
                    fetch(SERVER+"/api/telegram/savechat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:telegramChatId})}).catch(()=>{});
                    setTelegramStatus("success");
                  }
                  else setTelegramStatus(d.error||"Failed");
                }catch(e){setTelegramStatus(e.message);}
                setTelegramTesting(false);
              }}>{telegramTesting?"Testing...":"Test & Save"}</button>
            </div>
          </div>
          {telegramStatus==="success"&&(
            <div>
              <div style={{fontSize:12,color:T.green,fontWeight:600,marginBottom:10}}>Connected! Check your Telegram for a test message.</div>
              <div style={{background:T.blueBg,border:"1px solid rgba(79,128,255,.25)",borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:12,fontWeight:700,color:T.blue,marginBottom:6}}>Step 5 — Activate Bot Commands</div>
                <div style={{fontSize:11,color:T.textSub,marginBottom:10,lineHeight:1.7}}>
                  Click below to register the webhook so you can message your bot directly to set price alerts from Telegram — no need to open the app.
                </div>
                <button className="btn btn-primary" style={{fontSize:11}} onClick={async()=>{
                  const host="tradeledger-server-production.up.railway.app";
                  const r=await fetch(SERVER+"/api/telegram/webhook/set?host="+host);
                  const d=await r.json();
                  if(d.ok)setTelegramStatus("webhook_ok");
                  else alert("Webhook error: "+(d.description||d.error||JSON.stringify(d)));
                }}>Register Bot Commands</button>
              </div>
            </div>
          )}
          {telegramStatus==="webhook_ok"&&(
            <div style={{background:T.greenBg,border:"1px solid "+T.greenBorder,borderRadius:10,padding:"12px 14px"}}>
              <div style={{fontSize:12,fontWeight:700,color:T.green,marginBottom:6}}>Bot fully activated!</div>
              <div style={{fontSize:11,color:T.textSub,lineHeight:1.8}}>
                Open Telegram → message your bot:<br/>
                <code style={{background:T.bg,padding:"1px 5px",borderRadius:4}}>/alert BTCUSD above 67000</code> — set a price alert<br/>
                <code style={{background:T.bg,padding:"1px 5px",borderRadius:4}}>/alerts</code> — list active alerts<br/>
                <code style={{background:T.bg,padding:"1px 5px",borderRadius:4}}>/price XAUUSD</code> — get current price<br/>
                <code style={{background:T.bg,padding:"1px 5px",borderRadius:4}}>/clear</code> — remove all alerts
              </div>
            </div>
          )}
          {telegramStatus&&telegramStatus!=="success"&&<div style={{fontSize:12,color:T.red}}>{telegramStatus}</div>}
          {localStorage.getItem&&localStorage.getItem("tl_telegram_chat")&&telegramStatus!=="success"&&(
            <div style={{fontSize:11,color:T.green}}>Chat ID saved: {localStorage.getItem("tl_telegram_chat")}</div>
          )}
        </div>

        <div className="card" style={{padding:20,gridColumn:"1/-1"}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>Daily Risk Limit</div>
          <p style={{fontSize:12,color:T.textSub,marginBottom:14}}>TradeLedger locks the screen if today's loss exceeds this amount.</p>
          <div style={{display:"flex",gap:10,maxWidth:360}}><input className="input" type="number" placeholder="e.g. 100" value={rlInput} onChange={e=>setRlInput(e.target.value)}/><button className="btn btn-primary" onClick={()=>{const v=parseFloat(rlInput);if(!isNaN(v)&&v>0){setRiskLimit(v);try{localStorage.setItem("tl_risk_limit",JSON.stringify(v));}catch{}}}}>Save</button>{riskLimit&&<button className="btn" style={{color:T.red,borderColor:T.redBorder}} onClick={()=>{setRiskLimit(null);setRlInput("");try{localStorage.removeItem("tl_risk_limit");}catch{}}}>Clear</button>}</div>
          {riskLimit&&<p style={{marginTop:10,fontSize:12,color:T.green}}>Limit set: ${riskLimit}</p>}
        </div>
      </div>
    </div>
  );
}

// ── LOCAL ANALYSE ─────────────────────────────────────────────
function makeAnalyse(prices,trades){
  return (sym)=>{
    const info=getAssetInfo(sym),p=prices[sym];
    const symTrades=trades.filter(t=>t.symbol===sym),symWins=symTrades.filter(t=>t.profit>0);
    const hist={total:symTrades.length,winRate:symTrades.length?+(symWins.length/symTrades.length*100).toFixed(0):null,netPnl:+symTrades.reduce((s,t)=>s+(t.profit||0),0).toFixed(2)};
    if(!p?.price)return null;
    const price=parseFloat(p.price),changePct=parseFloat(p.changePct)||0;
    const high=parseFloat(p.high)||price*1.005,low=parseFloat(p.low)||price*0.995;
    const range=high-low,pip=info.pip,rangePct=range>0?(price-low)/range:0.5,absMov=Math.abs(changePct);
    let signal,bias,confidence;
    if(changePct>0.3&&rangePct>0.6){signal="BUY";bias="bullish";confidence=Math.min(78,52+Math.round(absMov*8));}
    else if(changePct<-0.3&&rangePct<0.4){signal="SELL";bias="bearish";confidence=Math.min(78,52+Math.round(absMov*8));}
    else if(changePct>0.1){signal="BUY";bias="bullish";confidence=54;}
    else if(changePct<-0.1){signal="SELL";bias="bearish";confidence=54;}
    else{signal="HOLD";bias="neutral";confidence=50;}
    const utcH=new Date().getUTCHours(),session=utcH>=0&&utcH<8?"Asian":utcH>=8&&utcH<13?"London":utcH>=13&&utcH<17?"Overlap":"NewYork";
    const sessionLabel={Asian:"Asian Session",London:"London Session",Overlap:"London/NY Overlap",NewYork:"New York Session"}[session];
    const boost=hist.total>=5&&hist.winRate!=null?(hist.winRate>55?4:hist.winRate<40?-4:0):0;
    confidence=Math.max(45,Math.min(78,confidence+boost));
    const dec=pip<0.001?5:pip<0.01?4:2;
    const step=pip*100,support=+(low-step*0.5).toFixed(dec),resistance=+(high+step*0.5).toFixed(dec);
    const target=signal==="BUY"?+(price+range*0.5).toFixed(dec):signal==="SELL"?+(price-range*0.5).toFixed(dec):+price.toFixed(dec);
    const catalyst=bias==="bullish"?`Price is ${absMov>1?"sharply":"slightly"} up ${absMov.toFixed(2)}% — momentum favours buyers in the ${sessionLabel}`:bias==="bearish"?`Price is ${absMov>1?"sharply":"slightly"} down ${absMov.toFixed(2)}% — sellers in control through ${sessionLabel}`:`Price flat (${changePct>=0?"+":""}${changePct.toFixed(2)}%) — no directional momentum in the ${sessionLabel}`;
    const isMetal=info.type==="metal";
    const fmtP=v=>(isMetal?"$":"")+parseFloat(v).toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec});
    const slDist=(range*0.3).toFixed(dec);
    const steps=signal==="BUY"?[`Wait for pullback to ${fmtP(support)} — enter long with stop ${slDist} below entry`,`Take profit at ${fmtP(target)} (~${((target-price)/price*100).toFixed(2)}% move)`,`Risk max 1-2% of account. Invalidate if price breaks below ${fmtP(support)}`]:signal==="SELL"?[`Look for bounce toward ${fmtP(resistance)} to enter short — don't chase the move`,`Target ${fmtP(target)} with stop ${slDist} above entry`,`Risk max 1-2% of account. Exit if price reclaims ${fmtP(resistance)}`]:[`No clear edge — stay flat and watch for a break above ${fmtP(resistance)} or below ${fmtP(support)}`,`Break above ${fmtP(resistance)} triggers potential long`,`Break below ${fmtP(support)} triggers potential short`];
    const histNote=hist.total>=5?`Your ${sym}: ${hist.total} trades, ${hist.winRate}% WR, $${hist.netPnl} net P&L`:hist.total>0?`${hist.total} ${sym} trade${hist.total>1?"s":""} — need more for personalisation`:null;
    return{signal,bias,confidence,price,changePct,high,low,target,support,resistance,catalyst,steps,histNote,rangePct,info,isMetal,fmtP,dec};
  };
}

// ── MAIN APP ──────────────────────────────────────────────────
export default function TradeLedger(){
  const [trades,setTrades]=useState([]);
  const [tab,setTab]=useState("dashboard");
  const [serverOk,setServerOk]=useState(false);
  const [lastSync,setLastSync]=useState(null);
  const [sideOpen,setSideOpen]=useState(true);
  const [dark,setDark]=useState(()=>{try{return localStorage.getItem("tl_dark")==="1";}catch{return false;}});
  // Apply T immediately on first render so colours are correct before paint
  useMemo(()=>{ T=dark?{...DARK}:{...LIGHT}; },[dark]);
  // Multi-account support
  const [accounts,setAccounts]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_accounts")||"null")||[{id:"default",label:"Main Account",token:"TL-S7PDZ3UV",trades:[]}];}catch{return [{id:"default",label:"Main Account",token:"TL-S7PDZ3UV",trades:[]}];}});
  const [activeAccount,setActiveAccount]=useState(()=>{try{return localStorage.getItem("tl_active_account")||"default";}catch{return "default";}});
  // Goals
  const [goals,setGoals]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_goals")||"null")||{monthlyProfit:0,dailyTrades:0,winRate:0,maxDD:0};}catch{return {monthlyProfit:0,dailyTrades:0,winRate:0,maxDD:0};}});


  const toggleDark=()=>{setDark(d=>{const n=!d;try{localStorage.setItem("tl_dark",n?"1":"0");}catch{}return n;});};

  const [watchlist,setWatchlist]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_wl")||JSON.stringify(DEFAULT_WL));}catch{return DEFAULT_WL;}});
  const [prices,setPrices]=useState({});
  const [pFlash,setPFlash]=useState({});

  const [weeklyAI,setWeeklyAI]=useState(null);
  const [savedNews,setSavedNews]=useState(()=>{try{const r=JSON.parse(localStorage.getItem("tl_saved_news")||"[]");const c=Date.now()-48*60*60*1000;return r.filter(a=>new Date(a.savedAt||a.pubDate||0).getTime()>c);}catch{return[];}});
  const [newsLd,setNewsLd]=useState(false);
  const [newsFeed,setNewsFeed]=useState([]);
  const [tickerIdx,setTickerIdx]=useState(0);
  const [todayNews,setTodayNews]=useState([]);
  const [searchQuery,setSearchQuery]=useState("");
  const [searchResults,setSearchResults]=useState(null);
  const [searchLd,setSearchLd]=useState(false);
  const [searchErr,setSearchErr]=useState(null);
  const [riskLimit,setRiskLimit]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_risk_limit")||"null");}catch{return null;}});
  const [riskLockDismissed,setRiskLockDismissed]=useState(false);
  const [checklistOpen,setChecklistOpen]=useState(false);
  const [checklistDone,setChecklistDone]=useState({});
  const [readModal,setReadModal]=useState(null);
  const [newsImpactOpen,setNewsImpactOpen]=useState(false);
  const [briefing,setBriefing]=useState(()=>{try{return JSON.parse(localStorage.getItem("tl_briefing")||"null");}catch{return null;}});
  const [briefingLd,setBriefingLd]=useState(false);

  const stats=useMemo(()=>computeStats(trades),[trades]);
  const analyseSymbol=useMemo(()=>makeAnalyse(prices,trades),[prices,trades]);
  const wsRef=useRef(null),reconnRef=useRef(null),fetchNewsRef=useRef(null);

  useEffect(()=>{try{localStorage.setItem("tl_saved_news",JSON.stringify(savedNews.slice(0,200)));}catch{}},[savedNews]);

  const prevTradeIdsRef=useRef(new Set());

  // Auto-journal: called when new trades arrive via WebSocket
  const autoJournalNewTrades=useCallback((newTrades, oldIds)=>{
    const JKEY="tl_journal_entries";
    const existing=new Set(
      (()=>{try{return JSON.parse(localStorage.getItem(JKEY)||"[]");}catch{return[];}})()
        .map(e=>e.sourceTradeId)
        .filter(Boolean)
    );
    const newlyClosed=newTrades.filter(t=>{
      // Must be a closed trade (has closeTime), not already journalled, not in old set
      const id=t.ticket||t.id||t.order;
      return t.closeTime && !existing.has(String(id)) && !oldIds.has(String(id));
    });
    if(!newlyClosed.length)return;
    const drafts=(()=>{try{return JSON.parse(localStorage.getItem(JKEY)||"[]");}catch{return[];}})();
    const newDrafts=newlyClosed.map(t=>{
      const net=(t.profit||0)+(t.swap||0)+(t.commission||0);
      return {
        id:"auto_"+Date.now()+"_"+(t.ticket||Math.random()),
        sourceTradeId:String(t.ticket||t.id||t.order||""),
        createdAt:new Date().toISOString(),
        auto:true, // flag as auto-created draft
        date:mt5Day(t.closeTime)||localDay(),
        symbol:t.symbol||"",
        type:(t.type||"buy").toLowerCase().includes("sell")?"sell":"buy",
        pnl:+net.toFixed(2),
        outcome:net>0?"win":net<0?"loss":"breakeven",
        setup:"", reason:"", emotion:"", mistakes:"", lessons:"",
        rating:3, screenshot:null, tags:[],
        needsReview:true, // prompt user to fill in details
      };
    });
    const merged=[...newDrafts,...drafts];
    try{localStorage.setItem(JKEY,JSON.stringify(merged));}catch{}
    console.log("[JOURNAL] Auto-added "+newDrafts.length+" trade draft(s)");
    // Telegram notification for closed trades
    try{
      const chatId=localStorage.getItem("tl_telegram_chat");
      if(chatId&&newDrafts.length){
        newDrafts.forEach(d=>{
          const emoji=d.pnl>=0?"green":"red";
          const text="<b>TradeLedger — Trade Closed</b>\n"+d.symbol+" "+d.type.toUpperCase()+"\nP&L: "+(d.pnl>=0?"+":"")+d.pnl+"\nOutcome: "+d.outcome.toUpperCase();
          fetch(SERVER+"/api/telegram/send",{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({chatId,text})}).catch(()=>{});
        });
      }
    }catch{}
  },[]);

  const connectWS=useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN)return;
    try{const ws=new WebSocket(WS_URL);wsRef.current=ws;ws.onopen=()=>{};ws.onclose=()=>{reconnRef.current=setTimeout(connectWS,5000);};ws.onerror=()=>{ws.close();};ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==="TRADE_UPDATE"||m.type==="NEW_TRADE"||m.type==="TRADES_REPLACED"){const incoming=m.trades||[];autoJournalNewTrades(incoming,prevTradeIdsRef.current);prevTradeIdsRef.current=new Set(incoming.map(t=>String(t.ticket||t.id||t.order||"")));setTrades(incoming);setLastSync(new Date().toISOString());}if(m.type==="CLEARED")setTrades([]);}catch{}};}catch{}
  },[autoJournalNewTrades]);

  const fetchAll=useCallback(async()=>{
    try{const[tr,st]=await Promise.all([fetch(SERVER+"/api/trades"),fetch(SERVER+"/api/status")]);if(st.ok)setServerOk(true);if(tr.ok){const d=await tr.json();const incoming=d.trades||[];autoJournalNewTrades(incoming,prevTradeIdsRef.current);prevTradeIdsRef.current=new Set(incoming.map(t=>String(t.ticket||t.id||t.order||"")));setTrades(incoming);setLastSync(new Date().toISOString());}}catch{setServerOk(false);}
  },[autoJournalNewTrades]);

  useEffect(()=>{fetchAll();},[fetchAll]);
  useEffect(()=>{const t=setInterval(fetchAll,30000);return()=>clearInterval(t);},[fetchAll]);
  useEffect(()=>{if(serverOk)connectWS();return()=>{wsRef.current?.close();clearTimeout(reconnRef.current);};},[serverOk,connectWS]);

  // Register saved Telegram chat ID with server on load
  useEffect(()=>{
    const chatId=localStorage.getItem("tl_telegram_chat");
    if(chatId){fetch(SERVER+"/api/telegram/savechat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId})}).catch(()=>{});}
  },[]);

  // Keyboard shortcuts
  useEffect(()=>{
    const map={d:"dashboard",w:"watchlist",a:"analytics",j:"journal",c:"calendar",n:"news",s:"setup",x:"crypto"};
    const handler=e=>{
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT")return;
      if(e.metaKey||e.ctrlKey||e.altKey)return;
      const tab=map[e.key.toLowerCase()];
      if(tab)setTab(tab);
    };
    window.addEventListener("keydown",handler);
    return()=>window.removeEventListener("keydown",handler);
  },[]);

  // Prices
  useEffect(()=>{
    if(!watchlist.length)return;
    const load=async()=>{
      const prev={...prices};
      const q=await fetchPriceBatch(watchlist,{onCachedHit:c=>{setPrices(p=>{const n={...p};Object.entries(c).forEach(([s,v])=>{if(v)n[s]=v;});return n;});}});
      if(Object.keys(q).length){
        setPrices(p=>{const n={...p};Object.entries(q).forEach(([s,v])=>{if(v)n[s]=v;});return n;});
        const f={};Object.entries(q).forEach(([s,v])=>{if(v&&prev[s]){const d=parseFloat(v.price)-parseFloat(prev[s]?.price||0);if(Math.abs(d)>0.0001)f[s]=d>0?"up":"down";}});
        if(Object.keys(f).length){setPFlash(f);setTimeout(()=>setPFlash({}),800);}
      }
    };
    load();const t=setInterval(load,60000);return()=>clearInterval(t);
  },[watchlist.join(",")]);

  // Calendar events
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch(SERVER+"/api/week-events",{signal:AbortSignal.timeout(20000)});if(r.ok){const d=await r.json();
      const allEvents=d.events||[];
      const todayStr=localDay();
      // Filter to TODAY's events only — compare event date to local today
      // ForexFactory uses UTC ISO dates e.g. "2026-03-31T08:30:00Z"
      // Match events where either the UTC date OR local date matches today
      const todayUTC=new Date().toISOString().slice(0,10);
      const todayOnly=allEvents.filter(e=>{
        const evtDate=e.date||e.time||e.datetime||"";
        if(!evtDate)return false;
        const utcSlice=(evtDate||"").slice(0,10);
        if(utcSlice===todayUTC)return true;
        try{return localDay(new Date(evtDate))===todayStr;}catch{return false;}
      });
      setTodayNews(todayOnly);
      // Cache full week on window so CalendarTab can filter by any selected day
      window._weekEvents=allEvents;
    }}catch{}};
    load();const t=setInterval(load,3600000);return()=>clearInterval(t);
  },[]);

  // Ticker
  useEffect(()=>{if(savedNews.length<2)return;const t=setInterval(()=>setTickerIdx(i=>(i+1)%savedNews.length),5000);return()=>clearInterval(t);},[savedNews.length]);

  // AI (auto on analytics tab)
  const genWeeklyAI=useCallback((force=false)=>{
    if(!stats||trades.length===0)return;
    if(!force&&weeklyAI?.generatedAt){const gd=new Date(weeklyAI.generatedAt),now=new Date(),mon=new Date(now);mon.setUTCHours(0,0,0,0);mon.setUTCDate(now.getUTCDate()-((now.getUTCDay()+6)%7));if(gd>=mon)return;}
    setWeeklyAI(null);
    const{total,wins,losses,winRate,totalProfit,grossProfit,grossLoss,pf,avgWin,avgLoss,rr,maxDD,maxCW,maxCL,expectancy,bySymbol,sessions}=stats;
    const symWR=bySymbol.map(s=>({...s,wr:s.trades>0?+(s.wins/s.trades*100).toFixed(1):0}));
    const bestSym=symWR[0],worstSym=[...symWR].sort((a,b)=>a.profit-b.profit)[0];
    const sessSort=[...sessions].sort((a,b)=>b.profit-a.profit),bestSess=sessSort[0],worstSess=sessSort[sessSort.length-1];
    const dowP={0:0,1:0,2:0,3:0,4:0,5:0,6:0},dowC={0:0,1:0,2:0,3:0,4:0,5:0,6:0};
    trades.forEach(t=>{const d=parseMT5Date(t.openTime);if(!d)return;const dow=d.getUTCDay();dowP[dow]=+((dowP[dow]||0)+(t.profit||0)).toFixed(2);dowC[dow]++;});
    const dowNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const dowArr=Object.entries(dowP).filter(([d])=>dowC[d]>0).map(([d,p])=>({day:dowNames[+d],profit:+p.toFixed(2),count:dowC[d]})).sort((a,b)=>b.profit-a.profit);
    const bestDay=dowArr[0],worstDay=dowArr[dowArr.length-1];
    const durs=trades.filter(t=>t.openTime&&t.closeTime).map(t=>{const o=parseMT5Date(t.openTime),c=parseMT5Date(t.closeTime);return o&&c?(c-o)/60000:null;}).filter(Boolean);
    const avgDur=durs.length?Math.round(durs.reduce((s,v)=>s+v,0)/durs.length):0;
    const activeDays=new Set(trades.map(t=>mt5Day(t.openTime)).filter(Boolean)).size;
    const tpd=activeDays>0?+(total/activeDays).toFixed(1):0;
    let revT=0;for(let i=1;i<trades.length;i++)if(trades[i-1].profit<0&&trades[i].profit<0)revT++;
    const revRate=total>1?+(revT/(total-1)*100).toFixed(0):0;
    const cuttingW=avgWin<avgLoss*0.8,wideSL=avgLoss>avgWin*1.5;
    const sections=[];
    {const is=[],ws=[],st=[];if(maxDD>20){is.push(`max drawdown of ${maxDD}% is dangerous`);ws.push(`needs 25%+ gain to recover`);st.push(`Cut position size 50% until drawdown under 10%`);}if(maxCL>=4){is.push(`${maxCL} consecutive losses`);ws.push(`signals strategy flaw or emotional trading`);st.push(`After 3 losses in a row, stop for the day`);}if(revRate>25){is.push(`${revRate}% back-to-back losses — revenge trading`);ws.push(`emotion-driven trades compound losses`);st.push(`Mandatory 10-min break after every losing trade`);}if(tpd>8){is.push(`averaging ${tpd} trades/day — overtrading`);st.push(`Cap at ${Math.ceil(tpd/2)} trades per day`);}if(pf<1.2){is.push(`profit factor ${pf} — barely sustainable`);st.push(`Target PF 1.5 — skip setups with less than 1:1.5 R:R`);}if(is.length===0){is.push(`risk management solid: PF ${pf}, drawdown ${maxDD}%`);st.push(`Document your rules in a written trading plan`);st.push(`Test same discipline at 10% larger size`);}sections.push({id:"risk",icon:"!",label:"WHAT WENT WRONG",color:T.red,bg:T.redBg,border:T.redBorder,what:is.slice(0,2).join(" and "),why:ws[0]||"",steps:st.slice(0,3)});}
    {const sessH={Asian:"00:00-08:00 UTC",London:"08:00-13:00 UTC",Overlap:"13:00-17:00 UTC",NewYork:"17:00-22:00 UTC"};const sp=sessions.map(s=>`${s.name}: $${s.profit}`).join(" | ");sections.push({id:"session",icon:"o",label:"WHEN TO TRADE",color:T.green,bg:T.greenBg,border:T.greenBorder,what:bestSess?`${bestSess.name} session is your strongest at $${bestSess.profit}`:"Track session data to find your edge",why:`${sp}${bestDay?`. Best day: ${bestDay.day} ($${bestDay.profit})`:""}`,steps:[bestSess?`Focus 80% of trades in ${bestSess.name} hours (${sessH[bestSess.name]||""})`:"",(worstSess&&worstSess.profit<0)?`Avoid ${worstSess.name} — losing $${Math.abs(worstSess.profit)}`:"",bestDay?`Prioritise ${bestDay.day}s — best day by P&L`:""].filter(Boolean).slice(0,3)});}
    {const top=symWR.slice(0,3).map(s=>`${s.symbol} ($${s.profit}, ${s.wr}%WR)`).join(", ");sections.push({id:"symbol",icon:"=",label:"WHAT TO TRADE",color:T.blue,bg:T.blueBg,border:"rgba(79,128,255,.25)",what:bestSym?`${bestSym.symbol} is top performer: $${bestSym.profit} (${bestSym.wr}% WR)`:"No profitable symbol yet",why:`Top 3: ${top||"no data"}${worstSym&&worstSym.profit<0?`. ${worstSym.symbol} worst at $${worstSym.profit}`:""}`,steps:[bestSym?`Make ${bestSym.symbol} primary — 60% of daily trades here`:"",worstSym&&worstSym.profit<0?`Drop ${worstSym.symbol} — losing $${Math.abs(worstSym.profit)}`:"",`Study ${bestSym?.symbol||"best symbol"}: S/R levels, news events, session behaviour`].filter(Boolean)});}
    {const rrN=parseFloat(rr)||0,durS=avgDur>0?(avgDur<60?`${avgDur}m`:`${Math.round(avgDur/60)}h${avgDur%60}m`):"unknown";sections.push({id:"exec",icon:">",label:"HOW TO IMPROVE",color:T.purple,bg:T.purpleBg,border:"rgba(139,92,246,.25)",what:rrN>=1.5?`R:R 1:${rr} healthy — $${expectancy}/trade expectancy compounds well`:`R:R 1:${rr} needs work — avg win $${avgWin} vs avg loss $${avgLoss}`,why:`${winRate}% WR gives $${expectancy}/trade over ${total} trades. Avg hold: ${durS}. ${cuttingW?"Cutting winners short.":wideSL?"Stop losses too wide.":"Execution looks reasonable."}`,steps:[cuttingW?`Move TP further: target 1.5x your SL distance`:rrN>=1.5?`Protect R:R — never tighten TP once in profit`:`Minimum 1:1.5 R:R — if TP is not 1.5x SL, skip the trade`,avgDur>0&&avgDur<10?`${durS} avg hold too short — 30-min minimum hold rule`:avgDur>480?`${durS} hold has overnight risk — close 50% at 1R`:null,expectancy>0?`Positive expectancy $${expectancy}/trade — scale up 1 lot per 10% account growth`:`Fix negative expectancy — min size until positive for 20+ trades`].filter(Boolean)});}
    const result={sections,generatedAt:new Date().toISOString(),tradeCount:total};
    setWeeklyAI(result);try{localStorage.setItem("tl_weekly_ai",JSON.stringify(result));}catch{}
  },[stats,trades,weeklyAI]);

  useEffect(()=>{try{const c=JSON.parse(localStorage.getItem("tl_weekly_ai")||"null");if(c?.sections)setWeeklyAI(c);}catch{};},[]);
  useEffect(()=>{if(tab==="analytics"&&stats&&!weeklyAI)genWeeklyAI(false);},[tab,stats]);

  // News
  const fetchNews=async()=>{setNewsLd(true);try{const r=await fetch(SERVER+"/api/news",{signal:AbortSignal.timeout(12000)});if(r.ok){const data=await r.json();const articles=(data.articles||[]).map(a=>({...a,savedAt:new Date().toISOString()}));setNewsFeed(articles);setSavedNews(prev=>[...articles,...prev.filter(p=>!articles.find(a=>a.title===p.title))].slice(0,200));}}catch{}finally{setNewsLd(false);}};
  useEffect(()=>{fetchNewsRef.current=fetchNews;},[newsFeed]);
  useEffect(()=>{fetchNewsRef.current?.();},[]);

  const fetchMarketSearch=async(q)=>{
    const query=(q||searchQuery).trim();if(!query)return;
    setSearchLd(true);setSearchErr(null);setSearchResults(null);
    try{const r=await fetch(SERVER+"/api/marketsearch?q="+encodeURIComponent(query),{signal:AbortSignal.timeout(25000)});if(!r.ok)throw new Error("Server error "+r.status);setSearchResults(await r.json());}
    catch(e){setSearchErr("Search failed — check server connection: "+e.message);}
    finally{setSearchLd(false);}
  };

  const openArticle=async(article)=>{
    setReadModal({...article,loading:true,blocks:null});
    try{const r=await fetch(SERVER+"/api/readarticle?url="+encodeURIComponent(article.link),{signal:AbortSignal.timeout(15000)});if(r.ok){const d=await r.json();setReadModal(m=>({...m,loading:false,...d}));}else setReadModal(m=>({...m,loading:false,error:"Failed to load"}));}
    catch{setReadModal(m=>({...m,loading:false,error:"Could not load article"}));}
  };

  const onAddSymbol=sym=>{const next=[...watchlist.filter(s=>s!==sym),sym];setWatchlist(next);try{localStorage.setItem("tl_wl",JSON.stringify(next));}catch{}};
  const onRemoveSymbol=sym=>{const next=watchlist.filter(s=>s!==sym);setWatchlist(next);try{localStorage.setItem("tl_wl",JSON.stringify(next));}catch{}};

  const NAV=[{id:"watchlist",icon:"◈",label:"Watchlist"},{id:"dashboard",icon:"▦",label:"Dashboard"},{id:"analytics",icon:"◎",label:"Analytics"},{id:"crypto",icon:"◆",label:"Crypto"},{id:"journal",icon:"[+]",label:"Journal"},{id:"calendar",icon:"◷",label:"Calendar"},{id:"news",icon:"◉",label:"News"},{id:"setup",icon:"o",label:"Setup"}];
  const [clockTick,setClockTick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>setClockTick(n=>n+1),30000);return()=>clearInterval(t);},[]);
  const now=new Date(),utcStr=now.toUTCString().slice(17,22)+" UTC",localStr=now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  const sessions=getSessions();

  return (
    <>
      <GlobalStyles dark={dark}/>

      {/* Article reader */}
      {readModal&&(
        <div style={{position:"fixed",inset:0,zIndex:900,background:"rgba(0,0,0,0.4)",backdropFilter:"blur(8px)",display:"flex",alignItems:"flex-start",justifyContent:"flex-end",padding:16}}>
          <div style={{background:"#fff",border:`1px solid ${T.border}`,borderRadius:16,width:"min(680px,95vw)",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.15)"}}>
            <div style={{position:"sticky",top:0,background:"#fff",borderBottom:`1px solid ${T.border}`,padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",zIndex:1}}>
              <span style={{fontSize:13,fontWeight:600}}>{readModal.source||"Article"}</span>
              <div style={{display:"flex",gap:8}}>{readModal.link&&<a href={readModal.link} target="_blank" rel="noreferrer" className="btn" style={{fontSize:11}}>Open</a>}<button className="btn" onClick={()=>setReadModal(null)}>Close</button></div>
            </div>
            <div style={{padding:22}}>
              {readModal.loading?<div style={{display:"flex",alignItems:"center",gap:10,color:T.textSub,fontSize:13}}><Spinner/>Loading article...</div>:readModal.error?<div style={{color:T.red,fontSize:13}}>{readModal.error}</div>:(
                <><h1 style={{fontSize:19,fontWeight:700,lineHeight:1.4,marginBottom:16}}>{readModal.title||readModal.headline}</h1>
                {readModal.blocks?.map((b,i)=>{if(b.type==="p")return <p key={i} style={{fontSize:14,color:T.textSub,lineHeight:1.8,marginBottom:14}}>{b.text}</p>;if(b.type==="h2")return <h2 key={i} style={{fontSize:16,fontWeight:700,marginBottom:10,marginTop:20}}>{b.text}</h2>;if(b.type==="img")return <img key={i} src={b.src} alt={b.alt||""} style={{width:"100%",borderRadius:8,marginBottom:14}}/>;return null;})}
                {!readModal.blocks?.length&&readModal.description&&<p style={{fontSize:14,color:T.textSub,lineHeight:1.8}}>{readModal.description}</p>}</>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Risk lock */}
      {!riskLockDismissed&&riskLimit&&(()=>{const tp=trades.filter(t=>mt5Day(t.closeTime)===localDay()).reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0);if(tp>-Math.abs(riskLimit))return null;return<div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(255,255,255,.95)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}><div style={{fontSize:32,fontWeight:800,color:T.red,marginBottom:16}}>RISK LOCK</div><div style={{fontSize:16,color:T.textSub,marginBottom:8}}>Today P&L: <span style={{color:T.red,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>${tp.toFixed(2)}</span></div><div style={{fontSize:13,color:T.textDim,marginBottom:28,textAlign:"center",maxWidth:320}}>Daily risk limit of ${Math.abs(riskLimit)} hit. Stop trading for today.</div><div style={{display:"flex",gap:10}}><button className="btn" onClick={()=>setTab("setup")}>Edit Limit</button><button className="btn btn-primary" style={{background:T.red,borderColor:T.red}} onClick={()=>setRiskLockDismissed(true)}>I Understand</button></div></div>;})()} 

      {/* Checklist */}
      {checklistOpen&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.3)",backdropFilter:"blur(8px)",display:"flex",alignItems:"flex-end",justifyContent:"flex-end",padding:80}}>
          <div style={{background:"#fff",border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:340,maxHeight:"80vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.15)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}><div style={{fontSize:14,fontWeight:600}}>Pre-Trade Checklist</div><button className="btn" onClick={()=>setChecklistOpen(false)}>Close</button></div>
            {DEFAULT_CHECKLIST.map((item,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
                <button onClick={()=>setChecklistDone(d=>({...d,[i]:!d[i]}))} style={{width:20,height:20,borderRadius:5,border:`2px solid ${checklistDone[i]?T.blue:T.border}`,background:checklistDone[i]?T.blue:"transparent",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",transition:"all .15s"}}>{checklistDone[i]?"ok":""}</button>
                <span style={{fontSize:13,color:checklistDone[i]?T.textDim:T.text,textDecoration:checklistDone[i]?"line-through":"none"}}>{item}</span>
              </div>
            ))}
            <button className="btn btn-primary" style={{width:"100%",marginTop:16,justifyContent:"center"}} onClick={()=>{setChecklistOpen(false);setChecklistDone({});}}>Done</button>
          </div>
        </div>
      )}

      {/* App shell */}
      <div style={{display:"flex",height:"100vh",overflow:"hidden",background:T.bg}}>
        {/* Sidebar */}
        <div className="sidebar-desktop" style={{width:200,background:T.surface,borderRight:"1px solid "+T.border,display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden",boxShadow:"1px 0 6px rgba(0,0,0,0.04)"}}>
          <div style={{padding:"14px 12px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:32,height:32,borderRadius:10,background:`linear-gradient(135deg,${T.blue},#6d9bff)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:"#fff",flexShrink:0}}>TL</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>TradeLedger</div>
              <div style={{fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>MT5 Journal</div>
            </div>
            {(()=>{
              if(!trades.length)return null;
              let streak=0,type=null;
              const rev=[...trades].reverse();
              const first=rev[0];if(!first)return null;
              type=first.profit>0?"W":"L";
              for(const t of rev){if((t.profit>0&&type==="W")||(t.profit<=0&&type==="L"))streak++;else break;}
              if(streak<2)return null;
              const isWin=type==="W";
              const emoji=isWin?(streak>=5?"fire":streak>=3?"⚡":"✓"):(streak>=5?"ice":streak>=3?"❄":"✗");
              return <div title={(isWin?"Win":"Loss")+" streak: "+streak+" trades"} style={{flexShrink:0,background:isWin?"rgba(0,196,140,.15)":"rgba(255,91,91,.15)",border:"1px solid "+(isWin?T.greenBorder:T.redBorder),borderRadius:7,padding:"2px 6px",display:"flex",alignItems:"center",gap:3,animation:streak>=5?"pulse 1.5s infinite":"none"}}>
                <span style={{fontSize:11}}>{emoji}</span>
                <span style={{fontSize:10,fontWeight:800,color:isWin?T.green:T.red}}>{streak}</span>
              </div>;
            })()}
          </div>
          <nav style={{padding:"8px 6px",flex:1}}>
            {NAV.map(n=>{
              const active=tab===n.id,newsBadge=n.id==="news"&&savedNews.filter(a=>Date.now()-new Date(a.savedAt||a.pubDate||0)<30*60*1000).length>0;
              return <button key={n.id} className={`nav-item ${active?"active":""}`} style={{justifyContent:"flex-start",padding:"9px 12px",marginBottom:2}} onClick={()=>setTab(n.id)}>
                <span style={{fontSize:14,flexShrink:0}}>{n.icon}</span>
                <span style={{whiteSpace:"nowrap"}}>{n.label}</span>
                {newsBadge&&<span style={{marginLeft:"auto",width:5,height:5,borderRadius:"50%",background:T.green,flexShrink:0}}/>}
              </button>;
            })}
          </nav>
          {/* Account switcher in sidebar */}
          {accounts.length>1&&(
            <div style={{padding:"6px 8px",borderTop:"1px solid "+T.border,flexShrink:0}}>
              <div style={{fontSize:9,color:T.textDim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4,paddingLeft:4}}>Account</div>
              <select value={activeAccount} onChange={e=>{setActiveAccount(e.target.value);try{localStorage.setItem("tl_active_account",e.target.value);}catch{}}} style={{width:"100%",background:T.bg,border:"1px solid "+T.border,borderRadius:6,padding:"4px 6px",fontSize:11,color:T.textSub,cursor:"pointer"}}>
                {accounts.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          )}
          <div style={{padding:"8px 6px",borderTop:`1px solid ${T.border}`,flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,justifyContent:"flex-start",padding:"4px 6px"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:serverOk?T.green:T.red,flexShrink:0,animation:serverOk?"none":"pulse 1.5s infinite"}}/>
              <span style={{fontSize:11,color:serverOk?T.green:T.red,whiteSpace:"nowrap",fontWeight:500}}>{serverOk?"Online":"Offline"}</span>
            </div>
            <>
              {sessions.map(s=><div key={s.name} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 6px",opacity:s.active?1:0.35}}><div style={{width:4,height:4,borderRadius:"50%",background:s.active?s.color:T.textDim,flexShrink:0}}/><span style={{fontSize:9,color:s.active?T.textSub:T.textDim,whiteSpace:"nowrap"}}>{s.name}</span></div>)}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.textDim,fontFamily:"'JetBrains Mono',monospace",padding:"4px 6px",marginTop:4}}><span>{utcStr}</span><span>{localStr}</span></div>
              {(()=>{
                const todayStr=localDay();
                const todayT=trades.filter(t=>mt5Day(t.closeTime)===todayStr);
                const pnl=+todayT.reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0).toFixed(2);
                if(!todayT.length)return null;
                return <div style={{margin:"4px 6px 0",padding:"5px 8px",borderRadius:7,background:pnl>=0?T.greenBg:T.redBg,border:"1px solid "+(pnl>=0?T.greenBorder:T.redBorder)}}>
                  <div style={{fontSize:8,color:pnl>=0?T.green:T.red,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:1}}>Today</div>
                  <div style={{fontSize:12,fontWeight:800,color:pnl>=0?T.green:T.red,fontFamily:"'JetBrains Mono',monospace"}}>{pnl>=0?"+":""}{pnl}</div>
                  <div style={{fontSize:9,color:T.textDim}}>{todayT.length} trade{todayT.length>1?"s":""}</div>
                </div>;
              })()}
            </>
          </div>
        </div>

        {/* Main content */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
          {/* Top bar */}
          <div style={{background:"#fff",borderBottom:`1px solid ${T.border}`,padding:"7px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div style={{flex:1,overflow:"hidden",marginRight:12}}>
              {savedNews.length>0&&<div style={{fontSize:11,color:T.textSub,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}><span style={{color:T.blue,fontWeight:700,marginRight:5,fontSize:9}}>●</span>{savedNews[tickerIdx]?.title||""}</div>}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
              {todayNews.length>0&&<button className="btn" style={{fontSize:11,padding:"4px 10px"}} onClick={()=>setNewsImpactOpen(o=>!o)}>{todayNews.filter(e=>(e.impact||"").toLowerCase()==="high").length>0&&<span style={{color:T.red}}>● </span>}Events</button>}
              <button className="btn" style={{fontSize:11,padding:"4px 10px"}} onClick={()=>setChecklistOpen(true)}>Checklist</button>
              {trades.length>0&&<span style={{fontSize:11,color:T.textDim,fontFamily:"'JetBrains Mono',monospace",background:T.bg,padding:"2px 7px",borderRadius:5}}>{trades.length}t</span>}
              {(()=>{
                const [now,setNow]=useState(new Date());
                useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t);},[]);
                const utc=now.toUTCString().slice(17,22);
                const session=(()=>{const h=now.getUTCHours();return h>=8&&h<13?"London":h>=13&&h<17?"Overlap":h>=17&&h<22?"New York":h>=0&&h<9?"Tokyo":"Sydney";})();
                const sessionColor=(()=>{const h=now.getUTCHours();return h>=8&&h<17?T.green:h>=17&&h<22?T.purple:T.cyan;})();
                return <div style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:T.textSub,display:"flex",alignItems:"center",gap:6,background:T.bg,border:"1px solid "+T.border,borderRadius:8,padding:"4px 10px"}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:sessionColor,animation:"pulse 2s infinite"}}/>
                  <span style={{color:sessionColor,fontWeight:600,fontSize:10}}>{session}</span>
                  <span>{utc} UTC</span>
                </div>;
              })()}
              <button onClick={toggleDark} title={dark?"Light mode":"Dark mode"} style={{background:dark?"rgba(255,255,255,0.1)":T.bg,border:"1px solid "+T.border,borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:13,color:T.textSub,display:"flex",alignItems:"center",gap:5,transition:"all .2s"}}>{dark?"Light":"Dark"}</button>
            </div>
          </div>

          {newsImpactOpen&&todayNews.length>0&&(
            <div style={{background:T.surface,borderBottom:"1px solid "+T.border,padding:"10px 18px"}}>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                {todayNews.slice(0,8).map((e,i)=>{
                  const impact=(e.impact||"").toLowerCase();
                  const col=impact==="high"?T.red:impact==="medium"?T.amber:T.textDim;
                  const bg=impact==="high"?T.redBg:impact==="medium"?T.amberBg:T.bg;
                  const border=impact==="high"?"1px solid "+T.redBorder:impact==="medium"?"1px solid rgba(245,158,11,.25)":"1px solid "+T.border;
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:5,background:bg,border,borderRadius:6,padding:"3px 8px",maxWidth:280}}>
                      <div style={{width:5,height:5,borderRadius:"50%",background:col,flexShrink:0,boxShadow:impact==="high"?"0 0 4px "+col:"none"}}/>
                      <span style={{fontSize:11,color:col,fontWeight:impact==="high"?600:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.title||e.event||e.name||"Event"}</span>
                      {(e.country||e.currency)&&<span style={{fontSize:10,color:T.textDim,flexShrink:0}}>({e.country||e.currency})</span>}
                    </div>
                  );
                })}
                {todayNews.length>8&&<span style={{fontSize:11,color:T.textDim}}>+{todayNews.length-8} more</span>}
              </div>
            </div>
          )}
          {!serverOk&&<div style={{background:T.redBg,borderBottom:`1px solid ${T.redBorder}`,padding:"6px 18px",display:"flex",alignItems:"center",gap:8,fontSize:12,color:T.red,flexShrink:0}}><div style={{width:5,height:5,borderRadius:"50%",background:T.red,animation:"pulse 1.5s infinite",flexShrink:0}}/>Server offline — AI features unavailable<button className="btn" style={{marginLeft:"auto",fontSize:11,color:T.red,borderColor:T.redBorder,padding:"3px 10px"}} onClick={fetchAll}>Retry</button></div>}

          {/* Page — key fixes: overflowY:auto on content div, min-height:0 on flex chain */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px 20px",paddingBottom:"calc(20px + env(safe-area-inset-bottom,0px))",minHeight:0}}>
            {tab==="dashboard"&&<DashboardTab trades={trades} stats={stats} serverOk={serverOk} lastSync={lastSync}/>}
            {tab==="watchlist"&&<WatchlistTab watchlist={watchlist} prices={prices} pFlash={pFlash} onAddSymbol={onAddSymbol} onRemoveSymbol={onRemoveSymbol} analyseSymbol={analyseSymbol} trades={trades}/>}
            {tab==="analytics"&&<AnalyticsTab trades={trades} stats={stats} weeklyAI={weeklyAI} genWeeklyAI={genWeeklyAI}/>}
            {tab==="calendar"&&<CalendarTab trades={trades} todayNews={todayNews}/>}
            {tab==="news"&&<NewsTab savedNews={savedNews} setSavedNews={setSavedNews} fetchNews={fetchNews} newsLd={newsLd} openArticle={openArticle} searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchResults={searchResults} searchLd={searchLd} searchErr={searchErr} fetchMarketSearch={fetchMarketSearch}/>}
            {tab==="crypto"&&<CryptoTab prices={prices} pFlash={pFlash} trades={trades} onAddSymbol={onAddSymbol}/>}
            {tab==="journal"&&<JournalTab trades={trades}/>}
            {tab==="setup"&&<SetupTab serverOk={serverOk} trades={trades} riskLimit={riskLimit} setRiskLimit={setRiskLimit} goals={goals} setGoals={setGoals} accounts={accounts} setAccounts={setAccounts} activeAccount={activeAccount} setActiveAccount={setActiveAccount} prices={prices}/>}
          </div>
        </div>
      </div>
      {/* Mobile bottom navigation */}
      <nav className="bottom-nav" style={{paddingBottom:"env(safe-area-inset-bottom,0px)"}}>
        {NAV.slice(0,6).map(n=>{
          const active=tab===n.id;
          return <button key={n.id} className="bottom-nav-item" onClick={()=>setTab(n.id)}
            style={{color:active?T.blue:T.textDim}}>
            <span style={{fontSize:16}}>{n.icon}</span>
            <span style={{fontSize:9,fontWeight:active?700:400}}>{n.label}</span>
          </button>;
        })}
      </nav>
    </>
  );
}
