// tiny built-in .env loader (no third-party dependency needed for this)
(function loadEnv() {
  const envPath = require('path').join(__dirname, '.env');
  if (!require('fs').existsSync(envPath)) return;
  require('fs').readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').trim();
  });
})();
const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const INVITE_CODE = process.env.INVITE_CODE || '4377';
const PORT = process.env.PORT || 3000;

if (!JWT_SECRET) {
  console.error('FATAL: set JWT_SECRET in .env before starting the server.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- uploads (avatars, story media, chat attachments) ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ---------- auth helpers ----------
function signToken(user) {
  return jwt.sign({ uid: user.id, name: user.display_name }, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name,
    avatar: row.avatar_url,
    status: row.status
  };
}

// ================= AUTH =================
app.post('/api/auth/register', (req, res) => {
  const { name, password, inviteCode, status } = req.body || {};
  if (inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'Wrong invite code' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const key = name.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(key);
  if (existing) return res.status(409).json({ error: 'That name is already taken' });

  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare(
    'INSERT INTO users (name, display_name, password_hash, status) VALUES (?,?,?,?)'
  ).run(key, name.trim(), hash, status && status.trim() ? status.trim() : "Hey there, I'm using Sketchgram!");

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const key = name.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(key);
  if (!user) return res.status(404).json({ error: 'No account with that name' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  res.json(publicUser(user));
});

app.put('/api/me', authMiddleware, (req, res) => {
  const { status, avatar } = req.body || {};
  if (status !== undefined) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.user.uid);
  if (avatar !== undefined) db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar, req.user.uid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  res.json(publicUser(user));
});

// ================= UPLOAD =================
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const kind = req.file.mimetype.startsWith('image/') ? 'image'
    : req.file.mimetype.startsWith('video/') ? 'video' : 'file';
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, kind });
});

// ================= USERS / CONTACTS =================
app.get('/api/users', authMiddleware, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const rows = db.prepare('SELECT * FROM users WHERE id != ? AND name LIKE ? LIMIT 50')
    .all(req.user.uid, `%${q}%`);
  res.json(rows.map(publicUser));
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(row));
});

// ================= THREADS / MESSAGES =================
function getOrCreateThread(userA, userB) {
  const a = Math.min(userA, userB), b = Math.max(userA, userB);
  let t = db.prepare('SELECT * FROM threads WHERE user_a = ? AND user_b = ?').get(a, b);
  if (!t) {
    const info = db.prepare('INSERT INTO threads (user_a, user_b) VALUES (?,?)').run(a, b);
    t = { id: info.lastInsertRowid, user_a: a, user_b: b };
  }
  return t;
}

app.get('/api/threads', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT t.id as threadId, u.* FROM threads t
     JOIN users u ON u.id = CASE WHEN t.user_a = ? THEN t.user_b ELSE t.user_a END
     WHERE t.user_a = ? OR t.user_b = ?`
  ).all(req.user.uid, req.user.uid, req.user.uid);
  res.json(rows.map(r => ({ threadId: r.threadId, user: publicUser(r) })));
});

app.get('/api/threads/:otherUserId/messages', authMiddleware, (req, res) => {
  const otherId = parseInt(req.params.otherUserId, 10);
  const t = getOrCreateThread(req.user.uid, otherId);
  const rows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC').all(t.id);
  res.json(rows.map(m => ({
    id: m.id,
    who: m.sender_id === req.user.uid ? 'me' : 'them',
    senderId: m.sender_id,
    text: m.text,
    attachments: m.attachments ? JSON.parse(m.attachments) : undefined,
    time: new Date(m.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    createdAt: m.created_at
  })));
});

app.post('/api/threads/:otherUserId/messages', authMiddleware, (req, res) => {
  const otherId = parseInt(req.params.otherUserId, 10);
  const { text, attachments } = req.body || {};
  if (!text && (!attachments || !attachments.length)) return res.status(400).json({ error: 'Empty message' });
  const t = getOrCreateThread(req.user.uid, otherId);
  const info = db.prepare('INSERT INTO messages (thread_id, sender_id, text, attachments) VALUES (?,?,?,?)')
    .run(t.id, req.user.uid, text || '', attachments ? JSON.stringify(attachments) : null);
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  const payload = {
    id: row.id,
    threadId: t.id,
    senderId: req.user.uid,
    recipientId: otherId,
    text: row.text,
    attachments,
    time: new Date(row.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    createdAt: row.created_at
  };
  io.to(`user:${otherId}`).emit('message', payload);
  io.to(`user:${req.user.uid}`).emit('message', payload); // echo to sender's other devices
  res.json(payload);
});

// ================= STORIES =================
app.post('/api/stories', authMiddleware, (req, res) => {
  const { kind, url } = req.body || {};
  if (!kind || !url) return res.status(400).json({ error: 'kind and url required' });
  db.prepare('INSERT INTO stories (user_id, kind, url) VALUES (?,?,?)').run(req.user.uid, kind, url);
  res.json({ ok: true });
});

app.get('/api/stories/:userId', authMiddleware, (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM stories WHERE user_id = ? AND expires_at > datetime('now') ORDER BY id DESC"
  ).all(req.params.userId);
  res.json(rows);
});

// ================= HTTP + SOCKET.IO =================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.uid}`);
  socket.broadcast.emit('presence', { userId: socket.user.uid, online: true });

  socket.on('typing', ({ toUserId }) => {
    io.to(`user:${toUserId}`).emit('typing', { fromUserId: socket.user.uid });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('presence', { userId: socket.user.uid, online: false });
  });
});

server.listen(PORT, () => console.log(`Sketchgram backend listening on :${PORT}`));
