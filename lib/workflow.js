// 业务文件一：状态判定
// 纯工艺规则，不读写文件、不操作页面。
// 主流程：建档 → 涂布 → 晾干 → 曝光 → 冲洗 → 入盒
// 返修支路：冲洗发现缺陷 → 修版（须填修补记录）→ 复晒 → 冲洗复检 → 入盒

export const FLOW = ["涂布", "晾干", "曝光", "冲洗", "入盒"];
export const REPAIR = ["修版", "复晒"];
export const STEPS = ["建档", ...FLOW.slice(0, 4), ...REPAIR, "入盒"];

// 页面统计的展示顺序
export const STATUS_ORDER = [
  "待涂布", "待晾干", "待曝光", "待冲洗", "返修中", "待入盒", "已入盒",
];

// 旧档案状态 → 已完成的主流程步数
const LEGACY_STATUS_UNTIL = {
  待曝光: 2, // 涂布、晾干已完成
  冲洗中: 3, // 曝光已完成，等待冲洗
  待入盒: 4, // 冲洗已完成
  已交付: 5, // 入盒已完成
};

const clean = (value) => (value === null || value === undefined ? "" : String(value).trim());
const pad3 = (n) => String(n).padStart(3, "0");

/**
 * 依据完整历史推导当前工序状态。
 * 返回 { stage, nextStep, status, repairing }
 * - stage：最近完成的工序（建档 / 涂布 / … / 入盒）
 * - nextStep：唯一允许的下一步；null 表示已入盒
 * - repairing：是否处于返修支路
 */
export function derive(history = []) {
  let flowIndex = -1; // -1 表示只有建档
  let mode = "normal"; // normal | repair（待修版） | resun（待复晒） | rewash（待复检冲洗）

  for (const ev of history) {
    switch (ev.step) {
      case "涂布": flowIndex = 0; mode = "normal"; break;
      case "晾干": flowIndex = 1; break;
      case "曝光": flowIndex = 2; break;
      case "冲洗":
        flowIndex = 3;
        mode = clean(ev.defect) ? "repair" : "normal";
        break;
      case "修版": mode = "resun"; break;
      case "复晒": mode = "rewash"; break;
      case "入盒": flowIndex = 4; mode = "normal"; break;
      // “建档”及其它旧备注不参与工序定位
    }
  }

  const repairing = mode !== "normal";
  let nextStep = null;
  if (flowIndex < 4) {
    if (mode === "repair") nextStep = "修版";
    else if (mode === "resun") nextStep = "复晒";
    else if (mode === "rewash") nextStep = "冲洗";
    else nextStep = FLOW[flowIndex + 1];
  }

  const stage = flowIndex === -1 ? "建档" : FLOW[flowIndex];
  const status = flowIndex >= 4 ? "已入盒" : repairing ? "返修中" : `待${nextStep}`;
  return { stage, nextStep, status, repairing };
}

export function boxOf(item) {
  if (clean(item.box)) return clean(item.box);
  for (let i = (item.history || []).length - 1; i >= 0; i--) {
    if (item.history[i].box) return clean(item.history[i].box);
  }
  return "";
}

/** 待补事项：进入下一步前必须处理的清单 */
export function pendingItems(item) {
  const state = derive(item.history || []);
  if (!state.nextStep) return [];

  const pending = [];
  if (state.nextStep === "修版") pending.push("冲洗发现缺陷：修版并填写修补记录");
  else if (state.nextStep === "复晒") pending.push("修版已完成，安排复晒");
  else if (state.nextStep === "冲洗" && state.repairing) pending.push("复晒后重新冲洗复检");
  else pending.push(`推进至「${state.nextStep}」`);

  if (state.nextStep === "入盒" && !boxOf(item)) pending.push("补填存放盒位");
  return pending;
}

/**
 * 校验一次工序提交（不修改原档案）。
 * 合法：返回 { event }；非法：返回 { error: { http, code, ... } }
 */
export function planAdvance(item, input = {}) {
  const state = derive(item.history || []);
  const step = clean(input.step);
  const note = clean(input.note);
  const defect = clean(input.defect);
  const repair = clean(input.repair);
  const box = clean(input.box) || boxOf(item);

  if (!STEPS.includes(step) || step === "建档") {
    return { error: { http: 400, code: "unknown_step", got: step, allowed: STEPS.slice(1) } };
  }
  if (!state.nextStep) {
    return { error: { http: 409, code: "already_finished", current: view(item) } };
  }
  // 越级 / 跳步：直接冲突，调用方不得写入
  if (step !== state.nextStep) {
    return {
      error: {
        http: 409,
        code: "invalid_transition",
        expected: state.nextStep,
        got: step,
        pending: pendingItems(item),
        current: view(item),
      },
    };
  }
  if (step === "修版" && !repair) {
    return { error: { http: 400, code: "repair_required", message: "修版必须填写修补记录" } };
  }
  if (step === "入盒") {
    const pending = [];
    if (state.repairing) pending.push("返修流程未完成（修版 → 复晒 → 冲洗复检）");
    if (!box) pending.push("缺少存放盒位");
    if (pending.length) {
      return { error: { http: 409, code: "pending_items", pending, current: view(item) } };
    }
  }

  const event = { at: new Date().toISOString(), step };
  if (note) event.note = note;
  if (step === "冲洗" && defect) event.defect = defect;
  if (step === "修版") event.repair = repair;
  if (step === "入盒") event.box = box;
  return { event };
}

/** 给列表 / 详情使用的只读视图：当前工序、待补事项、完整历史 */
export function view(item) {
  const state = derive(item.history || []);
  return {
    id: item.id,
    code: clean(item.code),
    plateSize: clean(item.plateSize),
    chemicalBatch: clean(item.chemicalBatch),
    exposure: clean(item.exposure),
    waterSource: clean(item.waterSource),
    box: boxOf(item),
    stage: state.stage,
    nextStep: state.nextStep,
    status: state.status,
    repairing: state.repairing,
    pending: pendingItems(item),
    history: item.history || [],
  };
}

// ---- 旧档案迁移 ----------------------------------------------------------------

/**
 * 把旧格式档案接上现行流转：
 * - 缺 id / 编号：补稳定内部 id（code 仍可空）
 * - 没有 history：按旧 status、logs、steps 反推标准工序链，
 *   推不出来的环节标记 migrated（旧档补登），原字段一律保留不动
 */
export function migrateItem(raw, index = 0) {
  if (Array.isArray(raw.history) && raw.history.length) {
    return { ...raw, id: raw.id || clean(raw.code) || `legacy-${pad3(index + 1)}` };
  }

  const real = [];
  for (const ev of [...(raw.logs || []), ...(raw.steps || [])]) {
    if (STEPS.includes(ev.step) && ev.step !== "建档") {
      real.push({
        at: ev.at || null,
        step: ev.step,
        ...(clean(ev.note) ? { note: clean(ev.note) } : {}),
        ...(clean(ev.defect) ? { defect: clean(ev.defect) } : {}),
        ...(clean(ev.repair) ? { repair: clean(ev.repair) } : {}),
      });
    }
  }
  real.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const first = (name) => real.find((ev) => ev.step === name);
  const anchor = real.find((ev) => ev.at)?.at || null;
  const synth = (name, extra = {}) => ({
    at: anchor,
    step: name,
    note: "旧档补登",
    migrated: true,
    ...extra,
  });

  // 旧档当前位置以旧 status 为准（历史里可能误记过后面的步骤，不能反向覆盖状态）；
  // status 无法识别时才退回按历史记录推断
  let target = LEGACY_STATUS_UNTIL[raw.status];
  if (target === undefined) {
    target = -1;
    for (const ev of real) {
      const i = FLOW.indexOf(ev.step);
      if (i >= 0) target = Math.max(target, i + 1);
    }
  }

  const history = [];
  for (let i = 0; i < Math.min(target, 4); i++) {
    const name = FLOW[i];
    const ev = first(name);
    if (ev) history.push(ev);
    else if (name === "冲洗" && clean(raw.defect)) history.push(synth("冲洗", { defect: clean(raw.defect) }));
    else history.push(synth(name));
  }

  // 已到入盒关口却带着未闭合的缺陷：有修补记录就补登返修支路，没有则停在“待修版”
  const washDefect = clean(raw.defect) || history.find((ev) => ev.step === "冲洗" && ev.defect)?.defect;
  const openRepair = clean(first("修版")?.repair)
    || (raw.steps || []).map((s) => clean(s.repair)).find(Boolean)
    || "";
  if (target >= 4 && washDefect) {
    if (openRepair) {
      history.push(synth("修版", { repair: openRepair }));
      history.push(synth("复晒"));
      history.push(synth("冲洗", { note: "旧档补登复检" }));
    }
  }

  if (target >= 5) {
    const boxing = first("入盒");
    if (boxing) history.push(boxing);
    else history.push(synth("入盒", { ...(clean(raw.box) ? { box: clean(raw.box) } : {}) }));
  }

  return {
    ...raw,
    id: raw.id || clean(raw.code) || `legacy-${pad3(index + 1)}`,
    history,
  };
}
