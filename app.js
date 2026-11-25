'use strict';
/* ================= 数据存储 ================= */
const KEY = 'loanLedger.v1';
const METHODS = {
  equal_installment: '等额本息',
  equal_principal: '等额本金',
  interest_first: '先息后本',
  none: '无固定计划（随借随还）'
};

const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n < 0 ? '-' : '') + '¥' + Math.abs(round2(n)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let state = load();
let view = { name: 'home', loanId: null };

function emptyState() {
  return { loans: [], records: [], settings: { remindDays: 3 } };
}
function normalize(s) {
  return {
    loans: Array.isArray(s.loans) ? s.loans : [],
    records: Array.isArray(s.records) ? s.records : [],
    settings: Object.assign({ remindDays: 3 }, s.settings || {})
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.loans)) return normalize(s);
  } catch (e) { /* ignore */ }
  return emptyState();
}
function save() {
  state.settings.lastSaved = new Date().toISOString();
  localStorage.setItem(KEY, JSON.stringify(state));
}

/* ================= 日期工具 ================= */
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoOf(new Date());
function parseDate(s) {
  const [y, m, d] = String(s || todayIso()).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addMonths(startIso, k, day) {
  const s = parseDate(startIso);
  const y = s.getFullYear(), m = s.getMonth() + k;
  const last = new Date(y, m + 1, 0).getDate();
  return isoOf(new Date(y, m, Math.min(day || s.getDate(), last)));
}
function daysUntil(iso) {
  const t = parseDate(todayIso());
  return Math.round((parseDate(iso) - t) / 86400000);
}
const cnDate = (iso) => { const d = parseDate(iso); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const shortDate = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
function dueText(days) {
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${days} 天后到期`;
}

/* ================= 计算 ================= */
// 根据「建账时的剩余本金」和「剩余期数」生成接下来的还款计划
function schedule(loan) {
  const P = round2((Number(loan.principal) || 0) - (Number(loan.repaidBefore) || 0));
  const n = parseInt(loan.termMonths, 10) || 0;
  const r = (Number(loan.rate) || 0) / 100 / 12;
  if (loan.method === 'none' || !n || P <= 0) return [];
  const hasNext = Boolean(loan.nextPayDate);
  const baseDate = hasNext ? loan.nextPayDate : (loan.startDate || todayIso());
  const day = hasNext
    ? parseDate(loan.nextPayDate).getDate()
    : (parseInt(loan.payDay, 10) || parseDate(baseDate).getDate());
  const pmt = r ? (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : P / n;
  const out = [];
  let bal = P;
  for (let i = 1; i <= n; i++) {
    let interest = bal * r;
    let principal;
    if (loan.method === 'equal_installment') principal = i === n ? bal : pmt - interest;
    else if (loan.method === 'equal_principal') principal = i === n ? bal : P / n;
    else principal = i === n ? bal : 0; // 先息后本
    interest = round2(interest);
    principal = round2(principal);
    bal = round2(bal - principal);
    const date = hasNext ? addMonths(baseDate, i - 1, day) : addMonths(baseDate, i, day);
    out.push({ n: i, date, payment: round2(principal + interest), principal, interest, balance: Math.max(0, bal) });
  }
  return out;
}

function recordsOf(loanId) {
  return state.records
    .filter((r) => r.loanId === loanId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

function stats(loan) {
  let borrowed = 0, repaidRecords = 0, interestPaid = 0, latestRepayDate = '';
  for (const r of state.records) {
    if (r.loanId !== loan.id) continue;
    if (r.type === 'borrow') borrowed += Number(r.amount) || 0;
    else {
      repaidRecords += Number(r.amount) || 0;
      interestPaid += Number(r.interest) || 0;
      if ((r.date || '') > latestRepayDate) latestRepayDate = r.date || '';
    }
  }
  const repaidBefore = round2(loan.repaidBefore);
  const plan = schedule(loan);
  const planBase = round2(Math.max(0, (Number(loan.principal) || 0) - repaidBefore));
  const repaid = round2(repaidBefore + repaidRecords);
  const total = round2((Number(loan.principal) || 0) + borrowed);
  const principalRepaid = round2(repaidBefore + repaidRecords - interestPaid);
  const remaining = round2(total - principalRepaid);

  // 根据建账后的累计还款额判断接下来计划已还到第几期
  let cum = 0, paidPeriods = 0;
  for (const p of plan) {
    if (cum + p.payment <= repaidRecords + 0.01) { cum += p.payment; paidPeriods++; } else break;
  }
  const planTotal = round2(plan.reduce((a, p) => a + p.payment, 0));
  const planInterest = round2(plan.reduce((a, p) => a + p.interest, 0));

  let next = null;
  if (remaining > 0.009) {
    if (plan.length && paidPeriods < plan.length) {
      const p = plan[paidPeriods];
      next = { date: p.date, amount: round2(cum + p.payment - repaidRecords), n: p.n };
    } else if (!plan.length && loan.nextPayDate) {
      let iso = loan.nextPayDate;
      const day = parseDate(iso).getDate();
      let step = 0;
      while (latestRepayDate && iso <= latestRepayDate && step < 1200) {
        step++;
        iso = addMonths(loan.nextPayDate, step, day);
      }
      next = { date: iso, amount: null };
    } else if (!plan.length && parseInt(loan.payDay, 10)) {
      const day = parseInt(loan.payDay, 10);
      const t = parseDate(todayIso());
      let iso = addMonths(isoOf(new Date(t.getFullYear(), t.getMonth(), 1)), 0, day);
      if (iso < todayIso()) iso = addMonths(isoOf(new Date(t.getFullYear(), t.getMonth(), 1)), 1, day);
      next = { date: iso, amount: null };
    }
  }
  return {
    borrowed: round2(borrowed), repaid, repaidBefore, repaidRecords: round2(repaidRecords),
    interestPaid: round2(interestPaid), total, principalRepaid, remaining,
    plan, planBase, paidPeriods, next, planTotal, planInterest,
    progress: total > 0 ? Math.min(1, Math.max(0, principalRepaid / total)) : 0
  };
}

function totals() {
  const t = { principal: 0, borrowed: 0, repaid: 0, repaidBefore: 0, total: 0, remaining: 0, interestPaid: 0, principalRepaid: 0 };
  for (const l of state.loans) {
    const s = stats(l);
    t.principal += Number(l.principal) || 0;
    t.borrowed += s.borrowed; t.repaid += s.repaid; t.repaidBefore += s.repaidBefore;
    t.total += s.total; t.remaining += s.remaining; t.interestPaid += s.interestPaid; t.principalRepaid += s.principalRepaid;
  }
  Object.keys(t).forEach((k) => (t[k] = round2(t[k])));
  t.progress = t.total > 0 ? Math.min(1, Math.max(0, t.principalRepaid / t.total)) : 0;
  return t;
}

function reminders() {
  const out = [];
  for (const l of state.loans) {
    const s = stats(l);
    if (!s.next) continue;
    const days = daysUntil(s.next.date);
    const remind = l.remindDays !== '' && l.remindDays != null ? Number(l.remindDays) : Number(state.settings.remindDays);
    if (days <= remind) out.push({ loan: l, next: s.next, days });
  }
  return out.sort((a, b) => a.days - b.days);
}

/* ================= 渲染 ================= */
const viewEl = $('#view');

function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const tab = view.name === 'loan' ? 'loans' : view.name;
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('#backBtn').classList.toggle('hidden', view.name !== 'loan');
  $('#addBtn').classList.toggle('hidden', view.name === 'settings');
  if (view.name === 'home') renderHome();
  else if (view.name === 'loans') renderLoans();
  else if (view.name === 'loan') renderLoan();
  else renderSettings();
  window.scrollTo(0, 0);
}

function reminderHtml() {
  return reminders().map(({ loan, next, days }) => {
    const cls = days < 0 ? 'red' : days <= 1 ? 'orange' : 'blue';
    return `<div class="alert ${cls}" data-action="open-loan" data-id="${loan.id}">
      <div class="main"><b>${esc(loan.name)}：${dueText(days)}</b>
      ${cnDate(next.date)}${next.amount != null ? ` · 应还 ${fmt(next.amount)}` : ''}</div>
      <button class="btn primary" style="flex:0 0 auto;padding:8px 12px" data-action="add-record" data-id="${loan.id}" data-type="repay">还款</button>
    </div>`;
  }).join('');
}

function installHint() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone || !ios || localStorage.getItem('hideInstallHint')) return '';
  return `<div class="alert blue"><div class="main"><b>安装到桌面</b>点 Safari 底部的「分享」按钮 → 「添加到主屏幕」，就能像 App 一样使用。</div>
    <button class="link" data-action="hide-hint">知道了</button></div>`;
}

function renderHome() {
  $('#title').textContent = '贷款记账';
  if (!state.loans.length) {
    viewEl.innerHTML = installHint() + `<div class="empty"><div class="e-ico">📒</div>
      还没有贷款记录<br/>先添加一笔贷款吧</div>
      <div class="btns"><button class="btn primary" data-action="add-loan">＋ 添加贷款</button></div>`;
    return;
  }
  const t = totals();
  const recent = [...state.records].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
  viewEl.innerHTML = `
    ${installHint()}
    <div class="card hero">
      <div class="label">剩余未还（本金）</div>
      <div class="big">${fmt(t.remaining)}</div>
      <div class="progress"><i style="width:${(t.progress * 100).toFixed(1)}%"></i></div>
      <div class="meta">已还本金 ${(t.progress * 100).toFixed(1)}% · 共 ${state.loans.length} 笔贷款</div>
    </div>
    <div class="grid3">
      <div class="stat blue"><div class="k">贷款金额</div><div class="v">${fmt(t.total)}</div></div>
      <div class="stat green"><div class="k">已还金额</div><div class="v">${fmt(t.repaid)}</div></div>
      <div class="stat orange"><div class="k">新借金额</div><div class="v">${fmt(t.borrowed)}</div></div>
    </div>
    <div class="note" style="margin:6px 4px">贷款金额 = 初始借款 ${fmt(t.principal)} + 新借 ${fmt(t.borrowed)}${t.repaidBefore ? `；已还中含以前已还 ${fmt(t.repaidBefore)}` : ''}${t.interestPaid ? `，后续利息 ${fmt(t.interestPaid)}` : ''}</div>
    ${reminderHtml()}
    <div class="btns">
      <button class="btn primary" data-action="add-record" data-type="repay">记一笔还款</button>
      <button class="btn warn" data-action="add-record" data-type="borrow">新借一笔</button>
    </div>
    <div class="section-title">最近记录</div>
    ${recent.length ? `<div class="list">${recent.map((r) => recordRow(r, true)).join('')}</div>` : `<div class="card empty" style="padding:20px">还没有还款或新借记录</div>`}
  `;
}

function recordRow(r, showLoan = true) {
  const loan = state.loans.find((l) => l.id === r.loanId);
  const isRepay = r.type !== 'borrow';
  const sub = [cnDate(r.date), showLoan && loan ? loan.name : '', isRepay && Number(r.interest) ? `含利息 ${fmt(r.interest)}` : '', r.note].filter(Boolean).map(esc).join(' · ');
  return `<div class="row tap" data-action="edit-record" data-id="${r.id}">
    <span class="badge ${isRepay ? 'green' : 'orange'}">${isRepay ? '还款' : '新借'}</span>
    <div class="main"><div class="s" style="margin:0">${sub}</div></div>
    <div class="r amt ${isRepay ? 'repay' : 'borrow'}">${isRepay ? '-' : '+'}${fmt(r.amount)}</div>
  </div>`;
}

function renderLoans() {
  $('#title').textContent = '我的贷款';
  if (!state.loans.length) {
    viewEl.innerHTML = `<div class="empty"><div class="e-ico">🏦</div>还没有贷款</div>
      <div class="btns"><button class="btn primary" data-action="add-loan">＋ 添加贷款</button></div>`;
    return;
  }
  const rows = state.loans.map((l) => {
    const s = stats(l);
    let badge = '';
    if (s.remaining <= 0.009) badge = '<span class="badge green">已还清</span>';
    else if (s.next) {
      const d = daysUntil(s.next.date);
      badge = `<span class="badge ${d < 0 ? 'red' : d <= 3 ? 'orange' : 'gray'}">${d < 0 ? '逾期' : shortDate(s.next.date) + ' 还款'}</span>`;
    }
    return `<div class="row tap" data-action="open-loan" data-id="${l.id}">
      <div class="main">
        <div class="t">${esc(l.name)} ${badge}</div>
        <div class="s">${esc([l.lender, METHODS[l.method] || '', l.rate ? `年利率 ${l.rate}%` : ''].filter(Boolean).join(' · '))}</div>
        <div class="mini-bar"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
      </div>
      <div class="r"><div class="amt">${fmt(s.remaining)}</div><div class="s">剩余 / 共 ${fmt(s.total)}</div></div>
      <span class="chev">›</span>
    </div>`;
  }).join('');
  viewEl.innerHTML = `<div class="list">${rows}</div>
    <div class="btns"><button class="btn primary" data-action="add-loan">＋ 添加贷款</button></div>`;
}

function renderLoan() {
  const loan = state.loans.find((l) => l.id === view.loanId);
  if (!loan) { view = { name: 'loans' }; return render(); }
  $('#title').textContent = loan.name;
  const s = stats(loan);
  const recs = recordsOf(loan.id);
  const nextDays = s.next ? daysUntil(s.next.date) : null;

  const planHtml = s.plan.length ? `
    <div class="card">
      <h3>接下来怎么还 <span class="note">${METHODS[loan.method]} · 剩 ${s.plan.length} 期</span></h3>
      <div class="note" style="margin-bottom:8px">按剩余 ${fmt(s.planBase)} 计算：后续总还款 ${fmt(s.planTotal)}，其中利息 ${fmt(s.planInterest)}。后续已还 ${s.paidPeriods}/${s.plan.length} 期。</div>
      <div class="scroll-x"><table class="plan">
        <thead><tr><th>期/日期</th><th>月供</th><th>本金</th><th>利息</th><th>剩余</th></tr></thead>
        <tbody>${s.plan.map((p, i) => `<tr class="${i < s.paidPeriods ? 'paid' : i === s.paidPeriods ? 'next' : ''}">
          <td>${p.n} · ${p.date.slice(2).replace(/-/g, '/')}</td><td>${p.payment.toFixed(2)}</td><td>${p.principal.toFixed(2)}</td><td>${p.interest.toFixed(2)}</td><td>${p.balance.toFixed(2)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : '';

  viewEl.innerHTML = `
    <div class="card hero">
      <div class="label">现在还剩（本金）${loan.lender ? ' · ' + esc(loan.lender) : ''}</div>
      <div class="big">${fmt(s.remaining)}</div>
      <div class="progress"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
      <div class="meta">${s.remaining <= 0.009 ? '🎉 已全部还清' : s.next ? `下次还款：${cnDate(s.next.date)}（${dueText(nextDays)}）${s.next.amount != null ? ' · ' + fmt(s.next.amount) : ''}` : `已还本金 ${(s.progress * 100).toFixed(1)}%`}</div>
    </div>
    <div class="grid3">
      <div class="stat blue"><div class="k">贷款金额</div><div class="v">${fmt(s.total)}</div></div>
      <div class="stat green"><div class="k">已还金额</div><div class="v">${fmt(s.repaid)}</div></div>
      <div class="stat orange"><div class="k">新借金额</div><div class="v">${fmt(s.borrowed)}</div></div>
    </div>
    <div class="note" style="margin:6px 4px">以前借了 ${fmt(loan.principal)}${loan.startDate ? `（${cnDate(loan.startDate)}）` : ''}${s.repaidBefore ? ` · 以前已还 ${fmt(s.repaidBefore)}` : ''}${s.interestPaid ? ` · 后续已付利息 ${fmt(s.interestPaid)}` : ''}${loan.note ? '<br/>备注：' + esc(loan.note) : ''}</div>
    <div class="btns">
      <button class="btn primary" data-action="add-record" data-id="${loan.id}" data-type="repay">记一笔还款</button>
      <button class="btn warn" data-action="add-record" data-id="${loan.id}" data-type="borrow">新借一笔</button>
    </div>
    <div class="section-title">后续记录（${recs.length}）</div>
    ${recs.length ? `<div class="list">${recs.map((r) => recordRow(r, false)).join('')}</div>` : `<div class="card empty" style="padding:20px">还没有后续还款或新借记录</div>`}
    ${planHtml}
    <div class="btns">
      <button class="btn" data-action="export-ics" data-id="${loan.id}">📅 添加还款提醒到日历</button>
    </div>
    <div class="btns">
      <button class="btn" data-action="edit-loan" data-id="${loan.id}">编辑贷款</button>
      <button class="btn danger" data-action="delete-loan" data-id="${loan.id}">删除贷款</button>
    </div>
  `;
}

function renderSettings() {
  $('#title').textContent = '备份 / 设置';
  const last = localStorage.getItem('lastBackup');
  viewEl.innerHTML = `
    <div class="section-title">数据备份</div>
    <div class="list">
      <div class="row tap" data-action="export-json"><div class="main"><div class="t">导出备份文件</div><div class="s">${last ? '上次备份：' + new Date(last).toLocaleString('zh-CN') : '还没有备份过'}</div></div><span class="chev">›</span></div>
      <div class="row tap" data-action="import-json"><div class="main"><div class="t">从备份文件恢复</div><div class="s">会覆盖当前数据</div></div><span class="chev">›</span></div>
      <div class="row tap" data-action="export-csv"><div class="main"><div class="t">导出表格（CSV）</div><div class="s">可用 Excel / Numbers 打开</div></div><span class="chev">›</span></div>
    </div>
    <div class="note" style="margin:0 4px">数据只保存在这台手机上，不会上传到任何地方。建议定期「导出备份文件」并保存到「文件」App 或 iCloud。</div>

    <div class="section-title">提醒</div>
    <div class="field"><label>默认提前几天提醒</label>
      <input type="number" inputmode="numeric" min="0" max="30" id="remindDaysInput" value="${esc(state.settings.remindDays)}" /></div>
    <div class="note" style="margin:0 4px">打开 App 时，首页会显示即将到期和已逾期的还款。如果想要手机准时推送提醒，请在贷款详情页点「添加还款提醒到日历」，系统日历会按时提醒你。</div>

    <div class="section-title">其他</div>
    <div class="list">
      <div class="row tap" data-action="clear-all"><div class="main"><div class="t" style="color:var(--red)">清空所有数据</div></div></div>
    </div>
    <div class="note" style="text-align:center;margin-top:20px">贷款记账 v1.1</div>
  `;
  $('#remindDaysInput').addEventListener('change', (e) => {
    state.settings.remindDays = Math.max(0, parseInt(e.target.value, 10) || 0);
    save(); toast('已保存');
  });
}

/* ================= 弹窗表单 ================= */
let sheetSubmit = null;
function openSheet(title, html, onSubmit, okText = '保存') {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').oninput = null;
  $('#sheetBody').onchange = null;
  $('#sheetBody').innerHTML = html + '<button type="submit" class="hidden"></button>';
  $('#sheetOk').textContent = okText;
  sheetSubmit = onSubmit;
  $('#sheet').classList.remove('hidden');
  $('#sheetMask').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheetMask').classList.add('hidden');
  document.body.style.overflow = '';
  sheetSubmit = null;
}
function formData() {
  const o = {};
  new FormData($('#sheetBody')).forEach((v, k) => (o[k] = typeof v === 'string' ? v.trim() : v));
  return o;
}
$('#sheetOk').addEventListener('click', () => sheetSubmit && sheetSubmit(formData()));
$('#sheetBody').addEventListener('submit', (e) => { e.preventDefault(); sheetSubmit && sheetSubmit(formData()); });
$('#sheetMask').addEventListener('click', closeSheet);

function loanForm(loan) {
  const defaultNext = addMonths(todayIso(), 1);
  const l = loan || { name: '', lender: '', principal: '', repaidBefore: '', startDate: '', nextPayDate: defaultNext, rate: '', termMonths: '', method: 'equal_installment', remindDays: '', note: '' };
  const initRem = l.principal !== '' && l.principal != null ? round2(Math.max(0, Number(l.principal) - (Number(l.repaidBefore) || 0))) : '';
  openSheet(loan ? '编辑贷款' : '添加贷款', `
    <div class="field"><label>贷款名称 *</label><input name="name" value="${esc(l.name)}" placeholder="例如：房贷、车贷、借小王的钱" required /></div>
    <div class="field"><label>出借方（银行 / 平台 / 个人）</label><input name="lender" value="${esc(l.lender)}" placeholder="例如：招商银行" /></div>
    <div class="field"><label>以前总共借了多少（贷款金额）*</label><input name="principal" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(l.principal)}" placeholder="0.00" /></div>
    <div class="two" style="margin-top:10px">
      <div class="field"><label>以前已还金额</label><input name="repaidBefore" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(l.repaidBefore)}" placeholder="新借款留空" /></div>
      <div class="field"><label>现在还剩金额</label><input name="remainingNow" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(initRem)}" placeholder="自动计算" /></div>
    </div>
    <div class="note" style="margin:4px 4px 10px">老借款填「以前已还」或「现在还剩」任意一个，另一个会自动算；之前的明细不用补记。</div>
    <div class="section-title" style="margin-top:12px">接下来怎么还（选填）</div>
    <div class="field"><label>还款方式</label><select name="method">
      ${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${l.method === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select></div>
    <div class="two" style="margin-top:10px">
      <div class="field"><label>年利率 %</label><input name="rate" type="number" inputmode="decimal" step="0.001" min="0" value="${esc(l.rate)}" placeholder="例如 3.85" /></div>
      <div class="field"><label>剩余期数（月）</label><input name="termMonths" type="number" inputmode="numeric" min="0" value="${esc(l.termMonths)}" placeholder="例如 24" /></div>
    </div>
    <div class="two" style="margin-top:10px">
      <div class="field"><label>下次还款日</label><input name="nextPayDate" type="date" value="${esc(l.nextPayDate || '')}" /></div>
      <div class="field"><label>提前几天提醒</label><input name="remindDays" type="number" inputmode="numeric" min="0" max="30" value="${esc(l.remindDays)}" placeholder="默认 ${esc(state.settings.remindDays)}" /></div>
    </div>
    <div class="calc-preview" id="loanPreview"></div>
    <div class="field" style="margin-top:10px"><label>原始借款日期（选填）</label><input name="startDate" type="date" value="${esc(l.startDate || '')}" /></div>
    <div class="field"><label>备注</label><textarea name="note" rows="2">${esc(l.note)}</textarea></div>
  `, (d) => {
    if (!d.name) return toast('请填写贷款名称');
    const principal = round2(d.principal);
    if (!(principal > 0)) return toast('请填写贷款金额');
    const repaidBefore = d.repaidBefore === '' ? 0 : round2(d.repaidBefore);
    if (repaidBefore < 0 || repaidBefore > principal) return toast('以前已还金额不能大于贷款金额');
    const data = {
      name: d.name, lender: d.lender, principal, repaidBefore: repaidBefore || '',
      startDate: d.startDate || '', nextPayDate: d.nextPayDate || '',
      rate: d.rate === '' ? '' : Number(d.rate), termMonths: d.termMonths === '' ? '' : parseInt(d.termMonths, 10),
      method: d.method,
      remindDays: d.remindDays === '' ? '' : Math.max(0, parseInt(d.remindDays, 10) || 0), note: d.note
    };
    if (loan) Object.assign(loan, data);
    else { const nl = { id: uid(), createdAt: Date.now(), ...data }; state.loans.push(nl); view = { name: 'loan', loanId: nl.id }; }
    save(); closeSheet(); render(); toast(loan ? '已更新' : '已添加');
  });
  const form = $('#sheetBody');
  const pEl = form.querySelector('input[name=principal]');
  const rbEl = form.querySelector('input[name=repaidBefore]');
  const remEl = form.querySelector('input[name=remainingNow]');
  const preview = () => {
    const d = formData();
    const rem = round2(Math.max(0, (Number(d.principal) || 0) - (Number(d.repaidBefore) || 0)));
    const plan = schedule({ principal: d.principal, repaidBefore: d.repaidBefore, rate: d.rate, termMonths: d.termMonths, method: d.method, nextPayDate: d.nextPayDate, startDate: d.startDate });
    const el = $('#loanPreview');
    if (!el) return;
    if (!plan.length) { el.textContent = d.method === 'none' ? '无固定计划：只记录剩余金额和后续还款，不计算月供。' : '填写剩余期数和利率后，会按「现在还剩金额」自动计算接下来每月还多少。'; return; }
    const total = plan.reduce((a, p) => a + p.payment, 0), interest = plan.reduce((a, p) => a + p.interest, 0);
    el.innerHTML = d.method === 'equal_principal'
      ? `按剩余 ${fmt(rem)} 计算：下月还 <b>${fmt(plan[0].payment)}</b>，每月递减；后续利息 ${fmt(interest)}`
      : d.method === 'interest_first'
        ? `按剩余 ${fmt(rem)} 计算：每月付息 <b>${fmt(plan[0].payment)}</b>，最后一期还本金；后续利息 ${fmt(interest)}`
        : `按剩余 ${fmt(rem)} 计算：接下来每月还 <b>${fmt(plan[0].payment)}</b>；后续利息 ${fmt(interest)}，后续总还 ${fmt(total)}`;
  };
  form.oninput = (e) => {
    const p = Number(pEl.value) || 0;
    if (e.target === remEl) {
      const rem = Number(remEl.value);
      rbEl.value = remEl.value === '' ? '' : Math.max(0, round2(p - (isNaN(rem) ? 0 : rem)));
    } else if (e.target === pEl || e.target === rbEl) {
      const rb = Number(rbEl.value) || 0;
      remEl.value = pEl.value === '' ? '' : Math.max(0, round2(p - rb));
    }
    preview();
  };
  preview();
}

function recordForm(opts) {
  const r = opts.record || { type: opts.type || 'repay', loanId: opts.loanId || (state.loans[0] && state.loans[0].id), amount: '', interest: '', date: todayIso(), note: '' };
  if (!state.loans.length) { toast('请先添加一笔贷款'); return loanForm(); }
  // 自动带出下期应还金额
  if (!opts.record && r.type === 'repay' && r.loanId) {
    const l = state.loans.find((x) => x.id === r.loanId);
    const s = l && stats(l);
    if (s && s.next && s.next.amount) { r.amount = s.next.amount; const p = s.plan[s.paidPeriods]; if (p && Math.abs(p.payment - s.next.amount) < 0.01) r.interest = p.interest; }
  }
  openSheet(opts.record ? '编辑记录' : r.type === 'borrow' ? '新借一笔' : '记一笔还款', `
    <div class="seg">
      <label><input type="radio" name="type" value="repay" ${r.type !== 'borrow' ? 'checked' : ''}/>还款</label>
      <label class="borrow"><input type="radio" name="type" value="borrow" ${r.type === 'borrow' ? 'checked' : ''}/>新借</label>
    </div>
    <div class="field"><label>哪笔贷款</label><select name="loanId">
      ${state.loans.map((l) => `<option value="${l.id}" ${l.id === r.loanId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select></div>
    <div class="field"><label id="amtLabel">金额 *</label><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(r.amount)}" placeholder="0.00" /></div>
    <div class="field" id="interestField"><label>其中利息（选填）</label><input name="interest" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(r.interest)}" placeholder="0.00" />
      <div class="hint">填写后，剩余本金 = 贷款金额 − (还款 − 利息)</div></div>
    <div class="field"><label>日期</label><input name="date" type="date" value="${esc(r.date)}" /></div>
    <div class="field"><label>备注</label><input name="note" value="${esc(r.note)}" placeholder="选填" /></div>
    ${opts.record ? '<div class="btns"><button type="button" class="btn danger" data-action="delete-record" data-id="' + r.id + '">删除这条记录</button></div>' : ''}
  `, (d) => {
    const amount = round2(d.amount);
    if (!(amount > 0)) return toast('请填写金额');
    const interest = d.type === 'repay' ? round2(d.interest) : 0;
    if (interest > amount) return toast('利息不能大于还款金额');
    const data = { type: d.type, loanId: d.loanId, amount, interest, date: d.date || todayIso(), note: d.note };
    if (opts.record) Object.assign(opts.record, data);
    else state.records.push({ id: uid(), createdAt: Date.now(), ...data });
    save(); closeSheet(); render(); toast('已记录');
  });
  const sync = () => {
    const t = $('#sheetBody').querySelector('input[name=type]:checked').value;
    $('#interestField').classList.toggle('hidden', t === 'borrow');
    $('#amtLabel').textContent = t === 'borrow' ? '新借金额 *' : '还款金额 *';
  };
  $('#sheetBody').onchange = sync;
  sync();
}

/* ================= 导入导出 ================= */
async function shareOrDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

async function exportJson() {
  const ok = await shareOrDownload(`贷款记账备份-${todayIso()}.json`, JSON.stringify({ app: 'loan-ledger', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2), 'application/json');
  if (ok) { localStorage.setItem('lastBackup', new Date().toISOString()); if (view.name === 'settings') render(); toast('备份已导出'); }
}

function exportCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['贷款名称', '出借方', '类型', '金额', '其中利息', '日期', '备注'].join(',')];
  for (const l of state.loans) {
    lines.push([l.name, l.lender, '初始贷款', l.principal, '', l.startDate || '', l.note].map(q).join(','));
    if (Number(l.repaidBefore) > 0) {
      lines.push([l.name, l.lender, '以前已还', l.repaidBefore, '', '', '建账前累计已还'].map(q).join(','));
    }
    for (const r of [...recordsOf(l.id)].reverse()) {
      lines.push([l.name, l.lender, r.type === 'borrow' ? '新借' : '还款', r.amount, r.type === 'borrow' ? '' : r.interest || '', r.date, r.note].map(q).join(','));
    }
  }
  lines.push('');
  lines.push(['汇总', '', '', '', '', '', ''].map(q).join(','));
  for (const l of state.loans) {
    const s = stats(l);
    lines.push([l.name, `贷款金额 ${s.total}`, `已还 ${s.repaid}`, `新借 ${s.borrowed}`, `剩余 ${s.remaining}`, '', ''].map(q).join(','));
  }
  shareOrDownload(`贷款记账-${todayIso()}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || !Array.isArray(d.loans) || !Array.isArray(d.records)) throw new Error('bad');
      if (!confirm(`备份中有 ${d.loans.length} 笔贷款、${d.records.length} 条记录。\n恢复后会覆盖当前数据，确定吗？`)) return;
      state = normalize(d); save(); view = { name: 'home' }; render(); toast('恢复成功');
    } catch (e) { alert('文件格式不正确，请选择「贷款记账备份」导出的 .json 文件'); }
  };
  reader.readAsText(file);
}

function exportIcs(loan) {
  const s = stats(loan);
  const remind = loan.remindDays !== '' && loan.remindDays != null ? Number(loan.remindDays) : Number(state.settings.remindDays);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dt = (iso) => iso.replace(/-/g, '');
  const nextDay = (iso) => { const d = parseDate(iso); d.setDate(d.getDate() + 1); return dt(isoOf(d)); };
  const icsEsc = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const alarms = () => {
    const a = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:还款提醒', 'TRIGGER:PT9H', 'END:VALARM'];
    if (remind > 0) a.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:还款提醒', `TRIGGER:-P${remind - 1}DT15H`, 'END:VALARM');
    return a;
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//loan-ledger//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  let count = 0;
  if (s.plan.length) {
    s.plan.slice(s.paidPeriods).forEach((p) => {
      count++;
      lines.push('BEGIN:VEVENT', `UID:${loan.id}-${p.n}@loan-ledger`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${dt(p.date)}`, `DTEND;VALUE=DATE:${nextDay(p.date)}`,
        `SUMMARY:${icsEsc(`还款：${loan.name} 第${p.n}期 ¥${p.payment.toFixed(2)}`)}`,
        `DESCRIPTION:${icsEsc(`本金 ${p.principal.toFixed(2)}，利息 ${p.interest.toFixed(2)}`)}`, ...alarms(), 'END:VEVENT');
    });
  } else if (s.next) {
    count++;
    lines.push('BEGIN:VEVENT', `UID:${loan.id}-monthly@loan-ledger`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dt(s.next.date)}`, `DTEND;VALUE=DATE:${nextDay(s.next.date)}`,
      'RRULE:FREQ=MONTHLY', `SUMMARY:${icsEsc(`还款：${loan.name}`)}`, ...alarms(), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  if (!count) return toast('这笔贷款没有待还的还款日。请在「编辑贷款」中设置期数或每月还款日');
  shareOrDownload(`还款提醒-${loan.name}.ics`, lines.join('\r\n'), 'text/calendar');
}

/* ================= 事件 ================= */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { view = { name: tab.dataset.tab }; return render(); }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, type } = el.dataset;
  const loan = id && state.loans.find((l) => l.id === id);
  switch (action) {
    case 'back': view = { name: 'loans' }; render(); break;
    case 'close-sheet': closeSheet(); break;
    case 'quick-add':
      if (view.name === 'loans' || !state.loans.length) loanForm();
      else recordForm({ type: 'repay', loanId: view.name === 'loan' ? view.loanId : undefined });
      break;
    case 'add-loan': loanForm(); break;
    case 'edit-loan': loanForm(loan); break;
    case 'delete-loan':
      if (loan && confirm(`确定删除「${loan.name}」及它的所有记录吗？此操作不能撤销。`)) {
        state.loans = state.loans.filter((l) => l.id !== id);
        state.records = state.records.filter((r) => r.loanId !== id);
        save(); view = { name: 'loans' }; render(); toast('已删除');
      }
      break;
    case 'open-loan':
      if (e.target.closest('button') && e.target.closest('button') !== el) break;
      view = { name: 'loan', loanId: id }; render(); break;
    case 'add-record': e.stopPropagation(); recordForm({ type, loanId: id }); break;
    case 'edit-record': { const r = state.records.find((x) => x.id === id); if (r) recordForm({ record: r }); break; }
    case 'delete-record':
      if (confirm('确定删除这条记录吗？')) {
        state.records = state.records.filter((r) => r.id !== id);
        save(); closeSheet(); render(); toast('已删除');
      }
      break;
    case 'export-json': exportJson(); break;
    case 'import-json': $('#importFile').click(); break;
    case 'export-csv': exportCsv(); break;
    case 'export-ics': if (loan) exportIcs(loan); break;
    case 'hide-hint': localStorage.setItem('hideInstallHint', '1'); render(); break;
    case 'clear-all':
      if (confirm('确定清空所有数据吗？建议先导出备份。') && confirm('再次确认：清空后无法恢复！')) {
        state = emptyState(); save(); view = { name: 'home' }; render(); toast('已清空');
      }
      break;
  }
});
$('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importJson(f); e.target.value = ''; });

/* ================= 启动 ================= */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
render();
