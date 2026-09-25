// 工艺状态判定：纯业务规则，不读写文件、不操作页面。
// 主工艺链：建档 → 涂布 → 晾干 → 曝光 → 冲洗 → 入盒
// 冲洗发现缺陷：冲洗 → 修版 → 复晒 → 冲洗复检，合格后才能入盒。

export const CREATE_STEP = "建档";
export const FLOW = ["涂布", "晾干", "曝光", "冲洗", "入盒"];
export const REPAIR_STEP = "修版";
export const REEXPOSE_STEP = "复晒";
export const FINISH_STEP = "已入盒";

// 允许记录的工序（修版、复晒是返修环里的工序）
export const PROCESS_STEPS = [...FLOW, REPAIR_STEP, REEXPOSE_STEP];

// 页面统计/筛选用的阶段标签顺序
export const STAGE_ORDER = [
  "待涂布",
  "待晾干",
  "待曝光",
  "待冲洗",
  "待修版",
  "待复晒",
  "待入盒",
  FINISH_STEP,
];

const STEP_HINTS = {
  涂布: "登记涂布药液与玻璃板情况",
  晾干: "确认涂层完全干透",
  曝光: "记录本次曝光时间与光线",
  冲洗: "冲洗合格直接推进；发现缺陷请填写缺陷类型，将转入修版复晒",
  修版: "先修补底片，修补记录必须填写",
  复晒: "修补完成后重新曝光",
  入盒: "确认无遗留缺陷后放入存放盒位",
};

export const clean = (v) =>
  v === null || v === undefined ? "" : String(v).trim();

export class TransitionError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "TransitionError";
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

// 一张底片已落档的工艺记录
export function records(item) {
  return Array.isArray(item?.steps)
    ? item.steps.filter((r) => r && typeof r.step === "string")
    : [];
}

// 某道工序完成后，下一步是什么。未知记录（如“备注”）不推进状态。
function nextAfter(rec) {
  switch (rec.step) {
    case CREATE_STEP:
      return "涂布";
    case "涂布":
      return "晾干";
    case "晾干":
      return "曝光";
    case "曝光":
    case REEXPOSE_STEP:
      return "冲洗"; // 首曝、复晒之后都要冲洗（复晒后为复检冲洗）
    case "冲洗":
      return clean(rec.defect) ? REPAIR_STEP : "入盒";
    case REPAIR_STEP:
      return REEXPOSE_STEP;
    case "入盒":
      return FINISH_STEP;
    default:
      return null;
  }
}

// 重放全部记录，得到当前应提交的工序。
// 对旧档案里“跳级”的历史记录采取容忍策略（以记录为准），
// 但新提交必须严格等于该值，越级由 validateTransition 拦截。
export function expectedStep(item) {
  let next = FLOW[0];
  for (const rec of records(item)) {
    const jumped = nextAfter(rec);
    if (jumped) next = jumped;
  }
  return next;
}

// 当前所处工序（最后一道已完成的工序，建档后为“建档”）
export function currentStep(item) {
  const done = records(item).filter((r) => PROCESS_STEPS.includes(r.step));
  return done.length ? done[done.length - 1].step : CREATE_STEP;
}

export function stageLabel(item) {
  const next = expectedStep(item);
  return next === FINISH_STEP ? FINISH_STEP : `待${next}`;
}

export function reworkCount(item) {
  return records(item).filter((r) => r.step === REPAIR_STEP).length;
}

// 尚未闭合的缺陷：每次“冲洗”登记缺陷后打开一条，
// 之后任意一条带修补记录的“修版”闭合最近一条。
export function openDefects(item) {
  const open = [];
  for (const rec of records(item)) {
    if (rec.step === "冲洗" && clean(rec.defect)) {
      open.push({ at: rec.at, defect: clean(rec.defect), repair: "" });
    } else if (rec.step === REPAIR_STEP && clean(rec.repair)) {
      for (let i = open.length - 1; i >= 0; i -= 1) {
        if (!open[i].repair) {
          open[i].repair = clean(rec.repair);
          break;
        }
      }
    }
  }
  return open.filter((d) => !d.repair);
}

// 待补事项：未闭合的缺陷（警告）+ 下一步工序提示 + 入盒前缺盒位提示
export function pendingItems(item) {
  const expected = expectedStep(item);
  if (expected === FINISH_STEP) return [];
  const pending = [];
  for (const d of openDefects(item)) {
    pending.push({
      level: "warn",
      text: `缺陷「${d.defect}」缺少修补记录，补齐前禁止入盒`,
    });
  }
  pending.push({
    level: "info",
    text: `下一步工序：${expected}。${STEP_HINTS[expected] || ""}`,
  });
  if (expected === "入盒" && !clean(item.box)) {
    pending.push({ level: "info", text: "尚未填写存放盒位，可在入盒提交时一并补填" });
  }
  return pending;
}

// 核心校验：不通过直接抛 TransitionError，调用方不得写入任何数据。
export function validateTransition(item, input) {
  const step = clean(input.step);
  if (!PROCESS_STEPS.includes(step)) {
    throw new TransitionError(400, "unknown_step", `未知工序「${step || "空"}」`, {
      allowed: PROCESS_STEPS,
    });
  }
  const expected = expectedStep(item);
  if (expected === FINISH_STEP) {
    throw new TransitionError(409, "already_finished", "底片已入盒，工艺流程已结束");
  }
  if (step !== expected) {
    throw new TransitionError(
      409,
      "out_of_order",
      `工序不能越级：当前应提交「${expected}」，不能直接提交「${step}」`,
      { expected, received: step, current: currentStep(item) },
    );
  }
  if (step === REPAIR_STEP && !clean(input.repair)) {
    throw new TransitionError(409, "repair_required", "修补记录为空，不能完成修版");
  }
  if (step === "入盒") {
    const open = openDefects(item);
    if (open.length) {
      throw new TransitionError(
        409,
        "repair_required",
        "冲洗发现的缺陷仍缺少修补记录，禁止入盒",
        { defects: open.map((d) => d.defect) },
      );
    }
  }
  return { step, expected };
}

// 构造一条将被追加的工艺记录（只保留有内容的字段）
export function buildRecord(input, at) {
  const rec = { at, step: clean(input.step) };
  for (const key of ["developStatus", "defect", "repair", "note"]) {
    const value = clean(input[key]);
    if (value) rec[key] = value;
  }
  return rec;
}

// 完整历史：规范工序记录 + 旧档 logs（与 steps 同时间同步骤的视为重复，不重复展示）
export function history(item) {
  const recs = records(item);
  const out = [];
  if (!recs.length || recs[0].step !== CREATE_STEP) {
    out.push({
      at: item.createdAt || "",
      step: CREATE_STEP,
      note: item.createdAt ? "建立底片档案" : "旧档案建档（原始时间未登记）",
      legacy: true,
      synthetic: true,
    });
  }
  for (const rec of recs) out.push({ ...rec });
  const stamped = new Set(recs.map((r) => `${r.at}|${r.step}`));
  for (const log of Array.isArray(item.logs) ? item.logs : []) {
    if (!log || typeof log.step !== "string") continue;
    if (stamped.has(`${log.at}|${log.step}`)) continue;
    out.push({ at: log.at, step: log.step, note: log.note, legacy: true });
  }
  return out.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

// 列表/详情视图模型：静态档案字段 + 派生的当前工序、待补事项、历史
export function present(item) {
  const expected = expectedStep(item);
  const finished = expected === FINISH_STEP;
  const fullHistory = history(item);
  return {
    id: item.id,
    code: clean(item.code),
    displayCode: clean(item.code) || `未编号·${String(item.id).slice(-4)}`,
    plateSize: clean(item.plateSize),
    chemicalBatch: clean(item.chemicalBatch),
    exposure: clean(item.exposure),
    waterSource: clean(item.waterSource),
    box: clean(item.box),
    currentStep: currentStep(item),
    stage: stageLabel(item),
    expected: finished ? null : expected,
    finished,
    reworkCount: reworkCount(item),
    pending: pendingItems(item),
    history: fullHistory,
    logCount: fullHistory.length,
  };
}

export function stats(items) {
  const counts = Object.fromEntries(STAGE_ORDER.map((label) => [label, 0]));
  for (const item of items) {
    const label = stageLabel(item);
    if (counts[label] !== undefined) counts[label] += 1;
  }
  return counts;
}
