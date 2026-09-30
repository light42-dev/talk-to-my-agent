// Client-side tool results must be sent only when reply.done is the latest
// event (https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools).
// This queue does that, and knows when the agent has asked to hang up.

export function createToolQueue(send) {
  let pending = []
  let last = null

  function flush() {
    if (last !== 'reply.done' || !pending.length) return
    for (const item of pending) {
      send({ type: 'tool.result', call_id: item.callId, result: JSON.stringify(item.result) })
    }
    pending = []
  }

  return {
    // Hold a result until the agent's current reply finishes.
    add(callId, result) {
      pending.push({ callId, result })
      flush()
    },
    event(type, detail = {}) {
      if (type === 'reply.started' || type === 'input.speech.started') last = type
      if (type === 'reply.done') {
        last = 'reply.done'
        // An interrupted reply drops its tool results, as the docs recommend.
        if (detail.status === 'interrupted') pending = []
        else flush()
      }
    },
    // Drop anything unsent, e.g. when the call is about to hang up and a
    // result would only prompt the agent to speak again.
    clear() {
      pending = []
    },
    // Rewrite the results still waiting to be sent, e.g. to change what the
    // agent is told to do next.
    amend(fn) {
      pending = pending.map((item) => ({ ...item, result: fn(item.result) }))
    },
    get pending() {
      return pending.length
    },
  }
}

// Seconds of 24 kHz PCM16 audio in a base64 chunk.
export function audioSeconds(base64) {
  const bytes = Math.floor((String(base64 || '').length * 3) / 4)
  return bytes / 2 / 24000
}

// Tracks how much agent audio is still queued for the speaker, so the call
// can hang up after the goodbye is heard rather than mid-word.
export function createPlayoutClock(now = () => Date.now()) {
  let endsAt = 0
  return {
    add(seconds) {
      const t = now()
      endsAt = Math.max(endsAt, t) + seconds * 1000
    },
    clear() {
      endsAt = 0
    },
    remainingMs() {
      return Math.max(0, endsAt - now())
    },
  }
}
