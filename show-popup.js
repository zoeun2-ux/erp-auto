require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const URL      = process.env.ERP_URL      || 'https://erp.lalasweet.kr/';
const USERNAME = process.env.ERP_USERNAME || 'zoeun2';
const PASSWORD = process.env.ERP_PASSWORD || '1234';
const SS = path.join(__dirname, 'scan-screenshots');

function allFrames(page) {
  const out = []; const walk = f => { out.push(f); f.childFrames().forEach(walk); }; walk(page.mainFrame()); return out;
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page    = await context.newPage();
  context.on('page', p => p.on('dialog', d => d.accept().catch(() => {})));

  // 로그인
  console.log('[1] 로그인...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const idInput = page.locator('input[placeholder*="아이디"], input[name="userId"]').first();
  if (await idInput.count() > 0) await idInput.fill(USERNAME);
  else await page.locator('input[type="text"]:not([disabled])').first().fill(USERNAME);

  for (const sel of ['button:has-text("다음")', 'button[type="submit"]']) {
    try { const el = page.locator(sel).first(); if (await el.count() > 0) { await el.click(); break; } } catch {}
  }
  // 비밀번호 필드가 나타날 때까지 대기
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input[type="password"]').first().fill(PASSWORD);

  for (const sel of ['button:has-text("로그인")', 'button[type="submit"]']) {
    try { const el = page.locator(sel).first(); if (await el.count() > 0) { await el.click(); break; } } catch {}
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  console.log('  완료');

  // 미결문서 이동
  console.log('[2] 미결문서 이동...');
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
    await page.goto(new URL(URL).origin + '/#/UB/UB/UBA0000?specialLnb=Y&moduleCode=UB&menuCode=UBA&pageCode=UBA7000', { waitUntil: 'networkidle' });
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
  console.log('  완료');

  // 첫 번째 문서 팝업 열기
  console.log('[3] 팝업 열기...');
  const rows = await page.locator('li[class*="list"]').all();
  let popup = null;
  for (const row of rows.slice(0, 5)) {
    try {
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 6000 }),
        row.locator('a').first().click({ timeout: 3000 }),
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      try { await newPage.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await newPage.waitForTimeout(2000);
      popup = newPage;
      break;
    } catch {}
  }

  if (popup) {
    // 기본정보 섹션으로 스크롤 후 스크린샷
    await popup.evaluate(() => {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if ((el.textContent || '').replace(/\s/g,'') === '기본정보') {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          return;
        }
      }
    });
    await popup.waitForTimeout(800);
    const outPath = path.join(SS, '_show_docTotal.png');
    await popup.screenshot({ path: outPath, fullPage: false });
    console.log('  스크린샷 저장:', outPath);
  } else {
    console.log('  팝업 열기 실패');
  }

  console.log('\n브라우저가 열려있습니다. 확인 후 직접 닫으세요.');
  // 브라우저를 열어둠 (닫지 않음)
})();
