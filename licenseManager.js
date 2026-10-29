import mongoose from 'mongoose';
import crypto from 'crypto';

// 1. Define the License Database Schema
const LicenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    durationDays: { type: Number, required: true, default: 30 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    isActivated: { type: Boolean, default: false },
    boundSession: { type: String, default: null }, // Locks the key to ONE custom session name
    issuedToTelegramId: { type: String, default: null }
});

const LicenseModel = mongoose.models.License || mongoose.model('License', LicenseSchema);

// Helper to generate key matching XYM-XXXX-XXXX format
export function generateRandomKey() {
    const p1 = crypto.randomBytes(4).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `XYM-${p1}-${p2}`;
}

// 2. Client-Facing Key Generation (For users directly on the website)
export async function clientGenerateKey() {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database is disconnected.');
    }
    const key = generateRandomKey();
    const newLicense = await LicenseModel.create({
        key,
        durationDays: 30 // Default 30-day client license
    });
    return newLicense.key;
}

// 3. Anti-Abuse Session-Bound License Verification Function
export async function verifyLicense(key, sessionId) {
    if (!key) return { valid: false, message: 'No key provided' };
    
    try {
        const license = await LicenseModel.findOne({ key: key.trim().toUpperCase() });
        if (!license) return { valid: false, message: 'Invalid License Key' };

        // First Activation: Lock to the client's custom session ID
        if (!license.isActivated) {
            license.isActivated = true;
            license.boundSession = sessionId;
            
            // Set expiration date
            const daysToMs = license.durationDays * 24 * 60 * 60 * 1000;
            license.expiresAt = new Date(Date.now() + daysToMs);
            
            await license.save();
            return { valid: true, message: 'License activated and locked to session!' };
        }

        // Anti-Abuse: Block if another bot/session tries to use this key
        if (license.boundSession && license.boundSession !== sessionId) {
            return { valid: false, message: 'License key is already in use on another bot session!' };
        }

        // Expiration Check
        if (license.expiresAt && new Date() > license.expiresAt) {
            return { valid: false, message: 'License key has expired!' };
        }

        return { valid: true, message: 'License valid' };
    } catch (err) {
        console.error('Database Error:', err);
        return { valid: false,
