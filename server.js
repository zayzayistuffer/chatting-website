const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const { Server } = require('socket.io');

const scrypt = promisify(crypto.scrypt);
const app = express();
const httpServer = require('node:http').createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SERVER_DIR = path.join(ROOT, 'servers');
const SITE_OWNERS_FILE = path.join(ROOT, 'site-owners.json');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SERVER_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], memberships: {}, messages: {} }, null, 2));
}
let SITE_OWNER_USERNAMES = new Set(JSON.parse(fs.readFileSync(SITE_OWNERS_FILE, 'utf8')).usernames);

function readData() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.users ||= [];
  data.memberships ||= {};
  data.messages ||= {};
  data.passwordResets ||= [];
  return data;
}

function writeData(data) {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryFile, DATA_FILE);
}

function loadServers() {
  const files = fs.readdirSync(SERVER_DIR).filter((file) => file.endsWith('.json'));
  const servers = files.map((file) => {
    const server = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, file), 'utf8'));
    server.channels ||= [{ id: 'general', name: 'general', locked: false }];
    if (!/^[a-z0-9-]+$/.test(server.id) || !server.name || !server.invites || !server.roles) {
      throw new Error(`Invalid server definition: ${file}`);
    }
    if (!Array.isArray(server.channels) || server.channels.length === 0) {
      throw new Error(`Server ${server.id} must define at least one channel`);
    }
    const channelIds = new Set();
    for (const channel of server.channels) {
      if (!/^[a-z0-9-]+$/.test(channel.id) || !channel.name || channelIds.has(channel.id)) {
        throw new Error(`Invalid or duplicate channel in ${server.id}`);
      }
      if (channel.locked !== undefined && typeof channel.locked !== 'boolean') {
        throw new Error(`Channel ${channel.id} in ${server.id} has an invalid locked value`);
      }
      channelIds.add(channel.id);
    }
    return server;
  });
  const ids = new Set();
  const inviteCodes = new Set();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`Duplicate server id: ${server.id}`);
    ids.add(server.id);
    for (const [code, role] of Object.entries(server.invites)) {
      if (inviteCodes.has(code)) throw new Error(`Duplicate invite code: ${code}`);
      if (!server.roles.includes(role)) throw new Error(`Unknown role "${role}" in ${server.id}`);
      inviteCodes.add(code);
    }
  }
  return servers;
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl || null };
}

function tokenFromRequest(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)chat_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function getSession(request) {
  const token = tokenFromRequest(request);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAuth(request, response, next) {
  const session = getSession(request);
  if (!session) return response.status(401).json({ error: 'Please sign in to continue.' });
  request.userId = session.userId;
  next();
}

function getMembership(userId, serverId) {
  return readData().memberships[userId]?.[serverId] || null;
}

function isSiteOwner(userId) {
  const user = readData().users.find((entry) => entry.id === userId);
  return Boolean(user && SITE_OWNER_USERNAMES.has(user.username));
}

function findServer(serverId) {
  return loadServers().find((server) => server.id === serverId);
}

function hasServerAccess(userId, serverId) {
  return Boolean(findServer(serverId) && (isSiteOwner(userId) || getMembership(userId, serverId)));
}

function getServerRole(userId, serverId) {
  return isSiteOwner(userId) ? 'Site Owner' : getMembership(userId, serverId);
}

function findChannel(server, channelId) {
  return server?.channels.find((channel) => channel.id === channelId);
}

function canManageServer(role) {
  return role === 'Owner' || role === 'Site Owner';
}

function publicServer(server, userId) {
  const role = getServerRole(userId, server.id);
  return {
    id: server.id,
    name: server.name,
    description: server.description || '',
    channels: server.channels,
    roles: server.roles,
    role,
    ...(canManageServer(role) ? { invites: server.invites } : {}),
  };
}

function emitServerUpdate(serverId) {
  io.to(serverId).emit('refresh');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.post('/api/register', async (request, response, next) => {
  try {
    const username = String(request.body.username || '').trim().toLowerCase();
    const displayName = String(request.body.displayName || '').trim();
    const password = String(request.body.password || '');
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return response.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers, or underscores.' });
    }
    if (displayName.length < 1 || displayName.length > 32) {
      return response.status(400).json({ error: 'Display name must be 1–32 characters.' });
    }
    if (password.length < 8 || password.length > 128) {
      return response.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const data = readData();
    if (data.users.some((user) => user.username === username)) {
      return response.status(409).json({ error: 'That username is already taken.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    const user = { id: crypto.randomUUID(), username, displayName, salt, passwordHash };
    data.users.push(user);
    data.memberships[user.id] = {};
    writeData(data);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
    response.cookie('chat_session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS });
    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', async (request, response, next) => {
  try {
    const username = String(request.body.username || '').trim().toLowerCase();
    const data = readData();
    const user = data.users.find((entry) => entry.username === username);
    if (!user) return response.status(401).json({ error: 'Username or password is incorrect.' });
    const passwordHash = (await scrypt(String(request.body.password || ''), user.salt, 64)).toString('hex');
    const storedHash = Buffer.from(user.passwordHash, 'hex');
    const suppliedHash = Buffer.from(passwordHash, 'hex');
    if (storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) {
      return response.status(401).json({ error: 'Username or password is incorrect.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
    response.cookie('chat_session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS });
    response.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/servers/:serverId/password-resets', requireAuth, (request, response) => {
  const { serverId } = request.params;
  if ((!isSiteOwner(request.userId) && getMembership(request.userId, serverId) !== 'Owner') || !findServer(serverId)) {
    return response.status(403).json({ error: 'Only a server Owner or Site Owner can create password reset codes.' });
  }
  const username = String(request.body.username || '').trim().toLowerCase();
  const data = readData();
  const user = data.users.find((entry) => entry.username === username);
  if (!user || !data.memberships[user.id]?.[serverId]) {
    return response.status(404).json({ error: 'No matching member was found in this server.' });
  }

  const resetCode = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + 15 * 60 * 1000;
  data.passwordResets = data.passwordResets.filter((entry) => entry.expiresAt > Date.now() && entry.userId !== user.id);
  data.passwordResets.push({
    userId: user.id,
    serverId,
    codeHash: crypto.createHash('sha256').update(resetCode).digest('hex'),
    expiresAt,
  });
  writeData(data);
  response.status(201).json({ resetCode, expiresAt });
});

app.post('/api/password-reset/complete', async (request, response, next) => {
  try {
    const username = String(request.body.username || '').trim().toLowerCase();
    const resetCode = String(request.body.resetCode || '');
    const password = String(request.body.password || '');
    if (password.length < 8 || password.length > 128) {
      return response.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const data = readData();
    const user = data.users.find((entry) => entry.username === username);
    const suppliedHash = crypto.createHash('sha256').update(resetCode).digest();
    const reset = user && data.passwordResets.find((entry) => {
      if (entry.userId !== user.id || entry.expiresAt <= Date.now()) return false;
      const storedHash = Buffer.from(entry.codeHash, 'hex');
      return storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
    });
    if (!reset) return response.status(400).json({ error: 'Username or reset code is invalid or expired.' });

    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = (await scrypt(password, user.salt, 64)).toString('hex');
    data.passwordResets = data.passwordResets.filter((entry) => entry.userId !== user.id);
    writeData(data);
    for (const [token, session] of sessions) {
      if (session.userId === user.id) sessions.delete(token);
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (request, response) => {
  const session = getSession(request);
  if (session) sessions.delete(session.token);
  response.clearCookie('chat_session', { httpOnly: true, sameSite: 'lax' });
  response.status(204).end();
});

app.get('/api/me', requireAuth, (request, response) => {
  const user = readData().users.find((entry) => entry.id === request.userId);
  if (!user) return response.status(401).json({ error: 'Account not found.' });
  response.json({ user: publicUser(user) });
});

app.put('/api/me/profile', requireAuth, (request, response) => {
  const username = String(request.body.username || '').trim().toLowerCase();
  const displayName = String(request.body.displayName || '').trim();
  const avatarUrl = request.body.avatarUrl === null ? null : String(request.body.avatarUrl || '');
  const avatarMatch = avatarUrl?.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return response.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers, or underscores.' });
  }
  if (displayName.length < 1 || displayName.length > 32) {
    return response.status(400).json({ error: 'Display name must be 1–32 characters.' });
  }
  if (avatarUrl && (!avatarMatch || Buffer.byteLength(avatarMatch[1], 'base64') > 512 * 1024)) {
    return response.status(400).json({ error: 'Profile pictures must be PNG, JPEG, or WebP and under 512 KB.' });
  }

  const data = readData();
  const user = data.users.find((entry) => entry.id === request.userId);
  if (!user) return response.status(401).json({ error: 'Account not found.' });
  if (data.users.some((entry) => entry.id !== user.id && entry.username === username)) {
    return response.status(409).json({ error: 'That username is already taken.' });
  }

  const previousUsername = user.username;
  user.username = username;
  user.displayName = displayName;
  user.avatarUrl = avatarUrl || null;
  if (SITE_OWNER_USERNAMES.has(previousUsername) && previousUsername !== username) {
    SITE_OWNER_USERNAMES.delete(previousUsername);
    SITE_OWNER_USERNAMES.add(username);
    const temporaryFile = `${SITE_OWNERS_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ usernames: [...SITE_OWNER_USERNAMES] }, null, 2));
    fs.renameSync(temporaryFile, SITE_OWNERS_FILE);
  }
  writeData(data);
  for (const serverId of Object.keys(data.memberships[user.id] || {})) emitServerUpdate(serverId);
  if (SITE_OWNER_USERNAMES.has(username)) {
    for (const server of loadServers()) emitServerUpdate(server.id);
  }
  response.json({ user: publicUser(user) });
});

app.get('/api/servers', requireAuth, (request, response) => {
  const data = readData();
  const memberships = data.memberships[request.userId] || {};
  const siteOwner = isSiteOwner(request.userId);
  const servers = loadServers()
    .filter((server) => siteOwner || memberships[server.id])
    .map((server) => publicServer(server, request.userId));
  response.json({ servers });
});

app.post('/api/servers/join', requireAuth, (request, response) => {
  const code = String(request.body.inviteCode || '').trim();
  const server = loadServers().find((entry) => Object.hasOwn(entry.invites, code));
  if (!server) return response.status(404).json({ error: 'That invite code is not valid.' });
  if (isSiteOwner(request.userId)) {
    return response.status(409).json({ error: 'Site Owners already have access to every server.' });
  }
  const data = readData();
  const memberships = data.memberships[request.userId] || {};
  if (memberships[server.id]) {
    return response.status(409).json({ error: 'You are already a member of this server.' });
  }
  memberships[server.id] = server.invites[code];
  data.memberships[request.userId] = memberships;
  writeData(data);
  response.status(201).json({ server: publicServer(server, request.userId) });
});

app.get('/api/servers/:serverId/channels/:channelId/messages', requireAuth, (request, response) => {
  const { serverId, channelId } = request.params;
  const server = findServer(serverId);
  if (!hasServerAccess(request.userId, serverId) || !findChannel(server, channelId)) {
    return response.status(403).json({ error: 'You cannot access this channel.' });
  }
  const messages = readData().messages[serverId] || [];
  const usersById = new Map(readData().users.map((user) => [user.id, user]));
  const visibleMessages = messages
    .filter((message) => (message.channelId || 'general') === channelId)
    .slice(-200)
    .map((message) => {
      const author = usersById.get(message.authorId);
      return author ? { ...message, author: author.displayName, avatarUrl: author.avatarUrl || null } : message;
    });
  response.json({ messages: visibleMessages });
});

app.post('/api/servers/:serverId/channels/:channelId/messages', requireAuth, (request, response) => {
  const { serverId, channelId } = request.params;
  const role = getServerRole(request.userId, serverId);
  const server = findServer(serverId);
  const channel = findChannel(server, channelId);
  if (!role || !channel) return response.status(403).json({ error: 'You cannot access this channel.' });
  if (channel.locked && !canManageServer(role)) {
    return response.status(403).json({ error: 'Only server Owners can speak in this locked channel.' });
  }
  const content = String(request.body.content || '').trim();
  if (!content || content.length > 2000) return response.status(400).json({ error: 'Messages must be 1–2000 characters.' });
  const data = readData();
  const user = data.users.find((entry) => entry.id === request.userId);
  const mentionedUsernames = new Set(
    [...content.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]{3,24})/gi)].map((match) => match[1].toLowerCase()),
  );
  const mentionedUsers = data.users.filter((mentionedUser) =>
    mentionedUser.id !== user.id
    && mentionedUsernames.has(mentionedUser.username)
    && (isSiteOwner(mentionedUser.id) || data.memberships[mentionedUser.id]?.[serverId]),
  );
  const message = {
    id: crypto.randomUUID(),
    authorId: user.id,
    author: user.displayName,
    avatarUrl: user.avatarUrl || null,
    role,
    channelId,
    mentions: mentionedUsers.map((mentionedUser) => mentionedUser.username),
    content,
    createdAt: new Date().toISOString(),
  };
  data.messages[serverId] ||= [];
  data.messages[serverId].push(message);
  data.messages[serverId] = data.messages[serverId].slice(-1000);
  writeData(data);
  for (const mentionedUser of mentionedUsers) {
    io.to(`user:${mentionedUser.id}`).emit('mention', {
      serverName: server.name,
      channelName: channel.name,
      author: user.displayName,
    });
  }
  emitServerUpdate(serverId);
  response.status(201).json({ message });
});

app.delete('/api/servers/:serverId/channels/:channelId/messages/:messageId', requireAuth, (request, response) => {
  const { serverId, channelId, messageId } = request.params;
  const role = getServerRole(request.userId, serverId);
  const server = findServer(serverId);
  if (!role || !findChannel(server, channelId)) return response.status(403).json({ error: 'You cannot access this channel.' });
  const data = readData();
  const messages = data.messages[serverId] || [];
  const message = messages.find((entry) => entry.id === messageId && (entry.channelId || 'general') === channelId);
  if (!message) return response.status(404).json({ error: 'Message not found.' });
  if (message.authorId !== request.userId && !canManageServer(role)) {
    return response.status(403).json({ error: 'Only the sender, a server Owner, or a Site Owner can delete this message.' });
  }
  data.messages[serverId] = messages.filter((entry) => entry.id !== messageId);
  writeData(data);
  emitServerUpdate(serverId);
  response.status(204).end();
});

io.use((socket, next) => {
  const session = getSession(socket.request);
  if (!session) return next(new Error('Sign in to connect.'));
  socket.data.userId = session.userId;
  next();
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  socket.on('watch-server', (serverId) => {
    if (typeof serverId === 'string' && hasServerAccess(socket.data.userId, serverId)) {
      socket.join(serverId);
    }
  });
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

httpServer.listen(PORT, () => {
  console.log(`Chat app listening on http://localhost:${PORT}`);
});