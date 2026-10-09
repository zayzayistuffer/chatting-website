# Commonroom

A small invite-only chat website. Accounts join servers through Member links; servers themselves are defined by JSON files in `servers/`, not created in the website.

## Run it

```sh
npm install
npm start
```

Open http://localhost:3000. Create an account, then open a server's Member invite link to join it.

Select your profile at the bottom of the sidebar to edit your username, display name, and profile picture. Pictures are center-cropped and resized in your browser before being saved.

Use **Direct messages** in the sidebar to search for a username and start a private one-to-one conversation. Only its two participants can read the messages; each participant can delete only their own messages.

## Set a Site Owner

Create an account for the person who should administer the site, then add their exact lowercase username to `site-owners.json`:

```json
{
  "usernames": ["your_username"]
}
```

Restart the app and have that account sign in again. Site Owners can access every configured server, delete any message, and create member password reset codes without joining servers individually. Keep this file restricted to trusted maintainers.

## Add a server

Add a JSON file in `servers/` and restart the app. For example:

```json
{
  "id": "book-club",
  "name": "Book Club",
  "description": "Books, notes, and good company.",
  "channels": [
    { "id": "general", "name": "general", "locked": false },
    { "id": "announcements", "name": "announcements", "locked": true }
  ],
  "roles": ["Owner", "Member"]
}
```

The file name can be anything ending in `.json`; each server `id` must be unique and contain only lowercase letters, numbers, or hyphens. A server link has the form `https://commonroom.abrdns.com/api/invite/<server-id>` and always grants the `Member` role. Owners can copy the current-origin link from that server's sidebar. There are no Owner invite links; the Site Owner can assign server roles using the command below. A server member can delete their own messages; that server's Owner or a Site Owner can delete another member's message. These checks are enforced by the server.

Each server file can define multiple channels with unique lowercase `id` values. Set `locked` to `true` to make a channel readable by members but writable only by that server's Owner and Site Owners. Channels are defined in code; restart the app after changing a server file.

Type `@username` in a message to ping someone who belongs to that server. If they are online, they receive a live notification; mentions of non-members do not notify them. Owners and Site Owners can view and copy the Member invite link from that server's sidebar in the website.

The Site Owner can assign a role to an existing server member by sending `?sudo role @username roleadd role RoleName` in that server. The role must be listed in that server's `roles` array, and the change applies only to that server. Commonroom posts a confirmation in the channel. Any user can reply to a channel or direct message using its reply button; replies cannot reference messages from a different conversation.

## Reset a password

An Owner can enter a member's username in the server sidebar to create a one-time reset code. Share that code privately with the member. They choose **Use a reset code** on the sign-in screen and enter their username, code, and new password. Codes expire after 15 minutes, work once, and are stored hashed. Completing a reset signs the account out of existing sessions; Owners cannot view current or previous passwords.

## Data and deployment

Account and message data is stored in `data/store.json`, created automatically and excluded from Git. Passwords are stored as salted scrypt hashes. Active sign-in sessions are held in memory and end when the server restarts. This JSON-backed setup is intended for a small, single-process deployment; use a database and persistent session store before scaling or deploying for broader use.