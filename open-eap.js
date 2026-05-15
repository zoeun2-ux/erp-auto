require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const URL      = process.env.ERP_URL      || 'https://erp.lalasweet.kr/';
  const USERNAME = process.env.ERP_USERNAME || 'zoeun2';
  const PASSWORD = process.env.ERP_PASSWORD || '1234';

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page    = await context.newPage();

  console.log('[1] 로그인 중...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
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
  console.log('  로그인 완료');

  console.log('[2] 전자결재 클릭 중...');
  try { await page.waitForSelector('text=전자결재', { timeout: 10000 }); } catch {}
  await page.waitForTimeout(1000);

  function allFrames(p) {
    const out = [];
    const walk = f => { out.push(f); f.childFrames().forEach(walk); };
    walk(p.mainFrame());
    return out;
  }

  for (const f of allFrames(page)) {
    try {
      const els = await f.locator('a, span, li, div, button').all();
      for (const el of els) {
        try {
          if (!await el.isVisible()) continue;
          const txt = (await el.innerText().catch(() => '')).trim();
          if (!txt.startsWith('전자결재')) continue;
          console.log('  클릭:', txt);
          await el.click({ timeout: 3000 });
          break;
        } catch {}
      }
    } catch {}
  }

  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  await page.waitForTimeout(1500);
  console.log('  전자결재 완료. URL:', page.url());

  // [3] 미결문서로 직접 이동 (URL의 pageCode만 UBA2020으로 교체)
  console.log('[3] 미결문서 직접 이동 중...');
  const currentUrl = page.url();
  const pendingUrl = currentUrl.replace(/pageCode=[^&]*/, 'pageCode=UBA2020');
  await page.goto(pendingUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  console.log('  미결문서 도착. URL:', page.url());

  // [4] ▼ 버튼(btn_arrDown) 클릭
  console.log('[4] ▼ 버튼 클릭 중...');
  let toggled = false;
  for (const f of allFrames(page)) {
    try {
      const btn = f.locator('button.btn_arrDown').first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click({ timeout: 3000 });
        toggled = true;
        console.log('  ▼ 클릭 완료');
        break;
      }
    } catch {}
  }
  if (!toggled) console.log('  ▼ 버튼을 찾지 못했습니다.');
  await page.waitForTimeout(600);

  // [5] 문서양식 입력란에 FORM_KEYWORD 입력
  const FORM_KEYWORD = process.env.FORM_KEYWORD || '(신규) 지출결의서';
  console.log(`[5] 문서양식 입력: "${FORM_KEYWORD}"`);
  let filled = false;
  for (const f of allFrames(page)) {
    try {
      const boxes = await f.locator('.flex-1.h-box').all();
      for (const box of boxes) {
        const text = await box.innerText().catch(() => '');
        if (text.includes('문서양식')) {
          const inp = box.locator('input').first();
          if (await inp.count() > 0) {
            await inp.clear();
            await inp.fill(FORM_KEYWORD);
            filled = true;
            console.log('  입력 완료');
            break;
          }
        }
      }
    } catch {}
    if (filled) break;
  }
  if (!filled) console.log('  문서양식 입력란을 찾지 못했습니다.');

  // 브라우저는 열어둔 채로 유지
  console.log('\n완료! 브라우저를 확인하세요.');
})();
