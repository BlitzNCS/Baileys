# WhatsApp Sync Viewer

A standalone CLI tool that connects to WhatsApp, syncs recent chat history, displays the 10 most recent messages, and lets you send messages — all from your terminal.

## Requirements

- Node.js >= 20.0.0

## Setup

```bash
cd tools/wa-sync-viewer
npm install
```

## Usage

### Connect with QR code (default)

```bash
npm start
```

A QR code will appear in your terminal. Scan it with WhatsApp:
**WhatsApp > Settings > Linked Devices > Link a Device**

### Connect with pairing code

```bash
npm run start:pairing
```

You'll be prompted for your phone number, then given an 8-digit code to enter on your phone.

### Send a message directly

```bash
npx tsx index.ts --send 1234567890@s.whatsapp.net "Hello from the terminal!"
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

- **Individual**: `<country><number>@s.whatsapp.net` (e.g. `12025551234@s.whatsapp.net`)
- **Group**: `<id>@g.us` (use `chats` command to find group JIDs)

## Session persistence

Session credentials are saved to `./session/`. On subsequent runs the tool reconnects automatically without needing to scan again.

To log out and re-pair, delete the `session/` directory and restart.

## Notes

- This tool links as a secondary device (like WhatsApp Web) — your phone stays primary
- New messages appear in real time while the tool is running
- The tool only syncs recent history (not full history) for fast startup
