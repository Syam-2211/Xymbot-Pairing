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
import mongoose from 'mongoose';
import { verifyLicense as checkLicense, initTelegramBot } from './licenseManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

<<<<<<< HEAD
// ─── MONGODB INTEGRATION ──────────────────────────────────────────────
// Make sure to add MONGO_URI in your Render Environment Variables!
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGO_URI environment variable is missing! Sessions will not save.');
} else {
    mongoose.connect(MONGO_URI)
      .then(() => console.log('✅ Connected to MongoDB Atlas'))
      .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

const SessionSchema = new mongoose.Schema({
    phrase: { type: String, required: true, unique: true },
    data: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const SessionModel = mongoose.model('Session', SessionSchema);

async function saveSessionPhrase(phrase, base64Data) {
    const cleanPhrase = phrase.toLowerCase().trim();
    try {
        await SessionModel.findOneAndUpdate(
            { phrase: cleanPhrase },
            { data: base64Data },
            { upsert: true, new: true }
        );
        console.log(`✅ Session saved to MongoDB for phrase: ${cleanPhrase}`);
    } catch (err) {
        console.error('❌ Failed to save session to MongoDB:', err);
    }
}

=======
// ─── CUSTOM SESSION PHRASE DATABASE HELPERS ─────────────────────────────────
const SESSIONS_DB_PATH = path.join(__dirname, 'session_phrases.json');

function loadSessionPhrases() {
    try {
        if (!fs.existsSync(SESSIONS_DB_PATH)) {
            fs.writeFileSync(SESSIONS_DB_PATH, JSON.stringify({}, null, 2), 'utf8');
            return {};
        }
        return JSON.parse(fs.readFileSync(SESSIONS_DB_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveSessionPhrase(phrase, base64Data) {
    const db = loadSessionPhrases();
    db[phrase.toLowerCase().trim()] = base64Data;
    fs.writeFileSync(SESSIONS_DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
const activeSessions = {};
const sessionStates = {};

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

async function startAuth(id, type, onReady = null, isReconnect = false, customPhrase = '') {
    const sessionDir = path.join(__dirname, `session-${id}`);

    if (!isReconnect) {
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

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

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

        if (type === 'code' && !isReconnect && !initialResponded) {
            if (!conn.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        if (initialResponded) return;
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
                }, 4000);
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
            console.log(`Connection closed for ${id} (statusCode:${statusCode})`);

            if (statusCode === DisconnectReason.loggedOut) {
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
                if (sessionStates[id]) {
                    sessionStates[id].status = 'linking';
                    sessionStates[id].message = 'Device detected! Finalizing encryption & session...';
                    sessionStates[id].lastUpdated = Date.now();
                }
                delete activeSessions[id];
                try { conn.end(); } catch (e) {}

                setTimeout(() => {
                    startAuth(id, type, null, true, customPhrase);
                }, 1500);
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Packaging credentials...`);
            if (sessionStates[id]) {
                sessionStates[id].status = 'linking';
<<<<<<< HEAD
                sessionStates[id].message = 'Pairing verified! Saving session to database...';
=======
                sessionStates[id].message = 'Pairing verified! Saving session...';
>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
                sessionStates[id].lastUpdated = Date.now();
            }

            await delay(2000);

            try {
                const credsPath = path.join(sessionDir, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    
                    // Bundle ALL session files, not just creds.json
                    const sessionFiles = fs.readdirSync(sessionDir);
                    const sessionObj = {};
                    for (const file of sessionFiles) {
                        const filePath = path.join(sessionDir, file);
                        if (fs.statSync(filePath).isFile()) {
                            const content = fs.readFileSync(filePath, 'utf8');
                            try {
                                sessionObj[file] = JSON.parse(content);
                            } catch (e) {
                                sessionObj[file] = content;
                            }
                        }
                    }
                    const base64Session = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
                    
                    // Fallback to xym-sneha-bot if the custom phrase is missing or fails
                    const finalPhrase = customPhrase || 'xym-sneha-bot';
<<<<<<< HEAD
                    
                    // Save to MongoDB
                    await saveSessionPhrase(finalPhrase, base64Session);

=======
                    saveSessionPhrase(finalPhrase, base64Session);

                    // Output the final custom phrase to the UI and WhatsApp
>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
                    const sessionId = finalPhrase;

                    if (sessionStates[id]) {
                        sessionStates[id].status = 'connected';
                        sessionStates[id].sessionId = sessionId;
                        sessionStates[id].message = 'Pairing Successful & Saved to DB!';
                        sessionStates[id].lastUpdated = Date.now();
                    }

                    try {
                        const rawId = conn.user?.id || '';
                        const normalizedJid = jidNormalizedUser(rawId) || (rawId.split(':')[0] + '@s.whatsapp.net');
                        
                        const messageText = `🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n*✅ Pairing Successful!*\n\nYour Custom Session Name:\n\n\`\`\`${sessionId}\`\`\``;

                        await conn.sendMessage(normalizedJid, { text: messageText });
                    } catch (waErr) {}

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
                    if (sessionStates[id]) {
                        sessionStates[id].status = 'error';
                        sessionStates[id].error = 'Credentials file was not created. Please try again.';
                    }
                }
            } catch (err) {
                if (sessionStates[id]) {
                    sessionStates[id].status = 'error';
                    sessionStates[id].error = 'Failed to process session: ' + err.message;
                }
            }
        }
    });
}

<<<<<<< HEAD
// ─── FETCH FROM MONGODB ───────────────────────────────────────────────
app.get('/api/get-session', async (req, res) => {
    const phrase = req.query.phrase;
    if (!phrase) return res.status(400).json({ error: 'Phrase parameter missing' });
    
    try {
        const sessionRecord = await SessionModel.findOne({ phrase: phrase.toLowerCase().trim() });
        if (!sessionRecord) {
            return res.status(404).json({ error: 'Session phrase not found or expired' });
        }
        res.json({ success: true, sessionData: sessionRecord.data });
    } catch (e) {
        console.error('DB Fetch Error:', e);
        res.status(500).json({ error: 'Database query failed' });
    }
=======
app.get('/api/get-session', (req, res) => {
    const phrase = req.query.phrase;
    if (!phrase) return res.status(400).json({ error: 'Phrase parameter missing' });
    
    const db = loadSessionPhrases();
    const sessionData = db[phrase.toLowerCase().trim()];

    if (!sessionData) {
        return res.status(404).json({ error: 'Session phrase not found or expired' });
    }

    res.json({ success: true, sessionData });
>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
});

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    let customPhrase = req.query.custom;

    if (!phone) return res.json({ error: 'Please provide a phone number.' });
    
<<<<<<< HEAD
=======
    // Default to xym-sneha-bot if nothing is typed
>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
    if (!customPhrase || customPhrase.trim() === '') {
        customPhrase = 'xym-sneha-bot';
    }
    
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
    }, 20000);

    try {
        await startAuth(phone, 'code', (data) => {
            if (!responded) {
                responded = true;
                clearTimeout(timeout);
                res.json(data);
            }
        }, false, customPhrase);
    } catch (e) {
        if (!responded) {
            responded = true;
            clearTimeout(timeout);
            res.json({ error: 'Internal server error: ' + e.message });
        }
    }
});

app.get('/qr', async (req, res) => {
    let customPhrase = req.query.custom;
    
<<<<<<< HEAD
=======
    // Default to xym-sneha-bot if nothing is typed
>>>>>>> a6edd02eac02eb368e1ec175d2d476808e5c0ec9
    if (!customPhrase || customPhrase.trim() === '') {
        customPhrase = 'xym-sneha-bot';
    }

    const id = 'QR-' + Date.now();

    let responded = false;
    const timeout = setTimeout(() => {
        if (!responded) {
            responded = true;
            res.json({ error: 'WhatsApp servers took too long to respond. Try again.' });
        }
    }, 20000);

    try {
        await startAuth(id, 'qr', (data) => {
            if (!responded) {
                responded = true;
                clearTimeout(timeout);
                res.json(data);
            }
        }, false, customPhrase);
    } catch (e) {
        if (!responded) {
            responded = true;
            clearTimeout(timeout);
            res.json({ error: 'Internal server error: ' + e.message });
        }
    }
});

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

app.get('/api/verify-license', (req, res) => {
    const key = req.query.key;
    const result = checkLicense(key);
    res.json(result);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
    initTelegramBot(app);
});