// 业务文件二：数据保存
// JSON 文件读写、旧档案迁移、原子落盘。不判定工艺，不渲染页面。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateItem, planAdvance, view } from "./workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dbPath = join(__dirname, "..", "data", "cyanotype-negative-room.json");

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
      logs: [{ at: "2026-06-20", step: "曝光", note: "阴天补时2分钟" }],
    },
  ],
};

const CREATE_FIELDS = ["code", "plateSize", "chemicalBatch", "exposure", "waterSource", "box"];
const clean = (value) => (value === null || value === undefined ? "" : String(value).trim());
const pad3 = (n) => String(n).padStart(3, "0");

// 先写临时文件再重命名，避免落盘中途损坏原档案
async function atomicWrite(path, content) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

/** 读库并迁移；迁移只做增量（补 id/history），旧字段原样保留 */
export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await atomicWrite(dbPath, JSON.stringify(seed, null, 2));
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  let changed = false;
  raw.items = (raw.items || []).map((item, index) => {
    const needsMigration = !item.id || !Array.isArray(item.history);
    if (!needsMigration) return item;
    changed = true;
    return migrateItem(item, index);
  });
  if (changed) await atomicWrite(dbPath, JSON.stringify(raw, null, 2));
  return raw;
}

export async function saveDb(db) {
  await atomicWrite(dbPath, JSON.stringify(db, null, 2));
}

export function findItem(db, idOrCode) {
  const key = decodeURIComponent(idOrCode);
  return db.items.find((x) => x.id === key || x.code === key);
}

let codeSeq = 0;
function nextId() {
  return `CN-${Date.now().toString(36)}${pad3(++codeSeq % 1000)}`;
}

/** 建档：从“建档”起步，不能自带状态越级 */
export function createItem(input = {}) {
  const fields = {};
  for (const key of CREATE_FIELDS) fields[key] = clean(input[key]);

  const item = {
    id: nextId(),
    ...fields,
    history: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }],
  };
  return item;
}

/**
 * 工序推进。
 * @returns {result} { item } 成功；{ error } 为 lib/workflow.js 判定的冲突（调用方返回 409，原档案保留）
 */
export async function advance(db, item, input) {
  const result = planAdvance(item, input);
  if (result.error) return result;

  item.history.push(result.event);
  if (result.event.step === "入盒" && result.event.box) item.box = result.event.box;
  await saveDb(db);
  return { item: view(item) };
}
