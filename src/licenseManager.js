import mongoose from 'mongoose';

const licenseSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    durationDays: { type: Number, default: 30 },
    expiresAt: Date,
    isActivated: { type: Boolean, default: false },
    boundSession: { type: String, default: null }
});

const License = mongoose.models.License || mongoose.model('License', licenseSchema);

export function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `XYM-${segment()}-${segment()}-${segment()}`;
}

export async function verifyLicense(key, sessionId) {
    try {
        const license = await License.findOne({ key });
        if (!license) {
            return { valid: false, message: 'Invalid license key.' };
        }

        if (license.isActivated && license.boundSession && license.boundSession !== sessionId) {
            return { valid: false, message: 'License key is already bound to another device/session.' };
        }

        if (license.expiresAt && new Date() > license.expiresAt) {
            return { valid: false, message: 'License key has expired.' };
        }

        if (!license.isActivated) {
            license.isActivated = true;
            license.boundSession = sessionId || 'default-session';
            license.expiresAt = new Date(Date.now() + (license.durationDays * 24 * 60 * 60 * 1000));
            await license.save();
        }

        return { valid: true, message: 'License verified successfully.', expiresAt: license.expiresAt };
    } catch (err) {
        console.error('License Verification Error:', err);
        return { valid: false, message: 'Database error verifying license.' };
    }
}

export async function clientGenerateKey() {
    const newKey = generateRandomKey();
    await License.create({ key: newKey, durationDays: 30, isActivated: false });
    return newKey;
}
