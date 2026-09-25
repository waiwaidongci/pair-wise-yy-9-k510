// 页面操作：服务端只负责吐出这一整页，全部交互（建档、推进工序、
// 追加备注、查看当前工序/待补事项/完整历史）都在本文件的页面脚本里完成。
// 页面上不再提供可直接改状态的下拉框，只能按工序逐道推进。

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn-bg:#f7e8e2; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:60px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; justify-self:start; }
    .pill.rework { border-color:var(--warn); color:var(--warn); margin-left:6px; }
    .pending { border-radius:6px; padding:7px 10px; font-size:13px; }
    .pending.info { background:#eef3ea; } .pending.warn { background:var(--warn-bg); color:var(--warn); font-weight:700; }
    .advance { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:6px; }
    .advance .next { font-weight:700; }
    .history { border-top:1px solid var(--line); padding-top:8px; max-height:180px; overflow:auto; display:grid; gap:4px; }
    .history .h { font-size:13px; } .history .h.legacy { color:var(--muted); }
    .err { color:var(--warn); font-weight:700; font-size:13px; min-height:1em; }
    .finished { color:var(--accent); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片整理室</h1><div class="meta">建档 → 涂布 → 晾干 → 曝光 → 冲洗 → 入盒，逐道推进不可越级；缺陷先修版复晒，修补记录空着不能入盒</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm" class="panel"><h2>新增底片建档</h2><div id="createFields"></div><div class="meta" style="margin-top:8px">编号暂缺可留空，建档后从「涂布」开始流转。</div><div class="err" id="createErr"></div><button>建档</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="stageFilter"><option value="">全部工序</option></select>
        <input id="search" placeholder="搜索编号、盒位、缺陷等">
      </div>
      <div class="panel"><h2>底片流转</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    // 与服务端 TEXT_FIELDS 保持一致的建档字段
    const createFields = ${JSON.stringify([
      ["code", "底片编号（可留空）"],
      ["plateSize", "玻璃板尺寸"],
      ["chemicalBatch", "药液批次"],
      ["exposure", "曝光时间"],
      ["waterSource", "冲洗水源"],
      ["box", "存放盒位（可入盒时补填）"],
    ])};
    const stageOrder = ["待涂布","待晾干","待曝光","待冲洗","待修版","待复晒","待入盒","已入盒"];
    const cardsEl = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const filterEl = document.querySelector('#stageFilter');
    const searchEl = document.querySelector('#search');
    let items = [];

    const esc = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    const fmtAt = at => { if (!at) return '时间未登记'; const d = new Date(at); return isNaN(d) ? at : d.toLocaleString('zh-CN', { hour12:false }); };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || '请求失败');
        err.status = res.status; err.code = data.code; err.data = data;
        throw err;
      }
      return data;
    }

    function renderCreateForm() {
      document.querySelector('#createFields').innerHTML = createFields
        .map(([key, label]) => '<label>'+esc(label)+'</label><input name="'+key+'">').join('');
    }

    // 每道工序可填写的字段；冲洗选“有缺陷”才显示缺陷类型
    function advanceFields(item) {
      const step = item.expected;
      const inputs = {
        涂布: [['note','涂布备注']],
        晾干: [['note','晾干备注']],
        曝光: [['note','曝光备注（光线、补时等）']],
        冲洗: [['developStatus','显影状态（合格/不均…）'],['defect','缺陷类型（无缺陷留空）'],['note','冲洗备注']],
        修版: [['repair','修补记录（必填）'],['note','修版备注']],
        复晒: [['note','复晒备注（重新曝光时长等）']],
        入盒: [['box','存放盒位'],['note','入盒备注']],
      }[step] || [];
      return '<input type="hidden" name="step" value="'+esc(step)+'">' +
        inputs.map(([key,label]) => '<label>'+esc(label)+'</label>'+
          (key === 'note' || key === 'repair' || key === 'defect'
            ? '<textarea name="'+key+'"></textarea>'
            : '<input name="'+key+'">')).join('');
    }

    function cardHtml(item) {
      const meta = [
        ['尺寸', item.plateSize], ['药液批次', item.chemicalBatch],
        ['曝光时间', item.exposure], ['冲洗水源', item.waterSource], ['盒位', item.box],
      ].filter(([, v]) => v).map(([k, v]) => '<span><b>'+esc(k)+'</b> '+esc(v)+'</span>').join(' · ');
      const pending = item.pending.map(p =>
        '<div class="pending '+p.level+'">'+(p.level === 'warn' ? '⛔ ' : '▸ ')+esc(p.text)+'</div>').join('');
      const history = item.history.slice().reverse().map(h =>
        '<div class="h'+(h.legacy ? ' legacy' : '')+'"><span class="meta">'+esc(fmtAt(h.at))+'</span> ' +
        '<b>'+esc(h.step)+'</b>'+(h.legacy ? '（旧档）' : '') +
        [h.developStatus && '显影：'+h.developStatus, h.defect && '缺陷：'+h.defect, h.repair && '修补：'+h.repair, h.note].filter(Boolean).map(esc).join('，') +
        '</div>').join('');
      const advance = item.finished
        ? '<div class="finished">✓ 已入盒，工艺流程结束（历史完整保留）</div>'
        : '<form class="advance" data-advance="'+esc(item.id)+'">'
          + '<div class="next">当前工序：'+esc(item.currentStep)+'　→　推进到：'+esc(item.expected)+'</div>'
          + advanceFields(item)
          + '<div class="err" data-err></div>'
          + '<button>提交「'+esc(item.expected)+'」</button></form>';
      return '<article class="card">'
        + '<h3>'+esc(item.displayCode)+'</h3>'
        + '<div><span class="pill">'+esc(item.stage)+'</span>'
        + (item.reworkCount ? '<span class="pill rework">返修 '+item.reworkCount+' 轮</span>' : '') + '</div>'
        + (meta ? '<div class="meta">'+meta+'</div>' : '<div class="meta">档案字段待补</div>')
        + pending
        + advance
        + '<div><button class="secondary" type="button" data-note="'+esc(item.id)+'">追加备注</button></div>'
        + '<div class="history"><b class="meta">完整历史（'+item.history.length+' 条）</b>'+(history || '<div class="meta">暂无记录</div>')+'</div>'
        + '</article>';
    }

    function render() {
      filterEl.innerHTML = '<option value="">全部工序</option>' +
        stageOrder.map(s => '<option '+(s === filterEl.value ? 'selected' : '')+'>'+esc(s)+'</option>').join('');
      const counts = Object.fromEntries(stageOrder.map(s => [s, 0]));
      items.forEach(i => { counts[i.stage] = (counts[i.stage] || 0) + 1; });
      statsEl.innerHTML = stageOrder.map(k => '<div class="stat"><span class="meta">'+esc(k)+'</span><strong>'+(counts[k] || 0)+'</strong></div>').join('');

      const q = searchEl.value.trim();
      const visible = items.filter(item =>
        (!filterEl.value || item.stage === filterEl.value) &&
        (!q || JSON.stringify(item).includes(q)));
      cardsEl.innerHTML = visible.map(cardHtml).join('') || '<div class="meta">没有符合条件的底片</div>';
    }

    async function load() { items = await api('/api/items'); render(); }

    document.querySelector('#createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget, errEl = document.querySelector('#createErr');
      errEl.textContent = '';
      try {
        await api('/api/items', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch (err) { errEl.textContent = '建档失败：' + err.message; }
    });

    // 事件委托：逐道推进工序。越级或修补记录为空时服务端返回 409，原样提示。
    cardsEl.addEventListener('submit', async (e) => {
      const form = e.target.closest('form[data-advance]');
      if (!form) return;
      e.preventDefault();
      const errEl = form.querySelector('[data-err]');
      errEl.textContent = '';
      try {
        await api('/api/items/' + encodeURIComponent(form.dataset.advance) + '/transitions', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
        });
        await load();
      } catch (err) {
        errEl.textContent = err.status === 409
          ? '不能推进（409）：' + err.message + '，原记录未改动'
          : '提交失败：' + err.message;
      }
    });

    cardsEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-note]');
      if (!btn) return;
      const note = prompt('追加备注（不改变当前工序）');
      if (note === null || !note.trim()) return;
      try {
        await api('/api/items/' + encodeURIComponent(btn.dataset.note) + '/notes', {
          method: 'POST', body: JSON.stringify({ note }),
        });
        await load();
      } catch (err) { alert('备注失败：' + err.message); }
    });

    filterEl.addEventListener('change', render);
    searchEl.addEventListener('input', render);
    document.querySelector('#reload').addEventListener('click', load);

    renderCreateForm();
    load();
  </script>
</body>
</html>`;
}
