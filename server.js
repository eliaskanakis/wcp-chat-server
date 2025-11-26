const http = require('http');
const WebSocket = require('ws');
const firebaseAccess = require('./firebaseAccess');

const PORT = process.env.PORT || 4000;
const HISTORY_PAGE_SIZE = 8;

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const socketsPerChannel = new Map();
const pendingSignals = new Map();
const SIGNAL_BUFFER_TTL_MS = 10000; // 10 seconds

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
  const users = sockets.map((entry) => ({
    username: entry.username,
    userId: entry.userId
  }));

  socket.send(JSON.stringify({
    type: 'channel-users',
    channelId,
    users
  }));
};

const broadcastUserJoin = (channelId, username, userId) => {
  broadcastToChannel(channelId, {
    type: 'user-joined',
    username,
    userId
  });
};

const broadcastUserLeave = (channelId, username, userId) => {
  broadcastToChannel(channelId, {
    type: 'user-left',
    username,
    userId
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
  broadcastUserJoin(channelId, username, socket.userId || null);
  sendChannelUsers(socket, channelId);
  flushBufferedSignals(socket);
};

const onDisconnect = (socket) => {
  const { channelId, username, userId } = socket;
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
    broadcastUserLeave(channelId, username, userId)
  }
};

const findChannelMember = (channelDef, userId) => {
  if (!channelDef || !Array.isArray(channelDef.members)) {
    return undefined;
  }

  return channelDef.members.find((member) => member.userId === userId);
};

const findSocketInChannel = (channelId, userId) => {
  if (!channelId || !userId) {
    return undefined;
  }

  const sockets = socketsPerChannel.get(channelId) || [];
  return sockets
    .filter((entry) => entry.userId === userId)
    .find((entry) => entry.readyState === WebSocket.OPEN);
};

const bufferSignal = (channelId, targetUserId, payload) => {
  const key = `${channelId}:${targetUserId}`;
  if (!pendingSignals.has(key)) {
    pendingSignals.set(key, []);
  }

  const expiresAt = Date.now() + SIGNAL_BUFFER_TTL_MS;
  pendingSignals.get(key).push({
    payload,
    expiresAt
  });
};

const flushBufferedSignals = (socket) => {
  if (!socket.channelId || !socket.userId) {
    return;
  }

  const key = `${socket.channelId}:${socket.userId}`;
  const buffered = pendingSignals.get(key);
  if (!buffered || buffered.length === 0) {
    return;
  }

  const now = Date.now();
  const remaining = [];
  buffered.forEach((entry) => {
    if (entry.expiresAt < now) {
      console.log('Discarded expired buffered signal for', socket.userId);
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(entry.payload));
      console.log('Buffered signal sent to', socket.userId, 'in channel', socket.channelId);
    } else {
      remaining.push(entry);
      confirm.log('Socket not open, keeping buffered signal for', socket.userId);
    }
  });

  if (remaining.length === 0) {
    pendingSignals.delete(key);
  } else {
    pendingSignals.set(key, remaining);
  }
};

const forwardWebRTCSignal = (ws, msg) => {
  const { channelId: msgChannelId, targetUserId } = msg;

  // Determine the effective channel: from message or from socket
  const channelId = msgChannelId || ws.channelId;
  if (!channelId) {
    sendSocketError(ws, 'WebRTC signaling missing channel context');
    return;
  }

  if (!ws.channelId || ws.channelId !== channelId) {
    sendSocketError(ws, 'You can only signal within your current channel');
    return;
  }

  // Must have some role to participate at all
  if (!ws.channelRole) {
    sendSocketError(ws, 'Join a channel with a valid role before using WebRTC');
    return;
  }

  // Observers are allowed to ACCEPT (answer/ICE) but not INITIATE (offer)
  if (ws.channelRole === 'observer' && msg.type === 'webrtc-offer') {
    sendSocketError(ws, 'Observer role cannot initiate calls in this channel');
    return;
  }

  if (!targetUserId) {
    sendSocketError(ws, 'WebRTC signaling missing target user');
    return;
  }

  console.log(`Forwarding WebRTC ${msg.type} from ${ws.userId} to ${targetUserId} in channel ${channelId}`);
  const targetSocket = findSocketInChannel(channelId, targetUserId);
  if (!targetSocket) {
    bufferSignal(channelId, targetUserId, {
      type: msg.type,
      channelId,
      from: ws.username,
      userId: ws.userId,
      fromUserId: ws.userId,
      targetUserId,
      sdp: msg.sdp,
      ice: msg.ice || msg.candidate,
      candidate: msg.candidate,
    });
    //sendSocketError(ws, 'Target user is reconnecting');
    console.log('Target user is reconnecting. Buffered signal for', targetUserId);
    return;
  }


  // Only forward a subset of fields to avoid leaking unwanted data
  const payload = {
    type: msg.type,          // "webrtc-offer" | "webrtc-answer" | "webrtc-ice"
    channelId,
    fromUserId: ws.userId,
    targetUserId,
    from: ws.username,
    userId: ws.userId,
  };

  if (msg.sdp) {
    payload.sdp = msg.sdp;
  }
  const candidate = msg.ice || msg.candidate;
  if (candidate) {
    payload.ice = candidate;
  }

  targetSocket.send(JSON.stringify(payload));
};

const forwardCallSignal = (ws, msg) => {
  const { channelId: msgChannelId, targetUserId } = msg;

  const channelId = msgChannelId || ws.channelId;
  if (!channelId) {
    sendSocketError(ws, 'Call signaling missing channel context');
    return;
  }

  if (!ws.channelId || ws.channelId !== channelId) {
    sendSocketError(ws, 'You can only signal within your current channel');
    return;
  }

  if (!ws.userId) {
    sendSocketError(ws, 'Call signaling requires an authenticated user');
    return;
  }

  if (!targetUserId) {
    sendSocketError(ws, 'Call signaling missing target user');
    return;
  }

  console.log(`Forwarding call ${msg.type} from ${ws.userId} to ${targetUserId} in channel ${channelId}`);
  const targetSocket = findSocketInChannel(channelId, targetUserId);
  if (!targetSocket) {
    bufferSignal(channelId, targetUserId, {
      type: msg.type,
      channelId,
      fromUserId: ws.userId,
      targetUserId,
      from: ws.username,
      userId: ws.userId,

    });
    sendSocketError(ws, 'Target user is reconnecting');
    return;
  }

  const payload = {
    type: msg.type,         // "call-cancelled" | "call-rejected" | "call-ended"
    channelId,
    fromUserId: ws.userId,
    targetUserId,
    from: ws.username,
    userId: ws.userId,
  };

  targetSocket.send(JSON.stringify(payload));
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

const handleJoinMessage = async (ws, msg) => {
  const channelId = msg.channelId;
  if (!channelId) {
    sendSocketError(ws, 'Join message missing channelId');
    return;
  }

  const frbUserIdToken = msg.firebaseUserIdToken;
  if (!frbUserIdToken) {
    sendSocketError(ws, 'Join message missing firebaseUserIdToken');
    return;
  }

  try {
    const frbDecodedToken = await firebaseAccess.verifyIdToken(frbUserIdToken);
    ws.userId = frbDecodedToken.uid;
    ws.frbClaims = frbDecodedToken;
    await handleChannelJoin(ws, channelId, frbDecodedToken);
    console.log(`User ${ws.userId} joined channel ${channelId}`);
  } catch (err) {
    console.error('Failed to complete join', err);
    sendSocketError(ws, err.message || 'Join failed');
    if (!ws.channelId) {
      ws.close(1008, 'Join failed');
    }
  }
};

const handleChatMessage = async (ws, msg) => {
  const channelId = ws.channelId || msg.channelId;
  if (!channelId) {
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
};

const handleHistoryRequest = async (ws, msg) => {
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
};

const handlePingMessage = (ws, msg) => {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type: 'pong',
    clientTs: msg.clientTs,
    serverTs: Date.now()
  }));
};

const MESSAGE_HANDLERS = {
  join: handleJoinMessage,
  chat: handleChatMessage,
  'fetch-history': handleHistoryRequest,
  ping: handlePingMessage,
  'webrtc-offer': forwardWebRTCSignal,
  'webrtc-answer': forwardWebRTCSignal,
  'webrtc-ice': forwardWebRTCSignal,
  'call-cancelled': forwardCallSignal,
  'call-rejected': forwardCallSignal,
  'call-ended': forwardCallSignal
};

const dispatchIncomingMessage = async (ws, msg) => {
  const handler = MESSAGE_HANDLERS[msg.type];
  if (!handler) {
    console.warn('Unknown message type', msg.type);
    return;
  }

  await handler(ws, msg);
};

wss.on('connection', (ws) => {
  console.log('Client connected');

  /*ws.send(JSON.stringify({
    type: 'system',
    text: 'Welcome to the chat server!'
  }));*/

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

    try {
      await dispatchIncomingMessage(ws, msg);
    } catch (err) {
      console.error(`Failed to process message of type ${msg.type}`, err);
      sendSocketError(ws, 'Unexpected server error');
    }

  });

  ws.on('close', () => {
    onDisconnect(ws);
    console.log('Client disconnected.userId =', ws.userId);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});
