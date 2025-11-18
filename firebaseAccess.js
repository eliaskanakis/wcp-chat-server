const EventEmitter = require('events');
const frbAdmin = require('firebase-admin');

class FirebaseAccess extends EventEmitter {
  constructor() {
    super();
    this.channelCache = new Map();
    this.userProfileEntries = new Map();
    this.channelWatcherStarted = false;

    this.frbCredential = this.createCredential();
    this.frbApp = frbAdmin.apps.length
      ? frbAdmin.app()
      : frbAdmin.initializeApp({
          credential: this.frbCredential
        });

    this.frbAuth = this.frbApp.auth();
    this.frbDb = this.frbApp.firestore();
    this.frbChannelsDocRef = this.frbDb.collection('config').doc('channels');
    this.frbUsersCollection = this.frbDb.collection('users');

    this.startChannelWatcher();
  }

  createCredential() {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (json) {
      try {
        const parsed = JSON.parse(json);
        return frbAdmin.credential.cert(parsed);
      } catch (err) {
        console.error('Invalid FIREBASE_SERVICE_ACCOUNT JSON', err);
        throw err;
      }
    }

    const base64 =
      process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (base64) {
      try {
        const decoded = Buffer.from(base64, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return frbAdmin.credential.cert(parsed);
      } catch (err) {
        console.error('Invalid FIREBASE_SERVICE_ACCOUNT_B64 value', err);
        throw err;
      }
    }

    return frbAdmin.credential.applicationDefault();
  }

  verifyIdToken(token) {
    return this.frbAuth.verifyIdToken(token);
  }

  startChannelWatcher() {
    if (this.channelWatcherStarted) {
      return;
    }
    this.channelWatcherStarted = true;

    this.frbChannelsDocRef.onSnapshot(
      (snapshot) => {
        const data = snapshot.data();
        const channels = Array.isArray(data?.items) ? data.items : [];
        this.updateChannelCache(channels);
      },
      (err) => {
        console.error('Channel watcher error', err);
      }
    );
  }

  updateChannelCache(channels) {
    const nextMap = new Map();
    channels.forEach((channel) => {
      if (channel && channel.id) {
        nextMap.set(channel.id, channel);
      }
    });

    this.channelCache = nextMap;
    this.emit('channels-updated', this.getAllChannels());
  }

  getAllChannels() {
    return Array.from(this.channelCache.values());
  }

  getCachedChannel(channelId) {
    if (!channelId) {
      return null;
    }

    return this.channelCache.get(channelId) || null;
  }

  async fetchChannelDefinition(channelId) {
    if (!channelId) {
      return null;
    }

    const cached = this.getCachedChannel(channelId);
    if (cached) {
      return cached;
    }

    await this.loadChannelCache();
    return this.getCachedChannel(channelId);
  }

  async loadChannelCache() {
    try {
      const snapshot = await this.frbChannelsDocRef.get();
      if (!snapshot.exists) {
        this.updateChannelCache([]);
        return;
      }

      const data = snapshot.data();
      const channels = Array.isArray(data?.channels) ? data.channels : [];
      this.updateChannelCache(channels);
    } catch (err) {
      console.error('Failed to fetch channel config', err);
      throw err;
    }
  }

  async fetchUserProfile(userId) {
    if (!userId) {
      return null;
    }

    try {
      const doc = await this.frbUsersCollection.doc(userId).get();
      if (!doc.exists) {
        return null;
      }
      return doc.data() || null;
    } catch (err) {
      console.error('Failed to fetch user profile', err);
      return null;
    }
  }

  subscribeToUserProfile(userId, handler) {
    if (!userId || typeof handler !== 'function') {
      return () => {};
    }

    let entry = this.userProfileEntries.get(userId);
    if (!entry) {
      entry = {
        handlers: new Set(),
        unsubscribe: null,
        latest: null
      };

      entry.unsubscribe = this.frbUsersCollection.doc(userId).onSnapshot(
        (snapshot) => {
          entry.latest = snapshot.exists ? snapshot.data() : null;
          entry.handlers.forEach((cb) => {
            try {
              cb(entry.latest);
            } catch (err) {
              console.error('User profile handler failed', err);
            }
          });
        },
        (err) => {
          console.error('User profile watcher error', err);
        }
      );

      this.userProfileEntries.set(userId, entry);
    }

    entry.handlers.add(handler);
    if (entry.latest !== null) {
      try {
        handler(entry.latest);
      } catch (err) {
        console.error('User profile handler failed', err);
      }
    }

    return () => {
      const current = this.userProfileEntries.get(userId);
      if (!current) {
        return;
      }

      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        if (current.unsubscribe) {
          current.unsubscribe();
        }
        this.userProfileEntries.delete(userId);
      }
    };
  }

  getChannelMessagesCollection(channelId) {
    if (!channelId) {
      throw new Error('channelId is required');
    }

    return this.frbDb
      .collection('channelMessages')
      .doc(channelId)
      .collection('messages');
  }

  async saveChatMessage(channelId, message) {
    if (!channelId || !message) {
      return null;
    }

    const doc = {
      ...message,
      channelId
    };

    try {
      await this.getChannelMessagesCollection(channelId).add(doc);
    } catch (err) {
      console.error('Failed to persist chat message', err);
    }
    return null;
  }

  async fetchRecentMessages(channelId, limit = 20, beforeTs) {
    if (!channelId) {
      return [];
    }

    try {
      let query = this.getChannelMessagesCollection(channelId).orderBy('ts', 'desc');

      if (typeof beforeTs === 'number') {
        query = query.where('ts', '<', beforeTs);
      }

      query = query.limit(limit);

      const snapshot = await query.get();
      return snapshot.docs.map((doc) => doc.data());
    } catch (err) {
      console.error('Failed to fetch chat history', err);
      return [];
    }
  }
}

module.exports = new FirebaseAccess();
