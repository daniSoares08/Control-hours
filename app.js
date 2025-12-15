(() => {
  const META_HORAS = 20;
  const PAGAMENTO = 4500;
  const FREEZE_THRESHOLD = -40; // congela se saldo < -40
  const STORAGE_KEY = "contract_hours_tracker_v3";

  let state = loadState();

  // UI
  const statusPill = document.getElementById("statusPill");
  const bankValue = document.getElementById("bankValue");
  const monthsCount = document.getElementById("monthsCount");
  const paidTotal = document.getElementById("paidTotal");
  const tbody = document.getElementById("tbody");
  const freezeHint = document.getElementById("freezeHint");

  const entryForm = document.getElementById("entryForm");
  const monthInput = document.getElementById("monthInput");
  const rateInput = document.getElementById("rateInput");
  const nfInput = document.getElementById("nfInput");

  const osTbody = document.getElementById("osTbody");
  const addOsBtn = document.getElementById("addOsBtn");
  const calcPreview = document.getElementById("calcPreview");

  const saveBtn = document.getElementById("saveBtn");
  const cancelEditBtn = document.getElementById("cancelEditBtn");

  const exportBtn = document.getElementById("exportBtn");
  const exportXlsBtn = document.getElementById("exportXlsBtn");
  const importInput = document.getElementById("importInput");
  const resetBtn = document.getElementById("resetBtn");

  let editingId = null;

  // Init default month
  monthInput.value = toMonthValue(new Date());

  // Start with 3 OS rows
  ensureOsRows(3);

  addOsBtn.addEventListener("click", () => {
    addOsRow();
    updatePreview();
  });

  cancelEditBtn.addEventListener("click", () => exitEditMode());

  [rateInput].forEach(el => el.addEventListener("input", updatePreview));
  osTbody.addEventListener("input", updatePreview);

  entryForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const m = monthInput.value?.trim();
    if (!m) return;

    const { year, month } = parseMonthValue(m);
    const id = `${year}-${String(month).padStart(2, "0")}`;

    // congelado: só permite editar/excluir
    const computed = computeTimeline(state.entries);
    if (computed.isFrozenNow && editingId === null) {
      freezeHint.textContent = "Contrato congelado: corrija lançamentos (editar/excluir) para voltar acima de -40h.";
      return;
    }

    const rate = round2(safeNum(rateInput.value, 225));
    if (!(rate > 0)) {
      alert("Valor da hora precisa ser maior que 0.");
      return;
    }

    const nf = (nfInput.value || "").trim();

    const osList = readOsFromUI();
    const totalMoney = round2(osList.reduce((acc, x) => acc + x.value, 0));

    if (!(totalMoney > 0)) {
      alert("Você precisa informar pelo menos 1 OS com valor > 0.");
      return;
    }

    const hours = round2(totalMoney / rate);

    const entry = {
      id,
      year,
      month,
      nf,
      rate,
      os: osList,
      moneyTotal: totalMoney,
      hours
    };

    const idx = state.entries.findIndex((x) => x.id === id);

    if (editingId && editingId !== id) {
      state.entries = state.entries.filter((x) => x.id !== editingId);
    }

    if (idx >= 0 && editingId === null) {
      const ok = confirm("Esse mês já existe. Quer substituir?");
      if (!ok) return;
      state.entries[idx] = entry;
    } else {
      const idx2 = state.entries.findIndex((x) => x.id === id);
      if (idx2 >= 0) state.entries[idx2] = entry;
      else state.entries.push(entry);
    }

    saveState(state);
    exitEditMode();
    render();

    // reset form
    entryForm.reset();
    monthInput.value = toMonthValue(new Date());
    rateInput.value = "225";
    nfInput.value = "";
    osTbody.innerHTML = "";
    ensureOsRows(3);
    updatePreview();
  });

  exportBtn.addEventListener("click", () => {
    const payload = {
      version: 3,
      exportedAt: new Date().toISOString(),
      meta: {
        targetMonthlyHours: META_HORAS,
        fixedPayment: PAGAMENTO,
        freezeThreshold: FREEZE_THRESHOLD,
      },
      data: state,
    };
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      "controle-horas-contrato.json"
    );
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const importedState = parsed?.data?.entries ? parsed.data : parsed;
      if (!importedState || !Array.isArray(importedState.entries)) {
        alert("JSON inválido: esperado { entries: [...] }.");
        return;
      }

      const entries = importedState.entries
        .map(normalizeEntry)
        .filter(Boolean);

      state.entries = uniqueById(entries);
      saveState(state);
      exitEditMode();
      render();
      alert("Importado com sucesso.");
    } catch (err) {
      console.error(err);
      alert("Falha ao importar JSON.");
    } finally {
      importInput.value = "";
    }
  });

  resetBtn.addEventListener("click", () => {
    const ok = confirm("Tem certeza que quer apagar todos os lançamentos?");
    if (!ok) return;
    state = { entries: [] };
    saveState(state);
    exitEditMode();
    render();
  });

  exportXlsBtn.addEventListener("click", () => {
    if (!state.entries.length) {
      alert("Não há meses lançados para exportar.");
      return;
    }

    const timeline = computeTimeline(state.entries);

    // último mês lançado = mês mais recente (cronológico)
    const lastRow = timeline.rows[timeline.rows.length - 1];
    const lastEntry = state.entries.find(e => e.id === lastRow.id);

    if (!lastEntry) {
      alert("Erro: não encontrei o último mês.");
      return;
    }

    const prevBank = timeline.rows.length >= 2 ? timeline.rows[timeline.rows.length - 2].bankAfter : 0;

    const filename = `contrato_${lastRow.year}-${String(lastRow.month).padStart(2, "0")}.xls`;
    const xml = buildSpreadsheetXml({
      lastEntry,
      lastRow,
      prevBank,
      timelineRows: timeline.rows
    });

    downloadBlob(
      new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" }),
      filename
    );
  });

  function render() {
    const timeline = computeTimeline(state.entries);

    const bank = timeline.bankNow;
    bankValue.textContent = formatHours(bank);
    bankValue.className = "kpi-value " + (bank >= 0 ? "good" : "bad");

    monthsCount.textContent = String(timeline.rows.length);

    const totalPaid = timeline.rows.length * PAGAMENTO;
    paidTotal.textContent = formatBRL(totalPaid);

    if (timeline.isFrozenNow) {
      statusPill.textContent = "CONTRATO CONGELADO";
      statusPill.className = "pill bad";
      saveBtn.disabled = true;
      freezeHint.innerHTML = `Saldo atual ${formatHours(bank)} (congela se < -40h).`;
      freezeHint.className = "hint bad";
    } else {
      statusPill.textContent = "ATIVO";
      statusPill.className = "pill good";
      saveBtn.disabled = false;
      freezeHint.textContent = "";
      freezeHint.className = "hint";
    }

    if (timeline.rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="muted">Nenhum mês lançado ainda.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    for (const row of timeline.rows) {
      const tr = document.createElement("tr");

      const entry = state.entries.find(e => e.id === row.id);

      tr.appendChild(td(`${row.year}-${String(row.month).padStart(2, "0")}`));
      tr.appendChild(td(entry?.nf || "—"));

      tr.appendChild(td(formatBRL(row.moneyTotal), "right"));
      tr.appendChild(td(formatBRL(row.rate), "right"));
      tr.appendChild(td(formatHours(row.hours), "right"));

      const diffTd = td(signedHours(row.diff), "right");
      diffTd.className += " " + (row.diff >= 0 ? "good" : "bad");
      tr.appendChild(diffTd);

      const bankTd = td(formatHours(row.bankAfter), "right");
      bankTd.className += " " + (row.bankAfter >= 0 ? "good" : "bad");
      tr.appendChild(bankTd);

      tr.appendChild(td(formatBRL(PAGAMENTO), "right"));

      const actionsTd = document.createElement("td");
      actionsTd.className = "right";

      const wrap = document.createElement("div");
      wrap.className = "actionsInline";

      const editBtn = document.createElement("button");
      editBtn.className = "smallBtn";
      editBtn.textContent = "Editar";
      editBtn.addEventListener("click", () => enterEditMode(row.id));

      const delBtn = document.createElement("button");
      delBtn.className = "smallBtn";
      delBtn.textContent = "Excluir";
      delBtn.addEventListener("click", () => deleteEntry(row.id));

      wrap.appendChild(editBtn);
      wrap.appendChild(delBtn);
      actionsTd.appendChild(wrap);

      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    }
  }

  function updatePreview() {
    const rate = safeNum(rateInput.value, 225);
    if (!(rate > 0)) {
      calcPreview.textContent = "Valor/hora precisa ser > 0.";
      return;
    }

    const osList = readOsFromUI(false);
    const totalMoney = round2(osList.reduce((acc, x) => acc + x.value, 0));
    const hours = rate > 0 ? round2(totalMoney / rate) : 0;

    if (totalMoney <= 0) {
      calcPreview.textContent = "Preencha pelo menos uma OS com valor (R$).";
      return;
    }

    calcPreview.textContent = `Total OS: ${formatBRL(totalMoney)} → Horas: ${formatHours(hours)} (=${formatBRL(totalMoney)} ÷ ${formatBRL(rate)}/h)`;
  }

  function enterEditMode(id) {
    const entry = state.entries.find((x) => x.id === id);
    if (!entry) return;

    editingId = id;

    monthInput.value = `${entry.year}-${String(entry.month).padStart(2, "0")}`;
    rateInput.value = String(entry.rate ?? 225);
    nfInput.value = entry.nf ?? "";

    osTbody.innerHTML = "";
    const list = Array.isArray(entry.os) ? entry.os : [];
    if (list.length === 0) {
      ensureOsRows(3);
    } else {
      for (const os of list) addOsRow(os.num ?? "", os.value ?? "");
      while (osTbody.querySelectorAll("tr").length < 3) addOsRow();
    }

    saveBtn.textContent = "Salvar edição";
    cancelEditBtn.hidden = false;

    updatePreview();
  }

  function exitEditMode() {
    editingId = null;
    saveBtn.textContent = "Adicionar";
    cancelEditBtn.hidden = true;
  }

  function deleteEntry(id) {
    const ok = confirm("Excluir esse mês?");
    if (!ok) return;
    state.entries = state.entries.filter((x) => x.id !== id);
    saveState(state);
    if (editingId === id) exitEditMode();
    render();
  }

  function computeTimeline(entries) {
    const sorted = [...entries].sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));

    const rows = [];
    let bank = 0;

    for (const e of sorted) {
      const rate = Number.isFinite(Number(e.rate)) ? Number(e.rate) : 225;
      const moneyTotal = Number.isFinite(Number(e.moneyTotal))
        ? Number(e.moneyTotal)
        : round2((Array.isArray(e.os) ? e.os : []).reduce((acc, x) => acc + (Number(x.value) || 0), 0));

      const hours = Number.isFinite(Number(e.hours)) ? Number(e.hours) : round2(moneyTotal / rate);
      const diff = round2(hours - META_HORAS);
      bank = round2(bank + diff);

      rows.push({
        id: e.id,
        year: e.year,
        month: e.month,
        rate: round2(rate),
        moneyTotal: round2(moneyTotal),
        hours: round2(hours),
        diff,
        bankAfter: bank
      });
    }

    return { rows, bankNow: bank, isFrozenNow: bank < FREEZE_THRESHOLD };
  }

  // ---------------- OS UI ----------------
  function ensureOsRows(n) {
    while (osTbody.querySelectorAll("tr").length < n) addOsRow();
    updatePreview();
  }

  function addOsRow(num = "", value = "") {
    const tr = document.createElement("tr");

    const tdNum = document.createElement("td");
    const numInput = document.createElement("input");
    numInput.type = "text";
    numInput.placeholder = "ex: 1029";
    numInput.value = String(num);
    numInput.className = "osInput";
    tdNum.appendChild(numInput);

    const tdVal = document.createElement("td");
    tdVal.className = "right";
    const valInput = document.createElement("input");
    valInput.type = "number";
    valInput.inputMode = "decimal";
    valInput.step = "0.01";
    valInput.min = "0";
    valInput.placeholder = "ex: 2000";
    valInput.value = value === "" ? "" : String(value);
    valInput.className = "osInput osMoney";
    tdVal.appendChild(valInput);

    const tdAct = document.createElement("td");
    tdAct.className = "right";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "smallBtn";
    rm.textContent = "Remover";
    rm.addEventListener("click", () => {
      tr.remove();
      // garante pelo menos 1 linha
      if (osTbody.querySelectorAll("tr").length === 0) addOsRow();
      updatePreview();
    });
    tdAct.appendChild(rm);

    tr.appendChild(tdNum);
    tr.appendChild(tdVal);
    tr.appendChild(tdAct);

    osTbody.appendChild(tr);
  }

  // strict=true => valida valor quando houver qualquer coisa na linha
  function readOsFromUI(strict = true) {
    const rows = [...osTbody.querySelectorAll("tr")];
    const list = [];

    for (const r of rows) {
      const inputs = r.querySelectorAll("input");
      const num = (inputs[0]?.value || "").trim();
      const valRaw = (inputs[1]?.value || "").trim();

      const hasSomething = num.length > 0 || valRaw.length > 0;
      if (!hasSomething) continue;

      const value = round2(safeNum(valRaw, NaN));
      if (strict && !Number.isFinite(value)) {
        alert("Tem uma OS preenchida sem valor válido. Corrige ali.");
        throw new Error("Invalid OS value");
      }
      if (!Number.isFinite(value)) continue;

      list.push({ num, value });
    }

    return list;
  }

  // ---------------- XLS (SpreadsheetML) ----------------
  function buildSpreadsheetXml({ lastEntry, lastRow, prevBank, timelineRows }) {
    const monthStr = `${lastRow.year}-${String(lastRow.month).padStart(2, "0")}`;

    const resumo = [
      ["Mês exportado", monthStr],
      ["NF", lastEntry.nf || ""],
      ["Valor/hora (R$)", lastRow.rate],
      ["Total OS (R$)", lastRow.moneyTotal],
      ["Horas do mês", lastRow.hours],
      ["Meta do mês (h)", META_HORAS],
      ["Diferença do mês (h)", lastRow.diff],
      ["Saldo antes do mês (h)", prevBank],
      ["Saldo após o mês (h)", lastRow.bankAfter],
      ["Pagamento do mês (R$)", PAGAMENTO],
    ];

    const historicoHeader = ["Mês", "Total OS (R$)", "R$/h", "Horas", "Diferença (h)", "Saldo após mês (h)"];
    const historico = timelineRows.map(r => ([
      `${r.year}-${String(r.month).padStart(2, "0")}`,
      r.moneyTotal,
      r.rate,
      r.hours,
      r.diff,
      r.bankAfter
    ]));

    const osHeader = ["Nº OS", "Valor (R$)"];
    const osRows = (Array.isArray(lastEntry.os) ? lastEntry.os : []).map(o => [o.num || "", Number(o.value) || 0]);

    // Workbook XML 2003 (Excel abre como .xls)
    return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  ${xmlSheet("Resumo", [["Campo","Valor"], ...resumo])}
  ${xmlSheet("OS do mês", [osHeader, ...osRows])}
  ${xmlSheet("Histórico banco", [historicoHeader, ...historico])}
</Workbook>`;
  }

  function xmlSheet(name, rows) {
    return `<Worksheet ss:Name="${xmlEsc(name)}">
      <Table>
        ${rows.map(r => `<Row>${r.map(cell => xmlCell(cell)).join("")}</Row>`).join("")}
      </Table>
    </Worksheet>`;
  }

  function xmlCell(v) {
    const isNum = typeof v === "number" && Number.isFinite(v);
    const type = isNum ? "Number" : "String";
    const val = isNum ? String(v) : xmlEsc(String(v ?? ""));
    return `<Cell><Data ss:Type="${type}">${val}</Data></Cell>`;
  }

  function xmlEsc(s) {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  // ---------------- storage ----------------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) {
          return { entries: uniqueById(parsed.entries.map(normalizeEntry).filter(Boolean)) };
        }
      }

      // tenta migrar v2/v1 se existirem
      const fallbackKeys = ["contract_hours_tracker_v2", "contract_hours_tracker_v1"];
      for (const k of fallbackKeys) {
        const rawOld = localStorage.getItem(k);
        if (!rawOld) continue;
        const parsedOld = JSON.parse(rawOld);
        if (parsedOld && Array.isArray(parsedOld.entries)) {
          const migrated = { entries: uniqueById(parsedOld.entries.map(normalizeEntry).filter(Boolean)) };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch {}
    return { entries: [] };
  }

  function saveState(s) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }

  // aceita entrada v1/v2 e converte para v3
  function normalizeEntry(e) {
    if (!e) return null;

    const year = Number(e.year);
    const month = Number(e.month);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

    const id = (typeof e.id === "string" && e.id) ? e.id : `${year}-${String(month).padStart(2, "0")}`;

    // v3
    if (Array.isArray(e.os)) {
      const rate = Number.isFinite(Number(e.rate)) ? round2(Number(e.rate)) : 225;
      const os = e.os
        .map(o => ({ num: (o?.num || "").trim(), value: round2(Number(o?.value) || 0) }))
        .filter(o => Number.isFinite(o.value) && o.value >= 0);

      const moneyTotal = Number.isFinite(Number(e.moneyTotal))
        ? round2(Number(e.moneyTotal))
        : round2(os.reduce((acc, x) => acc + x.value, 0));

      const hours = Number.isFinite(Number(e.hours)) ? round2(Number(e.hours)) : round2(moneyTotal / rate);
      return { id, year, month, nf: (e.nf || "").trim(), rate, os, moneyTotal, hours };
    }

    // v2/v1 (tinha hours, rate, money)
    const rate = Number.isFinite(Number(e.rate)) ? round2(Number(e.rate)) : 225;
    const hours = Number.isFinite(Number(e.hours)) ? round2(Number(e.hours)) : 0;
    const moneyTotal = Number.isFinite(Number(e.money)) ? round2(Number(e.money)) : round2(hours * rate);

    // cria uma OS única "migrada"
    const os = moneyTotal > 0 ? [{ num: "", value: moneyTotal }] : [];
    return { id, year, month, nf: "", rate, os, moneyTotal, hours };
  }

  function uniqueById(entries) {
    const map = new Map();
    for (const e of entries) if (e?.id) map.set(e.id, e);
    return [...map.values()];
  }

  // ---------------- helpers ----------------
  function td(text, extraClass = "") {
    const el = document.createElement("td");
    el.textContent = text;
    if (extraClass) el.className = extraClass;
    return el;
  }

  function parseMonthValue(val) {
    const [y, m] = val.split("-").map(Number);
    return { year: y, month: m };
  }

  function toMonthValue(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function formatBRL(n) {
    return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatHours(h) {
    const abs = Math.abs(h);
    return `${(abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2))}h`.replace(".", ",");
  }

  function signedHours(h) {
    const sign = h > 0 ? "+" : (h < 0 ? "−" : "");
    const abs = Math.abs(h);
    const s = (abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2)).replace(".", ",");
    return `${sign}${s}h`;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function safeNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // init
  updatePreview();
  render();
})();
