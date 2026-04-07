// 自賠責レセプト自動処理 - メインロジック
'use strict';

// pdf.js worker設定
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const STORAGE_KEY = 'jibaiseki_payees';
const FONT_URL = 'fonts/NotoSansJP-Regular.otf';

let records = [];      // 解析済みレコード配列
let fontBytes = null;  // 日本語フォント (キャッシュ)

// ========== ユーティリティ ==========
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }

function loadPayees() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function savePayees(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function refreshPayeeOptions() {
  const payees = loadPayees();
  const sels = [$('#bulk-payee'), ...$$('select.payee-sel')];
  sels.forEach(sel => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">（選択）</option>' +
      payees.map(p => `<option value="${p}">${p}</option>`).join('');
    sel.value = cur;
  });
}

async function loadFont() {
  if (fontBytes) return fontBytes;
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error('フォント取得失敗');
  fontBytes = await res.arrayBuffer();
  return fontBytes;
}

// ========== PDFテキスト抽出 ==========
async function extractPdfData(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const allPagesItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height || 10
    }));
    allPagesItems.push(items);
  }

  // 患者ごとに分割: 「J9A2」を含むページが先頭
  const groups = []; // [{ pages: [pageNum...], items: [pageItems...] }]
  for (let i = 0; i < allPagesItems.length; i++) {
    const hasHeader = allPagesItems[i].some(it => it.str.includes('J9A2') || it.str.includes('J902'));
    if (hasHeader || groups.length === 0) {
      groups.push({ pageNums: [i], pagesItems: [allPagesItems[i]] });
    } else {
      const last = groups[groups.length - 1];
      last.pageNums.push(i);
      last.pagesItems.push(allPagesItems[i]);
    }
  }

  const records = [];
  for (const g of groups) {
    records.push(buildRecord(file, buf, g));
  }
  return records;
}

function buildRecord(file, buf, group) {
  const items = group.pagesItems[0];
  const fullText = items.map(i => i.str).join('\n');

  // パース
  const data = {
    fileName: file.name,
    originalBytes: buf,
    pageNums: group.pageNums,
    items,
    pagesItems: group.pagesItems,
    name: '',
    period: '',
    days: 0,
    points: 0,    // ㋑
    smallSum: 0,  // ㋩
    B: 0,
    D_other: 0,  // ニ
    ho_count: 0, ho_amount: 0,  // 診断書料
    he_count: 0, he_amount: 0,  // 明細書料
    payee: '',
    date: ''
  };

  // 氏名: 「氏名」のすぐ後ろの非数値・非記号テキスト
  const nameIdx = items.findIndex(i => i.str.includes('氏'));
  if (nameIdx >= 0) {
    for (let k = nameIdx + 1; k < Math.min(nameIdx + 8, items.length); k++) {
      const s = items[k].str.trim();
      if (s && s !== '名' && !/^\d/.test(s) && !/年|月|男|女|才/.test(s)) {
        data.name = s; break;
      }
    }
  }

  // 診療期間
  const periodMatch = fullText.match(/自令和\s*(\d+)\s*年\s*(\d+)\s*月/);
  if (periodMatch) data.period = `R${periodMatch[1]}/${periodMatch[2]}`;

  // 診療実日数
  const daysMatch = fullText.match(/診療実日数[\s\S]{0,30}?(\d+)\s*日/);
  if (daysMatch) data.days = parseInt(daysMatch[1]);

  // 技術点数 ㋑ (10〜80点数計の右の数値) - ラベル「点数計」付近の最大数値
  const tenMatch = fullText.match(/(\d{1,3}(?:,\d{3})*|\d+)\s*点/g);
  // より確実: 「3,363 点」のような形を探す
  const ptMatches = [...fullText.matchAll(/([\d,]+)\s*点/g)]
    .map(m => parseInt(m[1].replace(/,/g, '')))
    .filter(n => n > 0);
  if (ptMatches.length) data.points = Math.max(...ptMatches);

  // ㋩ = 右側 10小計 (円).
  // テキスト全体から「10小計 ... 数値 円」パターンを探す
  const m = fullText.match(/10小計[\s\S]{0,60}?([\d,]+)\s*円/);
  if (m) data.smallSum = parseInt(m[1].replace(/,/g, ''));
  // フォールバック: テキスト全体検索
  if (!data.smallSum) {
    const m = fullText.match(/10小計\s*(\d{1,5})/);
    if (m) data.smallSum = parseInt(m[1]);
  }

  return data;
}

// ========== 計算 ==========
function calc(r) {
  const A = r.points * 20;
  const C = Math.round((r.smallSum || 0) * 1.2);
  const ho = (r.ho_count || 0) * 6500;
  const he = (r.he_count || 0) * 3300;
  r.ho_amount = ho;
  r.he_amount = he;
  const D = (r.D_other || 0) + ho + he;
  const total = A + (r.B || 0) + C + D;
  return { A, C, D, total };
}

function updateRowCalc(i) {
  const r = records[i];
  const { D, total } = calc(r);
  const row = document.querySelector(`#recept-table tbody tr:nth-child(${i + 1})`);
  if (!row) return;
  row.children[10].textContent = (r.ho_count * 6500).toLocaleString();
  row.children[12].textContent = (r.he_count * 3300).toLocaleString();
  row.children[13].textContent = D.toLocaleString();
  row.children[14].textContent = total.toLocaleString();
}

// ========== テーブル描画 ==========
function renderTable() {
  const tbody = $('#recept-table tbody');
  tbody.innerHTML = '';
  records.forEach((r, idx) => {
    const { A, C, D, total } = calc(r);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td style="text-align:left">${r.name || '?'}</td>
      <td>${r.period}</td>
      <td>${r.days}</td>
      <td>${r.points.toLocaleString()}</td>
      <td class="auto">${A.toLocaleString()}</td>
      <td>${r.smallSum.toLocaleString()}</td>
      <td class="auto">${C.toLocaleString()}</td>
      <td><input type="number" data-i="${idx}" data-f="D_other" value="${r.D_other || ''}" placeholder="0"></td>
      <td><input type="number" data-i="${idx}" data-f="ho_count" value="${r.ho_count || ''}" placeholder="0" style="width:40px"></td>
      <td class="auto">${(r.ho_count * 6500).toLocaleString()}</td>
      <td><input type="number" data-i="${idx}" data-f="he_count" value="${r.he_count || ''}" placeholder="0" style="width:40px"></td>
      <td class="auto">${(r.he_count * 3300).toLocaleString()}</td>
      <td class="auto">${D.toLocaleString()}</td>
      <td class="total">${total.toLocaleString()}</td>
      <td><select class="payee-sel" data-i="${idx}" data-f="payee"></select></td>
      <td><input type="date" class="wide" data-i="${idx}" data-f="date" value="${r.date}"></td>
    `;
    tbody.appendChild(tr);
  });
  refreshPayeeOptions();
  // 既存値を復元
  records.forEach((r, idx) => {
    const sel = document.querySelector(`select.payee-sel[data-i="${idx}"]`);
    if (sel) sel.value = r.payee || '';
  });
  // イベント
  $$('#recept-table input, #recept-table select').forEach(el => {
    el.addEventListener('input', e => {
      const i = +e.target.dataset.i, f = e.target.dataset.f;
      const v = e.target.type === 'number' ? (+e.target.value || 0) : e.target.value;
      records[i][f] = v;
      if (e.target.type === 'number') updateRowCalc(i);
    });
  });
  $('#count').textContent = `(${records.length}件)`;
}

// ========== ファイル読込 ==========
async function handleFiles(files) {
  const pdfs = [...files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return;
  $('#status').textContent = `読込中... (0/${pdfs.length})`;
  records = [];
  for (let i = 0; i < pdfs.length; i++) {
    try {
      const rs = await extractPdfData(pdfs[i]);
      records.push(...rs);
    } catch (e) {
      console.error(pdfs[i].name, e);
    }
    $('#status').textContent = `読込中... (${i + 1}/${pdfs.length})`;
  }
  $('#status').textContent = `${records.length}件読み込み完了`;
  $('#bulk-controls').style.display = '';
  $('#table-section').style.display = '';
  renderTable();
}

// ========== PDF修正 ==========
async function generateFixedPdf(r) {
  const { PDFDocument, rgb } = PDFLib;
  const srcDoc = await PDFDocument.load(r.originalBytes.slice(0));
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const font = await newDoc.embedFont(await loadFont(), { subset: true });
  // 該当ページだけコピー
  const copied = await newDoc.copyPages(srcDoc, r.pageNums);
  copied.forEach(p => newDoc.addPage(p));
  const pages = newDoc.getPages();
  const { A, C, D, total } = calc(r);
  for (let pi = 0; pi < pages.length; pi++) {
    applyFixesToPage(pages[pi], r.pagesItems[pi] || [], r, { A, C, D, total }, font, rgb);
  }
  return await newDoc.save();
}

function applyFixesToPage(page, items, r, calcResult, font, rgb) {
  const { A, C, D, total } = calcResult;
  const draw = (text, x, y, size = 9) => {
    page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
  };
  const whiteOut = (x, y, w, h) => {
    // 下方向にだけ少し拡張（descender対策）、罫線にかからないように上は拡張しない
    page.drawRectangle({ x: x - 0.3, y: y - 1.5, width: w + 0.6, height: h + 1, color: rgb(1, 1, 1) });
  };
  const findItem = (pred) => items.find(pred);

  // 1. J9A2 → J902
  const j = findItem(i => i.str.includes('J9A2'));
  if (j) {
    whiteOut(j.x, j.y, j.w, j.h);
    draw('J902', j.x, j.y, j.h);
  }

  // 2. A（㋑×単価×1.2） → A（㋑×単価×2.0）
  // 「1.2」を含むアイテムを全て取得し、同じ行のCラベルと区別
  // Aは「単価」を含む or 行内最左の1.2
  const re12 = /[1１][．.\u30fb][2２]/;
  const all12 = items.filter(i => re12.test(i.str));
  // 単価を含むものが第一候補
  let a12Targets = all12.filter(i => i.str.includes('単価'));
  if (a12Targets.length === 0 && all12.length >= 1) {
    // 同じ行 (yが近い) でグループ化し、各行の左端を採用
    const rows = {};
    all12.forEach(i => {
      const key = Math.round(i.y);
      (rows[key] = rows[key] || []).push(i);
    });
    Object.values(rows).forEach(row => {
      row.sort((a, b) => a.x - b.x);
      a12Targets.push(row[0]); // Aは左、Cは右
    });
  }
  for (const a12 of a12Targets) {
    whiteOut(a12.x, a12.y, a12.w, a12.h);
    draw(a12.str.replace(re12, '2.0'), a12.x, a12.y, a12.h);
  }

  // 3. 請求額計算行 (A,B,C,D,合計の金額)
  // ラベル行: "請求額" or "の計算" を探し、その直下の数値5つを置換
  const reqLabel = findItem(i => i.str.includes('請求額')) || findItem(i => i.str.includes('の計算'));
  if (reqLabel) {
    // ラベル行のy座標 (請求額/の計算が縦書き2行構成のことあり、y範囲広めに)
    // 数値行: ラベルy より下、35 unit以内、円や数字を含む
    const moneyRow = items.filter(i =>
      i.y < reqLabel.y + 5 && i.y > reqLabel.y - 35 &&
      i.x > reqLabel.x + 20 &&
      (/^[\d,]+$/.test(i.str.trim()) || i.str.trim() === '円')
    );
    // y座標でクラスタリング (1行のはず)
    if (moneyRow.length) {
      // 同じy(±2)のものに絞る - 円と数字が交互に並ぶ
      const ys = moneyRow.map(i => i.y);
      const targetY = ys.sort((a, b) => b - a)[0];
      const sameRow = moneyRow.filter(i => Math.abs(i.y - targetY) < 3)
        .sort((a, b) => a.x - b.x);
      // 数字だけ抽出 (5個: A,B,C,D,合計)
      const nums = sameRow.filter(i => /^[\d,]+$/.test(i.str.trim()));
      // 既存数字を白塗り
      sameRow.forEach(it => whiteOut(it.x, it.y, it.w, it.h));
      // 5列の中央x座標を計算 - 既存数字位置から
      const yens = sameRow.filter(i => i.str.trim() === '円');
      // 元の各「数字 円」ペアの位置に新数字を描画
      // nums と yens を順に対応させる
      const values = [A, r.B || 0, C, D, total];
      const labels = ['A', 'B', 'C', 'D', '合計'];
      for (let k = 0; k < Math.min(5, yens.length); k++) {
        const v = values[k];
        if (v === 0 && k !== 4 && k !== 0) {
          // 0は描画しない (Bが空欄なら空のまま)
          draw('円', yens[k].x, yens[k].y, yens[k].h);
          continue;
        }
        // 数字を円の左に描画
        const numStr = v.toLocaleString();
        const numW = numStr.length * 5;
        draw(numStr, yens[k].x - numW - 2, yens[k].y, yens[k].h);
        draw('円', yens[k].x, yens[k].y, yens[k].h);
      }
    }
  }

  // 同じ行(±2)・指定x範囲のアイテムを取得
  const sameRow = (label) => items.filter(i => Math.abs(i.y - label.y) < 3 && i.x > label.x);

  // 4. 診断書料 (ホ) - 同行の「通」「円」を見つけて、その左側に描画
  const hoLabel = findItem(i => i.str.includes('診断書料'));
  if (hoLabel && r.ho_count) {
    const row = sameRow(hoLabel);
    const tsu = row.find(i => i.str.trim() === '通');
    const yen = row.find(i => i.str.trim() === '円');
    if (tsu) draw(String(r.ho_count), tsu.x - 12, hoLabel.y, hoLabel.h);
    const amt = (r.ho_count * 6500).toLocaleString();
    if (yen) draw(amt, yen.x - amt.length * 6 - 2, hoLabel.y, hoLabel.h);
    else if (tsu) draw(amt, tsu.x + 15, hoLabel.y, hoLabel.h);
  }
  // 5. 明細書料 (ヘ)
  const heLabel = findItem(i => i.str.includes('明細書料'));
  if (heLabel && r.he_count) {
    const row = sameRow(heLabel);
    const tsu = row.find(i => i.str.trim() === '通');
    const yen = row.find(i => i.str.trim() === '円');
    if (tsu) draw(String(r.he_count), tsu.x - 12, heLabel.y, heLabel.h);
    const amt = (r.he_count * 3300).toLocaleString();
    if (yen) draw(amt, yen.x - amt.length * 6 - 2, heLabel.y, heLabel.h);
    else if (tsu) draw(amt, tsu.x + 15, heLabel.y, heLabel.h);
  }

  // 6. 上記金額・請求先・日付 (左下)
  const kingakuLabel = findItem(i => i.str.includes('上記金額'));
  if (kingakuLabel) {
    draw(total.toLocaleString(), kingakuLabel.x + 50, kingakuLabel.y, kingakuLabel.h);
    if (r.payee) {
      const rowItems = items.filter(i => Math.abs(i.y - kingakuLabel.y) < 5);
      const wo = rowItems.find(i => i.str.includes('を'));
      const tono = rowItems.find(i => i.str.includes('殿'));
      const leftX = wo ? (wo.x + (wo.w || 8) + 4) : (kingakuLabel.x + 60);
      const rightX = tono ? (tono.x - 2) : (kingakuLabel.x + 260);
      const gap = Math.max(40, rightX - leftX);
      let size = 9;
      const charW = size * 1.0;
      if (r.payee.length * charW > gap) {
        size = Math.max(5, gap / r.payee.length);
      }
      const w = r.payee.length * size;
      const px = leftX + (gap - w) / 2;
      draw(r.payee, px, kingakuLabel.y, size);
    }
  }
  if (r.date && kingakuLabel) {
    const [yy, mm, dd] = r.date.split('-');
    const reiwa = parseInt(yy) - 2018;
    // 上記金額の下にある「年　月　日」行を探す
    // 単独の「年」「月」「日」アイテムで、かつ kingakuLabel より下にある最初のセット
    const belowItems = items.filter(i => i.y < kingakuLabel.y && i.y > kingakuLabel.y - 40);
    const yItem = belowItems.find(i => i.str.trim() === '年');
    const mItem = belowItems.find(i => i.str.trim() === '月');
    const dItem = belowItems.find(i => i.str.trim() === '日');
    if (yItem && mItem && dItem) {
      draw(`令和${reiwa}`, yItem.x - 24, yItem.y, yItem.h);
      draw(String(parseInt(mm)), mItem.x - 12, mItem.y, mItem.h);
      draw(String(parseInt(dd)), dItem.x - 12, dItem.y, dItem.h);
    } else {
      draw(`${reiwa}年 ${parseInt(mm)}月 ${parseInt(dd)}日`, kingakuLabel.x + 30, kingakuLabel.y - 22, 9);
    }
  }
}

// ========== ZIP生成 ==========
async function generateAll() {
  if (!records.length) return;
  $('#generate-btn').disabled = true;
  $('#status').textContent = 'PDF生成中...';
  const { PDFDocument } = PDFLib;
  const merged = await PDFDocument.create();
  let okCount = 0;
  const errors = [];
  for (let i = 0; i < records.length; i++) {
    try {
      const bytes = await generateFixedPdf(records[i]);
      const sub = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(sub, sub.getPageIndices());
      copied.forEach(p => merged.addPage(p));
      okCount++;
    } catch (e) {
      console.error(records[i].fileName, e);
      errors.push(`${records[i].fileName}: ${e.message}`);
    }
    $('#status').textContent = `PDF生成中... (${i + 1}/${records.length})`;
  }
  if (errors.length) {
    alert(`エラー ${errors.length}件:\n` + errors.slice(0, 5).join('\n'));
  }
  if (okCount === 0) {
    $('#status').textContent = `失敗: ${errors[0] || '不明なエラー'}`;
    $('#generate-btn').disabled = false;
    return;
  }
  const out = await merged.save();
  const blob = new Blob([out], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `自賠責修正済_${new Date().toISOString().slice(0, 10)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
  $('#status').textContent = `完了 (${okCount}件)`;
  $('#generate-btn').disabled = false;
}

// ========== イベント設定 ==========
window.addEventListener('DOMContentLoaded', () => {
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(e => dz.addEventListener(e, ev => {
    ev.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(e => dz.addEventListener(e, ev => {
    ev.preventDefault(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', ev => handleFiles(ev.dataTransfer.files));
  $('#file-input').addEventListener('change', ev => handleFiles(ev.target.files));

  refreshPayeeOptions();

  $('#add-payee').addEventListener('click', () => {
    const v = $('#new-payee').value.trim();
    if (!v) return;
    const list = loadPayees();
    if (!list.includes(v)) { list.push(v); savePayees(list); }
    $('#new-payee').value = '';
    refreshPayeeOptions();
  });

  $('#apply-payee').addEventListener('click', () => {
    const v = $('#bulk-payee').value;
    if (!v) return;
    records.forEach(r => r.payee = v);
    renderTable();
  });

  $('#apply-date').addEventListener('click', () => {
    const v = $('#bulk-date').value;
    if (!v) return;
    records.forEach(r => r.date = v);
    renderTable();
  });

  $('#generate-btn').addEventListener('click', generateAll);
});
