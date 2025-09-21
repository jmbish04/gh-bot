export type CommandStatusPayload = {
  commandId: string
  status?: string
  progress?: number
  message?: string
  error?: string
  resultData?: Record<string, unknown>
  timestamp?: string
  [key: string]: unknown
}

const commandSubscriptions = new Map<string, Set<WebSocket>>()
const socketSubscriptions = new Map<WebSocket, string>()

function safeSend(socket: WebSocket, data: unknown) {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data))
    }
  } catch (error) {
    console.error('Failed to send WebSocket message', error)
    cleanupSocket(socket)
  }
}

function cleanupSocket(socket: WebSocket) {
  const commandId = socketSubscriptions.get(socket)
  if (commandId) {
    const sockets = commandSubscriptions.get(commandId)
    sockets?.delete(socket)
    if (sockets && sockets.size === 0) {
      commandSubscriptions.delete(commandId)
    }
    socketSubscriptions.delete(socket)
  }
}

function subscribeToCommand(socket: WebSocket, commandId: string) {
  const existing = socketSubscriptions.get(socket)
  if (existing) {
    if (existing === commandId) {
      return
    }
    const sockets = commandSubscriptions.get(existing)
    sockets?.delete(socket)
    if (sockets && sockets.size === 0) {
      commandSubscriptions.delete(existing)
    }
  }

  let sockets = commandSubscriptions.get(commandId)
  if (!sockets) {
    sockets = new Set()
    commandSubscriptions.set(commandId, sockets)
  }
  sockets.add(socket)
  socketSubscriptions.set(socket, commandId)
}

function unsubscribe(socket: WebSocket) {
  const existing = socketSubscriptions.get(socket)
  if (!existing) {
    return
  }
  const sockets = commandSubscriptions.get(existing)
  sockets?.delete(socket)
  if (sockets && sockets.size === 0) {
    commandSubscriptions.delete(existing)
  }
  socketSubscriptions.delete(socket)
}

function parseMessageData(data: unknown): string {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer)
  }
  return ''
}

export function setupCommandStatusSocket(socket: WebSocket) {
  socket.accept()
  safeSend(socket, {
    type: 'connection_ack',
    message: 'Connected to Colby command status stream'
  })

  socket.addEventListener('message', (event: MessageEvent) => {
    const raw = parseMessageData(event.data)
    if (!raw) {
      safeSend(socket, {
        type: 'error',
        message: 'Invalid message payload'
      })
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      safeSend(socket, {
        type: 'error',
        message: 'Messages must be valid JSON'
      })
      return
    }

    const action = parsed?.action
    if (action === 'subscribe') {
      const commandId = parsed?.commandId
      if (typeof commandId !== 'string' || !commandId.trim()) {
        safeSend(socket, {
          type: 'error',
          message: 'commandId must be a non-empty string'
        })
        return
      }

      subscribeToCommand(socket, commandId)
      safeSend(socket, {
        type: 'subscribed',
        commandId
      })
      return
    }

    if (action === 'unsubscribe') {
      unsubscribe(socket)
      safeSend(socket, {
        type: 'unsubscribed'
      })
      return
    }

    safeSend(socket, {
      type: 'error',
      message: 'Unknown action'
    })
  })

  const closeHandler = () => {
    unsubscribe(socket)
    cleanupSocket(socket)
  }

  socket.addEventListener('close', closeHandler)
  socket.addEventListener('error', closeHandler)
}

export function broadcastCommandStatus(update: CommandStatusPayload) {
  const commandId = String(update.commandId ?? '')
  if (!commandId) {
    return
  }

  const sockets = commandSubscriptions.get(commandId)
  if (!sockets || sockets.size === 0) {
    return
  }

  const { commandId: _ignored, timestamp, ...rest } = update
  const payload = {
    type: 'command_status',
    commandId,
    timestamp: timestamp ?? new Date().toISOString(),
    ...rest
  }

  const serialized = JSON.stringify(payload)

  for (const socket of sockets) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized)
      } else {
        cleanupSocket(socket)
      }
    } catch (error) {
      console.error('Error broadcasting command status', error)
      cleanupSocket(socket)
    }
  }
}
