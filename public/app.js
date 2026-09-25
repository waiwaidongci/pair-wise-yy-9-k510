// 业务文件三：页面操作
// 只负责取数、渲染、表单提交与错误提示；工艺规则以服务端返回为准，页面不下拉改状态。

const CREATE_FIELDS = [
  ["code", "底片编号（可空）"],
  ["plateSize", "玻璃板尺寸"],
  ["chemicalBatch", "药液批次"],
  ["exposure", "曝光时间"],
  ["waterSource", "冲洗水源"],
  ["box", "存放盒位"],
];

// 每道工序在表单里补充的字段
const STEP_FIELDS = {
  涂布: [["note", "备注（药液涂布情况）"]],
  晾干: [["note", "备注（晾干时长/天气）"]],
  曝光: [["note", "备注（曝光时长/光线）"]],
  冲洗: [["defect", "缺陷类型（正常则留空）"], ["note", "备注（显影情况）"]],
  修版: [["repair", "修补记录（必填）"], ["note", "备注"]],
  复晒: [["note", "备注（补晒时长）"]],
  入盒: [["box", "存放盒位"], ["note", "备注"]],
};

const $ = (sel) => document.querySelector(sel);
const createForm = $("#createForm");
const advanceForm = $("#advanceForm");
const itemSelect = $("#itemSelect");
const stepSelect = $("#stepSelect");
const stepFields = $("#stepFields");
const cards = $("#cards");
const statsEl = $("#stats");
const statusFilter = $("#statusFilter");
const toastEl = $("#toast");

let items = [];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function displayCode(item) {
  return item.code || `旧档#${String(item.id).slice(-6)}`;
}
function fmtDate(at) {
  if (!at) return "日期不详";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at.slice(0, 10);
  return d.toLocaleString("zh-CN", { hour12: false });
}
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? "error" : "";
  toastEl.style.display = "block";
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { toastEl.style.display = "none"; }, 5000);
}

async function api(path, options) {
  const res = await fetch(path, options && options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(data.error?.message || data.error?.code || "请求失败");
    err.payload = data.error || data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function describeError(err) {
  const e = err.payload || {};
  if (e.code === "invalid_transition") {
    return `工序冲突（409）：当前应先「${e.expected}」，不能提交「${e.got}」。\n`
      + (e.pending || []).map((p) => `· ${p}`).join("\n");
  }
  if (e.code === "pending_items") {
    return `暂不能入盒（409）：\n${(e.pending || []).map((p) => `· ${p}`).join("\n")}`;
  }
  if (e.code === "already_finished") return "该底片已入盒，工序全部完成。";
  if (e.code === "repair_required") return "修版必须填写修补记录，补全后再提交。";
  return err.message;
}

function renderCreateForm() {
  $("#createFields").innerHTML = CREATE_FIELDS
    .map(([key, label]) => `<label>${label}</label><input name="${key}" type="text">`).join("");
}

function renderSelects() {
  itemSelect.innerHTML = items
    .map((item) => `<option value="${esc(item.id)}">${esc(displayCode(item))} · ${esc(item.status)}</option>`)
    .join("");
  syncStepSelect();
}

// 工序下拉只给出当前允许的下一步，从源头避免跳步；服务端仍做 409 兜底
function syncStepSelect() {
  const item = items.find((x) => x.id === itemSelect.value) || items[0];
  if (item && item.id) itemSelect.value = item.id;
  stepSelect.innerHTML = item && item.nextStep
    ? `<option value="${esc(item.nextStep)}">${esc(item.nextStep)}</option>`
    : `<option value="">已入盒，无下一步</option>`;
  renderStepFields();
}

function renderStepFields() {
  const fields = STEP_FIELDS[stepSelect.value] || [];
  const item = items.find((x) => x.id === itemSelect.value);
  stepFields.innerHTML = fields.map(([key, label]) => {
    const value = key === "box" && item ? esc(item.box || "") : "";
    return `<label>${label}</label><input name="${key}" value="${value}">`;
  }).join("");
}

function renderStats(statuses, counts) {
  statsEl.innerHTML = statuses
    .map((s) => `<div class="stat"><span>${s}</span><strong>${counts[s] || 0}</strong></div>`)
    .join("");
  const current = statusFilter.value;
  statusFilter.innerHTML = `<option value="">全部状态</option>`
    + statuses.map((s) => `<option ${s === current ? "selected" : ""}>${s}</option>`).join("");
}

function renderCards() {
  const status = statusFilter.value;
  const q = $("#search").value.trim();
  const visible = items.filter((item) => {
    if (status && item.status !== status) return false;
    if (q && !JSON.stringify(item).includes(q)) return false;
    return true;
  });
  cards.innerHTML = visible.map(cardHtml).join("") || "<p class='meta'>没有匹配的底片</p>";

  cards.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.onclick = () => {
      itemSelect.value = btn.dataset.pick;
      syncStepSelect();
      advanceForm.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
}

function cardHtml(item) {
  const metas = [
    ["玻璃板", item.plateSize], ["药液批次", item.chemicalBatch],
    ["曝光时间", item.exposure], ["冲洗水源", item.waterSource], ["盒位", item.box],
  ].filter(([, v]) => v).map(([k, v]) => `<div class="meta">${k}：${esc(v)}</div>`).join("");

  const pending = item.pending.length
    ? `<ul class="pending">${item.pending.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : "";

  const history = item.history.length
    ? `<ul class="timeline">${[...item.history].reverse().map((ev) => `
        <li><span class="at">${esc(fmtDate(ev.at))}</span><b>${esc(ev.step)}</b>${
          ev.defect ? `｜缺陷：${esc(ev.defect)}` : ""
        }${ev.repair ? `｜修补：${esc(ev.repair)}` : ""
        }${ev.box ? `｜盒位：${esc(ev.box)}` : ""
        }${ev.note ? `｜${esc(ev.note)}` : ""
        }${ev.migrated ? `<span class="tag">旧档补登</span>` : ""}</li>`).join("")}
      </ul>`
    : `<div class="meta">暂无历史</div>`;

  const pillClass = item.status === "已入盒" ? "done" : item.repairing ? "repair" : "";
  const nextLine = item.nextStep
    ? `<div class="meta">当前工序：<b>${esc(item.stage)}</b> ｜ 下一步：<b>${esc(item.nextStep)}</b></div>`
    : `<div class="meta">当前工序：<b>${esc(item.stage)}</b>，全流程完成</div>`;

  return `<article class="card">
    <h3>${esc(displayCode(item))}</h3>
    <span class="pill ${pillClass}">${esc(item.status)}</span>
    ${nextLine}
    ${metas}
    ${pending}
    ${item.nextStep ? `<div class="advance"><button class="secondary" data-pick="${esc(item.id)}">推进「${esc(item.nextStep)}」</button></div>` : ""}
    <div class="meta">完整历史（${item.history.length} 条）</div>
    ${history}
  </article>`;
}

async function load() {
  const [list, stats] = await Promise.all([api("/api/items"), api("/api/stats")]);
  items = list;
  renderSelects();
  renderStats(stats.statuses, stats.counts);
  renderCards();
}

createForm.onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(createForm).entries());
  try {
    await api("/api/items", { method: "POST", body: JSON.stringify(data) });
    createForm.reset();
    toast("建档完成，请从「涂布」开始推进工序。");
    await load();
  } catch (err) {
    toast(describeError(err), true);
  }
};

advanceForm.onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(advanceForm).entries());
  if (!data.step) { toast("该底片已入盒，无下一步。"); return; }
  try {
    await api(`/api/items/${encodeURIComponent(data.id)}/advance`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    advanceForm.reset();
    toast(`「${data.step}」已记录。`);
    await load();
  } catch (err) {
    toast(describeError(err), true);
  }
};

itemSelect.onchange = syncStepSelect;
stepSelect.onchange = renderStepFields;
statusFilter.onchange = renderCards;
$("#search").oninput = renderCards;
$("#reload").onclick = load;

renderCreateForm();
load().catch((err) => toast(describeError(err), true));
