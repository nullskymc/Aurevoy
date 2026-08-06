import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { artifactTargetExists, writeArtifactToWorkspace } from './artifact.js'

describe('writeArtifactToWorkspace', () => {
  it('writes nested files inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aurevoy-artifact-'))
    await writeArtifactToWorkspace(root, 'reports/result.md', '# result')
    expect(readFileSync(join(root, 'reports/result.md'), 'utf8')).toBe('# result')
  })

  it('rejects lexical path traversal before writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aurevoy-artifact-'))
    await expect(writeArtifactToWorkspace(root, '../outside.txt', 'blocked')).rejects.toThrow('路径越界')
  })

  it('rejects a parent symlink that points outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aurevoy-artifact-'))
    const outside = mkdtempSync(join(tmpdir(), 'aurevoy-artifact-outside-'))
    writeFileSync(join(outside, 'existing.txt'), 'keep')
    symlinkSync(outside, join(root, 'linked'))

    await expect(writeArtifactToWorkspace(root, 'linked/new.txt', 'blocked')).rejects.toThrow('路径越界')
  })

  it('reports overwrite impact before applying an artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aurevoy-artifact-'))
    writeFileSync(join(root, 'result.md'), 'old')
    await expect(artifactTargetExists(root, 'result.md')).resolves.toBe(true)
    await expect(artifactTargetExists(root, 'new.md')).resolves.toBe(false)
  })
})
