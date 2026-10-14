#!/usr/bin/env node
/*
 * 在 GitHub Actions 里使用：从 issue / PR 正文里找出附件链接，
 * 下载后用 tools/validate-snapshot.js 校验，把结果写进 GITHUB_OUTPUT 的 report。
 *
 * 本地用不到这个脚本（程序里点「反馈这份数据」不会调它）。
 * 只依赖 Node 内置模块 + 系统 curl（ubuntu-latest 自带）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const body = process.env.BODY || '';

/* GitHub 附件链接形如：
   https://github.com/user-attachments/files/1234567/apex-sens-2026.json
   markdown 里通常是 [name](url) 或裸链 */
const urls = [];
for (const m of body.matchAll(/https:\/\/github\.com\/user-attachments\/[^\s)>"']+/g)) urls.push(m[0]);
for (const m of body.matchAll(/\((https:\/\/[^\s)]+\.json)\)/g)) urls.push(m[1]);
const list = [...new Set(urls)];

function emitReport(text){
  const out = process.env.GITHUB_OUTPUT;
  if (!out) { console.log(text); return; }
  fs.appendFileSync(out, 'report<<__REPORT_EOF__\n' + text + '\n__REPORT_EOF__\n');
}

console.log('找到候选附件链接 ' + list.length + ' 个');
if (!list.length){
  emitReport('');
  process.exit(0);
}

fs.mkdirSync('incoming', { recursive: true });
const parts = [];
let i = 0;

for (const url of list){
  i++;
  const base = (url.split('?')[0].split('/').pop() || ('rec-' + i + '.json')).replace(/[^\w.\-]/g, '_');
  const file = path.join('incoming', i + '-' + base);
  process.stdout.write('下载 ' + url + ' → ' + file + ' ... ');
  try {
    execFileSync('curl', ['-sSL', '--fail', '--max-time', '60', '-o', file, url], { stdio: 'pipe' });
  } catch (e){
    console.log('失败');
    parts.push('### 记录 ' + i + '\n\n下载失败，请确认附件是否已上传成功（链接：' + url + '）');
    continue;
  }
  const size = fs.statSync(file).size;
  console.log('OK (' + size + ' 字节)');

  let out = '', rc = 0;
  try {
    out = execFileSync('node', ['tools/validate-snapshot.js', file], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e){
    rc = (e && typeof e.status === 'number') ? e.status : 1;
    out = ((e && e.stdout) || '') + ((e && e.stderr) || '');
  }
  console.log(out);

  /* 正文里的 .json 链接不一定是本工具的记录；JSON 解析失败会以 exit=2 结束 */
  let head;
  if (rc === 2) head = '不是本工具导出的记录（无法解析为 JSON），已跳过。';
  else head = (rc === 0) ? '通过 ✅' : '未通过 ❌';

  parts.push('### 记录 ' + i + '：' + head + '\n\n```\n' + out.trim() + '\n```');
}

emitReport(parts.join('\n\n'));
