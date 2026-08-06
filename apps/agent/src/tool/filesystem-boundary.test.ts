import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { editTool } from './tools/edit/edit.js'
import { globTool } from './tools/glob/glob.js'
import { grepTool } from './tools/grep/grep.js'
import { writeTool } from './tools/write/write.js'

const context = (workspaceDir: string) => ({
  sessionID: 'test',
  taskID: 'test',
  agent: 'test',
  assistantMessageID: '',
  toolCallID: 'call',
  workspaceDir,
  externalPaths: [],
})

describe('filesystem tool workspace boundary', () => {
  it('rejects traversal for every file read/search/write entry point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aurevoy-boundary-'))
    writeFileSync(join(root, 'inside.txt'), 'hello')
    const ctx = context(root)

    await expect(writeTool.runtime().settle({ path: '../outside.txt', content: 'blocked' }, ctx)).rejects.toThrow('路径越界')
    await expect(editTool.runtime().settle({ path: '../outside.txt', oldString: 'x', newString: 'y' }, ctx)).rejects.toThrow('路径越界')
    await expect(globTool.runtime().settle({ path: '../', pattern: '**/*' }, ctx)).rejects.toThrow('路径越界')
    await expect(grepTool.runtime().settle({ path: '../', pattern: 'hello' }, ctx)).rejects.toThrow('路径越界')
  })
})
