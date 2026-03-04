import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import cors from 'cors';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import dotenv from 'dotenv';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// Load environment variables
dotenv.config();

// Setup SQLite database
const dbPath = path.join(process.cwd(), 'optk.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS optk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scientific_name TEXT UNIQUE,
    data TEXT,
    lang TEXT
  );
  CREATE TABLE IF NOT EXISTS optk_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    optk_id INTEGER,
    image_url TEXT,
    FOREIGN KEY (optk_id) REFERENCES optk(id)
  );
`);

const HISTORY_FILE = path.join(process.cwd(), 'history.json');
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([]), 'utf-8');
}

const getHistory = () => JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
const saveToHistory = (data: any) => fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Limit file size to 2MB to prevent memory issues and speed up AI processing
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } 
});

// List of API keys for rotation
const API_KEYS = [
  'AIzaSyCPiyUbHCm2Nhxv_xTPGPg06dzX9r6Ttjo',
  'AIzaSyDDsnw_xOZS8TXNoifE6FHeJZvyTqZTcOA',
  'AIzaSyAu_7n94HMMtVuSyzUuvqcNhOrLNqWKLeg',
  'AIzaSyC-sgIabJ3G5742-izKi-9zvDn3yU9M5kA',
  'AIzaSyD2zBsvUgx6s3MpGpUSQ3MpyJmA5S13Gik',
  'AIzaSyAlHXARtWyaYmeSm7BGIFmK3BbP8qRFXGY',
  'AIzaSyBQNMkgVMyN0gig-PddGn-eJOx2cE38TN8',
  'AIzaSyDBAOCUAKUd6Bb2_vBSl2yrxtDYagZV6Hs',
  'AIzaSyAP6e3xFfkt_twV_15xl6nAZ40XFEXX42w',
  'AIzaSyAeHul15N8gK1Yvp8WvQH8L4UuvT9vElO4',
  'AIzaSyC0WLWY4szX_iFwBKygIECB4DYWCJA0b0c',
  'AIzaSyCf7eG4nTchrPokmj8ukk3PaeyjSESzlQs'
];

// Fallback models in case of quota exhaustion
const MODELS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
  "gemini-3.1-pro-preview"
];

// Current key index for rotation (global to persist across requests)
let currentKeyIndex = 0;

// Function to try AI call with rotation and model fallback
const tryAIWithRotation = async (startIndex: number, attempts: number = 1, modelIndex: number = 0, isFastCheck: boolean = false, lang: 'id' | 'en' = 'id', customPrompt?: string, imagePart?: any): Promise<any> => {
  const safeAttempts = Math.max(1, attempts);
  const index = (startIndex + (safeAttempts - 1)) % API_KEYS.length;
  const rawKey = API_KEYS[index];
  if (!rawKey) {
    throw new Error(`API Key at index ${index} is undefined. API_KEYS length: ${API_KEYS.length}`);
  }
  const apiKey = rawKey.trim();
  const modelName = MODELS[modelIndex % MODELS.length];
  
  console.log(`[${new Date().toISOString()}] Attempt ${attempts} using API Key Index ${index} with model ${modelName} (Fast Check: ${isFastCheck}, Lang: ${lang})`);
  
  try {
    const ai = new GoogleGenAI({ apiKey: apiKey });
    
    let config: any = {};
    let prompt = customPrompt || '';

    if (!customPrompt) {
      if (isFastCheck) {
        prompt = `Identifikasi serangga ini. Hanya kembalikan nama ilmiahnya saja (contoh: "Bactrocera dorsalis"). Jika tidak tahu, kembalikan "UNKNOWN".`;
        config = {
          responseMimeType: "text/plain",
        };
      } else {
        if (lang === 'en') {
          prompt = `Identify this insect quickly and accurately.
Use Google Search to verify the latest data, especially distribution maps and quarantine status.
Analyze the image to determine if it is a Quarantine Pest (OPTK) A1, A2, or Regulated Non-Quarantine Pest (OPT) based on the Decree of the Head of the Indonesian Quarantine Agency Number 571 of 2025 (Kepkaban 571/2025), CABI, EPPO, and IPPC. You must refer to your knowledge of these documents to determine the quarantine status (OPTK A1/A2/OPT) and related regulations.

VERY IMPORTANT: Complete all taxonomy levels from Kingdom to Species (do not leave any blank). If unsure, provide the closest taxonomy based on visual identification. You must fill in kingdom, phylum, class, order_name, family, genus, and species.
Use concise, essential, and technical bullet points (max 3-4 points per section).

MITIGATION AND TREATMENT INSTRUCTIONS (MUST BE STRUCTURED WITH NUMBERING 1., 2., 3., etc.):
- Farmer Level Mitigation (if OPT/OPTK): Detail control methods using biological agents, chemicals, natural enemies, or other cultivation methods based on domestic journals and research.
- Inter-Area/Domestic Mitigation (if OPTK A2): Detail steps to prevent domestic spread.
- Export & Import Quarantine Treatment (if OPTK A1/A2): Explain in detail quarantine treatment actions based on international research journals and recommendations from the Indonesian Quarantine Agency. MUST include the success rate of the treatment in percentage (e.g., "Success rate 99.9%").
(Note: Do not use markdown formatting like **bold** or *italic* in this mitigation section, just use plain text with new line numbering).

DISTRIBUTION MAP: Find the URL of the latest distribution map image from official sources like EPPO Global Database, CABI Compendium, or IPPC. If there is no direct image URL, provide the URL of the interactive map page.

JSON Schema:
{
  "scientific_name": "Scientific name",
  "taxonomy": { 
    "kingdom": "Animalia", 
    "phylum": "Arthropoda", 
    "class": "Insecta", 
    "subclass": "Pterygota", 
    "order_name": "...", 
    "family": "...", 
    "genus": "...", 
    "species": "..." 
  },
  "taxonomy_explanation": "Brief explanation.",
  "quarantine_status": "OPTK A1/A2/OPT",
  "regulatory_status": "Status",
  "regulation_description": "Brief description.",
  "risk_level": "CRITICAL/HIGH/LOW",
  "risk_details": { "potential_damage": "...", "spread_rate": "...", "economic_impact": "...", "reasoning": "..." },
  "mitigation": { 
    "farmer_level": "1. Biological Agents: ...\\n2. Chemical: ...\\n3. Natural Enemies: ...", 
    "domestic": "1. ...\\n2. ...",
    "export": "1. Fumigation Treatment: ... (Success rate: 99.9%)\\n2. ...", 
    "import": "1. Heat Treatment: ... (Success rate: 100%)\\n2. ..." 
  },
  "mitigation_summary": "Very brief summary.",
  "quarantine_actions": ["Essential action 1", "Essential action 2"],
  "distribution_map_url": "Direct image URL (.png/.jpg) from EPPO/CABI if available",
  "distribution_map_page_url": "URL of the interactive map page on EPPO Global Database (gd.eppo.int)",
  "references": [{ "title": "Scopus Ref", "url": "URL" }],
  "decision_summary": "Decision.",
  "treatment_guide": {
    "media_type": "Carrier media type (e.g., Seeds, Fruit, Wood)",
    "treatment_method": "Main method (e.g., Fumigation, Heat Treatment)",
    "steps": [
      { "step_number": 1, "title": "Step Title", "description": "Detailed step description.", "technical_details": "Technical parameters (temp/dose/duration).", "video_url": "YouTube demonstration/tutorial video URL if available" }
    ]
  }
}`;
        } else {
          prompt = `Identifikasi serangga ini secara cepat dan akurat.
Gunakan Google Search untuk memverifikasi data terbaru, terutama peta sebaran dan status karantina.
Analisa gambar apakah termasuk OPTK A1, OPTK A2, atau OPT berdasarkan Keputusan Kepala Badan Karantina Indonesia Nomor 571 Tahun 2025 (Kepkaban 571/2025), CABI, EPPO, dan IPPC. Wajib merujuk pada pengetahuan Anda tentang dokumen tersebut untuk menentukan status karantina (OPTK A1/A2/OPT) dan regulasi terkait.

SANGAT PENTING: Lengkapi seluruh tingkatan taksonomi dari Kingdom sampai Spesies (jangan ada yang kosong). Jika tidak yakin, berikan taksonomi yang paling mendekati berdasarkan identifikasi visual. Wajib mengisi kingdom, phylum, class, order_name, family, genus, and species.
Gunakan poin-poin padat, esensial, dan teknis (maksimal 3-4 poin per bagian).

INSTRUKSI MITIGASI DAN PERLAKUAN (WAJIB TERSTRUKTUR DENGAN PENOMORAN KE BAWAH 1., 2., 3., dst):
- Mitigasi Tingkat Petani (jika OPT/OPTK): Jabarkan dengan mendetail cara pengendalian menggunakan agensia hayati, kimiawi, musuh alami, atau cara budidaya lainnya berdasarkan jurnal dan penelitian dalam negeri.
- Mitigasi Antar Wilayah/Domestik (jika OPTK A2): Jabarkan langkah pencegahan penyebaran domestik dengan mendetail.
- Perlakuan Karantina Ekspor & Impor (jika OPTK A1/A2): Jelaskan dengan mendetail tindakan perlakuan karantina berdasarkan jurnal penelitian internasional dan rekomendasi Badan Karantina Indonesia. WAJIB sertakan tingkat keberhasilan perlakuan tersebut dalam persentase (misal: "Tingkat keberhasilan 99.9%").
(Catatan: Jangan gunakan format markdown seperti **tebal** atau *miring* pada bagian mitigasi ini, cukup gunakan teks biasa dengan penomoran baris baru).

PETA SEBARAN: Cari URL gambar peta sebaran terbaru dari sumber resmi seperti EPPO Global Database, CABI Compendium, atau IPPC. Jika tidak ada URL gambar langsung, berikan URL halaman peta interaktifnya.

Skema JSON:
{
  "scientific_name": "Nama ilmiah",
  "taxonomy": { 
    "kingdom": "Animalia", 
    "phylum": "Arthropoda", 
    "class": "Insecta", 
    "subclass": "Pterygota", 
    "order_name": "...", 
    "family": "...", 
    "genus": "...", 
    "species": "..." 
  },
  "taxonomy_explanation": "Singkat.",
  "quarantine_status": "OPTK A1/A2/OPT",
  "regulatory_status": "Status",
  "regulation_description": "Singkat.",
  "risk_level": "CRITICAL/HIGH/LOW",
  "risk_details": { "potential_damage": "...", "spread_rate": "...", "economic_impact": "...", "reasoning": "..." },
  "mitigation": { 
    "farmer_level": "1. Agensia Hayati: ...\\n2. Kimiawi: ...\\n3. Musuh Alami: ...", 
    "domestic": "1. ...\\n2. ...",
    "export": "1. Perlakuan Fumigasi: ... (Tingkat keberhasilan: 99.9%)\\n2. ...", 
    "import": "1. Perlakuan Panas: ... (Tingkat keberhasilan: 100%)\\n2. ..." 
  },
  "mitigation_summary": "Ringkasan sangat singkat.",
  "quarantine_actions": ["Tindakan esensial 1", "Tindakan esensial 2"],
  "distribution_map_url": "URL gambar langsung (.png/.jpg) dari EPPO/CABI jika tersedia",
  "distribution_map_page_url": "URL halaman peta interaktif di EPPO Global Database (gd.eppo.int)",
  "references": [{ "title": "Scopus Ref", "url": "URL" }],
  "decision_summary": "Keputusan.",
  "treatment_guide": {
    "media_type": "Jenis media pembawa (misal: Benih, Buah, Kayu)",
    "treatment_method": "Metode utama (misal: Fumigasi, Perlakuan Panas)",
    "steps": [
      { "step_number": 1, "title": "Judul Langkah", "description": "Penjelasan detail langkah.", "technical_details": "Parameter teknis (suhu/dosis/durasi).", "video_url": "URL video demonstrasi/tutorial YouTube jika ada" }
    ]
  }
}`;
        }

        config = {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              scientific_name: { type: Type.STRING },
              taxonomy: {
                type: Type.OBJECT,
                properties: {
                  kingdom: { type: Type.STRING },
                  phylum: { type: Type.STRING },
                  class: { type: Type.STRING },
                  subclass: { type: Type.STRING },
                  order_name: { type: Type.STRING },
                  family: { type: Type.STRING },
                  genus: { type: Type.STRING },
                  species: { type: Type.STRING }
                },
                required: ["kingdom", "phylum", "class", "order_name", "family", "genus", "species"]
              },
              taxonomy_explanation: { type: Type.STRING },
              quarantine_status: { type: Type.STRING },
              regulatory_status: { type: Type.STRING },
              regulation_description: { type: Type.STRING },
              risk_level: { type: Type.STRING },
              risk_details: {
                type: Type.OBJECT,
                properties: {
                  potential_damage: { type: Type.STRING },
                  spread_rate: { type: Type.STRING },
                  economic_impact: { type: Type.STRING },
                  reasoning: { type: Type.STRING }
                }
              },
              mitigation: {
                type: Type.OBJECT,
                properties: {
                  farmer_level: { type: Type.STRING },
                  domestic: { type: Type.STRING },
                  export: { type: Type.STRING },
                  import: { type: Type.STRING }
                }
              },
              mitigation_summary: { type: Type.STRING },
              quarantine_actions: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              distribution_map_url: { type: Type.STRING },
              distribution_map_page_url: { type: Type.STRING },
              references: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    url: { type: Type.STRING }
                  }
                }
              },
              integrated_sources: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    url: { type: Type.STRING }
                  }
                }
              },
              source_databases: {
                type: Type.OBJECT,
                properties: {
                  cabi: { type: Type.STRING },
                  eppo: { type: Type.STRING },
                  ippc: { type: Type.STRING }
                }
              },
              confidence_score: { type: Type.NUMBER },
              decision_summary: { type: Type.STRING },
              treatment_guide: {
                type: Type.OBJECT,
                properties: {
                  media_type: { type: Type.STRING },
                  treatment_method: { type: Type.STRING },
                  steps: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        step_number: { type: Type.NUMBER },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        technical_details: { type: Type.STRING },
                        video_url: { type: Type.STRING }
                      },
                      required: ["step_number", "title", "description"]
                    }
                  }
                },
                required: ["media_type", "treatment_method", "steps"]
              }
            },
            required: ["scientific_name", "taxonomy", "taxonomy_explanation", "quarantine_status", "regulatory_status", "risk_level", "risk_details", "mitigation", "mitigation_summary", "references", "integrated_sources", "source_databases", "confidence_score", "decision_summary", "regulation_description", "quarantine_actions"]
          }
        };
      }
    }

    // Only Gemini 3 models support thinkingConfig
    if (modelName.includes('gemini-3') && modelName.includes('pro')) {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }

    const contents: any = { parts: [] };
    if (imagePart) contents.parts.push(imagePart);
    contents.parts.push({ text: prompt });

    const aiPromise = ai.models.generateContent({
      model: modelName,
      contents: contents,
      config: config
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI Call Timeout')), 90000)
    );

    const response = await Promise.race([aiPromise, timeoutPromise]) as any;
    currentKeyIndex = index;
    return response;
  } catch (error: any) {
    const msg = String(error.message || '').toLowerCase();
    const isQuotaError = msg.includes('quota') || msg.includes('exhausted') || msg.includes('429');
    const isTimeoutError = msg.includes('timeout');
    const isAuthError = msg.includes('api key not found') || msg.includes('invalid') || msg.includes('403') || msg.includes('401') || msg.includes('permission');
    const isModelError = msg.includes('not found') || msg.includes('not supported');
    const isUnavailableError = msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') || msg.includes('overloaded');
    
    // Use regex to detect limit: 0 more robustly (handles spaces, colons, etc)
    const isZeroLimit = /limit\D*0/.test(msg) || msg.includes('limit: 0') || msg.includes('limit:0');
    
    if (isZeroLimit) {
      console.warn(`[${new Date().toISOString()}] Model ${modelName} hit limit: 0. Message: ${msg.substring(0, 100)}...`);
    }

    console.warn(`[${new Date().toISOString()}] API Error on Key ${index} (${modelName}): ${error.message}`);
    
    if ((isQuotaError || isTimeoutError || isAuthError || isModelError || isUnavailableError)) {
      // If it's a quota error, we might want to move the currentKeyIndex forward for future requests
      if (isQuotaError && attempts === 1) {
        currentKeyIndex = (index + 1) % API_KEYS.length;
      }

      console.warn(`[${new Date().toISOString()}] Key ${index} failed (${isQuotaError ? 'Quota' : isTimeoutError ? 'Timeout' : isAuthError ? 'Auth' : isUnavailableError ? 'Unavailable' : 'Model'}). Rotating...`);
      
      // If quota error, switch model immediately (after 1 key) because keys share project quota
      // If model not found or limit is 0, switch immediately
      const maxAttemptsForKey = (isZeroLimit || isModelError || isQuotaError) ? 1 : API_KEYS.length;

      // If all keys exhausted for current model, OR if the limit is 0, OR if the model is unavailable/timing out, try next model
      if (attempts >= maxAttemptsForKey || isZeroLimit || isUnavailableError || isTimeoutError || isModelError) {
        if (modelIndex < MODELS.length - 1) {
          console.log(`[${new Date().toISOString()}] ${isZeroLimit ? 'Model disabled (limit: 0)' : isUnavailableError ? 'Model unavailable' : isTimeoutError ? 'Model timeout' : 'All keys exhausted'} for ${modelName}. Switching to ${MODELS[modelIndex + 1]}`);
          // Wait longer before switching models to allow quota to reset (only if not zero limit)
          if (isQuotaError && !isZeroLimit) await new Promise(r => setTimeout(r, 5000));
          // Reset attempts to 1 for the new model, but keep the startIndex to continue rotating keys
          return tryAIWithRotation(startIndex, 1, modelIndex + 1, isFastCheck, lang, customPrompt, imagePart);
        } else {
          if (isZeroLimit) {
            throw new Error("API_QUOTA_EXCEEDED_ZERO");
          }
          if (isUnavailableError) {
            throw new Error("API_UNAVAILABLE");
          }
          if (isTimeoutError) {
            throw new Error("API_TIMEOUT");
          }
          throw new Error("API_QUOTA_EXCEEDED");
        }
      } else {
        // Wait longer if it's a rate limit (429) to allow the quota bucket to refill
        if (isQuotaError) await new Promise(r => setTimeout(r, 2000));
        return tryAIWithRotation(startIndex, attempts + 1, modelIndex, isFastCheck, lang, customPrompt, imagePart);
      }
    }
    throw error;
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json());

  // Session priming endpoint to help with "Cookie check" issues in iframes
  app.get('/api/ping', (req, res) => {
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc;">
          <div style="text-align: center; padding: 20px; background: white; border-radius: 12px; shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
            <h2 style="color: #059669; margin-bottom: 8px;">Koneksi Diperbaiki</h2>
            <p style="color: #475569; font-size: 14px;">Sesi Anda telah diperbarui. Jendela ini akan tertutup otomatis...</p>
            <script>
              setTimeout(() => {
                window.close();
              }, 1000);
            </script>
          </div>
        </body>
      </html>
    `);
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
  });

  // Get identification history
  app.get('/api/history', (req, res) => {
    try {
      res.json(getHistory());
    } catch (error) {
      res.status(500).json({ error: 'Gagal mengambil data riwayat.' });
    }
  });

  app.post('/api/translate-report', express.json(), async (req, res) => {
    const { report, targetLang } = req.body;
    if (!report || !targetLang) {
      return res.status(400).json({ error: 'Missing report or targetLang' });
    }

    try {
      const langName = targetLang === 'id' ? 'Indonesian' : 'English';
      const prompt = `Translate the following JSON quarantine pest report into ${langName}. 
      Keep all scientific names, URLs, and numeric values exactly as they are. 
      Translate all descriptive text, explanations, and summaries.
      Maintain the exact same JSON structure.
      
      JSON to translate:
      ${JSON.stringify(report)}
      
      Return ONLY the translated JSON object.`;

      const response = await tryAIWithRotation(currentKeyIndex, 1, 0, false, targetLang, prompt);
      let translatedText = response.text;
      
      if (translatedText) {
        translatedText = translatedText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const jsonMatch = translatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          translatedText = jsonMatch[0];
        }
        const translatedReport = JSON.parse(translatedText);
        translatedReport.lang = targetLang;
        res.json(translatedReport);
      } else {
        res.status(500).json({ error: 'Translation failed' });
      }
    } catch (error) {
      console.error('Translation error:', error);
      res.status(500).json({ error: 'Gagal menerjemahkan laporan.' });
    }
  });

  // Wrapper for multer to catch file size errors
  const uploadMiddleware = (req: any, res: any, next: any) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Ukuran gambar terlalu besar. Maksimal 2MB.' });
        }
        return res.status(400).json({ error: `Kesalahan unggah: ${err.message}` });
      } else if (err) {
        return res.status(500).json({ error: `Kesalahan server: ${err.message}` });
      }
      next();
    });
  };

  app.post('/api/detect-insect', uploadMiddleware, async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const processedImageBuffer = await sharp(req.file.buffer)
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .normalize() // Enhance contrast
        .sharpen() // Sharpen the image for better feature extraction
        .jpeg({ quality: 85 }) // Convert to JPEG to save bandwidth
        .toBuffer();

      const base64EncodeString = processedImageBuffer.toString('base64');
      const mimeType = 'image/jpeg';

      const imagePart = {
        inlineData: {
          mimeType: mimeType,
          data: base64EncodeString,
        },
      };

      // Extract language from request body (default to 'id')
      const lang = (req.body.lang === 'en') ? 'en' : 'id';

      // Step 1 & 2: Fast check and Database lookup (Optional/Resilient)
      let identifiedName = '';
      try {
        // Skip fast check if we are low on quota to save requests
        // Only do fast check if we have a healthy history or explicitly requested
        console.log(`[${new Date().toISOString()}] Performing fast check for database lookup...`);
        // Use model index 0 (flash-lite) for fast check
        const fastResponse = await tryAIWithRotation(currentKeyIndex, 1, 0, true, lang, undefined, imagePart);
        identifiedName = fastResponse.text?.trim() || '';
        
        if (identifiedName && identifiedName !== 'UNKNOWN') {
          const stmt = db.prepare('SELECT data, lang FROM optk WHERE scientific_name = ?');
          const row = stmt.get(identifiedName) as { data: string, lang: string } | undefined;
          
          if (row && row.lang === lang) {
            console.log(`[${new Date().toISOString()}] Found ${identifiedName} in database (${lang}). Returning cached result.`);
            return res.json(JSON.parse(row.data));
          }
        }
      } catch (fastCheckError) {
        console.warn(`[${new Date().toISOString()}] Fast check/DB lookup failed or skipped:`, fastCheckError instanceof Error ? fastCheckError.message : 'Unknown error');
        // We don't throw here, just proceed to full analysis
      }

      // Step 3: If not in database or fast check failed, do full analysis
      console.log(`[${new Date().toISOString()}] Proceeding with full analysis...`);
      const response = await tryAIWithRotation(currentKeyIndex, 1, 0, false, lang, undefined, imagePart);

      console.log(`[${new Date().toISOString()}] AI full analysis completed successfully.`);
      
      let reportText = response.text;
      if (reportText) {
        // Clean up potential markdown formatting
        reportText = reportText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        
        // Extract JSON block if there's extra text
        const jsonMatch = reportText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          reportText = jsonMatch[0];
        }
        
        try {
          // Robust JSON extraction
          let cleanText = reportText.trim();
          if (cleanText.includes('```')) {
            cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          }
          
          const start = cleanText.indexOf('{');
          const end = cleanText.lastIndexOf('}');
          if (start !== -1 && end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
          }

          // Check for basic JSON completeness
          if (!cleanText.startsWith('{') || !cleanText.endsWith('}')) {
            throw new Error('Incomplete JSON response from AI');
          }

          const report = JSON.parse(cleanText);
          
          // Step 4: Save to database
          if (report.scientific_name) {
            // Use a transaction for atomic update
            const saveTransaction = db.transaction((reportData, langCode) => {
              // Check if scientific_name already exists to get its ID
              const existing = db.prepare('SELECT id FROM optk WHERE scientific_name = ?').get(reportData.scientific_name) as { id: number } | undefined;
              
              let optkId: number | bigint;
              if (existing) {
                optkId = existing.id;
                // Update existing record
                db.prepare('UPDATE optk SET data = ?, lang = ? WHERE id = ?').run(JSON.stringify(reportData), langCode, optkId);
              } else {
                // Insert new record
                const result = db.prepare('INSERT INTO optk (scientific_name, data, lang) VALUES (?, ?, ?)').run(reportData.scientific_name, JSON.stringify(reportData), langCode);
                optkId = result.lastInsertRowid;
              }

              // Clear old photos to prevent duplicates
              db.prepare('DELETE FROM optk_photos WHERE optk_id = ?').run(optkId);

              // Save new photos (if any)
              if (reportData.additional_images && reportData.additional_images.length > 0) {
                const insertPhoto = db.prepare('INSERT INTO optk_photos (optk_id, image_url) VALUES (?, ?)');
                for (const url of reportData.additional_images) {
                  insertPhoto.run(optkId, url);
                }
              }
              return optkId;
            });

            saveTransaction(report, lang);
            console.log(`[${new Date().toISOString()}] Saved/Updated ${report.scientific_name} in database (${lang}).`);

            // Step 5: Save to history for visualization
            const history = getHistory();
            history.push({
              timestamp: new Date().toISOString(),
              scientific_name: report.scientific_name,
              quarantine_status: report.quarantine_status,
              risk_level: report.risk_level,
              region: req.body.region || 'Jakarta'
            });
            saveToHistory(history);
          }

          res.json(report);
        } catch (parseError) {
          console.error('Failed to parse JSON from AI. Raw response snippet:', reportText.substring(0, 200));
          console.error('Parse Error:', parseError);
          res.status(500).json({ error: 'AI mengembalikan format data yang tidak valid. Silakan coba lagi.' });
        }
      } else {
        res.status(500).json({ error: 'AI tidak mengembalikan laporan apa pun.' });
      }

    } catch (error: any) {
      console.error('Error processing image with Gemini:', error);
      
      // Extract more specific error message if available
      let errorMessage = 'Terjadi kesalahan internal saat menganalisis gambar.';
      
      if (error && error.message) {
        const msg = String(error.message).toLowerCase();
        if (msg.includes('api key not valid') || msg.includes('api_key_invalid')) {
          errorMessage = 'API Key Gemini tidak valid atau sudah tidak aktif. Pastikan Anda menggunakan API Key yang benar dari Google AI Studio.';
        } else if (msg.includes('not found') && msg.includes('api key')) {
          errorMessage = 'API Key tidak ditemukan oleh sistem Google. Silakan periksa kembali konfigurasi API Key Anda.';
        } else if (msg.includes('quota') || msg.includes('exhausted') || msg.includes('429')) {
          errorMessage = 'Kuota API Key Gemini Anda telah habis atau terlalu banyak permintaan (Rate Limit). Silakan coba lagi nanti atau gunakan API Key lain.';
        } else if (msg.includes('timeout') || msg.includes('aborted')) {
          errorMessage = 'Koneksi ke AI terputus karena terlalu lama (Timeout). Silakan coba unggah gambar dengan ukuran lebih kecil.';
        } else {
          errorMessage = `Kesalahan AI: ${error.message}`;
        }
      }
      
      // Only send response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ error: errorMessage });
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Global error handler caught:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Terjadi kesalahan sistem yang tidak terduga.' });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
