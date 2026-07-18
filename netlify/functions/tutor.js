// netlify/functions/tutor.js
//
// This is the "brain" behind every lesson. It reads the lesson content file
// for whatever level the student is on, and calls Claude with instructions
// to teach ONLY from that file — never invent trading content on its own.
//
// Setup required before this works:
//   1. In your Netlify site dashboard: Site settings > Environment variables
//      Add a variable named ANTHROPIC_API_KEY with your real API key.
//   2. That's it — Netlify runs this automatically at /.netlify/functions/tutor

const fs = require('fs');
const path = require('path');

// Which levels are free vs. locked. Keep this in sync with index.html.
const LOCKED_LEVELS = [4, 5, 6, 7];

const LEVEL_FILES = {
  1: 'level-1-what-moves-price.md',
  2: 'level-2-trend-structure-shifts.md',
  3: 'level-3-candles-with-intent.md',
  4: 'level-4-entries-confirmation-timing.md',
  5: 'level-5-slp-framework.md',
  // 6 and 7 get added once those lesson files exist
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  const { level, message, history, unlocked, teamCode } = body;
  const levelNum = parseInt(level, 10);

  if (!LEVEL_FILES[levelNum]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown level' }) };
  }

  // Team members (founder + team) can bypass the paywall entirely with a
  // shared secret code, set in Netlify env vars as TEAM_ACCESS_CODE.
  const isTeam = !!teamCode && !!process.env.TEAM_ACCESS_CODE && teamCode === process.env.TEAM_ACCESS_CODE;

  // Server-side gate: even if someone tampers with the frontend, locked
  // levels refuse to teach unless the client says the student has paid,
  // OR they're a verified team member.
  // NOTE: the "unlocked" flag alone is a placeholder for real Stripe
  // subscription checks — replace before charging anyone for real.
  if (LOCKED_LEVELS.includes(levelNum) && !unlocked && !isTeam) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'This level requires a subscription.' }),
    };
  }

  let lessonContent;
  try {
    const filePath = path.join(__dirname, 'lessons', LEVEL_FILES[levelNum]);
    lessonContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Lesson content not found' }) };
  }

  const systemPrompt = `You are a forex trading tutor inside "SLP School," an app that teaches trading one level at a time.

You are currently teaching this specific level. Here is the ONLY material you know for this level — teach from it, don't add outside trading concepts, don't invent details that aren't here:

---
${lessonContent}
---

Rules:
- Teach the concepts above clearly, like a patient tutor, not a textbook dump.
- If the student asks something outside this lesson's material, gently point out it's covered in a different level (or not covered yet), rather than answering from general knowledge.
- Never give live trade signals, "buy/sell now" calls, or advice on real money decisions — this is education only.
- Use plain language. Avoid jargon unless you define it.
- Keep responses focused — a few paragraphs at most, not an essay, unless the student asks for more depth.
- End your first message in a new conversation with one question to check the student is following, but don't do this every single message.`;

  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: message },
  ];

  // Free levels (1-3) run on Gemini's free tier to avoid burning paid
  // Claude credit on non-paying users. Paid levels + team members get
  // Claude, since that's what the $40/mo is actually paying for.
  const useGemini = !LOCKED_LEVELS.includes(levelNum);

  try {
    let reply;

    if (useGemini) {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: messages.map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
          }),
        }
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return { statusCode: 502, body: JSON.stringify({ error: 'AI request failed', detail: errText }) };
      }

      const geminiData = await geminiRes.json();
      reply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 700,
          system: systemPrompt,
          messages: messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { statusCode: 502, body: JSON.stringify({ error: 'AI request failed', detail: errText }) };
      }

      const data = await response.json();
      reply = data.content && data.content[0] ? data.content[0].text : '';
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ reply }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error', detail: e.message }) };
  }
};
