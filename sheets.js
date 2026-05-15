require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const url  = require('url');

const SPREADSHEET_ID = '13XkuqBavGmGReAzHkZ4lFsY77-Hw-ITBrj8eAfBm3EA';
const SCOPES         = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH     = path.join(__dirname, '.sheets-token.json');
const CREDS_PATH     = path.join(__dirname, 'credentials.json');

// 컬럼 정의: A~H
// A: No. | B: 품의번호 | C: 제목 | D: 용도별합계 | E: 첨부파일 확인금액 | F: 일치여부 | G: 차이금액 | H: 스캔일시
const HEADERS = ['No.', '품의번호', '제목', '용도별합계', '첨부파일 확인금액', '일치여부', '차이금액', '스캔일시'];
const COL_WIDTHS = [45, 160, 320, 120, 130, 90, 100, 170];

function fmt(n) {
  if (n == null) return '-';
  if (typeof n === 'number') return n.toLocaleString('ko-KR');
  return String(n);
}

async function getAuth() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error('credentials.json 없음');
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_id, client_secret } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/callback');

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2;
  }

  const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n========================================');
  console.log('브라우저에서 아래 URL을 열어 구글 계정 인증하세요:');
  console.log(authUrl);
  console.log('========================================\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const { code } = url.parse(req.url, true).query;
      res.end('<html><body><h2>인증 완료! 이 창을 닫으세요.</h2></body></html>');
      server.close();
      if (code) resolve(code); else reject(new Error('code 없음'));
    });
    server.listen(3001, () => console.log('인증 대기 중... (localhost:3001)'));
  });

  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('  토큰 저장 완료');
  return oAuth2;
}

// username에 해당하는 시트를 찾거나 새로 생성, sheetId 반환
async function getOrCreateSheet(sheets, username) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = meta.data.sheets.find(s => s.properties.title === username);
  if (existing) return existing.properties.sheetId;

  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: username } } }] },
  });
  console.log(`  [시트] "${username}" 시트 새로 생성`);
  return resp.data.replies[0].addSheet.properties.sheetId;
}

async function initSheet(username) {
  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetId = await getOrCreateSheet(sheets, username);
  const range   = `${username}!A:H`;

  // 기존 내용 초기화
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range });

  // 헤더 작성
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${username}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADERS] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        // 헤더 서식 (파란 배경, 흰 굵은 글씨)
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.26, green: 0.52, blue: 0.96 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
          },
        },
        // 헤더 행 높이
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 32 },
            fields: 'pixelSize',
          },
        },
        // 컬럼 너비
        ...COL_WIDTHS.map((px, col) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
            properties: { pixelSize: px },
            fields: 'pixelSize',
          },
        })),
        // 헤더 행 고정
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });

  console.log(`  [시트] 초기화 완료 (헤더 8열) → "${username}" 시트`);
}

async function logToSheet({ idx, docNum, title, usageTotal, attachTotal, match, diff, approved = false, username }) {
  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetId = await getOrCreateSheet(sheets, username);
  const now      = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const matchTxt = (usageTotal == null || attachTotal == null) ? '확인불가'
    : (match ? (approved ? '✅ 일치+승인완료' : '✅ 일치') : '❌ 불일치');

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${username}!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        idx,
        docNum  || '-',
        title   || '-',
        fmt(usageTotal),
        fmt(attachTotal),
        matchTxt,
        diff != null ? fmt(diff) : '-',
        now,
      ]],
    },
  });

  // 불일치 행: 일치여부(F열) 빨간 배경
  if (usageTotal != null && attachTotal != null && !match) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: idx, endRowIndex: idx + 1, startColumnIndex: 5, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 0.8, blue: 0.8 },
                textFormat: { bold: true },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        }],
      },
    });
  }

  console.log(`  [시트] ${idx}. ${docNum||'-'} | ${fmt(usageTotal)} | ${fmt(attachTotal)} | ${matchTxt}`);
}

module.exports = { logToSheet, initSheet };
