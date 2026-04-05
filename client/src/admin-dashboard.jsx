import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  RadialBarChart, RadialBar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";

/* ═══════════════════════════════════════════════════════════════
   ⚙️  CONFIG — عدّل هنا فقط
   ═══════════════════════════════════════════════════════════════ */
const CONFIG = {
  ADMIN_ID: "5469997406",
  API_BASE:  "",           // فارغ = نفس الـ origin | أو: "https://your-server.com"
  REFRESH_MS: 30_000,
  //  USE_MOCK:
  //    "auto"   = يجرّب API حقيقي، لو فشل يرجع mock تلقائياً
  //    "always" = mock دائماً (Lovable / تطوير محلي)
  //    "never"  = API فقط بدون fallback
  USE_MOCK: "auto",
};

/* ═══════════════════════════════════════════════════════════════
   📦  MOCK DATA
   ═══════════════════════════════════════════════════════════════ */
const MOCK = {
  today: {
    date: new Date().toISOString().slice(0,10),
    searches: 847, downloads: 621, success: 574, fail: 47,
    cacheHits: 198, successRate: "92.4%", cacheRate: "31.9%",
    avgMs: 3840, activeUsers: 312,
  },
  total:     { totalSearches: 48291, totalDownloads: 34872 },
  queue:     { highQueue: 2, normalQueue: 11, dlqSize: 3, totalActiveJobs: 13 },
  premium:   { count: 47 },
  banned:    { count: 8 },
  blacklist: { total: 234, active: 189 },
  system: {
    uptimeHuman: "5ي 0س 0د", maintenance: false, redis: true,
    memory: { heapUsed: 142, heapTotal: 256, rss: 310 },
    workers: 4, nodeVersion: "v20.11.0", pid: 1337,
  },
  weekly: [
    { date:"02-28", searches:620, downloads:441, success:398, fail:43, cacheHits:112, activeUsers:201, avgMs:4200 },
    { date:"03-01", searches:710, downloads:523, success:489, fail:34, cacheHits:154, activeUsers:267, avgMs:3900 },
    { date:"03-02", searches:530, downloads:389, success:351, fail:38, cacheHits: 98, activeUsers:178, avgMs:4100 },
    { date:"03-03", searches:890, downloads:671, success:623, fail:48, cacheHits:201, activeUsers:341, avgMs:3600 },
    { date:"03-04", searches:780, downloads:590, success:552, fail:38, cacheHits:175, activeUsers:298, avgMs:3750 },
    { date:"03-05", searches:910, downloads:688, success:641, fail:47, cacheHits:212, activeUsers:365, avgMs:3500 },
    { date:"03-06", searches:847, downloads:621, success:574, fail:47, cacheHits:198, activeUsers:312, avgMs:3840 },
  ],
  topBooks: [
    { title:"أرض زيكولا",               count:89 },
    { title:"الأمير الصغير",             count:76 },
    { title:"عزازيل",                   count:71 },
    { title:"زقاق المدق",               count:68 },
    { title:"قواعد العشق الأربعون",     count:52 },
    { title:"موبي ديك",                  count:47 },
    { title:"فرانكنشتاين في بغداد",     count:43 },
    { title:"مائة عام من العزلة",       count:38 },
  ],
  sources: [
    { domain:"archive.org",    ok:187, fail: 9, rate:"95%" },
    { domain:"foulabook.com",  ok:143, fail:21, rate:"87%" },
    { domain:"noor-book.com",  ok:112, fail:18, rate:"86%" },
    { domain:"pdfdrive.com",   ok: 98, fail:34, rate:"74%" },
    { domain:"z-lib.org",      ok: 76, fail:42, rate:"64%" },
    { domain:"kotobati.com",   ok: 54, fail:28, rate:"66%" },
  ],
  dlqJobs: [
    { bookName:"كتاب النجاح",      userId:"112233445", failReason:"PDF download timeout 30s", createdAt:Date.now()-120000 },
    { bookName:"مختصر المفيد",     userId:"998877665", failReason:"All sources returned 404", createdAt:Date.now()-300000 },
    { bookName:"مقدمة ابن خلدون", userId:"554433221", failReason:"File size exceeded 50MB",  createdAt:Date.now()-600000 },
  ],
  premiumUsers: ["112233445","998877665","443322110","556677889","112299334"],
  bannedUsers:  ["909090909","111222333"],
};

/* ═══════════════════════════════════════════════════════════════
   🌐  SMART API — auto mock fallback
   ═══════════════════════════════════════════════════════════════ */
let _mode = CONFIG.USE_MOCK; // runtime: "auto" | "always" | "never"

async function apiFetch(path, opts = {}) {
  if (_mode === "always") return null;
  const base = CONFIG.API_BASE.trim() || window.location.origin;
  try {
    const res = await fetch(`${base}/api/admin/${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${CONFIG.ADMIN_ID}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (_mode === "auto") _mode = "never";  // API работает — переключаемся на реальный
    return j.data ?? j;
  } catch {
    if (_mode === "never") return null;      // API работал раньше, просто пустой ответ
    _mode = "always";                        // переключаемся на mock навсегда
    return null;
  }
}

async function apiPost(method, path, body) {
  await apiFetch(path, { method, body: body ? JSON.stringify(body) : undefined });
  return true;
}

async function loadOverview() {
  const d = await apiFetch("overview");
  if (d) return d;
  return {
    today: MOCK.today, total: MOCK.total, queue: MOCK.queue,
    premium: MOCK.premium, banned: MOCK.banned,
    blacklist: MOCK.blacklist, system: MOCK.system, weekly: MOCK.weekly,
  };
}
async function loadTopBooks() { return (await apiFetch("stats/top-books?limit=15")) ?? MOCK.topBooks; }
async function loadSources()  { return (await apiFetch("stats/sources"))            ?? MOCK.sources;  }
async function loadDLQ()      { return (await apiFetch("queue/dlq?limit=30"))        ?? MOCK.dlqJobs;  }
async function loadPremium()  { return (await apiFetch("users/premium"))             ?? MOCK.premiumUsers; }
async function loadBanned()   { return (await apiFetch("users/banned"))              ?? MOCK.bannedUsers;  }

/* ═══════════════════════════════════════════════════════════════
   🎨  TOKENS
   ═══════════════════════════════════════════════════════════════ */
const T = {
  bg:"#07090f", surface:"#0d1117", card:"#141920", cardHov:"#191f28",
  border:"#1e2533",
  gold:"#d4a843", goldMid:"#b8902e", goldDim:"#7a5c18",
  green:"#3fb950", greenDim:"#1a4d23",
  red:"#f85149",   redDim:"#4d1a18",
  blue:"#58a6ff",  blueDim:"#1a3a5c",
  purple:"#bc8cff",orange:"#f0883e",
  text:"#e6edf3",  textMid:"#adbac7", muted:"#636e7b", dim:"#2d333b",
};

if (!document.getElementById("_dcss")) {
  const s = document.createElement("style");
  s.id = "_dcss";
  s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=Noto+Kufi+Arabic:wght@300;400;500;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{background:${T.bg};color:${T.text};font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;overflow-x:hidden}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${T.surface}}::-webkit-scrollbar-thumb{background:${T.dim};border-radius:3px}
.mono{font-family:'IBM Plex Mono',monospace!important;direction:ltr;display:inline-block}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes glow{0%,100%{box-shadow:0 0 4px ${T.gold}44}50%{box-shadow:0 0 18px ${T.gold}88}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
.fade-up{animation:fadeUp .3s ease forwards}
.pulse{animation:pulse 2.5s ease-in-out infinite}
.glow{animation:glow 2.5s ease-in-out infinite}
.hcard:hover{background:${T.cardHov}!important}
table{border-collapse:collapse;width:100%}th,td{padding:9px 12px;text-align:right}
tr:hover td{background:${T.surface}22}
input,select{background:${T.surface};border:1px solid ${T.border};border-radius:8px;color:${T.text};padding:8px 12px;font-family:inherit;font-size:13px;outline:none;width:100%}
input:focus,select:focus{border-color:${T.gold}88}
button{cursor:pointer;font-family:'Noto Kufi Arabic',sans-serif}
.shimmer{background:linear-gradient(90deg,${T.dim} 25%,${T.border} 50%,${T.dim} 75%);background-size:400px;animation:shimmer 1.4s infinite}
  `;
  document.head.appendChild(s);
}

/* ═══════════════════════════════════════════════════════════════
   🧩  ATOMS
   ═══════════════════════════════════════════════════════════════ */
const Card = ({children,style={},className="",onClick}) => (
  <div className={`${onClick?"hcard":""} ${className}`} onClick={onClick}
    style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,
      padding:20,transition:"background .15s",...style}}>
    {children}
  </div>
);

const Tag = ({children,color=T.gold,size=11}) => (
  <span style={{background:color+"20",color,border:`1px solid ${color}40`,
    padding:"2px 9px",borderRadius:20,fontSize:size,fontWeight:600,whiteSpace:"nowrap"}}>
    {children}
  </span>
);

const HR = () => (
  <div style={{height:1,margin:"14px 0",background:`linear-gradient(90deg,transparent,${T.border},transparent)`}}/>
);

const Dot = ({color=T.green,size=8}) => (
  <span className="pulse" style={{display:"inline-block",width:size,height:size,
    borderRadius:"50%",background:color,marginLeft:5,flexShrink:0}}/>
);

function Btn({children,onClick,variant="ghost",size="md",disabled=false}) {
  const pad={sm:"5px 11px",md:"8px 18px",lg:"11px 24px"}[size]||"8px 18px";
  const fs={sm:11,md:13,lg:14}[size]||13;
  const v={
    ghost:   {bg:"transparent",     border:T.border,   color:T.textMid},
    gold:    {bg:T.goldDim+"40",   border:T.goldDim,  color:T.gold},
    danger:  {bg:T.redDim+"40",    border:T.redDim,   color:T.red},
    success: {bg:T.greenDim+"40",  border:T.greenDim, color:T.green},
    blue:    {bg:T.blueDim+"40",   border:T.blueDim,  color:T.blue},
  }[variant]||{bg:"transparent",border:T.border,color:T.textMid};
  return (
    <button onClick={onClick} disabled={disabled}
      style={{background:v.bg,border:`1px solid ${v.border}`,color:v.color,
        padding:pad,borderRadius:8,fontSize:fs,display:"inline-flex",alignItems:"center",
        gap:5,opacity:disabled?.5:1,transition:"all .15s",whiteSpace:"nowrap",fontWeight:500}}>
      {children}
    </button>
  );
}

const SH = ({icon,title,actions}) => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,fontSize:15,fontWeight:700}}>
      <span style={{fontSize:18}}>{icon}</span>{title}
    </div>
    {actions && <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{actions}</div>}
  </div>
);

const CT = ({active,payload,label}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,
      padding:"10px 14px",fontSize:12,minWidth:130}}>
      <div style={{color:T.muted,marginBottom:6,fontWeight:600}}>{label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
          <span style={{width:9,height:9,borderRadius:2,background:p.color,flexShrink:0}}/>
          <span style={{color:T.muted,flex:1}}>{p.name}</span>
          <span className="mono" style={{color:p.color,fontWeight:700}}>{p.value?.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

const Sk = ({w="100%",h=20,r=6}) => (
  <div className="shimmer" style={{width:w,height:h,borderRadius:r}}/>
);

function ApiBadge({isMock}) {
  return isMock
    ? <Tag color={T.orange} size={11}>🟡 بيانات تجريبية</Tag>
    : <Tag color={T.green}  size={11}>🟢 API حقيقية</Tag>;
}

/* ═══════════════════════════════════════════════════════════════
   📊  KPI
   ═══════════════════════════════════════════════════════════════ */
function KPI({icon,label,value,sub,color=T.gold,trend}) {
  return (
    <Card style={{position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,right:0,width:3,height:"100%",
        background:`linear-gradient(180deg,${color},${color}44)`,borderRadius:"0 14px 14px 0"}}/>
      <div style={{position:"absolute",top:-20,left:-20,width:80,height:80,
        borderRadius:"50%",background:color+"08",pointerEvents:"none"}}/>
      <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
        <span style={{fontSize:24,lineHeight:1,marginTop:4}}>{icon}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,color:T.muted,marginBottom:5,fontWeight:500}}>{label}</div>
          <div className="mono" style={{fontSize:26,fontWeight:700,color,lineHeight:1,letterSpacing:"-.5px"}}>
            {value??<span style={{color:T.dim}}>—</span>}
          </div>
          {sub   && <div style={{fontSize:11,color:T.muted,marginTop:5}}>{sub}</div>}
          {trend!=null && (
            <div style={{fontSize:11,marginTop:4,color:trend>0?T.green:trend<0?T.red:T.muted}}>
              {trend>0?"↑":trend<0?"↓":"→"} {Math.abs(trend)}%
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════
   🔔  TOAST
   ═══════════════════════════════════════════════════════════════ */
function Toast({msg,type="ok",onDone}) {
  useEffect(()=>{const t=setTimeout(onDone,3200);return ()=>clearTimeout(t);},[]);
  const c=type==="ok"?T.green:type==="warn"?T.orange:T.red;
  return (
    <div className="fade-up" style={{position:"fixed",bottom:28,left:"50%",
      transform:"translateX(-50%)",background:T.card,border:`1px solid ${c}60`,
      color:c,padding:"11px 22px",borderRadius:12,fontSize:13,fontWeight:600,
      zIndex:9999,boxShadow:`0 4px 24px ${c}20`,display:"flex",alignItems:"center",gap:8}}>
      {type==="ok"?"✅":type==="warn"?"⚠️":"❌"} {msg}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   📋  TABS
   ═══════════════════════════════════════════════════════════════ */

/* ── Overview ── */
function OverviewTab({ov}) {
  if (!ov) return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
      {Array(12).fill(0).map((_,i)=><Card key={i}><Sk h={70}/></Card>)}
    </div>
  );
  const {today,total,queue,premium,banned,system} = ov;
  const sr = today.downloads>0 ? ((today.success/today.downloads)*100).toFixed(1) : "0";
  const kpis = [
    {icon:"🔍",label:"بحث اليوم",        value:today.searches.toLocaleString(),   color:T.blue,   sub:`إجمالي: ${total.totalSearches.toLocaleString()}`},
    {icon:"📥",label:"تحميل اليوم",      value:today.downloads.toLocaleString(),  color:T.gold,   sub:`إجمالي: ${total.totalDownloads.toLocaleString()}`, trend:8},
    {icon:"✅",label:"نسبة النجاح",      value:`${sr}٪`,                          color:+sr>=90?T.green:+sr>=70?T.orange:T.red, sub:`${today.success} نجاح`},
    {icon:"⚡",label:"من الكاش",         value:today.cacheHits.toLocaleString(),  color:T.purple, sub:today.cacheRate},
    {icon:"👥",label:"مستخدمون نشطون",  value:today.activeUsers.toLocaleString(),color:T.blue,   sub:"اليوم"},
    {icon:"⏱️",label:"متوسط الاستجابة", value:`${today.avgMs}ms`,                color:today.avgMs<5000?T.green:T.red},
    {icon:"⭐",label:"مميزون",            value:premium.count,                     color:T.gold},
    {icon:"🔄",label:"الطابور",           value:queue.totalActiveJobs,             color:T.orange, sub:`high:${queue.highQueue} · normal:${queue.normalQueue}`},
    {icon:"💀",label:"DLQ",              value:queue.dlqSize,                     color:queue.dlqSize>10?T.red:T.muted},
    {icon:"🚫",label:"محظورون",           value:banned.count,                      color:T.red},
    {icon:"💾",label:"Heap",             value:`${system.memory.heapUsed}MB`,     color:T.muted,  sub:`RSS: ${system.memory.rss}MB`},
    {icon:"⏰",label:"Uptime",           value:system.uptimeHuman,                color:T.green,  sub:`${system.workers} workers`},
  ];
  return (
    <div className="fade-up">
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
        {kpis.map((k,i)=><KPI key={i} {...k}/>)}
      </div>
      {system.maintenance && (
        <div style={{marginTop:16,background:T.redDim,border:`1px solid ${T.red}55`,
          borderRadius:12,padding:"12px 18px",color:T.red,fontWeight:600,fontSize:13,
          display:"flex",alignItems:"center",gap:8}}>
          🔴 وضع الصيانة مفعّل — البوت لا يستقبل طلبات
        </div>
      )}
    </div>
  );
}

/* ── Analytics ── */
function AnalyticsTab({weekly}) {
  if (!weekly?.length) return <Card><Sk h={260}/></Card>;
  const data = weekly.map(d=>({
    ...d,
    "نجاح٪": d.downloads>0?+((d.success/d.downloads)*100).toFixed(1):0,
    "كاش٪":  d.success>0  ?+((d.cacheHits/d.success)*100).toFixed(1):0,
  }));
  return (
    <div className="fade-up" style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card>
        <SH icon="📈" title="الحركة اليومية — آخر 7 أيام"/>
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={data} margin={{top:4,right:4,left:-24,bottom:0}}>
            <defs>
              {[["gB",T.blue],["gG",T.gold],["gGr",T.green],["gP",T.purple]].map(([id,c])=>(
                <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={c} stopOpacity={0.35}/>
                  <stop offset="95%" stopColor={c} stopOpacity={0}/>
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border}/>
            <XAxis dataKey="date" tick={{fontSize:11,fill:T.muted}} stroke={T.border}/>
            <YAxis tick={{fontSize:10,fill:T.muted}} stroke={T.border}/>
            <Tooltip content={<CT/>}/>
            <Area type="monotone" dataKey="searches"  name="بحث"   stroke={T.blue}   fill="url(#gB)"  strokeWidth={2}/>
            <Area type="monotone" dataKey="downloads" name="تحميل" stroke={T.gold}   fill="url(#gG)"  strokeWidth={2}/>
            <Area type="monotone" dataKey="success"   name="نجاح"  stroke={T.green}  fill="url(#gGr)" strokeWidth={2}/>
            <Area type="monotone" dataKey="cacheHits" name="كاش"   stroke={T.purple} fill="url(#gP)"  strokeWidth={2}/>
          </AreaChart>
        </ResponsiveContainer>
        <div style={{display:"flex",gap:16,marginTop:8,flexWrap:"wrap"}}>
          {[["بحث",T.blue],["تحميل",T.gold],["نجاح",T.green],["كاش",T.purple]].map(([k,c])=>(
            <div key={k} style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}>
              <span style={{width:14,height:3,background:c,display:"inline-block",borderRadius:2}}/>
              <span style={{color:T.muted}}>{k}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <SH icon="📊" title="معدلات الأداء (٪)"/>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={data} margin={{top:4,right:4,left:-24,bottom:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border}/>
            <XAxis dataKey="date" tick={{fontSize:11,fill:T.muted}} stroke={T.border}/>
            <YAxis domain={[0,100]} tick={{fontSize:10,fill:T.muted}} stroke={T.border}/>
            <Tooltip content={<CT/>}/>
            <Line type="monotone" dataKey="نجاح٪" stroke={T.green}  strokeWidth={2.5} dot={{r:3,fill:T.green}}/>
            <Line type="monotone" dataKey="كاش٪"  stroke={T.purple} strokeWidth={2.5} dot={{r:3,fill:T.purple}}/>
          </LineChart>
        </ResponsiveContainer>
      </Card>
      <Card>
        <SH icon="📅" title="جدول يومي تفصيلي"/>
        <div style={{overflowX:"auto"}}>
          <table>
            <thead>
              <tr style={{borderBottom:`2px solid ${T.border}`}}>
                {["التاريخ","بحث","تحميل","نجاح","فشل","كاش","نجاح٪","كاش٪","مستخدمون","⏱ms"].map(h=>(
                  <th key={h} style={{color:T.muted,fontWeight:500,fontSize:11,paddingBottom:10,whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekly.map((d,i)=>{
                const sr2=d.downloads>0?((d.success/d.downloads)*100).toFixed(1):"0";
                const cr =d.success>0  ?((d.cacheHits/d.success)*100).toFixed(1):"0";
                return (
                  <tr key={i} style={{borderBottom:`1px solid ${T.border}20`}}>
                    <td className="mono" style={{color:T.muted,fontSize:12}}>{d.date}</td>
                    <td className="mono" style={{color:T.blue,  fontWeight:600}}>{d.searches}</td>
                    <td className="mono" style={{color:T.gold,  fontWeight:600}}>{d.downloads}</td>
                    <td className="mono" style={{color:T.green, fontWeight:600}}>{d.success}</td>
                    <td className="mono" style={{color:d.fail>0?T.red:T.muted}}>{d.fail}</td>
                    <td className="mono" style={{color:T.purple,fontWeight:600}}>{d.cacheHits}</td>
                    <td><Tag color={+sr2>=90?T.green:+sr2>=70?T.orange:T.red}>{sr2}٪</Tag></td>
                    <td><Tag color={T.purple}>{cr}٪</Tag></td>
                    <td className="mono" style={{color:T.textMid}}>{d.activeUsers}</td>
                    <td className="mono" style={{color:d.avgMs>6000?T.red:T.green,fontSize:11}}>{d.avgMs}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ── Books ── */
function BooksTab({books}) {
  if (!books?.length) return <Card><Sk h={300}/></Card>;
  const max = books[0]?.count || 1;
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const barData = books.slice(0,8).map(b=>({name:b.title.slice(0,18),طلبات:b.count}));
  return (
    <div className="fade-up" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <Card>
        <SH icon="🏆" title="أكثر الكتب طلباً"/>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {books.slice(0,10).map((b,i)=>{
            const pct=(b.count/max)*100;
            const c=i===0?T.gold:i===1?"#c0c0c0":i===2?"#cd7f32":T.dim;
            return (
              <div key={i}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,fontSize:13}}>
                  <span>{medals[i]} <span style={{color:T.text,fontWeight:i<3?600:400}}>{b.title.slice(0,36)}</span></span>
                  <span className="mono" style={{color:c,fontWeight:700,fontSize:14}}>{b.count}</span>
                </div>
                <div style={{background:T.dim,borderRadius:4,height:5,overflow:"hidden"}}>
                  <div style={{background:`linear-gradient(90deg,${c},${c}99)`,
                    width:`${pct}%`,height:"100%",borderRadius:4,transition:"width .6s ease"}}/>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <Card>
        <SH icon="📊" title="توزيع الطلبات"/>
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={barData} layout="vertical" margin={{top:0,right:30,left:0,bottom:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false}/>
            <XAxis type="number" tick={{fontSize:10,fill:T.muted}} stroke={T.border}/>
            <YAxis dataKey="name" type="category" tick={{fontSize:10,fill:T.textMid}} stroke={T.border} width={80}/>
            <Tooltip content={<CT/>}/>
            <Bar dataKey="طلبات" radius={[0,6,6,0]}>
              {barData.map((_,i)=><Cell key={i} fill={i===0?T.gold:i===1?T.goldMid:i===2?"#b87333":T.dim}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

/* ── Sources ── */
function SourcesTab({sources}) {
  if (!sources?.length) return <Card><Sk h={200}/></Card>;
  return (
    <div className="fade-up" style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card>
        <SH icon="🔌" title="صحة المصادر وأداؤها"/>
        <table>
          <thead>
            <tr style={{borderBottom:`2px solid ${T.border}`}}>
              {["المصدر","✅ نجاح","❌ فشل","النسبة","الشريط","الحالة"].map(h=>(
                <th key={h} style={{color:T.muted,fontWeight:500,fontSize:11,paddingBottom:10}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map((s,i)=>{
              const t=s.ok+s.fail;
              const r=t>0?(s.ok/t)*100:0;
              const c=r>=90?T.green:r>=75?T.orange:T.red;
              return (
                <tr key={i} style={{borderBottom:`1px solid ${T.border}20`}}>
                  <td style={{fontWeight:600}}>{s.domain}</td>
                  <td><span className="mono" style={{color:T.green,fontWeight:700}}>{s.ok}</span></td>
                  <td><span className="mono" style={{color:s.fail>0?T.red:T.muted}}>{s.fail}</span></td>
                  <td><Tag color={c}>{s.rate}</Tag></td>
                  <td style={{width:100}}>
                    <div style={{background:T.dim,borderRadius:4,height:6,overflow:"hidden"}}>
                      <div style={{background:c,width:`${r}%`,height:"100%",borderRadius:4}}/>
                    </div>
                  </td>
                  <td style={{fontSize:12}}>{r>=90?"🟢 ممتاز":r>=75?"🟡 جيد":"🔴 ضعيف"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card>
        <SH icon="🎯" title="توزيع الصحة (Radial)"/>
        <ResponsiveContainer width="100%" height={200}>
          <RadialBarChart innerRadius="25%" outerRadius="90%"
            data={sources.map(s=>({name:s.domain.split(".")[0],
              value:(s.ok+s.fail)>0?Math.round((s.ok/(s.ok+s.fail))*100):0}))}>
            <RadialBar background dataKey="value" cornerRadius={5}>
              {sources.map((s,i)=>{
                const r=(s.ok+s.fail)>0?(s.ok/(s.ok+s.fail))*100:0;
                return <Cell key={i} fill={r>=90?T.green:r>=75?T.orange:T.red}/>;
              })}
            </RadialBar>
            <Tooltip content={<CT/>}/>
          </RadialBarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

/* ── Queue ── */
function QueueTab({queue,dlqJobs,onToast,onRefresh}) {
  const [show,setShow] = useState(false);
  if (!queue) return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
      {Array(4).fill(0).map((_,i)=><Card key={i}><Sk h={80}/></Card>)}
    </div>
  );
  const clearDLQ = async () => {
    if (!confirm("مسح DLQ؟")) return;
    await apiPost("DELETE","queue/dlq");
    onToast("تم مسح DLQ ✅"); onRefresh();
  };
  const clearAll = async () => {
    if (!confirm("⚠️ مسح جميع الطوابير؟")) return;
    await apiPost("DELETE","queue/all");
    onToast("تم مسح الطوابير ✅","warn"); onRefresh();
  };
  return (
    <div className="fade-up" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        {[
          ["⚡ High",     queue.highQueue,        T.green],
          ["📋 Normal",   queue.normalQueue,      T.blue],
          ["💀 DLQ",      queue.dlqSize,          queue.dlqSize>10?T.red:T.muted],
          ["⚙️ Active",   queue.totalActiveJobs,  T.orange],
        ].map(([l,v,c])=>(
          <Card key={l} style={{textAlign:"center"}}>
            <div style={{fontSize:11,color:T.muted,marginBottom:8}}>{l}</div>
            <div className="mono" style={{fontSize:40,fontWeight:800,color:c,lineHeight:1}}>{v}</div>
          </Card>
        ))}
      </div>
      <Card>
        <SH icon="💀" title={`قائمة DLQ — ${dlqJobs?.length||0} مهمة`}
          actions={<>
            <Btn variant="danger" size="sm" onClick={clearDLQ}>🗑️ مسح DLQ</Btn>
            <Btn variant="danger" size="sm" onClick={clearAll}>⚠️ مسح الكل</Btn>
            {!!dlqJobs?.length && (
              <Btn variant="ghost" size="sm" onClick={()=>setShow(p=>!p)}>
                {show?"▲ طيّ":"▼ عرض"}
              </Btn>
            )}
          </>}/>
        {!dlqJobs?.length && (
          <div style={{color:T.green,fontSize:13,display:"flex",alignItems:"center",gap:6}}>
            <Dot/> لا مهام فاشلة
          </div>
        )}
        {show && dlqJobs?.length>0 && (
          <div style={{maxHeight:320,overflowY:"auto",marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
            {dlqJobs.map((j,i)=>(
              <div key={i} style={{padding:"10px 12px",background:T.surface,borderRadius:8,
                border:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",gap:12}}>
                <div>
                  <div style={{fontWeight:600,marginBottom:3}}>📗 {j.bookName}</div>
                  <div style={{color:T.red,fontSize:11}}>❌ {j.failReason}</div>
                </div>
                <div style={{textAlign:"left",fontSize:11,color:T.muted,flexShrink:0}}>
                  <div className="mono">{j.userId}</div>
                  <div>{new Date(j.createdAt).toLocaleTimeString("ar")}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── Users ── */
function UsersTab({premUsers,banUsers,onToast,onRefresh}) {
  const [tab,setTab]   = useState("manage");
  const [uid,setUid]   = useState("");
  const [lim,setLim]   = useState("");
  const SubTab = ({id,label}) => (
    <button onClick={()=>setTab(id)} style={{
      background:tab===id?T.goldDim+"40":"transparent",
      border:`1px solid ${tab===id?T.gold:T.border}`,
      color:tab===id?T.gold:T.muted,
      padding:"6px 16px",borderRadius:8,fontSize:12,fontWeight:tab===id?600:400,
    }}>{label}</button>
  );
  const act = async (type, targetId=uid) => {
    if (!targetId.trim()) { onToast("أدخل User ID أولاً","err"); return; }
    const map = {
      grantPrem:  ()=>apiPost("POST",   `users/${targetId}/premium`,{enable:true}),
      revokePrem: ()=>apiPost("POST",   `users/${targetId}/premium`,{enable:false}),
      ban:        ()=>apiPost("POST",   `users/${targetId}/ban`),
      unban:      ()=>apiPost("DELETE", `users/${targetId}/ban`),
      setLimit:   ()=>apiPost("PUT",    `users/${targetId}/limit`,{limit:+lim}),
      resetLimit: ()=>apiPost("DELETE", `users/${targetId}/limit`),
    };
    await map[type]?.();
    const msgs = {
      grantPrem:"✅ تم منح التميز", revokePrem:"✅ تم إلغاء التميز",
      ban:"🚫 تم الحظر", unban:"✅ تم رفع الحظر",
      setLimit:`✅ تم تحديد الحد: ${lim}`, resetLimit:"✅ تم إعادة التعيين",
    };
    onToast(msgs[type]); onRefresh();
  };
  return (
    <div className="fade-up">
      <Card>
        <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
          <SubTab id="manage"  label="⚙️ إدارة يدوية"/>
          <SubTab id="premium" label={`⭐ مميزون (${premUsers?.length||0})`}/>
          <SubTab id="banned"  label={`🚫 محظورون (${banUsers?.length||0})`}/>
        </div>
        {tab==="manage" && (
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div>
              <div style={{fontSize:11,color:T.muted,marginBottom:6}}>Telegram User ID</div>
              <input value={uid} onChange={e=>setUid(e.target.value)}
                placeholder="مثال: 112233445" style={{direction:"ltr",maxWidth:280}}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <Btn variant="gold"    onClick={()=>act("grantPrem")}>⭐ منح تميز</Btn>
              <Btn variant="ghost"   onClick={()=>act("revokePrem")}>❌ إلغاء تميز</Btn>
              <Btn variant="danger"  onClick={()=>act("ban")}>🚫 حظر</Btn>
              <Btn variant="success" onClick={()=>act("unban")}>✅ رفع حظر</Btn>
            </div>
            <HR/>
            <div style={{fontSize:12,color:T.muted,marginBottom:4}}>الحد اليومي (0 = بلا حد)</div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input value={lim} onChange={e=>setLim(e.target.value)}
                placeholder="عدد الكتب يومياً" style={{direction:"ltr",maxWidth:240}}/>
              <Btn variant="gold"  onClick={()=>act("setLimit")}>💾 حفظ</Btn>
              <Btn variant="ghost" onClick={()=>act("resetLimit")}>♻️ إعادة</Btn>
            </div>
          </div>
        )}
        {tab==="premium" && (
          <div style={{maxHeight:360,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            {!(premUsers?.length) && <div style={{color:T.muted}}>لا يوجد مميزون</div>}
            {(premUsers||[]).map((id,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"10px 12px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
                <span>⭐ <span className="mono" style={{color:T.gold}}>{id}</span></span>
                <Btn variant="danger" size="sm" onClick={()=>act("revokePrem",id)}>إلغاء التميز</Btn>
              </div>
            ))}
          </div>
        )}
        {tab==="banned" && (
          <div style={{maxHeight:360,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            {!(banUsers?.length) && <div style={{color:T.muted}}>لا يوجد محظورون</div>}
            {(banUsers||[]).map((id,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"10px 12px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
                <span>🚫 <span className="mono" style={{color:T.red}}>{id}</span></span>
                <Btn variant="success" size="sm" onClick={()=>act("unban",id)}>رفع الحظر</Btn>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── System ── */
function SystemTab({system,maintenance,onToggleMaint,onClearBL}) {
  if (!system) return <Card><Sk h={300}/></Card>;
  return (
    <div className="fade-up" style={{display:"flex",flexDirection:"column",gap:16}}>
      {maintenance && (
        <div style={{background:T.redDim,border:`1px solid ${T.red}55`,
          borderRadius:12,padding:"12px 18px",color:T.red,fontWeight:600,fontSize:13,
          display:"flex",alignItems:"center",gap:8}}>
          🔴 وضع الصيانة مفعّل — البوت معطّل
        </div>
      )}
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        <Btn variant={maintenance?"success":"danger"} onClick={onToggleMaint}>
          {maintenance?"✅ إيقاف الصيانة":"🔧 تفعيل الصيانة"}
        </Btn>
        <Btn variant="ghost" onClick={onClearBL}>🧹 مسح Blacklist</Btn>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
        {[
          ["Node.js",    system.nodeVersion,                     T.green],
          ["PID",        system.pid,                              T.muted],
          ["Heap Used",  `${system.memory.heapUsed} MB`,          T.blue],
          ["Heap Total", `${system.memory.heapTotal} MB`,         T.muted],
          ["RSS",        `${system.memory.rss} MB`,               T.muted],
          ["Workers",    system.workers,                          T.gold],
          ["Redis",      system.redis?"🟢 متصل":"🔴 منقطع",      system.redis?T.green:T.red],
          ["Uptime",     system.uptimeHuman,                      T.green],
        ].map(([l,v,c])=>(
          <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"10px 14px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
            <span style={{color:T.muted,fontSize:12}}>{l}</span>
            <span className="mono" style={{color:c,fontWeight:700,fontSize:13}}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Settings ── */
function SettingsTab({isMock,onSave}) {
  const [base,setBase] = useState(CONFIG.API_BASE||"");
  const [adminId,]     = useState(CONFIG.ADMIN_ID);
  return (
    <div className="fade-up">
      <Card>
        <SH icon="⚙️" title="إعدادات الاتصال بالـ API"/>
        <div style={{display:"flex",flexDirection:"column",gap:20}}>

          {/* حالة الاتصال */}
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",
            background:T.surface,borderRadius:10,border:`1px solid ${T.border}`}}>
            <span style={{fontSize:13,fontWeight:600,flex:1}}>حالة الاتصال الحالية</span>
            <ApiBadge isMock={isMock}/>
          </div>

          {/* Admin ID */}
          <div>
            <div style={{fontSize:11,color:T.muted,marginBottom:6}}>
              Telegram Admin ID (Bearer Token للـ API)
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <input value={adminId} readOnly style={{direction:"ltr",maxWidth:280,opacity:.7}}/>
              <Tag color={T.green}>✅ مضبوط</Tag>
            </div>
          </div>

          {/* Base URL */}
          <div>
            <div style={{fontSize:11,color:T.muted,marginBottom:6}}>
              عنوان السيرفر (API Base URL)
            </div>
            <div style={{display:"flex",gap:8}}>
              <input value={base} onChange={e=>setBase(e.target.value)}
                placeholder="https://your-server.replit.app  أو فارغ = نفس الـ origin"
                style={{direction:"ltr"}}/>
              <Btn variant="gold" onClick={()=>onSave(base)}>💾 حفظ وتجربة</Btn>
            </div>
            <div style={{fontSize:11,color:T.muted,marginTop:6,lineHeight:1.7}}>
              {base
                ? <>ستتصل بـ: <span className="mono" style={{color:T.blue}}>{base}/api/admin/...</span></>
                : "فارغ = يستخدم نفس domain اللوحة  →  /api/admin/..."}
            </div>
          </div>

          {/* وضع Mock */}
          <div style={{padding:"14px 16px",background:T.surface,borderRadius:10,
            border:`1px solid ${isMock?T.orange:T.green}44`}}>
            <div style={{fontWeight:600,marginBottom:8,color:isMock?T.orange:T.green,fontSize:13}}>
              {isMock?"🟡 وضع البيانات التجريبية (Mock)":"🟢 متصل بالـ API الحقيقية"}
            </div>
            <div style={{fontSize:12,color:T.muted,lineHeight:1.8}}>
              {isMock
                ? <>اللوحة تعمل ببيانات <b style={{color:T.orange}}>تجريبية</b>. لتفعيل البيانات الحقيقية، أدخل عنوان السيرفر أعلاه واضغط "حفظ وتجربة".</>
                : <>اللوحة متصلة بالـ API وتجلب <b style={{color:T.green}}>بيانات حية</b> من السيرفر.</>}
            </div>
          </div>

          {/* Endpoints reference */}
          <div>
            <div style={{fontSize:12,color:T.muted,marginBottom:8,fontWeight:600}}>📋 الـ Endpoints</div>
            <div style={{background:T.surface,borderRadius:8,padding:"12px 14px",
              fontFamily:"'IBM Plex Mono',monospace",fontSize:11,direction:"ltr",
              color:T.muted,lineHeight:2,border:`1px solid ${T.border}`}}>
              {[
                ["GET",    "/api/admin/overview",          "كل شيء في استدعاء واحد"],
                ["GET",    "/api/admin/stats/weekly",      "آخر 7 أيام"],
                ["GET",    "/api/admin/stats/top-books",   "أكثر الكتب طلباً"],
                ["GET",    "/api/admin/stats/sources",     "صحة المصادر"],
                ["GET",    "/api/admin/queue",             "حالة الطابور"],
                ["GET",    "/api/admin/queue/dlq",         "قائمة المهام الفاشلة"],
                ["DELETE", "/api/admin/queue/dlq",         "مسح DLQ"],
                ["DELETE", "/api/admin/queue/all",         "مسح الطوابير كلها"],
                ["GET",    "/api/admin/users/premium",     "قائمة المميزين"],
                ["GET",    "/api/admin/users/banned",      "قائمة المحظورين"],
                ["POST",   "/api/admin/users/:id/ban",     "حظر مستخدم"],
                ["DELETE", "/api/admin/users/:id/ban",     "رفع الحظر"],
                ["POST",   "/api/admin/users/:id/premium", "منح/إلغاء تميز"],
                ["PUT",    "/api/admin/users/:id/limit",   "تحديد الحد اليومي"],
                ["DELETE", "/api/admin/users/:id/limit",   "إعادة تعيين الحد"],
                ["GET",    "/api/admin/maintenance",       "حالة الصيانة"],
                ["PUT",    "/api/admin/maintenance",       "تفعيل/إيقاف الصيانة"],
                ["DELETE", "/api/admin/blacklist",         "مسح Blacklist"],
                ["GET",    "/api/admin/system",            "بيانات النظام"],
              ].map(([m,p,d],i)=>(
                <div key={i} style={{display:"flex",gap:16}}>
                  <span style={{minWidth:52,color:m==="GET"?T.green:m==="DELETE"?T.red:T.blue,fontWeight:700}}>{m}</span>
                  <span style={{color:T.gold,flex:1}}>{p}</span>
                  <span style={{color:T.dim}}># {d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   🏠  APP ROOT
   ═══════════════════════════════════════════════════════════════ */
const TABS = [
  {id:"overview",  icon:"🏠",label:"نظرة عامة"},
  {id:"analytics", icon:"📊",label:"التحليلات"},
  {id:"books",     icon:"📚",label:"الكتب"},
  {id:"sources",   icon:"🔌",label:"المصادر"},
  {id:"queue",     icon:"🔄",label:"الطابور"},
  {id:"users",     icon:"👥",label:"المستخدمون"},
  {id:"system",    icon:"💻",label:"النظام"},
  {id:"settings",  icon:"⚙️",label:"الإعدادات"},
];

export default function App() {
  const [tab,       setTab]       = useState("overview");
  const [ov,        setOv]        = useState(null);
  const [books,     setBooks]     = useState([]);
  const [sources,   setSources]   = useState([]);
  const [dlq,       setDlq]       = useState([]);
  const [prem,      setPrem]      = useState([]);
  const [banned,    setBanned]    = useState([]);
  const [ts,        setTs]        = useState(Date.now());
  const [toast,     setToast]     = useState(null);
  const [sidebar,   setSidebar]   = useState(true);
  const [isMock,    setIsMock]    = useState(CONFIG.USE_MOCK !== "never");
  const [ago,       setAgo]       = useState("الآن");

  const showToast = (msg,type="ok") => setToast({msg,type});

  const loadAll = useCallback(async () => {
    const [r1,r2,r3,r4,r5,r6] = await Promise.allSettled([
      loadOverview(), loadTopBooks(), loadSources(),
      loadDLQ(), loadPremium(), loadBanned(),
    ]);
    if (r1.status==="fulfilled") setOv(r1.value);
    if (r2.status==="fulfilled") setBooks(r2.value);
    if (r3.status==="fulfilled") setSources(r3.value);
    if (r4.status==="fulfilled") setDlq(r4.value);
    if (r5.status==="fulfilled") setPrem(r5.value);
    if (r6.status==="fulfilled") setBanned(r6.value);
    setIsMock(_mode === "always");
    setTs(Date.now());
  }, []);

  useEffect(()=>{
    loadAll();
    const t = setInterval(loadAll, CONFIG.REFRESH_MS);
    return () => clearInterval(t);
  }, [loadAll]);

  useEffect(()=>{
    const t = setInterval(()=>{
      const s = Math.floor((Date.now()-ts)/1000);
      setAgo(s<5?"الآن":s<60?`${s}ث`:`${Math.floor(s/60)}د`);
    }, 1000);
    return () => clearInterval(t);
  }, [ts]);

  const maintenance = ov?.system?.maintenance;

  const handleToggleMaint = async () => {
    await apiPost("PUT","maintenance",{active:!maintenance});
    showToast(maintenance?"✅ تم إيقاف الصيانة":"🔴 الصيانة مفعّلة", maintenance?"ok":"warn");
    loadAll();
  };
  const handleClearBL = async () => {
    if (!confirm("مسح Blacklist؟")) return;
    await apiPost("DELETE","blacklist");
    showToast("تم مسح Blacklist ✅");
    loadAll();
  };
  const handleSaveApiBase = (base) => {
    CONFIG.API_BASE = base.trim();
    _mode = CONFIG.USE_MOCK === "always" ? "always" : "auto";
    setIsMock(true);
    showToast("جارٍ الاتصال بالـ API...");
    setTimeout(loadAll, 300);
  };

  return (
    <div style={{display:"flex",minHeight:"100vh",background:T.bg}}>

      {/* ── SIDEBAR ── */}
      <div style={{width:sidebar?220:62,background:T.surface,
        borderLeft:`1px solid ${T.border}`,display:"flex",flexDirection:"column",
        transition:"width .25s cubic-bezier(.4,0,.2,1)",overflow:"hidden",
        flexShrink:0,position:"sticky",top:0,height:"100vh"}}>

        {/* Logo */}
        <div style={{padding:"18px 14px",borderBottom:`1px solid ${T.border}`,
          display:"flex",alignItems:"center",gap:10,overflow:"hidden"}}>
          <div className="glow" style={{width:38,height:38,borderRadius:10,flexShrink:0,
            background:`linear-gradient(135deg,${T.goldDim},${T.gold})`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📚</div>
          {sidebar && (
            <div style={{overflow:"hidden",lineHeight:1.3}}>
              <div style={{color:T.gold,fontWeight:800,fontSize:13,whiteSpace:"nowrap"}}>خلاصة الكتب</div>
              <div style={{color:T.muted,fontSize:10,whiteSpace:"nowrap"}}>لوحة الإدارة</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{flex:1,padding:"10px 8px",display:"flex",flexDirection:"column",
          gap:2,overflowY:"auto"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              background:tab===t.id?T.goldDim+"30":"transparent",
              border:`1px solid ${tab===t.id?T.gold+"55":"transparent"}`,
              color:tab===t.id?T.gold:T.muted,
              padding:"9px 10px",borderRadius:9,display:"flex",alignItems:"center",
              gap:9,transition:"all .15s",textAlign:"right",width:"100%",
            }}>
              <span style={{fontSize:17,flexShrink:0}}>{t.icon}</span>
              {sidebar && <span style={{fontSize:13,fontWeight:tab===t.id?600:400,whiteSpace:"nowrap"}}>{t.label}</span>}
            </button>
          ))}
        </nav>

        <button onClick={()=>setSidebar(p=>!p)}
          style={{background:"transparent",border:"none",color:T.muted,
            padding:14,borderTop:`1px solid ${T.border}`,fontSize:14}}>
          {sidebar?"◀":"▶"}
        </button>
      </div>

      {/* ── MAIN ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

        {/* Topbar */}
        <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,
          padding:"0 20px",height:56,display:"flex",alignItems:"center",
          justifyContent:"space-between",flexShrink:0,position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:17,fontWeight:800}}>
              {TABS.find(t=>t.id===tab)?.icon} {TABS.find(t=>t.id===tab)?.label}
            </span>
            {maintenance && <Tag color={T.red}>🔴 صيانة</Tag>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <ApiBadge isMock={isMock}/>
            <div style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:T.muted}}>
              <Dot/>{ago}
            </div>
            <Btn variant="gold" size="sm" onClick={loadAll}>🔄</Btn>
            <div style={{background:T.goldDim+"30",border:`1px solid ${T.goldDim}`,
              color:T.gold,padding:"4px 10px",borderRadius:8,fontSize:11,fontWeight:600}}>
              🛡️ أدمن
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{flex:1,overflowY:"auto",padding:"22px 18px"}}>
          {tab==="overview"  && <OverviewTab  ov={ov}/>}
          {tab==="analytics" && <AnalyticsTab weekly={ov?.weekly||[]}/>}
          {tab==="books"     && <BooksTab     books={books}/>}
          {tab==="sources"   && <SourcesTab   sources={sources}/>}
          {tab==="queue"     && <QueueTab     queue={ov?.queue} dlqJobs={dlq} onToast={showToast} onRefresh={loadAll}/>}
          {tab==="users"     && <UsersTab     premUsers={prem} banUsers={banned} onToast={showToast} onRefresh={loadAll}/>}
          {tab==="system"    && <SystemTab    system={ov?.system} maintenance={maintenance}
                                  onToggleMaint={handleToggleMaint} onClearBL={handleClearBL}/>}
          {tab==="settings"  && <SettingsTab  isMock={isMock} onSave={handleSaveApiBase}/>}
        </div>
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
    </div>
  );
}
