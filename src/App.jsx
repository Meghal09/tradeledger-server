import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from "recharts";

const SERVER = "https://tradeledger-server-production.up.railway.app";
const WS_URL  = "wss://tradeledger-server-production.up.railway.app/ws";
const RAILWAY_SERVER = SERVER;
const DEFAULT_WL = ["EURUSD","GBPUSD","USDJPY","XAUUSD","GBPJPY","USDCHF","AUDUSD","BTCUSD"];
const PRICE_CACHE_KEY = "tl_price_cache";
const PRICE_CACHE_TTL = 5 * 60 * 1000;

const T = {
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

function parseMT5Date(s){if(!s)return null;const d=new Date(String(s).replace(/\./g,"-").replace(" ","T"));return isNaN(d.getTime())?null:d;}
function mt5Day(s){const d=parseMT5Date(s);return d?d.toISOString().slice(0,10):null;}
function mt5Hour(s){const d=parseMT5Date(s);return d?d.getUTCHours():null;}

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
  return{total:trades.length,wins:wins.length,losses:losses.length,winRate:+((wins.length/trades.length)*100).toFixed(1),totalProfit,grossProfit:+gp.toFixed(2),grossLoss:+gl.toFixed(2),pf,avgWin,avgLoss,rr:avgLoss>0?+(avgWin/avgLoss).toFixed(2):"--",maxDD:+maxDD.toFixed(2),equity,dailyPnl,bySymbol:Object.values(symMap).sort((a,b)=>b.profit-a.profit),sessions:Object.entries(sessions).map(([k,v])=>({name:k,profit:+v.toFixed(2)})),byDayOfWeek:dayMap,maxCW,maxCL,expectancy};
}

const getSessions=()=>{const now=new Date(),u=now.getUTCHours()*60+now.getUTCMinutes();return[{name:"Sydney",color:T.cyan,open:21*60,close:6*60,overnight:true},{name:"Tokyo",color:T.amber,open:0,close:9*60,overnight:false},{name:"London",color:T.green,open:8*60,close:17*60,overnight:false},{name:"New York",color:T.purple,open:13*60,close:22*60,overnight:false}].map(s=>({...s,active:s.overnight?(u>=s.open||u<s.close):(u>=s.open&&u<s.close)}));};
const getAssetInfo=s=>({XAUUSD:{name:"Gold",type:"metal",pip:0.1},BTCUSD:{name:"Bitcoin",type:"crypto",pip:1},ETHUSD:{name:"Ethereum",type:"crypto",pip:0.1},EURUSD:{name:"EUR/USD",type:"forex",pip:0.0001},GBPUSD:{name:"GBP/USD",type:"forex",pip:0.0001},USDJPY:{name:"USD/JPY",type:"forex",pip:0.01},GBPJPY:{name:"GBP/JPY",type:"forex",pip:0.01},AUDUSD:{name:"AUD/USD",type:"forex",pip:0.0001},USDCHF:{name:"USD/CHF",type:"forex",pip:0.0001},USDCAD:{name:"USD/CAD",type:"forex",pip:0.0001},NZDUSD:{name:"NZD/USD",type:"forex",pip:0.0001},XAGUSD:{name:"Silver",type:"metal",pip:0.001},NAS100:{name:"Nasdaq",type:"index",pip:0.1},SPX500:{name:"S&P 500",type:"index",pip:0.1},US30:{name:"Dow Jones",type:"index",pip:1},USOIL:{name:"Crude Oil",type:"commodity",pip:0.01}}[s]||{name:s,type:"forex",pip:0.0001});
const WL_SYMBOLS={Forex:["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","NZDUSD","USDCAD","EURGBP","EURJPY","GBPJPY","AUDJPY","CADJPY"],Metals:["XAUUSD","XAGUSD"],Crypto:["BTCUSD","ETHUSD","XRPUSD"],Indices:["NAS100","US30","SPX500","GER40"],Energy:["USOIL","UKOIL"]};
const DEFAULT_CHECKLIST=["Checked economic calendar","Confirmed trend direction","Set stop loss","Risk < 1% of account","No revenge trading mindset","Entry aligns with setup rules"];

// ── CSS ──────────────────────────────────────────────────────
const GlobalStyles=()=>(
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body,#root{height:100%;overflow:hidden;}
    body{background:${T.bg};color:${T.text};font-family:'Inter',sans-serif;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;}
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
  const todayStr=new Date().toISOString().slice(0,10);
  const [period,setPeriod]=useState("all");
  const periods=[{k:"today",l:"Today"},{k:"yesterday",l:"Yesterday"},{k:"week",l:"This Week"},{k:"lastweek",l:"Last Week"},{k:"month",l:"This Month"},{k:"lastmonth",l:"Last Month"},{k:"year",l:"This Year"},{k:"all",l:"All Time"}];

  const filteredTrades=useMemo(()=>{
    // mt5Day() already normalises "2024.03.15 14:22" → "2024-03-15" via parseMT5Date
    const getDay=t=>mt5Day(t.closeTime)||mt5Day(t.openTime)||"";
    const weekAgo=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const monthAgo=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const ydStr=new Date(Date.now()-86400000).toISOString().slice(0,10);
    if(period==="today")return trades.filter(t=>getDay(t)===todayStr);
    if(period==="yesterday")return trades.filter(t=>getDay(t)===ydStr);
    if(period==="week")return trades.filter(t=>getDay(t)>=weekAgo);
    if(period==="lastweek"){const s=new Date(Date.now()-14*86400000).toISOString().slice(0,10);return trades.filter(t=>{const d=getDay(t);return d>=s&&d<weekAgo;});}
    if(period==="month")return trades.filter(t=>getDay(t)>=monthAgo);
    if(period==="lastmonth"){const s=new Date(Date.now()-60*86400000).toISOString().slice(0,10);return trades.filter(t=>{const d=getDay(t);return d>=s&&d<monthAgo;});}
    if(period==="year"){const y=new Date();y.setFullYear(y.getFullYear()-1);return trades.filter(t=>getDay(t)>=y.toISOString().slice(0,10));}
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

      {/* HEADER */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:700,letterSpacing:"-0.5px"}}>Dashboard</h1>
          <div style={{fontSize:12,color:T.textSub,marginTop:2}}>Welcome back — {new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,background:serverOk?T.greenBg:T.redBg,border:"1px solid "+(serverOk?T.greenBorder:T.redBorder),borderRadius:20,padding:"3px 12px",fontSize:11,fontWeight:600,color:serverOk?T.green:T.red}}>
          <div style={{width:5,height:5,borderRadius:"50%",background:serverOk?T.green:T.red,animation:serverOk?"none":"pulse 1.5s infinite"}}/>
          {serverOk?"Live":"Offline"}
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
                    const dStr=day.toISOString().slice(0,10);
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

// ── WATCHLIST ─────────────────────────────────────────────────
function WatchlistTab({watchlist,prices,pFlash,onAddSymbol,onRemoveSymbol,analyseSymbol,trades}){
  const [pickerOpen,setPickerOpen]=useState(false);
  const [pickerCat,setPickerCat]=useState("Forex");
  const [selectedSym,setSelectedSym]=useState(null);
  const [sizerOpen,setSizerOpen]=useState(false);
  const [sizerSym,setSizerSym]=useState("");
  const [sizerAccount,setSizerAccount]=useState("10000");
  const [sizerRisk,setSizerRisk]=useState("1");
  const [sizerSlPips,setSizerSlPips]=useState("20");

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
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Watchlist</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>Live prices + position sizer + signal scanner</p></div>
        <div style={{display:"flex",gap:8}}>
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
                  <div style={{textAlign:"right"}}><button onClick={e=>{e.stopPropagation();onRemoveSymbol(sym);}} style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:15,padding:2,lineHeight:1}}>x</button></div>
                </div>
              );
            })}
            {watchlist.length===0&&<div style={{padding:32,textAlign:"center",color:T.textDim,fontSize:12}}>Add symbols to track live prices</div>}
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
                    {/* Catalyst */}
                    <div style={{fontSize:12,color:T.textSub,lineHeight:1.65,borderLeft:`3px solid ${sc}40`,paddingLeft:10}}>{a.catalyst}</div>
                  </div>
                </div>
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
            <div className="card" style={{padding:32,textAlign:"center",color:T.textSub,fontSize:13,display:"flex",flexDirection:"column",gap:8,alignItems:"center",justifyContent:"center",height:"100%"}}>
              <div style={{fontSize:28,opacity:0.2,marginBottom:4}}>◈</div>
              <div style={{fontWeight:600,color:T.text}}>Select a symbol</div>
              <div style={{fontSize:12}}>Click any row on the left to see detailed market analysis, support/resistance levels, and your personal trade history for that symbol.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ANALYTICS ────────────────────────────────────────────────
function AnalyticsTab({trades,stats,weeklyAI,genWeeklyAI}){
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

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Analytics</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>{stats.total} trades analysed</p></div>
      </div>

      {/* KPI grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        <KpiCard label="Net P&L" value={`$${stats.totalProfit}`} color={pnlColor}/>
        <KpiCard label="Win Rate" value={`${stats.winRate}%`} color={stats.winRate>=50?T.green:T.red}/>
        <KpiCard label="Profit Factor" value={stats.pf} color={stats.pf>=1.5?T.green:stats.pf>=1?T.amber:T.red}/>
        <KpiCard label="Expectancy" value={`$${stats.expectancy}`} color={stats.expectancy>=0?T.green:T.red}/>
        <KpiCard label="Avg Win" value={`$${stats.avgWin}`} color={T.green}/>
        <KpiCard label="Avg Loss" value={`$${stats.avgLoss}`} color={T.red}/>
        <KpiCard label="Max Drawdown" value={`${stats.maxDD}%`} color={stats.maxDD>10?T.red:T.amber}/>
        <KpiCard label="Max Loss Streak" value={stats.maxCL} color={stats.maxCL>=4?T.red:T.amber}/>
      </div>

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

      {/* AI Coach */}
      <div className="card" style={{marginBottom:4}}>
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
      </div>
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

  const todayStr=new Date().toISOString().slice(0,10);
  const selectedData=selectedDay?tradesByDay[selectedDay]:null;

  return (
    <div className="page" style={{overflowY:"auto",height:"100%",paddingBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>Calendar</h1>
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
              const dStr=day.toISOString().slice(0,10);
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
              tradingDays.forEach(d=>{const k=d.toISOString().slice(0,10);if(tradesByDay[k]){wProfit+=tradesByDay[k].profit;wCount+=tradesByDay[k].count;}});
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

          {/* Economic events */}
          {todayNews.length>0&&(
            <div className="card" style={{overflow:"hidden"}}>
              <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,fontSize:12,fontWeight:600}}>Economic Events</div>
              <div>
                {todayNews.map((e,i)=>{
                  const impact=(e.impact||"").toLowerCase();
                  const col=impact==="high"?T.red:impact==="medium"?T.amber:T.textDim;
                  const badgeCol=impact==="high"?"red":impact==="medium"?"amber":"gray";
                  return (
                    <div key={i} className="trow" style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:col,flexShrink:0,boxShadow:impact==="high"?`0 0 6px ${col}`:"none"}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:500,color:T.text,lineHeight:1.4}}>{e.title||e.event||e.name||"Event"}</div>
                        <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{e.country||e.currency} {e.time?`· ${new Date(e.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`:""}</div>
                        {(e.actual!=null||e.forecast!=null)&&<div style={{fontSize:10,color:T.textSub,marginTop:2,fontFamily:"'JetBrains Mono',monospace"}}>
                          {e.actual!=null&&<span style={{color:T.green}}>Actual: {e.actual} </span>}
                          {e.forecast!=null&&<span style={{color:T.textDim}}>Forecast: {e.forecast} </span>}
                          {e.previous!=null&&<span style={{color:T.textDim}}>Prev: {e.previous}</span>}
                        </div>}
                      </div>
                      <Badge color={badgeCol}>{impact||"low"}</Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
    date: new Date().toISOString().slice(0,10),
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
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button className="btn" onClick={()=>{setSelected(null);setView("list");}}>Back</button>
          <div>
            <h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>{selected.symbol} — {selected.date}</h1>
            <div style={{fontSize:12,color:T.textSub,marginTop:1}}>{selected.type?.toUpperCase()} trade</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
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
                    <div style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{entry.symbol}</div>
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

// ── SETUP ─────────────────────────────────────────────────────
function SetupTab({serverOk,trades,riskLimit,setRiskLimit}){
  const [rlInput,setRlInput]=useState(riskLimit||"");
  return (
    <div className="page" style={{overflowY:"auto",height:"100%"}}>
      <div style={{marginBottom:20}}><h1 style={{fontSize:20,fontWeight:700,letterSpacing:"-0.5px"}}>EA Setup</h1><p style={{fontSize:12,color:T.textSub,marginTop:1}}>Configure your MetaTrader 5 connection</p></div>
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

  const connectWS=useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN)return;
    try{const ws=new WebSocket(WS_URL);wsRef.current=ws;ws.onopen=()=>{};ws.onclose=()=>{reconnRef.current=setTimeout(connectWS,5000);};ws.onerror=()=>{ws.close();};ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==="TRADE_UPDATE"||m.type==="NEW_TRADE"||m.type==="TRADES_REPLACED"){setTrades(m.trades||[]);setLastSync(new Date().toISOString());}if(m.type==="CLEARED")setTrades([]);}catch{}};}catch{}
  },[]);

  const fetchAll=useCallback(async()=>{
    try{const[tr,st]=await Promise.all([fetch(SERVER+"/api/trades"),fetch(SERVER+"/api/status")]);if(st.ok)setServerOk(true);if(tr.ok){const d=await tr.json();setTrades(d.trades||[]);setLastSync(new Date().toISOString());}}catch{setServerOk(false);}
  },[]);

  useEffect(()=>{fetchAll();},[fetchAll]);
  useEffect(()=>{const t=setInterval(fetchAll,30000);return()=>clearInterval(t);},[fetchAll]);
  useEffect(()=>{if(serverOk)connectWS();return()=>{wsRef.current?.close();clearTimeout(reconnRef.current);};},[serverOk,connectWS]);

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
    const load=async()=>{try{const r=await fetch(SERVER+"/api/week-events",{signal:AbortSignal.timeout(20000)});if(r.ok){const d=await r.json();setTodayNews(d.events||[]);}}catch{}};
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

  const NAV=[{id:"watchlist",icon:"◈",label:"Watchlist"},{id:"dashboard",icon:"▦",label:"Dashboard"},{id:"analytics",icon:"◎",label:"Analytics"},{id:"journal",icon:"[+]",label:"Journal"},{id:"calendar",icon:"◷",label:"Calendar"},{id:"news",icon:"◉",label:"News"},{id:"setup",icon:"o",label:"Setup"}];
  const [clockTick,setClockTick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>setClockTick(n=>n+1),30000);return()=>clearInterval(t);},[]);
  const now=new Date(),utcStr=now.toUTCString().slice(17,22)+" UTC",localStr=now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  const sessions=getSessions();

  return (
    <>
      <GlobalStyles/>

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
      {!riskLockDismissed&&riskLimit&&(()=>{const tp=trades.filter(t=>(t.closeTime||"").slice(0,10)===new Date().toISOString().slice(0,10)).reduce((s,t)=>s+(t.profit||0)+(t.swap||0)+(t.commission||0),0);if(tp>-Math.abs(riskLimit))return null;return<div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(255,255,255,.95)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}><div style={{fontSize:32,fontWeight:800,color:T.red,marginBottom:16}}>RISK LOCK</div><div style={{fontSize:16,color:T.textSub,marginBottom:8}}>Today P&L: <span style={{color:T.red,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>${tp.toFixed(2)}</span></div><div style={{fontSize:13,color:T.textDim,marginBottom:28,textAlign:"center",maxWidth:320}}>Daily risk limit of ${Math.abs(riskLimit)} hit. Stop trading for today.</div><div style={{display:"flex",gap:10}}><button className="btn" onClick={()=>setTab("setup")}>Edit Limit</button><button className="btn btn-primary" style={{background:T.red,borderColor:T.red}} onClick={()=>setRiskLockDismissed(true)}>I Understand</button></div></div>;})()} 

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
        <div style={{width:200,background:"#fff",borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden",boxShadow:"1px 0 6px rgba(0,0,0,0.04)"}}>
          <div style={{padding:"14px 12px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:32,height:32,borderRadius:10,background:`linear-gradient(135deg,${T.blue},#6d9bff)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:"#fff",flexShrink:0}}>TL</div>
            <div><div style={{fontSize:14,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>TradeLedger</div><div style={{fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>MT5 Journal</div></div>
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
          <div style={{padding:"8px 6px",borderTop:`1px solid ${T.border}`,flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,justifyContent:"flex-start",padding:"4px 6px"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:serverOk?T.green:T.red,flexShrink:0,animation:serverOk?"none":"pulse 1.5s infinite"}}/>
              <span style={{fontSize:11,color:serverOk?T.green:T.red,whiteSpace:"nowrap",fontWeight:500}}>{serverOk?"Online":"Offline"}</span>
            </div>
            <>
              {sessions.map(s=><div key={s.name} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 6px",opacity:s.active?1:0.35}}><div style={{width:4,height:4,borderRadius:"50%",background:s.active?s.color:T.textDim,flexShrink:0}}/><span style={{fontSize:9,color:s.active?T.textSub:T.textDim,whiteSpace:"nowrap"}}>{s.name}</span></div>)}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.textDim,fontFamily:"'JetBrains Mono',monospace",padding:"4px 6px",marginTop:4}}><span>{utcStr}</span><span>{localStr}</span></div>
            </>}
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
            </div>
          </div>

          {newsImpactOpen&&todayNews.length>0&&(
            <div style={{background:"#fff",borderBottom:`1px solid ${T.border}`,padding:"8px 18px"}}>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                {todayNews.slice(0,6).map((e,i)=>{
                  const impact=(e.impact||"").toLowerCase(),col=impact==="high"?T.red:impact==="medium"?T.amber:T.textDim;
                  return <div key={i} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:T.textSub}}><div style={{width:5,height:5,borderRadius:"50%",background:col,flexShrink:0}}/><span>{e.title||e.event}</span></div>;
                })}
              </div>
            </div>
          )}
          {!serverOk&&<div style={{background:T.redBg,borderBottom:`1px solid ${T.redBorder}`,padding:"6px 18px",display:"flex",alignItems:"center",gap:8,fontSize:12,color:T.red,flexShrink:0}}><div style={{width:5,height:5,borderRadius:"50%",background:T.red,animation:"pulse 1.5s infinite",flexShrink:0}}/>Server offline — AI features unavailable<button className="btn" style={{marginLeft:"auto",fontSize:11,color:T.red,borderColor:T.redBorder,padding:"3px 10px"}} onClick={fetchAll}>Retry</button></div>}

          {/* Page — key fixes: overflowY:auto on content div, min-height:0 on flex chain */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px 20px",minHeight:0}}>
            {tab==="dashboard"&&<DashboardTab trades={trades} stats={stats} serverOk={serverOk} lastSync={lastSync}/>}
            {tab==="watchlist"&&<WatchlistTab watchlist={watchlist} prices={prices} pFlash={pFlash} onAddSymbol={onAddSymbol} onRemoveSymbol={onRemoveSymbol} analyseSymbol={analyseSymbol} trades={trades}/>}
            {tab==="analytics"&&<AnalyticsTab trades={trades} stats={stats} weeklyAI={weeklyAI} genWeeklyAI={genWeeklyAI}/>}
            {tab==="calendar"&&<CalendarTab trades={trades} todayNews={todayNews}/>}
            {tab==="news"&&<NewsTab savedNews={savedNews} setSavedNews={setSavedNews} fetchNews={fetchNews} newsLd={newsLd} openArticle={openArticle} searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchResults={searchResults} searchLd={searchLd} searchErr={searchErr} fetchMarketSearch={fetchMarketSearch}/>}
            {tab==="journal"&&<JournalTab trades={trades}/>}
            {tab==="setup"&&<SetupTab serverOk={serverOk} trades={trades} riskLimit={riskLimit} setRiskLimit={setRiskLimit}/>}
          </div>
        </div>
      </div>
    </>
  );
}
