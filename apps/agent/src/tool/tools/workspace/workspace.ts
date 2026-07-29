import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { Schema } from 'effect';
import { make } from '../../framework/definition.js';
import { assertRealPathInside, pathExists, resolveInWorkspace, rootAndExternals } from '../../filesystem/workspace-paths.js';

const PathInput = Schema.Struct({
  path: Schema.optional(Schema.String.annotations({ description: 'Relative directory path. Defaults to the workspace root.' })),
});

const MutationInput = Schema.Struct({
  sourcePath: Schema.String.annotations({ description: 'Workspace-relative source file path.' }),
  targetPath: Schema.String.annotations({ description: 'Workspace-relative target file path.' }),
  overwrite: Schema.optional(Schema.Boolean.annotations({ description: 'Replace an existing target. Defaults to false.' })),
});

const MutationOutput = Schema.Struct({
  sourcePath: Schema.String,
  targetPath: Schema.String,
  bytesCopied: Schema.optional(Schema.Number),
  bytesMoved: Schema.optional(Schema.Number),
});

// Effect 会把空 Struct 导出为 object | array；函数工具协议要求根参数必须明确为 object。
const EmptyObjectInput = Schema.Struct({}).annotations({
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
});

/** 只读目录枚举，仍使用同一套工作区与符号链接边界检查。 */
export const listDirectoryTool = make({
  name: 'list_directory',
  description: '列出工作区内某个目录的条目（文件/子目录）。path 相对工作区根，缺省为根。',
  riskLevel: 'safe',
  input: PathInput,
  output: Schema.Struct({
    dir: Schema.String,
    entries: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Literal('directory', 'file') })),
  }),
  execute: async (input, context) => {
    const { root, externalPaths } = rootAndExternals(context);
    await fs.mkdir(root, { recursive: true });
    const dir = resolveInWorkspace(input.path ?? '.', root, externalPaths);
    await assertRealPathInside(dir, root, externalPaths);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      dir: relative(root, dir) || '.',
      entries: entries.filter((entry) => entry.name !== '.aurevoy-trash')
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const })),
    };
  },
});

export const getCurrentTimeTool = make({
  name: 'get_current_time',
  description: '获取当前的 ISO 时间戳',
  riskLevel: 'safe',
  input: EmptyObjectInput,
  output: Schema.Struct({ now: Schema.String }),
  execute: async () => ({ now: new Date().toISOString() }),
});

function makeFileMutationTool(name: 'copy_file' | 'move_file' | 'rename_file', description: string, operation: 'copy' | 'move') {
  return make({
    name,
    description,
    riskLevel: 'caution',
    executionPolicy: { parallelizable: false },
    input: MutationInput,
    output: MutationOutput,
    execute: async (input, context) => {
      const { root, externalPaths } = rootAndExternals(context);
      const source = resolveInWorkspace(input.sourcePath, root, externalPaths);
      const target = resolveInWorkspace(input.targetPath, root, externalPaths);
      await assertRealPathInside(source, root, externalPaths);
      await fs.mkdir(join(target, '..'), { recursive: true });
      await assertRealPathInside(target, root, externalPaths);
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
      if (input.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
      if (operation === 'copy') await fs.copyFile(source, target);
      else await fs.rename(source, target);
      const paths = { sourcePath: relative(root, source), targetPath: relative(root, target) };
      return operation === 'copy' ? { ...paths, bytesCopied: sourceStat.size } : { ...paths, bytesMoved: sourceStat.size };
    },
  });
}

export const copyFileTool = makeFileMutationTool('copy_file', '在工作区内复制文件。目标存在时默认拒绝覆盖，除非 overwrite=true。', 'copy');
export const moveFileTool = makeFileMutationTool('move_file', '在工作区内移动或重命名文件。目标存在时默认拒绝覆盖，除非 overwrite=true。', 'move');
export const renameFileTool = makeFileMutationTool('rename_file', 'move_file 的别名：在工作区内重命名文件。', 'move');

export const deleteFileTool = make({
  name: 'delete_file',
  description: '把工作区内文件移入工作区 .aurevoy-trash 回收区，不做永久删除。默认禁用，启用后仍需审批。',
  riskLevel: 'dangerous',
  executionPolicy: { parallelizable: false },
  enabledByDefault: false,
  input: Schema.Struct({ path: Schema.String.annotations({ description: 'Workspace-relative file path to recycle.' }) }),
  output: Schema.Struct({ path: Schema.String, trashedPath: Schema.String, bytesMoved: Schema.Number }),
  execute: async (input, context) => {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(input.path, root, externalPaths);
    await assertRealPathInside(file, root, externalPaths);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('path 不是文件');
    const trashDir = resolveInWorkspace('.aurevoy-trash', root, externalPaths);
    await fs.mkdir(trashDir, { recursive: true });
    await assertRealPathInside(trashDir, root, externalPaths);
    const trashPath = join(trashDir, `${Date.now()}-${relative(root, file).replace(/[/\\:]/g, '_')}`);
    await fs.rename(file, trashPath);
    return { path: relative(root, file), trashedPath: relative(root, trashPath), bytesMoved: stat.size };
  },
});
