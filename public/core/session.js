// Builds the session.update the browser sends to the AssemblyAI Voice Agent
// API: prompt, greeting, tools, transcription hints and voice.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration

import { PAY_BASES, WORK_MODES, formatDate } from './facts.js'
import { SCAM_REASONS } from './scam.js'
import { CANDIDATE_TOPICS, END_REASONS } from './tools.js'

export const VOICE = 'alba'

// Turns end as soon as the caller is clearly done. While the caller spells an
// email address, call.js switches to EMAIL_TRANSCRIPTION_MODE so the agent
// waits for the whole address.
export const TRANSCRIPTION_MODE = 'min_latency'
export const EMAIL_TRANSCRIPTION_MODE = 'balanced'
// min_latency also drops the barge-in delay to 0 ms, so any small sound could
// cut the agent off. Keep the balanced default of 500 ms.
export const INTERRUPTION_DELAY_MS = 500

export function buildGreeting(candidate) {
  return `Hi, you've reached ${candidate.name}'s agent. I'm an AI assistant who handles ${candidate.firstName}'s first conversations about new roles, and I take notes for her. Who am I speaking with?`
}

export function buildSystemPrompt(candidate, applications, now = new Date()) {
  const first = candidate.firstName
  const today = now.toLocaleDateString('en-US', {
    timeZone: candidate.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const applied = applications
    .map((a) => `${a.company} (${a.role}, applied ${formatDate(a.appliedOn)})`)
    .join('; ')

  return `You are the phone agent for ${candidate.name}, a ${candidate.headline} in ${candidate.location} who is looking for a new job. You answer the number on her résumé and handle first conversations with recruiters and hiring teams. You are an AI assistant, you say so if asked, and you work for ${first}, not for the caller.

Today is ${today}. ${first}'s time zone is ${candidate.timezoneLabel} time.
${first} has applied to: ${applied}.

How you sound: warm, brief and professional. One or two short spoken sentences per turn. One question at a time. No lists, no emojis, no exclamation marks. Never read out tool names or field names.

On every call, in this order:
1. Learn who is calling and from which company, then call find_application. If ${first} applied, say when. If not, that is fine: it is a new opportunity.
2. Ask the questions ${first} would find awkward to ask, one at a time: the pay range, whether the role is remote, hybrid or on-site and where, how many interview rounds there are, and when ${first} will hear back either way. Each time the caller answers, call record_details with only what you just heard. Its result tells you what is still missing, whether it fits ${first}'s rules, and the exact sentence to read back. Ask only for what is missing.
3. If they will not share a pay range, ask once more, politely: ${first} only takes calls with a ballpark range. If they still decline, call record_details with pay_not_shared and move on.
4. When nothing is missing, read back the sentence the tool gave you, word for word, and ask if you got it right. If yes, call confirm_details with scope details. If not, record the correction and read back again.
5. If it fits, call get_open_slots, offer the first two times, and call book_slot with the one they choose. If it does not fit, say so kindly and specifically, and say ${first} would be glad to talk if that changes. Never offer times the tools say do not fit.
6. Get the caller's name if you do not have it, and the best email for a short written confirmation. Call record_contact, read the email back the way the tool spells it, and call confirm_details with scope contact.
7. Tell them a written summary is on its way, and that if they decide not to move forward, a short reply is enough, since ${first} would rather know than wait. Say goodbye and call end_call.

When the caller asks about ${first}, call get_candidate_answer and answer only with what it returns, ideally in her words, like: in ${first}'s words, ... If it returns nothing, say you will ask her and put the answer in the written confirmation. Never invent anything about ${first}: no skills, numbers, dates, employers or opinions she did not give. If they ask about her salary expectations, use get_candidate_answer with the topic salary_expectation.

Scams: if the caller asks ${first} to pay anything or buy equipment, asks for bank details, a Social Security number, ID or date of birth before a written offer, mentions depositing a check or gift cards, wants the interview on a chat app, or cannot name the company or the role, call flag_scam with their words as evidence. Then say calmly that ${first} does not do that, say goodbye, and call end_call with reason scam. Do not argue.

Hard limits: do not accept, decline or negotiate an offer for ${first}. Do not agree to anything except a first call on her calendar. Do not share her phone number, address or personal details. Do not pretend to be human. If the caller wants to speak with ${first} directly, offer a booked time instead. If the call is not about a job, take a short message and end the call.

Examples:
Caller: Hi, this is Jen from Northwind Analytics, about the senior data analyst role.
You: (call find_application) Thanks, Jen. ${first} applied for that role on ${formatDate(applications[0]?.appliedOn || '2026-09-03')}. Before I get you on her calendar, what's the pay range?
Caller: It's one fifteen to one thirty-five base.
You: (call record_details with pay_min 115000, pay_max 135000, pay_unit year, pay_basis base) Thank you. Is it remote, hybrid, or on-site?
Caller: What's she looking for, salary-wise?
You: (call get_candidate_answer with topic salary_expectation) In ${first}'s words, for full-time roles her floor is 120 thousand base.
Caller: We'll need your bank details to set up payroll before the interview.
You: (call flag_scam) ${first} doesn't share bank details before a written offer. If the role is real, please send the details in writing. Goodbye. (call end_call)`
}

export function buildTools() {
  return [
    {
      type: 'function',
      name: 'find_application',
      description:
        'Call this as soon as the caller says which company they are calling from or recruiting for. It tells you whether the candidate applied there and when. Call it even if you are unsure of the exact name.',
      parameters: {
        type: 'object',
        properties: {
          company: {
            type: 'string',
            description: 'The company the caller works for or is recruiting for, as they said it.',
            examples: ['Northwind Analytics', 'TalentBridge Staffing'],
          },
          role: { type: 'string', description: 'The job title they mention, if any.', examples: ['Senior Data Analyst'] },
          caller_name: { type: 'string', description: "The caller's name, if they gave it.", examples: ['Jen Park'] },
        },
        required: ['company'],
      },
    },
    {
      type: 'function',
      name: 'get_candidate_answer',
      description:
        'Call this whenever the caller asks anything about the candidate: background, skills, why she is looking, salary expectations, notice period, work authorization or availability. Answer only with what it returns. Do not answer questions about the candidate from memory.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', enum: CANDIDATE_TOPICS, description: 'What the caller is asking about.' },
          question: { type: 'string', description: "The caller's question in their words, for anything the topics do not cover." },
        },
        required: ['topic'],
      },
    },
    {
      type: 'function',
      name: 'record_details',
      description:
        'Call this every time the caller shares the pay range, the work arrangement, the number of interview rounds, or when the candidate will hear back. Send only the fields you just heard. The result says what is still missing, whether it fits, and the sentence to read back.',
      parameters: {
        type: 'object',
        properties: {
          pay_min: { type: 'number', description: 'Bottom of the pay range as a plain number. 115000 for 115 thousand a year, 40 for 40 dollars an hour.', examples: [115000, 40] },
          pay_max: { type: 'number', description: 'Top of the pay range as a plain number.', examples: [135000, 45] },
          pay_unit: { type: 'string', enum: ['year', 'hour'], description: 'Annual salary or hourly rate.' },
          pay_basis: { type: 'string', enum: PAY_BASES, description: 'Base salary, base plus bonus, on-target earnings, W-2 hourly, 1099 hourly, corp-to-corp, or commission only.' },
          pay_not_shared: { type: 'boolean', description: 'True if the caller declined to share any pay range after being asked twice.' },
          work_mode: { type: 'string', enum: WORK_MODES, description: 'remote, hybrid or onsite.' },
          office_location: { type: 'string', description: 'City of the office for hybrid or on-site roles.', examples: ['Austin', 'Dallas'] },
          office_days_per_week: { type: 'integer', minimum: 0, maximum: 5, description: 'Days per week in the office for hybrid roles.' },
          interview_rounds: { type: 'integer', minimum: 1, maximum: 15, description: 'How many interview rounds in total.' },
          decision_date: { type: 'string', format: 'date', description: 'The date the candidate will hear back either way, as YYYY-MM-DD, worked out from today if they said something like next Friday.', examples: ['2026-10-20'] },
          decision_when: { type: 'string', description: 'When the candidate will hear back, in the caller\'s words.', examples: ['by the end of next week'] },
          role_status: { type: 'string', enum: ['new', 'backfill', 'unknown'], description: 'Whether the role is newly created or replaces someone, if they say.' },
          note: { type: 'string', description: 'Any other useful detail the caller shares about the role or process.' },
        },
      },
    },
    {
      type: 'function',
      name: 'record_contact',
      description:
        "Call this when the caller gives their name, title, email or callback number. Always get an email for the written confirmation before the call ends.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The caller's full name.", examples: ['Jen Park'] },
          title: { type: 'string', description: "The caller's job title.", examples: ['Technical Recruiter'] },
          email: { type: 'string', format: 'email', description: 'Their email address, exactly as spelled.', examples: ['jen.park@northwind-analytics.com'] },
          phone: { type: 'string', description: 'Callback number with country code.', examples: ['+15125550142'], pattern: '\\+?[0-9 ()-]{7,20}' },
        },
      },
    },
    {
      type: 'function',
      name: 'confirm_details',
      description:
        'Call this right after you read facts back and the caller answers. Use scope details after reading back the role facts, and scope contact after reading back their email.',
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'True if the caller said the read-back was right.' },
          scope: { type: 'string', enum: ['details', 'contact'], description: 'Which read-back this answers.' },
        },
        required: ['confirmed', 'scope'],
      },
    },
    {
      type: 'function',
      name: 'get_open_slots',
      description: "Call this after the details are confirmed and they fit, to get the candidate's open times for a first call.",
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'book_slot',
      description: 'Call this when the caller picks one of the open times.',
      parameters: {
        type: 'object',
        properties: {
          slot_id: { type: 'string', enum: ['slot_1', 'slot_2', 'slot_3'], description: 'The id of the time they chose.' },
        },
        required: ['slot_id'],
      },
    },
    {
      type: 'function',
      name: 'flag_scam',
      description:
        'Call this immediately if the caller asks for money, equipment purchases, bank details, a Social Security number, ID or date of birth, mentions check deposits or gift cards, wants a chat-app interview, or cannot name the company or role.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: Object.keys(SCAM_REASONS), description: 'The red flag.' },
          evidence: { type: 'string', description: "The caller's words that raised the flag." },
        },
        required: ['reason', 'evidence'],
      },
    },
    {
      type: 'function',
      name: 'end_call',
      description: 'Call this after you have said goodbye, to hang up.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', enum: END_REASONS, description: 'Why the call ended.' } },
        required: ['reason'],
      },
    },
  ]
}

// Rare words only: names, companies, jargon. Common words and phrases would
// dilute the boost (https://www.assemblyai.com/docs/voice-agents/voice-agent-api/transcription-prompt).
export function buildKeyterms(candidate, applications) {
  const terms = new Set([
    candidate.name,
    candidate.firstName,
    ...applications.map((a) => a.company),
    'W-2',
    '1099',
    'corp-to-corp',
    'C2C',
    'OTE',
    'dbt',
    'Looker',
    'Tableau',
  ])
  return [...terms].slice(0, 100)
}

export const TRANSCRIPTION_PROMPT =
  "A recruiter or hiring contact is calling a job candidate's AI agent. Callers say company names, job titles, salary ranges such as one fifteen to one thirty-five or 120K base plus bonus, hourly contract rates, W-2, 1099 or corp-to-corp, whether a role is remote, hybrid or on-site, office cities, numbers of interview rounds, dates, email addresses spelled letter by letter, and phone numbers."

export function buildSession(candidate, applications, now = new Date()) {
  return {
    system_prompt: buildSystemPrompt(candidate, applications, now),
    greeting: buildGreeting(candidate),
    tools: buildTools(),
    input: {
      keyterms: buildKeyterms(candidate, applications),
      transcription_prompt: TRANSCRIPTION_PROMPT,
      transcription_mode: TRANSCRIPTION_MODE,
      turn_detection: { interruption_delay: INTERRUPTION_DELAY_MS },
    },
    output: { voice: VOICE },
  }
}
