import fs from 'fs';
import path, { dirname } from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, 'licenses.json');

// Default lifetime keys so existing bots and setups never fail
const DEFAULT_KEYS = [
    {
        key: 'XYM-BOT-PAIR',
        owner: 'Default Master Key',
        status: 'active',
        expiresAt: null,
        createdAt: 1728000000000,
        issuedBy: 'system'
    },
    {
        key: 'CLIENT001',
        owner: 'Default Client 1',
        status: 'active',
        expiresAt: null,
        createdAt: 1728000000000,
        issuedBy: 'system'
    },
    {
        key: 'XYMBOT-FREE',
        owner: 'Community Free Key',
        status: 'active',
        expiresAt: null,
        createdAt: 1728000000000,
        issuedBy: 'system'
    }
];

function loadLicenses() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_KEYS, null, 2), 'utf8');
            return DEFAULT_KEYS;
        }
        const data = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : DEFAULT_KEYS;
    } catch (e) {
        console.error('Error loading licenses.json:', e.message);
        return DEFAULT_KEYS;
    }
}

function saveLicenses(licenses) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(licenses, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving licenses.json:', e.message);
    }
}

export function generateKeyString() {
    const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `XYM-${part1}-${part2}-${part3}`;
}

export function parseDuration(durationStr) {
    if (!durationStr || durationStr.toLowerCase() === 'lifetime' || durationStr.toLowerCase() === 'forever') {
        return null;
    }
    const match = durationStr.match(/^(\d+)([dhmwy])$/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    const now = Date.now();
    switch (unit) {
        case 'h': return now + value * 60 * 60 * 1000;
        case 'd': return now + value * 24 * 60 * 60 * 1000;
        case 'w': return now + value * 7 * 24 * 60 * 60 * 1000;
        case 'm': return now + value * 30 * 24 * 60 * 60 * 1000;
        case 'y': return now + value * 365 * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

export function createLicense(durationStr = '30d', note = 'Client', issuedBy = 'admin') {
    const licenses = loadLicenses();
    const key = generateKeyString();
    const expiresAt = parseDuration(durationStr);

    const newLicense = {
        key,
        owner: note || 'Unnamed Client',
        status: 'active',
        createdAt: Date.now(),
        expiresAt,
        durationGiven: durationStr,
        issuedBy: String(issuedBy)
    };

    licenses.push(newLicense);
    saveLicenses(licenses);
    return newLicense;
}

export function revokeLicense(key) {
    const licenses = loadLicenses();
    const target = licenses.find(l => l.key.toUpperCase() === key.toUpperCase());
    if (!target) return { success: false, error: 'Key not found.' };

    target.status = 'revoked';
    saveLicenses(licenses);
    return { success: true, license: target };
}

export function extendLicense(key, days = 30) {
    const licenses = loadLicenses();
    const target = licenses.find(l => l.key.toUpperCase() === key.toUpperCase());
    if (!target) return { success: false, error: 'Key not found.' };

    const baseTime = target.expiresAt && target.expiresAt > Date.now() ? target.expiresAt : Date.now();
    target.expiresAt = baseTime + days * 24 * 60 * 60 * 1000;
    target.status = 'active';
    saveLicenses(licenses);
    return { success: true, license: target };
}

export function getAllLicenses() {
    return loadLicenses();
}

export function verifyLicense(key) {
    if (!key) return { valid: false, error: 'License Key missing' };

    // Also check any keys listed in VALID_KEYS environment variable
    const validKeysEnv = (process.env.VALID_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (validKeysEnv.includes(key)) {
        return { valid: true, message: 'License verified via environment config.' };
    }

    const licenses = loadLicenses();
    const target = licenses.find(l => l.key.toUpperCase() === key.toUpperCase().trim());

    if (!target) {
        return { valid: false, error: 'Invalid License Key' };
    }

    if (target.status === 'revoked') {
        return { valid: false, error: 'This license has been revoked by admin.' };
    }

    if (target.expiresAt && target.expiresAt < Date.now()) {
        const expiryDate = new Date(target.expiresAt).toLocaleDateString();
        return { valid: false, error: `License expired on ${expiryDate}. Please renew.` };
    }

    return {
        valid: true,
        message: 'License verified successfully.',
        owner: target.owner,
        expiresAt: target.expiresAt
    };
}

// ─── TELEGRAM BOT HANDLER ───────────────────────────────────────────────────

async function sendTelegramMessage(token, chatId, text, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: parseMode
            })
        });
    } catch (e) {
        console.error('Failed to send Telegram message:', e.message);
    }
}

export function initTelegramBot(app) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminIds = (process.env.TELEGRAM_ADMIN_ID || '').split(',').map(id => id.trim()).filter(Boolean);

    if (!token) {
        console.log('ℹ️ TELEGRAM_BOT_TOKEN not provided. Telegram bot is standby.');
        return;
    }

    console.log('🤖 Initializing Telegram License Bot...');

    // Function to check if sender is admin
    const isAdmin = (fromId) => {
        if (!adminIds.length) return true; // If no admin ID set, allow first user or open
        return adminIds.includes(String(fromId));
    };

    // Route for Telegram Webhook
    app.post('/api/telegram-webhook', async (req, res) => {
        res.sendStatus(200); // Acknowledge Telegram immediately

        const message = req.body?.message;
        if (!message || !message.text) return;

        const chatId = message.chat.id;
        const fromId = message.from?.id;
        const text = message.text.trim();
        const [cmd, ...args] = text.split(/\s+/);

        const command = cmd.toLowerCase().replace(/@\w+bot$/, '');

        // ── /start or /help ─────────────────────────────────────────────────
        if (command === '/start' || command === '/help') {
            if (isAdmin(fromId)) {
                const helpMsg = `
👑 <b>Xymbot License Admin Panel</b>

<b>Commands:</b>
• <code>/genkey &lt;duration&gt; [note]</code>
  <i>Generate a new license key</i>
  <i>Examples:</i>
  <code>/genkey 30d @john</code> (30 days)
  <code>/genkey 7d Trial</code> (7 days)
  <code>/genkey lifetime VIP</code> (Never expires)

• <code>/revoke &lt;key&gt;</code>
  <i>Immediately disable a license</i>

• <code>/extend &lt;key&gt; &lt;days&gt;</code>
  <i>Add extra days to a license</i>

• <code>/list</code>
  <i>View all active & expired licenses</i>

• <code>/check &lt;key&gt;</code>
  <i>Inspect details of any license</i>
`;
                await sendTelegramMessage(token, chatId, helpMsg);
            } else {
                const userMsg = `
🤖 <b>Welcome to Xymbot License Manager</b>

Use:
• <code>/check &lt;YOUR-KEY&gt;</code> — Verify your license status & expiry date.
`;
                await sendTelegramMessage(token, chatId, userMsg);
            }
            return;
        }

        // ── /check <key> (Available for both users & admin) ──────────────────
        if (command === '/check') {
            const keyToCheck = args[0];
            if (!keyToCheck) {
                return sendTelegramMessage(token, chatId, '⚠️ Please provide a key: <code>/check XYM-XXXX-XXXX-XXXX</code>');
            }

            const result = verifyLicense(keyToCheck);
            if (!result.valid) {
                return sendTelegramMessage(token, chatId, `❌ <b>License Invalid:</b> ${result.error}`);
            }

            const expiryText = result.expiresAt
                ? new Date(result.expiresAt).toUTCString()
                : '♾️ Lifetime (Never expires)';

            const remainingDays = result.expiresAt
                ? Math.max(0, Math.ceil((result.expiresAt - Date.now()) / (1000 * 60 * 60 * 24))) + ' days'
                : 'Unlimited';

            const resp = `
✅ <b>License is ACTIVE!</b>

🔑 <b>Key:</b> <code>${keyToCheck}</code>
👤 <b>Owner:</b> ${result.owner || 'N/A'}
⏳ <b>Remaining:</b> ${remainingDays}
📅 <b>Expires:</b> ${expiryText}
`;
            return sendTelegramMessage(token, chatId, resp);
        }

        // ── ADMIN ONLY COMMANDS ─────────────────────────────────────────────
        if (!isAdmin(fromId)) {
            return sendTelegramMessage(token, chatId, '⛔ You are not authorized to use admin commands.');
        }

        // /genkey <duration> [note]
        if (command === '/genkey' || command === '/createkey') {
            const duration = args[0] || '30d';
            const note = args.slice(1).join(' ') || 'Customer';

            const lic = createLicense(duration, note, fromId);
            const expiryText = lic.expiresAt
                ? new Date(lic.expiresAt).toLocaleDateString()
                : '♾️ Lifetime (Never expires)';

            const reply = `
🎉 <b>New License Generated!</b>

🔑 <b>Key:</b> (tap to copy)
<code>${lic.key}</code>

👤 <b>Assigned To:</b> ${lic.owner}
⏳ <b>Duration:</b> ${lic.durationGiven}
📅 <b>Expires:</b> ${expiryText}

<b>How your customer uses it:</b>
Put in Xymbot's <code>config.js</code>:
<code>global.LICENSE_KEY = "${lic.key}";</code>
`;
            return sendTelegramMessage(token, chatId, reply);
        }

        // /revoke <key>
        if (command === '/revoke' || command === '/block') {
            const key = args[0];
            if (!key) return sendTelegramMessage(token, chatId, '⚠️ Usage: <code>/revoke XYM-XXXX-XXXX-XXXX</code>');

            const resRev = revokeLicense(key);
            if (!resRev.success) {
                return sendTelegramMessage(token, chatId, `❌ ${resRev.error}`);
            }
            return sendTelegramMessage(token, chatId, `🚫 <b>License Revoked:</b> <code>${key}</code> is now blocked.`);
        }

        // /extend <key> <days>
        if (command === '/extend') {
            const key = args[0];
            const days = parseInt(args[1] || '30', 10);
            if (!key) return sendTelegramMessage(token, chatId, '⚠️ Usage: <code>/extend XYM-XXXX-XXXX-XXXX 30</code>');

            const resExt = extendLicense(key, days);
            if (!resExt.success) {
                return sendTelegramMessage(token, chatId, `❌ ${resExt.error}`);
            }
            const newExpiry = new Date(resExt.license.expiresAt).toLocaleDateString();
            return sendTelegramMessage(token, chatId, `✅ <b>Extended!</b> <code>${key}</code> is now valid until ${newExpiry}.`);
        }

        // /list
        if (command === '/list' || command === '/keys') {
            const all = getAllLicenses();
            if (!all.length) return sendTelegramMessage(token, chatId, 'No licenses found.');

            let listText = `📋 <b>Total Licenses (${all.length}):</b>\n\n`;
            for (const l of all) {
                const statusEmoji = l.status === 'revoked' ? '🚫' : (l.expiresAt && l.expiresAt < Date.now() ? '⌛' : '✅');
                const exp = l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : 'Lifetime';
                listText += `${statusEmoji} <code>${l.key}</code>\n   └ 👤 ${l.owner} | 📅 ${exp}\n\n`;
            }
            return sendTelegramMessage(token, chatId, listText);
        }
    });

    // Automatically register Telegram Webhook if PUBLIC_URL is known or log instructions
    const publicUrl = process.env.RENDER_EXTERNAL_URL || 'https://xymbot-pairing.onrender.com';
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;

    fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`)
        .then(r => r.json())
        .then(res => {
            if (res.ok) {
                console.log(`✅ Telegram Webhook registered successfully at ${webhookUrl}`);
            } else {
                console.warn('Telegram setWebhook response:', res.description);
            }
        })
        .catch(err => {
            console.warn('Could not set Telegram webhook automatically:', err.message);
        });
}
