# 古法蓝晒底片整理室

底片工艺流转系统。运行：

```bash
npm start
```

访问 `http://localhost:3040`。数据保存在 `data/cyanotype-negative-room.json`（先写临时文件再原子替换）。

## 工艺流转

```
建档 → 涂布 → 晾干 → 曝光 → 冲洗 → 入盒
                      └─ 发现缺陷 → 修版（必填修补记录）→ 复晒 → 冲洗复检 ─┘
```

- 步骤只能按顺序推进，不能跳过；越级提交返回 **409**（`invalid_transition`），档案不写入。
- 冲洗时登记缺陷即进入返修支路；修版必须填写修补记录，否则 400（`repair_required`）。
- 返修未闭合、或缺少存放盒位时提交入盒，返回 409（`pending_items`）。
- 状态由完整历史推导，不再靠下拉框直接覆盖。
- 旧档案（旧 `status`/`logs`/`steps` 结构、缺编号或缺内部 id）加载时自动接续到现行流转，
  补登环节标记 `migrated: true`，旧字段原样保留；缺编号的档案用内部档号也能继续流转。
- 每张底片可查看当前工序、待补事项和完整历史。

## 三个业务文件

| 文件 | 职责 |
| --- | --- |
| `lib/workflow.js` | 状态判定：工序推导、待补事项、提交校验（越级判定）、旧档迁移 |
| `lib/store.js` | 数据保存：JSON 读写、原子落盘、建档与工序推进 |
| `public/app.js` | 页面操作：列表/历史渲染、表单提交、错误提示（HTML 外壳在 `public/index.html`） |

`server.js` 只保留 HTTP 路由。

## 主要接口

- `GET /api/items` / `GET /api/items/:idOrCode` — 档案视图（含 `stage`、`nextStep`、`pending`、`history`）
- `POST /api/items` — 建档（编号可空，一律从「建档」起步）
- `POST /api/items/:idOrCode/advance` — 推进工序，body：`{ step, note?, defect?, repair?, box? }`
- `GET /api/stats` — 各工序在制数量
