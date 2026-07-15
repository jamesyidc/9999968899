const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const collector  = require('./collector');

const PORT       = 3000;
const DATA_DIR   = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE   = path.join(__dirname, 'collector.log');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function writeJsonlAppend(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 400) {
  sendJson(res, { success: false, error: msg }, status);
}

// ─── 读最近 N 行日志 ───
function readLogTail(n = 100) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).reverse(); // 最新在前
}

const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ─── CORS preflight ───
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // ─── API: GET /api/data ───
  if (req.method === 'GET' && pathname === '/api/data') {
    const official = readJsonl(path.join(DATA_DIR, 'official_weekly.jsonl'));
    const realtime = readJsonl(path.join(DATA_DIR, 'realtime_daily.jsonl'));
    return sendJson(res, { official, realtime });
  }

  // ─── API: GET /api/collector/status ───
  if (req.method === 'GET' && pathname === '/api/collector/status') {
    const state = collector.loadState();
    const logs  = readLogTail(60);
    return sendJson(res, { state, logs, schedule: {
      official: '每周三 10:30（上海油气中心发布后约1小时）',
      realtime: '每个交易日 16:30（A股收盘后1小时）',
      official_publish: '每周三 ~09:29',
    }});
  }

  // ─── API: POST /api/collector/run ───
  // 手动触发采集（用于补录/测试）
  if (req.method === 'POST' && pathname === '/api/collector/run') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { target } = JSON.parse(body || '{}');
        let result;
        if (target === 'official') {
          result = await collector.collectOfficial();
        } else if (target === 'realtime') {
          result = await collector.collectRealtime();
        } else {
          return sendError(res, 'target 应为 official 或 realtime');
        }
        return sendJson(res, result);
      } catch (e) {
        return sendError(res, e.message);
      }
    });
    return;
  }

  // ─── API: POST /api/add ───
  if (req.method === 'POST' && pathname === '/api/add') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const record = JSON.parse(body);
        if (!record.date || !record.type) return sendError(res, '缺少 date 或 type 字段');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return sendError(res, 'date 格式应为 YYYY-MM-DD');

        if (record.type === 'official_weekly') {
          const file = path.join(DATA_DIR, 'official_weekly.jsonl');
          const existing = readJsonl(file);
          if (existing.find(r => r.date === record.date)) return sendError(res, '该日期数据已存在（官方周度）');
          if (record.index && !record.price_rmb_ton) record.price_rmb_ton = +(record.index * 31.14).toFixed(2);
          if (record.price_rmb_ton && !record.price_rmb_barrel) record.price_rmb_barrel = +(record.price_rmb_ton / 7.33).toFixed(2);
          if (record.price_rmb_barrel && record.fx_rate && !record.price_usd_barrel)
            record.price_usd_barrel = +(record.price_rmb_barrel / record.fx_rate).toFixed(2);
          writeJsonlAppend(file, record);
        } else if (record.type === 'realtime_daily') {
          const file = path.join(DATA_DIR, 'realtime_daily.jsonl');
          const existing = readJsonl(file);
          if (existing.find(r => r.date === record.date)) return sendError(res, '该日期数据已存在（实时测算）');
          if (record.brent_usd && record.freight_usd != null && record.premium_usd != null && record.discount_usd != null) {
            if (!record.price_usd_barrel)
              record.price_usd_barrel = +(record.brent_usd - record.discount_usd + record.premium_usd + record.freight_usd).toFixed(2);
          }
          if (record.price_usd_barrel && record.fx_rate) {
            if (!record.price_rmb_barrel) record.price_rmb_barrel = +(record.price_usd_barrel * record.fx_rate).toFixed(2);
            if (!record.price_rmb_ton)    record.price_rmb_ton    = +(record.price_rmb_barrel * 7.33).toFixed(2);
          }
          writeJsonlAppend(file, record);
        } else {
          return sendError(res, 'type 只能是 official_weekly 或 realtime_daily');
        }
        return sendJson(res, { success: true, record });
      } catch (e) {
        return sendError(res, '请求体解析失败: ' + e.message);
      }
    });
    return;
  }

  // ─── API: POST /api/delete ───
  if (req.method === 'POST' && pathname === '/api/delete') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { date, type } = JSON.parse(body);
        if (!date || !type) return sendError(res, '缺少 date 或 type');
        const file = path.join(DATA_DIR, type === 'official_weekly' ? 'official_weekly.jsonl' : 'realtime_daily.jsonl');
        const records = readJsonl(file).filter(r => r.date !== date);
        fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf-8');
        return sendJson(res, { success: true });
      } catch (e) {
        return sendError(res, e.message);
      }
    });
    return;
  }

  // ─── Static files ───
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  const ext = path.extname(filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 到岸油价系统已启动 → http://0.0.0.0:${PORT}`);
  // 启动定时采集调度器
  collector.startScheduler();
});
