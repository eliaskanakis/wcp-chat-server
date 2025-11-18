const http = require('http');
const WebSocket = require('ws');
const firebaseAccess = require('./firebaseAccess');

const PORT = process.env.PORT || 4000;
const HISTORY_PAGE_SIZE = 20;

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const socketsPerChannel = new Map();

const getSocketsForChannel = (channelId) => {
  if (!channelId) {
    return undefined;
  }

  if (!socketsPerChannel.has(channelId)) {
    socketsPerChannel.set(channelId, []);
  }

  return socketsPerChannel.get(channelId);
};

const broadcastToChannel = (channelId, payload) => {
  const sockets = socketsPerChannel.get(channelId);
  if (!sockets) {
    return;
  }

  sockets.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
};

const sendChannelUsers = (socket, channelId) => {
  const sockets = socketsPerChannel.get(channelId) || [];
  const users = sockets.map((entry, index) => ({
    username: entry.username,
    sequenceNumber: index + 1
  }));

  socket.send(JSON.stringify({
    type: 'channel-users',
    channelId,
    users
  }));
};

const broadcastUserJoin = (channelId, username, sequenceNumber) => {
  broadcastToChannel(channelId, {
    type: 'user-joined',
    from: username,
    sequenceNumber
  });
};

const broadcastUserLeave = (channelId, username) => {
  broadcastToChannel(channelId, {
    type: 'user-left',
    from: username
  });
};

const broadcastChatMessage = (channelId, payload) => {
  broadcastToChannel(channelId, payload);
};

const sendSocketError = (socket, text) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'error',
      text
    }));
  }
};

const attachUserProfileWatcher = (socket, initialProfile) => {
  if (!socket.userId) {
    return;
  }

  if (initialProfile) {
    socket.userProfile = initialProfile;
    socket.isGlobalAdmin = Boolean(initialProfile.globalAdmin);
    if (initialProfile.name) {
      socket.username = initialProfile.name;
    }
  }

  if (socket.userProfileUnsubscribe) {
    socket.userProfileUnsubscribe();
  }

  socket.userProfileUnsubscribe = firebaseAccess.subscribeToUserProfile(
    socket.userId,
    (profile) => {
      socket.userProfile = profile || undefined;
      socket.isGlobalAdmin = Boolean(profile?.globalAdmin);
      if (profile?.name) {
        socket.username = profile.name;
      }

      if (socket.channelId) {
        enforceSocketChannelAccess(socket);
      }
    }
  );
};

const detachUserProfileWatcher = (socket) => {
  if (socket.userProfileUnsubscribe) {
    socket.userProfileUnsubscribe();
    socket.userProfileUnsubscribe = null;
  }
};

firebaseAccess.on('channels-updated', () => {
  enforceChannelPolicies();
});

const sendChannelHistory = (socket, channelId, messages) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: 'channel-history',
    channelId,
    messages: messages || []
  }));
};

const sendRecentHistory = async (socket, channelId, beforeTs) => {
  if (!channelId) {
    return;
  }

  try {
    const messages = await firebaseAccess.fetchRecentMessages(
      channelId,
      HISTORY_PAGE_SIZE,
      beforeTs
    );
    sendChannelHistory(socket, channelId, messages);
  } catch (err) {
    console.error('Failed to send channel history', err);
    sendSocketError(socket, 'Unable to load chat history');
  }
};

const onUserJoin = (socket, channelId, username) => {
  const sockets = getSocketsForChannel(channelId);
  if (!sockets) {
    return;
  }

  socket.channelId = channelId;
  socket.username = username;

  sockets.push(socket);
  broadcastUserJoin(channelId, username, sockets.length);
  sendChannelUsers(socket, channelId);
};

const onDisconnect = (socket) => {
  const { channelId, username } = socket;
  detachUserProfileWatcher(socket);
  if (!channelId) {
    return;
  }

  const sockets = socketsPerChannel.get(channelId);
  if (!sockets) {
    return;
  }

  const index = sockets.indexOf(socket);
  if (index !== -1) {
    sockets.splice(index, 1);
  }

  if (sockets.length === 0) {
    socketsPerChannel.delete(channelId);
  }

  if (username) {
    broadcastUserLeave(channelId, username);
  }
};

const findChannelMember = (channelDef, userId) => {
  if (!channelDef || !Array.isArray(channelDef.members)) {
    return undefined;
  }

  return channelDef.members.find((member) => member.userId === userId);
};

const getChannelMaxUsers = (channelDef) => {
  if (!channelDef || !channelDef.rules) {
    return undefined;
  }

  const raw = channelDef.rules.maxUsers;
  if (typeof raw === 'number') {
    return raw;
  }

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
};

function disconnectSocket(socket, reason) {
  sendSocketError(socket, reason);
  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1008, reason);
    }
  } catch (err) {
    console.error('Failed to close socket cleanly', err);
  }
}

function enforceSocketChannelAccess(socket, overrideChannelDef) {
  if (!socket.channelId || !socket.userId) {
    return;
  }

  const channelDef = overrideChannelDef || firebaseAccess.getCachedChannel(socket.channelId);
  if (!channelDef) {
    return;
  }

  const channelMember = findChannelMember(channelDef, socket.userId);
  if (channelMember?.isBlocked && !socket.isGlobalAdmin) {
    disconnectSocket(socket, 'You are blocked from this channel');
    return;
  }

  const isAllowed =
    Boolean(channelDef.isPublic) ||
    Boolean(channelMember) ||
    Boolean(socket.isGlobalAdmin);
  if (!isAllowed) {
    disconnectSocket(socket, 'You are not allowed to participate in this channel');
    return;
  }

  const nextRole = channelMember?.role || (socket.isGlobalAdmin ? 'admin' : 'staff');
  socket.channelRole = nextRole;
}

function enforceChannelPolicies() {
  socketsPerChannel.forEach((clients, channelId) => {
    const channelDef = firebaseAccess.getCachedChannel(channelId);
    if (!channelDef) {
      const orphans = clients.slice();
      orphans.forEach((socket) => {
        disconnectSocket(socket, 'Channel is no longer available');
      });
      socketsPerChannel.delete(channelId);
      return;
    }

    const maxUsers = getChannelMaxUsers(channelDef);
    if (maxUsers && clients.length > maxUsers) {
      const overflowSockets = clients.slice(maxUsers);
      overflowSockets.forEach((socket) => {
        disconnectSocket(socket, 'Channel capacity updated, please try again later');
      });
    }

    const remainingClients = socketsPerChannel.get(channelId) || [];
    remainingClients.slice().forEach((socket) => {
      enforceSocketChannelAccess(socket, channelDef);
    });
  });
}

const handleChannelJoin = async (socket, channelId, frbDecodedToken) => {
  const [channelDef, frbUserProfile] = await Promise.all([
    firebaseAccess.fetchChannelDefinition(channelId),
    firebaseAccess.fetchUserProfile(frbDecodedToken.uid)
  ]);

  if (!channelDef) {
    throw new Error('Channel not found');
  }

  const frbGlobalAdmin = Boolean(frbUserProfile?.globalAdmin);
  const channelMember = findChannelMember(channelDef, frbDecodedToken.uid);

  if (channelMember?.isBlocked && !frbGlobalAdmin) {
    throw new Error('You are blocked from this channel');
  }

  if (!channelDef.isPublic && !channelMember && !frbGlobalAdmin) {
    throw new Error('You are not allowed to join this channel');
  }

  const maxUsers = getChannelMaxUsers(channelDef);
  const sockets = getSocketsForChannel(channelId) || [];
  if (maxUsers && sockets.length >= maxUsers) {
    throw new Error('Channel has reached the maximum number of users');
  }

  const username =
    frbUserProfile?.name ||
    frbDecodedToken.name ||
    frbDecodedToken.email ||
    frbDecodedToken.uid;

  const channelRole = channelMember?.role || (frbGlobalAdmin ? 'admin' : 'staff');

  socket.channelRole = channelRole;
  socket.channelInfo = {
    id: channelDef.id,
    name: channelDef.name || channelDef.id
  };
  socket.userProfile = frbUserProfile || undefined;
  socket.isGlobalAdmin = frbGlobalAdmin;
  attachUserProfileWatcher(socket, frbUserProfile || null);

  onUserJoin(socket, channelId, username);
  sendRecentHistory(socket, channelId).catch((err) => {
    console.error('Failed to send initial history', err);
  });
};

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.send(JSON.stringify({
    type: 'system',
    text: 'Welcome to the chat server!'
  }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error('Invalid JSON', e);
      ws.send(JSON.stringify({
        type: 'error',
        text: 'Invalid JSON'
      }));
      return;
    }

    if (msg.type === 'join') {
      const channelId = msg.channelId;
      if (!channelId) {
        console.error('Join message missing channelId');
        sendSocketError(ws, 'Join message missing channelId');
        return;
      }
      const frbUserIdToken = msg.firebaseUserIdToken;
      if (!frbUserIdToken) {
        console.error('Join message missing firebaseUserIdToken');
        sendSocketError(ws, 'Join message missing firebaseUserIdToken');
        return;
      }

      try {
        const frbDecodedToken = await firebaseAccess.verifyIdToken(frbUserIdToken);
        ws.userId = frbDecodedToken.uid;
        ws.frbClaims = frbDecodedToken;
        await handleChannelJoin(ws, channelId, frbDecodedToken);
      } catch (err) {
        console.error('Failed to complete join', err);
        sendSocketError(ws, err.message || 'Join failed');
        if (!ws.channelId) {
          ws.close(1008, 'Join failed');
        }
      }
      return;
    }

    if (msg.type === 'chat') {
      const channelId = ws.channelId || msg.channelId;
      if (!channelId) {
        console.error('Chat message missing channel context');
        sendSocketError(ws, 'Chat message missing channel context');
        return;
      }

      if (!ws.channelRole) {
        sendSocketError(ws, 'Join a channel before sending messages');
        return;
      }

      if (ws.channelRole === 'observer') {
        sendSocketError(ws, 'Observer role cannot send messages');
        return;
      }

      const payload = {
        type: 'chat',
        channelId,
        from: ws.username || 'Anonymous',
        text: msg.text || '',
        ts: Date.now()
      };

      broadcastChatMessage(channelId, payload);
      firebaseAccess.saveChatMessage(channelId, {
        ...payload,
        userId: ws.userId || null
      });
    }

    if (msg.type === 'fetch-history') {
      const channelId = msg.channelId || ws.channelId;
      if (!channelId) {
        sendSocketError(ws, 'History request missing channelId');
        return;
      }

      if (ws.channelId !== channelId) {
        sendSocketError(ws, 'You can only request history for your current channel');
        return;
      }

      const beforeTs = typeof msg.beforeTs === 'number' ? msg.beforeTs : undefined;
      await sendRecentHistory(ws, channelId, beforeTs);
      return;
    }
  });

  ws.on('close', () => {
    onDisconnect(ws);
    console.log('Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});
