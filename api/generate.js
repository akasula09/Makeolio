// Vercel Serverless Function — hides GEMINI_API_KEY, returns clean JSON only.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    template: { type: 'STRING', enum: ['aurora', 'sunset', 'mono'] },
    theme: {
      type: 'OBJECT',
      properties: {
        primary: { type: 'STRING' },
        accent: { type: 'STRING' },
        background: { type: 'STRING' },
        font: { type: 'STRING', enum: ['Inter', 'Poppins', 'Sora', 'Space Grotesk'] }
      },
      required: ['primary', 'accent', 'background', 'font']
    },
    hero: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        tagline: { type: 'STRING' },
        location: { type: 'STRING' },
        initials: { type: 'STRING' }
      },
      required: ['name', 'tagline']
    },
    about: {
      type: 'OBJECT',
      properties: { heading: { type: 'STRING' }, body: { type: 'STRING' } },
      required: ['heading', 'body']
    },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          type: { type: 'STRING', enum: ['projects', 'timeline', 'tags', 'contact', 'text'] },
          heading: { type: 'STRING' },
          body: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                subtitle: { type: 'STRING' },
                period: { type: 'STRING' },
                description: { type: 'STRING' },
                link: { type: 'STRING' },
                tags: { type: 'ARRAY', items: { type: 'STRING' } }
              }
            }
          },
          animation: {
            type: 'OBJECT',
            properties: {
              trigger: { type: 'STRING', enum: ['none', 'fadeIn', 'fadeOut'] },
              delayMs: { type: 'NUMBER' },
              durationMs: { type: 'NUMBER' }
            }
          }
        },
        required: ['id', 'type', 'heading']
      }
    }
  },
  required: ['template', 'theme', 'hero', 'about', 'sections']
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { name, age, location, bio, school, projectsText, links, skills, enriched } = body || {};

  if (!name || !age) return res.status(400).json({ error: 'Name and age are required.' });

  const apiKey = process.env.GEMINI_API_KEY;
  const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

  if (!apiKey) {
    return res.status(200).json({
      content: sanitizeContent(buildFallbackContent(body), name),
      source: 'fallback',
      note: 'GEMINI_API_KEY not set.'
    });
  }

  const prompt = buildPrompt(body);

  try {
    // 1) requested model + thinking config, 2) same model without it,
    // 3) a known-stable fallback model — then finally an offline template.
    let r = await callGemini(apiKey, primaryModel, prompt, true);
    if (!r.ok) r = await callGemini(apiKey, primaryModel, prompt, false);
    if (!r.ok) r = await callGemini(apiKey, 'gemini-2.0-flash', prompt, false);

    if (!r.ok) {
      console.error('Gemini failed:', r.status, await safeText(r));
      return res.status(200).json({
        content: sanitizeContent(buildFallbackContent(body), name),
        source: 'fallback',
        note: 'AI service unavailable, used offline template.'
      });
    }

    const data = await r.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let content;
    try {
      content = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      content = match ? JSON.parse(match[0]) : null;
    }
    if (!content) throw new Error('Could not parse AI response as JSON.');

    return res.status(200).json({ content: sanitizeContent(content, name), source: 'gemini' });
  } catch (e) {
    console.error(e);
    return res.status(200).json({
      content: sanitizeContent(buildFallbackContent(body), name),
      source: 'fallback',
      note: String(e.message || e)
    });
  }
}

async function callGemini(apiKey, model, prompt, includeThinking) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.8,
      // Gemini 3.7 Flash exposes discrete thinking levels (LOW/MEDIUM/HIGH).
      // Medium gives good reasoning quality for structuring a portfolio
      // without the latency/cost of HIGH.
      ...(includeThinking ? { thinkingConfig: { thinkingLevel: 'MEDIUM' } } : {})
    };
    return await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig })
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(r) { try { return await r.text(); } catch { return ''; } }

function buildPrompt({ name, age, location, bio, school, projectsText, links, skills, enriched }) {
  const research = (enriched || []).slice(0, 10)
    .map((r) => `- ${r.title}: ${r.snippet} (${r.link})`).join('\n') || 'No external research found.';

  return `You are the content engine for Folyo, a tool that builds personal portfolio websites.
Generate the JSON content for this person's portfolio. Follow the schema exactly. Output ONLY the JSON object — no markdown, no code fences, no commentary.

PERSON DETAILS:
- Name: ${name}
- Age: ${age}
- Location: ${location || 'Not provided'}
- Self-written bio/summary: ${bio || 'Not provided'}
- Schooling: ${school || 'Not provided'}
- Projects (as described by the person, one per line): ${projectsText || 'Not provided'}
- Links/socials provided: ${links || 'Not provided'}
- Skills provided: ${skills || 'Not provided'}

WEB RESEARCH (may be noisy or about someone else with the same name — use judgement; trust the person's own words above over this):
${research}

INSTRUCTIONS:
- Confident, warm, professional tone. Keep copy concise — this is a portfolio, not an essay.
- Pick "template": "aurora" (creative/tech), "sunset" (warm/personal), or "mono" (minimal/professional) — whichever fits the vibe.
- Pick a cohesive dark-mode-friendly hex pair for theme.primary/theme.accent, a dark theme.background, and theme.font from the allowed list.
- Build 2-5 "sections" from the details given (and confidently-supported research). Good options: "projects", "timeline" (school/experience), "tags" (skills), "contact" (from links; use mailto: only if an email was actually given).
- Give each section a tasteful "animation": trigger "fadeIn", delayMs staggered by roughly 120ms per section, durationMs 500-700ms.
- Never invent facts you're not reasonably confident about. Return ONLY the JSON object.`;
}

function buildFallbackContent({ name, age, location, bio, school, projectsText, links, skills }) {
  const projectItems = (projectsText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)
    .map((line) => {
      const [title, ...rest] = line.split('-');
      return { title: (title || line).trim(), description: rest.join('-').trim() || 'A project I worked on.', tags: [] };
    });
  const skillItems = (skills || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ title: s }));
  const contactItems = parseLinks(links);

  const sections = [];
  if (projectItems.length) sections.push({ id: 'projects', type: 'projects', heading: 'Projects', items: projectItems, animation: { trigger: 'fadeIn', delayMs: 100, durationMs: 600 } });
  if (school) sections.push({ id: 'education', type: 'timeline', heading: 'Education', items: [{ title: school, subtitle: location || '', period: '', description: '' }], animation: { trigger: 'fadeIn', delayMs: 220, durationMs: 600 } });
  if (skillItems.length) sections.push({ id: 'skills', type: 'tags', heading: 'Skills', items: skillItems, animation: { trigger: 'fadeIn', delayMs: 340, durationMs: 600 } });
  if (contactItems.length) sections.push({ id: 'contact', type: 'contact', heading: 'Get in touch', items: contactItems, animation: { trigger: 'fadeIn', delayMs: 460, durationMs: 600 } });

  return {
    template: 'aurora',
    theme: { primary: '#7c5cff', accent: '#2dd4ff', background: '#0b0f19', font: 'Inter' },
    hero: {
      name, location,
      tagline: (bio ? bio.slice(0, 120) : [age && `${age}`, location].filter(Boolean).join(' • ')) || 'Welcome to my portfolio',
      initials: name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
    },
    about: { heading: 'About', body: bio || `Hi, I'm ${name}. Welcome to my portfolio.` },
    sections
  };
}

function parseLinks(links) {
  if (!links) return [];
  return links.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((raw) => {
    let url = raw.includes('@') && !raw.startsWith('http') ? `mailto:${raw}` : raw;
    if (!/^https?:\/\//.test(url) && !url.startsWith('mailto:')) url = `https://${url}`;
    let label = 'Website';
    if (url.startsWith('mailto:')) label = 'Email';
    else if (/github\.com/.test(url)) label = 'GitHub';
    else if (/linkedin\.com/.test(url)) label = 'LinkedIn';
    else if (/twitter\.com|x\.com/.test(url)) label = 'Twitter';
    return { title: label, link: url };
  });
}

function sanitizeContent(c, fallbackName) {
  c = c || {};
  c.template = ['aurora', 'sunset', 'mono'].includes(c.template) ? c.template : 'aurora';
  c.theme = Object.assign({ primary: '#7c5cff', accent: '#2dd4ff', background: '#0b0f19', font: 'Inter' }, c.theme || {});
  c.hero = Object.assign({ name: fallbackName, tagline: '', location: '' }, c.hero || {});
  if (!c.hero.initials) {
    c.hero.initials = (c.hero.name || fallbackName || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }
  c.about = Object.assign({ heading: 'About', body: '' }, c.about || {});
  c.sections = (Array.isArray(c.sections) ? c.sections : []).map((s, i) => ({
    id: s.id || `section-${i}`,
    type: ['projects', 'timeline', 'tags', 'contact', 'text'].includes(s.type) ? s.type : 'text',
    heading: s.heading || 'Section',
    body: s.body || '',
    items: Array.isArray(s.items) ? s.items : [],
    hidden: false,
    animation: {
      trigger: ['none', 'fadeIn', 'fadeOut'].includes(s.animation?.trigger) ? s.animation.trigger : 'fadeIn',
      delayMs: Number.isFinite(s.animation?.delayMs) ? s.animation.delayMs : i * 120,
      durationMs: Number.isFinite(s.animation?.durationMs) ? s.animation.durationMs : 600
    }
  }));
  return c;
}
