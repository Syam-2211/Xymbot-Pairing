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
    boundSession: { type: String, default: null }, // Locks the key to ONE custom session name
    issuedToTelegramId: { type: String, default: null }
});

const LicenseModel = mongoose.models.License || mongoose.model('License', LicenseSchema);


// 2. License Verification Function
export async function verifyLicense(key, sessionId) {
    if (!key) return { valid: false, message: 'No key provided' };
    
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

// Telegram license management commands
export function initTelegramBot(app) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN is missing. License Bot disabled.');
        return;
    }

    const ownerId = process.env.OWNER_ID?.trim();
    if (!ownerId) {
        console.warn('⚠️ OWNER_ID is missing. Owner commands are disabled.');
    }

    const bot = new TelegramBot(token, { polling: true });

    const generateKey = () => {
        const p1 = crypto.randomBytes(4).toString('hex').toUpperCase();
        const p2 = crypto.randomBytes(4).toString('hex').toUpperCase();
        return `XYM-${p1}-${p2}`;
    };

    const isOwner = (msg) => Boolean(
        ownerId &&
        msg.chat.type === 'private' &&
        String(msg.from?.id) === ownerId &&
        String(msg.chat.id) === ownerId
    );
    const requireOwner = async (msg) => {
        if (isOwner(msg)) return true;
        if (msg.chat.type === 'private') {
            await bot.sendMessage(msg.chat.id, ownerId ? '⛔ This command is for the bot owner only.' : '⛔ Owner commands are not configured.');
        }
        return false;
    };
    const requireDatabase = async (chatId) => {
        if (mongoose.connection.readyState === 1) return true;
        await bot.sendMessage(chatId, '❌ MongoDB is not connected. Check the MONGO_URI setting and try again.');
        return false;
    };
    const durationLabel = (days) => days >= 9999 ? 'Lifetime' : `${days} days`;
    const licenseStatus = (license) => {
        if (license.expiresAt && license.expiresAt < new Date()) return 'Expired';
        return license.isActivated ? 'Active' : 'Unused';
    };

    bot.on('polling_error', (error) => {
        console.error('Telegram polling error:', error.message);
    });

    bot.onText(/^\/start(?:@\w+)?(?:\s.*)?$/i, (msg) => {
        bot.sendMessage(msg.chat.id, 'Welcome. Use /getkey to receive a license key.');
    });

    bot.onText(/^\/gen(?:@\w+)?\s+(life|\d+)$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        const lifetime = match[1].toLowerCase() === 'life';
        const days = lifetime ? 9999 : Number(match[1]);
        if (!lifetime && (!Number.isInteger(days) || days < 1 || days > 9998)) {
            return bot.sendMessage(msg.chat.id, '❌ Choose a duration from 1 to 9998 days, or use /gen life.');
        }

        try {
            const key = generateKey();
            await LicenseModel.create({ key, durationDays: days });
            await bot.sendMessage(msg.chat.id, `✅ License created\nKey: ${key}\nDuration: ${durationLabel(days)}`);
        } catch (error) {
            console.error('License generation failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not create the license. Check the server logs.');
        }
    });

    bot.onText(/^\/keys(?:@\w+)?$/i, async (msg) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const [licenses, total] = await Promise.all([
                LicenseModel.find().sort({ createdAt: -1 }).limit(20).lean(),
                LicenseModel.countDocuments()
            ]);
            if (!licenses.length) return bot.sendMessage(msg.chat.id, 'There are no licenses yet.');

            const lines = licenses.map((license) =>
                `${license.key} | ${licenseStatus(license)} | ${durationLabel(license.durationDays)}`
            );
            await bot.sendMessage(msg.chat.id, `Licenses (${licenses.length} shown, ${total} total):\n${lines.join('\n')}`);
        } catch (error) {
            console.error('License listing failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not load licenses.');
        }
    });

    bot.onText(/^\/check(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const key = match[1].trim().toUpperCase();
            const license = await LicenseModel.findOne({ key }).lean();
            if (!license) return bot.sendMessage(msg.chat.id, '❌ License key not found.');

            const details = `🔍 License status\nKey: ${license.key}\nStatus: ${licenseStatus(license)}\nDuration: ${durationLabel(license.durationDays)}\nExpires: ${license.expiresAt ? new Date(license.expiresAt).toISOString() : 'Starts on first activation'}`;
            if (isOwner(msg)) {
                return bot.sendMessage(msg.chat.id, `${details}\nBound session: ${license.boundSession || 'None'}\nCreated: ${new Date(license.createdAt).toISOString()}`);
            }
            await bot.sendMessage(msg.chat.id, details);
        } catch (error) {
            console.error('License status check failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not check this key.');
        }
    });

    bot.onText(/^\/reset(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const key = match[1].trim().toUpperCase();
            const license = await LicenseModel.findOne({ key });
            if (!license) return bot.sendMessage(msg.chat.id, '❌ License key not found.');

            license.isActivated = false;
            license.boundSession = null;
            license.expiresAt = null;
            await license.save();
            await bot.sendMessage(msg.chat.id, `✅ Key reset and unbound: ${key}`);
        } catch (error) {
            console.error('License reset failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not reset this key.');
        }
    });

    bot.onText(/^\/remove(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const key = match[1].trim().toUpperCase();
            const result = await LicenseModel.deleteOne({ key });
            await bot.sendMessage(msg.chat.id, result.deletedCount ? `✅ License deleted: ${key}` : '❌ License key not found.');
        } catch (error) {
            console.error('License deletion failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not delete this key.');
        }
    });

    bot.onText(/^\/killall(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;
        if (match[1] !== 'CONFIRM') {
            return bot.sendMessage(msg.chat.id, 'This permanently deletes every license. To continue, send /killall CONFIRM.');
        }

        try {
            const result = await LicenseModel.deleteMany({});
            await bot.sendMessage(msg.chat.id, `✅ Deleted ${result.deletedCount} license(s).`);
        } catch (error) {
            console.error('Bulk license deletion failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not delete all licenses.');
        }
    });

    bot.onText(/^\/stats(?:@\w+)?$/i, async (msg) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const [total, activated, expired] = await Promise.all([
                LicenseModel.countDocuments(),
                LicenseModel.countDocuments({ isActivated: true }),
                LicenseModel.countDocuments({ expiresAt: { $lt: new Date() } })
            ]);
            await bot.sendMessage(msg.chat.id, `License totals\nAll: ${total}\nActivated: ${activated}\nExpired: ${expired}`);
        } catch (error) {
            console.error('License stats failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not load statistics.');
        }
    });

    bot.onText(/^\/getkey(?:@\w+)?$/i, async (msg) => {
        if (msg.chat.type !== 'private') {
            return bot.sendMessage(msg.chat.id, 'Please message me privately to request a key.');
        }
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const requesterId = String(msg.from.id);
            const existing = await LicenseModel.findOne({ issuedToTelegramId: requesterId })
                .sort({ createdAt: -1 });
            if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
                return bot.sendMessage(msg.chat.id, `You already have a license key:\n${existing.key}\nStatus: ${licenseStatus(existing)}`);
            }

            const key = generateKey();
            await LicenseModel.create({ key, durationDays: 30, issuedToTelegramId: requesterId });
            await bot.sendMessage(msg.chat.id, `✅ Your 30-day license key is ready:\n${key}\n\nUse /check ${key} to check its status.`);
        } catch (error) {
            console.error('Automatic license generation failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not generate a key. Please try again later.');
        }
    });


    bot.onText(/^\/contact(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
        const message = match[1]?.trim();
        const contact = process.env.OWNER_CONTACT?.trim();
        if (!message) {
            return bot.sendMessage(msg.chat.id, contact ? `Owner contact: ${contact}` : 'Send /contact followed by your message to contact the owner.');
        }
        if (msg.chat.type !== 'private') {
            return bot.sendMessage(msg.chat.id, 'Please message me privately to contact the owner.');
        }
        if (!ownerId) {
            return bot.sendMessage(msg.chat.id, contact ? `Owner contact: ${contact}` : '❌ Owner contact is not configured.');
        }

        const requesterName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Telegram user';
        const username = msg.from.username ? `@${msg.from.username}` : 'no username';
        try {
            await bot.sendMessage(ownerId, `Client message from ${requesterName} (${username}, ID ${msg.from.id}):\n\n${message.slice(0, 3000)}`);
            await bot.sendMessage(msg.chat.id, '✅ Your message was sent to the owner.');
        } catch (error) {
            console.error('Owner contact message failed:', error);
            await bot.sendMessage(msg.chat.id, contact ? `Could not deliver the message. Contact the owner directly: ${contact}` : '❌ Could not deliver your message. Try again later.');
        }
    });

    console.log(`✅ Telegram License Bot is online. Owner commands ${ownerId ? 'enabled' : 'disabled'}; MongoDB state: ${mongoose.connection.readyState}`);
}
