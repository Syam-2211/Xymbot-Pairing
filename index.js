import express from 'express';
import fs from 'fs';
import pino from 'pino';
import mongoose from 'mongoose';
import baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode';

const { default: makeWASocket, useMultiFileAuthState, delay, Browsers } = baileys;

const app = express();
const PORT = process.env.PORT || 8000;

// ─── MONGODB SETUP ─────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connected to MongoDB on Pairing Site'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    sessionData: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const licenseSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    expiresAt: Date,
    boundSession: { type: String, default: null }
});
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activePairings = new Map();

// ─── PAIRING SITE FRONTEND (Original Glassmorphism UI/UX) ───────────────────
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊 & Xymbot • Pairing Portal</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.1/anime.min.js"></script>
    <style>
        :root {
            --glass-bg: rgba(13, 17, 33, 0.65);
            --glass-border: rgba(0, 229, 255, 0.25);
            --accent-cyan: #00e5ff;
            --accent-blue: #3d7eff;
            --accent-glow: rgba(0, 229, 255, 0.2);
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: #070913;
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px 16px;
            overflow-x: hidden;
            position: relative;
        }
        .bg-video-container {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; overflow: hidden; z-index: -2;
        }
        .bg-video-container video {
            width: 100%; height: 100%; object-fit: cover; filter: brightness(0.35) contrast(1.2) saturate(1.3);
        }
        .bg-overlay {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: radial-gradient(circle at 50% 50%, rgba(9, 13, 26, 0.4) 0%, rgba(7, 9, 19, 0.85) 100%);
            z-index: -1;
        }
        .container {
            width: 100%; max-width: 500px;
            background: var(--glass-bg);
            border: 1.5px solid var(--glass-border);
            backdrop-filter: blur(30px);
            -webkit-backdrop-filter: blur(30px);
            border-radius: 28px;
            padding: 38px 30px;
            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.7), 0 0 40px var(--accent-glow), inset 0 0 25px rgba(255, 255, 255, 0.03);
            position: relative; overflow: hidden; opacity: 0;
        }
        .container::before {
            content: ''; position: absolute; top: -100px; left: 50%; transform: translateX(-50%);
            width: 250px; height: 250px; background: radial-gradient(circle, rgba(0,229,255,0.15) 0%, transparent 70%);
            pointer-events: none;
        }
        .header { text-align: center; margin-bottom: 26px; }
        .badge-logo {
            display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 99px;
            background: rgba(0, 229, 255, 0.08); border: 1px solid rgba(0, 229, 255, 0.25);
            font-size: 11px; font-weight: 700; color: var(--accent-cyan); letter-spacing: 0.5px; margin-bottom: 12px;
            box-shadow: 0 0 15px rgba(0, 229, 255, 0.15);
        }
        h1 {
            font-size: 26px; font-weight: 800; letter-spacing: -0.5px;
            background: linear-gradient(135deg, #ffffff 30%, #7dd3fc 70%, var(--accent-cyan) 100%);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px;
        }
        .subtitle { font-size: 13px; color: var(--text-muted); line-height: 1.5; }
        .tabs {
            display: flex; background: rgba(7, 9, 19, 0.75); border: 1px solid var(--glass-border);
            border-radius: 14px; padding: 4px; margin-bottom: 22px; gap: 4px;
        }
        .tab-btn {
            flex: 1; padding: 10px 14px; border: none; background: transparent; color: var(--text-muted);
            font-size: 13px; font-weight: 600; border-radius: 10px; cursor: pointer; transition: color 0.2s;
            display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .tab-btn.active {
            background: linear-gradient(135deg, rgba(0, 229, 255, 0.2), rgba(61, 126, 255, 0.25));
            color: #fff; border: 1px solid rgba(0, 229, 255, 0.35); box-shadow: 0 4px 15px rgba(0, 229, 255, 0.15);
        }
        .input-group { margin-bottom: 18px; text-align: left; }
        .input-group label {
            display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;
        }
        input {
            width: 100%; padding: 14px 16px; background: rgba(7, 9, 19, 0.85); border: 1px solid var(--glass-border);
            border-radius: 12px; color: #fff; font-size: 15px; font-weight: 500; outline: none;
            transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit;
        }
        input:focus { border-color: var(--accent-cyan); box-shadow: 0 0 0 3px rgba(0, 229, 255, 0.2); }
        .btn-primary {
            width: 100%; padding: 14px 20px;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-blue));
            border: none; border-radius: 12px; color: #070913; font-size: 15px; font-weight: 700;
            cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 8px 24px rgba(0, 229, 255, 0.25);
        }
        .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-secondary {
            width: 100%; padding: 12px 18px; background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--glass-border); border-radius: 12px; color: var(--text-main);
            font-size: 14px; font-weight: 600; cursor: pointer; display: inline-flex;
            align-items: center; justify-content: center; gap: 6px; transition: background 0.2s;
        }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }
        #display-section, #success-section { display: none; text-align: center; }
        .status-box {
            display: flex; align-items: center; justify-content: center; gap: 10px;
            padding: 12px 16px; border-radius: 12px; background: rgba(7, 9, 19, 0.8);
            border: 1px solid var(--glass-border); font-size: 13px; font-weight: 600; margin-bottom: 20px;
        }
        .spinner {
            width: 18px; height: 18px; border: 2px solid rgba(0,229,255,0.2);
            border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .code-box {
            background: rgba(0, 0, 0, 0.5); border: 1px dashed rgba(0, 229, 255, 0.5);
            border-radius: 16px; padding: 20px; font-family: 'JetBrains Mono', monospace;
            font-size: 30px; font-weight: 700; letter-spacing: 4px; color: var(--accent-cyan);
            margin-bottom: 12px; text-shadow: 0 0 15px rgba(0,229,255,0.4);
            animation: glow 2s ease-in-out infinite alternate;
        }
        @keyframes glow {
            from { text-shadow: 0 0 8px rgba(0,229,255,0.3); }
            to   { text-shadow: 0 0 22px rgba(0,229,255,0.7); }
        }
        .qr-card { background: #fff; padding: 12px; border-radius: 12px; display: inline-block; margin-bottom: 12px; }
        .qr-card img { width: 220px; height: 220px; display: block; }
        .hint-text { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
        .success-icon-wrap {
            width: 64px; height: 64px; border-radius: 50%; background: rgba(0, 240, 144, 0.15);
            border: 2px solid rgba(0, 240, 144, 0.3); display: flex; align-items: center; justify-content: center;
            font-size: 30px; margin: 0 auto 16px auto; color: #00f090; box-shadow: 0 0 30px rgba(0, 240, 144, 0.25);
        }
        .session-code-container {
            background: rgba(7, 9, 19, 0.9); border: 1px solid rgba(0, 229, 255, 0.3);
            border-radius: 14px; padding: 16px; margin: 18px 0; text-align: left;
        }
        .session-code-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .session-code-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--accent-cyan); letter-spacing: 0.5px; }
        .session-code-text {
            font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #e2e8f0;
            word-break: break-all; max-height: 110px; overflow-y: auto; line-height: 1.4; padding-right: 4px;
        }
        .instructions-list {
            text-align: left; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
            border-radius: 14px; padding: 16px; margin-bottom: 20px; font-size: 12px; color: var(--text-muted); line-height: 1.6;
        }
        .instructions-list strong { color: #fff; }
        .instructions-list ol { padding-left: 18px; }
        .instructions-list li { margin-bottom: 6px; }
        .instructions-list code {
            font-family: 'JetBrains Mono', monospace; color: var(--accent-cyan);
            background: rgba(0, 229, 255, 0.1); padding: 2px 5px; border-radius: 4px;
        }
        .footer { margin-top: 24px; text-align: center; font-size: 11px; color: rgba(148,163,184,0.6); }
    </style>
</head>
<body>
    <div class="bg-video-container">
        <video autoplay muted loop playsinline>
            <source src="https://assets.mixkit.co/videos/preview/mixkit-digital-animation-of-screens-and-numbers-31991-large.mp4" type="video/mp4">
        </video>
    </div>
    <div class="bg-overlay"></div>

    <div class="container" id="main-card">
        <div class="header">
            <div class="badge-logo">🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊 & Xymbot</div>
            <h1>Session Pairing Portal</h1>
            <p class="subtitle">Connect your custom WhatsApp session securely.</p>
        </div>

        <div id="setup-section">
            <div class="input-group">
                <label for="custom-session-input">Custom Session Name / ID</label>
                <input type="text" id="custom-session-input" placeholder="e.g. sneha-vip-bot" autocomplete="off">
            </div>

            <div class="tabs">
                <button class="tab-btn active" id="tab-code-btn" onclick="setMode('code')"><span>🔢</span> Pairing Code</button>
                <button class="tab-btn" id="tab-qr-btn" onclick="setMode('qr')"><span>📷</span> QR Code</button>
            </div>

            <div id="mode-code-box">
                <div class="input-group">
                    <label for="phone-input">WhatsApp Phone Number (+ Country Code)</label>
                    <input type="tel" id="phone-input" placeholder="e.g. 919876543210" autocomplete="tel">
                </div>
                <button class="btn-primary" id="btn-get-code" onclick="requestCode()">
                    <span>Request 8-Digit Code</span>
                </button>
            </div>

            <div id="mode-qr-box" style="display: none;">
                <p class="hint-text" style="margin-bottom: 16px;">Click below to generate a fresh QR code to scan from WhatsApp &gt; Linked Devices.</p>
                <button class="btn-primary" id="btn-get-qr" onclick="requestQR()">
                    <span>Generate QR Code</span>
                </button>
            </div>
        </div>

        <div id="display-section">
            <div class="status-box" id="status-card">
                <div class="spinner" id="status-spinner"></div>
                <span id="status-msg">Connecting to WhatsApp...</span>
            </div>

            <div id="code-view" style="display: none;">
                <div class="code-box" id="code-digits">----</div>
                <p class="hint-text">Open WhatsApp &gt; <strong>Linked Devices</strong> &gt; <strong>Link with phone number</strong> and enter this code.</p>
            </div>

            <div id="qr-view" style="display: none;">
                <div class="qr-card">
                    <img id="qr-image" alt="WhatsApp QR Code">
                </div>
                <p class="hint-text">Open WhatsApp &gt; <strong>Linked Devices</strong> &gt; <strong>Link a Device</strong> and point your camera here.</p>
            </div>

            <button class="btn-secondary" style="margin-top: 14px;" onclick="cancelPairing()">✕ Cancel & Try Again</button>
        </div>

        <div id="success-section">
            <div class="success-icon-wrap">✓</div>
            <h2 style="font-size: 22px; margin-bottom: 6px; color: #fff;">Pairing Successful!</h2>
            <p class="subtitle" style="margin-bottom: 16px;">Your custom bot session is ready.</p>

            <div class="session-code-container">
                <div class="session-code-header">
                    <span class="session-code-label">Session ID Token</span>
                    <button id="copy-btn" class="btn-secondary" style="padding: 4px 10px; font-size: 11px; width: auto;" onclick="copySessionId()">📋 Copy Code</button>
                </div>
                <div class="session-code-text" id="session-id-display"></div>
            </div>

            <div class="instructions-list">
                <div style="font-weight: 700; color: #fff; margin-bottom: 8px;">🚀 Next Steps:</div>
                <ol>
                    <li>Copy your custom <strong>Session ID</strong> above.</li>
                    <li>Set environment variable <code>SESSION_ID</code> in Render to this string.</li>
                    <li>Start your bot container!</li>
                </ol>
            </div>

            <button class="btn-primary" onclick="resetForm()">↻ Pair Another Number</button>
        </div>

        <div class="footer">Powered by Baileys Engine • 🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊 & Xymbot Ecosystem</div>
    </div>

    <script>
        document.addEventListener("DOMContentLoaded", () => {
            anime({ targets: '#main-card', opacity: [0, 1], translateY: [30, 0], duration: 1000, easing: 'easeOutExpo' });
        });

        let currentMode = 'code';
        let activeSessionId = null;
        let pollTimer = null;
        let currentRawSessionId = '';

        function setMode(mode) {
            currentMode = mode;
            document.getElementById('tab-code-btn').classList.toggle('active', mode === 'code');
            document.getElementById('tab-qr-btn').classList.toggle('active', mode === 'qr');
            document.getElementById('mode-code-box').style.display = (mode === 'code') ? 'block' : 'none';
            document.getElementById('mode-qr-box').style.display = (mode === 'qr') ? 'block' : 'none';
        }

        function setStatus(msg, isError = false, showSpinner = true) {
            const statusCard = document.getElementById('status-card');
            const statusMsg = document.getElementById('status-msg');
            const spinner = document.getElementById('status-spinner');
            statusMsg.innerText = msg;
            spinner.style.display = showSpinner ? 'block' : 'none';
            if (isError) {
                statusCard.style.borderColor = 'rgba(255,71,87,0.4)';
                statusCard.style.color = '#ff6b81';
            } else {
                statusCard.style.borderColor = 'var(--glass-border)';
                statusCard.style.color = 'var(--text-main)';
            }
        }

        async function requestCode() {
            const phoneInput = document.getElementById('phone-input').value.trim();
            const customSession = document.getElementById('custom-session-input').value.trim();
            const btn = document.getElementById('btn-get-code');

            if (!phoneInput) { alert('Please enter your phone number with country code!'); return; }
            btn.disabled = true;

            document.getElementById('setup-section').style.display = 'none';
            document.getElementById('display-section').style.display = 'block';
            document.getElementById('code-view').style.display = 'none';
            document.getElementById('qr-view').style.display = 'none';
            setStatus('Requesting 8-digit Pairing Code...');

            try {
                const res = await fetch(\`/pair?phone=\${encodeURIComponent(phoneInput)}&custom=\${encodeURIComponent(customSession)}\`);
                const data = await res.json();
                if (data.error) {
                    setStatus('❌ ' + data.error, true, false);
                    btn.disabled = false;
                    setTimeout(() => { document.getElementById('display-section').style.display = 'none'; document.getElementById('setup-section').style.display = 'block'; }, 3000);
                    return;
                }
                if (data.code && data.id) {
                    activeSessionId = data.id;
                    document.getElementById('code-digits').innerText = data.code;
                    document.getElementById('code-view').style.display = 'block';
                    setStatus('Waiting for you to enter code in WhatsApp...', false, true);
                    startStatusPolling(activeSessionId);
                }
            } catch (err) {
                setStatus('❌ Server connection error.', true, false);
                btn.disabled = false;
            }
        }

        async function requestQR() {
            const customSession = document.getElementById('custom-session-input').value.trim();
            const btn = document.getElementById('btn-get-qr');
            btn.disabled = true;

            document.getElementById('setup-section').style.display = 'none';
            document.getElementById('display-section').style.display = 'block';
            document.getElementById('code-view').style.display = 'none';
            document.getElementById('qr-view').style.display = 'none';
            setStatus('Generating QR Code...');

            try {
                const res = await fetch(\`/qr?custom=\${encodeURIComponent(customSession)}\`);
                const data = await res.json();
                if (data.error) {
                    setStatus('❌ ' + data.error, true, false);
                    btn.disabled = false;
                    return;
                }
                if (data.qr && data.id) {
                    activeSessionId = data.id;
                    document.getElementById('qr-image').src = data.qr;
                    document.getElementById('qr-view').style.display = 'block';
                    setStatus('Scan this QR code with WhatsApp...', false, true);
                    startStatusPolling(activeSessionId);
                }
            } catch (err) {
                setStatus('❌ Server connection error.', true, false);
                btn.disabled = false;
            }
        }

        function startStatusPolling(id) {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                if (!activeSessionId) { clearInterval(pollTimer); return; }
                try {
                    const res = await fetch(\`/status?id=\${encodeURIComponent(id)}\`);
                    const data = await res.json();
                    if (!data) return;
                    if (data.status === 'linking') {
                        setStatus(data.message || 'Linking WhatsApp account...', false, true);
                    } else if (data.status === 'waiting') {
                        if (data.qr && document.getElementById('qr-image').src !== data.qr) {
                            document.getElementById('qr-image').src = data.qr;
                        }
                    } else if (data.status === 'connected') {
                        clearInterval(pollTimer);
                        showSuccess(data.sessionId);
                    } else if (data.status === 'error') {
                        clearInterval(pollTimer);
                        setStatus('❌ ' + (data.error || 'Connection failed.'), true, false);
                        resetForm();
                    }
                } catch (e) {}
            }, 1500);
        }

        function showSuccess(sessionId) {
            currentRawSessionId = sessionId;
            document.getElementById('display-section').style.display = 'none';
            document.getElementById('setup-section').style.display = 'none';
            document.getElementById('success-section').style.display = 'block';
            document.getElementById('session-id-display').innerText = sessionId;
        }

        function copySessionId() {
            if (!currentRawSessionId) return;
            navigator.clipboard.writeText(currentRawSessionId).then(() => {
                const btn = document.getElementById('copy-btn');
                btn.innerText = '✅ Copied!';
                setTimeout(() => { btn.innerText = '📋 Copy Code'; }, 3000);
            });
        }

        function cancelPairing() {
            if (pollTimer) clearInterval(pollTimer);
            activeSessionId = null;
            resetForm();
        }

        function resetForm() {
            if (pollTimer) clearInterval(pollTimer);
            activeSessionId = null;
            currentRawSessionId = '';
            document.getElementById('btn-get-code').disabled = false;
            document.getElementById('display-section').style.display = 'none';
            document.getElementById('success-section').style.display = 'none';
            document.getElementById('setup-section').style.display = 'block';
        }

        document.getElementById('phone-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') requestCode();
        });
    </script>
</body>
</html>`);
});

// ─── PAIRING CODE BACKEND ROUTE ────────────────────────────────────────────
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: 'Phone number is required' });
    phone = phone.replace(/[^0-9]/g, '');

    const sessionId = 'session-' + Date.now();
    const sessionFolder = `./tmp/${sessionId}`;
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    activePairings.set(sessionId, { status: 'waiting', sessionId: null });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Desktop'),
        });

        if (!socket.authState.creds.registered) {
            await delay(1500);
            const code = await socket.requestPairingCode(phone);
            activePairings.set(sessionId, { status: 'waiting', code });

            res.json({ code, id: sessionId });
        }

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                await delay(3000);
                const files = fs.readdirSync(sessionFolder);
                const sessionObj = {};
                for (const file of files) {
                    if (file !== '.done') {
                        sessionObj[file] = fs.readFileSync(`${sessionFolder}/${file}`, 'utf8');
                    }
                }
                const base64Session = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
                const finalSessionId = 'XYMBOT~' + base64Session;

                if (process.env.MONGO_URI) {
                    await Session.create({ sessionId: finalSessionId, sessionData: base64Session })
                        .catch(err => console.error('MongoDB save error:', err.message));
                }

                activePairings.set(sessionId, { status: 'connected', sessionId: finalSessionId });
                try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
                socket.ws.close();
            } else if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code && code !== 440) {
                    activePairings.set(sessionId, { status: 'error', error: 'Connection closed or timeout' });
                }
            }
        });
    } catch (err) {
        console.error('Pairing error:', err);
        res.json({ error: 'Failed to generate pairing code' });
    }
});

// ─── QR CODE BACKEND ROUTE ─────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
    const sessionId = 'session-' + Date.now();
    const sessionFolder = `./tmp/${sessionId}`;
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    activePairings.set(sessionId, { status: 'waiting', qr: null });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Desktop'),
        });

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            if (qr) {
                const qrDataUrl = await qrcode.toDataURL(qr);
                activePairings.set(sessionId, { status: 'waiting', qr: qrDataUrl });
            }
            if (connection === 'open') {
                await delay(3000);
                const files = fs.readdirSync(sessionFolder);
                const sessionObj = {};
                for (const file of files) {
                    if (file !== '.done') {
                        sessionObj[file] = fs.readFileSync(`${sessionFolder}/${file}`, 'utf8');
                    }
                }
                const base64Session = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
                const finalSessionId = 'XYMBOT~' + base64Session;

                if (process.env.MONGO_URI) {
                    await Session.create({ sessionId: finalSessionId, sessionData: base64Session })
                        .catch(err => console.error('MongoDB save error:', err.message));
                }

                activePairings.set(sessionId, { status: 'connected', sessionId: finalSessionId });
                try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
                socket.ws.close();
            } else if (connection === 'close') {
                activePairings.set(sessionId, { status: 'error', error: 'QR session closed' });
            }
        });

        await delay(1000);
        const currentData = activePairings.get(sessionId) || {};
        res.json({ id: sessionId, qr: currentData.qr || null });
    } catch (err) {
        res.json({ error: 'Failed to generate QR code' });
    }
});

// ─── STATUS POLLING ROUTE ──────────────────────────────────────────────────
app.get('/status', (req, res) => {
    const id = req.query.id;
    if (!id || !activePairings.has(id)) {
        return res.json({ status: 'not_found' });
    }
    res.json(activePairings.get(id));
});

// ─── LICENSE VERIFICATION API ──────────────────────────────────────────────
app.get('/api/verify-license', async (req, res) => {
    try {
        const { key, session } = req.query;
        if (!key || !session) {
            return res.status(400).json({ valid: false, message: 'Missing key or session parameter' });
        }

        if (!process.env.MONGO_URI) {
            return res.json({ valid: true, message: 'MongoDB not connected. Skipping validation.' });
        }

        const license = await License.findOne({ key });
        if (!license) {
            return res.status(404).json({ valid: false, message: 'License key not found' });
        }

        if (license.expiresAt && license.expiresAt < new Date()) {
            return res.status(403).json({ valid: false, message: 'License key has expired' });
        }

        if (license.boundSession && license.boundSession !== session) {
            return res.status(403).json({ valid: false, message: 'License key is already in use by another bot' });
        }

        if (!license.boundSession) {
            license.boundSession = session;
            await license.save();
        }

        return res.json({ valid: true, message: 'License verified and secured' });
    } catch (error) {
        console.error('License API Error:', error);
        res.status(500).json({ valid: false, error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Pairing server live on port ${PORT}`);
});