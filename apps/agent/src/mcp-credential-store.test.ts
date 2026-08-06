import { describe, expect, it } from 'vitest'
import { listMcpCredentialInfo, secureMcpServersJson } from './mcp-credential-store.js'

describe('MCP credential store', () => {
  it('moves auth headers to SQLite and leaves only a placeholder in persisted JSON', () => {
    const secured = secureMcpServersJson(JSON.stringify({
      mcpServers: {
        remote: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp',
          headers: {
            Authorization: 'Bearer test-secret',
            'Content-Type': 'application/json',
          },
        },
      },
    }))

    expect(secured.persistedJson).toContain('AUREVOY_MCP_SECRET')
    expect(secured.persistedJson).not.toContain('test-secret')
    expect(secured.servers[0]).toMatchObject({
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
    })
    expect(listMcpCredentialInfo()).toEqual(expect.arrayContaining([
      { serverName: 'remote', fieldName: 'Authorization' },
    ]))
  })

  it('hydrates a placeholder without exposing the secret in the persisted projection', () => {
    const first = secureMcpServersJson(JSON.stringify({
      mcpServers: {
        remote: {
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'Bearer stable-secret' },
        },
      },
    }))
    const second = secureMcpServersJson(first.persistedJson)

    expect(second.persistedJson).toBe(first.persistedJson)
    expect(second.servers[0]).toMatchObject({ headers: { Authorization: 'Bearer stable-secret' } })
  })

  it('does not send a missing placeholder to a remote server', () => {
    const secured = secureMcpServersJson(JSON.stringify({
      mcpServers: {
        'remote-missing': {
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: '${AUREVOY_MCP_SECRET:remote-missing:Authorization}' },
        },
      },
    }))

    expect(secured.servers[0]).toMatchObject({ headers: undefined })
  })
})
