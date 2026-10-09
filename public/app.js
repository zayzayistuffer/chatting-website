const app = document.querySelector('#app');
let currentUser = null;
let servers = [];
let directMessages = [];
let activeServerId = null;
let activeChannelId = null;
let activeDmId = null;
let activeReplyTarget = null;
let socket = null;
let refreshTimer = null;
let dmSearchTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('The chat API is unavailable on this static site. Commonroom’s Node server must be deployed and its /api routes connected before accounts can be created.');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The chat server returned an invalid response. Please reload the page; if this continues, the Node API is not correctly connected to this site.');
  }
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatarElement(user, className = 'avatar') {
  const avatar = element('span', className);
  if (user.avatarUrl) {
    const image = element('img', 'avatar-image');
    image.src = user.avatarUrl;
    image.alt = '';
    avatar.append(image);
  } else {
    avatar.textContent = (user.displayName || user.author || user.username || '?').slice(0, 1).toUpperCase();
  }
  return avatar;
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = element('div', 'toast', message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setReplyTarget(message, contextKey) {
  activeReplyTarget = {
    contextKey,
    messageId: message.id,
    author: message.author,
    content: message.content,
  };
  drawWorkspace();
  if (activeDmId) loadDirectMessages();
  else loadMessages();
  document.querySelector('.composer textarea')?.focus();
}

function appendReplyPreview(container, contextKey) {
  if (activeReplyTarget?.contextKey !== contextKey) return;
  const preview = element('div', 'replying-banner');
  const quote = element('span', '', `Replying to ${activeReplyTarget.author}: ${activeReplyTarget.content}`);
  const cancel = element('button', 'cancel-reply', '×');
  cancel.type = 'button';
  cancel.title = 'Cancel reply';
  cancel.setAttribute('aria-label', 'Cancel reply');
  cancel.addEventListener('click', () => {
    activeReplyTarget = null;
    preview.remove();
  });
  preview.append(quote, cancel);
  container.append(preview);
}

function addReplyQuote(container, replyTo) {
  if (!replyTo) return;
  const quote = element('button', 'reply-quote', `${replyTo.author}: ${replyTo.content}`);
  quote.type = 'button';
  quote.title = 'Jump to replied message';
  quote.addEventListener('click', () => {
    document.getElementById(`message-${replyTo.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  container.append(quote);
}

function showPingNotification(ping) {
  const location = `${ping.serverName} #${ping.channelName}`;
  const message = ping.mentionEveryone
    ? `${ping.author} pinged @everyone in ${location}`
    : `${ping.author} mentioned you in ${location}`;
  showToast(message);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const notification = new Notification('Commonroom ping', { body: message });
  notification.addEventListener('click', () => {
    window.focus();
    const server = servers.find((item) => item.id === ping.serverId);
    if (!server) return;
    activeServerId = server.id;
    activeChannelId = ping.channelId;
    drawWorkspace();
    watchActiveServer();
    loadMessages();
    notification.close();
  });
}

async function enableNotifications(button) {
  if (!('Notification' in window)) {
    showToast('This browser does not support desktop notifications.');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Notifications are blocked in your browser settings.');
    return;
  }
  const permission = await Notification.requestPermission();
  button.textContent = permission === 'granted' ? 'Alerts on' : 'Enable alerts';
  if (permission === 'granted') showToast('Desktop ping alerts enabled.');
  else showToast('Desktop notifications were not enabled. In-app alerts still work.');
}

function showProfileEditor() {
  const overlay = element('div', 'modal-overlay');
  let closeOnEscape;
  const closeEditor = () => {
    overlay.remove();
    document.removeEventListener('keydown', closeOnEscape);
  };
  const modal = element('section', 'profile-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'profile-modal-title');
  const header = element('div', 'profile-modal-header');
  const title = element('h2', '', 'Edit your profile');
  title.id = 'profile-modal-title';
  const close = element('button', 'modal-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close profile editor');
  close.addEventListener('click', closeEditor);
  header.append(title, close);

  const form = element('form', 'profile-edit-form');
  const pictureField = element('div', 'picture-field');
  const picturePreview = avatarElement(currentUser, 'avatar picture-preview');
  const pictureControls = element('div', 'picture-controls');
  pictureControls.append(element('strong', '', 'Profile picture'), element('span', '', 'PNG, JPEG, or WebP'));
  const fileInput = element('input', 'picture-input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.setAttribute('aria-label', 'Choose a profile picture');
  const choosePicture = element('button', 'secondary-btn', 'Choose image');
  choosePicture.type = 'button';
  choosePicture.addEventListener('click', () => fileInput.click());
  const removePicture = element('button', 'text-btn picture-remove', 'Remove picture');
  removePicture.type = 'button';
  pictureControls.append(choosePicture, removePicture, fileInput);
  pictureField.append(picturePreview, pictureControls);
  form.append(pictureField);

  addField(form, 'Display name', 'displayName', 'Your display name', 'text', true, '1', '32');
  addField(form, 'Username', 'username', 'your_handle', 'text', true, '3', '24');
  form.elements.displayName.value = currentUser.displayName;
  form.elements.username.value = currentUser.username;
  const error = element('p', 'form-error');
  const actions = element('div', 'profile-form-actions');
  const cancel = element('button', 'secondary-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeEditor);
  const save = element('button', 'primary-btn', 'Save changes');
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(error, actions);

  let selectedAvatar = currentUser.avatarUrl || null;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      error.textContent = 'Choose a PNG, JPEG, or WebP image.';
      fileInput.value = '';
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      const cropSize = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - cropSize) / 2, (bitmap.height - cropSize) / 2, cropSize, cropSize, 0, 0, 256, 256);
      bitmap.close();
      selectedAvatar = canvas.toDataURL('image/jpeg', 0.82);
      picturePreview.replaceChildren();
      const image = element('img', 'avatar-image');
      image.src = selectedAvatar;
      image.alt = '';
      picturePreview.append(image);
      error.textContent = '';
    } catch {
      error.textContent = 'That image could not be opened. Choose another file.';
    }
  });
  removePicture.addEventListener('click', () => {
    selectedAvatar = null;
    picturePreview.replaceChildren(document.createTextNode(currentUser.displayName.slice(0, 1).toUpperCase()));
    fileInput.value = '';
    error.textContent = '';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    error.textContent = '';
    try {
      const result = await api('/api/me/profile', {
        method: 'PUT',
        body: JSON.stringify({
          username: form.elements.username.value,
          displayName: form.elements.displayName.value,
          avatarUrl: selectedAvatar,
        }),
      });
      currentUser = result.user;
      closeEditor();
      drawWorkspace();
      await loadMessages();
      showToast('Profile updated.');
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      save.disabled = false;
    }
  });
  modal.append(header, form);
  overlay.append(modal);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeEditor();
  });
  closeOnEscape = (event) => {
    if (event.key === 'Escape') {
      closeEditor();
    }
  };
  document.addEventListener('keydown', closeOnEscape);
  document.body.append(overlay);
  form.elements.displayName.focus();
}

function showAuth(mode = 'login') {
  const isRegister = mode === 'register';
  const isReset = mode === 'reset';
  app.replaceChildren();
  const shell = element('div', 'auth-shell');
  const art = element('section', 'auth-art');
  const brand = element('div', 'brand');
  brand.append(element('span', 'brand-mark', 'c'), document.createTextNode('commonroom'));
  art.append(brand);
  const copy = element('div', 'auth-copy');
  copy.append(element('h1', '', 'Good conversations start here.'), element('p', '', 'A quieter corner of the internet. Find your people, share what you’re making, and pick up right where you left off.'));
  art.append(copy, element('div', 'auth-note', 'A place for the people you choose.'));
  const panel = element('section', 'auth-panel');
  const wrap = element('div', 'auth-form-wrap');
  wrap.append(element('p', 'eyebrow', isRegister ? 'Make yourself at home' : isReset ? 'Account recovery' : 'Your people are here'), element('h2', '', isRegister ? 'Create your account' : isReset ? 'Choose a new password' : 'Welcome back'), element('p', 'auth-subtitle', isRegister ? 'A name, a handle, and you’re in.' : isReset ? 'Enter the one-time reset code from your server Owner.' : 'Sign in to get back to your conversations.'));
  const form = element('form', 'auth-form');
  if (isRegister) addField(form, 'Display name', 'displayName', 'e.g. Sam Rivera', 'text', true, '1', '32');
  addField(form, 'Username', 'username', 'your_handle', 'text', true, '3', '24');
  if (isReset) addField(form, 'Reset code', 'resetCode', 'One-time code', 'text', true);
  addField(form, 'Password', 'password', isRegister || isReset ? 'At least 8 characters' : 'Your password', 'password', true, isRegister || isReset ? '8' : '', '128');
  const error = element('p', 'form-error');
  const submit = element('button', 'primary-btn', isRegister ? 'Create account' : isReset ? 'Set new password' : 'Sign in');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    const fields = Object.fromEntries(new FormData(form));
    try {
      const endpoint = isRegister ? 'register' : isReset ? 'password-reset/complete' : 'login';
      const result = await api(`/api/${endpoint}`, { method: 'POST', body: JSON.stringify(fields) });
      if (isReset) {
        showAuth('login');
        showToast('Password updated. Sign in with your new password.');
        return;
      }
      currentUser = result.user;
      await enterWorkspace();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });
  wrap.append(form);
  const switcher = element('p', 'auth-switch', isRegister || isReset ? 'Already have an account? ' : 'New around here? ');
  const switchButton = element('button', 'text-btn', isRegister || isReset ? 'Sign in' : 'Create an account');
  switchButton.type = 'button';
  switchButton.addEventListener('click', () => showAuth(isRegister || isReset ? 'login' : 'register'));
  switcher.append(switchButton);
  wrap.append(switcher);
  if (!isRegister && !isReset) {
    const resetLink = element('p', 'auth-switch', 'Forgot your password? ');
    const resetButton = element('button', 'text-btn', 'Use a reset code');
    resetButton.type = 'button';
    resetButton.addEventListener('click', () => showAuth('reset'));
    resetLink.append(resetButton);
    wrap.append(resetLink);
  }
  panel.append(wrap);
  shell.append(art, panel);
  app.append(shell);
}

function addField(form, labelText, name, placeholder, type, required, minLength = '', maxLength = '') {
  const label = element('label', '', labelText);
  const input = element('input');
  input.name = name;
  input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = name === 'password' ? (required && minLength ? 'new-password' : 'current-password') : name === 'username' ? 'username' : name === 'resetCode' ? 'off' : 'name';
  input.required = required;
  if (minLength) input.minLength = Number(minLength);
  if (maxLength) input.maxLength = Number(maxLength);
  label.htmlFor = name;
  input.id = name;
  const field = element('div', 'field');
  field.append(label, input);
  form.append(field);
}

async function enterWorkspace() {
  const inviteServerId = new URLSearchParams(window.location.search).get('invite');
  if (inviteServerId) {
    try {
      await api(`/api/invite/${encodeURIComponent(inviteServerId)}/join`, { method: 'POST' });
      showToast('Joined the server as a Member.');
    } catch (failure) {
      showToast(failure.message);
    } finally {
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }
  const [serverResult, dmResult] = await Promise.all([api('/api/servers'), api('/api/dms')]);
  servers = serverResult.servers;
  directMessages = dmResult.conversations;
  activeServerId = servers[0]?.id || null;
  activeChannelId = servers[0]?.channels[0]?.id || null;
  activeDmId = null;
  drawWorkspace();
  if (typeof window.io === 'function') {
    socket = window.io();
    socket.on('connect', watchActiveServer);
    socket.on('refresh', () => { if (activeServerId) loadMessages(); });
    socket.on('mention', showPingNotification);
    socket.on('dm-available', async ({ conversationId }) => {
      await refreshDirectMessages();
      const conversation = directMessages.find((item) => item.id === conversationId);
      if (conversation) showToast(`New direct message from ${conversation.user.displayName}`);
    });
    socket.on('dm-message', async ({ conversationId, author, authorId }) => {
      await refreshDirectMessages();
      if (authorId !== currentUser.id && activeDmId !== conversationId) showToast(`New direct message from ${author}`);
    });
    if (socket.connected) watchActiveServer();
  }
  refreshTimer = setInterval(() => { if (activeServerId) loadMessages(); }, 5000);
  if (activeServerId) await loadMessages();
}

async function refreshDirectMessages() {
  const result = await api('/api/dms');
  directMessages = result.conversations;
  drawWorkspace();
  if (activeDmId) await loadDirectMessages();
  else if (activeServerId) await loadMessages();
}

function drawWorkspace() {
  app.replaceChildren();
  const workspace = element('div', 'workspace');
  const sidebar = element('aside', 'sidebar');
  const brand = element('div', 'brand');
  brand.append(element('span', 'brand-mark', 'c'), document.createTextNode('commonroom'));
  sidebar.append(brand);
  sidebar.append(element('div', 'section-label', 'Your servers'));
  const serverList = element('div', 'server-list');
  if (!servers.length) {
    const empty = element('p', 'join-feedback', 'No servers yet. Ask for a Member invite link to join.');
    empty.style.margin = '8px 7px';
    serverList.append(empty);
  }
  for (const server of servers) {
    const item = element('button', `server-item${server.id === activeServerId ? ' active' : ''}`);
    item.type = 'button';
    const initial = element('span', 'server-initial', server.name.slice(0, 1).toUpperCase());
    const label = element('span', 'server-label');
    label.append(element('span', 'server-name', server.name), element('span', 'server-role', server.role));
    item.append(initial, label);
    item.addEventListener('click', async () => {
      activeServerId = server.id;
      activeChannelId = server.channels[0]?.id || null;
      activeDmId = null;
      drawWorkspace();
      watchActiveServer();
      await loadMessages();
    });
    serverList.append(item);
  }
  sidebar.append(serverList);
  const activeServer = servers.find((server) => server.id === activeServerId);
  if (activeServer) {
    sidebar.append(element('div', 'section-label channels-label', 'Channels'));
    const channelList = element('div', 'channel-list');
    for (const channel of activeServer.channels) {
      const item = element('button', `channel-item${channel.id === activeChannelId ? ' active' : ''}`);
      item.type = 'button';
      item.setAttribute('aria-label', `${channel.name}${channel.locked ? ', locked, Owner posting only' : ''}`);
      const mark = element('span', `channel-mark${channel.locked ? ' locked' : ''}`, channel.locked ? 'L' : '#');
      mark.title = channel.locked ? 'Only Owners can speak' : 'Open channel';
      item.append(mark, element('span', 'channel-name', channel.name));
      if (channel.locked) item.append(element('span', 'channel-lock-label', 'locked'));
      item.addEventListener('click', async () => {
        activeChannelId = channel.id;
        drawWorkspace();
        watchActiveServer();
        await loadMessages();
      });
      channelList.append(item);
    }
    sidebar.append(channelList);
  }
  sidebar.append(element('div', 'section-label dm-section-label', 'Direct messages'));
  const dmSearch = element('div', 'dm-search');
  const dmSearchInput = element('input', 'dm-search-input');
  dmSearchInput.type = 'search';
  dmSearchInput.placeholder = 'Find by username';
  dmSearchInput.autocomplete = 'off';
  dmSearchInput.setAttribute('aria-label', 'Find someone to message');
  const dmSearchResults = element('div', 'dm-search-results');
  dmSearch.append(dmSearchInput, dmSearchResults);
  dmSearchInput.addEventListener('input', () => {
    clearTimeout(dmSearchTimer);
    dmSearchResults.replaceChildren();
    const query = dmSearchInput.value.trim();
    if (query.length < 2) return;
    dmSearchTimer = setTimeout(async () => {
      try {
        const result = await api(`/api/users?q=${encodeURIComponent(query)}`);
        dmSearchResults.replaceChildren();
        for (const user of result.users) {
          const userButton = element('button', 'dm-search-result');
          userButton.type = 'button';
          const userInfo = element('span', 'dm-user-info');
          userInfo.append(element('strong', '', user.displayName), element('span', '', `@${user.username}`));
          userButton.append(avatarElement(user, 'avatar dm-search-avatar'), userInfo);
          userButton.addEventListener('click', async () => {
            try {
              const created = await api('/api/dms', { method: 'POST', body: JSON.stringify({ username: user.username }) });
              const conversations = await api('/api/dms');
              directMessages = conversations.conversations;
              activeDmId = created.conversation.id;
              activeServerId = null;
              activeChannelId = null;
              drawWorkspace();
              await loadDirectMessages();
            } catch (failure) {
              showToast(failure.message);
            }
          });
          dmSearchResults.append(userButton);
        }
        if (!result.users.length) dmSearchResults.append(element('span', 'dm-no-results', 'No users found'));
      } catch (failure) {
        showToast(failure.message);
      }
    }, 180);
  });
  sidebar.append(dmSearch);
  const dmList = element('div', 'dm-list');
  for (const conversation of directMessages) {
    const item = element('button', `dm-item${conversation.id === activeDmId ? ' active' : ''}`);
    item.type = 'button';
    const userInfo = element('span', 'dm-user-info');
    userInfo.append(element('strong', '', conversation.user.displayName), element('span', '', `@${conversation.user.username}`));
    item.append(avatarElement(conversation.user, 'avatar dm-avatar'), userInfo);
    item.addEventListener('click', async () => {
      activeDmId = conversation.id;
      activeServerId = null;
      activeChannelId = null;
      drawWorkspace();
      await loadDirectMessages();
    });
    dmList.append(item);
  }
  if (!directMessages.length) dmList.append(element('p', 'dm-empty', 'No conversations yet'));
  sidebar.append(dmList);
  if (activeServer?.role === 'Owner' || activeServer?.role === 'Site Owner') {
    const resetBox = element('form', 'reset-box');
    resetBox.append(element('h3', '', 'Reset a member password'));
    resetBox.append(element('p', '', 'Create a one-time code. The member chooses their new password.'));
    const resetRow = element('div', 'join-row');
    const memberInput = element('input');
    memberInput.name = 'username';
    memberInput.placeholder = 'Member username';
    memberInput.autocomplete = 'off';
    memberInput.required = true;
    memberInput.setAttribute('aria-label', 'Member username');
    const resetButton = element('button', '', '↗');
    resetButton.type = 'submit';
    resetButton.title = 'Create reset code';
    resetButton.setAttribute('aria-label', 'Create reset code');
    resetRow.append(memberInput, resetButton);
    const resetFeedback = element('div', 'reset-feedback');
    resetBox.append(resetRow, resetFeedback);
    resetBox.addEventListener('submit', async (event) => {
      event.preventDefault();
      resetButton.disabled = true;
      resetFeedback.replaceChildren();
      try {
        const result = await api(`/api/servers/${encodeURIComponent(activeServer.id)}/password-resets`, {
          method: 'POST',
          body: JSON.stringify({ username: memberInput.value }),
        });
        resetFeedback.append(element('span', '', 'Share this one-time code. It expires in 15 minutes:'));
        resetFeedback.append(element('code', '', result.resetCode));
        const copyButton = element('button', 'copy-reset', 'Copy code');
        copyButton.type = 'button';
        copyButton.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(result.resetCode);
            copyButton.textContent = 'Copied';
          } catch {
            showToast('Select and copy the reset code above.');
          }
        });
        resetFeedback.append(copyButton);
      } catch (failure) {
        resetFeedback.append(element('span', 'reset-error', failure.message));
      } finally {
        resetButton.disabled = false;
      }
    });
    sidebar.append(resetBox);
    const inviteBox = element('section', 'invite-box');
    inviteBox.append(element('h3', '', 'Member invite link'));
    inviteBox.append(element('p', '', 'Anyone who opens this link can join this server as a Member.'));
    const inviteUrl = `${window.location.origin}/api/invite/${encodeURIComponent(activeServer.id)}`;
    const inviteCode = element('code', 'invite-link', inviteUrl);
    const copyButton = element('button', 'copy-invite', 'Copy link');
    copyButton.type = 'button';
    copyButton.title = 'Copy Member invite link';
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        copyButton.textContent = 'Copied';
      } catch {
        showToast('Select and copy the invite link above.');
      }
    });
    inviteBox.append(inviteCode, copyButton);
    sidebar.append(inviteBox);
  }
  const profile = element('div', 'profile');
  profile.append(avatarElement(currentUser));
  const profileInfo = element('div', 'profile-info');
  profileInfo.append(element('div', 'profile-name', currentUser.displayName), element('div', 'profile-handle', `@${currentUser.username}`));
  const editProfile = element('button', 'profile-edit-button');
  editProfile.type = 'button';
  editProfile.title = 'Edit profile';
  editProfile.setAttribute('aria-label', 'Edit profile');
  editProfile.append(profileInfo, element('span', 'profile-edit-icon', '✎'));
  editProfile.addEventListener('click', showProfileEditor);
  const logout = element('button', 'logout-btn', '↪');
  logout.type = 'button';
  logout.title = 'Sign out';
  logout.setAttribute('aria-label', 'Sign out');
  logout.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    if (socket) socket.disconnect();
    clearInterval(refreshTimer);
    socket = null;
    currentUser = null;
    showAuth();
  });
  profile.append(editProfile, logout);
  sidebar.append(profile);
  const chat = element('section', 'chat-pane');
  if (activeDmId) {
    const conversation = directMessages.find((item) => item.id === activeDmId);
    chat.append(renderDirectMessageChat(conversation));
  } else if (activeServerId) {
    const server = servers.find((item) => item.id === activeServerId);
    const channel = server?.channels.find((item) => item.id === activeChannelId);
    const header = element('header', 'chat-header');
    header.append(element('span', `channel-hash${channel?.locked ? ' is-locked' : ''}`, channel?.locked ? 'L' : '#'));
    const heading = element('div', 'chat-heading');
    heading.append(element('h1', '', channel?.name || 'general'), element('p', '', channel?.locked ? `${server?.name || 'Server'} · Owners only can speak here` : server?.description || 'A place for good conversation.'));
    const alertsButton = element('button', 'notification-btn', 'Enable alerts');
    alertsButton.type = 'button';
    alertsButton.title = 'Enable desktop notifications for pings';
    alertsButton.setAttribute('aria-label', 'Enable desktop notifications');
    if ('Notification' in window) {
      alertsButton.textContent = Notification.permission === 'granted' ? 'Alerts on' : Notification.permission === 'denied' ? 'Alerts blocked' : 'Enable alerts';
    }
    alertsButton.addEventListener('click', () => enableNotifications(alertsButton));
    header.append(heading, alertsButton, element('span', 'channel-tag', server?.role || 'Member'));
    const messages = element('div', 'messages');
    messages.id = 'messages';
    const welcome = element('section', 'welcome');
    welcome.append(element('span', 'welcome-mark', channel?.locked ? 'L' : '#'), element('h2', '', `Welcome to #${channel?.name || 'general'}`), element('p', '', channel?.locked ? 'This channel is read-only for members. Owners can post announcements here.' : 'Say hello, share a thought, or pick up where everyone left off.'));
    const list = element('div', 'message-list');
    list.id = 'message-list';
    messages.append(welcome, list);
    const composerWrap = element('div', 'composer-wrap');
    const canSpeak = !channel?.locked || server?.role === 'Owner' || server?.role === 'Site Owner';
    if (canSpeak) {
      const contextKey = `server:${activeServerId}:${activeChannelId}`;
      appendReplyPreview(composerWrap, contextKey);
      const composer = element('form', 'composer');
      const textarea = element('textarea');
      textarea.name = 'content';
      textarea.rows = 1;
      textarea.maxLength = 2000;
      textarea.placeholder = `Message #${channel?.name || 'general'} · @username to ping`;
      textarea.setAttribute('aria-label', 'Message');
      const send = element('button', 'send-btn', '↑');
      send.type = 'submit';
      send.title = 'Send message';
      send.setAttribute('aria-label', 'Send message');
      composer.append(textarea, send);
      composer.addEventListener('submit', async (event) => {
        event.preventDefault();
        const content = textarea.value.trim();
        if (!content) return;
        send.disabled = true;
        try {
          const replyTo = activeReplyTarget?.contextKey === contextKey ? activeReplyTarget.messageId : null;
          await api(`/api/servers/${encodeURIComponent(activeServerId)}/channels/${encodeURIComponent(activeChannelId)}/messages`, { method: 'POST', body: JSON.stringify({ content, replyTo }) });
          if (replyTo) activeReplyTarget = null;
          textarea.value = '';
          textarea.style.height = '';
          await loadMessages();
        } catch (failure) {
          showToast(failure.message);
        } finally {
          send.disabled = false;
          textarea.focus();
        }
      });
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
      });
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          composer.requestSubmit();
        }
      });
      composerWrap.append(composer, element('p', 'composer-hint', 'Enter to send · Shift + Enter for a new line · @username to ping'));
    } else {
      composerWrap.append(element('div', 'locked-notice', 'This channel is locked. Only Owners can send messages.'));
    }
    chat.append(header, messages, composerWrap);
  } else {
    const empty = element('div', 'empty-state');
    const content = document.createElement('div');
    content.append(element('strong', '', 'Your corner is ready.'), element('p', '', 'Open a Member invite link to start chatting with your people.'));
    empty.append(content);
    chat.append(empty);
  }
  workspace.append(sidebar, chat);
  app.append(workspace);
}

function renderDirectMessageChat(conversation) {
  const chat = element('section', 'chat-pane');
  if (!conversation) {
    chat.append(element('div', 'empty-state', 'Direct message not found.'));
    return chat;
  }
  const header = element('header', 'chat-header dm-header');
  header.append(avatarElement(conversation.user, 'avatar dm-header-avatar'));
  const heading = element('div', 'chat-heading');
  heading.append(element('h1', '', conversation.user.displayName), element('p', '', `@${conversation.user.username} · Direct message`));
  header.append(heading);
  const messages = element('div', 'messages');
  messages.id = 'dm-messages';
  const welcome = element('section', 'welcome dm-welcome');
  welcome.append(element('span', 'welcome-mark', '@'), element('h2', '', conversation.user.displayName), element('p', '', `This is the beginning of your direct conversation with @${conversation.user.username}.`));
  const list = element('div', 'message-list');
  list.id = 'dm-message-list';
  messages.append(welcome, list);
  const composerWrap = element('div', 'composer-wrap');
  const contextKey = `dm:${conversation.id}`;
  appendReplyPreview(composerWrap, contextKey);
  const composer = element('form', 'composer');
  const textarea = element('textarea');
  textarea.name = 'content';
  textarea.rows = 1;
  textarea.maxLength = 2000;
  textarea.placeholder = `Message @${conversation.user.username}`;
  textarea.setAttribute('aria-label', 'Direct message');
  const send = element('button', 'send-btn', '↑');
  send.type = 'submit';
  send.title = 'Send direct message';
  send.setAttribute('aria-label', 'Send direct message');
  composer.append(textarea, send);
  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = textarea.value.trim();
    if (!content) return;
    send.disabled = true;
    try {
      const replyTo = activeReplyTarget?.contextKey === contextKey ? activeReplyTarget.messageId : null;
      await api(`/api/dms/${encodeURIComponent(conversation.id)}/messages`, { method: 'POST', body: JSON.stringify({ content, replyTo }) });
      if (replyTo) activeReplyTarget = null;
      textarea.value = '';
      textarea.style.height = '';
      await refreshDirectMessages();
    } catch (failure) {
      showToast(failure.message);
    } finally {
      send.disabled = false;
      textarea.focus();
    }
  });
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composerWrap.append(composer, element('p', 'composer-hint', 'Enter to send · Shift + Enter for a new line'));
  chat.append(header, messages, composerWrap);
  return chat;
}

function watchActiveServer() {
  if (socket?.connected && activeServerId) socket.emit('watch-server', activeServerId);
}

async function loadDirectMessages() {
  if (!activeDmId) return;
  const conversationId = activeDmId;
  try {
    const result = await api(`/api/dms/${encodeURIComponent(conversationId)}/messages`);
    if (activeDmId !== conversationId) return;
    const list = document.querySelector('#dm-message-list');
    const container = document.querySelector('#dm-messages');
    if (!list || !container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    list.replaceChildren(...result.messages.map(renderDirectMessage));
    if (atBottom) container.scrollTop = container.scrollHeight;
  } catch (failure) {
    showToast(failure.message);
  }
}

function renderDirectMessage(message) {
  const row = element('article', 'message');
  row.id = `message-${message.id}`;
  row.append(avatarElement(message));
  const body = element('div', 'message-body');
  const meta = element('div', 'message-meta');
  meta.append(element('span', 'message-author', message.author));
  meta.append(element('time', 'message-time', new Date(message.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
  addReplyQuote(body, message.replyTo);
  body.append(meta, element('p', 'message-content', message.content));
  row.append(body);
  const reply = element('button', 'reply-btn', '↩');
  reply.type = 'button';
  reply.title = 'Reply';
  reply.setAttribute('aria-label', `Reply to ${message.author}`);
  reply.addEventListener('click', () => setReplyTarget(message, `dm:${activeDmId}`));
  row.append(reply);
  if (message.authorId === currentUser.id) {
    const remove = element('button', 'delete-btn', '×');
    remove.type = 'button';
    remove.title = 'Delete direct message';
    remove.setAttribute('aria-label', 'Delete your direct message');
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/dms/${encodeURIComponent(activeDmId)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
        await refreshDirectMessages();
      } catch (failure) {
        showToast(failure.message);
      }
    });
    row.append(remove);
  }
  return row;
}

async function loadMessages() {
  if (!activeServerId || !activeChannelId) return;
  const targetServer = activeServerId;
  const targetChannel = activeChannelId;
  try {
    const result = await api(`/api/servers/${encodeURIComponent(targetServer)}/channels/${encodeURIComponent(targetChannel)}/messages`);
    if (activeServerId !== targetServer || activeChannelId !== targetChannel) return;
    const list = document.querySelector('#message-list');
    if (!list) return;
    const atBottom = document.querySelector('#messages').scrollHeight - document.querySelector('#messages').scrollTop - document.querySelector('#messages').clientHeight < 100;
    list.replaceChildren(...result.messages.map(renderMessage));
    if (atBottom) document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight;
  } catch (failure) {
    if (failure.message.includes('not a member')) showToast(failure.message);
  }
}

function renderMessage(message) {
  const row = element('article', 'message');
  row.id = `message-${message.id}`;
  row.append(avatarElement(message));
  const body = element('div', 'message-body');
  addReplyQuote(body, message.replyTo);
  const meta = element('div', 'message-meta');
  meta.append(element('span', 'message-author', message.author));
  meta.append(element('span', `role-chip${message.role === 'Owner' || message.role === 'Site Owner' ? ' owner' : message.role === 'Bot' ? ' bot' : ''}`, message.role));
  const time = new Date(message.createdAt);
  meta.append(element('time', 'message-time', time.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
  const content = element('p', 'message-content');
  let lastIndex = 0;
  for (const mention of message.content.matchAll(/@[a-z0-9_]{3,24}/gi)) {
    content.append(document.createTextNode(message.content.slice(lastIndex, mention.index)));
    content.append(element('span', 'message-mention', mention[0]));
    lastIndex = mention.index + mention[0].length;
  }
  content.append(document.createTextNode(message.content.slice(lastIndex)));
  body.append(meta, content);
  row.append(body);
  const reply = element('button', 'reply-btn', '↩');
  reply.type = 'button';
  reply.title = 'Reply';
  reply.setAttribute('aria-label', `Reply to ${message.author}`);
  reply.addEventListener('click', () => setReplyTarget(message, `server:${activeServerId}:${activeChannelId}`));
  row.append(reply);
  const server = servers.find((item) => item.id === activeServerId);
  if (message.authorId === currentUser.id || server?.role === 'Owner' || server?.role === 'Site Owner') {
    const remove = element('button', 'delete-btn', '×');
    remove.type = 'button';
    remove.title = 'Delete message';
    remove.setAttribute('aria-label', `Delete message from ${message.author}`);
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${encodeURIComponent(activeServerId)}/channels/${encodeURIComponent(activeChannelId)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
        await loadMessages();
      } catch (failure) {
        showToast(failure.message);
      }
    });
    row.append(remove);
  }
  return row;
}

(async function start() {
  try {
    const result = await api('/api/me');
    currentUser = result.user;
    await enterWorkspace();
  } catch {
    showAuth();
  }
})();