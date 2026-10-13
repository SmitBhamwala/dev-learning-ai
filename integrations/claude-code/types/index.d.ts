/** Session state of the dev-learning-ai mod (held by the host; survives hot reloads). */

export type TaskAccumulator = {
  taskId: string;
  startedAt: string;
  turns: number;
  paths: string[];
  linesChanged: number;
  symbols: string[];
  toolCalls: Record<string, number>;
  testsRan: number;
  testsFailed: number;
};

export type PublicChoice = { id: string; text: string };

export type QuestionView = {
  assessmentId: string;
  questionId: string;
  prompt: string;
  code?: string;
  codeLanguage?: string;
  choices?: PublicChoice[];
  isMultiSelect: boolean;
  isOpen: boolean;
  type: string;
  conceptLabel: string;
  progress: string;
  askReasoning: boolean;
  askConfidence: boolean;
  requireReasoning: boolean;
  requireConfidence: boolean;
};

export type Feedback = {
  headline: string;
  isCorrect: boolean;
  lines: string[];
  explanation: string;
};

export type Band =
  | { kind: "hidden" }
  | { kind: "offer"; taskId: string; message: string }
  | { kind: "resume"; assessmentId: string; answered: number; total: number }
  | { kind: "consent"; taskId?: string; assessmentKind: "task" | "review" }
  | { kind: "working"; message: string }
  | {
      kind: "question";
      question: QuestionView;
      selected: string[];
      reasoning: string;
      answerText: string;
      stage: "answer" | "confidence";
    }
  | {
      kind: "feedback";
      assessmentId: string;
      feedback: Feedback;
      next: QuestionView | null;
      summary: string[] | null;
    }
  | { kind: "summary"; lines: string[] }
  | { kind: "notice"; message: string };

export type Status = {
  available: boolean;
  enabled: boolean;
  dueReviews: number;
  allowHostModel: boolean;
  reason?: string;
};

declare module "claude-code" {
  interface PluginState {
    "dev-learning-ai": {
      task: TaskAccumulator | null;
      band: Band;
      status: Status;
      lastSummary: string[];
    };
  }
}
