# @pipeworx/gdelt

GDELT 2.0 DOC API MCP — global news monitoring (100+ languages, 15-min refresh), no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `search_articles(query, timespan?, sort?, max_records?)` — recent matching articles.
- `timeline_tone(query, timespan?)` — daily average tone (-100..+100).
- `timeline_volume(query, timespan?)` — daily article volume (% of news).

## Data source

`https://api.gdeltproject.org/api/v2/doc/doc` — public, no key required.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gdelt": {
      "url": "https://gateway.pipeworx.io/gdelt/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Gdelt data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
