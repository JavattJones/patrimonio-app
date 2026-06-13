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
let chartMode = localStorage.getItem("pat:chartmode") || "cuentas";
let liberandoLote = null; // id del lote que se está liberando (UI de Ajustes)

// paleta fósforo para las bandas por cuenta
const PALETTE = ["#ffb000", "#3df98b", "#25e0ff", "#ffe14d", "#ff7a1a", "#b3ff66", "#ff66b3", "#7aa2ff"];

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
// ── acciones bloqueadas (lotes / vesting) ──
// Un lote cuenta (a coste = aportado) desde su mes de compra hasta que se libera.
// Al liberarse, su valor sale de aquí y entra como dinero real en la cuenta destino.
function loteVivoEn(lote, mes) {
  if (!lote.mesCompra || lote.mesCompra > mes) return false; // aún no comprado
  if (lote.liberado && lote.mesLiberado && lote.mesLiberado <= mes) return false; // ya liberado
  return true;
}
function valorBloqueada(cuenta, mes) {
  let total = 0;
  for (const lote of cuenta.lotes || []) if (loteVivoEn(lote, mes)) total += Number(lote.aportado || 0);
  return total;
}
function valorCuenta(cuenta, mes) {
  const reg = data.registros[mes];
  if (!reg) return null;
  if (cuenta.tipo === "aportaciones") return aportAcumulada(cuenta.id, mes);
  if (cuenta.tipo === "bloqueada") {
    const v = valorBloqueada(cuenta, mes);
    return v > 0 ? v : null;
  }
  const s = reg.saldos?.[cuenta.id];
  return s === undefined || s === null || s === "" ? null : Number(s);
}
// lotes vencidos (fecha de liberación alcanzada) y aún sin liberar
function lotesPorLiberar() {
  const hoy = hoyYM();
  const res = [];
  for (const c of data.cuentas) {
    if (c.tipo !== "bloqueada" || c.archived) continue;
    for (const lote of c.lotes || []) {
      if (!lote.liberado && lote.mesLiberacion && lote.mesLiberacion <= hoy) res.push({ cuenta: c, lote });
    }
  }
  return res;
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

  // aviso de registro pendiente del mes en curso
  const banner = document.getElementById("banner-pendiente");
  const mesActual = hoyYM();
  if (meses.length && data.cuentas.length && !data.registros[mesActual]) {
    document.getElementById("banner-mes").textContent = mesLargo(mesActual);
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  // aviso de paquete(s) de acciones listos para liberar
  const bannerLib = document.getElementById("banner-liberar");
  const porLiberar = lotesPorLiberar();
  if (porLiberar.length) {
    const { cuenta, lote } = porLiberar[0];
    document.getElementById("banner-liberar-txt").textContent =
      `${cuenta.nombre}: paquete de ${fmtEur(lote.aportado)} liberable (venció ${mesLargo(lote.mesLiberacion)})` +
      (porLiberar.length > 1 ? ` · +${porLiberar.length - 1} más` : "");
    bannerLib.classList.remove("hidden");
  } else {
    bannerLib.classList.add("hidden");
  }

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

  const tasaEl = document.getElementById("kpi-tasa");
  if (ahorro !== null && ingresos && Number(ingresos) > 0) {
    const tasa = (ahorro / Number(ingresos)) * 100;
    tasaEl.textContent = (tasa >= 0 ? "+" : "") + tasa.toFixed(0) + " %";
    tasaEl.className = "kpi-value " + (tasa >= 0 ? "pos" : "neg");
  } else {
    tasaEl.textContent = "—";
    tasaEl.className = "kpi-value";
  }

  const deltas = [];
  for (let i = 1; i < meses.length; i++) deltas.push(totalMes(meses[i]) - totalMes(meses[i - 1]));
  const media = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  setKpi("kpi-media", media);
  document.getElementById("kpi-media-sub").textContent = deltas.length ? `sobre ${deltas.length} meses` : "";

  const hace12 = meses.find((m) => m >= restarMeses(ultimo, 12));
  const kpiAnual = hace12 && hace12 !== ultimo ? total - totalMes(hace12) : null;
  setKpi("kpi-anual", kpiAnual);

  // objetivo anual
  renderObjetivo(meses);

  // gráfica de evolución: apilada por cuenta o línea de total
  document.getElementById("seg-cuentas").classList.toggle("active", chartMode === "cuentas");
  document.getElementById("seg-total").classList.toggle("active", chartMode === "total");

  if (chartMode === "cuentas") {
    // una banda por cuenta; el borde superior de la pila = patrimonio total
    const conDatos = data.cuentas.filter((c) => meses.some((m) => valorCuenta(c, m) !== null));
    const datasets = conDatos.map((c, i) => {
      const col = PALETTE[i % PALETTE.length];
      return {
        label: c.nombre,
        data: meses.map((m) => valorCuenta(c, m) ?? 0),
        borderColor: col,
        borderWidth: 1.5,
        backgroundColor: col + "3d",
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: col,
      };
    });
    const opts = chartOpts((v) => fmtEur(v));
    opts.scales.y.stacked = true;
    opts.plugins.legend = {
      display: true,
      position: "bottom",
      labels: { color: "#9a8d5e", boxWidth: 10, boxHeight: 10, font: { family: MONO, size: 10 }, padding: 12 },
    };
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => ` ${ctx.dataset.label}: ${fmtEur(ctx.parsed.y)}`,
      footer: (items) => "TOTAL: " + fmtEur(items.reduce((a, it) => a + it.parsed.y, 0)),
    };
    opts.interaction = { mode: "index", intersect: false };
    drawChart("chart-evolucion", { type: "line", data: { labels: meses.map(mesLargo), datasets }, options: opts });
  } else {
    const evoCtx = document.getElementById("chart-evolucion").getContext("2d");
    const grad = evoCtx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, "rgba(255,176,0,0.30)");
    grad.addColorStop(1, "rgba(255,176,0,0)");
    drawChart("chart-evolucion", {
      type: "line",
      data: {
        labels: meses.map(mesLargo),
        datasets: [{
          data: meses.map(totalMes),
          borderColor: "#ffb000",
          borderWidth: 2,
          backgroundColor: grad,
          fill: true, tension: 0.35,
          pointRadius: meses.length > 14 ? 0 : 3,
          pointBackgroundColor: "#ffb000",
          pointBorderColor: "rgba(7,7,3,0.9)",
          pointBorderWidth: 2,
          pointHoverRadius: 5,
        }],
      },
      options: chartOpts((v) => fmtEur(v)),
    });
  }

  drawChart("chart-ahorro", {
    type: "bar",
    data: {
      labels: meses.slice(1).map(mesLargo),
      datasets: [{
        data: deltas,
        backgroundColor: deltas.map((d) => (d >= 0 ? "rgba(61,249,139,0.7)" : "rgba(255,95,95,0.7)")),
        borderColor: deltas.map((d) => (d >= 0 ? "#3df98b" : "#ff5f5f")),
        borderWidth: 1,
        borderRadius: 2,
        maxBarThickness: 32,
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
    } else if (c.tipo === "bloqueada") {
      const vivos = (c.lotes || []).filter((l) => !l.liberado);
      const prox = vivos.map((l) => l.mesLiberacion).filter(Boolean).sort()[0];
      const n = vivos.length;
      deltaHtml = `<span class="cuenta-delta">${n} paquete${n === 1 ? "" : "s"}${prox ? ` · próx. ${mesLargo(prox)}` : ""}</span>`;
    }
    const tipoTxt = { cuenta: "cuenta", inversion: "inversión", aportaciones: "aportaciones", bloqueada: "acciones" }[c.tipo];
    const pct = total > 0 && v !== null && v > 0 ? (v / total) * 100 : 0;
    const pctTxt = pct > 0 ? ` · ${pct.toFixed(0)} %` : "";
    row.innerHTML = `
      <div class="cuenta-id">
        <span class="avatar t-${c.tipo}">${esc(iniciales(c.nombre))}</span>
        <div class="cuenta-info">
          <span class="cuenta-nombre">${esc(c.nombre)}</span>
          <span class="cuenta-tipo">${tipoTxt}${pctTxt}</span>
          <div class="share"><i style="width:${pct.toFixed(1)}%"></i></div>
        </div>
      </div>
      <div class="cuenta-valor">${v !== null ? fmtEur(v) : "—"}${deltaHtml}</div>`;
    cont.appendChild(row);
  }
}

function renderObjetivo(meses) {
  const card = document.getElementById("card-objetivo");
  const objetivo = Number(data.config.objetivoAnual || 0);
  if (!objetivo || meses.length < 2) { card.classList.add("hidden"); return; }
  const año = meses[meses.length - 1].slice(0, 4);
  // ahorro acumulado del año = suma de deltas de los meses del año en curso
  let acumulado = 0;
  for (let i = 1; i < meses.length; i++) {
    if (meses[i].startsWith(año)) acumulado += totalMes(meses[i]) - totalMes(meses[i - 1]);
  }
  card.classList.remove("hidden");
  document.getElementById("obj-year").textContent = "· " + año;
  const pct = Math.max(0, (acumulado / objetivo) * 100);
  const fill = document.getElementById("obj-fill");
  fill.style.width = Math.min(100, pct) + "%";
  fill.classList.toggle("over", pct >= 100);
  document.getElementById("obj-txt").innerHTML =
    `<b>${fmtEur(acumulado)}</b> de ${fmtEur(objetivo)} · ${pct.toFixed(0)} %` +
    (pct >= 100 ? " · 🏆 objetivo cumplido" : "");
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
function sumarMeses(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
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
const MONO = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';

function chartOpts(fmt) {
  const tick = { color: "#9a8d5e", font: { family: MONO, size: 10, weight: 700 } };
  return {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(7,7,3,0.96)",
        borderColor: "rgba(255,176,0,0.35)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 4,
        displayColors: false,
        titleColor: "#ffb000",
        bodyColor: "#e9ddb9",
        footerColor: "#ffb000",
        titleFont: { family: MONO, size: 11 },
        bodyFont: { family: MONO, size: 11 },
        footerFont: { family: MONO, size: 11, weight: 700 },
        callbacks: { label: (ctx) => fmt(ctx.parsed.y) },
      },
    },
    scales: {
      x: { ticks: tick, grid: { display: false }, border: { color: "rgba(255,176,0,0.18)" } },
      y: {
        ticks: { ...tick, callback: (v) => fmtEur(v), maxTicksLimit: 6 },
        grid: { color: "rgba(255,176,0,0.07)" },
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
    } else if (c.tipo === "bloqueada") {
      const v = valorBloqueada(c, mes);
      label.innerHTML = `<span>${esc(c.nombre)} — acciones bloqueadas <small>(automático · se gestiona en Ajustes)</small></span>
        <input type="text" value="${v > 0 ? fmtEur(v) : "sin paquetes activos"}" disabled>`;
    } else {
      const val = reg.saldos?.[c.id] ?? "";
      const prev = prevReg?.saldos?.[c.id];
      label.innerHTML = `<span>${esc(c.nombre)} — saldo a fin de mes${prev !== undefined ? ` <small>(anterior: ${fmtEur(prev)})</small>` : ""}</span>
        <input type="number" inputmode="decimal" step="0.01" data-saldo="${c.id}" value="${val}" placeholder="${prev ?? "0"}">`;
    }
    cont.appendChild(label);
  }
  // ingresos: precarga el del mes anterior (suele ser el mismo sueldo); solo se toca si cambia
  document.getElementById("upd-ingresos").value = reg.ingresos ?? prevReg?.ingresos ?? "";
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
    const tipoTxt = { cuenta: "cuenta", inversion: "inversión", aportaciones: "aportaciones", bloqueada: "acciones" }[c.tipo];
    const aportadoInput = (c.tipo === "inversion" || c.tipo === "aportaciones") && !c.archived
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
    if (c.tipo === "bloqueada" && !c.archived) {
      const wrap = document.createElement("div");
      wrap.innerHTML = lotePanelHTML(c);
      cont.appendChild(wrap.firstElementChild);
    }
  }
  // objetivo anual
  document.getElementById("cfg-objetivo").value = data.config.objetivoAnual ?? "";
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
  const cuenta = { id: uid(), nombre, tipo };
  if (tipo === "bloqueada") cuenta.lotes = [];
  data.cuentas.push(cuenta);
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

// ---------- acciones bloqueadas: panel de lotes ----------
function lotePanelHTML(c) {
  const lotes = (c.lotes || []).slice().sort((a, b) => (a.mesCompra || "").localeCompare(b.mesCompra || ""));
  let rows = "";
  if (!lotes.length) rows = `<p class="hint">Sin paquetes todavía. Añade el primero 👇</p>`;
  for (const l of lotes) {
    if (liberandoLote === l.id) { rows += formLiberarHTML(c, l); continue; }
    let estado;
    if (l.liberado) {
      estado = `<span class="lote-estado liberado">✓ liberado ${mesLargo(l.mesLiberado)} · ${fmtEur(l.valorLiberacion)} (${fmtEurSign(l.valorLiberacion - l.aportado)})</span>`;
    } else if (l.mesLiberacion && l.mesLiberacion <= hoyYM()) {
      estado = `<span class="lote-estado vence">⚠ liberable · venció ${mesLargo(l.mesLiberacion)}</span>`;
    } else {
      estado = `<span class="lote-estado">🔒 se libera ${l.mesLiberacion ? mesLargo(l.mesLiberacion) : "—"}</span>`;
    }
    rows += `<div class="lote">
      <div class="lote-info"><b>${esc((l.mesCompra || "").slice(0, 4))}</b> · ${fmtEur(l.aportado)}${estado}</div>
      ${l.liberado ? "" : `<button class="btn-mini accion" data-liberar="${l.id}|${c.id}" title="Liberar (pasar a dinero real)">💰</button>`}
      <button class="btn-mini" data-dellote="${l.id}|${c.id}" title="Eliminar paquete">✕</button>
    </div>`;
  }
  rows += `<div class="add-lote">
    <input type="month" data-newlote-mes="${c.id}" title="Mes de compra del paquete">
    <input type="number" inputmode="decimal" step="0.01" data-newlote-imp="${c.id}" placeholder="importe €">
    <button class="btn-mini add" data-addlote="${c.id}">＋ paquete</button>
  </div>`;
  return `<div class="lotes-panel">${rows}</div>`;
}

function formLiberarHTML(c, l) {
  const destinos = data.cuentas.filter((x) => !x.archived && (x.tipo === "cuenta" || x.tipo === "inversion"));
  const opts = destinos.map((d) => `<option value="${d.id}">${esc(d.nombre)}</option>`).join("");
  return `<div class="lote-liberar">
    <div class="lote-info"><b>Liberar paquete ${esc((l.mesCompra || "").slice(0, 4))}</b> · aportado ${fmtEur(l.aportado)}</div>
    <label class="mini-field"><span>Valor real recibido (€)</span>
      <input type="number" inputmode="decimal" step="0.01" data-lib-valor="${l.id}" placeholder="${l.aportado}"></label>
    <label class="mini-field"><span>Mes de liberación</span>
      <input type="month" data-lib-mes="${l.id}" value="${hoyYM()}"></label>
    <label class="mini-field"><span>Dinero ingresado en</span>
      <select data-lib-destino="${l.id}">${opts || `<option value="">(ninguna cuenta destino)</option>`}</select></label>
    <div class="btn-row">
      <button class="btn-mini ok" data-libok="${l.id}|${c.id}">✓ Confirmar</button>
      <button class="btn-mini accion" data-libcancel="1">cancelar</button>
    </div>
  </div>`;
}

function addLote(cid) {
  const c = data.cuentas.find((x) => x.id === cid);
  if (!c) return;
  const mesCompra = document.querySelector(`[data-newlote-mes="${cid}"]`)?.value;
  const imp = Number(document.querySelector(`[data-newlote-imp="${cid}"]`)?.value);
  if (!mesCompra || !imp) { alert("Indica el mes de compra y el importe del paquete."); return; }
  c.lotes = c.lotes || [];
  c.lotes.push({
    id: uid(), mesCompra, aportado: imp, mesLiberacion: sumarMeses(mesCompra, 36),
    liberado: false, valorLiberacion: null, destinoId: null, mesLiberado: null,
  });
  saveAndSync(null);
}

function delLote(cid, lid) {
  const c = data.cuentas.find((x) => x.id === cid);
  if (!c) return;
  const l = (c.lotes || []).find((x) => x.id === lid);
  if (!l) return;
  if (!confirm(`¿Eliminar el paquete de ${fmtEur(l.aportado)} (${(l.mesCompra || "").slice(0, 4)})?`)) return;
  c.lotes = c.lotes.filter((x) => x.id !== lid);
  if (liberandoLote === lid) liberandoLote = null;
  saveAndSync(null);
}

function confirmarLiberar(cid, lid) {
  const c = data.cuentas.find((x) => x.id === cid);
  if (!c) return;
  const l = (c.lotes || []).find((x) => x.id === lid);
  if (!l) return;
  const valor = Number(document.querySelector(`[data-lib-valor="${lid}"]`)?.value);
  const mes = document.querySelector(`[data-lib-mes="${lid}"]`)?.value;
  const destinoId = document.querySelector(`[data-lib-destino="${lid}"]`)?.value || null;
  if (!valor || !mes) { alert("Indica el valor real recibido y el mes de liberación."); return; }
  l.liberado = true;
  l.valorLiberacion = valor;
  l.mesLiberado = mes;
  l.destinoId = destinoId;
  liberandoLote = null;
  const dest = data.cuentas.find((x) => x.id === destinoId);
  saveAndSync(null);
  alert(
    `Paquete liberado ✓\n\n` +
    `Importante: al registrar el saldo de ${dest ? dest.nombre : "la cuenta destino"} en ${mesLargo(mes)}, ` +
    `ese saldo ya debe incluir los ${fmtEur(valor)} ingresados.\n\n` +
    `Así el traspaso cuadra y la ganancia (${fmtEurSign(valor - l.aportado)}) aparece sola en el patrimonio de ese mes.`
  );
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
  // ── acciones de lotes (acciones bloqueadas) ──
  const addL = e.target.closest("[data-addlote]");
  if (addL) return addLote(addL.dataset.addlote);
  const delL = e.target.closest("[data-dellote]");
  if (delL) { const [lid, cid] = delL.dataset.dellote.split("|"); return delLote(cid, lid); }
  const libBtn = e.target.closest("[data-liberar]");
  if (libBtn) { liberandoLote = libBtn.dataset.liberar.split("|")[0]; return renderAjustes(); }
  const libCancel = e.target.closest("[data-libcancel]");
  if (libCancel) { liberandoLote = null; return renderAjustes(); }
  const libOk = e.target.closest("[data-libok]");
  if (libOk) { const [lid, cid] = libOk.dataset.libok.split("|"); return confirmarLiberar(cid, lid); }
  // ── acciones de cuenta ──
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
document.getElementById("banner-pendiente").addEventListener("click", () => switchView("actualizar"));
document.getElementById("banner-liberar").addEventListener("click", () => switchView("ajustes"));
document.getElementById("seg-cuentas").addEventListener("click", () => {
  chartMode = "cuentas";
  localStorage.setItem("pat:chartmode", chartMode);
  renderResumen();
});
document.getElementById("seg-total").addEventListener("click", () => {
  chartMode = "total";
  localStorage.setItem("pat:chartmode", chartMode);
  renderResumen();
});
document.getElementById("cfg-objetivo").addEventListener("change", (e) => {
  data.config.objetivoAnual = e.target.value === "" ? 0 : Number(e.target.value);
  saveAndSync(null);
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
