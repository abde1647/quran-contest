/* Website layer: runs only outside claude.ai. Data stays in this browser (localStorage). */
async function appSave({filename,data}){
  try{const f=new File([data],filename,{type:data.type});
    if(navigator.canShare&&navigator.canShare({files:[f]})&&/iPhone|iPad|Android/i.test(navigator.userAgent)){
      try{await navigator.share({files:[f]});return}catch(e){if(e&&e.name==="AbortError")throw {code:"declined"}}}}catch(e){if(e&&e.code)throw e}
  const a=document.createElement("a");a.href=URL.createObjectURL(data);a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},4000);
}
function appInit(){
  try{if(!localStorage.getItem("qc-cert"))localStorage.setItem("qc-cert",JSON.stringify({org:"مدرسة الإخلاص القرآنية",signerTitle:"مسؤول النشاط",signer:"",date:""}))}catch(e){}
  dl={save:appSave};
  useLocal("");
  document.getElementById("banner").hidden=true;
  setStatus("محفوظ في هذا الجهاز");
  if("serviceWorker" in navigator&&location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
}
let pending=null; // {kind:"excel"|"backup", students, cert?, label}
function dataPanelHTML(){
  const empty=!students.length;
  return `<div class="panel" style="${empty?"border-color:var(--accent);background:var(--accent-soft)":""}">
  <h3>${empty?"ابدأ هنا: أدخل قائمة التلاميذ":"البيانات والنسخ الاحتياطي"}</h3>
  <p class="note">${empty?"استورد ملف الإكسل الخاص بالمسابقة (ورقة لكل قسم: الاسم، الحفظ، التلاوة ابتداءً من السطر 5)، أو أضف التلاميذ يدوياً من صفحة كل قسم.":"البيانات محفوظة في هذا الجهاز فقط. احفظ نسخة احتياطية لحمايتها أو لنقلها إلى جهاز آخر."}</p>
  ${pending?`<p class="banner">${pending.label}</p>`:""}
  <div class="actions">
    ${pending?`<button class="btn" id="dpConfirm">تأكيد ${students.length?"(يستبدل البيانات الحالية)":""}</button><button class="btn ghost" id="dpCancel">إلغاء</button>`:
    `<button class="btn${empty?"":" ghost"}" id="dpExcel">استيراد من ملف Excel</button>
     ${empty?"":`<button class="btn ghost" id="bkExport">حفظ نسخة احتياطية</button>`}
     <button class="btn ghost" id="bkImport">استرجاع نسخة احتياطية</button>`}
    <input type="file" id="dpFile" accept=".xlsx,.xls,.json,application/json" hidden>
  </div></div>`;
}
function bindData(el){
  const q=s=>el.querySelector(s), fi=q("#dpFile"); if(!fi) return;
  let want=null;
  if(q("#dpExcel")) q("#dpExcel").onclick=()=>{want="excel";fi.accept=".xlsx,.xls";fi.click()};
  if(q("#bkImport")) q("#bkImport").onclick=()=>{want="backup";fi.accept=".json,application/json";fi.click()};
  if(q("#bkExport")) q("#bkExport").onclick=async()=>{
    const blob=new Blob([JSON.stringify({app:"quran-contest",version:1,savedAt:new Date().toISOString(),students,cert:certSettings},null,1)],{type:"application/json"});
    try{await appSave({filename:`نسخة-مسابقة-القرآن-${new Date().toISOString().slice(0,10)}.json`,data:blob});setStatus("تم حفظ النسخة الاحتياطية")}catch(e){setStatus("لم يتم الحفظ",true)}};
  if(q("#dpConfirm")) q("#dpConfirm").onclick=()=>{students=pending.students;if(pending.cert)Object.assign(certSettings,pending.cert);
    localSave();try{localStorage.setItem("qc-cert",JSON.stringify(certSettings))}catch(e){}
    setStatus(`تم: ${students.length} تلميذ`);pending=null;render()};
  if(q("#dpCancel")) q("#dpCancel").onclick=()=>{pending=null;render()};
  fi.onchange=async()=>{const f=fi.files[0];fi.value="";if(!f)return;
    try{ if(want==="excel"||/\.xlsx?$/i.test(f.name)) readExcel(await f.arrayBuffer()); else readBackup(await f.text()); }
    catch(e){setStatus(e.message||"تعذرت قراءة الملف",true)} };
}
function readExcel(buf){
  if(!window.XLSX) throw new Error("قارئ ملفات Excel لم يُحمَّل");
  const wb=XLSX.read(buf,{type:"array"}), out=[];let o=1;const found=[];
  for(const sec of SECTIONS){
    const ws=wb.Sheets[sec]; if(!ws) continue; found.push(sec);
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,range:4,blankrows:false,defval:null});
    for(const r of rows){
      const name=r[0]==null?"":String(r[0]).trim();
      if(!name||/^[🥇🥈🥉]/u.test(name)) continue;
      const num=v=>{const n=typeof v==="number"?v:parseFloat(v);return isFinite(n)&&n>=0&&n<=10?n:null};
      out.push({id:"x"+(o)+"-"+Date.now().toString(36),section:sec,name,hifz:num(r[1]),tilawa:num(r[2]),order:o++});
    }
  }
  if(!found.length) throw new Error("لم أجد في الملف أوراقاً بأسماء الأقسام (مثل: الرابعة ابتدائي)");
  pending={kind:"excel",students:out,label:`وُجد ${out.length} تلميذ في ${found.length} أقسام. اضغط «تأكيد» لإدخالهم.`};
  setStatus("راجع ثم أكّد الاستيراد");render();
}
function readBackup(text){
  let o;try{o=JSON.parse(text)}catch(e){o=null}
  if(!o||o.app!=="quran-contest"||!Array.isArray(o.students)) throw new Error("هذا الملف ليس نسخة احتياطية من التطبيق");
  const st=o.students.filter(s=>s&&typeof s.name==="string"&&SECTIONS.includes(s.section));
  pending={kind:"backup",students:st,cert:o.cert&&typeof o.cert==="object"?o.cert:null,label:`نسخة احتياطية فيها ${st.length} تلميذ. اضغط «تأكيد» لاسترجاعها.`};
  render();
}
