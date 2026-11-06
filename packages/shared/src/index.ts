export {
  Agent,
  AgentDialog,
  AgentList,
  AgentModel,
  AgentRole,
  AgentStatus,
  CommandList,
  ContextUsage,
  CreateAgentRequest,
  DialogAnswer,
  ModelList,
  PromptRequest,
  SetModelRequest,
  SetThinkingRequest,
  ThinkingLevel,
} from "./agents.js";
export {
  applyPiEvent,
  type ChatMessage,
  type ChatState,
  emptyChat,
  type RunningTool,
} from "./chat.js";
export { HealthResponse } from "./health.js";
export {
  AddProjectRequest,
  Project,
  ProjectConfigView,
  ProjectLines,
  ProjectList,
  ProjectTrait,
  SettingSource,
} from "./projects.js";
export { slugify } from "./slug.js";
export { parse, parseJsonBody, ValidationError } from "./validate.js";
export {
  ArchiveWorkspaceRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  Isolation,
  RenameWorkspaceRequest,
  Workspace,
  WorkspaceList,
  WorkspaceState,
} from "./workspaces.js";

/** Default address of the local server (R1.2: loopback only). */
export const DEFAULT_PORT = 7420;
export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
