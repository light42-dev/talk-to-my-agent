// The demo candidate. Everything the agent is allowed to say about the
// candidate lives in this file. Maya Chen and every company below are
// fictional; swap in your own profile and applications to use it for real.

export const CANDIDATE = {
  name: 'Maya Chen',
  firstName: 'Maya',
  headline: 'Senior Data Analyst',
  location: 'Austin, Texas',
  timezone: 'America/Chicago',
  timezoneLabel: 'Central',
  // The number printed on her résumé. It rings this agent, not her phone.
  agentPhoneDisplay: '+1 (512) 555-0147',
  email: 'maya.chen.jobs@example.com',

  // Rules the code enforces. The model is told the outcome, never asked to
  // judge fit itself.
  rules: {
    baseFloorAnnual: 120000,
    hourlyFloor: 65,
    shareFloorWithRecruiters: true,
    workModes: ['remote', 'hybrid'],
    maxOnsiteDaysPerWeek: 2,
    commutableCities: ['austin', 'round rock', 'cedar park', 'pflugerville'],
    sponsorshipNeeded: false,
    dealbreakers: [
      'commission-only pay',
      'relocating',
      'fully on-site roles',
      'unpaid take-home work over four hours',
    ],
    callLengthMinutes: 30,
  },

  // Maya's own words, recorded on her setup call. The agent may describe
  // Maya only with these, and anything else becomes a question for her.
  inHerWords: {
    summary:
      "I'm a senior data analyst with six years in marketplace and fintech analytics. Most recently I rebuilt our revenue forecasting and cut the monthly close report from four days to one.",
    why_looking:
      'My team was restructured after a merger, and I want to be somewhere analytics actually drives decisions.',
    skills:
      'SQL and Python every day, dbt for modeling, Looker and Tableau for reporting, and a lot of experiment design.',
    leadership:
      'I mentor two junior analysts, and I led the move of about forty dashboards from Tableau to Looker.',
    looking_for: 'A team that ships decisions, not just dashboards. Hybrid in Austin or remote.',
    work_authorization: "I'm authorized to work in the US and don't need sponsorship.",
    notice_period: "I'd need to give two weeks' notice.",
    salary_expectation:
      "For full-time roles my floor is 120 thousand base. For contracts it's 65 an hour on W-2.",
    availability_to_interview:
      "Weekdays at lunch or after four thirty Central work best, since I'm still employed.",
  },
  recordedOn: '2026-09-20',

  // Times Maya offers for a first call, in her own time zone.
  callWindows: [
    { hour: 12, minute: 0 },
    { hour: 16, minute: 45 },
  ],
}

export const APPLICATIONS = [
  {
    id: 'northwind',
    company: 'Northwind Analytics',
    aliases: ['northwind'],
    role: 'Senior Data Analyst',
    appliedOn: '2026-09-03',
    postedRange: '$115,000 to $135,000',
    location: 'Austin, TX (hybrid)',
  },
  {
    id: 'brightline',
    company: 'Brightline Health',
    aliases: ['brightline', 'bright line'],
    role: 'Analytics Engineer',
    appliedOn: '2026-09-10',
    postedRange: null,
    location: 'Remote (US)',
  },
  {
    id: 'keystone',
    company: 'Keystone Freight',
    aliases: ['keystone'],
    role: 'Senior BI Analyst',
    appliedOn: '2026-09-12',
    postedRange: '$105,000 to $125,000',
    location: 'Dallas, TX (hybrid)',
  },
  {
    id: 'juniper',
    company: 'Juniper Pay',
    aliases: ['juniper'],
    role: 'Product Data Analyst',
    appliedOn: '2026-09-15',
    postedRange: null,
    location: 'Remote (US)',
  },
  {
    id: 'atlas',
    company: 'Atlas Robotics',
    aliases: ['atlas'],
    role: 'Senior Data Analyst, Operations',
    appliedOn: '2026-09-19',
    postedRange: '$125,000 to $145,000',
    location: 'Austin, TX (on-site)',
  },
]
