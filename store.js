// 数据保存：JSON 文件读写、旧档案迁移、建档与工序推进。
// 所有推进必须先通过 workflow.validateTransition，通过后才追加记录并落盘，
// 校验失败（如越级）时不修改任何数据，原档案保留。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREATE_STEP,
  clean,
  expectedStep,
  validateTransition,
  buildRecord,
} from "./workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.env.DB_PATH || join(__dirname, "data", "cyanotype-negative-room.json");

const TEXT_FIELDS = [
  ["code", "底片编号"],
  ["plateSize", "玻璃板尺寸"],
  ["chemicalBatch", "药液批次"],
  ["exposure", "曝光时间"],
  ["waterSource", "冲洗水源"],
  ["box", "存放盒位"],
];

const seed = {
  items: [
    {
      code: "CN-001",
      plateSize: "18x24cm",
      chemicalBatch: "B-0620",
      exposure: "8分钟",
      waterSource: "井水过滤",
      box: "蓝盒A-03",
      status: "待入盒",
      defect: "边角显影不均",
      logs: [
        { at: "2026-06-20", step: "曝光", note: "阴天补时2分钟" },
        { at: "2026-06-21T03:50:30.042Z", step: "入盒", note: "放入A盒" },
      ],
      steps: [
        {
          at: "2026-06-21T03:50:30.042Z",
          step: "入盒",
          developStatus: "稳定",
          defect: "边角显影不均",
          repair: "边角重涂",
          note: "放入A盒",
        },
      ],
    },
  ],
};

function nowIso() {
  return new Date().toISOString();
}

// 内部唯一 id；旧档案可能只有编号没有 id，载入时补一个。
function newInternalId(existing) {
  let id = `neg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  while (existing.has(id)) {
    id = `neg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return id;
}

// 旧档迁移：缺 id 补 id；只有 logs 的，把工艺类记录迁入 steps 以接续流转。
// 返回是否发生了需要落盘的变更。
function migrateItem(item, usedIds) {
  let changed = false;
  if (!item || typeof item !== "object") return { item: null, changed };
  if (!clean(item.id)) {
    item.id = newInternalId(usedIds);
    changed = true;
  }
  usedIds.add(item.id);

  if (!Array.isArray(item.steps)) {
    item.steps = [];
    changed = true;
  }
  for (const log of Array.isArray(item.logs) ? item.logs : []) {
    if (!log || typeof log.step !== "string") continue;
    const duplicate = item.steps.some(
      (r) => r.at === log.at && r.step === log.step,
    );
    if (!duplicate) {
      // 旧 logs 里可能登记了缺陷/修补等关键信息，必须一并带入，
      // 否则“冲洗有缺陷待修版”的旧档会被误判成可直接入盒。
      const rec = { at: log.at, step: log.step, note: log.note };
      for (const key of ["developStatus", "defect", "repair"]) {
        const value = clean(log[key]);
        if (value) rec[key] = value;
      }
      item.steps.push(rec);
      changed = true;
    }
  }
  if (changed) {
    // 旧档 logs 与 steps 可能顺序交错，迁移时统一按时间排序，
    // 保证 workflow 重放得到真实到达的工序。
    item.steps.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  }

  // 旧档的 steps/logs 原样保留在文件中；当前工序一律由 workflow 从
  // steps 重放派生，不再读取或回写旧 status，避免新状态盖住原档案。
  return { item, changed };
}

let dbCache = null;

export async function loadDb({ force = false } = {}) {
  if (dbCache && !force) return dbCache;
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(db.items)) db.items = [];
  const usedIds = new Set(db.items.map((i) => i?.id).filter(Boolean));
  let changed = false;
  db.items = db.items
    .map((raw) => {
      const { item, changed: itemChanged } = migrateItem(raw, usedIds);
      if (itemChanged) changed = true;
      return item;
    })
    .filter(Boolean);
  if (changed) {
    await writeFile(dbPath, JSON.stringify(db, null, 2));
  }
  dbCache = db;
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
  dbCache = db;
}

export function findItem(db, idOrCode) {
  const key = decodeURIComponent(String(idOrCode));
  return (
    db.items.find((x) => x.id === key || (clean(x.code) && x.code === key)) ||
    null
  );
}

function pickFields(input) {
  const out = {};
  for (const [key] of TEXT_FIELDS) {
    const value = clean(input?.[key]);
    if (value) out[key] = value;
  }
  return out;
}

// 建档：编号允许留空（旧档/新档都可能暂无编号），留空不影响后续流转。
export async function createItem(input) {
  const db = await loadDb();
  const usedIds = new Set(db.items.map((i) => i.id));
  const code = clean(input.code);
  if (code && db.items.some((i) => clean(i.code) === code)) {
    const err = new Error("编号已存在");
    err.status = 409;
    err.code = "duplicate_code";
    throw err;
  }
  const at = nowIso();
  const item = {
    id: newInternalId(usedIds),
    ...pickFields(input),
    status: "待涂布",
    steps: [{ at, step: CREATE_STEP, note: "建立底片档案" }],
    logs: [],
    createdAt: at,
  };
  db.items.unshift(item);
  await saveDb(db);
  return item;
}

// 推进一道工序。校验不通过直接抛错，文件与内存均保持原状。
export async function advanceItem(idOrCode, input) {
  const db = await loadDb();
  const item = findItem(db, idOrCode);
  if (!item) {
    const err = new Error("底片不存在");
    err.status = 404;
    err.code = "item_not_found";
    throw err;
  }
  const { step } = validateTransition(item, input); // 越级/缺修补记录在此 409
  const rec = buildRecord(input, nowIso());

  // 入盒时允许一并补登盒位
  if (step === "入盒") {
    const box = clean(input.box) || clean(item.box);
    if (box) item.box = box;
  }

  item.steps.push(rec);
  item.logs.push({ at: rec.at, step: rec.step, note: rec.note || "" });
  item.status = expectedStep(item) === "已入盒" ? "已入盒" : `待${expectedStep(item)}`;

  await saveDb(db); // 校验通过后才落盘
  return item;
}

// 追加备注：不是工艺推进，不改变当前工序。
export async function addNote(idOrCode, input) {
  const db = await loadDb();
  const item = findItem(db, idOrCode);
  if (!item) {
    const err = new Error("底片不存在");
    err.status = 404;
    err.code = "item_not_found";
    throw err;
  }
  const note = clean(input.note);
  if (!note) {
    const err = new Error("备注内容为空");
    err.status = 400;
    err.code = "empty_note";
    throw err;
  }
  const entry = { at: nowIso(), step: "备注", note };
  item.logs.push(entry);
  await saveDb(db);
  return item;
}

export { TEXT_FIELDS, dbPath };
