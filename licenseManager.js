import mongoose from 'mongoose';
import crypto from 'crypto';

const LicenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    durationDays: { type: Number, required: true, default: 30 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    isActivated: { type: Boolean, default: false },
    boundSession: { type: String, default: null },
    issuedToTelegramId: { type: String, default: null }
});

const LicenseModel = mongoose.models.License || mongoose.model('License', LicenseSchema);

export function generateRandomKey() {
    const p1 = crypto.randomBytes(4).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `XYM-${p1}-${p2}`;
}

// Client-facing generation remains disabled per your security rules
export async function clientGenerateKey() {
    throw new Error('Unauthorized: Client-side key generation is disabled.');
}

// Admin API to create keys programmatically
export async function adminGenerateKey(durationDays = 30) {
    const key = generateRandomKey();
    const expiresAt = new Date(Date.now() + (durationDays * 24 * 60 * 60 * 1000));
    
    const newLicense = await LicenseModel.create({
        key,
        durationDays,
        expiresAt,
        isActivated: false
    });
    return newLicense;
}

export async function verifyLicense(key, sessionId) {
    if (!key) return { valid: false, message: 'No key provided' };
    
    try {
        const license = await LicenseModel.findOne({ key: key.trim().toUpperCase() });
        if (!license) return { valid: false, message: 'Invalid License Key' };

        if (!license.isActivated) {
            license.isActivated = true;
            license.boundSession = sessionId;
            await license.save();
            return { valid: true, message: 'License activated and locked to session!' };
        }

        if (license.boundSession && license.boundSession !== sessionId) {
            return { valid: false, message: 'License key is already in use on another bot session!' };
        }

        if (license.expiresAt && new Date() > license.expiresAt) {
            return { valid: false, message: 'License key has expired!' };
        }

        return { valid: true, message: 'License valid' };
    } catch (err) {
        console.error('Database Error:', err);
        return { valid: false, message: 'Server verification error' };
    }
}
