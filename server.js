const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// API endpoint to generate story
app.post('/api/generate', async (req, res) => {
    try {
        const { messages } = req.body;
        
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'API key not configured' });
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
                max_tokens: 1500,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            return res.status(response.status).json({ 
                error: errorData.error?.message || 'API request failed' 
            });
        }

        const data = await response.json();
        if (data.error) {
            console.error('Anthropic API error:', JSON.stringify(data.error));
            return res.status(500).json({ error: data.error.message || 'API error' });
        }
        const textBlock = (data.content || []).find(b => b.type === 'text');
        if (!textBlock) {
            console.error('No text block in response:', JSON.stringify(data).slice(0, 2000));
            return res.status(500).json({ error: 'No text returned from Claude' });
        }
        res.json({ content: textBlock.text });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

