// Job-scam red flags, checked in code against what the caller actually said.
// The model can also raise a flag, but the verdict comes from these rules
// plus that flag, never from the model's opinion alone.

export const SCAM_REASONS = {
  asks_payment: 'asked Maya to pay a fee or buy equipment',
  asks_bank_or_id: 'asked for bank details, a Social Security number, ID or date of birth before a written offer',
  check_or_gift_card: 'mentioned depositing a check, gift cards or crypto',
  chat_only_interview: 'wanted to move the interview to a chat app',
  no_company_details: 'could not name the company or the role',
  pressure_tactics: 'pushed for an answer right now',
  too_good_to_be_true: 'offered a job without an interview',
  other: 'other red flag',
}

// Severity: a "hard" flag alone makes it a scam; "soft" flags make it caution.
const RULES = [
  {
    code: 'asks_payment',
    hard: true,
    test: /\b(pay|paying|payment|fee|fees|deposit|purchase|buy|buying|cost)\b[^.?!]{0,60}\b(equipment|kit|starter|training|laptop|software|certification|onboarding|registration|background check|processing)\b|\b(equipment|starter|onboarding|training|registration|processing)\s+(fee|kit|cost)\b/i,
  },
  {
    code: 'asks_bank_or_id',
    hard: true,
    test: /\b(bank (account|details|info(rmation)?)|routing number|account number|social security|ssn|driver'?s licen[cs]e|passport (number|copy)|date of birth|credit card|debit card)\b/i,
  },
  {
    code: 'check_or_gift_card',
    hard: true,
    test: /\b(cheque|check)\b[^.?!]{0,40}\b(deposit|cash|mobile)\b|\bgift ?cards?\b|\b(bitcoin|crypto|usdt|zelle|cash ?app)\b/i,
  },
  {
    code: 'chat_only_interview',
    hard: true,
    test: /\b(telegram|whatsapp|signal|google chat|teams chat)\b[^.?!]{0,50}\b(interview|chat|message|text)\b|\binterview (over|via|on|by) (text|chat)\b/i,
  },
  {
    code: 'pressure_tactics',
    hard: false,
    test: /\b(today only|right now|immediately|within the hour|limited (spots|slots)|before (the )?end of (the )?day)\b/i,
  },
  {
    code: 'too_good_to_be_true',
    hard: false,
    test: /\b(no interview (needed|required)|hired on the spot|you('ve| have) been selected|guaranteed (job|income|position))\b/i,
  },
]

// callerLines: [{ text }] said by the caller. modelFlags: [{ reason, evidence }]
export function scamVerdict(callerLines = [], modelFlags = []) {
  const found = new Map()
  for (const line of callerLines) {
    const text = line.text || ''
    for (const rule of RULES) {
      if (!found.has(rule.code) && rule.test.test(text)) {
        found.set(rule.code, { code: rule.code, hard: rule.hard, evidence: text, by: 'rule' })
      }
    }
  }
  for (const flag of modelFlags) {
    const code = SCAM_REASONS[flag.reason] ? flag.reason : 'other'
    if (!found.has(code)) {
      const rule = RULES.find((r) => r.code === code)
      found.set(code, {
        code,
        // A model-only flag counts, but as a soft one unless a rule agrees.
        hard: false,
        evidence: flag.evidence || '',
        by: 'agent',
      })
      if (rule?.hard && rule.test.test(flag.evidence || '')) found.get(code).hard = true
    }
  }
  const reasons = [...found.values()]
  const hard = reasons.filter((r) => r.hard).length
  const level = hard > 0 || reasons.length >= 2 ? 'scam' : reasons.length === 1 ? 'caution' : 'clear'
  return {
    level,
    reasons: reasons.map((r) => ({ ...r, label: SCAM_REASONS[r.code] || r.code })),
  }
}
