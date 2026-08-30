const express = require('express');
const pino = require('pino');
const app = express();
const PORT = process.env.PORT || 3000; // Important for Render!

app.get('/pair', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.send('Please provide a WhatsApp number!');

    try {
        // 🚀 DYNAMIC IMPORT MOVED INSIDE THE ASYNC ROUTE 🚀
        const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = await import('@whiskeysockets/baileys');

        const { state, saveCreds } = await useMultiFileAuthState('./temp_session');
        
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
            res.send(`Your Pairing Code: ${code?.match(/.{1,4}/g)?.join("-")}`);
        }
        
        // ... (Your existing logic to gather the session files, base64 encode them, and send the XYMBOT~ string to the user goes here) ...

    } catch (e) {
        console.error("Pairing error:", e);
        res.send('An error occurred during pairing.');
    }
});

app.listen(PORT, () => console.log(`Pairing server running on port ${PORT}`));
