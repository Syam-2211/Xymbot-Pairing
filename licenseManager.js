import fs from 'fs';
import path, { dirname } from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, 'licenses.json');

// ─── LICENSE DATABASE ────────────────────────────────────────────────────────

const DEFAULT_KEYS = [
    { key: 'XYM-BOT-PAIR', owner: 'Master Key', status: 'active', expiresAt: null, createdAt: Date.now(), telegramUserId: null },
    { key: 'CLIENT001',     owner: 'Default Client', status: 'active', expiresAt: null, createdAt: Date.now(), telegramUserId: null },
    { key: 'XYMBOT-FREE',  owner: 'Community Free', status: 'active', expiresAt: null, createdAt: Date.now(), telegramUserId: null },
];

function loadLicenses() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_KEYS, null, 2), 'utf8');
            return [...DEFAULT_KEYS];
        }
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        return Array.isArray(data) ? data : [...DEFAULT_KEYS];
    } catch (e) {
        return [...DEFAULT_KEYS];
    }
}

function saveLicenses(licenses) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(licenses, null, 2), 'utf8'); } catch (e) {}
}

function generateKey() {
    const rnd = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    return `XYM-${rnd()}-${rnd()}-${rnd()}`;
}

export function verifyLicense(key) {
    if (!key) return { valid: false, error: 'License Key missing' };

    // Check environment VALID_KEYS override
    const envKeys = (process.env.VALID_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (envKeys.includes(key)) return { valid: true, message: 'License verified via env config.' };

    const licenses = loadLicenses();
    const lic = licenses.find(l => l.key.toUpperCase() === key.toUpperCase().trim());
    if (!lic) return { valid: false, error: 'Invalid License Key' };
    if (lic.status === 'revoked') return { valid: false, error: 'License revoked by admin.' };
    if (lic.expiresAt && lic.expiresAt < Date.now()) {
        return { valid: false, error: `License expired on ${new Date(lic.expiresAt).toLocaleDateString()}.` };
    }
    return { valid: true, message: 'License verified successfully.', owner: lic.owner, expiresAt: lic.expiresAt };
}

// ─── TELEGRAM API HELPERS ────────────────────────────────────────────────────

async function tgRequest(token, method, body) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await res.json();
    } catch (e) {
        console.error(`Telegram API error [${method}]:`, e.message);
    }
}

async function sendMsg(token, chatId, text, extra = {}) {
    return tgRequest(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function editMsg(token, chatId, msgId, text, extra = {}) {
    return tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });
}

async function answerCallback(token, callbackId, text = '') {
    return tgRequest(token, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

// ─── MENU BUILDERS ───────────────────────────────────────────────────────────

function mainMenuForUser(name) {
    return {
        text: `👋 <b>Welcome to Xymbot, ${name}!</b>\n\n` +
              `🤖 <b>Xymbot</b> is a powerful WhatsApp Bot.\n` +
              `Use the buttons below to get started:`,
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔑 Get My LICENSE KEY', callback_data: 'get_key' }],
                [{ text: '✅ Check My Key Status', callback_data: 'check_key' }],
                [{ text: '📞 Contact Owner', callback_data: 'contact_owner' }],
                [{ text: '📖 How to Use', callback_data: 'how_to_use' }],
            ]
        }
    };
}

function adminMenuText() {
    return `👑 <b>Admin Panel — Xymbot License Manager</b>\n\n` +
           `Manage all licenses from here.`;
}

function adminKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔑 Generate New Key', callback_data: 'admin_genkey' }],
            [{ text: '🚫 Revoke a Key', callback_data: 'admin_revoke' }],
            [{ text: '📋 List All Keys', callback_data: 'admin_list' }],
            [{ text: '🔍 Check Any Key', callback_data: 'admin_check' }],
        ]
    };
}

// ─── STATE STORE (tracks what a user is doing) ───────────────────────────────
const userStates = {};

// ─── TELEGRAM BOT INIT ───────────────────────────────────────────────────────

export function initTelegramBot(app) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminIds = (process.env.TELEGRAM_ADMIN_ID || '')
        .split(',').map(id => id.trim()).filter(Boolean);
    const ownerHandle = process.env.OWNER_TELEGRAM || '@YourOwner';
    const ownerContact = process.env.OWNER_CONTACT || 'Contact the owner via Telegram.';

    if (!token) {
        console.log('ℹ️  TELEGRAM_BOT_TOKEN not set. Telegram bot disabled.');
        return;
    }

    const isAdmin = (id) => !adminIds.length || adminIds.includes(String(id));

    // ── WEBHOOK ROUTE ────────────────────────────────────────────────────────
    app.post('/api/telegram-webhook', async (req, res) => {
        res.sendStatus(200);

        const body = req.body;
        if (!body) return;

        // ── CALLBACK QUERIES (Button Presses) ──────────────────────────────
        if (body.callback_query) {
            const cq        = body.callback_query;
            const chatId    = cq.message.chat.id;
            const msgId     = cq.message.message_id;
            const fromId    = cq.from.id;
            const fromName  = cq.from.first_name || 'User';
            const data      = cq.data;

            await answerCallback(token, cq.id);

            // ── USER: Get Key ──────────────────────────────────────────────
            if (data === 'get_key') {
                const licenses = loadLicenses();
                const existing = licenses.find(l =>
                    String(l.telegramUserId) === String(fromId) &&
                    l.status === 'active' &&
                    (!l.expiresAt || l.expiresAt > Date.now())
                );

                if (existing) {
                    await editMsg(token, chatId, msgId,
                        `✅ <b>You already have an active license!</b>\n\n` +
                        `🔑 <b>Your Key:</b>\n<code>${existing.key}</code>\n\n` +
                        `♾️ Valid: Lifetime — Never Expires\n\n` +
                        `<i>Tap the key above to copy it.</i>`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '⬅️ Back to Menu', callback_data: 'back_main' }]
                                ]
                            }
                        }
                    );
                } else {
                    // Generate a lifetime key for the user
                    const newKey = generateKey();
                    const newLic = {
                        key: newKey,
                        owner: fromName,
                        status: 'active',
                        expiresAt: null, // Lifetime — never expires
                        createdAt: Date.now(),
                        telegramUserId: String(fromId),
                    };
                    licenses.push(newLic);
                    saveLicenses(licenses);

                    const expiryDate = '♾️ Lifetime';

                    await editMsg(token, chatId, msgId,
                        `🎉 <b>Your License Key is Ready!</b>\n\n` +
                        `🔑 <b>Key (tap to copy):</b>\n<code>${newKey}</code>\n\n` +
                        `♾️ <b>Valid:</b> Lifetime — Never Expires\n` +
                        `👤 <b>Issued To:</b> ${fromName}\n\n` +
                        `━━━━━━━━━━━━━━━━\n` +
                        `<b>📥 How to use:</b>\n` +
                        `In your Xymbot's <code>config.js</code>, paste:\n` +
                        `<code>global.LICENSE_KEY = "${newKey}";</code>\n\n` +
                        `<i>Or set env var</i> <code>LICENSE_KEY=${newKey}</code>\n` +
                        `<i>in your Render/Railway dashboard.</i>`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '⬅️ Back to Menu', callback_data: 'back_main' }],
                                    [{ text: '📞 Contact Owner', callback_data: 'contact_owner' }],
                                ]
                            }
                        }
                    );

                    // Notify admin of new key issuance
                    for (const adminId of adminIds) {
                        await sendMsg(token, adminId,
                            `🔔 <b>New License Issued!</b>\n\n` +
                            `👤 To: ${fromName} (ID: ${fromId})\n` +
                            `🔑 Key: <code>${newKey}</code>\n` +
                            `♾️ Valid: Lifetime`
                        );
                    }
                }
                return;
            }

            // ── USER: Check Key Status ─────────────────────────────────────
            if (data === 'check_key') {
                const licenses = loadLicenses();
                const myLicense = licenses.find(l => String(l.telegramUserId) === String(fromId));

                if (!myLicense) {
                    await editMsg(token, chatId, msgId,
                        `❌ <b>No license found for your account.</b>\n\nClick <b>Get My LICENSE KEY</b> to generate one.`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔑 Get My LICENSE KEY', callback_data: 'get_key' }],
                                    [{ text: '⬅️ Back', callback_data: 'back_main' }],
                                ]
                            }
                        }
                    );
                    return;
                }

                const isExpired  = myLicense.expiresAt && myLicense.expiresAt < Date.now();
                const isRevoked  = myLicense.status === 'revoked';
                const statusEmoji = isRevoked ? '🚫 Revoked' : isExpired ? '⌛ Expired' : '✅ Active';

                const expiryText = myLicense.expiresAt
                    ? `${new Date(myLicense.expiresAt).toLocaleDateString()}`
                    : '♾️ Lifetime';

                const daysLeft = myLicense.expiresAt
                    ? Math.max(0, Math.ceil((myLicense.expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
                    : '∞';

                await editMsg(token, chatId, msgId,
                    `🔍 <b>Your License Status</b>\n\n` +
                    `🔑 <b>Key:</b> <code>${myLicense.key}</code>\n` +
                    `📊 <b>Status:</b> ${statusEmoji}\n` +
                    `📅 <b>Expires:</b> ${expiryText}\n` +
                    `⏳ <b>Days Left:</b> ${daysLeft}\n` +
                    `👤 <b>Owner:</b> ${myLicense.owner}`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⬅️ Back to Menu', callback_data: 'back_main' }]
                            ]
                        }
                    }
                );
                return;
            }

            // ── USER: Contact Owner ────────────────────────────────────────
            if (data === 'contact_owner') {
                await editMsg(token, chatId, msgId,
                    `📞 <b>Contact Owner</b>\n\n` +
                    `If you need help, extended license, or have any questions:\n\n` +
                    `👤 <b>Owner:</b> ${ownerHandle}\n\n` +
                    `${ownerContact}\n\n` +
                    `<i>Response time: Usually within a few hours.</i>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⬅️ Back to Menu', callback_data: 'back_main' }]
                            ]
                        }
                    }
                );
                return;
            }

            // ── USER: How to Use ──────────────────────────────────────────
            if (data === 'how_to_use') {
                await editMsg(token, chatId, msgId,
                    `📖 <b>How to Use Xymbot</b>\n\n` +
                    `<b>Step 1:</b> Get your LICENSE KEY from this bot.\n\n` +
                    `<b>Step 2:</b> Go to <a href="https://xymbot-pairing.onrender.com">Xymbot Pairing Site</a>\n` +
                    `   → Enter your phone number or scan QR\n` +
                    `   → Copy the <b>SESSION ID</b> sent to your WhatsApp.\n\n` +
                    `<b>Step 3:</b> Deploy Xymbot on Render.com (free):\n` +
                    `   • Build: <code>npm install</code>\n` +
                    `   • Start: <code>node index.js</code>\n` +
                    `   • Set env vars:\n` +
                    `     <code>SESSION_ID=XYMBOT~...</code>\n` +
                    `     <code>LICENSE_KEY=XYM-XXXX-XXXX-XXXX</code>\n\n` +
                    `<b>Step 4:</b> Your bot is live! 🚀`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔑 Get My LICENSE KEY', callback_data: 'get_key' }],
                                [{ text: '⬅️ Back to Menu', callback_data: 'back_main' }],
                            ]
                        }
                    }
                );
                return;
            }

            // ── BACK TO MAIN MENU ─────────────────────────────────────────
            if (data === 'back_main') {
                if (isAdmin(fromId)) {
                    await editMsg(token, chatId, msgId, adminMenuText(), { reply_markup: adminKeyboard() });
                } else {
                    const m = mainMenuForUser(fromName);
                    await editMsg(token, chatId, msgId, m.text, { reply_markup: m.reply_markup });
                }
                return;
            }

            // ── ADMIN: Generate Key ───────────────────────────────────────
            if (data === 'admin_genkey' && isAdmin(fromId)) {
                userStates[fromId] = { action: 'genkey_waiting_input' };
                await editMsg(token, chatId, msgId,
                    `🔑 <b>Generate New License Key</b>\n\n` +
                    `Please reply with the format:\n` +
                    `<code>duration | note</code>\n\n` +
                    `<b>Examples:</b>\n` +
                    `<code>30d | @username</code>\n` +
                    `<code>lifetime | VIP Client</code>\n` +
                    `<code>7d | Trial User</code>`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'back_main' }]]
                        }
                    }
                );
                return;
            }

            // ── ADMIN: Revoke Key ─────────────────────────────────────────
            if (data === 'admin_revoke' && isAdmin(fromId)) {
                userStates[fromId] = { action: 'revoke_waiting_input' };
                await editMsg(token, chatId, msgId,
                    `🚫 <b>Revoke a License Key</b>\n\nReply with the key to revoke:\n<code>XYM-XXXX-XXXX-XXXX</code>`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'back_main' }]]
                        }
                    }
                );
                return;
            }

            // ── ADMIN: List Keys ──────────────────────────────────────────
            if (data === 'admin_list' && isAdmin(fromId)) {
                const all = loadLicenses();
                let listText = `📋 <b>All Licenses (${all.length})</b>\n\n`;
                for (const l of all.slice(-20)) { // Show last 20
                    const emoji = l.status === 'revoked' ? '🚫' : (l.expiresAt && l.expiresAt < Date.now() ? '⌛' : '✅');
                    const exp = l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : 'Lifetime';
                    listText += `${emoji} <code>${l.key}</code>\n   👤 ${l.owner} | 📅 ${exp}\n\n`;
                }
                await editMsg(token, chatId, msgId, listText, {
                    reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_main' }]] }
                });
                return;
            }

            // ── ADMIN: Check any key ──────────────────────────────────────
            if (data === 'admin_check' && isAdmin(fromId)) {
                userStates[fromId] = { action: 'check_waiting_input' };
                await editMsg(token, chatId, msgId,
                    `🔍 <b>Check a Key</b>\n\nReply with any key to inspect it:`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'back_main' }]]
                        }
                    }
                );
                return;
            }

            return;
        }

        // ── INCOMING MESSAGES ─────────────────────────────────────────────
        const message = body.message;
        if (!message || !message.text) return;

        const chatId   = message.chat.id;
        const fromId   = message.from?.id;
        const fromName = message.from?.first_name || 'User';
        const text     = message.text.trim();

        // ── Handle pending state (admin typed input after button prompt) ──
        const state = userStates[fromId];
        if (state) {
            delete userStates[fromId];

            if (state.action === 'genkey_waiting_input') {
                const [durPart, notePart] = text.split('|').map(s => s.trim());
                const duration = durPart || '30d';
                const note = notePart || 'Customer';

                const expiresAt = parseDuration(duration);
                const key = generateKey();
                const lic = { key, owner: note, status: 'active', createdAt: Date.now(), expiresAt, telegramUserId: null };
                const licenses = loadLicenses();
                licenses.push(lic);
                saveLicenses(licenses);

                const expStr = expiresAt ? new Date(expiresAt).toLocaleDateString() : '♾️ Lifetime';
                await sendMsg(token, chatId,
                    `✅ <b>License Generated!</b>\n\n🔑 <code>${key}</code>\n\n👤 For: ${note}\n📅 Expires: ${expStr}`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔑 Generate Another', callback_data: 'admin_genkey' }],
                                [{ text: '⬅️ Admin Panel', callback_data: 'back_main' }],
                            ]
                        }
                    }
                );
                return;
            }

            if (state.action === 'revoke_waiting_input') {
                const keyToRevoke = text.trim();
                const licenses = loadLicenses();
                const target = licenses.find(l => l.key.toUpperCase() === keyToRevoke.toUpperCase());
                if (!target) {
                    await sendMsg(token, chatId, `❌ Key not found: <code>${keyToRevoke}</code>`);
                } else {
                    target.status = 'revoked';
                    saveLicenses(licenses);
                    await sendMsg(token, chatId, `🚫 <b>Revoked!</b> Key <code>${keyToRevoke}</code> is now blocked.`);
                }
                return;
            }

            if (state.action === 'check_waiting_input') {
                const result = verifyLicense(text.trim());
                const statusLine = result.valid
                    ? `✅ <b>VALID</b>\n👤 Owner: ${result.owner || 'N/A'}`
                    : `❌ <b>INVALID:</b> ${result.error}`;
                await sendMsg(token, chatId,
                    `🔍 <b>Key Check:</b> <code>${text.trim()}</code>\n\n${statusLine}`
                );
                return;
            }
        }

        // ── /start and /help ──────────────────────────────────────────────
        if (text === '/start' || text === '/help' || text === '/menu') {
            if (isAdmin(fromId)) {
                await sendMsg(token, chatId, adminMenuText(), { reply_markup: adminKeyboard() });
            } else {
                const m = mainMenuForUser(fromName);
                await sendMsg(token, chatId, m.text, { reply_markup: m.reply_markup });
            }
            return;
        }

        // ── Fallback: show menu ───────────────────────────────────────────
        const m = mainMenuForUser(fromName);
        await sendMsg(token, chatId, m.text, { reply_markup: m.reply_markup });
    });

    // ── REGISTER WEBHOOK ──────────────────────────────────────────────────
    const publicUrl = process.env.RENDER_EXTERNAL_URL || 'https://xymbot-pairing.onrender.com';
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;

    fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`)
        .then(r => r.json())
        .then(r => {
            if (r.ok) console.log(`✅ Telegram Webhook set: ${webhookUrl}`);
            else console.warn('Telegram setWebhook failed:', r.description);
        })
        .catch(e => console.warn('Could not set webhook:', e.message));
}

// ─── DURATION PARSER ──────────────────────────────────────────────────────────
function parseDuration(str) {
    if (!str || ['lifetime', 'forever', '∞'].includes(str.toLowerCase())) return null;
    const m = str.match(/^(\d+)([dhmwy])$/i);
    if (!m) return null;
    const v = parseInt(m[1]), u = m[2].toLowerCase(), now = Date.now();
    const map = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
    return now + v * (map[u] || 86400000);
}
