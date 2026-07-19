import { describe, expect, it } from 'vitest';
import { parseMcpServers } from './config.js';

describe('parseMcpServers', () => {
  it('parses stdio servers', () => {
    const servers = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          fs: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'server'],
            enabled: true,
          },
        },
      }),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    });
  });

  it('parses streamable-http servers', () => {
    const servers = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          remote: {
            transport: 'streamable-http',
            url: 'https://mcp.example.com/v1',
            headers: { Authorization: 'Bearer x' },
          },
        },
      }),
    );
    expect(servers).toEqual([
      {
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/v1',
        headers: { Authorization: 'Bearer x' },
        enabled: true,
        riskLevel: undefined,
      },
    ]);
  });

  it('infers streamable-http when only url is set', () => {
    const servers = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          cloud: { url: 'http://127.0.0.1:3000/mcp' },
        },
      }),
    );
    expect(servers[0]?.transport).toBe('streamable-http');
    if (servers[0]?.transport === 'streamable-http') {
      expect(servers[0].url).toBe('http://127.0.0.1:3000/mcp');
    }
  });

  it('accepts http alias transport', () => {
    const servers = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          a: { transport: 'http', url: 'https://example.com/mcp' },
        },
      }),
    );
    expect(servers[0]?.transport).toBe('streamable-http');
  });

  it('rejects invalid url protocol', () => {
    expect(() =>
      parseMcpServers(
        JSON.stringify({
          mcpServers: {
            bad: { transport: 'streamable-http', url: 'ftp://x' },
          },
        }),
      ),
    ).toThrow(/http/);
  });
});
