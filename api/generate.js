import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { name, age, location } = req.body;

    try {
        // 1. Context Gathering via SearchAPI.io
        const searchQuery = encodeURIComponent(`${name} ${location} portfolio projects developer`);
        const searchRes = await fetch(`https://www.searchapi.io/api/v1/search?engine=google&q=${searchQuery}&api_key=${process.env.SEARCHAPI_API_KEY}`);
        
        if (!searchRes.ok) throw new Error("SearchAPI request failed");
        const searchData = await searchRes.json();
        
        // Extract context snippets for lightweight context injection
        const contextSnippets = searchData.organic_results?.slice(0, 3).map(r => r.snippet).join(' ') || "No external web data found.";

        // 2. Generate JSON via the correct @google/genai SDK
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const prompt = `
        You are Makeolio, an expert portfolio generator. Create a stunning portfolio for ${name}, age ${age}, based in ${location}.
        Incorporate this web context: ${contextSnippets}
        
        Return ONLY valid JSON matching this exact structure:
        {
          "hero": { "greeting": "Hi, I'm...", "tagline": "..." },
          "about": "A short, engaging bio...",
          "projects": [
            { "name": "Project 1", "description": "..." },
            { "name": "Project 2", "description": "..." }
          ],
          "skills": ["Skill 1", "Skill 2", "Skill 3"]
        }`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.7-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                // Passing the requested thinking level
                thinkingConfig: { level: "medium" } 
            }
        });

        // Parse the response (text is a property in the new SDK)
        const generatedJSON = JSON.parse(response.text);

        res.status(200).json(generatedJSON);
    } catch (error) {
        console.error("Generation error:", error);
        res.status(500).json({ error: 'Failed to generate portfolio' });
    }
}
