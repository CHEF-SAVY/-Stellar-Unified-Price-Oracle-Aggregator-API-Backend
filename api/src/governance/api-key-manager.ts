import crypto from 'crypto';
import { logger } from '../observability/logger';
import type { Role } from './rbac';

export type KeyTier = 'free' | 'pro' | 'enterprise' | 'admin';

export const TIER_RATE_LIMITS: Record<KeyTier, number> = {
  free: 60,
  pro: 500,
  enterprise: 10000,
  admin: 100000,
};

export interface ApiKeyMetadata {
  keyHash: string;
  /** Non-secret leading segment of the key, kept for display in admin listings */
  keyPrefix: string;
  createdAt: number;
  lastUsed: number | null;
  requestCount: number;
  isActive: boolean;
  rateLimitPerMin: number;
  tier: KeyTier;
  role: Role;
  description?: string;
  /** If set, this key is in rotation grace period until this timestamp */
  rotationExpiresAt?: number;
}

/** Metadata plus the plaintext key, returned only when a key is created or rotated. */
export interface GeneratedApiKey extends ApiKeyMetadata {
  key: string;
}

export interface ApiKeyStore {
  [keyHash: string]: ApiKeyMetadata;
}

export class ApiKeyManager {
  /** Keyed by SHA-256 hash of the API key — plaintext keys are never retained. */
  private keys: Map<string, ApiKeyMetadata> = new Map();
  private lastMinuteRequests: Map<string, number[]> = new Map();

  constructor() {
    this.loadKeysFromEnv();
  }

  generateKey(rateLimitPerMin: number = TIER_RATE_LIMITS.free, description?: string, tier: KeyTier = 'free', role: Role = 'viewer'): GeneratedApiKey {
    const key = this.createKey(tier);
    const keyHash = this.hashKey(key);
    const metadata: ApiKeyMetadata = {
      keyHash,
      keyPrefix: key.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: true,
      rateLimitPerMin,
      tier,
      role,
      description,
    };

    this.keys.set(keyHash, metadata);
    logger.info(`Generated new API key: ${metadata.keyPrefix}... tier=${tier} role=${role} limit=${rateLimitPerMin}/min`);

    return { ...metadata, key };
  }

  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
    const metadata = this.keys.get(this.hashKey(key));

    if (!metadata) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!metadata.isActive) {
      return { valid: false, error: 'API key has been revoked' };
    }

    return { valid: true, metadata };
  }

  isAdminKey(key: string): boolean {
    const metadata = this.keys.get(this.hashKey(key));
    return !!metadata && metadata.role === 'admin';
  }

  checkRateLimit(key: string): { allowed: boolean; remaining: number; resetTime: number; retryAfter?: number } {
    const keyHash = this.hashKey(key);
    const metadata = this.keys.get(keyHash);
    if (!metadata) {
      return { allowed: false, remaining: 0, resetTime: 0 };
    }

    const now = Date.now();
    const windowMs = 60000;
    const oneMinuteAgo = now - windowMs;

    let requests = this.lastMinuteRequests.get(keyHash) || [];
    requests = requests.filter((ts) => ts > oneMinuteAgo);

    if (requests.length >= metadata.rateLimitPerMin) {
      const oldestRequest = Math.min(...requests);
      const resetTime = oldestRequest + windowMs;
      const retryAfter = Math.ceil((resetTime - now) / 1000);

      return { allowed: false, remaining: 0, resetTime, retryAfter };
    }

    requests.push(now);
    this.lastMinuteRequests.set(keyHash, requests);

    metadata.lastUsed = now;
    metadata.requestCount++;

    const remaining = metadata.rateLimitPerMin - requests.length;
    return { allowed: true, remaining, resetTime: now + windowMs };
  }

  rotateKey(oldKeyHash: string): GeneratedApiKey | null {
    const metadata = this.keys.get(oldKeyHash);
    if (!metadata) return null;

    const newKey = this.createKey(metadata.tier);
    const newHash = this.hashKey(newKey);
    const newMetadata: ApiKeyMetadata = {
      ...metadata,
      keyHash: newHash,
      keyPrefix: newKey.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
    };

    this.keys.delete(oldKeyHash);
    this.lastMinuteRequests.delete(oldKeyHash);
    this.keys.set(newHash, newMetadata);
    logger.info(`Rotated API key: old=${metadata.keyPrefix}... new=${newMetadata.keyPrefix}...`);

    return { ...newMetadata, key: newKey };
  }

  revokeKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = false;
    logger.info(`Revoked API key: ${metadata.keyPrefix}...`);
    return true;
  }

  deactivateKey(keyHash: string): boolean {
    return this.revokeKey(keyHash);
  }

  reactivateKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = true;
    logger.info(`Reactivated API key: ${metadata.keyPrefix}...`);
    return true;
  }

  getKeyMetadata(keyHash: string): ApiKeyMetadata | null {
    return this.keys.get(keyHash) || null;
  }

  getAllKeys(): Array<{ keyPrefix: string; keyHash: string; createdAt: number; lastUsed: number | null; requestCount: number; isActive: boolean; rateLimitPerMin: number; tier: KeyTier; role: Role; description?: string }> {
    return Array.from(this.keys.values()).map((m) => ({
      keyPrefix: m.keyPrefix + '...',
      keyHash: m.keyHash,
      createdAt: m.createdAt,
      lastUsed: m.lastUsed,
      requestCount: m.requestCount,
      isActive: m.isActive,
      rateLimitPerMin: m.rateLimitPerMin,
      tier: m.tier,
      role: m.role,
      description: m.description,
    }));
  }

  findByHash(hash: string): ApiKeyMetadata | null {
    return this.keys.get(hash) || null;
  }

  updateRateLimit(keyHash: string, newLimit: number): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.rateLimitPerMin = newLimit;
    logger.info(`Updated rate limit for ${metadata.keyPrefix}... to ${newLimit}/min`);
    return true;
  }

  updateTier(keyHash: string, tier: KeyTier): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.tier = tier;
    metadata.rateLimitPerMin = TIER_RATE_LIMITS[tier];
    logger.info(`Updated tier for ${metadata.keyPrefix}... to ${tier} (${TIER_RATE_LIMITS[tier]}/min)`);
    return true;
  }

  deleteKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    const result = this.keys.delete(keyHash);
    if (result) {
      this.lastMinuteRequests.delete(keyHash);
      logger.info(`Deleted API key: ${metadata!.keyPrefix}...`);
    }
    return result;
  }

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private createKey(tier: KeyTier = 'free'): string {
    const prefix = tier === 'admin' ? 'sk_admin_' : `sk_${tier}_`;
    return prefix + crypto.randomBytes(32).toString('hex');
  }

  private loadKeysFromEnv(): void {
    const envKeys = process.env.API_KEYS;
    if (!envKeys) {
      if (this.keys.size === 0) {
        const adminKey = this.generateKey(TIER_RATE_LIMITS.admin, 'Default admin key', 'admin', 'admin');
        logger.info(`Generated default admin key: ${adminKey.key}`);
        logger.info('Store this key securely. It will not be shown again.');
      }
      return;
    }

    try {
      // Format: key1:limit1:desc1:tier1:role1,key2:...
      for (const config of envKeys.split(',')) {
        const parts = config.trim().split(':');
        if (parts.length >= 1 && parts[0]) {
          const key = parts[0];
          const limit = parseInt(parts[1], 10);
          const description = parts[2] || undefined;
          const tier = (parts[3] as KeyTier) || 'free';
          const role = (parts[4] as Role) || 'viewer';

          const keyHash = this.hashKey(key);
          const metadata: ApiKeyMetadata = {
            keyHash,
            keyPrefix: key.substring(0, 12),
            createdAt: Date.now(),
            lastUsed: null,
            requestCount: 0,
            isActive: true,
            rateLimitPerMin: isNaN(limit) ? TIER_RATE_LIMITS[tier] : limit,
            tier,
            role,
            description,
          };

          this.keys.set(keyHash, metadata);
        }
      }

      logger.info(`Loaded ${this.keys.size} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }
}

export const apiKeyManager = new ApiKeyManager();
