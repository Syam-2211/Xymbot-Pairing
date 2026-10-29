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
import { initTelegramBot } from './licenseManager.js';

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
    expiresAt: Date,
    boundSession: { type: String, default: null }
});
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Optional: if you put HTML files in a 'public' folder

const activePairings = new Map();

// ─── ROUTES FOR MULTIPLE PAGES ─────────────────────────────────────────────

// 1. Pairing Portal Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'site.html')); 
    // Note: If using a public folder, use path.join(__dirname, 'public', 'site.html')
});

// 2. License Management Page Route
app.get('/license-portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'license.html'));
});

// ─── LICENSE CHECK API ROUTE ───────────────────────────────────────────────
app.post('/api/check-license', async (req, res) => {
    try {
        const { licenseKey } = req.body;
        if (!licenseKey) {
            return res.status(400).json({ valid: false, error: 'License key is required.' });
        }

        const license = await License.findOne({ key: licenseKey });
        if (!license) {
            return res.json({ valid: false, error: 'Invalid license key.' });
        }

        const isExpired = license.expiresAt && new Date(license.expiresAt) < new Date();
        if (isExpired) {
            return res.json({ valid: false, error: 'This license key has expired.' });
        }

        return res.json({
            valid: true,
            expiresAt: license.expiresAt,
            boundSession: license.boundSession || 'Unbound'
        });
    } catch (err) {
        console.error('License check error:', err);
        res.status(500).json({ valid: false, error: 'Internal server error.' });
    }
});

// WhatsApp pairing background logic helper remains the same...
// (Keep startPairingSocket, /pair, /qr, /status routes from previous configuration)

app.listen(PORT, () => {
    console.log(`🌐 Server running live on port ${PORT}`);
    initTelegramBot(app);
});
