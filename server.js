'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const INDEX_FILE = path.join(ROOT, 'index.html');

// ---------------------------------------------------------------------------
// データの読み書き（data.json に保存するのでアプリを閉じても消えない）
// ---------------------------------------------------------------------------

const EMPTY = { memos: [], tasks: [], reviews: [] };

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      memos: Array.isArray(parsed.memos) ? parsed.memos : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      // reviews は後から追加した項目なので、無い場合は空で始める
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('data.json を読み込めませんでした。空のデータで起動します:', err.message);
    }
    return { ...EMPTY };
  }
}

let data = loadData();

// 書き込みが重ならないように直列化し、一時ファイル経由で置き換える
let writeChain = Promise.resolve();

function saveData() {
  const snapshot = JSON.stringify(data, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => {
    console.error('data.json の保存に失敗しました:', err.message);
  });
  return writeChain;
}

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// 週の識別子は「その週の月曜日（YYYY-MM-DD）」に揃える
function toYmd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekStartOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 月曜まで戻す
  return toYmd(d);
}

// ---------------------------------------------------------------------------
// HTTP まわりの小さなヘルパー
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON の形式が正しくありません'));
      }
    });
    req.on('error', reject);
  });
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const method = req.method;

  // GET /api/data : メモとタスクをまとめて返す
  if (pathname === '/api/data' && method === 'GET') {
    return sendJson(res, 200, data);
  }

  // POST /api/memos : メモを追加
  if (pathname === '/api/memos' && method === 'POST') {
    const body = await readBody(req);
    const title = str(body.title);
    const text = str(body.body);
    if (!title && !text) {
      return sendJson(res, 400, { error: 'タイトルか本文のどちらかを入力してください' });
    }
    const memo = {
      id: newId(),
      title: title || '(無題)',
      body: text,
      createdAt: now(),
    };
    data.memos.unshift(memo);
    await saveData();
    return sendJson(res, 201, memo);
  }

  // POST /api/tasks : タスクを追加
  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    const title = str(body.title);
    if (!title) {
      return sendJson(res, 400, { error: 'タスク名を入力してください' });
    }
    const task = {
      id: newId(),
      title,
      done: false,
      createdAt: now(),
      completedAt: null,
    };
    data.tasks.unshift(task);
    await saveData();
    return sendJson(res, 201, task);
  }

  // POST /api/reviews : 週次の振り返りを記録（同じ週は上書き）
  if (pathname === '/api/reviews' && method === 'POST') {
    const body = await readBody(req);
    const weekStart = weekStartOf(body.weekStart);
    const comment = str(body.comment);
    if (!weekStart) {
      return sendJson(res, 400, { error: '週の指定が正しくありません' });
    }
    if (!comment) {
      return sendJson(res, 400, { error: '振り返りのコメントを入力してください' });
    }

    const existing = data.reviews.find((r) => r.weekStart === weekStart);
    let review;
    if (existing) {
      existing.comment = comment;
      existing.updatedAt = now();
      review = existing;
    } else {
      review = {
        id: newId(),
        weekStart,
        comment,
        createdAt: now(),
        updatedAt: null,
      };
      data.reviews.push(review);
    }
    // 新しい週が先頭に来るように並べ替える
    data.reviews.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
    await saveData();
    return sendJson(res, existing ? 200 : 201, review);
  }

  // PATCH /api/tasks/:id : 完了 / 未完了を切り替え
  // DELETE /api/tasks/:id : タスクを削除
  const taskMatch = pathname.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    const index = data.tasks.findIndex((t) => t.id === id);
    if (index === -1) {
      return sendJson(res, 404, { error: 'タスクが見つかりません' });
    }

    if (method === 'PATCH') {
      const body = await readBody(req);
      const task = data.tasks[index];
      task.done = typeof body.done === 'boolean' ? body.done : !task.done;
      task.completedAt = task.done ? now() : null;
      await saveData();
      return sendJson(res, 200, task);
    }

    if (method === 'DELETE') {
      const [removed] = data.tasks.splice(index, 1);
      await saveData();
      return sendJson(res, 200, removed);
    }
  }

  return sendJson(res, 404, { error: 'エンドポイントが見つかりません' });
}

// ---------------------------------------------------------------------------
// サーバー本体
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'URL が不正です' });
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 画面（index.html）だけを返すシンプルな構成
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(INDEX_FILE, (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html を読み込めませんでした');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      res.end(html);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('秘書アプリを起動しました');
  console.log(`  画面      : http://localhost:${PORT}`);
  console.log(`  保存先    : ${DATA_FILE}`);
  console.log('  終了する  : Ctrl + C');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。PORT=3001 のように別のポートを指定してください。`);
    process.exit(1);
  }
  throw err;
});
