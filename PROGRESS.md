# scan-docs.js 진행 현황

## 완료된 것

### 네비게이션 (goToPending)
- 로그인 → 라라스윗 포털 → 전자결재 클릭 → 결재 HOME → 미결문서 더보기 or 사이드바 → **완료**
- 최종 URL: `pageCode=UBA2020` (미결문서 목록 페이지 확인됨)
- `isHere()`: "일괄승인" 또는 "연속결재" 버튼 감지로 도착 확인
  - 주의: `text=/미결문서 \d+건/` 패턴은 결재 HOME 대시보드의 "미결문서 7건"에도 매칭되어 **제거함**

### DOM 구조 파악
- `tbody tr` → 0개 (이 ERP는 표준 HTML table 미사용)
- `[class*="row"]` → 579개 (레이아웃 row 포함 너무 많음)
- `li[class*="list"]` → 30개 ← **유력한 문서 행 후보**
- 페이지당 문서 30개인 것과 수 일치

## 남은 작업

### 1. getRows() 수정
현재 `tbody tr`으로 찾고 있어 0개 반환됨.  
→ `li[class*="list"]` 셀렉터로 교체 필요.  
→ `openPopup()`도 `row.locator('td').nth(2)` 대신 클릭 가능한 올바른 요소 찾기 필요.

### 2. 각 문서 팝업 열기
- 용도별합계 읽기 (`readUsageTotal`) → 이미 구현됨, 테스트 필요
- 스크린샷 저장 → 구현됨

### 3. Google Sheets 업로드
- `logToSheet` import 되어 있으나 호출 안 됨
- 각 문서 처리 후 `logToSheet({ total, attachment: null, match: false })` 추가 필요

## 확인된 파일 구조
```
c:\Users\zoeun2\erp-auto\
  scan-docs.js       ← 메인 스캔 스크립트
  approve.js         ← 일괄승인 스크립트 (네비게이션 참조용)
  sheets.js          ← Google Sheets 연동
  credentials.json   ← OAuth2 credentials
  .sheets-token.json ← 저장된 토큰
  scan-screenshots/  ← 스크린샷 저장 폴더
  scan-results.json  ← 스캔 결과 JSON
```

## 다음 실행 시 할 일
1. `getRows()`를 `li[class*="list"]`로 교체
2. `openPopup()`에서 클릭 대상 요소 수정
3. 스캔 실행하여 첫 번째 문서 팝업 열기 확인
4. `logToSheet` 연결
