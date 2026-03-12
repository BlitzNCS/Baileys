# WhatsApp Sync Viewer

A standalone CLI tool that connects to WhatsApp, syncs recent chat history, displays the 10 most recent messages, and lets you send messages — all from your terminal.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), a pure WebSocket WhatsApp Web API (no browser required).

## Requirements

- Node.js >= 20.0.0

## Quick Start

```bash
git clone <this-repo>
cd wa-sync-viewer
npm install
npm start
```

A QR code will appear in your terminal. Scan it with WhatsApp:

**WhatsApp > Settings > Linked Devices > Link a Device**

That's it. After ~15 seconds of syncing, you'll see your 10 most recent messages and an interactive prompt.

## Usage

### Connect with QR code (default)

```bash
npm start
```

### Connect with pairing code

```bash
npm run start:pairing
```

You'll be prompted for your phone number, then given an 8-digit code to enter on your phone:
**WhatsApp > Linked Devices > Link a Device > Link with phone number**

### Send a message from the command line

```bash
npm run send -- 12025551234@s.whatsapp.net "Hello from the terminal!"
```

## What happens on launch

1. Connects to WhatsApp Web via WebSocket
2. Authenticates (QR or pairing code) — only needed on first run
3. Syncs recent chat history (~15 seconds)
4. Displays the **10 most recent messages** across all chats
5. Enters **interactive mode**

## Interactive commands

| Command | Description |
|---------|-------------|
| `recent` | Redisplay the 10 most recent messages |
| `chats` | List all synced chats with their JIDs |
| `send <jid> <msg>` | Send a text message to a JID |
| `quit` | Exit the tool |

## JID format

WhatsApp identifies contacts and groups with JIDs:

| Type | Format | Example |
|------|--------|---------|
| Individual | `<country><number>@s.whatsapp.net` | `12025551234@s.whatsapp.net` |
| Group | `<id>@g.us` | `120363001234567890@g.us` |

Use the `chats` command to discover JIDs for your conversations.

## Session persistence

Session credentials are saved to `./session/`. On subsequent runs the tool reconnects automatically without needing to scan again.

To log out and re-pair, delete the `session/` directory and restart.

## Project structure

```
wa-sync-viewer/
├── src/
│   └── index.ts        # Main application
├── session/            # Created at runtime (git-ignored)
├── package.json
├── tsconfig.json
└── README.md
```

## How it works

- Uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library to connect to WhatsApp Web
- Links as a secondary device (like WhatsApp Web) — your phone stays primary
- Communicates via WebSocket using WhatsApp's Noise protocol encryption
- Messages are end-to-end encrypted via the Signal protocol
- New messages appear in real time while the tool is running
- Only syncs recent history (not full history) for fast startup

## Notes

- This is an **unofficial** tool — it uses WhatsApp's Web protocol, not an official API
- Use a dedicated phone number for automation to avoid any risk to your personal account
- Don't use this for bulk messaging or spam — accounts can be banned
- Session credentials in `./session/` give full access to the linked account — keep them secure
