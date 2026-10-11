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
import qrcode from 'qrcode';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env variables without external dependency
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

// Active socket connections and state store for real-time frontend updates
const activeSessions = {};
const sessionStates = {};

// Clean up stale session entries older than 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, state] of Object.entries(sessionStates)) {
        if (now - state.lastUpdated > 15 * 60 * 1000) {
            delete sessionStates[id];
            const sessionDir = path.join(__dirname, `session-${id}`);
            if (fs.existsSync(sessionDir)) {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    }
}, 5 * 60 * 1000);

async function startAuth(id, type, onReady = null, isReconnect = false) {
    const sessionDir = path.join(__dirname, `session-${id}`);

    if (!isReconnect) {
        // Fresh start: reset state and remove any old session folder
        sessionStates[id] = {
            id,
            type,
            status: 'initializing',
            message: 'Initializing WhatsApp connection...',
            qr: null,
            code: null,
            sessionId: null,
            error: null,
            lastUpdated: Date.now()
        };

        if (fs.existsSync(sessionDir)) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        }
    } else {
        if (sessionStates[id]) {
            sessionStates[id].lastUpdated = Date.now();
        }
    }

    let state, saveCreds;
    try {
        const authData = await useMultiFileAuthState(sessionDir);
        state = authData.state;
        saveCreds = authData.saveCreds;
    } catch (err) {
        console.error(`Auth state error for ${id}:`, err.message);
        if (sessionStates[id]) {
            sessionStates[id].status = 'error';
            sessionStates[id].error = 'Failed to initialize session directory.';
        }
        if (onReady) onReady({ error: 'Failed to initialize session directory.' });
        return;
    }

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
        markOnlineOnConnect: false
    });

    activeSessions[id] = conn;
    let initialResponded = false;

    // Handle Pairing Code mode
    if (type === 'code' && !isReconnect) {
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await conn.requestPairingCode(id);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'waiting';
                        sessionStates[id].code = code;
                        sessionStates[id].message = 'Pairing code generated. Enter this in WhatsApp.';
                        sessionStates[id].lastUpdated = Date.now();
                    }

                    if (onReady && !initialResponded) {
                        initialResponded = true;
                        onReady({ code, id });
                    }
                } catch (err) {
                    console.error(`Pairing Code Error for ${id}:`, err.message);
                    const errMsg = 'Failed to fetch code from WhatsApp servers. Please try again.';
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'error';
                        sessionStates[id].error = errMsg;
                        sessionStates[id].lastUpdated = Date.now();
                    }
                    if (onReady && !initialResponded) {
                        initialResponded = true;
                        onReady({ error: errMsg });
                    }
                }
            }, 3000);
        } else {
            const errMsg = 'Number is already registered. Please use another number or clear session.';
            if (sessionStates[id]) {
                sessionStates[id].status = 'error';
                sessionStates[id].error = errMsg;
            }
            if (onReady && !initialResponded) {
                initialResponded = true;
                onReady({ error: errMsg });
            }
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Whenever a new/refreshed QR code is emitted
        if (type === 'qr' && qr) {
            try {
                const qrImage = await qrcode.toDataURL(qr);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'waiting';
                    sessionStates[id].qr = qrImage;
                    sessionStates[id].message = 'Scan this QR code with WhatsApp.';
                    sessionStates[id].lastUpdated = Date.now();
                }

                if (onReady && !initialResponded) {
                    initialResponded = true;
                    onReady({ qr: qrImage, id });
                }
            } catch (err) {
                if (onReady && !initialResponded) {
                    initialResponded = true;
                    onReady({ error: 'Failed to generate QR Code image.' });
                }
            }
        }

        if (connection === 'connecting') {
            if (sessionStates[id] && sessionStates[id].status !== 'connected') {
                sessionStates[id].status = 'linking';
                sessionStates[id].message = 'Connecting to WhatsApp...';
                sessionStates[id].lastUpdated = Date.now();
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed for ${id} (statusCode: ${statusCode}, reason: ${lastDisconnect?.error?.message || 'unknown'})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`Device logged out or unlinked for ${id}.`);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'error';
                    sessionStates[id].error = 'Logged out or rejected by WhatsApp device. Please try again.';
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
                // Handshake reconnect (428 connectionClosed, 515 restartRequired, 408 timeout, etc.)
                // DO NOT DELETE sessionDir! Preserve credentials to finalize handshake.
                console.log(`Handshake reconnection for ${id} (statusCode: ${statusCode}). Re-establishing connection...`);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'linking';
                    sessionStates[id].message = 'Device detected! Finalizing encryption & session...';
                    sessionStates[id].lastUpdated = Date.now();
                }
                delete activeSessions[id];
                try { conn.end(); } catch (e) {}

                setTimeout(() => {
                    startAuth(id, type, null, true);
                }, 1500);
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Packaging credentials...`);
            if (sessionStates[id]) {
                sessionStates[id].status = 'linking';
                sessionStates[id].message = 'Pairing verified! Generating Base64 Session ID...';
                sessionStates[id].lastUpdated = Date.now();
            }

            await delay(2000);

            try {
                const credsPath = path.join(sessionDir, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const credsData = fs.readFileSync(credsPath, 'utf8');
                    const base64Session = Buffer.from(credsData).toString('base64');
                    const sessionId = `XYMBOT~${base64Session}`;

                    // Update session state for frontend polling
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'connected';
                        sessionStates[id].sessionId = sessionId;
                        sessionStates[id].message = 'Pairing Successful!';
                        sessionStates[id].lastUpdated = Date.now();
                    }

                    // Attempt to send session ID to user's WhatsApp self-chat as convenience
                    try {
                        const rawId = conn.user?.id || '';
                        const normalizedJid = jidNormalizedUser(rawId) || (rawId.split(':')[0] + '@s.whatsapp.net');
                        
                        const messageText = `🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n*✅ Pairing Successful!*\n\nHere is your *SESSION ID* (tap and hold to copy):\n\n\`\`\`${sessionId}\`\`\`\n\n*How to use:*\n1. Copy the code above.\n2. In your bot's \`config.js\`, set:\n\`\`\`global.SESSION_ID = "${sessionId}";\`\`\`\n(or set \`SESSION_ID\` in your environment variables / .env).\n3. Start the bot (\`npm start\` or \`node index.js\`).\n\n⚠️ *DO NOT SHARE THIS SESSION ID WITH ANYONE!*`;

                        await conn.sendMessage(normalizedJid, { text: messageText });
                        console.log(`Dispatched Session ID to WhatsApp user ${normalizedJid}`);
                    } catch (waErr) {
                        console.warn('Could not dispatch message over WhatsApp (Session ID is available on web UI):', waErr.message);
                    }

                    // Delay session directory cleanup to ensure safe write & read
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(sessionDir)) {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                            }
                            delete activeSessions[id];
                            conn.end();
                        } catch (e) {}
                    }, 8000);
                } else {
                    console.error('creds.json not found in', sessionDir);
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'error';
                        sessionStates[id].error = 'Credentials file was not created. Please try again.';
                    }
                }
            } catch (err) {
                console.error('Session processing error:', err);
                if (sessionStates[id]) {
                    sessionStates[id].status = 'error';
                    sessionStates[id].error = 'Failed to process session: ' + err.message;
                }
            }
        }
    });
}

// Endpoint for 8-digit Pairing Code
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
            res.json({ error: 'WhatsApp servers took too long to respond. Try again.' });
        }
    }, 15000);

    try {
        await startAuth(phone, 'code', (data) => {
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

// Endpoint for QR Code
app.get('/qr', async (req, res) => {
    const id = 'QR-' + Date.now();

    let responded = false;
    const timeout = setTimeout(() => {
        if (!responded) {
            responded = true;
            res.json({ error: 'WhatsApp servers took too long to respond. Try again.' });
        }
    }, 15000);

    try {
        await startAuth(id, 'qr', (data) => {
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

// Polling endpoint for real-time status & session delivery
app.get('/status', (req, res) => {
    const id = req.query.id;
    if (!id || !sessionStates[id]) {
        return res.json({ status: 'not_found', error: 'Session not found or expired.' });
    }

    const state = sessionStates[id];
    res.json({
        id: state.id,
        type: state.type,
        status: state.status,
        code: state.code || null,
        qr: state.qr || null,
        sessionId: state.sessionId || null,
        message: state.message || null,
        error: state.error || null
    });
});

// Endpoint to verify License Key
app.get('/api/verify-license', (req, res) => {
    const key = req.query.key;
    if (!key) {
        return res.json({ valid: false, error: 'License Key missing' });
    }

    // Default recognized keys + environment configured keys
    const validKeysStr = process.env.VALID_KEYS || 'CLIENT001,XYM-BOT-PAIR,XYMBOT-FREE,DEFAULT';
    const validKeys = validKeysStr.split(',').map(k => k.trim()).filter(k => k);

    if (validKeys.includes(key)) {
        return res.json({ valid: true, message: 'License verified successfully.' });
    } else {
        return res.json({ valid: false, error: 'Invalid License Key' });
    }
});

// Health check endpoint for uptime monitors
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
});
