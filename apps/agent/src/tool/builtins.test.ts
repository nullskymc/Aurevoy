import { describe, expect, it } from 'vitest';
import { allTools } from './builtins.js';

describe('built-in Effect tool catalog', () => {
  it('contains every migrated former simple-tool id exactly once', () => {
    const names = allTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'get_current_time', 'list_directory', 'copy_file', 'move_file', 'rename_file', 'delete_file',
      'attach_content', 'present_ui', 'index_files', 'recall', 'run_dreams',
    ]));
    const deleteFile = allTools.find((tool) => tool.name === 'delete_file');
    expect(deleteFile?.enabledByDefault).toBe(false);
  });
});
