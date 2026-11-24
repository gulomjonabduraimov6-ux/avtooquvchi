"use strict";
// AvtoO’quvchi serveri. Tashqi kutubxona kerak emas (Node.js 20+).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const env = process.env;
const PORT = +env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DBF = env.DATA_FILE || path.join(__dirname, "data", "db.json");
const CFG = {
  sms: (env.SMS_PROVIDER || "demo").toLowerCase(),            // demo | eskiz
  eskizUrl: (env.ESKIZ_URL || "https://notify.eskiz.uz/api").replace(/\/$/, ""),
  eskizEmail: env.ESKIZ_EMAIL, eskizPass: env.ESKIZ_PASSWORD, eskizFrom: env.ESKIZ_FROM || "4546",
  smsText: env.SMS_TEXT || "AvtoO'quvchi tasdiqlash kodi: {code}",
  aiKey: env.ANTHROPIC_API_KEY, aiModel: env.AI_MODEL || "claude-sonnet-5-5",
  adminPath: env.ADMIN_PATH || "/admin", proxy: env.TRUST_PROXY === "1",
  hrs: +env.ACCESS_HOURS || 24,                                 // bepul foydalanish muddati (soat)
  geminiKey: env.GEMINI_API_KEY, geminiModel: env.GEMINI_MODEL || "gemini-flash-latest", geminiBase: (env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, ""),
  aiProvider: (env.AI_PROVIDER || (env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY ? "gemini" : "anthropic")).toLowerCase(),
};

/* ---------- Ma'lumotlar bazasi (JSON fayl) ---------- */
let db = { students: {}, admin: null, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch (e) {}
db.students = db.students || {}; db.sessions = db.sessions || {};
let wt = null;
const writeNow = () => { fs.mkdirSync(path.dirname(DBF), { recursive: true }); const t = DBF + ".tmp"; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DBF); };
const flush = () => { clearTimeout(wt); wt = setTimeout(writeNow, 300); };
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { try { writeNow(); } catch (e) {} process.exit(0); });

/* ---------- Xavfsizlik yordamchilari ---------- */
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const hp = (pw, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
const vp = (pw, h) => { if (!h) return false; const [s, x] = h.split(":"), y = crypto.scryptSync(String(pw), s, 32).toString("hex"); return x.length === y.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); };
const rndPw = () => Array.from(crypto.randomBytes(8), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
if (!db.admin) { db.admin = { login: env.ADMIN_LOGIN || "admin", h: hp(env.ADMIN_PASSWORD || "admin2026"), tmp: !env.ADMIN_PASSWORD }; flush(); }
const hits = new Map();
const limit = (k, max, ms) => { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms); if (a.length >= max) { hits.set(k, a); return false; } a.push(n); hits.set(k, a); return true; };
setInterval(() => { const n = Date.now(); for (const [k, s] of Object.entries(db.sessions)) if (s.exp < n) delete db.sessions[k]; for (const [k, a] of hits) if (!a.some(t => n - t < 36e5)) hits.delete(k); for (const [k, o] of otp) if (o.exp < n) otp.delete(k); }, 6e5).unref();
const newSession = (role, id) => { const t = crypto.randomBytes(32).toString("hex"); db.sessions[sha(t)] = { role, id, exp: Date.now() + (role === "admin" ? 12 : 30 * 24) * 36e5 }; flush(); return t; };
const session = req => { const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || ""); if (!m) return null; const s = db.sessions[sha(m[1])]; return s && s.exp > Date.now() ? { ...s, key: sha(m[1]) } : null; };
const ipOf = req => (CFG.proxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
const pub = u => ({ id: u.id, first: u.first, last: u.last, school: u.school, phone: u.phone, v: u.v, ap: u.ap, exam: u.exam });
const adminRow = u => ({ ...pub(u), sub: u.sub, at: u.at, act: u.act, n: u.n || 0, ok: u.ok || 0, hasPw: !!u.h, acc: u.acc || 0, grant: u.grant || 0, req: u.req || 0 });
const normLogin = s => { s = String(s || "").trim().toLowerCase(); const d = s.replace(/\D/g, ""); return /^(998)?\d{9}$/.test(d) ? "tel" + d.slice(-9) : s; };
const cleanName = s => String(s || "").trim().replace(/\s+/g, " ").slice(0, 40);

/* ---------- Ruxsat (24 soatlik bepul foydalanish) ---------- */
// pending: admin tasdig'ini kutmoqda | granted/active: ruxsat bor (taymer o'quvchi kirganda boshlanadi) | expired: vaqt tugagan | rejected
const accOf = (u, start) => {
  if (u.ap === -1) return { status: "rejected" };
  if (u.ap === 1) {
    if (!u.acc && start && u.v) { u.acc = Date.now() + (u.grant || CFG.hrs) * 36e5; flush(); }
    if (!u.acc) return { status: "granted" };
    return u.acc > Date.now() ? { status: "active", until: u.acc, now: Date.now() } : { status: "expired", now: Date.now() };
  }
  return { status: "pending", now: Date.now(), since: u.req || u.sub || 0 };
};

/* ---------- SMS ---------- */
let eskTok = null;
async function eskizAuth() {
  const f = new FormData(); f.append("email", CFG.eskizEmail || ""); f.append("password", CFG.eskizPass || "");
  const r = await fetch(CFG.eskizUrl + "/auth/login", { method: "POST", body: f }), j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data || !j.data.token) throw new Error("Eskiz login xatosi: " + JSON.stringify(j).slice(0, 200));
  eskTok = j.data.token;
}
async function eskizSend(phone, text, retry) {
  if (!eskTok) await eskizAuth();
  const f = new FormData(); f.append("mobile_phone", "998" + phone); f.append("message", text); f.append("from", CFG.eskizFrom);
  const r = await fetch(CFG.eskizUrl + "/message/sms/send", { method: "POST", headers: { Authorization: "Bearer " + eskTok }, body: f });
  if (r.status === 401 && !retry) { eskTok = null; return eskizSend(phone, text, true); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error("Eskiz SMS xatosi: " + JSON.stringify(j).slice(0, 200));
}
async function sendSms(phone, code) {
  const text = CFG.smsText.replace("{code}", code);
  if (CFG.sms === "eskiz") return eskizSend(phone, text);
  console.log(`[DEMO SMS] +998${phone}: ${text}`);
}
const otp = new Map();

/* ---------- AI murabbiy ---------- */
async function askAI(u, msgs) {
  const st = u.state || {}; let dl = null;
  if (st.exam) dl = Math.ceil((new Date(st.exam + "T00:00:00") - new Date(new Date().toDateString())) / 864e5);
  const sys = `Sen “AvtoO’quvchi” ilovasining shaxsiy murabbiy-yordamchisisan. Suhbatdoshing: ${u.first || "talaba"}${dl !== null ? `. U imtihonga ${dl} kun qolgan deb rejalashtirgan, hozirgacha ${st.n || 0} ta savol yechgan, aniqligi ${st.n ? Math.round(st.ok / st.n * 100) : 0}%` : ""}.
Qoidalar:
1) O’zbek tilida (lotin yozuvi) yoz. Foydalanuvchi boshqa tilda yozsa, o’sha tilda javob ber.
2) Faqat yo’l harakati qoidalari (YHQ), yo’l belgilari va chiziqlari, svetofor, chorrahalar, avtodrom mashqlari, imtihon va tayyorgarlik mavzularida yordam ber. Boshqa mavzu so’ralsa, mehr bilan qisqa javob berib, suhbatni mavzuga qaytar.
3) Samimiy, sabrli, ruhlantiruvchi bo’l. Salomlashsa salomlash, kayfiyatini so’ra, qiynalayotgan bo’lsa dalda ber. Quruq va rasmiy bo’lma.
4) Javob qisqa va tushunarli bo’lsin: avval asosiy fikr, keyin bitta hayotiy misol. Kerak bo’lsa oxirida bitta aniqlashtiruvchi savol ber.
5) Test savolini tushuntirganda nega to’g’ri javob to’g’ri va boshqalari nega noto’g’ri ekanini ayt.
6) Modda yoki band raqamlarini o’ylab topma. Ishonching komil bo’lmasa, rasmiy YHQ matnidan tekshirishni ayt.`;
  if (CFG.aiProvider === "gemini") {
    const r = await fetch(CFG.geminiBase + "/models/" + encodeURIComponent(CFG.geminiModel) + ":generateContent", { method: "POST", headers: { "x-goog-api-key": CFG.geminiKey, "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: msgs.map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] })), generationConfig: { maxOutputTokens: 700, temperature: 0.7 } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "Gemini xatosi");
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts;
    const text = (parts || []).map(x => x.text || "").join("").trim();
    if (!text) throw new Error("Gemini bo‘sh javob qaytardi");
    return text;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": CFG.aiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: CFG.aiModel, max_tokens: 700, system: sys, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "AI xatosi");
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}

/* ---------- HTTP ---------- */
const send = (res, code, obj, type) => { res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" }); res.end(type ? obj : JSON.stringify(obj)); };
const fail = (res, code, error) => send(res, code, { error });
const readBody = req => new Promise((ok, no) => { let b = "", n = 0; req.on("data", c => { n += c.length; if (n > 262144) { no(Object.assign(new Error("Hajm katta"), { code: 413 })); req.destroy(); } else b += c; }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(Object.assign(new Error("Noto‘g‘ri so‘rov"), { code: 400 })); } }); });
const file = (res, p, type) => { try { send(res, 200, fs.readFileSync(p), type); } catch (e) { fail(res, 404, "Topilmadi"); } };

async function handle(req, res) {
  const url = new URL(req.url, "http://x"), p = url.pathname, m = req.method, ip = ipOf(req);
  if (m === "GET") {
    if (p === "/" || p === "/index.html") return file(res, path.join(PUB, "student.html"), "text/html; charset=utf-8");
    if (p === CFG.adminPath) return file(res, path.join(PUB, "admin.html"), "text/html; charset=utf-8");
    if (p === "/bank.json") { const f = path.join(__dirname, "data", "bank.json"); return file(res, fs.existsSync(f) ? f : path.join(PUB, "bank.json"), "application/json; charset=utf-8"); }
  }
  if (!p.startsWith("/api/")) return fail(res, 404, "Topilmadi");
  const body = m === "GET" || m === "DELETE" ? {} : await readBody(req);
  const S = session(req);

  /* --- O'quvchi: SMS orqali ro'yxatdan o'tish --- */
  if (p === "/api/sms/send" && m === "POST") {
    const phone = String(body.phone || "").replace(/\D/g, "");
    if (!/^\d{9}$/.test(phone)) return fail(res, 400, "Telefon raqam noto‘g‘ri");
    if (cleanName(body.first).length < 2 || cleanName(body.last).length < 2) return fail(res, 400, "Ism va familiyani kiriting");
    const ex = db.students["tel" + phone]; if (ex && ex.ap === -1) return fail(res, 403, "Arizangiz rad etilgan. Administrator bilan bog‘laning");
    if (!limit("ip:" + ip, 20, 36e5) || !limit("p1:" + phone, 1, 6e4) || !limit("p5:" + phone, 5, 36e5)) return fail(res, 429, "Juda ko‘p urinish. Bir daqiqadan keyin qayta urinib ko‘ring");
    const code = String(crypto.randomInt(0, 100000)).padStart(5, "0");
    otp.set(phone, { h: sha(code + phone), exp: Date.now() + 12e4, tries: 0 });
    try { await sendSms(phone, code); } catch (e) { otp.delete(phone); console.error(e.message); return fail(res, 502, "SMS yuborib bo‘lmadi. Birozdan keyin urinib ko‘ring"); }
    return send(res, 200, { ok: true, wait: 60, ...(CFG.sms === "demo" ? { demoCode: code } : {}) });
  }
  if (p === "/api/sms/verify" && m === "POST") {
    const phone = String(body.phone || "").replace(/\D/g, ""), o = otp.get(phone);
    if (!limit("v:" + ip, 30, 36e5)) return fail(res, 429, "Juda ko‘p urinish");
    if (!o || Date.now() > o.exp) return fail(res, 400, "Kod muddati tugadi. Qayta yuboring");
    if (++o.tries > 3) { otp.delete(phone); return fail(res, 400, "Juda ko‘p xato urinish. Yangi kod so‘rang"); }
    if (o.h !== sha(String(body.code || "") + phone)) return fail(res, 400, "Kod noto‘g‘ri (" + (3 - o.tries) + " urinish qoldi)");
    otp.delete(phone);
    const first = cleanName(body.first), last = cleanName(body.last), school = body.school ? 1 : 0, now = Date.now();
    let u = S && S.role === "student" && db.students[S.id] && !db.students[S.id].v ? db.students[S.id] : null;   // admin yaratgan hisob
    const dup = Object.values(db.students).find(x => x.phone === phone && (!u || x.id !== u.id));
    if (u && dup) return fail(res, 409, "Bu raqam boshqa hisobda ro‘yxatdan o‘tgan");
    if (!u) { u = dup || db.students["tel" + phone]; if (u && u.ap === -1) return fail(res, 403, "Arizangiz rad etilgan. Administrator bilan bog‘laning"); }
    if (!u) u = db.students["tel" + phone] = { id: "tel" + phone, at: now };
    if (!u.v) { Object.assign(u, { first, last, school, phone, v: 1, sub: now }); if (u.ap === undefined) u.ap = 0; }
    u.act = now; flush();
    return send(res, 200, { token: newSession("student", u.id), user: pub(u), state: u.state || {}, access: accOf(u, true) });
  }
  if (p === "/api/login" && m === "POST") {
    if (!limit("l:" + ip, 20, 9e5)) return fail(res, 429, "Juda ko‘p urinish. 15 daqiqadan keyin urinib ko‘ring");
    const u = db.students[normLogin(body.login)];
    if (u && !u.h) return fail(res, 401, "Sizga hali parol berilmagan. Telefon raqam bilan ro‘yxatdan o‘tish orqali kiring");
    if (!u || !vp(body.password, u.h)) return fail(res, 401, "Login yoki parol noto‘g‘ri");
    if (u.ap === -1) return fail(res, 403, "Arizangiz rad etilgan. Administrator bilan bog‘laning");
    u.act = Date.now(); flush();
    return send(res, 200, { token: newSession("student", u.id), user: pub(u), state: u.state || {}, access: accOf(u, true) });
  }
  if (p === "/api/logout" && m === "POST") { if (S) { delete db.sessions[S.key]; flush(); } return send(res, 200, { ok: true }); }

  /* --- O'quvchi: shaxsiy ma'lumot, natijalar, AI --- */
  if (p.startsWith("/api/me") || p === "/api/ai") {
    const u = S && S.role === "student" && db.students[S.id];
    if (!u) return fail(res, 401, "Qayta kiring");
    if (p === "/api/me" && m === "GET") return send(res, 200, { user: pub(u), state: u.ap === -1 ? {} : u.state || {}, access: accOf(u, true) });
    if (p === "/api/me/request" && m === "POST") {
      if (accOf(u).status === "expired") { u.ap = 0; u.acc = 0; u.req = Date.now(); flush(); }
      return send(res, 200, { access: accOf(u) });
    }
    if (accOf(u).status !== "active") return fail(res, 403, "Ruxsat yo‘q yoki vaqt tugagan");
    if (p === "/api/me/state" && m === "PUT") {
      const st = body.state; if (!st || typeof st !== "object" || JSON.stringify(st).length > 150000) return fail(res, 400, "Noto‘g‘ri ma’lumot");
      u.state = st; u.n = Math.max(0, +st.n || 0); u.ok = Math.max(0, +st.ok || 0); u.exam = /^\d{4}-\d\d-\d\d$/.test(st.exam || "") ? st.exam : ""; u.act = Date.now(); flush();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/ai" && m === "POST") {
      if (!(CFG.aiProvider === "gemini" ? CFG.geminiKey : CFG.aiKey)) return fail(res, 503, "AI sozlanmagan");
      if (!limit("ai:" + u.id, 40, 36e5)) return fail(res, 429, "Ko‘p so‘rov");
      let msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-9).filter(x => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string").map(x => ({ role: x.role, content: x.content.slice(0, 2000) }));
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return fail(res, 400, "Savol yo‘q");
      try { return send(res, 200, { text: await askAI(u, msgs) }); } catch (e) { console.error(e.message); return fail(res, 502, "AI javob bera olmadi"); }
    }
    return fail(res, 404, "Topilmadi");
  }

  /* --- Admin (faqat admin sessiyasi) --- */
  if (p === "/api/admin/login" && m === "POST") {
    if (!limit("al:" + ip, 10, 9e5)) return fail(res, 429, "Juda ko‘p urinish. 15 daqiqadan keyin urinib ko‘ring");
    if (String(body.login || "").trim().toLowerCase() !== db.admin.login || !vp(body.password, db.admin.h)) return fail(res, 401, "Login yoki parol noto‘g‘ri");
    return send(res, 200, { token: newSession("admin", "admin") });
  }
  if (p.startsWith("/api/admin/")) {
    if (!S || S.role !== "admin") return fail(res, 401, "Admin sifatida kiring");
    if (p === "/api/admin/logout" && m === "POST") { delete db.sessions[S.key]; flush(); return send(res, 200, { ok: true }); }
    if (p === "/api/admin/students" && m === "GET") return send(res, 200, { students: Object.values(db.students).map(adminRow), cfg: { login: db.admin.login, tmp: !!db.admin.tmp } });
    if (p === "/api/admin/students" && m === "POST") {
      let id; do id = "avto" + String(crypto.randomInt(0, 10000)).padStart(4, "0"); while (db.students[id]);
      const pw = rndPw(); db.students[id] = { id, h: hp(pw), v: 0, at: Date.now(), ap: 1, grant: CFG.hrs, acc: 0 }; flush(); return send(res, 200, { id, password: pw });
    }
    const mm = /^\/api\/admin\/students\/([a-z0-9]+)(\/password)?$/.exec(p), u = mm && db.students[mm[1]];
    if (mm) {
      if (!u) return fail(res, 404, "O‘quvchi topilmadi");
      if (mm[2] && m === "POST") { const pw = rndPw(); u.h = hp(pw); for (const [k, s] of Object.entries(db.sessions)) if (s.role === "student" && s.id === u.id) delete db.sessions[k]; flush(); return send(res, 200, { password: pw }); }
      if (m === "PATCH") {
        if (![1, -1, 0].includes(body.ap)) return fail(res, 400, "Noto‘g‘ri holat");
        if (body.ap === 1) { if (accOf(u).status === "active") u.acc += (u.grant || CFG.hrs) * 36e5; else { u.ap = 1; u.grant = CFG.hrs; u.acc = 0; } u.apAt = Date.now(); }
        else { u.ap = body.ap; u.acc = 0; if (body.ap === -1) for (const [k, s] of Object.entries(db.sessions)) if (s.role === "student" && s.id === u.id) delete db.sessions[k]; }
        flush(); return send(res, 200, { ok: true });
      }
      if (m === "DELETE") { delete db.students[u.id]; for (const [k, s] of Object.entries(db.sessions)) if (s.id === u.id) delete db.sessions[k]; flush(); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/admin/config" && m === "PUT") {
      const l = String(body.login || "").trim().toLowerCase(), pw = String(body.password || "");
      if (!/^[a-z0-9_]{4,20}$/.test(l) || /^(avto|tel)/.test(l)) return fail(res, 400, "Login noto‘g‘ri");
      if (pw.length < 8) return fail(res, 400, "Parol kamida 8 belgi bo‘lsin");
      db.admin = { login: l, h: hp(pw), tmp: false }; flush(); return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, "Topilmadi");
}

http.createServer((req, res) => { handle(req, res).catch(e => { if (!res.headersSent) fail(res, e.code || 500, e.code ? e.message : "Server xatosi"); if (!e.code) console.error(e); }); })
  .listen(PORT, () => {
    console.log(`AvtoO’quvchi: http://localhost:${PORT}   (admin: ${CFG.adminPath})`);
    console.log(`SMS: ${CFG.sms}${CFG.sms === "demo" ? " (kod konsolda va ekranda ko‘rinadi, haqiqiy SMS yuborilmaydi)" : ""} | AI: ${(CFG.aiProvider === "gemini" ? CFG.geminiKey : CFG.aiKey) ? CFG.aiProvider + " yoqilgan" : "o‘chiq (GEMINI_API_KEY yoki ANTHROPIC_API_KEY yo‘q)"} | Ruxsat muddati: ${CFG.hrs} soat`);
    if (db.admin.tmp) console.log("DIQQAT: vaqtinchalik admin paroli (admin / admin2026). Kirgach darhol o‘zgartiring.");
    if (CFG.sms === "eskiz" && (!CFG.eskizEmail || !CFG.eskizPass)) console.log("DIQQAT: ESKIZ_EMAIL va ESKIZ_PASSWORD kiritilmagan.");
  });
