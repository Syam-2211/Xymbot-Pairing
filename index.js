import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import makeWASocket, {
    useMultiFileAuthState,
    delay,
    DisconnectReason
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { verifyLicense, generateRandomKey, clientGenerateKey } from './src/licenseManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;
const HOST = '0.0.0.0';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'binisha';

// ─── MONGODB SETUP ─────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connected to MongoDB'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
} else {
    console.warn('⚠️ MONGO_URI is not set. Named sessions and license persistence require MongoDB.');
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
}, { timestamps: true });
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activePairings = new Map();

function cleanupFolder(folderPath) {
    if (!folderPath) return;
    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
    } catch (_) {}
}

function ensureMongoReady(res, errorMessage = 'MongoDB is required for this operation.') {
    if (!process.env.MONGO_URI || mongoose.connection.readyState !== 1) {
        res.status(503).json({ error: errorMessage });
        return false;
    }
    return true;
}

// ─── SERVER-SIDE ADMIN AUTH MIDDLEWARE & ROUTES ────────────────────────────
function extractAdminSecret(req) {
    const headerSecret = req.headers['x-admin-secret'];
    if (typeof headerSecret === 'string' && headerSecret.trim()) {
        return headerSecret.trim();
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    if (typeof req.query?.secret === 'string' && req.query.secret.trim()) {
        return req.query.secret.trim();
    }
    if (typeof req.body?.secret === 'string' && req.body.secret.trim()) {
        return req.body.secret.trim();
    }
    return '';
}

function requireAdmin(req, res, next) {
    const providedSecret = extractAdminSecret(req);
    if (!providedSecret || providedSecret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing admin secret.' });
    }
    return next();
}

app.post('/api/admin/login', (req, res) => {
    const secret = extractAdminSecret(req);
    if (!secret || secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Access Denied: Incorrect Admin Key!' });
    }
    return res.json({ success: true, message: 'Admin authenticated.' });
});

app.get('/api/admin/keys', requireAdmin, async (req, res) => {
    try {
        if (!ensureMongoReady(res, 'Database unavailable.')) return;

        const keys = await License.find().sort({ createdAt: -1, _id: -1 });
        return res.json({ success: true, keys });
    } catch (err) {
        console.error('Fetch keys error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch keys' });
    }
});

app.post('/api/admin/generate', requireAdmin, async (req, res) => {
    try {
        if (!ensureMongoReady(res, 'Database unavailable.')) return;

        const rawDays = Number(req.body?.durationDays);
        const durationDays = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 3650
            ? Math.floor(rawDays)
            : 30;

        const newKey = generateRandomKey();
        const license = await License.create({ key: newKey, durationDays });
        return res.json({ success: true, license });
    } catch (err) {
        console.error('Admin generate key error:', err);
        return res.status(500).json({ success: false, error: 'Failed to create key' });
    }
});

app.delete('/api/admin/revoke/:id', requireAdmin, async (req, res) => {
    try {
        if (!ensureMongoReady(res, 'Database unavailable.')) return;

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'Invalid license ID.' });
        }

        const deleted = await License.findByIdAndDelete(id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'License key not found.' });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('Revoke key error:', err);
        return res.status(500).json({ success: false, error: 'Failed to revoke key' });
    }
});

// ─── PAGE ROUTES ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'site.html'));
});

app.get('/license-portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'license.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// ─── CLIENT LICENSE ROUTES ─────────────────────────────────────────────────
app.get('/api/verify-license', async (req, res) => {
    try {
        const key = (req.query.key || '').trim();
        if (!key) {
            return res.status(400).json({ valid: false, message: 'License key is required.' });
        }
        if (!ensureMongoReady(res, 'Database unavailable for license verification.')) return;

        const result = await verifyLicense(key, 'general-check');
        return res.json({ valid: result.valid, message: result.message, expiresAt: result.expiresAt });
    } catch (err) {
        console.error('Verify error:', err);
        return res.status(500).json({ valid: false, message: 'Internal server error.' });
    }
});

app.post('/api/client-generate-key', async (req, res) => {
    try {
        if (!ensureMongoReady(res, 'Database unavailable for key generation.')) return;

        const newKey = await clientGenerateKey();
        return res.json({ key: newKey });
    } catch (err) {
        console.error('Client key generation error:', err);
        return res.status(400).json({ error: 'Failed to generate license key.' });
    }
});

// ─── WHATSAPP PAIRING LOGIC ────────────────────────────────────────────────
function normalizeSessionName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{2,39}$/.test(name) ? name : null;
}

function startPairingSocket({ sessionId, sessionName, sessionFolder, state: initialAuthState, saveCreds: initialSaveCreds, generateQr }) {
    let socket;
    let restartCount = 0;
    let completed = false;
    let authState = initialAuthState;
    let saveCredsHandler = initialSaveCreds;
    let saveCredentials = Promise.resolve();
    let saveError;

    const start = () => {
        activePairings.set(sessionId, {
            status: restartCount ? 'linking' : 'connecting',
            message: restartCount ? 'Reconnecting to WhatsApp...' : 'Connecting to WhatsApp...'
        });

        socket = makeWASocket({
            auth: authState,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            syncFullHistory: false,
        });

        const currentSocket = socket;

        currentSocket.ev.on('creds.update', (update) => {
            saveCredentials = saveCredentials
                .then(() => saveCredsHandler(update))
                .catch((error) => {
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
                            sessionObj[file] = fs.readFileSync(path.join(sessionFolder, file), 'utf8');
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
                    activePairings.set(sessionId, {
                        status: 'connected',
                        sessionName,
                        message: `Session "${sessionName}" linked and saved!`
                    });

                    // ─── AUTO WELCOME MESSAGES ──────────────────────────────
                    try {
                        const rawId = currentSocket.user?.id || '';
                        const pairedNumber = rawId.includes(':')
                            ? rawId.split(':')[0] + '@s.whatsapp.net'
                            : rawId.replace(/@.*/, '') + '@s.whatsapp.net';

                        const ownerNum = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
                        const ownerJid = ownerNum ? ownerNum + '@s.whatsapp.net' : null;
                        const ownerInstagram = process.env.OWNER_INSTAGRAM || '@xymbot';
                        const supportNum = (process.env.SUPPORT_NUMBER || ownerNum || '').replace(/[^0-9]/g, '');
                        const supportJid = supportNum ? supportNum + '@s.whatsapp.net' : null;

                        const greeting =
`╔══════════════════════════╗
║   🤖  *XYMBOT CONNECTED*   ║
╚══════════════════════════╝

✅ Your WhatsApp has been successfully paired!

━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Session Name:* ${sessionName}
━━━━━━━━━━━━━━━━━━━━━━━━━

📞 *Customer Support:* ${supportJid ? '+' + supportNum : 'N/A'}
📸 *Instagram:* ${ownerInstagram}

━━━━━━━━━━━━━━━━━━━━━━━━━
_Powered by Xymbot_ 🚀`;

                        // Send to paired number
                        await currentSocket.sendMessage(pairedNumber, { text: greeting });

                        // Also notify the owner
                        if (ownerJid && ownerJid !== pairedNumber) {
                            await currentSocket.sendMessage(ownerJid, {
                                text: `🔔 *New Xymbot Session Connected!*\n\n📋 Session: *${sessionName}*\n📱 Number: +${rawId.split(':')[0]}\n\n_A new device has just paired via your Xymbot portal._`
                            });
                        }

                        console.log(`✅ Welcome messages sent to ${pairedNumber}`);
                    } catch (msgErr) {
                        console.error('⚠️ Could not send welcome messages:', msgErr.message);
                        // Non-fatal — session is still saved
                    }
                    // ────────────────────────────────────────────────────────

                    cleanupFolder(sessionFolder);
                    try { currentSocket.ws.close(); } catch (_) {}
                } else if (connection === 'close') {
                    if (activePairings.get(sessionId)?.status === 'connected') return;

                    const statusCode = lastDisconnect?.error?.output?.statusCode
                        || lastDisconnect?.error?.statusCode
                        || (String(lastDisconnect?.error?.message || '').includes('515') ? 515 : null);
                    const detail = lastDisconnect?.error?.message || 'WhatsApp connection closed';
                    const isRestartRequired = statusCode === 515
                        || statusCode === DisconnectReason?.restartRequired
                        || String(detail).includes('515')
                        || String(detail).toLowerCase().includes('restart required');

                    if (isRestartRequired && restartCount < 5) {
                        restartCount += 1;
                        activePairings.set(sessionId, {
                            status: 'linking',
                            message: 'WhatsApp requested connection restart. Reconnecting...'
                        });
                        await saveCredentials;
                        await delay(2000);
                        if (!completed) {
                            try {
                                const refreshedAuth = await useMultiFileAuthState(sessionFolder);
                                authState = refreshedAuth.state;
                                saveCredsHandler = refreshedAuth.saveCreds;
                            } catch (refreshErr) {
                                console.warn('Could not refresh auth state from disk:', refreshErr.message);
                            }
                            start();
                        }
                        return;
                    }

                    cleanupFolder(sessionFolder);
                    activePairings.set(sessionId, {
                        status: 'error',
                        error: `Connection closed: ${detail}`,
                        message: `Connection closed: ${detail}`
                    });
                }
            } catch (error) {
                cleanupFolder(sessionFolder);
                activePairings.set(sessionId, {
                    status: 'error',
                    error: error.message || 'Failed to complete session.',
                    message: error.message || 'Failed to complete session.'
                });
            }
        });

        return currentSocket;
    };

    return start();
}

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    phone = String(phone).replace(/[^0-9]/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'Enter a valid phone number with country code.' });

    const sessionName = normalizeSessionName(req.query.custom);
    if (!sessionName) {
        return res.status(400).json({ error: 'Enter a valid custom session name (3-40 alphanumeric chars).' });
    }

    if (!ensureMongoReady(res, 'MongoDB is required for named sessions.')) return;

    const sessionId = 'session-' + Date.now();
    const sessionFolder = path.join('/tmp', sessionId);
    fs.mkdirSync(sessionFolder, { recursive: true });
    activePairings.set(sessionId, { status: 'connecting', message: 'Connecting to WhatsApp...' });

    try {
        if (await Session.exists({ sessionName })) {
            cleanupFolder(sessionFolder);
            activePairings.delete(sessionId);
            return res.status(409).json({ error: 'This custom session name is already in use.' });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const socket = startPairingSocket({
            sessionId,
            sessionName,
            sessionFolder,
            state,
            saveCreds,
            generateQr: false
        });

        if (socket.authState.creds.registered) {
            cleanupFolder(sessionFolder);
            return res.status(400).json({ error: 'Session already registered.' });
        }

        const pairingCode = await new Promise((resolve, reject) => {
            let settled = false;
            let codeRequested = false;

            const finishResolve = (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearTimeout(fallbackTimer);
                socket.ev.off('connection.update', handleUpdate);
                resolve(code);
            };

            const finishReject = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearTimeout(fallbackTimer);
                socket.ev.off('connection.update', handleUpdate);
                reject(err);
            };

            const timeout = setTimeout(() => {
                finishReject(new Error('Pairing code generation timed out waiting for connection.'));
            }, 25000);

            const triggerCode = async () => {
                if (codeRequested || settled) return;
                codeRequested = true;
                try {
                    await delay(1500);
                    const code = await socket.requestPairingCode(phone);
                    finishResolve(code);
                } catch (err) {
                    finishReject(err);
                }
            };

            const handleUpdate = async (update) => {
                if (update.connection === 'connecting' || update.connection === 'open' || update.qr) {
                    await triggerCode();
                } else if (update.connection === 'close') {
                    finishReject(new Error(update.lastDisconnect?.error?.message || 'Socket closed before pairing code was generated.'));
                }
            };

            socket.ev.on('connection.update', handleUpdate);

            const fallbackTimer = setTimeout(() => {
                triggerCode();
            }, 4000);
        });

        const statusPayload = {
            status: 'waiting',
            code: pairingCode,
            message: 'Enter the code in WhatsApp and keep this page open.'
        };
        activePairings.set(sessionId, statusPayload);
        return res.json({ code: pairingCode, id: sessionId });
    } catch (error) {
        console.error(`Pairing failed for ${sessionId}:`, error);
        cleanupFolder(sessionFolder);
        const errMsg = error.message || 'Failed to generate code.';
        activePairings.set(sessionId, { status: 'error', error: errMsg, message: errMsg });
        return res.status(502).json({ error: errMsg, id: sessionId });
    }
});

app.get('/qr', async (req, res) => {
    const sessionName = normalizeSessionName(req.query.custom);
    if (!sessionName) {
        return res.status(400).json({ error: 'Enter a valid custom session name (3-40 alphanumeric chars).' });
    }

    if (!ensureMongoReady(res, 'MongoDB is required for named sessions.')) return;

    const sessionId = 'qr-' + Date.now();
    const sessionFolder = path.join('/tmp', sessionId);
    fs.mkdirSync(sessionFolder, { recursive: true });
    activePairings.set(sessionId, { status: 'connecting', message: 'Initializing QR session...' });

    try {
        if (await Session.exists({ sessionName })) {
            cleanupFolder(sessionFolder);
            activePairings.delete(sessionId);
            return res.status(409).json({ error: 'This custom session name is already in use.' });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        startPairingSocket({
            sessionId,
            sessionName,
            sessionFolder,
            state,
            saveCreds,
            generateQr: true
        });

        return res.json({ id: sessionId });
    } catch (error) {
        console.error(`QR initialization failed for ${sessionId}:`, error);
        cleanupFolder(sessionFolder);
        const errMsg = error.message || 'Failed to initialize QR session.';
        activePairings.set(sessionId, { status: 'error', error: errMsg, message: errMsg });
        return res.status(500).json({ error: errMsg });
    }
});

app.get('/status', (req, res) => {
    const id = req.query.id;
    if (!id || !activePairings.has(id)) {
        return res.json({ status: 'not_found', message: 'Session not found.' });
    }
    return res.json(activePairings.get(id));
});

app.listen(PORT, HOST, () => {
    console.log(`✅ Server running on http://${HOST}:${PORT}`);
});

export default app;
