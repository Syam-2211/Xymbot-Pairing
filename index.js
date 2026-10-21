import express from 'express';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
    Browsers,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path, { dirname } from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { verifyLicense as checkLicense, initTelegramBot } from './licenseManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Load .env without dotenv ──────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [k, ...v] = trimmed.split('=');
                if (k && !process.env[k.trim()]) {
                    process.env[k.trim()] = v.join('=').trim();
                }
            }
        }
    } catch (e) {
        console.warn('Could not read .env file:', e.message);
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Active sessions & real-time state store ───────────────────────────────────
const activeSessions = {};
const sessionStates  = {};

// Clean up stale session entries older than 20 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, state] of Object.entries(sessionStates)) {
        if (now - state.lastUpdated > 20 * 60 * 1000) {
            delete sessionStates[id];
            const sessionDir = path.join(__dirname, `session-${id}`);
            if (fs.existsSync(sessionDir)) {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    }
}, 5 * 60 * 1000);

// ── Core pairing function ─────────────────────────────────────────────────────
async function startAuth(id, onReady = null, isReconnect = false) {
    const sessionDir = path.join(__dirname, `session-${id}`);

    if (!isReconnect) {
        sessionStates[id] = {
            id,
            status: 'initializing',
            message: 'Initializing WhatsApp connection...',
            code: null,
            sessionId: null,
            error: null,
            lastUpdated: Date.now()
        };

        if (fs.existsSync(sessionDir)) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        }
    } else {
        if (sessionStates[id]) sessionStates[id].lastUpdated = Date.now();
    }

    let state, saveCreds;
    try {
        const authData = await useMultiFileAuthState(sessionDir);
        state     = authData.state;
        saveCreds = authData.saveCreds;
    } catch (err) {
        console.error(`Auth state error for ${id}:`, err.message);
        if (sessionStates[id]) {
            sessionStates[id].status = 'error';
            sessionStates[id].error  = 'Failed to initialize session directory.';
        }
        if (onReady) onReady({ error: 'Failed to initialize session directory.' });
        return;
    }

    // Fetch latest WA version with fallback
    let version = [2, 3000, 1043857760];
    try {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
    } catch (e) {
        console.warn('Could not fetch latest Baileys version, using fallback:', version);
    }

    const conn = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    activeSessions[id] = conn;
    let initialResponded = false;

    // ── Request pairing code ──────────────────────────────────────────────────
    if (!isReconnect) {
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await conn.requestPairingCode(id);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;

                    if (sessionStates[id]) {
                        sessionStates[id].status    = 'waiting';
                        sessionStates[id].code      = code;
                        sessionStates[id].message   = 'Pairing code generated. Enter this in WhatsApp.';
                        sessionStates[id].lastUpdated = Date.now();
                    }

                    if (onReady && !initialResponded) {
                        initialResponded = true;
                        onReady({ code, id });
                    }
                } catch (err) {
                    console.error(`Pairing Code Error for ${id}:`, err.message);
                    const errMsg = 'Failed to fetch pairing code from WhatsApp. Please try again.';
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'error';
                        sessionStates[id].error  = errMsg;
                        sessionStates[id].lastUpdated = Date.now();
                    }
                    if (onReady && !initialResponded) {
                        initialResponded = true;
                        onReady({ error: errMsg });
                    }
                }
            }, 3000);
        } else {
            const errMsg = 'Number already registered. Please use a different number or clear session.';
            if (sessionStates[id]) {
                sessionStates[id].status = 'error';
                sessionStates[id].error  = errMsg;
            }
            if (onReady && !initialResponded) {
                initialResponded = true;
                onReady({ error: errMsg });
            }
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            if (sessionStates[id] && sessionStates[id].status !== 'connected') {
                sessionStates[id].status    = 'linking';
                sessionStates[id].message   = 'Connecting to WhatsApp...';
                sessionStates[id].lastUpdated = Date.now();
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed for ${id} (code: ${statusCode})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`Device logged out for ${id}.`);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'error';
                    sessionStates[id].error  = 'Rejected or logged out by WhatsApp. Please try again.';
                    sessionStates[id].lastUpdated = Date.now();
                }
                if (fs.existsSync(sessionDir)) {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                }
                delete activeSessions[id];

                if (onReady && !initialResponded) {
                    initialResponded = true;
                    onReady({ error: 'Logged out. Please try again.' });
                }
            } else {
                // Non-logout disconnect → reconnect to finalize handshake
                console.log(`Handshake reconnect for ${id} (code: ${statusCode})`);
                if (sessionStates[id]) {
                    sessionStates[id].status  = 'linking';
                    sessionStates[id].message = 'Device detected! Finalizing encryption & session...';
                    sessionStates[id].lastUpdated = Date.now();
                }
                delete activeSessions[id];
                try { conn.end(); } catch (e) {}

                setTimeout(() => { startAuth(id, null, true); }, 1500);
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Packaging credentials...`);
            if (sessionStates[id]) {
                sessionStates[id].status  = 'linking';
                sessionStates[id].message = 'Pairing verified! Generating Session ID...';
                sessionStates[id].lastUpdated = Date.now();
            }

            await delay(2000);

            try {
                const credsPath = path.join(sessionDir, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const credsData     = fs.readFileSync(credsPath, 'utf8');
                    const base64Session = Buffer.from(credsData).toString('base64');
                    const sessionId     = `XYMBOT~${base64Session}`;

                    if (sessionStates[id]) {
                        sessionStates[id].status    = 'connected';
                        sessionStates[id].sessionId = sessionId;
                        sessionStates[id].message   = 'Pairing Successful!';
                        sessionStates[id].lastUpdated = Date.now();
                    }

                    // Attempt to DM the session ID to the user's WhatsApp
                    try {
                        const rawId        = conn.user?.id || '';
                        const normalizedJid = jidNormalizedUser(rawId) || (rawId.split(':')[0] + '@s.whatsapp.net');

                        const messageText =
                            `🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n` +
                            `*✅ Pairing Successful!*\n\n` +
                            `Here is your *SESSION ID* (tap and hold to copy):\n\n` +
                            `\`\`\`${sessionId}\`\`\`\n\n` +
                            `*How to use on Render:*\n` +
                            `1. Copy the SESSION ID above.\n` +
                            `2. Go to Render → Environment → set \`SESSION_ID\`\n` +
                            `3. Also set your \`LICENSE_KEY\` in Render environment.\n` +
                            `4. Redeploy → Your bot is live!\n\n` +
                            `⚠️ *DO NOT SHARE THIS SESSION ID WITH ANYONE!*`;

                        await conn.sendMessage(normalizedJid, { text: messageText });
                        console.log(`Session ID dispatched to WhatsApp user ${normalizedJid}`);
                    } catch (waErr) {
                        console.warn('Could not DM session (still available on web UI):', waErr.message);
                    }

                    // Cleanup after a safe delay
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(sessionDir)) {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                            }
                            delete activeSessions[id];
                            conn.end();
                        } catch (e) {}
                    }, 10000);
                } else {
                    console.error('creds.json not found in', sessionDir);
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'error';
                        sessionStates[id].error  = 'Credentials file was not created. Please try again.';
                    }
                }
            } catch (err) {
                console.error('Session processing error:', err);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'error';
                    sessionStates[id].error  = 'Failed to process session: ' + err.message;
                }
            }
        }
    });
}

// ── /pair — 8-digit pairing code endpoint ────────────────────────────────────
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: 'Please provide a phone number.' });
    phone = phone.replace(/[^0-9]/g, '');

    if (phone.length < 8) {
        return res.json({ error: 'Please enter a valid phone number with country code.' });
    }

    let responded = false;
    const timeout = setTimeout(() => {
        if (!responded) {
            responded = true;
            res.json({ error: 'WhatsApp servers took too long to respond. Please try again.' });
        }
    }, 20000);

    try {
        await startAuth(phone, (data) => {
            if (!responded) {
                responded = true;
                clearTimeout(timeout);
                res.json(data);
            }
        });
    } catch (e) {
        if (!responded) {
            responded = true;
            clearTimeout(timeout);
            res.json({ error: 'Internal server error: ' + e.message });
        }
    }
});

// ── /status — real-time polling endpoint ─────────────────────────────────────
app.get('/status', (req, res) => {
    const id = req.query.id;
    if (!id || !sessionStates[id]) {
        return res.json({ status: 'not_found', error: 'Session not found or expired.' });
    }
    const state = sessionStates[id];
    res.json({
        id:        state.id,
        status:    state.status,
        code:      state.code      || null,
        sessionId: state.sessionId || null,
        message:   state.message   || null,
        error:     state.error     || null
    });
});

// ── /api/verify-license — license verification endpoint ───────────────────────
app.get('/api/verify-license', (req, res) => {
    const key    = req.query.key;
    const result = checkLicense(key);
    res.json(result);
});

// ── /health — uptime monitor ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Xymbot Pairing Server running on port ${PORT}`);
    // Start embedded Telegram License Bot (only if TELEGRAM_BOT_TOKEN is set)
    initTelegramBot(app);
});
