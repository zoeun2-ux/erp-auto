require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ERP_URL  = process.env.ERP_URL      || 'https://erp.lalasweet.kr/';
const USERNAME = process.env.ERP_USERNAME || 'zoeun2';
const PASSWORD = process.env.ERP_PASSWORD || '1234';
const SS = path.join(__dirname, 'scan-screenshots');

function allFrames(page) {
  const out = []; const walk = f => { out.push(f); f.childFrames().forEach(walk); }; walk(page.mainFrame()); return out;
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page    = await context.newPage();
  context.on('page', p => p.on('dialog', d => d.accept().catch(() => {})));

  // 로그인
  await page.goto(ERP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const idInput = page.locator('input[placeholder*="아이디"], input[name="userId"]').first();
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
  await page.waitForTimeout(1000);
  console.log('로그인 완료');

  // 전자결재 클릭 후 UBA2020 이동
  for (const f of allFrames(page)) {
    try {
      const els = await f.locator('a, span, li, div, button').all();
      for (const el of els) {
        try {
          if (!await el.isVisible()) continue;
          const txt = (await el.innerText().catch(() => '')).trim();
          if (!txt.startsWith('전자결재')) continue;
          await el.click({ timeout: 3000 }); break;
        } catch {}
      }
    } catch {}
  }
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  await page.waitForTimeout(2000);
  let cur = page.url();
  if (!cur.includes('pageCode=')) {
    const origin = new URL(ERP_URL).origin;
    await page.goto(`${origin}/#/UB/UB/UBA0000?specialLnb=Y&moduleCode=UB&menuCode=UBA&pageCode=UBA7000`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    cur = page.url();
  }
  await page.goto(cur.replace(/pageCode=[^&#]*/, 'pageCode=UBA2020'), { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 조회
  for (const f of allFrames(page)) {
    try {
      const btn = f.locator('button.btn_arrDown').first();
      if (await btn.count() > 0 && await btn.isVisible()) { await btn.click(); break; }
    } catch {}
  }
  await page.waitForTimeout(600);
  for (const f of allFrames(page)) {
    try {
      const boxes = await f.locator('.flex-1.h-box').all();
      for (const box of boxes) {
        if ((await box.innerText().catch(() => '')).includes('문서양식')) {
          const inp = box.locator('input').first();
          if (await inp.count() > 0) { await inp.clear(); await inp.fill('(신규) 지출결의서'); break; }
        }
      }
    } catch {}
  }
  for (const f of allFrames(page)) {
    for (const sel of ['button:has-text("조회")', '[title="조회"]']) {
      try { const el = f.locator(sel).first(); if (await el.count() > 0 && await el.isVisible()) { await el.click(); break; } } catch {}
    }
  }
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  await page.waitForTimeout(2000);

  // 4번째 문서 열기 (에이원방재 - 첨부파일 3개인 문서)
  const rows = await page.locator('li[class*="list"]').all();
  console.log(`총 ${rows.length}개 행 발견`);

  // 4번째 문서 시도 (인덱스 3)
  for (let docIdx = 0; docIdx < Math.min(rows.length, 8); docIdx++) {
    const rowTxt = (await rows[docIdx].innerText().catch(() => '')).replace(/\s+/g,' ').slice(0,80);
    console.log(`\n[${docIdx+1}] ${rowTxt}`);

    let popup = null;
    try {
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 6000 }),
        rows[docIdx].locator('a').first().click({ timeout: 3000 }),
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      try { await newPage.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await newPage.waitForTimeout(2000);
      popup = newPage;
    } catch { console.log('  팝업 실패'); continue; }

    // 모든 프레임 탐색
    let fi = 0;
    for (const f of allFrames(popup)) {
      try {
        const txt = await f.evaluate(() => document.body ? document.body.innerText : '');
        const c = txt.replace(/\s/g, '');
        const isForm = c.includes('용도별합계') || c.includes('품의번호');
        const hasTax = c.includes('전자세금계산서');
        console.log(`  [프레임${fi}] ${txt.length}자 / 폼:${isForm} / 세금계산서:${hasTax}`);

        // 첨부파일 HTML 저장 (폼 프레임)
        if (isForm) {
          const html = await f.evaluate(() => {
            return document.body ? document.body.innerHTML.slice(-10000) : '';
          });
          fs.writeFileSync(path.join(SS, `_attach_html_doc${docIdx+1}.html`), html);
          console.log(`  → HTML 저장: _attach_html_doc${docIdx+1}.html`);

          // 첨부 섹션 innerText도 저장
          const innerTxt = await f.evaluate(() => document.body ? document.body.innerText : '');
          fs.writeFileSync(path.join(SS, `_attach_txt_doc${docIdx+1}.txt`), innerTxt);

          // 모든 a/button 요소 나열
          const btns = await f.evaluate(() => {
            return [...document.querySelectorAll('a, button')].map(el => ({
              tag: el.tagName,
              text: (el.textContent || '').trim().slice(0, 60),
              cls: el.className,
              onclick: el.getAttribute('onclick') || '',
              href: el.getAttribute('href') || '',
            }));
          });
          console.log(`  a/button 개수: ${btns.length}`);
          btns.forEach((b, i) => {
            if (b.text || b.onclick || b.href) {
              console.log(`    [${i}] <${b.tag}> text="${b.text}" class="${b.cls}" onclick="${b.onclick.slice(0,60)}" href="${b.href.slice(0,40)}"`);
            }
          });
        }
      } catch (e) { console.log(`  [프레임${fi}] 오류: ${e.message.slice(0,40)}`); }
      fi++;
    }

    await popup.screenshot({ path: path.join(SS, `_debug_doc${docIdx+1}.png`), fullPage: true }).catch(() => {});
    await popup.close().catch(() => {});
    await page.waitForTimeout(300);
  }

  console.log('\n완료. 브라우저 열려있음.');
})();
