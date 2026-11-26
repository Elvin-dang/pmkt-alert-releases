"use strict";
// PMKT Alert UI. All data comes from window.pywebview.api (Python Api class); nothing is hard-coded.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
// Round half up to a whole number (fractional ≥ .5 → ceil, below → floor); drops the decimal part.
// e.g. 0.9388 → 1, 2602.93 → 2603. For non-percentage numbers — percentages keep pct()/toFixed as-is.
const rhu = (v) => { const x = Number(v); return Math.round(x + Math.max(Math.abs(x), 1) * 1e-9); };
const money = (v) => (num(v) ? "$" + rhu(v).toLocaleString("en-US") : "—");
const pct = (v, d = 0) => (num(v) ? (v * 100).toFixed(d) + "%" : "—");
const signed = (v) => (num(v) ? (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(0) + "%" : "—");
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
const short = (label) => String(label || "").split(" – ")[0];
const SEV = { HIGH: 0, MED: 1, LOW: 2, "": 3 };
const ALL_PIC = "__ALL__";
const ROLE_NAME = { tracker: "Data (raw_sso_us, Product Info, KPI, ads_camp, Listing Issue…)", ads: "Ads by Campaign (ads_camp)", activity: "Activity Log", logic: "Logic", defind: "Defind", converted: "Converted product (cross sale · halo effect)" };

let api = null;
// Web viewer (PWA, web/shim.js): the same page in a browser, for reading reports only – everyone is a reader there.
const WEB = !!window.PMKT_WEB;
const S = { paths: [], roles: null, run: null, ai: null, runId: null, pic: null, open: new Set(), update: null, fb: null, origSlack: "" };

// ------------------------------------------------------------------ helpers
function bad(r) {
  if (r && r.kind === "WebOnlyDesktop") return true;  // a desktop-only feature on the web: nothing to say
  if (r && r.error) { toast(r.error, true); return true; }
  return false;
}
function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.setAttribute("role", err ? "alert" : "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 8000 : 4000);
}
const raw = (v) => `<span data-no-i18n>${esc(v)}</span>`;  // Claude / user text: never run through the UI translation
function sev(s) { return s ? `<span class="sev ${esc(s)}">${esc(s)}</span>` : ""; }
function fbBtn(unit, label, done) {
  return `<button class="fb${done ? " done" : ""}" data-unit="${esc(unit)}" data-label="${esc(label)}"><svg class="i" aria-hidden="true"><use href="#flag"/></svg>${done ? "Đã góp ý" : "Chưa hợp lý"}</button>`;
}
function copyText(text) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  };
  try { navigator.clipboard.writeText(text).catch(fallback); } catch { fallback(); }
}
function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
}
function md(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  let out = "", inList = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) out += `<h3>${inline(h[1])}</h3>`;
    else if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  return out + (inList ? "</ul>" : "");
}

// ------------------------------------------------------------------ navigation & theme
function go(id, tab) {
  if (id === "settings") settingsTab(tab || store("settingsTab") || "team");
  $$("main section").forEach((s) => s.classList.toggle("on", s.id === id));
  $$("nav button[data-go]").forEach((b) => (b.dataset.go === id ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (id === "review") loadReview();
  if (id === "dashboard") loadDashboard();
  if (id === "present") loadDeck();
  if (id === "perf") loadPerf();
  if (id === "hourly") loadHourly();
  if (id === "lessons") loadLessons();
  if (id === "settings") loadSettings();
}
// Settings is split into tabs; a Lead-only tab (hidden for viewers) falls back to Nhóm.
function settingsTab(tab) {
  const btn = $(`#set-tabs [data-stab="${tab}"]`);
  if (!btn || getComputedStyle(btn).display === "none") tab = "team";
  $$("#set-tabs [data-stab]").forEach((b) => {
    const on = b.dataset.stab === tab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $$("#settings > .tabpanel").forEach((p) => p.classList.toggle("on", p.id === "set-" + tab));
  store("settingsTab", tab);
}
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; }
function applyLang(l) {
  I18N.set(l);
  $("#lang").textContent = I18N.lang === "en" ? "VI" : "EN";
  $("#lang").title = I18N.lang === "en" ? "Chuyển sang tiếng Việt" : "Switch to English";
  $("#su-lang").textContent = I18N.lang === "en" ? "Tiếng Việt" : "English";
}

// ------------------------------------------------------------------ Claude status
async function checkClaude() {
  setPill("warn", "Đang kiểm tra…", "");
  const s = await api.claude_status();
  if (bad(s)) return;
  const text = s.level === "ok" ? "Sẵn sàng" : !s.installed ? "Chưa cài" : !s.logged_in ? "Chưa đăng nhập" : "Chậm/không ổn định";
  setPill(s.level, text + (!s.installed ? " – bấm để cài" : !s.logged_in ? " – bấm để đăng nhập" : ""), [s.version, s.latency_s != null ? `phản hồi ${s.latency_s}s` : "", s.detail].filter(Boolean).join(" · "));
  $("#cc-checks").innerHTML = [
    [s.installed, "Đã cài đặt", s.version ? `<code class="muted">${esc(s.version)}</code>` : "Bấm “Cài Claude Code” bên dưới"],
    [s.logged_in, "Đã đăng nhập", s.logged_in ? "" : "Bấm “Đăng nhập Claude Code” bên dưới"],
    [s.responds, "Phản hồi thử", s.latency_s != null ? `<span class="muted num">${s.latency_s}s</span>` : esc(s.detail || "")],
  ].map(([ok, label, extra]) => `<div class="check"><span class="sev ${ok ? "OK" : "HIGH"}">${ok ? "OK" : "LỖI"}</span>${label} ${extra}</div>`).join("");
  $("#cc-install").classList.toggle("hidden", s.installed);
  $("#cc-login").classList.toggle("hidden", !s.installed || s.logged_in);
  const hint = !s.installed ? "Cài bản chính thức của Anthropic (không cần quyền admin), sau đó đăng nhập bằng tài khoản Claude của bạn."
    : !s.logged_in ? "Bấm Đăng nhập → cửa sổ Terminal mở ra, làm theo hướng dẫn trên trình duyệt, xong quay lại bấm Kiểm tra lại." : "";
  $("#cc-hint").textContent = hint;
  $("#cc-hint").classList.toggle("hidden", !hint);
  S.claudeLevel = s.level;
  S.ccInstalled = s.installed;
  if (s.installed) loadClaudeStats(); else { $("#cc-stats").innerHTML = ""; $("#cc-foot-usage").innerHTML = ""; $("#cc-foot-refresh").classList.add("hidden"); }
}
function untilText(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return "0m";
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}
const useColor = (p) => (!num(p) ? "var(--muted)" : p >= 90 ? "var(--high)" : p >= 70 ? "var(--med)" : "var(--ok)");
function usageBar(u) {
  if (!u || !u.limits || !u.limits.length) return "";
  const rows = u.limits.map((l) => {
    const p = num(l.percent) ? l.percent : 0;
    return `<div class="usebar"><div class="usebar-lbl" data-no-i18n>${esc(l.label)}</div>
      <div class="bar"><span style="width:${Math.min(100, p)}%;background:${useColor(l.percent)}"></span></div>
      <div class="usebar-pct num">${num(l.percent) ? p + "%" : "—"}</div>
      <div class="usebar-reset muted">${l.resets_at ? "còn " + untilText(l.resets_at) : ""}</div></div>`;
  }).join("");
  const age = u.fetched_at_ms ? ` · cập nhật ${untilAgo(u.fetched_at_ms)}` : "";
  return `<div style="margin-top:12px"><div class="poplab">Hạn mức Claude Code (5 giờ · tuần · theo model)</div>
    <div class="usebars">${rows}</div>
    <p class="muted" style="font-size:12px;margin:4px 0 0">Theo tài khoản Claude Code của bạn${age}.</p></div>`;
}
function untilAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  return mins < 1 ? "vừa xong" : mins < 60 ? `${mins}p trước` : `${Math.floor(mins / 60)}g trước`;
}
function footUsage(u) {
  const el = $("#cc-foot-usage");
  $("#cc-foot-refresh").classList.toggle("hidden", !(u && u.limits && u.limits.length));
  if (!u || !u.limits || !u.limits.length) { el.innerHTML = ""; return; }
  const parts = u.limits.map((l) => {
    const detail = l.kind === "weekly_scoped" ? esc(l.label) : (l.resets_at ? untilText(l.resets_at) : "");
    const col = num(l.percent) && l.percent >= 90 ? "var(--high)" : num(l.percent) && l.percent >= 70 ? "var(--med)" : "";
    const bar = l.kind === "session" ? `<span class="fu-bar"><span style="width:${Math.min(100, num(l.percent) ? l.percent : 0)}%;background:${useColor(l.percent)}"></span></span>` : "";
    return `<span class="fu-item">${bar}<b class="num"${col ? ` style="color:${col}"` : ""}>${num(l.percent) ? l.percent + "%" : "—"}</b>${detail ? " " + detail : ""}</span>`;
  }).join('<span class="fu-sep">·</span>');
  el.innerHTML = `<span class="fu-used">Used</span><span class="fu-spark">✳</span>${parts}`;
}
async function refreshUsage() {
  const b = $("#cc-foot-refresh");
  b.disabled = true; b.classList.add("spinning");
  await Promise.all([loadClaudeStats(), new Promise((r) => setTimeout(r, 600))]);  // keep the spin visible on a fast local read
  b.disabled = false; b.classList.remove("spinning");
}
async function loadClaudeStats() {
  const r = await api.claude_stats();
  const u = r && !r.error ? r.usage : null;
  footUsage(u);
  $("#cc-stats").innerHTML = usageBar(u);
}
async function installClaude() {
  const cmd = navigator.userAgent.includes("Windows") ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
  if (!confirm(I18N.t(`Cài Claude Code bằng trình cài đặt chính thức của Anthropic?\n\n${cmd}\n\nCần kết nối Internet, mất khoảng 1–2 phút.`))) return;
  const b = $("#cc-install");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> Đang cài…';
  setPill("warn", "Đang cài…", "");
  const r = await api.install_claude();
  b.disabled = false;
  b.innerHTML = '<svg class="i" aria-hidden="true"><use href="#download"/></svg>Cài Claude Code';
  if (bad(r)) return;
  if (!r.ok) { toast("Cài chưa thành công: " + (r.output || "").slice(-300), true); await checkClaude(); return; }
  toast("Đã cài Claude Code. Bước tiếp: đăng nhập.");
  await checkClaude();
}
async function loginClaude() {
  if (!bad(await api.open_claude_login())) toast("Đã mở Terminal – đăng nhập xong thì bấm Kiểm tra lại.");
}
function setPill(level, text, title) {
  const p = $("#cc-pill");
  p.className = "pill " + level;
  p.title = title || "";
  $("#cc-text").textContent = "Claude Code: " + text;
  $("#cc-foot").textContent = "Claude Code ● " + text.toLowerCase();
}

// ------------------------------------------------------------------ run screen
const DAILY = new Set(["tracker", "ads", "activity"]);
function ago(iso) {
  const t = new Date(iso), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(t.toDateString())) / 864e5);
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return { days, text: days === 0 ? `hôm nay ${hm}` : days === 1 ? `hôm qua ${hm}` : `${ddmm(iso)}/${iso.slice(0, 4)} ${hm} · ${days} ngày trước` };
}
function slot(role) {
  let r = S.roles && S.roles[role];
  const noAds = role === "tracker" && r && !S.roles.ads;  // Data file without ads_camp
  const synced = (role === "tracker" && r && r.synced) || [];  // SharePoint exports found in OneDrive
  const auto = role === "activity" && S.actEmail;  // Chạy fetches it from Ads
  const m = r && r.modified ? ago(synced.length ? (r.workbook_modified || r.modified) : r.modified) : null;
  // With the daily tables synced, the Data workbook only holds the hand-entered sheets: check it monthly.
  const stale = m && !auto && DAILY.has(role) && m.days >= (synced.length ? 30 : 2);
  const last = synced.length ? ago(synced.map((x) => x.modified).sort().pop()) : null;
  const name = r ? (synced.length ? r.path.split(/[\\/]/).pop() : r.name) : role === "activity" ? "Activity Log" : ROLE_NAME[role];
  const what = synced.length ? "Product Info · KPI · Summary (nhập tay)" : role === "activity" ? "Activity Log – tự lấy từ Ads khi Chạy" : ROLE_NAME[role];
  const ok = (r && !noAds) || auto;
  const optional = role === "converted" && !r;  // not needed to run: only the cross sale / halo columns
  return `<div class="slot ${r ? "clickable" : ""}" ${r ? `role="button" tabindex="0" data-slot="${role}" aria-label="Xem chi tiết ${esc(name)}"` : ""}>
    <svg class="i" aria-hidden="true"><use href="#file"/></svg><div style="min-width:0"><div class="name" data-no-i18n>${esc(name)}</div>
    <div class="meta">${esc(what)}${r ? ` · ${r.size_mb ? r.size_mb : "<0.1"} MB` : role === "activity" ? "" : " · Chưa có file"}</div>
    ${m ? `<div class="meta" style="${stale ? "color:var(--med);font-weight:600" : ""}" title="Lần lưu gần nhất (Last modified)">${auto ? "Lấy lần cuối" : "Sửa lần cuối"}: ${m.text}${stale ? (synced.length ? " – kiểm tra Product Info / KPI tháng này" : " – data có thể đã cũ") : ""}</div>` : ""}
    ${role === "activity" && !auto ? '<div class="meta" style="color:var(--med);font-weight:600">Chưa đăng nhập Ads – bấm “Lấy Activity Log từ Ads” một lần</div>' : ""}
    ${synced.length ? `<div class="meta" title="${esc(synced.map((x) => x.name).join("\n"))}">SharePoint (OneDrive): ${synced.length} file · sync gần nhất ${last.text}</div>` : ""}</div>
    ${noAds ? '<div class="meta" style="color:var(--high);font-weight:600">Thiếu sheet ads_camp trong file Data</div>' : ""}
    <span class="badges">${r && r.new ? '<span class="sev INFO" title="File đã thay đổi kể từ lần chạy trước">MỚI</span>' : ""}<span class="st sev ${ok ? "OK" : optional ? "INFO" : "MED"}">${auto ? "TỰ ĐỘNG" : ok ? "HỢP LỆ" : optional ? "TÙY CHỌN" : "THIẾU"}</span></span></div>`;
}
async function openFileDetail(role) {
  const r = S.roles[role];
  $("#fd-title").textContent = r.name;
  $("#fd-body").innerHTML = '<div class="muted"><span class="spin"></span> Đang đọc file…</div>';
  $("#fd").classList.add("on");
  const d = await api.file_detail(r.paths || [r.path]);
  if (d.error) { $("#fd-body").innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  $("#fd-body").innerHTML = d.files.map((f) => {
    const m = ago(f.modified);
    return `<div class="card" style="margin-bottom:10px">
      <h3 style="margin:0 0 8px;font-size:14px" data-no-i18n>${esc(f.name)}</h3>
      <dl class="kv"><dt>Vai trò</dt><dd>${esc(ROLE_NAME[f.role] || f.role || "—")}</dd>
        <dt>Sửa lần cuối</dt><dd><b>${m.text}</b></dd><dt>Dung lượng</dt><dd>${(f.size / 1048576).toFixed(2)} MB</dd>
        <dt>Thư mục</dt><dd class="num" style="word-break:break-all" data-no-i18n>${esc(f.folder)}</dd></dl>
      ${f.sheets.map((sh) => `<details class="evsec" ${f.sheets.length === 1 ? "open" : ""}><summary><b data-no-i18n>${esc(sh.name)}</b> · <span class="num">${sh.rows.toLocaleString("en-US")}</span> dòng · ${sh.columns.length} cột${sh.dates.column ? ` · dữ liệu <span class="num">${ddmm(sh.dates.min)}/${sh.dates.min.slice(0, 4)} – ${ddmm(sh.dates.max)}/${sh.dates.max.slice(0, 4)}</span>` : ""}</summary>
        ${sh.dates.column ? `<p class="muted" style="font-size:12px;margin:6px 0">Khoảng ngày theo cột <code data-no-i18n>${esc(sh.dates.column)}</code></p>` : ""}
        ${sh.preview.rows.length ? `<div class="tbl" style="max-height:260px" data-no-i18n><table><thead><tr>${sh.preview.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${sh.preview.rows.map((row) => `<tr>${row.map((v) => `<td class="${typeof v === "number" ? "n" : ""}">${v == null ? "" : esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
          <p class="muted" style="font-size:12px;margin:4px 0 0">${sh.preview.rows.length} dòng đầu${sh.columns.length > sh.preview.columns.length ? ` · ${sh.preview.columns.length}/${sh.columns.length} cột đầu` : ""}</p>` : '<div class="empty">Sheet trống</div>'}
      </details>`).join("")}</div>`;
  }).join("");
}
function renderSlots() {
  const ro = S.roles || {};
  $("#slots-data").innerHTML = ["tracker", "activity", "converted"].map(slot).join("");
  $("#slots-setting").innerHTML = slot("logic");
  $("#run-btn").disabled = !!S.detecting || !S.roles || ROLES.some((role) => role !== "activity" && !S.roles[role]);  // Chạy fetches it
  for (const id of ["#pick", "#pick-files"]) $(id).disabled = !!S.detecting;
  $("#slots-pending").innerHTML = (S.detecting || []).map((p) => `<div class="slot" aria-busy="true"><span class="spin" aria-hidden="true"></span>
    <div><div class="name" data-no-i18n>${esc(p.split(/[\\/]/).pop())}</div><div class="meta">Đang đọc & kiểm tra file…</div></div></div>`).join("");
}
const ROLES = ["tracker", "ads", "activity", "logic"];
let detectQueue = Promise.resolve();
function useInputs(paths) {  // one detect at a time: a second drop waits for the first
  if (!paths || !paths.length) return detectQueue;
  return (detectQueue = detectQueue.then(() => detectInputs(paths)));
}
async function detectInputs(paths) {
  S.detecting = paths.filter((p) => !S.paths.includes(p));  // re-checks of listed files: buttons locked, no new rows
  renderSlots();
  // New picks go first so they replace an earlier file of the same role.
  const r = await api.detect([...paths, ...S.paths]).finally(() => { S.detecting = null; renderSlots(); });
  if (bad(r)) return;
  S.roles = r.roles;
  S.paths = [...new Set(Object.values(r.roles).flatMap((x) => x.paths || [x.path]))];
  const msgs = [];
  if (r.missing.length) msgs.push("Còn thiếu: " + r.missing.filter((m) => !(m === "ads" && r.roles.tracker) && m !== "activity").map((m) => ROLE_NAME[m]).join(", ")
    + (r.tracker_missing?.length ? ` (CSV còn thiếu: ${r.tracker_missing.join(", ")})` : ""));
  if (r.unknown.length) msgs.push("Không nhận ra: " + r.unknown.join(", "));
  $("#input-error").textContent = msgs.join(" · ");
  renderSlots();
}
// Operators / Members don't run data: a dropped .pmkt opens as a report; anything else is ignored (feedback #75 –
// it used to land on the run page as "Không nhận ra").
window.onDropPaths = async (paths) => {
  if (!document.body.classList.contains("viewer")) { go("run"); useInputs(paths); return; }
  const p = paths.find((x) => /\.pmkt$/i.test(x));
  if (!p) { toast("Kéo thả file báo cáo .pmkt để mở."); return; }
  const r = await api.open_local_report(p);
  if (!bad(r)) { setRun(r); await loadRole(); go("results"); }
};
const STEPS = { fetch: "Lấy dữ liệu – Activity Log (Ads) · file SharePoint", load: "Đọc & làm sạch data", logic: "Kiểm tra file logic", rules: "Tầng 0–4 – Data check · Pacing · Trend · Campaign · Action log", claude: "Claude – Insight · To-do · Tin nhắn", review: "Claude rà soát logic", logic_eval: "Claude đánh giá lỗi file logic" };
const STEP_STATE = {};
let RUN_T0 = 0, ETA = null, ETA_AT = 0, ETA_TIMER = null;
function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  const [sec, min] = I18N.lang === "en" ? ["s", "min"] : ["giây", "phút"];
  return s < 60 ? `${s} ${sec}` : `${Math.floor(s / 60)} ${min} ${String(s % 60).padStart(2, "0")} ${sec}`;
}
function renderEta() {
  const el = $("#eta");
  if (!el) return;
  const elapsed = (Date.now() - RUN_T0) / 1000;
  if (ETA == null) { el.textContent = `Đã chạy ${fmtSecs(elapsed)}`; return; }
  const left = Math.max(0, ETA - (Date.now() - ETA_AT) / 1000);
  const share = elapsed + left > 0 ? Math.min(99, (elapsed / (elapsed + left)) * 100) : 0;
  el.innerHTML = `Đã chạy ${fmtSecs(elapsed)} · <b>còn khoảng ${left < 1 ? "vài giây" : fmtSecs(left)}</b>`;
  $("#eta-bar").style.width = share + "%";
}
function stepLine(k, v, sub) {
  const badge = v.state === "running" ? '<span class="spin" aria-label="đang chạy"></span>'
    : v.state === "stopped" ? '<span class="sev INFO">ĐÃ DỪNG</span>'
    : `<span class="sev ${v.state === "done" ? "OK" : "MED"}">${v.state === "done" ? "XONG" : "CẢNH BÁO"}</span>`;
  const label = sub && k.includes(":") ? k.slice(k.indexOf(":") + 1) : STEPS[k] || k;
  return `<div class="check" ${sub ? 'style="padding-left:22px"' : ""}>${badge}${esc(label)} <span class="muted">${v.detail ? "— " + esc(v.detail) : ""}</span></div>`;
}
// Sub-steps: "fetch:<file>" under Lấy dữ liệu; "pic:<PIC>" and "review" under Claude
const stepParent = (k) => k.startsWith("fetch:") ? "fetch" : k.startsWith("pic:") || k === "review" ? "claude" : null;
// RUN_GEN: bumped by every Run and Stop – an older run's late answer is ignored. RUNNING: a stopped run's last
// progress messages (already on their way) change nothing.
let RUN_GEN = 0, RUNNING = false;
window.onProgress = (step, state, detail, extra) => {
  if (!RUNNING) return;
  if (!RUN_T0) RUN_T0 = Date.now();
  STEP_STATE[step] = { state, detail };
  if (extra && extra.eta != null) { ETA = extra.eta; ETA_AT = Date.now(); }
  if (extra && extra.run_id) prefetchPerf(extra.run_id);
  renderSteps();
};
function renderSteps() {
  const keys = Object.keys(STEP_STATE);
  const subsOf = (p) => keys.filter((k) => stepParent(k) === p);
  const subs = subsOf("claude");
  const n = subs.length, fin = subs.filter((k) => STEP_STATE[k].state !== "running").length;
  $("#progress").innerHTML = `<div class="prog" aria-hidden="true"><span id="eta-bar"></span></div><p class="muted" id="eta" style="font-size:12px;margin:0 0 6px" role="status"></p>` +
    keys.filter((k) => !stepParent(k)).map((k) =>
      stepLine(k, k === "claude" && n ? { ...STEP_STATE[k], detail: `${fin}/${n} phần xong · ${STEP_STATE[k].detail}` } : STEP_STATE[k], false) +
      subsOf(k).map((s) => stepLine(s, STEP_STATE[s], true)).join("")).join("");
  renderEta();
}
function runningUi(on, stopped) {
  RUNNING = on;
  clearInterval(ETA_TIMER);
  if (on) { RUN_T0 = Date.now(); ETA = null; ETA_TIMER = setInterval(renderEta, 1000); }
  else if ($("#eta") && stopped) $("#eta").textContent = "Đã dừng";
  else if ($("#eta")) { $("#eta").textContent = `Xong sau ${fmtSecs((Date.now() - RUN_T0) / 1000)}`; $("#eta-bar").style.width = "100%"; }
  $("#run-btn").classList.toggle("hidden", on);
  $("#stop-btn").classList.toggle("hidden", !on);
  $("#stop-btn").disabled = false;
  $("#stop-btn").innerHTML = '<svg class="i" aria-hidden="true"><use href="#x"/></svg>Dừng';
}
async function stopRun() {  // #60: the run ends now – the backend drops its work in the background
  if (!RUNNING) return;
  const gen = ++RUN_GEN;  // doRun ignores the stopped run's answer
  Object.entries(STEP_STATE).forEach(([k, v]) => { if (v.state === "running") STEP_STATE[k] = { ...v, state: "stopped" }; });
  renderSteps();
  runningUi(false, true);
  $("#run-btn").disabled = false;
  const r = await api.cancel_run();
  if (gen !== RUN_GEN) return;  // a new run already started
  if (r && r.run_id) {  // the rule results were saved before the Stop: show them
    const run = await api.results(r.run_id);
    if (gen === RUN_GEN && run && run.result && !run.error) {
      setRun(run);
      go("results");
      toast("Đã dừng – kết quả rule đầy đủ, phần Claude bị bỏ dở.");
      return;
    }
  }
  toast("Đã dừng – chưa có kết quả mới.");
}
function runError(r) {
  // A failing step stops the run: drop the progress view, say what to fix and exactly where.
  clearInterval(ETA_TIMER);
  const loc = r.location || {};
  const where = loc.file ? `<div class="kv" style="margin-top:8px"><dt>File</dt><dd data-no-i18n>${esc(loc.file)}</dd>
      ${loc.sheet ? `<dt>Sheet</dt><dd data-no-i18n>${esc(loc.sheet)}</dd>` : ""}
      ${loc.columns ? `<dt>Cột cần có</dt><dd data-no-i18n><b>${loc.columns.map(esc).join(", ")}</b>${loc.row ? ` (dòng tiêu đề ${loc.row})` : ""}</dd>` : ""}
      ${loc.cell ? `<dt>Ô</dt><dd data-no-i18n><b>${esc(loc.cell)}</b></dd>` : ""}</div>` : "";
  $("#progress").innerHTML = `<div class="run-error" role="alert"><div style="display:flex;gap:8px;align-items:center"><span class="sev HIGH">LỖI</span>
      <b>Dừng ở bước: ${esc(STEPS[r.step] || r.step || "Đọc dữ liệu")}</b></div>
    <p style="margin:8px 0 0">${esc(r.error)}</p>${where}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Sửa file theo chỉ dẫn trên, lưu lại, rồi bấm Chạy lần nữa.</p></div>`;
  $("#input-error").textContent = "";
}
function actStatus(email, busy) {
  if (!busy) { S.actEmail = email || null; renderSlots(); }
  $("#act-status").innerHTML = busy ? '<span class="spin"></span> Đang xuất Activity Log từ Ads…'
    : email ? `Đã đăng nhập Ads: <span data-no-i18n>${esc(email)}</span> · <a href="#" id="act-out">Đăng xuất</a>` : "";
}
async function fetchActivity() {  // → true when the Activity Log slot now holds a fresh export
  $("#act-fetch").disabled = true;
  actStatus(null, true);
  const r = await api.activity_fetch().finally(() => { $("#act-fetch").disabled = false; });
  actStatus(r.email);
  if (bad(r)) return false;
  await useInputs([r.path]);
  toast(r.skipped && r.skipped.length ? `Đã lấy Activity Log mới từ Ads – thiếu ${r.skipped.length} profile: ${r.skipped.join("; ")}`
    : "Đã lấy Activity Log mới từ Ads");
  return true;
}
async function fetchSharePoint() {  // sign in once (app window) and download the files shared one by one
  $("#sp-fetch").disabled = true;
  $("#act-status").innerHTML = '<span class="spin"></span> Đang tải file từ SharePoint…';
  const r = await api.sharepoint_fetch().finally(() => { $("#sp-fetch").disabled = false; actStatus(S.actEmail); });
  if (bad(r)) return;
  await useInputs(r.paths);
  toast("Đã tải file mới từ SharePoint");
}
async function doRun() {
  const gen = ++RUN_GEN;
  $("#run-btn").disabled = true;
  runningUi(true);
  Object.keys(STEP_STATE).forEach((k) => delete STEP_STATE[k]);
  window.onProgress("fetch", "running", "");
  if ($("#use-claude").checked) await checkClaude();
  if (gen !== RUN_GEN) return;  // stopped while Claude was checked
  const r = await api.run(S.paths, $("#as-of").value || null, $("#use-claude").checked);
  if (gen !== RUN_GEN) return;  // stopped (stopRun already freed the UI) – this is the old run's late answer
  runningUi(false);
  $("#run-btn").disabled = false;
  if (r.error) { runError(r); return; }
  useInputs(r.paths || S.paths);  // the fetched Activity Log; files are no longer "Mới" after a run
  if (r.cancelled) { toast("Đã dừng – chưa có kết quả mới."); return; }
  setRun(r);
  if (r.stopped) toast("Đã dừng – kết quả rule đầy đủ, phần Claude bị bỏ dở.");
  if (r.ai && !r.ai.claude_ok) setPill("warn", "Lỗi ở lần chạy này", r.ai.error || "");
  go("results");
  if (S.role && S.role.signed_in && RUNNER(S.role)) uploadReport();  // feedback #36: a Lead's finished run goes to the team right away
}

// ------------------------------------------------------------------ results
function setRun(r) {
  S.run = r.result; S.ai = r.ai; S.runId = r.run_id; S.open.clear(); S.db = null;
  const digest = [...S.run.digest].sort((a, b) => (b.pl_high + b.camp_high) - (a.pl_high + a.camp_high));
  if (S.pic !== ALL_PIC && !digest.some((d) => d.pic === S.pic)) S.pic = digest.length ? digest[0].pic : null;
  $("#pic").innerHTML = `<option value="${ALL_PIC}" ${S.pic === ALL_PIC ? "selected" : ""}>Tất cả PIC</option>`
    + digest.map((d) => `<option ${d.pic === S.pic ? "selected" : ""}>${esc(d.pic)}</option>`).join("");
  const asOf = S.run.as_of;
  const d = new Date(asOf + "T00:00:00");
  const shift = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`; };
  const modelTxt = S.run.model === "score_v3" ? " · mô hình chấm điểm" : "";
  $("#run-meta").innerHTML = `Data đến <span class="num">${ddmm(asOf)}/${asOf.slice(0, 4)}</span> · L7D ${shift(-6)}–${shift(0)} vs P7D ${shift(-13)}–${shift(-7)} · Logic <code>Ver ${S.run.logic_version}</code>${modelTxt}`;
  $("#run-meta").title = $("#run-meta").textContent;  // shortened with "…" in a narrow window
  $("#f-run").textContent = `Lần chạy: ${S.runId}`;
  $("#f-logic").innerHTML = `Logic: <code>Ver ${S.run.logic_version}</code>`;
  const high = S.run.digest.reduce((a, x) => a + x.pl_high + x.camp_high, 0);
  $("#nav-results").textContent = high; $("#nav-results").classList.toggle("hidden", !high);
  renderResults();
  S.pf = null; loadPerf();  // preload Performance Review in the background so opening the tab is instant
}
function aiFor(pic) { return ((S.ai || {}).per_pic || {})[pic] || null; }
const DIGEST_KEYS = ["pl_high", "pl_med", "pl_trend_review", "camp_high", "camp_med", "camp_followup", "excess_new"];
function digestFor(pic) {
  if (pic !== ALL_PIC) return S.run.digest.find((x) => x.pic === pic);
  const z = { pic: ALL_PIC }; DIGEST_KEYS.forEach((k) => (z[k] = 0));
  S.run.digest.forEach((d) => DIGEST_KEYS.forEach((k) => (z[k] += d[k] || 0)));
  return z;
}
const F_DEFAULT = { sev: "HM", action: "", trend: "", status: "", q: "", sort: "sev", dir: 1, todoSev: "", todoDue: "" };
S.f = { ...F_DEFAULT };
function renderResults() {
  const body = $("#results-body");
  if (!S.run || !S.pic) { body.innerHTML = '<div class="empty" style="margin-top:12px">Chưa có kết quả – vào “Chạy dữ liệu”.</div>'; return; }
  const allPic = S.pic === ALL_PIC;
  const d = digestFor(S.pic);
  const mine = allPic ? null : aiFor(S.pic);
  const issues = S.run.issues || [];
  const tab = S.tab || "t-alerts";
  const todos = mine ? mine.todos : [];
  const picHint = '<div class="empty">Chọn 1 PIC để xem phần này.</div>';
  body.innerHTML = `
    ${freshBar()}
    ${S.run.unreliable ? '<div class="warnbar"><svg class="i" aria-hidden="true"><use href="#alert"/></svg><b>CẢNH BÁO DATA</b> – xem tab Data trước khi action.</div>' : ""}
    ${logicBanner()}
    ${layoutHtml("results", {
    score: scoreModelHtml(d),
    kpis: `<div class="grid g5">
      <div class="card kpi"><div class="lbl">PL HIGH (pacing)</div><div class="val high num">${d.pl_high}</div></div>
      <div class="card kpi"><div class="lbl">PL MED (pacing)</div><div class="val med num">${d.pl_med}</div></div>
      <div class="card kpi"><div class="lbl">PL trend cần review</div><div class="val num">${d.pl_trend_review}</div></div>
      <div class="card kpi"><div class="lbl">Camp HIGH / MED · follow-up</div><div class="val num"><span style="color:var(--high)">${d.camp_high}</span> / <span style="color:var(--med)">${d.camp_med}</span> · ${d.camp_followup}</div></div>
      <div class="card kpi"><div class="lbl">Excess spend cần action</div><div class="val num">${money(d.excess_new)}</div></div>
    </div>`,
    tabs: `<div class="tabs" role="tablist">
      ${[["t-alerts", "Cảnh báo"], ["t-todos", `To-do (${todos.length})`], ["t-insights", "Insight"], ["t-data", `Data ⚠ (${issues.length})`]]
        .map(([id, label]) => `<button role="tab" aria-selected="${id === tab}" data-tab="${id}">${label}</button>`).join("")}
    </div>
    <div class="tabpanel ${tab === "t-alerts" ? "on" : ""}" id="t-alerts">${filterBar()}${alertsTable()}</div>
    <div class="tabpanel ${tab === "t-todos" ? "on" : ""}" id="t-todos">${allPic ? picHint : todosHtml(mine)}</div>
    <div class="tabpanel ${tab === "t-insights" ? "on" : ""}" id="t-insights">${allPic ? picHint : insightsHtml(mine)}</div>
    <div class="tabpanel ${tab === "t-data" ? "on" : ""}" id="t-data">${issues.length ? issues.map((i) => `<div class="todo"><span class="sev ${i.severity === "WARN" ? "MED" : "INFO"}">${i.severity === "WARN" ? "DATA" : "INFO"}</span><div><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div></div></div>`).join("") : '<div class="empty">Data ổn.</div>'}</div>`,
    ...resultExtras() })}`;
  drawResultExtras();
  S.origSlack = mine ? mine.slack : "";
}
function freshBar() {  // every source's newest day, saved with the run: green = up to date, red = late
  const inp = S.run.inputs || {}, fresh = inp.fresh, stale = inp.stale || [];
  if (!fresh) return stale.length ? `<div class="warnbar"><b>DATA CŨ</b>&nbsp;– ${stale.map(esc).join(" · ")}</div>` : "";  // older runs
  const bad = stale.length > 0;
  const when = (d) => d ? (d.length > 10 ? `${ddmm(d)} ${d.slice(11, 16)}` : ddmm(d)) : "—";
  const items = fresh.map((f) => `<span class="fresh-i ${f.ok ? "" : "late"}" title="${esc(f.file)}${f.need ? ` · cần từ ${ddmm(f.need)}` : ""}"><span data-no-i18n>${esc(f.table)}</span> <b class="num">${when(f.day)}</b></span>`).join("");
  return `<div class="freshbar ${bad ? "bad" : ""}" role="status"><svg class="i" aria-hidden="true"><use href="#${bad ? "alert" : "check"}"/></svg>
    <div><b>${bad ? "DATA CŨ" : "Data mới nhất"}</b> <span class="fresh-list">${items}</span>
    ${bad ? `<ul style="margin:4px 0 0;padding-left:18px">${stale.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div></div>`;
}
function logicBanner() {
  const errs = (S.run.logic_issues || []).filter((i) => i.hint === "error");
  if (!errs.length) return "";
  const crit = ((S.ai || {}).logic_eval?.items || []).filter((x) => x.verdict === "critical").length;
  return `<div class="warnbar"><svg class="i" aria-hidden="true"><use href="#alert"/></svg><b>FILE LOGIC</b> – ${esc(S.run.logic_file || "")}: ${errs.length} lỗi, đang dùng giá trị dự phòng${crit ? ` · <b>${crit} nghiêm trọng</b>` : ""}.
    <span style="flex:1"></span><button class="btn sm" data-goto="review">Xem hướng dẫn sửa</button></div>`;
}
function claudeMissing(mine) {
  const err = !S.ai ? "Lần chạy này không dùng Claude" : (mine && mine.error) || S.ai.error;
  return `<div class="empty"><b>Claude không sẵn sàng</b><br>${esc(err || "")}<br>Kết quả rule vẫn đầy đủ ở tab Cảnh báo.</div>`;
}
function evBtn(units, label = "Bằng chứng") {
  const list = (Array.isArray(units) ? units : [units]).filter((u) => /^(pl|camp|pic):/.test(u || ""));
  if (!list.length) return "";
  return `<button class="fb evb" data-ev="${esc(list.join("|"))}" title="Xem dữ liệu gốc: file, sheet, cột, dòng"><svg class="i" aria-hidden="true"><use href="#file"/></svg>${label}</button>`;
}
function opts(list, cur, all) {
  return [`<option value="">${esc(all)}</option>`, ...list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`)].join("");
}
// SCALE UP = grow → green; otherwise colour follows severity.
function actionColor(action, sevLevel) {
  if (String(action || "").startsWith("SCALE UP") || String(action || "").startsWith("MAINTAIN/PUSH")) return "var(--ok)";
  return sevLevel === "HIGH" ? "var(--high)" : sevLevel === "MED" ? "var(--med)" : "var(--fg)";
}
function scoreModelHtml(d) {
  if (S.run.model !== "score_v3" || !S.run.dept) return "";
  const dp = S.run.dept, pic = (S.run.pics || []).find((x) => x.pic === S.pic);
  const regimeCls = dp.regime === "VƯỢT" ? "HIGH" : dp.regime === "CÒN ROOM" ? "OK" : "INFO";
  return `<div class="card" style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px">
    <span><b>Department</b> · target TACoS <b class="num">${pct(dp.target_tacos, 1)}</b> · actual <b class="num">${pct(dp.actual_tacos, 1)}</b>
      · coverage <span class="num">${pct(dp.coverage)}</span> · <span class="sev ${regimeCls}">${esc(dp.regime)}</span>
      · ngưỡng SCALE DOWN <b class="num">${esc(dp.sd_threshold)}</b></span>
    ${pic ? `<span style="flex:1"></span><span><b>${esc(S.pic)}</b> · <span class="lab" style="color:${actionColor(pic.pacing_action, pic.pacing_sev)}">${esc(pic.pacing_action)}</span>
      ${pic.score != null ? `· điểm <b class="num">${Math.round(pic.score)}</b>` : ""} · Excess$ vs Dept <b class="num">${money(pic.excess_dept)}</b>
      ${evBtn("pic:" + S.pic)}</span>` : ""}
  </div>`;
}
const picOk = (r) => S.pic === ALL_PIC || r.pic === S.pic;
function filterBar() {
  const mineCamps = S.run.camp.filter(picOk);
  const minePls = S.run.pl.filter(picOk);
  const actions = [...new Set([...minePls.map((p) => short(p.pacing_action)), ...mineCamps.map((c) => short(c.base_action))])].sort();
  const trends = [...new Set(minePls.map((p) => p.trend_label).filter(Boolean))].sort();
  return `<div class="filters">
    <input type="search" id="f-q" placeholder="Tìm PL / campaign…" value="${esc(S.f.q)}" aria-label="Tìm">
    <select id="f-sev" aria-label="Mức">${opts([["HM", "HIGH + MED"], ["HIGH", "Chỉ HIGH"], ["MED", "Chỉ MED"], ["LOW", "Chỉ LOW"]], S.f.sev, "Mọi mức")}</select>
    <select id="f-action" aria-label="Action">${opts(actions.map((a) => [a, a]), S.f.action, "Mọi action")}</select>
    <select id="f-trend" aria-label="Trend">${opts(trends.map((t) => [t, t]), S.f.trend, "Mọi trend")}</select>
    <select id="f-status" aria-label="Trạng thái">${opts([["CHƯA ACTION", "Chưa action"], ["ĐÃ ACTION", "Đã action (follow-up)"], ["ACTION CŨ", "Action cũ"]], S.f.status, "Mọi trạng thái")}</select>
    <button class="btn sm ghost" id="f-reset">Xoá lọc</button>
    <span style="flex:1"></span><button class="btn sm" id="cols-btn" aria-haspopup="true"><svg class="i" aria-hidden="true"><use href="#cols"/></svg>Cột</button>
  </div>`;
}
const SEV_OK = (s, f) => !f || (f === "HM" ? s === "HIGH" || s === "MED" : s === f);
const SORTS = {
  sev: [(r) => SEV[r.pacing_sev ?? r.sev] ?? 3, 1], name: [(r) => (r.pl || r.campaign || "").toLowerCase(), 1],
  gmv: [(r) => r.pct_gmv ?? -1, -1], spend: [(r) => r.pct_spend ?? -1, -1], tacos: [(r) => r.actual_tacos ?? -1, -1],
  dspend: [(r) => r.d_spend ?? -9, -1], excess: [(r) => r._excess ?? r.excess ?? 0, -1],
  dnmv: [(r) => dNmv(r) ?? -9, -1], lastaction: [(r) => String(r.last_action_date || (r.pl && !r.campaign ? lastActionOfPl(r.pl) : "") || ""), -1],
  score: [(r) => r.score ?? -999, -1],
};
function sortRows(rows) {
  const [key, natural] = SORTS[S.f.sort] || SORTS.sev;
  const dir = natural * S.f.dir;
  return rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || (SEV[a.pacing_sev ?? a.sev] ?? 3) - (SEV[b.pacing_sev ?? b.sev] ?? 3); });
}
function th(c) {  // sort is handled by the Excel-style column menu (▾)
  const info = `<button class="colinfo" data-col="${c.key}" aria-label="Định nghĩa ${esc(c.label)}" title="Định nghĩa"><svg class="i" aria-hidden="true"><use href="#info"/></svg></button>`;
  return `<th class="${c.cls || ""}"><span class="thw">${c.label}${info}</span></th>`;
}
function colInfo(btn) {
  const c = COLS.find((x) => x.key === btn.dataset.col), d = c.def, pop = $("#colpop");
  pop.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><b style="flex:1">${esc(c.label)}</b>
      ${c.fixed ? "" : `<button class="btn sm ghost" data-hidecol="${c.key}">Ẩn cột</button>`}<button class="btn sm ghost" data-closepop aria-label="Đóng">✕</button></div>
    <p style="margin:6px 0">${esc(d.what)}</p>
    ${d.formula ? `<div class="poplab">Công thức</div><div class="code-box" style="font-size:12px">${esc(d.formula)}</div>` : ""}
    <div class="poplab">Lấy từ</div><ul>${d.map.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
    ${d.note ? `<p class="muted" style="font-size:12px;margin:4px 0 0">${esc(d.note)}</p>` : ""}`;
  const r = btn.getBoundingClientRect();
  pop.classList.remove("hidden");
  const w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  pop.style.top = Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8) + "px";
  pop.querySelector("[data-closepop]").focus();
}
function colChooser(btn) {
  const pop = $("#colpop"), hide = hiddenCols(), v3 = S.run.model === "score_v3";
  pop.innerHTML = `<div style="display:flex;align-items:center"><b style="flex:1">Hiện / ẩn cột</b><button class="btn sm ghost" data-closepop aria-label="Đóng">✕</button></div>
    ${COLS.filter((c) => !c.v3 || v3).map((c) => `<label class="colchk"><input type="checkbox" data-togglecol="${c.key}" ${hide.has(c.key) && !c.fixed ? "" : "checked"} ${c.fixed ? "disabled" : ""}> ${esc(c.label)}</label>`).join("")}
    <button class="btn sm ghost" data-showall style="margin-top:6px">Hiện tất cả</button>`;
  const r = btn.getBoundingClientRect();
  pop.classList.remove("hidden");
  pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = r.bottom + 6 + "px";
}
function setHidden(set) { store("hiddenCols2", JSON.stringify([...set])); renderResults(); }
// Result columns: header, cells (PL row / campaign row), sort key and the definition shown by the ⓘ button.
// Definitions follow the code (aggregate.py, rules/, evidence.py) – keep them in sync when a formula changes.
const COLS = [
  { key: "name", label: "Product Line / Campaign", sort: "name", fixed: true,
    def: { what: "PL là Product Line; bấm dòng PL để xem các campaign của PL đó.",
      map: ["PL: Product Info › product_line_old, nối ASIN → SKU → PL", "PIC: Product Info › cột PIC của tháng (v3: PMKT PIC_Final)", "Campaign: ads_camp › campaign_name, gán vào PL theo ASIN quảng cáo"] },
    pl: (p, kids, open) => `<td><b>${esc(p.pl)}</b>${kids.length ? ` <span class="muted">(${kids.length})</span>` : ""}</td>`,
    camp: (c) => `<td class="muted" title="${esc(c.campaign)}">${esc(c.campaign)}</td>` },
  { key: "sev", label: "Alert Level", sort: "sev",
    def: { what: "Mức độ ưu tiên của cảnh báo: HIGH (xử lý ngay), MED (trong tuần), LOW (theo dõi).",
      formula: "PL: theo rule pacing đầu tiên khớp · Campaign: theo ACoS camp ÷ ACoS PL, số click và excess spend",
      map: ["Ngưỡng: Alert_Logic › Config (vd. “Excess spend để lên HIGH”)"] },
    pl: (p) => `<td>${sev(p.pacing_sev)}</td>`, camp: (c) => `<td>${sev(c.sev)}</td>` },
  { key: "placode", label: "PL action code",
    def: { what: "Hướng ngân sách của Product Line (chỉ ở dòng PL).",
      formula: "Mô hình chấm điểm: điểm ≥ 50 → SCALE DOWN, ≥ 25 → OPTIMIZE, ≤ −25 → SCALE UP, còn lại MAINTAIN; luật cứng NO DATA / NO PLAN / KHÔNG CHẠY / CHƯA ĐỦ DATA / BUDGET CAP; chốt chặn tồn kho đổi SCALE UP → CHỜ HÀNG",
      map: ["Ngưỡng: Logic › Config (D, E, K)"] },
    pl: (p) => `<td class="lab" style="color:${actionColor(p.pacing_action, p.pacing_sev)}">${esc(short(p.pacing_action))}</td>`, camp: () => "<td></td>" },
  { key: "dspend2", label: "Change in spend", sort: "dspend", cls: "n",
    def: { what: "Thay đổi chi tiêu 7 ngày gần nhất so với 7 ngày trước đó (% và số tuyệt đối).", formula: "% = Spend L7D ÷ Spend P7D − 1 · tuyệt đối = Spend L7D − Spend P7D",
      map: ["PL: raw_sso_us › sp_spend + sb_spend + sd_spend", "Campaign: ads_camp › spend_usd"] },
    pl: (p) => `<td class="n">${signed(p.d_spend)} <span class="muted">${moneyDelta(dSpendAbs(p))}</span></td>`,
    camp: (c) => `<td class="n">${signed(c.d_spend)} <span class="muted">${moneyDelta(dSpendAbs(c))}</span></td>` },
  { key: "dnmv", label: "Change in NMV", sort: "dnmv", cls: "n",
    def: { what: "Thay đổi doanh thu 7 ngày gần nhất so với 7 ngày trước đó (% và số tuyệt đối).", formula: "PL: GMV L7D ÷ GMV P7D − 1 · Campaign: sales L7D ÷ sales P7D − 1",
      map: ["PL: raw_sso_us › ordered_gmv_usd", "Campaign: ads_camp › sales_14d"] },
    pl: (p) => `<td class="n">${signed(dNmv(p))} <span class="muted">${moneyDelta(dNmvAbs(p))}</span></td>`,
    camp: (c) => `<td class="n">${signed(dNmv(c))} <span class="muted">${moneyDelta(dNmvAbs(c))}</span></td>` },
  { key: "lastaction", label: "Last action", sort: "lastaction",
    def: { what: "Hành động gần nhất của PIC trên campaign (PL: hành động mới nhất trong các campaign của PL).",
      formula: "Khớp Activity Log theo tên campaign; trong 3 ngày gần nhất = ĐÃ ACTION, cũ hơn mà vẫn còn cảnh báo = ACTION CŨ",
      map: ["Activity Log › Level (Campaign: …), Type, thời gian"] },
    pl: (p) => { const d = lastActionOfPl(p.pl); return `<td class="muted" style="white-space:nowrap">${d ? ddmm(d) : "—"}</td>`; },
    camp: (c) => {
      const base = c.last_action_date ? `${ddmm(String(c.last_action_date))} <span class="muted">${esc(c.last_action_type || "")}</span>` : '<span class="muted">—</span>';
      const chip = c.status && c.sev ? ` <span class="chip">${esc(c.status)}</span>` : "";
      let extra = "";
      if (c.sev && c.status === "ĐÃ ACTION" && c.followup_due) extra = ` <span class="muted">follow up ${ddmm(String(c.followup_due))}</span>`;
      else if (c.sev && c.status === "ACTION CŨ") extra = ' <span class="muted">→ action lại</span>';
      return `<td style="white-space:nowrap">${base}${chip}${extra}</td>`;
    } },
  { key: "campcode", label: "Campaign action code",
    def: { what: "Việc nên làm với campaign (chỉ ở dòng campaign).",
      formula: "Chưa đủ click → WAIT; đủ click 0 order → PAUSE/NEGATE; còn lại so ACoS camp ÷ ACoS PL theo action của PL; ≥50% spend trên ASIN hết hàng → PAUSE – HẾT HÀNG, sắp hết → GIỮ – SẮP HẾT",
      map: ["ads_camp (L7D, P7D) · Logic › Config G, K"] },
    pl: () => "<td></td>",
    camp: (c) => `<td class="lab" style="color:${actionColor(c.base_action, "")}">${esc(c.base_action || "—")}</td>` },
  { key: "reason", label: "Reason",
    def: { what: "Vì sao có cảnh báo / khuyến nghị.", formula: "PL: TACoS, target riêng & Dept, Excess$ vs Dept, GMV/Spend pace, điểm, tồn kho · Campaign: ACoS so với PL, click, excess, xu hướng, tồn kho",
      map: ["Tổng hợp từ các cột trên + Evidence"] },
    pl: (p) => `<td class="reason"><div title="${esc(p.pacing_reason || "")}">${esc(p.pacing_reason || "—")}</div></td>`,
    camp: (c) => { const t = campReason(c); return `<td class="reason"><div title="${esc(t)}">${esc(t || "—")}</div></td>`; } },
  { key: "action", label: "Pacing / Action", optional: true,
    def: { what: "Việc nên làm với PL / campaign.",
      formula: "PL (Ver 1): rule đầu tiên khớp theo thứ tự NO PLAN → KHÔNG CHẠY → SCALE DOWN → OPTIMIZE → SCALE UP → BUDGET CAP → CHECK → MAINTAIN, dựa trên GMV pace, Spend pace và TACoS ÷ target. PL (v3): theo Điểm và khung Department. Campaign: theo action của PL + ACoS camp ÷ ACoS PL; trạng thái (đã / chưa action) lấy từ Activity Log.",
      map: ["Ngưỡng: Alert_Logic › Config", "Trạng thái campaign: Activity Log › campaign + ngày action"] },
    pl: (p) => `<td class="lab" style="color:${actionColor(p.pacing_action, p.pacing_sev)}">${esc(short(p.pacing_action))}</td>`,
    camp: (c) => `<td class="lab" style="color:${actionColor(c.base_action, "")}">${esc(c.final_label || short(c.base_action))}</td>` },
  { key: "trend", label: "Trend L7D", optional: true,
    def: { what: "Xu hướng 7 ngày gần nhất (L7D) so với 7 ngày trước đó (P7D).",
      formula: "PL: Δ Spend, Δ ACoS, Δ TACoS so với ngưỡng → tạo key, tra bảng Matrix_PL ra nhãn · Campaign: Δ ACoS và Δ Spend của campaign",
      map: ["PL: raw_sso_us (spend, ppc_ordered_gmv_usd, ordered_gmv_usd)", "Campaign: ads_camp (spend_usd, sales_14d)", "Ngưỡng: Alert_Logic › Config (Spend / ACoS / TACoS) + sheet Matrix_PL"] },
    pl: (p) => `<td class="lab">${esc(p.trend_label || "—")}</td>`,
    camp: (c) => `<td class="muted">${esc(c.camp_trend ? c.camp_trend.replace("7D: ", "") : "")}</td>` },
  { key: "gmv", label: "GMV %", sort: "gmv", cls: "n", optional: true,
    def: { what: "Tiến độ GMV tháng so với target.", formula: "GMV MTD ÷ target GMV tháng",
      map: ["GMV MTD: raw_sso_us › ordered_gmv_usd, từ ngày 1 tới ngày data", "Target: KPI › GMV của tháng, cộng các ASIN của PL"],
      note: "So với time gone: GMV % ÷ time gone = GMV pace (1× là đúng tiến độ)." },
    pl: (p) => `<td class="n">${pct(p.pct_gmv)}</td>`, camp: () => "<td></td>" },
  { key: "spend", label: "Spend %", sort: "spend", cls: "n", optional: true,
    def: { what: "Tiến độ chi tiêu ads tháng so với target.", formula: "Spend MTD ÷ target spend tháng",
      map: ["Spend MTD: raw_sso_us › sp_spend + sb_spend + sd_spend", "Target: KPI › Spend_final của tháng"],
      note: "Spend % ÷ time gone = Spend pace." },
    pl: (p) => `<td class="n">${pct(p.pct_spend)}</td>`, camp: () => "<td></td>" },
  { key: "tacos", label: "TACoS", sort: "tacos", cls: "n", optional: true,
    def: { what: "PL: TACoS tháng / target TACoS. Campaign: ACoS của campaign so với ACoS chung của PL.",
      formula: "TACoS = Spend MTD ÷ GMV MTD · Target TACoS = target spend ÷ target GMV · Campaign: (spend L7D ÷ sales L7D của camp) ÷ (spend L7D ÷ sales L7D của mọi camp trong PL)",
      map: ["raw_sso_us (spend, ordered_gmv_usd) · KPI (GMV, Spend_final)", "Campaign: ads_camp › spend_usd, sales_14d"] },
    pl: (p) => `<td class="n">${pct(p.actual_tacos, 1)} <span class="muted">/${pct(p.target_tacos, 1)}</span></td>`,
    camp: (c) => `<td class="n">ACoS ${num(c.acos_ratio) ? rhu(c.acos_ratio) + "×" : "—"}</td>` },
  { key: "dspend", label: "Δ Spend", sort: "dspend", cls: "n", optional: true,
    def: { what: "Thay đổi chi tiêu 7 ngày gần nhất so với 7 ngày trước đó.", formula: "Spend L7D ÷ Spend P7D − 1",
      map: ["PL: raw_sso_us › sp_spend + sb_spend + sd_spend", "Campaign: ads_camp › spend_usd"] },
    pl: (p) => `<td class="n">${signed(p.d_spend)}</td>`, camp: (c) => `<td class="n">${signed(c.d_spend)}</td>` },
  { key: "score", label: "Điểm", sort: "score", cls: "n", v3: true, optional: true,
    def: { what: "Điểm tổng hợp của PL (chỉ với file logic mô hình chấm điểm v3). Âm = nên giảm, dương = có thể tăng.",
      formula: "Σ(w × s) ÷ Σw, với s1…s6 = (TACoS ÷ target − 1), (TACoS ÷ target Dept − 1), −(Ads dependency ÷ benchmark − 1), Δ TACoS, GMV pace − 1, Spend pace − 1; mỗi s chia độ nhạy × 100, giới hạn ±100",
      map: ["Trọng số w1–w6 và độ nhạy: Alert_Logic › Config"] },
    pl: (p) => `<td class="n">${p.score != null ? Math.round(p.score) : "—"}</td>`, camp: () => "<td></td>" },
  { key: "excess", label: "Excess $", sort: "excess", cls: "n", optional: true,
    def: { what: "Chi tiêu L7D vượt mức hợp lý – số tiền có thể cắt.", formula: "Campaign: MAX(0, spend L7D − sales L7D × ACoS L7D của PL) · PL: cộng excess của các campaign",
      map: ["ads_camp › spend_usd, sales_14d (7 ngày gần nhất)"] },
    pl: (p) => `<td class="n">${p._excess ? money(p._excess) : "—"}</td>`, camp: (c) => `<td class="n">${money(c.excess)}</td>` },
];
function hiddenCols() {
  // Default view = the Alert_brief "Update" columns; the older metrics stay available in "Cột".
  try { const saved = store("hiddenCols2"); if (saved) return new Set(JSON.parse(saved)); } catch { /* fall through */ }
  return new Set(COLS.filter((c) => c.optional).map((c) => c.key));
}
const dNmv = (r) => (r.p7d_gmv != null ? (r.p7d_gmv ? r.l7d_gmv / r.p7d_gmv - 1 : null) : r.p7d_sales ? r.l7d_sales / r.p7d_sales - 1 : null);
const dSpendAbs = (r) => (num(r.l7d_spend) && num(r.p7d_spend) ? r.l7d_spend - r.p7d_spend : null);
const dNmvAbs = (r) => (r.p7d_gmv != null ? (num(r.l7d_gmv) && num(r.p7d_gmv) ? r.l7d_gmv - r.p7d_gmv : null) : (num(r.l7d_sales) && num(r.p7d_sales) ? r.l7d_sales - r.p7d_sales : null));
const moneyDelta = (v) => (num(v) ? (v >= 0 ? "+" : "−") + "$" + rhu(Math.abs(v)).toLocaleString("en-US") : "");
function lastActionOfPl(pl) {
  const ds = S.run.camp.filter((c) => c.pl === pl && picOk(c) && c.last_action_date).map((c) => String(c.last_action_date));
  return ds.length ? ds.sort().at(-1) : null;
}
function campReason(c) {
  const parts = [];
  if (num(c.acos_ratio)) parts.push(`ACoS ${rhu(c.acos_ratio)}× PL`);
  if (num(c.l7d_clicks)) parts.push(`${Math.round(c.l7d_clicks)} click (cần ${c.min_clicks ?? "—"})`);
  if (c.excess > 0) parts.push(`excess ${money(c.excess)}`);
  if (c.camp_trend) parts.push(c.camp_trend);
  if (c.inv_note) parts.push(c.inv_note);
  if (c.followup_check) parts.push(c.followup_check);
  return parts.join(" · ");
}
function shownCols() {
  const hide = hiddenCols(), v3 = S.run.model === "score_v3";
  return COLS.filter((c) => (!c.v3 || v3) && (c.fixed || !hide.has(c.key)));
}
function alertsTable() {
  const f = S.f, q = f.q.trim().toLowerCase();
  const campOk = (c) => SEV_OK(c.sev, f.sev) && (!f.action || short(c.base_action) === f.action) && (!f.status || c.status === f.status)
    && (!q || c.campaign.toLowerCase().includes(q) || c.pl.toLowerCase().includes(q));
  const byPl = {};
  S.run.camp.filter((c) => picOk(c) && campOk(c)).forEach((c) => (byPl[c.pl] = byPl[c.pl] || []).push(c));
  const plOk = (p) => !f.status && SEV_OK(p.pacing_sev, f.sev) && (!f.action || short(p.pacing_action) === f.action)
    && (!f.trend || p.trend_label === f.trend) && (!q || p.pl.toLowerCase().includes(q));
  const pls = S.run.pl.filter((p) => picOk(p) && (plOk(p) || (byPl[p.pl] && (!f.trend || p.trend_label === f.trend))))
    .map((p) => ({ ...p, _excess: (byPl[p.pl] || []).reduce((a, c) => a + (c.excess || 0), 0) }));
  const visible = sortRows(pls);
  if (!visible.length) return '<div class="empty">Không có dòng nào khớp bộ lọc.</div>';
  const sent = new Set(S.feedbackUnits || []);
  const cols = shownCols();
  const rows = visible.map((p) => {
    const kids = sortRows(byPl[p.pl] || []);
    const open = S.open.has(p.pl) || (q && kids.length);
    const head = `<tr class="expandable" data-pl="${esc(p.pl)}" aria-expanded="${!!open}"><td>${kids.length ? `<svg class="i" aria-hidden="true" style="transform:rotate(${open ? 90 : 0}deg)"><use href="#chev"/></svg>` : ""}</td>
      ${cols.map((c) => c.pl(p, kids, open)).join("")}
      <td class="acts">${evBtn(p.unit_id)}${fbBtn(p.unit_id, `${p.pl} · ${short(p.pacing_action)}`, sent.has(p.unit_id))}</td></tr>`;
    const children = open ? kids.map((c) => `<tr class="child"><td></td>${cols.map((col) => col.camp(c)).join("")}
      <td class="acts">${evBtn(c.unit_id)}${fbBtn(c.unit_id, `${c.campaign} · ${short(c.final_label || c.base_action)}`, sent.has(c.unit_id))}</td></tr>`).join("") : "";
    return head + children;
  }).join("");
  const hiddenN = COLS.filter((c) => (!c.v3 || S.run.model === "score_v3") && !c.fixed && !c.optional && hiddenCols().has(c.key)).length;
  return `<div class="tbl"><table><thead><tr><th></th>${cols.map((c) => th(c)).join("")}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:12px">${visible.length} PL · bấm ▾ ở tiêu đề cột để lọc / sắp xếp · ⓘ xem định nghĩa · “Bằng chứng” mở dữ liệu gốc.${hiddenN ? ` · Đang ẩn ${hiddenN} cột` : ""}</p>`;
}
function todosHtml(mine) {
  if (!mine || (mine.error && !mine.todos.length)) return claudeMissing(mine);
  if (!mine.todos.length) return '<div class="empty">Không có to-do.</div>';
  const list = mine.todos.filter((t) => (!S.f.todoSev || t.severity === S.f.todoSev) && (!S.f.todoDue || t.due === S.f.todoDue));
  return `<div class="filters"><select id="f-todo-sev" aria-label="Mức">${opts([["HIGH", "HIGH"], ["MED", "MED"]], S.f.todoSev, "Mọi mức")}</select>
    <select id="f-todo-due" aria-label="Hạn">${opts([["today", "Hôm nay"], ["week", "Trong tuần"]], S.f.todoDue, "Mọi hạn")}</select></div>`
    + (list.length ? list.map((t) => `<div class="todo">${sev(t.severity)}<div><div class="t">${raw(t.title)}</div><div class="d">${raw(t.detail)}</div></div>
    <div class="r"><span class="muted">${t.due === "today" ? "Hôm nay" : "Trong tuần"}</span><span class="acts">${evBtn(t.refs || [])}${fbBtn((t.refs || [])[0] || "todo:" + t.title, "To-do: " + t.title)}</span></div></div>`).join("") : '<div class="empty">Không có to-do khớp bộ lọc.</div>')
    + (mine.dropped ? `<p class="muted" style="font-size:12px">Đã bỏ ${mine.dropped} câu của Claude vì số liệu không khớp dữ liệu.</p>` : "");
}

// ------------------------------------------------------------------ evidence popup
async function openEvidence(units) {
  S.ev = { units, i: 0 };
  $("#ev").classList.add("on");
  await showEvidence();
}
async function showEvidence() {
  const { units, i } = S.ev;
  $("#ev-tabs").innerHTML = units.length > 1 ? units.map((u, k) => `<button class="btn sm ${k === i ? "primary" : ""}" data-evi="${k}">${esc(u.replace(/^camp:\d+:/, "camp: ").replace(/^pl:/, "PL: "))}</button>`).join("") : "";
  $("#ev-title").textContent = "Bằng chứng";
  $("#ev-body").innerHTML = '<div class="muted"><span class="spin"></span> Đang đọc dữ liệu gốc…</div>';
  const ev = await api.evidence(units[i], S.runId);
  if (ev.error) { $("#ev-body").innerHTML = `<div class="empty">${esc(ev.error)}</div>`; return; }
  $("#ev-title").textContent = ev.title;
  const table = (rows) => {
    if (!rows.length) return '<p class="muted">Không có dòng.</p>';
    const cols = Object.keys(rows[0]);
    return `<div class="tbl" style="max-height:240px"><table><thead><tr>${cols.map((c) => `<th>${c === "_row" ? "Dòng Excel" : esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${typeof r[c] === "number" ? "n" : ""}">${esc(typeof r[c] === "number" && c !== "_row" ? Number(r[c]).toLocaleString("en-US", { maximumFractionDigits: 2 }) : r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  };
  $("#ev-body").innerHTML = `
    <p class="muted" style="font-size:12px;margin-top:0">Data đến ${esc(ev.as_of)} · Logic: ${esc(ev.logic_file)} · File: ${esc(Object.values(ev.files || {}).join(", "))}</p>
    <h3>Cách tính</h3>
    <table><tbody>${ev.calc.map((c) => `<tr><td><b>${esc(c.label)}</b></td><td class="muted">${esc(c.formula)}</td><td class="n"><b>${esc(c.value)}</b></td></tr>`).join("")}</tbody></table>
    <h3>Ngưỡng so sánh</h3>
    <table><tbody>${ev.thresholds.map((t) => `<tr><td>${esc(t.label)}</td><td class="num muted">${esc(t.file)} › ${esc(t.cell)}</td><td class="n"><b>${esc(t.value)}</b></td></tr>`).join("")}</tbody></table>
    <h3>Dữ liệu gốc</h3>
    ${ev.sections.map((s) => `<details class="evsec" ${s.key === "raw_mtd" || s.key === "ads_l7d" ? "open" : ""}><summary><b>${esc(s.title)}</b> · <span class="num">${s.row_count}</span> dòng
      ${Object.keys(s.totals).length ? " · " + Object.entries(s.totals).map(([k, v]) => `${esc(k)} = <span class="num">${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`).join(" · ") : ""}</summary>
      <div class="muted" style="font-size:12px;margin:6px 0">Nguồn: <b>${esc(s.source)}</b><br>Lọc: ${esc(s.filter)}${s.columns_text ? `<br>Cột: ${esc(s.columns_text)}` : ""}${s.row_ranges ? `<br>Dòng Excel: <span class="num">${esc(s.row_ranges.length > 260 ? s.row_ranges.slice(0, s.row_ranges.lastIndexOf(",", 260)) + " … (+" + (s.row_ranges.slice(s.row_ranges.lastIndexOf(",", 260)).split(",").length - 1) + " nhóm dòng)" : s.row_ranges)}</span>` : ""}${s.row_count > s.rows.length ? ` · hiển thị ${s.rows.length}/${s.row_count}` : ""}</div>
      ${table(s.rows)}</details>`).join("")}`;
}
function insightsHtml(mine) {
  const list = !mine || (mine.error && !mine.insights.length) ? claudeMissing(mine)
    : mine.insights.length ? mine.insights.map((i) => `<div class="insight"><span class="ai"><svg class="i" aria-hidden="true"><use href="#spark"/></svg>Claude</span>
      <div>${raw(i.text)}</div><div class="src">${evBtn(i.refs || [])} ${fbBtn((i.refs || [])[0] || "insight", "Insight: " + i.text.slice(0, 60))}</div></div>`).join("")
    : '<div class="empty">Không có insight.</div>';
  const addr = ((S.style || {}).pic_address || {})[S.pic] || {};
  const given = String(S.pic || "").trim().split(/\s+/).pop() || "";
  const opt = (list, cur) => list.map(([v, label]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`).join("");
  return `${list}<h2 style="margin-top:14px">Tin nhắn</h2>
    <div class="grid" style="grid-template-columns:150px 170px 1fr auto;align-items:end;margin-bottom:8px">
      <div><label for="addr-self">Tự xưng</label><select id="addr-self">${opt([["em", "em"], ["anh", "anh"], ["chị", "chị"], ["mình", "mình"], ["tôi", "tôi"], ["", "Không xưng"]], addr.self ?? "em")}</select></div>
      <div><label for="addr-call">Gọi họ là</label><select id="addr-call">${opt([["anh", "anh"], ["chị", "chị"], ["em", "em"], ["bạn", "bạn"], ["name", "Chỉ gọi tên"]], addr.call ?? "chị")}</select></div>
      <div><label for="addr-name">Tên gọi</label><input type="text" id="addr-name" value="${esc(addr.name ?? given)}"></div>
      <button class="btn" id="rewrite"><svg class="i" aria-hidden="true"><use href="#spark"/></svg>Viết lại với Claude</button>
    </div>
    <textarea class="slack-edit" id="slack-text" aria-label="Tin nhắn">${esc(mine ? mine.slack : "")}</textarea>
    <p class="muted" style="font-size:12px;margin:4px 0 0">Xưng hô được lưu riêng cho từng PIC và dùng cho các lần chạy sau.</p>`;
}
async function rewriteMessage() {
  const b = $("#rewrite");
  const addr = { self: $("#addr-self").value, call: $("#addr-call").value, name: $("#addr-name").value.trim() };
  b.disabled = true; b.innerHTML = '<span class="spin"></span> Claude đang viết…';
  const saved = await api.save_pic_address(S.pic, addr);
  if (!bad(saved)) S.style = saved;
  const r = await api.rewrite_message(S.pic, S.runId);
  b.disabled = false; b.innerHTML = '<svg class="i" aria-hidden="true"><use href="#spark"/></svg>Viết lại với Claude';
  if (bad(r)) return;
  S.ai = S.ai || { claude_ok: true, error: null, review: [], per_pic: {} };
  S.ai.per_pic[S.pic] = { insights: [], todos: [], dropped: 0, ...(S.ai.per_pic[S.pic] || {}), slack: r.slack };
  $("#slack-text").value = r.slack;
  S.origSlack = r.slack;
  toast("Đã viết lại tin nhắn.");
}
async function copySlack() {
  const ta = $("#slack-text");
  const text = ta ? ta.value : (aiFor(S.pic) || {}).slack || "";
  if (!text) { toast("Chưa có tin nhắn."); return; }
  copyText(text);
  toast("Đã copy tin nhắn.");
  if (ta && text.trim() !== (S.origSlack || "").trim() && confirm(I18N.t("Lưu bản sửa làm mẫu văn phong?"))) {
    if (!bad(await api.add_style_sample(text))) toast("Đã lưu mẫu văn phong.");
  }
}

// ------------------------------------------------------------------ feedback drawer
function openFb(unit, label) {
  S.fb = { unit, label };
  $("#fbrow").textContent = label;
  $("#fbtxt").value = "";
  $("#fbexp").value = "";
  document.body.classList.add("open");
  $("#fbtxt").focus();
}
function closeFb() { document.body.classList.remove("open"); }
async function sendFb() {
  const issue = $$("#fb-issue button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent).join(", ");
  const item = { unit_id: S.fb.unit, label: S.fb.label, issue, expected: $("#fbexp").value, text: $("#fbtxt").value, run_id: S.runId };
  closeFb();
  toast("Đang gửi góp ý cho Claude phân tích…");
  const r = await api.submit_feedback(item);
  S.feedbackUnits = [...(S.feedbackUnits || []), item.unit_id];
  renderResults();
  if (r.error) { toast(r.error, true); return; }
  toast(r.kind === "lesson" ? "Đã thêm bài học: " + r.lesson_text : r.kind === "param" ? "Có đề xuất sửa tham số – xem Rà soát logic." : "Đã lưu đề xuất rule – xem Rà soát logic.");
}

// ------------------------------------------------------------------ logic review
function bar(b) {
  if (!b) return '<span class="muted">—</span>';
  const add = b.added.HIGH + b.added.MED + b.added.TREND, rem = b.removed.HIGH + b.removed.MED + b.removed.TREND;
  const total = Math.max(add + rem, 1);
  return `<div class="bar" title="thêm ${add} · bỏ ${rem}"><span style="width:${(rem / total) * 100}%;background:var(--ok)"></span><span style="width:${(add / total) * 100}%;background:var(--high)"></span></div>
    <div class="muted num" style="font-size:11px">−${rem} / +${add} alert (HIGH −${b.removed.HIGH} +${b.added.HIGH})</div>`;
}
async function loadReview() {
  const r = await api.review();
  if (bad(r)) return;
  const pending = r.proposals.filter((p) => p.status === "pending");
  const crit = (r.logic_eval?.items || []).filter((x) => x.verdict === "critical").length;
  $("#nav-review").textContent = pending.length + crit; $("#nav-review").classList.toggle("hidden", !(pending.length + crit));
  const findings = r.findings.length ? r.findings.map((f) => `<div class="finding">${sev(f.severity === "INFO" ? "INFO" : f.severity)}<div><b>${raw(f.title)}</b><div class="muted">${raw(f.detail)}</div></div><span class="muted">${f.kind === "param" ? "Tham số" : "Rule mới"}</span></div>`).join("") : '<div class="empty">Chưa có phát hiện (cần chạy với Claude).</div>';
  const fb = r.feedback.slice(-8).reverse();
  const fbHtml = fb.length ? fb.map((f) => `<div class="finding"><span class="sev INFO">${esc(f.status)}</span><div><b>“${raw(f.text || f.issue)}”</b><div class="muted">${esc(f.label || f.unit_id)}</div></div><span class="muted">${esc((f.created || "").slice(0, 10))}</span></div>`).join("") : '<div class="empty">Chưa có góp ý.</div>';
  const props = r.proposals.filter((p) => p.status !== "applied").map((p) => `<tr><td>${esc(p.param_key || "Rule mới")}<div class="muted" style="font-size:12px">${esc(p.title || "")}</div></td>
    <td class="diff">${!p.param_key ? "—" : `<span class="old">${esc(p.old)}</span> → ${p.status === "pending"
      ? `<input class="prop-new" data-prop="${esc(p.id)}" value="${esc(p.new)}"${String(p.param_key).startsWith("matrix:") ? "" : ' type="number" step="any"'}>`
      : `<span class="new">${esc(p.new)}</span>`}`}</td><td class="muted">${esc(p.rationale)}</td>
    <td style="min-width:170px">${bar(p.backtest)}</td>
    <td>${p.status === "saved_rule" ? '<span class="muted">Cần dev</span>' : p.status === "pending"
      ? `<button class="btn sm primary" data-prop="${esc(p.id)}" data-status="approved"><svg class="i" aria-hidden="true"><use href="#check"/></svg>Duyệt</button> <button class="btn sm" data-prop="${esc(p.id)}" data-status="rejected">Bỏ</button>`
      : `${sev(p.status === "approved" ? "OK" : "LOW")} <button class="btn sm ghost" data-prop="${esc(p.id)}" data-status="pending">Hoàn tác</button>`}</td></tr>`).join("");
  const approved = r.proposals.filter((p) => p.status === "approved").length;
  $("#review-body").innerHTML = `${logicCheckHtml(r)}<div class="grid g2"><div><h2>Lỗ hổng phát hiện (lần chạy gần nhất)</h2>${findings}</div><div><h2>Góp ý của bạn</h2>${fbHtml}</div></div>
    <h2 style="margin-top:16px">Đề xuất thay đổi</h2>
    ${props ? `<div class="tbl"><table><thead><tr><th>Tham số</th><th>Thay đổi</th><th>Lý do</th><th>Backtest 4 tuần</th><th></th></tr></thead><tbody>${props}</tbody></table></div>` : '<div class="empty">Chưa có đề xuất.</div>'}
    <div style="display:flex;gap:8px;margin-top:12px;align-items:center"><span class="muted">Đã duyệt: <b class="num">${approved}</b> thay đổi</span><span style="flex:1"></span>
    <button class="btn primary" id="apply" ${approved ? "" : "disabled"}>Tạo phiên bản logic mới & chạy lại</button></div>`;
}

const VERDICT = { critical: ["HIGH", "NGHIÊM TRỌNG"], change: ["MED", "NÊN SỬA"], ignore: ["INFO", "BỎ QUA ĐƯỢC"] };
function logicCheckHtml(r) {
  const ev = r.logic_eval;
  if (!r.logic_issues || !r.logic_issues.length) return r.logic_file ? `<div class="card" style="margin-bottom:12px"><h2 style="margin:0">Kiểm tra file logic</h2><p class="muted" style="margin:6px 0 0">${esc(r.logic_file)}: không có lỗi.</p></div>` : "";
  const unused = r.logic_issues.filter((i) => i.code === "UNUSED");
  const items = (ev?.items || []).map((x) => {
    const [cls, label] = VERDICT[x.verdict] || VERDICT.change, i = x.issue;
    return `<div class="finding"><span class="sev ${cls}">${label}</span><div>
      <b>${esc(i.label || i.key)}</b> <span class="muted num">${esc(i.cell || "chưa có dòng")}</span>
      <div class="muted" style="font-size:12px">${esc(i.message)}${i.value ? ` · giá trị trong file: <code>${esc(i.value)}</code>` : ""}${i.used != null && i.used_from ? ` · đang dùng <b class="num">${esc(i.used)}</b> (${esc(i.used_from)})` : ""}</div>
      <div style="margin-top:4px">${raw(x.reason)}</div>
      ${x.fix ? `<div style="margin-top:4px"><b>Cách sửa:</b> ${esc(x.fix)}${x.suggested_value != null && x.suggested_value !== "" ? ` · gợi ý: <code>${esc(x.suggested_value)}</code>` : ""}</div>` : ""}
    </div><span></span></div>`;
  }).join("");
  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0">Kiểm tra file logic</h2><span class="muted">${esc(r.logic_file || "")}</span><span style="flex:1"></span>
      <span class="ai">${ev?.by_claude ? '<svg class="i" aria-hidden="true"><use href="#spark"/></svg>Claude đánh giá' : "Đánh giá tự động (không có Claude)"}</span></div>
    ${ev?.summary ? `<p style="margin:8px 0">${raw(ev.summary)}</p>` : ""}
    ${items || '<p class="muted">Không có lỗi cần sửa.</p>'}
    ${unused.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:13px">${unused.length} tham số trong file mà app chưa dùng</summary>
      <table style="margin-top:6px"><tbody>${unused.map((i) => `<tr><td>${esc(i.label)}</td><td class="num muted">${esc(i.cell)}</td><td class="n">${esc(i.value ?? "")}</td></tr>`).join("")}</tbody></table></details>` : ""}
  </div>`;
}

// ------------------------------------------------------------------ lessons & history
async function loadLessons() {
  const [l, h] = await Promise.all([api.lessons(), api.history()]);
  if (bad(l) || bad(h)) return;
  $("#f-lessons").textContent = `Bài học: ${l.lessons.length}`;
  $("#lessons-list").innerHTML = l.lessons.length ? l.lessons.map((x, i) => `<div class="check"><span class="sev INFO">#${i + 1}</span><div>${raw(x.text)} <span class="muted">· ${esc((x.created || "").slice(0, 10))}</span></div>
    <button class="btn sm ghost" data-lesson="${esc(x.id)}" aria-label="Xoá bài học" style="margin-left:auto"><svg class="i"><use href="#x"/></svg></button></div>`).join("") : '<div class="empty">Chưa có bài học.</div>';
  $("#versions").innerHTML = h.logic_versions.length ? `<div class="timeline">${h.logic_versions.map((v) => `<div class="ev"><b>Ver ${v.version}</b> ${v.active ? '<span class="sev OK">ĐANG DÙNG</span>' : `<button class="btn sm" data-version="${v.version}">Dùng bản này</button>`}<div class="muted">${esc(v.name)}</div></div>`).join("")}</div>` : '<div class="empty">Chưa có.</div>';
  $("#runs").innerHTML = h.runs.length ? `<table><thead><tr><th>Lần chạy</th><th>Ngày data</th><th>Logic</th><th class="n">Alert</th><th class="n">Góp ý</th></tr></thead><tbody>${h.runs.slice(0, 30).map((r) => `<tr class="expandable" data-run="${esc(r.run_id)}"><td class="num">${esc(r.run_id)}</td><td class="num">${ddmm(r.as_of)}</td><td>Ver ${esc(r.logic_version)}</td><td class="n">${r.alert_count}</td><td class="n">${r.feedback_count}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">Chưa có.</div>';
}

// ------------------------------------------------------------------ settings
async function loadSettings() {
  loadRole();
  loadGy();
  loadUploads();
  const set = await api.get_settings();
  if (bad(set)) return;
  $("#claude-note").value = set.claude_note || "";
  $("#note-count").textContent = `${(set.claude_note || "").length}/4000 ký tự`;
  $("#mem-limit").value = set.memory_limit_mb ?? 1024;
  $("#mem-auto").checked = set.auto_prune !== false;
  loadMemory();
  if (RUNNER(S.role)) loadHistory();
  $("#auto-upd").checked = !!set.auto_update_check;
  const accounts = (((S.run || {}).inputs || {}).ads || {}).accounts || [];
  $("#ads-account").innerHTML = '<option value="">Tự chọn (account nhiều dòng nhất)</option>' +
    [...new Set([...accounts, set.ads_account].filter(Boolean))].map((a) => `<option ${a === set.ads_account ? "selected" : ""}>${esc(a)}</option>`).join("");
  const m = await api.email_map_suggestions();
  if (!m.error) {
    const opts = (cur) => ['<option value="">—</option>', ...m.pics.map((p) => `<option ${p === cur ? "selected" : ""}>${esc(p)}</option>`)].join("");
    $("#emailmap").innerHTML = `<table class="emailmap"><thead><tr><th>Email</th><th>PIC</th></tr></thead><tbody>${Object.entries(m.email_map).map(([e, p]) => `<tr><td>${esc(e)}</td><td><select data-email="${esc(e)}">${opts(p)}</select></td></tr>`).join("")}</tbody></table>`;
  }
  renderVersion();
}
function bytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}
const KIND = { runs: "Lịch sử chạy", logic: "Phiên bản logic", lessons: "Bài học", feedback: "Góp ý", proposals: "Đề xuất", history: "Dữ liệu lịch sử", other: "Khác" };
function renderMemory(m) {
  const share = Math.min(100, (m.bytes / m.limit_bytes) * 100);
  const color = share > 90 ? "var(--high)" : share > 70 ? "var(--med)" : "var(--primary)";
  const o = m.oldest;
  $("#mem-info").innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:13px"><b class="num">${bytes(m.bytes)} / ${bytes(m.limit_bytes)}</b><span class="muted num">${share.toFixed(share < 1 ? 2 : 0)}%</span></div>
    <div class="bar" style="height:10px;margin:6px 0" role="progressbar" aria-valuenow="${share.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(share, 0.5)}%;background:${color}"></span></div>
    <div class="muted" style="font-size:12px">${Object.entries(m.by_kind).filter(([, v]) => v).map(([k, v]) => `${KIND[k]}: <span class="num">${bytes(v)}</span>`).join(" · ")}</div>
    <div class="check" style="margin-top:6px"><span class="sev INFO" style="white-space:nowrap">CŨ NHẤT</span><div>${o ? `Lưu ngày <b class="num">${esc(o.date.slice(0, 10).split("-").reverse().join("/"))}</b>${o.as_of ? ` (data đến ${ddmm(o.as_of)})` : ""} · lần chạy ${esc(o.run_id)} · đang giữ ${m.runs} lần chạy` : "Chưa có lần chạy nào"}</div></div>
    ${share > 100 && !m.auto_prune ? '<div class="warnbar">Đã vượt giới hạn – bật “Tự ghi đè” hoặc bấm “Dọn ngay”.</div>' : ""}`;
}
async function loadMemory() { const m = await api.memory_info(); if (!bad(m)) renderMemory(m); }
const dmy = (iso) => iso.split("-").reverse().join("/");
function renderHistory(h) {
  const el = $("#hist-info");
  if (h.error) { el.innerHTML = `<div class="muted" style="font-size:13px">${esc(h.error)}</div>`; return; }
  if (!h.days) { el.innerHTML = '<div class="muted" style="font-size:13px">Chưa có dữ liệu – bấm Chạy một lần để bắt đầu lưu.</div>'; return; }
  const miss = h.missing.length ? `<div class="warnbar">Thiếu ${h.missing.length} ngày raw_sso_us: <span data-no-i18n>${h.missing.slice(0, 10).map(dmy).join(", ")}${h.missing.length > 10 ? "…" : ""}</span></div>` : "";
  el.innerHTML = `<div style="font-size:13px"><b class="num">${dmy(h.first)} – ${dmy(h.last)}</b> · <span class="num">${h.days}</span> ngày · <span class="num">${bytes(h.bytes)}</span></div>${miss}
    <div class="tbl" style="max-height:260px;margin-top:8px"><table><thead><tr><th>Tháng</th><th class="n">Số ngày</th><th class="n">Dòng raw_sso_us</th><th class="n">Dòng ads_camp</th><th class="n">Dòng INELIGIBLE</th><th></th></tr></thead>
    <tbody>${h.months.map((m) => `<tr><td class="num">${m.month.slice(5)}/${m.month.slice(0, 4)}</td><td class="n">${m.days}</td><td class="n">${m.raw_rows.toLocaleString()}</td><td class="n">${m.ads_rows.toLocaleString()}</td><td class="n">${(m.ie_rows || 0).toLocaleString()}</td>
      <td><button class="btn sm" data-hist-del="${esc(m.month)}">Xoá</button></td></tr>`).join("")}</tbody></table></div>
    <div style="margin-top:8px"><button class="btn sm" data-hist-del="">Xoá tất cả</button></div>`;
}
async function loadHistory() { renderHistory(await api.history_info()); }
$("#hist-info").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-hist-del]");
  if (!b) return;
  const month = b.dataset.histDel || null;
  if (!confirm(I18N.t(month ? "Xoá dữ liệu đã lưu của tháng này? Lần chạy sau sẽ không còn các ngày này (trừ khi file mới có)." : "Xoá toàn bộ dữ liệu lịch sử đã lưu?"))) return;
  b.disabled = true;
  const r = await api.history_delete(month);
  if (!bad(r)) { renderHistory(r); loadMemory(); toast("Đã xoá."); } else b.disabled = false;
});

// ------------------------------------------------------------------ updates
function renderVersion() {
  const u = S.update;
  const current = u ? u.current : "";
  $("#f-version").innerHTML = u ? `v${esc(current)}${u.newer ? ` · <span style="color:var(--primary)">có bản ${esc(u.latest)}</span>` : ""}` : "";
  $("#ver-checks").innerHTML = u ? `<div class="check"><span class="sev INFO">ĐANG DÙNG</span><span class="num">v${esc(current)}</span></div>
    <div class="check"><span class="sev ${u.newer ? "MED" : "OK"}">${u.newer ? "MỚI" : "MỚI NHẤT"}</span><span class="num">${esc(u.latest || (u.repo ? "không kết nối được GitHub" : "chưa đặt GitHub repo"))}</span><span class="muted">${esc((u.published || "").slice(0, 10))}</span></div>` : "";
}
async function checkUpdate(showModal) {
  const u = await api.check_update();
  if (bad(u)) return;
  S.update = u;
  renderVersion();
  if (u.newer && S.updDismissed === u.latest && !showModal) return;  // closed for this version: the hourly check stays quiet
  $("#upd-banner").classList.toggle("hidden", !u.newer);
  $("#upd-text").innerHTML = u.newer ? `Có phiên bản mới <b class="num">${esc(u.latest)}</b> (bạn đang dùng <span class="num">v${esc(u.current)}</span>)` : "";
  // feedback #50: a new version opens its What's new window (notes + Cập nhật) once per version, unless another one is up
  if (showModal || (u.newer && S.wnAuto !== u.latest && !$("#wn").classList.contains("on"))) { S.wnAuto = u.latest; openWn(); }
}
function openWn() {
  const u = S.update;
  if (!u || !u.latest) { toast("Chưa có thông tin phiên bản mới."); return; }
  $("#wntitle").textContent = `Có gì mới – ${u.latest}`;
  $("#wn-date").textContent = (u.published || "").slice(0, 10) + " · từ GitHub Release notes";
  $("#wn-notes").innerHTML = md(u.notes);
  $("#wn-prev").innerHTML = u.previous.length ? `<details><summary class="muted" style="cursor:pointer;font-size:13px">Phiên bản trước</summary>${u.previous.map((p) => `<h3>${esc(p.tag)}</h3>${md(p.notes)}`).join("")}</details>` : "";
  $("#wn-install").classList.toggle("hidden", !u.newer);
  $("#wn-stat").textContent = "";
  $("#wn").classList.add("on");
}
function showInstalledNotes(w) {
  S.installedNotes = true;
  $("#wntitle").textContent = `Có gì mới – v${w.version}`;
  $("#wn-date").textContent = (w.date ? w.date + " · " : "") + "bạn vừa cập nhật lên phiên bản này";
  $("#wn-notes").innerHTML = md(w.notes);
  $("#wn-prev").innerHTML = w.previous.length ? `<details><summary class="muted" style="cursor:pointer;font-size:13px">Phiên bản trước</summary>${w.previous.map((p) => `<h3>${esc(p.tag)}</h3>${md(p.notes)}`).join("")}</details>` : "";
  $("#wn-install").classList.add("hidden");
  $("#wn-stat").textContent = "";
  $("#wn").classList.add("on");
}
function closeWn() {
  $("#wn").classList.remove("on");
  if (S.installedNotes) { S.installedNotes = false; api.mark_whats_new_seen(); }
}
async function install(btn = $("#wn-install"), stat = $("#wn-stat")) {  // progress in the What's new window or the update popup
  btn.disabled = true;
  stat.innerHTML = '<span class="spin"></span> Đang tải và kiểm tra checksum… app sẽ tự đóng và mở lại.';
  const r = await api.install_update();
  btn.disabled = false;
  if (r.error) stat.textContent = r.error;
}

// Zoom (feedback #41): CSS zoom on the whole page, 50–200 %; buttons in the top bar, Ctrl +/−/0 and Ctrl + wheel.
// Saved in settings – localStorage alone is wiped by pywebview's private mode.
function setZoom(z, save = true) {
  z = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
  if (z === S.zoom) return;
  S.zoom = z; document.documentElement.style.zoom = z;
  document.documentElement.style.setProperty("--zoom", z);  // viewport units are zoomed too: styles.css divides them back
  $("#zoom-reset").textContent = `${Math.round(z * 100)}%`;
  if (save) api.save_settings({ ui_zoom: z });
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const step = { "=": 0.1, "+": 0.1, "-": -0.1, "_": -0.1 }[e.key];
  if (step) setZoom((S.zoom || 1) + step); else if (e.key === "0") setZoom(1); else return;
  e.preventDefault();
});
document.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom((S.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1)); } }, { passive: false });

// ------------------------------------------------------------------ wiring
function wire() {
  $("#zoom-in").onclick = () => setZoom((S.zoom || 1) + 0.1);
  $("#zoom-out").onclick = () => setZoom((S.zoom || 1) - 0.1);
  $("#zoom-reset").onclick = () => setZoom(1);
  wireDashboard();
  $$("nav button[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  $("#lang").onclick = () => { const l = I18N.lang === "en" ? "vi" : "en"; applyLang(l); store("lang", l); api.save_settings({ ui_lang: l }); if (S.db && $("#dashboard").classList.contains("on")) renderDashboard(); };
  $("#su-lang").onclick = () => $("#lang").click();
  $("#theme").onclick = () => { const t = isDark() ? "light" : "dark"; applyTheme(t); store("theme", t); if (S.db && $("#dashboard").classList.contains("on")) renderDashboard(); };
  $("#cc-recheck").onclick = $("#cc-recheck2").onclick = checkClaude;
  $("#cc-install").onclick = installClaude;
  $("#cc-login").onclick = loginClaude;
  $("#set-tabs").onclick = (e) => { const b = e.target.closest("[data-stab]"); if (b) settingsTab(b.dataset.stab); };
  $("#set-tabs").onkeydown = (e) => {  // ←/→ move between the visible tabs (WAI-ARIA tablist)
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = $$("#set-tabs [data-stab]").filter((b) => getComputedStyle(b).display !== "none");
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    settingsTab(next.dataset.stab);
    next.focus();
  };
  const pillGo = () => { if (S.claudeLevel !== "ok") go("settings", "claude"); };
  $("#cc-pill").onclick = pillGo;
  $("#cc-pill").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") pillGo(); };
  $("#cc-foot-usage").onclick = () => go("settings", "claude");
  $("#cc-foot-usage").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") go("settings", "claude"); };
  $("#cc-foot-refresh").onclick = refreshUsage;
  $("#pick").onclick = async () => { const r = await api.pick_folder(); if (!bad(r) && r.paths) useInputs(r.paths); };
  $("#pick-files").onclick = async () => { const r = await api.pick_files(); if (!bad(r) && r.paths) useInputs(r.paths); };
  $("#run-btn").onclick = doRun;
  $("#stop-btn").onclick = stopRun;
  // The whole window takes drops; the Run page's input area lights up. dragenter/leave fire for every child
  // element, so a depth counter tells "left the window" from "moved onto a child".
  let dragDepth = 0;
  const dropOn = (on) => $("#drop-zone").classList.toggle("drop", on);
  const files = (e) => [...(e.dataTransfer?.types || [])].includes("Files");  // not the layout window's own drags
  document.body.addEventListener("dragenter", (e) => { if (!files(e)) return; e.preventDefault(); if (dragDepth++ === 0) { go("run"); dropOn(true); } });
  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("dragleave", (e) => { if (files(e) && --dragDepth <= 0) { dragDepth = 0; dropOn(false); } });
  // Paths of dropped files arrive from the native handler via window.onDropPaths.
  document.body.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; dropOn(false); });
  $("#pic").onchange = (e) => { S.pic = e.target.value; S.open.clear(); renderResults(); };
  $("#copy-slack").onclick = copySlack;
  $("#export").onclick = async () => { if (!S.pic) return; if (S.pic === ALL_PIC) { toast("Chọn 1 PIC để xuất Excel."); return; } const r = await api.export(S.pic, null, S.runId); if (!bad(r) && r.path) toast("Đã xuất: " + r.path); };
  const pop = $("#colpop");
  const closePop = () => pop.classList.add("hidden");
  pop.addEventListener("click", (e) => {
    if (e.target.closest("[data-closepop]")) closePop();
    const h = e.target.closest("[data-hidecol]");
    if (h) { const set = hiddenCols(); set.add(h.dataset.hidecol); closePop(); setHidden(set); }
    if (e.target.closest("[data-showall]")) { closePop(); setHidden(new Set()); }
    const pfAll = e.target.closest("[data-pfshowall]");
    if (pfAll) { closePop(); pfSetHidden(pfAll.dataset.pfshowall, new Set()); }
  });
  pop.addEventListener("change", (e) => {
    if (e.target.dataset.pftoggle) {  // Performance Review tables
      const [table, col] = e.target.dataset.pftoggle.split(":"), set = pfHidden(table);
      e.target.checked ? set.delete(col) : set.add(col); pfSetHidden(table, set); return;
    }
    const k = e.target.dataset.togglecol; if (!k) return;
    const set = hiddenCols(); e.target.checked ? set.delete(k) : set.add(k); setHidden(set);
  });
  document.addEventListener("click", (e) => { if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !e.target.closest(".colinfo,#cols-btn,[data-pfcols]")) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  for (const id of ["#slots-data", "#slots-setting"]) {
    $(id).addEventListener("click", (e) => { const t = e.target.closest("[data-slot]"); if (t) openFileDetail(t.dataset.slot); });
    $(id).addEventListener("keydown", (e) => { const t = e.target.closest("[data-slot]"); if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openFileDetail(t.dataset.slot); } });
  }
  $("#fd-close").onclick = () => $("#fd").classList.remove("on");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#fd").classList.remove("on"); });
  $("#results-body").addEventListener("click", (e) => {
    const ev = e.target.closest(".evb");
    if (ev) { e.stopPropagation(); openEvidence(ev.dataset.ev.split("|")); return; }
    const fb = e.target.closest(".fb");
    if (fb) { e.stopPropagation(); openFb(fb.dataset.unit, fb.dataset.label); return; }
    const ci = e.target.closest(".colinfo");
    if (ci) { e.stopPropagation(); colInfo(ci); return; }
    if (e.target.closest("#cols-btn")) { colChooser(e.target.closest("#cols-btn")); return; }
    if (e.target.closest("#f-reset")) { S.f = { ...F_DEFAULT }; renderResults(); return; }
    if (e.target.closest("#rewrite")) { rewriteMessage(); return; }
    const goto = e.target.closest("[data-goto]");
    if (goto) { go(goto.dataset.goto); return; }
    const t = e.target.closest("[data-tab]");
    if (t) { S.tab = t.dataset.tab; renderResults(); return; }
    const row = e.target.closest("tr.expandable[data-pl]");
    if (row) { const pl = row.dataset.pl; S.open.has(pl) ? S.open.delete(pl) : S.open.add(pl); renderResults(); }
  });
  const FMAP = { "f-sev": "sev", "f-action": "action", "f-trend": "trend", "f-status": "status", "f-todo-sev": "todoSev", "f-todo-due": "todoDue" };
  $("#results-body").addEventListener("change", (e) => { if (FMAP[e.target.id]) { S.f[FMAP[e.target.id]] = e.target.value; renderResults(); } });
  $("#results-body").addEventListener("input", (e) => {
    if (e.target.id !== "f-q") return;
    S.f.q = e.target.value;
    clearTimeout(S.qTimer);
    S.qTimer = setTimeout(() => { renderResults(); const el = $("#f-q"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250);
  });
  $$("#fb-issue button").forEach((b) => (b.onclick = () => {
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  }));
  $("#fb-close").onclick = $("#fb-cancel").onclick = $("#fb-scrim").onclick = closeFb;
  $("#fb-send").onclick = sendFb;
  $("#review-body").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-prop][data-status]");
    if (b) {
      const inp = b.closest("tr")?.querySelector(".prop-new");
      const nv = b.dataset.status === "approved" && inp ? inp.value : null;
      if (!bad(await api.set_proposal(b.dataset.prop, b.dataset.status, nv))) loadReview();
      return;
    }
    if (e.target.closest("#apply")) {
      e.target.closest("#apply").disabled = true;
      toast("Đang tạo phiên bản logic mới và chạy lại…");
      const r = await api.apply_proposals();
      if (bad(r)) { loadReview(); return; }
      setRun(r); toast(`Đã tạo ${r.logic_file} và chạy lại.`); go("results");
    }
  });
  $("#lessons").addEventListener("click", async (e) => {
    const l = e.target.closest("[data-lesson]");
    if (l && confirm(I18N.t("Xoá bài học này?"))) { if (!bad(await api.delete_lesson(l.dataset.lesson))) loadLessons(); return; }
    const v = e.target.closest("[data-version]");
    if (v) { if (!bad(await api.set_active_logic(Number(v.dataset.version)))) { toast("Đã đổi phiên bản logic – chạy lại để áp dụng."); loadLessons(); } return; }
    const r = e.target.closest("[data-run]");
    if (r) { const run = await api.results(r.dataset.run); if (!bad(run)) { setRun(run); go("results"); } }
  });
  $("#email-save").onclick = async () => {
    const map = {};
    $$("#emailmap select").forEach((s) => { if (s.value) map[s.dataset.email] = s.value; });
    if (!bad(await api.save_settings({ email_map: map }))) toast("Đã lưu email → PIC.");
  };
  $("#auto-upd").onchange = (e) => api.save_settings({ auto_update_check: e.target.checked });
  $("#careful").onchange = (e) => api.save_settings({ careful_mode: e.target.checked });
  $("#act-fetch").onclick = fetchActivity;
  $("#sp-fetch").onclick = fetchSharePoint;
  $("#act-status").addEventListener("click", async (e) => {
    if (e.target.id !== "act-out") return;
    e.preventDefault();
    await api.activity_sign_out();
    actStatus(null);
  });
  $("#claude-note").oninput = (e) => ($("#note-count").textContent = `${e.target.value.length}/4000 ký tự`);
  $("#note-save").onclick = async () => { if (!bad(await api.save_settings({ claude_note: $("#claude-note").value.trim() }))) toast("Đã lưu ghi chú – áp dụng từ lần chạy tới."); };
  $("#mem-save").onclick = async () => {
    const mb = Math.min(1024, Math.max(1, Number($("#mem-limit").value) || 1024));
    $("#mem-limit").value = mb;
    if (!bad(await api.save_settings({ memory_limit_mb: mb, auto_prune: $("#mem-auto").checked }))) { toast("Đã lưu cài đặt bộ nhớ."); loadMemory(); }
  };
  $("#mem-prune").onclick = async () => {
    if (!confirm(I18N.t("Xoá các lần chạy cũ nhất cho tới khi dưới giới hạn?"))) return;
    const r = await api.prune_memory();
    if (!bad(r)) { toast(r.deleted.length ? `Đã xoá ${r.deleted.length} lần chạy cũ.` : "Chưa vượt giới hạn – không cần xoá."); renderMemory(r); }
  };
  $("#ads-account").onchange = async (e) => { if (!bad(await api.save_settings({ ads_account: e.target.value }))) toast("Đã lưu – chạy lại để áp dụng."); };
  $("#upd-check").onclick = () => checkUpdate(true);
  $("#upd-whatsnew").onclick = $("#upd-whatsnew2").onclick = $("#f-version").onclick = openWn;
  $("#upd-now").onclick = () => install($("#upd-now"), $("#upd-text"));
  $("#upd-later").onclick = () => { S.updDismissed = S.update && S.update.latest; $("#upd-banner").classList.add("hidden"); };
  $("#wn-close").onclick = $("#wn-later").onclick = closeWn;
  $("#wn").onclick = (e) => { if (e.target.id === "wn") closeWn(); };
  $("#wn-install").onclick = () => install();
  $("#ev-close").onclick = () => $("#ev").classList.remove("on");
  $("#ev").onclick = (e) => { if (e.target.id === "ev") $("#ev").classList.remove("on"); };
  $("#ev-tabs").onclick = (e) => { const b = e.target.closest("[data-evi]"); if (b) { S.ev.i = Number(b.dataset.evi); showEvidence(); } };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeFb(); closeWn(); $("#ev").classList.remove("on"); } });
}

async function init() {
  api = window.pywebview.api;
  api.get_style().then((st) => { if (!st.error) S.style = st; });
  applyTheme(store("theme"));
  applyLang(store("lang") || "vi");
  wire();
  renderSlots();
  checkClaude();
  const settings = await api.get_settings();
  if (!settings.error) {
    if (settings.ui_lang && settings.ui_lang !== I18N.lang) applyLang(settings.ui_lang);
    if (typeof settings.nav_mini === "boolean") setMini(settings.nav_mini, false);
    if (typeof settings.ui_zoom === "number") setZoom(settings.ui_zoom, false);
    S.layouts = settings.layouts || {};
    api.synced_files().then((sy) => useInputs([...(sy.paths || []), ...((settings.last_inputs || {}).paths || [])]));  // OneDrive copies first
    $("#careful").checked = settings.careful_mode !== false;
    api.activity_status().then((r) => { if (!r.error) actStatus(r.email); });
    $("#auto-upd").checked = !!settings.auto_update_check;  // the hourly check reads it (Settings may never be opened)
    if (settings.auto_update_check) checkUpdate(false);
    else api.check_update().then((u) => { if (!u.error) { S.update = u; renderVersion(); } });
    // a release while the app is open → popup within 5 minutes; the probe is a cheap redirect, the full check only on a new tag
    setInterval(async () => {
      if (!$("#auto-upd").checked) return;
      const t = await api.latest_tag();
      if (!t.error && t.tag && (!S.update || t.tag !== S.update.latest)) checkUpdate(false);
    }, 5 * 60 * 1000);
  }
  await initTeam();
  pushHourly();  // Lead: the team's Hourly tab follows this machine's hourly file
  if (S.role && S.role.signed_in && RUNNER(S.role) && !S.runId) await loadLastRun();
  const w = await api.whats_new();
  if (!w.error && w.show) showInstalledNotes(w);
  // the Review tab is Lead-only: an Operator loading it downloaded and decrypted the report a second time (feedback #75)
  if (S.role && S.role.signed_in && S.role.role !== "member") { loadLessons(); if (RUNNER(S.role)) loadReview(); }
}
async function loadLastRun() {
  const last = await api.results();
  if (!last.error && last.result) { setRun(last); go("results"); }
}

if (window.pywebview && window.pywebview.api) init();
else window.addEventListener("pywebviewready", init);

// ------------------------------------------------------------------ dashboard
// Categorical palette (dataviz reference, validated for this app's light #fff and dark #111A2C cards).
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const NO_PIC = "Chưa có PIC";
const charts = {};
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function picColor(pic, pics) {
  if (pic === NO_PIC) return cssVar("--muted");
  const named = pics.filter((p) => p !== NO_PIC).sort();
  return SERIES[isDark() ? "dark" : "light"][named.indexOf(pic) % 8];  // colour follows the PIC, never its rank
}
// feedback #80: under the page's CSS zoom (#41) the browser gives the mouse offset in zoomed px while Chart.js lays out
// in CSS px, so hover / click landed on the wrong day (80 % zoom: ~20 % to the left). Map the pointer back to CSS px.
const ZOOM_POINTER = { id: "zoomPointer", beforeEvent(chart, args) {
  const n = args.event.native, p = n && ((n.touches && n.touches[0]) || n);
  if (!p || !("clientX" in p)) return;
  const c = chart.canvas, r = c.getBoundingClientRect(), k = r.width / (c.offsetWidth || 1) || 1;  // rect px per css px
  if (Math.abs(k - 1) < 1e-3) return;
  args.event.x = (p.clientX - r.left) / k; args.event.y = (p.clientY - r.top) / k;
} };
function drawChart(id, config) {
  if (charts[id]) charts[id].destroy();
  config.plugins = [...(config.plugins || []), ZOOM_POINTER];
  const el = document.getElementById(id);
  if (!el || !window.Chart) return;
  const ink = cssVar("--muted"), grid = cssVar("--border");
  Chart.defaults.font.family = '"Fira Sans", system-ui, sans-serif';
  Chart.defaults.color = ink;
  config.options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: config.type === "line" ? "index" : "nearest", intersect: false },
    plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } }, ...(config.options?.plugins || {}) },
    scales: Object.fromEntries(Object.entries(config.options?.scales || {}).map(([k, v]) => [k, { grid: { color: grid }, border: { display: false }, ...v }])),
    ...Object.fromEntries(Object.entries(config.options || {}).filter(([k]) => !["plugins", "scales"].includes(k))),
  };
  charts[id] = new Chart(el, config);
}
const FMT = { x: (v) => (num(v) ? rhu(v) + "×" : "—"), "%": (v) => pct(v, 1) };
async function loadDashboard() {
  if (!S.runId) return;
  $("#db-body").innerHTML = '<div class="muted"><span class="spin"></span> Đang tính…</div>';
  const d = await api.dashboard(S.runId);
  if (d.error) { $("#db-body").innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  S.db = d;
  renderDashboard();
}
function renderDashboard() {
  const d = S.db, sc = d.scorecard, pics = sc.pics.map((p) => p.pic);
  $("#db-sub").textContent = `Data đến ${ddmm(sc.as_of)} · time gone ${pct(sc.time_gone)} · mỗi PIC đo so với target của chính họ; điểm 0–100 là xếp hạng tương đối (100 = tốt nhất).`;
  const ranked = sc.pics.filter((p) => p.rank);
  const metricOpts = sc.metrics.map((m) => `<option value="${m.key}" ${m.key === (S.dbMetric || "gmv_pace") ? "selected" : ""}>${esc(m.label)}</option>`).join("");
  const tr = d.team_review;
  const review = tr ? `${tr.summary ? `<p style="margin-top:0">${raw(tr.summary)}</p>` : ""}
      ${tr.highlights.length ? "<h3 style='font-size:13px;margin:8px 0 4px'>Điểm mạnh</h3>" + tr.highlights.map((h) => `<div class="review-item"><span class="sev OK">${esc(h.pic)}</span> <b>${esc(metricLabel(h.metric))}</b><div>${raw(h.text)}</div></div>`).join("") : ""}
      ${tr.improve.length ? "<h3 style='font-size:13px;margin:12px 0 4px'>Cần cải thiện</h3>" + tr.improve.map((h) => `<div class="review-item"><span class="sev MED">${esc(h.pic)}</span> <b>${esc(metricLabel(h.metric))}</b><div>${raw(h.text)}</div><div class="muted">→ ${raw(h.suggestion)}</div></div>`).join("") : ""}
      <p class="muted" style="font-size:12px">${esc((tr.created || "").replace("T", " "))}${tr.dropped ? ` · đã bỏ ${tr.dropped} câu vì số liệu không khớp` : ""}</p>`
    : '<div class="empty">Bấm “Nhận xét bởi Claude” để Claude so sánh các PIC dựa trên scorecard, xu hướng theo tuần và lịch sử các lần chạy.</div>';
  $("#db-body").innerHTML = layoutHtml("dashboard", {
    rank: `<div class="card"><h2>Xếp hạng tổng (điểm 0–100)</h2><div class="chartbox"><canvas id="ch-rank" role="img" aria-label="Điểm tổng theo PIC"></canvas></div></div>`,
    review: `<div class="card"><h2>Nhận xét của Claude</h2><div id="db-review">${review}</div></div>`,
    scorecard: `<div class="card"><h2>Scorecard</h2><div class="tbl"><table>
      <thead><tr><th>#</th><th>PIC</th><th class="n">Điểm</th>${sc.metrics.map((m) => `<th class="n" title="${esc(m.label)}">${esc(m.short)}</th>`).join("")}<th class="n">HIGH</th><th class="n">Excess $</th></tr></thead>
      <tbody>${sc.pics.map((p) => `<tr><td>${p.rank ? `<span class="rank ${p.rank === 1 ? "r1" : ""}">${p.rank}</span>` : "—"}</td>
        <td style="white-space:nowrap"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${picColor(p.pic, pics)};margin-right:6px"></span>${esc(p.pic)}</td>
        <td class="n"><b>${p.total ?? "—"}</b></td>
        ${sc.metrics.map((m) => { const s = p.scores[m.key]; return `<td class="n"><div class="scorecell"><span class="num">${FMT[m.fmt](p.values[m.key])}</span>${s == null ? "" : `<span class="scorebar" title="điểm ${s}"><span style="width:${s}%"></span></span>`}</div></td>`; }).join("")}
        <td class="n">${p.values.high_alerts}</td><td class="n">${money(p.values.excess_new)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted" style="font-size:12px">${sc.metrics.map((m) => `<b>${esc(m.short)}</b>: ${esc(m.label)} (${m.higher_better ? "cao tốt" : "thấp tốt"})`).join(" · ")}<br>Thanh nhỏ = điểm của chỉ số (dài = tốt hơn so với các PIC khác). “${NO_PIC}” không được xếp hạng.</p></div>`,
    pace: `<div class="card"><h2>Tiến độ GMV & spend so với time gone</h2><div class="chartbox"><canvas id="ch-pace" role="img" aria-label="Tiến độ GMV và spend theo PIC"></canvas></div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">% target tháng đã đạt. Vạch đứt = time gone (${pct(sc.time_gone)}): GMV dưới vạch là chậm, spend vượt vạch là tiêu nhanh.</p></div>`,
    sev: `<div class="card"><h2>Mức cảnh báo theo PIC</h2><div class="chartbox"><canvas id="ch-sev" role="img" aria-label="Số cảnh báo HIGH, MED và cần theo dõi theo PIC"></canvas></div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">PL + campaign. “Theo dõi” = campaign đã action, đang chờ kiểm tra kết quả.</p></div>`,
    plmap: `<div class="card"><h2>Bản đồ PL: GMV pace vs spend pace</h2><div class="chartbox tall"><canvas id="ch-plmap" role="img" aria-label="Mỗi chấm là một PL"></canvas></div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">Mỗi chấm là một PL (màu = PIC). Vạch đứt = đúng tiến độ (1×). Góc trên-trái: spend nhanh nhưng GMV chậm – cần xem trước. Góc dưới-phải: GMV tốt, spend còn room.</p></div>`,
    excess: `<div class="card"><h2>Top 10 PL theo excess spend</h2><div class="chartbox tall"><canvas id="ch-excess" role="img" aria-label="Top PL theo excess spend"></canvas></div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">Excess = spend L7D vượt mức hợp lý theo ACoS target, cộng từ các campaign của PL.</p></div>`,
    metric: `<div class="card"><div style="display:flex;gap:8px;align-items:center"><h2 style="margin:0">So sánh theo chỉ số</h2><span style="flex:1"></span><select id="db-metric" style="width:auto">${metricOpts}</select></div>
        <div class="chartbox" style="margin-top:8px"><canvas id="ch-metric" role="img" aria-label="So sánh chỉ số giữa các PIC"></canvas></div></div>`,
    week: `<div class="card"><div style="display:flex;gap:8px;align-items:center"><h2 style="margin:0">Xu hướng theo tuần</h2><span style="flex:1"></span>
        <select id="db-week" style="width:auto">${[["gmv", "GMV"], ["spend", "Ads spend"], ["tacos", "TACoS"], ["acos", "ACoS"]].map(([v, l]) => `<option value="${v}" ${v === (S.dbWeek || "gmv") ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="chartbox" style="margin-top:8px"><canvas id="ch-week" role="img" aria-label="Xu hướng theo tuần"></canvas></div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">Tuần tính từ thứ Hai; tuần cuối có thể chưa đủ 7 ngày.</p></div>`,
    share: `<div class="card"><h2>Tỷ trọng GMV theo tuần</h2>${pics.filter((p) => p !== NO_PIC).length >= 2 ? '<div class="chartbox"><canvas id="ch-share" role="img" aria-label="Tỷ trọng GMV của từng PIC theo tuần"></canvas></div>' : '<div class="empty">Cần từ 2 PIC trở lên.</div>'}</div>`,
    runs: `<div class="card"><h2>Số alert HIGH qua các lần chạy</h2>${d.runs.length >= 2 ? '<div class="chartbox"><canvas id="ch-runs" role="img" aria-label="Alert HIGH qua các lần chạy"></canvas></div>' : '<div class="empty">Cần ít nhất 2 lần chạy để xem xu hướng.</div>'}</div>`,
    ...dashExtras(sc) });
  drawCharts();
  drawDashExtras(sc);
}
function metricLabel(key) { return ((S.db?.scorecard.metrics || []).find((m) => m.key === key) || { label: key }).label; }
function drawCharts() {
  const d = S.db, sc = d.scorecard, pics = sc.pics.map((p) => p.pic);
  const ranked = sc.pics.filter((p) => p.rank);
  const blue = SERIES[isDark() ? "dark" : "light"][0];
  drawChart("ch-rank", { type: "bar", data: { labels: ranked.map((p) => p.pic), datasets: [{ data: ranked.map((p) => p.total), backgroundColor: blue, borderRadius: 4, barThickness: 18 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Điểm ${c.raw}` } } }, scales: { x: { min: 0, max: 100 }, y: { grid: { display: false } } } } });
  const m = sc.metrics.find((x) => x.key === (S.dbMetric || "gmv_pace"));
  const rows = sc.pics.filter((p) => p.values[m.key] != null);
  drawChart("ch-metric", { type: "bar", data: { labels: rows.map((p) => p.pic), datasets: [{ data: rows.map((p) => p.values[m.key]), backgroundColor: rows.map((p) => picColor(p.pic, pics)), borderRadius: 4, barThickness: 18 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${m.label}: ${FMT[m.fmt](c.raw)}` } } },
      scales: { x: { ticks: { callback: (v) => FMT[m.fmt](v) } }, y: { grid: { display: false } } } } });
  const key = S.dbWeek || "gmv";
  const weeks = [...new Set(d.weekly.map((r) => r.week))].sort();
  const isRatio = key === "tacos" || key === "acos";
  drawChart("ch-week", { type: "line", data: { labels: weeks.map(ddmm), datasets: pics.map((pic) => ({ label: pic, borderColor: picColor(pic, pics), backgroundColor: picColor(pic, pics), borderWidth: 2, pointRadius: 4, tension: 0,
      data: weeks.map((w) => { const r = d.weekly.find((x) => x.pic === pic && x.week === w); return r ? r[key] : null; }) })) },
    options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${isRatio ? pct(c.raw, 1) : money(c.raw)}` } } }, scales: { y: { ticks: { callback: (v) => (isRatio ? pct(v) : "$" + Number(v).toLocaleString("en-US")) } } } } });
  drawExtraCharts(d, sc, pics);
  if (d.runs.length >= 2) {
    drawChart("ch-runs", { type: "line", data: { labels: d.runs.map((r) => `${ddmm(r.as_of)} (${r.run_id.slice(9, 13)})`),
      datasets: pics.map((pic) => ({ label: pic, borderColor: picColor(pic, pics), backgroundColor: picColor(pic, pics), borderWidth: 2, pointRadius: 4, data: d.runs.map((r) => r.by_pic[pic]?.high ?? null) })) },
      options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
  }
}
// Dashed reference lines (time gone, on-pace 1×) drawn under the data.
function refLines(lines) {
  return { id: "ref", beforeDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales } = chart;
    ctx.save(); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = cssVar("--muted");
    for (const [axis, v] of lines) {
      const sc = scales[axis]; if (!sc || v == null) continue;
      const px = sc.getPixelForValue(v);
      ctx.beginPath();
      if (axis === "x") { ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); } else { ctx.moveTo(a.left, px); ctx.lineTo(a.right, px); }
      ctx.stroke();
    }
    ctx.restore();
  } };
}
function drawExtraCharts(d, sc, pics) {
  const pal = SERIES[isDark() ? "dark" : "light"], surface = cssVar("--card") || (isDark() ? "#111A2C" : "#fff");
  const named = sc.pics.filter((p) => p.pic !== NO_PIC && (p.values.gmv_pct != null || p.values.spend_pct != null));
  drawChart("ch-pace", { type: "bar", plugins: [refLines([["x", sc.time_gone]])],
    data: { labels: named.map((p) => p.pic), datasets: [
      { label: "GMV % target", data: named.map((p) => p.values.gmv_pct), backgroundColor: pal[0], borderRadius: 4, barThickness: 12 },
      { label: "Spend % target", data: named.map((p) => p.values.spend_pct), backgroundColor: pal[1], borderRadius: 4, barThickness: 12 }] },
    options: { indexAxis: "y", plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.raw, 1)} (time gone ${pct(sc.time_gone)})` } } },
      scales: { x: { beginAtZero: true, suggestedMax: sc.time_gone * 1.2, ticks: { callback: (v) => pct(v) } }, y: { grid: { display: false } } } } });

  const dg = (S.run?.digest || []).filter((x) => x.pic !== NO_PIC);
  const sevSet = [["HIGH", (x) => x.pl_high + x.camp_high, "--high"], ["MED", (x) => x.pl_med + x.camp_med, "--med"], [I18N.t("Theo dõi"), (x) => x.camp_followup, "--info"]];
  drawChart("ch-sev", { type: "bar",
    data: { labels: dg.map((x) => x.pic), datasets: sevSet.map(([label, f, v]) => ({ label, data: dg.map(f), backgroundColor: cssVar(v), borderColor: surface, borderWidth: 1, barThickness: 16 })) },
    options: { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } } });

  const pls = (S.run?.pl || []).filter((r) => num(r.gmv_pace) && num(r.spend_pace));
  const cap = (v) => Math.min(v, 3);  // ponytail: extreme paces pinned at 3× so the cloud stays readable; tooltip shows the real value
  const plPics = [...new Set(pls.map((r) => r.pic))];
  drawChart("ch-plmap", { type: "scatter", plugins: [refLines([["x", 1], ["y", 1]])],
    data: { datasets: plPics.map((pic) => ({ label: pic, backgroundColor: picColor(pic, pics), borderColor: surface, borderWidth: 2, pointRadius: 5, pointHoverRadius: 7,
      data: pls.filter((r) => r.pic === pic).map((r) => ({ x: cap(r.gmv_pace), y: cap(r.spend_pace), r })) })) },
    options: { interaction: { mode: "nearest", intersect: true },
      plugins: { tooltip: { callbacks: { label: (c) => { const r = c.raw.r; return `${r.pl} (${r.pic}) · GMV ${rhu(r.gmv_pace)}× · spend ${rhu(r.spend_pace)}× · ${short(r.pacing_action)}`; } } } },
      scales: { x: { min: 0, suggestedMax: 1.5, title: { display: true, text: "GMV pace (× time gone)" } }, y: { min: 0, suggestedMax: 1.5, title: { display: true, text: "Spend pace (× time gone)" } } } } });

  const ex = {};
  (S.run?.camp || []).forEach((c) => { if (c.excess > 0) { const k = c.pl; ex[k] = ex[k] || { pl: c.pl, pic: c.pic, v: 0 }; ex[k].v += c.excess; } });
  const top = Object.values(ex).sort((a, b) => b.v - a.v).slice(0, 10);
  drawChart("ch-excess", { type: "bar",
    data: { labels: top.map((x) => x.pl), datasets: [{ data: top.map((x) => x.v), backgroundColor: top.map((x) => picColor(x.pic, pics)), borderRadius: 4, barThickness: 14 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${top[c.dataIndex].pic}: ${money(c.raw)}` } } },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => "$" + Number(v).toLocaleString("en-US") } }, y: { grid: { display: false } } } } });
  if (!top.length) { const el = document.getElementById("ch-excess"); if (el) el.parentElement.innerHTML = '<div class="empty">Không có excess spend.</div>'; }

  if (document.getElementById("ch-share")) {
    const weeks = [...new Set(d.weekly.map((r) => r.week))].sort();
    const tot = Object.fromEntries(weeks.map((w) => [w, d.weekly.filter((r) => r.week === w).reduce((a, r) => a + (r.gmv || 0), 0)]));
    drawChart("ch-share", { type: "bar",
      data: { labels: weeks.map(ddmm), datasets: [...pics.filter((p) => p !== NO_PIC), ...(d.weekly.some((r) => r.pic === NO_PIC) ? [NO_PIC] : [])].map((pic) => ({ label: pic, backgroundColor: picColor(pic, pics), borderColor: surface, borderWidth: 1,
        data: weeks.map((w) => { const r = d.weekly.find((x) => x.pic === pic && x.week === w); return r && tot[w] ? r.gmv / tot[w] : 0; }) })) },
      options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.raw, 1)}` } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, min: 0, max: 1, ticks: { callback: (v) => pct(v) } } } } });
  }
}
async function teamReview() {
  const b = $("#db-review-btn");
  b.disabled = true; b.innerHTML = '<span class="spin"></span> Claude đang phân tích…';
  const r = await api.team_review(S.runId);
  b.disabled = false; b.innerHTML = '<svg class="i" aria-hidden="true"><use href="#spark"/></svg>Nhận xét bởi Claude';
  if (bad(r)) return;
  S.db.team_review = r;
  renderDashboard();
}
function renderWeights() {
  const sc = S.db.scorecard;
  $("#db-weights").innerHTML = `<h2>Trọng số điểm</h2><p class="muted" style="font-size:12px;margin-top:0">0 = không tính chỉ số đó. Mặc định mọi chỉ số bằng nhau (1).</p>
    <div class="grid g4">${sc.metrics.map((m) => `<div><label for="w-${m.key}">${esc(m.label)}</label><input type="text" inputmode="decimal" id="w-${m.key}" data-w="${m.key}" value="${sc.weights[m.key] ?? 1}"></div>`).join("")}</div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary" id="w-save">Lưu & tính lại</button><button class="btn" id="w-reset">Về mặc định</button></div>`;
}
function wireDashboard() {
  $("#db-review-btn").onclick = teamReview;
  $("#db-weights-btn").onclick = () => { if (!S.db) return; renderWeights(); $("#db-weights").classList.toggle("hidden"); };
  $("#db-weights").addEventListener("click", async (e) => {
    if (e.target.id === "w-save" || e.target.id === "w-reset") {
      const w = {};
      $$("#db-weights [data-w]").forEach((i) => (w[i.dataset.w] = e.target.id === "w-reset" ? 1 : Number(i.value.replace(",", ".")) || 0));
      if (!bad(await api.save_score_weights(w))) { $("#db-weights").classList.add("hidden"); loadDashboard(); }
    }
  });
  $("#db-body").addEventListener("change", (e) => {
    if (e.target.id === "db-metric") { S.dbMetric = e.target.value; drawCharts(); }
    if (e.target.id === "db-week") { S.dbWeek = e.target.value; drawCharts(); }
    if (e.target.id === "db-daily") { S.dbDaily = e.target.value; renderDashboard(); }
  });
}

// ------------------------------------------------------------------ team: Supabase sign-in, Lead / Member
S.role = null;
const NOT_SIGNED = "Chưa đăng nhập nhóm";
const STATUS = { ready: ["OK", "ĐÃ ĐĂNG NHẬP"], invited: ["MED", "CHƯA ĐĂNG NHẬP"], disabled: ["INFO", "ĐÃ KHOÁ"] };
function copyBox(id, text) {
  return `<div style="display:flex;gap:6px;align-items:flex-start"><div class="code-box" id="${id}" style="flex:1;white-space:pre-wrap;max-height:220px;overflow:auto" data-no-i18n>${esc(text)}</div><button class="btn sm" data-copy="${id}">Copy</button></div>`;
}
// Roles: lead = Admin (every team), team_lead (runs one team, manages its Operators / Members), operator, member.
const RUNNER = (r) => !WEB && !!r && (r.role === "lead" || r.role === "team_lead");
const ACCOUNT_ROLE = { lead: "Admin", team_lead: "Team Lead", operator: "Operator", member: "Thành viên" };
const teamName = (id) => { const t = ((S.role && S.role.teams) || []).find((x) => x.id === id); return t ? t.name : (id || "").toUpperCase(); };
async function loadRole() {
  const r = await api.team_info();
  if (bad(r)) return null;
  S.role = r;
  document.body.classList.toggle("member", r.role === "member");
  document.body.classList.toggle("viewer", WEB || r.role === "member" || r.role === "operator");
  document.body.classList.toggle("locked", !r.signed_in);
  const sw = $("#team-switch"), switcher = r.signed_in && r.role === "lead" && (r.teams || []).length > 1;
  sw.classList.toggle("hidden", !switcher);
  if (switcher) sw.innerHTML = r.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === r.work_team ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const tm = r.signed_in && !switcher && (r.teams || []).length > 1 ? ` · ${teamName(r.work_team)}` : "";  // only once there are teams
  $("#role-badge").textContent = !r.signed_in ? NOT_SIGNED : r.role === "lead" ? `Admin${tm} · ${r.email}`
    : r.role === "team_lead" ? `Team Lead${tm} · ${r.email}` : r.role === "operator" ? `Operator${tm} · ${r.email} · chỉ xem` : `${r.pic || "—"}${tm} · chỉ xem`;
  renderTeamFiles(r);
  renderTeam();
  return r;
}
// The work team's input files (layouts.py): what to sync / download, and the hourly file to pick.
function renderTeamFiles(r) {
  const f = r.files, box = $("#team-files");
  if (f) {  // the Data / Ads slots name the work team's sheets
    ROLE_NAME.tracker = `Data (${f.raw}, ${f.products}, KPI, ${f.ads}${f.keepa ? ", Listing Issue…" : "…"})`;
    ROLE_NAME.ads = `Ads by Campaign (${f.ads})`;
    if ($("#slots-data")) renderSlots();  // drawn before the role was known
  }
  if (box) box.innerHTML = !f ? "" : `<b>File của nhóm ${esc(f.team)}</b><ul style="margin:4px 0 0;padding-left:18px">${
    f.guide.map((g) => `<li data-no-i18n>${esc(g)}</li>`).join("")}</ul>`;
  const pick = $("#hr-pick");
  if (pick && f) pick.title = `Chọn file ${f.hourly}, hoặc shortcut .url của file trên SharePoint (Add shortcut to My files)`;
}
function pwChange() {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
    <div><label for="pw-new">Mật khẩu mới (≥ 10 ký tự)</label><input type="password" id="pw-new" autocomplete="new-password"></div>
    <button class="btn" id="pw-save">Đổi mật khẩu</button><button class="btn ghost sm" id="team-signout">Đăng xuất</button></div>
    <details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:13px">Máy dùng chung? Gỡ tài khoản khỏi máy này…</summary>
      <p class="muted" style="font-size:12px;margin:6px 0">Đăng xuất và xoá khoá của tài khoản này trên máy này. Khoá đã có bản sao trên máy chủ (khoá bằng mật khẩu của bạn) – lần đăng nhập sau, ở bất kỳ máy nào, khoá tự về.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><div><label for="fg-pw">Mật khẩu hiện tại</label><input type="password" id="fg-pw" autocomplete="current-password"></div>
      <button class="btn sm" id="team-forget">Gỡ khỏi máy này</button></div></details>`;
}
function showPassword(email, pw, title) {
  $("#mb-pw").innerHTML = `<div class="banner" style="display:block;margin:8px 0"><b>${esc(title)}</b> – gửi riêng cho <span data-no-i18n>${esc(email)}</span>. Mật khẩu chỉ hiện một lần; người đó có thể tự đổi sau khi đăng nhập.
    <div style="margin-top:6px">${copyBox("mb-pw-text", pw)}</div></div>`;
}
function keyHelp() {
  return `<div class="banner" style="margin:8px 0;display:block"><b>Máy này chưa có khoá ký của Lead.</b> Cách dễ nhất: đăng nhập một lần trên máy cũ bằng bản app này – khoá sẽ tự theo tài khoản, rồi đăng nhập lại ở đây. Hoặc nhập file khoá Lead (đã xuất từ máy cũ).
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary sm" id="lk-import">Nhập file khoá Lead…</button>
    <button class="btn ghost sm" id="lk-reset">Mất file khoá? Tạo khoá mới</button></div></div>`;
}
async function renderTeam() {
  const r = S.role || {};
  const el = $("#team-card");
  if (!r.signed_in) {
    el.innerHTML = `<h2>Nhóm</h2><p class="muted" style="margin-top:0">${NOT_SIGNED}. Lead và thành viên đăng nhập bằng email công việc.</p><button class="btn primary" id="team-setup">Đăng nhập nhóm…</button>`;
    return;
  }
  if (r.role === "member") {
    el.innerHTML = `<h2>Nhóm · Thành viên</h2><p style="margin-top:0">${esc(r.name || "")} · <b>${esc(r.email)}</b> · PIC <b>${esc(r.pic || "—")}</b> (chỉ xem)</p>
      ${r.opened ? `<p class="muted" style="font-size:13px">Đang xem ${esc(r.opened.file)}</p>` : ""}${pwChange()}`;
    return;
  }
  const admin = r.role === "lead", many = (r.teams || []).length > 1;
  const inTeam = r.team && many ? ` · ${esc(teamName(r.team))}` : "";
  if (!RUNNER(r)) {  // Operator: views its team's reports only; accounts are the Admin's / Team Lead's
    el.innerHTML = `<h2>Nhóm · ${WEB ? ACCOUNT_ROLE[r.role] || "Operator" : "Operator"}${inTeam}</h2><p style="margin-top:0">${esc(r.name || "")} · <b>${esc(r.email)}</b> (xem mọi PIC, không chạy)</p>
      ${r.opened ? `<p class="muted" style="font-size:13px">Đang xem ${esc(r.opened.file)}</p>` : ""}${pwChange()}`;
    return;
  }
  const roles = admin ? [["member", "Thành viên (chỉ xem PIC)"], ["operator", "Operator (xem mọi PIC, không chạy)"],
    ["team_lead", "Team Lead (chạy + quản lý nhóm)"], ["lead", "Admin (mọi nhóm)"]]
    : [["member", "Thành viên (chỉ xem PIC)"], ["operator", "Operator (xem mọi PIC, không chạy)"]];
  const teamPick = admin && many ? `<div><label for="mb-team">Nhóm</label><select id="mb-team">${r.teams.map((t) =>
    `<option value="${esc(t.id)}" ${t.id === r.work_team ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>` : "";
  el.innerHTML = `<h2>Nhóm · ${admin ? "Admin" : "Team Lead"}${inTeam}</h2><p style="margin-top:0"><b>${esc(r.email)}</b> · ${esc(r.url)}</p>${r.needs_key ? keyHelp() : ""}
    <h3 style="font-size:14px;margin:12px 0 4px">Tài khoản</h3><div id="mb-table"><div class="muted"><span class="spin"></span></div></div>
    <div class="grid ${teamPick ? "g5" : "g4"}" style="margin-top:8px${teamPick ? ";grid-template-columns:1fr 1fr 1fr .7fr 1.6fr" : ""}">
      <div><label for="mb-email">Email</label><input type="text" id="mb-email" autocomplete="off"></div>
      <div><label for="mb-name">Tên hiển thị</label><input type="text" id="mb-name"></div>
      <div><label for="mb-pic">PIC</label><input type="text" id="mb-pic" list="mb-pics"><datalist id="mb-pics"></datalist></div>
      ${teamPick}
      <div><label for="mb-role">Vai trò</label><div style="display:flex;gap:6px"><select id="mb-role">${roles.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select><button class="btn primary" id="mb-add">Tạo</button></div></div>
    </div>
    <div id="mb-pw"></div>
    ${admin && many ? `<h3 style="font-size:14px;margin:14px 0 4px">Nhóm & Ads profile</h3>
      <p class="muted" style="font-size:12px;margin:0 0 6px">Ads profile của từng nhóm (bật/tắt campaign, budget, Activity Log). Nhóm có nhiều profile: nhập các số cách nhau bằng dấu phẩy. Team Lead và Operator của nhóm dùng profile này; nhóm chưa có profile sẽ không thao tác Ads.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">${r.teams.map((t) => `<div><label for="tp-${esc(t.id)}">${esc(t.name)}${t.is_default ? " (mặc định)" : ""}</label>
        <div style="display:flex;gap:6px"><input type="text" id="tp-${esc(t.id)}" value="${esc(t.ads_profile || "")}" placeholder="${t.is_default ? "mặc định của app" : "chưa có"}" style="width:260px">
        <button class="btn sm" data-tp="${esc(t.id)}">Lưu</button></div></div>`).join("")}</div>` : ""}
    <p class="muted" style="font-size:12px">App tạo mật khẩu đầu tiên để bạn gửi cho người đó; không có email nào được gửi. Đổi PIC / khoá tài khoản có hiệu lực ngay; báo cáo tải lên trước khi một người đăng nhập lần đầu sẽ không có phần của họ.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
      <div><label for="lk-pw">Mật khẩu file khoá (≥ 8 ký tự)</label><input type="password" id="lk-pw" autocomplete="new-password"></div>
      <button class="btn" id="lk-export" ${r.needs_key ? "disabled" : ""}>Xuất khoá Lead…</button>
    </div>${pwChange()}`;
  loadMembers();
}
async function loadMembers() {
  const m = await api.members();
  const box = $("#mb-table");
  if (!box) return;
  if (m.error) { box.innerHTML = `<div class="empty">${esc(m.error)}</div>`; return; }
  const pics = S.run ? [...new Set(S.run.digest.map((d) => d.pic))].filter((p) => p !== NO_PIC) : [];
  $("#mb-pics").innerHTML = [...new Set([...pics, ...m.members.map((x) => x.pic).filter(Boolean)])].map((p) => `<option>${esc(p)}</option>`).join("");
  const teams = (S.role.role === "lead" && (S.role.teams || []).length > 1) ? S.role.teams : null;  // the Admin moves people between teams
  const teamCell = (x) => !teams ? "" : `<td>${x.role === "lead" ? "Mọi nhóm" : `<select class="mb-team-edit" aria-label="Nhóm">${teams.map((t) =>
    `<option value="${esc(t.id)}" ${t.id === x.team ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`}</td>`;
  box.innerHTML = `<div class="tbl"><table><thead><tr><th>Email</th><th>Tên</th><th>Vai trò</th>${teams ? "<th>Nhóm</th>" : ""}<th>PIC</th><th>Trạng thái</th><th></th></tr></thead><tbody>
    ${m.members.map((x) => `<tr data-email="${esc(x.email)}"><td data-no-i18n>${esc(x.email)}</td><td data-no-i18n>${esc(x.name || "")}</td><td>${ACCOUNT_ROLE[x.role] || esc(x.role)}</td>${teamCell(x)}
      <td>${x.role !== "member" ? "—" : `<input type="text" class="mb-pic-edit" list="mb-pics" value="${esc(x.pic || "")}" style="width:140px" aria-label="PIC">`}</td>
      <td><span class="sev ${STATUS[x.status][0]}">${STATUS[x.status][1]}</span></td>
      <td style="white-space:nowrap">${x.email === S.role.email ? "" : `<button class="btn sm ghost" data-mb="reset">Đặt lại mật khẩu</button><button class="btn sm ghost" data-mb="toggle" data-active="${x.active ? 1 : 0}">${x.active ? "Khoá" : "Mở khoá"}</button><button class="btn sm ghost" data-mb="delete">Xoá</button>`}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function setupError(msg) {
  $("#setup-error").textContent = msg || "";
  $("#setup-error").classList.toggle("hidden", !msg);
}
function openSetup() {
  const r = S.role || {};
  setupError(r.configured === false ? "App chưa có máy chủ nhóm – cập nhật app lên bản mới nhất." : "");
  $("#su-email").value = r.email || store("lastEmail") || "";
  $("#su-pw").value = "";
  $("#su-ver").textContent = S.update && S.update.current ? `PMKT Alert v${S.update.current}` : "PMKT Alert";
  $("#setup").classList.add("on");
  setTimeout(() => ($("#su-email").value ? $("#su-pw") : $("#su-email")).focus(), 50);
}
function closeSetup() { $("#setup").classList.remove("on"); }
async function signIn(e) {
  if (e) e.preventDefault();
  const email = $("#su-email").value.trim(), pw = $("#su-pw").value;
  if (!email || !pw) { setupError(!email ? "Nhập email." : "Nhập mật khẩu."); (!email ? $("#su-email") : $("#su-pw")).focus(); return; }
  const b = $("#su-signin");
  b.disabled = true; b.innerHTML = '<span class="spin"></span> Đang đăng nhập…';
  setupError("");
  const r = await api.team_sign_in(email, pw);
  b.disabled = false; b.textContent = I18N.t("Đăng nhập");
  if (r.error) { setupError(r.error); $("#su-pw").select(); return; }
  store("lastEmail", email);
  $("#su-pw").value = "";
  closeSetup();
  await loadRole();
  toast(r.role === "lead" ? "Đã đăng nhập – Admin." : r.role === "team_lead" ? `Đã đăng nhập – Team Lead ${teamName(r.team)}.`
    : r.role === "operator" ? "Đã đăng nhập – Operator (xem mọi PIC)." : `Đã đăng nhập – xem PIC ${r.pic}.`);
  if (!RUNNER(r)) loadReports(true);
  else { loadLastRun(); loadLessons(); loadReview(); }
  if (r.needs_key) { go("settings", "team"); loadSettings(); }
}
async function loadReports(openNewest) {
  const r = await api.list_reports();
  if (r.error) { $("#report-list").innerHTML = `<option value="">${esc(r.error)}</option>`; return; }
  const cur = S.role && S.role.opened ? S.role.opened.file : null;
  $("#report-list").innerHTML = r.reports.length ? r.reports.map((x) => `<option value="${esc(x.name)}" ${x.name === cur ? "selected" : ""}>${esc(upName(x.name))}${x.opened_at ? ` · đã mở ${esc(upTime(x.opened_at))}` : " · chưa mở"}</option>`).join("")
    : "<option value=''>Chưa có báo cáo</option>";
  if (openNewest && r.reports.length && r.reports[0].name !== cur) openReport(r.reports[0].name);
}
async function openReport(name) {
  if (!name) return;
  const r = await api.open_report(name);
  if (bad(r)) return;
  setRun(r);
  await loadRole();
  $("#published-line").textContent = ` · ${r.published_by || "Lead"} tải lên ${(r.published_at || "").replace("T", " ").slice(0, 16)}`;
  go("results");
}
async function uploadReport() {
  const b = $("#upload-btn");
  b.disabled = true;
  const r = await api.upload_report(S.runId);
  b.disabled = false;
  if (bad(r)) return;
  $("#published-line").textContent = ` · đã tải lên ${r.name}`;
  pushHourly();  // the new report gets the hourly data right away
  const missing = r.no_readers.filter((p) => p !== NO_PIC);
  toast(`Đã tải lên ${r.name} (${(r.size / 1048576).toFixed(1)} MB) cho ${Object.keys(r.readers).length} PIC.${missing.length ? ` Chưa có tài khoản cho: ${missing.join(", ")}.` : ""}${r.waiting.length ? ` Chưa đăng nhập lần nào: ${r.waiting.join(", ")}.` : ""}`);
}
function wireTeam() {
  $("#team-switch").onchange = async (e) => {
    const r = await api.set_work_team(e.target.value);
    if (bad(r)) { e.target.value = (S.role || {}).work_team || ""; return; }
    location.reload();  // every tab reloads with the team's own data, logic and reports
  };
  $("#role-badge").onclick = () => { if (!(S.role || {}).signed_in) openSetup(); else { go("settings", "team"); loadSettings(); } };
  $("#su-form").addEventListener("submit", signIn);
  $("#su-eye").onclick = () => {
    const show = $("#su-pw").type === "password";
    $("#su-pw").type = show ? "text" : "password";
    $("#su-eye").setAttribute("aria-pressed", String(show));
    $("#su-eye").setAttribute("aria-label", show ? "Ẩn mật khẩu" : "Hiện mật khẩu");
    $("#su-pw").focus();
  };
  const caps = (e) => { if (e.getModifierState) $("#su-caps").classList.toggle("hidden", !e.getModifierState("CapsLock")); };
  $("#su-pw").addEventListener("keydown", caps);
  $("#su-pw").addEventListener("keyup", caps);
  $("#upload-btn").onclick = uploadReport;
  $("#reload-pmkt").onclick = () => loadReports(false);
  $("#save-pmkt").onclick = async () => {
    const r = await api.save_report($("#report-list").value);
    if (!bad(r) && r.path) toast(`Đã lưu ${r.path}`);
  };
  $("#report-list").onchange = (e) => openReport(e.target.value);
  $("#open-pmkt").onclick = async () => {
    const f = await api.pick_file("PMKT Alert", "*.pmkt");
    if (bad(f) || !f.path) return;
    const r = await api.open_local_report(f.path);
    if (!bad(r)) { setRun(r); await loadRole(); go("results"); }
  };
  document.addEventListener("change", async (e) => {
    if (e.target.classList.contains("mb-team-edit")) {
      const email = e.target.closest("tr").dataset.email;
      if (!bad(await api.update_member(email, { team: e.target.value }))) toast(`Đã chuyển sang nhóm ${teamName(e.target.value)} – có hiệu lực từ báo cáo tải lên tiếp theo.`);
      else loadMembers();
      return;
    }
    if (!e.target.classList.contains("mb-pic-edit")) return;
    const email = e.target.closest("tr").dataset.email;
    if (!bad(await api.update_member(email, { pic: e.target.value.trim() }))) toast("Đã đổi PIC – có hiệu lực từ báo cáo tải lên tiếp theo.");
  });
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.copy) { copyText($("#" + t.dataset.copy).textContent); return; }
    if (t.dataset.tp) {
      const r = await api.team_set_ads_profile(t.dataset.tp, $("#tp-" + t.dataset.tp).value);
      if (!bad(r)) { S.role = { ...S.role, teams: r.teams }; toast(`Đã lưu Ads profile của nhóm ${teamName(t.dataset.tp)}.`); }
      return;
    }
    if (t.dataset.mb) {
      const row = t.closest("tr"), email = row.dataset.email;
      if (t.dataset.mb === "delete" && confirm(I18N.t("Xoá tài khoản này? Người đó mất quyền xem ngay lập tức."))) { if (!bad(await api.remove_member(email))) loadMembers(); }
      if (t.dataset.mb === "reset" && confirm(I18N.t("Tạo mật khẩu mới cho tài khoản này? Mật khẩu cũ hết hiệu lực."))) {
        const r = await api.reset_password(email);
        if (!bad(r)) showPassword(email, r.password, "Mật khẩu mới");
      }
      if (t.dataset.mb === "toggle") { if (!bad(await api.update_member(email, { active: t.dataset.active !== "1" }))) loadMembers(); }
      return;
    }
    switch (t.id) {
      case "team-setup": openSetup(); break;
      case "team-signout": if (!bad(await api.team_sign_out())) { S.run = null; await loadRole(); openSetup(); } break;
      case "team-forget": {
        t.disabled = true;
        const r = await api.team_forget_device($("#fg-pw").value);
        t.disabled = false;
        if (!bad(r)) { S.run = null; toast("Đã gỡ tài khoản khỏi máy này."); await loadRole(); openSetup(); }
        break;
      }
      case "mb-add": {
        const email = $("#mb-email").value.trim();
        const r = await api.add_member(email, $("#mb-name").value.trim(), $("#mb-pic").value.trim(), $("#mb-role").value, $("#mb-team") ? $("#mb-team").value : null);
        if (!bad(r)) { ["#mb-email", "#mb-name", "#mb-pic"].forEach((s) => ($(s).value = "")); await loadMembers(); showPassword(email.toLowerCase(), r.password, "Đã tạo tài khoản"); }
        break;
      }
      case "pw-save": {
        const r = await api.team_change_password($("#pw-new").value);
        if (!bad(r)) { $("#pw-new").value = ""; toast("Đã đổi mật khẩu."); }
        break;
      }
      case "lk-export": {
        const r = await api.export_lead_key(null, $("#lk-pw").value);
        if (!bad(r) && !r.cancelled) toast(`Đã lưu ${r.path} – cất giữ cẩn thận.`);
        break;
      }
      case "lk-import": {
        const f = await api.pick_file("Khoá Lead", "*.pmktkey");
        if (bad(f) || !f.path) return;
        const pw = prompt(I18N.t("Mật khẩu file khoá"));
        if (!pw) return;
        if (!bad(await api.import_lead_key(f.path, pw))) { toast("Đã nhập khoá Lead."); loadRole(); }
        break;
      }
      case "lk-reset":
        if (confirm(I18N.t("Tạo khoá ký mới cho nhóm? Các báo cáo đã tải lên trước đây sẽ không mở được nữa.")) && !bad(await api.team_reset_lead_key())) { toast("Đã tạo khoá mới."); loadRole(); }
        break;
    }
  });
}
async function initTeam() {
  wireTeam();
  const r = await loadRole();
  if (!r) return;
  if (!r.signed_in) { openSetup(); return; }  // nothing works before sign-in
  await syncRole();  // the Lead may have changed this account since the last session
  const s = await api.startup_open();
  if (!s.error && s.opened) { const res = await api.results(); if (!res.error) setRun(res); await loadRole(); go("results"); }
  if (r.signed_in && !RUNNER(r)) {
    // Operators / Members can't run data: start on the results page (report picker, Mở file .pmkt) instead of
    // the run page, also when opening the newest report fails (feedback #75)
    if (!(s && s.opened) && ["run", "review"].includes(($("main section.on") || {}).id)) go("results");
    loadReports(!(s && s.opened));
  }
}

// ------------------------------------------------------------------ Performance Review (logic brief)
// [key, label, format, actual only (no target in KPI)]
const PF_METRICS = [["gmv", "GMV", "money"], ["rs", "RS", "int"], ["spend", "Ads Spend", "money"], ["tacos", "TACOS", "pct"], ["acos", "ACOS", "pct", true]];
// Product line and SKU tables (feedback #48, #58): Total pfm (GMV, RS), then Ads pfm, with a divider before it (no shading).
const PF_PL_ADS = [["ads_nmv", "Ads NMV", "money", true], ["ads_rs", "Ads RS", "int", true], ["ads_rs_share", "%PPC RS/Total", "pct", true]];
// Cross sale (this product's ads → other products) and halo effect (other products' ads → this product), from the
// Converted product file (USD) – shown only when that file was loaded.
const PF_CROSS = [["cross_nmv", "Cross-sale NMV", "money", true], ["cross_rs", "Cross-sale RS", "int", true],
  ["halo_nmv", "Halo NMV", "money", true], ["halo_rs", "Halo RS", "int", true]];
const PF_ADS = new Set(["spend", "tacos", "acos", ...PF_PL_ADS.map(([k]) => k), ...PF_CROSS.map(([k]) => k)]);
const pfMetrics = (table, hide = new Set()) => [...PF_METRICS, ...PF_PL_ADS, ...(S.pf && S.pf.converted ? PF_CROSS : [])]
  .filter(([k]) => !hide.has(k));
const pfAdsCls = (table, hide) => {  // metric key → " pf-ads" (+ " pf-ads0" on the first visible Ads column); " pf-g" opens each metric group (feedback #49)
  const first = pfMetrics(table, hide).find(([k]) => PF_ADS.has(k));
  return (k, i) => (i ? "" : " pf-g") + (PF_ADS.has(k) ? ` pf-ads${first && first[0] === k && !i ? " pf-ads0" : ""}` : "");
};
// Show / hide columns of the Product line and SKU tables (a metric hides its Tgt/Act/% together); remembered per machine.
const PF_COLS = {
  pl: [["action", "PL action code"], ["reason", "Reason"]],
  sku: [["pl", "Product line"], ["product", "Product name"], ["ineligible", "Ineligible status"], ["stock", "Current stock"], ["incoming", "Incoming"], ["listing", "Listing issue"]],
};
function pfHidden(table) { try { return new Set(JSON.parse(store(`pfHide_${table}`) || "[]")); } catch { return new Set(); } }
const pfCells = (cells, hide) => cells.filter(([k]) => !hide.has(k)).map(([, h]) => h).join("");
function pfColChooser(btn) {
  const table = btn.dataset.pfcols, hide = pfHidden(table), pop = $("#colpop");
  const opts = [...PF_COLS[table], ...pfMetrics(table).map(([k, label]) => [k, label])];
  pop.innerHTML = `<div style="display:flex;align-items:center"><b style="flex:1">Hiện / ẩn cột</b><button class="btn sm ghost" data-closepop aria-label="Đóng">✕</button></div>
    ${opts.map(([k, label]) => `<label class="colchk"><input type="checkbox" data-pftoggle="${table}:${k}" ${hide.has(k) ? "" : "checked"}> ${esc(label)}</label>`).join("")}
    <button class="btn sm ghost" data-pfshowall="${table}" style="margin-top:6px">Hiện tất cả</button>`;
  const r = btn.getBoundingClientRect();
  pop.classList.remove("hidden");
  pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8) + "px";
}
function pfSetHidden(table, set) { store(`pfHide_${table}`, JSON.stringify([...set])); if (S.pf) renderPerf(); }
const pfColsBtn = (table) => `<button type="button" class="btn sm ghost" data-pfcols="${table}" aria-haspopup="true"><svg class="i" aria-hidden="true"><use href="#cols"/></svg>Cột</button>`;
const pfFmt = { money: (v) => money(v), int: (v) => (num(v) ? Math.round(v).toLocaleString("en-US") : "—"), pct: (v) => pct(v, 1) };
function pfAchieve(v, key, gone) {
  if (!num(v)) return '<span class="muted">—</span>';
  // GMV/RS ≥ campaign gone = green (ahead); Ads spend ≤ campaign gone = green; TACoS ≤ 100% = green.
  const good = key === "gmv" || key === "rs" ? v >= gone : key === "tacos" ? v <= 1 : v <= gone;
  return `<span class="num pf-ach ${good ? "ok" : "bad"}">${pct(v, 1)}</span>`;  // soft pill (feedback #49)
}
// Metrics laid out as columns (Excel-style): one row per entity, 3 cells per metric (actual-only metrics: 1).
function pfWideRow(obj, lead, gone, tail, hide, table = "sku", i) {
  const c = pfAdsCls(table, hide);
  return `<tr${i == null ? "" : ` data-i="${i}"`}>${lead}${pfMetrics(table, hide).map(([k, , f, actOnly]) => actOnly ? `<td class="n${c(k, 0)}"${pfXdetAttr(table, obj, k)}>${pfFmt[f](obj.actual[k])}</td>`
    : `<td class="n${c(k, 0)}">${pfFmt[f](obj.target[k])}</td><td class="n${c(k, 1)}">${pfFmt[f](obj.actual[k])}</td><td class="n${c(k, 1)}">${pfAchieve(obj.achieve[k], k, gone)}</td>`).join("")}${tail}</tr>`;
}
// feedback #61: a Cross-sale / Halo cell of the Product line / SKU tables carries its row, so hovering lists the
// counterpart SKUs (performance.cross_detail); the Tổng row (no pl / asin) has none.
const PF_CROSS_KEYS = new Set(["cross_nmv", "cross_rs", "halo_nmv", "halo_rs"]);
function pfXdetAttr(table, obj, k, id = table === "pl" ? obj.pl : obj.asin) {
  const det = S.pf && S.pf.cross_detail;
  return PF_CROSS_KEYS.has(k) && id != null && det && det[table]?.[id]?.[k] ? ` data-xdet="${table}" data-xid="${esc(id)}" data-xkey="${k}"` : "";
}
// feedback #76: the Campaign table's Cross-sale cells – "camp" = the campaign row (id = campaign_id), "camp_asin" = one
// SKU / ASIN of an expanded campaign (id = "campaign_id|asin"); the panel lists the purchased SKUs with their names.
const pfCampXid = (c, s) => (s ? `${c.campaign_id}|${s.asin}` : String(c.campaign_id));
function pfXdetHtml(td) {
  const { xdet: table, xid: id, xkey: k } = td.dataset, e = S.pf?.cross_detail?.[table]?.[id]?.[k];
  if (!e) return "";
  const label = PF_CROSS.find(([x]) => x === k)[1], fmt = k.endsWith("_nmv") ? money : pfFmt.int;
  const camp = table === "camp" || table === "camp_asin" ? (S.pfCampList || []).find((c) => String(c.campaign_id) === id.split("|")[0]) : null;
  const asin = table === "camp_asin" ? id.slice(id.indexOf("|") + 1) : table === "sku" ? id : null;
  const kid = camp && asin ? (camp.skus || []).find((s) => s.asin === asin) : null;
  const sk = asin ? S.pf.skus.find((s) => s.asin === asin) || kid : null;
  const row = table === "pl" ? id : table === "camp" ? (camp ? pfCampName(camp) : id) : (sk?.sku || asin);
  const what = k.startsWith("cross") ? (table === "camp" ? "Quảng cáo của campaign này mang về cho:" : "Quảng cáo của dòng này mang về cho:") : "Nhận từ quảng cáo của:";
  // feedback #64: the product name of the hovered SKU and of each counterpart
  const pname = (n) => (n ? `<div class="xname muted" data-no-i18n>${esc(n)}</div>` : "");
  return `<b>${label}</b> · <b data-no-i18n>${esc(row)}</b>${pname(sk?.product || kid?.product)}${table === "camp_asin" && camp ? `<div class="muted" data-no-i18n>${esc(pfCampName(camp))}</div>` : ""}<div class="muted">${what}</div><ul>${e.top.map(([sku, asin, name, v]) =>
    `<li><span data-no-i18n>${sku ? `<b>${esc(sku)}</b> ` : ""}<span class="muted">${esc(asin)}</span> – <span class="num">${fmt(v)}</span></span>${pname(name)}</li>`).join("")}${
    e.more ? `<li><span data-no-i18n>+${e.more}</span> <span>khác</span><span data-no-i18n> – <span class="num">${fmt(e.rest)}</span></span></li>` : ""}</ul>`;
}
// feedback #56: a Tổng row frozen at the bottom (tfoot) of the Product line / SKU tables, over the rows shown (SKU filter
// here, column filters via xfApply → pfTotRedraw); ratios are recomputed from the sums, like performance.from_sums.
const pfDiv = (a, b) => (b && a != null ? a / b : null);
function pfTotal(rows) {
  const sum = (o, ks) => Object.fromEntries(ks.map((k) => [k, rows.reduce((a, r) => a + (r[o][k] || 0), 0)]));
  const t = sum("target", ["gmv", "rs", "spend"]), a = sum("actual", ["gmv", "rs", "spend", "ads_nmv", "ads_rs", ...PF_CROSS.map(([k]) => k)]);
  t.tacos = pfDiv(t.spend, t.gmv); a.tacos = pfDiv(a.spend, a.gmv); a.acos = pfDiv(a.spend, a.ads_nmv); a.ads_rs_share = pfDiv(a.ads_rs, a.rs);
  return { target: t, actual: a, achieve: Object.fromEntries(["gmv", "rs", "spend", "tacos"].map((k) => [k, pfDiv(a[k], t[k])])) };
}
function pfTotRow(table, rows) {  // blank cells under the non-metric columns keep the row aligned for the table export
  const { gone, hide } = S.pfTot[table], blank = (ks) => pfCells(ks.map(([k]) => [k, "<td></td>"]), hide);
  return pfWideRow(pfTotal(rows), `<td>Tổng</td>${table === "sku" ? blank(PF_COLS.sku) : ""}`, gone, table === "pl" ? blank(PF_COLS.pl) : "", hide, table)
    .replace("<tr>", '<tr style="font-weight:700">');
}
function pfTotRedraw(t, vis) {
  const { rows } = S.pfTot[t.dataset.pftot];
  t.tFoot.innerHTML = pfTotRow(t.dataset.pftot, vis.map((g) => rows[g[0].dataset.i]).filter(Boolean));
}
// Sortable perf tables. Key forms: "field" (plain), "t:<m>" target, "a:<m>" actual, "ach:<m>" %achieve.
S.pfSort = S.pfSort || {};
S.pfOpenCamp = S.pfOpenCamp || new Set();
S.pfCampQ = S.pfCampQ || "";
function pfVal(o, key) {
  if (key.startsWith("t:")) return o.target[key.slice(2)];
  if (key.startsWith("a:")) return o.actual[key.slice(2)];
  if (key.startsWith("ach:")) return o.achieve[key.slice(4)];
  return o[key];
}
const pfInelig = (ie) => `${ie.current ? `<span class="sev ${ie.current.startsWith("INELIGIBLE") ? "HIGH" : "MED"}" data-no-i18n>${esc(ie.current)}</span>` : '<span class="muted">—</span>'}
        <div class="muted" style="font-size:11px">${ie.changes} lần đổi · ${ie.days} ngày ineligible</div>`;
const pfStock = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
function pfSort(rows, table) {
  const st = S.pfSort[table];
  if (!st || !st.key) return rows;
  return [...rows].sort((a, b) => {
    const x = pfVal(a, st.key), y = pfVal(b, st.key);
    if (typeof x === "string" || typeof y === "string") return String(x ?? "").localeCompare(String(y ?? "")) * st.dir;
    return ((x == null ? -Infinity : x) - (y == null ? -Infinity : y)) * st.dir;
  });
}
// feedback #37: TACOS Tgt is the row's own Ads Spend target ÷ GMV target (KPI) – the SKUs of a PL whose KPI spend was
// planned at one rate share the same value, so the header says how it is computed.
const PF_TH_TITLE = { "t:tacos": "TACOS target = Ads Spend target ÷ GMV target của dòng (KPI) · dòng Tổng = Σ Ads Spend target ÷ Σ GMV target" };
function pfTh(label, key, table, cls = "") {  // sort is handled by the Excel-style column menu (▾)
  return `<th class="${cls}"${PF_TH_TITLE[key] ? ` title="${esc(PF_TH_TITLE[key])}"` : ""}>${label}</th>`;
}
// feedback #49: the metric name sits above Tgt · Act · % (shown once per group) – still one header row, so the column
// menu / resize keep working and the header text ("GMV Tgt", …) stays the same for the export and saved widths.
const pfGrp = (label, rep) => `<span class="pf-grp${rep ? " rep" : ""}">${label}</span> `;
const pfMetricHeads = (table, hide) => { const c = pfAdsCls(table, hide); return pfMetrics(table, hide).map(([k, label, , actOnly]) => actOnly ? pfTh(label, `a:${k}`, table, `n${c(k, 0)}`) :
  pfTh(`${pfGrp(label)}Tgt`, `t:${k}`, table, `n${c(k, 0)}`) + pfTh(`${pfGrp(label, 1)}Act`, `a:${k}`, table, `n${c(k, 1)}`) + pfTh(`${pfGrp(label, 1)}%`, `ach:${k}`, table, `n${c(k, 1)}`)).join(""); };
const PF_TONE = { "var(--ok)": "OK", "var(--high)": "HIGH", "var(--med)": "MED" };
// Performance Review only needs the rules' result, so it is computed while Claude is still running.
const pfDefaultFilter = () => ({ pic: S.pfPic || (S.pic && S.pic !== ALL_PIC ? [S.pic] : []), sku: S.pfSku });
function prefetchPerf(runId) {
  S.pfPrefetch = { runId, p: api.performance(pfDefaultFilter(), runId) };
}
async function loadPerf(keepFilters) {
  if (!S.runId && !(S.role && !RUNNER(S.role))) { $("#pf-body").innerHTML = '<div class="empty">Chưa có dữ liệu – chạy dữ liệu trước.</div>'; return; }
  if (!keepFilters && S.pf && S.pfRunId === S.runId) { renderPerf(); return; }  // already loaded for this run – no refetch on tab switch
  if (!keepFilters && S.pfLoading) return;  // a background/preload fetch for this run is already in flight
  const f = keepFilters ? { pic: S.pfPic, start: $("#pf-start").value, end: $("#pf-end").value, pl: S.pfPl, leader: S.pfLeader, sku: S.pfSku } : pfDefaultFilter();
  $("#pf-body").innerHTML = '<div class="muted"><span class="spin"></span> Đang tính…</div>';
  S.pfLoading = true;
  const pre = !keepFilters && S.pfPrefetch && S.pfPrefetch.runId === S.runId ? S.pfPrefetch.p : null;
  S.pfPrefetch = null;
  const d = await (pre || api.performance(f, S.runId)).finally(() => { S.pfLoading = false; });
  if (d.error) { $("#pf-body").innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  S.pf = d; S.pfRunId = S.runId;
  const ff = d.filters;
  S.pfPic = ff.pic; S.pfLeader = ff.leader.filter((p) => ff.leaders.includes(p)); S.pfPl = ff.pl.filter((p) => ff.pls.includes(p));
  S.pfSku = ff.sku.filter((a) => d.skus.some((s) => s.asin === a));  // the PL/PIC filter narrowed the SKU set
  pfMselRender("pic", ff.pics.map((p) => [p, p]));
  $("#pf-leader").parentElement.hidden = !ff.leaders.length;  // data without a Sales Leader column
  pfMselRender("leader", ff.leaders.map((p) => [p, p]));
  pfMselRender("pl", ff.pls.map((p) => [p, p]));
  pfMselRender("sku", d.skus.map((s) => [s.asin, `${s.sku} (${s.asin})`]));
  for (const [id, v] of [["#pf-start", ff.start], ["#pf-end", ff.end]]) { $(id).value = v; $(id).min = ff.min; $(id).max = ff.max; }
  renderPerf();
}
const LOST_FORMULA = "Potential = Sessions × CVR × AOV baseline (ngày cùng thứ trong 8 tuần gần nhất, không dính listing issue / deal, cần ≥ 4 ngày); chưa đủ data → GMV trung bình/ngày 14 ngày trước. Est GMV lost = Potential − GMV thực tế, gán cho 1 nguyên nhân theo thứ tự Hết hàng → Mất buybox → Shipping → Giá → Unexplained";
const lostCell = (x) => x.est_gmv_lost == null ? '<span class="muted">—</span>'
  : `${money(x.est_gmv_lost)}<div class="muted" style="font-size:11px">${esc(x.lost_cause || "")}</div>`;
function pfToday(t, hd) {
  if (!t) return "";
  // the server scopes to PIC ∧ Sales Leader ∧ Product line; the SKU filter narrows every list here too
  t = { ...t, ...Object.fromEntries(["blocked_now", "blocked_new", "blocked_removed", "listing_new", "listing_resolved", "listing_open", "oos"]
    .map((k) => [k, (t[k] || []).filter((x) => pfSkuOn(x.asin))])) };
  const base = t.has_listing_baseline ? "" : "Chưa có dữ liệu lần upload trước để so sánh – đang hiện danh sách hiện tại.";
  const tabs = [
    ["blocked_now", "Tổng ASIN đang bị block ads", "high", ""], ["blocked_new", "Mới bị block ads", "high", ""], ["blocked_removed", "Được gỡ block ads", "ok", ""],
    ["listing_new", "Mới bị listing issue", "high", base], ["listing_resolved", "Hết listing issue", "ok", base],
    ["listing_open", "Listing issue tồn đọng", "high", `SKU đã bị issue từ ngày data trước (không gồm SKU mới bị). Chỉ tính trên lịch sử listing lưu ${hd || 0}/30 ngày gần nhất (mỗi lần chạy lưu 1 ngày).`],
    ["oos", "Hết hàng cần off ads", "high", t.inv_available ? "" : "Thiếu dữ liệu tồn kho (KPI · Current Stock)."]];
  if (!tabs.some(([k]) => k === S.pfTodayTab)) S.pfTodayTab = (tabs.find(([k]) => t[k].length) || tabs[0])[0];
  const [key, title, , note] = tabs.find(([k]) => k === S.pfTodayTab), arr = t[key];
  const tile = ([k, lbl, tone]) => `<button type="button" class="card kpi td-tab ${k === key ? "on" : ""}" data-td="${k}" aria-pressed="${k === key}">
      <div class="lbl">${lbl}</div><div class="val num ${t[k].length ? tone : "zero"}">${t[k].length}</div></button>`;
  const extra = key === "oos" ? "Tồn kho" : ["listing_new", "listing_open", "listing_resolved"].includes(key) ? "Issue" : key === "blocked_now" ? "Trạng thái" : "";
  const cell = (x) => key === "oos"
    ? `<span class="sev ${x.status === "HẾT HÀNG" ? "HIGH" : "MED"}">${esc(x.status)}${x.days_left != null ? ` · ${rhu(x.days_left)}d` : ""}</span>`
    : `<span class="sev MED">${esc(x.issue || "")}</span>`;
  const open = key === "listing_open", lost = key === "listing_new" || open;  // est GMV lost (performance.gmv_lost_fn) + its waterfall cause
  const rows = arr.map((x) => `<tr><td data-no-i18n><b>${esc(x.sku)}</b></td><td class="muted" data-no-i18n>${esc(x.asin)}</td><td class="td-pn" title="${esc(x.product || "")}" data-no-i18n>${esc(x.product || "")}</td><td>${esc(x.pl)}</td>${extra ? `<td>${cell(x)}</td>` : ""}${open ? `<td class="num">${x.since ? `${ddmm(x.since)}/${x.since.slice(0, 4)}` : "—"}</td><td class="n">${x.days}</td>` : ""}${lost ? `<td class="n">${lostCell(x)}</td>` : ""}</tr>`).join("");
  const cols = 4 + !!extra + lost + 2 * open;
  return `<div class="card td-card" style="margin-top:12px">
    <h2>Tóm tắt hôm nay <span class="muted" style="font-weight:400;font-size:13px" data-no-i18n>· ${ddmm(t.as_of)}/${t.as_of.slice(0, 4)}</span></h2>
    <div class="td-tabs">
      ${tabs.map(tile).join("")}
    </div>
    <div class="td-h" style="margin-top:12px">${title} <span class="td-n" data-xf-count>${arr.length}</span></div>
    ${note ? `<div class="muted" style="font-size:12px;margin:0 0 6px">${note}</div>` : ""}
    <div class="tbl" style="max-height:320px"><table>
      <thead><tr><th>SKU</th><th>ASIN</th><th>Product name</th><th>Product line</th>${extra ? `<th>${extra}</th>` : ""}${open ? '<th>Từ ngày</th><th class="n">Số ngày</th>' : ""}${lost ? `<th class="n" title="${open ? "Cộng các ngày tồn đọng · " : ""}${LOST_FORMULA}">Est GMV lost</th>` : ""}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${cols}" class="muted" style="text-align:center">No data</td></tr>`}</tbody></table></div>
  </div>`;
}
// Nearest incoming shipment of the SKU + a flag when its arrival window moved since the previous data day (history.incoming_changes).
const INC_CHANGE = { earlier: ["Về sớm hơn", "OK"], delay: ["Bị delay", "HIGH"], changed: ["Đổi thời gian incoming", "MED"] };
function pfIncoming(x) {
  if (!x) return "—";
  const [txt, sev] = INC_CHANGE[x.change] || [];
  return `${Math.round(x.qty).toLocaleString("en-US")}<div class="muted" style="font-size:11px" data-no-i18n>${esc(x.window)}</div>${txt
    ? `<span class="sev ${sev}" title="Lần trước: ${esc(x.prev || "")}">${txt}</span>` : ""}`;
}
// Change drivers (feedback #32, #51): which PL / SKU moved GMV, Ads Spend, Real Sale or TACOS – a day vs the day before,
// a week (7 days to the day) vs the 7 days before, or month-to-date vs the same days of the month before. Every PL and
// its SKUs (collapsed under the PL) + a total row; fetched on demand (api.performance_drivers) for the picked day/period.
// Pick the day with the select or by clicking it on the GMV / Ads Spend / TACOS charts.
const PF_DRV = [["spend", "Ads Spend"], ["gmv", "GMV"], ["rs", "RS"], ["tacos", "TACOS"]];
const PF_DRV_P = [["day", "Theo ngày", "hôm trước"], ["week", "Theo tuần", "tuần trước"], ["month", "Theo tháng", "tháng trước"]];
S.pfDrvOpen = S.pfDrvOpen || new Set();
const ppDelta = (v) => (num(v) ? (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(2) + " pp" : "—");
const pfSpan = ([a, b]) => (a === b ? ddmm(a) : `${ddmm(a)}–${ddmm(b)}`);
async function pfDrvLoad(day, p) {
  const req = { k: `${day}|${p}`, pf: S.pf };
  if (S.pfDrvReq && S.pfDrvReq.k === req.k && S.pfDrvReq.pf === req.pf) return;  // already in flight
  S.pfDrvReq = req;
  const f = S.pf.filters;
  const r = await api.performance_drivers({ pic: f.pic, leader: f.leader, pl: f.pl, sku: S.pfSku, end: f.end }, day, p, S.pfRunId);
  if (S.pfDrvReq !== req) return;  // superseded by another day / period / filter
  S.pfDrvReq = null;
  S.pfDrv = { ...r, day, period: p, pf: req.pf };
  pfDrvRedraw();
}
function pfDrivers(note) {
  const days = S.pf.daily.map((x) => x.date);
  if (!days.includes(S.pfDrvDay)) S.pfDrvDay = days[days.length - 1];
  const day = S.pfDrvDay;
  const [p, , was] = PF_DRV_P.find(([k]) => k === S.pfDrvP) || PF_DRV_P[0];
  const d = S.pfDrv && S.pfDrv.day === day && S.pfDrv.period === p && S.pfDrv.pf === S.pf ? S.pfDrv : null;
  if (!d) pfDrvLoad(day, p);
  return drvCard("pf", d, { days, day, p, was, periods: PF_DRV_P, note, help: "Theo ngày = ngày chọn so với ngày liền trước · Theo tuần = 7 ngày đến ngày chọn so với 7 ngày trước đó · Theo tháng = từ đầu tháng đến ngày chọn so với cùng các ngày của tháng trước. Mọi PL (bấm ▸ để xem các SKU), xếp theo độ lớn của Δ đang chọn · RS = Real Sale (units) · bấm 1 ngày trên biểu đồ GMV / Ads Spend / TACOS để xem ngày đó. Đóng góp Δ TACOS = (Δ Ads Spend − TACOS cả phạm vi kỳ trước × Δ GMV) / GMV cả phạm vi kỳ này; cộng các dòng PL = thay đổi TACOS của cả phạm vi (dương = kéo TACOS lên)." });
}
// The change-driver card, shared by Performance Review and Hourly (feedback #84). ns ("pf" / "hr") names its controls
// (#ns-drv-day, #ns-drv-p) and its state (S[ns + "DrvM"] sort tab, S[ns + "DrvOpen"] expanded PLs); d = the loaded
// drivers (null = loading). o: days, day, p / was / periods (no periods = no compare select), note, cut (extra summary
// text), help (footnote).
function drvCard(ns, d, o) {
  const { days, day, p, was, note } = o, sm = S[`${ns}DrvM`], opened = S[`${ns}DrvOpen`];
  const m = PF_DRV.some(([k]) => k === sm) ? sm : "spend", key = `d_${m}`;
  const by = (rs) => [...rs].sort((a, b) => Math.abs(b[key] || 0) - Math.abs(a[key] || 0));
  const tone = (v, bad) => (num(v) && v !== 0 ? `color:var(${bad ? "--high" : "--ok"})` : "");
  const rs = (v) => (num(v) ? Math.round(v).toLocaleString("en-US") : "—");
  const cells = (r) => `<td class="n">${money(r.gmv_prev)}</td><td class="n">${money(r.gmv)}</td><td class="n" style="${tone(r.d_gmv, r.d_gmv < 0)}">${moneyDelta(r.d_gmv) || "—"}</td>
    <td class="n">${money(r.spend_prev)}</td><td class="n">${money(r.spend)}</td><td class="n">${moneyDelta(r.d_spend) || "—"}</td>
    <td class="n">${rs(r.rs_prev)}</td><td class="n">${rs(r.rs)}</td><td class="n" style="${tone(r.d_rs, r.d_rs < 0)}">${r.d_rs ? (r.d_rs > 0 ? "+" : "−") + rs(Math.abs(r.d_rs)) : "—"}</td>
    <td class="n">${pct(r.tacos_prev, 1)}</td><td class="n">${pct(r.tacos, 1)}</td><td class="n" style="${tone(r.d_tacos, r.d_tacos > 0)}">${ppDelta(r.d_tacos)}</td>`;
  const chev = (open) => `<svg class="i" aria-hidden="true" style="transform:rotate(${open ? 90 : 0}deg)"><use href="#chev"/></svg>`;
  const body = !d ? '<tr><td colspan="13" class="muted"><span class="spin"></span> Đang tính…</td></tr>'
    : d.error ? `<tr><td colspan="13" class="muted">${esc(d.error)}</td></tr>`
    : by(d.pls).map((r) => {
      const open = opened.has(r.pl);
      return `<tr class="expandable" data-drvpl="${esc(r.pl)}" aria-expanded="${open}"><td>${chev(open)} <b>${esc(r.pl)}</b> <span class="muted num">(${r.skus.length})</span></td>${cells(r)}</tr>`
        + (open ? by(r.skus).map((x) => `<tr class="child"><td data-no-i18n>↳ <b>${esc(x.sku)}</b> <span class="muted">${esc(x.asin)}</span>${x.product
          ? `<div class="drv-pn muted" title="${esc(x.product)}">${esc(x.product)}</div>` : ""}</td>${cells(x)}</tr>`).join("") : "");
    }).join("");
  const t = d && d.total;
  // feedback #69: the Tổng row sits at the bottom, frozen (tfoot) while the rows scroll, out of the column sort / filter
  const foot = t && !d.error ? `<tfoot><tr style="font-weight:700"><td>Tổng</td>${cells(t)}</tr></tfoot>` : "";
  const head = !t ? "" : `<b class="num">${pfSpan(d.cur)}</b> so với <b class="num">${pfSpan(d.prev)}</b>${o.cut || ""} · cả phạm vi: Δ GMV <b class="num">${moneyDelta(t.d_gmv) || "—"}</b> · Δ Ads Spend <b class="num">${moneyDelta(t.d_spend) || "—"}</b> · TACOS <b class="num">${pct(t.tacos_prev, 1)} → ${pct(t.tacos, 1)}</b>${d.partial ? " · kỳ trước có ngày trước dữ liệu đã tải" : ""}`;
  const th = (lbl, n) => `<th class="n">${lbl} ${n}</th>`;
  return `<div class="card"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="flex:1">PL / SKU nào làm GMV · Ads Spend · TACOS thay đổi${note}</h2>
    ${o.periods ? `<select id="${ns}-drv-p" aria-label="So sánh">${o.periods.map(([k, label]) => `<option value="${k}" ${k === p ? "selected" : ""}>${label}</option>`).join("")}</select>` : ""}
    <select id="${ns}-drv-day" aria-label="Ngày" data-no-i18n>${days.map((x) => `<option value="${x}" ${x === day ? "selected" : ""}>${ddmm(x)}/${x.slice(0, 4)}</option>`).join("")}</select></div>
    <div class="tabs" role="tablist" style="margin:6px 0">${PF_DRV.map(([k, label]) => `<button type="button" role="tab" data-drvm="${k}" aria-selected="${k === m}">Xếp theo Δ ${label}</button>`).join("")}</div>
    <p class="muted" style="font-size:12px;margin:0 0 6px">${head}</p>
    <div class="tbl" style="max-height:520px"><table>
      <thead><tr><th>Product line / SKU</th>${th("GMV", was)}<th class="n">GMV</th><th class="n">Δ GMV</th>${th("Ads Spend", was)}<th class="n">Ads Spend</th><th class="n">Δ Ads Spend</th>
        ${th("RS", was)}<th class="n">RS</th><th class="n">Δ RS</th>
        ${th("TACOS", was)}<th class="n">TACOS</th><th class="n" title="(Δ Ads Spend − TACOS cả phạm vi kỳ trước × Δ GMV) / GMV cả phạm vi kỳ này">Đóng góp Δ TACOS</th></tr></thead>
      <tbody>${body}</tbody>${foot}</table></div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">${o.help}</p></div>`;
}
function pfDrvRedraw() { drvRedraw($('#pf-body [data-w="drivers"]'), () => pfDrivers(S.pfDrvNote)); }
function drvRedraw(w, html) {  // keeps the table's scroll position (expand / collapse, sort tab, loaded)
  if (!w) return;
  const sc = w.querySelector(".tbl"), top = sc ? sc.scrollTop : 0;
  w.innerHTML = html();
  const sc2 = w.querySelector(".tbl");
  if (sc2) sc2.scrollTop = top;
}
// Summary insight (feedback #54, performance.pf_insight): follows PIC ∧ Sales Leader ∧ date only, not the PL / SKU
// filters. Green = good, red = bad, so the card reads at a glance.
const PF_SIGNAL = { up: ["tích cực", "--ok"], flat: ["ổn định", "--muted"], down: ["suy yếu", "--high"] };
const PF_REASON = { oos: (r) => `hết hàng ${r.n} SKU`, listing: (r) => `listing issue ${r.n} SKU`,
  spend: (r) => `ads spend bị cắt (${signed(r.v)} vs L7D)`, cvr: (r) => `CVR giảm (${signed(r.v)} vs L7D)`, asp: (r) => `giá/ASP giảm (${signed(r.v)} vs L7D)` };
function pfInsight(d) {
  // every section is as of the insight day = the day before the last data day (feedback #57), so Overall PFM reads
  // insight.overall, not the timeframe tiles (d.summary)
  const ins = d.insight || {}, t = ins.overall || d.summary, { change: c, top_pls: top = [], off_track: o } = ins;
  const b = (v, good) => `<b class="num"${good == null ? "" : ` style="color:var(${good ? "--ok" : "--high"})"`}>${v}</b>`;
  const sg = (v) => b(signed(v), num(v) && v !== 0 ? v > 0 : null);  // up = good
  const dir = (v) => (v >= 0 ? "tăng" : "giảm");
  const tgtTacos = t.tacos_target ?? (t.gmv_target ? t.spend_target / t.gmv_target : null);  // Ads Spend target ÷ GMV target
  const trend = c && `so với trend: ${sg(c.vs_l3d)} vs L3D, ${sg(c.vs_l7d)} vs L7D`;
  const sec = (title, body) => `<li><b>${title}</b><div style="margin-top:2px">${body}</div></li>`;
  return `<div class="card"><h2>Insight tổng quan</h2><ol style="margin:0;padding-left:20px;display:grid;gap:10px;font-size:13px;line-height:1.55">
    ${sec("Overall PFM", `Tính đến ngày ${b(ddmm(ins.day || d.filters.end))}, GMV đạt ${b(money(t.gmv))} (${b(pct(t.gmv_pct, 1), num(t.gmv_pct) ? t.gmv_pct >= t.time_gone : null)} target, time gone ${b(pct(t.time_gone))}), TACOS ${b(pct(t.tacos, 1), num(t.tacos) && num(tgtTacos) ? t.tacos <= tgtTacos : null)}.`)}
    ${sec("Biến động theo ngày", !c ? '<span class="muted">Không có ngày trước để so.</span>'
    : `PFM ngày ${b(ddmm(c.day))} ${c.d_gmv >= 0 ? "uplift" : "drop"} ${sg(c.gmv_pct)} so với ngày trước đó (${ddmm(c.prev)}): spend ${dir(c.d_spend)} ${b(money(Math.abs(c.d_spend)))} (${signed(c.spend_pct)}), TACOS ${dir(c.d_tacos || 0)} ${b(num(c.d_tacos) ? (Math.abs(c.d_tacos) * 100).toFixed(1) + " pp" : "—", num(c.d_tacos) && c.d_tacos !== 0 ? c.d_tacos < 0 : null)}.<br>
      ${c.cause ? `Nguyên nhân chính: <b>${c.cause} ${dir(c.cause === "ads" ? c.d_ads : c.d_organic)}</b>. ` : ""}Cụ thể, organic GMV ${b(moneyDelta(c.d_organic) || "—", c.d_organic ? c.d_organic > 0 : null)}, ads GMV ${b(moneyDelta(c.d_ads) || "—", c.d_ads ? c.d_ads > 0 : null)} (ads RS ${c.d_ads_rs >= 0 ? "+" : "−"}${Math.abs(Math.round(c.d_ads_rs))})${num(c.ads_share) ? ` → ads đóng góp ${b(pct(c.ads_share))} mức thay đổi, organic đóng góp ${b(pct(c.organic_share))}` : ""}.<br>
      ${c.abnormal ? `<span style="color:var(--high)">⚠ Bất thường ${trend} – cần check ngay.</span>` : `<span class="muted">Bình thường ${trend} – chỉ là biến động 1 ngày, cần follow thêm.</span>`}`)}
    ${sec("Product line đóng góp GMV chính", top.length ? top.map((p) => { const [lbl, col] = PF_SIGNAL[p.signal];
      return `<div><b>${esc(p.pl)}</b> (${b(pct(p.share))} tổng GMV): ${sg(p.vs_prev)} vs hôm qua, ${sg(p.vs_l3d)} vs L3D, ${sg(p.vs_l7d)} vs L7D → signal <b style="color:var(${col})">${lbl}</b></div>`; }).join("") : '<span class="muted">Không có GMV</span>')}
    ${sec("Product line off-track nhất", !o ? '<span class="muted">Không có product line nào chậm hơn time gone.</span>'
    : `<b>${esc(o.pl)}</b> đang đạt ${b(pct(o.achieve, 1), false)} target (time gone ${pct(t.time_gone)}, gap ${b(money(o.gap), false)} GMV). Lý do: ${o.reasons.length ? o.reasons.map((r) => b(PF_REASON[r.k](r), false)).join(", ") : "chưa rõ nguyên nhân – cần check detail"}.<br>=> Cần check detail hơn các SKU của <b>${esc(o.pl)}</b> ở bảng SKU.`)}
  </ol><p class="muted" style="font-size:12px;margin:8px 0 0">Theo PIC · Sales leader · khung thời gian (không theo bộ lọc Product line / SKU). Insight tính đến ngày trước ngày cuối có data (ngày cuối thường chưa đủ data; khung chỉ có 1 ngày thì lấy ngày đó). So với hôm qua = ngày insight so với ngày trước đó; L3D / L7D = trung bình mỗi ngày của 3 / 7 ngày trước ngày insight; bất thường khi lệch quá ±20%. Tỷ trọng GMV, %target và time gone tính từ đầu khung thời gian đến ngày insight; off-track nhất = gap GMV ($) so với target theo time gone lớn nhất; lý do off-track so ngày insight với trung bình L7D.</p></div>`;
}
// One SKU's listing (Keepa) – only when exactly one SKU is filtered (performance.sku_listing): today's Keepa values,
// then Buy Box / New / List Price / Amazon (stepped, $) and Sales Rank (right axis, reversed: up = better) per data day,
// with the day's listing issue as a strip along the top. Prices & rank are saved per run (the Keepa file holds only today).
const price = (v) => (num(v) ? "$" + Number(v).toFixed(2) : "—");
const PF_KEEPA = [["bb", "Buy Box", 4], ["new", "New", 0], ["list", "List Price", 3], ["amazon", "Amazon", 1]];  // [key, label, palette index]
function pfListing(l) {
  const c = l.current || {}, tile = (lbl, val, sub = "") => `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val num" style="font-size:18px">${val}</div>${sub ? `<div class="muted" style="font-size:12px">${sub}</div>` : ""}</div>`;
  const bbSub = num(c.bb) && num(c.bb30) && c.bb30 > 0 ? `30 ngày TB ${price(c.bb30)} · ${signed(c.bb / c.bb30 - 1)}` : num(c.bb30) ? `30 ngày TB ${price(c.bb30)}` : "";
  const ndays = l.days.filter((x) => PF_KEEPA.some(([k]) => num(x[k])) || num(x.rank)).length;
  return `<div class="card"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="flex:1">Listing (Keepa) · <span data-no-i18n>${esc(l.sku)} <span class="muted" style="font-weight:400">${esc(l.asin)}</span></span></h2>
      ${l.issue ? `<span class="sev HIGH">${esc(l.issue)}</span>` : '<span class="sev OK">Không có listing issue</span>'}</div>
    ${l.current ? `<div class="grid pf-tiles" style="margin-top:8px">
      ${tile("Buy Box", num(c.bb) ? price(c.bb) : '<span style="color:var(--high)">Không có</span>', bbSub)}
      ${tile("New", price(c.new))}${tile("List Price", price(c.list))}${tile("Amazon", price(c.amazon))}
      ${tile("Sales Rank", num(c.rank) ? "#" + Math.round(c.rank).toLocaleString("en-US") : "—")}
      ${tile("Buy Box seller", `<span style="font-size:14px" data-no-i18n>${esc(c.seller || "—")}</span>`, esc(c.bb_avail || ""))}
      ${tile("Rating", num(c.rating) ? `${Number(c.rating).toFixed(1)}★` : "—", num(c.reviews) ? `${Math.round(c.reviews).toLocaleString("en-US")} reviews` : "")}
    </div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">${esc(c.avail || "")}${c.updated ? ` · Keepa cập nhật <span class="num">${ddmm(c.updated.slice(0, 10))} ${c.updated.slice(11, 16)}</span>` : ""}</p>`
    : '<p class="muted" style="font-size:12px">Không có ASIN này trong file Keepa (US Keepa Raw Auto) của lần chạy.</p>'}
    <div class="chartbox tall" style="margin-top:8px"><canvas id="pf-listing" role="img" aria-label="Giá và Sales Rank theo ngày"></canvas></div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">Dải trên cùng: <b style="color:var(--high)">đỏ</b> = ngày có listing issue (rê chuột để xem), <b style="color:var(--ok)">xanh</b> = không có, trống = chưa lưu ngày đó.
      Giá & Sales Rank lưu từ mỗi lần chạy (file Keepa chỉ có số hôm nay) – có ${ndays}/${l.days.length} ngày trong khung thời gian, đã lưu ${l.keepa_days} ngày (tối đa 90).</p></div>`;
}
function drawPfListing() {
  const l = S.pf && S.pf.listing;
  if (!l || !document.getElementById("pf-listing")) return;
  const d = l.days, pal = SERIES[isDark() ? "dark" : "light"];
  const step = (label, key, color) => ({ type: "line", label, data: d.map((x) => x[key]), borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: d.length > 40 ? 0 : 2, stepped: "before", spanGaps: true, yAxisID: "y", order: 1 });
  const strip = { type: "bar", label: "Listing issue", yAxisID: "yi", order: 3, barPercentage: 1, categoryPercentage: 1, borderWidth: 0,
    data: d.map((x) => (x.issue == null ? null : [0.94, 1])),
    backgroundColor: d.map((x) => cssVar(x.issue ? "--high" : "--ok")) };
  drawChart("pf-listing", { type: "line", data: { labels: d.map((x) => ddmm(x.date)), datasets: [
    // Buy Box breaks where it is blank: a lost Buy Box shows as a gap, not as yesterday's price
    ...PF_KEEPA.filter(([k]) => d.some((x) => num(x[k]))).map(([k, label, i]) => ({ ...step(label, k, pal[i]), spanGaps: k !== "bb" })),
    { ...step("Sales Rank", "rank", pal[2]), yAxisID: "y1", borderWidth: 1.5, borderDash: [4, 3] }, strip] },
    options: { plugins: { legend: { labels: { filter: (it) => it.text !== "Listing issue" } },
      tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === "yi" ? `Listing issue: ${d[c.dataIndex].issue || "không có"}`
        : c.dataset.yAxisID === "y1" ? `Sales Rank: #${Math.round(c.raw).toLocaleString("en-US")}` : `${c.dataset.label}: ${price(c.raw)}` } } },
      scales: { y: { grace: "15%", ticks: { callback: (v) => "$" + v } },  // grace: room under the issue strip
        y1: { position: "right", reverse: true, grace: "15%", grid: { display: false }, ticks: { callback: (v) => "#" + Math.round(v).toLocaleString("en-US") } },
        yi: { display: false, min: 0, max: 1 } } } });
}
function renderPerf() {
  const d = S.pf, t = d.summary, gone = t.campaign_gone ?? t.time_gone;
  $("#pf-sub").textContent = `${ddmm(d.filters.start)} – ${ddmm(d.filters.end)}/${d.filters.end.slice(0, 4)} · thực tế theo khung thời gian, target của tháng · PIC ${pfPicLabel()}`;
  const tile = (lbl, val, sub = "") => `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val num">${val}</div>${sub ? `<div class="muted" style="font-size:12px">${sub}</div>` : ""}</div>`;
  const hp = pfHidden("pl"), hs = pfHidden("sku");
  // PL rows: PLs holding a picked SKU (filters are AND); a row keeps its whole-PL figures
  const plList = pfSort(d.pls.filter((r) => !S.pfSku.length || d.skus.some((s) => s.pl === r.pl && pfSkuOn(s.asin))), "pl");
  const skuList = pfSort(d.skus.filter((r) => pfSkuOn(r.asin)), "sku");
  S.pfTot = { pl: { rows: plList, gone, hide: hp }, sku: { rows: skuList, gone, hide: hs } };
  const pls = plList.map((r, i) => pfWideRow(r, `<td><div class="pf-name" title="${esc(r.pl)}"><b>${esc(r.pl)}</b></div></td>`, gone, pfCells([
    ["action", `<td>${r.action ? `<span class="sev ${PF_TONE[actionColor(r.action, r.sev)] || "pf-neutral"}">${esc(short(r.action))}</span>` : '<span class="muted">—</span>'}</td>`],
    ["reason", `<td class="reason"><div title="${esc(r.reason)}">${esc(r.reason || "—")}</div></td>`]], hp), hp, "pl", i)).join("");
  const skuRows = skuList.map((r, i) => pfWideRow(r,
    `<td data-no-i18n style="white-space:nowrap"><b>${esc(r.sku)}</b><div class="muted" style="font-size:11px">${esc(r.asin)}</div></td>` + pfCells([
      ["pl", `<td><div class="pf-name" title="${esc(r.pl)}">${esc(r.pl)}</div></td>`], ["product", `<td style="max-width:220px">${esc(r.product)}</td>`],
      ["ineligible", `<td>${pfInelig(r.ineligible)}</td>`],
      ["stock", `<td class="n">${pfStock(r.stock)}</td>`],
      ["incoming", `<td class="n">${pfIncoming(r.incoming)}</td>`],
      ["listing", `<td>${r.listing_issue ? `<span class="sev MED">${esc(r.listing_issue)}</span>` : '<span class="muted">—</span>'}</td>`]], hs), gone, "", hs, "sku", i)).join("");
  // Listed when the campaign has an ASIN matching every filter (PIC ∧ leader ∧ PL server-side, ∧ SKU here).
  const campList = pfSort(d.campaigns.filter((c) => (c.skus || []).some(pfCampSkuOn)), "camp");
  S.pfCampList = campList;
  const camps = pfCampRows(campList);
  const issues = (d.issue_days || []).filter((r) => pfSkuOn(r.asin));
  const lostSum = issues.reduce((a, r) => a + (r.est_gmv_lost || 0), 0);
  const issueRows = issues.map((r) => `<tr><td class="num">${ddmm(r.date)}/${r.date.slice(0, 4)}</td>
      <td data-no-i18n><b>${esc(r.sku)}</b><div class="muted" style="font-size:11px">${esc(r.asin)}</div></td><td>${esc(r.pl)}</td>
      <td><span class="sev MED">${esc(r.issue)}</span></td>
      <td class="n">${lostCell(r)}</td><td class="n">${r.count}</td></tr>`).join("");
  const plNote = d.filters.pl.length ? ` · lọc theo <b>${esc(d.filters.pl.join(", "))}</b>` : "";
  const skuNote = S.pfSku.length ? ` · SKU <b data-no-i18n>${esc(S.pfSku.join(", "))}</b>` : "";
  S.pfDrvNote = plNote + skuNote;
  $("#pf-tiles").innerHTML = `
    <div class="grid pf-tiles">
      ${tile("Time gone / Campaign gone", `${pct(t.time_gone)} / ${t.campaign_gone == null ? "—" : pct(t.campaign_gone)}`, "theo tháng của khung thời gian")}
      ${tile("GMV", money(t.gmv), `${pct(t.gmv_pct, 1)} target tháng (${money(t.gmv_target)})`)}
      ${tile("Ads Spend", money(t.spend), `${pct(t.spend_pct, 1)} target tháng (${money(t.spend_target)})`)}
      ${tile("Ads NMV", money(t.ads_nmv))}${tile("ACOS", pct(t.acos, 1))}${tile("TACOS", pct(t.tacos, 1), `target ${pct(t.tacos_target, 1)} (Ads Spend target ÷ GMV target)`)}${tile("%Ads RS / Total", pct(t.ads_rs_share, 1))}
    </div>`;
  $("#pf-body").innerHTML = layoutHtml("perf", {
    insight: pfInsight(d),
    today: pfToday(d.today, d.history_days),
    listing: d.listing ? pfListing(d.listing) : "",  // only with exactly one SKU filtered
    pl: `<div class="card" style="margin-top:12px"><div style="display:flex;align-items:center;gap:8px"><h2 style="flex:1">Product line</h2>${pfColsBtn("pl")}</div><div class="tbl pf-tbl"><table data-pftot="pl" data-fz="1">
      <thead><tr>${pfTh("Product line", "pl", "pl")}${pfMetricHeads("pl", hp)}${pfCells([["action", "<th>PL action code</th>"], ["reason", "<th>Reason</th>"]], hp)}</tr></thead>
      <tbody>${pls || '<tr><td colspan="15" class="muted">Không có dữ liệu</td></tr>'}</tbody><tfoot>${pfTotRow("pl", plList)}</tfoot></table></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">%Achieve: <span class="pf-ach ok">xanh</span> = tốt (GMV/RS ≥ ${pct(gone)} campaign gone · Ads spend ≤ campaign gone · TACOS ≤ 100%), <span class="pf-ach bad">đỏ</span> = ngược lại.<br>Các cột sau vạch kẻ là Ads pfm (Ads Spend, TACOS, ACOS, Ads NMV, Ads RS, %PPC RS/Total = Ads RS ÷ RS); phía trước là Total pfm (GMV, RS).${d.converted ? `<br>${PF_CROSS_NOTE}. ${PF_CROSS_HINT}.` : ""}</p></div>`,
    c1: `<div class="card"><h2>GMV target & actual · Ads NMV · %Ads RS${plNote}${skuNote}</h2><div class="chartbox"><canvas id="pf-c1" role="img" aria-label="GMV theo ngày"></canvas></div></div>`,
    c2: `<div class="card"><h2>Ads Spend target & actual · ACOS${plNote}${skuNote}</h2><div class="chartbox"><canvas id="pf-c2" role="img" aria-label="Ads spend theo ngày"></canvas></div></div>`,
    c3: `<div class="card"><h2>TACOS target & actual${plNote}${skuNote}</h2><div class="chartbox"><canvas id="pf-c3" role="img" aria-label="TACOS theo ngày"></canvas></div></div>`,
    drivers: pfDrivers(plNote + skuNote),
    sku: `<div class="card"><div style="display:flex;align-items:center;gap:8px"><h2 style="flex:1">SKU${plNote}${skuNote}</h2>${pfColsBtn("sku")}</div><div class="tbl pf-tbl" style="max-height:560px"><table data-pftot="sku" data-fz="${1 + !hs.has("pl") + !hs.has("product")}">
      <thead><tr>${pfTh("SKU", "sku", "sku")}${pfCells([["pl", pfTh("Product line", "pl", "sku")], ["product", pfTh("Product name", "product", "sku")], ["ineligible", "<th>Ineligible status</th>"],
        ["stock", pfTh("Current stock", "stock", "sku", "n")], ["incoming", '<th class="n" title="USA Inventory Y4A-AMZ › report, cột W–AV: đợt hàng về gần nhất">Incoming</th>'], ["listing", pfTh("Listing issue", "listing_issue", "sku")]], hs)}${pfMetricHeads("sku", hs)}</tr></thead>
      <tbody>${skuRows || '<tr><td colspan="21" class="muted">Không có SKU</td></tr>'}</tbody><tfoot>${pfTotRow("sku", skuList)}</tfoot></table></div>
      ${d.converted ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${PF_CROSS_NOTE}. ${PF_CROSS_HINT}.</p>` : ""}</div>`,
    camp: `<div class="card"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="flex:1">Campaign${plNote}${skuNote} <span class="td-n" id="pf-camp-n" data-no-i18n></span></h2>
      <span id="pf-ads-st" class="muted" style="font-size:12px">${pfAdsHead()}</span>
      <input type="search" id="pf-camp-q" placeholder="Tìm campaign / SKU / ASIN…" aria-label="Tìm" value="${esc(S.pfCampQ)}" style="max-width:260px"></div><div class="tbl" style="max-height:520px"><table>
      <thead><tr><th></th><th class="ads-col" title="Trạng thái trên Ads (ads.yes4all.com) – bấm để bật/tắt">On/Off</th>${pfTh("Campaign name", "campaign", "camp")}<th class="n ads-bud-col" title="Budget trên Ads (ads.yes4all.com) – bấm để sửa">Budget</th>${pfTh("Ads Spend", "spend", "camp", "n")}${pfTh("Ads NMV", "nmv", "camp", "n")}${pfTh("Ads Order", "orders", "camp", "n")}${pfTh("ACOS", "acos", "camp", "n")}${pfTh("Clicks", "clicks", "camp", "n")}${pfTh("CPC", "cpc", "camp", "n")}${d.converted ? pfTh("Cross-sale NMV", "cross_nmv", "camp", "n") + pfTh("Cross-sale RS", "cross_rs", "camp", "n") : ""}${pfTh("Trend Spend L7D", "trend_spend", "camp", "n")}${pfTh("Trend ACOS L7D", "trend_acos", "camp", "n")}${pfTh("Last action", "last_action", "camp")}${pfTh("Alert", "alert", "camp")}</tr></thead>
      <tbody id="pf-camp-body">${camps || `<tr><td colspan="${d.converted ? 16 : 14}" class="muted">Không có campaign</td></tr>`}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Data ads_camp đến <b class="num">${d.ads_last ? `${ddmm(d.ads_last)}/${d.ads_last.slice(0, 4)}` : "—"}</b> · Bấm dòng campaign để xem chi tiết theo SKU & ASIN.${d.converted ? `<br>${PF_CROSS_NOTE} – đến <b class="num">${d.converted_last ? `${ddmm(d.converted_last)}/${d.converted_last.slice(0, 4)}` : "—"}</b>. ${PF_CAMP_CROSS_HINT}.` : ""}</p></div>`,
    issues: `<div class="card"><h2>Listing issue theo ngày${plNote}${skuNote} <span class="td-n" data-xf-count>${issues.length}</span></h2><div class="tbl" style="max-height:420px"><table>
      <thead><tr><th>Ngày</th><th>SKU</th><th>Product line</th><th>Listing issue</th><th class="n" title="${LOST_FORMULA}">Est GMV lost</th><th class="n" title="Số ngày SKU bị issue này trong khung thời gian">Số lần</th></tr></thead>
      <tbody>${issueRows || '<tr><td colspan="6" class="muted" style="text-align:center">Không có listing issue trong khung thời gian</td></tr>'}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Tổng est GMV lost: <b class="num" data-xf-sum="4">${money(lostSum)}</b> · lịch sử listing lưu ${d.history_days || 0}/30 ngày gần nhất (mỗi lần chạy lưu 1 ngày) · ${LOST_FORMULA}.</p></div>` });
  pfCampFilter();
  if (!S.ads.tried) { S.ads.tried = true; adsLoad(false); }  // saved Ads session only – never pops a login by itself
  drawPerfCharts();
  drawPfListing();
}
// Campaign table rows (head + SKU / ASIN children when expanded). Expand / collapse redraws only these rows, so the
// page and the table keep their scroll position.
const pfCampSkuOn = (s) => s.in_scope !== false && pfSkuOn(s.asin);
const pfCrossBlank = () => (S.pf && S.pf.converted ? "<td></td><td></td>" : "");
const pfCrossCells = (x, table, id) => (S.pf && S.pf.converted ? `<td class="n"${pfXdetAttr(table, x, "cross_nmv", id)}>${money(x.cross_nmv)}</td><td class="n"${pfXdetAttr(table, x, "cross_rs", id)}>${pfFmt.int(x.cross_rs)}</td>` : "");
const PF_CROSS_HINT = "Rê chuột vào ô Cross-sale / Halo để xem theo từng SKU";
const PF_CAMP_CROSS_HINT = "Rê chuột vào ô Cross-sale để xem SKU / ASIN được mua và giá trị";  // feedback #76
const PF_CROSS_NOTE = "Cross-sale = doanh số quảng cáo của sản phẩm mang về cho sản phẩm khác (trừ chính nó) · Halo = doanh số sản phẩm nhận được từ quảng cáo của sản phẩm khác · NMV = sales, RS = units_sold (file Converted product, chỉ USD)";
// Campaign name to show: the input files' name, else the Ads tool's (feedback #67: the files may only carry the id).
const pfCampName = (c) => (c.campaign && c.campaign !== c.campaign_id ? c.campaign : (S.ads.names || {})[c.campaign_id] || c.campaign || c.campaign_id);
function pfCampRows(campList) {
  return campList.map((c) => {
    const kids = c.skus || [];  // every ASIN, so the breakdown adds up to the campaign row; off-filter ones dimmed
    const key = c.campaign, multi = (c.pls || []).length > 1;  // one row per campaign, summed over its PLs
    const open = S.pfOpenCamp.has(key);
    const name = pfCampName(c);
    const q = [name, c.campaign_id, c.pl, ...(c.skus || []).flatMap((s) => [s.sku, s.asin, s.product || ""])].join(" ").toLowerCase();
    const cst = S.ads.states ? S.ads.states[c.campaign_id] || null : undefined;
    const head = `<tr class="expandable${adsOff(cst) ? " ads-off" : ""}" data-camp="${esc(key)}" data-q="${esc(q)}" aria-expanded="${!!open}">
      <td>${kids.length ? `<svg class="i" aria-hidden="true" style="transform:rotate(${open ? 90 : 0}deg)"><use href="#chev"/></svg>` : ""}</td>
      <td class="ads-col">${cst === undefined ? "" : adsSw(cst, `camp:${c.campaign_id}`, `data-sw="camp" data-id="${esc(c.campaign_id)}"`, "campaign")}</td>
      <td class="muted" title="${esc(name)}" style="max-width:320px">${esc(name)}<div style="font-size:11px">${esc(c.pl)}</div></td>
      <td class="n ads-bud-col">${pfBudget(c)}</td>
      <td class="n">${money(c.spend)}</td><td class="n">${money(c.nmv)}</td><td class="n">${Math.round(c.orders)}</td><td class="n">${pct(c.acos, 1)}</td><td class="n">${Math.round(c.clicks || 0)}</td><td class="n">${c.cpc == null ? "—" : `$${c.cpc.toFixed(2)}`}</td>${pfCrossCells(c, "camp", pfCampXid(c))}
      <td class="n">${signed(c.trend_spend)}</td><td class="n">${signed(c.trend_acos)}</td>
      <td style="white-space:nowrap"${c.last_action_notes?.length ? ` data-anote="${esc(c.last_action_notes.join("\n"))}" data-anday="${esc(ddmm(String(c.last_action)))}"` : ""}>${c.last_action ? `${ddmm(String(c.last_action))} <span class="muted">${esc(c.last_action_type)}</span>${c.last_action_notes?.length > 1 ? ` <span class="td-n">${c.last_action_notes.length}</span>` : ""}` : '<span class="muted">—</span>'}</td>
      <td>${c.alert ? `<span class="sev HIGH" title="${esc(c.action)}">YES</span>` : '<span class="muted">No</span>'}</td></tr>`;
    const children = open ? kids.map((s) => `<tr class="child${adsOff(pfAsinState(c, s.asin)) ? " ads-off" : ""}"${pfCampSkuOn(s) ? "" : ' style="opacity:.55" title="Ngoài bộ lọc"'}><td></td>
      <td class="ads-col">${pfAsinSw(c, s.asin)}</td>
      <td data-no-i18n><b>${esc(s.sku)}</b> <span class="muted">${esc(s.asin)}${multi && s.pl ? ` · ${esc(s.pl)}` : ""}</span>${pfGroupChip(c, s.asin)}${s.product ? `<div class="muted" style="font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.product)}">${esc(s.product)}</div>` : ""}</td><td></td>
      <td class="n">${money(s.spend)}</td><td class="n">${money(s.nmv)}</td><td class="n">${Math.round(s.orders)}</td><td class="n">${pct(s.acos, 1)}</td><td class="n">${Math.round(s.clicks || 0)}</td><td class="n">${s.cpc == null ? "—" : `$${s.cpc.toFixed(2)}`}</td>${pfCrossCells(s, "camp_asin", pfCampXid(c, s))}
      <td></td><td></td><td></td><td></td></tr>${pfGroupRows(c, s.asin)}`).join("") : "";
    return head + children;
  }).join("");
}
// On/Off: campaign and ASIN-in-campaign state on the Ads tool, switched with the user's own Ads login (the Ads tool's
// permissions and Activity Log apply). States load once per session from the saved Ads session; ASINs on expand.
S.ads = S.ads || { states: null, asins: {}, groups: {}, nGroups: {}, open: new Set(), busy: new Set(), login: false, loading: false, tried: false };
function pfAdsHead() {
  if (S.ads.loading) return '<span class="spin"></span> Đang tải On/Off từ Ads…';
  if (S.ads.states) return 'On/Off từ Ads · <a href="#" id="pf-ads-login">Tải lại</a>';
  if (S.ads.other) return `Ads đang đăng nhập bằng <span data-no-i18n>${esc(S.ads.other)}</span> · <a href="#" id="pf-ads-login">Đăng nhập bằng tài khoản của bạn</a>`;
  return '<a href="#" id="pf-ads-login">Đăng nhập Ads để bật/tắt</a>';
}
function pfCampRedraw() {
  const body = $("#pf-camp-body"), st = $("#pf-ads-st");
  if (st) st.innerHTML = pfAdsHead();
  if (body && S.pfCampList) { body.innerHTML = pfCampRows(S.pfCampList); pfCampFilter(); }
}
async function adsLoad(login) {
  if (S.ads.loading) return;
  S.ads.loading = true; pfCampRedraw();
  const r = await api.ads_campaign_states(login).finally(() => { S.ads.loading = false; });
  if (r.login) { S.ads.login = true; S.ads.other = r.other || null; }
  else if (!bad(r)) { S.ads.other = null; S.ads.states = r.states; S.ads.budgets = r.budgets || {}; S.ads.names = r.names || {}; S.ads.asins = {}; S.ads.groups = {}; S.ads.nGroups = {}; S.ads.login = false; actStatus(r.email); }
  pfCampRedraw();
  for (const c of S.pfCampList || []) if (S.ads.states && S.pfOpenCamp.has(c.campaign)) adsAsins(c.campaign_id);
}
async function adsAsins(id) {
  S.ads.asins[id] = "loading"; pfCampRedraw();
  const r = await api.ads_asin_states(id);
  S.ads.asins[id] = bad(r) ? null : r.asins;
  S.ads.nGroups[id] = r.groups || {};
  for (const k of Object.keys(S.ads.groups)) if (k.startsWith(id + ":")) delete S.ads.groups[k];  // stale after a re-read
  pfCampRedraw();
  for (const k of S.ads.open) if (k.startsWith(id + ":")) adsGroups(id, k.slice(id.length + 1));
}
// "n nhóm" under an ASIN's switch: the ad groups of the campaign holding it, each with its own switch.
// Stats per ad group come from the Ads tool for the page's timeframe (refetched when it changes).
const pfRange = () => (S.pf ? [S.pf.filters.start, S.pf.filters.end] : [null, null]);
async function adsGroups(id, asin) {
  const k = `${id}:${asin}`, [start, end] = pfRange();
  S.ads.groups[k] = "loading"; pfCampRedraw();
  const r = await api.ads_asin_groups(id, asin, start, end);
  S.ads.groups[k] = bad(r) ? null : { rows: r.groups, start: r.start, end: r.end };
  pfCampRedraw();
}
function pfGroupRows(c, asin) {
  const k = `${c.campaign_id}:${asin}`, g = S.ads.groups[k], [start, end] = pfRange();
  if (!S.ads.open.has(k) || g === undefined) return "";
  if (g && g.rows && (g.start !== start || g.end !== end)) { setTimeout(() => adsGroups(c.campaign_id, asin)); return ""; }  // timeframe changed
  if (g === "loading") return `<tr class="child ads-grp"><td></td><td class="ads-col"></td><td colspan="${S.pf && S.pf.converted ? 14 : 12}" class="muted"><span class="ads-tree">└</span><span class="spin"></span> Đang tải ad group…</td></tr>`;
  if (!g) return "";
  const cell = (v, f) => (v == null ? '<span class="muted">—</span>' : f(v));
  const last = g.rows.length - 1;
  return g.rows.map((x, i) => {
    const waste = x.spend > 0 && !x.orders;  // spent, no order in the timeframe: the first candidate to switch off
    return `<tr class="child ads-grp${adsOff(x.state) ? " ads-off" : ""}"><td></td>
    <td class="ads-col">${adsSw(x.state, `ad:${x.ad_id}`, `data-sw="ad" data-id="${esc(c.campaign_id)}" data-asin="${esc(asin)}" data-ad="${esc(x.ad_id)}" data-group="${esc(x.group)}"`, "ad group")}</td>
    <td data-no-i18n><span class="ads-tree" aria-hidden="true">${i === last ? "└" : "├"}</span>${x.url ? `<a href="#" class="ads-open" data-url="${esc(x.url)}" title="Mở ad group này trên ads.yes4all.com">${esc(x.group)}<svg class="i" aria-hidden="true"><use href="#ext"/></svg></a>` : esc(x.group)}${x.impressions != null ? `<span class="muted ads-impr" title="Impressions">${Math.round(x.impressions).toLocaleString("en-US")} impr</span>` : ""}</td><td></td>
    <td class="n"${waste ? ' style="color:var(--high);font-weight:600" title="Có spend nhưng chưa có đơn trong khung thời gian"' : ""}>${cell(x.spend, money)}</td><td class="n">${cell(x.nmv, money)}</td><td class="n">${cell(x.orders, Math.round)}</td>
    <td class="n">${x.spend == null ? '<span class="muted">—</span>' : pct(x.nmv ? x.spend / x.nmv : null, 1)}</td>
    <td class="n">${cell(x.clicks, Math.round)}</td><td class="n">${x.clicks ? `$${(x.spend / x.clicks).toFixed(2)}` : '<span class="muted">—</span>'}</td>${pfCrossBlank()}
    <td></td><td></td><td></td><td></td></tr>`; }).join("")
    + `<tr class="child ads-grp ads-note"><td></td><td class="ads-col"></td><td colspan="${S.pf && S.pf.converted ? 14 : 12}" class="muted">Số liệu ad group từ Ads tool, ${ddmm(g.start)} – ${ddmm(g.end)} · có thể lệch nhẹ so với ads_camp</td></tr>`;
}
const pfAsinState = (c, asin) => { const m = S.ads.asins[c.campaign_id]; return m && typeof m === "object" ? m[asin] || null : undefined; };
const adsOff = (st) => st === "PAUSED" || st === "ARCHIVED";
function pfAsinSw(c, asin) {
  const m = S.ads.asins[c.campaign_id];
  if (!S.ads.states || m === undefined) return "";
  if (m === "loading") return '<span class="ads-sw ads-skel" title="Đang tải trạng thái ASIN từ Ads" aria-busy="true"></span>';
  if (m === null) return '<span class="muted" title="Không tải được trạng thái từ Ads">?</span>';
  return adsSw(m[asin] || null, `asin:${c.campaign_id}:${asin}`, `data-sw="asin" data-id="${esc(c.campaign_id)}" data-asin="${esc(asin)}"`, "ASIN");
}
// "n ad group ▾" next to the SKU: lists the campaign's ad groups holding the ASIN, each with its stats and switch.
function pfGroupChip(c, asin) {
  const n = (S.ads.nGroups[c.campaign_id] || {})[asin] || 0, k = `${c.campaign_id}:${asin}`, open = S.ads.open.has(k);
  return n ? `<button type="button" class="ads-chip${open ? " open" : ""}" data-grp="${esc(asin)}" data-id="${esc(c.campaign_id)}" aria-expanded="${open}"
    title="Các ad group trong campaign có ASIN này – xem số liệu và bật/tắt từng nhóm">${n} ad group <span aria-hidden="true">${open ? "▴" : "▾"}</span></button>` : "";
}
// Budget: the campaign's budget on Ads; click → inline editor (Enter / Lưu, Esc / Huỷ), like the website's.
function pfBudget(c) {
  const b = (S.ads.budgets || {})[c.campaign_id];
  if (!S.ads.states || !b || b.budget == null) return "";
  const key = `bud:${c.campaign_id}`;
  if (S.ads.busy.has(key)) return '<span class="ads-sw ads-skel" aria-busy="true" title="Đang gửi lên Ads…"></span>';
  if (S.ads.editBudget === c.campaign_id) {
    return `<span class="ads-bud-edit" data-bud-form="${esc(c.campaign_id)}"><span class="ads-bud-in"><span class="muted">$</span><input type="number" min="1" step="0.01"
      value="${b.budget}" aria-label="Budget mới" data-bud-input="${esc(c.campaign_id)}"></span>
      <button type="button" class="btn sm ghost" data-bud-cancel>Huỷ</button><button type="button" class="btn sm primary" data-bud-save="${esc(c.campaign_id)}">Lưu</button></span>`;
  }
  const sug = b.suggested && Math.abs(b.suggested - b.budget) >= 0.01 ? `<div class="muted ads-bud-sub">Gợi ý ${money(b.suggested)}</div>` : "";
  const amt = `$${Number(b.budget).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return b.editable
    ? `<button type="button" class="ads-bud" data-bud="${esc(c.campaign_id)}" title="Bấm để sửa budget trên Ads">${amt}<svg class="i" aria-hidden="true"><use href="#pen"/></svg></button><div class="muted ads-bud-sub">${esc(b.type || "")}</div>${sug}`
    : `<span title="Ads không cho sửa budget campaign này">${amt}</span><div class="muted ads-bud-sub">${esc(b.type || "")}</div>${sug}`;
}
async function adsSaveBudget(id) {
  const inp = document.querySelector(`[data-bud-input="${CSS.escape(id)}"]`), b = (S.ads.budgets || {})[id];
  const v = inp ? Math.round(Number(inp.value) * 100) / 100 : NaN;
  if (!b || !(v >= 1)) { toast(I18N.t("Budget phải ≥ $1"), true); return; }
  if (Math.abs(v - b.budget) < 0.005) { S.ads.editBudget = null; pfCampRedraw(); return; }
  const camp = (S.pfCampList || []).find((x) => x.campaign_id === id), name = camp ? pfCampName(camp) : id;
  const big = b.budget > 0 && (v >= b.budget * 2 || v <= b.budget / 2);  // a typo guard: only big jumps ask again
  if (big && !confirm(`${I18N.t("Đổi budget")} ${money(b.budget)} → ${money(v)} (${v > b.budget ? "+" : ""}${Math.round((v / b.budget - 1) * 100)}%)\n${name}\n\n${I18N.t("trên Ads (ads.yes4all.com)?")}`)) return;
  const key = `bud:${id}`;
  S.ads.editBudget = null; S.ads.busy.add(key); pfCampRedraw();
  const r = await api.ads_set_budget(id, v).finally(() => S.ads.busy.delete(key));
  if (!bad(r)) {
    S.ads.budgets[id] = r;
    const ok = Math.abs((r.budget || 0) - v) < 0.005;
    toast(ok ? `${I18N.t("Đã đổi budget")} ${name}: ${money(r.budget)}` : I18N.t("Ads chưa nhận thay đổi – kiểm tra lại trên ads.yes4all.com"), !ok);
  }
  pfCampRedraw();
}
// state: ENABLED / PAUSED / MIXED (ASIN on in some ad groups) / ARCHIVED / null (not on Ads, e.g. SB ads have no ASIN)
function adsSw(state, key, attrs, what = "") {
  if (S.ads.busy.has(key)) return '<span class="ads-sw ads-skel" aria-busy="true" title="Đang gửi lên Ads…"></span>';
  if (!state || state === "ARCHIVED") return `<span class="muted ads-none" title="${state ? "Đã archive trên Ads" : "Không có trên Ads"}">—</span>`;
  const on = state === "ENABLED", mixed = state === "MIXED";
  const tip = on ? "Đang bật – bấm để tắt trên Ads" : mixed ? "Bật ở một số ad group – bấm để bật tất cả" : "Đang tắt – bấm để bật trên Ads";
  return `<button type="button" class="ads-sw${on ? " on" : ""}${mixed ? " mixed" : ""}" role="switch" aria-checked="${on ? "true" : mixed ? "mixed" : "false"}"
    aria-label="${esc(`${what} ${on ? "On" : mixed ? "Một phần" : "Off"}`.trim())}" ${attrs} data-on="${on ? 1 : 0}" title="${tip}"><span class="knob"></span></button>`;
}
async function adsToggle(d) {
  const camp = (S.pfCampList || []).find((x) => x.campaign_id === d.id), turnOn = d.on !== "1";
  const name = camp ? pfCampName(camp) : d.id, n = (S.ads.nGroups[d.id] || {})[d.asin] || 0;
  const what = d.sw === "ad" ? `ASIN ${d.asin} ${I18N.t("trong ad group")} ${d.group}`
    : d.sw === "asin" ? `ASIN ${d.asin} ${I18N.t("ở tất cả")} ${n} ad group ${I18N.t("trong campaign")}` : "campaign";
  if (!confirm(`${I18N.t(turnOn ? "Bật" : "Tắt")} ${what}\n${name}\n\n${I18N.t("trên Ads (ads.yes4all.com)?")}`)) return;
  const key = d.sw === "ad" ? `ad:${d.ad}` : d.sw === "asin" ? `asin:${d.id}:${d.asin}` : `camp:${d.id}`;
  S.ads.busy.add(key); pfCampRedraw();
  const r = await (d.sw === "ad" ? api.ads_set_ad(d.id, d.ad, turnOn) : d.sw === "asin" ? api.ads_set_asin(d.id, d.asin, turnOn)
    : api.ads_set_campaign(d.id, turnOn)).finally(() => S.ads.busy.delete(key));
  if (!bad(r)) {
    const gk = `${d.id}:${d.asin}`;
    if (d.sw === "ad") {
      if (S.ads.asins[d.id]) S.ads.asins[d.id][d.asin] = r.asin_state;
      const g = S.ads.groups[gk] && S.ads.groups[gk].rows && S.ads.groups[gk].rows.find((x) => x.ad_id === d.ad);
      if (g) g.state = r.state;
    } else if (d.sw === "asin") {
      if (S.ads.asins[d.id]) S.ads.asins[d.id][d.asin] = r.state;
      const rows = S.ads.groups[gk] && S.ads.groups[gk].rows;  // keep the stats, take the new states
      if (rows) for (const x of r.groups) { const g = rows.find((y) => y.ad_id === x.ad_id); if (g) g.state = x.state; }
    } else S.ads.states[d.id] = r.state;
    const ok = r.state === (turnOn ? "ENABLED" : "PAUSED");
    toast(ok ? `${I18N.t(turnOn ? "Đã bật" : "Đã tắt")} ${d.sw === "camp" ? name : d.asin}${d.sw === "ad" ? ` · ${d.group}` : ""}`
      : I18N.t("Ads chưa nhận thay đổi – kiểm tra lại trên ads.yes4all.com"), !ok);
  }
  pfCampRedraw();
}
// Campaign search: hides campaign rows (and their SKU rows) whose name / PL / SKU / ASIN don't contain the query.
// DOM-only so typing keeps focus; the query survives re-renders (sorting, expanding) via S.pfCampQ.
function pfCampFilter() {
  const body = $("#pf-camp-body"), q = (S.pfCampQ || "").trim().toLowerCase();
  if (!body) return;
  let show = true, n = 0, all = 0;
  for (const tr of body.rows) {
    if (tr.classList.contains("expandable")) { all++; show = !q || tr.dataset.q.includes(q); n += show; }
    tr.style.display = show ? "" : "none";
  }
  const cnt = $("#pf-camp-n");
  if (cnt) cnt.textContent = q ? `${n}/${all}` : "";
}
document.addEventListener("keydown", (e) => {
  const id = e.target.dataset && e.target.dataset.budInput;
  if (!id) return;
  if (e.key === "Enter") { e.preventDefault(); adsSaveBudget(id); }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); S.ads.editBudget = null; pfCampRedraw(); }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "pf-camp-q") return;
  S.pfCampQ = e.target.value;
  pfCampFilter();
});
function drawPerfCharts() {
  const d = S.pf.daily, pal = SERIES[isDark() ? "dark" : "light"], grey = cssVar("--muted");
  const labels = d.map((x) => ddmm(x.date));
  const money0 = (v) => "$" + rhu(v).toLocaleString("en-US");
  const bar = (label, key, color) => ({ type: "bar", label, data: d.map((x) => x[key]), backgroundColor: color, borderRadius: 3, yAxisID: "y", order: 2 });
  const line = (label, key, color, axis, dash) => ({ type: "line", label, data: d.map((x) => x[key]), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 2, borderDash: dash || [], yAxisID: axis, order: 1, spanGaps: true });
  const pctAxis = { position: "right", grid: { display: false }, ticks: { callback: (v) => pct(v) }, beginAtZero: true };
  const tip = (fmts) => ({ callbacks: { label: (c) => `${c.dataset.label}: ${fmts[c.dataset.yAxisID](c.raw)}` } });
  const onClick = (e, els) => { if (els.length) { S.pfDrvDay = d[els[0].index].date; pfDrvRedraw(); } };  // → change drivers card
  drawChart("pf-c1", { type: "bar", data: { labels, datasets: [bar(I18N.t("GMV target"), "gmv_target", grey), bar("GMV actual", "gmv", pal[0]), bar("Ads NMV", "ads_nmv", pal[2]), line("%Ads RS / Total RS", "ads_rs_share", pal[1], "y1")] },
    options: { onClick, plugins: { tooltip: tip({ y: money, y1: (v) => pct(v, 1) }) }, scales: { y: { beginAtZero: true, ticks: { callback: money0 } }, y1: pctAxis } } });
  drawChart("pf-c2", { type: "bar", data: { labels, datasets: [bar(I18N.t("Ads Spend target"), "spend_target", grey), bar("Ads Spend actual", "spend", pal[1]), line("ACOS", "acos", pal[4], "y1")] },
    options: { onClick, plugins: { tooltip: tip({ y: money, y1: (v) => pct(v, 1) }) }, scales: { y: { beginAtZero: true, ticks: { callback: money0 } }, y1: pctAxis } } });
  drawChart("pf-c3", { type: "line", data: { labels, datasets: [line("TACOS target", "tacos_target", grey, "y", [5, 4]), line("TACOS actual", "tacos", pal[0], "y")] },
    options: { onClick, plugins: { tooltip: tip({ y: (v) => pct(v, 1) }) }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => pct(v) } } } } });
}
document.addEventListener("change", (e) => {
  if (e.target.id === "pf-drv-day") { S.pfDrvDay = e.target.value; pfDrvRedraw(); }
  if (e.target.id === "pf-drv-p") { S.pfDrvP = e.target.value; pfDrvRedraw(); }
});
for (const id of ["#pf-start", "#pf-end"]) {
  document.addEventListener("change", (e) => { if (e.target.matches(id)) { S.pfSku = []; loadPerf(true); } });
}
// PIC / Sales Leader / Product line / SKU: tick several (or Tất cả = none ticked → all); applied with the button, not per tick.
// Each filter narrows the ones after it, so applying one clears those. SKU: tables narrow client-side; the refetch
// recomputes the daily chart series for the picked SKUs.
const PF_MSEL = { pic: ["pfPic", "PIC"], leader: ["pfLeader", "Sales Leader"], pl: ["pfPl", "Product line"], sku: ["pfSku", "SKU"] };
const pfSkuOn = (asin) => !S.pfSku.length || S.pfSku.includes(asin);
// The same filter bar serves Performance Review (prefix "pf") and Hourly ("hr"): state S.<pre>Pic / Leader / Pl / Sku.
const mselKey = (pre, k) => pre + k[0].toUpperCase() + k.slice(1);
const MSEL_LOAD = { pf: () => loadPerf(true), hr: () => loadHourly(true) };
const pfMselLabel = (k, opts, pre = "pf") => {
  const v = S[mselKey(pre, k)];
  return !v.length ? "Tất cả" : v.length === 1 ? (opts.find(([x]) => x === v[0]) || [, v[0]])[1] : `${v.length} ${PF_MSEL[k][1]}`;
};
const pfPicLabel = () => pfMselLabel("pic", S.pfPic.map((p) => [p, p]));
function pfMselRender(k, opts, pre = "pf") {  // opts: [[value, label]]
  const el = $(`#${pre}-${k}`), cur = S[mselKey(pre, k)], off = k === "pic" && !!(S.role && S.role.role === "member");
  el.classList.toggle("off", off); el.open = false;
  const box = (v, label, on, cls = "") => `<label class="${cls}"><input type="checkbox" value="${esc(v)}" ${on ? "checked" : ""}> ${esc(label)}</label>`;
  el.innerHTML = `<summary title="${esc(cur.join(", ") || "Tất cả")}">${esc(pfMselLabel(k, opts, pre))}</summary>${off ? "" : `<div class="msel-pop">
    <input class="xf-search" placeholder="Tìm…" aria-label="Tìm">${box("", "Tất cả", !cur.length, "all")}<div data-no-i18n>${opts.map(([v, l]) => box(v, l, cur.includes(v))).join("")}</div>
    <button type="button" class="btn sm primary" data-msel-apply>Áp dụng</button></div>`}`;
}
document.addEventListener("change", (e) => {
  const el = e.target.closest("#pf-filters details.msel, #hr-filters details.msel");
  if (!el || e.target.type !== "checkbox") return;
  const boxes = [...el.querySelectorAll("input[type=checkbox]")], all = boxes[0];
  if (e.target === all) boxes.slice(1).forEach((b) => (b.checked = false));  // Tất cả clears the individual picks
  else all.checked = !boxes.slice(1).some((b) => b.checked);
});
document.addEventListener("click", (e) => {
  const apply = e.target.closest("[data-msel-apply]");
  if (apply) {
    const el = apply.closest("details"), keys = Object.keys(PF_MSEL), [pre, k] = el.id.split("-");
    S[mselKey(pre, k)] = [...el.querySelectorAll("input:checked")].map((b) => b.value).filter(Boolean);
    for (const later of keys.slice(keys.indexOf(k) + 1)) S[mselKey(pre, later)] = [];
    el.open = false; MSEL_LOAD[pre]();
  }
  for (const d of document.querySelectorAll("#pf-filters details.msel[open], #hr-filters details.msel[open]")) if (!d.contains(e.target)) d.open = false;  // click outside closes
});

// Searchable single-select: shows a <select> as a .msel picker with a "Tìm…" box. The hidden <select> stays
// the source of truth – code keeps filling it via innerHTML, reading .value and listening for "change".
function sselEnhance(sel) {
  const d = document.createElement("details");
  d.className = "msel ssel";
  d.innerHTML = '<summary data-no-i18n></summary><div class="msel-pop"><input class="xf-search" placeholder="Tìm…" aria-label="Tìm"><div class="ssel-list" data-no-i18n></div></div>';
  sel.hidden = true; sel.after(d);
  const sum = d.querySelector("summary"), list = d.querySelector(".ssel-list"), q = d.querySelector(".xf-search");
  const sync = () => { const o = sel.selectedOptions[0]; sum.textContent = sum.title = o ? o.textContent : ""; };
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true });  // refills + language switch
  sel.addEventListener("change", sync);
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    sync();
    list.innerHTML = [...sel.options].map((o, i) => `<button type="button" data-i="${i}" class="${o.selected ? "on" : ""}">${esc(o.textContent)}</button>`).join("");
    q.value = ""; q.focus();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]"); if (!b) return;
    sel.selectedIndex = +b.dataset.i; d.open = false; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  q.addEventListener("keydown", (e) => {  // Enter picks the first match
    if (e.key === "Enter") { e.preventDefault(); const b = [...list.children].find((x) => x.style.display !== "none"); if (b) b.click(); }
  });
}
sselEnhance($("#pic"));
document.addEventListener("input", (e) => {  // "Tìm…" box inside any .msel popup hides non-matching entries
  if (!e.target.matches(".msel-pop .xf-search")) return;
  const q = e.target.value.toLowerCase();
  for (const x of e.target.parentNode.querySelectorAll("label:not(.all), .ssel-list button")) x.style.display = x.textContent.toLowerCase().includes(q) ? "" : "none";
});
document.addEventListener("click", (e) => { for (const d of document.querySelectorAll("details.ssel[open]")) if (!d.contains(e.target)) d.open = false; });
$("#pf-body").addEventListener("click", (e) => {  // sort is handled by the Excel-style column menu (▾)
  const tab = e.target.closest("[data-td]");
  if (tab) { S.pfTodayTab = tab.dataset.td; renderPerf(); return; }
  const drv = e.target.closest("[data-drvm]");
  if (drv) { S.pfDrvM = drv.dataset.drvm; pfDrvRedraw(); return; }
  const dpl = e.target.closest("tr[data-drvpl]");
  if (dpl) { const k = dpl.dataset.drvpl; S.pfDrvOpen.has(k) ? S.pfDrvOpen.delete(k) : S.pfDrvOpen.add(k); pfDrvRedraw(); return; }
  const cols = e.target.closest("[data-pfcols]");
  if (cols) { pfColChooser(cols); return; }
  if (e.target.closest("#pf-ads-login")) { e.preventDefault(); adsLoad(true); return; }
  const sw = e.target.closest("[data-sw]");
  if (sw) { adsToggle(sw.dataset); return; }  // the switch sits in the row: don't also expand it
  if (e.target.closest("[data-bud-form]") && !e.target.closest("[data-bud-cancel],[data-bud-save]")) return;  // typing in the editor
  const bud = e.target.closest("[data-bud]");
  if (bud) {
    S.ads.editBudget = bud.dataset.bud; pfCampRedraw();
    const inp = document.querySelector(`[data-bud-input="${CSS.escape(bud.dataset.bud)}"]`);
    if (inp) { inp.focus(); inp.select(); }
    return;
  }
  if (e.target.closest("[data-bud-cancel]")) { S.ads.editBudget = null; pfCampRedraw(); return; }
  const save = e.target.closest("[data-bud-save]");
  if (save) { adsSaveBudget(save.dataset.budSave); return; }
  const link = e.target.closest("a.ads-open[data-url]");
  if (link) { e.preventDefault(); api.ads_open(link.dataset.url).then(bad); return; }
  const grp = e.target.closest("[data-grp]");
  if (grp) {
    e.preventDefault();
    const k = `${grp.dataset.id}:${grp.dataset.grp}`;
    if (S.ads.open.has(k)) S.ads.open.delete(k);
    else { S.ads.open.add(k); if (S.ads.groups[k] === undefined) { adsGroups(grp.dataset.id, grp.dataset.grp); return; } }
    pfCampRedraw();
    return;
  }
  const row = e.target.closest("tr.expandable[data-camp]");
  if (row) {
    const c = row.dataset.camp, body = $("#pf-camp-body");
    S.pfOpenCamp.has(c) ? S.pfOpenCamp.delete(c) : S.pfOpenCamp.add(c);
    if (body && S.pfCampList) { body.innerHTML = pfCampRows(S.pfCampList); pfCampFilter(); } else renderPerf();
    const camp = S.pfOpenCamp.has(c) && (S.pfCampList || []).find((x) => x.campaign === c);
    if (camp && S.ads.states && S.ads.asins[camp.campaign_id] === undefined) adsAsins(camp.campaign_id);
  }
});

// feedback #53: hovering Last action shows every action of that day, like an Excel cell note (fixed, so the
// scrolling table does not clip it).
// feedback #61: the same panel on a Cross-sale / Halo cell of the Product line / SKU tables (pfXdetHtml).
$("#pf-body").addEventListener("mouseover", (e) => {
  const td = e.target.closest("[data-anote], [data-xdet]");
  let tip = $("#anote");
  if (!td) { tip?.classList.add("hidden"); return; }
  if (!tip) { tip = document.createElement("div"); tip.id = "anote"; tip.className = "popover anote"; document.body.append(tip); }
  tip.innerHTML = td.dataset.xdet ? pfXdetHtml(td)
    : `<b>Action ngày</b> <b>${esc(td.dataset.anday)}</b><ul data-no-i18n>${td.dataset.anote.split("\n").map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  tip.classList.remove("hidden");
  const r = td.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
  tip.style.top = (r.bottom + 4 + tip.offsetHeight > innerHeight ? Math.max(8, r.top - tip.offsetHeight - 4) : r.bottom + 4) + "px";
});
$("#pf-body").addEventListener("mouseleave", () => $("#anote")?.classList.add("hidden"));

// ---------------------------------------------------------------- Excel-style column filter + sort (every table)
// Pure DOM enhancer: adds a ▾ menu to each header (Sort A→Z / Z→A + checkbox value filter with search).
// State is kept per table key and re-applied after the app re-renders. Works on any .tbl table.
const XF = {};  // key -> { sort:{col,dir}|null, filt:{[col]:string[]} } – filt lists the UNCHECKED values, so values new since the filter was set (PIC/PL/date change) stay visible
const xfNum = (v) => { const n = Number(String(v).replace(/[$,%\s]/g, "").replace("−", "-")); return v !== "" && v !== "—" && !Number.isNaN(n) ? n : null; };
const xfCmp = (a, b) => { const na = xfNum(a), nb = xfNum(b); return na !== null && nb !== null ? na - nb : String(a).localeCompare(String(b), undefined, { numeric: true }); };
const xfText = (row, col) => { const c = row.cells[col]; return c ? (c.innerText || "").trim().split("\n")[0].trim() : ""; };
function xfKey(t) {
  const sec = t.closest("section[id]"), heads = [...t.tHead.rows[0].cells].map((c) => c.textContent.trim());
  return `${sec ? sec.id : "x"}|${[...(sec || document).querySelectorAll("table")].indexOf(t)}|${heads.join(",")}`;
}
function xfGroups(tb) {  // each top-level row carries its trailing .child rows as one group
  const out = [];
  for (const r of tb.rows) (r.classList.contains("child") && out.length ? out[out.length - 1] : out[out.push([]) - 1]).push(r);
  return out;
}
function xfApply(t) {
  const st = XF[t.dataset.xfkey] || {}, tb = t.tBodies[0];
  if (!tb) return;
  const groups = xfGroups(tb), filt = Object.entries(st.filt || {});
  for (const g of groups) { const show = filt.every(([c, ex]) => !ex.includes(xfText(g[0], +c))); for (const r of g) r.style.display = show ? "" : "none"; }
  const vis = groups.filter((g) => g[0].style.display !== "none"), card = t.closest(".card");
  if (card) {  // badges [data-xf-count] show visible/total, [data-xf-sum="<col>"] re-sums that column over visible rows
    for (const el of card.querySelectorAll("[data-xf-count]")) { el.dataset.xfCount ||= el.textContent; el.textContent = filt.length ? `${vis.length}/${el.dataset.xfCount}` : el.dataset.xfCount; }
    for (const el of card.querySelectorAll("[data-xf-sum]")) { el.dataset.xfAll ??= el.textContent; el.textContent = filt.length ? money(vis.reduce((a, g) => a + (xfNum(xfText(g[0], +el.dataset.xfSum)) || 0), 0)) : el.dataset.xfAll; }
  }
  if (t.dataset.pftot && t.tFoot && S.pfTot) pfTotRedraw(t, vis);  // feedback #56: the frozen Tổng row follows the column filters
  if (t.dataset.hrtot) hrTotRedraw(t);  // feedback #77: same for the Hourly tables
  fzApply(t);  // a redrawn Tổng row gets its frozen cells back
  if (st.sort) {
    vis.sort((a, b) => st.sort.dir * xfCmp(xfText(a[0], st.sort.col), xfText(b[0], st.sort.col)));
    for (const g of vis) for (const r of g) tb.appendChild(r);
  }
  for (const th of t.tHead.rows[0].cells) {
    const b = th.querySelector(".xf-btn"); if (!b) continue;
    b.classList.toggle("on", !!(st.filt && st.filt[th.cellIndex]));
    b.querySelector(".xf-ar").textContent = st.sort && st.sort.col === th.cellIndex ? (st.sort.dir < 0 ? "↓" : "↑") : "";
  }
}
function xfEnhance(t) {
  if (!t.tHead || !t.tHead.rows.length) return;
  t.dataset.xf = "1"; t.dataset.xfkey = xfKey(t);
  for (const th of t.tHead.rows[0].cells) {
    if (!th.textContent.trim() || th.querySelector(".xf-btn")) continue;
    const b = document.createElement("button");
    b.className = "xf-btn"; b.type = "button"; b.setAttribute("aria-label", "Lọc / sắp xếp"); b.setAttribute("data-no-i18n", "");
    b.innerHTML = '<span class="xf-ar"></span>▾';
    b.addEventListener("click", (e) => { e.stopPropagation(); xfMenu(t, th.cellIndex, b); });
    th.appendChild(b);
  }
  xfApply(t);
  const at = t.closest(".tbl") || t;  // "Tải bảng" button above every enhanced table
  tszEnhance(t, at);
  fzWatch(t);
  if (!(at.previousElementSibling && at.previousElementSibling.classList.contains("tbl-dl"))) {
    const d = document.createElement("div");
    d.className = "tbl-dl";
    d.innerHTML = '<button type="button" class="btn sm ghost" title="Tải các dòng đang hiện (theo bộ lọc cột) ra Excel"><svg class="i" aria-hidden="true"><use href="#download"/></svg>Tải bảng</button>';
    d.firstChild.addEventListener("click", () => tblDownload(d.nextElementSibling));
    at.before(d);
  }
}
function tblTitle(el) {  // nearest heading above the table (card h2, section h1, …)
  for (; el && el !== document.body; el = el.parentElement)
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      const h = s.matches("h1,h2,h3") ? s : s.querySelector("h1,h2,h3");
      if (h) return h.textContent.replace(/\s+/g, " ").trim();
    }
  return "Bảng";
}
async function tblDownload(at) {  // the rows the table shows now (column filters / sort applied), without the ▾ text
  const t = at.matches("table") ? at : at.querySelector("table");
  if (!t || !t.tHead) return;
  const txt = (c) => (c.innerText || "").replace(/\s+/g, " ").trim();
  const heads = [...t.tHead.rows[0].cells].map((c) => c.textContent.replace(/[↑↓]?▾$/, "").replace(/\s+/g, " ").trim());
  const keep = heads.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);  // drop blank-header columns (▸ / action buttons)
  const rows = [...(t.tBodies[0] || { rows: [] }).rows, ...(t.tFoot ? t.tFoot.rows : [])].filter((r) => r.getClientRects().length)
    .map((r) => (r.cells.length === heads.length ? keep.map((i) => txt(r.cells[i])) : [...r.cells].map(txt)));
  const r = await api.save_table(tblTitle(at), keep.map((i) => heads[i]), rows);
  if (!bad(r) && r.path) toast("Đã xuất: " + r.path);
}
// ---- resizable tables (feedback #45): drag a table box's bottom-right corner to resize it, a column's right edge to
// resize that column; double-click either to reset. Remembered per table (same key as the column filter) on this machine.
const TSZ = (() => { try { return JSON.parse(store("tblSize") || "{}"); } catch { return {}; } })();
const tszSave = () => store("tblSize", JSON.stringify(TSZ));
const tszSum = (ws, n) => ws.slice(0, n).reduce((a, b) => a + b, 0);
function tszCols(t, ws) {  // ws = px width per header column (fixed layout), or null = automatic widths again
  const heads = [...t.tHead.rows[0].cells];
  heads.forEach((th, i) => {
    th.dataset.css0 ??= th.style.cssText;
    th.style.cssText = th.dataset.css0;
    if (ws) Object.assign(th.style, { width: `${ws[i]}px`, minWidth: `${ws[i]}px`, maxWidth: `${ws[i]}px` });
  });
  t.style.tableLayout = ws ? "fixed" : ""; t.style.width = ws ? `${tszSum(ws, ws.length)}px` : "";
  t.classList.toggle("tsz", !!ws);
  for (const r of t.rows) {  // frozen (sticky) columns: their left offsets follow the new widths
    let col = 0;
    for (const c of r.cells) {
      if (c.classList.contains("fz")) { c.dataset.l0 ??= c.style.left; c.style.left = ws ? `${tszSum(ws, col)}px` : c.dataset.l0; }
      col += c.colSpan;
    }
  }
  fzApply(t);  // table[data-fz]: offsets measured from the widths just set
}
// ---- frozen lead columns (feedback #70, #71): <table data-fz="n"> keeps its first n columns in place while it scrolls
// sideways. The left offsets follow the real column widths (fonts, zoom, resized columns) through a ResizeObserver.
function fzApply(t) {
  const n = +t.dataset.fz || 0, heads = t.tHead && t.tHead.rows.length ? [...t.tHead.rows[0].cells] : [];
  if (!n || !heads.length) return;
  const k = t.getBoundingClientRect().width / (t.offsetWidth || 1) || 1;  // rect px → css px whatever the zoom
  const lefts = [0];
  heads.slice(0, n).forEach((c, i) => lefts.push(lefts[i] + c.getBoundingClientRect().width / k));
  for (const r of t.rows) {
    let col = 0;
    for (const c of r.cells) {
      const on = col + c.colSpan <= n;  // a placeholder cell spanning the whole row stays put
      c.classList.toggle("fz", on); c.classList.toggle("fz-end", on && col + c.colSpan === n);
      c.style.left = on ? `${lefts[col]}px` : "";
      col += c.colSpan;
      if (col >= n) break;
    }
  }
}
function fzWatch(t) {
  if (!+t.dataset.fz || !window.ResizeObserver) { fzApply(t); return; }
  const ro = new ResizeObserver(() => (t.isConnected ? fzApply(t) : ro.disconnect()));
  ro.observe(t);
  [...t.tHead.rows[0].cells].slice(0, +t.dataset.fz).forEach((c) => ro.observe(c));
}
function tszBox(at, box) {  // box = {w, h} css px, or null = the page's own size
  at.dataset.mh0 ??= at.style.maxHeight;
  at.style.width = box && box.w ? `${box.w}px` : ""; at.style.height = box && box.h ? `${box.h}px` : "";
  at.style.maxHeight = box ? "none" : at.dataset.mh0;
}
function tszEnhance(t, at) {
  const key = t.dataset.xfkey, st = TSZ[key] || {}, heads = [...t.tHead.rows[0].cells];
  const cols = t.tHead.rows.length === 1 && !heads.some((c) => c.colSpan > 1);  // one plain header row only
  if (cols) {
    heads.forEach((th, i) => {
      const g = document.createElement("span");
      g.className = "col-grip"; g.setAttribute("aria-hidden", "true"); g.title = "Kéo để đổi độ rộng cột · bấm đúp để về mặc định";
      g.addEventListener("click", (e) => e.stopPropagation());
      g.addEventListener("dblclick", (e) => { e.stopPropagation(); tszCols(t, null); delete (TSZ[key] || {}).cols; tszSave(); });
      g.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const z = S.zoom || 1;  // clientX / rects are in zoomed px, widths in css px
        const ws = (TSZ[key] && TSZ[key].cols) || [...t.tHead.rows[0].cells].map((c) => Math.ceil(c.getBoundingClientRect().width / z));
        const x0 = e.clientX, w0 = ws[i];
        const move = (ev) => { ws[i] = Math.max(32, Math.round(w0 + (ev.clientX - x0) / z)); tszCols(t, ws); };
        const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); (TSZ[key] ||= {}).cols = ws; tszSave(); };
        addEventListener("pointermove", move); addEventListener("pointerup", up);
      });
      th.appendChild(g);
    });
    if (st.cols && st.cols.length === heads.length) tszCols(t, st.cols);
  }
  if (!at.classList.contains("tbl")) return;
  if (st.box) tszBox(at, st.box);
  const corner = (e) => { const r = at.getBoundingClientRect(); return e.clientX > r.right - 18 && e.clientY > r.bottom - 18; };
  at.addEventListener("pointerdown", (e) => {  // the native resize handle (CSS resize) sits in that corner
    if (!corner(e)) return;
    at.style.height ||= `${at.offsetHeight}px`; at.style.maxHeight = "none";  // let it grow past the page's max height
    addEventListener("pointerup", () => {
      if (!at.style.width && !at.style.height) return;
      (TSZ[key] ||= {}).box = { w: parseFloat(at.style.width) || 0, h: parseFloat(at.style.height) || 0 }; tszSave();
    }, { once: true });
  });
  at.addEventListener("dblclick", (e) => { if (corner(e)) { tszBox(at, null); delete (TSZ[key] || {}).box; tszSave(); } });
}
let xfPop = null;
const xfOutside = (e) => { if (xfPop && !xfPop.contains(e.target) && !e.target.closest(".xf-btn")) xfClose(); };
function xfClose() { if (xfPop) { xfPop.remove(); xfPop = null; document.removeEventListener("mousedown", xfOutside, true); } }
function xfMenu(t, col, anchor) {
  const key = t.dataset.xfkey, same = xfPop && xfPop.dataset.col == col && xfPop.dataset.key == key;
  xfClose(); if (same) return;
  const st = XF[key] = XF[key] || {}, tb = t.tBodies[0];
  const vals = [...new Set(xfGroups(tb).map((g) => xfText(g[0], col)))].sort(xfCmp);
  const cur = st.filt && st.filt[col], on = (v) => !cur || !cur.includes(v);
  const p = document.createElement("div");
  p.className = "xf-pop"; p.dataset.col = col; p.dataset.key = key; p.setAttribute("data-no-i18n", "");
  p.innerHTML = `<button class="xf-sort" data-dir="1">↑ Sắp xếp A → Z</button><button class="xf-sort" data-dir="-1">↓ Sắp xếp Z → A</button>
    <div class="xf-sep"></div><input class="xf-search" placeholder="Tìm…">
    <label class="xf-all"><input type="checkbox" class="xf-selall" ${vals.every(on) ? "checked" : ""}> (Chọn tất cả)</label>
    <div class="xf-list">${vals.map((v) => `<label><input type="checkbox" class="xf-v" value="${esc(v)}" ${on(v) ? "checked" : ""}> ${esc(v || "(trống)")}</label>`).join("")}</div>
    <div class="xf-sep"></div><div class="xf-act"><button class="xf-ok">OK</button><button class="xf-clear">Xóa lọc</button></div>`;
  document.body.appendChild(p); xfPop = p;
  const r = anchor.getBoundingClientRect();
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8))}px`;
  p.style.top = `${Math.min(r.bottom + 4, innerHeight - p.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener("mousedown", xfOutside, true), 0);
  const boxes = () => [...p.querySelectorAll(".xf-v")];
  p.querySelector(".xf-search").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); for (const l of p.querySelectorAll(".xf-list label")) l.style.display = l.textContent.toLowerCase().includes(q) ? "" : "none"; });
  p.querySelector(".xf-selall").addEventListener("change", (e) => boxes().forEach((b) => { if (b.closest("label").style.display !== "none") b.checked = e.target.checked; }));
  p.querySelectorAll(".xf-sort").forEach((b) => b.addEventListener("click", () => { st.sort = { col, dir: +b.dataset.dir }; xfClose(); xfApply(t); }));
  p.querySelector(".xf-ok").addEventListener("click", () => { const ex = boxes().filter((b) => !b.checked).map((b) => b.value); st.filt = st.filt || {}; if (ex.length) st.filt[col] = ex; else delete st.filt[col]; xfClose(); xfApply(t); });
  p.querySelector(".xf-clear").addEventListener("click", () => { if (st.filt) delete st.filt[col]; xfClose(); xfApply(t); });
}
const xfScan = () => { for (const t of document.querySelectorAll(".tbl table:not([data-xf]), #runs table:not([data-xf])")) xfEnhance(t); };
let xfPending = false;
new MutationObserver(() => { if (xfPending) return; xfPending = true; requestAnimationFrame(() => { xfPending = false; xfScan(); }); }).observe($("main") || document.body, { childList: true, subtree: true });
xfScan();

// ---------------------------------------------------------------- collapsible sidebar (remembered per machine)
function setMini(on, save = true) {
  document.body.classList.toggle("mini", on);
  $("#nav-mini").setAttribute("aria-expanded", String(!on));
  $("#nav-mini").setAttribute("aria-label", on ? "Mở rộng menu" : "Thu gọn menu");
  store("navMini", on ? "1" : "0");
  if (save) api.save_settings({ nav_mini: on });  // localStorage alone is wiped by pywebview's private mode
}
setMini(store("navMini") === "1", false);
$("#nav-mini").addEventListener("click", () => setMini(!document.body.classList.contains("mini")));

// ---------------------------------------------------------------- in-app feedback (Supabase pmkt_feedback)
const gyPage = () => ($("nav button[aria-current=page] .nl") || {}).textContent || "";
function gyContext() { return { page: gyPage(), run_id: S.runId || "", pic: (S.pfPic || []).join(", ") }; }
function openGy() {
  const c = gyContext();
  $("#gy-ctx").textContent = `Gửi kèm: trang ${c.page || "—"}${c.run_id ? ` · lần chạy ${c.run_id}` : ""} · phiên bản app và vai trò của bạn.`;
  $("#gy").classList.add("on");
  $("#gy-msg").focus();
}
const closeGy = () => $("#gy").classList.remove("on");
// Attachments: new ones are {name, data: data URL}; saved ones are storage paths ("email/uuid/name").
const GY_MAX = 5, GY_BYTES = 10 * 1024 * 1024, GY_IMG = /\.(png|jpe?g|webp|gif)$/i;
const GY_EXT = ["png", "jpg", "jpeg", "webp", "gif", "pdf", "docx", "xlsx", "pptx", "zip", "doc", "xls", "ppt", "csv", "txt", "log", "md", "json"];
document.querySelectorAll(".gy-pick").forEach((i) => (i.accept = GY_EXT.map((e) => "." + e).join(",")));
S.gyFiles = [];
const gyName = (f) => (typeof f === "string" ? f.split("/").pop() : f.name);
function gyShrink(file) {  // screenshots → ≤1600px JPEG so uploads stay small
  return new Promise((ok, fail) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("bad image")); };
    img.src = url;
  });
}
const gyRead = (file) => new Promise((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file);
});
async function gyAdd(files, list) {  // adds to list in place
  for (const f of files) {
    const name = f.name || "screenshot.png", ext = name.split(".").pop().toLowerCase();
    if (list.length >= GY_MAX) { toast(`Tối đa ${GY_MAX} tệp.`, true); break; }
    if (!name.includes(".") || !GY_EXT.includes(ext)) { toast(`Không đính kèm được ${name} – loại tệp không hỗ trợ.`, true); continue; }
    try {
      if (/^image\/(png|jpeg|webp)$/.test(f.type)) list.push({ name: name.replace(/\.[^.]+$/, "") + ".jpg", data: await gyShrink(f) });
      else if (f.size > GY_BYTES) toast(`${name} quá lớn (tối đa 10 MB).`, true);
      else list.push({ name, data: await gyRead(f) });
    } catch { toast(`Không đọc được ${name}.`, true); }
  }
}
function gyChips(list, rm) {  // rm: attribute for the × button (null = read-only)
  return list.map((f, i) => {
    const name = gyName(f), x = rm ? `<button type="button" ${rm}="${i}" aria-label="Bỏ ${esc(name)}">×</button>` : "";
    if (GY_IMG.test(name)) {
      const src = typeof f === "string" ? `data-gy-src="${esc(f)}"` : `src="${f.data}"`;
      return `<div class="gy-thumb"><img ${src} alt="${esc(name)}">${x}</div>`;
    }
    const dl = typeof f === "string" ? ` data-gy-dl="${esc(f)}" title="Tải về"` : "";
    return `<div class="gy-doc"><span${dl} data-no-i18n><svg class="i" aria-hidden="true"><use href="#file"/></svg>${esc(name)}</span>${x}</div>`;
  }).join("");
}
async function gyLoadImgs(root) {  // private bucket → fetched through the app
  for (const img of root.querySelectorAll("img[data-gy-src]:not([src])")) {
    const r2 = await api.feedback_image(img.dataset.gySrc);
    if (!r2.error) img.src = r2.url; else img.alt = "Không tải được ảnh";
  }
}
const gyThumbs = () => { $("#gy-imgs").innerHTML = gyChips(S.gyFiles, "data-gy-rm"); };
$("#gy-file").addEventListener("change", async (e) => { await gyAdd([...e.target.files], S.gyFiles); e.target.value = ""; gyThumbs(); });
$("#gy").addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData || {}).items || []].filter((x) => x.kind === "file").map((x) => x.getAsFile());
  if (files.length) { e.preventDefault(); await gyAdd(files, S.gyFiles); gyThumbs(); }
});
$("#gy-imgs").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-gy-rm]");
  if (rm) { S.gyFiles.splice(Number(rm.dataset.gyRm), 1); gyThumbs(); }
});
$("#gy-open").addEventListener("click", openGy);
$("#gy-close").addEventListener("click", closeGy);
$("#gy-cancel").addEventListener("click", closeGy);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGy(); });
$("#gy-send").addEventListener("click", async () => {
  const btn = $("#gy-send"), kind = ($("input[name=gy-kind]:checked") || {}).value;
  btn.disabled = true;
  btn.textContent = S.gyFiles.length ? "Đang gửi tệp…" : "Đang gửi…";
  const r = await api.send_feedback(kind, $("#gy-msg").value, gyContext(), S.gyFiles)
    .finally(() => { btn.disabled = false; btn.textContent = "Gửi"; });
  if (bad(r)) return;
  $("#gy-msg").value = ""; S.gyFiles = []; gyThumbs(); closeGy(); toast("Đã gửi góp ý – cảm ơn bạn!");
  if ($("#settings").classList.contains("on")) loadGy();
});
const GY_ST = { new: ["MED", "Chờ Lead duyệt"], approved: ["INFO", "Đã duyệt"], rejected: ["HIGH", "Không duyệt"], processing: ["INFO", "Đang xử lý"], done: ["OK", "Đã xử lý"] };
async function loadGy() {
  const el = $("#gy-card");
  if (!el || !(S.role && S.role.signed_in)) { if (el) el.innerHTML = '<div class="muted" style="font-size:13px">Đăng nhập nhóm để xem góp ý.</div>'; return; }
  const lead = S.role.role === "lead", title = lead ? "Góp ý từ nhóm" : "Góp ý của bạn";
  el.innerHTML = `<h2>${title}</h2><div class="muted"><span class="spin"></span> Đang tải…</div>`;
  const r = await api.feedback_list();
  if (r.error) { el.innerHTML = `<h2>${title}</h2><div class="muted" style="font-size:13px">${esc(r.error)}</div>`; return; }
  S.gyItems = r.items;
  const open = r.items.filter((x) => (r.all ? x.status === "new" : x.status !== "done")).length;
  const rows = r.items.map((x) => {
    const [cls, label] = GY_ST[x.status] || GY_ST.new;
    const act = r.all && !["processing", "done"].includes(x.status) ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
        ${x.status !== "approved" ? `<button class="btn sm primary" data-gy-id="${x.id}" data-gy-act="approved">Duyệt</button>` : ""}
        <button class="btn sm" data-gy-id="${x.id}" data-gy-act="edit">Sửa</button>
        ${x.status !== "rejected" ? `<button class="btn sm" data-gy-id="${x.id}" data-gy-act="rejected">Từ chối</button>` : ""}</div>` : "";
    return `<tr class="${x.status === "done" || x.status === "rejected" ? "done" : ""}">
      <td style="white-space:nowrap">${esc(String(x.created_at).slice(0, 16).replace("T", " "))}</td>
      ${r.all ? `<td data-no-i18n>${esc(x.email)}</td>` : ""}
      <td><span class="sev ${x.kind === "bug" ? "HIGH" : "MED"}">${x.kind === "bug" ? "Lỗi" : "Góp ý"}</span></td>
      <td class="msg" data-gy-msg="${x.id}"><span data-no-i18n>${esc(x.message)}</span>${x.original_message ? `<details class="gy-orig"><summary>Bản gốc (trước khi Lead sửa)</summary><span data-no-i18n>${esc(x.original_message)}</span></details>` : ""}${x.review_note ? `<div class="muted" style="font-size:12px;margin-top:4px">Lead: <span data-no-i18n>${esc(x.review_note)}</span></div>` : ""}${(x.images || []).length ? `<div class="gy-imgs">${gyChips(x.images, null)}</div>` : ""}${x.original_images ? `<details class="gy-orig"><summary>Tệp gốc (trước khi Lead sửa)</summary><div class="gy-imgs">${gyChips(x.original_images, null)}</div></details>` : ""}</td>
      <td class="muted gy-ctx" style="font-size:12px" data-no-i18n>${esc([x.context.page, x.context.version && "v" + x.context.version, x.context.role, x.context.run_id].filter(Boolean).join(" · "))}</td>
      <td><span class="sev ${cls}">${r.all && x.status === "new" ? "Mới" : label}</span>${act}</td>
      <td class="num" style="white-space:nowrap" data-no-i18n>${x.fixed_in ? `v${esc(String(x.fixed_in).replace(/^v/, ""))}` : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
  const cols = r.all ? 7 : 6;
  el.innerHTML = `<h2>${title} <span class="td-n">${open} ${r.all ? "chờ duyệt" : "đang chờ"}</span></h2>
    ${r.all ? '<p class="muted" style="font-size:12px;margin:0 0 8px">Chỉ góp ý <b>Đã duyệt</b> được đưa vào xử lý. Sửa nội dung vẫn giữ bản gốc của người gửi.</p>' : ""}
    <div class="tbl" style="max-height:420px"><table><thead><tr><th>Ngày</th>${r.all ? "<th>Người gửi</th>" : ""}<th>Loại</th><th>Nội dung</th><th>Ngữ cảnh</th><th>Trạng thái</th><th title="Phiên bản app đã có bản sửa – cập nhật app lên bản này để dùng">Sửa ở bản</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}" class="muted" style="text-align:center">Chưa có góp ý</td></tr>`}</tbody></table></div>`;
  gyLoadImgs(el);
}
$("#settings").addEventListener("click", async (e) => {  // Lead: approve / reject / edit a ticket
  const b = e.target.closest("[data-gy-act]");
  if (!b) return;
  const id = Number(b.dataset.gyId), act = b.dataset.gyAct;
  if (act === "edit") {
    const x = (S.gyItems || []).find((i) => i.id === id), td = $(`[data-gy-msg="${id}"]`);
    if (!x || !td) return;
    S.gyEdit = { id, files: [...(x.images || [])] };
    td.innerHTML = `<textarea rows="5" maxlength="4000" style="width:100%" aria-label="Nội dung góp ý" data-no-i18n>${esc(x.message)}</textarea>
      <div class="gy-imgs gy-edit-files"></div>
      <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap"><button class="btn sm primary" data-gy-id="${id}" data-gy-act="save">Lưu & duyệt</button><button class="btn sm" data-gy-act="cancel" data-gy-id="${id}">Huỷ</button>
      <label class="btn sm" style="margin:0"><svg class="i" aria-hidden="true"><use href="#file"/></svg>Thêm tệp<input type="file" class="gy-pick gy-edit-pick" multiple hidden></label></div>`;
    td.querySelector(".gy-edit-pick").accept = GY_EXT.map((e) => "." + e).join(",");
    gyEditFiles();
    td.querySelector("textarea").focus();
    return;
  }
  if (act === "cancel") { S.gyEdit = null; loadGy(); return; }
  let r;
  if (act === "save") r = await api.feedback_review(id, "approved", $(`[data-gy-msg="${id}"] textarea`).value, null, S.gyEdit.files);
  else if (act === "rejected") {
    const note = prompt(I18N.t("Lý do không duyệt (không bắt buộc) – người gửi sẽ thấy"));
    if (note === null) return;
    r = await api.feedback_review(id, "rejected", null, note);
  } else r = await api.feedback_review(id, "approved", null, null);
  b.disabled = true;
  if (!bad(r)) loadGy(); else b.disabled = false;
});
function gyEditFiles() {
  const box = S.gyEdit && $(`[data-gy-msg="${S.gyEdit.id}"] .gy-edit-files`);
  if (box) { box.innerHTML = gyChips(S.gyEdit.files, "data-gy-erm"); gyLoadImgs(box); }
}
$("#settings").addEventListener("change", async (e) => {  // Lead edit: add files
  if (!e.target.matches(".gy-edit-pick") || !S.gyEdit) return;
  await gyAdd([...e.target.files], S.gyEdit.files); e.target.value = ""; gyEditFiles();
});
$("#settings").addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-gy-erm]");
  if (rm && S.gyEdit) { S.gyEdit.files.splice(Number(rm.dataset.gyErm), 1); gyEditFiles(); return; }
  const dl = e.target.closest("[data-gy-dl]");
  if (dl) { const r = await api.save_feedback_file(dl.dataset.gyDl); if (!bad(r) && r.path) toast(`Đã lưu ${r.path}`); }
});
document.addEventListener("click", (e) => {
  const img = e.target.closest("#gy-card img[src], #gy-imgs img[src]");
  if (!img) return;
  $("#fd-title").textContent = "Ảnh đính kèm";
  $("#fd-body").innerHTML = `<img src="${img.src}" alt="Ảnh đính kèm" style="max-width:100%;display:block;margin:auto">`;
  $("#fd").classList.add("on");
});

// ---------------------------------------------------------------- Lead: uploaded reports (who opened, when; delete)
const upName = (n) => n.replace("PMKT-Alert_", "").replace(/_(\d\d)-(\d\d)(?:-(\d\d))?$/, " $1:$2");
const upTime = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso) : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
async function loadUploads() {
  const el = $("#up-card");
  if (!el || !(S.role && RUNNER(S.role) && S.role.signed_in)) { if (el) el.innerHTML = ""; return; }
  el.innerHTML = '<h2>Báo cáo đã tải lên</h2><div class="muted"><span class="spin"></span> Đang tải…</div>';
  const r = await api.uploads_overview();
  if (r.error) { el.innerHTML = `<h2>Báo cáo đã tải lên</h2><div class="muted" style="font-size:13px">${esc(r.error)}</div>`; return; }
  const person = (p) => `<span title="${esc(p.email)}${p.pic ? " · " + esc(p.pic) : ""}" data-no-i18n>${esc(p.name)}${p.role === "operator" ? " (Operator)" : ""}</span>`;
  const rows = r.reports.map((x) => {
    const total = x.opened.length + x.not_opened.length;
    return `<tr data-up="${esc(x.name)}"><td style="white-space:nowrap"><b data-no-i18n>${esc(upName(x.name))}</b><div class="muted" style="font-size:11px">${x.pics} PIC</div></td>
      <td class="n"><span class="sev ${total && x.opened.length === total ? "OK" : x.opened.length ? "MED" : "HIGH"}">${x.opened.length}/${total}</span></td>
      <td style="font-size:12px">${x.opened.map((p) => `${person(p)} <span class="muted">${esc(upTime(p.last))}</span>`).join("<br>") || '<span class="muted">—</span>'}</td>
      <td style="font-size:12px">${x.not_opened.map(person).join(", ") || '<span class="muted">—</span>'}</td>
      <td><button class="btn sm ghost" data-up-del="${esc(x.name)}">Xoá</button></td></tr>`;
  }).join("");
  el.innerHTML = `<h2>Báo cáo đã tải lên</h2>
    <p class="muted" style="font-size:12px;margin-top:0">20 lần tải lên gần nhất · ai đã mở và lúc nào (giờ mở gần nhất). "Chưa mở" chỉ tính người có file cho PIC của họ trong lần đó.${r.opens_error ? ` <b>${esc(r.opens_error)}</b>` : ""}</p>
    <div class="tbl" style="max-height:420px"><table><thead><tr><th>Báo cáo</th><th>Đã mở</th><th>Người đã mở</th><th>Chưa mở</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted" style="text-align:center">Chưa tải lên báo cáo nào</td></tr>'}</tbody></table></div>`;
}
$("#settings").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-up-del]");
  if (!b) return;
  if (!confirm(I18N.t("Xoá báo cáo này khỏi máy chủ? Thành viên và Operator sẽ không mở được nữa."))) return;
  b.disabled = true;
  if (!bad(await api.delete_report(b.dataset.upDel))) { toast("Đã xoá báo cáo."); loadUploads(); }
  else b.disabled = false;
});

// ---------------------------------------------------------------- follow role / PIC changes made by the Lead
async function syncRole() {
  if (!api || !(S.role && S.role.signed_in)) return;
  // add devices that signed in after an upload (background); a failure only goes to the log, never a popup
  if (RUNNER(S.role)) api.reshare_reports().then((x) => { if (x && (x.error || (x.failed || []).length)) console.warn("reshare", x); });
  const r = await api.team_sync();
  if (!r || r.error || !r.changed) return;
  if (r.message) toast(r.message, !!r.signed_out);
  const me = await loadRole();
  if (r.signed_out || !me || !me.signed_in) { openSetup(); return; }
  S.pf = null; S.pfPic = null;  // Performance Review reloads with the new scope
  if (RUNNER(me)) { loadLastRun(); loadLessons(); loadReview(); }
  else { loadReports(true); if (["run", "review"].includes(($("main section.on") || {}).id)) go("results"); }
  if (me.needs_key) { go("settings", "team"); loadSettings(); }
}
setInterval(syncRole, 3 * 60 * 1000);
setInterval(() => { if (S.ccInstalled) loadClaudeStats(); }, 60 * 1000);  // footer usage stays current
window.addEventListener("focus", () => { if (Date.now() - (S.syncedAt || 0) > 30 * 1000) { S.syncedAt = Date.now(); syncRole(); } });

// Pinned page headers (Performance Review, Hourly: title, filters, tiles) stay pinned only while they leave
// most of the page for the content. On a laptop the filters and tiles wrap and the header covered ~70% of the
// screen (feedback #74), so past PIN_MAX of the visible height it scrolls away with the page instead.
// Unpinning doesn't change the header's height, so the toggle can't flip back and forth.
const PIN_MAX = 0.45;
function pinFit() {
  const m = $("main");
  if (!m || !m.clientHeight) return;
  for (const h of $$(".pf-sticky"))
    if (h.offsetHeight) h.classList.toggle("unpin", h.offsetHeight > m.clientHeight * PIN_MAX);
}
if (window.ResizeObserver) {  // window resize, zoom, wrapped filters, tiles rendered, a tab shown (0 → real height)
  const ro = new ResizeObserver(pinFit);
  ro.observe($("main"));
  $$(".pf-sticky").forEach((h) => ro.observe(h));
}

// ------------------------------------------------------------------ presentation (deck.js renders slides)
// Python holds the deck; every change it makes (build, Claude edit, slide / popup moves from either window)
// comes back through deckSync(), so the presenter view and the external screen never drift apart.
const DK = { cats: [], deck: null, sel: 0, picked: null, show: { i: 0, pop: null }, on: false, ext: false, shown: -1, t0: 0, timer: null };
async function loadDeck() {
  if (!S.runId) return;
  const r = await api.deck(S.runId);
  if (bad(r)) return;
  DK.cats = r.cats; DK.deck = r.deck;
  if (!DK.picked) { const saved = store("deck-cats"); DK.picked = new Set(saved ? saved.split(",") : r.cats.map((c) => c.key)); }
  renderDeckUi();
}
function dkSlides() { return (DK.deck && DK.deck.slides) || []; }
function renderDeckUi() {
  $("#dk-cats").innerHTML = DK.cats.map((c) => `<button aria-pressed="${DK.picked.has(c.key)}" data-cat="${esc(c.key)}">${esc(c.label)}</button>`).join("");
  const slides = dkSlides();
  $("#dk-play").disabled = !slides.length;
  if (!slides.length) { $("#dk-body").innerHTML = '<div class="empty">Chọn nội dung rồi bấm “Tạo slide”.</div>'; return; }
  DK.sel = Math.min(DK.sel, slides.length - 1);
  const cur = slides[DK.sel];
  if (!$("#dk-stage")) {
    $("#dk-body").innerHTML = `<div class="dk-grid">
      <div class="dk-thumbs" id="dk-thumbs" role="listbox" aria-label="Slides"></div>
      <div><div class="stage" id="dk-stage"></div><div class="card" style="margin-top:12px"><div class="dk-notes-h"><h2>Ghi chú người trình bày</h2><span class="muted" id="dk-notes-st" style="font-size:12px"></span></div>
        <textarea class="dk-notes" id="dk-notes" data-notes placeholder="Gõ ghi chú cho slide này – tự lưu, chỉ hiện ở màn hình người trình bày."></textarea></div></div>
      <div class="card dk-edit"><h2>Sửa với Claude</h2>
        <div class="chips" role="radiogroup" id="dk-scope"><button aria-pressed="true" data-scope="slide">Slide này</button><button aria-pressed="false" data-scope="all">Cả bài</button></div>
        <textarea id="dk-ask" placeholder="VD: viết insight sắc hơn, thêm ghi chú nói về PIC chậm tiến độ, gộp các slide PIC thành 1 slide tóm tắt…"></textarea>
        <button class="btn primary" id="dk-edit-btn"><svg class="i" aria-hidden="true"><use href="#spark"/></svg>Sửa với Claude</button>
        <p class="muted" style="font-size:12px;margin:0">Claude chỉ sửa chữ (tiêu đề, insight, ý chính, ghi chú). Số liệu và biểu đồ lấy từ kết quả chạy; câu có số không khớp dữ liệu sẽ bị bỏ.</p>
        <p class="muted" id="dk-edit-status" style="font-size:12px;margin:0"></p></div></div>`;
  }
  const secs = Object.fromEntries(Deck.sections(slides).map((x) => [x.cat, x]));
  $("#dk-thumbs").innerHTML = slides.map((s, i) => { const x = secs[s.cat]; return `<button role="option" aria-selected="${i === DK.sel}" data-sl="${i}"><span class="num">${i + 1}</span>${x ? `<span class="tab" style="--c:${x.c}">${x.L}</span>` : ""}<span data-no-i18n>${esc(s.title)}</span></button>`; }).join("");
  Deck.render($("#dk-stage"), cur, { slides, i: DK.sel, asOf: DK.deck.as_of, animate: true, onGo: (i) => { DK.sel = i; renderDeckUi(); } });
  $("#dk-notes").value = cur.notes || ""; $("#dk-notes-st").textContent = "";
}
async function buildDeck() {
  const cats = [...DK.picked];
  if (!cats.length) { toast("Chọn ít nhất một mục", true); return; }
  store("deck-cats", cats.join(","));
  const b = $("#dk-build"); b.disabled = true;
  const r = await api.deck_build(cats, S.runId);
  b.disabled = false;
  if (bad(r)) return;
  DK.deck = r.deck; DK.sel = 0; renderDeckUi();
}
async function editDeck() {
  const text = $("#dk-ask").value.trim();
  if (!text) { $("#dk-ask").focus(); return; }
  const all = $("#dk-scope [aria-pressed=true]").dataset.scope === "all";
  const b = $("#dk-edit-btn"), st = $("#dk-edit-status");
  b.disabled = true; st.innerHTML = '<span class="spin"></span> Claude đang sửa…';
  const r = await api.deck_edit(text, all ? null : DK.sel);
  b.disabled = false; st.textContent = "";
  if (bad(r)) return;
  DK.deck = r.deck;
  st.textContent = r.dropped ? `Đã cập nhật · bỏ ${r.dropped} câu vì số liệu không khớp dữ liệu.` : "Đã cập nhật.";
  $("#dk-ask").value = "";
  renderDeckUi();
}
// ---- show
async function startShow() {
  const r = await api.present_start();
  if (bad(r)) return;
  DK.on = true; DK.ext = r.external; DK.shown = -1; DK.t0 = Date.now();
  $("#pv").hidden = false;
  $("#pv").classList.toggle("solo", !DK.ext);
  $("#pv").classList.remove("notes");
  clearInterval(DK.timer);
  DK.timer = setInterval(() => { const s = Math.floor((Date.now() - DK.t0) / 1000); $("#pv-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }, 1000);
  showGo(DK.sel, null);
}
function showGo(i, pop) { api.present_show(i, pop).then((r) => { if (!bad(r)) renderShow(r); }); }
function renderShow(show) {
  DK.show = show;
  const slides = dkSlides(), i = show.i, slide = slides[i];
  if (!DK.on || !slide) return;
  const stage = $("#pv-stage");
  if (i !== DK.shown) {
    Deck.render(stage, slide, { slides, i, asOf: DK.deck.as_of, animate: true, onPop: (p) => showGo(i, p), onGo: (j) => showGo(j, null) });
    Deck.render($("#pv-next"), slides[i + 1], { slides, i: i + 1, asOf: DK.deck.as_of });
    if (document.activeElement !== $("#pv-notes")) $("#pv-notes").value = slide.notes || "";
    $("#pv-count").textContent = `${i + 1} / ${slides.length}`;
    DK.shown = i;
  }
  Deck.pop(stage, slide, show.pop);
}
function endShow() {
  if (!DK.on) return;
  DK.on = false; clearInterval(DK.timer);
  $("#pv").hidden = true;
  api.present_stop();
  DK.sel = DK.show.i; renderDeckUi();
}
window.deckSync = (st) => {  // called by Python
  const changed = JSON.stringify(st.deck) !== JSON.stringify(DK.deck);
  DK.deck = st.deck;
  if (DK.on) { if (changed) DK.shown = -1; renderShow(st.show); }
};
// Speaker notes are typed by hand (editor or presenter view) and saved after a short pause.
document.addEventListener("input", (e) => {
  const t = e.target.closest("[data-notes]");
  if (!t || !DK.deck) return;
  const i = t.id === "pv-notes" ? DK.show.i : DK.sel, v = t.value, st = $("#dk-notes-st");
  DK.deck.slides[i].notes = v;
  if (st) st.textContent = "Đang lưu…";
  clearTimeout(DK.nt);
  DK.nt = setTimeout(async () => { const r = await api.deck_notes(i, v); if (st) st.textContent = bad(r) ? "" : "Đã lưu"; }, 500);
});
window.presentEnded = () => { if (DK.ext) endShow(); };  // the external window was closed
document.addEventListener("click", async (e) => {
  const cat = e.target.closest("#dk-cats [data-cat]");
  if (cat) { const k = cat.dataset.cat; DK.picked.has(k) ? DK.picked.delete(k) : DK.picked.add(k); cat.setAttribute("aria-pressed", DK.picked.has(k)); return; }
  const sl = e.target.closest("#dk-thumbs [data-sl]");
  if (sl) { DK.sel = +sl.dataset.sl; renderDeckUi(); return; }
  const sc = e.target.closest("#dk-scope [data-scope]");
  if (sc) { $$("#dk-scope button").forEach((b) => b.setAttribute("aria-pressed", b === sc)); return; }
  if (e.target.closest("#dk-build")) buildDeck();
  else if (e.target.closest("#dk-edit-btn")) editDeck();
  else if (e.target.closest("#dk-play")) startShow();
  else if (e.target.closest("#pv-prev")) showGo(DK.show.i - 1, null);
  else if (e.target.closest("#pv-next-btn")) showGo(DK.show.i + 1, null);
  else if (e.target.closest("#pv-end")) endShow();
});
document.addEventListener("keydown", (e) => {
  if (!DK.on || e.target.closest("textarea,input")) return;
  if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); showGo(DK.show.i + 1, null); }
  else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); showGo(DK.show.i - 1, null); }
  else if (e.key === "Escape") { if (DK.show.pop) showGo(DK.show.i, null); else endShow(); }
  else if (e.key.toLowerCase() === "n") $("#pv").classList.toggle("notes");
});
// ------------------------------------------------------------------ customizable layouts
// Results, Performance Review, Dashboard and Hourly render their cards as named widgets; layoutHtml() places them on a
// 30-column grid in the user's order and width (settings.layouts). No saved layout = the original page.
// Widget: [key, label, span of a 30-column row (10 = ⅓, 15 = ½, 30 = full …), shown by default]. Not-default ones are the extras.
const WIDGETS = {
  results: [["score", "Mô hình chấm điểm (Department / PIC)", 30, true], ["kpis", "Chỉ số cảnh báo", 30, true],
    ["tabs", "Cảnh báo · To-do · Insight · Data", 30, true],
    ["r-actions", "Số PL theo action", 15, false], ["r-excess", "Top campaign theo excess spend", 15, false],
    ["r-follow", "Campaign đang theo dõi kết quả", 30, false]],
  perf: [["insight", "Insight tổng quan", 30, true], ["today", "Tóm tắt hôm nay", 30, true], ["listing", "Listing (Keepa) – khi lọc đúng 1 SKU", 30, true], ["pl", "Bảng Product line", 30, true],
    ["c1", "Biểu đồ GMV · Ads NMV · %Ads RS", 15, true], ["c2", "Biểu đồ Ads Spend · ACOS", 15, true], ["c3", "Biểu đồ TACOS", 30, true],
    ["drivers", "PL / SKU làm GMV · Spend · TACOS thay đổi", 30, true],
    ["sku", "Bảng SKU", 30, true], ["camp", "Bảng Campaign", 30, true], ["issues", "Listing issue theo ngày", 30, true]],
  dashboard: [["rank", "Xếp hạng tổng", 18, true], ["review", "Nhận xét của Claude", 12, true], ["scorecard", "Scorecard", 30, true],
    ["pace", "Tiến độ GMV & spend", 15, true], ["sev", "Mức cảnh báo theo PIC", 15, true],
    ["plmap", "Bản đồ PL", 15, true], ["excess", "Top 10 PL theo excess spend", 15, true],
    ["metric", "So sánh theo chỉ số", 15, true], ["week", "Xu hướng theo tuần", 15, true],
    ["share", "Tỷ trọng GMV theo tuần", 15, true], ["runs", "Alert HIGH qua các lần chạy", 15, true],
    ["d-excess", "Excess spend theo PIC", 15, false], ["d-action", "Tỉ lệ action & cải thiện theo PIC", 15, false],
    ["d-target", "Target tháng theo PIC", 30, false], ["d-daily", "Target vs actual theo ngày từng PIC", 30, true]],
  hourly: [["h-c1", "Biểu đồ GMV · Ads Spend · TACOS theo giờ", 15, true], ["h-c2", "Biểu đồ lũy kế so với target", 15, true],
    ["h-c3", "Biểu đồ so với kỳ trước theo giờ", 30, true], ["h-cpc", "Biểu đồ CPC theo giờ so với kỳ trước", 30, true], ["h-c4", "Biểu đồ Impression · Glance view · Click theo giờ", 30, true], ["h-sku", "Performance theo giờ · SKU", 30, true], ["h-pl", "Performance theo giờ · Product line", 30, true],
    ["h-drv", "PL / SKU làm GMV · Spend · TACOS thay đổi", 30, true],  // feedback #84
    ["h-pic", "Tóm tắt từng PIC theo giờ", 30, true], ["h-rpl", "Target & actual theo khung ngày · Product line", 30, true],
    ["h-rsku", "Target & actual theo khung ngày · SKU", 30, true], ["h-mpl", "Target & actual cả tháng · Product line", 30, true],
    ["h-msku", "Target & actual cả tháng · SKU", 30, true]],
};
const PAGE_NAME = { results: "Kết quả", perf: "Performance Review", dashboard: "Dashboard đội", hourly: "Hourly" };
const SPANS = [[10, "⅓"], [12, "⅖"], [15, "½"], [18, "⅗"], [20, "⅔"], [30, "Cả hàng"]];
function defaultLayout(page) { return WIDGETS[page].filter((w) => w[3]).map(([key, , span]) => ({ key, span })); }
// Default widgets added in an update ([page, key, the widget it follows]): a layout saved before gets them too, until
// the user saves a layout again (the save records them in layouts.seen, so removing one sticks).
const NEW_WIDGETS = [["perf", "listing", "today"], ["hourly", "h-cpc", "h-c3"], ["hourly", "h-drv", "h-pl"]];
function layoutOf(page) {
  const known = new Set(WIDGETS[page].map((w) => w[0])), saved = (S.layouts || {})[page];
  const ok = Array.isArray(saved) && saved.filter((w) => w && known.has(w.key) && SPANS.some(([n]) => n === w.span));
  if (!(ok && ok.length)) return defaultLayout(page);
  const seen = new Set((S.layouts || {}).seen || []), out = [...ok];
  for (const [p, key, after] of NEW_WIDGETS) {
    if (p !== page || seen.has(`${p}:${key}`) || out.some((w) => w.key === key)) continue;
    out.splice(out.findIndex((w) => w.key === after) + 1, 0, { key, span: WIDGETS[page].find((w) => w[0] === key)[2] });  // anchor gone → first
  }
  return out;
}
function layoutHtml(page, W) {
  return `<div class="lay">${layoutOf(page).filter((w) => W[w.key]).map((w) => `<div class="lw" style="grid-column:span ${w.span}" data-w="${w.key}">${W[w.key]}</div>`).join("")}</div>`;
}
const chartCard = (title, id, note = "") => `<div class="card"><h2>${title}</h2><div class="chartbox"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div>${note ? `<p class="muted" style="font-size:12px;margin:4px 0 0">${note}</p>` : ""}</div>`;
const emptyChart = (id, text) => { const el = document.getElementById(id); if (el) el.parentElement.innerHTML = `<div class="empty">${text}</div>`; };
const hbar = (labels, data, colors, fmtv) => ({ type: "bar", data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, barThickness: 14 }] },
  options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtv(c.raw) } } },
    scales: { x: { beginAtZero: true, ticks: { callback: fmtv } }, y: { grid: { display: false } } } } });

// ---- Results extras (follow the selected PIC)
function resultExtras() {
  const camps = (S.run.camp || []).filter(picOk).filter((c) => c.followup_check);
  return {
    "r-actions": chartCard("Số PL theo action", "r-c-actions", "Pacing action của từng PL (PIC đang chọn)."),
    "r-excess": chartCard("Top 10 campaign theo excess spend", "r-c-excess"),
    "r-follow": `<div class="card"><h2>Campaign đang theo dõi kết quả <span class="td-n">${camps.length}</span></h2><div class="tbl" style="max-height:360px"><table>
      <thead><tr><th>Campaign</th><th>PL</th><th>PIC</th><th>Action gần nhất</th><th>Kết quả</th><th class="n">Spend L7D</th><th class="n">ACoS L7D</th></tr></thead>
      <tbody>${camps.map((c) => `<tr><td class="muted" style="max-width:320px" title="${esc(c.campaign)}">${esc(c.campaign)}</td><td>${esc(c.pl)}</td><td>${esc(c.pic)}</td>
        <td class="num">${c.last_action_date ? ddmm(String(c.last_action_date)) : "—"}</td><td>${esc(c.followup_check)}</td>
        <td class="n">${money(c.l7d_spend)}</td><td class="n">${pct(c.l7d_acos, 1)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted" style="text-align:center">Không có campaign đang theo dõi</td></tr>'}</tbody></table></div></div>`,
  };
}
function drawResultExtras() {
  const pal = SERIES[isDark() ? "dark" : "light"];
  if (document.getElementById("r-c-actions")) {
    const n = {};
    (S.run.pl || []).filter(picOk).forEach((r) => { const k = short(r.pacing_action) || "—"; n[k] = (n[k] || 0) + 1; });
    const rows = Object.entries(n).sort((a, b) => b[1] - a[1]);
    if (!rows.length) emptyChart("r-c-actions", "Không có PL.");
    else {  // canvas needs real colours, not var(--x)
      const color = (a) => { const c = actionColor(a, ""); return c === "var(--fg)" ? pal[0] : cssVar(c.slice(4, -1)); };
      const cfg = hbar(rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => color(r[0])), (v) => String(v));
      cfg.options.scales.x.ticks.precision = 0;
      drawChart("r-c-actions", cfg);
    }
  }
  if (document.getElementById("r-c-excess")) {
    const top = (S.run.camp || []).filter(picOk).filter((c) => c.excess > 0).sort((a, b) => b.excess - a.excess).slice(0, 10);
    if (!top.length) emptyChart("r-c-excess", "Không có excess spend.");
    else drawChart("r-c-excess", hbar(top.map((c) => String(c.campaign).slice(0, 40)), top.map((c) => c.excess), pal[1], money));
  }
}

// ------------------------------------------------------------------ Hourly (usa_amz_sso_hourly -- usa.xlsx)
// Filters as on Performance Review, combined with AND; time gone on 24 h (hour-to-date). The file is checked every
// minute: when it changed on disk the tab reloads (in the background when another tab is open: on the next visit).
S.hrPic = S.hrPic || []; S.hrLeader = S.hrLeader || []; S.hrPl = S.hrPl || []; S.hrSku = S.hrSku || [];
S.hrM = S.hrM || { sku: "gmv", pl: "gmv", pic: "gmv" };
const HR_M = [["gmv", "GMV", "money"], ["rs", "RS", "int"], ["spend", "Ads Spend", "money", "Spend"], ["tacos", "TACOS", "pct"]];
const HR_PIC_M = ["gmv", "spend", "tacos"];
const hh = (h) => `${String(h).padStart(2, "0")}:00`;
async function loadHourly(keepFilters, quiet) {
  const body = $("#hr-body");
  if (!S.runId && !(S.role && !RUNNER(S.role))) { body.innerHTML = '<div class="empty">Chưa có dữ liệu – chạy dữ liệu trước.</div>'; return; }
  if (!keepFilters && S.hr && S.hrRunId === S.runId && !S.hrStale) { renderHourly(); return; }
  if (S.hrLoading) return;
  let f = { pic: S.hrPic.length || S.hr ? S.hrPic : (S.pic && S.pic !== ALL_PIC ? [S.pic] : []), leader: S.hrLeader, pl: S.hrPl, sku: S.hrSku };
  if (S.hr) {  // a range ending on the last data hour follows the file forward when a new day arrives
    const s = $("#hr-start").value, e = $("#hr-end").value, max = S.hr.filters.max;
    f = { ...f, start: e === max && s === e ? null : s || null, end: e === max ? null : e || null };
  }
  if (S.hr) $("#hr-src").insertAdjacentHTML("beforeend", ' <span class="spin"></span>');
  else body.innerHTML = '<div class="muted"><span class="spin"></span> Đang đọc file hourly… (lần đầu ~20 giây)</div>';
  S.hrLoading = true;
  const d = await api.hourly(f, S.runId).finally(() => { S.hrLoading = false; });
  if (d.error) {
    if (S.hr) { renderHourly(); $("#hr-src").insertAdjacentHTML("beforeend", `<br><span style="color:var(--high)">${esc(d.error)}</span>`); }
    else body.innerHTML = `<div class="empty">${esc(d.error)}</div>`;
    return;
  }
  S.hr = d; S.hrRunId = S.runId; S.hrSig = d.source.sig; S.hrStale = false;
  const ff = d.filters;
  S.hrPic = ff.pic; S.hrLeader = ff.leader.filter((p) => ff.leaders.includes(p)); S.hrPl = ff.pl.filter((p) => ff.pls.includes(p));
  S.hrSku = ff.sku.filter((a) => ff.skus.some(([x]) => x === a));
  pfMselRender("pic", ff.pics.map((p) => [p, p]), "hr");
  $("#hr-leader").parentElement.hidden = !ff.leaders.length;
  pfMselRender("leader", ff.leaders.map((p) => [p, p]), "hr");
  pfMselRender("pl", ff.pls.map((p) => [p, p]), "hr");
  pfMselRender("sku", ff.skus, "hr");
  for (const [id, v] of [["#hr-start", ff.start], ["#hr-end", ff.end]]) { $(id).value = v; $(id).min = ff.min; $(id).max = ff.max; }
  hrPresetMark();
  renderHourly();
}
// Hour × entity matrix: one row per entity, then a total row; GMV / RS / spend cells shaded by size.
// all = every metric side by side in each hour (SKU / Product line, feedback #38) with the lead + Tổng columns frozen;
// otherwise one metric picked by tabs (PIC).
function hrMatrix(table, rows, total, lead, metrics, all) {
  const ms = all ? metrics : [metrics.includes(S.hrM[table]) ? S.hrM[table] : metrics[0]];
  const info = (m) => HR_M.find(([k]) => k === m);
  const max = Object.fromEntries(ms.map((m) => [m, Math.max(0, ...rows.flatMap((r) => r.hours.map((c) => (c && num(c[m]) ? c[m] : 0))))]));
  const cell = (c, m, j) => {
    const cls = `n${all && !j ? " hg" : ""}`;
    if (!c) return `<td class="${cls} muted">·</td>`;
    const shade = m !== "tacos" && max[m] > 0 && c[m] > 0 ? ` style="background:color-mix(in srgb,var(--primary) ${Math.round(4 + 26 * c[m] / max[m])}%,transparent)"` : "";
    return `<td class="${cls}"${shade}>${pfFmt[info(m)[2]](c[m])}</td>`;
  };
  // frozen columns: lead (widths from lead[i][2]) then the Tổng block; left offsets add up
  const TW = 68, frz = [...lead.map((l) => l[2] || 120), ...(all ? ms.map(() => TW) : [])];
  const lefts = frz.map((_, i) => frz.slice(0, i).reduce((a, b) => a + b, 0));
  const fz = (i) => (all ? ` class="fz${i === frz.length - 1 ? " fz-end" : ""}${i >= lead.length ? " n" : ""}" style="left:${lefts[i]}px;min-width:${frz[i]}px;max-width:${frz[i]}px"` : "");
  const totCells = (t, b) => ms.map((m, j) => all ? `<td${fz(lead.length + j)}>${b ? "<b>" : ""}${pfFmt[info(m)[2]](t[m])}${b ? "</b>" : ""}</td>`
    : `<td class="n">${b ? "<b>" : ""}${pfFmt[info(m)[2]](t[m])}${b ? "</b>" : ""}</td>`).join("");
  const tabs = all ? "" : `<div class="tabs" role="tablist" style="margin:6px 0">${metrics.map((k) => `<button type="button" role="tab" data-hrm="${table}:${k}" aria-selected="${k === ms[0]}">${info(k)[1]}</button>`).join("")}</div>`;
  // feedback #47: the metric goes on a second header line (short name) so hour columns stay narrow
  const label = (m) => (all ? ` <br><span class="muted" style="font-weight:400" title="${info(m)[1]}">${info(m)[3] || info(m)[1]}</span>` : "");
  const head = `<tr>${lead.map(([h], i) => `<th${fz(i)}>${h}</th>`).join("")}${ms.map((m, j) => `<th${all ? fz(lead.length + j) : ' class="n"'}>Tổng${label(m)}</th>`).join("")}${Array.from({ length: 24 }, (_, i) => ms.map((m, j) =>
    `<th class="n${all && !j ? " hg" : ""}" data-no-i18n>${String(i).padStart(2, "0")}h${label(m)}</th>`).join("")).join("")}</tr>`;
  const leadW = lefts[lead.length - 1] + frz[lead.length - 1];
  // feedback #77: the Tổng row is summed over the rows shown (search box / column filters, via hrTotRedraw)
  const totRow = (list) => {
    const t = list.length === rows.length ? total : hrSum(list);
    return `<tr style="font-weight:700"><td colspan="${lead.length}"${all ? ` class="fz" style="left:0;min-width:${leadW}px;max-width:${leadW}px"` : ""}>Tổng</td>${totCells(t.total)}${t.hours.map((c) => ms.map((m, j) => (c ? `<td class="n${all && !j ? " hg" : ""}">${pfFmt[info(m)[2]](c[m])}</td>` : `<td class="n${all && !j ? " hg" : ""} muted">·</td>`)).join("")).join("")}</tr>`;
  };
  S.hrTot[table] = { rows, row: totRow };
  const body = rows.map((r, i) => `<tr data-i="${i}" data-q="${esc(lead.map(([, v]) => v(r, true)).join(" ").toLowerCase())}">${lead.map(([, v], i) => `<td${fz(i)}>${v(r)}</td>`).join("")}${totCells(r.total, true)}${r.hours.map((c) => ms.map((m, j) => cell(c, m, j)).join("")).join("")}</tr>`).join("");
  // feedback #46: the Tổng row sits frozen at the bottom (tfoot), out of the column sort / filter
  return { tabs, html: `<div class="tbl${all ? " hrm" : ""}" style="max-height:520px"><table data-hrtot="${table}"><thead>${head}</thead><tbody id="hr-${table}-body">${body || `<tr><td colspan="${lead.length + 25 * ms.length}" class="muted">Không có dữ liệu</td></tr>`}</tbody><tfoot>${totRow(rows)}</tfoot></table></div>` };
}
// feedback #77: sums of the matrix rows (Tổng column + each hour); TACOS = Σspend / ΣGMV, an hour no row has stays "·"
function hrSum(list) {
  const add = (cs) => {
    const c = cs.filter(Boolean);
    if (!c.length) return null;
    const s = Object.fromEntries(["gmv", "rs", "spend"].map((k) => [k, c.reduce((a, x) => a + (x[k] || 0), 0)]));
    return { ...s, tacos: pfDiv(s.spend, s.gmv) };
  };
  return { total: add(list.map((r) => r.total)) || { gmv: 0, rs: 0, spend: 0, tacos: null }, hours: Array.from({ length: 24 }, (_, h) => add(list.map((r) => r.hours[h]))) };
}
// feedback #77: every hourly table keeps a Tổng row frozen at the bottom (tfoot) over the rows shown – the search box
// (hrFilterRows) and the column filters (xfApply) redraw it; S.hrTot[key] = { rows, row(list) → <tr> }
S.hrTot = {};
function hrTotRedraw(t) {
  const o = t && S.hrTot[t.dataset.hrtot];
  if (!o || !t.tFoot || !t.tBodies[0]) return;
  const vis = [...t.tBodies[0].rows].filter((r) => r.dataset.i !== undefined && r.style.display !== "none");
  t.tFoot.innerHTML = o.row(vis.map((r) => o.rows[r.dataset.i]).filter(Boolean));
}
function hrTav(key, rows, lead, gone, empty) {  // target / actual / %achieve per metric, like the Performance Review tables
  const heads = HR_M.map(([, label]) => `<th class="n">${label} Tgt</th><th class="n">${label} Act</th><th class="n">${label} %</th>`).join("");
  const cells = (r) => HR_M.map(([k, , f]) =>
    `<td class="n">${pfFmt[f](r.target[k])}</td><td class="n">${pfFmt[f](r.actual[k])}</td><td class="n">${pfAchieve(r.achieve[k], k, gone)}</td>`).join("");
  const body = rows.map((r, i) => `<tr data-i="${i}">${lead.map(([, v, c]) => `<td${c ? ` class="${c}"` : ""}>${v(r)}</td>`).join("")}${cells(r)}</tr>`).join("");
  // Tổng: targets / actuals summed, TACOS and %achieve recomputed from the sums (pfTotal); stock / status columns blank
  const totRow = (list) => `<tr style="font-weight:700"><td>Tổng</td>${lead.slice(1).map(() => "<td></td>").join("")}${cells(pfTotal(list))}</tr>`;
  S.hrTot[key] = { rows, row: totRow };
  return `<div class="tbl pf-tbl" style="max-height:460px"><table data-hrtot="${key}"><thead><tr>${lead.map(([h, , c]) => `<th${c ? ` class="${c}"` : ""}>${h}</th>`).join("")}${heads}</tr></thead>
    <tbody>${body || `<tr><td colspan="${lead.length + 12}" class="muted">${empty}</td></tr>`}</tbody>${rows.length ? `<tfoot>${totRow(rows)}</tfoot>` : ""}</table></div>`;
}
function renderHourly() {
  const d = S.hr, ff = d.filters, last = d.last, src = d.source;
  const range = ff.start === ff.end ? `${ddmm(ff.start)}/${ff.start.slice(0, 4)}` : `${ddmm(ff.start)} – ${ddmm(ff.end)}/${ff.end.slice(0, 4)}`;
  const at = (iso) => (iso ? `${ddmm(iso.slice(0, 10))} ${iso.slice(11, 16)}` : "—");
  // Members / Operators: the Lead's hourly push when there is one (hourly_push), else their own file
  const head = src.shared ? `Từ Lead <span data-no-i18n>${esc(src.by || "")}</span> · chia sẻ lúc ${at(src.modified)}` : `${esc(src.name)} · lưu lúc ${at(src.modified)}`;
  const how = src.shared ? "Tự cập nhật khi Lead chia sẻ bản mới (kiểm tra mỗi phút)" : src.sharepoint ? "Tải từ SharePoint mỗi giờ" : "Tự cập nhật khi file có data mới (kiểm tra mỗi phút)";
  const team = src.team_share ? ` · Đã chia sẻ cho team lúc ${at(src.team_share.at)}` : "";
  $("#hr-src").innerHTML = `${head} · data đến khung <b>${hh(last.hour)}</b> ngày <b>${ddmm(last.date)}</b> · ${how}${team}${src.sp_error ? `<br><span style="color:var(--high)">SharePoint: ${esc(src.sp_error)} – bấm “Làm mới” để đăng nhập lại</span>` : ""}${d.note ? `<br><span style="color:var(--high)">${esc(d.note)}</span>` : ""}`;
  const picL = pfMselLabel("pic", S.hrPic.map((p) => [p, p]), "hr");
  $("#hr-sub").textContent = `${range} · hour-to-date · time gone tính trên 24h · PIC ${picL}`;
  const t = d.range.total, tile = (lbl, val, sub = "") => `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val num">${val}</div>${sub ? `<div class="muted" style="font-size:12px">${sub}</div>` : ""}</div>`;
  const vs = (k, f) => `${pct(t.achieve[k], 1)} target (${pfFmt[f](t.target[k])})`;
  const pv = d.prev_hours, pvL = pv ? (pv.start === pv.end ? ddmm(pv.start) : `${ddmm(pv.start)} – ${ddmm(pv.end)}`) : "";
  // feedback #85: CPC this period vs the one just before (default: today vs yesterday, over the same hours so far)
  const cpc = d.cpc_hours || { missing: true }, cpcP = cpc.prev && cpc.prev.total.cpc, cpcC = cpc.missing ? null : cpc.total.cpc;
  const cpcSub = cpc.missing ? "" : cpcP == null ? "chưa có data kỳ trước"
    : `${pvL}: ${price(cpcP)}${cpcC != null ? ` · ${signed(cpcC / cpcP - 1)}` : ""}${cpc.upto < 23 ? ` (cùng giờ 00:00–${hh(cpc.upto)})` : ""}`;
  $("#hr-tiles").innerHTML = `<div class="grid pf-tiles">
    ${tile("Time gone (24h)", pct(d.gone_day, 1), `${ddmm(last.date)} · đến hết khung ${hh(last.hour)}${ff.start !== ff.end ? ` · cả khung ngày ${pct(d.gone_range, 1)}` : ""}`)}
    ${tile("GMV", money(t.actual.gmv), vs("gmv", "money"))}${tile("RS", pfFmt.int(t.actual.rs), vs("rs", "int"))}
    ${tile("Ads Spend", money(t.actual.spend), vs("spend", "money"))}${tile("TACOS", pct(t.actual.tacos, 1), `target ${pct(t.target.tacos, 1)}`)}${cpc.missing ? "" : tile("CPC", price(cpcC), cpcSub)}</div>`;
  const note = (ff.pl.length ? ` · ${esc(ff.pl.join(", "))}` : "") + (S.hrSku.length ? ` · ${S.hrSku.length} SKU` : "");
  S.hrDrvNote = note;  // feedback #84
  // feedback #78: the SKU tables show the Product name instead of the Product line
  const skuLead = [["SKU", (r, q) => (q ? `${r.sku} ${r.asin}` : `<b data-no-i18n>${esc(r.sku)}</b><div class="muted" style="font-size:11px" data-no-i18n>${esc(r.asin)}</div>`), 88],
    ["Product name", (r, q) => (q ? r.product : `<div class="pf-name wrap" title="${esc(r.product)}" data-no-i18n>${esc(r.product)}</div>`), 160]];
  const plLead = [["Product line", (r, q) => (q ? r.pl : `<b title="${esc(r.pl)}">${esc(r.pl)}</b>`), 170]];
  const picLead = [["PIC", (r, q) => (q ? r.pic : `<b>${esc(r.pic)}</b>`)]];
  const mSku = hrMatrix("sku", d.sku_hours, d.total_hours, skuLead, HR_M.map(([k]) => k), true);
  const mPl = hrMatrix("pl", d.pl_hours, d.total_hours, plLead, HR_M.map(([k]) => k), true);
  const mPic = hrMatrix("pic", d.pic_hours, d.total_hours, picLead, HR_PIC_M);
  const card = (title, inner, extra = "") => `<div class="card"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="flex:1">${title}</h2>${extra}</div>${inner}</div>`;
  const search = (table) => `<input type="search" data-hrq="${table}" placeholder="Tìm…" aria-label="Tìm" value="${esc((S.hrQ || {})[table] || "")}" style="max-width:220px">`;
  const skuTav = [["SKU", (r) => `<b data-no-i18n>${esc(r.sku)}</b><div class="muted" style="font-size:11px" data-no-i18n>${esc(r.asin)}</div>`], ["Product name", (r) => `<div class="pf-name wrap" title="${esc(r.product)}" data-no-i18n>${esc(r.product)}</div>`]];
  const plTav = [["Product line", (r) => `<b>${esc(r.pl)}</b>`]];
  const legend = (gone) => `<p class="muted" style="font-size:12px;margin:6px 0 0">%: <b style="color:var(--ok)">xanh</b> = tốt (GMV/RS ≥ ${pct(gone, 1)} time gone · Ads spend ≤ time gone · TACOS ≤ 100%), <b style="color:var(--high)">đỏ</b> = ngược lại.</p>`;
  const tr = d.traffic_hours, trMiss = tr.missing.length ? ` · <b>File hourly chưa có cột</b> ${tr.missing.map((k) => tr.columns[k].join(" / ")).join(" · ")}.` : "";
  $("#hr-body").innerHTML = layoutHtml("hourly", {  // feedback #44: cards placed by the layout editor (Bố cục)
    "h-c4": chartCard(`Impression · Glance view · Click theo giờ${note}`, "hr-c4", `Cột: Impression (SP + SB + SD) · đường: Glance view và Click (SP + SB + SD), trục phải.${trMiss}`),
    "h-c1": chartCard(`GMV · Ads Spend · TACOS theo giờ${note}`, "hr-c1", "Cột: GMV và Ads Spend từng khung giờ · đường: TACOS (trục phải) – giờ nào tiêu nhiều mà ra ít GMV."),
    "h-c2": chartCard(`Lũy kế so với target${note}`, "hr-c2", "GMV, RS, Ads Spend cộng dồn đến hết từng khung giờ, tính theo % target của khung ngày; đường đứt = time gone (24h). Spend vượt time gone nhanh hơn GMV = đang tiêu trước doanh thu."),
    "h-c3": chartCard(`So với kỳ trước theo giờ${note}`, "hr-c3", pv ? `Nét liền: ${range} · nét đứt: ${pvL} (cùng số ngày ngay trước).` : "File hourly không có data của kỳ trước để so sánh."),
    "h-cpc": chartCard(`CPC theo giờ so với kỳ trước${note}`, "hr-cpc", `${pv ? `Nét liền: ${range} · nét đứt: ${pvL}. ` : ""}CPC = Ads Spend ÷ Click (SP + SB + SD) của từng khung giờ; khung giờ 0 click để trống.`),  // feedback #85
    "h-sku": card(`Performance theo giờ · SKU${note} <span class="muted" style="font-weight:400;font-size:13px">${range}</span>`, mSku.tabs + mSku.html, search("sku")),
    "h-pl": card(`Performance theo giờ · Product line${note} <span class="muted" style="font-weight:400;font-size:13px">${range}</span>`, mPl.tabs + mPl.html, search("pl")),
    "h-drv": hrDrivers(note),
    "h-pic": card(`Tóm tắt từng PIC theo giờ${note} <span class="muted" style="font-weight:400;font-size:13px">${range}</span>`, mPic.tabs + mPic.html),
    "h-rpl": card(`Target & actual theo khung ngày · Product line${note} <span class="muted" style="font-weight:400;font-size:13px">${range} · time gone ${pct(d.gone_range, 1)}</span>`,
      hrTav("rpl", d.range.pls, plTav, d.gone_range, "Không có dữ liệu") + legend(d.gone_range)),
    "h-rsku": card(`Target & actual theo khung ngày · SKU${note} <span class="muted" style="font-weight:400;font-size:13px">${range}</span>`, hrTav("rsku", d.range.skus, skuTav, d.gone_range, "Không có SKU")),
    "h-mpl": card(`Target & actual cả tháng ${d.month} · Product line${note} <span class="muted" style="font-weight:400;font-size:13px">không theo bộ lọc ngày · time gone ${pct(d.gone_month, 1)}</span>`,
      hrTav("mpl", d.month_tbl.pls, plTav, d.gone_month, "Không có dữ liệu") + legend(d.gone_month) +
      `<p class="muted" style="font-size:12px;margin:4px 0 0">Actual tháng = raw_sso_us (theo ngày) đến ${d.raw_last ? ddmm(d.raw_last) : "—"} + file hourly các ngày sau (ngày ${ddmm(last.date)} luôn lấy từ file hourly).</p>`),
    "h-msku": card(`Target & actual cả tháng ${d.month} · SKU${note}`, hrTav("msku", d.month_tbl.skus,
      [...skuTav, ["Current stock", (r) => pfStock(r.stock), "n"], ["Ineligible status", (r) => pfInelig(r.ineligible)]], d.gone_month, "Không có SKU")),
  });
  for (const table of ["sku", "pl"]) hrFilterRows(table);
  drawHourCharts(d);
}
// feedback #84: Performance Review's change-driver card (drvCard) on the hourly file – a day vs the day before, with the
// tab's PIC / Sales Leader / PL / SKU filters; default the latest day (followed when a new day arrives). The latest day is
// partial, so it is compared hour-to-date: both days cut at its last data hour (hourly.hourly_drivers).
S.hrDrvOpen = S.hrDrvOpen || new Set();
async function hrDrvLoad(day) {
  const req = { day, hr: S.hr };
  if (S.hrDrvReq && S.hrDrvReq.day === day && S.hrDrvReq.hr === req.hr) return;  // already in flight
  S.hrDrvReq = req;
  const f = S.hr.filters;
  const r = await api.hourly_drivers({ pic: f.pic, leader: f.leader, pl: f.pl, sku: f.sku }, day, S.hrRunId);
  if (S.hrDrvReq !== req) return;  // superseded by another day / a reload
  S.hrDrvReq = null;
  S.hrDrv = { ...r, day, hr: req.hr };
  hrDrvRedraw();
}
function hrDrivers(note) {
  const ff = S.hr.filters, days = [];
  for (let t = Date.parse(`${ff.min}T00:00:00Z`); t <= Date.parse(`${ff.max}T00:00:00Z`); t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
  const day = days.includes(S.hrDrvDay) ? S.hrDrvDay : ff.max;  // null = the latest day
  const d = S.hrDrv && S.hrDrv.day === day && S.hrDrv.hr === S.hr ? S.hrDrv : null;
  if (!d) hrDrvLoad(day);
  const cut = d && d.hour != null ? ` · hour-to-date, cả 2 ngày đến hết khung <b class="num">${hh(d.hour)}</b>` : "";
  return drvCard("hr", d, { days, day, p: "day", was: "hôm trước", note, cut, help: "Ngày chọn so với ngày liền trước, từ file hourly. Ngày mới nhất chưa đủ 24h nên so hour-to-date: cả 2 ngày cùng tính đến hết khung giờ cuối có data; các ngày trước so cả ngày. Mọi PL (bấm ▸ để xem các SKU), xếp theo độ lớn của Δ đang chọn · RS = Real Sale (units). Đóng góp Δ TACOS = (Δ Ads Spend − TACOS cả phạm vi hôm trước × Δ GMV) / GMV cả phạm vi ngày chọn; cộng các dòng PL = thay đổi TACOS của cả phạm vi (dương = kéo TACOS lên)." });
}
function hrDrvRedraw() { drvRedraw($('#hr-body [data-w="h-drv"]'), () => hrDrivers(S.hrDrvNote)); }
document.addEventListener("change", (e) => {
  if (e.target.id === "hr-drv-day") { S.hrDrvDay = e.target.value === S.hr.filters.max ? null : e.target.value; hrDrvRedraw(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#hr-body")) return;
  const drv = e.target.closest("[data-drvm]");
  if (drv) { S.hrDrvM = drv.dataset.drvm; hrDrvRedraw(); return; }
  const dpl = e.target.closest("tr[data-drvpl]");
  if (dpl) { const k = dpl.dataset.drvpl; S.hrDrvOpen.has(k) ? S.hrDrvOpen.delete(k) : S.hrDrvOpen.add(k); hrDrvRedraw(); }
});
// feedback #43: hour-by-hour comparison charts over the filtered scope and date range
function drawHourCharts(d) {
  const pal = SERIES[isDark() ? "dark" : "light"], grey = cssVar("--muted"), labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}h`);
  const live = d.filters.end === d.last.date ? d.last.hour : 23;  // hours after the last data hour have no data yet
  const at = (hours, k) => hours.map((c) => (c ? c[k] : 0));
  const money0 = { ticks: { callback: (v) => money(v) }, beginAtZero: true };
  drawChart("hr-c1", { type: "bar", data: { labels, datasets: [
    { label: "GMV", data: at(d.total_hours.hours, "gmv"), backgroundColor: pal[0], borderRadius: 3, yAxisID: "y", order: 2 },
    { label: "Ads Spend", data: at(d.total_hours.hours, "spend"), backgroundColor: pal[1], borderRadius: 3, yAxisID: "y", order: 2 },
    { type: "line", label: "TACOS", data: d.total_hours.hours.map((c) => (c ? c.tacos : null)), borderColor: pal[2], backgroundColor: pal[2], borderWidth: 2, pointRadius: 2, yAxisID: "y2", order: 1, spanGaps: true }] },
  options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.dataset.yAxisID === "y2" ? pct(c.raw, 1) : money(c.raw)}` } } },
    scales: { x: { grid: { display: false } }, y: money0, y2: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { callback: (v) => pct(v) } } } } });
  const tgt = d.range.total.target, cum = (k) => { let a = 0; return d.total_hours.hours.map((c, h) => { a += c ? c[k] : 0; return h > live || !tgt[k] ? null : a / tgt[k]; }); };
  const ln = (label, data, color, dash) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, borderDash: dash || [], spanGaps: false });
  drawChart("hr-c2", { type: "line", data: { labels, datasets: [ln("GMV", cum("gmv"), pal[0]), ln("RS", cum("rs"), pal[3]), ln("Ads Spend", cum("spend"), pal[1]),
    ln("Time gone", labels.map((_, h) => (h + 1) / 24), grey, [5, 4])] },
  options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.raw, 1)}` } } },
    scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => pct(v) } } } } });
  // feedback #55: traffic per hour – a series whose column the hourly file lacks is left out
  const tr = d.traffic_hours, has = (k) => !tr.missing.includes(k), cnt = (v) => (num(v) ? rhu(v).toLocaleString("en-US") : "—");
  const trv = (k, gap) => tr.hours.map((c, h) => (h > live ? null : c ? c[k] : gap));
  if (tr.missing.length === 3) emptyChart("hr-c4", "File hourly chưa có cột Impression / Glance view / Click.");
  else drawChart("hr-c4", { type: "bar", data: { labels, datasets: [
    has("impressions") && { label: "Impression", data: trv("impressions", 0), backgroundColor: pal[0], borderRadius: 3, yAxisID: "y", order: 2 },
    has("glance_views") && { ...ln("Glance view", trv("glance_views", null), pal[3]), type: "line", pointRadius: 2, yAxisID: "y2", order: 1 },
    has("clicks") && { ...ln("Click", trv("clicks", null), pal[1]), type: "line", pointRadius: 2, yAxisID: "y2", order: 1 }].filter(Boolean) },
  options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${cnt(c.raw)}` } } },
    scales: { x: { grid: { display: false } }, y: { beginAtZero: true, display: has("impressions"), ticks: { callback: cnt } },
      y2: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { callback: cnt } } } } });
  // feedback #85: CPC per hour (Σ spend / Σ clicks, from the backend), solid = this period, dashed = the one before;
  // 0 clicks or after the last data hour → gap
  const cp = d.cpc_hours || { missing: true }, cpcAt = (hours, cut) => hours.map((c, h) => (h > cut || !c ? null : c.cpc));
  if (cp.missing) emptyChart("hr-cpc", "File hourly chưa có cột Click (sp_clicks / sb_clicks / sd_clicks).");
  else drawChart("hr-cpc", { type: "line", data: { labels, datasets: [{ ...ln("CPC", cpcAt(cp.hours, live), pal[2]), pointRadius: 2 },
    cp.prev && { ...ln("CPC kỳ trước", cpcAt(cp.prev.hours, 23), pal[2], [5, 4]), pointRadius: 2 }].filter(Boolean) },
  options: { plugins: { tooltip: { callbacks: { label: (c) => {
    const x = (c.datasetIndex ? cp.prev : cp).hours[c.dataIndex];
    return `${c.dataset.label}: ${price(c.raw)} (${price(x.spend)} / ${rhu(x.clicks).toLocaleString("en-US")} click)`;
  } } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => price(v) } } } } });
  const pv = d.prev_hours;
  if (!pv) { emptyChart("hr-c3", "Chưa có data kỳ trước trong file hourly."); return; }
  const cur = (k) => d.total_hours.hours.map((c, h) => (h > live ? null : c ? c[k] : 0));
  drawChart("hr-c3", { type: "line", data: { labels, datasets: [ln("GMV", cur("gmv"), pal[0]), ln("GMV kỳ trước", at(pv.hours, "gmv"), pal[0], [5, 4]),
    ln("Ads Spend", cur("spend"), pal[1]), ln("Ads Spend kỳ trước", at(pv.hours, "spend"), pal[1], [5, 4])] },
  options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.raw)}` } } }, scales: { x: { grid: { display: false } }, y: money0 } } });
}
function hrFilterRows(table) {
  const body = $(`#hr-${table}-body`), q = ((S.hrQ || {})[table] || "").trim().toLowerCase();
  if (!body) return;
  for (const tr of body.rows) if (tr.dataset.q !== undefined) tr.style.display = !q || tr.dataset.q.includes(q) ? "" : "none";
  hrTotRedraw(body.closest("table"));
}
document.addEventListener("input", (e) => {
  const t = e.target.dataset && e.target.dataset.hrq;
  if (!t) return;
  S.hrQ = { ...(S.hrQ || {}), [t]: e.target.value };
  hrFilterRows(t);
});
document.addEventListener("click", async (e) => {
  const m = e.target.closest("[data-hrm]");
  if (m) { const [table, k] = m.dataset.hrm.split(":"); S.hrM[table] = k; renderHourly(); return; }
  if (e.target.closest("#hr-reload")) {  // SharePoint file: download it now (signing in if the session is over)
    const r = await api.hourly_refresh();
    if (r && r.sp_error) toast(r.sp_error, true);
    S.hrStale = true; loadHourly(true); return;
  }
  if (e.target.closest("#hr-pick")) {
    const r = await api.pick_hourly();
    if (r.error) { toast(r.error, true); return; }
    if (r.path) { S.hrStale = true; loadHourly(true); }
  }
});
document.addEventListener("change", (e) => { if (e.target.matches("#hr-start, #hr-end")) loadHourly(true); });
// feedback #79: quick ranges by the hourly file's days – "Hôm nay" = the file's last day (the file can lag the clock),
// L3D / L7D / Tuần này (from Monday) / Tháng này end on it; a start before the file's first day is clamped to it.
function hrPresetRange(k, min, max) {
  const add = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const s = { yd: add(max, -1), td: max, l3d: add(max, -2), l7d: add(max, -6), mo: max.slice(0, 8) + "01",
    wk: add(max, -((new Date(max + "T00:00:00Z").getUTCDay() + 6) % 7)) }[k];
  const e = k === "yd" ? s : max;
  return e < min ? null : [s < min ? min : s, e];  // null: the file has no such day (Hôm qua on a one-day file)
}
function hrPresetMark() {
  const ff = S.hr && S.hr.filters, s = $("#hr-start").value, e = $("#hr-end").value;
  for (const b of document.querySelectorAll("[data-hrp]")) {
    const r = ff && hrPresetRange(b.dataset.hrp, ff.min, ff.max);
    b.disabled = !r; b.setAttribute("aria-pressed", String(!!r && r[0] === s && r[1] === e));
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hrp]");
  const r = b && S.hr && !S.hrLoading && hrPresetRange(b.dataset.hrp, S.hr.filters.min, S.hr.filters.max);
  if (!r) return;
  $("#hr-start").value = r[0]; $("#hr-end").value = r[1]; hrPresetMark(); loadHourly(true);
});
setInterval(async () => {  // new data in the hourly file → reload
  if (!api || S.hrLoading || !(S.hr || $("#hourly").classList.contains("on"))) return;
  const st = await api.hourly_status();
  if (!st || st.error || !st.sig || st.sig === S.hrSig) return;
  S.hrSig = st.sig;  // a file that fails to read is retried on its next change, not every minute
  if ($("#hourly").classList.contains("on")) { S.hrStale = true; loadHourly(true, true); } else S.hrStale = true;
}, 60000);
// Lead: share the hourly data with Members / Operators (hourly_push only uploads when the file, the newest report or
// the team's devices changed – the SharePoint copy itself is downloaded about hourly)
async function pushHourly() {
  if (!api || !(S.role && S.role.signed_in && RUNNER(S.role))) return;
  const r = await api.hourly_push();
  if (!r || !r.pushed || !S.hr) return;
  S.hr.source.team_share = r.shared;
  if ($("#hourly").classList.contains("on")) renderHourly();
}
setInterval(pushHourly, 5 * 60 * 1000);

// ---- Dashboard extras
function dashExtras(sc) {
  const named = sc.pics.filter((p) => p.pic !== NO_PIC);
  return {
    "d-excess": chartCard("Excess spend theo PIC", "ch-x-excess", "Spend L7D vượt mức hợp lý theo ACoS target – cộng các campaign alert mới."),
    "d-action": chartCard("Tỉ lệ action & cải thiện theo PIC", "ch-x-action", "Action 7 ngày = camp alert được action trong 7 ngày; Đang cải thiện = action đang có kết quả tốt."),
    "d-target": `<div class="card"><h2>Target tháng theo PIC</h2><div class="tbl"><table>
      <thead><tr><th>PIC</th><th class="n">Số PL</th><th class="n">GMV target</th><th class="n">GMV MTD</th><th class="n">% GMV</th><th class="n">Spend target</th><th class="n">Spend MTD</th><th class="n">% spend</th><th class="n">TACoS</th><th class="n">TACoS target</th></tr></thead>
      <tbody>${named.map((p) => { const v = p.values; return `<tr><td>${esc(p.pic)}</td><td class="n">${v.pl_count}</td><td class="n">${money(v.target_gmv)}</td><td class="n">${money(v.gmv_mtd)}</td>
        <td class="n">${pfAchieve(v.gmv_pct, "gmv", sc.time_gone)}</td><td class="n">${money(v.target_spend)}</td><td class="n">${money(v.spend_mtd)}</td>
        <td class="n">${pfAchieve(v.spend_pct, "spend", sc.time_gone)}</td><td class="n">${pct(v.tacos, 1)}</td><td class="n">${pct(v.target_tacos, 1)}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Time gone ${pct(sc.time_gone)}: % GMV <b style="color:var(--ok)">xanh</b> khi ≥ time gone, % spend xanh khi ≤ time gone.</p></div>`,
    "d-daily": dailyPicCard(S.db.daily_pic),
  };
}
// Per PIC, grouped by metric: Target / Actual / %Achieve on adjacent rows (rows with no data, e.g. Promotion target, are left out).
// Every row carries PIC + metric so the column filter and "Tải bảng" export stay flat; repeats are only hidden visually (.rep).
const DAILY_ROWS = [["gmv", "GMV", "money"], ["spend", "PPC", "money"], ["tacos", "TACOS", "pct"], ["rs", "RS", "int"], ["promo", "Promotion", "money"], ["promo_gmv", "%Promo/GMV", "pct"]];
function dailyPicCard(dp) {
  if (!dp) return "";
  // feedback #83: with "Tất cả PIC", a Tổng team block (sums; TACOS / %Promo/GMV / %Achieve from the sums) comes first
  const team = !S.dbDaily && dp.team && dp.pics.length > 1 ? [{ pic: "Tổng team", rows: dp.team.rows, team: true }] : [];
  const pics = [...team, ...dp.pics.filter((p) => !S.dbDaily || p.pic === S.dbDaily)];
  const wd = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const dcls = dp.days.map((d) => { const w = new Date(d + "T00:00").getDay(); return [w === 0 || w === 6 ? "we" : "", d === dp.as_of ? "today" : d > dp.as_of ? "fut" : ""].join(" "); });
  const cols = [["mtd", "sum"], ["month", "sum end"], ...dp.days.map((_, i) => [i, dcls[i]])];
  const ach = (v, key) => (v == null ? ["", ""] : [pct(v, 1), (key === "gmv" || key === "rs" ? v >= 1 : v <= 1) ? "ok" : "bad"]);
  const body = pics.map((p) => p.rows.flatMap((r, ri) => {
    const [, label, f] = DAILY_ROWS.find((x) => x[0] === r.key);
    return [["target", "Target"], ["actual", "Actual"], ["achieve", "%Achieve"]].filter(([g]) => r[g]).map(([g, gl], gi) =>
      `<tr class="${[ri === 0 && gi === 0 ? "pic" : "", gi === 0 ? "met" : "", ri % 2 ? "odd" : "", g, p.team ? "team" : ""].join(" ")}"><td class="${ri || gi ? "rep" : ""}"><b>${esc(p.pic)}</b></td><td class="${gi ? "rep" : ""}"><b>${label}</b></td><td>${gl}</td>${cols.map(([i, c]) => {
        const v = typeof i === "number" ? r[g].days[i] : r[g][i];
        if (g !== "achieve") return `<td class="n ${c}">${v == null ? "" : pfFmt[f](v)}</td>`;
        const [t, k] = ach(v, r.key);
        return `<td class="n ${c} ${k}">${t}</td>`;
      }).join("")}</tr>`);
  }).join("")).join("");
  return `<div class="card"><div style="display:flex;gap:8px;align-items:center"><h2 style="margin:0">Target vs actual theo ngày từng PIC</h2><span style="flex:1"></span>
      <select id="db-daily" style="width:auto"><option value="">Tất cả PIC</option>${dp.pics.map((p) => `<option ${p.pic === S.dbDaily ? "selected" : ""}>${esc(p.pic)}</option>`).join("")}</select></div>
    <div class="tbl dp" style="margin-top:8px"><table><thead><tr><th>PIC</th><th>Chỉ số</th><th>Loại</th><th class="n sum">MTD</th><th class="n sum end">Cả tháng</th>${dp.days.map((d, i) => `<th class="n ${dcls[i]}">${wd[new Date(d + "T00:00").getDay()]}<br>${ddmm(d)}</th>`).join("")}</tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted" style="text-align:center">Không có PIC</td></tr>'}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">Time gone ${pct(dp.time_gone)}. Target ngày = target tháng (KPI) × %Contribution của ngày (sheet Summary; không có thì chia đều). Actual cả tháng = MTD ÷ phần tháng đã qua theo %Contribution. %Achieve xanh khi GMV/RS ≥ 100%, PPC/TACOS/Promotion ≤ 100%. Promotion chưa có target trong dữ liệu đang đọc.</p>
    <p class="muted" style="font-size:12px;margin:2px 0 0">Cột tô xanh = hôm nay, nền xám = cuối tuần, ngày tương lai làm mờ.</p></div>`;
}
function drawDashExtras(sc) {
  const pics = sc.pics.map((p) => p.pic), named = sc.pics.filter((p) => p.pic !== NO_PIC), pal = SERIES[isDark() ? "dark" : "light"];
  if (document.getElementById("ch-x-excess"))
    drawChart("ch-x-excess", hbar(named.map((p) => p.pic), named.map((p) => p.values.excess_new), named.map((p) => picColor(p.pic, pics)), money));
  if (document.getElementById("ch-x-action"))
    drawChart("ch-x-action", { type: "bar", data: { labels: named.map((p) => p.pic), datasets: [
      { label: "Action 7 ngày", data: named.map((p) => p.values.action_rate), backgroundColor: pal[0], borderRadius: 4, barThickness: 14 },
      { label: "Đang cải thiện", data: named.map((p) => p.values.followup_success), backgroundColor: pal[2], borderRadius: 4, barThickness: 14 }] },
    options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.raw, 1)}` } } }, scales: { y: { beginAtZero: true, max: 1, ticks: { callback: (v) => pct(v) } }, x: { grid: { display: false } } } } });
}

// ---- layout window: drag to reorder, pick widths, remove / add widgets; saved to settings for every page
const LAY = { page: "results", draft: null, drag: null };
function openLayout(page) {
  LAY.page = page;
  LAY.draft = Object.fromEntries(Object.keys(WIDGETS).map((p) => [p, layoutOf(p).map((w) => ({ ...w }))]));
  $("#lay").classList.add("on");
  renderLayout();
}
function renderLayout() {
  const page = LAY.page, list = LAY.draft[page], label = Object.fromEntries(WIDGETS[page].map((w) => [w[0], w]));
  const extra = (k) => !label[k][3];
  $("#lay-pages").innerHTML = Object.keys(WIDGETS).map((p) => `<button aria-pressed="${p === page}" data-lay-page="${p}">${PAGE_NAME[p]}</button>`).join("");
  $("#lay-grid").innerHTML = list.map((w, i) => `<div class="lay-blk${extra(w.key) ? " new" : ""}" draggable="true" data-i="${i}" style="grid-column:span ${w.span}">
      <div class="lay-top"><span class="grip" aria-hidden="true">⋮⋮</span><b>${esc(label[w.key][1])}</b>${extra(w.key) ? '<span class="sev OK">Mới</span>' : ""}</div>
      <div class="lay-ctl">
        <button class="btn sm ghost" data-lay-mv="-1" aria-label="Lên trước" ${i ? "" : "disabled"}>‹</button>
        <button class="btn sm ghost" data-lay-mv="1" aria-label="Xuống sau" ${i < list.length - 1 ? "" : "disabled"}>›</button>
        <select data-lay-span aria-label="Độ rộng">${SPANS.map(([n, l]) => `<option value="${n}" ${n === w.span ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span style="flex:1"></span><button class="btn sm ghost" data-lay-rm aria-label="Bỏ khung này"><svg class="i"><use href="#x"/></svg></button></div></div>`).join("")
    || '<div class="empty" style="grid-column:1/-1">Trang trống – thêm khung ở dưới.</div>';
  const hidden = WIDGETS[page].filter((w) => !list.some((x) => x.key === w[0]));
  $("#lay-add").innerHTML = hidden.length ? hidden.map(([k, l, , def]) => `<button class="btn sm" data-lay-add="${k}"><svg class="i" aria-hidden="true"><use href="#plus"/></svg>${esc(l)}${def ? "" : ' <span class="sev OK">Mới</span>'}</button>`).join("")
    : '<span class="muted" style="font-size:12px">Tất cả khung đều đang hiện.</span>';
}
async function saveLayout() {
  const def = (p) => JSON.stringify(LAY.draft[p]) === JSON.stringify(defaultLayout(p));
  const layouts = Object.fromEntries(Object.keys(WIDGETS).filter((p) => !def(p)).map((p) => [p, LAY.draft[p]]));  // default pages stay unsaved: they follow app updates
  layouts.seen = NEW_WIDGETS.map(([p, k]) => `${p}:${k}`);  // laid out (or removed) by the user from now on
  const r = await api.save_settings({ layouts });
  if (bad(r)) return;
  S.layouts = layouts;
  $("#lay").classList.remove("on");
  if (S.run && S.pic) renderResults();
  if (S.pf) renderPerf();
  if (S.db) renderDashboard();
  if (S.hr) renderHourly();
  toast("Đã lưu bố cục");
}
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-layout]");
  if (open) { openLayout(open.dataset.layout); return; }
  if (!e.target.closest("#lay")) return;
  const list = LAY.draft && LAY.draft[LAY.page], blk = e.target.closest(".lay-blk"), i = blk ? +blk.dataset.i : -1;
  let b;
  if ((b = e.target.closest("[data-lay-page]"))) LAY.page = b.dataset.layPage;
  else if ((b = e.target.closest("[data-lay-add]"))) list.push({ key: b.dataset.layAdd, span: WIDGETS[LAY.page].find((w) => w[0] === b.dataset.layAdd)[2] });
  else if (e.target.closest("[data-lay-rm]")) list.splice(i, 1);
  else if ((b = e.target.closest("[data-lay-mv]"))) { const j = i + +b.dataset.layMv; [list[i], list[j]] = [list[j], list[i]]; }
  else if (e.target.closest("#lay-reset")) LAY.draft[LAY.page] = defaultLayout(LAY.page);
  else if (e.target.closest("#lay-save")) { saveLayout(); return; }
  else if (e.target.closest("#lay-close,#lay-cancel") || e.target.id === "lay") { $("#lay").classList.remove("on"); return; }
  else return;
  renderLayout();
});
document.addEventListener("change", (e) => {
  const sel = e.target.closest("#lay [data-lay-span]");
  if (sel) { LAY.draft[LAY.page][+sel.closest(".lay-blk").dataset.i].span = +sel.value; renderLayout(); }
});
document.addEventListener("dragstart", (e) => {
  const blk = e.target.closest && e.target.closest(".lay-blk");
  if (!blk) return;
  LAY.drag = +blk.dataset.i; blk.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", blk.dataset.i);
});
document.addEventListener("dragover", (e) => {
  const blk = LAY.drag != null && e.target.closest && e.target.closest(".lay-blk");
  if (!blk) return;
  e.preventDefault();
  const r = blk.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
  $$(".lay-blk").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  blk.classList.add(after ? "drop-after" : "drop-before");
});
document.addEventListener("drop", (e) => {
  const blk = LAY.drag != null && e.target.closest && e.target.closest(".lay-blk");
  if (!blk) return;
  e.preventDefault(); e.stopPropagation();  // not a file drop
  const list = LAY.draft[LAY.page], from = LAY.drag, r = blk.getBoundingClientRect();
  let to = +blk.dataset.i + (e.clientX > r.left + r.width / 2 ? 1 : 0);
  const [w] = list.splice(from, 1);
  if (from < to) to -= 1;
  list.splice(to, 0, w);
  LAY.drag = null; renderLayout();
});
document.addEventListener("dragend", () => { LAY.drag = null; $$(".lay-blk").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after")); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lay").classList.remove("on"); });
