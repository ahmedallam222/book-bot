import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, RadialBarChart, RadialBar, ScatterChart, Scatter,
} from "recharts";

/* ═══════════════════════════════════════════════════════════════
   PERSIST
═══════════════════════════════════════════════════════════════ */
const SK="kholasa_v3";
const P={
  get:(k,fb)=>{try{return JSON.parse(localStorage.getItem(SK)||"{}")[k]??fb;}catch{return fb;}},
  set:(k,v)=>{try{const d=JSON.parse(localStorage.getItem(SK)||"{}");d[k]=v;localStorage.setItem(SK,JSON.stringify(d));}catch{}},
};

/* ═══════════════════════════════════════════════════════════════
   THEMES  (4 themes)
═══════════════════════════════════════════════════════════════ */
const THEMES={
  obsidian:{
    name:"🌑 Obsidian",
    bg:"#04060c",surf:"#080e1a",card:"#0c1422",cardH:"#111d30",
    border:"#182540",borderH:"#223660",
    gold:"#f0b429",goldD:"#5c3f00",goldDim:"rgba(240,180,41,0.07)",
    green:"#10d96e",greenD:"#083320",red:"#f04060",redD:"#380c18",
    blue:"#3d8eff",blueD:"#0c2248",purple:"#9d6fff",purpleD:"#1e0f4a",
    orange:"#ff7c2a",cyan:"#00d4d0",teal:"#00bba0",pink:"#ff3d8a",
    text:"#dce8f8",textM:"#6a88a8",muted:"#344a62",dim:"#121e30",
  },
  aurora:{
    name:"🌌 Aurora",
    bg:"#020408",surf:"#060b12",card:"#091018",cardH:"#0d1520",
    border:"#122030",borderH:"#1a3048",
    gold:"#ffdd57",goldD:"#5a4500",goldDim:"rgba(255,221,87,0.07)",
    green:"#00e5a0",greenD:"#003d28",red:"#ff4466",redD:"#400c18",
    blue:"#44aaff",blueD:"#0a2040",purple:"#cc88ff",purpleD:"#200f50",
    orange:"#ff9933",cyan:"#00ffee",teal:"#00ddcc",pink:"#ff44cc",
    text:"#e8f4ff",textM:"#5a7a98",muted:"#2a4060",dim:"#0e1824",
  },
  slate:{
    name:"🪨 Slate",
    bg:"#0f1318",surf:"#151b22",card:"#1a2230",cardH:"#1f2a3a",
    border:"#253040",borderH:"#304060",
    gold:"#e8a020",goldD:"#483200",goldDim:"rgba(232,160,32,0.08)",
    green:"#24c464",greenD:"#0a2c18",red:"#e84040",redD:"#300c0c",
    blue:"#4488ee",blueD:"#102040",purple:"#9966ee",purpleD:"#1c1040",
    orange:"#e87020",cyan:"#20cccc",teal:"#20b090",pink:"#e0409a",
    text:"#d4dfe8",textM:"#607888",muted:"#3a4e60",dim:"#1a2230",
  },
  crimson:{
    name:"🩸 Crimson",
    bg:"#080608",surf:"#100a0e",card:"#180e14",cardH:"#20121a",
    border:"#2a1828",borderH:"#3a2238",
    gold:"#ff9933",goldD:"#4a2800",goldDim:"rgba(255,153,51,0.07)",
    green:"#22dd66",greenD:"#0a2e18",red:"#ff3355",redD:"#3a0c14",
    blue:"#4499ff",blueD:"#0c2240",purple:"#cc55ff",purpleD:"#220c40",
    orange:"#ff6622",cyan:"#22ddcc",teal:"#22ccaa",pink:"#ff2288",
    text:"#f0e0e8",textM:"#806070",muted:"#4a3040",dim:"#140c10",
  },
};

/* ═══════════════════════════════════════════════════════════════
   CFG
═══════════════════════════════════════════════════════════════ */
const CFG={
  ADMIN_ID: P.get("adminId","5469997406"),
  API_BASE: P.get("apiBase",""),
  USE_MOCK: "never",
};

/* ═══════════════════════════════════════════════════════════════
   MOCK DATA
═══════════════════════════════════════════════════════════════ */
const now=Date.now();
const M={
  today:{searches:847,downloads:621,success:574,fail:47,cacheHits:198,avgMs:3840,activeUsers:312,newUsers:28},
  yesterday:{searches:720,downloads:540,success:498,fail:42,cacheHits:171,avgMs:4020,activeUsers:278,newUsers:21},
  total:{totalSearches:48291,totalDownloads:34872,totalUsers:2847},
  queue:{highQueue:2,normalQueue:11,dlqSize:3,totalActiveJobs:13},
  premium:{count:47},banned:{count:8},
  blacklist:{total:234,active:189},
  system:{uptimeHuman:"5ي 12س 34د",maintenance:false,redis:true,
    memory:{heapUsed:142,heapTotal:256,rss:310},workers:5,
    nodeVersion:"v20.11.0",pid:1337,cpuUsage:23},
  weekly:[
    {date:"02-28",searches:620,downloads:441,success:398,fail:43,cacheHits:112,activeUsers:201,avgMs:4200,newUsers:18},
    {date:"03-01",searches:710,downloads:523,success:489,fail:34,cacheHits:154,activeUsers:267,avgMs:3900,newUsers:24},
    {date:"03-02",searches:530,downloads:389,success:351,fail:38,cacheHits:98, activeUsers:178,avgMs:4100,newUsers:14},
    {date:"03-03",searches:890,downloads:671,success:623,fail:48,cacheHits:201,activeUsers:341,avgMs:3600,newUsers:31},
    {date:"03-04",searches:780,downloads:590,success:552,fail:38,cacheHits:175,activeUsers:298,avgMs:3750,newUsers:27},
    {date:"03-05",searches:910,downloads:688,success:641,fail:47,cacheHits:212,activeUsers:365,avgMs:3500,newUsers:33},
    {date:"03-06",searches:847,downloads:621,success:574,fail:47,cacheHits:198,activeUsers:312,avgMs:3840,newUsers:28},
  ],
  topBooks:[
    {title:"أرض زيكولا",count:89,author:"أحمد خيري العمري"},{title:"الأمير الصغير",count:76,author:"سان تيكزوبيري"},
    {title:"عزازيل",count:71,author:"يوسف زيدان"},{title:"زقاق المدق",count:68,author:"نجيب محفوظ"},
    {title:"قواعد العشق الأربعون",count:52,author:"إليف شافاق"},{title:"فرانكنشتاين في بغداد",count:47,author:"أحمد سعداوي"},
    {title:"مائة عام من العزلة",count:43,author:"ماركيز"},{title:"العادات الذرية",count:38,author:"جيمس كلير"},
    {title:"الخيميائي",count:35,author:"باولو كويلو"},{title:"أنا كافكا",count:31,author:"فرانز كافكا"},
  ],
  sources:[
    {domain:"noor-book.com",ok:187,fail:9,enabled:true,type:"ar"},
    {domain:"foulabook.com",ok:143,fail:21,enabled:true,type:"ar"},
    {domain:"hindawi.org",ok:112,fail:18,enabled:true,type:"ar"},
    {domain:"kutubm.com",ok:98,fail:34,enabled:true,type:"ar"},
    {domain:"kolalkotob.com",ok:76,fail:12,enabled:true,type:"ar"},
    {domain:"kutubypdf.com",ok:65,fail:8,enabled:true,type:"ar"},
    {domain:"kotobati.com",ok:54,fail:28,enabled:false,type:"ar"},
    {domain:"yasmeenlibrary.com",ok:48,fail:11,enabled:true,type:"ar"},
    {domain:"kutub.info",ok:42,fail:19,enabled:true,type:"ar"},
    {domain:"books-library.net",ok:38,fail:7,enabled:true,type:"ar"},
    {domain:"pdfdrive.com",ok:31,fail:14,enabled:true,type:"intl"},
    {domain:"z-lib.org",ok:24,fail:8,enabled:true,type:"intl"},
    {domain:"annas-archive.org",ok:18,fail:5,enabled:true,type:"intl"},
  ],
  dlqJobs:[
    {id:"j001",bookName:"كتاب النجاح",userId:"112233445",failReason:"PDF download timeout 30s",createdAt:now-120000},
    {id:"j002",bookName:"مختصر المفيد",userId:"998877665",failReason:"All sources returned 404",createdAt:now-300000},
    {id:"j003",bookName:"مقدمة ابن خلدون",userId:"554433221",failReason:"File size exceeded 50MB",createdAt:now-600000},
    {id:"j004",bookName:"رسالة المغفرة",userId:"112299334",failReason:"PDF magic bytes invalid",createdAt:now-900000},
  ],
  premiumUsers:["112233445","998877665","443322110","556677889","334455667"],
  bannedUsers:["909090909","111222333"],
  telemetry:{
    funnel:{searched:847,results_found:621,pdf_attempted:574,pdf_validated:521,sent:509},
    pdfValidation:{total:574,accepted:521,rejected:53,mistral_used:67,meaningless_filename:12,no_metadata:23,score_too_low:18},
    traces:[
      {id:"t001",bookName:"أرض زيكولا",userId:"112233",ms:2340,status:"sent",source:"foulabook.com",cached:false,ts:now-60000},
      {id:"t002",bookName:"الأمير الصغير",userId:"998877",ms:890,status:"cached",source:"cache",cached:true,ts:now-120000},
      {id:"t003",bookName:"عزازيل",userId:"443322",ms:4120,status:"sent",source:"noor-book.com",cached:false,ts:now-180000},
      {id:"t004",bookName:"كتاب غير موجود",userId:"556677",ms:8900,status:"failed",source:"all",cached:false,ts:now-240000},
      {id:"t005",bookName:"مئة عام من العزلة",userId:"112299",ms:1240,status:"cached",source:"cache",cached:true,ts:now-300000},
      {id:"t006",bookName:"العادات الذرية",userId:"334455",ms:3780,status:"sent",source:"kutubypdf.com",cached:false,ts:now-360000},
      {id:"t007",bookName:"الخيميائي",userId:"667788",ms:2100,status:"sent",source:"noor-book.com",cached:false,ts:now-420000},
      {id:"t008",bookName:"زقاق المدق",userId:"889900",ms:650,status:"cached",source:"cache",cached:true,ts:now-480000},
    ],
  },
  randomGenres:[
    {genre:"novel",label:"رواية وقصة",count:342},
    {genre:"selfhelp",label:"تطوير الذات",count:187},
    {genre:"history",label:"التاريخ",count:156},
    {genre:"psychology",label:"علم النفس",count:134},
    {genre:"science",label:"العلوم",count:112},
    {genre:"philosophy",label:"الفلسفة",count:89},
    {genre:"business",label:"الأعمال",count:78},
    {genre:"religion",label:"الدين",count:67},
    {genre:"children",label:"أطفال",count:45},
    {genre:"travel",label:"الرحلات",count:38},
  ],
  activity:[
    {type:"download",text:"تحميل: أرض زيكولا",time:"2د",icon:"📥",color:"green"},
    {type:"search",text:"بحث: العادات الذرية",time:"3د",icon:"🔍",color:"blue"},
    {type:"fail",text:"فشل: كتاب غير موجود",time:"5د",icon:"❌",color:"red"},
    {type:"cache",text:"كاش: الأمير الصغير",time:"7د",icon:"⚡",color:"purple"},
    {type:"newuser",text:"مستخدم جديد #334455",time:"9د",icon:"👤",color:"cyan"},
    {type:"download",text:"تحميل: مئة عام من العزلة",time:"11د",icon:"📥",color:"green"},
    {type:"premium",text:"تميز ممنوح #445566",time:"15د",icon:"⭐",color:"gold"},
    {type:"cache",text:"كاش: عزازيل",time:"18د",icon:"⚡",color:"purple"},
    {type:"download",text:"تحميل: الخيميائي",time:"22د",icon:"📥",color:"green"},
    {type:"search",text:"بحث: فرانكنشتاين في بغداد",time:"25د",icon:"🔍",color:"blue"},
  ],
  hourly:[
    {h:"00",v:12},{h:"01",v:8},{h:"02",v:5},{h:"03",v:3},{h:"04",v:4},{h:"05",v:9},
    {h:"06",v:22},{h:"07",v:45},{h:"08",v:78},{h:"09",v:98},{h:"10",v:112},{h:"11",v:134},
    {h:"12",v:145},{h:"13",v:138},{h:"14",v:122},{h:"15",v:110},{h:"16",v:98},{h:"17",v:87},
    {h:"18",v:95},{h:"19",v:108},{h:"20",v:118},{h:"21",v:95},{h:"22",v:67},{h:"23",v:38},
  ],
  heatmap:{
    days:["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"],
    hours:["0","3","6","9","12","15","18","21"],
    data:[
      [12,8,5,3,22,45,98,67],[15,6,4,7,34,67,112,89],[18,9,6,5,45,78,134,102],
      [22,11,8,9,56,89,145,120],[25,14,10,12,67,98,138,115],[18,10,7,8,52,84,122,98],
      [10,6,4,3,28,52,95,72],
    ],
  },
  errors:[
    {time:new Date(now-300000).toLocaleTimeString("ar"),level:"WARN",msg:"Source noor-book.com returned 403",ctx:"engine.ts:247"},
    {time:new Date(now-600000).toLocaleTimeString("ar"),level:"ERROR",msg:"PDF magic bytes check failed for foulabook.com",ctx:"pdfValidator.ts:428"},
    {time:new Date(now-900000).toLocaleTimeString("ar"),level:"WARN",msg:"Firecrawl rate limit approaching (80%)",ctx:"engine.ts:89"},
    {time:new Date(now-1200000).toLocaleTimeString("ar"),level:"INFO",msg:"Cache hit: أرض زيكولا — saved 4.2s",ctx:"bookRequest.ts:216"},
    {time:new Date(now-1500000).toLocaleTimeString("ar"),level:"ERROR",msg:"DLQ job failed 3x: كتاب النجاح",ctx:"queue.ts:334"},
    {time:new Date(now-1800000).toLocaleTimeString("ar"),level:"INFO",msg:"Redis FLUSHDB triggered by admin",ctx:"routes.ts:219"},
    {time:new Date(now-2100000).toLocaleTimeString("ar"),level:"WARN",msg:"User 909090909 hit daily limit",ctx:"bookRequest.ts:112"},
    {time:new Date(now-2400000).toLocaleTimeString("ar"),level:"INFO",msg:"Bot restarted — 5 workers online",ctx:"index.ts:44"},
  ],
  healthScore:{
    overall:87,
    components:[
      {name:"نجاح البحث",score:92,color:"green"},
      {name:"سرعة الاستجابة",score:84,color:"blue"},
      {name:"جودة PDF",score:91,color:"purple"},
      {name:"صحة المصادر",score:78,color:"orange"},
      {name:"Redis / Cache",score:96,color:"cyan"},
      {name:"استقرار الطابور",score:88,color:"teal"},
    ],
  },
};

/* ═══════════════════════════════════════════════════════════════
   API
═══════════════════════════════════════════════════════════════ */
let _mode=CFG.USE_MOCK;
async function apiFetch(path,opts={}){
  if(_mode==="always") return null;
  const base=CFG.API_BASE.trim()||window.location.origin;
  try{
    const r=await fetch(`${base}/api/admin/${path}`,{...opts,
      headers:{"Authorization":`Bearer ${CFG.ADMIN_ID}`,"Content-Type":"application/json",...(opts.headers||{})},
    });
    if(!r.ok) throw new Error(`${r.status}`);
    const j=await r.json(); if(_mode==="auto") _mode="never"; return j.data??j;
  }catch{if(_mode==="never") return null; _mode="always"; return null;}
}
const apiM=(method,path,body)=>apiFetch(path,{method,body:body?JSON.stringify(body):undefined});

/* ═══════════════════════════════════════════════════════════════
   CSS
═══════════════════════════════════════════════════════════════ */
function injectCSS(C){
  let s=document.getElementById("_kd3");
  if(!s){s=document.createElement("style");s.id="_kd3";document.head.appendChild(s);}
  s.textContent=`
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Cairo:wght@300;400;500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background:${C.bg};color:${C.text};font-family:'Cairo',sans-serif;direction:rtl;-webkit-font-smoothing:antialiased;overflow-x:hidden}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:${C.borderH}}
.mono{font-family:'IBM Plex Mono',monospace!important;direction:ltr;display:inline-block}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideInRight{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideInLeft{from{transform:translateX(-100%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideDown{from{opacity:0;max-height:0;transform:translateY(-8px)}to{opacity:1;max-height:1000px;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes glow{0%,100%{box-shadow:0 0 8px ${C.gold}40}50%{box-shadow:0 0 28px ${C.gold}80}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{background-position:-800px 0}100%{background-position:800px 0}}
@keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
@keyframes blink{0%,100%{opacity:1}49%{opacity:1}50%{opacity:0}99%{opacity:0}}
@keyframes growBar{from{width:0}to{width:var(--w)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
.fu{animation:fadeUp .32s cubic-bezier(.22,1,.36,1) forwards}
.fi{animation:fadeIn .25s ease forwards}
.pulse{animation:pulse 2.2s ease-in-out infinite}
.glow{animation:glow 2.5s ease-in-out infinite}
.spin{animation:spin .75s linear infinite;display:inline-block}
.blink{animation:blink 1s step-end infinite}
.float{animation:float 3s ease-in-out infinite}
.shimmer{background:linear-gradient(90deg,${C.dim} 25%,${C.borderH} 50%,${C.dim} 75%);background-size:800px;animation:shimmer 1.6s infinite}
.hov{transition:all .18s cubic-bezier(.4,0,.2,1)}
.hov:hover{transform:translateY(-2px);filter:brightness(1.08)}
input,select,textarea{background:${C.surf};border:1.5px solid ${C.border};border-radius:10px;color:${C.text};padding:9px 14px;font-family:'Cairo',sans-serif;font-size:13px;outline:none;width:100%;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:${C.gold}80;box-shadow:0 0 0 3px ${C.gold}0d}
button{cursor:pointer;font-family:'Cairo',sans-serif;transition:all .16s cubic-bezier(.4,0,.2,1);border:none;outline:none}
button:active{transform:scale(.97)!important}
table{border-collapse:collapse;width:100%}
th{padding:10px 14px;text-align:right;font-size:10px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.6px;border-bottom:1.5px solid ${C.border};white-space:nowrap;user-select:none}
td{padding:10px 14px;text-align:right;white-space:nowrap}
tbody tr{border-bottom:1px solid ${C.border}14;transition:background .1s}
tbody tr:hover td{background:${C.surf}80}
th.sortable{cursor:pointer}
th.sortable:hover{color:${C.gold}}
@media(max-width:900px){.hm{display:none!important}}
@media(max-width:768px){
  .sm-col{flex-direction:column!important}
  .sm-full{width:100%!important;grid-column:1/-1!important}
  td,th{padding:8px 10px;font-size:11px}
}
  `;
}

/* ═══════════════════════════════════════════════════════════════
   ATOMS
═══════════════════════════════════════════════════════════════ */
function Card({children,style={},glow=false,onClick,accent}){
  const C=window.__C;
  return(
    <div className="hov" onClick={onClick}
      style={{background:C.card,border:`1px solid ${accent||C.border}`,borderRadius:16,
        padding:18,position:"relative",overflow:"hidden",
        boxShadow:glow?`0 0 30px ${C.gold}14,inset 0 1px 0 ${C.gold}12`:`0 2px 24px rgba(0,0,0,.35)`,
        cursor:onClick?"pointer":"default",transition:"all .2s cubic-bezier(.4,0,.2,1)",...style}}>
      {accent&&<div style={{position:"absolute",top:0,right:0,width:2.5,height:"100%",
        background:`linear-gradient(180deg,${accent},${accent}00)`,borderRadius:"0 16px 16px 0"}}/>}
      {children}
    </div>
  );
}

function Tag({children,color,size=11,dot=false,pill=false}){
  const C=window.__C; const c=color||C.gold;
  return(
    <span style={{background:`${c}14`,color:c,border:`1px solid ${c}28`,
      padding:pill?"3px 12px":"2px 9px",borderRadius:pill?20:6,
      fontSize:size,fontWeight:700,display:"inline-flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}>
      {dot&&<span className="pulse" style={{width:6,height:6,borderRadius:"50%",background:c,flexShrink:0}}/>}
      {children}
    </span>
  );
}

function Btn({children,onClick,v="ghost",sz="md",disabled=false,loading=false,full=false,icon}){
  const C=window.__C;
  const pads={xs:"3px 9px",sm:"6px 13px",md:"8px 18px",lg:"11px 26px"};
  const fnts={xs:10,sm:11,md:13,lg:14};
  const vv={
    ghost:{bg:"transparent",b:C.border,c:C.textM},
    gold:{bg:`${C.gold}10`,b:`${C.gold}35`,c:C.gold},
    solid:{bg:C.gold,b:C.gold,c:C.bg},
    danger:{bg:`${C.red}10`,b:`${C.red}30`,c:C.red},
    success:{bg:`${C.green}10`,b:`${C.green}30`,c:C.green},
    blue:{bg:`${C.blue}10`,b:`${C.blue}30`,c:C.blue},
    purple:{bg:`${C.purple}10`,b:`${C.purple}30`,c:C.purple},
    surf:{bg:C.surf,b:C.border,c:C.textM},
  }[v]||{bg:"transparent",b:C.border,c:C.textM};
  return(
    <button onClick={onClick} disabled={disabled||loading}
      style={{background:vv.bg,border:`1.5px solid ${vv.b}`,color:vv.c,
        padding:pads[sz]||pads.md,borderRadius:10,fontSize:fnts[sz]||13,
        display:"inline-flex",alignItems:"center",gap:6,
        opacity:(disabled||loading)?.4:1,fontWeight:700,whiteSpace:"nowrap",
        width:full?"100%":undefined,justifyContent:full?"center":undefined}}>
      {loading?<span className="spin">⟳</span>:icon&&<span>{icon}</span>}
      {children}
    </button>
  );
}

const Dot=({color,size=8,anim=true})=>{const C=window.__C;const c=color||C.green;return <span className={anim?"pulse":""} style={{display:"inline-block",width:size,height:size,borderRadius:"50%",background:c,flexShrink:0}}/>;};
const HR=()=>{const C=window.__C;return <div style={{height:1,margin:"14px 0",background:`linear-gradient(90deg,transparent,${C.border},transparent)`}}/>;};
const Sk=({w="100%",h=20,r=8})=><div className="shimmer" style={{width:w,height:h,borderRadius:r,flexShrink:0}}/>;
const Badge=({n,color})=>{const C=window.__C;if(!n||n<=0) return null;const c=color||C.red;return <span style={{background:c,color:"#fff",borderRadius:10,fontSize:9,fontWeight:900,padding:"2px 6px",minWidth:18,textAlign:"center",lineHeight:1.4,marginRight:2}}>{n>99?"99+":n}</span>;};

function SH({icon,title,sub,actions,badge}){
  const C=window.__C;
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:7,fontSize:14,fontWeight:800}}>
          <span style={{fontSize:17}}>{icon}</span>{title}
          {badge!=null&&<Badge n={badge}/>}
        </div>
        {sub&&<div style={{fontSize:11,color:C.muted,marginTop:2}}>{sub}</div>}
      </div>
      {actions&&<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{actions}</div>}
    </div>
  );
}

function CT({active,payload,label}){
  const C=window.__C;
  if(!active||!payload?.length) return null;
  return(
    <div style={{background:`${C.card}f0`,border:`1px solid ${C.border}`,borderRadius:12,
      padding:"10px 14px",fontSize:12,minWidth:150,backdropFilter:"blur(20px)"}}>
      <div style={{color:C.muted,marginBottom:7,fontWeight:700,fontSize:11}}>{label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{width:8,height:8,borderRadius:2,background:p.color,flexShrink:0}}/>
          <span style={{color:C.textM,flex:1}}>{p.name}</span>
          <span className="mono" style={{color:p.color,fontWeight:700}}>{p.value?.toLocaleString?.()??p.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Sparkline (inline mini-chart in KPI) ── */
function Sparkline({data,color,h=36}){
  const C=window.__C;
  if(!data?.length) return null;
  const max=Math.max(...data,1);
  const pts=data.map((v,i)=>{
    const x=(i/(data.length-1))*100;
    const y=h-(v/max)*(h-4);
    return `${x},${y}`;
  }).join(" ");
  return(
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none"
      style={{position:"absolute",bottom:0,left:0,right:0,opacity:.3,borderRadius:"0 0 16px 16px"}}>
      <defs>
        <linearGradient id={`sg${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".6"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} 100,${h}`} fill={`url(#sg${color.replace("#","")})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"/>
    </svg>
  );
}

/* ── Animated Counter ── */
function Counter({value,color,size=22,suffix=""}){
  const C=window.__C;
  const [disp,setDisp]=useState(0);
  const prev=useRef(0);
  useEffect(()=>{
    if(value==null) return;
    const target=typeof value==="string"?parseFloat(value.replace(/[^0-9.]/g,""))||0:+(value||0);
    const from=prev.current; prev.current=target;
    if(Math.abs(target-from)<2){setDisp(target);return;}
    let frame=0; const dur=60;
    const t=setInterval(()=>{
      frame++;
      const progress=1-Math.pow(1-frame/dur,3);
      setDisp(Math.round(from+progress*(target-from)));
      if(frame>=dur){setDisp(target);clearInterval(t);}
    },16);
    return()=>clearInterval(t);
  },[value]);
  const isStr=typeof value==="string"&&isNaN(+value);
  return(
    <span className="mono" style={{fontSize:size,fontWeight:800,color:color||C.text,letterSpacing:"-1px",lineHeight:1}}>
      {isStr?value:disp.toLocaleString()+suffix}
    </span>
  );
}

/* ── KPI Card ── */
function KPI({icon,label,value,sub,color,trend,sparkData,onClick,alert=false}){
  const C=window.__C; const c=color||C.gold;
  return(
    <Card onClick={onClick} glow={alert} accent={c}
      style={{position:"relative",overflow:"hidden",padding:"15px 15px 15px",cursor:onClick?"pointer":"default",minHeight:90}}>
      {sparkData&&<Sparkline data={sparkData} color={c}/>}
      <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse at 85% 10%,${c}08,transparent 60%)`,pointerEvents:"none"}}/>
      <div style={{display:"flex",gap:10,alignItems:"flex-start",position:"relative"}}>
        <span style={{fontSize:20,lineHeight:1,marginTop:2,filter:`drop-shadow(0 0 6px ${c}50)`}}>{icon}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:9,color:C.muted,marginBottom:4,fontWeight:700,textTransform:"uppercase",letterSpacing:.6}}>{label}</div>
          <Counter value={value} color={c} size={21}/>
          {sub&&<div style={{fontSize:10,color:C.muted,marginTop:3,lineHeight:1.3}}>{sub}</div>}
          {trend!=null&&(
            <div style={{fontSize:10,marginTop:3,fontWeight:700,color:trend>0?C.green:trend<0?C.red:C.muted}}>
              {trend>0?"↑ ":trend<0?"↓ ":"→ "}{Math.abs(trend).toFixed(1)}%
            </div>
          )}
        </div>
        {alert&&<span className="blink" style={{fontSize:7,color:C.red}}>●</span>}
      </div>
    </Card>
  );
}

/* ── Health Score Ring ── */
function HealthRing({score,size=80}){
  const C=window.__C;
  const r=size/2-6; const circ=2*Math.PI*r;
  const dash=circ*(score/100);
  const c=score>=90?C.green:score>=75?C.orange:C.red;
  return(
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.dim} strokeWidth={6}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c} strokeWidth={6}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{transition:"stroke-dasharray 1.2s cubic-bezier(.4,0,.2,1)"}}/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
        <span className="mono" style={{fontSize:18,fontWeight:800,color:c,lineHeight:1}}>{score}</span>
        <span style={{fontSize:8,color:C.muted,letterSpacing:.5}}>SCORE</span>
      </div>
    </div>
  );
}

/* ─── COMPARISON ROW ─── */
function CompareRow({label,today,yesterday,color}){
  const C=window.__C; const c=color||C.gold;
  const pct=yesterday>0?((today-yesterday)/yesterday*100):0;
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}14`}}>
      <div style={{width:3,height:28,background:c,borderRadius:2,flexShrink:0}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11,color:C.muted}}>{label}</div>
        <div style={{fontSize:13,fontWeight:700,color:C.text}}>{today.toLocaleString()}</div>
      </div>
      <div style={{textAlign:"left",direction:"ltr"}}>
        <div style={{fontSize:10,color:C.muted}}>أمس: {yesterday.toLocaleString()}</div>
        <Tag color={pct>=0?C.green:C.red} size={10}>{pct>=0?"↑":"↓"}{Math.abs(pct).toFixed(1)}%</Tag>
      </div>
    </div>
  );
}

/* ─── EXPORT HELPER ─── */
function exportCSV(rows,headers,filename){
  const hdr=headers.join(",");
  const body=rows.map(r=>headers.map(h=>r[h]??r[h.toLowerCase()]??"-").join(",")).join("\n");
  const blob=new Blob(["\uFEFF"+hdr+"\n"+body],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
}
function exportJSON(data,filename){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
}

/* ═══════════════════════════════════════════════════════════════
   LIVE TICKER
═══════════════════════════════════════════════════════════════ */
function LiveTicker({data,isMock}){
  const C=window.__C;
  if(!data?.today) return null;
  const {searches,downloads,success,activeUsers,cacheHits}=data.today;
  const sr=downloads>0?((success/downloads)*100).toFixed(1):"0";
  const items=[
    `🔍 ${searches.toLocaleString()} بحث اليوم`,
    `📥 ${downloads.toLocaleString()} تحميل`,
    `✅ نجاح ${sr}٪`,
    `⚡ ${cacheHits.toLocaleString()} كاش`,
    `👥 ${activeUsers.toLocaleString()} مستخدم نشط`,
    isMock?"⚠️ بيانات تجريبية":"🟢 متصل بـ API",
  ];
  const doubled=[...items,...items];
  return(
    <div style={{background:C.surf,borderBottom:`1px solid ${C.border}`,
      height:30,overflow:"hidden",position:"relative"}}>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",overflow:"hidden"}}>
        <div style={{display:"flex",gap:0,animation:"ticker 30s linear infinite",whiteSpace:"nowrap"}}>
          {doubled.map((item,i)=>(
            <span key={i} style={{padding:"0 24px",fontSize:11,color:C.textM,display:"inline-flex",alignItems:"center",gap:8,borderRight:`1px solid ${C.border}40`}}>
              {item}
            </span>
          ))}
        </div>
      </div>
      <div style={{position:"absolute",right:0,top:0,bottom:0,width:60,background:`linear-gradient(270deg,${C.surf},transparent)`,zIndex:1}}/>
      <div style={{position:"absolute",left:0,top:0,bottom:0,width:60,background:`linear-gradient(90deg,${C.surf},transparent)`,zIndex:1}}/>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   COMMAND PALETTE
═══════════════════════════════════════════════════════════════ */
function CmdPalette({open,onClose,onTabChange,tabs}){
  const C=window.__C; const [q,setQ]=useState(""); const ref=useRef();
  useEffect(()=>{if(open){setQ("");setTimeout(()=>ref.current?.focus(),60);}});
  if(!open) return null;
  const filtered=tabs.filter(t=>t.label.includes(q)||t.id.includes(q.toLowerCase()));
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:1000,
      display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"13vh 16px",backdropFilter:"blur(10px)"}}>
      <div className="fu" style={{width:"100%",maxWidth:500,background:C.card,
        border:`1.5px solid ${C.border}`,borderRadius:20,overflow:"hidden",
        boxShadow:`0 24px 80px rgba(0,0,0,.6),0 0 0 1px ${C.gold}12`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"13px 16px",borderBottom:`1px solid ${C.border}`}}>
          <span style={{color:C.muted,fontSize:15}}>⌘</span>
          <input ref={ref} value={q} onChange={e=>setQ(e.target.value)}
            onKeyDown={e=>{
              if(e.key==="Escape") onClose();
              if(e.key==="Enter"&&filtered.length){onTabChange(filtered[0].id);onClose();}
            }}
            placeholder="اكتب اسم التاب..." style={{border:"none",background:"transparent",flex:1,fontSize:14,padding:0}}/>
          <kbd style={{background:C.dim,border:`1px solid ${C.border}`,borderRadius:5,padding:"2px 7px",fontSize:9,color:C.muted,fontFamily:"monospace"}}>ESC</kbd>
        </div>
        <div style={{maxHeight:340,overflowY:"auto"}}>
          {filtered.map((t,i)=>(
            <div key={t.id} onClick={()=>{onTabChange(t.id);onClose();}}
              style={{display:"flex",alignItems:"center",gap:12,padding:"11px 16px",cursor:"pointer",transition:"background .1s"}}
              onMouseEnter={e=>e.currentTarget.style.background=C.cardH}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <span style={{fontSize:20,width:30,textAlign:"center"}}>{t.icon}</span>
              <span style={{fontSize:13,fontWeight:600,color:C.text,flex:1}}>{t.label}</span>
              <kbd style={{background:C.dim,border:`1px solid ${C.border}`,borderRadius:5,
                padding:"2px 7px",fontSize:9,color:C.muted,fontFamily:"monospace"}}>↵</kbd>
            </div>
          ))}
          {!filtered.length&&<div style={{padding:"24px 16px",color:C.muted,textAlign:"center",fontSize:13}}>لا نتائج</div>}
        </div>
        <div style={{padding:"9px 16px",borderTop:`1px solid ${C.border}`,display:"flex",gap:14,fontSize:10,color:C.muted}}>
          <span>↵ فتح</span><span>Esc إغلاق</span><span>⌘K في أي وقت</span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION CENTER
═══════════════════════════════════════════════════════════════ */
function NotifCenter({open,onClose,errors=[]}){
  const C=window.__C;
  if(!open) return null;
  const levelColor={INFO:C.teal,WARN:C.orange,ERROR:C.red};
  return(
    <>
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:399}}/>
    <div style={{position:"fixed",top:52,left:16,zIndex:400,width:360,
      background:C.card,border:`1.5px solid ${C.border}`,borderRadius:16,
      boxShadow:`0 16px 48px rgba(0,0,0,.5)`,animation:"slideInRight .22s ease"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontWeight:800,fontSize:13}}>🔔 السجلات</div>
        <Btn sz="xs" onClick={onClose}>✕</Btn>
      </div>
      <div style={{maxHeight:360,overflowY:"auto"}}>
        {errors.map((e,i)=>(
          <div key={i} style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}14`,display:"flex",gap:10,alignItems:"flex-start"}}>
            <Tag color={levelColor[e.level]||C.muted} size={9}>{e.level}</Tag>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,color:C.text,marginBottom:2}}>{e.msg}</div>
              <div style={{fontSize:10,color:C.muted,display:"flex",gap:8}}>
                <span className="mono">{e.ctx}</span>
                <span>{e.time}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{padding:"10px 16px",borderTop:`1px solid ${C.border}`,fontSize:11,color:C.muted,textAlign:"center"}}>
        {errors.length} سجل — <span style={{color:C.red}}>{errors.filter(e=>e.level==="ERROR").length} خطأ</span>
      </div>
    </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   OVERVIEW TAB
═══════════════════════════════════════════════════════════════ */
function OverviewTab({ov,onToast,onRefresh}){
  const C=window.__C;
  const [maint,setMaint]=useState(false);
  const [showComp,setShowComp]=useState(false);
  useEffect(()=>setMaint(ov?.system?.maintenance??false),[ov]);

  if(!ov) return(
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(158px,1fr))",gap:12}}>
      {Array(12).fill(0).map((_,i)=><Card key={i}><Sk h={80}/></Card>)}
    </div>
  );

  const {today,yesterday,total,queue,premium,banned,system,healthScore}=ov;
  const sr=today.downloads>0?((today.success/today.downloads)*100).toFixed(1):"0";
  const weekSpk=ov.weekly?.map(d=>d.downloads)||[];

  const kpis=[
    {icon:"🔍",label:"بحث اليوم",     value:today.searches,  color:C.blue,  sparkData:ov.weekly?.map(d=>d.searches),
      sub:`إجمالي: ${total.totalSearches.toLocaleString()}`,trend:yesterday?+(((today.searches-yesterday.searches)/Math.max(yesterday.searches,1))*100).toFixed(1):undefined},
    {icon:"📥",label:"تحميل اليوم",   value:today.downloads, color:C.gold,  sparkData:weekSpk,
      sub:`إجمالي: ${total.totalDownloads.toLocaleString()}`,trend:yesterday?+(((today.downloads-yesterday.downloads)/Math.max(yesterday.downloads,1))*100).toFixed(1):undefined},
    {icon:"✅",label:"نجاح اليوم",    value:today.success,   color:C.green, sparkData:ov.weekly?.map(d=>d.success)},
    {icon:"❌",label:"فشل اليوم",     value:today.fail,      color:C.red,   sparkData:ov.weekly?.map(d=>d.fail)},
    {icon:"⚡",label:"كاش",           value:today.cacheHits,  color:C.purple,sparkData:ov.weekly?.map(d=>d.cacheHits),
      sub:`${((today.cacheHits/Math.max(today.success,1))*100).toFixed(0)}% من النجاح`},
    {icon:"⏱️",label:"متوسط ms",      value:`${today.avgMs}ms`, color:today.avgMs<5000?C.teal:C.red},
    {icon:"👥",label:"مستخدمون",      value:today.activeUsers,color:C.cyan, sparkData:ov.weekly?.map(d=>d.activeUsers),
      sub:`${today.newUsers||28} جديد اليوم`},
    {icon:"⭐",label:"مميزون",         value:premium.count,   color:C.gold},
    {icon:"🔄",label:"High Queue",    value:queue.highQueue,  color:C.orange},
    {icon:"📋",label:"Normal Queue",  value:queue.normalQueue,color:C.blue},
    {icon:"💀",label:"DLQ",           value:queue.dlqSize,    color:queue.dlqSize>5?C.red:C.muted,alert:queue.dlqSize>5},
    {icon:"🚫",label:"محظورون",       value:banned.count,     color:C.red},
  ];

  const toggleMaint=async()=>{
    const next=!maint; await apiM("PUT","maintenance",{active:next}); setMaint(next);
    onToast(next?"🔴 الصيانة مفعّلة":"✅ الصيانة أُوقفت",next?"warn":"ok");
  };

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Status + Actions */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",
        padding:"11px 16px",background:C.surf,borderRadius:12,border:`1px solid ${C.border}`}}>
        <Dot color={maint?C.red:C.green} size={10}/>
        <span style={{fontSize:12,fontWeight:700,color:maint?C.red:C.green,flex:1}}>
          {maint?"⚠️ الصيانة مفعّلة — البوت معطّل":"النظام يعمل بشكل طبيعي"}
        </span>
        <Btn v={maint?"success":"danger"} sz="sm" onClick={toggleMaint}>
          {maint?"✅ إيقاف الصيانة":"🔧 تفعيل الصيانة"}
        </Btn>
        <Btn v="surf" sz="sm" onClick={()=>setShowComp(p=>!p)}>
          {showComp?"▲ إخفاء":"📊 مقارنة اليوم/أمس"}
        </Btn>
        <Btn v="surf" sz="sm" onClick={onRefresh} icon="🔄">تحديث</Btn>
      </div>

      {/* Comparison */}
      {showComp&&yesterday&&(
        <Card style={{animation:"slideDown .3s ease"}}>
          <SH icon="📊" title="مقارنة — اليوم مقابل أمس"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 24px"}}>
            {[
              {label:"البحث",today:today.searches,yesterday:yesterday.searches,color:C.blue},
              {label:"التحميل",today:today.downloads,yesterday:yesterday.downloads,color:C.gold},
              {label:"النجاح",today:today.success,yesterday:yesterday.success,color:C.green},
              {label:"الفشل",today:today.fail,yesterday:yesterday.fail,color:C.red},
              {label:"الكاش",today:today.cacheHits,yesterday:yesterday.cacheHits,color:C.purple},
              {label:"المستخدمون",today:today.activeUsers,yesterday:yesterday.activeUsers,color:C.cyan},
            ].map((r,i)=><CompareRow key={i} {...r}/>)}
          </div>
        </Card>
      )}

      {/* KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(158px,1fr))",gap:12}}>
        {kpis.map((k,i)=><KPI key={i} {...k}/>)}
      </div>

      {/* Health Score + Hourly + Activity */}
      <div style={{display:"grid",gridTemplateColumns:"240px 1fr 260px",gap:16}}>
        {/* Health Score */}
        <Card>
          <SH icon="💊" title="صحة البوت"/>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginBottom:12}}>
            <HealthRing score={(healthScore||M.healthScore).overall}/>
            <Tag color={(healthScore||M.healthScore).overall>=90?C.green:(healthScore||M.healthScore).overall>=75?C.orange:C.red} pill>
              {(healthScore||M.healthScore).overall>=90?"ممتاز":(healthScore||M.healthScore).overall>=75?"جيد":"يحتاج انتباه"}
            </Tag>
          </div>
          {(healthScore||M.healthScore).components.map((comp,i)=>(
            <div key={i} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
                <span style={{color:C.muted}}>{comp.name}</span>
                <span className="mono" style={{color:C[comp.color]||C.muted,fontWeight:700}}>{comp.score}</span>
              </div>
              <div style={{background:C.dim,borderRadius:3,height:4}}>
                <div style={{background:C[comp.color]||C.muted,width:`${comp.score}%`,height:"100%",borderRadius:3,transition:"width .9s ease"}}/>
              </div>
            </div>
          ))}
        </Card>

        {/* Hourly */}
        <Card>
          <SH icon="📈" title="الطلبات بالساعة" sub="توزيع حركة اليوم"/>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={M.hourly} margin={{top:4,right:4,left:-28,bottom:0}}>
              <defs>
                <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.blue} stopOpacity={.45}/>
                  <stop offset="95%" stopColor={C.blue} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
              <XAxis dataKey="h" tick={{fontSize:9,fill:C.muted}} stroke={C.border}/>
              <YAxis tick={{fontSize:9,fill:C.muted}} stroke={C.border}/>
              <Tooltip content={<CT/>}/>
              <Area type="monotone" dataKey="v" name="طلبات" stroke={C.blue} fill="url(#hg)" strokeWidth={2}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Activity */}
        <Card style={{padding:"15px 13px"}}>
          <SH icon="⚡" title="النشاط المباشر" sub="آخر الأحداث"/>
          <div style={{display:"flex",flexDirection:"column",maxHeight:180,overflowY:"auto"}}>
            {M.activity.map((a,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:7,
                padding:"6px 0",borderBottom:`1px solid ${C.border}10`,fontSize:11}}>
                <span style={{fontSize:13,flexShrink:0}}>{a.icon}</span>
                <span style={{flex:1,color:C.textM,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:10}}>{a.text}</span>
                <span style={{color:C.muted,fontSize:9,flexShrink:0}}>{a.time}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ANALYTICS TAB
═══════════════════════════════════════════════════════════════ */
function AnalyticsTab({weekly}){
  const C=window.__C;
  const [metric,setMetric]=useState("downloads");
  const [showHeatmap,setShowHeatmap]=useState(true);

  if(!weekly?.length) return <Card><Sk h={260}/></Card>;
  const data=weekly.map(d=>({...d,
    "نجاح٪":d.downloads>0?+((d.success/d.downloads)*100).toFixed(1):0,
    "كاش٪":d.success>0?+((d.cacheHits/d.success)*100).toFixed(1):0,
  }));
  const metrics=[
    {k:"downloads",label:"تحميل",c:C.gold},{k:"searches",label:"بحث",c:C.blue},
    {k:"success",label:"نجاح",c:C.green},{k:"cacheHits",label:"كاش",c:C.purple},
    {k:"activeUsers",label:"مستخدمون",c:C.cyan},{k:"avgMs",label:"متوسط ms",c:C.teal},
  ];
  const totals={
    searches:weekly.reduce((s,d)=>s+d.searches,0),
    downloads:weekly.reduce((s,d)=>s+d.downloads,0),
    success:weekly.reduce((s,d)=>s+d.success,0),
    fail:weekly.reduce((s,d)=>s+d.fail,0),
  };
  const avgs={
    searches:Math.round(totals.searches/weekly.length),
    downloads:Math.round(totals.downloads/weekly.length),
    success:Math.round(totals.success/weekly.length),
  };

  /* Heatmap */
  const hm=M.heatmap;
  const hmMax=Math.max(...hm.data.flat(),1);

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
        {[
          {icon:"🔍",label:"إجمالي بحث",value:totals.searches,color:C.blue,sub:`متوسط: ${avgs.searches}/يوم`},
          {icon:"📥",label:"إجمالي تحميل",value:totals.downloads,color:C.gold,sparkData:weekly.map(d=>d.downloads),sub:`متوسط: ${avgs.downloads}/يوم`},
          {icon:"✅",label:"إجمالي نجاح",value:totals.success,color:C.green,sub:`متوسط: ${avgs.success}/يوم`},
          {icon:"❌",label:"إجمالي فشل",value:totals.fail,color:C.red},
          {icon:"📊",label:"معدل النجاح",value:`${(totals.downloads>0?(totals.success/totals.downloads*100):0).toFixed(1)}٪`,color:C.teal},
        ].map((k,i)=><KPI key={i} {...k}/>)}
      </div>

      {/* Chart with metric selector */}
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <SH icon="📈" title="الحركة اليومية" sub="آخر 7 أيام"/>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
            {metrics.map(m=>(
              <button key={m.k} onClick={()=>setMetric(m.k)}
                style={{background:metric===m.k?`${m.c}14`:"transparent",border:`1.5px solid ${metric===m.k?m.c:C.border}`,
                  color:metric===m.k?m.c:C.muted,padding:"4px 12px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                {m.label}
              </button>
            ))}
            <Btn v="surf" sz="sm" onClick={()=>exportCSV(weekly,["date","searches","downloads","success","fail","cacheHits","activeUsers","avgMs"],"analytics.csv")} icon="📤">CSV</Btn>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={data} margin={{top:4,right:4,left:-24,bottom:0}}>
            <defs>
              <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={metrics.find(m=>m.k===metric)?.c||C.gold} stopOpacity={.45}/>
                <stop offset="95%" stopColor={metrics.find(m=>m.k===metric)?.c||C.gold} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
            <XAxis dataKey="date" tick={{fontSize:11,fill:C.muted}} stroke={C.border}/>
            <YAxis tick={{fontSize:10,fill:C.muted}} stroke={C.border}/>
            <Tooltip content={<CT/>}/>
            <Area type="monotone" dataKey={metric} name={metrics.find(m=>m.k===metric)?.label||metric}
              stroke={metrics.find(m=>m.k===metric)?.c||C.gold} fill="url(#ag)" strokeWidth={2.5}/>
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Heatmap */}
      <Card>
        <SH icon="🌡️" title="خريطة الحرارة — نشاط الأسبوع"
          sub="توزيع الطلبات حسب اليوم والساعة"
          actions={<Btn v="surf" sz="sm" onClick={()=>setShowHeatmap(p=>!p)}>{showHeatmap?"طيّ":"عرض"}</Btn>}/>
        {showHeatmap&&(
          <div style={{overflowX:"auto"}}>
            <div style={{display:"flex",gap:6,alignItems:"flex-start",minWidth:400}}>
              <div style={{display:"flex",flexDirection:"column",gap:3,paddingTop:20}}>
                {hm.days.map((d,i)=><div key={i} style={{fontSize:10,color:C.muted,height:24,display:"flex",alignItems:"center",whiteSpace:"nowrap"}}>{d}</div>)}
              </div>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:3,marginBottom:3}}>
                  {hm.hours.map((h,i)=><div key={i} style={{flex:1,fontSize:9,color:C.muted,textAlign:"center"}}>{h}h</div>)}
                </div>
                {hm.data.map((row,ri)=>(
                  <div key={ri} style={{display:"flex",gap:3,marginBottom:3}}>
                    {row.map((val,ci)=>{
                      const intensity=val/hmMax;
                      const alpha=Math.round(intensity*220+20);
                      return(
                        <div key={ci} title={`${hm.days[ri]} ${hm.hours[ci]}:00 — ${val} طلب`}
                          style={{flex:1,height:24,borderRadius:4,
                            background:`rgba(${C.blue==="rgb"?"59,142,255":
                              C.blue.startsWith("#")?`${parseInt(C.blue.slice(1,3),16)},${parseInt(C.blue.slice(3,5),16)},${parseInt(C.blue.slice(5,7),16)}`
                              :"59,142,255"},${intensity.toFixed(2)})`,
                            border:`1px solid ${C.border}30`,cursor:"default",
                            boxShadow:intensity>0.6?`0 0 8px ${C.blue}40`:undefined,
                            transition:"transform .15s"}}
                          onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.15)";e.currentTarget.style.zIndex="10";}}
                          onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.zIndex="auto";}}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10,fontSize:10,color:C.muted}}>
              <span>منخفض</span>
              {[.1,.3,.5,.7,.9].map(v=>(
                <div key={v} style={{width:16,height:12,borderRadius:3,background:C.blue,opacity:v}}/>
              ))}
              <span>مرتفع</span>
            </div>
          </div>
        )}
      </Card>

      {/* Success/Cache Rate */}
      <Card>
        <SH icon="📊" title="معدلات الأداء (٪)"/>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data} margin={{top:4,right:4,left:-24,bottom:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
            <XAxis dataKey="date" tick={{fontSize:11,fill:C.muted}} stroke={C.border}/>
            <YAxis domain={[0,100]} tick={{fontSize:10,fill:C.muted}} stroke={C.border}/>
            <Tooltip content={<CT/>}/>
            <Line type="monotone" dataKey="نجاح٪" stroke={C.green} strokeWidth={2.5} dot={{r:3,fill:C.green}}/>
            <Line type="monotone" dataKey="كاش٪" stroke={C.purple} strokeWidth={2.5} dot={{r:3,fill:C.purple}}/>
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Detailed Table */}
      <Card>
        <SH icon="📅" title="جدول تفصيلي"
          actions={<Btn v="surf" sz="sm" onClick={()=>exportCSV(weekly,["date","searches","downloads","success","fail","cacheHits","activeUsers","avgMs"],"weekly.csv")} icon="📤">CSV</Btn>}/>
        <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr>
              {["التاريخ","بحث","تحميل","نجاح","فشل","كاش","نجاح٪","كاش٪","مستخدمون","⏱ms"].map(h=><th key={h}>{h}</th>)}
            </tr></thead>
            <tbody>
              {weekly.map((d,i)=>{
                const sr2=d.downloads>0?((d.success/d.downloads)*100).toFixed(1):"0";
                const cr=d.success>0?((d.cacheHits/d.success)*100).toFixed(1):"0";
                return(
                  <tr key={i}>
                    <td className="mono" style={{color:C.muted,fontSize:12}}>{d.date}</td>
                    <td className="mono" style={{color:C.blue,fontWeight:700}}>{d.searches}</td>
                    <td className="mono" style={{color:C.gold,fontWeight:700}}>{d.downloads}</td>
                    <td className="mono" style={{color:C.green,fontWeight:700}}>{d.success}</td>
                    <td className="mono" style={{color:d.fail>0?C.red:C.muted}}>{d.fail}</td>
                    <td className="mono" style={{color:C.purple,fontWeight:700}}>{d.cacheHits}</td>
                    <td><Tag color={+sr2>=90?C.green:+sr2>=70?C.orange:C.red}>{sr2}٪</Tag></td>
                    <td><Tag color={C.purple}>{cr}٪</Tag></td>
                    <td className="mono" style={{color:C.textM}}>{d.activeUsers}</td>
                    <td className="mono" style={{color:d.avgMs>6000?C.red:C.teal,fontSize:11}}>{d.avgMs}</td>
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

/* ═══════════════════════════════════════════════════════════════
   BOOKS TAB
═══════════════════════════════════════════════════════════════ */
function BooksTab({books}){
  const C=window.__C; const [q,setQ]=useState(""); const [sortBy,setSortBy]=useState("count");
  if(!books?.length) return <Card><Sk h={300}/></Card>;
  const colors=[C.gold,"#c0c0c0","#cd7f32",C.blue,C.purple,C.cyan,C.teal,C.orange,C.pink,C.green];
  const [page,setPage]=useState(0);
  const PAGE=10;
  const filtered=books.filter(b=>!q||b.title.includes(q)||(b.author||"").includes(q));
  const sorted=[...filtered].sort((a,b)=>b[sortBy]-a[sortBy]);
  const totalPages=Math.ceil(sorted.length/PAGE);
  const paginated=sorted.slice(page*PAGE,(page+1)*PAGE);
  const max=sorted[0]?.count||1;

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",gap:8}}>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="🔍 فلتر الكتب..." style={{maxWidth:280}}/>
        <Btn v="surf" sz="sm" onClick={()=>exportJSON(books,"top-books.json")} icon="📤">JSON</Btn>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Card>
          <SH icon="🏆" title={`أكثر الكتب طلباً`} sub={`${sorted.length} كتاب`}/>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {paginated.slice(0,10).map((b,i)=>{
              const pct=(b.count/max)*100;
              const c=colors[i]||C.muted;
              const medal=["🥇","🥈","🥉"][i]||`${i+1}`;
              return(
                <div key={i}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,gap:8}}>
                    <span style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                      <span style={{flexShrink:0}}>{medal}</span>
                      <div style={{minWidth:0}}>
                        <div style={{color:C.text,fontWeight:i<3?700:400,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>{b.title}</div>
                        {b.author&&<div style={{color:C.muted,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.author}</div>}
                      </div>
                    </span>
                    <span className="mono" style={{color:c,fontWeight:800,fontSize:14,flexShrink:0}}>{b.count}</span>
                  </div>
                  <div style={{background:C.dim,borderRadius:4,height:5,overflow:"hidden"}}>
                    <div style={{background:`linear-gradient(90deg,${c},${c}88)`,width:`${pct}%`,height:"100%",borderRadius:4,transition:"width .9s ease"}}/>
                  </div>
                </div>
              );
            })}
          </div>
          {totalPages>1&&(
            <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:12,alignItems:"center"}}>
              <Btn v="surf" sz="sm" onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0}>◀</Btn>
              <span style={{fontSize:12,color:window.__C.muted}}>{page+1} / {totalPages}</span>
              <Btn v="surf" sz="sm" onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page===totalPages-1}>▶</Btn>
            </div>
          )}
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <SH icon="📊" title="توزيع الطلبات"/>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={sorted.slice(0,8).map(b=>({name:b.title.slice(0,12),طلبات:b.count}))} layout="vertical" margin={{top:0,right:30,left:0,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:C.muted}} stroke={C.border}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:10,fill:C.textM}} stroke={C.border} width={72}/>
                <Tooltip content={<CT/>}/>
                <Bar dataKey="طلبات" radius={[0,6,6,0]}>{sorted.slice(0,8).map((_,i)=><Cell key={i} fill={colors[i]||C.muted}/>)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card>
            <SH icon="🥧" title="Top 5"/>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={sorted.slice(0,5).map((b,i)=>({name:b.title.slice(0,10),value:b.count}))}
                  cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={4} dataKey="value">
                  {sorted.slice(0,5).map((_,i)=><Cell key={i} fill={colors[i]}/>)}
                </Pie>
                <Tooltip content={<CT/>}/>
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SOURCES TAB
═══════════════════════════════════════════════════════════════ */
function SourcesTab({src,onToast,onRefresh}){
  const C=window.__C; const [toggling,setToggling]=useState(null);
  const [filter,setFilter]=useState("all");
  const toggle=async(domain,enabled)=>{
    setToggling(domain);
    await apiFetch(`sources/${domain}/toggle`,{method:"POST",body:JSON.stringify({action:enabled?"disable":"enable"})});
    onToast(`${enabled?"🔴":"🟢"} ${domain}`,enabled?"warn":"ok");
    onRefresh(); setToggling(null);
  };
  if(!src?.length) return <Card><Sk h={200}/></Card>;
  const on=src.filter(s=>s.enabled!==false).length;
  const displayed=src.filter(s=>{
    if(filter==="enabled") return s.enabled!==false;
    if(filter==="disabled") return s.enabled===false;
    if(filter==="ar") return s.type==="ar";
    if(filter==="intl") return s.type==="intl";
    return true;
  }).sort((a,b)=>{
    const ra=(a.ok+a.fail)>0?(a.ok/(a.ok+a.fail)):0;
    const rb=(b.ok+b.fail)>0?(b.ok/(b.ok+b.fail)):0;
    return rb-ra;
  });
  const totalOk=src.reduce((s,x)=>s+x.ok,0);
  const totalFail=src.reduce((s,x)=>s+x.fail,0);

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        <KPI icon="🟢" label="مفعّلة" value={on} color={C.green}/>
        <KPI icon="🔴" label="معطّلة" value={src.length-on} color={C.red}/>
        <KPI icon="✅" label="معدل النجاح" value={`${(totalOk+totalFail>0?(totalOk/(totalOk+totalFail)*100):0).toFixed(1)}٪`} color={C.teal}/>
        <KPI icon="📡" label="الإجمالي" value={src.length} color={C.gold}/>
      </div>
      <Card>
        <SH icon="🔌" title="إدارة المصادر"
          actions={
            <div style={{display:"flex",gap:6}}>
              {["all","enabled","disabled","ar","intl"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)}
                  style={{background:filter===f?`${C.gold}12`:"transparent",border:`1.5px solid ${filter===f?C.gold:C.border}`,
                    color:filter===f?C.gold:C.muted,padding:"4px 10px",borderRadius:8,fontSize:10,fontWeight:700,cursor:"pointer"}}>
                  {f==="all"?"الكل":f==="enabled"?"🟢":f==="disabled"?"🔴":f==="ar"?"🇸🇦":"🌍"}
                </button>
              ))}
            </div>
          }/>
        <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr>
              {["","المصدر","نوع","✅","❌","النسبة","أداء","تحكم"].map(h=><th key={h}>{h}</th>)}
            </tr></thead>
            <tbody>
              {displayed.map((s,i)=>{
                const t=s.ok+s.fail; const r=t>0?(s.ok/t)*100:0;
                const c=r>=90?C.green:r>=75?C.orange:C.red;
                const en=s.enabled!==false;
                return(
                  <tr key={i} style={{opacity:en?1:.5}}>
                    <td><Dot color={en?C.green:C.red} anim={en} size={8}/></td>
                    <td style={{fontWeight:700,fontSize:12,color:C.text}}>{s.domain}</td>
                    <td><Tag color={s.type==="intl"?C.blue:C.teal} size={9}>{s.type==="intl"?"🌍":"🇸🇦"}</Tag></td>
                    <td className="mono" style={{color:C.green,fontWeight:700}}>{s.ok}</td>
                    <td className="mono" style={{color:s.fail>0?C.red:C.muted}}>{s.fail}</td>
                    <td><Tag color={c} size={10}>{r.toFixed(0)}%</Tag></td>
                    <td style={{width:90}}>
                      <div style={{background:C.dim,borderRadius:4,height:6,overflow:"hidden"}}>
                        <div style={{background:`linear-gradient(90deg,${c},${c}88)`,width:`${r}%`,height:"100%",borderRadius:4,transition:"width .6s"}}/>
                      </div>
                    </td>
                    <td>
                      <Btn v={en?"danger":"success"} sz="sm" loading={toggling===s.domain} onClick={()=>toggle(s.domain,en)}>
                        {en?"إيقاف":"تفعيل"}
                      </Btn>
                    </td>
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

/* ═══════════════════════════════════════════════════════════════
   QUEUE TAB
═══════════════════════════════════════════════════════════════ */
function QueueTab({queue,dlq,onToast,onRefresh}){
  const C=window.__C; const [show,setShow]=useState(true);
  const clearDLQ=async()=>{if(!confirm("مسح DLQ؟")) return; await apiM("DELETE","queue/dlq"); onToast("✅ تم مسح DLQ"); onRefresh();};
  const clearAll=async()=>{if(!confirm("⚠️ مسح الطوابير؟")) return; await apiM("DELETE","queue/all"); onToast("✅ تم المسح","warn"); onRefresh();};
  if(!queue) return <Card><Sk h={200}/></Card>;
  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        <KPI icon="⚡" label="High Priority" value={queue.highQueue} color={C.green}/>
        <KPI icon="📋" label="Normal Queue" value={queue.normalQueue} color={C.blue}/>
        <KPI icon="💀" label="Dead Letter" value={queue.dlqSize} color={queue.dlqSize>5?C.red:C.muted} alert={queue.dlqSize>5}/>
        <KPI icon="⚙️" label="Active Jobs" value={queue.totalActiveJobs} color={C.orange}/>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <Btn v="danger" sz="sm" onClick={clearDLQ} icon="🗑️">مسح DLQ</Btn>
        <Btn v="danger" sz="sm" onClick={clearAll} icon="⚠️">مسح الكل</Btn>
        {!!dlq?.length&&<Btn v="surf" sz="sm" onClick={()=>setShow(p=>!p)}>
          {show?"▲ طيّ":"▼ عرض"} DLQ ({dlq.length})</Btn>}
        {!!dlq?.length&&<Btn v="surf" sz="sm" onClick={()=>exportJSON(dlq,"dlq.json")} icon="📤">تصدير</Btn>}
      </div>
      {show&&dlq?.length>0&&(
        <Card>
          <SH icon="💀" title={`DLQ — مهام فاشلة`} badge={dlq.length}/>
          <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:360,overflowY:"auto"}}>
            {dlq.map((j,i)=>(
              <div key={i} style={{padding:"12px 14px",background:C.surf,borderRadius:10,
                border:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",
                gap:12,flexWrap:"wrap",borderRight:`3px solid ${C.red}`}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,marginBottom:3,color:C.text}}>📗 {j.bookName}</div>
                  <div style={{color:C.red,fontSize:11,marginBottom:4}}>❌ {j.failReason}</div>
                  <Tag color={C.muted} size={10}>⏰ {new Date(j.createdAt).toLocaleTimeString("ar")}</Tag>
                </div>
                <span className="mono" style={{fontSize:11,color:C.muted,flexShrink:0}}>{j.userId}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {!dlq?.length&&(
        <Card style={{textAlign:"center",padding:32}}>
          <div className="float" style={{fontSize:36,marginBottom:8}}>✅</div>
          <div style={{color:C.green,fontWeight:700,marginBottom:4}}>لا مهام فاشلة</div>
          <div style={{color:C.muted,fontSize:12}}>الطابور نظيف تماماً</div>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   USERS TAB
═══════════════════════════════════════════════════════════════ */
function UsersTab({prem,ban,onToast,onRefresh}){
  const C=window.__C;
  const [sub,setSub]=useState("manage");
  const [uid,setUid]=useState(""); const [lim,setLim]=useState("");
  const [srch,setSrch]=useState(""); const [loading,setLoading]=useState(false);
  const [userInfo,setUserInfo]=useState(null); const [looking,setLooking]=useState(false);

  const act=async(type,tid=uid)=>{
    if(!tid.trim()){onToast("أدخل ID","err");return;}
    setLoading(true);
    const map={
      grant:()=>apiM("POST",`users/${tid}/premium`,{enable:true}),
      revoke:()=>apiM("POST",`users/${tid}/premium`,{enable:false}),
      ban:()=>apiM("POST",`users/${tid}/ban`),
      unban:()=>apiM("DELETE",`users/${tid}/ban`),
      setLim:()=>apiM("PUT",`users/${tid}/limit`,{limit:+lim}),
      resetLim:()=>apiM("DELETE",`users/${tid}/limit`),
    };
    await map[type]?.();
    onToast({grant:"✅ تم منح التميز",revoke:"✅ إلغاء التميز",ban:"🚫 تم الحظر",unban:"✅ رُفع الحظر",setLim:`✅ الحد: ${lim}`,resetLim:"✅ إعادة التعيين"}[type]);
    setLoading(false); onRefresh();
  };

  const lookup=async(id=srch)=>{
    if(!id.trim()) return; setLooking(true);
    const info=await apiFetch(`users/${id.trim()}/info`);
    setUserInfo(info??{id:id.trim(),note:"لا بيانات — تحقق من الـ ID"});
    setLooking(false);
  };

  const SubBtn=({id,label,count})=>(
    <button onClick={()=>setSub(id)}
      style={{background:sub===id?`${C.gold}10`:"transparent",border:`1.5px solid ${sub===id?C.gold:C.border}`,
        color:sub===id?C.gold:C.textM,padding:"7px 14px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",gap:6,alignItems:"center"}}>
      {label}{count!=null&&<Badge n={count} color={C.gold}/>}
    </button>
  );

  const filtP=(prem||[]).filter(id=>!srch||id.includes(srch));
  const filtB=(ban||[]).filter(id=>!srch||id.includes(srch));

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        <KPI icon="⭐" label="مميزون" value={prem?.length||0} color={C.gold}/>
        <KPI icon="🚫" label="محظورون" value={ban?.length||0} color={C.red}/>
        <KPI icon="👥" label="إجمالي" value={(prem?.length||0)+(ban?.length||0)} color={C.blue}/>
      </div>

      <Card>
        <SH icon="🔍" title="بحث عن مستخدم"/>
        <div style={{display:"flex",gap:8,marginBottom:userInfo?14:0}}>
          <input value={srch} onChange={e=>setSrch(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&lookup()}
            placeholder="Telegram User ID..." style={{direction:"ltr",flex:1}}/>
          <Btn v="blue" onClick={()=>lookup()} loading={looking} icon="🔍">بحث</Btn>
        </div>
        {userInfo&&(
          <div style={{background:C.surf,borderRadius:12,padding:"14px 16px",
            border:`1.5px solid ${C.gold}30`,animation:"slideDown .25s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span className="mono" style={{color:C.gold,fontWeight:800,fontSize:15}}>👤 {userInfo.id}</span>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {userInfo.premium&&<Tag color={C.gold} dot pill>⭐ مميز</Tag>}
                {userInfo.banned&&<Tag color={C.red} dot pill>🚫 محظور</Tag>}
              </div>
            </div>
            {userInfo.dailyLimit>=0&&(
              <div style={{fontSize:12,color:C.muted,marginBottom:8}}>
                📥 اليوم: <span className="mono" style={{color:C.blue,fontWeight:700}}>{userInfo.todayDownloads}</span>
                {" / "}
                <span className="mono" style={{color:C.textM}}>{userInfo.dailyLimit||"∞"}</span>
              </div>
            )}
            {userInfo.note&&<div style={{color:C.muted,fontSize:11,marginBottom:10}}>{userInfo.note}</div>}
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {!userInfo.premium?<Btn v="gold" sz="sm" onClick={()=>act("grant",userInfo.id)}>⭐ تميز</Btn>
                :<Btn v="ghost" sz="sm" onClick={()=>act("revoke",userInfo.id)}>❌ إلغاء</Btn>}
              {!userInfo.banned?<Btn v="danger" sz="sm" onClick={()=>act("ban",userInfo.id)}>🚫 حظر</Btn>
                :<Btn v="success" sz="sm" onClick={()=>act("unban",userInfo.id)}>✅ رفع</Btn>}
              <Btn v="surf" sz="sm" onClick={()=>setUserInfo(null)}>✕</Btn>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
          <SubBtn id="manage" label="⚙️ إدارة"/>
          <SubBtn id="prem" label="⭐ مميزون" count={prem?.length||0}/>
          <SubBtn id="ban" label="🚫 محظورون" count={ban?.length||0}/>
        </div>
        {sub==="manage"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div>
              <div style={{fontSize:10,color:C.muted,marginBottom:6,fontWeight:700,letterSpacing:.5}}>TELEGRAM USER ID</div>
              <input value={uid} onChange={e=>setUid(e.target.value)} placeholder="112233445" style={{direction:"ltr",maxWidth:300}}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <Btn v="gold" onClick={()=>act("grant")} loading={loading} icon="⭐">منح تميز</Btn>
              <Btn v="ghost" onClick={()=>act("revoke")} loading={loading} icon="❌">إلغاء تميز</Btn>
              <Btn v="danger" onClick={()=>act("ban")} loading={loading} icon="🚫">حظر</Btn>
              <Btn v="success" onClick={()=>act("unban")} loading={loading} icon="✅">رفع الحظر</Btn>
            </div>
            <HR/>
            <div style={{fontSize:10,color:C.muted,marginBottom:4,fontWeight:700,letterSpacing:.5}}>الحد اليومي (0 = بلا حد)</div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <input value={lim} onChange={e=>setLim(e.target.value)} placeholder="عدد الكتب" style={{direction:"ltr",maxWidth:180}}/>
              <Btn v="gold" onClick={()=>act("setLim")} loading={loading}>💾 حفظ</Btn>
              <Btn v="ghost" onClick={()=>act("resetLim")} loading={loading}>♻️ إعادة</Btn>
            </div>
          </div>
        )}
        {sub==="prem"&&(
          <div style={{maxHeight:380,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
              <Btn v="surf" sz="sm" onClick={()=>exportJSON(filtP,"premium-users.json")} icon="📤">تصدير</Btn>
            </div>
            {!filtP.length&&<div style={{color:C.muted,textAlign:"center",padding:"24px 0"}}>لا يوجد مميزون</div>}
            {filtP.map((id,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"10px 14px",background:C.surf,borderRadius:10,border:`1px solid ${C.border}`,borderRight:`3px solid ${C.gold}`}}>
                <span>⭐ <span className="mono" style={{color:C.gold,fontWeight:700}}>{id}</span></span>
                <Btn v="danger" sz="sm" onClick={()=>act("revoke",id)}>إلغاء</Btn>
              </div>
            ))}
          </div>
        )}
        {sub==="ban"&&(
          <div style={{maxHeight:380,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            {!filtB.length&&<div style={{color:C.muted,textAlign:"center",padding:"24px 0"}}>لا يوجد محظورون</div>}
            {filtB.map((id,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"10px 14px",background:C.surf,borderRadius:10,border:`1px solid ${C.border}`,borderRight:`3px solid ${C.red}`}}>
                <span>🚫 <span className="mono" style={{color:C.red,fontWeight:700}}>{id}</span></span>
                <Btn v="success" sz="sm" onClick={()=>act("unban",id)}>رفع</Btn>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   BROADCAST TAB
═══════════════════════════════════════════════════════════════ */
function BroadcastTab({onToast}){
  const C=window.__C;
  const [msg,setMsg]=useState(""); const [prev,setPrev]=useState(false);
  const [conf,setConf]=useState(false); const [sending,setSending]=useState(false);
  const [history,setHistory]=useState(P.get("bh",[]).slice(0,8));

  const templates=[
    {emoji:"🔧",label:"صيانة",text:"🔧 *البوت في وضع الصيانة مؤقتاً*\n\nسنعود قريباً بمزيد من التحسينات! ⏳"},
    {emoji:"✅",label:"عودة",text:"✅ *البوت عاد للعمل!*\n\nاكتب اسم أي كتاب وسأبحث عنه 📚"},
    {emoji:"✨",label:"تحديث",text:"✨ *تحديث جديد!*\n\n• 🔍 بحث أذكى وأسرع\n• 📚 مصادر جديدة\n• 🎲 /random أفضل\n\nجرّبها الآن! 🚀"},
    {emoji:"🎲",label:"/random",text:"🎲 *هل جربت /random؟*\n\n_كتاب مفاجئ من 10 أنواع مختلفة_\n\nجرّبه الآن! 📖"},
    {emoji:"📚",label:"اكتشف",text:"📚 *اكتشف كنوز المكتبة!*\n\nآلاف الكتب العربية في انتظارك.\nاكتب اسم أي كتاب الآن 🌟"},
  ];

  const send=async()=>{
    if(!msg.trim()){onToast("اكتب الرسالة","err");return;}
    setSending(true);
    const ok=await apiM("POST","broadcast",{message:msg,parse_mode:"Markdown"});
    if(ok){
      const h=[{text:msg.slice(0,70),time:new Date().toLocaleString("ar")},...history].slice(0,8);
      setHistory(h); P.set("bh",h); setMsg(""); setConf(false); onToast("✅ تم البث الجماعي");
    } else onToast("❌ فشل الإرسال","err");
    setSending(false);
  };

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card>
        <SH icon="📡" title="البث الجماعي" sub="إرسال رسالة لجميع المستخدمين"/>
        <div style={{display:"flex",gap:6,marginBottom:12}}>
          <Btn v={!prev?"gold":"surf"} sz="sm" onClick={()=>setPrev(false)} icon="✏️">كتابة</Btn>
          <Btn v={prev?"gold":"surf"} sz="sm" onClick={()=>setPrev(true)} icon="👁️">معاينة</Btn>
        </div>
        {!prev?(
          <textarea value={msg} onChange={e=>setMsg(e.target.value)}
            placeholder={"اكتب رسالة البث...\n**غامق** _مائل_ `كود` — يدعم Markdown"}
            rows={7} style={{resize:"vertical",lineHeight:1.9,fontSize:13}}/>
        ):(
          <div style={{background:C.surf,border:`1.5px solid ${C.gold}30`,borderRadius:10,
            padding:"14px 16px",minHeight:140,lineHeight:1.9,fontSize:13,whiteSpace:"pre-wrap",color:C.text}}>
            {msg||<span style={{color:C.muted}}>لا محتوى</span>}
          </div>
        )}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10,flexWrap:"wrap",gap:8}}>
          <span style={{fontSize:11,color:msg.length>4000?C.red:C.muted}}>{msg.length.toLocaleString()} / 4096</span>
          <div style={{display:"flex",gap:6}}>
            <Btn v="surf" sz="sm" onClick={()=>setMsg("")} icon="🗑️">مسح</Btn>
            {!conf?<Btn v="gold" onClick={()=>setConf(true)} disabled={!msg.trim()} icon="📡">إرسال</Btn>
              :<><Btn v="danger" onClick={()=>setConf(false)}>❌ إلغاء</Btn>
                <Btn v="success" onClick={send} loading={sending}>✅ تأكيد</Btn></>}
          </div>
        </div>
        {conf&&<div style={{marginTop:10,padding:"10px 14px",background:`${C.red}0d`,border:`1px solid ${C.red}28`,borderRadius:10,color:C.red,fontSize:12,fontWeight:600}}>
          ⚠️ سيُرسل لجميع المستخدمين — تأكد من صحة الرسالة</div>}
      </Card>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Card>
          <SH icon="📋" title="قوالب جاهزة"/>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {templates.map((t,i)=>(
              <button key={i} onClick={()=>setMsg(t.text)}
                style={{background:C.surf,border:`1.5px solid ${C.border}`,borderRadius:10,
                  padding:"9px 14px",textAlign:"right",cursor:"pointer",
                  display:"flex",alignItems:"center",gap:10,transition:"all .15s"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.background=`${C.gold}08`;}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surf;}}>
                <span style={{fontSize:17}}>{t.emoji}</span>
                <span style={{color:C.textM,fontSize:12,fontWeight:600}}>{t.label}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card>
          <SH icon="🕐" title="سجل البث"/>
          {!history.length&&<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:20}}>لا رسائل سابقة</div>}
          <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:260,overflowY:"auto"}}>
            {history.map((h,i)=>(
              <div key={i} onClick={()=>setMsg(h.text)} title="اضغط لاستعادة" style={{padding:"9px 12px",background:C.surf,borderRadius:8,border:`1px solid ${C.border}`,cursor:"pointer",transition:"border-color .15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=C.gold}
                onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                <div style={{fontSize:11,color:C.textM,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.text}</div>
                <div style={{fontSize:10,color:C.muted,marginTop:2}}>{h.time}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TELEMETRY TAB
═══════════════════════════════════════════════════════════════ */
function TelemetryTab({tel}){
  const C=window.__C; const [sel,setSel]=useState(null); const [filterStatus,setFilterStatus]=useState("all");
  if(!tel) return <Card><Sk h={300}/></Card>;
  const {funnel,pdfValidation,traces}=tel;
  const fsteps=[
    {label:"طلبات بحث",value:funnel?.searched,color:C.blue},
    {label:"نتائج وُجدت",value:funnel?.results_found,color:C.gold},
    {label:"PDF جُرِّب",value:funnel?.pdf_attempted,color:C.purple},
    {label:"PDF صالح",value:funnel?.pdf_validated,color:C.orange},
    {label:"أُرسل",value:funnel?.sent,color:C.green},
  ];
  const maxF=fsteps[0]?.value||1;
  const stc={sent:C.green,cached:C.purple,failed:C.red};
  const stl={sent:"✅ أُرسل",cached:"⚡ كاش",failed:"❌ فشل"};
  const filteredTraces=(traces||[]).filter(t=>filterStatus==="all"||t.status===filterStatus);

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card>
        <SH icon="🔽" title="قمع البحث" sub="تحويل الطلبات من البحث إلى الإرسال"
          actions={<Btn v="surf" sz="sm" onClick={()=>exportJSON(fsteps,"funnel.json")} icon="📤">تصدير</Btn>}/>
        {fsteps.map((s,i)=>{
          const pct=maxF>0?((s.value/maxF)*100).toFixed(1):0;
          const prevPct=i>0&&fsteps[i-1].value>0?((s.value/fsteps[i-1].value)*100).toFixed(1):null;
          return(
            <div key={i} style={{marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontSize:13}}>
                <span style={{color:C.textM,display:"flex",alignItems:"center",gap:7}}>
                  <span style={{width:10,height:10,borderRadius:2,background:s.color,flexShrink:0}}/>
                  {s.label}
                </span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {prevPct&&<Tag color={+prevPct>80?C.green:+prevPct>60?C.orange:C.red} size={10}>↓{prevPct}%</Tag>}
                  <span className="mono" style={{color:s.color,fontWeight:800}}>{s.value?.toLocaleString()}</span>
                  <span style={{fontSize:10,color:C.muted}}>({pct}%)</span>
                </div>
              </div>
              <div style={{background:C.dim,borderRadius:6,height:10,overflow:"hidden"}}>
                <div style={{background:`linear-gradient(90deg,${s.color},${s.color}88)`,width:`${pct}%`,height:"100%",borderRadius:6,transition:"width .9s ease"}}/>
              </div>
            </div>
          );
        })}
      </Card>

      {pdfValidation&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          <Card>
            <SH icon="📋" title="تحقق PDF"/>
            {[["إجمالي",pdfValidation.total,C.textM],["✅ مقبول",pdfValidation.accepted,C.green],
              ["❌ مرفوض",pdfValidation.rejected,C.red],["🤖 Mistral",pdfValidation.mistral_used,C.purple],
              ["📛 اسم عشوائي",pdfValidation.meaningless_filename,C.orange],
              ["📭 لا metadata",pdfValidation.no_metadata,C.muted],
              ["📉 score منخفض",pdfValidation.score_too_low,C.red]].map(([l,v,c])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 12px",background:C.surf,borderRadius:8,marginBottom:5}}>
                <span style={{color:C.muted,fontSize:12}}>{l}</span>
                <span className="mono" style={{color:c,fontWeight:700}}>{v}</span>
              </div>
            ))}
          </Card>
          <Card>
            <SH icon="🥧" title="قبول vs رفض"/>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={[{name:"مقبول",value:pdfValidation.accepted},{name:"مرفوض",value:pdfValidation.rejected}]}
                  cx="50%" cy="50%" innerRadius={55} outerRadius={82} paddingAngle={5} dataKey="value">
                  <Cell fill={C.green}/><Cell fill={C.red}/>
                </Pie>
                <Tooltip content={<CT/>}/>
              </PieChart>
            </ResponsiveContainer>
            <div style={{display:"flex",gap:14,justifyContent:"center",fontSize:11,marginTop:6}}>
              {[["مقبول",C.green],["مرفوض",C.red]].map(([l,c])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{width:10,height:10,borderRadius:2,background:c,display:"inline-block"}}/>
                  <span style={{color:C.muted}}>{l}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <SH icon="🔬" title="Traces" sub="سجل الطلبات الأخيرة — انقر للتفاصيل"
          actions={
            <div style={{display:"flex",gap:5}}>
              {["all","sent","cached","failed"].map(s=>(
                <button key={s} onClick={()=>setFilterStatus(s)}
                  style={{background:filterStatus===s?`${stc[s]||C.gold}12`:"transparent",
                    border:`1.5px solid ${filterStatus===s?stc[s]||C.gold:C.border}`,
                    color:filterStatus===s?stc[s]||C.gold:C.muted,padding:"3px 10px",borderRadius:7,fontSize:10,fontWeight:700,cursor:"pointer"}}>
                  {s==="all"?"الكل":stl[s]||s}
                </button>
              ))}
            </div>
          }/>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {filteredTraces.map((t,i)=>(
            <div key={i} onClick={()=>setSel(sel?.id===t.id?null:t)}
              style={{padding:"10px 12px",background:sel?.id===t.id?C.cardH:C.surf,borderRadius:10,
                border:`1.5px solid ${sel?.id===t.id?C.gold:C.border}`,cursor:"pointer",transition:"all .15s"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <Tag color={stc[t.status]||C.muted} size={10} pill>{stl[t.status]||t.status}</Tag>
                  <span style={{fontSize:13,fontWeight:600,color:C.text}}>{t.bookName?.slice(0,30)}</span>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span className="mono" style={{fontSize:11,color:t.ms>5000?C.red:C.teal,fontWeight:700}}>{t.ms}ms</span>
                  <Tag color={C.muted} size={10}>{t.source?.slice(0,18)}</Tag>
                  <span style={{fontSize:10,color:C.muted}}>{new Date(t.ts||Date.now()).toLocaleTimeString("ar")}</span>
                </div>
              </div>
              {sel?.id===t.id&&(
                <div style={{marginTop:10,padding:"10px 12px",background:C.bg,borderRadius:8,
                  display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,fontSize:11,animation:"slideDown .2s ease"}}>
                  {[["ID",t.id],["User",t.userId],["Source",t.source],["Cached",t.cached?"✅":"❌"],["Time",`${t.ms}ms`],["Status",t.status]].map(([k,v])=>(
                    <div key={k}><span style={{color:C.muted}}>{k}: </span><span className="mono" style={{color:C.textM}}>{v}</span></div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!filteredTraces.length&&<div style={{color:C.muted,textAlign:"center",padding:20}}>لا سجلات بهذا الفلتر</div>}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RANDOM TAB
═══════════════════════════════════════════════════════════════ */
function RandomTab({rand}){
  const C=window.__C;
  if(!rand?.length) return <Card><Sk h={300}/></Card>;
  const total=rand.reduce((s,g)=>s+g.count,0);
  const max=rand[0]?.count||1;
  const CLR=[C.blue,C.gold,C.green,C.purple,C.orange,C.cyan,C.teal,C.pink,C.red,C.textM];
  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        <KPI icon="🎲" label="إجمالي /random" value={total} color={C.gold} sparkData={rand.map(g=>g.count)}/>
        <KPI icon="📚" label="أنواع متاحة" value={rand.length} color={C.blue}/>
        <KPI icon="🏆" label="الأكثر طلباً" value={rand[0]?.label||"—"} color={C.green}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Card>
          <SH icon="🎲" title="توزيع الأنواع"
            actions={<Btn v="surf" sz="sm" onClick={()=>exportJSON(rand,"random-genres.json")} icon="📤">تصدير</Btn>}/>
          {rand.map((g,i)=>{
            const pct=(g.count/max)*100;
            return(
              <div key={g.genre} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:13}}>
                  <span style={{color:C.textM,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:8,height:8,borderRadius:2,background:CLR[i],flexShrink:0}}/>
                    {g.label}
                  </span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span className="mono" style={{color:CLR[i],fontWeight:800}}>{g.count}</span>
                    <span style={{fontSize:10,color:C.muted}}>({((g.count/total)*100).toFixed(1)}%)</span>
                  </div>
                </div>
                <div style={{background:C.dim,borderRadius:4,height:6,overflow:"hidden"}}>
                  <div style={{background:CLR[i],width:`${pct}%`,height:"100%",borderRadius:4,transition:"width .8s ease"}}/>
                </div>
              </div>
            );
          })}
          {totalPages>1&&(
            <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:12,alignItems:"center"}}>
              <Btn v="surf" sz="sm" onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0}>◀</Btn>
              <span style={{fontSize:12,color:window.__C.muted}}>{page+1} / {totalPages}</span>
              <Btn v="surf" sz="sm" onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page===totalPages-1}>▶</Btn>
            </div>
          )}
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <SH icon="🥧" title="توزيع الأنواع"/>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={rand.slice(0,7).map((g,i)=>({name:g.label,value:g.count}))}
                  cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={3} dataKey="value">
                  {rand.slice(0,7).map((_,i)=><Cell key={i} fill={CLR[i]}/>)}
                </Pie>
                <Tooltip content={<CT/>}/>
              </PieChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{padding:"14px 16px"}}>
            <SH icon="📊" title="الترتيب"/>
            {rand.map((g,i)=>(
              <div key={g.genre} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,fontSize:12}}>
                <span style={{color:C.muted,minWidth:18,fontWeight:700,fontSize:11}}>#{i+1}</span>
                <span style={{flex:1,color:C.textM}}>{g.label}</span>
                <Tag color={CLR[i]} size={10}>{g.count}</Tag>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LOGS TAB
═══════════════════════════════════════════════════════════════ */
function LogsTab({errors=[]}){
  const C=window.__C;
  const [filter,setFilter]=useState("ALL");
  const [q,setQ]=useState("");
  const lc={INFO:C.teal,WARN:C.orange,ERROR:C.red};
  const filtered=errors.filter(e=>(filter==="ALL"||e.level===filter)&&(!q||e.msg.includes(q)||e.ctx.includes(q)));

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        <KPI icon="ℹ️" label="INFO" value={errors.filter(e=>e.level==="INFO").length} color={C.teal}/>
        <KPI icon="⚠️" label="WARN" value={errors.filter(e=>e.level==="WARN").length} color={C.orange}/>
        <KPI icon="🔴" label="ERROR" value={errors.filter(e=>e.level==="ERROR").length} color={C.red}/>
      </div>
      <Card>
        <SH icon="📋" title="سجلات النظام"
          actions={<Btn v="surf" sz="sm" onClick={()=>exportJSON(errors,"logs.json")} icon="📤">تصدير</Btn>}/>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="فلتر بالنص..." style={{flex:1,maxWidth:280}}/>
          {["ALL","INFO","WARN","ERROR"].map(l=>(
            <button key={l} onClick={()=>setFilter(l)}
              style={{background:filter===l?`${lc[l]||C.gold}12`:"transparent",
                border:`1.5px solid ${filter===l?lc[l]||C.gold:C.border}`,
                color:filter===l?lc[l]||C.gold:C.muted,padding:"5px 12px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}>
              {l}
            </button>
          ))}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:500,overflowY:"auto"}}>
          {filtered.map((e,i)=>(
            <div key={i} style={{padding:"10px 12px",background:C.surf,borderRadius:8,border:`1px solid ${C.border}`,
              display:"flex",gap:10,alignItems:"flex-start",borderRight:`3px solid ${lc[e.level]||C.muted}`}}>
              <Tag color={lc[e.level]||C.muted} size={9}>{e.level}</Tag>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:C.text,marginBottom:3}}>{e.msg}</div>
                <div style={{display:"flex",gap:10,fontSize:10,color:C.muted}}>
                  <span className="mono">{e.ctx}</span>
                  <span>{e.time}</span>
                </div>
              </div>
            </div>
          ))}
          {!filtered.length&&<div style={{color:C.muted,textAlign:"center",padding:20}}>لا سجلات</div>}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SYSTEM TAB
═══════════════════════════════════════════════════════════════ */
function SystemTab({system,onToast,onRefresh}){
  const C=window.__C; const [clearing,setClearing]=useState(false);
  const clearBL=async()=>{if(!confirm("مسح Blacklist؟")) return; setClearing(true); await apiM("DELETE","blacklist"); onToast("✅ تم مسح Blacklist"); setClearing(false); onRefresh();};
  if(!system) return <Card><Sk h={300}/></Card>;
  const heapPct=Math.round((system.memory.heapUsed/system.memory.heapTotal)*100);
  const cpuPct=system.cpuUsage||0;
  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        {[
          {icon:"🟢",label:"Server",value:"Online",color:C.green},
          {icon:"⚡",label:"Redis",value:system.redis?"متصل":"منقطع",color:system.redis?C.green:C.red},
          {icon:"⚙️",label:"Workers",value:system.workers,color:C.gold},
        ].map((k,i)=><KPI key={i} {...k}/>)}
      </div>
      <Card>
        <SH icon="💾" title="الموارد"/>
        {[
          {label:"Heap Memory",used:heapPct,detail:`${system.memory.heapUsed}MB / ${system.memory.heapTotal}MB`,color:heapPct>80?C.red:heapPct>60?C.orange:C.green},
          {label:"CPU Usage",used:cpuPct,detail:`${cpuPct}%`,color:cpuPct>80?C.red:cpuPct>60?C.orange:C.green},
        ].map(r=>(
          <div key={r.label} style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontSize:13}}>
              <span style={{color:C.textM}}>{r.label}</span>
              <span className="mono" style={{color:r.color,fontWeight:700}}>{r.detail}</span>
            </div>
            <div style={{background:C.dim,borderRadius:6,height:10,overflow:"hidden"}}>
              <div style={{background:`linear-gradient(90deg,${r.color},${r.color}88)`,width:`${r.used}%`,height:"100%",borderRadius:6,transition:"width .9s"}}/>
            </div>
          </div>
        ))}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginTop:4}}>
          {[["Node.js",system.nodeVersion,C.green],["PID",system.pid,C.muted],
            ["RSS",`${system.memory.rss}MB`,C.muted],["Uptime",system.uptimeHuman,C.teal]].map(([l,v,c])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 12px",background:C.surf,borderRadius:8,border:`1px solid ${C.border}`}}>
              <span style={{color:C.muted,fontSize:11}}>{l}</span>
              <span className="mono" style={{color:c,fontWeight:700,fontSize:12}}>{v}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <SH icon="⚡" title="إجراءات"/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn v="danger" onClick={clearBL} loading={clearing} icon="🧹">مسح Blacklist</Btn>
          <Btn v="surf" onClick={onRefresh} icon="🔄">تحديث</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS TAB
═══════════════════════════════════════════════════════════════ */
function SettingsTab({isMock,theme,setTheme,refreshMs,setRefreshMs,onSave,onToast}){
  const C=window.__C;
  const [base,setBase]=useState(CFG.API_BASE||"");
  const [adminId,setAdminId]=useState(CFG.ADMIN_ID||"");

  const save=()=>{
    CFG.API_BASE=base.trim(); CFG.ADMIN_ID=adminId.trim();
    P.set("apiBase",base.trim()); P.set("adminId",adminId.trim());
    P.set("refreshMs",refreshMs); _mode="auto"; onSave(); onToast("✅ تم الحفظ");
  };

  const ep=[
    ["GET","/api/admin/overview","نظرة عامة شاملة"],
    ["GET","/api/admin/stats/random-genres","إحصائيات /random"],
    ["POST","/api/admin/sources/:domain/toggle","تفعيل/إيقاف مصدر"],
    ["POST","/api/admin/broadcast","بث جماعي"],
    ["GET","/api/admin/users/:id/info","معلومات مستخدم"],
    ["GET","/api/admin/telemetry/funnel","قمع البحث"],
    ["GET","/api/admin/telemetry/pdf-validation","إحصائيات PDF"],
    ["GET","/api/admin/telemetry/traces","سجل الطلبات"],
    ["PUT","/api/admin/maintenance","وضع الصيانة"],
    ["DELETE","/api/admin/blacklist","مسح Blacklist"],
    ["DELETE","/api/admin/queue/dlq","مسح DLQ"],
  ];

  return(
    <div className="fu" style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card>
        <SH icon="🎨" title="المظهر — 4 ثيمات"/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
          {Object.entries(THEMES).map(([k,t])=>(
            <button key={k} onClick={()=>{setTheme(k);P.set("theme",k);}}
              style={{background:theme===k?`${C.gold}10`:C.surf,border:`1.5px solid ${theme===k?C.gold:C.border}`,
                color:theme===k?C.gold:C.textM,padding:"10px 14px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"right"}}>
              {t.name}
            </button>
          ))}
        </div>
      </Card>
      <Card>
        <SH icon="⚙️" title="إعدادات الاتصال"/>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",background:C.surf,borderRadius:10,border:`1px solid ${C.border}`}}>
            <Dot color={isMock?C.orange:C.green} size={9}/>
            <span style={{flex:1,fontSize:13,fontWeight:700}}>حالة الاتصال</span>
            <Tag color={isMock?C.orange:C.green}>{isMock?"بيانات تجريبية":"API حقيقية"}</Tag>
          </div>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:6,fontWeight:700,letterSpacing:.5}}>ADMIN ID</div>
            <input value={adminId} onChange={e=>setAdminId(e.target.value)} style={{direction:"ltr"}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:6,fontWeight:700,letterSpacing:.5}}>API BASE URL</div>
            <input value={base} onChange={e=>setBase(e.target.value)} placeholder="فارغ = نفس الـ origin" style={{direction:"ltr"}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:8,fontWeight:700,letterSpacing:.5}}>تحديث تلقائي: {Math.round(refreshMs/1000)}s</div>
            <div style={{display:"flex",gap:8}}>
              {[10,30,60,120].map(s=>(
                <button key={s} onClick={()=>setRefreshMs(s*1000)}
                  style={{background:refreshMs===s*1000?`${C.gold}12`:"transparent",border:`1.5px solid ${refreshMs===s*1000?C.gold:C.border}`,
                    color:refreshMs===s*1000?C.gold:C.muted,padding:"5px 14px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  {s}s
                </button>
              ))}
            </div>
          </div>
          <Btn v="solid" onClick={save} full icon="💾">حفظ الإعدادات</Btn>
        </div>
      </Card>
      <Card>
        <SH icon="📋" title="API Reference"/>
        <div style={{background:C.surf,borderRadius:10,padding:"12px 14px",fontFamily:"'IBM Plex Mono',monospace",fontSize:11,direction:"ltr",overflowX:"auto"}}>
          {ep.map(([m,p,d],i)=>(
            <div key={i} style={{display:"flex",gap:12,padding:"4px 0",borderBottom:i<ep.length-1?`1px solid ${C.border}14`:"none",alignItems:"center"}}>
              <span style={{minWidth:55,color:{GET:C.teal,POST:C.blue,PUT:C.orange,DELETE:C.red}[m]||C.muted,fontWeight:700,fontSize:10}}>{m}</span>
              <span style={{flex:1,color:C.gold,fontSize:11}}>{p}</span>
              <span style={{color:C.muted,fontSize:10}}>// {d}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   QUICK ACTIONS FLOAT
═══════════════════════════════════════════════════════════════ */
function QuickActions({onToast,onRefresh,onTabChange}){
  const C=window.__C; const [open,setOpen]=useState(false);
  const actions=[
    {icon:"🔄",label:"تحديث البيانات",action:()=>{onRefresh();onToast("🔄 جارٍ التحديث");}},
    {icon:"📡",label:"بث الآن",action:()=>onTabChange("broadcast")},
    {icon:"💀",label:"إدارة DLQ",action:()=>onTabChange("queue")},
    {icon:"👥",label:"إدارة المستخدمين",action:()=>onTabChange("users")},
    {icon:"🔌",label:"المصادر",action:()=>onTabChange("sources")},
  ];
  return(
    <div style={{position:"fixed",bottom:80,left:16,zIndex:300}}>
      {open&&(
        <div style={{position:"absolute",bottom:52,left:0,display:"flex",flexDirection:"column",gap:6,
          animation:"fadeUp .2s ease"}}>
          {actions.map((a,i)=>(
            <button key={i} onClick={()=>{a.action();setOpen(false);}}
              style={{background:C.card,border:`1.5px solid ${C.border}`,color:C.text,
                padding:"8px 14px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",
                display:"flex",gap:8,alignItems:"center",whiteSpace:"nowrap",
                boxShadow:`0 4px 16px rgba(0,0,0,.3)`,
                transition:"all .15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text;}}>
              <span style={{fontSize:16}}>{a.icon}</span>{a.label}
            </button>
          ))}
        </div>
      )}
      <button onClick={()=>setOpen(p=>!p)} className="glow"
        style={{width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${C.goldD},${C.gold})`,
          border:"none",fontSize:20,cursor:"pointer",boxShadow:`0 4px 20px ${C.gold}40`,display:"flex",alignItems:"center",justifyContent:"center",
          transition:"transform .2s"}}>
        {open?"✕":"⚡"}
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TOAST SYSTEM
═══════════════════════════════════════════════════════════════ */
function Toaster({toasts}){
  const C=window.__C;
  return(
    <div style={{position:"fixed",bottom:90,left:"50%",transform:"translateX(-50%)",zIndex:9999,
      display:"flex",flexDirection:"column",gap:8,alignItems:"center",pointerEvents:"none"}}>
      {toasts.map(t=>{
        const c={ok:C.green,warn:C.orange,err:C.red}[t.type]||C.green;
        return(
          <div key={t.id} className="fu" style={{background:`${C.card}f5`,border:`1.5px solid ${c}55`,
            color:c,padding:"10px 20px",borderRadius:14,fontSize:13,fontWeight:700,
            display:"flex",alignItems:"center",gap:8,
            boxShadow:`0 8px 32px ${c}20`,backdropFilter:"blur(16px)",whiteSpace:"nowrap"}}>
            {{ok:"✅",warn:"⚠️",err:"❌"}[t.type]||"ℹ️"} {t.msg}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   APP ROOT
═══════════════════════════════════════════════════════════════ */
const TABS=[
  {id:"overview",  icon:"🏠",label:"نظرة عامة"},
  {id:"analytics", icon:"📊",label:"التحليلات"},
  {id:"books",     icon:"📚",label:"الكتب"},
  {id:"sources",   icon:"🔌",label:"المصادر"},
  {id:"queue",     icon:"🔄",label:"الطابور"},
  {id:"users",     icon:"👥",label:"المستخدمون"},
  {id:"broadcast", icon:"📡",label:"البث"},
  {id:"telemetry", icon:"🔬",label:"Telemetry"},
  {id:"random",    icon:"🎲",label:"/random"},
  {id:"logs",      icon:"📋",label:"السجلات"},
  {id:"system",    icon:"💻",label:"النظام"},
  {id:"settings",  icon:"⚙️",label:"الإعدادات"},
];

export default function App(){
  const [tab,setTab]          = useState("overview");
  const [data,setData]        = useState({});
  const [loading,setLoading]  = useState(true);
  const [toasts,setToasts]    = useState([]);
  const [theme,setTheme]      = useState(()=>P.get("theme","obsidian"));
  const [sidebar,setSidebar]  = useState(()=>window.innerWidth>900);
  const [navOpen,setNavOpen]  = useState(false);
  const [cmdOpen,setCmdOpen]  = useState(false);
  const [notifOpen,setNotifOpen]= useState(false);
  const [winW,setWinW]        = useState(window.innerWidth);
  const [ago,setAgo]          = useState("الآن");
  const [refreshMs,setRefreshMs]= useState(()=>P.get("refreshMs",30_000));
  const tsRef                 = useRef(Date.now());

  const C = THEMES[theme]||THEMES.obsidian;
  window.__C = C;
  injectCSS(C);

  const isMobile = winW<=768;

  const showToast=useCallback((msg,type="ok")=>{
    const id=Date.now();
    setToasts(p=>[...p,{id,msg,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),3500);
  },[]);

  const refresh=useCallback(async()=>{
    setLoading(true);
    const fallback={today:M.today,yesterday:M.yesterday,total:M.total,queue:M.queue,premium:M.premium,
      banned:M.banned,blacklist:M.blacklist,system:M.system,weekly:M.weekly,healthScore:M.healthScore};
    const [ov,books,src,dlq,prem,ban,tel,rand]=await Promise.all([
      apiFetch("overview").then(d=>d??fallback),
      apiFetch("stats/top-books?limit=10").then(d=>d??M.topBooks),
      apiFetch("stats/sources").then(d=>d??M.sources),
      apiFetch("queue/dlq?limit=30").then(d=>d??M.dlqJobs),
      apiFetch("users/premium").then(d=>d??M.premiumUsers),
      apiFetch("users/banned").then(d=>d??M.bannedUsers),
      (async()=>{
        const [f,p,t]=await Promise.all([
          apiFetch("telemetry/funnel"),apiFetch("telemetry/pdf-validation"),apiFetch("telemetry/traces?limit=20"),
        ]);
        return{funnel:f??M.telemetry.funnel,pdfValidation:p??M.telemetry.pdfValidation,traces:t??M.telemetry.traces};
      })(),
      apiFetch("stats/random-genres").then(d=>d?.length?d:M.randomGenres),
    ]);
    setData({ov,books,src,dlq,prem,ban,tel,rand,isMock:_mode==="always"});
    tsRef.current=Date.now(); setLoading(false);
  },[]);

  useEffect(()=>{refresh();},[]);
  useEffect(()=>{const t=setInterval(refresh,refreshMs);return()=>clearInterval(t);},[refreshMs]);
  useEffect(()=>{
    const t=setInterval(()=>{
      const s=Math.floor((Date.now()-tsRef.current)/1000);
      setAgo(s<5?"الآن":s<60?`${s}ث`:`${Math.floor(s/60)}د`);
    },1000); return()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    const fn=()=>{setWinW(window.innerWidth);setSidebar(window.innerWidth>900);};
    window.addEventListener("resize",fn); return()=>window.removeEventListener("resize",fn);
  },[]);
  useEffect(()=>{
    const fn=(e)=>{
      if((e.ctrlKey||e.metaKey)&&e.key==="k"){e.preventDefault();setCmdOpen(true);}
      if(e.key==="Escape"){setCmdOpen(false);setNavOpen(false);setNotifOpen(false);}
    };
    window.addEventListener("keydown",fn); return()=>window.removeEventListener("keydown",fn);
  },[]);

  const ov=data.ov;
  const maintenance=ov?.system?.maintenance;
  const dlqAlert=(data.dlq?.length||0)>3;
  const errorCount=M.errors.filter(e=>e.level==="ERROR").length;

  const tabBadge={queue:data.dlq?.length||0,logs:errorCount};

  const NavItem=({t,onClick,compact=false})=>{
    const active=tab===t.id;
    const badge=tabBadge[t.id]||0;
    return(
      <button onClick={onClick||(() => setTab(t.id))}
        style={{background:active?`${C.gold}0d`:"transparent",
          border:`1.5px solid ${active?`${C.gold}50`:"transparent"}`,
          color:active?C.gold:C.muted,
          padding:compact?"8px 10px":"9px 10px",borderRadius:10,
          display:"flex",alignItems:"center",gap:compact?0:9,
          width:"100%",cursor:"pointer",position:"relative",
          transition:"all .16s",boxShadow:active?`inset 0 0 20px ${C.gold}06`:undefined}}>
        {active&&!compact&&<div style={{position:"absolute",right:0,top:"20%",height:"60%",width:2.5,background:C.gold,borderRadius:"2px 0 0 2px"}}/>}
        <span style={{fontSize:compact?20:17,flexShrink:0,filter:active?`drop-shadow(0 0 8px ${C.gold}60)`:undefined}}>{t.icon}</span>
        {!compact&&sidebar&&<span style={{fontSize:12,fontWeight:active?700:400,whiteSpace:"nowrap",flex:1}}>{t.label}</span>}
        {!compact&&sidebar&&badge>0&&<Badge n={badge}/>}
      </button>
    );
  };

  return(
    <div style={{display:"flex",minHeight:"100vh",flexDirection:"column",background:C.bg}}>
      {/* LIVE TICKER */}
      <LiveTicker data={ov} isMock={data.isMock}/>

      <div style={{display:"flex",flex:1}}>
        {/* SIDEBAR */}
        {!isMobile&&(
          <div style={{width:sidebar?224:56,background:C.surf,borderLeft:`1px solid ${C.border}`,
            display:"flex",flexDirection:"column",transition:"width .22s cubic-bezier(.4,0,.2,1)",
            overflow:"hidden",flexShrink:0,position:"sticky",top:0,height:"calc(100vh - 30px)",zIndex:50}}>
            <div style={{padding:"14px 10px",borderBottom:`1px solid ${C.border}`,
              display:"flex",alignItems:"center",gap:9,overflow:"hidden",minHeight:56}}>
              <div className="glow" style={{width:34,height:34,borderRadius:9,flexShrink:0,
                background:`linear-gradient(135deg,${C.goldD},${C.gold})`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,
                boxShadow:`0 0 20px ${C.gold}35`}}>📚</div>
              {sidebar&&(
                <div style={{lineHeight:1.3,overflow:"hidden"}}>
                  <div style={{color:C.gold,fontWeight:900,fontSize:13,whiteSpace:"nowrap",letterSpacing:.3}}>خلاصة الكتب</div>
                  <div style={{color:C.muted,fontSize:8,whiteSpace:"nowrap",letterSpacing:.8}}>ADMIN DASHBOARD</div>
                </div>
              )}
            </div>
            <nav style={{flex:1,padding:"8px 5px",overflowY:"auto",display:"flex",flexDirection:"column",gap:1.5}}>
              {TABS.map(t=><NavItem key={t.id} t={t}/>)}
            </nav>
            {sidebar&&(
              <button onClick={()=>setCmdOpen(true)}
                style={{margin:"0 8px 8px",background:C.dim,border:`1px solid ${C.border}`,color:C.muted,
                  padding:"8px 12px",borderRadius:9,fontSize:11,cursor:"pointer",display:"flex",gap:6,alignItems:"center"}}>
                <span>⌘</span><span style={{flex:1}}>بحث سريع</span>
                <kbd style={{background:C.surf,border:`1px solid ${C.border}`,borderRadius:4,padding:"1px 6px",fontSize:9,fontFamily:"monospace"}}>⌘K</kbd>
              </button>
            )}
            <button onClick={()=>setSidebar(p=>!p)}
              style={{background:"transparent",border:"none",color:C.muted,padding:13,borderTop:`1px solid ${C.border}`,fontSize:12,cursor:"pointer"}}>
              {sidebar?"◀":"▶"}
            </button>
          </div>
        )}

        {/* MAIN */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
          {/* TOPBAR */}
          <div style={{background:`${C.surf}ee`,borderBottom:`1px solid ${C.border}`,padding:"0 16px",
            height:50,display:"flex",alignItems:"center",justifyContent:"space-between",
            flexShrink:0,position:"sticky",top:0,zIndex:100,backdropFilter:"blur(20px)"}}>
            <div style={{display:"flex",alignItems:"center",gap:9}}>
              {isMobile&&(
                <button onClick={()=>setNavOpen(true)}
                  style={{background:"transparent",border:"none",color:C.textM,fontSize:20,cursor:"pointer",padding:"3px 6px"}}>
                  ☰
                </button>
              )}
              <div style={{display:"flex",alignItems:"center",gap:7,fontSize:14,fontWeight:800}}>
                <span style={{fontSize:16}}>{TABS.find(t=>t.id===tab)?.icon}</span>
                <span className="hm">{TABS.find(t=>t.id===tab)?.label}</span>
                {maintenance&&<Tag color={C.red} dot size={10} pill>صيانة</Tag>}
                {dlqAlert&&<Tag color={C.red} size={10}>💀 DLQ</Tag>}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <Tag color={data.isMock?C.orange:C.green} size={10} dot>{data.isMock?"Mock":"Live"}</Tag>
              <span className="hm mono" style={{fontSize:10,color:C.muted}}>{ago}</span>
              <button onClick={()=>setNotifOpen(p=>!p)}
                style={{background:notifOpen?`${C.orange}15`:"transparent",border:`1.5px solid ${notifOpen?C.orange:C.border}`,
                  color:notifOpen?C.orange:C.muted,padding:"4px 8px",borderRadius:8,fontSize:12,cursor:"pointer",
                  display:"flex",alignItems:"center",gap:4,position:"relative"}}>
                🔔{errorCount>0&&<span style={{position:"absolute",top:-2,left:-2,background:C.red,borderRadius:"50%",
                  width:8,height:8,display:"block"}} className="pulse"/>}
              </button>
              <button onClick={()=>setCmdOpen(true)} className="hm"
                style={{background:C.dim,border:`1px solid ${C.border}`,color:C.muted,padding:"3px 10px",
                  borderRadius:7,fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>⌘K</button>
              <button onClick={refresh}
                style={{background:"transparent",border:"none",color:loading?C.gold:C.muted,fontSize:17,cursor:"pointer",display:"inline-flex",
                  animation:loading?"spin .75s linear infinite":undefined}}>⟳</button>
              <div style={{background:C.goldDim,border:`1px solid ${C.goldD}`,color:C.gold,
                padding:"3px 10px",borderRadius:8,fontSize:10,fontWeight:700}} className="hm">🛡️ أدمن</div>
            </div>
          </div>

          {/* CONTENT */}
          <div style={{flex:1,overflowY:"auto",padding:isMobile?"10px 12px":"18px 20px"}}>
            {tab==="overview"  &&<OverviewTab  ov={ov} onToast={showToast} onRefresh={refresh}/>}
            {tab==="analytics" &&<AnalyticsTab weekly={ov?.weekly||[]}/>}
            {tab==="books"     &&<BooksTab     books={data.books}/>}
            {tab==="sources"   &&<SourcesTab   src={data.src} onToast={showToast} onRefresh={refresh}/>}
            {tab==="queue"     &&<QueueTab     queue={ov?.queue} dlq={data.dlq} onToast={showToast} onRefresh={refresh}/>}
            {tab==="users"     &&<UsersTab     prem={data.prem} ban={data.ban} onToast={showToast} onRefresh={refresh}/>}
            {tab==="broadcast" &&<BroadcastTab onToast={showToast}/>}
            {tab==="telemetry" &&<TelemetryTab tel={data.tel}/>}
            {tab==="random"    &&<RandomTab    rand={data.rand}/>}
            {tab==="logs"      &&<LogsTab      errors={M.errors}/>}
            {tab==="system"    &&<SystemTab    system={ov?.system} onToast={showToast} onRefresh={refresh}/>}
            {tab==="settings"  &&<SettingsTab  isMock={data.isMock} theme={theme} setTheme={setTheme}
              refreshMs={refreshMs} setRefreshMs={setRefreshMs} onSave={refresh} onToast={showToast}/>}
          </div>

          {/* BOTTOM NAV MOBILE */}
          {isMobile&&(
            <nav style={{background:`${C.surf}f5`,borderTop:`1px solid ${C.border}`,
              display:"flex",overflowX:"auto",flexShrink:0,padding:"4px 2px",
              position:"sticky",bottom:0,zIndex:100,backdropFilter:"blur(16px)"}}>
              {TABS.map(t=>(
                <button key={t.id} onClick={()=>setTab(t.id)}
                  style={{background:tab===t.id?`${C.gold}0e`:"transparent",border:`1.5px solid ${tab===t.id?`${C.gold}50`:"transparent"}`,
                    color:tab===t.id?C.gold:C.muted,padding:"5px 7px",borderRadius:8,
                    display:"flex",flexDirection:"column",alignItems:"center",gap:2,
                    minWidth:46,cursor:"pointer",flexShrink:0,transition:"all .15s"}}>
                  <span style={{fontSize:16}}>{t.icon}</span>
                  <span style={{fontSize:8,fontWeight:700,whiteSpace:"nowrap"}}>{t.label}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>

      {/* MOBILE SIDEBAR */}
      {isMobile&&navOpen&&(
        <div style={{position:"fixed",inset:0,zIndex:200,display:"flex"}}>
          <div onClick={()=>setNavOpen(false)} style={{flex:1,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)"}}/>
          <div style={{width:248,background:C.surf,borderRight:`1px solid ${C.border}`,
            display:"flex",flexDirection:"column",animation:"slideInRight .22s ease"}}>
            <div style={{padding:"16px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:10}}>
              <div className="glow" style={{width:33,height:33,borderRadius:8,flexShrink:0,
                background:`linear-gradient(135deg,${C.goldD},${C.gold})`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📚</div>
              <div>
                <div style={{color:C.gold,fontWeight:900,fontSize:13}}>خلاصة الكتب</div>
                <div style={{color:C.muted,fontSize:8,letterSpacing:.8}}>ADMIN DASHBOARD</div>
              </div>
            </div>
            <nav style={{flex:1,padding:"7px 7px",overflowY:"auto",display:"flex",flexDirection:"column",gap:1.5}}>
              {TABS.map(t=><NavItem key={t.id} t={t} onClick={()=>{setTab(t.id);setNavOpen(false);}}/>)}
            </nav>
            <div style={{padding:"10px 12px",borderTop:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:6}}>
              <Dot color={data.isMock?C.orange:C.green} size={8}/>
              <span style={{fontSize:11,color:C.muted}}>{data.isMock?"Mock":"Live"}</span>
            </div>
          </div>
        </div>
      )}

      {/* CMD PALETTE */}
      <CmdPalette open={cmdOpen} onClose={()=>setCmdOpen(false)} onTabChange={setTab} tabs={TABS}/>

      {/* NOTIFICATION CENTER */}
      <NotifCenter open={notifOpen} onClose={()=>setNotifOpen(false)} errors={M.errors}/>

      {/* QUICK ACTIONS */}
      {!isMobile&&<QuickActions onToast={showToast} onRefresh={refresh} onTabChange={setTab}/>}

      {/* TOASTS */}
      <Toaster toasts={toasts}/>
    </div>
  );
}
