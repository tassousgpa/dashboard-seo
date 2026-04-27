import { useState, useMemo, useCallback, useEffect, useRef } from "react";

/* ───────── CONFIG ───────── */
const SUPA_URL = "https://cikbkbhniglwgdwvnqza.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpa2JrYmhuaWdsd2dkd3ZucXphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NzAyNjcsImV4cCI6MjA5MDU0NjI2N30.xlD9OWFhI268U2cD95KpuJ7Dx1-BeqkvynP3rfGOIfg";

const C = {
  navy:"#1B2A4A",blue:"#3266AD",teal:"#1D9E75",orange:"#D85A30",
  purple:"#534AB7",red:"#DC2626",green:"#16A34A",yellow:"#D97706",
  bg:"#F5F6F8",card:"#FFFFFF",border:"#E5E7EB",text:"#1E1E2E",textLight:"#6B7280",
};

/* ───────── SUPABASE ───────── */
async function sbFetch(path,opts={}){
  const res=await fetch(`${SUPA_URL}/rest/v1/${path}`,{...opts,headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`,"Content-Type":"application/json","Prefer":opts.prefer||"return=representation",...(opts.headers||{})}});
  if(!res.ok)throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status===204?null:res.json();
}
const loadHistory=()=>sbFetch("weekly_snapshots?select=*&order=week_start.asc");
const upsertSnapshot=row=>sbFetch("weekly_snapshots",{method:"POST",prefer:"resolution=merge-duplicates,return=representation",body:JSON.stringify(row)});

/* ───────── UTILS ───────── */
const normalizeId=raw=>String(raw||"").trim().replace(/-/g,"_");
function parseDateCode(str){const m=str&&str.match(/(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})/);return m?{start:`${m[1]}-${m[2]}-${m[3]}`,end:`${m[4]}-${m[5]}-${m[6]}`}:null;}
function parseDateEnglish(str){
  const mo={January:"01",February:"02",March:"03",April:"04",May:"05",June:"06",July:"07",August:"08",September:"09",October:"10",November:"11",December:"12"};
  const m=str&&str.match(/(\w+)\s+(\d+),\s+(\d{4})\s+-\s+(\w+)\s+(\d+),\s+(\d{4})/);
  if(!m)return null; const p=n=>String(n).padStart(2,"0");
  return{start:`${m[3]}-${mo[m[1]]}-${p(m[2])}`,end:`${m[6]}-${mo[m[4]]}-${p(m[5])}`};
}
const fmtDate=str=>{if(!str)return"–";const[y,m,d]=str.split("-");return`${d}/${m}/${y}`;};
const daysBetween=(d1,d2)=>Math.round((new Date(d2)-new Date(d1))/86400000);
const addDays=(s,n)=>{const d=new Date(s);d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};
// GA4 export bug: swap views/atc if atc > views (physically impossible)
const safeVA=(v,a)=>v<a?[a,v]:[v,a];

/* ───────── PARSERS ───────── */
function parseGA4(text){
  const lines=text.split("\n");
  let dateRange=null;
  for(let i=0;i<6;i++){const r=parseDateCode(lines[i]?.replace(/^#\s*/,"").trim());if(r){dateRange=r;break;}}
  let segIdx=-1,dataIdx=-1;
  for(let i=0;i<lines.length;i++){
    const t=lines[i].trim();
    if(t.startsWith(",Segment,")||t.startsWith("Segment,"))segIdx=i;
    if(t.startsWith("Item ID,")){dataIdx=i;break;}
  }
  if(dataIdx===-1)return null;
  const segParts=lines[segIdx].split(",");
  const segs={};let col=2;
  while(col<segParts.length){
    const s=segParts[col].trim().toLowerCase();if(!s){col++;continue;}
    const key=s.includes("all")?"all":s.includes("paid")?"paid":s.includes("organic")?"organic":null;
    if(key&&!segs[key]){segs[key]={v:col,a:col+1,p:col+2};col+=3;}else col++;
  }
  const products=[];
  for(let i=dataIdx+1;i<lines.length;i++){
    const line=lines[i].trim();if(!line||line.includes("Grand total"))continue;
    const fields=[];let cur="",inQ=false;
    for(let c=0;c<line.length;c++){if(line[c]==='"')inQ=!inQ;else if(line[c]===','&&!inQ){fields.push(cur);cur="";}else cur+=line[c];}
    fields.push(cur);if(fields.length<5)continue;
    const itemId=normalizeId(fields[0]);const name=fields[1].trim();if(!itemId&&!name)continue;
    const gn=i=>parseInt(fields[i])||0;
    const row={itemId,name};
    if(segs.all){const[v,a]=safeVA(gn(segs.all.v),gn(segs.all.a));row.allViews=v;row.allAtc=a;row.allPurch=gn(segs.all.p);}
    if(segs.paid){const[v,a]=safeVA(gn(segs.paid.v),gn(segs.paid.a));row.paidViews=v;row.paidAtc=a;row.paidPurch=gn(segs.paid.p);}
    if(segs.organic){const[v,a]=safeVA(gn(segs.organic.v),gn(segs.organic.a));row.orgViews=v;row.orgAtc=a;row.orgPurch=gn(segs.organic.p);}
    products.push(row);
  }
  // Always recompute totals from clean (swap-corrected) product rows
  const totals={allViews:0,allAtc:0,allPurch:0,paidViews:0,paidAtc:0,paidPurch:0,orgViews:0,orgAtc:0,orgPurch:0};
  products.forEach(r=>{
    totals.allViews+=r.allViews||0;totals.allAtc+=r.allAtc||0;totals.allPurch+=r.allPurch||0;
    totals.paidViews+=r.paidViews||0;totals.paidAtc+=r.paidAtc||0;totals.paidPurch+=r.paidPurch||0;
    totals.orgViews+=r.orgViews||0;totals.orgAtc+=r.orgAtc||0;totals.orgPurch+=r.orgPurch||0;
  });
  return{products,dateRange,totals};
}

function parseGoogleAds(text){
  if(text.charCodeAt(0)===0xFEFF)text=text.substring(1);
  const lines=text.split("\n").map(l=>l.replace(/\r$/,""));
  const dateRange=parseDateEnglish(lines[1]||"");
  const costs={};
  for(const line of lines){const p=line.split("\t").map(x=>x.trim());if(p.length>=3){const id=normalizeId(p[0]);const cost=parseFloat(p[2].replace(",","."));if(id&&!isNaN(cost)&&cost>0&&id!=="Item_ID"&&id!=="Item ID")costs[id]=(costs[id]||0)+cost;}}
  return{costs,dateRange,total:Object.values(costs).reduce((s,v)=>s+v,0)};
}

function parseMeta(text){
  if(text.charCodeAt(0)===0xFEFF)text=text.substring(1);
  const lines=text.split("\n").map(l=>l.replace(/\r$/,"").trim()).filter(l=>l);
  if(lines.length<2)return{costs:{},dateRange:null,total:0};
  const sep=lines[0].includes('","')||(lines[0].startsWith('"')&&!lines[0].includes(";"))?",":";";
  const parseRow=line=>{const f=[];let cur="",inQ=false;for(let c=0;c<line.length;c++){if(line[c]==='"')inQ=!inQ;else if(line[c]===sep&&!inQ){f.push(cur.trim());cur="";}else cur+=line[c];}f.push(cur.trim());return f;};
  const hdr=parseRow(lines[0]);
  const idCol=hdr.findIndex(h=>h.toLowerCase().includes("id"));
  const costCol=hdr.findIndex(h=>h.toLowerCase().includes("montant")||h.toLowerCase().includes("dépensé")||h.toLowerCase().includes("depense"));
  const startCol=hdr.findIndex(h=>h.toLowerCase().includes("début")||h.toLowerCase().includes("debut"));
  const endCol=hdr.findIndex(h=>h.toLowerCase().includes("fin des")||h.toLowerCase().includes("fin rapport"));
  const costs={};let dateRange=null;
  for(let i=1;i<lines.length;i++){
    const f=parseRow(lines[i]);if(f.length<2)continue;
    const rawId=f[idCol>=0?idCol:0]||"";const idMatch=rawId.match(/^(\d+[-_]\d+)/);if(!idMatch)continue;
    const itemId=normalizeId(idMatch[1]);
    const costStr=(f[costCol>=0?costCol:1]||"").trim().replace(/\s/g,"").replace(",",".");const cost=parseFloat(costStr);
    if(!isNaN(cost)&&cost>0)costs[itemId]=(costs[itemId]||0)+cost;
    if(!dateRange&&startCol>=0&&endCol>=0){const s=f[startCol]?.trim(),e=f[endCol]?.trim();if(s&&s.match(/^\d{4}-\d{2}-\d{2}/))dateRange={start:s,end:e};}
  }
  return{costs,dateRange,total:Object.values(costs).reduce((s,v)=>s+v,0)};
}

/* ───────── CHECKS ───────── */
function checkDateAnomalies(ranges){
  const valid=ranges.filter(r=>r.range);if(valid.length<2)return[];
  const ref=valid[0];
  return valid.slice(1).filter(r=>r.range.start!==ref.range.start||r.range.end!==ref.range.end).map(r=>`⚠️ ${r.label} : ${fmtDate(r.range.start)}→${fmtDate(r.range.end)} ≠ ${ref.label} : ${fmtDate(ref.range.start)}→${fmtDate(ref.range.end)}`);
}
function checkHistoryGap(history,newStart){
  const last=[...history].filter(h=>!h.is_ytd).sort((a,b)=>b.week_end.localeCompare(a.week_end))[0];
  if(!last)return null;
  const exp=addDays(last.week_end,1);
  if(newStart>exp)return`⚠️ Gap : dernière semaine en base jusqu'au ${fmtDate(last.week_end)}. Import commence le ${fmtDate(newStart)}. Il manque du ${fmtDate(exp)} au ${fmtDate(addDays(newStart,-1))}.`;
  return null;
}

/* ───────── FORMATTERS ───────── */
const fmt=n=>{if(n==null||isNaN(n))return"–";if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e4)return Math.round(n/1e3)+"k";return Math.round(n).toLocaleString("fr-FR");};
const pct=n=>n==null||isNaN(n)?"–":(n*100).toFixed(2)+"%";
const euro=n=>n==null||isNaN(n)?"–":Math.round(n).toLocaleString("fr-FR")+" €";


/* ───────── PDF EXPORT ───────── */
async function loadScript(src){
  return new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`)){res();return;}
    const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
  });
}

async function exportPDF(periodLabel,pdfRef){
  if(!pdfRef.current)return;
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  const{jsPDF}=window.jspdf;

  const A4_W=210,A4_H=297,MARGIN=12,MINI_H=14;
  const contentW=A4_W-MARGIN*2;
  const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});

  const addMiniHeader=(first)=>{
    pdf.setFillColor(27,42,74);
    pdf.rect(0,0,210,first?28:MINI_H,"F");
    pdf.setTextColor(255,255,255);
    if(first){
      pdf.setFontSize(14);pdf.setFont("helvetica","bold");
      pdf.text("Dashboard E-commerce · BestMobilier",MARGIN,12);
      pdf.setFontSize(9);pdf.setFont("helvetica","normal");
      pdf.text(periodLabel,MARGIN,20);
    } else {
      pdf.setFontSize(7);pdf.setFont("helvetica","normal");
      pdf.text(`BestMobilier · ${periodLabel}`,MARGIN,9);
    }
    pdf.setTextColor(0,0,0);
  };

  addMiniHeader(true);
  let curY=32;
  let firstPage=true;

  // Collect all granular pdf elements (data-pdf-block = fine-grained, data-pdf-section = coarse fallback)
  const els=Array.from(pdfRef.current.querySelectorAll("[data-pdf-block],[data-pdf-section]"));

  for(const el of els){
    // Skip data-pdf-section if it contains data-pdf-blocks (avoid double rendering)
    if(el.hasAttribute("data-pdf-section")&&el.querySelector("[data-pdf-block]"))continue;

    const canvas=await window.html2canvas(el,{scale:2,useCORS:true,backgroundColor:"#ffffff",logging:false});
    const imgW=contentW;
    const imgH=(canvas.height/canvas.width)*imgW;

    // If doesn't fit → new page
    if(curY+imgH>A4_H-MARGIN){
      pdf.addPage();firstPage=false;
      addMiniHeader(false);
      curY=MINI_H+4;
    }

    pdf.addImage(canvas.toDataURL("image/png"),"PNG",MARGIN,curY,imgW,imgH);
    curY+=imgH+5;
  }

  pdf.save(`BestMobilier_${periodLabel.replace(/[^a-zA-Z0-9]/g,"_")}.pdf`);
}

/* ───────── COMPONENTS ───────── */
function DropZone({label,hint,icon,loaded,fileName,dateRange,onFiles,accept,color=C.blue}){
  const[drag,setDrag]=useState(false);
  const onDO=useCallback(e=>{e.preventDefault();setDrag(true);},[]);
  const onDL=useCallback(e=>{e.preventDefault();setDrag(false);},[]);
  const onDP=useCallback(e=>{e.preventDefault();setDrag(false);const f=[...e.dataTransfer.files];if(f.length)onFiles(f);},[onFiles]);
  const onClick=useCallback(()=>{const i=document.createElement("input");i.type="file";i.accept=accept;i.onchange=e=>{const f=[...e.target.files];if(f.length)onFiles(f);};i.click();},[accept,onFiles]);
  return(
    <div onClick={onClick} onDragOver={onDO} onDragLeave={onDL} onDrop={onDP}
      style={{flex:1,minWidth:150,padding:"16px 12px",borderRadius:14,border:`2.5px dashed ${loaded?C.teal:drag?color:C.border}`,background:loaded?"#F0FDF4":drag?"#EFF6FF":C.card,cursor:"pointer",transition:"all 0.2s",textAlign:"center",transform:drag?"scale(1.02)":"scale(1)"}}>
      <div style={{fontSize:26,marginBottom:3}}>{loaded?"✅":icon}</div>
      <div style={{fontSize:12,fontWeight:700,color:loaded?C.teal:C.text}}>{label}</div>
      <div style={{fontSize:10,color:C.textLight,marginTop:3,lineHeight:1.4}}>{hint}</div>
      {fileName&&<div style={{marginTop:4,fontSize:9,color:C.teal,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fileName}</div>}
      {dateRange&&<div style={{marginTop:3,fontSize:9,color,fontWeight:700}}>{fmtDate(dateRange.start)} → {fmtDate(dateRange.end)}</div>}
      {!loaded&&<div style={{fontSize:10,color,marginTop:5,fontWeight:600}}>Glisser ici ou cliquer</div>}
    </div>
  );
}

function KpiCard({label,value,borderColor=C.blue,sub}){
  return(
    <div style={{background:C.card,borderRadius:12,padding:"12px 16px",borderTop:`3px solid ${borderColor}`,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",flex:1,minWidth:100}}>
      <div style={{fontSize:9,color:C.textLight,fontWeight:600,textTransform:"uppercase",letterSpacing:0.3}}>{label}</div>
      <div style={{fontSize:21,fontWeight:700,color:C.navy,marginTop:5}}>{value}</div>
      {sub&&<div style={{fontSize:9,color:C.textLight,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function Alert({type="warn",children}){
  const bg=type==="error"?"#FEF2F2":type==="ok"?"#F0FDF4":"#FFFBEB";
  const color=type==="error"?C.red:type==="ok"?C.teal:C.yellow;
  return<div style={{background:bg,border:`1px solid ${color}40`,borderRadius:10,padding:"10px 14px",fontSize:12,color,fontWeight:500,marginBottom:10}}>{children}</div>;
}

function TableBlock({title,subtitle,titleColor,products,showCost=false}){
  if(!products||products.length===0)return null;
  return(
    <div data-pdf-block style={{marginBottom:18}}>
      <div style={{fontSize:12,fontWeight:700,color:titleColor,marginBottom:3}}>{title}</div>
      {subtitle&&<div style={{fontSize:10,color:C.textLight,marginBottom:7}}>{subtitle}</div>}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead>
            <tr style={{borderBottom:`2px solid ${C.navy}`}}>
              {["#","Produit","Vues","ATC","Taux ATC","Achats","Conv.",...(showCost?["Coût Ads"]:[])].map((h,i)=>(
                <th key={i} style={{textAlign:i<2?"left":"right",padding:"7px 5px",color:C.navy,fontWeight:700}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((p,i)=>{
              const atcR=p.views>0?p.atc/p.views:0;
              const convR=p.views>0?p.purchases/p.views:0;
              return(
                <tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#FAFBFC":C.card}}>
                  <td style={{padding:"5px",color:C.textLight,fontSize:10}}>{i+1}</td>
                  <td style={{padding:"5px",fontWeight:500,maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${p.name} (${p.itemId})`}>
                    {p.name||p.itemId}<span style={{fontSize:9,color:C.textLight,marginLeft:5}}>({p.itemId})</span>
                  </td>
                  <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:C.navy}}>{fmt(p.views)}</td>
                  <td style={{padding:"5px",textAlign:"right"}}>{fmt(p.atc)}</td>
                  <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:atcR>0.04?C.green:atcR<0.02?C.red:C.text}}>{pct(atcR)}</td>
                  <td style={{padding:"5px",textAlign:"right",fontWeight:600,color:p.purchases>0?C.teal:C.red}}>{p.purchases}</td>
                  <td style={{padding:"5px",textAlign:"right",color:convR>0.01?C.green:C.text}}>{pct(convR)}</td>
                  {showCost&&<td style={{padding:"5px",textAlign:"right",color:C.orange,fontWeight:500}}>{p.cost>0?euro(p.cost):"–"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HistoryChart({history}){
  const[active,setActive]=useState("all_views");
  const metrics=[{key:"all_views",label:"Vues",color:C.blue,fn:fmt},{key:"all_purchases",label:"Achats",color:C.teal,fn:v=>v},{key:"google_spend",label:"Google €",color:C.orange,fn:v=>Math.round(v)+"€"},{key:"meta_spend",label:"Meta €",color:C.purple,fn:v=>Math.round(v)+"€"}];
  const m=metrics.find(x=>x.key===active);
  const vals=history.map(w=>w[active]||0);const mx=Math.max(...vals,1);
  const W=600,H=140,pL=50,pR=20,pT=10,pB=30,n=history.length;
  const pts=history.map((w,i)=>({x:n===1?pL+(W-pL-pR)/2:pL+i*(W-pL-pR)/(n-1),y:pT+(1-(w[active]||0)/mx)*(H-pT-pB),w}));
  return(
    <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.navy}}>Historique · {history.length} semaine(s)</div>
        <div style={{display:"flex",gap:6}}>{metrics.map(x=>(<button key={x.key} onClick={()=>setActive(x.key)} style={{fontSize:10,padding:"4px 10px",borderRadius:20,border:"none",cursor:"pointer",fontWeight:600,background:active===x.key?x.color:C.bg,color:active===x.key?"#fff":C.textLight}}>{x.label}</button>))}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
        {[0,.25,.5,.75,1].map(t=>{const y=pT+t*(H-pT-pB);return<line key={t} x1={pL} x2={W-pR} y1={y} y2={y} stroke={C.border} strokeWidth="1"/>;}) }
        {[0,.5,1].map(t=>{const y=pT+t*(H-pT-pB);const v=mx*(1-t);return<text key={t} x={pL-4} y={y+4} textAnchor="end" fontSize="9" fill={C.textLight}>{m.fn(Math.round(v))}</text>;}) }
        {pts.length>1&&<polyline points={pts.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={m.color} strokeWidth="2.5" strokeLinejoin="round"/>}
        {pts.map((p,i)=>(<g key={i}><circle cx={p.x} cy={p.y} r="4" fill={m.color}/><text x={p.x} y={H-4} textAnchor="middle" fontSize="8" fill={C.textLight}>{fmtDate(p.w.week_start).slice(0,5)}</text></g>))}
      </svg>
    </div>
  );
}


/* ───────── AGGREGATE PRODUCT ROWS FROM SNAPSHOTS ───────── */
function aggregateSnapshots(snaps){
  // Merge product_rows from multiple snapshots, summing numeric fields per itemId
  const map={};
  for(const snap of snaps){
    const rows=snap.product_rows||[];
    for(const r of rows){
      const id=r.itemId||r.item_id||"";
      if(!id)continue;
      if(!map[id])map[id]={itemId:id,name:r.name||"",allViews:0,allAtc:0,allPurch:0,paidViews:0,paidAtc:0,paidPurch:0,orgViews:0,orgAtc:0,orgPurch:0,cost:0};
      const e=map[id];
      e.allViews+=r.allViews||0; e.allAtc+=r.allAtc||0; e.allPurch+=r.allPurch||0;
      e.paidViews+=r.paidViews||0; e.paidAtc+=r.paidAtc||0; e.paidPurch+=r.paidPurch||0;
      e.orgViews+=r.orgViews||0; e.orgAtc+=r.orgAtc||0; e.orgPurch+=r.orgPurch||0;
      e.cost+=r.cost||0;
    }
  }
  const products=Object.values(map);
  const totals={allViews:0,allAtc:0,allPurch:0,paidViews:0,paidAtc:0,paidPurch:0,orgViews:0,orgAtc:0,orgPurch:0};
  products.forEach(r=>{
    totals.allViews+=r.allViews; totals.allAtc+=r.allAtc; totals.allPurch+=r.allPurch;
    totals.paidViews+=r.paidViews; totals.paidAtc+=r.paidAtc; totals.paidPurch+=r.paidPurch;
    totals.orgViews+=r.orgViews; totals.orgAtc+=r.orgAtc; totals.orgPurch+=r.orgPurch;
  });
  // Aggregate spend
  const googleSpend=snaps.reduce((s,sn)=>s+(sn.google_spend||0),0);
  const metaSpend=snaps.reduce((s,sn)=>s+(sn.meta_spend||0),0);
  return{products,totals,googleSpend,metaSpend};
}

/* ───────── HISTORY SELECTOR ───────── */
function HistorySelector({weeklyHist,ytdSnap,selectedSnaps,setSelectedSnaps,onAnalyse}){
  const toggleWeek=id=>{
    setSelectedSnaps(prev=>{
      const next=new Set(prev);
      // YTD and weekly are mutually exclusive
      if(ytdSnap&&id===ytdSnap.id){return new Set([id]);}
      // Remove YTD if selecting a week
      if(ytdSnap)next.delete(ytdSnap.id);
      if(next.has(id))next.delete(id);else next.add(id);
      return next;
    });
  };

  const selectYTD=()=>{if(ytdSnap)setSelectedSnaps(new Set([ytdSnap.id]));};
  const clearAll=()=>setSelectedSnaps(new Set());

  // Check consecutiveness
  const selectedWeeks=weeklyHist.filter(s=>selectedSnaps.has(s.id)).sort((a,b)=>a.week_start.localeCompare(b.week_start));
  let gapError=null;
  for(let i=1;i<selectedWeeks.length;i++){
    const prev=selectedWeeks[i-1];const curr=selectedWeeks[i];
    const expected=addDays(prev.week_end,1);
    if(curr.week_start>expected){gapError=`⚠️ Semaines non consécutives : gap entre ${fmtDate(prev.week_end)} et ${fmtDate(curr.week_start)}`;break;}
  }

  const isYTDSelected=ytdSnap&&selectedSnaps.has(ytdSnap.id);
  const count=selectedSnaps.size;
  const canAnalyse=count>0&&!gapError;

  return(
    <div style={{background:C.card,borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.07)",marginBottom:20,border:`2px solid ${C.blue}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:C.navy}}>📂 Analyser depuis la base</div>
          <div style={{fontSize:10,color:C.textLight,marginTop:2}}>Sélectionne une ou plusieurs semaines consécutives — les données seront cumulées</div>
        </div>
        {count>0&&<button onClick={clearAll} style={{fontSize:10,padding:"4px 10px",borderRadius:20,border:`1px solid ${C.red}`,cursor:"pointer",background:"#FEF2F2",color:C.red,fontWeight:600}}>Effacer</button>}
      </div>

      {/* Weekly checkboxes */}
      {weeklyHist.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
          {weeklyHist.map(s=>{
            const sel=selectedSnaps.has(s.id)&&!isYTDSelected;
            return(
              <div key={s.id} onClick={()=>toggleWeek(s.id)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",borderRadius:10,border:`2px solid ${sel?C.blue:C.border}`,background:sel?"#EFF6FF":C.bg,cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${sel?C.blue:C.border}`,background:sel?C.blue:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {sel&&<div style={{width:8,height:8,borderRadius:2,background:"#fff"}}/>}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,fontWeight:700,color:sel?C.blue:C.navy}}>Semaine {fmtDate(s.week_start)} → {fmtDate(s.week_end)}</div>
                  <div style={{fontSize:9,color:C.textLight}}>{fmt(s.all_views)} vues · {s.all_purchases} achats · Google {euro(s.google_spend)} · Meta {euro(s.meta_spend)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* YTD option — mutually exclusive with weeks */}
      {ytdSnap&&(
        <div onClick={selectYTD}
          style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",borderRadius:10,border:`2px solid ${isYTDSelected?C.navy:C.border}`,background:isYTDSelected?"#1B2A4A":"#F8FAFC",cursor:"pointer",marginBottom:12}}>
          <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${isYTDSelected?"#fff":C.border}`,background:isYTDSelected?"#fff":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            {isYTDSelected&&<div style={{width:8,height:8,borderRadius:2,background:C.navy}}/>}
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:isYTDSelected?"#fff":C.navy}}>YTD — {fmtDate(ytdSnap.week_start)} → {fmtDate(ytdSnap.week_end)}</div>
            <div style={{fontSize:9,color:isYTDSelected?"#94A3B8":C.textLight}}>{fmt(ytdSnap.all_views)} vues · {ytdSnap.all_purchases} achats · Google {euro(ytdSnap.google_spend)} · Meta {euro(ytdSnap.meta_spend)}</div>
          </div>
        </div>
      )}

      {/* Gap error */}
      {gapError&&<div style={{background:"#FEF2F2",border:`1px solid ${C.red}40`,borderRadius:8,padding:"8px 12px",fontSize:11,color:C.red,fontWeight:500,marginBottom:10}}>{gapError}</div>}

      {/* CTA */}
      {canAnalyse&&(
        <button onClick={onAnalyse}
          style={{fontSize:12,fontWeight:700,padding:"9px 22px",borderRadius:8,border:"none",cursor:"pointer",background:C.blue,color:"#fff"}}>
          Analyser {isYTDSelected?"YTD":`${count} semaine${count>1?"s":""}`} →
        </button>
      )}
    </div>
  );
}


/* ───────── ABANDON TABLE ───────── */
function AbandonTable({products,showCost=false}){
  if(!products||products.length===0)return null;
  return(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead>
          <tr style={{borderBottom:`2px solid ${C.navy}`}}>
            {["#","Produit","ATC","Achats","Abandons","Taux abandon",...(showCost?["Coût Ads"]:[])].map((h,i)=>(
              <th key={i} style={{textAlign:i<2?"left":"right",padding:"7px 5px",color:C.navy,fontWeight:700}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p,i)=>(
            <tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#FAFBFC":C.card}}>
              <td style={{padding:"5px",color:C.textLight,fontSize:10}}>{i+1}</td>
              <td style={{padding:"5px",fontWeight:500,maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${p.name} (${p.itemId})`}>
                {p.name||p.itemId}<span style={{fontSize:9,color:C.textLight,marginLeft:5}}>({p.itemId})</span>
              </td>
              <td style={{padding:"5px",textAlign:"right",color:C.navy,fontWeight:600}}>{fmt(p.atc)}</td>
              <td style={{padding:"5px",textAlign:"right",color:p.purchases>0?C.teal:C.red,fontWeight:600}}>{p.purchases}</td>
              <td style={{padding:"5px",textAlign:"right",fontWeight:700,color:C.orange}}>{fmt(p.abandon)}</td>
              <td style={{padding:"5px",textAlign:"right",fontWeight:700,color:p.abandonRate>0.9?C.red:p.abandonRate>0.7?C.orange:C.yellow}}>{pct(p.abandonRate)}</td>
              {showCost&&<td style={{padding:"5px",textAlign:"right",color:C.orange,fontWeight:500}}>{p.cost>0?euro(p.cost):"–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────── MAIN ───────── */
export default function Dashboard(){
  const[ga4,setGa4]=useState(null);const[gAds,setGAds]=useState(null);const[meta,setMeta]=useState(null);
  const[ga4File,setGa4File]=useState(null);const[gAdsFile,setGAdsFile]=useState(null);const[metaFile,setMetaFile]=useState(null);
  const[isYTD,setIsYTD]=useState(false);
  const[history,setHistory]=useState([]);const[histLoading,setHistLoading]=useState(true);
  const[saveStatus,setSaveStatus]=useState(null);const[saveMsg,setSaveMsg]=useState("");
  const[gapWarn,setGapWarn]=useState(null);const[dateAnom,setDateAnom]=useState([]);
  const[pdfLoading,setPdfLoading]=useState(false);
  const pdfRef=useRef(null);
  const[selectedSnaps,setSelectedSnaps]=useState(new Set());
  const[histMode,setHistMode]=useState(false); // true = analyse depuis la base
  const[importMode,setImportMode]=useState(false); // true = user clicked "Importer"
  const[histAnalysis,setHistAnalysis]=useState(null); // analysis from base
  const[histPeriodLabel,setHistPeriodLabel]=useState("");

  useEffect(()=>{loadHistory().then(r=>setHistory(r||[])).catch(console.error).finally(()=>setHistLoading(false));},[]);

  const handleGA4=useCallback(files=>{
    const file=files[0],r=new FileReader();
    r.onload=e=>{const res=parseGA4(e.target.result);if(res&&res.products.length>0){setGa4(res);setGa4File(file.name);if(res.dateRange)setIsYTD(daysBetween(res.dateRange.start,res.dateRange.end)>10);}else alert("Format non reconnu.");};
    r.readAsText(file);
  },[]);

  const handleGoogleAds=useCallback(files=>{
    const file=files[0],r=new FileReader();
    r.onload=e=>{const res=parseGoogleAds(e.target.result);if(Object.keys(res.costs).length>0){setGAds(res);setGAdsFile(file.name);}else{const r2=new FileReader();r2.onload=e2=>{const res2=parseGoogleAds(e2.target.result);setGAds(res2);setGAdsFile(file.name);};r2.readAsText(file,"utf-8");}};
    r.readAsText(file,"utf-16");
  },[]);

  const handleMeta=useCallback(files=>{
    const file=files[0];
    // Try latin1 first (weekly export), fallback utf-8 (YTD export with BOM)
    const tryParse=(text)=>{
      const res=parseMeta(text);
      // Validate: if total>0 we got real data
      if(res.total>0){setMeta(res);setMetaFile(file.name);return true;}
      return false;
    };
    const r=new FileReader();
    r.onload=e=>{
      if(!tryParse(e.target.result)){
        const r2=new FileReader();
        r2.onload=e2=>{tryParse(e2.target.result)||(setMeta({costs:{},dateRange:null,total:0}),setMetaFile(file.name));};
        r2.readAsText(file,"utf-8");
      }
    };
    r.readAsText(file,"latin1");
  },[]);

  useEffect(()=>{
    setDateAnom(checkDateAnomalies([{label:"GA4",range:ga4?.dateRange},{label:"Google Ads",range:gAds?.dateRange},{label:"Meta",range:meta?.dateRange}]));
    if(ga4?.dateRange)setGapWarn(checkHistoryGap(history,ga4.dateRange.start));
  },[ga4,gAds,meta,history]);

  const handleSave=useCallback(async()=>{
    if(!ga4)return;setSaveStatus("saving");
    try{
      const t=ga4.totals;
      await upsertSnapshot({week_start:ga4.dateRange.start,week_end:ga4.dateRange.end,is_ytd:isYTD,source:isYTD?"ytd_seed":"manual",all_views:t.allViews,all_atc:t.allAtc,all_purchases:t.allPurch,paid_views:t.paidViews,paid_atc:t.paidAtc,paid_purchases:t.paidPurch,org_views:t.orgViews,org_atc:t.orgAtc,org_purchases:t.orgPurch,google_spend:Math.round((gAds?.total||0)*100)/100,meta_spend:Math.round((meta?.total||0)*100)/100,product_rows:ga4.products.map(r=>({...r,cost:Math.round(((gAds?.costs?.[r.itemId]||0)+(meta?.costs?.[r.itemId]||0))*100)/100}))});
      const upd=await loadHistory();setHistory(upd||[]);
      setSaveStatus("ok");setSaveMsg(`✅ ${isYTD?"YTD":"Semaine"} ${fmtDate(ga4.dateRange.start)}→${fmtDate(ga4.dateRange.end)} sauvegardée`);
    }catch(e){setSaveStatus("error");setSaveMsg("❌ "+e.message);}
    setTimeout(()=>{setSaveStatus(null);setSaveMsg("");},5000);
  },[ga4,gAds,meta,isYTD]);


  const handleHistAnalyse=useCallback(()=>{
    const snaps=[...history].filter(h=>selectedSnaps.has(h.id));
    if(snaps.length===0)return;
    const{products,totals,googleSpend,metaSpend}=aggregateSnapshots(snaps);
    // Build period label
    const sorted=snaps.sort((a,b)=>a.week_start.localeCompare(b.week_start));
    const label=snaps.length===1&&snaps[0].is_ytd
      ? `YTD ${fmtDate(snaps[0].week_start)}→${fmtDate(snaps[0].week_end)}`
      : `${fmtDate(sorted[0].week_start)} → ${fmtDate(sorted[sorted.length-1].week_end)} (${snaps.length} semaine${snaps.length>1?"s":""})`;
    setHistPeriodLabel(label);
    // Build fake ga4-like structure for analysis useMemo
    setHistAnalysis({products,totals,googleSpend,metaSpend});
    setHistMode(true);
  },[history,selectedSnaps]);

  const analysis=useMemo(()=>{
    // Source: either live import (ga4) or history selection (histAnalysis)
    const src=histMode&&histAnalysis?histAnalysis:ga4?{products:ga4.products,totals:ga4.totals,googleSpend:gAds?.total||0,metaSpend:meta?.total||0}:null;
    if(!src)return null;
    const t=src.totals;
    // Build cost lookup: in histMode use stored cost from product_rows, otherwise live files
    const costMap={};
    if(histMode&&histAnalysis){
      histAnalysis.products.forEach(r=>{if(r.cost>0)costMap[r.itemId]=r.cost;});
    }
    const getCost=id=>{
      if(histMode&&histAnalysis)return costMap[id]||0;
      return(gAds?.costs?.[id]||0)+(meta?.costs?.[id]||0);
    };

    // ORGANIC
    const orgAll=src.products.filter(r=>(r.orgViews||0)>0)
      .map(r=>({itemId:r.itemId,name:r.name,views:r.orgViews||0,atc:r.orgAtc||0,purchases:r.orgPurch||0,cost:getCost(r.itemId),totalPurch:(r.allPurch||0)+(r.orgPurch||0)+(r.paidPurch||0)}))
      .sort((a,b)=>b.views-a.views);
    const orgTop20=orgAll.slice(0,20);
    const orgTop20Ids=new Set(orgTop20.map(p=>p.itemId));
    const orgBestConv=orgAll.filter(p=>p.views>=20&&p.purchases>0).sort((a,b)=>(b.purchases/b.views)-(a.purchases/a.views)).slice(0,10);
    const orgZeroConv=orgAll.filter(p=>p.views>=50&&p.totalPurch===0&&!orgTop20Ids.has(p.itemId)).slice(0,15);

    // PAID
    const paidAll=src.products.filter(r=>(r.paidViews||0)>0)
      .map(r=>({itemId:r.itemId,name:r.name,views:r.paidViews||0,atc:r.paidAtc||0,purchases:r.paidPurch||0,cost:getCost(r.itemId),totalPurch:(r.allPurch||0)+(r.orgPurch||0)+(r.paidPurch||0)}))
      .sort((a,b)=>b.views-a.views);
    const paidTop20=paidAll.slice(0,20);
    const paidTop20Ids=new Set(paidTop20.map(p=>p.itemId));
    const paidBestConv=paidAll.filter(p=>p.views>=20&&p.purchases>0).sort((a,b)=>(b.purchases/b.views)-(a.purchases/a.views)).slice(0,10);
    const paidZeroConv=paidAll.filter(p=>p.views>=50&&p.totalPurch===0&&!paidTop20Ids.has(p.itemId)).slice(0,15);

    // ABANDON PANIER : produits avec le plus d'ATC sans achat, par canal
    // Organic abandon
    const orgAbandon=src.products
      .filter(r=>(r.orgAtc||0)>=10)
      .map(r=>({itemId:r.itemId,name:r.name,
        atc:r.orgAtc||0,purchases:r.orgPurch||0,
        abandon:(r.orgAtc||0)-(r.orgPurch||0),
        abandonRate:(r.orgAtc||0)>0?((r.orgAtc||0)-(r.orgPurch||0))/(r.orgAtc||0):0,
        cost:getCost(r.itemId)}))
      .sort((a,b)=>b.abandon-a.abandon).slice(0,15);

    // Paid abandon
    const paidAbandon=src.products
      .filter(r=>(r.paidAtc||0)>=10)
      .map(r=>({itemId:r.itemId,name:r.name,
        atc:r.paidAtc||0,purchases:r.paidPurch||0,
        abandon:(r.paidAtc||0)-(r.paidPurch||0),
        abandonRate:(r.paidAtc||0)>0?((r.paidAtc||0)-(r.paidPurch||0))/(r.paidAtc||0):0,
        cost:getCost(r.itemId)}))
      .sort((a,b)=>b.abandon-a.abandon).slice(0,15);

    // WASTEFUL: spend > 20€, 0 achat toutes sources
    const wasteful=src.products.map(r=>({itemId:r.itemId,name:r.name,views:r.paidViews||0,atc:r.paidAtc||0,purchases:(r.allPurch||0)+(r.orgPurch||0)+(r.paidPurch||0),cost:getCost(r.itemId)})).filter(p=>p.cost>20&&p.purchases===0).sort((a,b)=>b.cost-a.cost).slice(0,10);

    return{
      allViews:t.allViews,allAtcRate:t.allViews>0?t.allAtc/t.allViews:0,allConvRate:t.allViews>0?t.allPurch/t.allViews:0,allPurch:t.allPurch,
      orgViews:t.orgViews,orgAtcRate:t.orgViews>0?t.orgAtc/t.orgViews:0,orgConvRate:t.orgViews>0?t.orgPurch/t.orgViews:0,orgPurch:t.orgPurch,orgShare:t.allViews>0?t.orgViews/t.allViews:0,
      paidViews:t.paidViews,paidAtcRate:t.paidViews>0?t.paidAtc/t.paidViews:0,paidConvRate:t.paidViews>0?t.paidPurch/t.paidViews:0,paidPurch:t.paidPurch,paidShare:t.allViews>0?t.paidViews/t.allViews:0,
      totalGCost:histMode&&histAnalysis?histAnalysis.googleSpend:(gAds?.total||0),totalMCost:histMode&&histAnalysis?histAnalysis.metaSpend:(meta?.total||0),
      orgTop20,orgBestConv,orgZeroConv,orgAbandon,
      paidTop20,paidBestConv,paidZeroConv,wasteful,paidAbandon,
    };
  },[ga4,gAds,meta,histMode,histAnalysis]);

  const hasCosts=histMode?(histAnalysis&&(histAnalysis.googleSpend>0||histAnalysis.metaSpend>0)):(gAds||meta);
  const weeklyHist=useMemo(()=>history.filter(h=>!h.is_ytd).sort((a,b)=>a.week_start.localeCompare(b.week_start)),[history]);
  const ytdSnap=useMemo(()=>history.find(h=>h.is_ytd),[history]);

  // Home screen: show when no data loaded and not in histMode
  const showHome = !ga4 && !histMode && !histAnalysis && !importMode;

  if(showHome){
    return(
      <div style={{fontFamily:"-apple-system,'Segoe UI',sans-serif",background:C.navy,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
        {/* Logo bar */}
        <div style={{padding:"24px 36px"}}>
          <div style={{fontSize:18,fontWeight:700,color:"#fff"}}>BestMobilier</div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>Dashboard E-commerce</div>
        </div>

        {/* Split hero */}
        <div style={{flex:1,display:"flex",gap:0,padding:"0 36px 48px"}}>
          {/* Left: Import */}
          <div onClick={()=>setImportMode(true)}
            style={{flex:1,background:"#243556",borderRadius:"16px 0 0 16px",padding:"48px 40px",cursor:"pointer",transition:"background 0.2s",display:"flex",flexDirection:"column",justifyContent:"space-between",borderRight:"1px solid rgba(255,255,255,0.08)"}}
            onMouseEnter={e=>e.currentTarget.style.background="#2d4268"}
            onMouseLeave={e=>e.currentTarget.style.background="#243556"}>
            <div>
              <div style={{fontSize:48,marginBottom:20}}>📥</div>
              <div style={{fontSize:22,fontWeight:700,color:"#fff",marginBottom:12}}>Importer des données</div>
              <div style={{fontSize:13,color:"#94A3B8",lineHeight:1.6}}>
                Glisse tes exports GA4, Google Ads et Meta Ads pour analyser une nouvelle semaine ou initialiser le YTD.
              </div>
            </div>
            <div style={{marginTop:32}}>
              <div style={{display:"inline-flex",alignItems:"center",gap:8,background:C.blue,color:"#fff",padding:"12px 24px",borderRadius:10,fontSize:13,fontWeight:700}}>
                Importer une période →
              </div>
            </div>
          </div>

          {/* Right: Visualise base */}
          <div onClick={()=>{if(weeklyHist.length>0||ytdSnap){setHistMode(true);}}}
            style={{flex:1,background:weeklyHist.length===0&&!ytdSnap?"#1e2d46":"#243556",borderRadius:"0 16px 16px 0",padding:"48px 40px",cursor:weeklyHist.length===0&&!ytdSnap?"not-allowed":"pointer",transition:"background 0.2s",display:"flex",flexDirection:"column",justifyContent:"space-between",opacity:weeklyHist.length===0&&!ytdSnap?0.5:1}}
            onMouseEnter={e=>{if(weeklyHist.length>0||ytdSnap)e.currentTarget.style.background="#2d4268";}}
            onMouseLeave={e=>e.currentTarget.style.background="#243556"}>
            <div>
              <div style={{fontSize:48,marginBottom:20}}>📊</div>
              <div style={{fontSize:22,fontWeight:700,color:"#fff",marginBottom:12}}>Visualiser l'historique</div>
              <div style={{fontSize:13,color:"#94A3B8",lineHeight:1.6}}>
                {weeklyHist.length===0&&!ytdSnap
                  ? "Aucune donnée en base. Commence par importer une première période."
                  : `${weeklyHist.length} semaine${weeklyHist.length>1?"s":""} en base${ytdSnap?" · YTD disponible":""} — sélectionne une période pour afficher les analyses.`
                }
              </div>
            </div>
            {(weeklyHist.length>0||ytdSnap)&&(
              <div style={{marginTop:32}}>
                <div style={{display:"inline-flex",alignItems:"center",gap:8,background:C.teal,color:"#fff",padding:"12px 24px",borderRadius:10,fontSize:13,fontWeight:700}}>
                  Analyser la base →
                </div>
              </div>
            )}
          </div>
        </div>

        {histLoading&&<div style={{textAlign:"center",padding:20,color:"#94A3B8",fontSize:12}}>Chargement de l'historique…</div>}
      </div>
    );
  }

  return(
    <div style={{fontFamily:"-apple-system,'Segoe UI',sans-serif",background:C.bg,minHeight:"100vh"}}>

      {/* Header */}
      <div style={{background:C.navy,padding:"16px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:"#FFF"}}>Dashboard E-commerce · BestMobilier</div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:2,display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>{setGa4(null);setGAds(null);setMeta(null);setHistMode(false);setHistAnalysis(null);setSelectedSnaps(new Set());setImportMode(false);}} style={{fontSize:10,padding:"3px 10px",borderRadius:20,border:"1px solid #94A3B8",cursor:"pointer",fontWeight:600,background:"transparent",color:"#94A3B8"}}>← Accueil</button>
            <button onClick={()=>{setHistMode(false);setHistAnalysis(null);}} style={{fontSize:10,padding:"3px 10px",borderRadius:20,border:"none",cursor:"pointer",fontWeight:600,background:!histMode?"#3266AD":"transparent",color:!histMode?"#fff":"#94A3B8"}}>Import</button>
            <button onClick={()=>setHistMode(true)} style={{fontSize:10,padding:"3px 10px",borderRadius:20,border:"none",cursor:"pointer",fontWeight:600,background:histMode?"#3266AD":"transparent",color:histMode?"#fff":"#94A3B8"}}>Analyser base</button>
          </div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>{weeklyHist.length} semaine(s) en base{ytdSnap?` · YTD ${fmtDate(ytdSnap.week_start)}→${fmtDate(ytdSnap.week_end)}`:""}</div>
        </div>
        {(ga4||histAnalysis)&&(
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {!histMode&&<label style={{fontSize:11,color:"#94A3B8",display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
              <input type="checkbox" checked={isYTD} onChange={e=>setIsYTD(e.target.checked)}/>Import YTD
            </label>}
            {!histMode&&<button onClick={handleSave} disabled={saveStatus==="saving"} style={{fontSize:12,fontWeight:700,padding:"8px 18px",borderRadius:8,border:"none",cursor:"pointer",background:saveStatus==="ok"?C.teal:C.blue,color:"#fff"}}>
              {saveStatus==="saving"?"Sauvegarde...":saveStatus==="ok"?"✅ Sauvegardé":"💾 Sauvegarder"}
            </button>}
            <button onClick={async()=>{setPdfLoading(true);try{await exportPDF(histMode?histPeriodLabel:`${isYTD?"YTD":"Semaine"} ${fmtDate(ga4?.dateRange?.start)}→${fmtDate(ga4?.dateRange?.end)}`,pdfRef);}finally{setPdfLoading(false);}}} disabled={pdfLoading}
              style={{fontSize:12,fontWeight:700,padding:"8px 18px",borderRadius:8,border:"none",cursor:"pointer",background:C.purple,color:"#fff"}}>
              {pdfLoading?"Génération...":"📄 Export PDF"}
            </button>
          </div>
        )}
      </div>

      <div style={{maxWidth:1140,margin:"0 auto",padding:"18px 16px 60px"}}>
        {/* PDF content area */}
        <div ref={pdfRef}>

        {/* Drop zones — hidden in histMode */}
        {!histMode&&<div style={{display:"flex",gap:12,marginBottom:14}}>
          <DropZone label="GA4" hint="Export combiné Organic + Paid + All Users (.csv)" icon="📊" loaded={!!ga4} fileName={ga4File} dateRange={ga4?.dateRange} onFiles={handleGA4} accept=".csv" color={C.blue}/>
          <DropZone label="Google Ads" hint="Coûts par produit (.csv UTF-16 TSV)" icon="🎯" loaded={!!gAds} fileName={gAdsFile} dateRange={gAds?.dateRange} onFiles={handleGoogleAds} accept=".csv" color={C.orange}/>
          <DropZone label="Meta Ads" hint="Coûts par produit ID (.csv)" icon="📘" loaded={!!meta} fileName={metaFile} dateRange={meta?.dateRange} onFiles={handleMeta} accept=".csv" color={C.purple}/>
        </div>}

        {/* Alerts */}
        {!histMode&&dateAnom.map((a,i)=><Alert key={i} type="error">{a}</Alert>)}
        {!histMode&&gapWarn&&<Alert type="warn">{gapWarn}</Alert>}
        {saveMsg&&<Alert type={saveStatus==="error"?"error":"ok"}>{saveMsg}</Alert>}

        {histMode&&!histLoading&&(weeklyHist.length>0||ytdSnap)&&(
          <HistorySelector weeklyHist={weeklyHist} ytdSnap={ytdSnap} selectedSnaps={selectedSnaps} setSelectedSnaps={setSelectedSnaps} onAnalyse={handleHistAnalyse}/>
        )}

        {!histMode&&!ga4&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}>
            <div style={{fontSize:48,marginBottom:12}}>📊</div>
            <div style={{fontSize:15,fontWeight:500}}>Glisse ton export GA4 pour commencer</div>
            <div style={{fontSize:12,marginTop:6}}>Google Ads et Meta Ads sont optionnels</div>
          </div>
        )}

        {analysis&&(<>

          {/* Period + KPIs globaux */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.navy}}>{histMode?`📂 ${histPeriodLabel}`:`${isYTD?"📅 YTD":"📅 Semaine"} · ${fmtDate(ga4?.dateRange?.start)} → ${fmtDate(ga4?.dateRange?.end)}`}</div>
          </div>
          <div data-pdf-section style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
            <KpiCard label="Vues (All)" value={fmt(analysis.allViews)} borderColor={C.navy}/>
            <KpiCard label="ATC global" value={pct(analysis.allAtcRate)} borderColor={C.navy}/>
            <KpiCard label="Conv. globale" value={pct(analysis.allConvRate)} borderColor={C.navy}/>
            <KpiCard label="Achats total" value={fmt(analysis.allPurch)} borderColor={C.navy}/>
            <KpiCard label="% Organic" value={pct(analysis.orgShare)} borderColor={C.teal}/>
            <KpiCard label="% Paid" value={pct(analysis.paidShare)} borderColor={C.orange}/>
            {hasCosts&&<KpiCard label="Spend total" value={euro(analysis.totalGCost+analysis.totalMCost)} borderColor={C.red}/>}
            {hasCosts&&analysis.paidPurch>0&&<KpiCard label="CPA moyen" value={euro((analysis.totalGCost+analysis.totalMCost)/analysis.paidPurch)} borderColor={C.orange}/>}
          </div>

          {/* ══ BLOC SEO ══ */}
          <div data-pdf-section style={{background:C.card,borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.07)",marginBottom:20,borderTop:`4px solid ${C.teal}`}}>
            <div data-pdf-block style={{borderLeft:`4px solid ${C.teal}`,paddingLeft:12,marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:700,color:C.teal}}>🌿 SEO — Trafic Organique</div>
              <div style={{fontSize:10,color:C.textLight,marginTop:2}}>{fmt(analysis.orgViews)} vues · ATC {pct(analysis.orgAtcRate)} · Conv. {pct(analysis.orgConvRate)} · {analysis.orgPurch} achats</div>
            </div>
            <div data-pdf-block style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:18}}>
              <KpiCard label="Vues organic" value={fmt(analysis.orgViews)} borderColor={C.teal}/>
              <KpiCard label="Taux ATC" value={pct(analysis.orgAtcRate)} borderColor={C.teal}/>
              <KpiCard label="Taux conv." value={pct(analysis.orgConvRate)} borderColor={C.teal}/>
              <KpiCard label="Achats organic" value={analysis.orgPurch} borderColor={C.teal}/>
            </div>
            <TableBlock title="Top 20 produits · par vues" subtitle="Taux ATC : vert >4%, rouge <2%" titleColor={C.teal} products={analysis.orgTop20}/>
            <TableBlock title="✅ Meilleures conversions · à pousser en SEO" subtitle="≥20 vues, au moins 1 achat, triés par taux de conv." titleColor={C.green} products={analysis.orgBestConv}/>
            <TableBlock title="⚠️ 50+ vues organic · 0 achat · trafic SEO gaspillé" subtitle="Hors Top 20. Pages à optimiser (contenu, prix, CTA)." titleColor={C.red} products={analysis.orgZeroConv}/>
            {analysis.orgAbandon.length>0&&(
              <div data-pdf-block style={{marginBottom:18}}>
                <div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:3}}>🛒 Paniers abandonnés organic · Top 15 par volume</div>
                <div style={{fontSize:10,color:C.textLight,marginBottom:7}}>≥10 ATC. Rouge &gt;90% abandon, orange &gt;70%. Trié par nombre d'abandons absolu.</div>
                <AbandonTable products={analysis.orgAbandon}/>
              </div>
            )}
          </div>

          {/* ══ BLOC PAID ══ */}
          <div data-pdf-section style={{background:C.card,borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.07)",marginBottom:20,borderTop:`4px solid ${C.orange}`}}>
            <div data-pdf-block style={{borderLeft:`4px solid ${C.orange}`,paddingLeft:12,marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:700,color:C.orange}}>🎯 Paid — Trafic Publicitaire</div>
              <div style={{fontSize:10,color:C.textLight,marginTop:2}}>{fmt(analysis.paidViews)} vues · ATC {pct(analysis.paidAtcRate)} · Conv. {pct(analysis.paidConvRate)} · {analysis.paidPurch} achats</div>
            </div>
            <div data-pdf-block style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:18}}>
              <KpiCard label="Vues paid" value={fmt(analysis.paidViews)} borderColor={C.orange}/>
              <KpiCard label="Taux ATC" value={pct(analysis.paidAtcRate)} borderColor={C.orange}/>
              <KpiCard label="Taux conv." value={pct(analysis.paidConvRate)} borderColor={C.orange}/>
              <KpiCard label="Achats paid" value={analysis.paidPurch} borderColor={C.orange}/>
              {gAds&&<KpiCard label="Google Ads" value={euro(analysis.totalGCost)} borderColor={C.blue}/>}
              {meta&&<KpiCard label="Meta Ads" value={euro(analysis.totalMCost)} borderColor={C.purple}/>}
              {hasCosts&&analysis.paidPurch>0&&<KpiCard label="CPA" value={euro((analysis.totalGCost+analysis.totalMCost)/analysis.paidPurch)} borderColor={C.red}/>}
            </div>
            <TableBlock title="Top 20 produits · par vues paid" subtitle="Taux ATC : vert >4%, rouge <2%" titleColor={C.orange} products={analysis.paidTop20} showCost={!!hasCosts}/>
            <TableBlock title="✅ Meilleures conversions paid · à scaler" subtitle="≥20 vues paid, au moins 1 achat, triés par taux de conv." titleColor={C.green} products={analysis.paidBestConv} showCost={!!hasCosts}/>
            <TableBlock title="⚠️ 50+ vues paid · 0 achat" subtitle="Hors Top 20. Audience ou landing page à revoir." titleColor={C.red} products={analysis.paidZeroConv} showCost={!!hasCosts}/>
            {analysis.paidAbandon.length>0&&(
              <div data-pdf-block style={{marginBottom:18}}>
                <div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:3}}>🛒 Paniers abandonnés paid · Top 15 par volume</div>
                <div style={{fontSize:10,color:C.textLight,marginBottom:7}}>≥10 ATC. Rouge &gt;90% abandon, orange &gt;70%. Trié par nombre d'abandons absolu.</div>
                <AbandonTable products={analysis.paidAbandon} showCost={!!hasCosts}/>
              </div>
            )}
            <TableBlock title="🔥 Budget gaspillé · >20€ dépensé · 0 achat toutes sources" subtitle="Candidats à couper ou retravailler." titleColor={C.orange} products={analysis.wasteful} showCost={true}/>
          </div>

        </>)}

        </div>{/* end pdfRef */}

        {/* Historique */}
        {!histLoading&&weeklyHist.length>0&&<HistoryChart history={weeklyHist}/>}
        {histLoading&&<div style={{textAlign:"center",padding:20,color:C.textLight,fontSize:12}}>Chargement de l'historique…</div>}

        {/* YTD reference */}
        {ytdSnap&&(
          <div style={{background:C.card,borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",borderTop:`3px solid ${C.navy}`}}>
            <div style={{fontSize:13,fontWeight:700,color:C.navy,marginBottom:12}}>Référence YTD · {fmtDate(ytdSnap.week_start)} → {fmtDate(ytdSnap.week_end)}</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[{label:"Vues",value:fmt(ytdSnap.all_views),color:C.blue},{label:"Achats",value:fmt(ytdSnap.all_purchases),color:C.green},{label:"Conv.",value:pct(ytdSnap.all_views>0?ytdSnap.all_purchases/ytdSnap.all_views:0),color:C.purple},{label:"Google Ads",value:euro(ytdSnap.google_spend),color:C.orange},{label:"Meta Ads",value:euro(ytdSnap.meta_spend),color:C.purple},{label:"CPA",value:ytdSnap.paid_purchases>0?euro((ytdSnap.google_spend+ytdSnap.meta_spend)/ytdSnap.paid_purchases):"–",color:C.orange}].map((k,i)=>(
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
