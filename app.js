// 自賠責レセプト自動処理 - メインロジック
'use strict';

// pdf.js worker設定
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const STORAGE_KEY = 'jibaiseki_payees';
const FONT_URL = 'fonts/NotoSansJP-Regular.otf';

const HO_FEE = 6500;  // 診断書料 (1通)
const HE_FEE = 3300;  // 明細書料 (1通)
const TANKA  = 20;    // 自賠責 1点単価 (円)

let records = [];      // 解析済みレコード配列
let fontBytes = null;  // 日本語フォント (キャッシュ)

// ========== ユーティリティ ==========
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }
function norm(s) { return String(s).replace(/\s+/g, ''); }
function num(s) { return parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0; }

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

// フォント読込
// サーバー経由(Vercel/起動.bat)なら fetch。index.htmlを直接開いた場合は
// fetchがブラウザに遮断されるので、そのときだけ埋め込みbase64を読み込む。
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(src + ' の読込に失敗'));
    document.head.appendChild(s);
  });
}
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
async function loadFont() {
  if (fontBytes) return fontBytes;
  try {
    const res = await fetch(FONT_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fontBytes = await res.arrayBuffer();
    return fontBytes;
  } catch (e) {
    // file:// で開いた場合のフォールバック
    if (!window.NOTO_SANS_JP_B64) await loadScript('fonts/font-base64.js');
    if (!window.NOTO_SANS_JP_B64) throw new Error('フォント取得失敗');
    fontBytes = b64ToArrayBuffer(window.NOTO_SANS_JP_B64);
    return fontBytes;
  }
}

// ========== 行(row)ユーティリティ ==========
// 同じ高さ(y)のテキストアイテムを1行にまとめる。返り値は上から下の順。
function rowsOf(items, tol = 2.2) {
  const rows = [];
  for (const it of items) {
    let r = rows.find(r => Math.abs(r.y - it.y) < tol);
    if (!r) { r = { y: it.y, items: [] }; rows.push(r); }
    r.items.push(it);
  }
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  rows.sort((a, b) => b.y - a.y);
  return rows;
}
function rowText(r) { return norm(r.items.map(i => i.str).join('')); }

// J902(健保準拠様式)の右下「請求額」ブロックを構造的に特定する。
// 総請求額の行を起点に、その上の数行(小計/その他/明細書料/診断書料…)を拾う。
function billBlock(items) {
  const right = items.filter(i => i.x > 321);
  const rows = rowsOf(right, 2.2);
  const total = rows.find(r => /総請求額/.test(rowText(r)));
  if (!total) return null;
  // 右端に「円」があり、総請求額行から上に120pt以内の行だけを対象にする
  const block = rows.filter(r =>
    r.y >= total.y - 3 && r.y <= total.y + 120 && r.items.some(isYenCell)
  );
  const find = (re) => block.find(r => re.test(rowText(r)));
  const subs = block.filter(r => /小計/.test(rowText(r)) && r.y > total.y)
    .sort((a, b) => a.y - b.y);
  return {
    total,
    ho: find(/診断書料/),
    he: find(/明細書料/),
    other: block.find(r => /その他/.test(rowText(r))),
    sub: subs[0] || null   // 総請求額のすぐ上の「小計」= 諸費用の小計
  };
}
// pdf.jsが「28,880」と「円」を1アイテムに結合する場合があるため、
// 「円を含むセル」「数字を含むセル」で別々に探す（同一アイテムのこともある）。
// 結合時は左端が寄るので、判定は右端(x+w)で行う。
const isYenCell = (i) => i.str.includes('円') && (i.x + (i.w || 0)) > 545;
const yenOf = (r) => r && r.items.find(isYenCell);
const tsuOf = (r) => r && r.items.find(i => i.str.trim().startsWith('通'));
const amtOf = (r) => r && r.items.find(i => /\d/.test(i.str) && i.x > 400);

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

  // 患者ごとに分割: レセプト番号「(12)[234643]」が同じページは同一患者
  // (摘要が溢れた続きページにも同じ番号が入る)
  const groups = [];
  let lastNo = null;
  for (let i = 0; i < allPagesItems.length; i++) {
    const t = norm(allPagesItems[i].map(x => x.str).join(''));
    const m = t.match(/\((\d+)\)\[(\d+)\]/);
    const no = m ? m[0] : null;
    if (no && no === lastNo && groups.length) {
      const last = groups[groups.length - 1];
      last.pageNums.push(i);
      last.pagesItems.push(allPagesItems[i]);
    } else {
      groups.push({ receiptNo: no, pageNums: [i], pagesItems: [allPagesItems[i]] });
      lastNo = no;
    }
  }

  const out = [];
  for (const g of groups) out.push(buildRecord(file, buf, g));
  return out;
}

function buildRecord(file, buf, group) {
  const items = group.pagesItems[0];
  const fullText = items.map(i => i.str).join('\n');
  const flat = norm(fullText);

  const data = {
    fileName: file.name,
    originalBytes: buf,
    receiptNo: group.receiptNo || '',
    pageNums: group.pageNums,
    items,
    pagesItems: group.pagesItems,
    form: flat.includes('J9A2') ? 'J9A2' : 'J902',
    name: '',
    period: '',
    days: 0,
    points: 0,      // J9A2: ㋑技術点数 / J902: 合計点数
    smallSum: 0,    // J9A2: ㋩ (10小計 円)
    B: 0,
    baseTotal: 0,   // 諸費用を除く請求額
    tanka: 0,       // J902: ※1点単価
    D_other: 0,     // ニ その他
    ho_count: 1, ho_amount: 0,  // 診断書料 (既定1通)
    he_count: 1, he_amount: 0,  // 明細書料 (既定1通)
    payee: '',
    date: '',
    warn: ''
  };

  // 氏名: 「氏名」のすぐ後ろの非数値・非記号テキストを結合（フルネーム）
  const nameIdx = items.findIndex(i => i.str.includes('氏'));
  if (nameIdx >= 0) {
    const nameParts = [];
    let refY = null;
    for (let k = nameIdx + 1; k < Math.min(nameIdx + 12, items.length); k++) {
      const s = items[k].str.trim();
      if (!s || s === '名') continue;
      if (/^\d/.test(s) || /[年月男女才生]/.test(s) || /^(平成|昭和|令和|大正)$/.test(s)) break;
      if (refY === null) refY = items[k].y;
      if (Math.abs(items[k].y - refY) > 10) break;
      nameParts.push(s);
    }
    data.name = nameParts.join(' ');
  }

  // 診療期間
  const periodMatch = fullText.match(/自令和\s*(\d+)\s*年\s*(\d+)\s*月/);
  if (periodMatch) data.period = `R${periodMatch[1]}/${periodMatch[2]}`;

  // 診療実日数
  const daysMatch = fullText.match(/診療実日数[\s\S]{0,30}?(\d+)\s*日/);
  if (daysMatch) data.days = parseInt(daysMatch[1]);

  if (data.form === 'J9A2') {
    // ---- 労災準拠様式: ㋑点数と㋩から A/B/C を計算し直す ----
    const ptMatches = [...fullText.matchAll(/([\d,]+)\s*点/g)]
      .map(m => parseInt(m[1].replace(/,/g, '')))
      .filter(n => n > 0);
    if (ptMatches.length) data.points = Math.max(...ptMatches);

    // ㋩ = 右側 10小計 (円)
    const koukeiItems = items.filter(i => /小計/.test(i.str));
    if (koukeiItems.length) {
      const xs = koukeiItems.map(i => i.x);
      const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const rightKoukei = koukeiItems.filter(i => i.x > midX);
      if (rightKoukei.length) {
        const top = rightKoukei.sort((a, b) => b.y - a.y)[0];
        const rowNums = items.filter(i =>
          Math.abs(i.y - top.y) < 8 && i.x > top.x && /^[\d,]+$/.test(i.str.trim())
        ).sort((a, b) => a.x - b.x);
        if (rowNums.length) data.smallSum = parseInt(rowNums[0].str.replace(/,/g, ''));
      }
    }
    if (!data.smallSum) {
      const m = flat.match(/10小計([\d,]+)円/);
      if (m) data.smallSum = num(m[1]);
    }
  } else {
    // ---- 健保準拠様式: 既に1点20円で計算済み。総請求額をそのまま土台にする ----
    const tk = flat.match(/技術料(\d+)円/);
    if (tk) data.tanka = parseInt(tk[1]);

    // 合計行 (※1点単価 医薬品等 XX円  <点数>  <金額>)
    const yaku = items.find(i => norm(i.str).includes('医薬品等'));
    if (yaku) {
      const nums = items.filter(i =>
        Math.abs(i.y - yaku.y) < 2.5 && i.x > 230 && /^[\d,]+$/.test(i.str.trim())
      ).sort((a, b) => a.x - b.x);
      if (nums.length >= 2) {
        data.points = num(nums[0].str);
        data.baseTotal = num(nums[1].str);
      }
    }
    // 総請求額欄から読み直す (こちらが正)
    const blk = billBlock(items);
    const amt = amtOf(blk && blk.total);
    if (amt) data.baseTotal = num(amt.str);
    if (!data.baseTotal) {
      const m = flat.match(/総請求額([\d,]+)円/);
      if (m) data.baseTotal = num(m[1]);
    }
    if (!blk) data.warn = '請求額欄を認識できず';
    else if (data.tanka && data.tanka !== TANKA) data.warn = `1点単価が${data.tanka}円`;
  }

  return data;
}

// ========== 計算 ==========
function calc(r) {
  const ho = (r.ho_count || 0) * HO_FEE;
  const he = (r.he_count || 0) * HE_FEE;
  r.ho_amount = ho;
  r.he_amount = he;
  const D = (r.D_other || 0) + ho + he;   // 諸費用計 (ニ＋ホ＋ヘ)
  let A = 0, B = 0, C = 0, base = 0;
  if (r.form === 'J9A2') {
    A = (r.points || 0) * TANKA;
    B = r.B || 0;
    C = Math.round((r.smallSum || 0) * 1.2);
    base = A + B + C;
  } else {
    base = r.baseTotal || 0;
  }
  return { A, B, C, D, ho, he, base, total: base + D };
}

function updateRowCalc(i) {
  const r = records[i];
  const { D, ho, he, base, total } = calc(r);
  const row = document.querySelector(`#recept-table tbody tr:nth-child(${i + 1})`);
  if (!row) return;
  row.querySelector('.c-ho').textContent = ho.toLocaleString();
  row.querySelector('.c-he').textContent = he.toLocaleString();
  row.querySelector('.c-d').textContent = D.toLocaleString();
  row.querySelector('.c-base').textContent = base.toLocaleString();
  row.querySelector('.c-total').textContent = total.toLocaleString();
}

// ========== テーブル描画 ==========
function renderTable() {
  const tbody = $('#recept-table tbody');
  tbody.innerHTML = '';
  records.forEach((r, idx) => {
    const { D, ho, he, base, total } = calc(r);
    const tr = document.createElement('tr');
    if (r.warn) tr.classList.add('warn');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td style="text-align:left">${r.name || '?'}${r.warn ? ` <span class="warn-tag" title="${r.warn}">要確認</span>` : ''}</td>
      <td class="form-${r.form}">${r.form === 'J9A2' ? '労災準拠' : '健保準拠'}</td>
      <td>${r.period}</td>
      <td>${r.days}</td>
      <td>${(r.points || 0).toLocaleString()}</td>
      <td class="auto c-base">${base.toLocaleString()}</td>
      <td><input type="number" data-i="${idx}" data-f="ho_count" value="${r.ho_count}" style="width:40px"></td>
      <td class="auto c-ho">${ho.toLocaleString()}</td>
      <td><input type="number" data-i="${idx}" data-f="he_count" value="${r.he_count}" style="width:40px"></td>
      <td class="auto c-he">${he.toLocaleString()}</td>
      <td><input type="number" data-i="${idx}" data-f="D_other" value="${r.D_other || ''}" placeholder="0"></td>
      <td class="auto c-d">${D.toLocaleString()}</td>
      <td class="total c-total">${total.toLocaleString()}</td>
      <td><select class="payee-sel" data-i="${idx}" data-f="payee"></select></td>
      <td><input type="date" class="wide" data-i="${idx}" data-f="date" value="${r.date}"></td>
    `;
    tbody.appendChild(tr);
  });
  refreshPayeeOptions();
  records.forEach((r, idx) => {
    const sel = document.querySelector(`select.payee-sel[data-i="${idx}"]`);
    if (sel) sel.value = r.payee || '';
  });
  $$('#recept-table input, #recept-table select').forEach(el => {
    el.addEventListener('input', e => {
      const i = +e.target.dataset.i, f = e.target.dataset.f;
      const v = e.target.type === 'number' ? (+e.target.value || 0) : e.target.value;
      records[i][f] = v;
      if (e.target.type === 'number') updateRowCalc(i);
    });
  });
  const n902 = records.filter(r => r.form === 'J902').length;
  $('#count').textContent = `(${records.length}件 / 健保準拠${n902}・労災準拠${records.length - n902})`;
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

// 描画ヘルパを作る
function painter(page, font, rgb) {
  return {
    draw(text, x, y, size = 7.5) {
      page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
    },
    // 右端 rightX で右寄せ描画
    drawRight(text, rightX, y, size = 7.5) {
      const s = String(text);
      let w;
      try { w = font.widthOfTextAtSize(s, size); } catch { w = s.length * size * 0.55; }
      page.drawText(s, { x: rightX - w, y, size, font, color: rgb(0, 0, 0) });
    },
    whiteOut(x, y, w, h) {
      page.drawRectangle({ x: x - 0.3, y: y - 1.5, width: w + 0.6, height: h + 1, color: rgb(1, 1, 1) });
    }
  };
}

// --- 共通: 上記金額 / 請求先 / 日付 ---
function applyFooter(items, r, total, P) {
  const kingakuLabel = items.find(i => norm(i.str).includes('上記金額'));
  if (!kingakuLabel) return;
  P.draw(total.toLocaleString(), kingakuLabel.x + 50, kingakuLabel.y, 9);

  if (r.payee) {
    const rowItems = items.filter(i => Math.abs(i.y - kingakuLabel.y) < 5);
    const wo = rowItems.find(i => i.str.includes('を'));
    const tono = rowItems.find(i => i.str.includes('殿'));
    const leftX = wo ? (wo.x + (wo.w || 8) + 4) : (kingakuLabel.x + 60);
    const rightX = tono ? (tono.x - 2) : (kingakuLabel.x + 260);
    const gap = Math.max(40, rightX - leftX);
    let size = 9;
    if (r.payee.length * size > gap) size = Math.max(5, gap / r.payee.length);
    const w = r.payee.length * size;
    P.draw(r.payee, leftX + (gap - w) / 2, kingakuLabel.y, size);
  }

  if (r.date) {
    const [yy, mm, dd] = r.date.split('-');
    const reiwa = parseInt(yy) - 2018;
    const below = items.filter(i => i.y < kingakuLabel.y && i.y > kingakuLabel.y - 40);
    const yItem = below.find(i => i.str.trim() === '年');
    const mItem = below.find(i => i.str.trim() === '月');
    const dItem = below.find(i => i.str.trim() === '日');
    if (yItem && mItem && dItem) {
      P.draw(`令和${reiwa}`, yItem.x - 24, yItem.y, 9);
      P.draw(String(parseInt(mm)), mItem.x - 12, mItem.y, 9);
      P.draw(String(parseInt(dd)), dItem.x - 12, dItem.y, 9);
    } else {
      P.draw(`${reiwa}年 ${parseInt(mm)}月 ${parseInt(dd)}日`, kingakuLabel.x + 30, kingakuLabel.y - 22, 9);
    }
  }
}

// --- 健保準拠様式 (J902): 諸費用を記入し総請求額を打ち直す ---
function applyJ902(page, items, r, c, P) {
  const blk = billBlock(items);
  if (blk) {
    // 金額欄: 右端の「円」の左に右寄せ。既存の数字があれば白塗りしてから。
    const put = (row, value, count) => {
      if (!row) return;
      const tsu = tsuOf(row);
      if (tsu && count) P.drawRight(String(count), tsu.x - 3, tsu.y, 7.5);
      const yen = yenOf(row);
      const old = amtOf(row);
      if (old) P.whiteOut(old.x, old.y, old.w, old.h);
      if (!value || !yen) return;
      const y = old ? old.y : yen.y;
      if (old && old === yen) {
        // 「28,880円」が1アイテム → 円ごと描き直す
        P.drawRight(value.toLocaleString() + '円', yen.x + yen.w, y, 7.5);
      } else {
        P.drawRight(value.toLocaleString(), yen.x - 4, y, 7.5);
      }
    };
    put(blk.ho, c.ho, r.ho_count);
    put(blk.he, c.he, r.he_count);
    put(blk.other, r.D_other || 0, 0);
    put(blk.sub, c.D, 0);
    put(blk.total, c.total, 0);   // 既存の総請求額を白塗りして打ち直す
  }
  applyFooter(items, r, c.total, P);
}

// --- 労災準拠様式 (J9A2): 様式・単価を書き換え A/B/C/D を計算し直す ---
function applyJ9A2(page, items, r, c, P) {
  const findItem = (pred) => items.find(pred);

  // 1. J9A2 → J902
  const j = findItem(i => i.str.includes('J9A2'));
  if (j) {
    P.whiteOut(j.x, j.y, j.w, j.h);
    P.draw('J902', j.x, j.y, j.h);
  }

  // 2. A（㋑×単価×1.2） → ×2.0
  const re12 = /[1１][．.・][2２]/;
  const all12 = items.filter(i => re12.test(i.str));
  let a12Targets = all12.filter(i => i.str.includes('単価'));
  if (a12Targets.length === 0 && all12.length >= 1) {
    const rows = {};
    all12.forEach(i => { const k = Math.round(i.y); (rows[k] = rows[k] || []).push(i); });
    Object.values(rows).forEach(row => { row.sort((a, b) => a.x - b.x); a12Targets.push(row[0]); });
  }
  for (const a12 of a12Targets) {
    P.whiteOut(a12.x, a12.y, a12.w, a12.h);
    P.draw(a12.str.replace(re12, '2.0'), a12.x, a12.y, a12.h);
  }

  // 3. 請求額の計算行 (A,B,C,D,合計)
  const reqLabel = findItem(i => norm(i.str).includes('請求額')) || findItem(i => norm(i.str).includes('の計算'));
  if (reqLabel) {
    const moneyRow = items.filter(i =>
      i.y < reqLabel.y + 5 && i.y > reqLabel.y - 35 && i.x > reqLabel.x + 20 &&
      (/^[\d,]+$/.test(i.str.trim()) || i.str.trim() === '円')
    );
    if (moneyRow.length) {
      const targetY = moneyRow.map(i => i.y).sort((a, b) => b - a)[0];
      const sameRow = moneyRow.filter(i => Math.abs(i.y - targetY) < 3).sort((a, b) => a.x - b.x);
      sameRow.forEach(it => P.whiteOut(it.x, it.y, it.w, it.h));
      const yens = sameRow.filter(i => i.str.trim() === '円');
      const values = [c.A, c.B, c.C, c.D, c.total];
      for (let k = 0; k < Math.min(5, yens.length); k++) {
        const v = values[k];
        if (v === 0 && k !== 0 && k !== 4) { P.draw('円', yens[k].x, yens[k].y, yens[k].h); continue; }
        P.drawRight(v.toLocaleString(), yens[k].x - 2, yens[k].y, yens[k].h);
        P.draw('円', yens[k].x, yens[k].y, yens[k].h);
      }
    }
  }

  // 4/5. 診断書料(ホ) 明細書料(ヘ)
  const rowOf = (label) => items.filter(i => Math.abs(i.y - label.y) < 3 && i.x > label.x);
  const putFee = (labelRe, count, amount) => {
    const label = findItem(i => labelRe.test(norm(i.str)));
    if (!label || !count) return;
    const row = rowOf(label);
    const tsu = row.find(i => i.str.trim() === '通' || i.str.trim().startsWith('通'));
    const yen = row.find(i => i.str.trim() === '円');
    if (tsu) P.draw(String(count), tsu.x - 12, label.y, label.h);
    const amt = amount.toLocaleString();
    if (yen) P.drawRight(amt, yen.x - 2, label.y, label.h);
    else if (tsu) P.draw(amt, tsu.x + 15, label.y, label.h);
  };
  putFee(/診断書料/, r.ho_count, c.ho);
  putFee(/明細書料/, r.he_count, c.he);

  applyFooter(items, r, c.total, P);
}

function applyFixesToPage(page, items, r, c, font, rgb) {
  const P = painter(page, font, rgb);
  if (r.form === 'J9A2') applyJ9A2(page, items, r, c, P);
  else applyJ902(page, items, r, c, P);
}

// ========== PDF生成（元PDFを直接修正 — フォント保持） ==========
async function generateAll() {
  if (!records.length) return;
  $('#generate-btn').disabled = true;
  $('#status').textContent = 'PDF生成中...';

  const { PDFDocument, rgb } = PDFLib;

  const fileGroups = new Map();
  for (const r of records) {
    if (!fileGroups.has(r.originalBytes)) {
      fileGroups.set(r.originalBytes, { fileName: r.fileName, records: [] });
    }
    fileGroups.get(r.originalBytes).records.push(r);
  }

  const outputs = [];
  let okCount = 0;
  const errors = [];
  let progress = 0;

  for (const [bytes, group] of fileGroups) {
    try {
      const doc = await PDFDocument.load(bytes.slice(0));
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(await loadFont());
      const pages = doc.getPages();

      for (const r of group.records) {
        try {
          const c = calc(r);
          for (let pi = 0; pi < r.pageNums.length; pi++) {
            const pageIdx = r.pageNums[pi];
            if (pageIdx < pages.length) {
              applyFixesToPage(pages[pageIdx], r.pagesItems[pi] || [], r, c, font, rgb);
            }
          }
          okCount++;
        } catch (e) {
          console.error(r.name, e);
          errors.push(`${r.name}: ${e.message}`);
        }
        progress++;
        $('#status').textContent = `PDF生成中... (${progress}/${records.length})`;
      }

      const out = await doc.save();
      outputs.push({ name: group.fileName, bytes: out });
    } catch (e) {
      console.error(group.fileName, e);
      errors.push(`${group.fileName}: ${e.message}`);
    }
  }

  if (errors.length) alert(`エラー ${errors.length}件:\n` + errors.slice(0, 5).join('\n'));
  if (okCount === 0) {
    $('#status').textContent = `失敗: ${errors[0] || '不明なエラー'}`;
    $('#generate-btn').disabled = false;
    return;
  }

  if (outputs.length === 1) {
    const blob = new Blob([outputs[0].bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `自賠責修正済_${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    const zip = new JSZip();
    for (const o of outputs) zip.file(`修正済_${o.name}`, o.bytes);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `自賠責修正済_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

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

  $('#delete-payee').addEventListener('click', () => {
    const v = $('#bulk-payee').value;
    if (!v) return;
    if (!confirm(`「${v}」を削除しますか？`)) return;
    savePayees(loadPayees().filter(p => p !== v));
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

  $('#apply-fees').addEventListener('click', () => {
    const ho = +$('#bulk-ho').value || 0;
    const he = +$('#bulk-he').value || 0;
    records.forEach(r => { r.ho_count = ho; r.he_count = he; });
    renderTable();
  });

  $('#generate-btn').addEventListener('click', generateAll);
});
