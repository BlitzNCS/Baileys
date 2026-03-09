# Building a WhatsApp Sync Server with Baileys

## Full Technical Report

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What is Baileys?](#2-what-is-baileys)
3. [Architecture Overview](#3-architecture-overview)
4. [Prerequisites & Setup](#4-prerequisites--setup)
5. [Authentication & Session Management](#5-authentication--session-management)
6. [Syncing All WhatsApp History](#6-syncing-all-whatsapp-history)
7. [Receiving New Messages in Real Time](#7-receiving-new-messages-in-real-time)
8. [Sending Messages](#8-sending-messages)
9. [Media Handling](#9-media-handling)
10. [Group Management](#10-group-management)
11. [Full Server Implementation](#11-full-server-implementation)
12. [Production Considerations](#12-production-considerations)
13. [API Reference: Key Events](#13-api-reference-key-events)
14. [Limitations & Risks](#14-limitations--risks)

---

## 1. Executive Summary

Baileys (v7.0.0-rc.9) is a pure WebSocket-based Node.js library that implements the WhatsApp Web multi-device protocol. It communicates directly with WhatsApp's servers using the Noise protocol for encryption and the Signal protocol for end-to-end message encryption — **no browser, Selenium, or Puppeteer required**.

With Baileys you can build a Node.js server that:
- **Automatically syncs all WhatsApp chat history** (chats, contacts, messages)
- **Receives new messages in real time** via an event-driven architecture
- **Sends text, media, location, contact, and interactive messages**
- **Manages groups** (create, add/remove members, update settings)
- **Tracks read receipts, presence, and message status updates**

---

## 2. What is Baileys?

| Property | Detail |
|----------|--------|
| **Library** | `baileys` (npm) |
| **Version** | 7.0.0-rc.9 |
| **License** | MIT |
| **Node.js** | >= 20.0.0 |
| **Module system** | ES Modules (`"type": "module"`) |
| **Protocol** | WhatsApp Web multi-device via WebSocket |
| **Encryption** | Noise_XX_25519_AESGCM_SHA256 + Signal Protocol |
| **Repository** | https://github.com/WhiskeySockets/Baileys |

---

## 3. Architecture Overview

Baileys uses a layered socket architecture where each layer adds capabilities:

```
makeWASocket()                    ← Public API entry point
  └─ makeCommunitiesSocket()      ← Community management
      └─ makeBusinessSocket()     ← Business features
          └─ makeNewsletterSocket() ← Newsletter/channel support
              └─ makeMessagesSocket()     ← Message sending, device enumeration
                  └─ makeMessagesRecvSocket() ← Message decryption, history sync
                      └─ makeGroupsSocket()   ← Group operations
                          └─ makeChatsSocket() ← Chat mutations, app state sync
                              └─ makeSocket()  ← Core WebSocket, Noise protocol, QR
```

**Key internal components:**
- **WebSocketClient** — raw WebSocket connection to `wss://web.whatsapp.com/ws/chat`
- **Signal Repository** — E2E encryption/decryption via `libsignal`
- **Binary Protocol** — WhatsApp's custom binary XML encoding (`WABinary`)
- **Event Emitter** — buffered event system for all state changes

---

## 4. Prerequisites & Setup

### 4.1 Install Dependencies

```bash
mkdir whatsapp-sync-server && cd whatsapp-sync-server
npm init -y

# Core dependency
npm install baileys

# Required peer/utility dependencies
npm install pino pino-pretty        # Logging
npm install @cacheable/node-cache   # Caching for retry handling
npm install link-preview-js         # Optional: rich link previews
npm install express                 # HTTP API layer
```

### 4.2 Project Structure

```
whatsapp-sync-server/
├── src/
│   ├── server.ts              # Express HTTP API
│   ├── whatsapp.ts            # Baileys connection manager
│   ├── store.ts               # Message/chat/contact persistence
│   └── types.ts               # Shared types
├── auth_info/                 # Auto-created: session credentials
├── data/                      # Persisted messages/chats
├── package.json
└── tsconfig.json
```

### 4.3 TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true
  }
}
```

---

## 5. Authentication & Session Management

### 5.1 How Authentication Works

Baileys uses **multi-file authentication state** which stores:
- `creds.json` — Noise keys, identity keys, signed pre-keys, account metadata
- `pre-key-*.json` — Signal pre-keys for session establishment
- `session-*.json` — Active Signal sessions with contacts
- `sender-key-*.json` — Group encryption sender keys
- `app-state-sync-key-*.json` — App state sync encryption keys

### 5.2 Basic Auth Setup

```typescript
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys'
import pino from 'pino'

const logger = pino({ level: 'info' })

async function connectToWhatsApp() {
  // Load or create auth state from disk
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  // Fetch the latest WA Web version for compatibility
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // Sync full history on first connect
    syncFullHistory: true,
    // Mark client as online
    markOnlineOnConnect: true,
    // Generate high quality link previews
    generateHighQualityLinkPreview: true,
    // Required: implement message retrieval for retry handling
    getMessage: async (key) => {
      // Return stored message for retry decryption
      return undefined
    }
  })

  // CRITICAL: Save credentials whenever they update
  sock.ev.on('creds.update', saveCreds)

  return sock
}
```

### 5.3 Pairing Methods

**Method 1: QR Code Pairing (Default)**

```typescript
sock.ev.on('connection.update', (update) => {
  const { qr } = update
  if (qr) {
    // Display QR code for scanning
    // Use 'qrcode-terminal' package to render in terminal
    // or send to a web client for display
    console.log('Scan this QR code:', qr)
  }
})
```

**Method 2: Pairing Code (Phone Number)**

```typescript
// After connection is established but before pairing:
if (!sock.authState.creds.registered) {
  const code = await sock.requestPairingCode('+1234567890')
  console.log(`Enter this code on your phone: ${code}`)
}
```

### 5.4 Connection Lifecycle & Auto-Reconnect

```typescript
sock.ev.on('connection.update', (update) => {
  const { connection, lastDisconnect } = update

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut

    if (shouldReconnect) {
      console.log('Reconnecting...')
      connectToWhatsApp() // Recursive reconnect
    } else {
      console.log('Logged out. Delete auth_info/ and re-scan.')
    }
  }

  if (connection === 'open') {
    console.log('Connected to WhatsApp!')
  }
})
```

**DisconnectReason codes:**
| Code | Meaning | Action |
|------|---------|--------|
| 401 | Unauthorized | Re-authenticate |
| 408 | Timed out | Reconnect |
| 428 | Connection replaced | Reconnect |
| 440 | Connection replaced | Reconnect |
| 500 | Internal error | Reconnect |
| 515 | Restart required | Reconnect |

---

## 6. Syncing All WhatsApp History

### 6.1 How History Sync Works

When a new device connects, WhatsApp sends history in multiple phases:

| Sync Type | Description |
|-----------|-------------|
| `INITIAL_BOOTSTRAP` | Initial set of chats and recent messages |
| `PUSH_NAME` | Contact name mappings |
| `RECENT` | Recent messages across chats |
| `FULL` | Full message history (if `syncFullHistory: true`) |
| `NON_BLOCKING_DATA` | Background data (profile pictures, etc.) |
| `ON_DEMAND` | User-requested history for specific chats |
| `INITIAL_STATUS_V3` | Status/story updates |

### 6.2 Enabling Full History Sync

```typescript
const sock = makeWASocket({
  // ...other config
  syncFullHistory: true,
  // Control which sync types to process:
  shouldSyncHistoryMessage: (msg) => {
    // Return true to process ALL history types (including FULL)
    return true
  }
})
```

> **Default behavior**: By default, `shouldSyncHistoryMessage` skips `FULL` sync type. Override it to `return true` to receive everything.

### 6.3 Receiving Synced History

```typescript
sock.ev.on('messaging-history.set', ({
  chats,
  contacts,
  messages,
  isLatest,
  progress,
  syncType
}) => {
  console.log(`History sync [${syncType}]: ${chats.length} chats, ` +
              `${contacts.length} contacts, ${messages.length} messages`)
  console.log(`Progress: ${progress}%, isLatest: ${isLatest}`)

  // Persist to your database
  for (const chat of chats) {
    store.upsertChat(chat)
  }
  for (const contact of contacts) {
    store.upsertContact(contact)
  }
  for (const message of messages) {
    store.upsertMessage(message)
  }
})
```

### 6.4 On-Demand History Fetch

For older messages not included in the initial sync:

```typescript
// Fetch 50 messages before a specific message in a chat
const requestId = await sock.fetchMessageHistory(
  50,                    // count
  oldMessageKey,         // WAMessageKey to fetch before
  oldMessageTimestamp    // timestamp of that message
)

// Results arrive via the same 'messaging-history.set' event
// with syncType === ON_DEMAND
```

### 6.5 Placeholder Message Resolution

Sometimes messages arrive as placeholders (e.g., encrypted messages your device missed). You can request the full content:

```typescript
sock.ev.on('messages.upsert', async ({ messages, requestId }) => {
  for (const msg of messages) {
    // If this is a placeholder, request the real content
    if (requestId) {
      console.log('Placeholder resolved:', msg.key.id)
    }
  }
})

// Request a specific placeholder to be resent
await sock.requestPlaceholderResend(messageKey)
```

---

## 7. Receiving New Messages in Real Time

### 7.1 The Event System

Baileys uses a **buffered event processor** pattern. The `ev.process()` method receives batches of events for efficient handling:

```typescript
sock.ev.process(async (events) => {
  // Each key in `events` is an event name
  // Each value is the event payload
  // Multiple events can fire in a single batch

  if (events['messages.upsert']) { /* ... */ }
  if (events['messages.update']) { /* ... */ }
  if (events['chats.update'])    { /* ... */ }
  // etc.
})
```

Alternatively, use individual event listeners:

```typescript
sock.ev.on('messages.upsert', handler)
sock.ev.on('messages.update', handler)
```

### 7.2 Receiving New Messages

```typescript
sock.ev.on('messages.upsert', ({ messages, type }) => {
  // type === 'notify' → real-time incoming message
  // type === 'append' → message from history sync

  for (const msg of messages) {
    if (type !== 'notify') continue // Skip history messages here

    const sender = msg.key.remoteJid       // Chat JID
    const fromMe = msg.key.fromMe          // Sent by us?
    const participant = msg.key.participant // Group sender (if group)
    const messageId = msg.key.id           // Unique message ID

    // Extract text content
    const text = msg.message?.conversation
               || msg.message?.extendedTextMessage?.text

    // Extract media
    const imageMessage = msg.message?.imageMessage
    const videoMessage = msg.message?.videoMessage
    const audioMessage = msg.message?.audioMessage
    const documentMessage = msg.message?.documentMessage

    console.log(`[${sender}] ${fromMe ? 'Me' : participant || sender}: ${text}`)
  }
})
```

### 7.3 Message Status Updates

```typescript
// Delivery status, read receipts, edits, deletes
sock.ev.on('messages.update', (updates) => {
  for (const { key, update } of updates) {
    if (update.status) {
      // 1=ERROR, 2=PENDING, 3=SERVER_ACK, 4=DELIVERY_ACK, 5=READ, 6=PLAYED
      console.log(`Message ${key.id} status: ${update.status}`)
    }
  }
})

// Detailed read receipts
sock.ev.on('message-receipt.update', (receipts) => {
  for (const { key, receipt } of receipts) {
    console.log(`Message ${key.id} read by:`, receipt)
  }
})
```

### 7.4 Reactions

```typescript
sock.ev.on('messages.reaction', (reactions) => {
  for (const { key, reaction } of reactions) {
    console.log(`Message ${key.id} got reaction: ${reaction.text || '[removed]'}`)
  }
})
```

### 7.5 Presence Updates

```typescript
// Subscribe to presence for a specific chat
await sock.presenceSubscribe('1234567890@s.whatsapp.net')

sock.ev.on('presence.update', ({ id, presences }) => {
  for (const [participant, presence] of Object.entries(presences)) {
    console.log(`${participant} is ${presence.lastKnownPresence}`)
    // Values: 'available', 'unavailable', 'composing', 'recording', 'paused'
  }
})
```

---

## 8. Sending Messages

### 8.1 JID Format

WhatsApp uses JIDs (Jabber IDs) to identify contacts and groups:

| Type | Format | Example |
|------|--------|---------|
| Individual | `<country><number>@s.whatsapp.net` | `12025551234@s.whatsapp.net` |
| Group | `<timestamp>-<seq>@g.us` | `120363001234567890@g.us` |
| Broadcast | `status@broadcast` | `status@broadcast` |
| Newsletter | `<id>@newsletter` | `120363001234567890@newsletter` |

### 8.2 Text Messages

```typescript
// Simple text
await sock.sendMessage('1234567890@s.whatsapp.net', {
  text: 'Hello from my server!'
})

// Text with mentions
await sock.sendMessage('group-id@g.us', {
  text: '@John check this out',
  mentions: ['john-number@s.whatsapp.net']
})

// Reply to a message
await sock.sendMessage('1234567890@s.whatsapp.net', {
  text: 'This is a reply',
}, {
  quoted: originalMessage // WAMessage object
})
```

### 8.3 Media Messages

```typescript
import { readFileSync } from 'fs'

// Image
await sock.sendMessage(jid, {
  image: readFileSync('./photo.jpg'),
  // OR: image: { url: 'https://example.com/photo.jpg' },
  caption: 'Check this out!'
})

// Video
await sock.sendMessage(jid, {
  video: readFileSync('./video.mp4'),
  caption: 'Cool video',
  gifPlayback: false // set true for GIF-style playback
})

// Audio (voice note)
await sock.sendMessage(jid, {
  audio: readFileSync('./audio.ogg'),
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true // true = voice note, false = audio file
})

// Document
await sock.sendMessage(jid, {
  document: readFileSync('./report.pdf'),
  mimetype: 'application/pdf',
  fileName: 'Report.pdf'
})

// Sticker
await sock.sendMessage(jid, {
  sticker: readFileSync('./sticker.webp')
})
```

### 8.4 Location & Contact Messages

```typescript
// Location
await sock.sendMessage(jid, {
  location: {
    degreesLatitude: 40.7128,
    degreesLongitude: -74.0060
  }
})

// Contact card (vCard)
await sock.sendMessage(jid, {
  contacts: {
    displayName: 'John Doe',
    contacts: [{
      vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nTEL;type=CELL:+1234567890\nEND:VCARD`
    }]
  }
})
```

### 8.5 Message Actions

```typescript
// React to a message
await sock.sendMessage(jid, {
  react: { text: '👍', key: messageKey }
})

// Delete a message (for everyone)
await sock.sendMessage(jid, {
  delete: messageKey
})

// Edit a message
await sock.sendMessage(jid, {
  edit: messageKey,
  text: 'Edited message text'
})

// Forward a message
await sock.sendMessage(jid, {
  forward: originalMessage
})
```

### 8.6 Custom Message IDs

```typescript
import { generateMessageIDV2 } from 'baileys'

const messageId = generateMessageIDV2(sock.user?.id)
await sock.sendMessage(jid, { text: 'Hello' }, { messageId })
```

---

## 9. Media Handling

### 9.1 Downloading Media from Received Messages

```typescript
import { downloadMediaMessage } from 'baileys'
import { writeFileSync } from 'fs'

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    const mediaMsg = msg.message?.imageMessage
                  || msg.message?.videoMessage
                  || msg.message?.audioMessage
                  || msg.message?.documentMessage

    if (mediaMsg) {
      // Download the decrypted media buffer
      const buffer = await downloadMediaMessage(
        msg,
        'buffer', // 'buffer' | 'stream'
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage
        }
      )

      const extension = mediaMsg.mimetype?.split('/')[1] || 'bin'
      writeFileSync(`./downloads/${msg.key.id}.${extension}`, buffer)
    }
  }
})
```

### 9.2 Supported Media Types

| Type | Max Size | Formats |
|------|----------|---------|
| Image | 16 MB | JPEG, PNG, WebP |
| Video | 64 MB | MP4, 3GP |
| Audio | 16 MB | OGG/Opus, MP3, M4A |
| Document | 100 MB | Any file type |
| Sticker | 100 KB (static), 500 KB (animated) | WebP |

---

## 10. Group Management

```typescript
// Create a group
const group = await sock.groupCreate('My Group', [
  '1234567890@s.whatsapp.net',
  '0987654321@s.whatsapp.net'
])
console.log('Group created:', group.id)

// Get group metadata
const metadata = await sock.groupMetadata('group-id@g.us')
console.log(metadata.subject, metadata.participants)

// Add participants
await sock.groupParticipantsUpdate('group-id@g.us',
  ['newmember@s.whatsapp.net'], 'add')

// Remove participants
await sock.groupParticipantsUpdate('group-id@g.us',
  ['member@s.whatsapp.net'], 'remove')

// Promote to admin
await sock.groupParticipantsUpdate('group-id@g.us',
  ['member@s.whatsapp.net'], 'promote')

// Demote from admin
await sock.groupParticipantsUpdate('group-id@g.us',
  ['member@s.whatsapp.net'], 'demote')

// Update group subject
await sock.groupUpdateSubject('group-id@g.us', 'New Group Name')

// Update group description
await sock.groupUpdateDescription('group-id@g.us', 'New description')

// Get invite link
const code = await sock.groupInviteCode('group-id@g.us')
console.log('Invite link: https://chat.whatsapp.com/' + code)

// Set disappearing messages (7 days)
await sock.groupToggleEphemeral('group-id@g.us', 7 * 24 * 60 * 60)

// Leave group
await sock.groupLeave('group-id@g.us')
```

---

## 11. Full Server Implementation

Below is a complete, production-ready server implementation combining everything above:

```typescript
// server.ts
import express from 'express'
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
  WAMessage,
  WAMessageKey,
  generateMessageIDV2,
  CacheStore
} from 'baileys'
import NodeCache from '@cacheable/node-cache'
import pino from 'pino'

// ============================================================
// Configuration
// ============================================================
const AUTH_DIR = './auth_info'
const PORT = 3000
const logger = pino({ level: 'info' })

// ============================================================
// In-Memory Store (replace with a real DB in production)
// ============================================================
const store = {
  chats: new Map<string, any>(),
  contacts: new Map<string, any>(),
  messages: new Map<string, WAMessage>(),

  upsertChat(chat: any) {
    this.chats.set(chat.id, { ...this.chats.get(chat.id), ...chat })
  },
  upsertContact(contact: any) {
    this.contacts.set(contact.id, { ...this.contacts.get(contact.id), ...contact })
  },
  upsertMessage(msg: WAMessage) {
    const key = `${msg.key.remoteJid}:${msg.key.id}`
    this.messages.set(key, msg)
  },
  getMessage(key: WAMessageKey): WAMessage | undefined {
    return this.messages.get(`${key.remoteJid}:${key.id}`)
  }
}

// ============================================================
// WhatsApp Connection
// ============================================================
let sock: ReturnType<typeof makeWASocket> | null = null

const msgRetryCounterCache = new NodeCache() as CacheStore

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    syncFullHistory: true,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
    // Accept ALL history sync types
    shouldSyncHistoryMessage: () => true,
    // Retrieve stored messages for retry decryption
    getMessage: async (key) => {
      const msg = store.getMessage(key)
      return msg?.message || undefined
    },
  })

  // --- Credential persistence ---
  sock.ev.on('creds.update', saveCreds)

  // --- Connection lifecycle ---
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // In production: send QR to your web frontend via WebSocket
      console.log('QR Code (scan with WhatsApp):', qr)
    }

    if (connection === 'open') {
      console.log('WhatsApp connected successfully')
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Disconnected. Reconnecting...')
        startWhatsApp()
      } else {
        console.log('Logged out. Please delete auth_info/ and restart.')
        sock = null
      }
    }
  })

  // --- History sync (bulk import) ---
  sock.ev.on('messaging-history.set', ({
    chats, contacts, messages, isLatest, progress, syncType
  }) => {
    console.log(
      `[HISTORY SYNC] type=${syncType} chats=${chats.length} ` +
      `contacts=${contacts.length} messages=${messages.length} ` +
      `progress=${progress}% isLatest=${isLatest}`
    )

    for (const chat of chats) store.upsertChat(chat)
    for (const contact of contacts) store.upsertContact(contact)
    for (const message of messages) store.upsertMessage(message)
  })

  // --- Real-time incoming messages ---
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      store.upsertMessage(msg)

      if (type === 'notify') {
        const text = msg.message?.conversation
                  || msg.message?.extendedTextMessage?.text
        const sender = msg.key.remoteJid
        const fromMe = msg.key.fromMe

        console.log(`[NEW MSG] ${fromMe ? 'OUT' : 'IN'} ${sender}: ${text || '[media]'}`)
      }
    }
  })

  // --- Message status updates ---
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update.status) {
        console.log(`[STATUS] ${key.id}: ${update.status}`)
      }
    }
  })

  // --- Chat updates ---
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) store.upsertChat(chat)
  })

  sock.ev.on('chats.update', (updates) => {
    for (const update of updates) store.upsertChat(update)
  })

  // --- Contact updates ---
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) store.upsertContact(contact)
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (update.id) store.upsertContact(update)
    }
  })

  return sock
}

// ============================================================
// Express HTTP API
// ============================================================
const app = express()
app.use(express.json())

// Health check
app.get('/status', (req, res) => {
  res.json({
    connected: !!sock,
    user: sock?.user || null,
    chats: store.chats.size,
    contacts: store.contacts.size,
    messages: store.messages.size,
  })
})

// List all synced chats
app.get('/chats', (req, res) => {
  const chats = Array.from(store.chats.values())
  res.json(chats)
})

// List all contacts
app.get('/contacts', (req, res) => {
  const contacts = Array.from(store.contacts.values())
  res.json(contacts)
})

// Get messages for a specific chat
app.get('/messages/:jid', (req, res) => {
  const { jid } = req.params
  const messages = Array.from(store.messages.values())
    .filter(m => m.key.remoteJid === jid)
    .sort((a, b) =>
      (a.messageTimestamp as number) - (b.messageTimestamp as number)
    )
  res.json(messages)
})

// Send a text message
app.post('/send/text', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Not connected' })

  const { jid, text, quotedMessageId } = req.body
  try {
    let options: any = {}
    if (quotedMessageId) {
      const quoted = store.getMessage({
        remoteJid: jid,
        id: quotedMessageId
      } as WAMessageKey)
      if (quoted) options.quoted = quoted
    }

    const result = await sock.sendMessage(jid, { text }, options)
    res.json({ success: true, messageId: result?.key.id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Send an image
app.post('/send/image', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Not connected' })

  const { jid, imageUrl, caption } = req.body
  try {
    const result = await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ''
    })
    res.json({ success: true, messageId: result?.key.id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Send a document
app.post('/send/document', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Not connected' })

  const { jid, documentUrl, mimetype, fileName } = req.body
  try {
    const result = await sock.sendMessage(jid, {
      document: { url: documentUrl },
      mimetype: mimetype || 'application/octet-stream',
      fileName: fileName || 'file'
    })
    res.json({ success: true, messageId: result?.key.id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Get group metadata
app.get('/groups/:jid', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Not connected' })
  try {
    const metadata = await sock.groupMetadata(req.params.jid)
    res.json(metadata)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Fetch on-demand history for a chat
app.post('/history/:jid', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Not connected' })
  const { count, beforeMessageId, beforeTimestamp } = req.body
  try {
    const requestId = await sock.fetchMessageHistory(
      count || 50,
      { remoteJid: req.params.jid, id: beforeMessageId } as WAMessageKey,
      beforeTimestamp
    )
    res.json({ success: true, requestId })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Start Everything
// ============================================================
startWhatsApp()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`HTTP API running on http://localhost:${PORT}`)
    })
  })
  .catch(console.error)
```

### 11.1 API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/status` | Connection status and store stats |
| `GET` | `/chats` | List all synced chats |
| `GET` | `/contacts` | List all synced contacts |
| `GET` | `/messages/:jid` | Get messages for a chat |
| `POST` | `/send/text` | Send a text message |
| `POST` | `/send/image` | Send an image message |
| `POST` | `/send/document` | Send a document |
| `GET` | `/groups/:jid` | Get group metadata |
| `POST` | `/history/:jid` | Request on-demand history sync |

### 11.2 Example API Calls

```bash
# Check connection status
curl http://localhost:3000/status

# List chats
curl http://localhost:3000/chats

# Send a text message
curl -X POST http://localhost:3000/send/text \
  -H 'Content-Type: application/json' \
  -d '{"jid": "1234567890@s.whatsapp.net", "text": "Hello from API!"}'

# Send an image
curl -X POST http://localhost:3000/send/image \
  -H 'Content-Type: application/json' \
  -d '{"jid": "1234567890@s.whatsapp.net", "imageUrl": "./photo.jpg", "caption": "Check this!"}'

# Get messages for a chat
curl http://localhost:3000/messages/1234567890@s.whatsapp.net

# Get group info
curl http://localhost:3000/groups/120363001234567890@g.us

# Fetch older messages
curl -X POST http://localhost:3000/history/1234567890@s.whatsapp.net \
  -H 'Content-Type: application/json' \
  -d '{"count": 100, "beforeMessageId": "ABCDEF123", "beforeTimestamp": 1700000000}'
```

---

## 12. Production Considerations

### 12.1 Persistent Storage

Replace the in-memory store with a real database:

```typescript
// Example with SQLite, PostgreSQL, MongoDB, etc.
// Store messages in a database table:
// CREATE TABLE messages (
//   jid TEXT,
//   message_id TEXT PRIMARY KEY,
//   from_me BOOLEAN,
//   timestamp INTEGER,
//   content JSONB,
//   raw JSONB
// );
```

The `getMessage` callback is **critical** for production — when WhatsApp requests a retry, Baileys needs to re-encrypt the original message. Without it, recipients see "waiting for this message" indefinitely.

### 12.2 Caching Strategy

```typescript
import NodeCache from '@cacheable/node-cache'

const sock = makeWASocket({
  // ...config
  msgRetryCounterCache: new NodeCache({ stdTTL: 3600 }),    // 1 hour
  userDevicesCache: new NodeCache({ stdTTL: 300 }),          // 5 minutes
  callOfferCache: new NodeCache({ stdTTL: 300 }),            // 5 minutes
})
```

### 12.3 Rate Limiting

WhatsApp enforces rate limits. Best practices:
- **Don't send more than ~10-15 messages/minute** to avoid temporary bans
- Add delays between bulk sends (`p-queue` with concurrency limits)
- Avoid sending identical messages to many recipients rapidly
- Never send unsolicited bulk messages (this will get your number banned)

### 12.4 Error Handling & Retry

```typescript
import { Boom } from '@hapi/boom'

// The getMessage callback is essential for retry handling
getMessage: async (key) => {
  // Look up the message in your database
  const msg = await db.getMessage(key.remoteJid, key.id)
  return msg?.content || undefined
}
```

### 12.5 Multi-Session Support

To manage multiple WhatsApp accounts:

```typescript
const sessions = new Map<string, ReturnType<typeof makeWASocket>>()

async function createSession(sessionId: string) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`)
  const sock = makeWASocket({ auth: { /* ... */ } })
  sessions.set(sessionId, sock)
  return sock
}
```

### 12.6 Security

- **Never expose the auth_info/ directory** — it contains full session credentials
- **Add authentication to your HTTP API** (API keys, JWT, etc.)
- **Validate all input** to API endpoints (JID format, message content)
- **Use HTTPS** in production
- **Don't log message content** in production

---

## 13. API Reference: Key Events

| Event | Payload | When |
|-------|---------|------|
| `connection.update` | `{ connection, lastDisconnect, qr }` | Connection state changes |
| `creds.update` | `Partial<AuthenticationCreds>` | Credentials updated (must save) |
| `messaging-history.set` | `{ chats, contacts, messages, isLatest, progress, syncType }` | History sync batch received |
| `messages.upsert` | `{ messages, type, requestId? }` | New/synced messages |
| `messages.update` | `[{ key, update }]` | Message status/content changes |
| `messages.delete` | `{ keys } \| { jid, all }` | Messages deleted |
| `messages.reaction` | `[{ key, reaction }]` | Reactions added/removed |
| `message-receipt.update` | `[{ key, receipt }]` | Read/delivery receipts |
| `chats.upsert` | `Chat[]` | New chats discovered |
| `chats.update` | `ChatUpdate[]` | Chat metadata changed |
| `chats.delete` | `string[]` | Chats deleted |
| `contacts.upsert` | `Contact[]` | New contacts |
| `contacts.update` | `Partial<Contact>[]` | Contact info changed |
| `groups.upsert` | `GroupMetadata[]` | New groups |
| `groups.update` | `Partial<GroupMetadata>[]` | Group settings changed |
| `group-participants.update` | `{ id, participants, action }` | Members added/removed/promoted |
| `presence.update` | `{ id, presences }` | Online/typing status |
| `call` | `WACallEvent[]` | Incoming/outgoing calls |
| `labels.edit` | `Label` | Label created/edited |
| `labels.association` | `{ association, type }` | Label assigned/removed |

---

## 14. Limitations & Risks

### 14.1 Technical Limitations

- **Not an official API** — Baileys reverse-engineers the WhatsApp Web protocol. WhatsApp can change their protocol at any time, breaking compatibility.
- **Single device per connection** — Each Baileys instance acts as one linked device. WhatsApp allows up to 4 linked devices.
- **History sync is async** — Full history arrives in batches over time (can take minutes for large accounts). You cannot "query" old messages on demand beyond what WhatsApp provides.
- **No voice/video calls** — Baileys supports call event detection but not actual VoIP.
- **Media re-upload** — Media URLs expire. Downloaded media must be stored locally.
- **Placeholder messages** — Some old messages may arrive as encrypted placeholders that need explicit re-request (limited to 14 days old).

### 14.2 Account Risks

- **Ban risk** — Using unofficial APIs violates WhatsApp's Terms of Service. Accounts can be temporarily or permanently banned, especially with:
  - Bulk/automated messaging
  - Spamming behavior
  - High message volume
  - New/unverified numbers
- **Use a dedicated number** — Never use your primary personal number for automation.

### 14.3 Alternatives for Production Use

For business-critical applications, consider:
- **WhatsApp Business API** (official, via Meta Business Suite)
- **WhatsApp Cloud API** (official, free tier available)

These are sanctioned by Meta and don't carry ban risk, but have their own limitations (no personal message history sync, template-based messaging, etc.).

---

## Summary

Baileys provides everything needed to build a full WhatsApp sync server in Node.js:

1. **Connect** via `makeWASocket()` with QR code or pairing code authentication
2. **Sync** all history automatically via the `messaging-history.set` event with `syncFullHistory: true`
3. **Receive** real-time messages via `messages.upsert` events
4. **Send** any message type via `sock.sendMessage()`
5. **Manage** groups, contacts, and presence via dedicated socket methods
6. **Persist** everything by wiring events to your database of choice
7. **Expose** functionality via an HTTP/WebSocket API for your applications

The library handles all the complexity of the WhatsApp protocol — Noise encryption, Signal E2E encryption, binary protocol encoding, session management, and connection lifecycle — letting you focus on your application logic.
