# The Way of Becoming

A philosophical choose-your-own-adventure game that explores Deleuzean and Daoist concepts through interactive storytelling. Live at [thewayofbecoming.org](https://www.thewayofbecoming.org).

## Features

- Dynamic story generation using the Claude API
- Exploration of philosophical concepts including rhizomes, wu wei, becoming, and the Dao
- Four choices at each decision point
- A journey of up to 20 story segments, the last of which is an ending
- Complete path tracking showing all your choices
- Save your story at any point as plain text, Markdown, a web page, or a PDF (via print)

## Files

- `index.html` - The game page (everything the visitor sees)
- `server.js` - The Node.js server: holds the story prompt, talks to Claude, and checks the reply
- `package.json` / `package-lock.json` - Dependencies and the Node.js version
- `og-image.png` - Preview image for social media links
- `test/server.test.js` - Automated checks (run with `npm test`)

## Deployment (Railway)

The site is deployed on [Railway](https://railway.app) from GitHub. **Pushing to the `main` branch redeploys the live site.**

Railway variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `CLAUDE_MODEL` | No | Overrides the model (default: `claude-sonnet-5-5`) |

After a deploy, the Railway deploy log should show:

```
Server running on port ... (model: claude-sonnet-5-5)
```

If it shows a static file server (Caddy) instead, Railway failed to recognise the project as a Node.js app. The usual cause is a broken `package.json` - see the warning below.

### Warning: editing files on Windows

Do not save `package.json` or `server.js` with PowerShell's `Set-Content -Encoding UTF8` or `Out-File`. Windows PowerShell adds an invisible marker (a "BOM") to the start of the file, which makes `package.json` unreadable to Railway and takes the site down. Edit the files in an editor such as VS Code or Notepad instead. `npm test` checks for this.

## Local Development

Requires [Node.js](https://nodejs.org) 22 or newer.

```powershell
# Install dependencies
npm install

# Set your API key (Windows PowerShell)
$env:ANTHROPIC_API_KEY="your-api-key-here"

# Run the server
npm start

# Visit http://localhost:3000
```

Run the automated checks (these never contact Anthropic and need no API key):

```powershell
npm test
```

## How It Works

- The browser sends the journey so far (stories and choices) to the server
- The server adds the story prompt, asks Claude for the next segment, and reads the reply into a story, a concept, and four choices
- The API key stays on the server; visitors never see it
- Prompt caching keeps the cost of re-sending the story on every turn low; the Railway log line for each segment shows how much of the input was read from the cache
- To limit misuse and cost, the server caps the journey length, the size of each request, and the number of requests per visitor

## Technologies

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js with Express
- AI: Claude API (Claude Sonnet 5.5, with prompt caching)
- Hosting: Railway

Enjoy your journey through becoming and the Way!
