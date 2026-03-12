/**
 * WhatsApp Sync Viewer
 *
 * A local CLI tool that connects to WhatsApp, syncs recent history,
 * and displays the 10 most recent messages across all chats.
 *
 * Usage:
 *   npx tsx tools/wa-sync-viewer.ts                  # QR code pairing
 *   npx tsx tools/wa-sync-viewer.ts --pairing-code   # Phone number pairing code
 *   npx tsx tools/wa-sync-viewer.ts --send <jid> <message>  # Send a message
 *
 * On first run, scan the QR code with WhatsApp (or use pairing code).
 * Session is saved to ./wa-sync-session/ for future runs.
 */

import { Boom } from '@hapi/boom'
import makeWASocket, {
  CacheStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WAMessageKey,
} from '../src'
import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import readline from 'readline'

// ── Config ──────────────────────────────────────────────────
const SESSION_DIR = './wa-sync-session'
const MAX_DISPLAY_MESSAGES = 10
const HISTORY_WAIT_MS = 15_000 // wait for history sync after connection

const usePairingCode = process.argv.includes('--pairing-code')
const sendMode = process.argv.includes('--send')

const logger = P({ level: 'warn' })

// ── Store ───────────────────────────────────────────────────
interface ChatInfo {
  id: string
  name?: string | null
  unreadCount?: number
  lastMessageTimestamp?: number
}

const chats = new Map<string, ChatInfo>()
const contacts = new Map<string, { id: string; name?: string | null; notify?: string | null }>()
const messages: WAMessage[] = []
const msgRetryCounterCache = new NodeCache() as CacheStore

function storeMessage(msg: WAMessage) {
  messages.push(msg)
}

function getContactName(jid: string): string {
  const c = contacts.get(jid)
  if (c?.name) return c.name
  if (c?.notify) return c.notify
  const chat = chats.get(jid)
  if (chat?.name) return chat.name
  // strip @s.whatsapp.net / @g.us
  return jid.replace(/@.*/, '')
}

function formatTimestamp(ts: number | Long | null | undefined): string {
  if (!ts) return '???'
  const n = typeof ts === 'number' ? ts : Number(ts)
  // WhatsApp timestamps are in seconds
  const d = new Date(n * 1000)
  return d.toLocaleString()
}

function extractText(msg: WAMessage): string {
  const m = msg.message
  if (!m) return '[empty]'
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage) return `[Image] ${m.imageMessage.caption || ''}`
  if (m.videoMessage) return `[Video] ${m.videoMessage.caption || ''}`
  if (m.audioMessage) return m.audioMessage.ptt ? '[Voice Note]' : '[Audio]'
  if (m.documentMessage) return `[Document] ${m.documentMessage.fileName || ''}`
  if (m.stickerMessage) return '[Sticker]'
  if (m.contactMessage) return `[Contact] ${m.contactMessage.displayName || ''}`
  if (m.locationMessage) return '[Location]'
  if (m.reactionMessage) return `[Reaction] ${m.reactionMessage.text || ''}`
  if (m.pollCreationMessage) return `[Poll] ${m.pollCreationMessage.name || ''}`
  if (m.editedMessage) return '[Edited Message]'
  if (m.protocolMessage) return '[System Message]'
  // fallback: show first key
  const keys = Object.keys(m)
  return `[${keys[0] || 'unknown'}]`
}

function displayRecentMessages() {
  // Sort all messages by timestamp descending, take top N
  const sorted = messages
    .filter(m => m.message && !m.message.protocolMessage && !m.message.senderKeyDistributionMessage)
    .sort((a, b) => {
      const ta = Number(a.messageTimestamp || 0)
      const tb = Number(b.messageTimestamp || 0)
      return tb - ta
    })
    .slice(0, MAX_DISPLAY_MESSAGES)

  console.log('\n' + '═'.repeat(70))
  console.log(`  WHATSAPP SYNC VIEWER — ${MAX_DISPLAY_MESSAGES} Most Recent Messages`)
  console.log('═'.repeat(70))

  if (sorted.length === 0) {
    console.log('  No messages synced yet.')
  } else {
    for (const msg of sorted.reverse()) {
      const chatName = getContactName(msg.key.remoteJid || '')
      const sender = msg.key.fromMe
        ? 'You'
        : msg.key.participant
          ? getContactName(msg.key.participant)
          : chatName
      const time = formatTimestamp(msg.messageTimestamp)
      const text = extractText(msg)

      const isGroup = msg.key.remoteJid?.endsWith('@g.us')
      const chatLabel = isGroup ? `[${chatName}]` : chatName

      console.log(`  ${time}`)
      console.log(`  ${chatLabel} — ${sender}: ${text}`)
      console.log('  ' + '─'.repeat(66))
    }
  }

  console.log('═'.repeat(70))
  console.log(`  Synced: ${messages.length} messages | ${chats.size} chats | ${contacts.size} contacts`)
  console.log('═'.repeat(70) + '\n')
}

// ── Readline helper ─────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

// ── Main ────────────────────────────────────────────────────
async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`\nWhatsApp Sync Viewer`)
  console.log(`Using WA Web v${version.join('.')}`)
  console.log(`Session stored in: ${SESSION_DIR}/\n`)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    syncFullHistory: false, // only recent history for quick view
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: true,
    shouldSyncHistoryMessage: (msg) => {
      // Accept INITIAL_BOOTSTRAP, RECENT, and PUSH_NAME for quick sync
      const dominated = [
        proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        proto.HistorySync.HistorySyncType.RECENT,
        proto.HistorySync.HistorySyncType.PUSH_NAME,
      ]
      return dominated.includes(msg.syncType!)
    },
    getMessage: async (key: WAMessageKey) => {
      const found = messages.find(
        m => m.key.remoteJid === key.remoteJid && m.key.id === key.id
      )
      return found?.message || undefined
    },
  })

  let connected = false
  let historySyncCount = 0

  // ── Connection lifecycle ──────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      if (usePairingCode && !sock.authState.creds.registered) {
        const phone = await ask('Enter your phone number (with country code, e.g. +12025551234): ')
        const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''))
        console.log(`\nPairing code: ${code}\n`)
        console.log('Enter this code on your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number\n')
      } else {
        console.log('Scan this QR code with WhatsApp:\n')
        qrcode.generate(qr, { small: true })
        console.log('')
      }
    }

    if (connection === 'open') {
      connected = true
      console.log(`Connected as ${sock.user?.id || 'unknown'}`)
      console.log(`Waiting ${HISTORY_WAIT_MS / 1000}s for history sync...\n`)

      // Handle --send mode
      if (sendMode) {
        const sendIdx = process.argv.indexOf('--send')
        const jid = process.argv[sendIdx + 1]
        const text = process.argv.slice(sendIdx + 2).join(' ')
        if (jid && text) {
          try {
            const result = await sock.sendMessage(jid, { text })
            console.log(`Message sent! ID: ${result?.key.id}`)
          } catch (err: any) {
            console.error(`Failed to send: ${err.message}`)
          }
        } else {
          console.error('Usage: --send <jid> <message text>')
        }
        // wait briefly then exit
        setTimeout(() => process.exit(0), 3000)
        return
      }

      // Wait for history then display
      setTimeout(() => {
        displayRecentMessages()
        enterInteractiveMode(sock)
      }, HISTORY_WAIT_MS)
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Disconnected. Reconnecting...')
        main()
      } else {
        console.log('Logged out. Delete wa-sync-session/ and restart to re-pair.')
        process.exit(1)
      }
    }
  })

  // ── Credential persistence ────────────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── History sync ──────────────────────────────────────────
  sock.ev.on('messaging-history.set', ({ chats: syncedChats, contacts: syncedContacts, messages: syncedMessages, progress, syncType }) => {
    historySyncCount++
    for (const chat of syncedChats) {
      chats.set(chat.id, {
        id: chat.id,
        name: chat.name || chats.get(chat.id)?.name,
        unreadCount: chat.unreadCount ?? undefined,
        lastMessageTimestamp: chat.conversationTimestamp
          ? Number(chat.conversationTimestamp)
          : undefined,
      })
    }
    for (const contact of syncedContacts) {
      contacts.set(contact.id, {
        id: contact.id,
        name: contact.name || contacts.get(contact.id)?.name,
        notify: contact.notify || contacts.get(contact.id)?.notify,
      })
    }
    for (const msg of syncedMessages) {
      storeMessage(msg)
    }
    console.log(
      `  [Sync #${historySyncCount}] +${syncedChats.length} chats, ` +
      `+${syncedContacts.length} contacts, +${syncedMessages.length} msgs ` +
      `(progress: ${progress}%, type: ${syncType})`
    )
  })

  // ── Real-time messages ────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages: newMsgs, type }) => {
    for (const msg of newMsgs) {
      storeMessage(msg)
    }
    if (type === 'notify' && connected) {
      for (const msg of newMsgs) {
        const chatName = getContactName(msg.key.remoteJid || '')
        const sender = msg.key.fromMe ? 'You' : chatName
        const text = extractText(msg)
        console.log(`  [NEW] ${sender}: ${text}`)
      }
    }
  })

  // ── Contact/chat updates ──────────────────────────────────
  sock.ev.on('contacts.upsert', (upserted) => {
    for (const c of upserted) {
      contacts.set(c.id, {
        id: c.id,
        name: c.name || contacts.get(c.id)?.name,
        notify: c.notify || contacts.get(c.id)?.notify,
      })
    }
  })

  sock.ev.on('contacts.update', (updated) => {
    for (const c of updated) {
      if (c.id) {
        const existing = contacts.get(c.id)
        contacts.set(c.id, {
          id: c.id,
          name: c.name ?? existing?.name,
          notify: c.notify ?? existing?.notify,
        })
      }
    }
  })

  sock.ev.on('chats.upsert', (upserted) => {
    for (const chat of upserted) {
      chats.set(chat.id, {
        id: chat.id,
        name: chat.name || chats.get(chat.id)?.name,
      })
    }
  })

  sock.ev.on('chats.update', (updated) => {
    for (const chat of updated) {
      if (chat.id) {
        const existing = chats.get(chat.id)
        chats.set(chat.id, {
          id: chat.id!,
          name: chat.name ?? existing?.name,
          unreadCount: chat.unreadCount ?? existing?.unreadCount,
        })
      }
    }
  })

  return sock
}

// ── Interactive Mode ────────────────────────────────────────
function enterInteractiveMode(sock: ReturnType<typeof makeWASocket>) {
  console.log('Interactive mode — commands:')
  console.log('  recent            Show 10 most recent messages again')
  console.log('  chats             List all synced chats')
  console.log('  send <jid> <msg>  Send a text message')
  console.log('  quit              Exit\n')

  const prompt = () => {
    rl.question('> ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed) return prompt()

      const [cmd, ...args] = trimmed.split(' ')

      switch (cmd) {
        case 'recent':
          displayRecentMessages()
          break

        case 'chats': {
          const chatList = Array.from(chats.values())
            .sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0))
          console.log(`\n  ${chatList.length} chats:\n`)
          for (const c of chatList.slice(0, 30)) {
            const name = c.name || c.id.replace(/@.*/, '')
            const time = c.lastMessageTimestamp
              ? formatTimestamp(c.lastMessageTimestamp)
              : ''
            console.log(`  ${c.id}  ${name}  ${time}`)
          }
          console.log('')
          break
        }

        case 'send': {
          const jid = args[0]
          const text = args.slice(1).join(' ')
          if (!jid || !text) {
            console.log('  Usage: send <jid> <message>')
            break
          }
          try {
            const result = await sock.sendMessage(jid, { text })
            console.log(`  Sent! ID: ${result?.key.id}`)
          } catch (err: any) {
            console.error(`  Error: ${err.message}`)
          }
          break
        }

        case 'quit':
        case 'exit':
          console.log('Goodbye!')
          process.exit(0)

        default:
          console.log(`  Unknown command: ${cmd}`)
      }

      prompt()
    })
  }

  prompt()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
