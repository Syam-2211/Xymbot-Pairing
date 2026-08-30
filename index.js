const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
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

const activeSessions = {};

async function startAuth(id, type, res) {
    const sessionDir = path.join(__dirname, `session-${id}`);
    
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
    let isResponded = false; 

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
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[id];
            } else {
                startAuth(id, type, { json: () => {} });
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

                // Package all json files into the base64 string
                const sessionFiles = fs.readdirSync(sessionDir);
                const sessionObj = {};
                for (const file of sessionFiles) {
                    if (file.endsWith('.json')) {
                        sessionObj[file] = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                    }
                }
                const base64Session = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
                await conn.sendMessage(userJid, {
                    text: `*Base64 Session ID:*\n\nXYMBOT~${base64Session}`
                });
                
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

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "Please provide a phone number." });
    phone = phone.replace(/[^0-9]/g, '');
    req.setTimeout(15000, () => res.json({ error: "WhatsApp servers took too long to respond. Try again." }));
    try { await startAuth(phone, 'code', res); } catch (e) { res.json({ error: "Internal server error" }); }
});

app.get('/qr', async (req, res) => {
    let id = "QR-" + Date.now();
    req.setTimeout(15000, () => res.json({ error: "WhatsApp servers took too long to respond. Try again." }));
    try { await startAuth(id, 'qr', res); } catch (e) { res.json({ error: "Internal server error" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Xymbot Pairing Server running on port ${PORT}`));
