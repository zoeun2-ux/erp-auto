const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/run', (req, res) => {
  const { username, password, formKeyword } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const env = {
    ...process.env,
    ERP_USERNAME: username,
    ERP_PASSWORD: password,
    FORM_KEYWORD: formKeyword || '(신규) 지출결의서',
  };

  const child = spawn('node', ['scan-docs.js'], {
    env,
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    });
  });

  child.stderr.on('data', (data) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) res.write(`data: [오류] ${line}\n\n`);
    });
  });

  child.on('close', (code, signal) => {
    if (code === 0) {
      res.write(`data: ✅ 자동화 완료!\n\n`);
    } else {
      res.write(`data: ❌ 오류 발생 (코드: ${code}, 시그널: ${signal})\n\n`);
    }
    res.write(`data: __DONE__\n\n`);
    res.end();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 시작됨: http://localhost:${PORT}`);
});
