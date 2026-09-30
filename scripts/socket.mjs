// A WebSocket for Node scripts: the built-in one on Node 22+, otherwise the
// `ws` package from `npm install`. Both speak the browser API used here.

export async function getWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  try {
    return (await import('ws')).WebSocket
  } catch {
    throw new Error('No WebSocket available. Use Node 22 or newer, or run `npm install` first.')
  }
}

// Opens a socket and calls onEvent(msg) for every JSON message.
export async function openJsonSocket(url, { onEvent, onClose } = {}) {
  const WebSocketImpl = await getWebSocket()
  const ws = new WebSocketImpl(String(url))
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (event) => reject(new Error(event?.message || 'WebSocket error'))
  })
  opened.catch(() => {}) // callers that await it still see the error
  ws.onmessage = (event) => {
    const data = event.data
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    onEvent?.(msg)
  }
  const closed = new Promise((resolve) => {
    ws.onclose = (event) => {
      onClose?.(event)
      resolve({ code: event?.code, reason: String(event?.reason || '') })
    }
  })
  return {
    ws,
    opened,
    closed,
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
    get open() {
      return ws.readyState === 1
    },
  }
}

// 20 ms of 24 kHz PCM16 silence, the frame size a microphone would send.
export const FRAME_MS = 20
export const FRAME_BYTES = (24000 * 2 * FRAME_MS) / 1000
export const SILENT_FRAME = Buffer.alloc(FRAME_BYTES).toString('base64')
