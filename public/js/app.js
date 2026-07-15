'use strict';

/* ══════════════════════════════════════
   STATE
══════════════════════════════════════ */
const state = {
  official: [],
  realtime: [],
  chart: null,
  showOfficial: true,
  showRealtime: true,
  priceUnit: 'price_rmb_ton',
  timeRange: 0,
  tableFilter: 'all',
  tableSort: 'desc',
};

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadData();
  initFormListeners();
  initControls();
  initCollectorTab();
});

/* ══════════════════════════════════════
   TABS
══════════════════════════════════════ */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

/* ══════════════════════════════════════
   DATA LOADING
══════════════════════════════════════ */
async function loadData() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();
    state.official = (data.official || []).sort((a, b) => a.date.localeCompare(b.date));
    state.realtime = (data.realtime || []).sort((a, b) => a.date.localeCompare(b.date));
    updateSummaryCards();
    renderChart();
    renderTable();
    updateLastUpdate();
  } catch (e) {
    showToast('数据加载失败: ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════
   SUMMARY CARDS
══════════════════════════════════════ */
function updateSummaryCards() {
  const off = state.official.at(-1);
  const rt  = state.realtime.at(-1);

  if (off) {
    document.getElementById('c1-main').textContent = fmt(off.price_rmb_ton, 2);
    document.getElementById('c1-detail').textContent =
      `指数：${off.index ?? '—'} | ≈ ${off.price_usd_barrel ?? '—'} 美元/桶`;
    document.getElementById('c1-date').textContent = `更新日期：${off.date}${off.week ? ' (' + off.week + ')' : ''}`;
  }
  if (rt) {
    document.getElementById('c2-main').textContent = fmt(rt.price_rmb_ton, 2);
    document.getElementById('c2-detail').textContent =
      `布伦特：${rt.brent_usd ?? '—'} USD | SC期货：${rt.sc_futures ?? '—'} 元/桶`;
    document.getElementById('c2-date').textContent = `数据日期：${rt.date}`;
  }
  if (off && rt) {
    const diff = (rt.price_rmb_ton - off.price_rmb_ton).toFixed(2);
    const el = document.getElementById('c3-main');
    el.textContent = (diff > 0 ? '+' : '') + diff;
    el.style.color = diff > 0 ? '#a3e635' : (diff < 0 ? '#f87171' : '#94a3b8');
    document.getElementById('c3-detail').textContent =
      `实时 ${fmt(rt.price_rmb_ton, 0)} vs 官方 ${fmt(off.price_rmb_ton, 0)} 元/吨`;
  }
}

/* ══════════════════════════════════════
   CHART
══════════════════════════════════════ */
function filterByTimeRange(arr) {
  if (!state.timeRange) return arr;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - state.timeRange);
  const cutStr = cutoff.toISOString().slice(0, 10);
  return arr.filter(r => r.date >= cutStr);
}

/**
 * 构建统一时间轴：合并两个数据集的所有日期，
 * 去重后按升序排列，作为 labels。
 * 每个数据集按此轴对齐，缺失日期填 null（spanGaps 跳过断点）。
 */
function buildAlignedChart(unit) {
  const offFiltered = state.showOfficial ? filterByTimeRange(state.official) : [];
  const rtFiltered  = state.showRealtime  ? filterByTimeRange(state.realtime)  : [];

  // 合并所有日期，去重升序
  const allDates = [...new Set([
    ...offFiltered.map(r => r.date),
    ...rtFiltered.map(r => r.date),
  ])].sort();

  // 建立 date → value 的查找表
  const offMap = Object.fromEntries(offFiltered.map(r => [r.date, r[unit] ?? null]));
  const rtMap  = Object.fromEntries(rtFiltered.map(r => [r.date, r[unit] ?? null]));

  // 按统一轴对齐，无数据日期填 null
  const offValues = allDates.map(d => offMap[d] ?? null);
  const rtValues  = allDates.map(d => rtMap[d]  ?? null);

  return { labels: allDates, offValues, rtValues };
}

function renderChart() {
  const unit = state.priceUnit;
  const unitLabel = { price_rmb_ton: '元/吨', price_rmb_barrel: '元/桶', price_usd_barrel: '美元/桶' }[unit];

  const { labels, offValues, rtValues } = buildAlignedChart(unit);

  const ctx = document.getElementById('oilChart');

  // 图表已存在：只更新数据，不重建
  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = offValues;
    state.chart.data.datasets[1].data = rtValues;
    state.chart.options.scales.y.title.text = unitLabel;
    // 更新 tooltip 中的单位
    state.chart._unitLabel = unitLabel;
    state.chart.update();
    return;
  }

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,                   // ← 统一、有序的 X 轴
      datasets: [
        {
          label: '官方周度综合到岸价',
          data: offValues,      // ← 与 labels 一一对应的数值数组
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,0.08)',
          borderWidth: 2.5,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointBackgroundColor: '#38bdf8',
          tension: 0.3,
          fill: false,
          spanGaps: true,       // null 处断开不连线
        },
        {
          label: '实时测算到岸成本',
          data: rtValues,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168,85,247,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#a855f7',
          tension: 0.3,
          fill: false,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1520',
          borderColor: '#1e293b',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#e2e8f0',
          padding: 12,
          filter: item => item.raw !== null,   // tooltip 不显示 null 项
          callbacks: {
            title: items => '日期：' + items[0].label,
            label: item => {
              const v = item.raw;
              const ul = state.chart?._unitLabel || unitLabel;
              return v != null ? `  ${item.dataset.label}：${fmt(v, 2)} ${ul}` : null;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          ticks: {
            color: '#475569',
            maxTicksLimit: 14,
            maxRotation: 0,
            autoSkip: true,
          },
          grid: { color: '#1a2332' },
        },
        y: {
          ticks: { color: '#475569', callback: v => fmt(v, 0) },
          grid: { color: '#1a2332' },
          title: { display: true, text: unitLabel, color: '#64748b', font: { size: 12 } },
        },
      },
    },
  });
  state.chart._unitLabel = unitLabel;
}

function updateChart() {
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  renderChart();
}

/* ══════════════════════════════════════
   TABLE
══════════════════════════════════════ */
function renderTable() {
  const all = [
    ...state.official.map(r => ({ ...r })),
    ...state.realtime.map(r => ({ ...r })),
  ];
  let filtered = state.tableFilter === 'all' ? all
    : all.filter(r => r.type === state.tableFilter);

  filtered.sort((a, b) => state.tableSort === 'asc'
    ? a.date.localeCompare(b.date)
    : b.date.localeCompare(a.date));

  const tbody = document.getElementById('tableBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="loading-row">暂无数据</td></tr>';
    document.getElementById('tableFooter').textContent = '';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const isOff = r.type === 'official_weekly';
    return `<tr class="${isOff ? 'row-official' : 'row-realtime'}">
      <td>${r.date}</td>
      <td><span class="type-badge ${isOff ? 'official' : 'realtime'}">${isOff ? '官方周度' : '实时测算'}</span></td>
      <td><strong>${fmt(r.price_rmb_ton, 2)}</strong></td>
      <td>${fmt(r.price_rmb_barrel, 2)}</td>
      <td>${fmt(r.price_usd_barrel, 2)}</td>
      <td>${r.fx_rate ?? '—'}</td>
      <td>${r.brent_usd ?? (r.index ? '指数:' + r.index : '—')}</td>
      <td>${r.sc_futures ?? '—'}</td>
      <td>${r.index ?? '—'}</td>
      <td style="color:#475569;font-size:0.75rem">${r.source ?? '—'}</td>
      <td style="color:#475569;font-size:0.75rem">${r.note ?? '—'}</td>
      <td><button class="btn-del" onclick="deleteRecord('${r.date}','${r.type}')">删除</button></td>
    </tr>`;
  }).join('');

  document.getElementById('tableFooter').textContent =
    `共 ${filtered.length} 条记录（官方周度 ${state.official.length} 条 / 实时测算 ${state.realtime.length} 条）`;
}

/* ══════════════════════════════════════
   DELETE
══════════════════════════════════════ */
async function deleteRecord(date, type) {
  if (!confirm(`确认删除 ${date} 的 ${type === 'official_weekly' ? '官方周度' : '实时测算'} 数据？`)) return;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, type }),
    });
    const data = await res.json();
    if (data.success) { showToast('删除成功', 'success'); loadData(); }
    else showToast('删除失败: ' + data.error, 'error');
  } catch (e) { showToast('请求失败', 'error'); }
}

/* ══════════════════════════════════════
   EXPORT CSV
══════════════════════════════════════ */
document.getElementById('exportCsv').addEventListener('click', () => {
  const all = [
    ...state.official.map(r => ({ ...r })),
    ...state.realtime.map(r => ({ ...r })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const headers = ['date','type','price_rmb_ton','price_rmb_barrel','price_usd_barrel',
    'fx_rate','brent_usd','wti_usd','sc_futures','index','week','source','note'];
  const rows = [headers.join(','), ...all.map(r => headers.map(h => csvEsc(r[h])).join(','))];
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `原油到岸价_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
});
function csvEsc(v) { if (v == null) return ''; const s = String(v); return s.includes(',') ? `"${s}"` : s; }

/* ══════════════════════════════════════
   CONTROLS
══════════════════════════════════════ */
function initControls() {
  document.getElementById('toggleOfficial').addEventListener('click', e => {
    state.showOfficial = !state.showOfficial;
    e.currentTarget.classList.toggle('active', state.showOfficial);
    updateChart();
  });
  document.getElementById('toggleRealtime').addEventListener('click', e => {
    state.showRealtime = !state.showRealtime;
    e.currentTarget.classList.toggle('active', state.showRealtime);
    updateChart();
  });
  document.getElementById('priceUnit').addEventListener('change', e => {
    state.priceUnit = e.target.value;
    updateChart();
  });
  document.getElementById('timeRange').addEventListener('change', e => {
    state.timeRange = +e.target.value;
    updateChart();
  });
  document.getElementById('tableFilter').addEventListener('change', e => {
    state.tableFilter = e.target.value;
    renderTable();
  });
  document.getElementById('tableSort').addEventListener('change', e => {
    state.tableSort = e.target.value;
    renderTable();
  });
}

/* ══════════════════════════════════════
   FORMS
══════════════════════════════════════ */
function initFormListeners() {
  // ─ Official live preview ─
  const oForm = document.getElementById('formOfficial');
  const oInputs = oForm.querySelectorAll('input');
  oInputs.forEach(inp => inp.addEventListener('input', updateOfficialPreview));

  // ─ Realtime live preview ─
  const rForm = document.getElementById('formRealtime');
  const rInputs = rForm.querySelectorAll('input');
  rInputs.forEach(inp => inp.addEventListener('input', updateRealtimePreview));

  // ─ Defaults: today ─
  const today = new Date().toISOString().slice(0, 10);
  oForm.querySelector('[name=date]').value = today;
  rForm.querySelector('[name=date]').value = today;

  // ─ Submit official ─
  oForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rec = {
      type: 'official_weekly',
      date: fd.get('date'),
      week: fd.get('week') || undefined,
      index: +fd.get('index'),
      fx_rate: +fd.get('fx_rate'),
      note: fd.get('note') || '官方周度综合到岸价指数',
      source: '上海石油天然气交易中心',
    };
    await submitRecord(rec, e.target);
  });

  // ─ Submit realtime ─
  rForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rec = {
      type: 'realtime_daily',
      date: fd.get('date'),
      brent_usd: +fd.get('brent_usd'),
      wti_usd: fd.get('wti_usd') ? +fd.get('wti_usd') : undefined,
      freight_usd: +fd.get('freight_usd'),
      premium_usd: +fd.get('premium_usd'),
      discount_usd: +fd.get('discount_usd'),
      sc_futures: fd.get('sc_futures') ? +fd.get('sc_futures') : undefined,
      fx_rate: +fd.get('fx_rate'),
      note: fd.get('note') || '中东阿曼/迪拜油测算',
      source: '实时盘面测算',
    };
    await submitRecord(rec, e.target);
  });
}

async function submitRecord(rec, form) {
  try {
    const res = await fetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ 数据录入成功！', 'success');
      form.reset();
      const today = new Date().toISOString().slice(0, 10);
      form.querySelector('[name=date]').value = today;
      loadData();
    } else {
      showToast('❌ ' + data.error, 'error');
    }
  } catch (e) {
    showToast('请求失败: ' + e.message, 'error');
  }
}

function updateOfficialPreview() {
  const form = document.getElementById('formOfficial');
  const idx = +form.querySelector('[name=index]').value;
  const fx  = +form.querySelector('[name=fx_rate]').value || 6.92;
  if (!idx) { document.getElementById('previewOfficial').innerHTML = '<span>输入指数后自动预览换算结果 →</span>'; return; }
  const ton = (idx * 31.14).toFixed(2);
  const barrel = (ton / 7.33).toFixed(2);
  const usd = (barrel / fx).toFixed(2);
  document.getElementById('previewOfficial').innerHTML =
    `<strong>预览：</strong>&nbsp; 指数 ${idx} &nbsp;→&nbsp; <strong>${ton}</strong> 元/吨 &nbsp;|&nbsp; ${barrel} 元/桶 &nbsp;|&nbsp; ${usd} 美元/桶`;
}

function updateRealtimePreview() {
  const form = document.getElementById('formRealtime');
  const brent    = +form.querySelector('[name=brent_usd]').value;
  const freight  = +form.querySelector('[name=freight_usd]').value;
  const premium  = +form.querySelector('[name=premium_usd]').value || 1.5;
  const discount = +form.querySelector('[name=discount_usd]').value || 3.0;
  const fx       = +form.querySelector('[name=fx_rate]').value || 6.92;
  if (!brent || !freight) { document.getElementById('previewRealtime').innerHTML = '<span>填写数据后自动预览到岸成本 →</span>'; return; }
  const usd    = +(brent - discount + premium + freight).toFixed(2);
  const rmb_b  = +(usd * fx).toFixed(2);
  const rmb_t  = +(rmb_b * 7.33).toFixed(2);
  const tax    = +(rmb_t * 1.13).toFixed(0);
  document.getElementById('previewRealtime').innerHTML =
    `<strong>预览：</strong>&nbsp; CIF <strong>${usd}</strong> 美元/桶 &nbsp;|&nbsp; <strong>${rmb_t}</strong> 元/吨 &nbsp;|&nbsp; 含税约 ${tax} 元/吨`;
}

/* ══════════════════════════════════════
   AUTO COLLECTOR TAB
══════════════════════════════════════ */
function initCollectorTab() {
  document.getElementById('btnRunOfficial').addEventListener('click', () => runCollector('official'));
  document.getElementById('btnRunRealtime').addEventListener('click', () => runCollector('realtime'));
  document.getElementById('btnRefreshLog').addEventListener('click', loadCollectorStatus);

  // 切换到 auto tab 时自动刷新
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === 'auto') {
      btn.addEventListener('click', loadCollectorStatus);
    }
  });
}

async function loadCollectorStatus() {
  try {
    const res  = await fetch('/api/collector/status');
    const data = await res.json();
    renderCollectorState(data.state);
    renderCollectorLogs(data.logs);
    document.getElementById('logRefreshTime').textContent =
      '刷新于 ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    document.getElementById('logBody').innerHTML = `<div class="log-loading" style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

function renderCollectorState(state) {
  const off = state?.official || {};
  const rt  = state?.realtime  || {};

  // 官方状态卡
  const offOk = !!off.last_success;
  document.getElementById('schedOfficialStatus').textContent = offOk ? '✅ 正常' : (off.last_error ? '❌ 失败' : '待触发');
  document.getElementById('schedOfficialStatus').className = 'sched-status ' + (offOk ? 'ok' : (off.last_error ? 'err' : ''));
  document.getElementById('stateOfficialVal').innerHTML = offOk
    ? `<strong>上次成功：</strong>${fmtTs(off.last_success)}<br>日期：${off.last_date || '—'}&nbsp; 指数：${off.last_index || '—'}`
    : (off.last_error
        ? `<span style="color:#f87171">上次错误：${off.last_error}</span><br>${fmtTs(off.last_error_at)}`
        : '尚未采集');

  // 实时状态卡
  const rtOk = !!rt.last_success;
  document.getElementById('schedRealtimeStatus').textContent = rtOk ? '✅ 正常' : (rt.last_error ? '❌ 失败' : '待触发');
  document.getElementById('schedRealtimeStatus').className = 'sched-status ' + (rtOk ? 'ok' : (rt.last_error ? 'err' : ''));
  document.getElementById('stateRealtimeVal').innerHTML = rtOk
    ? `<strong>上次成功：</strong>${fmtTs(rt.last_success)}<br>日期：${rt.last_date || '—'}&nbsp; 布伦特：${rt.last_brent || '—'} USD&nbsp; 到岸：${rt.last_price_rmb_ton || '—'} 元/吨`
    : (rt.last_error
        ? `<span style="color:#f87171">上次错误：${rt.last_error}</span><br>${fmtTs(rt.last_error_at)}`
        : '尚未采集');
}

function renderCollectorLogs(logs) {
  const body = document.getElementById('logBody');
  if (!logs || !logs.length) {
    body.innerHTML = '<div class="log-loading">暂无日志</div>';
    return;
  }
  body.innerHTML = logs.map(line => {
    // 格式：[2026-07-15 10:30:01] [INFO] 消息
    const m = line.match(/^\[(.+?)\] \[(.+?)\] (.*)$/);
    if (!m) return `<div class="log-line INFO"><span class="log-msg">${esc(line)}</span></div>`;
    const [, ts, lvl, msg] = m;
    const cls = ['INFO','WARN','ERROR'].includes(lvl) ? lvl : 'INFO';
    const msgHtml = msg.replace(/✅/g, '<span class="ok">✅</span>');
    return `<div class="log-line ${cls}">` +
      `<span class="log-ts">${ts}</span>` +
      `<span class="log-lvl">[${lvl}]</span>` +
      `<span class="log-msg">${esc(msgHtml)}</span>` +
      `</div>`;
  }).join('');
}

async function runCollector(target) {
  const btn = document.getElementById(target === 'official' ? 'btnRunOfficial' : 'btnRunRealtime');
  const result = document.getElementById('triggerResult');
  btn.disabled = true;
  result.className = 'trigger-result';
  result.textContent = `⏳ 正在采集（${target === 'official' ? '官方周度' : '实时盘面'}）…`;

  try {
    const res  = await fetch('/api/collector/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (data.skipped) {
      result.textContent = `ℹ️ 今日数据已存在，无需重复采集（${data.record?.date || target}）`;
    } else if (data.success) {
      const r = data.record;
      result.className = 'trigger-result';
      result.textContent = target === 'official'
        ? `✅ 采集成功：${r.date} 指数=${r.index} → ${r.price_rmb_ton} 元/吨`
        : `✅ 采集成功：${r.date} 布伦特=${r.brent_usd} → CIF ${r.price_rmb_ton} 元/吨`;
      loadData(); // 刷新图表和列表
    } else {
      result.className = 'trigger-result err';
      result.textContent = `❌ 采集失败：${data.error || JSON.stringify(data)}`;
    }
  } catch (e) {
    result.className = 'trigger-result err';
    result.textContent = `❌ 请求失败：${e.message}`;
  } finally {
    btn.disabled = false;
    // 延迟刷新日志
    setTimeout(loadCollectorStatus, 800);
  }
}

function fmtTs(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19) + ' (UTC)';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ══════════════════════════════════════
   UTILS
══════════════════════════════════════ */
function fmt(v, decimals = 2) {
  if (v == null || v === '') return '—';
  return Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function updateLastUpdate() {
  const all = [...state.official, ...state.realtime];
  if (!all.length) return;
  const latest = all.map(r => r.date).sort().at(-1);
  document.getElementById('lastUpdate').textContent = `最新数据：${latest}`;
}

let _toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}
