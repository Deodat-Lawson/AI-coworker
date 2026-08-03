/**
 * Domain model for AI Coworker.
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
