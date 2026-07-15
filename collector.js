'use strict';
/**
 * 原油到岸价格 — 定时数据采集器
 *
 * 采集策略：
 *  ① 官方周度指数（SHPGX）：每周三 10:30 自动抓取上海油气中心官网
 *     发布时间：每周三 ~09:29，我们延后 1 小时采集
 *
 *  ② 实时盘面（布伦特/WTI/SC/汇率）：每个交易日 16:30 采集
 *     上期所 15:00 收盘、夜盘 21:00 开盘，16:30 取日盘收盘价
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const cron   = require('node-cron');

const DATA_DIR   = path.join(__dirname, 'data');
const LOG_FILE   = path.join(__dirname, 'collector.log');
const STATE_FILE = path.join(__dirname, 'collector_state.json');

// ─── 工具 ────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// 判断是否交易日（周一到周五，简单判断，节假日不处理）
function isTradingDay() {
  const d = new Date().getDay(); // 0=Sun,6=Sat
  return d >= 1 && d <= 5;
}

// 读写采集状态
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return { official: {}, realtime: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// HTTP(S) GET 封装（返回 Promise<string>）
function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...opts.headers,
      },
      timeout: 10000,  // 10s 单请求超时
    };
    const req = lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, opts).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// ─── ① 官方周度：抓取 SHPGX ─────────────────────────────

/**
 * 从 SHPGX 资讯列表页找到最新"原油综合进口到岸价格指数"文章链接
 */
async function findLatestOfficialArticle() {
  const html = await fetch('https://www.shpgx.com/html/xyzx/');

  // 方案1：title 属性中含"原油综合进口到岸价格指数"的 <a> 标签
  const re1 = /<a\s+href="(\/html\/xyzx\/(\d{8})\/(\d+)\.html)"[^>]*title="([^"]*原油综合进口到岸价格指数[^"]*)"/g;
  const matches = [];
  let m;
  while ((m = re1.exec(html)) !== null) {
    matches.push({ url: 'https://www.shpgx.com' + m[1], dateStr: m[2], title: m[4] });
  }

  // 方案2：链接后紧跟的文本（不同 HTML 结构）
  if (!matches.length) {
    const re2 = /href="(\/html\/xyzx\/(\d{8})\/(\d+)\.html)"[^>]*>[^<]*原油综合进口到岸价格指数/g;
    while ((m = re2.exec(html)) !== null) {
      matches.push({ url: 'https://www.shpgx.com' + m[1], dateStr: m[2] });
    }
  }

  if (!matches.length) {
    // 方案3：取最近文章逐一检测（最多检查前8篇）
    log('WARN', '列表页未直接匹配指数文章，尝试逐一检测最近文章...');
    const allLinks = [];
    const re3 = /href="(\/html\/xyzx\/(\d{8})\/(\d+)\.html)"/g;
    while ((m = re3.exec(html)) !== null) {
      allLinks.push({ url: 'https://www.shpgx.com' + m[1], dateStr: m[2] });
    }
    // 按日期倒序
    allLinks.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
    const toCheck = allLinks.slice(0, 8);
    for (const link of toCheck) {
      try {
        const art = await fetch(link.url);
        if (art.includes('原油综合进口到岸价格指数')) {
          matches.push(link);
          break;
        }
      } catch {}
    }
  }

  if (!matches.length) throw new Error('未在列表页找到原油指数文章');
  matches.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
  log('INFO', `文章标题：${matches[0].title || matches[0].url}`);
  return matches[0].url;
}

/**
 * 解析文章页面，提取指数值和覆盖周期
 * 典型格式：
 *   标题：6月29日-7月5日中国原油综合进口到岸价格指数为144.46点
 *   正文：时间：2026-07-09 09:29:30
 */
async function parseOfficialArticle(articleUrl) {
  const html = await fetch(articleUrl);

  // 提取发布时间
  const timeMatch = html.match(/时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  const publishDate = timeMatch ? timeMatch[1] : todayStr();
  const publishTime = timeMatch ? timeMatch[2] : '09:30:00';

  // 提取指数值（如 144.46点）
  const indexMatch = html.match(/原油综合进口到岸价格指数为\s*([\d.]+)\s*点/);
  if (!indexMatch) throw new Error('未能提取指数值，页面内容可能已变更');
  const index = parseFloat(indexMatch[1]);

  // 提取周环比
  const wowMatch = html.match(/周环比(上涨|下跌)([\d.]+)%/);
  const wow = wowMatch ? `周环比${wowMatch[1]}${wowMatch[2]}%` : '';

  // 提取同比
  const yoyMatch = html.match(/同比(上涨|下跌)([\d.]+)%/);
  const yoy = yoyMatch ? `同比${yoyMatch[1]}${yoyMatch[2]}%` : '';

  // 提取覆盖周期（如"6月29日-7月5日"）
  const periodMatch = html.match(/([\d月日]+日[-—至][\d月日]+日)[\s\S]*?中国原油综合进口到岸价格指数为/);
  const period = periodMatch ? periodMatch[1] : '';

  // 汇率（文章中有时会提到，否则用固定值）
  const fxMatch  = html.match(/汇率[约为：:]+\s*([\d.]+)/);
  const fx_rate  = fxMatch ? parseFloat(fxMatch[1]) : 6.92;

  // 换算
  const price_rmb_ton    = +(index * 31.14).toFixed(2);
  const price_rmb_barrel = +(price_rmb_ton / 7.33).toFixed(2);
  const price_usd_barrel = +(price_rmb_barrel / fx_rate).toFixed(2);

  // 推算本记录的"日期"字段 = 发布日（周三）
  return {
    date: publishDate,
    type: 'official_weekly',
    publish_time: publishTime,
    period,
    index,
    price_rmb_ton,
    price_rmb_barrel,
    price_usd_barrel,
    fx_rate,
    wow,
    yoy,
    source: '上海石油天然气交易中心',
    note: `官方周度综合到岸价指数 ${period ? '(' + period + ')' : ''} ${wow} ${yoy}`.trim(),
    article_url: articleUrl,
    collected_at: new Date().toISOString(),
  };
}

async function collectOfficial() {
  log('INFO', '=== 开始采集官方周度指数（SHPGX） ===');
  // 50s 整体超时保护（单请求10s，最多4次请求，给余地）
  const withTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('collectOfficial 整体超时(50s)')), 50000)
  );
  return Promise.race([_collectOfficialImpl(), withTimeout]);
}

async function _collectOfficialImpl() {
  try {
    const articleUrl = await findLatestOfficialArticle();
    log('INFO', `找到文章: ${articleUrl}`);
    const record = await parseOfficialArticle(articleUrl);
    log('INFO', `解析结果: 指数${record.index}, ${record.price_rmb_ton}元/吨, ${record.wow}`);

    const file = path.join(DATA_DIR, 'official_weekly.jsonl');
    const existing = readJsonl(file);
    if (existing.find(r => r.date === record.date)) {
      log('INFO', `[跳过] ${record.date} 官方数据已存在，无需重复写入`);
      return { skipped: true, record };
    }

    appendJsonl(file, record);
    log('INFO', `✅ 已写入 official_weekly.jsonl: ${record.date} 指数=${record.index}`);

    // 更新状态
    const state = loadState();
    state.official.last_success = new Date().toISOString();
    state.official.last_date = record.date;
    state.official.last_index = record.index;
    saveState(state);

    return { success: true, record };
  } catch (e) {
    log('ERROR', `官方采集失败: ${e.message}`);
    const state = loadState();
    state.official.last_error = e.message;
    state.official.last_error_at = new Date().toISOString();
    saveState(state);
    return { success: false, error: e.message };
  }
}

// ─── ② 实时盘面：多源采集 ─────────────────────────────────

/**
 * 从 investing.com 历史数据页面抓取布伦特最新收盘价
 */
async function fetchBrentFromInvesting() {
  const html = await fetch('https://cn.investing.com/commodities/brent-oil-historical-data', {
    headers: { 'Referer': 'https://cn.investing.com/', 'X-Requested-With': 'XMLHttpRequest' }
  });
  // 页面内格式：2026年07月14日, 85.14, ...
  const re = /(\d{4})年(\d{2})月(\d{2})日\s*,\s*([\d.]+)\s*,/g;
  const rows = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push({ date: `${m[1]}-${m[2]}-${m[3]}`, price: parseFloat(m[4]) });
  }
  if (!rows.length) throw new Error('investing.com 未解析到布伦特数据');
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows[0]; // { date, price }
}

/**
 * 从财联社 / 东方财富文字快讯回退方案抓布伦特
 */
async function fetchBrentFromCLS() {
  // 财联社快讯搜索（布伦特结算价）
  const html = await fetch('https://m.cls.cn/search?keyword=%E5%B8%83%E4%BC%A6%E7%89%B9%E5%8E%9F%E6%B2%B9%E6%9C%9F%E8%B4%A7%E7%BB%93%E7%AE%97%E4%BB%B7');
  // 匹配"报XX.XX美元/桶"
  const re = /结算价报([\d.]+)美元\/桶/;
  const m = html.match(re);
  if (!m) throw new Error('CLS 未解析到布伦特结算价');
  return { date: todayStr(), price: parseFloat(m[1]) };
}

/**
 * 从 chemall.com.cn 抓 SC 期货收盘价
 */
async function fetchSCFromChemall() {
  const dateTag = todayStr().replace(/-/g, '');
  // 尝试当日页面
  const urls = [
    `https://www.chemall.com.cn/mobile/news/show-${dateTag}.html`, // 有时格式不同
    'https://www.chemall.com.cn/mobile/news/', // 列表页回退
  ];
  for (const url of urls) {
    try {
      const html = await fetch(url);
      const m = html.match(/sc\d+合约收盘价([\d.]+)元/i)
              || html.match(/SC原油期货.{0,20}?(\d{3,4}\.\d)\s*元/);
      if (m) return parseFloat(m[1]);
    } catch {}
  }
  return null;
}

/**
 * 从 FRED（EIA）抓布伦特现货价（T+1发布，作为备用）
 */
async function fetchBrentFromFRED() {
  const html = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU&vintage_date=' + todayStr());
  const lines = html.trim().split('\n').filter(l => !l.startsWith('DATE'));
  if (!lines.length) throw new Error('FRED 无数据');
  const last = lines[lines.length - 1].split(',');
  return { date: last[0].trim(), price: parseFloat(last[1]) };
}

/**
 * 从 cngold 金投网抓布伦特 + WTI 收盘
 */
async function fetchFromCngold() {
  const html = await fetch('https://energy.cngold.org/c/' + todayStr().replace(/-/g, '-') + '/c10614902.html');
  const brentM = html.match(/布伦特原油.*?([\d.]+)\s*美元/);
  const wtiM   = html.match(/WTI.*?([\d.]+)\s*美元/);
  return {
    brent: brentM ? parseFloat(brentM[1]) : null,
    wti:   wtiM   ? parseFloat(wtiM[1]) : null,
  };
}

/**
 * 汇率：从东方财富接口
 */
async function fetchFxRate() {
  try {
    const json = await fetch('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_FOREX_USDCNYIndex&columns=REPORT_DATE%2CCLOSE_PRICE&filter=(MARKET_CODE%3D%22CNY%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=REPORT_DATE&source=WEB&client=WEB');
    const data = JSON.parse(json);
    const price = data?.data?.data?.[0]?.CLOSE_PRICE;
    if (price) return parseFloat(price);
  } catch {}
  // 回退：从腾讯股票接口
  try {
    const txt = await fetch('https://qt.gtimg.cn/q=usdcny');
    const m = txt.match(/~([\d.]+)~.*?美元/);
    if (m) return parseFloat(m[1]);
  } catch {}
  return 6.92; // 兜底固定值
}

async function collectRealtime() {
  // 50s 整体超时保护
  const withTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('collectRealtime 整体超时(50s)')), 50000)
  );
  return Promise.race([_collectRealtimeImpl(), withTimeout]);
}

async function _collectRealtimeImpl() {
  const today = todayStr();
  log('INFO', `=== 开始采集实时盘面 ${today} ===`);

  // 检查是否已采集
  const file = path.join(DATA_DIR, 'realtime_daily.jsonl');
  const existing = readJsonl(file);
  if (existing.find(r => r.date === today)) {
    log('INFO', `[跳过] ${today} 实时数据已存在`);
    return { skipped: true };
  }

  const errors = [];
  let brent_usd = null, wti_usd = null, sc_futures = null, fx_rate = 6.92;

  // --- 布伦特 ---
  try {
    const r = await fetchBrentFromInvesting();
    brent_usd = r.price;
    log('INFO', `布伦特(investing): ${brent_usd} USD/桶`);
  } catch (e) {
    errors.push('investing:' + e.message);
    try {
      const r = await fetchBrentFromCLS();
      brent_usd = r.price;
      log('INFO', `布伦特(CLS回退): ${brent_usd} USD/桶`);
    } catch (e2) {
      errors.push('CLS:' + e2.message);
      try {
        const r = await fetchBrentFromFRED();
        brent_usd = r.price;
        log('INFO', `布伦特(FRED回退): ${brent_usd} USD/桶`);
      } catch (e3) {
        errors.push('FRED:' + e3.message);
        log('WARN', `布伦特所有源失败: ${errors.join(' | ')}`);
      }
    }
  }

  // --- WTI ---
  try {
    const txt = await fetch('https://m.cls.cn/search?keyword=WTI%E5%8E%9F%E6%B2%B9%E6%9C%9F%E8%B4%A7%E7%BB%93%E7%AE%97%E4%BB%B7');
    const m = txt.match(/WTI.*?结算价报([\d.]+)美元/);
    if (m) { wti_usd = parseFloat(m[1]); log('INFO', `WTI(CLS): ${wti_usd}`); }
  } catch {}

  if (!wti_usd && brent_usd) {
    // 布伦特-WTI 价差历史约3-6美元，简单估算
    wti_usd = +(brent_usd - 4.5).toFixed(2);
    log('INFO', `WTI 估算(布伦特-4.5): ${wti_usd}`);
  }

  // --- SC期货 ---
  try {
    sc_futures = await fetchSCFromChemall();
    if (sc_futures) log('INFO', `SC期货(chemall): ${sc_futures}`);
  } catch {}

  // --- 汇率 ---
  try {
    fx_rate = await fetchFxRate();
    log('INFO', `汇率: ${fx_rate}`);
  } catch {}

  // --- 如果布伦特获取失败，任务失败 ---
  if (!brent_usd) {
    log('ERROR', '布伦特价格所有数据源均失败，本次不写入');
    const state = loadState();
    state.realtime.last_error = '布伦特数据源全部失败';
    state.realtime.last_error_at = new Date().toISOString();
    saveState(state);
    return { success: false, error: '布伦特数据源全部失败', details: errors };
  }

  // --- 计算到岸价 ---
  const freight_usd  = 12.00;  // 中东→中国 VLCC，月度更新
  const premium_usd  = 1.50;   // OSP溢价
  const discount_usd = 3.00;   // 迪拜相对布伦特贴水

  const price_usd_barrel = +(brent_usd - discount_usd + premium_usd + freight_usd).toFixed(2);
  const price_rmb_barrel = +(price_usd_barrel * fx_rate).toFixed(2);
  const price_rmb_ton    = +(price_rmb_barrel * 7.33).toFixed(2);

  const record = {
    date: today,
    type: 'realtime_daily',
    brent_usd,
    wti_usd,
    freight_usd,
    premium_usd,
    discount_usd,
    price_usd_barrel,
    fx_rate,
    price_rmb_barrel,
    price_rmb_ton,
    sc_futures: sc_futures || null,
    source: '自动采集：investing.com/CLS/chemall',
    note: `中东阿曼/迪拜油测算，自动采集 ${errors.length ? '[部分源失败:' + errors.join('|') + ']' : ''}`.trim(),
    collected_at: new Date().toISOString(),
  };

  appendJsonl(file, record);
  log('INFO', `✅ 已写入 realtime_daily.jsonl: ${today} CIF=${price_rmb_ton}元/吨`);

  const state = loadState();
  state.realtime.last_success = new Date().toISOString();
  state.realtime.last_date = today;
  state.realtime.last_brent = brent_usd;
  state.realtime.last_price_rmb_ton = price_rmb_ton;
  saveState(state);

  return { success: true, record };
}

// ─── ③ 定时调度 ──────────────────────────────────────────

function startScheduler() {
  log('INFO', '========================================');
  log('INFO', '  原油到岸价格采集器启动');
  log('INFO', '  官方周度：每周三 10:30（晚于发布1小时）');
  log('INFO', '  实时盘面：每个交易日 16:30（A股收盘后）');
  log('INFO', '========================================');

  // 每周三 10:30 采集官方周度指数
  // cron: 分 时 日 月 星期（0=日，3=三）
  cron.schedule('30 10 * * 3', async () => {
    log('INFO', '[CRON] 触发：周三10:30 官方周度采集');
    await collectOfficial();
  }, { timezone: 'Asia/Shanghai' });

  // 每个交易日 16:30 采集实时盘面
  cron.schedule('30 16 * * 1-5', async () => {
    log('INFO', '[CRON] 触发：工作日16:30 实时盘面采集');
    if (!isTradingDay()) { log('INFO', '[跳过] 非交易日'); return; }
    await collectRealtime();
  }, { timezone: 'Asia/Shanghai' });

  log('INFO', '定时任务已注册，等待触发...');
}

// ─── ④ 导出（供 server.js 调用） ─────────────────────────

module.exports = {
  collectOfficial,
  collectRealtime,
  startScheduler,
  loadState,
};

// 独立运行时直接执行
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--official') {
    collectOfficial().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
  } else if (arg === '--realtime') {
    collectRealtime().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
  } else if (arg === '--test') {
    // 测试模式：两个都跑一遍
    (async () => {
      await collectOfficial();
      await collectRealtime();
      process.exit(0);
    })();
  } else {
    startScheduler();
  }
}
