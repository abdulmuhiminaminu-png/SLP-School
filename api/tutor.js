// api/tutor.js
//
// This is the "brain" behind every lesson. It reads the lesson content file
// for whatever level the student is on, and calls Gemini with instructions
// to teach ONLY from that file — never invent trading content on its own.
//
// Setup required before this works (on Vercel):
//   1. In your Vercel project: Settings > Environment Variables
//      Add GEMINI_API_KEY with your real Gemini API key
//      (get one free, no card needed, at aistudio.google.com)
//      Add TEAM_ACCESS_CODE with your team's secret unlock code.
//   2. That's it — Vercel runs this automatically at /api/tutor

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
  6: 'level-6-applying-slp-live.md',
  7: 'level-7-trading-slp-on-your-own.md',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { level, message, history, unlocked, teamCode } = req.body || {};
  const levelNum = parseInt(level, 10);

  if (!LEVEL_FILES[levelNum]) {
    res.status(400).json({ error: 'Unknown level' });
    return;
  }

  // Team members (founder + team) can bypass the paywall entirely with a
  // shared secret code, set in Vercel env vars as TEAM_ACCESS_CODE.
  const isTeam = !!teamCode && !!process.env.TEAM_ACCESS_CODE && teamCode === process.env.TEAM_ACCESS_CODE;

  // Server-side gate: even if someone tampers with the frontend, locked
  // levels refuse to teach unless the client says the student has paid,
  // OR they're a verified team member.
  // NOTE: the "unlocked" flag alone is a placeholder for real Stripe
  // subscription checks — replace before charging anyone for real.
  if (LOCKED_LEVELS.includes(levelNum) && !unlocked && !isTeam) {
    res.status(403).json({ error: 'This level requires a subscription.' });
    return;
  }

  let lessonContent;
  try {
    const filePath = path.join(__dirname, 'lessons', LEVEL_FILES[levelNum]);
    lessonContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    res.status(500).json({ error: 'Lesson content not found', detail: e.message });
    return;
  }

  const systemPrompt = `You are a forex trading tutor inside "SLP School," an app that teaches trading one level at a time.

SLP School background (know this regardless of which level you're teaching):
- SLP School was founded by Hakimi FX, along with team members Musty FX and Breehamxy FX.
- SLP stands for "Structured Liquidity & POI" — Hakimi FX's personal trading strategy, taught in full starting at Level 5.
- If a student asks who made this, who the founder is, or what SLP stands for before reaching Level 5, answer those specific questions honestly using the info above, but don't teach the full SLP strategy details early — just say it's covered starting at Level 5.

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

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : String(m.content || ''),
          })),
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      res.status(502).json({ error: 'AI request failed', detail: errText });
      return;
    }

    const groqData = await groqRes.json();
    const reply = groqData.choices?.[0]?.message?.content || '';

    res.status(200).json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
};
