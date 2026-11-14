#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k])).trim() || d;
const bool = (k, d = false) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
};
const num = (k, d) => {
  const v = parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};

const CFG = {
  loginUrl: env('LOGIN_URL', 'https://aclclouds.com/auth/login'),
  serverBase: env('SERVER_BASE', 'https://aclclouds.com/server/'),
  email: env('ACL_EMAIL'),
  password: env('ACL_PASSWORD'),
  cookieValue: env('COOKIE_VALUE'),
  ghToken: env('GH_TOKEN'),
  repo: env('GITHUB_REPOSITORY'),
  tgToken: env('TG_BOT_TOKEN'),
  tgChatId: env('TG_CHAT_ID'),
  // 代理地址：显式 PROXY_URL 优先，否则取 sing-box 脚本写入的 IS_PROXY/PROXY_SERVER
  proxyUrl: env('PROXY_URL') || (env('IS_PROXY').toLowerCase() === 'true' ? env('PROXY_SERVER') : ''),
  headless: bool('HEADLESS', true),
  dryRun: bool('DRY_RUN', false),
  timezone: env('TIMEZONE', 'Asia/Shanghai'),
  locale: env('LOCALE', 'en-US'),
  channel: env('BROWSER_CHANNEL'),
  navTimeout: num('NAV_TIMEOUT', 90000),
  shotDir: env('SHOT_DIR', 'screenshots'),
  ua: env('USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
};

/* ============================== 小工具 ============================== */

const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${nowStr()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 北京时间（佬王同款：UTC+8，YYYY-MM-DD HH:mm:ss，不依赖 runner 时区） */
const bjTime = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

/** 当前出口 IP（直连裸请求；失败返回'获取失败'，不阻塞主流程） */
function getCurrentIp(ms = 15000) {
  return new Promise((resolve) => {
    const req = https.get('https://api.ip.sb/ip', { timeout: ms }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve(r.statusCode === 200 ? buf.trim() : '获取失败'));
    });
    req.on('error', () => resolve('获取失败'));
    req.on('timeout', () => { req.destroy(); resolve('获取失败'); });
  });
}

/** 解析目标服务器列表：完整 URL 或裸 ID */
function parseTargets() {
  const raw = [env('SERVER_PAGE_URL'), env('SERVER_ID')].filter(Boolean).join('\n');
  const out = [];
  for (const line of raw.split(/[\r\n,;]+/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^https?:\/\//i.test(t)) out.push(t);
    else if (/^[0-9a-zA-Z_-]{4,}$/.test(t)) out.push(CFG.serverBase + t);
  }
  return [...new Set(out)];
}

function serverIdOf(url) {
  const m = String(url).match(/server\/([0-9a-zA-Z-]+)/);
  return m ? m[1] : (String(url).split('/').pop() || 'unknown');
}

/** TCP 探测 host:port 是否可连（sing-box 存活校验），不通自动直连 */
function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

function parseProxyHostPort(p) {
  try {
    const u = new URL(p);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname, port: Number(u.port) };
  } catch { return null; }
}

/** page.goto 带重试：ERR_CONNECTION_RESET 等网络抖动退避重试 */
async function gotoRetry(page, url, opts = {}, retries = 3) {
  let last;
  for (let i = 1; i <= retries; i++) {
    try { return await page.goto(url, opts); } catch (e) {
      last = e;
      log(`⚠️ 导航失败(${i}/${retries}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      if (i < retries) await sleep(3000 * i);
    }
  }
  throw last;
}

/** 邮箱脱敏（佬王 HidenCloud 风格：保留前后2位） */
function maskEmail() {
  const e = CFG.email || '';
  if (e.includes('@')) {
    const [name, domain] = e.split('@', 2);
    return name.length > 4 ? `${name.slice(0, 2)}****${name.slice(-2)}@${domain}` : `${name}@${domain}`;
  }
  return e ? `${e.slice(0, 2)}****` : 'COOKIE_VALUE登录';
}

/** 原生 https 发 TG 通知（佬王风格：parse_mode HTML，直发无降级） */
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CFG.tgToken || !CFG.tgChatId) {
      log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过通知');
      return resolve(false);
    }
    const data = JSON.stringify({ chat_id: CFG.tgChatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CFG.tgToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          log(j.ok ? '📢 TG 通知已送达' : `⚠️ TG 通知失败: ${(j.description || buf).slice(0, 120)}`);
          resolve(!!j.ok);
        } catch { log('⚠️ TG 响应解析失败'); resolve(false); }
      });
    });
    req.on('error', (e) => { log(`⚠️ TG 发送异常: ${e.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function safeShot(page, name) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, name.endsWith('.png') ? name : `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 8000 });
    log(`📸 截图: ${file}`);
    return file;
  } catch (e) {
    log(`⚠️ 截图跳过: ${e.message}`);
    return null;
  }
}

/* ============================== 登录态 ============================== */

/** 由 COOKIE_VALUE 构建 Playwright storageState（remember_web cookie，自动补全其余会话 cookie） */
function buildAuthState() {
  if (!CFG.cookieValue) return null;
  log(`🍪 使用 COOKIE_VALUE（${CFG.cookieValue.length}字）注入 remember_web 登录态`);
  return {
    cookies: [{
      name: 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d',
      value: CFG.cookieValue,
      domain: 'aclclouds.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [],
  };
}

/* ============================== 浏览器续期 ============================== */

/** 是否已登录：页面出现服务器关键文案 */
async function isLoggedIn(page) {
  try {
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 2000)).catch(() => '');
    return /Time remaining|Free plan|Console|Dashboard/i.test(txt);
  } catch { return false; }
}

/** 文本候选点击 */
async function clickByText(scope, texts, opts = {}) {
  for (const t of texts) {
    try {
      const el = scope.locator(`button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`).first();
      if (await el.isVisible({ timeout: opts.timeout || 1500 })) {
        await el.click({ timeout: 5000 });
        log(`👆 已点击: [${t}]`);
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}

async function dumpState(context) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, 'storage-state.json');
    const st = await context.storageState({ path: file });
    const s = JSON.stringify(st);
    log(`💾 登录态已导出 ${file} (${s.length} bytes)`);
    return s;
  } catch (e) {
    log(`⚠️ 导出登录态失败: ${e.message}`);
    return null;
  }
}

async function renewOneServer(context, url, idx, total) {
  const page = await context.newPage();
  const id = serverIdOf(url);
  const result = { idx, total, url, id, status: 'FAIL', before: null, after: null, note: '' };
  const t0 = Date.now();
  log(`\n──────── 服务器 [${idx}/${total}] ${id} ────────`);

  try {
    await gotoRetry(page, url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    await sleep(2500);

    if (!(await isLoggedIn(page))) {
      result.note = '未登录/被重定向';
      await safeShot(page, `server-${idx}-nologin.png`);
      return result;
    }

    // 从页面读到期时间（div.srv-expiry 内文案，如 "Temps restant : 3j 19h"）
    const beforeTxt = await page.evaluate(() => {
      const el = document.querySelector('.srv-expiry-text, .srv-expiry');
      return el ? (el.innerText || '').trim().slice(0, 100) : '';
    }).catch(() => '');
    result.before = beforeTxt || '?';
    log(`⏱️ 页面到期信息: ${result.before}`);

    if (CFG.dryRun) { result.status = 'PENDING'; result.note = 'DRY_RUN 演练，未点击'; return result; }
    // 找续期按钮（泛匹配；录制时 can_renew=false 故无精确选择器）
    const btn = page.locator('button, a, [role="button"]')
      .filter({ hasText: /^.*renew.*$/i }).first();
    let hasBtn = false;
    try {
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      hasBtn = true;
      const label = (await btn.innerText().catch(() => 'Renew')).replace(/\s+/g, ' ').trim().slice(0, 60);
      log(`🔘 续期按钮: [${label}]`);
      await btn.click({ timeout: 8000 });
    } catch {
      hasBtn = await clickByText(page, ['Renew', 'Renew Server', 'Renew now'], { timeout: 1500 });
      if (!hasBtn) {
        // 页面明示到期前2天才可续 → 未到续期窗口，属正常状态
        const bodyTxt = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
        if (/renewal[^.\n]{0,40}available/i.test(bodyTxt)) {
          result.status = 'PENDING';
          result.note = '未到续期时间';
          return result;
        }
        result.note = '未找到 Renew 按钮（可能改版，需补录）';
        await safeShot(page, `server-${idx}-norenew.png`);
        result.status = 'NO_BUTTON';
        return result;
      }
    }
    await sleep(2000);

    // 确认弹窗（Anti-bot confirmation + Cap.js）：必须点 cap-widget，点 Confirm/Yes 无效
    const modal = page.locator('[role="dialog"], div.modal.show, .modal, [class*="modal"]').last();
    let capClicked = false;
    try {
      await modal.waitFor({ state: 'visible', timeout: 8000 });
      log('🪟 已探测到确认弹窗');
      let btns = [];
      try {
        btns = await modal.locator('button, a, [role="button"], input[type="submit"]').all();
      } catch { /* ignore */ }
      const labels = [];
      for (const b of btns) {
        try {
          if (await b.isVisible({ timeout: 500 })) {
            const t = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            if (t) labels.push(t);
          }
        } catch { /* ignore */ }
      }
      // cap-widget 是自定义元素，不在上面的 button/a 选择器里，单独枚举
      try {
        const capCount = await modal.locator('cap-widget, .auth-cap-widget').count();
        if (capCount) labels.push("Verify you're human", 'Cap');
      } catch { /* ignore */ }
      log(`📝 弹窗按钮: ${labels.length ? JSON.stringify(labels) : '（空）'}`);
      await safeShot(page, `server-${idx}-modal.png`);
      // 优先点 cap-widget（录制选择器 div.auth-cap-widget > cap-widget）
      for (const c of [modal.locator('cap-widget').first(), page.locator('.auth-cap-widget cap-widget').first(), page.locator('cap-widget').first()]) {
        try {
          await c.waitFor({ state: 'visible', timeout: 3000 });
          await c.click({ timeout: 8000 });
          capClicked = true;
          log('👆 已点击 cap-widget，等待解算…');
          break;
        } catch { /* 换下一个候选 */ }
      }
      if (!capClicked) capClicked = await clickByText(modal, ["Verify you're human", 'Verify'], { timeout: 1500 });
      if (capClicked) {
        // Cap 解算约6s（录制 8.2s→13.8s），等 Solved 文案最多30s；等不到也继续
        try {
          await page.getByText("You're human", { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
          log('✅ Cap 已解算 (You\'re human)');
        } catch { log('ℹ️ 未探测到 Solved 文案，继续'); }
      } else {
        const ok = await clickByText(modal, ['Renew', 'Confirm', 'Yes', 'Continue', 'Submit', 'OK'], { timeout: 1200 });
        if (!ok) await clickByText(page.locator('body'), ['Confirm', 'Yes', 'OK'], { timeout: 1000 }).catch(() => false);
      }
    } catch { log('ℹ️ 无独立确认弹窗，继续'); }

    // 读页面 alert 判结果
    const alert = await page.evaluate(() => {
      const el = document.querySelector('div.alert');
      return el ? (el.innerText || '').trim().slice(0, 200) : '';
    }).catch(() => '');
    if (alert) log(`📩 页面提示: ${alert}`);
    const low = alert.toLowerCase();

    // Cap 解算 + 前端自动重试 renew 需要时间，等页面提示出现或刷新页面读新到期时间
    await sleep(5000);
    // 刷新页面后重读到期信息
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(2500);
    } catch { /* ignore */ }
    const afterTxt = await page.evaluate(() => {
      const el = document.querySelector('.srv-expiry-text, .srv-expiry');
      return el ? (el.innerText || '').trim().slice(0, 100) : '';
    }).catch(() => '');
    result.after = afterTxt || '?';
    log(`🔍 复核: ${result.before} ➔ ${result.after}`);
    await safeShot(page, `server-${idx}-verify.png`);

    if (/renewed|success|extended/i.test(low) || (result.before !== result.after)) {
      result.status = 'SUCCESS';
      result.note = alert || '页面到期信息已更新';
      log('🎉 续期成功');
    } else if (/can't renew|unable|not yet|cooldown|too early/i.test(low)) {
      result.status = 'PENDING';
      result.note = alert || '未到续期窗口';
      log(`⏳ ${result.note}`);
    } else {
      result.status = 'FAIL';
      result.note = alert ? `点击完成但未确认: ${alert}` : '点击完成但页面到期信息未变化（cap-widget 可能未解算成功）';
      await safeShot(page, `server-${idx}-fail.png`);
      log('❌ 未能确认续期成功');
    }
  } catch (e) {
    result.note = (result.note || '') + ` 异常: ${String(e.message).slice(0, 120)}`;
    await safeShot(page, `server-${idx}-error.png`);
    log(`❌ 处理异常: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
    log(`⌛ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return result;
}

/* ============================== 登录 ============================== */

/** 等待 cap-widget 解算（"You're human" 出现或 Solved 文案） */
async function waitCapSolved(page, timeout = 30000) {
  try {
    await page.getByText("You're human", { exact: false }).first().waitFor({ state: 'visible', timeout });
    log('✅ Cap 已解算 (You\'re human)');
    return true;
  } catch {
    log('ℹ️ 未探测到 Cap Solved 文案，继续');
    return false;
  }
}

/** 点击表单内 cap-widget，多次重试直到解算成功 */
async function clickFormCapWidget(page) {
  const selectors = [
    'div.auth-cap-widget > cap-widget',
    'form cap-widget',
    'div.auth-form-card cap-widget',
    'cap-widget',
  ];
  for (let round = 0; round < 4; round++) {
    for (const sel of selectors) {
      const cap = page.locator(sel).first();
      try {
        await cap.waitFor({ state: 'visible', timeout: 3000 });
        log(`👆 点击 cap-widget（${sel}）第 ${round + 1} 轮`);
        await cap.click({ timeout: 5000 });
        await waitCapSolved(page);
        return true;
      } catch { /* 换下一个选择器 */ }
    }
    log('⚠️ cap-widget 未解算，1s 后重试…');
    await sleep(1000);
  }
  return false;
}

/**
 * 账密登录（基于 AgentScribe session 751a24bb 抓包确认的登录表单结构）：
 *  登录页  https://aclclouds.com/auth/login
 *  用户名  #username        （type="text"，非 email）
 *  密码    #password
 *  Cap     div.auth-cap-widget > cap-widget（提交前必须解算，约 6s）
 *  提交    button.auth-submit-btn（"Se connecter"）
 *  成功    跳转 /dashboard
 * 流程：填账密 → 点 cap-widget → 等解算 → 点提交 → 验证跳转
 */
async function doLogin(page) {
  log('🔑 账密登录');
  await gotoRetry(page, CFG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
  await sleep(2500);
  if (await isLoggedIn(page)) { log('✅ 已有有效登录态，跳过登录'); return true; }
  try {
    // 填写用户名（#username，type=text；兼容 form 内其他候选）
    const userInput = page.locator('#username, input[name="username"], input[type="email"]').first();
    // 填写密码（#password）
    const passInput = page.locator('#password, input[type="password"]').first();
    await userInput.waitFor({ state: 'visible', timeout: 20000 });
    log(`⌨️ 填写用户名…`);
    await userInput.fill(CFG.email);
    log(`⌨️ 填写密码…`);
    await passInput.fill(CFG.password);
    await sleep(500);

    // 提交前必须先解算 cap-widget（录制：0:08 点 cap → 0:14 点提交，约 6s 解算）
    log('🛡️ 处理表单内 cap-widget…');
    const capOk = await clickFormCapWidget(page);
    if (!capOk) log('⚠️ cap-widget 未确认解算，仍将尝试提交…');

    // 点提交按钮（button.auth-submit-btn；兼容泛文案）
    await sleep(1000);
    const submitBtn = page.locator('button.auth-submit-btn, button[type="submit"]').first();
    try {
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      log('🖱️ 点击提交按钮');
      await submitBtn.click({ timeout: 5000 });
    } catch {
      const ok = await clickByText(page, ['Se connecter', 'Sign in', 'Log in', 'Login', 'Continue'], { timeout: 3000 });
      if (!ok) {
        log('❌ 未找到提交按钮');
        await safeShot(page, 'login-no-submit.png');
        return false;
      }
    }

    // 提交后等跳转离开登录页（登录成功 → /dashboard）
    log('⏳ 等待登录跳转…');
    const navStart = Date.now();
    let navigated = false;
    while (Date.now() - navStart < 120000) {
      const url = page.url || '';
      if (!url.includes('/auth/login') && !url.includes('/login')) { navigated = true; break; }
      // 跳转后可能遇到 cap 拦截
      if (await isLoggedIn(page)) { navigated = true; break; }
      await sleep(1000);
    }
    if (!navigated) {
      log('❌ 提交后 120s 内未完成跳转，登录失败');
      await safeShot(page, 'login-timeout.png');
      return false;
    }
    // 最终验证
    await sleep(2000);
    const ok = await isLoggedIn(page);
    log(ok ? '✅ 登录成功，已到达 /dashboard' : '⚠️ 已跳转但未检测到 dashboard 文案');
    if (ok) await safeShot(page, 'login-success.png');
    return ok;
  } catch (e) {
    log(`❌ 登录异常: ${String(e.message).slice(0, 150)}`);
    await safeShot(page, 'login-error.png');
    return false;
  }
}

/* ============================== 汇报 ============================== */

/** TG 报告（佬王同款 eooce 风：标题 + 状态 + 脱敏账号 + 前后到期 + IP + 北京时间） */
async function reportResults(results, currentIp = '未知') {
  results.sort((a, b) => a.idx - b.idx);
  const STATUS = { SUCCESS: '✅ 续期成功', NO_BUTTON: '❌ 未找到按钮', FAIL: '❌ 续期失败', PENDING: '⏳ 未到续期时间' };
  const ICON = { SUCCESS: '🟢', NO_BUTTON: '🟡', FAIL: '🔴', PENDING: '⏳' };
  const HIDE_DATE = new Set(['?', '-', '未读取到', '', null, undefined]);
  const lines = ['🎉 ACLClouds 续期通知', ''];
  for (const r of results) {
    lines.push(STATUS[r.status] || r.status);
    lines.push(`👤 账号: ${maskEmail()}`);
    lines.push(`🖥 服务器: ${r.id}`);
    if (r.status !== 'PENDING' && !HIDE_DATE.has(r.before)) lines.push(`📅 续期前到期：${r.before}`);
    if (r.status !== 'PENDING' && !HIDE_DATE.has(r.after)) lines.push(`📅 续期后到期：${r.after}`);
    // 内部 note（如 can_renew=false(…)/expires_at 已更新）不再展示；仅失败时保留简短原因
    if ((r.status === 'FAIL' || r.status === 'NO_BUTTON') && r.note) lines.push(`📝 ${String(r.note).slice(0, 120)}`);
    lines.push('');
  }
  lines.push(`🌐 续期使用IP: ${currentIp}`);
  lines.push(`🕒 续期时间：${bjTime()}`);
  await sendTelegram(lines.join('\n'));
  console.log('\n================ 汇总 ================');
  results.forEach((r) => console.log(`${ICON[r.status]} [${r.idx}/${r.total}] ${r.id} ${r.before}${r.after ? ' ➔ ' + r.after : ''} ${r.note}`));
  // 失败只走 TG 通知感知，工作流一律绿色（exit 0），避免红灯打扰
  process.exitCode = 0;
}

/* ============================== 主流程 ============================== */

(async () => {
  const targets = parseTargets();
  if (!targets.length) {
    console.error('❌ 未配置 SERVER_PAGE_URL（或 SERVER_ID），脚本终止');
    process.exit(1);
  }
  const state = buildAuthState();
  if (!state && (!CFG.email || !CFG.password)) {
    console.error('❌ 需至少提供 COOKIE_VALUE，或 ACL_EMAIL + ACL_PASSWORD');
    process.exit(1);
  }

  log('#'.repeat(64));
  log('   ACLClouds (aclclouds.com) 自动续期  v1.0');
  log(`   目标数: ${targets.length} | DRY_RUN: ${CFG.dryRun}`);
  log(`   代理: ${CFG.proxyUrl || '直连'} | headless: ${CFG.headless} | 登录: ${state ? 'COOKIE_VALUE注入(可降级账密)' : '账密'}`);
  log('#'.repeat(64));

  if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });

  const launchOpts = {
    headless: CFG.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--window-size=1920,1080', '--lang=en-US', '--no-first-run',
    ],
  };
  if (CFG.proxyUrl) {
    const hp = parseProxyHostPort(CFG.proxyUrl);
    // sing-box 未起好/端口残留时直接直连，不穿透脏代理
    const alive = hp ? await tcpProbe(hp.host, hp.port, 5000) : false;
    if (alive) {
      try { launchOpts.proxy = { server: CFG.proxyUrl }; log(`🔗 代理存活: ${CFG.proxyUrl}，走代理`); } catch (e) { log(`⚠️ 代理参数无效: ${e.message}`); }
    } else {
      log(`⚠️ 代理不可连(${CFG.proxyUrl})，本次直连`);
      CFG.proxyUrl = '';
    }
  } else { log('🍭 直连模式（未配置 NODE_LINK 则 workflow 不起 sing-box）'); }
  if (CFG.channel) launchOpts.channel = CFG.channel;

  const currentIp = await getCurrentIp();
  log(`🎯 当前出口IP: ${currentIp}`);

  // 启动浏览器
  const results = [];
  const browserTargets = targets.map((url, i) => ({ url, idx: i + 1 }));
  const browser = await chromium.launch(launchOpts);
  const ctxOpts = { viewport: { width: 1920, height: 1080 }, userAgent: CFG.ua, locale: CFG.locale, timezoneId: CFG.timezone };
  if (state) ctxOpts.storageState = state;
  const context = await browser.newContext(ctxOpts);

  let authOk = false;
  const first = await context.newPage();
  try {
    if (state) {
      log('🍪 使用 COOKIE_VALUE 注入登录态访问目标页');
      await gotoRetry(first, browserTargets[0].url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(2500);
      if (await isLoggedIn(first)) authOk = true;
      else log('⚠️ COOKIE_VALUE 已失效，降级为账密登录');
    }
    if (!authOk && CFG.email && CFG.password) authOk = await doLogin(first);
    if (!authOk) {
      await safeShot(first, 'login-failed.png');
      await dumpState(context);
      throw new Error('登录失败（COOKIE_VALUE 和账密均不可用）');
    }
    // 导出登录态供本地调试（不自动回写 Secret，COOKIE_VALUE 需手动更新）
    await dumpState(context);
  } finally { await first.close().catch(() => {}); }

  for (const t of browserTargets) {
    try { results.push(await renewOneServer(context, t.url, t.idx, targets.length)); }
    catch (e) { log(`❌ 服务器 ${t.idx} 未捕获异常: ${e.message}`); results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), status: 'FAIL', before: '-', after: '-', note: e.message.slice(0, 100) }); }
    await sleep(1500);
  }
  await context.storageState({ path: path.join(CFG.shotDir, 'storage-state-final.json') }).catch(() => {});
  await browser.close();
  log('🏁 浏览器已关闭');

  await reportResults(results, currentIp);
})().catch(async (e) => {
  console.error('❌ 全局致命错误:', e.message);
  const ip = await getCurrentIp();
  await sendTelegram(['🎉 ACLClouds 续期通知', '', '❌ 运行异常', `👤 账号: ${maskEmail()}`, `🌐 续期使用IP: ${ip}`, `🕒 续期时间：${bjTime()}`, `📝 ${String(e.message).slice(0, 200)}`].join('\n'));
  process.exit(0); // 同上：异常（登录失败等）也只走 TG 通知，保持绿色
});
