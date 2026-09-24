# 🔗 Xymbot-Pairing — Full Project Memory & Context Prompt

> **Purpose:** Paste this entire document into any LLM (ChatGPT, Claude, Gemini, Grok, etc.) to give it complete working knowledge of this project.

---

## 1. What Is This Project?

**Xymbot-Pairing** is a standalone **WhatsApp session generator web app** built to support the **Xymbot** WhatsApp bot. It provides a web UI where users can either scan a **QR code** or enter a phone number to receive an **8-digit WhatsApp Pairing Code**. Once connected, the server packages the WhatsApp session credentials (`creds.json`) and sends them directly to the user as a downloadable `.zip` file on WhatsApp, along with a Base64-encoded session ID string.

**It is NOT the bot itself** — it is a companion pairing/session-provisioning service for Xymbot.

---

## 2. Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | **Node.js 20.14.0** |
| Web Server | **Express.js 4.x** |
| WhatsApp Lib | **@whiskeysockets/baileys** (latest) |
| QR Generation | **qrcode** (npm) |
| Zip Packaging | **adm-zip** |
| Archiver (alt) | **archiver** (installed but not currently used in code) |
| File System | **fs-extra** |
| Logging | **pino** (set to `silent`) |
| CORS | **cors** middleware |
| Frontend | Single-page **vanilla HTML/CSS/JS** (no framework) |

---

## 3. Project Structure

```
Xymbot-Pairing/
├── .node-version          # Node.js version: 20.14.0
├── package.json           # Dependencies & scripts
├── package-lock.json      # Lockfile
├── index.js               # Main server (Express + Baileys)
├── public/
│   └── index.html         # Frontend UI (single file, self-contained)
├── node_modules/          # Dependencies
└── README.md              # Deployment guide
```

---

## 4. Complete Source Code

### 4.1 `index.js` — Main Server

```javascript
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const AdmZip = require('adm-zip');
const path = require('path');
const cors = require('cors');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active connections to prevent memory leaks and handle reconnects
const activeSessions = {};

async function startAuth(id, type, res) {
    const sessionDir = path.join(__dirname, `session-${id}`);
    
    // Clear old corrupted sessions if this is a fresh request
    if (!activeSessions[id] && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Xymbot", "Desktop", "1.0.0"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    activeSessions[id] = conn;
    let isResponded = false; // Prevent sending multiple Express responses

    // If pairing code mode
    if (type === 'code') {
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await conn.requestPairingCode(id);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!isResponded) {
                        res.json({ code });
                        isResponded = true;
                    }
                } catch (err) {
                    console.error("Pairing Code Error:", err.message);
                    if (!isResponded) {
                        res.json({ error: "Failed to fetch code from WhatsApp servers. Please try again." });
                        isResponded = true;
                    }
                }
            }, 3000); 
        } else {
            if (!isResponded) {
                res.json({ error: "Already registered. Try a different number." });
                isResponded = true;
            }
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // If QR mode and QR is emitted
        if (type === 'qr' && qr && !isResponded) {
            try {
                const qrImage = await qrcode.toDataURL(qr);
                res.json({ qr: qrImage, id: id });
                isResponded = true;
            } catch (err) {
                res.json({ error: "Failed to generate QR Code image." });
                isResponded = true;
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Logged out for ${id}.`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[id];
            } else {
                console.log(`Connection dropped for ${id} (Reason: ${reason}). Reconnecting...`);
                // Auto-reconnect
                startAuth(id, type, { json: () => {} }); // Dummy res
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Sending creds...`);
            
            await delay(3000);

            try {
                const zipPath = path.join(__dirname, `session-${id}.zip`);
                const zip = new AdmZip();
                zip.addLocalFolder(sessionDir);
                zip.writeZip(zipPath);

                const userJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                
                await conn.sendMessage(userJid, {
                    document: fs.readFileSync(zipPath),
                    mimetype: 'application/zip',
                    fileName: 'Xymbot-Session.zip',
                    caption: '🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n*✅ Pairing Successful!*\n\nHere is your `session` zip file.\n\n*How to use:*\n1. Download this zip file.\n2. Extract it.\n3. Put the contents into your bot\'s `session` folder.\n4. Restart the bot.\n\n⚠️ *DO NOT SHARE THIS FILE WITH ANYONE!*'
                });

                const sessionFiles = fs.readdirSync(sessionDir);
                const sessionObj = {};
                for (const file of sessionFiles) {
                    if (file.endsWith('.json')) {
                        sessionObj[file] = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                    }
                }
                const base64Session = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
                await conn.sendMessage(userJid, {
                    text: `*Base64 Session ID:*\n\nXYMBOT~${base64Session}`
                });

                console.log(`Sent session files to ${id}. Cleaning up...`);
                
                fs.unlinkSync(zipPath);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[id];
                
                conn.end(new Error("Finished pairing"));
            } catch (err) {
                console.error("Archive error:", err);
            }
        }
    });
}

// Endpoint for 8-digit Pairing Code
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "Please provide a phone number." });
    phone = phone.replace(/[^0-9]/g, '');

    req.setTimeout(15000, () => res.json({ error: "WhatsApp servers took too long to respond. Try again." }));

    try { await startAuth(phone, 'code', res); } 
    catch (e) { res.json({ error: "Internal server error" }); }
});

// Endpoint for QR Code
app.get('/qr', async (req, res) => {
    let id = "QR-" + Date.now(); // Generate random session ID

    req.setTimeout(15000, () => res.json({ error: "WhatsApp servers took too long to respond. Try again." }));

    try { await startAuth(id, 'qr', res); } 
    catch (e) { res.json({ error: "Internal server error" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
});
```

### 4.2 `public/index.html` — Frontend UI

The frontend is a **single-page glassmorphism-styled UI** with:
- **Two tabs**: "Pairing Code" (default) and "QR Code"
- **Pairing Code tab**: Phone number input → calls `GET /pair?phone=<number>` → displays 8-digit code
- **QR Code tab**: Button → calls `GET /qr` → displays base64 QR image
- **Design**: Dark theme, gradient background (`#1e1e2f → #2a2a40`), cyan accent (`#00d2ff`), Inter font, blur/glassmorphism card
- **Loader spinner** and **status messages** (yellow=loading, green=success, red=error)

### 4.3 `package.json`

```json
{
  "name": "xymbot-pairing",
  "version": "1.0.0",
  "description": "Pairing Code generator for Xymbot",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "latest",
    "adm-zip": "^0.6.0",
    "archiver": "^8.0.0",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "fs-extra": "^11.2.0",
    "pino": "^9.0.0",
    "qrcode": "^1.5.4"
  }
}
```

---

## 5. API Endpoints

| Method | Endpoint | Description | Request | Response |
|--------|----------|-------------|---------|----------|
| `GET` | `/` | Serves the frontend `index.html` | — | HTML page |
| `GET` | `/pair?phone=<number>` | Requests an 8-digit pairing code | `phone` query param (digits only, e.g. `919876543210`) | `{ "code": "1234-5678" }` or `{ "error": "..." }` |
| `GET` | `/qr` | Generates a QR code for scanning | — | `{ "qr": "<base64 data URL>", "id": "QR-<timestamp>" }` or `{ "error": "..." }` |

**Timeout**: Both endpoints have a 15-second timeout.

---

## 6. How It Works (Flow)

```
User visits web UI
    ├── Option A: Enter phone number → GET /pair?phone=919876543210
    │   ├── Server creates Baileys socket with browser: ["Xymbot", "Desktop", "1.0.0"]
    │   ├── Waits 3 seconds, then calls conn.requestPairingCode(phone)
    │   ├── Returns formatted code (e.g. "1234-5678")
    │   └── User enters code in WhatsApp → Linked Devices
    │
    └── Option B: Click "Generate QR" → GET /qr
        ├── Server creates Baileys socket
        ├── Listens for 'qr' event in connection.update
        ├── Converts QR string to base64 image via qrcode.toDataURL()
        └── User scans QR in WhatsApp → Linked Devices

After connection opens:
    1. Wait 3 seconds
    2. Zip the entire session directory using AdmZip
    3. Send zip file to user's WhatsApp as a document
    4. Also send a Base64-encoded session string prefixed with "XYMBOT~"
    5. Clean up: delete zip, delete session folder, close connection
```

---

## 7. Commands

### Local Development
```bash
# Install dependencies
npm install

# Start the server
npm start
# Or directly:
node index.js

# Server runs on http://localhost:3000
```

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

---

## 8. Deployment

### Production URL
The project was deployed to **Render.com** at:
```
https://xymbot-pairing.onrender.com
```

### Deploy on Render.com (Recommended)
1. Fork the repository on GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect the forked repo
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. **Node version**: Specify `20.14.0` (`.node-version` file included)
7. Click Deploy

### Also considered (from past conversations):
- **Vercel** — discussed but Render was chosen (Vercel serverless doesn't work well with persistent WebSocket connections)
- **Koyeb / Railway** — mentioned as alternatives in README

---

## 9. Known Issues & Past Fixes (from development history)

1. **"Cannot GET /"** — Occurred when `public/index.html` was missing or Express static middleware wasn't configured. Fixed by adding `app.use(express.static(...))` and the root route handler.

2. **Pairing code buffering/not working** — Users experienced the pairing code request hanging. The 3-second delay before calling `requestPairingCode()` is critical — without it, Baileys hasn't finished initializing.

3. **QR code not working initially** — The original version only supported pairing codes. QR support was added later with a second tab, a `/qr` endpoint, and `qrcode.toDataURL()`.

4. **WhatsApp Web version issues** — Early versions used `@risaoffc/baileys` fork. The production version uses the standard `@whiskeysockets/baileys` with `latest`.

5. **Browser fingerprint** — Set to `["Xymbot", "Desktop", "1.0.0"]` to appear as a desktop device. Previously was default `Google Chrome(Ubuntu)` which the user requested changing.

6. **Session cleanup** — After successful pairing, the server deletes both the session directory and the zip file to prevent disk space issues on the hosting platform.

7. **Multiple response prevention** — The `isResponded` flag prevents Express from crashing with "headers already sent" errors when multiple events fire.

---

## 10. Relationship to Xymbot (Main Bot)

- **Xymbot** is a WhatsApp multi-device bot located at `c:\Users\Dell\OneDrive\Desktop\all-bots\Xymbot\`
- It uses `@whiskeysockets/baileys` and has a plugin-based command architecture
- The pairing server generates session credentials that users put into Xymbot's `session` folder
- The session output format includes:
  - A **zip file** containing all session JSON files (sent as WhatsApp document)
  - A **Base64 session string** prefixed with `XYMBOT~` (sent as text message)
- The bot's package.json originally had name `sneha-bot`

---

## 11. Important Design Decisions

- **Stateless per-request**: Each pairing request creates a fresh Baileys socket, pairs, sends credentials, and tears down. No persistent sessions on the server.
- **No database needed**: Everything is file-system based and ephemeral.
- **Self-contained frontend**: The entire UI is a single HTML file with inline CSS and JS — no build step needed.
- **Silent logging**: Pino logger is set to `silent` to keep production logs clean.
- **Auto-reconnect on disconnect**: If a connection drops (non-logout), it auto-retries with a dummy response object.
