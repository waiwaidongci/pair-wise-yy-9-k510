import http from "node:http";
import { addNote, advanceItem, createItem, loadDb } from "./store.js";
import { present, stats } from "./workflow.js";
import { renderPage } from "./view.js";

const port = Number(process.env.PORT || 3040);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.status = 400;
    err.code = "bad_json";
    throw err;
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 业务错误（越级 409、缺修补记录 409、找不到 404 等）到 HTTP 状态的唯一映射点
function sendError(res, error) {
  const status = error.status || 500;
  send(res, status, {
    error: error.message,
    code: error.code || "internal_error",
    ...(error.expected ? { expected: error.expected, received: error.received } : {}),
    ...(error.defects ? { defects: error.defects } : {}),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }

    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(present));
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, stats(db.items));
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const item = await createItem(await readBody(req));
      return send(res, 201, present(item));
    }

    const transition = url.pathname.match(/^\/api\/items\/([^/]+)\/transitions$/);
    if (transition && req.method === "POST") {
      // 越级或修补记录为空时，store 内校验抛 409，数据不落盘、原档案保留
      const item = await advanceItem(transition[1], await readBody(req));
      return send(res, 201, present(item));
    }

    const notes = url.pathname.match(/^\/api\/items\/([^/]+)\/notes$/);
    if (notes && req.method === "POST") {
      const item = await addNote(notes[1], await readBody(req));
      return send(res, 201, present(item));
    }

    return send(res, 404, { error: "not_found", code: "not_found" });
  } catch (error) {
    return sendError(res, error);
  }
});

server.listen(port, () =>
  console.log("古法蓝晒底片整理室 listening on http://localhost:" + port),
);
