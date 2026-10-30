import { useMemo, useState } from 'react';

/**
 * The sales CRM guide, inside the app. Every label here is the one on screen;
 * docs/CRM_GUIDE.md carries the same text for reading outside TaskFlow.
 */
const TOPICS = [
  {
    id: 'start', who: 'Everyone', title: 'What goes where: Taskflow or TeleCRM',
    body: [
      'Taskflow’s sales CRM works B2B corporate leads and CSR / NGO leads. Retailers, FPOs (farmer producer organizations) and individual farmers or consumers are handled in TeleCRM.',
      'Every lead has a category. Choose it first when you add a lead. If you pick Retailer, FPO or Individual, TaskFlow keeps the lead and puts it in the TeleCRM queue; it never enters the pipeline, anyone’s lead pool or the sales totals.',
      'An FPO stays an FPO even if it is a registered company. A person who works at a company is a business contact (B2B), not an “individual”.',
      'A lead whose category is not known (a web form without it, an unknown caller) waits in “Needs classification” until someone with routing permission classifies it. Nothing is lost or deleted.',
    ],
  },
  {
    id: 'agent', who: 'Sales agent', title: 'Your day, step by step',
    body: [
      'Open Sales CRM → My Day. It lists Missed (overdue past the escalation time; your manager has been told), Overdue, Today, Coming up and Snoozed follow-ups, plus new leads still waiting for a first contact.',
      'To call: tap Call. On a phone this opens your dialler; it does not record anything by itself. Afterwards tap Log call, choose how it went, write what was said, and schedule the next step in the same box.',
      'To finish a follow-up: Done → outcome → notes → next step. If there is genuinely no next step, say why (for example “waiting for their board on the 20th”).',
      'Reschedule moves it with a reason (kept on its history). Snooze hides it until a time you choose. Hand over gives it to someone else with a reason (needs assign permission).',
      'New lead: Leads → New lead. Choose who it is, add the organization and a phone or email. TaskFlow warns you about possible duplicates before you save; it never merges on its own.',
      'When a lead is real and qualified: open it → Convert to deal. The organization, contact and deal are created (or linked to the existing organization), and the lead keeps its source, history and follow-ups.',
      'On a deal, the Sales section holds quotations, payments, delivery and renewal. A deal always needs a next action: what, who, by when.',
    ],
  },
  {
    id: 'manager', who: 'Manager', title: 'Running the team',
    body: [
      'My Day → Team shows everyone’s follow-ups; “Someone’s day” shows one person’s.',
      'Leads → Unassigned, Overdue and Stale are the queues to watch. Overdue means a scheduled follow-up’s time has passed. Stale means nobody has had a two-way conversation with the lead for the stale period, whatever is scheduled.',
      'Reassign one lead from its page (Owner → Reassign) or many from the list (select → Assign). Every change records who, when, from whom and why.',
      'Approvals lists quotations and proposals waiting for you. You cannot approve a request you made yourself unless the rule allows it. If someone edits an approved quotation, it needs approval again.',
      'Handovers: when a deal is won, the owner starts delivery from the deal’s Sales section. Review the handover there and accept or return it with a note.',
      'Reports: every number has a “?” that says exactly what it counts, and you can tap a number to see the records behind it.',
    ],
  },
  {
    id: 'admin', who: 'Administrator', title: 'Setting it up',
    body: [
      'Sales CRM → Settings → Setup checklist walks through everything. Each line opens its section; nothing changes until you save there.',
      'Visibility, routing & calendar: record-level access starts off, so after the upgrade everyone with CRM access still sees every record, as before. When the team is ready, choose what sales agents see (their own and shared records is recommended; or their department, or everything), switch record-level access on and save. Managers then see their own and granted departments. Confirm the time zone, currency, financial year and working hours too — they start as proposed defaults.',
      'Existing records to classify: organizations from before categories are listed with a suggestion and the reason for it. Confirm in bulk or choose a category. They are never reclassified or deleted automatically.',
      'Pipelines & stages: rename, reorder, set probabilities, required fields, allowed next stages, ageing and approval gates. Renaming keeps the stage and its history. Retiring a stage that holds deals asks where they go and records the move on each deal.',
      'Assignment: rules run in order (take turns, fewest open leads, by region or speciality, a fixed person, the organization’s owner). Set a fallback owner and capacity per person; people on leave are skipped. Use “Who would get it?” to check before switching a rule on.',
      'Catalogue, approvals & rates: products and services with prices and tax, approval thresholds by discount or value with named approvers, and currency rates (by finance).',
      'Automation: rules start off and in test mode. Turn a rule on, check its runs say “simulated” with what it would have done, then take it out of test mode. WhatsApp messages from automation also need “live sends” on.',
    ],
  },
  {
    id: 'corporate', who: 'Worked example', title: 'A corporate sale from enquiry to cash',
    body: [
      '1. Coromandel Agro fills the website form, choosing “A company or institution”. A B2B lead is created with its source (Website) and assigned by the rules; the owner gets a notification.',
      '2. The owner calls from My Day, logs “Connected — wants pricing for 400 dealers”, and schedules a demo.',
      '3. After the demo they convert the lead. The organization, Priya (decision maker) and the deal “Dealer soil programme” are created; the original source is kept.',
      '4. In the deal’s Sales section they create a quotation from the catalogue with a 12% discount. The approval rule needs a manager; Kiran approves.',
      '5. They download the PDF, email it, and press Mark as sent — it becomes the deal’s proposal. The customer’s purchase order arrives: Record their answer → Accepted, by purchase order.',
      '6. They move the deal to Won with the PO number. They press Start delivery: one engagement with kickoff tasks is created (pressing again creates nothing new). A manager reviews the handover.',
      '7. They add due dates (advance and on delivery) and record the advance with its bank reference. The deal shows scheduled, received, balance and overdue separately. Reports count the booking and the receipt as different numbers.',
    ],
  },
  {
    id: 'csr', who: 'Worked example', title: 'A CSR / NGO opportunity',
    body: [
      '1. Bharat Agro Foundation is added as CSR / NGO (organization type: CSR foundation). Its deals go to the CSR / NGO pipeline.',
      '2. On the deal, the CSR details hold thematic focus, project, geography, beneficiaries, funding requested and the proposal deadline (reminders come a week before).',
      '3. Link the implementing partner (Gram Vikas Trust) under Organizations on this deal — the same organization is never created twice; it can be a buyer elsewhere.',
      '4. Create a proposal: scope, objectives, outcomes, reporting and budget lines; it has its own PR- number and PDF.',
      '5. When the funder signs, record committed funding and agreement status, and move to Won / Committed with the MoU reference. A commitment is not cash: tranches and receipts go under Payments.',
      '6. Start delivery with reporting dates: each becomes a task. Next year, Open the next funding cycle creates a new linked deal; the won one stays as it was.',
      '7. A deal that does not go ahead is marked Lost with a reason; the foundation’s other deals are unaffected.',
    ],
  },
  {
    id: 'repeat', who: 'Worked example', title: 'A returning customer',
    body: [
      'When someone from an organization you already work with enquires (same company email domain), the lead is linked to that organization and goes to its owner.',
      'Converting it adds a new deal to the same organization, marked as a repeat sale. The earlier won deal, its value and history are untouched.',
      'For a contract that renews, open the won deal → Open a renewal. One renewal per deal; asking again returns the same one.',
    ],
  },
  {
    id: 'routed', who: 'Worked example', title: 'A retailer routed to TeleCRM',
    body: [
      'Krishna Agro Store calls in. The agent adds a lead and chooses Retailer. TaskFlow says it is handled in TeleCRM and saves it to the TeleCRM queue — not the pipeline.',
      'Someone with routing permission opens Leads → TeleCRM queue, presses Export (an Excel file), uploads it to TeleCRM, then confirms each lead (optionally with TeleCRM’s reference). Only that confirmation marks a lead as handed over.',
      'If it turns out to be a distributor that should be a B2B customer, classify it as B2B corporate: it enters Taskflow and is assigned.',
    ],
  },
  {
    id: 'imports', who: 'Everyone with import permission', title: 'Importing from Excel or CSV',
    body: [
      'Sales CRM → Imports → download the template. Keep the header row. Format phone and ID columns as Text so leading zeros stay.',
      'Upload, check the column matches, choose what to do with records that already exist, and press Check the rows. Every row gets a status with its reason: valid, problem, already there, or for TeleCRM.',
      'Download the corrections file, fix the rows with problems, and upload just those again.',
      'Import runs in the background. Undo archives the records it created that nobody has worked on since; anything worked on is kept and listed with why.',
    ],
  },
  {
    id: 'integrations', who: 'Administrator', title: 'Calls, WhatsApp and the API — and what to do when they fail',
    body: [
      'Credentials are set as environment variables on the server and are never typed into or shown by TaskFlow. Settings → Calls, WhatsApp & TeleCRM shows what is missing.',
      '“Not connected”: a variable is missing. “Awaiting live verification”: configured, but no real event has arrived yet. “Receiving events”: working.',
      'WhatsApp: set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN (and WHATSAPP_BUSINESS_ACCOUNT_ID to sync templates). Register the webhook URL shown in Settings in Meta’s app dashboard. Outside 24 hours since a customer last wrote, only approved templates can be sent.',
      'A message stuck at “Accepted, waiting for status” means Meta has it but has not reported back; check the webhook subscription. “Failed” shows Meta’s reason. Retry only resends messages Meta never accepted.',
      'Calls: manual logging always works. Exotel click-to-call needs EXOTEL_* variables and your phone number on your profile. Any other phone system can post signed events to the call webhook.',
      'Website forms and ad platforms: use the hosted form, or POST JSON to the capture API with a key from Settings → Website forms & API keys. Send an idempotency_key or external_id so retries do not duplicate.',
    ],
  },
  {
    id: 'numbers', who: 'Everyone', title: 'What the numbers mean',
    body: [
      'Score: how good a fit a lead looks from what is recorded, with each part shown. Not the chance of winning.',
      'Probability: the chance a deal is won (the deal’s own, else its stage’s). Weighted forecast = value × probability over open deals.',
      'Bookings: agreed value of won B2B deals. CSR committed: funding committed on won CSR deals. Received: money that arrived. None of these is accounting revenue, and they are never added together.',
      'Currencies are never mixed. Deals in another currency are listed separately.',
      'Cohort conversion: of the leads that arrived in a period, how many have converted (it can rise later). Converted in period: conversions that happened in the period.',
      'Past pipeline totals “as of” an earlier date are not available: TaskFlow keeps stage changes, not daily snapshots.',
    ],
  },
];

export default function SalesHelp() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('start');
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return TOPICS;
    return TOPICS.filter((x) => `${x.title} ${x.who} ${x.body.join(' ')}`.toLowerCase().includes(t));
  }, [q]);
  return (
    <div className="stack">
      <input className="input" style={{ maxWidth: 360 }} placeholder="Search the guide (e.g. “TeleCRM”, “approval”, “import”)" aria-label="Search the guide" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length === 0 && <div className="empty small">Nothing matches “{q}”.</div>}
      {found.map((t) => (
        <section key={t.id} className="card">
          <button type="button" className="card-head sales-help-head" aria-expanded={open === t.id || Boolean(q)} onClick={() => setOpen(open === t.id ? null : t.id)}>
            <h3>{t.title}</h3><span className="small muted">{t.who}</span>
          </button>
          {(open === t.id || q) && (
            <div className="card-pad stack-sm sales-help-body">
              {t.body.map((p, i) => <p key={i} className="small">{p}</p>)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
