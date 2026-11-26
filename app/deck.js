"use strict";
// Slide renderer shared by the main window (editor + presenter view) and present.html (audience screen).
// A slide is data from deck.py: cat, sec, title, kpis, chart, items, insight, notes. Clickable things carry
// data-pop="kpi:i" | "item:i" | "bar:i" (detail popup – the host decides whether to open it locally or mirror it)
// or data-go="i" (agenda: jump to slide i).
// Layout rule: nothing on a slide may be clipped or overlap. fit() shrinks the slide's type scale (--k) until
// every box fits; at the floor it switches to .tight (2-line items, full text in the popup).
const Deck = (() => {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PAL = ["#FF7A2F", "#F5B700", "#3DD6B5", "#6EA8FF", "#FF6F9C", "#B58CFF", "#9BE15D", "#FFA26B"];  // series on the dark stage
  const SEC = ["#FF7A2F", "#F5B700", "#3DD6B5", "#6EA8FF", "#FF8FB1", "#B9A2FF", "#A5E26A", "#FFB38A", "#7FD3FF"];  // section tabs
  const fmt = {
    money: (v) => (v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US")),
    pct: (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%"),
    n: (v) => (v == null ? "—" : String(v)),
  };
  const charts = new WeakMap(), last = new WeakMap();
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1c.6 5.6 4.4 9.4 11 11-6.6 1.6-10.4 5.4-11 11-.6-5.6-4.4-9.4-11-11 6.6-1.6 10.4-5.4 11-11z"/></svg>';

  // Sections in slide order: [{cat, label, i (first slide), L (letter), c (colour)}]
  function sections(slides) {
    const out = [];
    (slides || []).forEach((s, i) => { if (s.sec && !out.some((x) => x.cat === s.cat)) out.push({ cat: s.cat, label: s.sec, i }); });
    return out.map((x, k) => ({ ...x, L: String.fromCharCode(65 + k), c: SEC[k % SEC.length] }));
  }
  const secOf = (slides, slide) => slide && sections(slides).find((x) => x.cat === slide.cat);

  const kpi = (x, i) => `<button class="sl-kpi ${esc(x.tone)}" data-pop="kpi:${i}" style="--d:${i}">
    <span class="lbl">${esc(x.label)}</span><span class="val">${esc(x.value)}</span>${x.detail ? '<span class="more">+</span>' : ""}</button>`;
  const foot = (o) => `<div class="sl-foot"><span>PMKT Alert · ${esc(o.asOf || "")}</span>
    <span class="sl-prog" style="--p:${(o.n / o.total) * 100}%;--p0:${((o.n - o.dir) / o.total) * 100}%"><i></i></span><span class="num">${o.n} / ${o.total}</span></div>`;

  // Cover: big title left, honeycomb right (three hexes carry the cover KPIs, the rest are decoration).
  const HEX = [  // [left, top] in cqw; flat-top hexes 17cqw wide on a honeycomb
    [46, 9.6, "or"], [46, 25.3, "ring"], [59.75, 1.75, "lines"], [59.75, 17.45, 0], [59.75, 33.15, "y"],
    [73.5, 9.6, 1], [73.5, 25.3, 2], [73.5, 41, "dark"], [87.25, 1.75, "y"], [87.25, 17.45, "bars"], [87.25, 33.15, "or"]];
  const DECO = {
    lines: '<svg viewBox="0 0 100 86" preserveAspectRatio="none"><polyline points="8,62 24,48 38,55 54,30 70,38 92,14" /></svg>',
    bars: '<svg viewBox="0 0 100 86" preserveAspectRatio="none"><rect x="22" y="44" width="10" height="24"/><rect x="38" y="30" width="10" height="38"/><rect x="54" y="38" width="10" height="30"/><rect x="70" y="18" width="10" height="50"/></svg>',
  };
  function cover(slide) {
    const k = slide.kpis || [];
    return `<div class="sl sl-cover" data-no-i18n><div class="cv-frame"></div>
      <div class="cv-text"><div class="cv-kick">PMKT Alert · Report</div><h1 class="sl-title">${esc(slide.title)}</h1>
        ${slide.insight ? `<p class="cv-sub">${esc(slide.insight)}</p>` : ""}<div class="cv-dots"></div></div>
      <div class="cv-hx">${HEX.map(([x, y, t], j) => {
        const pos = `style="left:${x}cqw;top:${y}cqw;--d:${j}"`;
        if (typeof t === "number") return k[t] ? `<button class="hx hx-kpi ${esc(k[t].tone)}" data-pop="kpi:${t}" ${pos}><span class="val">${esc(k[t].value)}</span><span class="lbl">${esc(k[t].label)}</span></button>` : `<div class="hx hx-dark" ${pos}></div>`;
        return `<div class="hx hx-${t}" ${pos}>${DECO[t] || ""}</div>`;
      }).join("")}</div>
    </div>`;
  }

  function agenda(slide, slides, o) {
    const secs = sections(slides);
    return `<div class="sl sl-agenda" data-no-i18n>
      <div class="sl-head"><span class="sl-kick"><i class="bar"></i>Agenda</span><h2 class="sl-title">${esc(slide.title)}</h2></div>
      <div class="sl-main ag">${secs.map((s, k) => `<button class="ag-s" data-go="${s.i}" style="--c:${s.c};--d:${k};--n:${secs.length}">
        <span class="ag-L">${s.L}</span><span class="ag-t">${esc(s.label)}</span><span class="ag-n num">${String(s.i + 1).padStart(2, "0")}</span></button>`).join("")}</div>
      ${slide.insight ? `<div class="sl-side"><div class="sl-insight">${STAR}<span>${esc(slide.insight)}</span></div></div>` : ""}
      ${foot(o)}</div>`;
  }

  function content(slide, sec, o) {
    const k = slide.kpis || [], items = slide.items || [], split = !!(slide.chart && slide.insight);
    return `<div class="sl sl-${esc(slide.cat)}${split ? " split" : ""}" data-no-i18n>
      <div class="sl-head"><span class="sl-kick">${sec ? `<b class="sl-tab" style="--c:${sec.c}">${sec.L}</b>${esc(sec.label)}` : '<i class="bar"></i>'}</span>
        <h2 class="sl-title">${esc(slide.title)}</h2></div>
      <div class="sl-main">
        ${k.length ? `<div class="sl-kpis" data-n="${k.length}">${k.map(kpi).join("")}</div>` : ""}
        ${slide.chart ? '<div class="sl-chart"><canvas></canvas></div>' : ""}
        ${items.length ? `<ul class="sl-items${items.length > 4 ? " cols" : ""}">${items.map((x, i) => `<li style="--d:${i + k.length}"><button class="${esc(x.tone)}" data-pop="item:${i}">
          <span class="tx">${esc(x.text)}</span>${x.detail ? '<span class="more">+</span>' : ""}</button></li>`).join("")}</ul>` : ""}
      </div>
      ${slide.insight ? `<div class="sl-side"><div class="sl-insight">${STAR}<span>${esc(slide.insight)}</span></div></div>` : ""}
      ${foot(o)}</div>`;
  }

  // Shrink the type scale until nothing overflows; floor 0.62, then .tight.
  function fit(sl) {
    if (!sl.isConnected || !sl.clientHeight) return;  // hidden (e.g. next-slide preview in one-screen mode)
    sl.style.removeProperty("--k"); sl.classList.remove("tight");
    const boxes = [sl, ...sl.querySelectorAll(".sl-main,.sl-items,.sl-kpis,.sl-side,.sl-insight,.cv-text,.val,.sl-title,.ag-s,.hx-kpi")];
    const over = () => boxes.some((b) => b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1);
    for (let k = 1; over() && k > 0.62;) { k -= 0.04; sl.style.setProperty("--k", k.toFixed(2)); }
    if (over()) sl.classList.add("tight");
  }

  // Numbers count up from 0 to their value, keeping the original format ("$12,345", "37.5%", "3 / 5").
  function countUp(sl, delay) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    sl.querySelectorAll(".val").forEach((v, j) => {
      const txt = v.textContent, re = /\d[\d,]*(?:\.\d+)?/g;
      if (!re.test(txt)) return;
      const step = (t0) => (t) => {
        if (!v.isConnected) return;
        const p = Math.min(1, (t - t0) / 1000), e = 1 - (1 - p) ** 3;
        v.textContent = p >= 1 ? txt : txt.replace(re, (m) => {
          const dec = (m.split(".")[1] || "").length, n = parseFloat(m.replace(/,/g, "")) * e;
          return m.includes(",") ? n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : n.toFixed(dec);
        });
        if (p < 1) requestAnimationFrame(step(t0));
      };
      setTimeout(() => requestAnimationFrame((t) => step(t)(t)), delay + j * 90);
    });
  }

  function chart(el, sl, c, animate, delay, onBar) {
    const canvas = sl.querySelector(".sl-chart canvas");
    if (!canvas || !window.Chart) return;
    const st = getComputedStyle(el), ink = st.getPropertyValue("--s-mut").trim(), grid = st.getPropertyValue("--s-line").trim(), f = fmt[c.fmt] || fmt.n;
    const h = c.kind === "hbar", cut = (s) => (String(s).length > 30 ? String(s).slice(0, 29) + "…" : s);  // full label in the popup
    const size = Math.max(11, Math.round(el.clientWidth / 85));
    const fam = "'Fira Sans', system-ui, sans-serif", tick = { color: ink, font: { size, family: fam } };
    const ref = c.ref == null ? [] : [{ id: "ref", afterDatasetsDraw(ch) {
      const sc = ch.scales[h ? "x" : "y"], p = sc.getPixelForValue(c.ref), a = ch.chartArea, x = ch.ctx;
      x.save(); x.setLineDash([6, 5]); x.lineWidth = 2; x.strokeStyle = "#F5B700"; x.beginPath();
      if (h) { x.moveTo(p, a.top); x.lineTo(p, a.bottom); } else { x.moveTo(a.left, p); x.lineTo(a.right, p); }
      x.stroke(); x.fillStyle = "#F5B700"; x.font = `600 ${size}px ${fam}`;
      const right = p > (a.left + a.right) / 2;  // label on the side with room, never past the plot edge
      x.textAlign = right ? "right" : "left";
      if (h) x.fillText("time gone " + f(c.ref), p + (right ? -6 : 6), a.top - 6);
      x.restore();
    } }];
    const ch = new Chart(canvas, {
      type: c.kind === "line" ? "line" : "bar", plugins: ref,
      data: { labels: c.labels, datasets: c.series.map((s, i) => ({ label: s.name, data: s.data, backgroundColor: PAL[i % 8], borderColor: PAL[i % 8],
        borderRadius: 6, borderSkipped: false, maxBarThickness: 40, tension: 0.35, borderWidth: c.kind === "line" ? 3 : 0,
        pointRadius: 4, pointHoverRadius: 9, pointBackgroundColor: PAL[i % 8], hoverBackgroundColor: PAL[i % 8] + "cc" })) },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: h ? "y" : "x", layout: { padding: { top: c.ref != null && h ? size + 8 : 4 } },
        animation: animate ? { duration: 1100, easing: "easeOutQuart", delay: (x) => (x.type === "data" && x.mode === "default" ? delay + x.dataIndex * 70 : 0) } : false,
        interaction: { mode: c.kind === "line" ? "index" : "nearest", intersect: false },
        onHover: (e, act) => { e.native.target.style.cursor = act.length ? "pointer" : "default"; },
        onClick: (e, act) => { if (act.length) onBar(act[0].index); },
        plugins: { legend: { display: c.series.length > 1, position: "bottom", labels: { ...tick, color: ink, usePointStyle: true, boxWidth: 10 } },
          tooltip: { titleFont: { size, family: fam }, bodyFont: { size, family: fam }, footerFont: { size: size - 1, family: fam }, padding: 10,
            callbacks: { label: (t) => `${t.dataset.label}: ${f(t.raw)}`, footer: () => (window.I18N ? I18N.t("Bấm để xem chi tiết") : "Bấm để xem chi tiết") } } },
        scales: { [h ? "x" : "y"]: { beginAtZero: true, ticks: { ...tick, callback: (v) => f(v) }, grid: { color: grid }, border: { display: false } },
          [h ? "y" : "x"]: { ticks: { ...tick, color: st.getPropertyValue("--s-fg").trim(), callback(v) { return cut(this.getLabelForValue(v)); } }, grid: { display: false }, border: { display: false } } } },
    });
    charts.set(el, ch);
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => charts.get(el) === ch && ch.update("none"));
  }

  // Render slide `opts.i` of `opts.slides` into `el`.
  // opts: {slides, i, asOf, animate, onPop(pop|null), onGo(i)}. With animate, the previous slide leaves under a wipe.
  function render(el, slide, opts = {}) {
    const slides = opts.slides || [slide], i = opts.i ?? 0, prev = last.get(el), dir = prev == null || i >= prev ? 1 : -1;
    last.set(el, i);
    const old = opts.animate && slide && el.querySelector(":scope > .sl:not(.sl-out)");
    if (old) {  // freeze the old chart as an image so it can leave with its slide
      const c = old.querySelector("canvas");
      try { if (c) { const img = new Image(); img.src = c.toDataURL(); img.className = "snap"; c.replaceWith(img); } } catch { /* tainted */ }
    }
    charts.get(el)?.destroy(); charts.delete(el);
    [...el.children].forEach((x) => x !== old && x.remove());
    el.classList.remove("popping");
    old && old.classList.remove("in");
    if (!slide) { el.innerHTML = ""; return; }
    const o = { n: i + 1, total: slides.length, asOf: opts.asOf, dir: opts.animate ? dir : 0 };
    el.insertAdjacentHTML("beforeend", slide.cat === "cover" ? cover(slide)
      : slide.cat === "agenda" ? agenda(slide, slides, o) : content(slide, secOf(slides, slide), o));
    const sl = el.lastElementChild;
    sl.insertAdjacentHTML("beforeend", '<div class="sl-pop" hidden></div>');
    fit(sl);
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => fit(sl));  // metrics change once Fira loads
    const t0 = old ? 380 : 0;  // new content waits for the wipe
    if (old) {
      old.classList.add("sl-out"); old.style.setProperty("--dir", dir);
      el.insertAdjacentHTML("beforeend", `<div class="sl-wipe" style="--dir:${dir}"><i></i><i></i></div>`);
      const wipe = el.lastElementChild;
      setTimeout(() => { old.remove(); wipe.remove(); }, 1000);
    }
    if (opts.animate) { sl.style.setProperty("--t0", t0 + "ms"); sl.classList.add("in"); countUp(sl, t0 + 350); }
    const onPop = opts.onPop || ((p) => pop(el, slide, p));
    sl.querySelectorAll("[data-pop]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); onPop(b.dataset.pop); }));
    sl.querySelectorAll("[data-go]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); opts.onGo?.(+b.dataset.go); }));
    sl.onclick = () => onPop(null);
    if (slide.chart) chart(el, sl, slide.chart, opts.animate, t0 + 250, (j) => onPop(`bar:${j}`));
  }

  // Show (or close, p = null) the detail popup for "kpi:i" | "item:i" | "bar:i" and spotlight its source.
  function pop(el, slide, p) {
    const sl = el.querySelector(":scope > .sl:not(.sl-out)"), box = sl && sl.querySelector(".sl-pop");
    if (!box) return;
    sl.querySelectorAll(".focus").forEach((x) => x.classList.remove("focus"));
    el.classList.remove("popping");
    const [kind, i] = String(p || "").split(":");
    let title = "", body = "";
    if (kind === "kpi" && slide.kpis[+i]) { const k = slide.kpis[+i]; title = `${k.label}: ${k.value}`; body = k.detail; }
    if (kind === "item" && slide.items[+i]) { const it = slide.items[+i]; title = it.text; body = it.detail; }
    const ch = charts.get(el);
    if (kind === "bar" && slide.chart) {
      const c = slide.chart, f = fmt[c.fmt] || fmt.n;
      title = c.labels[+i];
      body = [c.series.map((s) => `${s.name}: ${f(s.data[+i])}`).join(" · "), (c.details || [])[+i]].filter(Boolean).join("\n");
      if (ch) { ch.setActiveElements(c.series.map((_, d) => ({ datasetIndex: d, index: +i }))); ch.update(); }
    } else if (ch && ch.getActiveElements().length) { ch.setActiveElements([]); ch.update(); }
    box.hidden = true;
    if (!p) return;
    const src = sl.querySelector(`[data-pop="${kind}:${i}"]`);
    src?.classList.add("focus");
    const r = src && src.getBoundingClientRect(), R = sl.getBoundingClientRect();  // keep the popup off its source
    box.classList.toggle("top", !!r && r.top + r.height / 2 - R.top > R.height * 0.5);
    el.classList.add("popping");
    if (!body && kind !== "item") return;  // an item's popup shows its full text even without a detail
    box.innerHTML = `<div class="t">${esc(title)}</div>${body ? `<div class="b">${esc(body)}</div>` : ""}`;
    box.hidden = false;
    box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
  }

  return { render, pop, sections };
})();
