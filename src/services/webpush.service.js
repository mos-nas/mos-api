const fs = require('fs').promises;
const path = require('path');
const webpush = require('web-push');

const VAPID_PATH = '/boot/config/api/vapid.json';
const SUBSCRIPTIONS_PATH = '/boot/config/api/push-subscriptions.json';

class WebPushService {
  constructor() {
    this.initialized = false;
    this.vapidKeys = null;
    this.subscriptions = [];
    this._dirty = false;
  }

  /**
   * Initializes VAPID keys (loads existing or generates new ones)
   * Must be called once before using any other method
   */
  async init() {
    if (this.initialized) return;

    try {
      this.vapidKeys = await this._loadVapidKeys();
    } catch {
      this.vapidKeys = this._generateVapidKeys();
      await this._saveVapidKeys(this.vapidKeys);
      console.info('New VAPID keys generated and saved to:', VAPID_PATH);
    }

    webpush.setVapidDetails('mailto:admin@mos-official.net', this.vapidKeys.publicKey, this.vapidKeys.privateKey);

    await this._loadSubscriptions();
    this.initialized = true;
    console.info(`Web Push initialized with ${this.subscriptions.length} active subscription(s)`);
  }

  /**
   * Returns the public VAPID key for the frontend
   * @returns {string} Public VAPID key
   */
  getPublicKey() {
    if (!this.vapidKeys) {
      throw new Error('WebPushService not initialized');
    }
    return this.vapidKeys.publicKey;
  }

  /**
   * Adds a push subscription for a user
   * @param {string} userId - User ID
   * @param {string} username - Username
   * @param {Object} subscription - Browser push subscription object
   * @returns {Object} Result
   */
  async subscribe(userId, username, subscription) {
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      throw new Error('Invalid push subscription object');
    }

    // Remove existing subscription with same endpoint (re-subscribe)
    this.subscriptions = this.subscriptions.filter((sub) => sub.endpoint !== subscription.endpoint);

    this.subscriptions.push({
      userId,
      username,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      createdAt: new Date().toISOString(),
    });

    await this._persistSubscriptions();

    return {
      success: true,
      message: 'Push subscription registered',
    };
  }

  /**
   * Removes a push subscription by endpoint
   * @param {string} endpoint - The subscription endpoint URL to remove
   * @returns {Object} Result
   */
  async unsubscribe(endpoint) {
    if (!endpoint) {
      throw new Error('Endpoint is required');
    }

    const initialLength = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((sub) => sub.endpoint !== endpoint);

    if (this.subscriptions.length === initialLength) {
      return {
        success: false,
        message: 'Subscription not found',
      };
    }

    await this._persistSubscriptions();

    return {
      success: true,
      message: 'Push subscription removed',
    };
  }

  /**
   * Sends a push notification to all active subscriptions
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {string} [priority='normal'] - Priority level (high, normal, low)
   * @returns {Object} Result with success/failure counts
   */
  async sendToAll(title, body, priority = 'normal') {
    if (!this.initialized) await this.init();
    if (this.subscriptions.length === 0) return { sent: 0, failed: 0 };

    const payload = JSON.stringify({ title, body, priority });
    let sent = 0;
    let failed = 0;
    const expiredEndpoints = [];

    for (const sub of this.subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload
        );
        sent++;
      } catch (error) {
        failed++;
        const host = new URL(sub.endpoint).host;
        console.error(`Web Push failed for ${host}: ${error.statusCode || ''} ${error.body || error.message}`);
        if (error.statusCode === 410 || error.statusCode === 404) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    }

    if (expiredEndpoints.length > 0) {
      this.subscriptions = this.subscriptions.filter(
        sub => !expiredEndpoints.includes(sub.endpoint)
      );
      this._dirty = true;
    }

    return { sent, failed };
  }

  // --- Private methods ---

  _generateVapidKeys() {
    return webpush.generateVAPIDKeys();
  }

  async _loadVapidKeys() {
    const data = await fs.readFile(VAPID_PATH, 'utf8');
    const keys = JSON.parse(data);
    if (!keys.publicKey || !keys.privateKey) {
      throw new Error('Invalid VAPID keys file');
    }
    return keys;
  }

  async _saveVapidKeys(keys) {
    await fs.mkdir(path.dirname(VAPID_PATH), { recursive: true });
    await fs.writeFile(VAPID_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }

  async _loadSubscriptions() {
    try {
      const data = await fs.readFile(SUBSCRIPTIONS_PATH, 'utf8');
      const parsed = JSON.parse(data);
      this.subscriptions = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.subscriptions = [];
    }
  }

  /**
   * Persists subscriptions to disk — only called on explicit subscribe/unsubscribe
   * Also flushes any pending expired-subscription cleanups (dirty flag)
   * @private
   */
  async _persistSubscriptions() {
    this._dirty = false;
    await fs.mkdir(path.dirname(SUBSCRIPTIONS_PATH), { recursive: true });
    await fs.writeFile(SUBSCRIPTIONS_PATH, JSON.stringify(this.subscriptions, null, 2), { mode: 0o600 });
  }
}

module.exports = new WebPushService();
