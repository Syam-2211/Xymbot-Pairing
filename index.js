const express = require('express');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. SERVE THE HTML HOME PAGE
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. PAIRING CODE ROUTE (WITH CUSTOM PREFIX & SHORT ID)
app.get('/pair', async (req, res) => {
    let num = req.query.phone;
    // Catch the custom prefix from the frontend, default to XYMBOT if empty
    let prefix = req.query.prefix ? req.query.prefix.toUpperCase() : 'XYMBOT';
    
    if (!num) return res.json({ error: 'Please provide a WhatsApp number!' });

    try {
        const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = await import('@whiskeysockets/baileys');
        
        const sessionFolder = `./temp_session_${num}`;
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }),
            browser: ["Xymbot Pairing", "Chrome", "1.0.0"]
        });

        conn.ev.on('creds.update', saveCreds);

        if (!conn.authState.creds.registered) {
            await delay(1500);
            num = num.replace(/[^0-9]/g, '');
            const code = await conn.requestPairingCode(num);
            res.json({ code: code?.match(/.{1,4}/g)?.join("-") });
        }
        
        conn.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await delay(3000); 
                
                let sessionData = {};
                const files = fs.readdirSync(sessionFolder);
                for (let file of files) {
                    const fileContent = fs.readFileSync(path.join(sessionFolder, file), 'utf-8');
                    try { sessionData[file] = JSON.parse(fileContent); } 
                    catch { sessionData[file] = fileContent; }
                }
                
                const base64Session = Buffer.from(JSON.stringify(sessionData)).toString('base64');
                
                // Upload to Cloud for Short ID
                try {
                    const response = await fetch('https://dpaste.com/api/v2/', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ content: base64Session, expiry_days: '365' })
                    });
                    
                    const pasteUrl = await response.text(); 
                    const shortId = pasteUrl.trim().split('/').pop(); 
                    
                    // Creates the final string: e.g. SNEHA~XYZ123
                    const sessionString = `${prefix}~${shortId}`;
                    
                    await conn.sendMessage(conn.user.id, { text: sessionString });
                    await conn.sendMessage(conn.user.id, { text: "⚠️ *DO NOT SHARE THIS CODE WITH ANYONE!* ⚠️\n\nCopy the text above and set it as your `SESSION_ID` environment variable on Render/Zeabur." });
                } catch (err) {
                    console.error("Cloud upload failed", err);
                }
                
                fs.rmSync(sessionFolder, { recursive: true, force: true });
                conn.ws.close();
            }
        });

    } catch (e) {
        console.error("Pairing error:", e);
        if (!res.headersSent) res.json({ error: 'An error occurred during pairing.' });
    }
});

// 3. QR CODE ROUTE (WITH CUSTOM PREFIX & SHORT ID)
app.get('/qr', async (req, res) => {
    let prefix = req.query.prefix ? req.query.prefix.toUpperCase() : 'XYMBOT';

    try {
        const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, delay } = await import('@whiskeysockets/baileys');
        
        const sessionId = Date.now();
        const sessionFolder = `./temp_session_qr_${sessionId}`;
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }),
            browser: ["Xymbot Pairing", "Chrome", "1.0.0"]
        });

        conn.ev.on('creds.update', saveCreds);

        conn.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            
            if (qr && !res.headersSent) {
                const qrImage = await qrcode.toDataURL(qr);
                res.json({ qr: qrImage });
            }
            
            if (connection === 'open') {
                await delay(3000);
                
                let sessionData = {};
                const files = fs.readdirSync(sessionFolder);
                for (let file of files) {
                    const fileContent = fs.readFileSync(path.join(sessionFolder, file), 'utf-8');
                    try { sessionData[file] = JSON.parse(fileContent); } 
                    catch { sessionData[file] = fileContent; }
                }
                
                const base64Session = Buffer.from(JSON.stringify(sessionData)).toString('base64');
                
                // Upload to Cloud for Short ID
                try {
                    const response = await fetch('https://dpaste.com/api/v2/', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ content: base64Session, expiry_days: '365' })
                    });
                    
                    const pasteUrl = await response.text(); 
                    const shortId = pasteUrl.trim().split('/').pop(); 
                    
                    // Creates the final string: e.g. SNEHA~XYZ123
                    const sessionString = `${prefix}~${shortId}`;
                    
                    await conn.sendMessage(conn.user.id, { text: sessionString });
                    await conn.sendMessage(conn.user.id, { text: "⚠️ *DO NOT SHARE THIS CODE WITH ANYONE!* ⚠️\n\nCopy the text above and set it as your `SESSION_ID` environment variable on Render/Zeabur." });
                } catch (err) {
                    console.error("Cloud upload failed", err);
                }
                
                fs.rmSync(sessionFolder, { recursive: true, force: true });
                conn.ws.close();
            }
        });

    } catch (e) {
        console.error("QR error:", e);
        if (!res.headersSent) res.json({ error: 'An error occurred generating QR.' });
    }
});

app.listen(PORT, () => console.log(`Pairing server running on port ${PORT}`));
