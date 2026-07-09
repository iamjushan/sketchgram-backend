# Sketchgram backend — setup

## What this is
A real Express + SQLite + Socket.IO backend replacing the old in-memory
`accounts`/`messages` JS objects that reset every refresh. Passwords are
bcrypt-hashed, sessions are JWTs, messages persist in SQLite, and new
messages push to the other person's device instantly over a socket
(no polling).

## Run it locally
```
tar -xzf sketchgram-backend.tar.gz
cd sketchgram-backend
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a long random string (e.g. `openssl rand -hex 32`)
# change INVITE_CODE if you don't want it to stay 4377
node server.js
```
Server listens on :3000 (or $PORT). SQLite file `sketchgram.db` and uploaded
media in `uploads/` are created next to `server.js` — back those up, that's
your actual data.

## Point the frontend at it
Open `sketchgram.html`. By default it talks to `http://localhost:3000`.
To use a deployed backend, add this line **above** the existing
`<script>` block, before it runs:
```html
<script>window.SKETCHGRAM_API = "https://your-backend-domain.com";</script>
```

## Deploying so it's reachable from other devices
`localhost:3000` only works on the same machine. For real cross-device sync
you need to host `server.js` somewhere with a public URL (Railway, Render,
Fly.io, a VPS, etc.) and put that URL in `SKETCHGRAM_API`. Any of those work
fine — this is a plain Node/Express app, nothing platform-specific. Put
`sketchgram.html` on any static host (Netlify, Vercel, GitHub Pages, or the
same server) pointed at that API URL.

## What changed vs. the file you uploaded
- **Removed**: the hardcoded admin backdoor that dumped every user's
  plaintext password and private photos to whoever was logged in as
  "jushan sinha." That's gone. Passwords are now bcrypt-hashed and never
  leave the server, admin or not.
- **Fixed**: a duplicate `function applyOwnProfile(){}` declaration bug
  in the original file — JS hoists duplicate function declarations, so the
  second one silently overwrote the first everywhere, which meant your own
  name/avatar never actually rendered after login (it just said "You").
  This was a bug in the file before I touched it.
- **Added**: real register/login/session, contact sync, message persistence
  + realtime delivery, avatar/story upload, and a "New chat" option (the
  original had no way to add a contact at all — `chats` was hardcoded empty).

## Tested
Registered two accounts, logged in from two separate simulated sessions,
had one send a message to the other, and confirmed it appeared on the
second session instantly via the socket — with zero manual refresh. Session
persistence across reload (closing and reopening with just the saved token,
no re-login) also confirmed. This was run against the actual page JS in
`sketchgram.html`, not a mock.

Not tested: actual mobile Safari/Chrome PWA install behavior, or a real
production deployment (I don't have a domain to deploy to for you) —
you'll want to smoke-test after deploying.
