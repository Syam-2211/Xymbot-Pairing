import express from 'express';
import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path, { dirname } from 'path';
import cors from 'cors';
import qrcode from 'qrcode';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active connections to prevent memory leaks and handle reconnects
const activeSessions = {};

async function startAuth(id, type, res, alreadyResponded = false) {
    const sessionDir = path.join(__dirname, `session-${id}`);
    
    // Clear old corrupted sessions if this is a fresh request
    if (!alreadyResponded && !activeSessions[id] && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version = [2, 3000, 1043857760];
    try {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
    } catch (e) {
        console.warn("Could not fetch latest version, using fallback:", version);
    }

    const conn = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        markOnlineOnConnect: false
    });

    activeSessions[id] = conn;
    let isResponded = alreadyResponded; // Prevent sending multiple Express responses

    // If pairing code mode
    if (type === 'code') {
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await conn.requestPairingCode(id);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (res && !isResponded) {
                        res.json({ code });
                        isResponded = true;
                    }
                } catch (err) {
                    console.error("Pairing Code Error:", err.message);
                    if (res && !isResponded) {
                        res.json({ error: "Failed to fetch code from WhatsApp servers. Please try again." });
                        isResponded = true;
                    }
                }
            }, 3000); 
        } else {
            if (res && !isResponded) {
                res.json({ error: "Already registered. Try a different number." });
                isResponded = true;
            }
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // If QR mode and QR is emitted
        if (type === 'qr' && qr && !isResponded && res) {
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
            const reason = lastDisconnect?.error?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Logged out for ${id}.`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                delete activeSessions[id];
                if (res && !isResponded) {
                    res.json({ error: "Logged out. Please try again." });
                    isResponded = true;
                }
            } else if (reason === DisconnectReason.restartRequired) {
                console.log(`Restart required for ${id} (Reason: 515). Reconnecting with auth credentials...`);
                delete activeSessions[id];
                setTimeout(() => {
                    startAuth(id, type, res, isResponded);
                }, 1000);
            } else {
                console.log(`Connection dropped for ${id} (Reason: ${reason}). Cleaning up...`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                delete activeSessions[id];
                try { conn.end(new Error("Connection dropped")); } catch(e) {}
                if (res && !isResponded) {
                    res.json({ error: "Connection closed by WhatsApp. Please try again." });
                    isResponded = true;
                }
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Generating Base64 Session ID...`);
            
            await delay(2000);

            try {
                const credsPath = path.join(sessionDir, 'creds.json');
                
                if (fs.existsSync(credsPath)) {
                    const credsData = fs.readFileSync(credsPath, 'utf8');
                    const base64Session = Buffer.from(credsData).toString('base64');
                    const sessionId = `XYMBOT~${base64Session}`;

                    const userJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    const messageText = `🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n*✅ Pairing Successful!*\n\nHere is your *SESSION ID* (tap and hold to copy):\n\n\`\`\`${sessionId}\`\`\`\n\n*How to use:*\n1. Copy the code above.\n2. In your bot's \`config.js\`, set:\n\`\`\`global.SESSION_ID = "${sessionId}";\`\`\`\n(or set \`SESSION_ID\` in your environment variables / .env).\n3. Start the bot (\`npm start\` or \`node index.js\`).\n\n⚠️ *DO NOT SHARE THIS SESSION ID WITH ANYONE!*`;

                    await conn.sendMessage(userJid, { text: messageText });
                    console.log(`Sent Base64 Session ID to ${id}. Cleaning up...`);
                } else {
                    console.error("creds.json not found in", sessionDir);
                }

                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                delete activeSessions[id];
                
                conn.end(new Error("Finished pairing"));
            } catch (err) {
                console.error("Session dispatch error:", err);
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

// Endpoint to verify License Key
app.get('/api/verify-license', (req, res) => {
    const key = req.query.key;
    if (!key) {
        return res.json({ valid: false, error: "License Key missing" });
    }
    
    // Check if process.env.VALID_KEYS exists and includes the key
    const validKeysStr = process.env.VALID_KEYS || '';
    const validKeys = validKeysStr.split(',').map(k => k.trim()).filter(k => k);
    
    if (validKeys.includes(key)) {
        return res.json({ valid: true });
    } else {
        return res.json({ valid: false, error: "Invalid License Key" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
});
