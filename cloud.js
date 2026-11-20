/* Central database layer: Firebase Auth + Cloud Firestore.
   Permissions are enforced by firestore.rules on the server; the interface only mirrors them. */
const CFG = window.FIREBASE_CONFIG;
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
const LOGIN_DOMAIN = "quran-ikhlass.app";
const ROLE_VIEWER = "school_admin_viewer";
const ROLE_LABEL = { admin: "مدير المسابقة", teacher: "أستاذ", [ROLE_VIEWER]: "مسؤول المدرسة" };

let auth = null, fs = null, me = null, unsubs = [], teachers = [], viewers = [], allUsers = [], activity = [];
let settingUp = false, loggingOut = false, adminExists = null, loginMode = "login";

function isAdmin() { return !!(me && me.role === "admin"); }
function isViewer() { return !!(me && me.role === ROLE_VIEWER); }
const ADMIN_VIEWS = ["dash", "results", "top", "stats", "search", "certs", "teachers", "sections", "log"];
const VIEWER_VIEWS = ["dash", "results", "top", "stats", "search", "certs", "log"];
// which screens each role may open; the database rules enforce the same limits on the server
function allowedView(v) {
  if (!me) return false;
  if (/^s\d+$/.test(v)) return isAdmin() || isViewer() ? !!SECTIONS[+v.slice(1)] : v === "s" + SECTIONS.indexOf(me.section);
  if (v === "mycode") return isAdmin();
  return (isAdmin() ? ADMIN_VIEWS : isViewer() ? VIEWER_VIEWS : []).includes(v);
}
function homeView() { return isAdmin() || isViewer() ? "dash" : "s" + SECTIONS.indexOf(me.section); }
function notify(msg, ok = true) {
  setStatus(msg, !ok);
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = (ok ? "✓ " : "⚠ ") + msg; t.className = ok ? "show ok" : "show bad";
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { t.className = ""; }, 3500);
}
function setStatus(t, err) { const s = $("#status"); s.textContent = t; s.classList.toggle("err", !!err); }
function loginKey(u) { return String(u || "").trim().toLowerCase().replace(/\s+/g, "-"); }
function validKey(k) { return /^[\p{L}\p{N}._-]{2,30}$/u.test(k); }
function newEmail() { return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + "@" + LOGIN_DOMAIN; }
function randomCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(10000000 + (a[0] % 90000000)); }
// rejects empty, short and easily guessed codes (codes themselves live only in Firebase Auth, hashed)
function codeProblem(code, username, min = 6) {
  const c = String(code || "");
  if (!c.trim()) return "رمز الدخول فارغ";
  if (/\s/.test(c)) return "رمز الدخول لا يحتوي على مسافات";
  if (c.length < min) return `رمز الدخول يجب أن يكون ${min} أحرف أو أرقام على الأقل`;
  if (/^(.)\1+$/.test(c)) return "رمز ضعيف: كل الخانات متشابهة";
  const up = "01234567890123456789", down = "98765432109876543210";
  if (/^\d+$/.test(c) && (up.includes(c) || down.includes(c))) return "رمز ضعيف: أرقام متتالية";
  if (/^(password|azerty|qwerty|abcdef|abc123|motdepasse|admin|quran)\d*$/i.test(c)) return "رمز ضعيف وشائع";
  if (username && username.length > 2 && c.toLowerCase().includes(String(username).toLowerCase())) return "لا تستعمل اسم المستخدم داخل الرمز";
  return "";
}
function toDate(t) { return t && t.toDate ? t.toDate() : (t instanceof Date ? t : null); }
function ago(t) {
  const d = toDate(t); if (!d) return "الآن";
  const s = (Date.now() - d.getTime()) / 1000, rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
  if (s < 60) return "الآن";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), "day");
  return d.toLocaleDateString("ar-DZ", { day: "numeric", month: "long" });
}
function errText(e) {
  const c = (e && e.code) || "";
  if (/wrong-password|invalid-credential|invalid-login-credentials|user-not-found/.test(c)) return "رمز الدخول غير صحيح";
  if (/too-many-requests/.test(c)) return "محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة";
  if (/network-request-failed|unavailable/.test(c)) return "لا يوجد اتصال بالإنترنت";
  if (/permission-denied/.test(c)) return "ليست لديك صلاحية لهذه العملية";
  if (/weak-password/.test(c)) return "رمز الدخول يجب أن يكون 6 أحرف أو أرقام على الأقل";
  if (/requires-recent-login/.test(c)) return "أعد تسجيل الدخول ثم حاول مرة أخرى";
  return (e && e.message) || String(e);
}

/* ---------- files (backup, certificates, CSV) ---------- */
async function appSave({ filename, data }) {
  try {
    const f = new File([data], filename, { type: data.type });
    if (navigator.canShare && navigator.canShare({ files: [f] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [f] }); return; } catch (e) { if (e && e.name === "AbortError") throw { code: "declined" }; }
    }
  } catch (e) { if (e && e.code) throw e; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(data); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------- boot & auth ---------- */
function boot() {
  document.getElementById("mastLogo").src = LOGO;
  dl = { save: appSave };
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    // when a new version is published, the page reloads once onto it
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded && !busyTyping()) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
  }
  if (!CFG || !window.firebase) {
    setStatus("قاعدة البيانات غير مربوطة", true);
    $("#view").innerHTML = `<div class="panel login"><h3>لم يتم ربط قاعدة البيانات بعد</h3><p class="note">يحتاج التطبيق إلى إعدادات مشروع Firebase في الملف firebase-config.js.</p></div>`;
    return;
  }
  firebase.initializeApp(CFG);
  auth = firebase.auth(); fs = firebase.firestore();
  if (window.FIREBASE_EMULATOR) { auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true }); fs.useEmulator("127.0.0.1", 8080); }
  fs.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  auth.onAuthStateChanged(onAuth);
}

async function onAuth(user) {
  if (settingUp || loggingOut) return;
  stopListeners(); me = null; loaded = false; students = []; teachers = []; activity = [];
  renderUserbox(); renderTabs();
  if (!user) { showLogin(); return; }
  setStatus("جارٍ التحقق من الحساب…");
  let snap;
  try { snap = await fs.doc("users/" + user.uid).get(); }
  catch (e) { setStatus(errText(e), true); showLogin(errText(e)); return; }
  const p = snap.exists ? snap.data() : null;
  if (!p || p.active !== true) { await auth.signOut(); showLogin("هذا الحساب غير مفعّل. راجع مسؤول النشاط."); return; }
  me = { uid: user.uid, ...p };
  canWrite = !isViewer();
  document.body.classList.remove("on-login");
  document.body.classList.toggle("role-viewer", isViewer());
  document.body.classList.toggle("role-admin", isAdmin());
  const asked = decodeURIComponent(location.hash.slice(1));
  if (asked && allowedView(asked)) view = asked;
  if (!allowedView(view)) view = homeView();
  try { history.replaceState(null, "", "#" + view); } catch (e) {}
  renderUserbox(); renderTabs(); render();
  startListeners();
}

function applySections(list) {
  if (!Array.isArray(list) || !list.length) return;
  if (list.join("\n") === SECTIONS.join("\n")) return;
  SECTIONS.splice(0, SECTIONS.length, ...list);
  if (certSec >= SECTIONS.length) certSec = 0;
  renderTabs(); if (!busyTyping()) render();
}
function startListeners() {
  setStatus("جارٍ تحميل البيانات…");
  unsubs.push(fs.doc("config/sections").onSnapshot(s => {
    if (s.exists) applySections(s.data().list);
    else if (isAdmin() && !s.metadata.fromCache && !sectionsInit) { sectionsInit = true; updateSections(l => l).catch(() => {}); }
  }, () => {}));
  if (!isAdmin()) unsubs.push(fs.doc("users/" + me.uid).onSnapshot(s => {
    if (s.metadata.hasPendingWrites || s.metadata.fromCache) return; // only server-confirmed changes
    const p = s.data();
    if (!p || p.active !== true) { logout(); return; } // stopped or deleted by the manager
    if (!isViewer() && p.section !== me.section) location.reload(); // moved to another section by the manager
    if (p.name !== me.name) { me.name = p.name; renderUserbox(); }
  }, () => {}));
  const q = isAdmin() || isViewer() ? fs.collection("students") : fs.collection("students").where("section", "==", me.section);
  const timer = setTimeout(() => { if (!loaded) setStatus("الاتصال بطيء، ما زلنا نحاول…", true); }, 10000);
  unsubs.push(q.onSnapshot({ includeMetadataChanges: true }, snap => {
    clearTimeout(timer);
    students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const first = !loaded; loaded = true;
    setStatus(snap.metadata.hasPendingWrites ? "محفوظ في الجهاز، بانتظار المزامنة…" : snap.metadata.fromCache ? "دون اتصال: تُحفظ التعديلات وتُرسل عند عودة الإنترنت" : "محفوظ ومتزامن ✓");
    if (snap.metadata.hasPendingWrites && !first && snap.docChanges().length === 0) return;
    const a = document.activeElement;
    if (!first && a && a.id && a.closest && a.closest("#view") && a.matches("input,select")) {
      if (a.matches("input[data-c]")) return;
      const id = a.id; render(); const n = document.getElementById(id); if (n) n.focus();
    } else render();
  }, e => { clearTimeout(timer); setStatus("تعذر تحميل البيانات: " + errText(e), true); }));
  if (!isAdmin() && !isViewer()) return;
  unsubs.push(fs.collection("users").onSnapshot(s => {
    allUsers = s.docs.map(d => ({ uid: d.id, ...d.data() }));
    teachers = visibleMembers("teacher"); viewers = visibleMembers(ROLE_VIEWER);
    if (["teachers", "dash", "search"].includes(view) && !busyTyping()) render();
  }, () => {}));
  unsubs.push(fs.collection("activity").orderBy("at", "desc").limit(150).onSnapshot(s => {
    activity = s.docs.map(d => ({ id: d.id, ...d.data() }));
    if (["log", "dash"].includes(view) && !busyTyping()) render();
  }, () => {}));
  settingsDoc = fs.doc("settings/certificate");
  unsubs.push(settingsDoc.onSnapshot(s => {
    if (s.exists) { Object.assign(certSettings, s.data()); if (view === "certs" && !busyTyping()) render(); }
  }, () => {}));
}
function busyTyping() { const a = document.activeElement; return !!(a && a.closest && a.closest("#view") && a.matches("input,select")); }
function stopListeners() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; settingsDoc = null; }

async function logout() {
  if (loggingOut) return;
  loggingOut = true; stopListeners(); setStatus("جارٍ تسجيل الخروج…");
  $("#view").innerHTML = `<div class="empty">جارٍ تسجيل الخروج…</div>`;
  try { await fs.waitForPendingWrites(); } catch (e) {}
  await auth.signOut();
  try { await fs.terminate(); await fs.clearPersistence(); } catch (e) {}
  location.reload();
}


/* show / hide button for every code field: same look in every browser and phone */
const EYE_OPEN = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function addEyes(root) {
  root.querySelectorAll('input[type="password"]').forEach(inp => {
    if (inp.parentElement.classList.contains("pw")) return;
    const wrap = document.createElement("span"); wrap.className = "pw";
    inp.replaceWith(wrap); wrap.appendChild(inp);
    const b = document.createElement("button");
    b.type = "button"; b.className = "eye"; b.innerHTML = EYE_OPEN;
    b.setAttribute("aria-label", "إظهار الرمز"); b.setAttribute("aria-pressed", "false"); b.title = "إظهار الرمز";
    b.onclick = e => {
      e.preventDefault();
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_SHUT : EYE_OPEN;
      b.setAttribute("aria-pressed", String(show));
      b.title = show ? "إخفاء الرمز" : "إظهار الرمز"; b.setAttribute("aria-label", b.title);
      inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (x) {}
    };
    wrap.appendChild(b);
  });
}

/* ---------- header ---------- */
function renderUserbox() {
  const b = $("#userbox"), badge = $("#roBadge");
  badge.hidden = !isViewer();
  if (!me) { b.hidden = true; b.innerHTML = ""; return; }
  b.hidden = false;
  b.innerHTML = `<span class="who">${esc(me.name)}</span><span class="role">· ${isAdmin() || isViewer() ? ROLE_LABEL[me.role] : esc(me.section)}</span>
    ${isAdmin() ? `<button class="btn ghost small" id="ubCode">🔑 تغيير رمز الدخول</button>` : ""}<button class="btn ghost small" id="ubOut">خروج</button>`;
  $("#ubOut").onclick = logout;
  const c = $("#ubCode"); if (c) c.onclick = () => { if (view === "mycode") go("dash"); else { view = "mycode"; renderTabs(); showMyCode(); } };
}
function showMyCode() {
  if (view !== "mycode" || !isAdmin()) { go(homeView()); return; }
  $("#view").innerHTML = `<div class="panel login"><h3>🔑 تغيير رمز الدخول</h3>
    <p class="note">خاص بمدير المسابقة. الرمز الجديد 8 أحرف أو أرقام على الأقل، ويتوقف الرمز القديم فوراً.</p>
    <form id="mcForm"><label class="field">الرمز الحالي<input id="mcOld" type="password" required autocomplete="current-password"></label>
    <label class="field">الرمز الجديد<input id="mcNew" type="password" minlength="8" required autocomplete="new-password"></label>
    <label class="field">تأكيد الرمز الجديد<input id="mcNew2" type="password" minlength="8" required autocomplete="new-password"></label>
    <p class="err" id="mcErr"></p><div class="actions"><button class="btn" type="submit" id="mcBtn">حفظ الرمز الجديد</button><button class="btn ghost" type="button" id="mcBack">رجوع</button></div></form></div>`;
  addEyes($("#view"));
  $("#mcBack").onclick = () => go("dash");
  $("#mcForm").onsubmit = async e => {
    e.preventDefault();
    const u = auth.currentUser, oldC = $("#mcOld").value, n1 = $("#mcNew").value, n2 = $("#mcNew2").value, err = $("#mcErr"), btn = $("#mcBtn");
    err.textContent = "";
    const weak = codeProblem(n1, me.username, 8);
    if (weak) { err.textContent = weak; return; }
    if (n1 !== n2) { err.textContent = "الرمز الجديد وتأكيده غير متطابقين"; return; }
    if (n1 === oldC) { err.textContent = "الرمز الجديد يجب أن يختلف عن الرمز الحالي"; return; }
    btn.disabled = true;
    try {
      await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, oldC));
      await u.updatePassword(n1);
      notify("تم تغيير رمز الدخول. الرمز القديم لم يعد صالحاً."); go("dash");
    } catch (x) { err.textContent = /wrong-password|invalid-credential|invalid-login/.test(x.code || "") ? "الرمز الحالي غير صحيح" : errText(x); btn.disabled = false; }
  };
}

/* ---------- login & first-time setup ---------- */
async function showLogin(msg) {
  $("#tabs").hidden = true;
  setStatus("سجّل الدخول للمتابعة");
  if (adminExists === null) {
    try { adminExists = (await fs.doc("config/admin").get({ source: "server" })).exists; } catch (e) { adminExists = true; }
  }
  if (!adminExists) loginMode = "setup";
  const setup = loginMode === "setup";
  document.body.classList.add("on-login");
  $("#view").innerHTML = `<div class="front">
  <section class="hero">
    <img src="${LOGO}" alt="شعار مدرسة الإخلاص القرآنية">
    <p class="eyebrow">مدرسة الإخلاص القرآنية</p>
    <h1>مسابقة القرآن الكريم السنوية</h1>
    <p class="hadith">«خيرُكم من تعلَّم القرآنَ وعلَّمه»</p>
  </section>
  <div class="panel login">
    <h3>${setup ? "الإعداد الأول: حساب مسؤول النشاط" : "تسجيل الدخول"}</h3>
    <p class="note">${setup ? "يتم هذا مرة واحدة فقط. صاحب هذا الحساب يتحكم في كل الأقسام ويُنشئ حسابات الأساتذة." : "أدخل اسم المستخدم ورمز الدخول اللذين أعطاك إياهما مدير المسابقة."}</p>
    <form id="lgForm">
      ${setup ? `<label class="field">الاسم الكامل<input id="lgName" required autocomplete="name"></label>` : ""}
      <label class="field">اسم المستخدم<input id="lgUser" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
      <label class="field">رمز الدخول<input id="lgCode" type="password" required ${setup ? 'minlength="6" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>
      <p class="err" id="lgErr">${esc(msg || "")}</p>
      <button class="btn" type="submit" id="lgBtn">${setup ? "إنشاء حساب المسؤول" : "دخول"}</button>
    </form></div>
  <p class="foot">خاص بمدير المسابقة والمعلمين ومسؤول المدرسة. لا تملك حساباً؟ اطلبه من مدير المسابقة.</p></div>`;
  addEyes($("#view"));
  $("#lgForm").onsubmit = e => { e.preventDefault(); setup ? doSetup() : doLogin(); };
}
async function doLogin() {
  const key = loginKey($("#lgUser").value), btn = $("#lgBtn"), err = $("#lgErr");
  btn.disabled = true; err.textContent = "";
  try {
    const card = validKey(key) ? await fs.doc("logins/" + key).get({ source: "server" }) : null;
    if (!card || !card.exists || card.data().active === false) throw new Error("اسم المستخدم غير موجود أو الحساب غير مفعّل");
    await auth.signInWithEmailAndPassword(card.data().email, $("#lgCode").value);
  } catch (e) { err.textContent = errText(e); btn.disabled = false; }
}
async function doSetup() {
  const name = $("#lgName").value.trim(), key = loginKey($("#lgUser").value), code = $("#lgCode").value, err = $("#lgErr"), btn = $("#lgBtn");
  if (!validKey(key)) { err.textContent = "اسم المستخدم: من 2 إلى 30 حرفاً أو رقماً، دون رموز خاصة"; return; }
  btn.disabled = true; settingUp = true;
  try {
    const email = newEmail();
    const cred = await auth.createUserWithEmailAndPassword(email, code);
    const uid = cred.user.uid, b = fs.batch();
    b.set(fs.doc("users/" + uid), { role: "admin", active: true, name, username: key, email, createdAt: TS() });
    b.set(fs.doc("config/admin"), { uid });
    try { await b.commit(); }
    catch (e) { await cred.user.delete().catch(() => {}); throw new Error("تم إعداد حساب المسؤول من قبل. سجّل الدخول بدلاً من ذلك."); }
    await fs.doc("logins/" + key).set({ email, active: true });
    await fs.doc("settings/certificate").set({ org: "مدرسة الإخلاص القرآنية", signerTitle: "مسؤول النشاط", signer: name, date: "" }, { merge: true });
    adminExists = true; settingUp = false; onAuth(auth.currentUser);
  } catch (e) { settingUp = false; adminExists = null; err.textContent = errText(e); btn.disabled = false; if (auth.currentUser) await auth.signOut(); }
}

/* ---------- writes (every change carries its author; every change is logged) ---------- */
function stamp() { return { updatedAt: TS(), updatedBy: me.uid, updatedByName: me.name }; }
function logEntry(section, action, student, changes) {
  return { uid: me.uid, name: me.name, section, action, student, changes: changes || [], at: TS() };
}
async function commit(b, okMsg) {
  setStatus("جارٍ الحفظ…");
  const p = b.commit();
  // offline: the write is already safe in the device queue and the snapshot shows it
  try { await p; setStatus(okMsg || "تم الحفظ ✓"); } catch (e) { setStatus("لم يُحفظ: " + errText(e), true); render(); }
}
async function saveField(id, patch) {
  const s = students.find(x => x.id === id); if (!s) return;
  const changes = Object.keys(patch).map(k => ({ field: k, from: s[k] ?? null, to: patch[k] ?? null }));
  const b = fs.batch();
  b.update(fs.doc("students/" + id), { ...patch, ...stamp() });
  b.set(fs.collection("activity").doc(), logEntry(s.section, "edit", patch.name || s.name, changes));
  await commit(b);
}
async function addStudent(d) {
  const b = fs.batch(), ref = fs.collection("students").doc();
  b.set(ref, { section: d.section, name: d.name, hifz: d.hifz, tilawa: d.tilawa, order: d.order, ...stamp() });
  b.set(fs.collection("activity").doc(), logEntry(d.section, "add", d.name, [{ field: "hifz", from: null, to: d.hifz }, { field: "tilawa", from: null, to: d.tilawa }]));
  await commit(b, "تمت الإضافة ✓");
}
async function removeStudent(id) {
  const s = students.find(x => x.id === id); if (!s || !isAdmin()) return;
  const b = fs.batch();
  b.delete(fs.doc("students/" + id));
  b.set(fs.collection("activity").doc(), logEntry(s.section, "delete", s.name, []));
  await commit(b, "تم الحذف");
}

/* ---------- admin: progress on the dashboard ---------- */
function sectionTeachers(sec) { return teachers.filter(t => t.active && t.section === sec); }
function progressHTML() {
  const rows = SECTIONS.map((sec, i) => {
    const list = students.filter(s => s.section === sec), done = list.filter(s => total(s) !== null).length;
    const last = list.reduce((m, s) => { const d = toDate(s.updatedAt); return d && (!m || d > m.d) ? { d, s } : m; }, null);
    const tn = sectionTeachers(sec).map(t => esc(t.name)).join("، ");
    const pct = list.length ? Math.round(done * 100 / list.length) : 0;
    return `<tr class="clickable" data-go="s${i}"><td><strong>${esc(sec)}</strong></td><td>${tn || '<span class="pend">لا يوجد أستاذ</span>'}</td>
      <td class="num">${done}/${list.length}<span class="prog"><i style="width:${pct}%"></i></span></td>
      <td>${last ? `${esc(last.s.updatedByName || "")} <span class="pend">· ${ago(last.s.updatedAt)}</span>` : '<span class="pend">—</span>'}</td></tr>`;
  }).join("");
  return `<div class="panel"><div class="row-actions"><h3>متابعة الأساتذة</h3><button class="btn ghost small" data-go="log">سجل التعديلات</button></div>
    <div class="tbl"><table><thead><tr><th>القسم</th><th>الأستاذ</th><th class="num">التنقيط المكتمل</th><th>آخر تعديل</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* ---------- admin: activity log ---------- */
const FIELD = { hifz: "الحفظ", tilawa: "التلاوة", name: "الاسم" };
function describe(a) {
  if (a.action === "add") return `أضاف التلميذ <strong>${esc(a.student)}</strong>`;
  if (a.action === "delete") return `حذف التلميذ <strong>${esc(a.student)}</strong>`;
  if (a.action === "import") return `استورد ${esc(a.student)}`;
  if (a.action === "note") return esc(a.student);
  const c = (a.changes || []).map(x => `${FIELD[x.field] || esc(x.field)}: ${x.from ?? "—"} ← ${x.to ?? "—"}`).join("، ");
  return `عدّل <strong>${esc(a.student)}</strong> <span class="pend">(${esc(c)})</span>`;
}
function logHTML() {
  return `<div style="display:grid;gap:14px"><div><h2>سجل التعديلات</h2><p class="sub">آخر ${activity.length} عملية من جميع الأساتذة، الأحدث أولاً.</p></div>
  <div class="tbl"><ul class="loglist" style="margin:0;padding:0">${activity.length ? activity.map(a => `<li><time>${ago(a.at)}</time>
    <span><strong>${esc(a.name)}</strong> <span class="pend">· ${esc(a.section)}</span> — ${describe(a)}</span></li>`).join("") : '<li><span></span><span class="pend">لا توجد تعديلات بعد.</span></li>'}</ul></div></div>`;
}

/* ---------- admin: teachers & the school viewer account ---------- */
// a deleted or replaced account stays in the database (history keeps its name) but is hidden and cannot sign in
function visibleMembers(role) { return allUsers.filter(u => u.role === role && !u.deleted && !u.replacedBy); }
const personKey = n => normalizeAr(n).replace(/\s+/g, " ");
function nameTaken(name, exceptUid) { const k = personKey(name); return teachers.some(t => t.uid !== exceptUid && personKey(t.name) === k); }
let lastCreated = null, showAdd = false, editUid = null, askDelete = null, memberBusy = false;

function createdCardHTML() {
  if (!lastCreated) return "";
  return `<div class="panel created"><h3>✓ تم ${lastCreated.reset ? "تجديد رمز" : "إنشاء حساب"} ${esc(lastCreated.name)}</h3>
    <p class="note">أعطِ صاحب الحساب هذه المعلومات. لن يظهر الرمز مرة أخرى.</p>
    <div>اسم المستخدم: <span class="code">${esc(lastCreated.username)}</span></div><div>رمز الدخول: <span class="code">${esc(lastCreated.code)}</span></div>
    <div class="actions"><button class="btn ghost small" id="tcCopy">📋 نسخ المعلومات</button><button class="btn ghost small" id="tcHide">تم</button></div></div>`;
}
function askDeleteHTML() {
  if (!askDelete) return "";
  const u = allUsers.find(x => x.uid === askDelete); if (!u) return "";
  const viewer = u.role === ROLE_VIEWER;
  return `<div class="panel confirmbox" role="alertdialog" aria-labelledby="cdT"><h3 id="cdT">🗑 حذف ${viewer ? "حساب مسؤول المدرسة" : "المعلم"} «${esc(u.name)}»؟</h3>
    <p class="note">${viewer ? "لن يستطيع الدخول بعد الآن." : "يختفي من قائمة المعلمين ولا يستطيع الدخول بعد الآن. نتائج التلاميذ وعلاماتهم والأقسام وسجل التعديلات تبقى كما هي."}</p>
    <div class="actions"><button class="btn danger" id="cdYes">نعم، احذف</button><button class="btn ghost" id="cdNo">إلغاء</button></div></div>`;
}
function memberRowHTML(t, viewer) {
  const editing = editUid === t.uid, dis = memberBusy ? "disabled" : "";
  return `<tr data-uid="${t.uid}">
    <td>${editing ? `<div class="inline-edit"><input id="edName" value="${esc(t.name)}" aria-label="الاسم الجديد" maxlength="60">
        <button class="btn small" data-act="save" ${dis}>حفظ</button><button class="btn ghost small" data-act="cancel">إلغاء</button></div>` : `<strong>${esc(t.name)}</strong>`}</td>
    <td><span class="code" style="font-size:.9rem">${esc(t.username)}</span></td>
    ${viewer ? "" : `<td>${t.active ? `<select data-sec aria-label="القسم" ${dis}>${SECTIONS.map(s => `<option ${s === t.section ? "selected" : ""}>${esc(s)}</option>`).join("")}${SECTIONS.includes(t.section) ? "" : `<option selected>${esc(t.section)}</option>`}</select>` : esc(t.section)}</td>`}
    <td><span class="state ${t.active ? "on" : ""}">${t.active ? "مفعّل" : "موقوف"}</span></td>
    <td><div class="actions icons">
      ${viewer ? "" : `<button class="btn ghost small" data-act="edit" title="تعديل الاسم" ${dis}>✎ تعديل</button>`}
      ${t.active ? `<button class="btn ghost small" data-act="reset" title="إعطاء رمز دخول جديد" ${dis}>🔑 رمز جديد</button><button class="btn ghost small" data-act="off" title="منع الدخول مؤقتاً" ${dis}>⏸ إيقاف</button>`
                 : `<button class="btn ghost small" data-act="on" ${dis}>▶ تفعيل</button>`}
      <button class="btn ghost small dangerish" data-act="del" title="حذف" ${dis}>🗑 حذف</button>
    </div></td></tr>`;
}
function teachersHTML() {
  const list = [...teachers].sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || (a.active === b.active ? 0 : a.active ? -1 : 1) || a.name.localeCompare(b.name, "ar"));
  const formOpen = showAdd || !list.length;
  return `<div style="display:grid;gap:14px">
  <div class="row-actions"><div><h2>إدارة المعلمين</h2><p class="sub">${list.length} معلم. لكل معلم اسم مستخدم ورمز دخول وقسم واحد، ولا يرى إلا تلاميذ قسمه.</p></div>
    ${formOpen ? "" : `<button class="btn" id="tcAddBtn">＋ إضافة معلم</button>`}</div>
  ${createdCardHTML()}${askDeleteHTML()}
  ${formOpen ? `<form class="panel" id="tcForm"><h3>＋ إضافة معلم</h3><div class="formgrid">
    <label class="field">الاسم الكامل<input id="tcName" required maxlength="60"></label>
    <label class="field">اسم المستخدم<input id="tcUser" required autocapitalize="none" spellcheck="false" placeholder="مثال: ahmed"></label>
    <label class="field">القسم<select id="tcSec">${SECTIONS.map(s => `<option>${esc(s)}</option>`).join("")}</select></label>
    <label class="field">رمز الدخول<input id="tcCode" value="${randomCode()}" minlength="6" required></label>
    <div class="actions"><button class="btn" type="submit" id="tcBtn">إنشاء الحساب</button>${list.length ? `<button class="btn ghost" type="button" id="tcCancel">إلغاء</button>` : ""}</div>
    </div><p class="err" id="tcErr"></p></form>` : ""}
  <div class="tbl"><table><thead><tr><th>المعلم</th><th>اسم المستخدم</th><th>القسم</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>
  ${list.length ? list.map(t => memberRowHTML(t, false)).join("") : '<tr><td colspan="5" class="empty">لا يوجد معلمون بعد. أضف أول معلم من النموذج أعلاه.</td></tr>'}
  </tbody></table></div>
  ${viewerPanelHTML()}</div>`;
}
function viewerPanelHTML() {
  return `<section class="panel viewerpanel"><h3>👁 حساب مسؤول المدرسة <span class="pend">(مشاهدة فقط)</span></h3>
    <p class="note">يرى كل النتائج والإحصائيات والأقسام ويطبعها، ولا يستطيع تعديل أي شيء. قاعدة البيانات نفسها ترفض أي تعديل منه.</p>
    ${viewers.length ? `<div class="tbl"><table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>${viewers.map(v => memberRowHTML(v, true)).join("")}</tbody></table></div>` : ""}
    <form id="vwForm" class="formgrid" style="margin-top:4px">
      <label class="field">الاسم<input id="vwName" required maxlength="60" value="${viewers.length ? "" : "مسؤول المدرسة"}"></label>
      <label class="field">اسم المستخدم<input id="vwUser" required autocapitalize="none" spellcheck="false" placeholder="مثال: madrasa"></label>
      <label class="field">رمز الدخول<input id="vwCode" value="${randomCode()}" minlength="6" required></label>
      <button class="btn ${viewers.length ? "ghost" : ""}" type="submit" id="vwBtn">${viewers.length ? "＋ حساب مشاهدة آخر" : "إنشاء حساب مسؤول المدرسة"}</button>
    </form><p class="err" id="vwErr"></p></section>`;
}
async function createAccount(email, code) {
  // a second app instance creates the account without signing the manager out
  const app2 = firebase.initializeApp(CFG, "create-" + Date.now());
  try {
    const a2 = app2.auth(); if (window.FIREBASE_EMULATOR) a2.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
    const cred = await a2.createUserWithEmailAndPassword(email, code);
    await a2.signOut(); return cred.user.uid;
  } finally { app2.delete().catch(() => {}); }
}
async function createMember({ role, name, username, section, code }) {
  const card = await fs.doc("logins/" + username).get({ source: "server" });
  if (card.exists) throw new Error("اسم المستخدم مستعمل من قبل، اختر اسماً آخر");
  const email = newEmail(), uid = await createAccount(email, code), b = fs.batch();
  b.set(fs.doc("users/" + uid), { role, active: true, name, username, ...(role === "teacher" ? { section } : {}), email, createdAt: TS() });
  b.set(fs.doc("logins/" + username), { email, active: true });
  b.set(fs.collection("activity").doc(), logEntry("الكل", "note", `أنشأ حساب ${ROLE_LABEL[role]} «${name}»`, []));
  await b.commit();
}
async function ownsCard(u) { const c = await fs.doc("logins/" + u.username).get({ source: "server" }); return !c.exists || c.data().email === u.email; }
const memberActions = {
  async reset(u) { // new account with the same username, role and section; the old code stops working at once
    const code = randomCode(), email = newEmail(), uid = await createAccount(email, code), b = fs.batch();
    b.update(fs.doc("users/" + u.uid), { active: false, replacedBy: uid });
    b.set(fs.doc("users/" + uid), { role: u.role, active: true, name: u.name, username: u.username, ...(u.role === "teacher" ? { section: u.section } : {}), email, createdAt: TS() });
    b.set(fs.doc("logins/" + u.username), { email, active: true });
    b.set(fs.collection("activity").doc(), logEntry("الكل", "note", `أعطى رمز دخول جديداً لـ «${u.name}»`, []));
    await b.commit(); lastCreated = { name: u.name, username: u.username, code, reset: true };
    return "تم إنشاء رمز جديد. الرمز القديم لم يعد صالحاً.";
  },
  async off(u) {
    const b = fs.batch(); b.update(fs.doc("users/" + u.uid), { active: false });
    if (await ownsCard(u)) b.set(fs.doc("logins/" + u.username), { email: u.email, active: false });
    await b.commit(); return "تم إيقاف حساب «" + u.name + "»";
  },
  async on(u) {
    if (!(await ownsCard(u))) throw new Error("اسم المستخدم مستعمل الآن بحساب آخر");
    const b = fs.batch(); b.update(fs.doc("users/" + u.uid), { active: true }); b.set(fs.doc("logins/" + u.username), { email: u.email, active: true });
    await b.commit(); return "تم تفعيل حساب «" + u.name + "»";
  },
  async del(u) {
    const b = fs.batch();
    b.update(fs.doc("users/" + u.uid), { active: false, deleted: true, deletedAt: TS() });
    if (await ownsCard(u)) b.delete(fs.doc("logins/" + u.username));
    b.set(fs.collection("activity").doc(), logEntry("الكل", "note", `حذف حساب ${ROLE_LABEL[u.role]} «${u.name}» (النتائج محفوظة)`, []));
    await b.commit(); askDelete = null; return "تم حذف «" + u.name + "». نتائج التلاميذ لم تتغيّر.";
  },
  async rename(u, name) {
    if (!name) throw new Error("الاسم فارغ");
    if (nameTaken(name, u.uid)) throw new Error("يوجد معلم آخر بنفس الاسم");
    if (name === u.name) { editUid = null; return ""; }
    const b = fs.batch(); b.update(fs.doc("users/" + u.uid), { name });
    b.set(fs.collection("activity").doc(), logEntry(u.section || "الكل", "note", `غيّر اسم المعلم «${u.name}» إلى «${name}»`, []));
    await b.commit(); editUid = null; return "تم تعديل الاسم إلى «" + name + "»";
  },
};
async function runMember(fn) {
  memberBusy = true; render();
  try { const msg = await fn(); if (msg) notify(msg); } catch (x) { notify(errText(x), false); }
  memberBusy = false; render();
}
function bindTeachers(el) {
  const add = el.querySelector("#tcAddBtn"); if (add) add.onclick = () => { showAdd = true; render(); el.querySelector("#tcName")?.focus(); };
  const cancel = el.querySelector("#tcCancel"); if (cancel) cancel.onclick = () => { showAdd = false; render(); };
  const f = el.querySelector("#tcForm");
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const name = cleanName($("#tcName").value), key = loginKey($("#tcUser").value), section = $("#tcSec").value, code = $("#tcCode").value.trim(), err = $("#tcErr"), btn = $("#tcBtn");
    err.textContent = "";
    if (!name) { err.textContent = "اكتب اسم المعلم"; return; }
    if (nameTaken(name)) { err.textContent = "هذا المعلم موجود في القائمة"; return; }
    if (!validKey(key)) { err.textContent = "اسم المستخدم: من 2 إلى 30 حرفاً أو رقماً، دون مسافات أو رموز خاصة"; return; }
    const weak = codeProblem(code, key); if (weak) { err.textContent = weak; return; }
    btn.disabled = true;
    try {
      await createMember({ role: "teacher", name, username: key, section, code });
      lastCreated = { name, username: key, code }; showAdd = false; notify("تمت إضافة المعلم «" + name + "»"); render();
    } catch (x) { err.textContent = errText(x); notify("لم تتم الإضافة: " + errText(x), false); btn.disabled = false; }
  };
  const vf = el.querySelector("#vwForm");
  if (vf) vf.onsubmit = async e => {
    e.preventDefault();
    const name = cleanName($("#vwName").value), key = loginKey($("#vwUser").value), code = $("#vwCode").value.trim(), err = $("#vwErr"), btn = $("#vwBtn");
    err.textContent = "";
    if (!name) { err.textContent = "اكتب الاسم"; return; }
    if (!validKey(key)) { err.textContent = "اسم المستخدم: من 2 إلى 30 حرفاً أو رقماً، دون مسافات أو رموز خاصة"; return; }
    const weak = codeProblem(code, key); if (weak) { err.textContent = weak; return; }
    btn.disabled = true;
    try { await createMember({ role: ROLE_VIEWER, name, username: key, code }); lastCreated = { name, username: key, code }; notify("تم إنشاء حساب مسؤول المدرسة"); render(); window.scrollTo({ top: 0 }); }
    catch (x) { err.textContent = errText(x); notify("لم يتم الإنشاء: " + errText(x), false); btn.disabled = false; }
  };
  const copy = el.querySelector("#tcCopy");
  if (copy) copy.onclick = () => { const t = `مسابقة القرآن الكريم\nاسم المستخدم: ${lastCreated.username}\nرمز الدخول: ${lastCreated.code}\n${location.href.split("#")[0]}`;
    navigator.clipboard.writeText(t).then(() => notify("تم النسخ"), () => notify("انسخ المعلومات يدوياً", false)); };
  const hide = el.querySelector("#tcHide"); if (hide) hide.onclick = () => { lastCreated = null; render(); };
  const yes = el.querySelector("#cdYes"), no = el.querySelector("#cdNo");
  if (no) no.onclick = () => { askDelete = null; render(); };
  if (yes) yes.onclick = () => { const u = allUsers.find(x => x.uid === askDelete); if (u) runMember(() => memberActions.del(u)); };
  el.querySelectorAll("tr[data-uid]").forEach(tr => {
    const u = allUsers.find(x => x.uid === tr.dataset.uid); if (!u) return;
    const sel = tr.querySelector("[data-sec]");
    if (sel) sel.onchange = () => fs.doc("users/" + u.uid).update({ section: sel.value }).then(() => notify("تم نقل «" + u.name + "» إلى " + sel.value), x => notify(errText(x), false));
    tr.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
      const act = b.dataset.act;
      if (act === "edit") { editUid = u.uid; render(); const i = document.getElementById("edName"); if (i) { i.focus(); i.select(); } return; }
      if (act === "cancel") { editUid = null; render(); return; }
      if (act === "save") { const name = cleanName(document.getElementById("edName").value); runMember(() => memberActions.rename(u, name)); return; }
      if (act === "del") { askDelete = u.uid; render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      if ((act === "reset" || act === "off") && !b.dataset.sure) { b.dataset.sure = 1; b.textContent = act === "reset" ? "تأكيد: رمز جديد" : "تأكيد الإيقاف"; return; }
      runMember(() => memberActions[act](u));
    });
    const ed = tr.querySelector("#edName");
    if (ed) ed.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); tr.querySelector('[data-act="save"]').click(); } if (e.key === "Escape") { editUid = null; render(); } };
  });
}

/* ---------- admin: sections ---------- */
let secBusy = false;
function sectionsAdminHTML() {
  const rows = SECTIONS.map((sec, i) => {
    const n = students.filter(s => s.section === sec).length, t = sectionTeachers(sec).length;
    return `<tr data-i="${i}"><td class="num pend">${i + 1}</td>
      <td><input class="name" id="sn-${i}" value="${esc(sec)}" aria-label="اسم القسم" ${secBusy ? "disabled" : ""}></td>
      <td class="num">${n}</td><td class="num">${t}</td>
      <td><div class="actions">
        <button class="btn ghost small" data-up ${i === 0 || secBusy ? "disabled" : ""} aria-label="تقديم">▲</button>
        <button class="btn ghost small" data-down ${i === SECTIONS.length - 1 || secBusy ? "disabled" : ""} aria-label="تأخير">▼</button>
        <button class="btn ghost small" data-rename ${secBusy ? "disabled" : ""}>حفظ الاسم</button>
        ${n || t ? "" : `<button class="del" data-remove title="حذف القسم" aria-label="حذف القسم" ${secBusy ? "disabled" : ""}>✕</button>`}
      </div></td></tr>`;
  }).join("");
  return `<div style="display:grid;gap:14px">
  <div><h2>الأقسام</h2><p class="sub">تُطبَّق هذه القائمة على كل الصفحات وعلى صلاحيات قاعدة البيانات. لا يمكن حذف قسم فيه تلاميذ أو أستاذ مفعّل.</p></div>
  <form class="panel" id="secForm"><h3>إضافة قسم</h3><div class="formgrid">
    <label class="field">اسم القسم الجديد<input id="secNew" required maxlength="40" placeholder="مثال: الخامسة متوسط"></label>
    <button class="btn" type="submit" ${secBusy ? "disabled" : ""}>إضافة القسم</button></div><p class="err" id="secErr" style="color:var(--warn);margin:0"></p></form>
  <div class="tbl"><table><thead><tr><th class="num">#</th><th>القسم</th><th class="num">التلاميذ</th><th class="num">الأساتذة</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">ورقة Excel لقسم جديد يجب أن تحمل نفس اسم القسم ليتم استيرادها.</p></div>`;
}
const cleanName = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 40);
const DEFAULT_SECTIONS = [...SECTIONS];
let sectionsInit = false;
// every change re-reads the stored list inside a transaction, so concurrent edits can't overwrite each other
async function updateSections(fn, msg) {
  const ref = fs.doc("config/sections");
  const list = await fs.runTransaction(async tx => {
    const d = await tx.get(ref), stored = d.exists && Array.isArray(d.data().list) && d.data().list.length ? d.data().list : null;
    const cur = stored || [...DEFAULT_SECTIONS], next = fn([...cur]);
    if (!next || !next.length) throw new Error("يجب أن يبقى قسم واحد على الأقل");
    if (stored && next.join("\n") === cur.join("\n")) return cur;
    tx.set(ref, { list: next }); return next;
  });
  applySections(list); if (msg) setStatus(msg); return list;
}
function bindSectionsAdmin(el) {
  const err = el.querySelector("#secErr");
  el.querySelector("#secForm").onsubmit = async e => {
    e.preventDefault(); const name = cleanName($("#secNew").value);
    if (!name) return;
    if (SECTIONS.includes(name)) { err.textContent = "هذا القسم موجود"; return; }
    try { await updateSections(l => l.includes(name) ? l : [...l, name], "تمت إضافة القسم «" + name + "»"); } catch (x) { err.textContent = errText(x); }
  };
  el.querySelectorAll("tr[data-i]").forEach(tr => {
    const i = +tr.dataset.i, sec = SECTIONS[i];
    const move = d => updateSections(l => { const a = l.indexOf(sec), b = a + d; if (a < 0 || b < 0 || b >= l.length) return l; [l[a], l[b]] = [l[b], l[a]]; return l; }, "تم تغيير الترتيب").catch(x => setStatus(errText(x), true));
    tr.querySelector("[data-up]").onclick = () => move(-1);
    tr.querySelector("[data-down]").onclick = () => move(1);
    const rm = tr.querySelector("[data-remove]");
    if (rm) rm.onclick = () => {
      if (!rm.classList.contains("confirm")) { rm.classList.add("confirm"); rm.textContent = "تأكيد الحذف"; return; }
      updateSections(l => l.filter(s => s !== sec), "تم حذف القسم «" + sec + "»").catch(x => setStatus(errText(x), true));
    };
    tr.querySelector("[data-rename]").onclick = () => renameSection(sec, cleanName(tr.querySelector("input").value));
  });
}
async function renameSection(from, to) {
  if (!to || to === from) return;
  if (SECTIONS.includes(to)) { setStatus("يوجد قسم بهذا الاسم", true); return; }
  secBusy = true; render(); setStatus("جارٍ إعادة تسمية القسم…");
  try {
    // 1) add the new name next to the old one, 2) move students and teachers, 3) drop the old name
    await updateSections(l => l.includes(to) ? l : l.flatMap(s => s === from ? [from, to] : [s]));
    const ops = [
      ...students.filter(s => s.section === from).map(s => b => b.update(fs.doc("students/" + s.id), { section: to, ...stamp() })),
      ...teachers.filter(t => t.section === from).map(t => b => b.update(fs.doc("users/" + t.uid), { section: to }))];
    for (let k = 0; k < ops.length; k += 400) { const b = fs.batch(); ops.slice(k, k + 400).forEach(f => f(b)); await b.commit(); }
    await updateSections(l => l.filter(s => s !== from));
    await fs.collection("activity").add(logEntry("الكل", "note", `أعاد تسمية القسم «${from}» إلى «${to}»`, []));
    setStatus("تمت إعادة التسمية ✓");
  } catch (x) { setStatus("توقفت إعادة التسمية: " + errText(x), true); }
  secBusy = false; render();
}

/* ---------- admin: import Excel / backup into the central database ---------- */
let pending = null;
function dataPanelHTML() {
  const empty = !students.length;
  return `<div class="panel" style="${empty ? "border-color:var(--accent);background:var(--accent-soft)" : ""}">
  <h3>${empty ? "ابدأ هنا: أدخل قائمة التلاميذ" : "البيانات والنسخ الاحتياطي"}</h3>
  <p class="note">${empty ? "استورد ملف الإكسل (ورقة لكل قسم: الاسم، الحفظ، التلاوة ابتداءً من السطر 5) أو نسخة احتياطية سابقة. تُحفظ البيانات في قاعدة البيانات المركزية وتظهر فوراً لكل أستاذ في قسمه." : "كل البيانات محفوظة في قاعدة البيانات المركزية. النسخة الاحتياطية ملف إضافي للأمان."}</p>
  ${pending ? `<p class="banner">${pending.label}</p>` : ""}
  <div class="actions">
    ${pending ? `<button class="btn" id="dpConfirm">تأكيد ${students.length ? "(يستبدل جميع التلاميذ الحاليين)" : ""}</button><button class="btn ghost" id="dpCancel">إلغاء</button>` :
    `<button class="btn${empty ? "" : " ghost"}" id="dpExcel">استيراد من ملف Excel</button>
     ${empty ? "" : `<button class="btn ghost" id="bkExport">حفظ نسخة احتياطية</button>`}
     <button class="btn ghost" id="bkImport">استرجاع نسخة احتياطية</button>`}
    </div></div>`;
}
// one file field outside the live-updated view, so a sync redraw can't drop the chosen file
let fileWant = null;
const fileInput = (() => {
  const fi = document.createElement("input"); fi.type = "file"; fi.hidden = true; fi.id = "dpFile"; document.body.appendChild(fi);
  fi.onchange = async () => {
    const f = fi.files[0]; fi.value = ""; if (!f || !isAdmin()) return;
    try { if (fileWant === "excel" || /\.xlsx?$/i.test(f.name)) readExcel(await f.arrayBuffer()); else readBackup(await f.text()); }
    catch (e) { setStatus(e.message || "تعذرت قراءة الملف", true); }
  };
  return fi;
})();
function bindData(el) {
  const q = s => el.querySelector(s), fi = fileInput; if (!isAdmin() || !q("#bkImport, #dpConfirm")) return;
  if (q("#dpExcel")) q("#dpExcel").onclick = () => { fileWant = "excel"; fi.accept = ".xlsx,.xls"; fi.click(); };
  if (q("#bkImport")) q("#bkImport").onclick = () => { fileWant = "backup"; fi.accept = ".json,application/json"; fi.click(); };
  if (q("#bkExport")) q("#bkExport").onclick = async () => {
    const clean = students.map(s => ({ id: s.id, section: s.section, name: s.name, hifz: s.hifz ?? null, tilawa: s.tilawa ?? null, order: s.order, updatedByName: s.updatedByName || "", updatedAt: toDate(s.updatedAt)?.toISOString() || null }));
    const blob = new Blob([JSON.stringify({ app: "quran-contest", version: 2, savedAt: new Date().toISOString(), students: clean, cert: certSettings }, null, 1)], { type: "application/json" });
    try { await appSave({ filename: `نسخة-مسابقة-القرآن-${new Date().toISOString().slice(0, 10)}.json`, data: blob }); setStatus("تم حفظ النسخة الاحتياطية"); } catch (e) { setStatus("لم يتم الحفظ", true); }
  };
  if (q("#dpConfirm")) q("#dpConfirm").onclick = () => importStudents(pending);
  if (q("#dpCancel")) q("#dpCancel").onclick = () => { pending = null; render(); };
}
const num = v => { const n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) && n >= 0 && n <= 10 ? n : null; };
function readExcel(buf) {
  if (!window.XLSX) throw new Error("قارئ ملفات Excel لم يُحمَّل");
  const wb = XLSX.read(buf, { type: "array" }), out = []; let o = 1; const found = [];
  for (const sec of SECTIONS) {
    const ws = wb.Sheets[sec]; if (!ws) continue; found.push(sec);
    for (const r of XLSX.utils.sheet_to_json(ws, { header: 1, range: 4, blankrows: false, defval: null })) {
      const name = r[0] == null ? "" : String(r[0]).trim();
      if (!name || /^[🥇🥈🥉]/u.test(name)) continue;
      out.push({ section: sec, name: name.slice(0, 80), hifz: num(r[1]), tilawa: num(r[2]), order: o++ });
    }
  }
  if (!found.length) throw new Error("لم أجد في الملف أوراقاً بأسماء الأقسام (مثل: الرابعة ابتدائي)");
  pending = { what: "ملف Excel", students: out, label: `وُجد ${out.length} تلميذ في ${found.length} أقسام. اضغط «تأكيد» لحفظهم في قاعدة البيانات.` };
  render();
}
function readBackup(text) {
  let o; try { o = JSON.parse(text); } catch (e) { o = null; }
  if (!o || o.app !== "quran-contest" || !Array.isArray(o.students)) throw new Error("هذا الملف ليس نسخة احتياطية من التطبيق");
  const st = o.students.filter(s => s && typeof s.name === "string" && s.name.trim() && SECTIONS.includes(s.section))
    .map((s, i) => ({ section: s.section, name: s.name.trim().slice(0, 80), hifz: num(s.hifz), tilawa: num(s.tilawa), order: typeof s.order === "number" ? s.order : i + 1 }));
  pending = { what: "نسخة احتياطية", students: st, cert: o.cert && typeof o.cert === "object" ? o.cert : null, label: `نسخة احتياطية فيها ${st.length} تلميذ. اضغط «تأكيد» لحفظها في قاعدة البيانات.` };
  render();
}
async function importStudents(p) {
  const btn = $("#dpConfirm"); if (btn) btn.disabled = true;
  setStatus("جارٍ الحفظ في قاعدة البيانات…");
  try {
    const ops = [...students.map(s => b => b.delete(fs.doc("students/" + s.id))),
      ...p.students.map(s => b => b.set(fs.collection("students").doc(), { ...s, ...stamp() }))];
    for (let i = 0; i < ops.length; i += 400) { const b = fs.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
    if (p.cert) await settingsDoc.set({ org: p.cert.org || "", signerTitle: p.cert.signerTitle || "مسؤول النشاط", signer: p.cert.signer || "", date: p.cert.date || "" });
    await fs.collection("activity").add(logEntry("الكل", "import", `${p.students.length} تلميذ من ${p.what}`, []));
    pending = null; setStatus(`تم حفظ ${p.students.length} تلميذ في قاعدة البيانات ✓`); render();
  } catch (e) { setStatus("توقف الاستيراد: " + errText(e), true); if (btn) btn.disabled = false; }
}

window.addEventListener("hashchange", () => {
  const v = decodeURIComponent(location.hash.slice(1));
  if (me && v && v !== view && v !== "mycode") go(v);
});
boot();
