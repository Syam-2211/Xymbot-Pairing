import express from 'express';
import fs from 'fs';
import pino from 'pino';
import mongoose from 'mongoose';
import baileys from '@whiskeysockets/baileys';

const { default: makeWASocket, useMultiFileAuthState, delay, Browsers } = baileys;

const app = express();
const PORT = process.env.PORT || 8000;

// ─── MONGODB SETUP ─────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connected to MongoDB on Pairing Site'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

// Schemas for automatic database creation
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    sessionData: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const licenseSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    expiresAt: Date,
    boundSession: { type: String, default: null } // Locks to the specific bot instance
});
const License = mongoose.models.License || mongoose.model('License', licenseSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── PAIRING SITE FRONTEND ──────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>Xymbot Pairing</title></head>
        <body style="font-family: Arial; text-align: center; margin-top: 50px; background-color: #121212; color: white;">
            <h2>Xymbot Pairing Server</h2>
            <form action="/pair" method="GET">
                <input type="text" name="phone" placeholder="WhatsApp Number (e.g., 919876543210)" style="padding: 10px; width: 300px; border-radius: 5px; border: none; margin-bottom: 15px;" required>
                <br>
                <button type="submit" style="padding: 10px 20px; background-color: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer;">Get Pairing Code</button>
            </form>
        </body>
        </html>
    `);
});

// ─── WHATSAPP PAIRING LOGIC ───────────────────────────────────────────────
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).send('Phone number is required');
    phone = phone.replace(/[^0-9]/g, '');

    const sessionFolder = `./tmp/session-${phone}-${Date.now()}`;
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

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
            res.send(`
                <html>
                <body style="font-family: Arial; text-align: center; margin-top: 50px; background-color: #121212; color: white;">
                    <h2>Your Pairing Code:</h2>
                    <h1 style="font-size: 48px; letter-spacing: 5px; color: #4CAF50;">${code}</h1>
                    <p>Open WhatsApp > Linked Devices > Link with Phone Number</p>
                    <p style="color: #aaaaaa;"><i>Keep this page open. Your Session ID will appear here.</i></p>
                    
                    <script>
                        setInterval(() => {
                            fetch('/status?folder=' + encodeURIComponent('${sessionFolder}'))
                                .then(r => r.json())
                                .then(data => {
                                    if (data.status === 'success') {
                                        document.body.innerHTML = '<div style="font-family: Arial; text-align: center; margin-top: 50px; background-color: #121212; color: white;"><h2>✅ Session Generated!</h2><p>Copy the ID below and set it as SESSION_ID in your Render bot settings:</p><textarea style="width: 80%; height: 150px; padding: 10px; border-radius: 5px; background: #222; color: #4CAF50; border: 1px solid #4CAF50;" readonly>' + data.sessionId + '</textarea></div>';
                                    }
                                });
                        }, 3000);
                    </script>
                </body>
                </html>
            `);
        }

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
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

                // Save session securely to MongoDB
                if (process.env.MONGO_URI) {
                    await Session.create({
                        sessionId: finalSessionId,
                        sessionData: base64Session
                    }).catch(err => console.error('MongoDB session save error:', err.message));
                }

                // Notify frontend
                fs.writeFileSync(`${sessionFolder}/.done`, finalSessionId);
                await delay(1000);
                socket.ws.close(); // Safely close connection
            }
        });

    } catch (err) {
        console.error('Pairing error:', err);
        if (!res.headersSent) res.status(500).send('Error generating pairing code.');
    }
});

// ─── POLLING ENDPOINT FOR FRONTEND ────────────────────────────────────────
app.get('/status', (req, res) => {
    const folder = req.query.folder;
    if (!folder || !fs.existsSync(folder)) return res.json({ status: 'pending' });
    const doneFile = `${folder}/.done`;
    if (fs.existsSync(doneFile)) {
        const sessionId = fs.readFileSync(doneFile, 'utf8');
        return res.json({ status: 'success', sessionId });
    }
    res.json({ status: 'pending' });
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

        // Lock the key to this bot instance's secure hash on first use
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