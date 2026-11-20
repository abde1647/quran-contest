/* Read-only report views shared by the competition manager and the school viewer:
   top students, statistics with charts, and search. They only read `students`,
   `teachers` and SECTIONS; scoring and ranking come from core.js unchanged. */

function normalizeAr(s) {
  return String(s || "").normalize("NFKD").replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase().trim();
}
function allRanked() {
  return SECTIONS.flatMap(sec => ranked(sec).filter(r => r.name).map(r => ({ ...r, section: sec })));
}
function printBtn() { return `<button class="btn ghost small noprint" data-print type="button">🖨 طباعة / PDF</button>`; }
const fmt = n => (n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1));

/* ---------- top students across all sections ---------- */
function topHTML() {
  const scored = allRanked().filter(r => r.total !== null)
    .sort((a, b) => b.total - a.total || b.hifz - a.hifz || normalizeAr(a.name).localeCompare(normalizeAr(b.name), "ar"));
  const top = scored.slice(0, 20), perfect = scored.filter(r => r.total === 20).length;
  return `<div style="display:grid;gap:14px">
  <div class="row-actions"><div><h2>المتفوقون</h2><p class="sub">أعلى ${top.length} مجموع في المسابقة، من كل الأقسام. الترتيب داخل كل قسم لا يتغيّر.</p></div>${printBtn()}</div>
  <div class="kpis">
    <div class="kpi"><b>${scored.length ? fmt(scored[0].total) : "—"}<small class="of"> /20</small></b><span>أعلى مجموع</span></div>
    <div class="kpi"><b>${perfect}</b><span>علامة كاملة 20/20</span></div>
    <div class="kpi"><b>${scored.filter(r => r.total >= 17).length}</b><span>مجموع 17 فأكثر</span></div>
  </div>
  <div class="tbl"><table>
    <thead><tr><th class="num">#</th><th>التلميذ</th><th>القسم</th><th class="num">الحفظ</th><th class="num">التلاوة</th><th class="num">المجموع /20</th><th>في قسمه</th></tr></thead>
    <tbody>${top.length ? top.map((r, n) => `<tr class="clickable" data-go="s${SECTIONS.indexOf(r.section)}">
      <td class="num pend">${n + 1}</td><td><strong>${esc(r.name)}</strong></td><td>${esc(r.section)}</td>
      <td class="num">${fmt(r.hifz)}</td><td class="num">${fmt(r.tilawa)}</td><td class="num"><strong>${fmt(r.total)}</strong></td>
      <td><span class="pill p${r.rank <= 3 ? r.rank : 0}">${noteFor(r.rank)}</span></td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">لا توجد علامات بعد.</td></tr>`}</tbody>
  </table></div></div>`;
}

/* ---------- statistics with charts (single series, one hue, values labelled) ---------- */
const BANDS = [[0, 5, "[0–5["], [5, 9, "[5–9["], [9, 13, "[9–13["], [13, 17, "[13–17["], [17, 20.01, "[17–20]"]];
function statsHTML() {
  const per = SECTIONS.map(sec => ({ sec, ...stats(sec) }));
  const scored = allRanked().filter(r => r.total !== null);
  const count = per.reduce((a, s) => a + s.count, 0);
  const avg = scored.length ? scored.reduce((a, r) => a + r.total, 0) / scored.length : null;
  const avgH = scored.length ? scored.reduce((a, r) => a + r.hifz, 0) / scored.length : null;
  const avgT = scored.length ? scored.reduce((a, r) => a + r.tilawa, 0) / scored.length : null;
  const bands = BANDS.map(([lo, hi, label]) => ({ label, n: scored.filter(r => r.total >= lo && r.total < hi).length }));
  const bandMax = Math.max(1, ...bands.map(b => b.n));
  const ticks = [0, 5, 10, 15, 20];
  const avgBars = per.map((s, i) => {
    const v = s.avg, w = v == null ? 0 : (v / 20) * 100;
    return `<div class="hrow" data-go="s${i}" title="${esc(s.sec)}: المعدل ${fmt(v)} من 20 · ${s.scored} تلميذ">
      <span class="hl">${esc(s.sec)}</span>
      <span class="htrack">${ticks.map(t => `<i class="tick" style="inset-inline-start:${t * 5}%"></i>`).join("")}<span class="hbar" style="width:${w}%"></span></span>
      <span class="hv">${fmt(v)}</span></div>`;
  }).join("");
  return `<div style="display:grid;gap:16px">
  <div class="row-actions"><div><h2>الإحصائيات</h2><p class="sub">محسوبة من العلامات الكاملة فقط (الحفظ + التلاوة).</p></div>${printBtn()}</div>
  <div class="kpis">
    <div class="kpi"><b>${count}</b><span>المشاركون</span></div>
    <div class="kpi"><b>${count ? Math.round(scored.length * 100 / count) : 0}%</b><span>اكتمال التنقيط (${scored.length}/${count})</span></div>
    <div class="kpi"><b>${fmt(avg)}<small class="of"> /20</small></b><span>المعدل العام</span></div>
    <div class="kpi"><b>${fmt(avgH)} · ${fmt(avgT)}</b><span>معدل الحفظ · معدل التلاوة (/10)</span></div>
  </div>
  <section class="panel chart" aria-label="معدل كل قسم من 20">
    <h3>معدل المجموع في كل قسم <span class="pend">(من 20)</span></h3>
    <div class="hchart">${avgBars}
      <div class="hrow axis" aria-hidden="true"><span class="hl"></span><span class="htrack">${ticks.map(t => `<b style="inset-inline-start:${t * 5}%">${t}</b>`).join("")}</span><span class="hv"></span></div>
    </div>
  </section>
  <section class="panel chart" aria-label="توزيع التلاميذ حسب المجموع">
    <h3>توزيع التلاميذ حسب المجموع <span class="pend">(عدد التلاميذ في كل فئة)</span></h3>
    <div class="vchart">${bands.map(b => `<div class="vcol" title="${b.label}: ${b.n} تلميذ">
      <span class="vv">${b.n}</span><span class="vtrack"><span class="vbar" style="height:${(b.n / bandMax) * 100}%"></span></span><span class="vl">${b.label}</span></div>`).join("")}</div>
  </section>
  <div class="tbl"><table>
    <thead><tr><th>القسم</th><th class="num">المشاركون</th><th class="num">المُنقَّطون</th><th class="num">المعدل</th><th class="num">أعلى علامة</th><th>الأول</th></tr></thead>
    <tbody>${per.map((s, i) => `<tr class="clickable" data-go="s${i}"><td><strong>${esc(s.sec)}</strong></td><td class="num">${s.count}</td><td class="num">${s.scored}</td>
      <td class="num">${fmt(s.avg)}</td><td class="num">${s.max}</td><td>${s.top[0] ? esc(s.top[0].name) : '<span class="pend">—</span>'}</td></tr>`).join("")}</tbody>
  </table></div></div>`;
}

/* ---------- search: students, sections, teachers ---------- */
let searchQ = "";
function searchHTML() {
  return `<div style="display:grid;gap:14px">
  <div><h2>البحث</h2><p class="sub">ابحث عن تلميذ أو قسم أو معلم. لا يهم الهمز والتشكيل.</p></div>
  <label class="field searchbox">اكتب للبحث<input id="q" type="search" value="${esc(searchQ)}" placeholder="مثال: محمد، الأولى متوسط، أحمد" autocomplete="off"></label>
  <div id="qres">${searchResults()}</div></div>`;
}
function searchResults() {
  const q = normalizeAr(searchQ);
  if (q.length < 2) return `<p class="note">اكتب حرفين على الأقل.</p>`;
  const st = allRanked().filter(r => normalizeAr(r.name).includes(q)).slice(0, 40);
  const secs = SECTIONS.map((s, i) => ({ s, i })).filter(x => normalizeAr(x.s).includes(q));
  const tch = (typeof teachers !== "undefined" ? teachers : []).filter(t => normalizeAr(t.name).includes(q) || normalizeAr(t.username).includes(q));
  if (!st.length && !secs.length && !tch.length) return `<p class="empty">لا توجد نتائج لـ «${esc(searchQ)}».</p>`;
  return `${st.length ? `<h3 class="rh">التلاميذ (${st.length})</h3><div class="tbl"><table><thead><tr><th>التلميذ</th><th>القسم</th><th class="num">الحفظ</th><th class="num">التلاوة</th><th class="num">المجموع</th><th>الترتيب</th></tr></thead><tbody>
    ${st.map(r => `<tr class="clickable" data-go="s${SECTIONS.indexOf(r.section)}"><td><strong>${esc(r.name)}</strong></td><td>${esc(r.section)}</td><td class="num">${fmt(r.hifz)}</td><td class="num">${fmt(r.tilawa)}</td><td class="num"><strong>${fmt(r.total)}</strong></td>
      <td>${r.rank ? `<span class="pill p${r.rank <= 3 ? r.rank : 0}">${noteFor(r.rank)} · ${r.rank}</span>` : '<span class="pend">بانتظار العلامات</span>'}</td></tr>`).join("")}</tbody></table></div>` : ""}
  ${secs.length ? `<h3 class="rh">الأقسام</h3><div class="actions">${secs.map(x => `<button class="btn ghost small" data-go="s${x.i}">${esc(x.s)}</button>`).join("")}</div>` : ""}
  ${tch.length ? `<h3 class="rh">المعلمون</h3><div class="tbl"><table><tbody>${tch.map(t => `<tr class="clickable" data-go="s${SECTIONS.indexOf(t.section)}"><td><strong>${esc(t.name)}</strong></td><td>${esc(t.section)}</td><td><span class="state ${t.active ? "on" : ""}">${t.active ? "مفعّل" : "موقوف"}</span></td></tr>`).join("")}</tbody></table></div>` : ""}`;
}
function bindReports(el) {
  el.querySelectorAll("[data-print]").forEach(b => b.onclick = () => window.print());
  const q = el.querySelector("#q");
  if (q) {
    q.oninput = () => {
      searchQ = q.value; const box = el.querySelector("#qres"); box.innerHTML = searchResults();
      box.querySelectorAll("[data-go]").forEach(r => r.onclick = () => go(r.dataset.go));
    };
    if (document.activeElement !== q && !("ontouchstart" in window)) q.focus();
  }
}
