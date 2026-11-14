import { query } from '../db/pool.js';

// The privacy notice for leads: a draft for the company (and its adviser) to
// approve. "## " starts a heading, "- " a list item; {placeholders} are filled
// from Settings → Calling. No real company details live here.
export const PRIVACY_NOTICE_EN = `# How we use your details when we call you

## Who we are
{legal_name}, {address}.

## What we keep
- your name, phone number and the details you gave in your enquiry;
- notes from our calls with you;
- the time and length of each call;
- recordings of calls.

## Why
- to answer your enquiry;
- to follow up about the products and services you asked about;
- to check and improve the quality of our calls, and to train our team.

## Recordings
Calls with our team may be recorded. We keep recordings for {retention_months} months and then delete them, unless one is needed to settle a complaint or dispute.

## Who sees your details
Only the people at {company} who work with you, and managers who check call quality. We do not sell your details.

## Your choices
At any time you can ask us not to record your calls, or not to call you at all. Tell the person who calls you, or contact us below. You can also ask to see, correct or delete your details.

## Questions or complaints
{contact_name}, {legal_name}
{contact_lines}

Last updated: {date}`;

export const PRIVACY_NOTICE_HI = `# जब हम आपको कॉल करते हैं, तब आपकी जानकारी का उपयोग कैसे होता है

## हम कौन हैं
{legal_name}, {address}।

## हम क्या रखते हैं
- आपका नाम, फ़ोन नंबर और आपकी पूछताछ में दी गई जानकारी;
- आपसे हुई कॉल के नोट्स;
- हर कॉल का समय और अवधि;
- कॉल की रिकॉर्डिंग।

## क्यों
- आपकी पूछताछ का जवाब देने के लिए;
- जिन उत्पादों और सेवाओं के बारे में आपने पूछा, उनके बारे में आगे बात करने के लिए;
- हमारी कॉल की गुणवत्ता जाँचने और सुधारने, और अपनी टीम को प्रशिक्षण देने के लिए।

## रिकॉर्डिंग
हमारी टीम के साथ आपकी कॉल रिकॉर्ड की जा सकती है। हम रिकॉर्डिंग {retention_months} महीने तक रखते हैं और फिर हटा देते हैं, जब तक किसी शिकायत या विवाद को सुलझाने के लिए उसकी ज़रूरत न हो।

## आपकी जानकारी कौन देखता है
केवल {company} के वे लोग जो आपके साथ काम करते हैं, और कॉल की गुणवत्ता जाँचने वाले मैनेजर। हम आपकी जानकारी बेचते नहीं हैं।

## आपके विकल्प
आप कभी भी कह सकते हैं कि आपकी कॉल रिकॉर्ड न की जाए, या आपको कॉल ही न किया जाए। जो व्यक्ति आपको कॉल करे उसे बताएँ, या नीचे दिए संपर्क पर हमसे बात करें। आप अपनी जानकारी देखने, सुधारने या हटाने के लिए भी कह सकते हैं।

## सवाल या शिकायत
{contact_name}, {legal_name}
{contact_lines}

अंतिम अपडेट: {date}`;

export const DEFAULT_SETTINGS = {
  blackmarks: {
    // a member with this many missed deadlines in a month is flagged for review
    missedDeadlineLimit: 3,
    // point thresholds used to colour the monthly review
    warningPoints: 3,
    criticalPoints: 6,
    // notify the member when a black mark is recorded
    notifyMember: true,
    // notify their department manager too
    notifyManagers: true,
    // black marks older than this many months drop out of the rolling review
    rollingWindowMonths: 1,
  },
  workload: {
    // a member with no activity for this many days shows up as idle
    idleDays: 3,
    // % of weekly capacity above which a member is considered overloaded
    overloadedPercent: 100,
    // due within this many days counts as "due soon" on the dashboard
    dueSoonDays: 3,
  },
  taskTypes: [
    'task',
    'bug',
    'feature',
    'enhancement',
    'customer-query',
    'procurement',
    'content',
    'campaign',
    'advisory',
    'documentation',
    'compliance',
  ],
  organisation: {
    name: 'EkoSight',
    workingDays: [1, 2, 3, 4, 5, 6],
    // the clock leave days are counted in: "on leave on the 14th" means the
    // 14th here, whatever timezone the server happens to run in
    timezone: 'Asia/Kolkata',
  },
  deadlines: {
    // every task needs a date it is expected by; how far out one may be set
    maxHorizonDays: 730,
    // a task that repeats every day or every working day gets its deadline
    // filled in at this hour, so nobody types tomorrow's date every day
    recurringDueHour: 18,
  },
  reviews: {
    // an open review always flags the item and tells its owner. Turn this on to
    // also hold the item back until the review is resolved — off by default,
    // because a reviewer on leave should not be able to stall a quarter.
    blockOnOpenReview: false,
  },
  okr: {
    // the module's on/off switch — no separate feature-flag framework needed,
    // since this settings store already exists and is editable without a deploy
    enabled: true,
    health: {
      // percentage points behind the expected pace before a goal changes state
      atRiskBehindPoints: 10,
      offTrackBehindPoints: 25,
    },
    // the line at the top of the Goals page — what all of this is in aid of
    destination: {
      line: 'Every goal moves the company toward',
      pillars: ['validation', 'growth', 'adoption', 'scale'],
    },
    // the intelligence layer: what "not moving" and "not active" mean, in days,
    // and how often the system is allowed to nudge the person accountable
    attention: {
      // watch and remind, or stay silent
      enabled: true,
      // a key result nobody has touched for this long is going stale
      staleKeyResultDays: 7,
      // a whole goal with no check-in on any of its results for this long has stalled
      stalledObjectiveDays: 10,
      // a department with active goals but no check-in activity for this long is idle
      idleDepartmentDays: 10,
      // at most one reminder to the same person inside this many hours
      reminderHours: 24,
      // also copy the objective owner's manager on a reminder
      notifyManagers: false,
    },
  },
  crm: {
    // the module's on/off switch, like Goals
    enabled: true,
    // keep every deal moving, and keep every deal warm
    cadence: {
      // watch and remind, or stay silent
      enabled: true,
      // a lead that hasn't advanced a stage in this long needs a push
      stageStaleDays: 7,
      // a lead with no logged activity in this long has gone cold
      engagementDays: 7,
      // at most one reminder to the same person inside this many hours
      reminderHours: 24,
      // cadence varies by how far along a deal is: a brand new lead does not
      // need chasing as hard as one sitting in negotiation
      byStage: {
        new: 14,
        contacted: 10,
        qualified: 7,
        discovery: 7,
        'meeting-demo': 5,
        'scope-alignment': 5,
        proposal: 4,
        negotiation: 3,
      },
      // a paused or nurtured deal is checked on far less often
      nurtureDays: 45,
      // a meeting that has been and gone with nothing recorded
      meetingOutcomeHours: 24,
      // a delivery milestone past its date
      milestoneGraceDays: 2,
      // a close date approaching with must-haves still open
      closingSoonDays: 21,
    },
    // how the state-wise view sorts leads into who to follow up with
    followUp: {
      // an open deal spoken to inside this many days is active
      activeWithinDays: 30,
      // what a lead is worth, in rupees: below this is lower potential…
      lowPotentialBelow: 500000,
      // …and from this up is high
      highPotentialFrom: 2500000,
    },
    // a blocker nobody has replied to in this long is nudged
    blockerQuietDays: 3,
    // a handover nobody has confirmed after this long is raised with them again
    handoverConfirmDays: 2,
    // the weekly record of what moved (India time)
    weekly: {
      // the snapshot of the week just ended is written on this day, at this time
      snapshotDay: 1,
      snapshotTime: '08:30',
      // owners who have not sent their weekly review are reminded once
      reviewReminderDay: 5,
      reviewReminderTime: '15:00',
    },
    // reading people's own Gmail and Calendar for correspondence with known
    // contacts: off until an admin turns it on, and then only for those who opt in
    mailboxSync: {
      enabled: false,
      lookbackDays: 3,
    },
    // each person's pipeline digest: when it arrives, unless they choose otherwise
    reminders: {
      digestTime: '09:30',
      // null: the organization's working days
      digestDays: null,
      // an unchanged digest is not sent again for this many days
      repeatSameDays: 3,
      // a reminder pause can be at most this long
      maxPauseDays: 30,
    },
    // when something owed is late enough to take to the deal's escalation point
    escalation: {
      afterDays: 3,
    },
    // The sales CRM: intake, routing, assignment, follow-ups, automation and
    // integrations. Every value here is an initial default to confirm, not a
    // business policy TaskFlow has decided.
    sales: {
      // Taskflow holds B2B corporate and CSR / NGO leads; retailers, FPOs and
      // individuals belong in TeleCRM
      routing: {
        // organizations that existed before categories: kept in the pipeline
        // until an administrator confirms their category ('INCLUDE'), or kept
        // out of forecasts and totals until then ('EXCLUDE')
        legacyUnclassified: 'INCLUDE',
        // where retailer, FPO and individual leads are worked: here, with the
        // retail pipeline and the call queue ('TASKFLOW'); or, while TeleCRM
        // is still in use, its hand-off list ('TELECRM') or a review queue
        // first ('TRIAGE')
        excludedDestination: 'TASKFLOW',
      },
      // what a sales agent (role "member") sees: their own and shared records
      // ('OWN'), their department's ('TEAM'), or everything ('ALL'); managers
      // see their departments. Record-level access starts off (`enforced`), so
      // nobody loses sight of a record they could open before this release;
      // an administrator switches it on in Sales CRM → Settings.
      visibility: { agents: 'OWN', enforced: false },
      calendar: {
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        // the financial year starts in this month (4 = April)
        fyStartMonth: 4,
        // 1 = Monday … 7 = Sunday
        workingDays: [1, 2, 3, 4, 5, 6],
        workStart: '09:30',
        workEnd: '18:30',
        // public holidays come from the attendance holiday list
        useAttendanceHolidays: true,
        // false until an administrator has confirmed these defaults
        confirmed: false,
      },
      followUps: {
        // a new lead nobody has contacted in this many working hours is raised
        firstResponseHours: 4,
        // a follow-up this many hours overdue is raised to the owner's manager
        overdueEscalateHours: 24,
        // a lead with no two-way contact for this long is stale
        staleLeadDays: 7,
        // an open deal with no two-way contact for this long is stale, unless
        // its stage sets its own aging
        staleOpportunityDays: 14,
        // where follow-up tasks are filed when the owner has no department
        departmentId: null,
      },
      calling: {
        // the reasons offered when a lead is lost; a person may also type one
        lostReasons: [
          'No Need', 'Budget Issues', 'Product does not fit their requirement', 'Unable to Connect',
          'Call Not Connected Even After Trying Multiple Times', 'Wrong Number', 'Bought elsewhere', 'Unknown Reason',
        ],
        // the call queue puts new leads before retries, or after them
        newLeadsFirst: true,
      },
      assignment: {
        enabled: true,
        // who gets a lead no rule could place; blank: it stays unassigned and
        // the people who can assign are told
        fallbackUserId: null,
        // a new enquiry from an organization someone already owns goes to them
        keepAccountOwner: true,
      },
      // fields required on top of the minimum, by category
      required: {
        lead: { B2B_CORPORATE: [], CSR_NGO: [] },
      },
      automation: {
        // outbound messages from automation stay off until an admin has
        // tested the rules and switched this on
        liveSends: false,
        // automation that triggers automation stops at this depth
        maxDepth: 3,
      },
      calls: {
        // 'none' (dial on your own phone, log by hand), 'exotel', or 'webhook'
        // (any provider posting TaskFlow's signed call-event format)
        provider: 'none',
        // these two govern provider (Exotel) recordings only, as before
        recordings: true,
        recordingRetentionDays: 365,

        // ---- calls made on company phones and SIMs (no provider) ----
        // keep recordings of calls (attached, shared or picked up by the app).
        // Off until an administrator switches it on, which needs the opening
        // sentence and a published privacy notice.
        deviceRecordings: false,
        // calendar months from the call's start, in India time
        recordingRetentionMonths: 6,
        // the app deletes its own copy on the phone once TaskFlow has the file
        removePhoneCopy: true,
        callingHours: { start: '09:00', end: '21:00', workingDaysOnly: true },
        // call attempts per lead per day, retries included; a callback the lead
        // asked for is allowed past it
        dailyAttemptCap: 3,
        maxRecordingMb: 50,
        // the Android app sends lead and contact calls from the phone's call log
        deviceSync: true,
        // the name leads hear on calls ("…from {company}")
        companyName: '',
        openingSentence: {
          en: 'Hello, this is {first_name} from {company}, calling about your enquiry. This call may be recorded for quality and training.',
          hi: 'नमस्ते, मैं {company} से {first_name} बोल रहा/रही हूँ, आपकी पूछताछ के बारे में। यह कॉल गुणवत्ता और प्रशिक्षण के लिए रिकॉर्ड की जा सकती है।',
        },
        staffPolicy: {
          version: 1,
          en: 'This is a company phone. Calls with leads and customers on the company SIM are logged in TaskFlow and recorded for quality and training, and recordings are kept for 6 months. Please use your own phone for personal calls.',
          hi: 'यह कंपनी का फ़ोन है। कंपनी सिम से लीड और ग्राहकों के साथ होने वाली कॉल TaskFlow में दर्ज होती हैं और गुणवत्ता व प्रशिक्षण के लिए रिकॉर्ड की जाती हैं; रिकॉर्डिंग 6 महीने तक रखी जाती हैं। निजी कॉल के लिए कृपया अपने फ़ोन का उपयोग करें।',
        },
        // the public page for leads. The company's own details are typed in by
        // an administrator; nothing real is kept in the code.
        privacyNotice: {
          legalName: '',
          address: '',
          contactName: '',
          contactPhone: '',
          contactEmail: '',
          publishedAt: null,
          version: 1,
          en: PRIVACY_NOTICE_EN,
          hi: PRIVACY_NOTICE_HI,
          formLine: {
            en: 'By sending this, you agree that we may call you about your enquiry. Calls may be recorded.',
            hi: 'यह फ़ॉर्म भेजकर आप सहमत हैं कि हम आपकी पूछताछ के बारे में आपको कॉल कर सकते हैं। कॉल रिकॉर्ड की जा सकती हैं।',
          },
        },
        // the copy leads see, made when the notice is published (edits above are a draft until then)
        privacyNoticePublished: null,
        // the Android app offered to staff (uploaded by an administrator)
        appRelease: { version: null, notes: null, file: null, uploadedAt: null },
      },
      whatsapp: {
        // the Meta WhatsApp Business Platform (Cloud API)
        enabled: false,
        messageRetentionDays: null,
      },
      // the default quotation terms and validity
      quotes: {
        validityDays: 30,
        terms: 'Prices are exclusive of taxes unless stated. Valid until the date shown.',
        brand: 'Soil Doctor',
        // printed on quotations and proposals; blank lines are left out. Tax
        // registration numbers are for an administrator to fill in.
        legalName: '',
        address: '',
        email: '',
        phone: '',
        website: 'soildoctor.in',
        taxId: '',
        taxIdLabel: 'GSTIN',
      },
    },
  },
  // Email marketing. Nothing is sent until a provider is set up on the server
  // and the sender, address and footer below are filled in.
  marketing: {
    // the module's on/off switch, like Goals and the pipeline
    enabled: true,
    // the footer every email carries: who it is from and where they are
    company: 'EkoSight',
    postalAddress: '',
    // the logo in every email links here; the line under the footer mark
    website: 'https://soildoctor.in',
    tagline: 'Turning soil data into farmer prosperity',
    defaultFromName: 'EkoSight Soil Doctor',
    defaultFromEmail: '',
    // a mailbox people read. With plus addressing (Google Workspace supports
    // it), replies are matched to the email they answer.
    defaultReplyTo: '',
    replyPlusAddressing: false,
    // the only addresses a campaign may be sent from
    senders: [],
    // the domain checked for SPF, DKIM and DMARC
    sendingDomain: '',
    dkimSelectors: [],
    // a second person approves before anything is sent
    approvals: { required: true, allowSelfApproval: false },
    // at most this many marketing emails to one person (0 means no limit)
    limits: { perContactPerDay: 1, perContactPerWeek: 3, ratePerMinute: 120 },
    // a reply, a click or a conversion becomes a task due this many days later
    followUps: { dueDays: 2, departmentId: null },
    // people at organizations in the pipeline join audiences by their rules.
    // Off until an admin has checked the consent basis.
    crmSync: { enabled: false },
    // reading replies from a Google Workspace mailbox
    replies: { enabled: false, mailbox: '', lookbackDays: 3 },
    // soft bounces in a row before an address is suppressed
    softBounceLimit: 3,
    // send-time optimization: the hour used for someone with no history (India time)
    sto: { defaultHour: 10 },
    timezone: 'Asia/Kolkata',
  },
  // The daily standup in a company Chat space. Separate from the individual
  // and department summaries, which carry on unchanged.
  standup: {
    enabled: false,
    // Google's name for the space, e.g. "spaces/AAAA…" — chosen by an admin
    spaceName: null,
    // India time, on the company's working days
    reminderTime: '09:30',
    deadline: '09:40',
    escalationTime: '11:00',
    // if the reminder never went out, the review still runs by this time
    reviewCutoff: '12:00',
    minItems: 3,
    maxItems: 5,
    // TaskFlow users told privately about what is still unresolved
    escalateTo: [],
    // Chat accounts on these domains are the company's own; any other account
    // must be mapped and verified by an admin before it counts
    companyDomains: ['ekosight.com'],
    // optional: read standups posted in the space without a mention, as this
    // member (needs the chat.messages.readonly grant)
    readSpaceAs: null,
    // the last privacy check of the space
    spaceCheck: null,
  },

  // The organisation's name, colours and logos (Settings → Branding). Colours
  // are checked by shared/brandTheme.js; assets null = the bundled Soil Doctor ones.
  branding: {
    version: 1,
    appName: 'TaskFlow',
    byline: 'by ekosight',
    primary: '#073F2A',
    accent: '#8B5E3B',
    assets: { mark: null, markDark: null, wordmark: null, wordmarkDark: null },
  },

  // Sales CRM follow-ups in Google Chat: reminders and the daily summary.
  // Both off until an administrator has previewed, tested and switched them on.
  crmFollowUps: {
    // follow-up reminders may also go to a person's Chat direct message
    chatReminders: false,
    digest: {
      enabled: false,
      // while on, nothing goes to employees: who would get what is recorded, and
      // an administrator can send any summary to themselves
      testMode: true,
      // India time
      time: '09:00',
      // Monday 1 … Sunday 7; empty means the organization's working days
      days: [],
      // company, department and personal holidays from the attendance calendar
      skipHolidays: true,
      // a summary not sent by then (the server was down) is skipped, not sent late
      lastSendTime: '13:00',
    },
  },

  // task reminders: one planned engine for every task (CRM follow-ups keep their own)
  reminders: {
    // TEST until an administrator has looked at the delivery log and switched it
    // to LIVE: in TEST, messages for the administrator who switched it on are
    // sent, labelled TEST, and everyone else's are recorded as "would send".
    // LIVE also retires the old due-soon notice. OFF plans nothing.
    mode: 'TEST',
    testRecipientId: null,
    // D5: one reminder this many hours before the deadline, if still open
    beforeDueHours: 2,
    // a notice to the owner at the deadline
    atDue: true,
    // after the grace period, a notice to the fallback person (reporting manager,
    // then the department's managers)
    managerNotice: true,
    // D6: nothing is sent between these times (India time); it waits for the
    // next morning summary
    quietStart: '20:00',
    quietEnd: '08:30',
    // a morning summary the server could not send on time is still sent until
    // this time the same day, marked late
    catchUpUntil: '18:00',
    // the weekly backlog review, on the first working day of the week
    weeklyBacklog: true,
    // the coverage check runs after the morning messages have had time to go
    coverageTime: '11:00',
  },
  googleChat: {
    // off until an admin has sent a test message and switched it on
    enabled: false,
    // India time, on working days
    morningSummaryTime: '08:45',
    teamSummaryTime: '09:15',
    // which TaskFlow notifications are also sent as a Chat message
    alertTypes: [
      'assigned', 'due_soon', 'deadline_missed', 'overdue_escalation', 'task_reopened',
      'tagged', 'comment', 'follower', 'blackmark', 'availability',
      'leave_request', 'leave_decision', 'attendance_correction', 'attendance_review',
      'attendance_reminder', 'attendance_checkout_reminder',
    ],
  },
  // My workspace (docs/MY_WORKSPACE.md)
  workspace: {
    // D1: who gets My workspace as their home. PILOT: the departments listed
    // (none until an administrator picks them); EVERYONE; OFF: nobody (the
    // page still opens at /workspace). A person's own choice wins either way.
    rollout: { mode: 'PILOT', departmentIds: [] },
    // the reminder rules for applications, meetings and deals. TEST until an
    // administrator has looked at the delivery log: only the test recipient
    // receives anything, everyone else's are recorded as "would send".
    // A person's own "remind me" always reaches them (it reaches nobody else).
    reminderMode: 'TEST',
    testRecipientId: null,
  },
};

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, override) => {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
};

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return deepMerge(DEFAULT_SETTINGS, stored);
}

export async function getSetting(key) {
  const all = await getSettings();
  return all[key];
}

export async function updateSetting(key, value, userId) {
  if (!(key in DEFAULT_SETTINGS)) {
    throw new Error(`Unknown settings key: ${key}`);
  }
  const merged = isPlainObject(DEFAULT_SETTINGS[key]) ? deepMerge(DEFAULT_SETTINGS[key], value) : value;
  const { rows } = await query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING key, value`,
    [key, JSON.stringify(merged), userId || null],
  );
  return rows[0];
}
