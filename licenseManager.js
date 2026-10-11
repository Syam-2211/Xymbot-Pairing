import fs from 'fs';
import path, { dirname } from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, 'licenses.json');

// ─── LICENSE DATABASE ────────────────────────────────────────────────────────

// Default keys are disabled — only official generated keys are accepted
const BLOCKED_DEFAULT_KEYS = ['XYM-BOT-PAIR', 'CLIENT001', 'XYMBOT-FREE'];

function loadLicenses() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2), 'utf8');
            return [];
        }
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        if (!Array.isArray(data)) return [];
        // Ensure no blocked default keys can ever be loaded or used
        return data.filter(l => !BLOCKED_DEFAULT_KEYS.includes((l.key || '').toUpperCase()));
    } catch (e) {
        return [];
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
    if (!key || typeof key !== 'string' || !key.trim()) {
        return { valid: false, error: 'License Key missing. A generated license key is required.' };
    }

    const cleanKey = key.trim().toUpperCase();

    // Default keys are strictly disabled
    if (BLOCKED_DEFAULT_KEYS.includes(cleanKey)) {
        return { valid: false, error: 'Default keys are disabled. Only generated keys from the Telegram bot are accepted.' };
    }

    // Optional environment VALID_KEYS whitelist override
    const envKeys = (process.env.VALID_KEYS || '').split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
    if (envKeys.includes(cleanKey)) {
        return { valid: true, message: 'License verified successfully.', owner: 'Admin Whitelist', lifetime: true };
    }

    const licenses = loadLicenses();
    const lic = licenses.find(l => (l.key || '').toUpperCase() === cleanKey);
    if (!lic) {
        return { valid: false, error: 'Invalid License Key. Only official generated keys can be used to run the bot.' };
    }
    if (lic.status === 'revoked') {
        return { valid: false, error: 'License revoked by admin.' };
    }

    // Lifetime validity — no expiration validation
    return { valid: true, message: 'License verified successfully.', owner: lic.owner, lifetime: true };
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
            [{ text: '🗑️ Delete All Active Keys', callback_data: 'admin_delete_active' }],
            [{ text: '💣 Delete ALL Keys', callback_data: 'admin_deleteall' }],
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
                    l.status === 'active'
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

                const isRevoked  = myLicense.status === 'revoked';
                const statusEmoji = isRevoked ? '🚫 Revoked' : '✅ Active';

                await editMsg(token, chatId, msgId,
                    `🔍 <b>Your License Status</b>\n\n` +
                    `🔑 <b>Key:</b> <code>${myLicense.key}</code>\n` +
                    `📊 <b>Status:</b> ${statusEmoji}\n` +
                    `♾️ <b>Validity:</b> Lifetime (Never Expires)\n` +
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
                    `🔑 <b>Generate Lifetime License Key</b>\n\n` +
                    `All keys are generated with <b>♾️ Lifetime</b> validity.\n` +
                    `Please reply with a note/owner name for this key:\n\n` +
                    `<b>Example:</b>\n` +
                    `<code>VIP Client - John</code>`,
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
                    const emoji = l.status === 'revoked' ? '🚫' : '✅';
                    listText += `${emoji} <code>${l.key}</code>\n   👤 ${l.owner} | ♾️ Lifetime\n\n`;
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

            // ── ADMIN: Delete All Active Keys ─────────────────────────────
            if (data === 'admin_delete_active' && isAdmin(fromId)) {
                const all = loadLicenses();
                const activeKeys = all.filter(l => l.status === 'active');

                if (activeKeys.length === 0) {
                    await editMsg(token, chatId, msgId,
                        `ℹ️ <b>No Active Keys Found</b>\n\nThere are currently no active license keys in the database.`,
                        {
                            reply_markup: {
                                inline_keyboard: [[{ text: '⬅️ Admin Panel', callback_data: 'back_main' }]]
                            }
                        }
                    );
                    return;
                }

                await editMsg(token, chatId, msgId,
                    `🗑️ <b>Delete All Active License Keys?</b>\n\n` +
                    `⚠️ This will <b>permanently delete</b> all <b>${activeKeys.length} active keys</b>!\n` +
                    `Any bot instances currently running on these keys will be stopped.\n\n` +
                    `<b>Are you sure you want to proceed?</b>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ YES, Delete All Active Keys', callback_data: 'admin_delete_active_confirm' }],
                                [{ text: '❌ No, Cancel', callback_data: 'back_main' }],
                            ]
                        }
                    }
                );
                return;
            }

            // ── ADMIN: Confirm Delete All Active Keys ─────────────────────
            if (data === 'admin_delete_active_confirm' && isAdmin(fromId)) {
                const all = loadLicenses();
                const activeCount = all.filter(l => l.status === 'active').length;
                const remaining = all.filter(l => l.status !== 'active');
                saveLicenses(remaining);

                await editMsg(token, chatId, msgId,
                    `🗑️ <b>Done! All ${activeCount} active license keys have been deleted.</b>\n\n` +
                    `Active bots using these keys are now deauthorized.\n` +
                    `New keys can be generated anytime.`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔑 Generate New Key', callback_data: 'admin_genkey' }],
                                [{ text: '⬅️ Admin Panel', callback_data: 'back_main' }],
                            ]
                        }
                    }
                );
                return;
            }

            // ── ADMIN: Delete ALL Keys ────────────────────────────────────
            if (data === 'admin_deleteall' && isAdmin(fromId)) {
                const count = loadLicenses().length;
                await editMsg(token, chatId, msgId,
                    `🗑️ <b>Delete ALL License Keys?</b>\n\n` +
                    `⚠️ This will <b>permanently delete</b> all <b>${count} generated keys</b>!\n\n` +
                    `<b>This action cannot be undone.</b>\n\n` +
                    `Are you absolutely sure?`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ YES, Delete Everything', callback_data: 'admin_deleteall_confirm' }],
                                [{ text: '❌ No, Cancel', callback_data: 'back_main' }],
                            ]
                        }
                    }
                );
                return;
            }

            // ── ADMIN: Confirm Delete ALL ────────────────────────────────
            if (data === 'admin_deleteall_confirm' && isAdmin(fromId)) {
                const before = loadLicenses().length;
                fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2), 'utf8');
                await editMsg(token, chatId, msgId,
                    `🗑️ <b>Done! All ${before} license keys have been deleted.</b>\n\n` +
                    `The license database is now empty.\n` +
                    `New keys can be generated anytime.`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔑 Generate New Key', callback_data: 'admin_genkey' }],
                                [{ text: '⬅️ Admin Panel', callback_data: 'back_main' }],
                            ]
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
                const note = text.trim() || 'Customer';
                const key = generateKey();
                const lic = { key, owner: note, status: 'active', createdAt: Date.now(), expiresAt: null, telegramUserId: null };
                const licenses = loadLicenses();
                licenses.push(lic);
                saveLicenses(licenses);

                await sendMsg(token, chatId,
                    `✅ <b>Lifetime License Generated!</b>\n\n🔑 <code>${key}</code>\n\n👤 For: ${note}\n♾️ Validity: <b>Lifetime (Never Expires)</b>`,
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
                    ? `✅ <b>VALID (Lifetime)</b>\n👤 Owner: ${result.owner || 'N/A'}`
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
