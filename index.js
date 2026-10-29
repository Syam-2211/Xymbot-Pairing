import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import makeWASocket, {
    useMultiFileAuthState,
    delay,
    Browsers
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { generateRandomKey, verifyLicense } from './licenseManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// ─── MONGODB SETUP ─────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connected to MongoDB'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    sessionName: { type: String, unique: true, sparse: true },
    sessionData: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const licenseSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date,
    boundSession: { type: String, default: null }
});
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve public static assets
app.use(express.static(path.join(__dirname, 'public')));

const activePairings = new Map();

// ─── PAGE ROUTING CONFIGURATION ────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'site.html'));
});

app.get('/license-portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'license.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// ─── LICENSE API ENDPOINTS ─────────────────────────────────────────────────
app.get('/api/verify-license', async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) {
            return res.json({ valid: false, message: 'License key is missing.' });
        }

        const license = await License.findOne({ key: key.trim().toUpperCase() });
        if (!license) {
            return res.json({ valid: false, message: 'Invalid License Key.' });
        }

        const isExpired = license.expiresAt && new Date(license.expiresAt) < new Date();
        if (isExpired) {
            return res.json({ valid: false, message: 'License key has expired.' });
        }

        res.json({ valid: true, message: 'License verified successfully.', expiresAt: license.expiresAt });
    } catch (err) {
        console.error('License check error:', err);
        res.status(500).json({ valid: false, message: 'Internal server error.' });
    }
});

app.post('/api/client-generate-key', async (req, res) => {
    try {
        if (!process.env.MONGO_URI || mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB connection required to generate keys.' });
        }

        const key = generateRandomKey();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days validity

        await License.create({
            key,
            expiresAt,
            boundSession: null
        });

        res.json({ success: true, key });
    } catch (err) {
        console.error('Key generation error:', err);
        res.status(500).json({ error: 'Failed to generate license key.' });
    }
});

// ─── WHATSAPP PAIRING LOGIC HELPER ─────────────────────────────────────────
function startPairingSocket({ sessionId, sessionName, sessionFolder, state, saveCreds, generateQr }) {
    let socket;
    let restartCount = 0;
    let completed = false;
    let saveCredentials = Promise.resolve();
    let saveError;

    const start = () => {
        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            browser: Browsers.windows('Desktop'),
            syncFullHistory: false,
        });

        const currentSocket = socket;
        currentSocket.ev.on('creds.update', (update) => {
            saveCredentials = saveCredentials.then(() => saveCreds(update)).catch((error) => {
                saveError = error;
                console.error(`Could not save credentials for session ${sessionId}:`, error);
            });
        });

        currentSocket.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            try {
                if (currentSocket !== socket || completed) return;
                if (qr && generateQr) {
                    const qrDataUrl = await qrcode.toDataURL(qr);
                    activePairings.set(sessionId, { status: 'waiting', qr: qrDataUrl });
                }
                if (connection === 'open') {
                    await saveCredentials;
                    if (saveError) throw new Error('Could not save WhatsApp session credentials');
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

                    if (!process.env.MONGO_URI || mongoose.connection.readyState !== 1) {
                        throw new Error('MongoDB is required to save named pairing sessions.');
                    }
                    await Session.create({
                        sessionId: finalSessionId,
                        sessionName,
                        sessionData: base64Session
                    });

                    completed = true;
                    activePairings.set(sessionId, { status: 'connected', sessionName });
                    try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (error) {}
                    currentSocket.ws.close();
                } else if (connection === 'close') {
                    if (activePairings.get(sessionId)?.status === 'connected') return;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const detail = lastDisconnect?.error?.message || 'WhatsApp connection closed';
                    if (statusCode === 515 && restartCount < 3) {
                        restartCount += 1;
                        activePairings.set(sessionId, {
                            status: 'linking',
                            message: 'WhatsApp is restarting the pairing connection...'
                        });
                        await saveCredentials;
                        if (saveError) throw new Error('Could not save credentials before reconnecting');
                        await delay(250);
                        if (!completed && currentSocket === socket) start();
                        return;
                    }

                    const reason = statusCode ? ` (${statusCode})` : '';
                    console.error(`Pairing session ${sessionId} closed${reason}: ${detail}`);
                    activePairings.set(sessionId, {
                        status: 'error',
                        error: `Connection closed${reason}: ${detail}`
                    });
                }
            } catch (error) {
                console.error(`Pairing session ${sessionId} failed:`, error);
                const duplicateSessionName = error?.code === 11000;
                activePairings.set(sessionId, {
                    status: 'error',
                    error: duplicateSessionName
                        ? 'This custom session name is already in use. Choose a different name and try again.'
                        : error.message || 'Failed to save or complete the WhatsApp session.'
                });
            }
        });

        return currentSocket;
    };

    return start();
}

function normalizeSessionName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{2,39}$/.test(name) ? name : null;
}

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    phone = phone.replace(/[^0-9]/g, '');
    const sessionName = normalizeSessionName(req.query.custom);
    if (!sessionName) return res.status(400).json({ error: 'Enter a valid custom session name (3-40 alphanumeric chars).' });

    const sessionId = 'session-' + Date.now();
    const sessionFolder = `./tmp/${sessionId}`;
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    activePairings.set(sessionId, { status: 'waiting' });

    try {
        if (!process.env.MONGO_URI || mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB is required for named sessions.' });
        }
        if (await Session.exists({ sessionName })) {
            return res.status(409).json({ error: 'This custom session name is already in use.' });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const socket = startPairingSocket({ sessionId, sessionName, sessionFolder, state, saveCreds, generateQr: false });

        if (!socket.authState.creds.registered) {
            if (typeof socket.waitForSocketOpen === 'function') {
                await socket.waitForSocketOpen();
            } else {
                await delay(2000);
            }
            const code = await socket.requestPairingCode(phone);
            activePairings.set(sessionId, { status: 'waiting', code });
            return res.json({ code, id: sessionId });
        }
    } catch (error) {
        console.error(`Pairing failed for ${sessionId}:`, error);
        activePairings.set(sessionId, { status: 'error', error: error.message || 'Failed to generate code.' });
        return res.status(502).json({ error: activePairings.get(sessionId).error });
    }
});

app.get('/qr', async (req, res) => {
    const sessionName = normalizeSessionName(req.query.custom);
    if (!sessionName) return res.status(400).json({ error: 'Enter a valid custom session name.' });

    const sessionId = 'session-' + Date.now();
    const sessionFolder = `./tmp/${sessionId}`;
    activePairings.set(sessionId, { status: 'waiting', qr: null });

    try {
        if (!process.env.MONGO_URI || mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB is required.' });
        }
        if (await Session.exists({ sessionName })) {
            return res.status(409).json({ error: 'Session name already exists.' });
        }
        if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        startPairingSocket({ sessionId, sessionName, sessionFolder, state, saveCreds, generateQr: true });

        return res.status(202).json({ id: sessionId });
    } catch (error) {
        activePairings.set(sessionId, { status: 'error', error: 'Failed to initialize QR session.' });
        return res.status(500).json({ error: 'Failed to initialize QR session.' });
    }
});

app.get('/status', (req, res) => {
    const id = req.query.id;
    if (!id || !activePairings.has(id)) return res.json({ status: 'not_found' });
    res.json(activePairings.get(id));
});

app.listen(PORT, () => {
    console.log(`🌐 Server running live on port ${PORT}`);
});
