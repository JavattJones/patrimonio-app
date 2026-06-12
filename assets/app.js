/* Patrimonio — control personal de patrimonio mensual
   Datos: JSON en repo privado de GitHub (Contents API) + caché localStorage. */

"use strict";

// ---------- estado ----------
const LS_DATA = "pat:data";
const LS_GH = "pat:gh";
const LS_SHA = "pat:sha";
const LS_DIRTY = "pat:dirty";
const DATA_PATH = "patrimonio.json";

let data = loadLocal();
let gh = JSON.parse(localStorage.getItem(LS_GH) || "null");
let remoteSha = localStorage.getItem(LS_SHA) || null;
let charts = {};

function emptyData() {
  return { version: 1, updatedAt: null, cuentas: [], registros: {}, config: { aportado: {} } };
}
function loadLocal() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_DATA) || "null");
    if (d && d.cuentas) return d;
  } catch (e) { /* caché corrupta: se parte de cero */ }
  return emptyData();
}
function persistLocal() {
  data.updatedAt = new Date().toISOString();
  localStorage.setItem(LS_DATA, JSON.stringify(data));
}

// ---------- utilidades ----------
const fmtEur = (n) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
const fmtEurSign = (n) => (n >= 0 ? "+" : "") + fmtEur(n);
const mesLargo = (ym) => {
  const [y, m] = ym.split("-");
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return meses[parseInt(m, 10) - 1] + " " + y;
};
const hoyYM = () => new Date().toISOString().slice(0, 7);
const uid = () => "c" + Math.random().toString(36).slice(2, 9);

function b64encodeUtf8(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64decodeUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
}

// ---------- cálculos ----------
function mesesOrdenados() {
  return Object.keys(data.registros).sort();
}
function aportAcumulada(cuentaId, hastaMes) {
  let total = Number(data.config.aportado?.[cuentaId] || 0);
  for (const m of mesesOrdenados()) {
    if (m > hastaMes) break;
    total += Number(data.registros[m]?.aportaciones?.[cuentaId] || 0);
  }
  return total;
}
function valorCuenta(cuenta, mes) {
  const reg = data.registros[mes];
  if (!reg) return null;
  if (cuenta.tipo === "aportaciones") return aportAcumulada(cuenta.id, mes);
  const s = reg.saldos?.[cuenta.id];
  return s === undefined || s === null || s === "" ? null : Number(s);
}
function totalMes(mes) {
  let total = 0;
  for (const c of data.cuentas) {
    const v = valorCuenta(c, mes);
    if (v !== null) total += v;
  }
  return total;
}

// ---------- sincronización GitHub ----------
function setSyncStatus(txt, cls) {
  const el = document.getElementById("sync-status");
  el.textContent = txt;
  el.className = "sync-status " + (cls || "");
}
function ghHeaders() {
  return {
    Authorization: "Bearer " + gh.token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function ghUrl() {
  return `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${DATA_PATH}`;
}

async function pullRemote() {
  if (!gh) return "sin-config";
  const res = await fetch(ghUrl(), { headers: ghHeaders() });
  if (res.status === 404) return "no-file";
  if (!res.ok) throw new Error("GitHub " + res.status);
  const json = await res.json();
  remoteSha = json.sha;
  localStorage.setItem(LS_SHA, remoteSha);
  const remote = JSON.parse(b64decodeUtf8(json.content));
  const localDirty = localStorage.getItem(LS_DIRTY) === "1";
  const remoteNewer = !data.updatedAt || (remote.updatedAt && remote.updatedAt > data.updatedAt);
  if (remoteNewer && !localDirty) {
    data = remote;
    localStorage.setItem(LS_DATA, JSON.stringify(data));
    return "actualizado";
  }
  if (localDirty) return "pendiente-push";
  return "al-dia";
}

async function pushRemote() {
  if (!gh) return;
  const body = {
    message: "patrimonio: actualización " + new Date().toISOString().slice(0, 10),
    content: b64encodeUtf8(JSON.stringify(data, null, 2)),
  };
  if (remoteSha) body.sha = remoteSha;
  const res = await fetch(ghUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {
    // sha desactualizado: re-lee y reintenta una vez
    const cur = await fetch(ghUrl(), { headers: ghHeaders() });
    if (cur.ok) {
      remoteSha = (await cur.json()).sha;
      body.sha = remoteSha;
      const retry = await fetch(ghUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
      if (!retry.ok) throw new Error("GitHub " + retry.status);
      remoteSha = (await retry.json()).content.sha;
    } else throw new Error("GitHub " + cur.status);
  } else if (!res.ok) {
    throw new Error("GitHub " + res.status);
  } else {
    remoteSha = (await res.json()).content.sha;
  }
  localStorage.setItem(LS_SHA, remoteSha);
  localStorage.setItem(LS_DIRTY, "0");
}

async function syncFull(interactive) {
  if (!gh) { setSyncStatus("sin configurar", ""); return; }
  setSyncStatus("↻ sincronizando…", "");
  try {
    const estado = await pullRemote();
    if (estado === "pendiente-push" || estado === "no-file") await pushRemote();
    setSyncStatus("✓ sincronizado", "ok");
    renderAll();
  } catch (e) {
    setSyncStatus("⚠ sin conexión", "err");
    if (interactive) alert("No se pudo sincronizar: " + e.message + "\nLos datos quedan guardados en este dispositivo.");
  }
}

async function saveAndSync(msgEl) {
  persistLocal();
  localStorage.setItem(LS_DIRTY, "1");
  if (!gh) {
    if (msgEl) showMsg(msgEl, "Guardado en este dispositivo (configura GitHub para sincronizar).", "ok");
    renderAll();
    return;
  }
  try {
    await pushRemote();
    setSyncStatus("✓ sincronizado", "ok");
    if (msgEl) showMsg(msgEl, "Guardado y sincronizado ✓", "ok");
  } catch (e) {
    setSyncStatus("⚠ sin conexión", "err");
    if (msgEl) showMsg(msgEl, "Guardado local ✓ — se subirá en la próxima sincronización.", "ok");
  }
  renderAll();
}

function showMsg(el, txt, cls) {
  el.textContent = txt;
  el.className = "msg " + (cls || "");
  setTimeout(() => { el.textContent = ""; }, 5000);
}

// ---------- render: resumen ----------
function renderAll() {
  renderResumen();
  renderFormulario();
  renderAjustes();
}

function renderResumen() {
  const meses = mesesOrdenados();
  const empty = document.getElementById("empty-state");
  const dash = document.getElementById("dash");
  if (!meses.length || !data.cuentas.length) {
    empty.classList.remove("hidden");
    dash.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  dash.classList.remove("hidden");

  const ultimo = meses[meses.length - 1];
  const previo = meses.length > 1 ? meses[meses.length - 2] : null;
  const total = totalMes(ultimo);
  const totalPrev = previo ? totalMes(previo) : null;

  document.getElementById("hero-mes").textContent = "· " + mesLargo(ultimo);
  document.getElementById("hero-total").textContent = fmtEur(total);

  const heroDelta = document.getElementById("hero-delta");
  if (totalPrev !== null) {
    const d = total - totalPrev;
    heroDelta.textContent = fmtEurSign(d) + " vs. " + mesLargo(previo);
    heroDelta.className = "hero-delta " + (d >= 0 ? "pos" : "neg");
  } else heroDelta.textContent = "";

  // KPIs
  const ahorro = totalPrev !== null ? total - totalPrev : null;
  setKpi("kpi-ahorro", ahorro);
  const ingresos = data.registros[ultimo]?.ingresos;
  const gasto = ahorro !== null && ingresos ? Number(ingresos) - ahorro : null;
  document.getElementById("kpi-gasto").textContent = gasto !== null ? fmtEur(gasto) : "—";

  const deltas = [];
  for (let i = 1; i < meses.length; i++) deltas.push(totalMes(meses[i]) - totalMes(meses[i - 1]));
  const media = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  setKpi("kpi-media", media);
  document.getElementById("kpi-media-sub").textContent = deltas.length ? `sobre ${deltas.length} meses` : "";

  const hace12 = meses.find((m) => m >= restarMeses(ultimo, 12));
  const kpiAnual = hace12 && hace12 !== ultimo ? total - totalMes(hace12) : null;
  setKpi("kpi-anual", kpiAnual);

  // gráficas
  const evoCtx = document.getElementById("chart-evolucion").getContext("2d");
  const grad = evoCtx.createLinearGradient(0, 0, 0, 230);
  grad.addColorStop(0, "rgba(56,189,248,0.32)");
  grad.addColorStop(1, "rgba(56,189,248,0)");
  drawChart("chart-evolucion", {
    type: "line",
    data: {
      labels: meses.map(mesLargo),
      datasets: [{
        data: meses.map(totalMes),
        borderColor: "#38bdf8",
        borderWidth: 2.5,
        backgroundColor: grad,
        fill: true, tension: 0.38,
        pointRadius: meses.length > 14 ? 0 : 3,
        pointBackgroundColor: "#38bdf8",
        pointBorderColor: "rgba(7,11,20,0.9)",
        pointBorderWidth: 2,
        pointHoverRadius: 5,
      }],
    },
    options: chartOpts((v) => fmtEur(v)),
  });

  drawChart("chart-ahorro", {
    type: "bar",
    data: {
      labels: meses.slice(1).map(mesLargo),
      datasets: [{
        data: deltas,
        backgroundColor: deltas.map((d) => (d >= 0 ? "rgba(52,211,153,0.75)" : "rgba(251,113,133,0.75)")),
        borderRadius: 7,
        borderSkipped: false,
        maxBarThickness: 34,
      }],
    },
    options: chartOpts((v) => fmtEurSign(v)),
  });

  // lista de cuentas
  document.getElementById("cuentas-mes").textContent = "· " + mesLargo(ultimo);
  const cont = document.getElementById("lista-cuentas");
  cont.innerHTML = "";
  for (const c of data.cuentas.filter((x) => !x.archived)) {
    const v = valorCuenta(c, ultimo);
    const row = document.createElement("div");
    row.className = "cuenta-row";
    let deltaHtml = "";
    if (c.tipo === "inversion") {
      const aportado = Number(data.config.aportado?.[c.id] || 0);
      if (aportado && v !== null) {
        const d = v - aportado;
        deltaHtml = `<span class="cuenta-delta ${d >= 0 ? "pos" : "neg"}">${fmtEurSign(d)} vs. aportado</span>`;
      }
    } else if (c.tipo === "aportaciones") {
      deltaHtml = `<span class="cuenta-delta">capital aportado</span>`;
    }
    const tipoTxt = { cuenta: "cuenta", inversion: "inversión", aportaciones: "aportaciones" }[c.tipo];
    row.innerHTML = `
      <div class="cuenta-id">
        <span class="avatar t-${c.tipo}">${esc(iniciales(c.nombre))}</span>
        <div><span class="cuenta-nombre">${esc(c.nombre)}</span><span class="cuenta-tipo">${tipoTxt}</span></div>
      </div>
      <div class="cuenta-valor">${v !== null ? fmtEur(v) : "—"}${deltaHtml}</div>`;
    cont.appendChild(row);
  }
}

function setKpi(id, val) {
  const el = document.getElementById(id);
  if (val === null) { el.textContent = "—"; el.className = "kpi-value"; return; }
  el.textContent = fmtEurSign(val);
  el.className = "kpi-value " + (val >= 0 ? "pos" : "neg");
}
function restarMeses(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function iniciales(nombre) {
  const partes = nombre.trim().split(/\s+/).filter((p) => /[a-zá-úñ0-9]/i.test(p[0]));
  if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
  return nombre.trim().slice(0, 2).toUpperCase();
}
function chartOpts(fmt) {
  const tick = { color: "#8b97ac", font: { size: 11, weight: 600 } };
  return {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(13,19,33,0.95)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 10,
        displayColors: false,
        callbacks: { label: (ctx) => fmt(ctx.parsed.y) },
      },
    },
    scales: {
      x: { ticks: tick, grid: { display: false }, border: { color: "rgba(255,255,255,0.07)" } },
      y: {
        ticks: { ...tick, callback: (v) => fmtEur(v), maxTicksLimit: 6 },
        grid: { color: "rgba(148,163,184,0.07)" },
        border: { display: false },
      },
    },
  };
}
function drawChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), cfg);
}

// ---------- render: actualizar mes ----------
function renderFormulario() {
  const mesInput = document.getElementById("upd-mes");
  if (!mesInput.value) mesInput.value = hoyYM();
  const mes = mesInput.value;
  const reg = data.registros[mes] || {};
  const meses = mesesOrdenados().filter((m) => m < mes);
  const prevReg = meses.length ? data.registros[meses[meses.length - 1]] : {};

  const cont = document.getElementById("upd-campos");
  cont.innerHTML = "";
  const activas = data.cuentas.filter((x) => !x.archived);
  if (!activas.length) {
    cont.innerHTML = `<p class="hint">Primero crea tus cuentas en <b>Ajustes</b>.</p>`;
  }
  for (const c of activas) {
    const label = document.createElement("label");
    label.className = "field";
    if (c.tipo === "aportaciones") {
      const val = reg.aportaciones?.[c.id] ?? "";
      label.innerHTML = `<span>${esc(c.nombre)} — aportado <b>este mes</b></span>
        <input type="number" inputmode="decimal" step="0.01" data-aport="${c.id}" value="${val}" placeholder="0">`;
    } else {
      const val = reg.saldos?.[c.id] ?? "";
      const prev = prevReg?.saldos?.[c.id];
      label.innerHTML = `<span>${esc(c.nombre)} — saldo a fin de mes${prev !== undefined ? ` <small>(anterior: ${fmtEur(prev)})</small>` : ""}</span>
        <input type="number" inputmode="decimal" step="0.01" data-saldo="${c.id}" value="${val}" placeholder="${prev ?? "0"}">`;
    }
    cont.appendChild(label);
  }
  document.getElementById("upd-ingresos").value = reg.ingresos ?? "";
  document.getElementById("upd-notas").value = reg.notas ?? "";
}

function guardarMes() {
  const mes = document.getElementById("upd-mes").value;
  if (!mes) { showMsg(document.getElementById("upd-msg"), "Elige un mes.", "err"); return; }
  const reg = { saldos: {}, aportaciones: {}, ingresos: null, notas: "" };
  document.querySelectorAll("[data-saldo]").forEach((i) => {
    if (i.value !== "") reg.saldos[i.dataset.saldo] = Number(i.value);
  });
  document.querySelectorAll("[data-aport]").forEach((i) => {
    if (i.value !== "") reg.aportaciones[i.dataset.aport] = Number(i.value);
  });
  const ing = document.getElementById("upd-ingresos").value;
  if (ing !== "") reg.ingresos = Number(ing);
  reg.notas = document.getElementById("upd-notas").value.trim();
  data.registros[mes] = reg;
  saveAndSync(document.getElementById("upd-msg"));
}

// ---------- render: ajustes ----------
function renderAjustes() {
  const cont = document.getElementById("lista-cuentas-cfg");
  cont.innerHTML = "";
  if (!data.cuentas.length) cont.innerHTML = `<p class="hint">Aún no hay cuentas. Añade la primera 👇</p>`;
  const orden = [...data.cuentas.filter((c) => !c.archived), ...data.cuentas.filter((c) => c.archived)];
  for (const c of orden) {
    const row = document.createElement("div");
    row.className = "cuenta-cfg" + (c.archived ? " archivada" : "");
    const tipoTxt = { cuenta: "cuenta", inversion: "inversión", aportaciones: "aportaciones" }[c.tipo];
    const aportadoInput = c.tipo !== "cuenta" && !c.archived
      ? `<input type="number" class="aportado" inputmode="decimal" step="0.01" data-aportado="${c.id}"
           value="${data.config.aportado?.[c.id] ?? ""}" placeholder="aportado" title="Capital aportado (base)">`
      : "";
    const archBtn = c.archived
      ? `<button class="btn-mini accion" data-unarchive="${c.id}" title="Reactivar cuenta">↩</button>`
      : `<button class="btn-mini accion" data-archive="${c.id}" title="Archivar (deja de pedirse, su histórico se conserva)">📦</button>`;
    row.innerHTML = `
      <div class="nombre">${esc(c.nombre)}<span class="tipo"> · ${tipoTxt}${c.archived ? " · archivada" : ""}</span></div>
      ${aportadoInput}
      <button class="btn-mini accion" data-rename="${c.id}" title="Renombrar">✏️</button>
      ${archBtn}
      <button class="btn-mini" data-del="${c.id}" title="Eliminar definitivamente">✕</button>`;
    cont.appendChild(row);
  }
  // GitHub
  if (gh) {
    document.getElementById("gh-owner").value = gh.owner || "";
    document.getElementById("gh-repo").value = gh.repo || "";
    document.getElementById("gh-token").value = gh.token || "";
  }
}

function addCuenta() {
  const nombre = document.getElementById("nueva-cuenta-nombre").value.trim();
  const tipo = document.getElementById("nueva-cuenta-tipo").value;
  if (!nombre) return;
  data.cuentas.push({ id: uid(), nombre, tipo });
  document.getElementById("nueva-cuenta-nombre").value = "";
  saveAndSync(null);
}

function delCuenta(id) {
  const c = data.cuentas.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`⚠️ ¿Eliminar DEFINITIVAMENTE "${c.nombre}"?\n\nSus datos históricos dejarán de contar y los totales pasados se recalcularán.\n\nSi solo has cancelado la cuenta, usa 📦 Archivar: deja de pedirse cada mes pero su historia se conserva.`)) return;
  data.cuentas = data.cuentas.filter((x) => x.id !== id);
  saveAndSync(null);
}

function renameCuenta(id) {
  const c = data.cuentas.find((x) => x.id === id);
  if (!c) return;
  const nuevo = prompt("Nuevo nombre para la cuenta:", c.nombre);
  if (!nuevo || !nuevo.trim() || nuevo.trim() === c.nombre) return;
  c.nombre = nuevo.trim();
  saveAndSync(null);
}

function archiveCuenta(id, archivar) {
  const c = data.cuentas.find((x) => x.id === id);
  if (!c) return;
  c.archived = archivar;
  saveAndSync(null);
}

async function guardarGitHub() {
  const owner = document.getElementById("gh-owner").value.trim();
  const repo = document.getElementById("gh-repo").value.trim();
  const token = document.getElementById("gh-token").value.trim();
  const msg = document.getElementById("gh-msg");
  if (!owner || !repo || !token) { showMsg(msg, "Rellena usuario, repositorio y token.", "err"); return; }
  gh = { owner, repo, token };
  localStorage.setItem(LS_GH, JSON.stringify(gh));
  showMsg(msg, "Probando conexión…", "");
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders() });
    if (!res.ok) throw new Error(res.status === 404 ? "repositorio no encontrado (¿token sin acceso?)" : "error " + res.status);
    await syncFull(true);
    showMsg(msg, "Conectado ✓", "ok");
  } catch (e) {
    showMsg(msg, "No conecta: " + e.message, "err");
    setSyncStatus("⚠ revisa GitHub", "err");
  }
}

// ---------- exportar / importar ----------
function exportar() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "patrimonio-" + hoyYM() + ".json";
  a.click();
}
function importar(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d.cuentas || !d.registros) throw new Error("formato no reconocido");
      if (!confirm("Esto reemplaza los datos actuales por el archivo importado. ¿Continuar?")) return;
      data = d;
      saveAndSync(null);
    } catch (e) { alert("No se pudo importar: " + e.message); }
  };
  r.readAsText(file);
}

// ---------- navegación y eventos ----------
function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById("view-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "actualizar") renderFormulario();
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
document.getElementById("upd-mes").addEventListener("change", renderFormulario);
document.getElementById("btn-guardar-mes").addEventListener("click", guardarMes);
document.getElementById("btn-add-cuenta").addEventListener("click", addCuenta);
document.getElementById("lista-cuentas-cfg").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) return delCuenta(del.dataset.del);
  const ren = e.target.closest("[data-rename]");
  if (ren) return renameCuenta(ren.dataset.rename);
  const arc = e.target.closest("[data-archive]");
  if (arc) return archiveCuenta(arc.dataset.archive, true);
  const una = e.target.closest("[data-unarchive]");
  if (una) return archiveCuenta(una.dataset.unarchive, false);
});
document.getElementById("lista-cuentas-cfg").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-aportado]");
  if (inp) {
    data.config.aportado = data.config.aportado || {};
    data.config.aportado[inp.dataset.aportado] = inp.value === "" ? 0 : Number(inp.value);
    saveAndSync(null);
  }
});
document.getElementById("btn-gh-guardar").addEventListener("click", guardarGitHub);
document.getElementById("btn-gh-sync").addEventListener("click", () => syncFull(true));
document.getElementById("btn-export").addEventListener("click", exportar);
document.getElementById("btn-import").addEventListener("click", () => document.getElementById("import-file").click());
document.getElementById("import-file").addEventListener("change", (e) => {
  if (e.target.files[0]) importar(e.target.files[0]);
  e.target.value = "";
});

// ---------- arranque ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
renderAll();
syncFull(false);
