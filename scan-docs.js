require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logToSheet, initSheet } = require('./sheets');

const URL          = process.env.ERP_URL      || 'https://erp.lalasweet.kr/';
const USERNAME     = process.env.ERP_USERNAME || 'zoeun2';
const PASSWORD     = process.env.ERP_PASSWORD || '1234';
const FORM_KEYWORD = process.env.FORM_KEYWORD || '(신규) 지출결의서';

const SS = path.join(__dirname, 'scan-screenshots');
if (!fs.existsSync(SS)) fs.mkdirSync(SS);

function allFrames(page) {
  const out = [];
  const walk = f => { out.push(f); f.childFrames().forEach(walk); };
  walk(page.mainFrame());
  return out;
}

function parseNum(str) {
  const n = String(str).replace(/[^0-9]/g, '');
  return n ? parseInt(n) : 0;
}

// rowText에서 품의번호·제목 추출 (팝업 실패 fallback용)
function parseRowText(text) {
  // 품의번호: 구매T-2605-067 / 물류T 냉동P-2605-023 / SCMT SCMP-2605-017 등
  const docMatch = text.match(/([가-힣A-Za-z]+(?:\s[가-힣A-Za-z]+)*-\d{4}-\d{3,4})/);
  const docNum = docMatch ? docMatch[1].trim() : null;

  // 제목: 시간(HH:MM) 이후 ~ (신규) 이전, 뒤 숫자 제거
  let title = null;
  const sinGyuIdx = text.indexOf('(신규)');
  if (sinGyuIdx > 0) {
    const timeMatch = text.match(/\d{2}:\d{2}\s+/);
    if (timeMatch) {
      let part = text.slice(timeMatch.index + timeMatch[0].length, sinGyuIdx).trim();
      part = part.replace(/\s+\d+(?:\s+\d+)*$/, '').trim(); // 뒤 개정번호 제거
      title = part || null;
    }
  }
  return { docNum, title };
}

// ── 로그인 ──────────────────────────────────────────────
async function login(page) {
  console.log('[1] 로그인...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const idInput = page.locator(
    'input[placeholder*="아이디"], input[name="userId"], input[id="userId"]'
  ).first();
  if (await idInput.count() > 0) await idInput.fill(USERNAME);
  else await page.locator('input[type="text"]:not([disabled])').first().fill(USERNAME);

  for (const sel of ['button:has-text("다음")', 'button[type="submit"]']) {
    try { const el = page.locator(sel).first(); if (await el.count() > 0) { await el.click(); break; } } catch {}
  }
  await page.waitForTimeout(800);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  for (const sel of ['button:has-text("로그인")', 'button[type="submit"]']) {
    try { const el = page.locator(sel).first(); if (await el.count() > 0) { await el.click(); break; } } catch {}
  }
  await page.waitForLoadState('networkidle');
  try { await page.waitForSelector('text=전자결재', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(1000);
  console.log('  완료');
}

// ── 미결문서 이동 ────────────────────────────────────────
async function goToPending(page) {
  console.log('[2] 미결문서 이동...');

  // 전자결재 클릭
  for (const f of allFrames(page)) {
    try {
      const els = await f.locator('a, span, li, div, button').all();
      for (const el of els) {
        try {
          if (!await el.isVisible()) continue;
          const txt = (await el.innerText().catch(() => '')).trim();
          if (!txt.startsWith('전자결재')) continue;
          await el.click({ timeout: 3000 });
          break;
        } catch {}
      }
    } catch {}
  }
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  await page.waitForTimeout(2000);

  // URL에 pageCode= 가 포함될 때까지 대기 (전자결재 클릭 효과)
  let currentUrl = page.url();
  console.log('  전자결재 후 URL:', currentUrl);

  // pageCode= 없으면 직접 UBA7000으로 이동
  if (!currentUrl.includes('pageCode=')) {
    const origin = new URL(URL).origin;
    const eapUrl = `${origin}/#/UB/UB/UBA0000?specialLnb=Y&moduleCode=UB&menuCode=UBA&pageCode=UBA7000`;
    await page.goto(eapUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    currentUrl = page.url();
  }

  // pageCode만 UBA2020으로 교체
  const pendingUrl = currentUrl.includes('pageCode=')
    ? currentUrl.replace(/pageCode=[^&#]*/, 'pageCode=UBA2020')
    : `${new URL(URL).origin}/#/UB/UB/UBA0000?specialLnb=Y&moduleCode=UB&menuCode=UBA&pageCode=UBA2020`;

  await page.goto(pendingUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  console.log('  완료. URL:', page.url());
}

// ── ▼ 버튼 → 문서양식 입력 → 조회 ──────────────────────
async function filterAndSearch(page) {
  console.log(`[3] "${FORM_KEYWORD}" 조회...`);
  for (const f of allFrames(page)) {
    try {
      const btn = f.locator('button.btn_arrDown').first();
      if (await btn.count() > 0 && await btn.isVisible()) { await btn.click({ timeout: 3000 }); break; }
    } catch {}
  }
  await page.waitForTimeout(600);

  let filled = false;
  for (const f of allFrames(page)) {
    try {
      const boxes = await f.locator('.flex-1.h-box').all();
      for (const box of boxes) {
        if ((await box.innerText().catch(() => '')).includes('문서양식')) {
          const inp = box.locator('input').first();
          if (await inp.count() > 0) { await inp.clear(); await inp.fill(FORM_KEYWORD); filled = true; break; }
        }
      }
    } catch {}
    if (filled) break;
  }

  for (const f of allFrames(page)) {
    for (const sel of ['button:has-text("조회")', 'a:has-text("조회")', '[title="조회"]']) {
      try {
        const el = f.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) { await el.click({ timeout: 3000 }); break; }
      } catch {}
    }
  }
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  await page.waitForTimeout(2000);
  console.log('  조회 완료');
}

// ── 현재 페이지 행 가져오기 ──────────────────────────────
async function getRows(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const liRows = await page.locator('li[class*="list"]').all();
      const data = [];
      for (const row of liRows) {
        const txt = await row.innerText().catch(() => '');
        if (txt.trim().length > 10) data.push(row);
      }
      if (data.length > 0) return data;

      for (const f of allFrames(page)) {
        const rows = await f.locator('tbody tr').all();
        const data2 = [];
        for (const row of rows) {
          if (await row.locator('td').count() > 0) data2.push(row);
        }
        if (data2.length > 0) return data2;
      }
    } catch {}
    if (attempt < 4) await page.waitForTimeout(1000).catch(() => {});
  }
  return [];
}

// ── 팝업에서 데이터 읽기 ───────────────────────────────────
async function readPopupData(popup) {
  try { await popup.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
  await popup.waitForTimeout(2000);

  let formText = '';
  let formFrame = null;
  const attachCandidates = [];  // 전자세금계산서 제외된 비-폼 프레임
  let fi = 0;

  for (const f of allFrames(popup)) {
    try {
      const text = await f.evaluate(() => document.body ? document.body.innerText : '');
      if (text.length < 50) { fi++; continue; }
      const c = text.replace(/\s/g, '');
      const isForm      = c.includes('용도별합계') || c.includes('품의번호') || c.includes('기본정보');
      const isTaxInvoice = c.includes('전자세금계산서');
      console.log(`  [프레임${fi}] ${text.length}자 / 폼:${isForm} / 세금계산서:${isTaxInvoice}`);
      if (isForm) {
        if (text.length > formText.length) { formText = text; formFrame = f; }
      } else if (!isTaxInvoice && text.length > 100) {
        attachCandidates.push({ f, text, c });
      }
    } catch {}
    fi++;
  }

  if (formText.length < 50) return { docNum: null, title: null, usageTotal: null, attachTotal: null };

  const compressed = formText.replace(/\s/g, '');

  // 품의번호
  let docNum = null;
  const docNumM = formText.match(/품\s*의\s*번\s*호\s*([^\n\r]+)/);
  if (docNumM) docNum = docNumM[1].trim().replace(/\s+/g, ' ');
  if (!docNum) {
    const cm = compressed.match(/품의번호([A-Za-z0-9가-힣\-\/\.]{1,50}?)(?=작성|기안|제목|수신|시행|비고|참고|합계)/);
    if (cm) docNum = cm[1];
  }

  // 제목
  let title = null;
  const titleM = formText.match(/제\s*목\s*([^\n\r]+)/);
  if (titleM) title = titleM[1].trim().replace(/\s+/g, ' ');
  if (!title) {
    const cm = compressed.match(/제목([^0-9]{1,80}?)(?=기본정보|용도|작성|합계)/);
    if (cm) title = cm[1];
  }

  // 용도별합계 — DOM 우선, 폼 프레임만 스캔
  let usageTotal = null;
  const usageScanFrames = formFrame ? [formFrame] : allFrames(popup);
  for (const f of usageScanFrames) {
    try {
      const val = await f.evaluate(() => {
        const compress = s => (s || '').replace(/\s/g, '');
        let afterUsage = false;
        const all = document.querySelectorAll('td, th');
        for (const cell of all) {
          const t = compress(cell.textContent);
          if (t.includes('용도별합계')) { afterUsage = true; continue; }
          if (afterUsage && (t === '합계' || t === '소계')) {
            const row = cell.closest('tr');
            if (row) {
              const cells = [...row.querySelectorAll('td')];
              for (let i = cells.length - 1; i >= 0; i--) {
                const raw = cells[i].textContent.replace(/[^0-9]/g, '');
                const n = parseInt(raw);
                if (n > 1000) return n;
              }
            }
          }
        }
        return null;
      });
      if (val && val > 1000) { usageTotal = val; break; }
    } catch {}
  }

  if (!usageTotal) {
    const usageKeyM = formText.match(/용\s*도\s*별\s*합\s*계/);
    if (usageKeyM) {
      const start = formText.indexOf(usageKeyM[0]);
      const section = formText.slice(start, start + 800);
      const hapgyeM = section.match(/합\s*계\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/);
      if (hapgyeM) usageTotal = parseNum(hapgyeM[3]);
      else {
        const nums = [...section.matchAll(/(?<![,\d])(\d{1,3}(?:,\d{3})+)(?![,\d])/g)]
          .map(m => parseNum(m[1])).filter(n => n > 1000);
        if (nums.length > 0) usageTotal = Math.max(...nums);
      }
    }
  }

  // ── 첨부파일 금액 추출 (전자세금계산서 제외, 돋보기 아이콘 클릭) ──
  let attachTotal = null;
  const DOM_LABELS = ['청구금액', '합계금액', '공급가액', '합계', '총액', '정상매출', '총합계'];
  const TOTAL_KW   = ['금액', '합계금액', '청구금액', '총합계금액', '총합', '정상매출', '합계', '총액'];

  // 압축 텍스트에서 금액 추출
  // useKeywords=true: 키워드 인접 숫자 우선(거래명세서·엑셀), false: MAX만(PDF 자간 렌더링)
  function extractFromText(nc, refTotal, useKeywords = false) {
    if (useKeywords) {
      for (const kw of TOTAL_KW) {
        const idx = nc.indexOf(kw);
        if (idx === -1) continue;
        const m = nc.slice(idx, idx + 80).match(/(\d{1,3}(?:,\d{3})+)/);
        if (m) {
          const n = parseInt(m[1].replace(/,/g, ''));
          if (n >= 10000) return { val: n, method: kw };
        }
      }
    }
    const nums = [...nc.matchAll(/(\d{1,3}(?:,\d{3})+)/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''))).filter(n => n >= 10000 && n < 10_000_000_000);
    if (nums.length > 0) {
      const maxVal = Math.max(...nums);
      // 용도별합계 대비 15배 초과 + 1억 초과이면 오인식으로 판단
      if (refTotal != null && maxVal > refTotal * 15 && maxVal > 100_000_000) return null;
      return { val: maxVal, method: '텍스트' };
    }
    return null;
  }

  // 프레임 DOM에서 금액 추출
  async function domExtract(f, labels) {
    try {
      const val = await f.evaluate((lbls) => {
        const compress = s => (s || '').replace(/\s/g, '');
        for (const label of lbls) {
          for (const cell of document.querySelectorAll('td, th')) {
            if (compress(cell.textContent) !== label) continue;
            const row = cell.closest('tr');
            if (!row) continue;
            const rowCells = [...row.querySelectorAll('td, th')];
            for (let i = rowCells.length - 1; i >= 0; i--) {
              if (compress(rowCells[i].textContent) === label) break;
              const n = parseInt(rowCells[i].textContent.replace(/[^0-9]/g, ''));
              if (n > 1000) return n;
            }
          }
        }
        return null;
      }, labels);
      return (val && val > 1000) ? val : null;
    } catch { return null; }
  }

  // Step 1: 이미 로드된 비-폼, 비-전자세금계산서 프레임에서 금액 추출
  for (const { f, c } of attachCandidates) {
    if (attachTotal != null) break;
    if (!c.includes('합계') && !c.includes('청구') && !c.includes('금액') && !c.includes('총액') && !c.includes('정상매출')) continue;

    const domVal = await domExtract(f, DOM_LABELS);
    if (domVal) {
      attachTotal = domVal;
      console.log(`  [첨부금액] ${domVal.toLocaleString('ko-KR')}원 (DOM)`);
      break;
    }
    const textResult = extractFromText(c, usageTotal);
    if (textResult) {
      attachTotal = textResult.val;
      console.log(`  [첨부금액] ${attachTotal.toLocaleString('ko-KR')}원 (${textResult.method})`);
      break;
    }
  }

  // Step 2: 돋보기(prvIco) 클릭 후 인라인 프레임 재스캔 (엑셀 등 미리로드 안 된 파일)
  if (attachTotal == null && formFrame) {
    try {
      const fileTitle = await formFrame.evaluate(() => {
        const FILE_EXT = /\.(xlsx?|jpe?g|png|pdf|hwp|docx?)/i;
        for (const item of document.querySelectorAll('li')) {
          const p = item.querySelector('p[title]');
          if (!p) continue;
          const t = p.getAttribute('title') || '';
          if (!FILE_EXT.test(t)) continue;
          if (t.replace(/\s/g, '').includes('전자세금계산서')) continue;
          const btn = item.querySelector('[title="미리보기"], .prvIco');
          if (!btn) continue;
          btn.click();
          return t;
        }
        return null;
      });

      if (fileTitle) {
        console.log(`  [첨부클릭] ${fileTitle}`);

        // 콘텐츠 로딩 대기: 폼 프레임 외 200자 이상 프레임이 생길 때까지 최대 20초 폴링
        for (let w = 0; w < 8; w++) {
          await popup.waitForTimeout(2500).catch(() => {});
          let ready = false;
          for (const nf of allFrames(popup)) {
            const u = nf.url();
            if (u === 'about:blank' || u === '' || u.includes('#/popup?')) continue;
            try {
              const len = await nf.evaluate(() => document.body ? document.body.innerText.length : 0);
              if (len > 200) { ready = true; break; }
            } catch {}
          }
          if (ready) break;
        }

        for (const nf of allFrames(popup)) {
          try {
            const txt = await nf.evaluate(() => document.body ? document.body.innerText : '');
            const nc = txt.replace(/\s/g, '');
            if (nc.length < 50) continue;
            // 전자세금계산서 양식은 3회 이상 등장 — 거래명세서 등 일반 언급(1~2회)은 통과
            if ((nc.match(/전자세금계산서/g) || []).length >= 3) continue;
            if (nc.includes('용도별합계') || nc.includes('품의번호') || nc.includes('기본정보')) continue;

            const domVal2 = await domExtract(nf, DOM_LABELS);
            if (domVal2) {
              attachTotal = domVal2;
              console.log(`  [첨부금액] ${attachTotal.toLocaleString('ko-KR')}원 (클릭DOM)`);
              break;
            }
            const textResult2 = extractFromText(nc, usageTotal, true); // 키워드 인접 우선
            if (textResult2) {
              attachTotal = textResult2.val;
              console.log(`  [첨부금액] ${attachTotal.toLocaleString('ko-KR')}원 (클릭${textResult2.method})`);
              break;
            }
          } catch {}
        }

        // 미리보기 뷰어 닫기
        try {
          await formFrame.evaluate(() => {
            for (const sel of ['[title="닫기"]', '.prvClose', '[class*="closeBtn"]', '[class*="close-btn"]', 'button.close']) {
              const el = document.querySelector(sel);
              if (el) { el.click(); return; }
            }
            const active = document.querySelector('.prvIco.on, .prvIco.active, [title="미리보기"].on');
            if (active) active.click();
          }).catch(() => {});
          await popup.keyboard.press('Escape').catch(() => {});
          await popup.waitForTimeout(300).catch(() => {});
          console.log('  [첨부] 미리보기 닫기');
        } catch {}
      }
    } catch (e) {
      console.log(`  [첨부] Step2 오류: ${e.message.slice(0, 60)}`);
    }
  }

  return { docNum, title, usageTotal, attachTotal };
}

// ── 팝업 열기 (새 탭만 허용, 메인 페이지 탐색 금지) ────────
async function openPopup(page, row) {
  const clickTargets = [
    () => row.locator('a').first().click({ timeout: 3000 }),
    () => row.locator('[class*="title"],[class*="subject"],[class*="con"]').first().click({ timeout: 3000 }),
    () => row.click({ timeout: 3000 }),
  ];

  for (const clickFn of clickTargets) {
    try {
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 6000 }),
        clickFn(),
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      try { await newPage.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await newPage.waitForTimeout(1000);
      return newPage;
    } catch {}
  }
  return null;
}

// ── 다음 페이지 ──────────────────────────────────────────
async function clickNextPage(page) {
  for (const f of allFrames(page)) {
    for (const sel of ['button[title="다음"]','button:has-text("다음")','a[title="다음"]','[class*="next"]']) {
      try {
        const el = f.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible() && !await el.isDisabled()) {
          await el.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          return true;
        }
      } catch {}
    }
  }
  return false;
}

// ── 메인 ─────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page    = await context.newPage();
  context.on('page', p => p.on('dialog', d => d.accept().catch(() => {})));
  page.on('dialog', d => d.accept().catch(() => {}));

  await login(page);
  await goToPending(page);
  await filterAndSearch(page);

  const listUrl = page.url();

  await initSheet(USERNAME).catch(e => console.log('시트 초기화 오류:', e.message));
  await page.screenshot({ path: path.join(SS, '_list.png') });

  const results = [];
  let globalIdx = 0;
  let pageNum   = 1;

  while (true) {
    const rows = await getRows(page);
    console.log(`\n[페이지 ${pageNum}] 행 ${rows.length}개`);
    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i++) {
      globalIdx++;
      let freshRows;
      try { freshRows = await getRows(page); } catch (e) {
        console.log('  ⚠ 행 조회 실패, 목록 복귀...', e.message.slice(0, 60));
        await page.goto(listUrl, { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(1500);
        try { freshRows = await getRows(page); } catch { break; }
      }
      const row = freshRows[i];
      if (!row) continue;

      const rowTextFull = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const rowText = rowTextFull.slice(0, 120); // 로그 출력용
      console.log(`\n[${globalIdx}] ${rowText}`);

      const popup = await openPopup(page, row);
      if (!popup) {
        console.log('  ❌ 팝업 실패');
        const parsed = parseRowText(rowTextFull);
        await logToSheet({ idx: globalIdx, docNum: parsed.docNum, title: parsed.title, usageTotal: null, attachTotal: null, match: false, diff: null, username: USERNAME }).catch(() => {});
        results.push({ idx: globalIdx, rowText, docNum: parsed.docNum, title: parsed.title, usageTotal: null, attachTotal: null });
        // 팝업 실패 시 메인 페이지 URL 복구
        if (!page.isClosed() && !page.url().includes('UBA2020')) {
          await page.goto(listUrl, { waitUntil: 'networkidle' }).catch(() => {});
          await page.waitForTimeout(1000).catch(() => {});
        }
        continue;
      }

      let readResult;
      try { readResult = await readPopupData(popup); }
      catch (e) {
        console.log(`  ❌ 팝업 읽기 오류: ${e.message.slice(0, 60)}`);
        const parsed = parseRowText(rowTextFull);
        await logToSheet({ idx: globalIdx, docNum: parsed.docNum, title: parsed.title, usageTotal: null, attachTotal: null, match: false, diff: null, approved: false, username: USERNAME }).catch(() => {});
        results.push({ idx: globalIdx, rowText, docNum: parsed.docNum, title: parsed.title, usageTotal: null, attachTotal: null, match: false, diff: null });
        await popup.close().catch(() => {});
        continue;
      }
      const { docNum, title, usageTotal, attachTotal } = readResult;
      const match = usageTotal != null && attachTotal != null && usageTotal === attachTotal;
      const diff  = (usageTotal != null && attachTotal != null) ? Math.abs(usageTotal - attachTotal) : null;

      const fmt = n => n != null ? n.toLocaleString('ko-KR') + '원' : '읽기실패';
      console.log(`  품의번호:      ${docNum || '-'}`);
      console.log(`  제목:          ${title || '-'}`);
      console.log(`  용도별합계:    ${fmt(usageTotal)}`);
      console.log(`  첨부파일금액:  ${fmt(attachTotal)}`);
      console.log(`  결과: ${match ? '✅ 일치' : '❌ 불일치'}${diff ? ' (차이: ' + diff.toLocaleString('ko-KR') + '원)' : ''}`);

      // 일치 시 자동 승인
      let approved = false;
      if (match) {
        console.log('  [승인] 시도...');
        try {
          await popup.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await popup.waitForTimeout(500).catch(() => {});

          // 네이티브 confirm/alert 다이얼로그 자동 수락 (승인하시겠습니까? 등)
          const dialogHandler = async (dialog) => {
            console.log(`  [다이얼로그] ${dialog.type()}: "${dialog.message().slice(0, 60)}"`);
            await dialog.accept().catch(() => {});
          };
          popup.on('dialog', dialogHandler);

          // 상단 우측 툴바(y<120, x>50%)에서 승인 버튼 좌표 추출
          const btnInfo = await popup.evaluate(() => {
            const W = window.innerWidth;
            const candidates = [];
            for (const el of document.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              if (r.top < 0 || r.top > 120) continue;
              if (r.right < W * 0.5) continue;
              const t = (el.textContent || '').trim().replace(/\s+/g, '');
              if (!t.includes('승인') || t.includes('반려')) continue;
              candidates.push({ text: t, cx: r.left + r.width / 2, cy: r.top + r.height / 2, area: r.width * r.height });
            }
            candidates.sort((a, b) => a.area - b.area);
            return candidates[0] || null;
          }).catch(() => null);

          console.log(`  [승인] 후보: ${btnInfo ? `"${btnInfo.text}" @ (${Math.round(btnInfo.cx)},${Math.round(btnInfo.cy)})` : '없음'}`);

          if (btnInfo) {
            // 1차 클릭: 상단 툴바 승인 버튼
            await popup.mouse.click(btnInfo.cx, btnInfo.cy);
            await popup.waitForTimeout(1500).catch(() => {});

            // 2차 클릭: "결재승인" 모달의 파란 승인 버튼 (y > 150 영역)
            const modalBtn = await popup.evaluate(() => {
              for (const el of document.querySelectorAll('button, [role="button"]')) {
                const t = (el.textContent || '').trim();
                const r = el.getBoundingClientRect();
                if (r.width < 10 || r.height < 10) continue;
                if (r.top <= 150) continue; // 툴바 제외
                if (t === '승인' || t === '확인' || t === '예') {
                  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: t };
                }
              }
              return null;
            }).catch(() => null);

            if (modalBtn) {
              console.log(`  [승인] 모달버튼: "${modalBtn.text}" @ (${Math.round(modalBtn.cx)},${Math.round(modalBtn.cy)})`);
              await popup.mouse.click(modalBtn.cx, modalBtn.cy);
              await popup.waitForTimeout(2000).catch(() => {});
            } else {
              console.log('  [승인] 모달버튼 없음 (1차 클릭만)');
              await popup.waitForTimeout(1000).catch(() => {});
            }

            approved = true;
          }

          popup.off('dialog', dialogHandler);
          console.log(`  [승인] ${approved ? '완료' : '실패(버튼 미발견)'}`);
        } catch (e) {
          console.log(`  [승인] 오류: ${e.message.slice(0, 60)}`);
        }
      }

      // 스크린샷
      await popup.screenshot({ path: path.join(SS, `doc_${String(globalIdx).padStart(3,'0')}.png`), fullPage: false }).catch(() => {});
      try {
        await popup.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await popup.waitForTimeout(400);
        await popup.screenshot({ path: path.join(SS, `attach_${String(globalIdx).padStart(3,'0')}.png`), fullPage: false }).catch(() => {});
      } catch {}

      await logToSheet({ idx: globalIdx, docNum, title, usageTotal, attachTotal, match, diff, approved, username: USERNAME }).catch(e => {
        console.log('  ⚠ 시트 오류:', e.message.slice(0, 60));
      });

      results.push({ idx: globalIdx, rowText, docNum, title, usageTotal, attachTotal, match, diff });

      console.log('  [창닫기] 팝업 닫는 중...');
      await popup.close().catch(() => {});
      console.log('  [창닫기] 완료');
      await page.waitForTimeout(300).catch(() => {});

      // 팝업이 메인 페이지를 건드렸을 경우 목록으로 복귀
      if (!page.isClosed() && !page.url().includes('UBA2020')) {
        console.log('  목록 페이지 복귀...');
        await page.goto(listUrl, { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});
      }
    }

    const moved = await clickNextPage(page);
    if (!moved) break;
    pageNum++;
  }

  fs.writeFileSync(path.join(__dirname, 'scan-results.json'), JSON.stringify(results, null, 2));

  const matched   = results.filter(r => r.match).length;
  const unmatched = results.filter(r => r.match === false && r.usageTotal != null).length;
  const failed    = results.filter(r => r.usageTotal == null).length;

  console.log('\n==============================');
  console.log(`스캔 완료: 총 ${results.length}건`);
  console.log(`  ✅ 일치: ${matched}건`);
  console.log(`  ❌ 불일치: ${unmatched}건`);
  console.log(`  ⚠ 읽기실패: ${failed}건`);
  console.log('==============================');

  await browser.close();
})();
