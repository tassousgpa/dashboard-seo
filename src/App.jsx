import { useState, useMemo, useCallback, useEffect } from "react";

/* ───────── CONFIG ───────── */
const SUPA_URL = "https://cikbkbhniglwgdwvnqza.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpa2JrYmhuaWdsd2dkd3ZucXphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NzAyNjcsImV4cCI6MjA5MDU0NjI2N30.xlD9OWFhI268U2cD95KpuJ7Dx1-BeqkvynP3rfGOIfg";

const C = {
  navy: "#1B2A4A", blue: "#3266AD", teal: "#1D9E75", orange: "#D85A30",
  purple: "#534AB7", gray: "#6B7280", red: "#DC2626", green: "#16A34A",
  bg: "#F5F6F8", card: "#FFFFFF", border: "#E5E7EB", text: "#1E1E2E",
  textLight: "#6B7280", yellow: "#D97706",
};

/* ───────── SUPABASE ───────── */
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function loadHistory() {
  return sbFetch("weekly_snapshots?select=*&order=week_start.asc");
}

async function upsertSnapshot(row) {
  return sbFetch("weekly_snapshots", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(row),
  });
}

/* ───────── UTILS ───────── */
function normalizeId(raw) {
  return String(raw || "").trim().replace(/-/g, "_");
}

function parseDateCode(str) {
  const m = str && str.match(/(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})/);
  if (m) return { start: `${m[1]}-${m[2]}-${m[3]}`, end: `${m[4]}-${m[5]}-${m[6]}` };
  return null;
}

function parseDateEnglish(str) {
  const mo = { January:"01",February:"02",March:"03",April:"04",May:"05",June:"06",July:"07",August:"08",September:"09",October:"10",November:"11",December:"12" };
  const m = str && str.match(/(\w+)\s+(\d+),\s+(\d{4})\s+-\s+(\w+)\s+(\d+),\s+(\d{4})/);
  if (m) { const p = n => String(n).padStart(2,"0"); return { start:`${m[3]}-${mo[m[1]]}-${p(m[2])}`, end:`${m[6]}-${mo[m[4]]}-${p(m[5])}` }; }
  return null;
}

function fmtDate(str) {
  if (!str) return "–";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ───────── PARSERS ───────── */

function parseGA4(text) {
  const lines = text.split("\n");
  let dateRange = null;
  for (let i = 0; i < 6; i++) {
    const r = parseDateCode(lines[i]?.replace(/^#\s*/, "").trim());
    if (r) { dateRange = r; break; }
  }
  let segIdx = -1, dataIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(",Segment,") || t.startsWith("Segment,")) segIdx = i;
    if (t.startsWith("Item ID,")) { dataIdx = i; break; }
  }
  if (dataIdx === -1) return null;

  const segParts = lines[segIdx].split(",");
  const segs = {};
  let col = 2;
  while (col < segParts.length) {
    const s = segParts[col].trim().toLowerCase();
    if (!s) { col++; continue; }
    const key = s.includes("all") ? "all" : s.includes("paid") ? "paid" : s.includes("organic") ? "organic" : null;
    if (key && !segs[key]) { segs[key] = { v: col, a: col+1, p: col+2 }; col += 3; } else col++;
  }

  // Grand total from line dataIdx+1
  let totals = null;
  const tl = lines[dataIdx + 1]?.trim();
  if (tl && tl.includes("Grand total")) {
    const tf = tl.split(","); const gn = i => parseInt(tf[i])||0;
    if (segs.all && segs.paid && segs.organic) {
      totals = {
        allViews:gn(segs.all.v), allAtc:gn(segs.all.a), allPurch:gn(segs.all.p),
        paidViews:gn(segs.paid.v), paidAtc:gn(segs.paid.a), paidPurch:gn(segs.paid.p),
        orgViews:gn(segs.organic.v), orgAtc:gn(segs.organic.a), orgPurch:gn(segs.organic.p),
      };
    }
  }

  const products = [];
  for (let i = dataIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.includes("Grand total")) continue;
    const fields = []; let cur = "", inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c]==='"') inQ=!inQ;
      else if (line[c]===',' && !inQ) { fields.push(cur); cur=""; }
      else cur+=line[c];
    }
    fields.push(cur);
    if (fields.length < 5) continue;
    const itemId = normalizeId(fields[0]);
    const name = fields[1].trim();
    if (!itemId && !name) continue;
    const gn = i => parseInt(fields[i])||0;
    const row = { itemId, name };
    if (segs.all) { row.allViews=gn(segs.all.v); row.allAtc=gn(segs.all.a); row.allPurch=gn(segs.all.p); }
    if (segs.paid) { row.paidViews=gn(segs.paid.v); row.paidAtc=gn(segs.paid.a); row.paidPurch=gn(segs.paid.p); }
    if (segs.organic) { row.orgViews=gn(segs.organic.v); row.orgAtc=gn(segs.organic.a); row.orgPurch=gn(segs.organic.p); }
    products.push(row);
  }

  if (!totals) {
    totals = { allViews:0,allAtc:0,allPurch:0,paidViews:0,paidAtc:0,paidPurch:0,orgViews:0,orgAtc:0,orgPurch:0 };
    products.forEach(r => {
      totals.allViews+=r.allViews||0; totals.allAtc+=r.allAtc||0; totals.allPurch+=r.allPurch||0;
      totals.paidViews+=r.paidViews||0; totals.paidAtc+=r.paidAtc||0; totals.paidPurch+=r.paidPurch||0;
      totals.orgViews+=r.orgViews||0; totals.orgAtc+=r.orgAtc||0; totals.orgPurch+=r.orgPurch||0;
    });
  }

  return { products, dateRange, totals };
}

function parseGoogleAds(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
  const lines = text.split("\n").map(l => l.replace(/\r$/,""));
  const dateRange = parseDateEnglish(lines[1] || "");
  const costs = {};
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const id = normalizeId(parts[0]);
      const cost = parseFloat(parts[2]);
      if (id && !isNaN(cost) && cost > 0 && id !== "Item_ID" && id !== "Item ID") {
        costs[id] = (costs[id]||0) + cost;
      }
    }
  }
  return { costs, dateRange, total: Object.values(costs).reduce((s,v)=>s+v,0) };
}

function parseMeta(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
  const lines = text.split("\n").map(l => l.replace(/\r$/,"").trim()).filter(l=>l);
  if (lines.length < 2) return { costs:{}, dateRange:null, total:0 };

  // Detect separator: YTD has quoted fields with commas; weekly uses semicolons
  const sep = lines[0].includes('","') || (lines[0].startsWith('"') && !lines[0].includes(";")) ? "," : ";";

  const parseRow = (line) => {
    const fields=[]; let cur="", inQ=false;
    for (let c=0;c<line.length;c++) {
      if (line[c]==='"') inQ=!inQ;
      else if (line[c]===sep && !inQ) { fields.push(cur.trim()); cur=""; }
      else cur+=line[c];
    }
    fields.push(cur.trim()); return fields;
  };

  const header = parseRow(lines[0]);
  const idCol = header.findIndex(h=>h.toLowerCase().includes("id"));
  const costCol = header.findIndex(h=>h.toLowerCase().includes("montant")||h.toLowerCase().includes("dépensé")||h.toLowerCase().includes("depense"));
  const startCol = header.findIndex(h=>h.toLowerCase().includes("début")||h.toLowerCase().includes("debut"));
  const endCol = header.findIndex(h=>h.toLowerCase().includes("fin des")||h.toLowerCase().includes("fin rapport"));

  const costs={}; let dateRange=null;
  for (let i=1;i<lines.length;i++) {
    const f = parseRow(lines[i]);
    if (f.length < 2) continue;
    const rawId = f[idCol>=0?idCol:0]||"";
    const idMatch = rawId.match(/^(\d+[-_]\d+)/);
    if (!idMatch) continue;
    const itemId = normalizeId(idMatch[1]);
    const costRaw = (f[costCol>=0?costCol:1]||"").replace(",",".");
    const cost = parseFloat(costRaw);
    if (!isNaN(cost) && cost > 0) costs[itemId]=(costs[itemId]||0)+cost;
    if (!dateRange && startCol>=0 && endCol>=0) {
      const s=f[startCol]?.trim(), e=f[endCol]?.trim();
      if (s && s.match(/^\d{4}-\d{2}-\d{2}/)) dateRange={start:s,end:e};
    }
  }
  return { costs, dateRange, total: Object.values(costs).reduce((s,v)=>s+v,0) };
}

/* ───────── CHECKS ───────── */
function checkDateAnomalies(ranges) {
  const valid = ranges.filter(r=>r.range);
  if (valid.length < 2) return [];
  const ref = valid[0];
  return valid.slice(1).filter(r=>r.range.start!==ref.range.start||r.range.end!==ref.range.end)
    .map(r=>`⚠️ ${r.label} : ${fmtDate(r.range.start)}→${fmtDate(r.range.end)} ≠ ${ref.label} : ${fmtDate(ref.range.start)}→${fmtDate(ref.range.end)}`);
}

function checkHistoryGap(history, newStart) {
  if (!history||history.length===0) return null;
  const lastWeekly = [...history].filter(h=>!h.is_ytd).sort((a,b)=>b.week_end.localeCompare(a.week_end))[0];
  if (!lastWeekly) return null;
  const expectedNext = addDays(lastWeekly.week_end, 1);
  if (newStart > expectedNext) {
    return `⚠️ Gap détecté : dernière semaine en base jusqu'au ${fmtDate(lastWeekly.week_end)}. L'import commence le ${fmtDate(newStart)}. Il manque du ${fmtDate(expectedNext)} au ${fmtDate(addDays(newStart,-1))}.`;
  }
  return null;
}

/* ───────── FORMATTERS ───────── */
function fmt(n) {
  if (n==null||isNaN(n)) return "–";
  if (n>=1000000) return (n/1000000).toFixed(1)+"M";
  if (n>=10000) return Math.round(n/1000)+"k";
  return Math.round(n).toLocaleString("fr-FR");
}
function pct(n) { if (n==null||isNaN(n)) return "–"; return (n*100).toFixed(2)+"%"; }
function euro(n) { if (n==null||isNaN(n)) return "–"; return Math.round(n).toLocaleString("fr-FR")+" €"; }

/* ───────── COMPONENTS ───────── */

function DropZone({ label, hint, icon, loaded, fileName, dateRange, onFiles, accept, color=C.blue }) {
  const [drag, setDrag] = useState(false);
  const onDragOver=useCallback(e=>{e.preventDefault();setDrag(true);},[]);
  const onDragLeave=useCallback(e=>{e.preventDefault();setDrag(false);},[]);
  const onDrop=useCallback(e=>{e.preventDefault();setDrag(false);const f=[...e.dataTransfer.files];if(f.length)onFiles(f);},[onFiles]);
  const onClick=useCallback(()=>{const i=document.createElement("input");i.type="file";i.accept=accept;i.onchange=e=>{const f=[...e.target.files];if(f.length)onFiles(f);};i.click();},[accept,onFiles]);
  return (
    <div onClick={onClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{flex:1,minWidth:160,padding:"18px 14px",borderRadius:14,
        border:`2.5px dashed ${loaded?C.teal:drag?color:C.border}`,
        background:loaded?"#F0FDF4":drag?"#EFF6FF":C.card,
        cursor:"pointer",transition:"all 0.2s",textAlign:"center",transform:drag?"scale(1.02)":"scale(1)"}}>
      <div style={{fontSize:28,marginBottom:4}}>{loaded?"✅":icon}</div>
      <div style={{fontSize:13,fontWeight:700,color:loaded?C.teal:C.text}}>{label}</div>
      <div style={{fontSize:10,color:C.textLight,marginTop:3,lineHeight:1.4}}>{hint}</div>
      {fileName && <div style={{marginTop:5,fontSize:9,color:C.teal,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fileName}</div>}
      {dateRange && <div style={{marginTop:4,fontSize:9,color,fontWeight:700}}>{fmtDate(dateRange.start)} → {fmtDate(dateRange.end)}</div>}
      {!loaded && <div style={{fontSize:10,color,marginTop:6,fontWeight:600}}>Glisser ici ou cliquer</div>}
    </div>
  );
}

function KpiCard({ label, value, borderColor=C.blue, sub }) {
  return (
    <div style={{background:C.card,borderRadius:12,padding:"14px 18px",borderTop:`3px solid ${borderColor}`,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",flex:1,minWidth:110}}>
      <div style={{fontSize:10,color:C.textLight,fontWeight:600,textTransform:"uppercase",letterSpacing:0.3}}>{label}</div>
      <div style={{fontSize:24,fontWeight:700,color:C.navy,marginTop:6}}>{value}</div>
      {sub && <div style={{fontSize:10,color:C.textLight,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function Alert({ type="warn", children }) {
  const bg=type==="error"?"#FEF2F2":type==="ok"?"#F0FDF4":"#FFFBEB";
  const color=type==="error"?C.red:type==="ok"?C.teal:C.yellow;
  return <div style={{background:bg,border:`1px solid ${color}40`,borderRadius:10,padding:"10px 14px",fontSize:12,color,fontWeight:500,marginBottom:12}}>{children}</div>;
}

function ChannelBlock({ label, bg, color, views, atcRate, convRate, purch }) {
  return (
    <div style={{padding:14,background:bg,borderRadius:10,textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,color}}>{label}</div>
      <div style={{fontSize:20,fontWeight:700,color:C.navy,marginTop:8}}>{fmt(views)}</div>
      <div style={{fontSize:9,color:C.textLight}}>vues</div>
      <div style={{display:"flex",justifyContent:"center",gap:14,marginTop:10}}>
        <div><div style={{fontSize:15,fontWeight:700,color:C.navy}}>{pct(atcRate)}</div><div style={{fontSize:9,color:C.textLight}}>ATC</div></div>
        <div><div style={{fontSize:15,fontWeight:700,color:C.navy}}>{pct(convRate)}</div><div style={{fontSize:9,color:C.textLight}}>Conv.</div></div>
      </div>
      <div style={{fontSize:15,fontWeight:700,color:purch>0?C.navy:C.red,marginTop:8}}>{purch} achats</div>
    </div>
  );
}

function ProductTable({ products, showCost=false }) {
  if (!products||products.length===0) return <div style={{color:C.textLight,fontSize:12,padding:16}}>Aucun produit</div>;
  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead>
          <tr style={{borderBottom:`2px solid ${C.navy}`}}>
            {["#","Produit","Vues","ATC","Taux ATC","Achats","Conv.",...(showCost?["Coût Ads"]:[])].map((h,i)=>(
              <th key={i} style={{textAlign:i<2?"left":"right",padding:"8px 5px",color:C.navy,fontWeight:700}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p,i)=>{
            const atcRate=p.views>0?p.atc/p.views:0;
            const convRate=p.views>0?p.purchases/p.views:0;
            return (
              <tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#FAFBFC":C.card}}>
                <td style={{padding:"5px",color:C.textLight,fontSize:10}}>{i+1}</td>
                <td style={{padding:"5px",fontWeight:500,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${p.name} (${p.itemId})`}>
                  {p.name||p.itemId}<span style={{fontSize:9,color:C.textLight,marginLeft:6}}>({p.itemId})</span>
                </td>
                <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:C.navy}}>{fmt(p.views)}</td>
                <td style={{padding:"5px",textAlign:"right"}}>{fmt(p.atc)}</td>
                <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:atcRate>0.04?C.green:atcRate<0.02?C.red:C.text}}>{pct(atcRate)}</td>
                <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:p.purchases>0?C.teal:C.red}}>{p.purchases}</td>
                <td style={{padding:"5px",textAlign:"right",color:convRate>0.01?C.green:C.text}}>{pct(convRate)}</td>
                {showCost && <td style={{padding:"5px",textAlign:"right",color:C.orange,fontWeight:500}}>{p.cost>0?euro(p.cost):"–"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryChart({ history }) {
  const [activeMetric, setActiveMetric] = useState("all_views");
  const metrics = [
    {key:"all_views",label:"Vues",color:C.blue,fn:fmt},
    {key:"all_purchases",label:"Achats",color:C.teal,fn:v=>v},
    {key:"google_spend",label:"Google €",color:C.orange,fn:v=>Math.round(v)+"€"},
    {key:"meta_spend",label:"Meta €",color:C.purple,fn:v=>Math.round(v)+"€"},
  ];
  const metric = metrics.find(m=>m.key===activeMetric);
  const values = history.map(w=>w[activeMetric]||0);
  const maxVal = Math.max(...values,1);
  const W=600,H=140,pL=50,pR=20,pT=10,pB=30;
  const n=history.length;
  const pts = history.map((w,i)=>({
    x: n===1?pL+(W-pL-pR)/2:pL+i*(W-pL-pR)/(n-1),
    y: pT+(1-(w[activeMetric]||0)/maxVal)*(H-pT-pB),
    w,
  }));
  return (
    <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.navy}}>Historique · {history.length} semaine(s)</div>
        <div style={{display:"flex",gap:6}}>
          {metrics.map(m=>(
            <button key={m.key} onClick={()=>setActiveMetric(m.key)}
              style={{fontSize:10,padding:"4px 10px",borderRadius:20,border:"none",cursor:"pointer",fontWeight:600,
                background:activeMetric===m.key?m.color:C.bg,color:activeMetric===m.key?"#fff":C.textLight}}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
        {[0,0.25,0.5,0.75,1].map(t=>{
          const y=pT+t*(H-pT-pB);
          return <line key={t} x1={pL} x2={W-pR} y1={y} y2={y} stroke={C.border} strokeWidth="1"/>;
        })}
        {[0,0.5,1].map(t=>{
          const y=pT+t*(H-pT-pB); const val=maxVal*(1-t);
          return <text key={t} x={pL-4} y={y+4} textAnchor="end" fontSize="9" fill={C.textLight}>{metric.fn(Math.round(val))}</text>;
        })}
        {pts.length>1 && <polyline points={pts.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={metric.color} strokeWidth="2.5" strokeLinejoin="round"/>}
        {pts.map((p,i)=>(
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="4" fill={metric.color}/>
            <text x={p.x} y={H-4} textAnchor="middle" fontSize="8" fill={C.textLight}>{fmtDate(p.w.week_start).slice(0,5)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ───────── MAIN ───────── */
export default function Dashboard() {
  const [ga4, setGa4] = useState(null);
  const [gAds, setGAds] = useState(null);
  const [meta, setMeta] = useState(null);
  const [ga4File, setGa4File] = useState(null);
  const [gAdsFile, setGAdsFile] = useState(null);
  const [metaFile, setMetaFile] = useState(null);
  const [isYTD, setIsYTD] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [gapWarning, setGapWarning] = useState(null);
  const [dateAnomalies, setDateAnomalies] = useState([]);

  useEffect(() => {
    loadHistory().then(r=>setHistory(r||[])).catch(e=>console.error(e)).finally(()=>setHistoryLoading(false));
  }, []);

  const handleGA4 = useCallback((files) => {
    const file=files[0], reader=new FileReader();
    reader.onload=e=>{
      const result=parseGA4(e.target.result);
      if (result&&result.products.length>0) {
        setGa4(result); setGa4File(file.name);
        if (result.dateRange) setIsYTD(daysBetween(result.dateRange.start,result.dateRange.end)>10);
      } else alert("Format non reconnu. Utilise l'export GA4 Explore combiné (Organic + Paid + All Users).");
    };
    reader.readAsText(file);
  }, []);

  const handleGoogleAds = useCallback((files) => {
    const file=files[0];
    const tryUtf16=new FileReader();
    tryUtf16.onload=e=>{
      const r=parseGoogleAds(e.target.result);
      if (Object.keys(r.costs).length>0) { setGAds(r); setGAdsFile(file.name); }
      else {
        const tryUtf8=new FileReader();
        tryUtf8.onload=e2=>{const r2=parseGoogleAds(e2.target.result);setGAds(r2);setGAdsFile(file.name);};
        tryUtf8.readAsText(file,"utf-8");
      }
    };
    tryUtf16.readAsText(file,"utf-16");
  }, []);

  const handleMeta = useCallback((files) => {
    const file=files[0], reader=new FileReader();
    reader.onload=e=>{const r=parseMeta(e.target.result);setMeta(r);setMetaFile(file.name);};
    reader.readAsText(file,"utf-8");
  }, []);

  useEffect(() => {
    setDateAnomalies(checkDateAnomalies([
      {label:"GA4",range:ga4?.dateRange},
      {label:"Google Ads",range:gAds?.dateRange},
      {label:"Meta",range:meta?.dateRange},
    ]));
    if (ga4?.dateRange) setGapWarning(checkHistoryGap(history,ga4.dateRange.start));
  }, [ga4,gAds,meta,history]);

  const handleSave = useCallback(async () => {
    if (!ga4) return;
    setSaveStatus("saving");
    try {
      const t=ga4.totals;
      await upsertSnapshot({
        week_start:ga4.dateRange.start, week_end:ga4.dateRange.end,
        is_ytd:isYTD, source:isYTD?"ytd_seed":"manual",
        all_views:t.allViews, all_atc:t.allAtc, all_purchases:t.allPurch,
        paid_views:t.paidViews, paid_atc:t.paidAtc, paid_purchases:t.paidPurch,
        org_views:t.orgViews, org_atc:t.orgAtc, org_purchases:t.orgPurch,
        google_spend:Math.round((gAds?.total||0)*100)/100,
        meta_spend:Math.round((meta?.total||0)*100)/100,
        product_rows:ga4.products,
      });
      const updated=await loadHistory(); setHistory(updated||[]);
      setSaveStatus("ok"); setSaveMsg(`✅ ${isYTD?"YTD":"Semaine"} ${fmtDate(ga4.dateRange.start)}→${fmtDate(ga4.dateRange.end)} sauvegardée`);
    } catch(e) { setSaveStatus("error"); setSaveMsg("❌ "+e.message); }
    setTimeout(()=>{setSaveStatus(null);setSaveMsg("");},5000);
  }, [ga4,gAds,meta,isYTD]);

  const analysis = useMemo(() => {
    if (!ga4) return null;
    const t=ga4.totals;
    const getCost=id=>((gAds?.costs?.[id]||0)+(meta?.costs?.[id]||0));
    const orgProducts=ga4.products.filter(r=>(r.orgViews||0)>0)
      .map(r=>({itemId:r.itemId,name:r.name,views:r.orgViews||0,atc:r.orgAtc||0,purchases:r.orgPurch||0,cost:getCost(r.itemId)}))
      .sort((a,b)=>b.views-a.views);
    return {
      ...t,
      orgAtcRate:t.orgViews>0?t.orgAtc/t.orgViews:0,
      orgConvRate:t.orgViews>0?t.orgPurch/t.orgViews:0,
      paidAtcRate:t.paidViews>0?t.paidAtc/t.paidViews:0,
      paidConvRate:t.paidViews>0?t.paidPurch/t.paidViews:0,
      allAtcRate:t.allViews>0?t.allAtc/t.allViews:0,
      allConvRate:t.allViews>0?t.allPurch/t.allViews:0,
      orgShare:t.allViews>0?t.orgViews/t.allViews:0,
      paidShare:t.allViews>0?t.paidViews/t.allViews:0,
      totalGCost:gAds?.total||0, totalMCost:meta?.total||0,
      topOrganic:orgProducts.slice(0,20),
      zeroConv:orgProducts.filter(p=>p.views>=50&&p.purchases===0).sort((a,b)=>b.views-a.views).slice(0,15),
      bestConv:orgProducts.filter(p=>p.views>=20&&p.purchases>0).sort((a,b)=>(b.purchases/b.views)-(a.purchases/a.views)).slice(0,10),
      wasteful:ga4.products.map(r=>({itemId:r.itemId,name:r.name,views:r.allViews||0,atc:r.allAtc||0,purchases:(r.allPurch||0)+(r.orgPurch||0)+(r.paidPurch||0),cost:getCost(r.itemId)}))
        .filter(p=>p.cost>20&&p.purchases===0).sort((a,b)=>b.cost-a.cost).slice(0,10),
    };
  }, [ga4,gAds,meta]);

  const hasCosts=gAds||meta;
  const weeklyHistory=useMemo(()=>history.filter(h=>!h.is_ytd).sort((a,b)=>a.week_start.localeCompare(b.week_start)),[history]);
  const ytdSnap=useMemo(()=>history.find(h=>h.is_ytd),[history]);

  return (
    <div style={{fontFamily:"-apple-system,'Segoe UI',sans-serif",background:C.bg,minHeight:"100vh"}}>
      {/* Header */}
      <div style={{background:C.navy,padding:"18px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:18,fontWeight:700,color:"#FFF"}}>Dashboard E-commerce · BestMobilier</div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>
            {weeklyHistory.length} semaine(s) en base{ytdSnap?` · YTD ${fmtDate(ytdSnap.week_start)}→${fmtDate(ytdSnap.week_end)}`:""}
          </div>
        </div>
        {ga4 && (
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <label style={{fontSize:11,color:"#94A3B8",display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
              <input type="checkbox" checked={isYTD} onChange={e=>setIsYTD(e.target.checked)}/>
              Import YTD
            </label>
            <button onClick={handleSave} disabled={saveStatus==="saving"}
              style={{fontSize:12,fontWeight:700,padding:"8px 18px",borderRadius:8,border:"none",cursor:"pointer",
                background:saveStatus==="ok"?C.teal:C.blue,color:"#fff"}}>
              {saveStatus==="saving"?"Sauvegarde...":saveStatus==="ok"?"✅ Sauvegardé":"💾 Sauvegarder"}
            </button>
          </div>
        )}
      </div>

      <div style={{maxWidth:1100,margin:"0 auto",padding:"20px 16px 60px"}}>

        {/* 3 Drop zones */}
        <div style={{display:"flex",gap:12,marginBottom:16}}>
          <DropZone label="GA4" hint="Export combiné Organic + Paid + All Users (.csv)" icon="📊"
            loaded={!!ga4} fileName={ga4File} dateRange={ga4?.dateRange}
            onFiles={handleGA4} accept=".csv" color={C.blue}/>
          <DropZone label="Google Ads" hint="Coûts par produit (.csv UTf-16 TSV)" icon="🎯"
            loaded={!!gAds} fileName={gAdsFile} dateRange={gAds?.dateRange}
            onFiles={handleGoogleAds} accept=".csv" color={C.orange}/>
          <DropZone label="Meta Ads" hint="Coûts par produit ID (.csv)" icon="📘"
            loaded={!!meta} fileName={metaFile} dateRange={meta?.dateRange}
            onFiles={handleMeta} accept=".csv" color={C.purple}/>
        </div>

        {/* Alerts */}
        {dateAnomalies.map((a,i)=><Alert key={i} type="error">{a}</Alert>)}
        {gapWarning && <Alert type="warn">{gapWarning}</Alert>}
        {saveMsg && <Alert type={saveStatus==="error"?"error":"ok"}>{saveMsg}</Alert>}

        {!ga4 && (
          <div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}>
            <div style={{fontSize:48,marginBottom:12}}>📊</div>
            <div style={{fontSize:15,fontWeight:500}}>Glisse ton export GA4 pour commencer</div>
            <div style={{fontSize:12,marginTop:6}}>Google Ads et Meta Ads sont optionnels</div>
          </div>
        )}

        {analysis && (
          <>
            {/* Period label */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.navy}}>
                {isYTD?"📅 YTD":"📅 Semaine"} · {fmtDate(ga4.dateRange?.start)} → {fmtDate(ga4.dateRange?.end)}
              </div>
              <div style={{fontSize:11,color:C.textLight}}>{analysis.allViews.toLocaleString("fr-FR")} vues · {analysis.allPurch} achats</div>
            </div>

            {/* KPIs */}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
              <KpiCard label="Vues produit" value={fmt(analysis.allViews)} borderColor={C.blue}/>
              <KpiCard label="Taux ATC" value={pct(analysis.allAtcRate)} borderColor={C.teal}/>
              <KpiCard label="Taux conversion" value={pct(analysis.allConvRate)} borderColor={C.purple}/>
              <KpiCard label="Achats" value={fmt(analysis.allPurch)} borderColor={C.green}/>
              <KpiCard label="% Organic" value={pct(analysis.orgShare)} borderColor={C.teal}/>
              <KpiCard label="% Paid" value={pct(analysis.paidShare)} borderColor={C.orange}/>
            </div>

            {/* Organic vs Paid + Budget */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
              <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
                <div style={{fontSize:13,fontWeight:700,color:C.navy,marginBottom:14}}>Organic vs Paid</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <ChannelBlock label="ORGANIC" bg="#F0FDF4" color={C.teal}
                    views={analysis.orgViews} atcRate={analysis.orgAtcRate} convRate={analysis.orgConvRate} purch={analysis.orgPurch}/>
                  <ChannelBlock label="PAID" bg="#FFF7ED" color={C.orange}
                    views={analysis.paidViews} atcRate={analysis.paidAtcRate} convRate={analysis.paidConvRate} purch={analysis.paidPurch}/>
                </div>
              </div>
              <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
                <div style={{fontSize:13,fontWeight:700,color:C.navy,marginBottom:14}}>Budget publicitaire</div>
                {hasCosts ? (
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    {gAds && <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:"#EFF6FF",borderRadius:8}}>
                      <span style={{fontSize:12,fontWeight:600,color:C.blue}}>🎯 Google Ads</span>
                      <span style={{fontSize:22,fontWeight:700,color:C.navy}}>{euro(analysis.totalGCost)}</span>
                    </div>}
                    {meta && <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:"#F3E8FF",borderRadius:8}}>
                      <span style={{fontSize:12,fontWeight:600,color:C.purple}}>📘 Meta Ads</span>
                      <span style={{fontSize:22,fontWeight:700,color:C.navy}}>{euro(analysis.totalMCost)}</span>
                    </div>}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.bg,borderRadius:8,borderTop:`2px solid ${C.navy}`}}>
                      <span style={{fontSize:12,fontWeight:700,color:C.navy}}>Total</span>
                      <span style={{fontSize:22,fontWeight:700,color:C.navy}}>{euro(analysis.totalGCost+analysis.totalMCost)}</span>
                    </div>
                    {analysis.paidPurch>0 && <div style={{padding:"10px 16px",background:"#FFF7ED",borderRadius:8,fontSize:12,display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:C.textLight}}>CPA moyen</span>
                      <span style={{fontWeight:700,color:C.orange}}>{euro((analysis.totalGCost+analysis.totalMCost)/analysis.paidPurch)} / achat</span>
                    </div>}
                  </div>
                ) : (
                  <div style={{color:C.textLight,fontSize:12,padding:30,textAlign:"center"}}>Glisse les fichiers Google Ads et/ou Meta Ads pour voir le budget</div>
                )}
              </div>
            </div>

            {/* Product tables */}
            <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
              <div style={{fontSize:13,fontWeight:700,color:C.navy}}>Top 20 produits Organic</div>
              <div style={{fontSize:10,color:C.textLight,marginBottom:12}}>Par vues. Taux ATC : vert &gt;4%, rouge &lt;2%.</div>
              <ProductTable products={analysis.topOrganic} showCost={!!hasCosts}/>
            </div>
            {analysis.bestConv.length>0 && (
              <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:C.green}}>Meilleures conversions Organic</div>
                <div style={{fontSize:10,color:C.textLight,marginBottom:12}}>Produits à pousser en SEO.</div>
                <ProductTable products={analysis.bestConv} showCost={!!hasCosts}/>
              </div>
            )}
            {analysis.zeroConv.length>0 && (
              <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:C.red}}>50+ vues organic · 0 achat</div>
                <div style={{fontSize:10,color:C.textLight,marginBottom:12}}>Trafic SEO gaspillé.</div>
                <ProductTable products={analysis.zeroConv} showCost={!!hasCosts}/>
              </div>
            )}
            {analysis.wasteful.length>0 && (
              <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:C.orange}}>Budget gaspillé · &gt;20€ · 0 achat</div>
                <div style={{fontSize:10,color:C.textLight,marginBottom:12}}>Candidats à couper.</div>
                <ProductTable products={analysis.wasteful} showCost={true}/>
              </div>
            )}
          </>
        )}

        {/* History chart */}
        {!historyLoading && weeklyHistory.length>0 && <HistoryChart history={weeklyHistory}/>}
        {historyLoading && <div style={{textAlign:"center",padding:20,color:C.textLight,fontSize:12}}>Chargement de l'historique…</div>}

        {/* YTD reference */}
        {ytdSnap && (
          <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",borderTop:`3px solid ${C.navy}`}}>
            <div style={{fontSize:13,fontWeight:700,color:C.navy,marginBottom:12}}>
              Référence YTD · {fmtDate(ytdSnap.week_start)} → {fmtDate(ytdSnap.week_end)}
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[
                {label:"Vues",value:fmt(ytdSnap.all_views),color:C.blue},
                {label:"Achats",value:fmt(ytdSnap.all_purchases),color:C.green},
                {label:"Conv.",value:pct(ytdSnap.all_views>0?ytdSnap.all_purchases/ytdSnap.all_views:0),color:C.purple},
                {label:"Google Ads",value:euro(ytdSnap.google_spend),color:C.orange},
                {label:"Meta Ads",value:euro(ytdSnap.meta_spend),color:C.purple},
                {label:"CPA",value:ytdSnap.paid_purchases>0?euro((ytdSnap.google_spend+ytdSnap.meta_spend)/ytdSnap.paid_purchases):"–",color:C.orange},
              ].map((k,i)=>(
                <div key={i} style={{background:C.bg,borderRadius:10,padding:"10px 16px",minWidth:100,borderTop:`2px solid ${k.color}`}}>
                  <div style={{fontSize:10,color:C.textLight,fontWeight:600}}>{k.label}</div>
                  <div style={{fontSize:18,fontWeight:700,color:C.navy,marginTop:4}}>{k.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
