// Minimal client for the Sketchfab embed postMessage protocol.
//
// Wire format (reverse-engineered from sketchfab-viewer-1.9.0.js and the
// page-side dispatcher in 4978f660...-v2.js):
//   parent -> iframe : {type:"api.initialize", requestId, name, instanceId}
//   parent -> iframe : {type:"api.request", instanceId, requestId, member, arguments:[...]}
//   iframe -> parent : {type:"api.ready", instanceId, results:[instanceId], error?}
//   iframe -> parent : {type:"api.initialize.result", instanceId, requestId, results:[err, ...]}
//   iframe -> parent : {type:"api.request.result", instanceId, requestId, results:[err, ...]}
//   iframe -> parent : {type:"api.event", instanceId, results:[eventName, ...]}
//
// The page dispatcher resolves `member` against the *prototype* of its API
// object, not against the version ladder, so undocumented members such as
// getNodeMask are reachable from here.

const SF_ORIGIN = "https://sketchfab.com";

const $ = (id) => document.getElementById(id);

class SketchfabSocket {
  constructor() {
    this.instanceId = "mvp-" + Math.random().toString(36).slice(2, 10);
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener("message", this._onMessage);
  }

  mount(host, { uid, apiVersion }) {
    this.destroy();
    this.apiVersion = apiVersion;
    this.ready = false;
    this.seq = 0;

    const params = new URLSearchParams({
      api_version: apiVersion,
      api_id: this.instanceId,
      autostart: "1",
      preload: "1",
      transparent: "0",
      ui_theme: "dark",
    });
    const url = `${SF_ORIGIN}/models/${encodeURIComponent(uid)}/embed?${params}`;

    const iframe = document.createElement("iframe");
    iframe.allow = "autoplay; fullscreen; xr-spatial-tracking";
    iframe.src = url;
    host.replaceChildren(iframe);
    this.iframe = iframe;

    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
      this._readyTimer = setTimeout(() => reject(new Error("viewer did not become ready")), 60000);
    });
    return this.readyPromise;
  }

  destroy() {
    clearTimeout(this._readyTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("viewer replaced"));
    }
    this.pending.clear();
    this.ready = false;
    if (this.iframe) this.iframe.remove();
    this.iframe = null;
  }

  _send(msg) {
    this.iframe?.contentWindow?.postMessage(msg, SF_ORIGIN);
  }

  _onMessage(e) {
    if (e.origin !== SF_ORIGIN) return;
    const d = e.data;
    if (!d || d.instanceId !== this.instanceId || !this.iframe) return;

    if (d.type === "api.ready") {
      if (d.error) {
        this._rejectReady?.(new Error(d.error));
        return;
      }
      this._send({
        type: "api.initialize",
        requestId: ++this.seq,
        name: this.apiVersion,
        instanceId: this.instanceId,
      });
      return;
    }

    if (d.type === "api.initialize.result") {
      const [err] = d.results || [];
      if (err) log(`initialize: ${err}`);
      return;
    }

    if (d.type === "api.request.result") {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(d.requestId);
      const [err, ...rest] = d.results || [];
      if (err) p.reject(new Error(String(err)));
      else p.resolve(rest);
      return;
    }

    if (d.type === "api.event") {
      const [name, ...rest] = d.results || [];
      if (name === "viewerready" && !this.ready) {
        this.ready = true;
        clearTimeout(this._readyTimer);
        this._resolveReady?.();
      }
      log(`event ${name} ${rest.length ? JSON.stringify(rest).slice(0, 160) : ""}`, true);
    }
  }

  request(member, args = []) {
    if (!this.iframe) return Promise.reject(new Error("not mounted"));
    const requestId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`timeout: ${member}`));
      }, 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      this._send({ type: "api.request", instanceId: this.instanceId, requestId, member, arguments: args });
    });
  }

  // (err, ...values) -> first value, throwing on err
  call(member, ...args) {
    return this.request(member, args).then((r) => r[0]);
  }
}

// ---------------------------------------------------------------- logging

function log(msg, all = false) {
  const out = $("rpcOut");
  const line = typeof msg === "string" ? msg : JSON.stringify(msg, null, 1);
  out.textContent = (all ? out.textContent + "\n" : "") + line;
  out.scrollTop = out.scrollHeight;
  if (!all) $("status").textContent = line.split("\n")[0].slice(0, 80);
}

// ---------------------------------------------------------------- scene state

const tree = {
  all: new Map(),     // instanceID -> entry
  parent: new Map(),  // instanceID -> parent instanceID
  roots: [],
  own: new Map(),     // instanceID -> own mask visibility
  rows: new Map(),    // instanceID -> row element
};

function indexNodeMap(map) {
  tree.all.clear();
  tree.parent.clear();
  tree.own.clear();
  tree.rows.clear();

  const visit = (entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.instanceID !== "number") return;
    if (tree.all.has(entry.instanceID)) return;
    tree.all.set(entry.instanceID, entry);
    tree.own.set(entry.instanceID, entry.nodeMask !== 0);
    for (const child of entry.children || []) {
      if (!child || typeof child.instanceID !== "number") continue;
      if (!tree.parent.has(child.instanceID)) tree.parent.set(child.instanceID, entry.instanceID);
      visit(child);
    }
  };
  for (const entry of Object.values(map || {})) visit(entry);

  tree.roots = [...tree.all.keys()].filter((id) => !tree.parent.has(id));
}

function effectiveVisible(id) {
  let cur = id;
  while (cur !== undefined) {
    if (tree.own.get(cur) === false) return false;
    cur = tree.parent.get(cur);
  }
  return true;
}

function renderTree() {
  const host = $("tree");
  const filter = $("filter").value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  tree.rows.clear();

  const add = (id, depth) => {
    const entry = tree.all.get(id);
    if (!entry) return;
    const visible = effectiveVisible(id);
    const label = `${entry.name || "(unnamed)"}`;
    if (!filter || label.toLowerCase().includes(filter) || (entry.type || "").toLowerCase().includes(filter)) {
      const row = document.createElement("div");
      row.className = "node" + (entry.children && entry.children.length ? "" : " leaf") + (visible ? "" : " hidden");
      row.dataset.id = String(id);
      row.style.paddingLeft = `${8 + depth * 12}px`;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = tree.own.get(id) !== false;
      box.dataset.id = String(id);

      const name = document.createElement("span");
      name.textContent = ` ${label} `;
      name.title = `instanceID ${id} · mask ${entry.nodeMask}`;

      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = `${entry.type || "?"} · ${id}`;

      const solo = document.createElement("button");
      solo.textContent = "solo";
      solo.dataset.solo = String(id);
      solo.style.marginLeft = "6px";

      row.append(box, name, meta, solo);
      frag.append(row);
      tree.rows.set(id, row);
    }
    for (const child of entry.children || []) add(child.instanceID, depth + 1);
  };

  for (const rootId of tree.roots) add(rootId, 0);
  host.replaceChildren(frag);
  $("nodeCount").textContent = `${tree.all.size} nodes`;
}

async function setVisible(id, visible) {
  await socket.call(visible ? "show" : "hide", id);
  tree.own.set(id, visible);
  // descendants keep their own masks; only this row's own state changed
  renderTree();
}

async function solo(id) {
  const keep = new Set();
  let cur = id;
  while (cur !== undefined) {
    keep.add(cur);
    cur = tree.parent.get(cur);
  }
  // hide every other leaf-ish node, show the target subtree
  for (const [nid, entry] of tree.all) {
    if (keep.has(nid)) continue;
    if (tree.parent.get(nid) !== undefined && !keep.has(tree.parent.get(nid))) continue; // covered by its parent
    if (tree.own.get(nid) === false) continue;
    await socket.call("hide", nid).catch(() => {});
    tree.own.set(nid, false);
  }
  for (const nid of keep) {
    if (tree.own.get(nid) === false) {
      await socket.call("show", nid).catch(() => {});
      tree.own.set(nid, true);
    }
  }
  renderTree();
}

// ---------------------------------------------------------------- camera

const AXES = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  iso: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
};

const vec = (ids) => ids.map((id) => Number($(id).value) || 0);
const fillVec = (ids, v) => ids.forEach((id, i) => { $(id).value = Number(v[i]).toFixed(3); });

async function readCamera() {
  const look = await socket.call("getCameraLookAt");
  if (look) {
    fillVec(["px", "py", "pz"], look.position);
    fillVec(["tx", "ty", "tz"], look.target);
  }
  try {
    const fov = await socket.call("getFov");
    if (fov !== undefined) $("fov").value = Number(fov).toFixed(1);
  } catch { /* getFov is 1.4+ */ }
  log("camera read");
}

async function applyCamera() {
  const mode = $("camMode").value;
  const duration = Number($("dur").value) || 0;

  if (mode === "orbit") await socket.call("setEnableCameraConstraints", false);
  if (mode === "constrained") await socket.call("setEnableCameraConstraints", true);

  let position = vec(["px", "py", "pz"]);
  let target = vec(["tx", "ty", "tz"]);

  if (AXES[mode]) {
    const look = await socket.call("getCameraLookAt");
    if (look) {
      target = look.target.map(Number);
      const dist = Math.hypot(
        position[0] - target[0],
        position[1] - target[1],
        position[2] - target[2],
      ) || 5;
      const axis = AXES[mode];
      position = target.map((t, i) => t + axis[i] * dist);
      fillVec(["tx", "ty", "tz"], target);
      fillVec(["px", "py", "pz"], position);
    }
  }

  await socket.call("setCameraLookAt", position, target, duration);

  if ($("fov").value !== "") await socket.call("setFov", Number($("fov").value));
  if ($("roll").value !== "") await socket.call("setCameraRoll", (Number($("roll").value) * Math.PI) / 180);

  log(`camera ${mode}`);
}

// ---------------------------------------------------------------- boot

const socket = new SketchfabSocket();

async function load() {
  const uid = $("uid").value.trim();
  const apiVersion = $("apiver").value.trim() || "1.12.0";
  if (!uid) return;

  $("status").textContent = "loading…";
  $("tree").replaceChildren();
  tree.all.clear();
  setControlsEnabled(false);

  try {
    await socket.mount($("frame"), { uid, apiVersion });
  } catch (err) {
    $("status").textContent = `failed: ${err.message}`;
    return;
  }

  $("status").textContent = "ready";
  setControlsEnabled(true);

  let nodeMap;
  for (let i = 0; i < 20 && !nodeMap; i++) {
    try {
      nodeMap = await socket.call("getNodeMap");
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!nodeMap) {
    $("status").textContent = "ready, but getNodeMap failed";
    return;
  }
  indexNodeMap(nodeMap);
  renderTree();
  await readCamera().catch((e) => log(`camera read: ${e.message}`));
}

function setControlsEnabled(on) {
  for (const el of document.querySelectorAll("aside button, aside input, aside select, aside textarea")) {
    if (el.id === "rpcOut") continue;
    el.disabled = !on;
  }
}

// controls

$("load").addEventListener("click", load);

$("camRead").addEventListener("click", () => readCamera().catch((e) => log(`read: ${e.message}`)));
$("camApply").addEventListener("click", () => applyCamera().catch((e) => log(`apply: ${e.message}`)));
$("camFit").addEventListener("click", () => socket.call("focusOnVisibleGeometries").then(() => log("fit")).catch((e) => log(`fit: ${e.message}`)));
$("camHome").addEventListener("click", () => socket.call("recenterCamera").then(() => log("recentered")).catch((e) => log(`recenter: ${e.message}`)));
$("camConstraints").addEventListener("click", () => {
  let payload;
  try {
    payload = JSON.parse($("constraints").value || "{}");
  } catch (e) {
    return log(`constraints json: ${e.message}`);
  }
  socket.call("setCameraConstraints", payload).then(() => log("constraints sent")).catch((e) => log(`constraints: ${e.message}`));
});

$("filter").addEventListener("input", renderTree);

$("tree").addEventListener("change", (e) => {
  const id = Number(e.target.dataset.id);
  if (!Number.isFinite(id)) return;
  setVisible(id, e.target.checked).catch((err) => log(`toggle ${id}: ${err.message}`));
});

$("tree").addEventListener("click", (e) => {
  const id = e.target.dataset && e.target.dataset.solo;
  if (id === undefined) return;
  solo(Number(id)).catch((err) => log(`solo: ${err.message}`));
});

$("showAll").addEventListener("click", async () => {
  for (const id of tree.all.keys()) {
    if (tree.own.get(id) === false) await socket.call("show", id).catch(() => {});
    tree.own.set(id, true);
  }
  renderTree();
  log("all shown");
});

$("hideAll").addEventListener("click", async () => {
  let n = 0;
  for (const [id, entry] of tree.all) {
    const isLeaf = !entry.children || entry.children.length === 0;
    if (!isLeaf || tree.own.get(id) === false) continue;
    await socket.call("hide", id).catch(() => {});
    tree.own.set(id, false);
    n++;
  }
  renderTree();
  log(`${n} leaves hidden`);
});

$("rpcSend").addEventListener("click", async () => {
  const member = $("rpcMember").value.trim();
  let args;
  try {
    args = JSON.parse($("rpcArgs").value || "[]");
    if (!Array.isArray(args)) throw new Error("arguments must be a JSON array");
  } catch (e) {
    return log(`args: ${e.message}`);
  }
  try {
    const out = await socket.request(member, args);
    log(`${member} -> ${JSON.stringify(out).slice(0, 4000)}`, true);
  } catch (e) {
    log(`${member} !! ${e.message}`, true);
  }
});

setControlsEnabled(false);
load();
