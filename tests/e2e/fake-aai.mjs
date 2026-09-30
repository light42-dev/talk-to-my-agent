// A stand-in for wss://agents.assemblyai.com/v1/ws that replays a scripted
// call using the documented event shapes, so the page can be tested end to
// end without an API key. It checks the page's replies as it goes.

import { WebSocketServer } from 'ws'

// 0.25 s of silence at 24 kHz PCM16, base64: stands in for agent speech.
const SILENCE = Buffer.alloc(24000 * 2 * 0.25).toString('base64')

export const SCENARIOS = {
  booked: [
    { agent: "Hi, you've reached Maya Chen's agent. I'm an AI assistant who handles Maya's first conversations about new roles, and I take notes for her. Who am I speaking with?" },
    { caller: 'Hi, this is Jen Park from Northwind Analytics, about the senior data analyst role.' },
    { agent: "Thanks, Jen. Maya applied for that role on September 3. What's the pay range?", tools: [{ name: 'find_application', arguments: { company: 'Northwind Analytics', role: 'Senior Data Analyst', caller_name: 'Jen Park' } }] },
    { caller: 'One fifteen to one thirty-five base.' },
    { agent: 'Thank you. Is it remote, hybrid, or on-site?', tools: [{ name: 'record_details', arguments: { pay_min: 115000, pay_max: 135000, pay_unit: 'year', pay_basis: 'base' } }] },
    { caller: 'Hybrid, two days a week in Austin.' },
    { agent: 'How many interview rounds are there, and when will she hear back either way?', tools: [{ name: 'record_details', arguments: { work_mode: 'hybrid', office_location: 'Austin', office_days_per_week: 2 } }] },
    { caller: "Four rounds, and we'll decide by October twentieth." },
    { agent: "So that's $115,000 to $135,000 base, hybrid, 2 days a week in Austin, 4 interview rounds, and a decision by October 20. Did I get that right?", tools: [{ name: 'record_details', arguments: { interview_rounds: 4, decision_date: '2026-10-20' } }] },
    { caller: "Yes, that's right." },
    { agent: 'Thanks. I can offer Wednesday at noon or Wednesday at four forty-five Central.', tools: [{ name: 'confirm_details', arguments: { confirmed: true, scope: 'details' } }, { name: 'get_open_slots', arguments: {} }] },
    { caller: 'Wednesday at noon works.' },
    { agent: "You're booked for Wednesday at noon Central. What's the best email for a short written confirmation?", tools: [{ name: 'book_slot', arguments: { slot_id: 'slot_1' } }] },
    { caller: 'jen dot park at northwind dash analytics dot com' },
    { agent: "That's j e n dot p a r k at northwind dash analytics dot com. Is that right?", tools: [{ name: 'record_contact', arguments: { name: 'Jen Park', email: 'jen dot park at northwind dash analytics dot com' } }] },
    { caller: 'Yes.' },
    {
      agent: 'Thanks, Jen. A written summary is on its way. And if you decide not to move forward, a short reply is enough. Maya would rather know than wait. Goodbye.',
      tools: [{ name: 'confirm_details', arguments: { confirmed: true, scope: 'contact' } }, { name: 'end_call', arguments: { reason: 'booked' } }],
      ends: true,
    },
  ],

  scam: [
    { agent: "Hi, you've reached Maya Chen's agent. Who am I speaking with?" },
    { caller: "Congratulations, Maya's been selected! There's just a $49 onboarding fee for her equipment kit." },
    // The agent misses it; the page's rules must catch it and nudge.
    { agent: 'Thanks for calling. Which company are you with?' },
    { expect: 'reply.create', contains: 'end_call' },
    {
      agent: "Maya doesn't pay for job opportunities or share personal details before a written offer, so I'll end the call here. Take care.",
      tools: [{ name: 'end_call', arguments: { reason: 'scam' } }],
      ends: true,
    },
  ],

  declined: [
    { agent: "Hi, you've reached Maya Chen's agent. Who am I speaking with?" },
    { caller: 'Mike from TalentBridge Staffing. Twelve-month W-2 contract, forty an hour, on-site in Dallas five days.' },
    {
      agent: 'Thanks, Mike. How many interview rounds, and when would she hear back?',
      tools: [
        { name: 'find_application', arguments: { company: 'TalentBridge Staffing', caller_name: 'Mike' } },
        { name: 'record_details', arguments: { pay_min: 40, pay_max: 40, pay_unit: 'hour', pay_basis: 'w2_hourly', work_mode: 'onsite', office_location: 'Dallas' } },
      ],
    },
    { caller: 'Two rounds, decision this week.' },
    { agent: "So that's $40/hr W-2, on-site in Dallas, 2 interview rounds, and a decision this week. Did I get that right?", tools: [{ name: 'record_details', arguments: { interview_rounds: 2, decision_when: 'this week' } }] },
    { caller: 'Yep.' },
    { agent: "Thanks. It isn't a fit for Maya right now: the rate is below her $65/hr floor, and she isn't looking for fully on-site roles. What's the best email for a short summary?", tools: [{ name: 'confirm_details', arguments: { confirmed: true, scope: 'details' } }] },
    { caller: 'mike at talentbridge dot com' },
    { agent: "That's m i k e at talentbridge dot com. Right?", tools: [{ name: 'record_contact', arguments: { name: 'Mike', email: 'mike@talentbridge.com' } }] },
    { caller: 'Right.' },
    { agent: 'Thanks, Mike. A short summary is on its way. Goodbye.', tools: [{ name: 'confirm_details', arguments: { confirmed: true, scope: 'contact' } }, { name: 'end_call', arguments: { reason: 'not_a_fit' } }], ends: true },
  ],
}

// What `npm run smoke` does against the real API: typed caller lines.
SCENARIOS.smoke = [
  { agent: "Hi, you've reached Maya Chen's agent. I'm an AI assistant who handles Maya's first conversations about new roles, and I take notes for her. Who am I speaking with?" },
  { expect: 'conversation.message', contains: 'Northwind' },
  { expect: 'reply.create' },
  { agent: 'One moment.', tools: [{ name: 'find_application', arguments: { company: 'Northwind Analytics', role: 'Senior Data Analyst', caller_name: 'Jen Park' } }] },
  { agent: "Thanks, Jen. Maya applied for that role on September 3. What's the pay range?" },
  { expect: 'conversation.message', contains: 'one hundred fifteen' },
  { expect: 'reply.create' },
  { agent: 'Thank you.', tools: [{ name: 'record_details', arguments: { pay_min: 115000, pay_max: 135000, pay_unit: 'year', pay_basis: 'base' } }] },
  { agent: 'Is it remote, hybrid, or on-site?' },
]

const REQUIRED_TOOLS = ['find_application', 'get_candidate_answer', 'record_details', 'record_contact', 'confirm_details', 'get_open_slots', 'book_slot', 'flag_scam', 'end_call']

export function startFakeServer({ port, scenario }) {
  const steps = SCENARIOS[scenario]
  const log = { problems: [], toolResults: [], received: [], ended: false }
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x')
    if (!url.searchParams.get('token')) log.problems.push('no token on the socket URL')
    const inbox = []
    let waiter = null
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type !== 'input.audio') log.received.push(msg.type)
      if (msg.type === 'session.end') {
        log.ended = true
        ws.send(JSON.stringify({ type: 'session.ended' }))
        setTimeout(() => ws.close(), 50)
      }
      inbox.push(msg)
      waiter?.()
    })
    const next = (type, timeout = 8000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now()
        let settled = false
        const check = () => {
          // A timer from an earlier poll must not take the next message.
          if (settled) return
          const i = inbox.findIndex((m) => m.type === type)
          if (i >= 0) {
            settled = true
            waiter = null
            return resolve(inbox.splice(i, 1)[0])
          }
          if (Date.now() - t0 > timeout) {
            settled = true
            waiter = null
            return reject(new Error(`timed out waiting for ${type}`))
          }
          waiter = check
          setTimeout(check, 50)
        }
        check()
      })
    const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))

    ;(async () => {
      const update = await next('session.update')
      const s = update.session || {}
      const names = (s.tools || []).map((t) => t.name)
      for (const name of REQUIRED_TOOLS) if (!names.includes(name)) log.problems.push(`tool missing: ${name}`)
      if (!s.system_prompt || !s.greeting) log.problems.push('prompt or greeting missing')
      if (!s.output?.voice) log.problems.push('voice missing')
      if (!Array.isArray(s.input?.keyterms)) log.problems.push('keyterms missing')
      send({ type: 'session.ready', session_id: 'sess_fake_1' })
      await pause(150)

      let replyN = 0
      let callN = 0
      for (const step of steps) {
        if (step.caller) {
          send({ type: 'input.speech.started' })
          send({ type: 'transcript.user.delta', text: step.caller.split(' ').slice(0, 4).join(' ') })
          await pause(60)
          send({ type: 'transcript.user', text: step.caller })
          await pause(120)
        } else if (step.expect) {
          const msg = await next(step.expect)
          if (step.contains && !JSON.stringify(msg).includes(step.contains)) log.problems.push(`${step.expect} did not mention ${step.contains}`)
        } else if (step.agent) {
          const replyId = `reply_${++replyN}`
          send({ type: 'reply.started', reply_id: replyId })
          send({ type: 'reply.audio', data: SILENCE })
          for (const word of step.agent.split(' ').slice(0, 6)) send({ type: 'transcript.agent.delta', delta: word, reply_id: replyId })
          send({ type: 'transcript.agent', text: step.agent, reply_id: replyId })
          const ids = []
          for (const tool of step.tools || []) {
            const id = `call_${++callN}`
            ids.push({ id, name: tool.name })
            send({ type: 'tool.call', call_id: id, name: tool.name, arguments: tool.arguments })
          }
          await pause(30)
          send({ type: 'reply.done', reply_id: replyId, status: 'completed' })
          if (step.ends) {
            // A goodbye already spoken: the page should hang up, not answer.
            await next('session.end', 10000).catch((e) => log.problems.push(e.message))
            return
          }
          for (const { id, name } of ids) {
            const result = await next('tool.result').catch((e) => {
              log.problems.push(`${name}: ${e.message}`)
              return null
            })
            if (result) {
              if (result.call_id !== id) log.problems.push(`tool.result for ${result.call_id}, expected ${id}`)
              log.toolResults.push({ name, result: JSON.parse(result.result) })
            }
          }
          await pause(80)
        }
      }
    })().catch((e) => log.problems.push(String(e.message || e)))
  })

  return { wss, log, close: () => new Promise((r) => wss.close(r)) }
}
