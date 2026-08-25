const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const AdmZip = require('adm-zip');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Store active connections to prevent memory leaks and handle reconnects
const activeSessions = {};

async function startPairing(phone, res) {
    const sessionDir = path.join(__dirname, `session-${phone}`);
    
    // Clear old corrupted sessions if this is a fresh request
    if (!activeSessions[phone] && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    activeSessions[phone] = conn;
    let isResponded = false; // Prevent sending multiple Express responses

    if (!conn.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await conn.requestPairingCode(phone);
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
        }, 3000); // Give Baileys a moment to negotiate WebSockets
    } else {
        if (!isResponded) {
            res.json({ error: "Already registered. Try a different number." });
            isResponded = true;
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            
            // If logged out or forbidden, destroy session
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Logged out for ${phone}.`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[phone];
            } else {
                console.log(`Connection dropped for ${phone} (Reason: ${reason}). Reconnecting...`);
                // Auto-reconnect
                startPairing(phone, { json: () => {} }); // Pass dummy res since we already responded to frontend
            }
        } else if (connection === 'open') {
            console.log(`Successfully paired with ${phone}! Sending creds...`);
            
            // Wait for all credentials to be flushed to disk
            await delay(3000);

            try {
                const zipPath = path.join(__dirname, `session-${phone}.zip`);
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

                console.log(`Sent session files to ${phone}. Cleaning up...`);
                
                // Clean up files and memory
                fs.unlinkSync(zipPath);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete activeSessions[phone];
                
                // Close connection gracefully
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

    // Set a timeout so the frontend doesn't buffer forever if Baileys hangs
    req.setTimeout(15000, () => {
        res.json({ error: "WhatsApp servers took too long to respond. Try again." });
    });

    try {
        await startPairing(phone, res);
    } catch (e) {
        console.error(e);
        res.json({ error: "Internal server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Xymbot Pairing Server is running on port ${PORT}`);
});
