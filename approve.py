import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

load_dotenv()

URL      = os.getenv("ERP_URL", "https://erp.lalasweet.kr/")
USERNAME = os.getenv("ERP_USERNAME", "zoeun2")
PASSWORD = os.getenv("ERP_PASSWORD", "1234")
KEYWORD  = os.getenv("KEYWORD", "지출결의서_선급금")

SS = Path("screenshots")
SS.mkdir(exist_ok=True)


async def shot(page, name):
    await page.screenshot(path=str(SS / f"{name}.png"), full_page=False)
    print(f"  [스크린샷] {name}.png")


async def try_fill(page, selectors: list[str], value: str):
    for sel in selectors:
        try:
            el = page.locator(sel).first
            if await el.count() > 0:
                await el.fill(value)
                return sel
        except Exception:
            continue
    raise RuntimeError(f"입력 필드를 찾지 못했습니다. 시도한 셀렉터: {selectors}")


async def try_click(page, selectors: list[str], description: str = ""):
    for sel in selectors:
        try:
            el = page.locator(sel).first
            if await el.count() > 0:
                await el.click()
                return sel
        except Exception:
            continue
    raise RuntimeError(f"'{description}' 버튼/링크를 찾지 못했습니다. 시도한 셀렉터: {selectors}")


async def login(page):
    print("\n[1] 로그인 중...")
    await page.goto(URL, wait_until="domcontentloaded")
    await page.wait_for_timeout(2000)
    await shot(page, "01_login_page")

    await try_fill(page, [
        'input[name="userId"]',
        'input[name="user_id"]',
        'input[name="loginId"]',
        'input[id="userId"]',
        'input[id="user_id"]',
        'input[id="loginId"]',
        'input[type="text"]:visible',
    ], USERNAME)

    await try_fill(page, [
        'input[type="password"]',
        'input[name="password"]',
        'input[name="passwd"]',
        'input[id="password"]',
    ], PASSWORD)

    await shot(page, "02_credentials_filled")

    await try_click(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("로그인")',
        'a:has-text("로그인")',
        '.btn-login',
        '#btnLogin',
    ], "로그인 버튼")

    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(2000)
    await shot(page, "03_after_login")
    print("  로그인 완료")


async def navigate_to_pending(page):
    print("\n[2] 전자결재 > 결재수신함 > 미결문서 이동 중...")

    # 전자결재 메뉴 클릭
    await try_click(page, [
        'text=전자결재',
        'a:has-text("전자결재")',
        'li:has-text("전자결재")',
        '[title="전자결재"]',
        'span:has-text("전자결재")',
    ], "전자결재 메뉴")
    await page.wait_for_timeout(1500)
    await shot(page, "04_approval_menu")

    # 결재수신함 클릭
    await try_click(page, [
        'text=결재수신함',
        'a:has-text("결재수신함")',
        'li:has-text("결재수신함")',
        '[title="결재수신함"]',
        'span:has-text("결재수신함")',
    ], "결재수신함")
    await page.wait_for_timeout(1500)
    await shot(page, "05_inbox")

    # 미결문서 탭/메뉴 클릭
    await try_click(page, [
        'text=미결문서',
        'a:has-text("미결문서")',
        'li:has-text("미결문서")',
        '[title="미결문서"]',
        'span:has-text("미결문서")',
    ], "미결문서")
    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(2000)
    await shot(page, "06_pending_docs")
    print("  미결문서 화면 진입 완료")


async def approve_matching(page):
    print(f"\n[3] 키워드 '{KEYWORD}' 포함 문서 검색 중...")

    # iframe 안에 목록이 있을 수 있으므로 frame 포함 탐색
    frames = [page] + list(page.frames)

    checked = 0
    for frame in frames:
        try:
            rows = await frame.locator("tr").all()
        except Exception:
            continue

        for row in rows:
            try:
                text = await row.inner_text()
            except Exception:
                continue

            if KEYWORD not in text:
                continue

            # 행에서 맨 왼쪽 체크박스 클릭
            checkbox = row.locator('input[type="checkbox"]').first
            if await checkbox.count() == 0:
                # td 첫 번째 셀의 체크박스 시도
                checkbox = row.locator("td:first-child input").first

            if await checkbox.count() > 0:
                is_checked = await checkbox.is_checked()
                if not is_checked:
                    await checkbox.click()
                    checked += 1
                    print(f"  체크: {text[:60].strip()}")

    if checked == 0:
        print(f"  '{KEYWORD}' 키워드가 포함된 미결문서를 찾지 못했습니다.")
        await shot(page, "07_no_match")
        return False

    print(f"  총 {checked}건 체크 완료")
    await shot(page, "07_checked")
    return True


async def bulk_approve(page):
    print("\n[4] 일괄승인 버튼 클릭 중...")

    frames = [page] + list(page.frames)
    for frame in frames:
        try:
            btn = frame.locator(
                'button:has-text("일괄승인"), '
                'a:has-text("일괄승인"), '
                'input[value="일괄승인"], '
                'span:has-text("일괄승인")'
            ).first
            if await btn.count() > 0:
                await btn.click()
                await page.wait_for_timeout(2000)
                await shot(page, "08_after_bulk_approve")
                print("  일괄승인 버튼 클릭 완료")

                # 확인 다이얼로그가 뜰 경우 자동 수락
                try:
                    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
                except Exception:
                    pass

                await page.wait_for_timeout(2000)
                await shot(page, "09_final")
                return True
        except Exception:
            continue

    print("  일괄승인 버튼을 찾지 못했습니다. 스크린샷을 확인하세요.")
    return False


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=300)
        context = await browser.new_context(viewport={"width": 1600, "height": 900})
        page = await context.new_page()

        # 팝업 다이얼로그 자동 수락
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        try:
            await login(page)
            await navigate_to_pending(page)
            found = await approve_matching(page)
            if found:
                await bulk_approve(page)
            print("\n완료. screenshots/ 폴더에서 각 단계 스크린샷을 확인하세요.")
        except RuntimeError as e:
            print(f"\n[오류] {e}")
            await shot(page, "error_state")
            print("screenshots/ 폴더의 스크린샷을 보고 셀렉터를 수정해 주세요.")
        finally:
            input("\n브라우저를 닫으려면 Enter를 누르세요...")
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
