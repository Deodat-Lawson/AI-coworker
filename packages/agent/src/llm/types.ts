import type {
  AgentAddress,
  Artifact,
  Meeting,
  MeetingPhase,
  Note,
  Profile,
  Project,
  PublicProfile,
  Task,
  TaskPriority,
  TranscriptEntry,
  TurnKind,
} from '@ai-coworker/shared';

/**
 * The slice of a knowledge base that an agent is willing to reason over for a
 * given audience. `private` items are filtered out before this is built when
 * the audience is anyone other than the owner.
 */
export interface KnowledgeDigest {
  projects: Project[];
  notes: Note[];
  artifacts: Artifact[];
  tasks: Task[];
  /** Recent feedback the person received, summarized as lines. */
  feedbackLines: string[];
}

export interface MeetingTurnInput {
  self: Profile;
  meeting: Meeting;
  phase: MeetingPhase;
  turnKind: TurnKind;
  instruction: string;
  transcript: TranscriptEntry[];
  digest: KnowledgeDigest;
  participants: PublicProfile[];
  question?: { from: AgentAddress; text: string };
  pendingTasks?: {
    id: string;
    title: string;
    detail: string;
    acceptanceCriteria: string[];
    dueDate?: number;
    priority: TaskPriority;
  }[];
  now: number;
}

export interface TurnAssignment {
  assignee: AgentAddress;
  title: string;
  detail: string;
  priority: TaskPriority;
  dueInDays: number;
  acceptanceCriteria: string[];
  projectHint: string;
}

export interface TurnCommitment {
  taskId: string;
  accepted: boolean;
  note: string;
  proposedDueInDays: number;
}

export interface MeetingTurnOutput {
  speech: string;
  showArtifactIds: string[];
  question: { to: string; text: string };
  assignments: TurnAssignment[];
  commitments: TurnCommitment[];
  decisions: string[];
  minutes: { summary: string; decisions: string[]; risks: string[]; followUps: string[] };
  openQuestionsForHuman: string[];
}

export interface PostMeetingInput {
  self: Profile;
  meeting: Meeting;
  transcript: TranscriptEntry[];
  digest: KnowledgeDigest;
  /** Tasks that were assigned to me during the meeting. */
  assignedToMe: { title: string; detail: string }[];
  now: number;
}

export interface PostMeetingOutput {
  headline: string;
  summary: string;
  decisions: string[];
  myCommitments: string[];
  openQuestionsForHuman: string[];
  /** Notes the agent wants to write into its own knowledge base. */
  notesToSave: { title: string; body: string; kind: Note['kind']; projectHint: string }[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  self: Profile;
  message: string;
  history: ChatMessage[];
  digest: KnowledgeDigest;
  directory: PublicProfile[];
  upcoming: { title: string; start: number; participants: string[] }[];
  now: number;
}

export interface ChatOutput {
  reply: string;
  /** Names of tools that were run, for UI transparency. */
  actions: { tool: string; input: Record<string, unknown>; result: string }[];
}

export interface LLMProvider {
  readonly name: string;
  readonly live: boolean;
  /** Optional hook a provider may expose so waits become visible to the user. */
  onRateLimit?: (waitMs: number, attempt: number) => void;
  meetingTurn(input: MeetingTurnInput): Promise<MeetingTurnOutput>;
  postMeeting(input: PostMeetingInput): Promise<PostMeetingOutput>;
  chat(input: ChatInput, tools: ToolSpec[], exec: ToolExecutor): Promise<ChatOutput>;
}

export function emptyTurnOutput(): MeetingTurnOutput {
  return {
    speech: '',
    showArtifactIds: [],
    question: { to: '', text: '' },
    assignments: [],
    commitments: [],
    decisions: [],
    minutes: { summary: '', decisions: [], risks: [], followUps: [] },
    openQuestionsForHuman: [],
  };
}
