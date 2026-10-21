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

const LicenseRequestSchema = new mongoose.Schema({
    requesterId: { type: String, required: true },
    requesterName: { type: String, default: '' },
    username: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

const LicenseRequest = mongoose.models.LicenseRequest || mongoose.model('LicenseRequest', LicenseRequestSchema);

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
        const ownerCommands = `Owner commands (private chat only):
/gen <days|life> - Create a license
/keys - List the latest 20 keys
/check <key> - Full license details
/reset <key> - Unbind a key
/remove <key> - Delete one key
/killall CONFIRM - Delete every key
/stats - License totals
/requests - Show client requests
/approve <request-id> <days|life> - Issue a requested key
/deny <request-id> - Reject a request`;
        const clientCommands = `Client commands:
/getkey - Request a license from the owner
/check <key> - Check your key status
/contact <message> - Message the owner`;
        bot.sendMessage(msg.chat.id, isOwner(msg) ? ownerCommands : clientCommands);
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
            const [total, activated, expired, pendingRequests] = await Promise.all([
                LicenseModel.countDocuments(),
                LicenseModel.countDocuments({ isActivated: true }),
                LicenseModel.countDocuments({ expiresAt: { $lt: new Date() } }),
                LicenseRequest.countDocuments({ status: 'pending' })
            ]);
            await bot.sendMessage(msg.chat.id, `License totals\nAll: ${total}\nActivated: ${activated}\nExpired: ${expired}\nPending client requests: ${pendingRequests}`);
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
        if (!ownerId) {
            return bot.sendMessage(msg.chat.id, '❌ The owner has not configured request notifications yet.');
        }

        try {
            const requesterId = String(msg.from.id);
            const existing = await LicenseRequest.findOne({ requesterId, status: 'pending' });
            if (existing) return bot.sendMessage(msg.chat.id, 'Your license request is already waiting for the owner.');

            const requesterName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Telegram user';
            const request = await LicenseRequest.create({
                requesterId,
                requesterName,
                username: msg.from.username || ''
            });
            const username = msg.from.username ? `@${msg.from.username}` : 'no username';
            await bot.sendMessage(ownerId, `New license request\nID: ${request._id}\nFrom: ${requesterName} (${username})\nTelegram ID: ${requesterId}\nApprove: /approve ${request._id} 30\nReject: /deny ${request._id}`);
            await bot.sendMessage(msg.chat.id, '✅ Your request was sent to the owner. They will send your key here after approval.');
        } catch (error) {
            console.error('License request failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not submit your request. Please try again later.');
        }
    });

    bot.onText(/^\/requests(?:@\w+)?$/i, async (msg) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const requests = await LicenseRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20).lean();
            if (!requests.length) return bot.sendMessage(msg.chat.id, 'There are no pending license requests.');
            const lines = requests.map((request) =>
                `${request._id} | ${request.requesterName} | ${request.username ? `@${request.username}` : request.requesterId}`
            );
            await bot.sendMessage(msg.chat.id, `Pending requests:\n${lines.join('\n')}\n\nApprove: /approve <id> <days|life>\nReject: /deny <id>`);
        } catch (error) {
            console.error('License request listing failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not load requests.');
        }
    });

    bot.onText(/^\/approve(?:@\w+)?\s+([a-f\d]{24})\s+(life|\d+)$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        const lifetime = match[2].toLowerCase() === 'life';
        const days = lifetime ? 9999 : Number(match[2]);
        if (!lifetime && (!Number.isInteger(days) || days < 1 || days > 9998)) {
            return bot.sendMessage(msg.chat.id, '❌ Choose a duration from 1 to 9998 days, or use life.');
        }

        try {
            const request = await LicenseRequest.findOne({ _id: match[1], status: 'pending' });
            if (!request) return bot.sendMessage(msg.chat.id, '❌ Pending request not found.');

            const key = generateKey();
            await LicenseModel.create({ key, durationDays: days });
            request.status = 'approved';
            await request.save();

            let delivered = true;
            try {
                await bot.sendMessage(request.requesterId, `✅ Your license request was approved.\nKey: ${key}\nDuration: ${durationLabel(days)}\n\nUse /check ${key} to check its status.`);
            } catch (deliveryError) {
                delivered = false;
                console.error('License delivery failed:', deliveryError.message);
            }
            await bot.sendMessage(msg.chat.id, `✅ License created for request ${request._id}.\nKey: ${key}\nDelivery: ${delivered ? 'sent to client' : 'failed; send the key to the client manually'}`);
        } catch (error) {
            console.error('License approval failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not approve this request.');
        }
    });

    bot.onText(/^\/deny(?:@\w+)?\s+([a-f\d]{24})$/i, async (msg, match) => {
        if (!await requireOwner(msg)) return;
        if (!await requireDatabase(msg.chat.id)) return;

        try {
            const request = await LicenseRequest.findOneAndUpdate(
                { _id: match[1], status: 'pending' },
                { status: 'rejected' },
                { new: true }
            );
            if (!request) return bot.sendMessage(msg.chat.id, '❌ Pending request not found.');
            await bot.sendMessage(request.requesterId, 'Your license request was declined. Use /contact <message> if you need to reach the owner.');
            await bot.sendMessage(msg.chat.id, `✅ Request ${request._id} declined.`);
        } catch (error) {
            console.error('License request rejection failed:', error);
            await bot.sendMessage(msg.chat.id, '❌ Could not reject this request.');
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
