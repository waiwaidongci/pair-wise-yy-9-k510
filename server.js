import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb, findItem, createItem, advance } from "./lib/store.js";
import { view, STATUS_ORDER } from "./lib/workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3040);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function sendError(res, error) {
  const { http = 500, ...payload } = error;
  send(res, http, { error: payload });
}
async function staticFile(res, file) {
  try {
    const text = await readFile(join(publicDir, file), "utf8");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(text);
  } catch {
    send(res, 404, { error: { code: "not_found" } });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return staticFile(res, "index.html");
    }
    if (req.method === "GET" && pathname === "/app.js") return staticFile(res, "app.js");

    // 列表
    if (req.method === "GET" && pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(view));
    }

    // 统计（按工序推导，不再读可被覆盖的 status）
    if (req.method === "GET" && pathname === "/api/stats") {
      const db = await loadDb();
      const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
      for (const item of db.items) counts[view(item).status] += 1;
      return send(res, 200, { statuses: STATUS_ORDER, counts });
    }

    // 建档
    if (req.method === "POST" && pathname === "/api/items") {
      const db = await loadDb();
      const item = createItem(await body(req));
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, view(item));
    }

    const detail = pathname.match(/^\/api\/items\/([^/]+)$/);
    if (detail && req.method === "GET") {
      const db = await loadDb();
      const item = findItem(db, detail[1]);
      if (!item) return send(res, 404, { error: { code: "item_not_found" } });
      return send(res, 200, view(item));
    }

    // 工序推进：越级 / 修补记录缺失等冲突返回 409，lib/store.js 在写入前判定，原档案保留
    const stepRoute = pathname.match(/^\/api\/items\/([^/]+)\/advance$/);
    if (stepRoute && req.method === "POST") {
      const db = await loadDb();
      const item = findItem(db, stepRoute[1]);
      if (!item) return send(res, 404, { error: { code: "item_not_found" } });
      const result = await advance(db, item, await body(req));
      if (result.error) return sendError(res, result.error);
      return send(res, 201, result.item);
    }

    return send(res, 404, { error: { code: "not_found" } });
  } catch (error) {
    return sendError(res, { http: 500, code: "invalid_request", message: error.message });
  }
});

server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
