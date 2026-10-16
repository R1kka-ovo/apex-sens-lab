#!/usr/bin/env node
/*
 * 校验「Apex 灵敏度实验台」导出的测试记录（.json）。
 *
 * 用法：
 *   node tools/validate-snapshot.js <记录文件.json> [--json]
 *
 * 只依赖 Node 内置模块，不需要 npm install。
 * 退出码：0 = 通过（可能有警告）、1 = 失败。
 *
 * 校验分两层：
 *   1) 格式层 —— 文件是不是本工具导出的、结构是否完整、能不能还原
 *   2) 量纲层 —— 结论是否落在物理合理区间（cm/360 是否像人用的），
 *                 以及「起点被夹取」等已知会导致结论失真的迹象
 */

'use strict';
const fs = require('fs');
const path = require('path');

const DEG_PER_COUNT = 0.022;
const CM_LO = 8, CM_HI = 120;          /* cm/360 的「常见」区间，仅作参考提示，不判失败 */
const SENS_LO = 0.02, SENS_HI = 25;    /* 工具可用的游戏内灵敏度范围（与 DPI 无关） */
const SCHEMA_EXPECT = 1;

const errors = [];
const warnings = [];
const info = [];
const err = m => errors.push(m);
const warn = m => warnings.push(m);
const note = m => info.push(m);

function fail(msg){
  console.error(msg);
  process.exit(2);
}

/* ---------------- 读取 ---------------- */
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const asJson = argv.includes('--json');
if (!file) fail('用法：node tools/validate-snapshot.js <记录文件.json> [--json]');
if (!fs.existsSync(file)) fail('找不到文件：' + file);

let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { fail('读取失败：' + e.message); }

let snap;
try { snap = JSON.parse(raw); }
catch (e) { fail('不是合法的 JSON：' + e.message); }

/* ---------------- 1. 格式层 ---------------- */
if (snap.app !== 'apex-sens-lab'){
  err('这不是本工具导出的记录（缺少 app:"apex-sens-lab" 标记）。请用结果页的「导出测试记录」按钮导出的文件。');
}
if (snap.schema !== SCHEMA_EXPECT){
  if (typeof snap.schema === 'number' && snap.schema > SCHEMA_EXPECT){
    err(`记录格式版本为 ${snap.schema}，比本校验脚本认识的 v${SCHEMA_EXPECT} 更新，请更新校验脚本。`);
  } else {
    warn(`记录格式版本为 ${snap.schema}（期望 v${SCHEMA_EXPECT}），可能来自旧版本。`);
  }
}

const cands = Array.isArray(snap.cands) ? snap.cands : null;
if (!cands) err('缺少 cands 数组（候选灵敏度列表）。');
else if (!cands.length) err('cands 为空：这份记录里没有测过任何候选值。');

if (cands && cands.length){
  const badV = cands.filter(c => !Number.isFinite(c && c.v) || c.v <= 0);
  if (badV.length) err(`有 ${badV.length} 个候选值不是正数。`);
  const measured = cands.filter(c => Array.isArray(c.blocks) && c.blocks.length);
  if (!measured.length) warn('所有候选值都没有实测段落（blocks 全空），这份记录无法参与比较。');
  note(`候选值 ${cands.length} 个，其中有实测数据的 ${measured.length} 个`);
}

if (!snap.track || typeof snap.track !== 'object') err('缺少 track 对象。');
if (!snap.cfg || typeof snap.cfg !== 'object') warn('缺少 cfg（当时的配置），无法核对 DPI / FOV。');
if (!Number.isFinite(snap.baseSens)) warn('缺少 baseSens（起始灵敏度）。');
if (!Array.isArray(snap.duelLog)) warn('缺少 duelLog（对决记录），无法复核结论的配对依据。');
else {
  const mains = snap.duelLog.filter(d => d && (d.main || d.deepen));
  note(`对决记录 ${snap.duelLog.length} 组，其中决胜/深化 ${mains.length} 组`);
  if (!mains.length) warn('没有决胜/深化对决记录，结论可能只基于搜索阶段。');
}

/* ---------------- 2. 量纲层 ---------------- */
const t = snap.track || {};
const rec = Number.isFinite(t.rec) ? t.rec : null;
const dpi = (snap.cfg && Number.isFinite(snap.cfg.dpi)) ? snap.cfg.dpi : null;

if (rec !== null && dpi){
  if (rec <= 0) err('推荐值不是正数。');
  else {
    const cm = 360 * 2.54 / (DEG_PER_COUNT * dpi * rec);
    note(`推荐值 ${rec} @ DPI ${dpi} → eDPI ${Math.round(dpi*rec)}，cm/360 ≈ ${cm.toFixed(2)} cm`);
    /* cm/360 的「常见区间」只作为参考提示，不作为错误。
       注意：高 DPI 玩家用小数值灵敏度是完全正常的（2400 DPI × 灵敏度 5 的
       eDPI 是 12000、cm/360 只有 3.5 cm），所以这里不会据此判失败。
       真正值得怀疑的是「灵敏度值本身」是否落在固定可用范围内。 */
    if (cm < CM_LO){
      warn(`cm/360 只有 ${cm.toFixed(1)} cm，比常见范围（${CM_LO}~${CM_HI} cm）更快。`
        + `高 DPI 玩家这样设置是正常的；但如果这不是你的预期，请核对 DPI 与「当前灵敏度」。`);
    } else if (cm > CM_HI){
      warn(`cm/360 达到 ${cm.toFixed(1)} cm，比常见范围（${CM_LO}~${CM_HI} cm）更慢。请核对 DPI 与「当前灵敏度」。`);
    }
  }
} else if (rec !== null){
  warn('缺少 DPI（cfg.dpi），无法换算 cm/360 做合理性检查。');
}

/* 灵敏度值本身是否在工具的可用范围内（这是硬性的，与 DPI 无关） */
if (rec !== null){
  if (rec < SENS_LO || rec > SENS_HI){
    warn(`推荐值 ${rec} 落在工具可用灵敏度范围 ${SENS_LO} ~ ${SENS_HI} 之外，这份记录可能来自旧版本（旧版本的上下限是按 DPI 反推的，会挡住高 DPI 玩家）。建议用最新版本重测。`);
  } else note(`推荐值在可用灵敏度范围内（${SENS_LO} ~ ${SENS_HI}）`);
}

/* 区间是否包含推荐值、是否单调 */
if (Array.isArray(t.interval) && t.interval.length === 2){
  const [a, b] = t.interval;
  if (!Number.isFinite(a) || !Number.isFinite(b)) warn('interval 含非数字。');
  else if (a > b) warn('interval 的下界大于上界（顺序异常）。');
  else if (rec !== null && (rec < a - 1e-9 || rec > b + 1e-9)){
    warn(`推荐值 ${rec} 不在不可分辨区间 [${a}, ${b}] 内，请核对。`);
  } else note(`不可分辨区间 [${a}, ${b}]`);
} else warn('缺少 interval（不可分辨区间）。');

/* 起点是否被夹取：对比用户填的值与最终使用值 */
const startRaw = (snap.cfg && Number.isFinite(snap.cfg.startSensRaw)) ? snap.cfg.startSensRaw : null;
const baseSens = Number.isFinite(snap.baseSens) ? snap.baseSens : null;
if (startRaw !== null && baseSens !== null && Math.abs(startRaw - baseSens) > 1e-9){
  warn(`「当前灵敏度」填的 ${startRaw} 被夹取为 ${baseSens}（超出合理范围）。修复后的版本已不受起点影响，但这份记录若来自旧版本，结论可能落在错误区域，建议重测。`);
}

/* 结论贴到边界：搜索被挤到合理范围的边缘，通常是「起点猜偏 + 搜索窗被框住」的典型特征 */
const bLo = (snap.bounds && Number.isFinite(snap.bounds.lo)) ? snap.bounds.lo : null;
const bHi = (snap.bounds && Number.isFinite(snap.bounds.hi)) ? snap.bounds.hi : null;
if (rec !== null && bLo !== null && bHi !== null){
  if (Math.abs(rec - bHi) < 1e-6){
    warn(`推荐值 ${rec} 正好等于合理范围上限 ${bHi}（bounds.hi）。这是「结论被挤到边界」的特征，常见于旧版本中起点被夹取的情形 —— 建议重测。`);
  } else if (Math.abs(rec - bLo) < 1e-6){
    warn(`推荐值 ${rec} 正好等于合理范围下限 ${bLo}（bounds.lo）。这是「结论被挤到边界」的特征 —— 建议核对 DPI 与起始灵敏度后重测。`);
  }
}

/* 深化轮数 / 疲劳 */
if (Number.isFinite(t.deepenCount) && t.deepenCount > 0) note(`自动深化 ${t.deepenCount} 轮`);
if (t.fatigued) warn('记录里带有疲劳标记（fatigued），结论可能受状态影响。');
if (t.deepStopped) note('深化因疲劳提前停止');

/* 锚点：状态漂移是否过大 */
if (Array.isArray(t.anchors) && t.anchors.length >= 2){
  const ss = t.anchors.map(a => a && a.s).filter(Number.isFinite);
  if (ss.length >= 2){
    const spread = Math.max(...ss) - Math.min(...ss);
    note(`状态锚点 ${ss.length} 个，分数跨度 ${spread.toFixed(1)} 分`);
    if (spread > 35) warn(`锚点分数跨度 ${spread.toFixed(1)} 分偏大，说明测试期间状态波动明显，结论噪声会偏大。`);
  }
}

/* ---------------- 输出 ---------------- */
const ok = errors.length === 0;
if (asJson){
  console.log(JSON.stringify({ ok, errors, warnings, info, file: path.basename(file) }, null, 2));
} else {
  console.log('文件：' + file);
  if (info.length){ console.log('\n读数：'); info.forEach(m => console.log('  · ' + m)); }
  if (warnings.length){ console.log('\n警告：'); warnings.forEach(m => console.log('  ! ' + m)); }
  if (errors.length){ console.log('\n错误：'); errors.forEach(m => console.log('  × ' + m)); }
  console.log('\n结论：' + (ok ? (warnings.length ? '通过（有警告）' : '通过') : '未通过'));
}
process.exit(ok ? 0 : 1);
