/**
 * Domain model for Stead.
 *
 * Everything here lives in a person's *local* knowledge base. The agent decides
 * what to share in a meeting based on `visibility`; `private` never leaves the
 * machine.
 */

export type AgentAddress = string; // e.g. "sarah@northwind"

export type Visibility = 'public' | 'team' | 'private';

export type Role = 'manager' | 'ic';

export interface WorkingHours {
  /** 0 = Sunday .. 6 = Saturday */
  days: number[];
  /** Minutes from local midnight, e.g. 9 * 60 */
  startMinute: number;
  endMinute: number;
}

export interface Profile {
  address: AgentAddress;
  displayName: string;
  title: string;
  role: Role;
  team: string;
  timezone: string;
  bio: string;
  /** What this person is known for; used by other agents to route questions. */
  focusAreas: string[];
  manager?: AgentAddress;
  reports: AgentAddress[];
  workingHours: WorkingHours;
  /** Free-form standing instructions the human gives their own agent. */
  agentInstructions: string;
}

/** The subset of a profile that is published to the network directory. */
export interface PublicProfile {
  address: AgentAddress;
  displayName: string;
  title: string;
  role: Role;
  team: string;
  timezone: string;
  bio: string;
  focusAreas: string[];
  manager?: AgentAddress;
  online: boolean;
  lastSeen: number;
}

export type ProjectStatus = 'planning' | 'active' | 'blocked' | 'shipped' | 'paused';

export interface Project {
  id: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  visibility: Visibility;
  tags: string[];
  repo?: string;
  /** Address of the person accountable, when it is not the owner of this store. */
  stakeholders: AgentAddress[];
  createdAt: number;
  updatedAt: number;
}

export type NoteKind = 'update' | 'decision' | 'idea' | 'blocker' | 'meeting' | 'reference';

/**
 * A note is the "NB file" of the system: a markdown document about a project or
 * a piece of work. The body is stored on disk as markdown so it stays legible
 * and editable outside the app.
 */
export interface Note {
  id: string;
  /** Path inside the vault, relative to `<root>/notes`, e.g. "Projects/Auth.md". */
  path?: string;
  projectId?: string;
  title: string;
  body: string;
  kind: NoteKind;
  tags: string[];
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
}

export type ArtifactKind = 'pr' | 'cl' | 'demo' | 'doc' | 'metric' | 'design' | 'incident';

export type ArtifactStatus = 'draft' | 'in_review' | 'merged' | 'shipped' | 'abandoned';

/**
 * Something concrete an agent can *show* in a meeting: a pull request, a demo
 * recording, a dashboard number. This is what makes an agent meeting more than
 * a summarized email.
 */
export interface Artifact {
  id: string;
  projectId?: string;
  kind: ArtifactKind;
  title: string;
  url?: string;
  summary: string;
  status: ArtifactStatus;
  visibility: Visibility;
  /** e.g. { additions: 412, deletions: 88, files: 12, reviewers: 2 } */
  stats: Record<string, string | number>;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'dropped';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** One line of a task's checklist. */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';

/**
 * A repeating task. Ticking one off does not finish it — it moves to its next
 * date and stays open, which is the whole reason a to-do list has this.
 */
export interface Recurrence {
  unit: RecurrenceUnit;
  /** Every N units: 2 weeks, 3 months. */
  every: number;
  /** Weekly repeats pinned to particular days. 0 = Sunday. */
  weekdays?: number[];
  /**
   * `schedule` keeps the original rhythm — rent is due on the 1st whether or not
   * you paid March's late. `completion` counts from the day you actually ticked
   * it: water the plants every three days means three days after the last
   * watering.
   */
  from: 'schedule' | 'completion';
  /**
   * The day of the month a monthly or yearly repeat is pinned to. Without it a
   * bill due on the 31st becomes due on the 28th the first time it passes
   * February, and stays there — the clamp has to be remembered as a clamp
   * rather than becoming the new truth.
   */
  anchorDay?: number;
  /** Stop after this date, or after this many occurrences. */
  until?: number;
  count?: number;
  /** How many times it has been completed, for `count`. */
  completions?: number;
}

/**
 * Where a task came from when it was not typed by hand. This is the thing a
 * general to-do app cannot have: work that arrived because two agents met, or
 * because somebody said it in a channel, keeps a way back to the moment.
 */
export interface TaskSource {
  kind: 'meeting' | 'message' | 'agent';
  workspaceId?: string;
  channelId?: string;
  messageId?: string;
  author?: AgentAddress;
  /** Enough of the original to recognise it without opening anything. */
  excerpt?: string;
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  assignee: AgentAddress;
  assignedBy: AgentAddress;
  projectId?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number;
  acceptanceCriteria: string[];
  /** Set when the task came out of an agent-to-agent meeting. */
  sourceMeetingId?: string;
  /** Recorded when the assignee's agent pushed back during the meeting. */
  negotiationNote?: string;
  createdAt: number;
  updatedAt: number;

  // --- the to-do list ---
  /** The list this lives in. Empty means the Inbox. */
  listId?: string;
  /** The heading inside that list, when the list has been divided up. */
  sectionId?: string;
  labels: string[];
  /**
   * True when `dueDate` names a moment; false when it is just a day. "Friday"
   * and "Friday at 3" are different promises and have to be stored differently.
   */
  dueHasTime?: boolean;
  /** When to raise a notification. Independent of the due date on purpose. */
  remindAt?: number;
  recurrence?: Recurrence;
  subtasks: Subtask[];
  /** Manual position within its group. Lower sorts first. */
  order: number;
  completedAt?: number;
  source?: TaskSource;
}

/** A list of tasks: Todoist calls it a project, Things calls it an area. */
export interface TaskList {
  id: string;
  name: string;
  emoji: string;
  /** A key from `LIST_COLORS`, not a literal — the theme owns the actual hue. */
  color: string;
  order: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A heading inside a list. Tasks with no section sit above the first one. */
export interface TaskSection {
  id: string;
  listId: string;
  name: string;
  order: number;
  collapsed?: boolean;
}

export type CalendarBlockKind = 'busy' | 'meeting' | 'focus' | 'ooo';

export interface CalendarBlock {
  id: string;
  title: string;
  start: number;
  end: number;
  kind: CalendarBlockKind;
  meetingId?: string;
}

export interface Feedback {
  id: string;
  from: AgentAddress;
  text: string;
  sentiment: 'positive' | 'constructive' | 'neutral';
  meetingId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export type MeetingKind = 'standup' | 'one_on_one' | 'review' | 'planning' | 'sync';

export type MeetingStatus =
  | 'negotiating'
  | 'scheduled'
  | 'live'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface AgendaItem {
  id: string;
  title: string;
  owner?: AgentAddress;
  notes?: string;
}

export interface Meeting {
  id: string;
  /** The workspace the meeting belongs to; its members are the ones who see it. */
  workspaceId: string;
  /**
   * The channel the meeting *is*: one made for it, which its turns fill and
   * which archives itself when the meeting ends.
   */
  channelId?: string;
  /**
   * Where it was booked from. The meeting does not happen here, but this is
   * where the people are, so the booking and the outcome are announced here
   * with a pointer to the room.
   */
  originChannelId?: string;
  title: string;
  purpose: string;
  kind: MeetingKind;
  agenda: AgendaItem[];
  /** The chair runs the meeting: opens it, gives feedback, assigns work. */
  chair: AgentAddress;
  participants: AgentAddress[];
  organizer: AgentAddress;
  start: number;
  end: number;
  status: MeetingStatus;
  createdAt: number;
}

export type MeetingPhase =
  | 'opening'
  | 'updates'
  | 'qa'
  | 'decisions'
  | 'commitments'
  | 'wrap'
  | 'closed';

export const MEETING_PHASES: MeetingPhase[] = [
  'opening',
  'updates',
  'qa',
  'decisions',
  'commitments',
  'wrap',
  'closed',
];

export interface ArtifactRef {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  url?: string;
  summary: string;
  stats?: Record<string, string | number>;
}

export type TranscriptKind =
  | 'moderator'
  | 'utterance'
  | 'question'
  | 'answer'
  | 'demo'
  | 'assignment'
  | 'commitment'
  | 'decision'
  | 'minutes'
  | 'system';

export interface TranscriptEntry {
  id: string;
  ts: number;
  phase: MeetingPhase;
  kind: TranscriptKind;
  /** Address of the speaking agent, or "moderator". */
  speaker: string;
  text: string;
  /** Target of a question / answer / assignment. */
  to?: AgentAddress;
  refs?: ArtifactRef[];
  /** Present on `assignment` entries. */
  task?: ProposedTask;
  /** Present on `commitment` entries. */
  commitment?: Commitment;
}

export interface ProposedTask {
  id: string;
  title: string;
  detail: string;
  assignee: AgentAddress;
  projectId?: string;
  priority: TaskPriority;
  dueDate?: number;
  acceptanceCriteria: string[];
}

export interface Commitment {
  taskId: string;
  accepted: boolean;
  note: string;
  /** Assignee's agent may counter-propose a due date. */
  proposedDueDate?: number;
}

/** The neutral record the chair's agent produces at the end of the meeting. */
export interface Minutes {
  summary: string;
  decisions: string[];
  risks: string[];
  followUps: string[];
}

/**
 * Each agent synthesizes its *own* outcome from the shared transcript. That is
 * the point of the system: your information arrives through your agent.
 */
export interface MeetingOutcome {
  meetingId: string;
  generatedFor: AgentAddress;
  headline: string;
  summary: string;
  /** New work assigned to me in this meeting. */
  myTasks: Task[];
  /** Feedback directed at me. */
  feedbackReceived: Feedback[];
  decisions: string[];
  /** Things I told the meeting I would follow up on. */
  myCommitments: string[];
  /** Points where my agent had to speak for me without solid grounding. */
  openQuestionsForHuman: string[];
  createdAt: number;
}

export interface MeetingRecord {
  meeting: Meeting;
  transcript: TranscriptEntry[];
  minutes?: Minutes;
  outcome?: MeetingOutcome;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface TimeSlot {
  start: number;
  end: number;
}

export interface MeetingRequest {
  negotiationId: string;
  organizer: AgentAddress;
  /** Defaults to the organizer's current workspace when omitted. */
  workspaceId?: string;
  /** Channel the request came from; the relay announces the booking there. */
  channelId?: string;
  participants: AgentAddress[];
  chair: AgentAddress;
  title: string;
  purpose: string;
  kind: MeetingKind;
  agenda: AgendaItem[];
  durationMins: number;
  /** Search window for a mutually free slot. */
  earliest: number;
  latest: number;
  urgency: 'whenever' | 'this_week' | 'asap';
  note?: string;
}

export interface AvailabilityReply {
  negotiationId: string;
  from: AgentAddress;
  slots: TimeSlot[];
  declined?: boolean;
  declineReason?: string;
}
