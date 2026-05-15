require('dotenv').config();
const { chromium }   = require('playwright');
const fs             = require('fs');
const path           = require('path');
const { logToSheet } = require('./sheets');

const URL          = process.env.ERP_URL      || 'https://erp.lalasweet.kr/';
const USERNAME     = process.env.ERP_USERNAME || 'zoeun2';
const PASSWORD     = process.env.ERP_PASSWORD || '1234';
const FORM_KEYWORD = process.env.FORM_KEYWORD || '(신규) 지출결의서';

const SS = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SS)) fs.mkdirSync(SS);

async function shot(page, name) {
  await page.screenshot({ path: path.join(SS, `${name}.png`) }).catch(() => {});
}


function allFrames(page) {
  const out = [];
  const walk = f => { out.push(f); f.childFrames().forEach(walk); };
  walk(page.mainFrame());
  return out;
}

async function clickFirst(page, selectors, desc) {
  for (const frame of allFrames(page)) {
    for (const sel of selectors) {
      try {
        const el = frame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.click({ timeout: 3000 });
          return true;
        }
      } catch {}
    }
  }
  throw new Error(`'${desc}' 요소 없음`);
}

// ── 로그인 ────────────────────────────────────────────
async function login(page) {
  console.log('\n[1] 로그인 중...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const idInput = page.locator(
    'input[placeholder="아이디를 입력하세요"], input[placeholder*="아이디"], input[name="userId"], input[id="userId"]'
  ).first();
  if (await idInput.count() > 0) {
    await idInput.fill(USERNAME);
  } else {
    await page.locator('input[type="text"]:not([disabled])').first().fill(USERNAME);
  }

  await clickFirst(page, ['button:has-text("다음")', 'button[type="submit"]'], '다음 버튼');
  await page.waitForTimeout(800);

  await page.locator(
    'input[placeholder="비밀번호를 입력하세요"], input[type="password"], input[name="password"]'
  ).first().fill(PASSWORD);

  await clickFirst(page, ['button:has-text("로그인")', 'button[type="submit"]'], '로그인 버튼');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  console.log('  로그인 완료');
}

// ── 미결문서 이동 ──────────────────────────────────────
async function navigateToPending(page) {
  console.log('\n[2] 미결문서 이동...');

  const isOnList = async () => {
    for (const frame of allFrames(page)) {
      try {
        if (await frame.locator('button:has-text("일괄승인")').count() > 0) return true;
        if (await frame.locator('text=/미결문서 \\d+건/').count() > 0) return true;
      } catch {}
    }
    return false;
  };

  if (await isOnList()) { console.log('  이미 미결문서'); return; }

  // 사이드바 "미결문서 88" 등 직접 클릭 시도
  for (const frame of allFrames(page)) {
    try {
      const el = frame.locator('a, span, li').filter({ hasText: /^미결문서/ }).first();
      if (await el.count() > 0 && await el.isVisible()) {
        const box = await el.boundingBox();
        if (box && box.x < 300) {
          await el.click({ timeout: 3000 });
          await page.waitForTimeout(800);
          if (await isOnList()) { console.log('  미결문서 직접 클릭 완료'); return; }
        }
      }
    } catch {}
  }

  // 대시보드 "미결문서" 더보기 클릭
  for (const frame of allFrames(page)) {
    try {
      const els = await frame.locator('a, button, span').filter({ hasText: '더보기' }).all();
      for (const el of els) {
        if (!(await el.isVisible())) continue;
        const parentText = await el.locator('xpath=ancestor::div[2]').innerText().catch(() => '');
        if (parentText.includes('미결문서')) {
          await el.click({ timeout: 3000 });
          await page.waitForTimeout(800);
          if (await isOnList()) { console.log('  더보기로 진입 완료'); return; }
          break;
        }
      }
    } catch {}
  }

  // 사이드바 순차 클릭
  const clickSidebar = async (keyword) => {
    for (const frame of allFrames(page)) {
      for (const sel of ['a', 'span', 'li']) {
        try {
          const els = frame.locator(sel).filter({ hasText: new RegExp(`^${keyword}`) });
          const cnt = await els.count();
          for (let i = 0; i < cnt; i++) {
            const el = els.nth(i);
            if (!(await el.isVisible())) continue;
            const box = await el.boundingBox();
            if (box && box.x < 300) { await el.click({ timeout: 3000 }); return true; }
          }
        } catch {}
      }
    }
    return false;
  };

  await clickSidebar('결재수신함');
  await page.waitForTimeout(600);
  await clickSidebar('미결문서');

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    if (await isOnList()) break;
    if (i === 3) await clickSidebar('미결문서');
  }

  if (!(await isOnList())) throw new Error('미결문서 목록 로딩 실패');
  console.log('  미결문서 진입 완료');
}

// ── ▼ 버튼 → 문서양식 입력 → 조회 ────────────────────
async function filterByFormKeyword(page) {
  console.log(`\n[3] "${FORM_KEYWORD}" 조회...`);

  // ▼ 버튼 (btn_arrDown)
  let toggled = false;
  for (const frame of allFrames(page)) {
    try {
      const btn = frame.locator('button.btn_arrDown').first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click({ timeout: 3000 });
        toggled = true;
        console.log('  ▼ 버튼 클릭');
      }
    } catch {}
    if (toggled) break;
  }

  if (!toggled) {
    await shot(page, '03_arrow_btn_failed');
    throw new Error('▼ 버튼(btn_arrDown)을 찾지 못했습니다.');
  }

  await page.waitForTimeout(600);

  // "문서양식" 텍스트를 포함한 .flex-1.h-box 안의 input
  let filled = false;
  for (const frame of allFrames(page)) {
    try {
      const boxes = await frame.locator('.flex-1.h-box').all();
      for (const box of boxes) {
        const text = await box.innerText().catch(() => '');
        if (text.includes('문서양식')) {
          const inp = box.locator('input').first();
          if (await inp.count() > 0) {
            await inp.clear();
            await inp.fill(FORM_KEYWORD);
            filled = true;
            console.log('  문서양식 입력 완료');
            break;
          }
        }
      }
    } catch {}
    if (filled) break;
  }

  if (!filled) {
    await shot(page, '03_fill_failed');
    throw new Error('문서양식 입력 필드를 찾지 못했습니다.');
  }

  await clickFirst(page, [
    'button:has-text("조회")',
    'a:has-text("조회")',
    'input[value="조회"]',
    '[title="조회"]',
  ], '조회 버튼');

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  console.log('  조회 완료');
}

// ── 전체 선택 + 일괄승인 ──────────────────────────────
async function bulkApproveAll(page) {
  console.log('\n[4] 일괄승인...');

  // 전체 선택 체크박스
  let selected = false;
  for (const frame of allFrames(page)) {
    for (const sel of [
      'thead input[type="checkbox"]',
      'th input[type="checkbox"]',
      'input[id*="checkAll"]',
      'input[id*="allCheck"]',
      'input[id*="chkAll"]',
      'input[name*="checkAll"]',
      'input[name*="allCheck"]',
      'input[name*="chkAll"]',
    ]) {
      try {
        const el = frame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.click({ timeout: 3000 });
          selected = true;
          console.log('  전체 선택');
          break;
        }
      } catch {}
    }
    if (selected) break;
  }

  await page.waitForTimeout(300);

  page.on('dialog', d => { console.log(`  [팝업] ${d.message()}`); d.accept().catch(() => {}); });

  // 일괄승인 버튼
  let approved = false;
  for (const frame of allFrames(page)) {
    for (const sel of [
      'button:has-text("일괄승인")',
      'a:has-text("일괄승인")',
      'input[value="일괄승인"]',
      '[title="일괄승인"]',
    ]) {
      try {
        const el = frame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.click({ timeout: 5000 });
          approved = true;
          console.log('  일괄승인 클릭');
          break;
        }
      } catch {}
    }
    if (approved) break;
  }

  if (!approved) {
    await shot(page, '04_bulk_failed');
    throw new Error('일괄승인 버튼을 찾지 못했습니다.');
  }

  await page.waitForTimeout(1500);
  await shot(page, '04_done');
  console.log('  완료');
}

// ── 메인 ─────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page    = await context.newPage();
  context.on('page', p => p.on('dialog', d => d.accept().catch(() => {})));
  page.on('dialog', d => d.accept().catch(() => {}));

  try {
    await login(page);
    await navigateToPending(page);
    await filterByFormKeyword(page);
    await bulkApproveAll(page);
    console.log('\n✅ 완료!');
  } catch (err) {
    console.error(`\n[오류] ${err.message}`);
    await shot(page, 'error_state').catch(() => {});
    console.log('screenshots/error_state.png 확인');
  }

  await browser.close();
})();
