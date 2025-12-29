# The Way of Becoming

A philosophical choose-your-own-adventure game that explores Deleuzean and Daoist concepts through interactive storytelling.

## Features

- Dynamic story generation using Claude API
- Exploration of philosophical concepts including rhizomes, wu wei, becoming, and the Dao
- Four choices at each decision point
- Beautiful, contemplative interface
- Complete path tracking showing all your choices

## Deployment to Railway

### Step 1: Prepare Your Files

You have three files:
- `index.html` - The game interface
- `server.js` - The Node.js server
- `package.json` - Dependencies configuration
- `.gitignore` - Files to exclude from Git

### Step 2: Push to GitHub

1. Open PowerShell and navigate to your project folder:
   ```powershell
   cd path\to\your\project
   ```

2. Initialize Git (if not already done):
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   ```

3. Create a new repository on GitHub.com and push:
   ```powershell
   git remote add origin https://github.com/YOUR-USERNAME/philosophical-adventure.git
   git branch -M main
   git push -u origin main
   ```

### Step 3: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `philosophical-adventure` repository
4. Railway will automatically detect it's a Node.js app

### Step 4: Add Your API Key

1. In Railway, click on your project
2. Go to "Variables" tab
3. Click "New Variable"
4. Add:
   - Variable name: `ANTHROPIC_API_KEY`
   - Value: `your-api-key-here` (starts with sk-ant-api03-)
5. Click "Add"

Railway will automatically redeploy with your API key.

### Step 5: Access Your Game

1. Railway will give you a URL (something like `https://philosophical-adventure-production.up.railway.app`)
2. Visit that URL to play!
3. Share it with anyone - they won't need their own API key!

## Local Development

To run locally:

```bash
# Install dependencies
npm install

# Set your API key
# On Windows PowerShell:
$env:ANTHROPIC_API_KEY="your-api-key-here"

# On Mac/Linux:
export ANTHROPIC_API_KEY="your-api-key-here"

# Run the server
npm start

# Visit http://localhost:3000
```

## How It Works

- Users make choices that shape their philosophical journey
- The server securely stores your Anthropic API key
- Each choice triggers a new story generation
- The path tracks all choices made (no truncation!)
- Stories explore concepts from both Deleuze and Daoism

## Technologies

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js with Express
- AI: Claude API (Sonnet 4)
- Hosting: Railway

Enjoy your journey through becoming and the Way!
