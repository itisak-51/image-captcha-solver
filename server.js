const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// ========= SECURITY & MIDDLEWARE FIXES =========
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API flexibility,
}));
app.use(cors()); // Enable CORS for all routes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Memory storage for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ========= CONFIGURATION =========
// IMPORTANT: Replace these with your actual keys
const IMAGEBB_API_KEY = process.env.IMAGEBB_API_KEY || 'YOUR_IMAGEBB_API_KEY_HERE';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ========= HEALTH CHECK ENDPOINT (For SSL/Proxy testing) =========
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production'
  });
});

// ========= HELPER: Upload to ImageBB =========
async function uploadToImageBB(imageData, isBase64 = false) {
  try {
    let form = new FormData();
    let imageToUpload;
    
    if (isBase64) {
      // Clean base64 string
      let base64String = imageData;
      if (imageData.includes('base64,')) {
        base64String = imageData.split('base64,')[1];
      }
      imageToUpload = base64String;
    } else {
      // Download image from URL
      const response = await axios.get(imageData, { 
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CaptchaExtractor/1.0)'
        }
      });
      imageToUpload = Buffer.from(response.data, 'binary').toString('base64');
    }
    
    form.append('image', imageToUpload);
    form.append('key', IMAGEBB_API_KEY);
    
    const result = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: { ...form.getHeaders() },
      timeout: 30000
    });
    
    if (!result.data || !result.data.data || !result.data.data.url) {
      throw new Error('ImageBB upload failed: Invalid response');
    }
    
    return result.data.data.url;
  } catch (error) {
    console.error('ImageBB Upload Error:', error.message);
    throw new Error(`Image upload failed: ${error.message}`);
  }
}

// ========= HELPER: Download image and convert to base64 =========
async function getImageAsBase64(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CaptchaExtractor/1.0)'
      }
    });
    return Buffer.from(response.data, 'binary').toString('base64');
  } catch (error) {
    console.error('Image Download Error:', error.message);
    throw new Error(`Failed to download image: ${error.message}`);
  }
}

// ========= HELPER: Extract captcha text using Gemini =========
async function extractCaptchaFromImage(imageUrl) {
  try {
    const prompt = `You are a precise CAPTCHA solver. Analyze the image carefully.
    Extract ONLY the exact text from the CAPTCHA image.
    Return ONLY valid JSON in this exact format: {"captcha_text": "extracted_text_here"}
    Do NOT add any extra words, explanations, or formatting. Just the JSON object.`;
    
    const imageBase64 = await getImageAsBase64(imageUrl);
    
    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/png",
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.0,  // Minimal randomness for accuracy
        topP: 0.1,
        topK: 1
      }
    };
    
    const response = await axios.post(GEMINI_URL, requestBody, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.data || !response.data.candidates || !response.data.candidates[0]) {
      throw new Error('Gemini API returned empty response');
    }
    
    const rawText = response.data.candidates[0].content.parts[0].text;
    
    // Extract JSON from response (handle markdown code blocks)
    let jsonMatch = rawText.match(/\{.*\}/s);
    if (!jsonMatch) {
      // If no JSON found, try to extract just the text
      return { captcha_text: rawText.trim() };
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    return { captcha_text: parsed.captcha_text || parsed.text || parsed.result };
    
  } catch (error) {
    console.error('Gemini API Error:', error.message);
    if (error.response) {
      console.error('Gemini Response:', error.response.data);
    }
    throw new Error(`Text extraction failed: ${error.message}`);
  }
}

// ========= MAIN API ENDPOINT =========
app.post('/extract-captcha', upload.single('image'), async (req, res) => {
  try {
    let imageUrl;
    let inputType = 'unknown';
    
    // Case 1: Direct image URL
    if (req.body.imageUrl) {
      inputType = 'url';
      imageUrl = await uploadToImageBB(req.body.imageUrl, false);
    }
    // Case 2: Base64 image
    else if (req.body.base64Image) {
      inputType = 'base64';
      imageUrl = await uploadToImageBB(req.body.base64Image, true);
    }
    // Case 3: File upload (multipart/form-data)
    else if (req.file) {
      inputType = 'file';
      const base64 = req.file.buffer.toString('base64');
      imageUrl = await uploadToImageBB(base64, true);
    }
    else {
      return res.status(400).json({ 
        success: false, 
        error: "Please provide either 'imageUrl', 'base64Image', or upload an image file" 
      });
    }
    
    // Extract text using Gemini
    const result = await extractCaptchaFromImage(imageUrl);
    
    res.json({
      success: true,
      input_type: inputType,
      imagebb_link: imageUrl,
      extracted_captcha: result.captcha_text,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ========= SIMPLE TEST ENDPOINT =========
app.get('/', (req, res) => {
  res.json({
    service: 'CAPTCHA Extractor API',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      extract: 'POST /extract-captcha',
      docs: 'GET /'
    },
    usage: {
      json: { imageUrl: 'https://example.com/captcha.jpg' },
      json: { base64Image: 'data:image/png;base64,...' },
      formData: { fieldName: 'image' }
    }
  });
});

// ========= PORT CONFIGURATION (Fixed for Cloudflare) =========
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces

const server = app.listen(PORT, HOST, () => {
  console.log(`✅ Server is running on http://${HOST}:${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app; // For testing
