const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json({ limit: '10mb' }));

// ========= CONFIGURATION =========
const IMAGEBB_API_KEY = 'YOUR_IMAGEBB_API_KEY';  // Replace with your key
const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY';    // Replace with your key
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ========= HELPER: Upload to ImageBB =========
async function uploadToImageBB(imageData, isBase64 = false) {
  let form = new FormData();
  
  if (isBase64) {
    // Remove data:image/xxx;base64, prefix if present
    const base64String = imageData.includes('base64,') 
      ? imageData.split('base64,')[1] 
      : imageData;
    form.append('image', base64String);
  } else {
    // Direct URL - download image first
    const response = await axios.get(imageData, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');
    form.append('image', buffer.toString('base64'));
  }
  
  form.append('key', IMAGEBB_API_KEY);
  
  const result = await axios.post('https://api.imgbb.com/1/upload', form, {
    headers: form.getHeaders()
  });
  
  return result.data.data.url; // Direct image link
}

// ========= HELPER: Extract text via Gemini =========
async function extractCaptchaFromImage(imageUrl) {
  const prompt = `You are a CAPTCHA solver. Look at this image carefully. 
  Extract ONLY the exact text shown in the CAPTCHA image. 
  Return ONLY valid JSON in this format: {"captcha_text": "extracted_text_here"}
  Do NOT add any extra explanation, spaces, or formatting. Just the JSON.`;
  
  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: "image/jpeg",
            data: await getImageAsBase64(imageUrl)
          }
        }
      ]
    }]
  };
  
  const response = await axios.post(GEMINI_URL, requestBody);
  const rawText = response.data.candidates[0].content.parts[0].text;
  
  // Extract JSON from response (Gemini sometimes adds markdown)
  const jsonMatch = rawText.match(/\{.*\}/s);
  return JSON.parse(jsonMatch[0]);
}

async function getImageAsBase64(imageUrl) {
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data, 'binary').toString('base64');
}

// ========= MAIN API ENDPOINT =========
app.post('/extract-captcha', upload.single('image'), async (req, res) => {
  try {
    let imageUrl;
    
    // Case 1: Direct image URL
    if (req.body.imageUrl) {
      imageUrl = await uploadToImageBB(req.body.imageUrl, false);
    }
    // Case 2: Base64 image
    else if (req.body.base64Image) {
      imageUrl = await uploadToImageBB(req.body.base64Image, true);
    }
    // Case 3: File upload (multipart/form-data)
    else if (req.file) {
      const base64 = req.file.buffer.toString('base64');
      imageUrl = await uploadToImageBB(base64, true);
    }
    else {
      return res.status(400).json({ error: "Provide imageUrl, base64Image, or upload file" });
    }
    
    // Extract text using Gemini
    const result = await extractCaptchaFromImage(imageUrl);
    
    res.json({
      success: true,
      imagebb_link: imageUrl,
      extracted_captcha: result.captcha_text
    });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========= TEST ENDPOINT =========
app.get('/', (req, res) => {
  res.send(`
    <h2>CAPTCHA Extractor API</h2>
    <p>POST to /extract-captcha with:</p>
    <ul>
      <li><code>{ "imageUrl": "https://example.com/captcha.jpg" }</code></li>
      <li><code>{ "base64Image": "data:image/png;base64,iVBOR..." }</code></li>
      <li>Or multipart form-data with field name "image"</li>
    </ul>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
