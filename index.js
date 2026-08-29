const express = require('express');
const pino = require('pino');
const fs = require('fs');
const AdmZip = require('adm-zip');
const path = require('path');
const cors = require('cors');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active connections to prevent memory leaks and handle reconnects
const activeSessions = {};

async function startAuth(id, type, res) {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = await import('@whiskeysockets/baileys');
    const sessionDir = path.join(__dirname, `session-${id}`);
    
    // Clear old corrupted sessions if this is a fresh request
    if (!activeSessions[id] && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Xymbot", "Desktop", "1.0.0"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    activeSessions[id] = conn;
    let isResponded = false; // Prevent sending multiple Express responses

    // If pairing code mode
    if (type === 'code') {
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await conn.requestPairingCode(id);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!isResponded) {
                        res.json({ code });
                        isResponded = true;
                    }
                } catch (err) {
                    console.error("Pairing Code Error:", err.message);
                    if (!isResponded) {
                        res.json({ error: "Failed to fetch code from WhatsApp servers. Please try again." });
                        isResponded = true;
                    }
                }
            }, 3000); 
        } else {
            if (!isResponded) {
                res.json({ error: "Already registered. Try a different number." });
                isResponded = true;
            }
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // If QR mode and QR is emitted
        if (type === 'qr' && qr && !isResponded) {
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
            const reason = lastDisconnect.error?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Logged out for ${id}.`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[id];
            } else {
                console.log(`Connection dropped for ${id} (Reason: ${reason}). Reconnecting...`);
                // Auto-reconnect
                startAuth(id, type, { json: () => {} }); // Dummy res
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${id}! Sending creds...`);
            
            await delay(3000);

            try {
                const zipPath = path.join(__dirname, `session-${id}.zip`);
                const zip = new AdmZip();
                zip.addLocalFolder(sessionDir);
                zip.writeZip(zipPath);

                const userJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                
                await conn.sendMessage(userJid, {
                    document: fs.readFileSync(zipPath),
                    mimetype: 'application/zip',
                    fileName: 'Xymbot-Session.zip',
                    caption: '🕊🦋⃝♥⃝ѕиєнα🍁♥⃝🦋⃝🕊\n\n*✅ Pairing Successful!*\n\nHere is your `session` zip file.\n\n*How to use:*\n1. Download this zip file.\n2. Extract it.\n3. Put the contents into your bot\'s `session` folder.\n4. Restart the bot.\n\n⚠️ *DO NOT SHARE THIS FILE WITH ANYONE!*'
                });

                const credsFile = fs.readFileSync(path.join(sessionDir, 'creds.json'));
                const base64Creds = Buffer.from(credsFile).toString('base64');
                await conn.sendMessage(userJid, {
                    text: `*Base64 Session ID:*\n\nXYMBOT~${base64Creds}`
                });

                console.log(`Sent session files to ${id}. Cleaning up...`);
                
                fs.unlinkSync(zipPath);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[id];
                
                conn.end(new Error("Finished pairing"));
            } catch (err) {
                console.error("Archive error:", err);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
});
