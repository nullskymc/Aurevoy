/** 项目和工作区跨进程契约的唯一类型定义。 */

/** 一个项目（导入的文件夹）。 */
export interface Project {
  id: string;
  name: string;
  /** 绝对路径。 */
  path: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/projects — 导入文件夹创建项目。 */
export interface CreateProjectRequest {
  /** 项目名称；缺省取目录 basename。 */
  name?: string;
  /** 文件夹绝对路径。 */
  path: string;
}

/** PATCH /api/projects/:id — 更新项目。 */
export interface UpdateProjectRequest {
  name?: string;
}

/** GET /api/projects。 */
export interface ProjectListResponse {
  projects: Project[];
}

export type WorkspaceReadEntryType = 'file' | 'directory';
export type WorkspaceReadResultType = 'directory' | 'text' | 'image';

export interface WorkspaceReadEntry {
  name: string;
  path: string;
  type: WorkspaceReadEntryType;
  size?: number;
  mimeType?: string;
}

export interface WorkspaceReadBaseResponse {
  root: string;
  path: string;
  type: WorkspaceReadResultType;
}

export interface WorkspaceDirectoryReadResponse extends WorkspaceReadBaseResponse {
  type: 'directory';
  entries: WorkspaceReadEntry[];
  truncated: boolean;
  next?: number;
}

export interface WorkspaceTextReadResponse extends WorkspaceReadBaseResponse {
  type: 'text';
  content: string;
  offset?: number;
  truncated: boolean;
  next?: number;
}

export interface WorkspaceImageReadResponse extends WorkspaceReadBaseResponse {
  type: 'image';
  content: string;
  mimeType: string;
}

/** GET /api/workspace/read — UI-facing adapter over the Pi read tool。 */
export type WorkspaceReadResponse =
  | WorkspaceDirectoryReadResponse
  | WorkspaceTextReadResponse
  | WorkspaceImageReadResponse;
