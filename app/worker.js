// PMKT Alert web viewer – the Python side. Pyodide runs the app's own pmkt_alert package (app.zip) in this worker,
// so every number is computed by the same code as the Windows app. The page talks to it through shim.js.
/* global loadPyodide, importScripts */
"use strict";
const DATA = "/data";  // IndexedDB-backed: the sign-in, the account's keys, settings (wiped on sign-out)
let py = null, call = null;

const status = (text) => postMessage({ status: text });

async function boot() {
  const cfg = await (await fetch("build.json", { cache: "no-cache" })).json();  // written by scripts/build_web.py
  importScripts(`${cfg.pyodide}pyodide.js`);
  status("Đang tải bộ tính toán…");
  py = await loadPyodide({ indexURL: cfg.pyodide });
  await py.loadPackage(["pandas", "cryptography", "sqlite3", "micropip", "jsonschema"]);
  status("Đang tải PMKT Alert…");
  const micropip = py.pyimport("micropip");
  await micropip.install.callKwargs(cfg.wheels.map((w) => new URL(w, self.location.href).href), { deps: false });
  const zip = await (await fetch(cfg.app)).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/app" });
  py.FS.mkdirTree(DATA);
  py.FS.mount(py.FS.filesystems.IDBFS, {}, DATA);
  await sync(true);
  status("Đang mở…");
  py.globals.set("_dev_json", JSON.stringify(cfg.team || null));
  py.runPython(`
import json, sys, types
sys.path.insert(0, "/app")
# Windows-app-only packages: never reached by the web's methods (reading Excel, windows)
sys.modules.setdefault("python_calamine", types.SimpleNamespace(CalamineWorkbook=None))
sys.modules.setdefault("webview", types.SimpleNamespace())
from pathlib import Path
from pmkt_alert.store import Store
from pmkt_alert.web import WebApi, xhr_opener
_api = WebApi(Store(Path("${DATA}/pmkt")), sb_opener=xhr_opener)
_dev = json.loads(_dev_json)  # a dev build points at a local test server (also after a sign-out wiped the settings)
def _call(method, args):
    if _dev and _api._team().get("url") != _dev["url"]:
        _api.team_connect(_dev["url"], _dev["anon"])
    return json.dumps(_api.call(method, json.loads(args)), ensure_ascii=False, default=str)
`);
  call = py.globals.get("_call");
}

const sync = (populate) => new Promise((ok, fail) => py.FS.syncfs(populate, (e) => (e ? fail(e) : ok())));
const ready = boot();
ready.then(() => postMessage({ ready: true }), (e) => postMessage({ fatal: String(e && e.message || e) }));

// one call at a time, in order: Python state (opened report, session) is shared
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { id, method, args } = e.data;
  queue = queue.then(async () => {
    await ready;
    let result;
    try {
      result = JSON.parse(call(method, JSON.stringify(args || [])));
    } catch (err) {
      result = { error: `Lỗi không mong đợi: ${String(err && err.message || err).split("\n").slice(-2).join(" ")}` };
    }
    try { await sync(false); } catch (err) { console.warn("save", err); }
    postMessage({ id, result });
  });
};
