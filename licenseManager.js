import mongoose from 'mongoose';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';

// 1. Define the License Database Schema
const LicenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    durationDays: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    isActivated: { type: Boolean, default: false },
    boundSession: { type: String, default: null } // Locks the key to ONE custom session name
});

const LicenseModel = mongoose.models.License || mongoose.model('License', LicenseSchema);

// 2. License Verification Function
export async function verifyLicense(key, sessionId) {
    if (!key) return { valid: false, message: 'No key provided' };
    
    // Optional Master Key that never expires and ignores locking
    if (key === 'syam-lifetime-pass') {
        return { valid: true, type: 'lifetime', message: 'Master key accepted' };
    }

    try {
        const license = await LicenseModel.findOne({ key: key.trim() });
        if (!license) return { valid: false, message: 'Invalid License Key' };

        // First Activation: Lock to the client's custom session ID
        if (!license.isActivated) {
            license.isActivated = true;
            license.boundSession = sessionId;
            
            // Set expiration date (9999 days = lifetime)
            const daysToMs = license.durationDays * 24 * 60 * 60 * 1000;
            license.expiresAt = new Date(Date.now() + daysToMs);
            
            await license.save();
            return { valid: true, message: 'License activated and locked to session!' };
        }

        // Anti-Abuse: Block if another bot tries to use this key
        if (license.boundSession && license.boundSession !== sessionId) {
            return { valid: false, message: 'License key is already in use on another bot!' };
        }

        // Expiration Check
        if (license.expiresAt && new Date() > license.expiresAt) {
            return { valid: false, message: 'License key has expired!' };
        }

        return { valid: true, message: 'License valid' };
    } catch (err) {
        console.error('Database Error:', err);
        return { valid: false, message: 'Server verification error' };
    }
}

// 3. Telegram Bot Admin Panel
export function initTelegramBot(app) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN is missing. License Bot disabled.');
        return;
    }

    const bot = new TelegramBot(token, { polling: true });

    const generateKey = () => {
        const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
        return `XYM-${p1}-${p2}`;
    };

    // /gen 30 (Creates a 30-day key)
    bot.onText(/\/(gen|generate) (\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const days = parseInt(match[2]);
        const key = generateKey();

        try {
            await LicenseModel.create({ key, durationDays: days });
            bot.sendMessage(chatId, `✅ *New License Generated!*\n\n🔑 \`${key}\`\n⏳ Duration: ${days} Days\n\n_Send this key to your client._`, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, '❌ Failed to save key to MongoDB.');
        }
    });

    // /gen life (Creates a lifetime key)
    bot.onText(/\/(gen|generate) life/, async (msg) => {
        const chatId = msg.chat.id;
        const key = generateKey();

        try {
            await LicenseModel.create({ key, durationDays: 9999 }); 
            bot.sendMessage(chatId, `✅ *Lifetime License Generated!*\n\n🔑 \`${key}\`\n⏳ Duration: Lifetime\n\n_Send this key to your client._`, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, '❌ Failed to save key to MongoDB.');
        }
    });

    // /reset XYM-ABCD-1234 (Unbinds a key if a client changes their bot name)
    bot.onText(/\/(reset|revoke) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const key = match[2].trim();

        try {
            const license = await LicenseModel.findOne({ key });
            if (!license) return bot.sendMessage(chatId, '❌ Key not found.');

            license.isActivated = false;
            license.boundSession = null;
            license.expiresAt = null;
            await license.save();

            bot.sendMessage(chatId, `✅ *Key Reset!*\n\n🔑 \`${key}\`\n\nThe key is unbound and can be used by a new bot.`, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, '❌ Failed to reset key.');
        }
    });

    // /check XYM-ABCD-1234 (Check status and who is using the key)
    bot.onText(/\/check (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const key = match[1].trim();

        try {
            const license = await LicenseModel.findOne({ key });
            if (!license) return bot.sendMessage(chatId, '❌ Key not found.');

            let status = `🔑 *Key:* \`${license.key}\`\n`;
            status += `⏳ *Duration:* ${license.durationDays === 9999 ? 'Lifetime' : license.durationDays + ' Days'}\n`;
            status += `🟢 *Activated:* ${license.isActivated ? 'Yes' : 'No'}\n`;
            if (license.boundSession) status += `📱 *Bound to Bot:* \`${license.boundSession}\`\n`;
            if (license.expiresAt) status += `📅 *Expires:* ${license.expiresAt.toDateString()}\n`;

            bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, '❌ Failed to check key.');
        }
    });

    console.log('✅ Telegram License Bot is online and secured with MongoDB!');
}