// PMKT Alert web viewer – the page side. app.js is the Windows app's own UI; it calls window.pywebview.api.<method>().
// Here those calls go to worker.js (Python in Pyodide) instead of pywebview. Loaded before app.js.
"use strict";
(() => {
  window.PMKT_WEB = true;
  const splash = document.getElementById("web-splash");
  const say = (t) => { const el = document.getElementById("web-splash-text"); if (el) el.textContent = t; };
  const fail = (t) => {
    say(t);
    splash.classList.add("err");
    document.getElementById("web-splash-retry").hidden = false;
  };

  if (!("Worker" in window) || typeof WebAssembly !== "object") {
    fail("Trình duyệt này không chạy được PMKT Alert – hãy dùng Chrome, Edge hoặc Safari bản mới.");
    return;
  }
  const worker = new Worker("worker.js");
  const pending = new Map();
  let seq = 0;
  const call = (method, args) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ id, method, args });
  });
  // api.<anything>(...) → the worker; `then` stays undefined so the proxy is never mistaken for a promise
  const api = new Proxy({}, { get: (_, m) => (m === "then" || typeof m !== "string" ? undefined : (...args) => call(m, args)) });

  worker.onmessage = (e) => {
    const d = e.data;
    if (d.status) say(d.status);
    else if (d.fatal) fail(`Không khởi động được (${d.fatal}). Kiểm tra mạng rồi thử lại.`);
    else if (d.ready) {
      window.pywebview = { api };
      window.dispatchEvent(new Event("pywebviewready"));
      splash.classList.add("done");
      setTimeout(() => splash.remove(), 400);
    } else if (pending.has(d.id)) {
      const r = d.result;
      if (r && r.download) {  // a file for the person (Excel export): the browser downloads it
        const bin = Uint8Array.from(atob(r.download.b64), (c) => c.charCodeAt(0));
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([bin], { type: r.download.mime })), download: r.download.name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        delete r.download;
      }
      pending.get(d.id)(r);
      pending.delete(d.id);
    }
  };
  worker.onerror = (e) => fail(`Không khởi động được (${e.message || "worker"}). Kiểm tra mạng rồi thử lại.`);

  // offline + install to home screen; a new version takes over on the next open
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker", e));
  }
})();
