/**
 * Builds the message shown when someone marks a task done.
 *
 * It is deterministic — no external service, no data leaves the app — but it reads
 * the task the way a manager would: it greets the person, names what kind of work
 * it was, asks for the specific proof that matters for that work, and shifts tone
 * when the task was critical or ran late. The goal is a prompt that feels aware of
 * the task, not a generic "add a note" box.
 */

const firstName = (name = '') => name.trim().split(/\s+/)[0] || 'there';

// What "done" should evidence, per kind of work. Keyed on task_type.
const BY_TYPE = {
  bug: {
    ask: 'What was the fix, and how did you confirm it no longer happens?',
    proof: 'Link the change or attach a before/after screenshot.',
  },
  feature: {
    ask: 'What shipped, and where can it be seen?',
    proof: 'Link the build, PR, or a screenshot of it working.',
  },
  enhancement: {
    ask: 'What did you improve, and what changed as a result?',
    proof: 'Link the change or attach a quick before/after.',
  },
  'customer-query': {
    ask: 'How was the customer’s issue resolved, and were they told?',
    proof: 'Attach the reply sent or a note of the call.',
  },
  procurement: {
    ask: 'What was ordered or agreed, and with whom?',
    proof: 'Attach the PO, quotation, or vendor confirmation.',
  },
  content: {
    ask: 'What did you produce, and where is the final piece?',
    proof: 'Link or attach the finished content.',
  },
  campaign: {
    ask: 'What went live, and where can we see it?',
    proof: 'Link the live campaign or attach the creative.',
  },
  advisory: {
    ask: 'What advice went out, and to whom?',
    proof: 'Attach the advisory sent or note the recipients.',
  },
  documentation: {
    ask: 'What did you document, and where does it live now?',
    proof: 'Link the document.',
  },
  compliance: {
    ask: 'What was filed or checked, and is it fully in order?',
    proof: 'Attach the filing or confirmation as proof.',
  },
  task: {
    ask: 'What did you actually do to close this out?',
    proof: 'Add a link or image as proof if you have one.',
  },
};

const DEFAULT_TYPE = BY_TYPE.task;

/**
 * @param task  the task being completed (title, task_type, priority, due_date, stage, recurrence…)
 * @param user  the person completing it (full_name)
 * @returns { heading, intro, ask, proof, placeholder, tone }
 */
export function completionPrompt(task = {}, user = {}) {
  const type = BY_TYPE[task.task_type] || DEFAULT_TYPE;
  const name = firstName(user.full_name);

  const isOverdue =
    task.due_date && new Date(task.due_date) < new Date() && task.stage !== 'done';
  const critical = task.priority === 'critical' || task.priority === 'high';
  const recurring = task.recurrence && task.recurrence !== 'none';

  let heading = `Closing out ${task.ref || 'this task'}`;
  let intro;
  let tone = 'normal';

  if (recurring) {
    heading = `Today’s ${task.title}`;
    intro = `${name}, quick note before you close today’s run — what did you get done?`;
  } else if (isOverdue) {
    tone = 'late';
    intro = `${name}, this one ran past its deadline. A short note on the outcome (and what held it up) keeps things clear at review.`;
  } else if (critical) {
    tone = 'critical';
    intro = `${name}, this was ${task.priority} priority — worth a clear record of how it was resolved.`;
  } else {
    intro = `Nice one, ${name}. Before this is marked done, capture the outcome so anyone can see what happened.`;
  }

  const proof = critical
    ? `This mattered — ${type.proof.charAt(0).toLowerCase()}${type.proof.slice(1)}`
    : type.proof;

  return {
    heading,
    intro,
    ask: type.ask,
    proof,
    tone,
    placeholder: 'Describe the outcome — what was done and why it counts as complete…',
  };
}
