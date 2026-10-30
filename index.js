import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import makeWASocket, {
    useMultiFileAuthState,
    delay
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { verifyLicense, generateRandomKey } from './licenseManager.js';

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
    key: { type: String, unique: true },
    durationDays: { type: Number, default: 30 },
    expiresAt: Date,
    isActivated: { type: Boolean, default: false },
    boundSession: { type: String, default: null }
});
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activePairings = new Map();

// ─── PAGE ROUTES ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'site.html'));
});

app.get('/license-portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'license.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// ─── API ENDPOINTS ─────────────────────────────────────────────────────────

// Verify License Key Route
app.get('/api/verify-license', async (req, res) => {
    try {
        const key = req.query.key;
        if (!key) return res.status(400).json({ valid: false, message: 'License key is required.' });
        
        const result = await verifyLicense(key, 'general-check');
        return res.json({ valid: result.valid, message: result.message });
    } catch (err) {
        console.error('Verify error:', err);
        res.status(500).json({ valid: false, message: 'Internal server error.' });
    }
});

// Client Key Generation Route
app.post('/api/client-generate-key', async (req, res) => {
    try {
        const newKey = generateRandomKey();
        await License.create({ key: newKey, durationDays: 30, isActivated: false });
        return res.json({ key: newKey });
    } catch (err) {
        return res.status(400).json({ error: 'Failed to generate license key.' });
    }
});

// Admin API to fetch all keys
app.get('/api/admin/keys', async (req, res) => {
    try {
        const keys = await License.find().sort({ createdAt: -1 });
        res.json({ keys });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch keys' });
    }
});

// Admin API to generate key
app.post('/api/admin/generate', async (req, res) => {
    try {
        const newKey = generateRandomKey();
        const license = await License.create({ key: newKey, durationDays: 30 });
        res.json({ success: true, license });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create key' });
    }
});

// Admin API to revoke key
app.delete('/api/admin/revoke/:id', async (req, res) => {
    try {
        await License.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke key' });
    }
});

// ─── WHATSAPP PAIRING LOGIC ────────────────────────────────────────────────
function startPairingSocket({ sessionId, sessionName, sessionFolder, state, saveCreds, generateQr }) {
    let socket;
    let restartCount = 0;
    let completed = false;
    let saveCredentials = Promise.resolve();
    let saveError;

    const start = () => {
        activePairings.set(sessionId, {
            status: restartCount ? 'linking' : 'connecting',
            message: restartCount ? 'Reconnecting to WhatsApp...' : 'Connecting to WhatsApp...'
        });
        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
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
                    activePairings.set(sessionId, {
                        status: 'waiting',
                        qr: qrDataUrl,
                        message: 'Scan the QR code with WhatsApp to connect.'
                    });
                }
                if (connection === 'open') {
                    activePairings.set(sessionId, {
                        status: 'linking',
                        message: 'WhatsApp linked. Saving your session...'
                    });
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
                            message: 'WhatsApp is restarting the connection...'
                        });
                        await saveCredentials;
                        if (!completed && currentSocket === socket) start();
                        return;
                    }
                    activePairings.set(sessionId, { status: 'error', error: `Connection closed: ${detail}` });
                }
            } catch (error) {
                activePairings.set(sessionId, { status: 'error', error: error.message || 'Failed to complete session.' });
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

        if (socket.authState.creds.registered) {
            return res.status(400).json({ error: 'Session already registered.' });
        }

        // Wait dynamically for connection or open state via a Promise wrapper
        const pairingCode = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Pairing code generation timed out waiting for connection.'));
            }, 25000); // 25 second timeout

            // Listen for socket updates to request the code safely once connected/ready
            let codeRequested = false;

            const handleUpdate = async (update) => {
                const { connection } = update;
                // Once connection establishes or socket is ready, request code if not already done
                if (!codeRequested) {
                    codeRequested = true;
                    try {
                        await delay(1500); // Brief buffer for socket stability
                        const code = await socket.requestPairingCode(phone);
                        clearTimeout(timeout);
                        socket.ev.off('connection.update', handleUpdate);
                        resolve(code);
                    } catch (err) {
                        clearTimeout(timeout);
                        socket.ev.off('connection.update', handleUpdate);
                        reject(err);
                    }
                }
            };

            // Alternatively, if connection.update doesn't trigger immediately, 
            // trigger after a safe connection attempt check
            setTimeout(async () => {
                if (!codeRequested) {
                    try {
                        codeRequested = true;
                        const code = await socket.requestPairingCode(phone);
                        clearTimeout(timeout);
                        resolve(code);
                    } catch (err) {
                        // If it fails here, let it try or fallback
                    }
                }
            }, 4000); 
        });

        activePairings.set(sessionId, {
            status: 'waiting',
            code: pairingCode,
            message: 'Enter the code in WhatsApp and keep this page open.'
        });
        return res.json({ code: pairingCode, id: sessionId });

    } catch (error) {
        console.error(`Pairing failed for ${sessionId}:`, error);
        activePairings.set(sessionId, { status: 'error', error: error.message || 'Failed to generate code.' });
        return res.status(502).json({ error: activePairings.get(sessionId).error });
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
