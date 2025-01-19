const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const speech = require('@google-cloud/speech');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose'); // MongoDB integration
const Blog = require('./models/Blog'); // Import the Blog model
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_KEY);
// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Initialize Google Cloud Speech client
const speechClient = new speech.SpeechClient({
    credentials: {
        type: "service_account",
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: process.env.GOOGLE_AUTH_URI,
        token_uri: process.env.GOOGLE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
        client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
    },
    projectId: process.env.GOOGLE_PROJECT_ID
});

// Configure multer for handling file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'video/mp4') {
            cb(null, true);
        } else {
            cb(new Error('Only MP4 files are allowed'));
        }
    },
    limits: {
        fileSize: 25 * 1024 * 1024 // 25MB limit
    }
});

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Health check route
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Transcription route
app.post('/transcribe', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        const inputPath = req.file.path;
        const outputPath = path.join('uploads', `${path.parse(req.file.filename).name}.wav`);

        // Convert video to audio
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('wav')
                .audioChannels(1)
                .audioFrequency(16000)
                .on('error', (err) => reject(err))
                .on('end', () => resolve())
                .save(outputPath);
        });

        // Read the audio file
        const audioBytes = fs.readFileSync(outputPath).toString('base64');

        // Configure the request
        const audio = {
            content: audioBytes,
        };
        const config = {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'en-US',
            enableAutomaticPunctuation: true,
            model: 'video',
            useEnhanced: true,
        };

        const request = {
            audio: audio,
            config: config,
        };

        // Perform the transcription
        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        // Clean up files
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);

        res.json({
            transcript: transcription
        });

    } catch (error) {
        console.error('Transcription error:', error);
        res.status(500).json({ error: error.message });
    }
});


// Save blog to database
app.post('/save-blog', async (req, res) => {
    try {
        const { title, content } = req.body;
        console.log(`This is the body you are trying to push ${req.body}`)
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required.' });
        }

        const blog = new Blog({ title, content });
        await blog.save();

        res.status(201).json({ message: 'Blog saved successfully!', blog });
    } catch (error) {
        console.error('Error saving blog:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// Blog generation route
app.post('/generate-blog', async (req, res) => {
    try {
        const { transcript } = req.body;

        if (!transcript) {
            return res.status(400).json({ error: 'No transcript provided' });
        }

        const prompt = `
        Task: Convert the following transcript into blog articles in multiple languages.

        Transcript: "${transcript}"

        Instructions:
        1. Create blog articles based on this transcript.
        2. Provide a separate title  
        3. Adapt the response according to the content appropriately 
        4. Maintain the key message 
        5. Do not geneate for any other langauage except english. This is to be strcitly followed.

        Respond ONLY with a valid JSON object in exactly this format:
        {
            "english": {
                "title": "Title in English",
                "content": "Content in English"
            }
        }

        The response must be valid JSON. Do not include additional text, explanations, or markdown formatting.
`;

        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const { response } = await model.generateContent(prompt);

        if (!response || typeof response.text !== 'function') {
            throw new Error('Unexpected response structure from the Generative AI model.');
        }

        const rawText = response.text();
        console.log('Raw AI Response:', rawText);

        // Sanitize and extract valid JSON
        let cleanText = rawText
            .replace(/```json|```/g, '') // Remove markdown
            .trim(); // Remove leading/trailing spaces
        
        console.log('Cleaned Response:', cleanText); // <-- Log this to check sanitized output

        // Ensure text starts and ends with valid JSON brackets
        cleanText = cleanText.substring(cleanText.indexOf('{'), cleanText.lastIndexOf('}') + 1);

        try {
            const blogArticles = JSON.parse(cleanText); // Attempt to parse JSON
            console.log('Generated blog articles:', blogArticles); // Log generated blog articles
            res.json(blogArticles); // Send parsed JSON response
        } catch (jsonParseError) {
            console.error('JSON Parsing Error:', jsonParseError.message);
            console.error('Sanitized AI Response:', cleanText); // Log sanitized response
            throw new Error('Failed to parse AI response into JSON.');
        }
    } catch (error) {
        console.error('Error in /generate-blog:', error.message);

        res.status(500).json({
            error: 'Error generating blog articles',
            details: error.message,
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
        });
    }
});



app.get('/blogs', async (req, res) => {
    try {
        // Fetch all blog documents from the "blogs" collection
        const blogs = await Blog.find();
        
        // Respond with the list of blogs
        res.status(200).json(blogs);
    } catch (error) {
        console.error('Error fetching blogs:', error);
        res.status(500).json({ error: 'Failed to fetch blogs.' });
    }
});


// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});


app.post('/translate-blog', async (req, res) => {
    try {
        const { title, content, language } = req.body;

        if (!title || !content || !language) {
            return res.status(400).json({ error: 'Title, content, and language are required' });
        }

        // Sanitize inputs for the prompt
        const sanitizedTitle = title.replace(/"/g, '\\"');
        const sanitizedContent = content.replace(/"/g, '\\"');

        const prompt = `
IMPORTANT: You must respond ONLY with a valid JSON object.
DO NOT include any other text, markdown, or formatting.
DO NOT include \\json or \\\ markers.
DO NOT add any explanations.
ONLY return a JSON object in this exact format:
{"title":"translated title","content":"translated content"}

Translate this blog from English to ${language}:

Title: ${sanitizedTitle}
Content: ${sanitizedContent}

Remember: Your entire response must be ONLY the JSON object, nothing else.`;

        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        let rawText = result.response.text().trim();

        // Log raw response for debugging
        console.log('Raw AI response:', rawText);

        // Clean up the response
        rawText = rawText
            .replace(/```json\n?|```/g, '') // Remove any markdown
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
            .trim();

        // Find JSON boundaries
        const jsonStart = rawText.indexOf('{');
        const jsonEnd = rawText.lastIndexOf('}') + 1;
        
        if (jsonStart === -1 || jsonEnd === 0) {
            throw new Error('Invalid response format from AI');
        }

        let jsonStr = rawText.slice(jsonStart, jsonEnd);
        
        // Additional sanitization and validation
        const validateAndFixJSON = (str) => {
            // Check if the JSON structure is complete
            const titleMatch = /"title"\s*:\s*"([^"]*)/;
            const contentMatch = /"content"\s*:\s*"([^"]*)/;
            
            // Fix missing quotes if needed
            if (titleMatch.test(str) && !str.includes('"title":"')) {
                str = str.replace(titleMatch, '"title":"$1"');
            }
            if (contentMatch.test(str) && !str.includes('"content":"')) {
                str = str.replace(contentMatch, '"content":"$1"');
            }

            // Ensure proper string termination
            if (!str.endsWith('"}')) {
                if (str.endsWith('}')) {
                    // If missing closing quote before }
                    str = str.slice(0, -1) + '"}';
                } else {
                    // If missing both quote and }
                    str += '"}';
                }
            }

            return str;
        };

        // Fix and validate JSON
        jsonStr = validateAndFixJSON(jsonStr);
        
        // Log cleaned JSON string for debugging
        console.log('Cleaned JSON string:', jsonStr);

        // Try parsing the JSON
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            // Final attempt to fix common issues
            jsonStr = jsonStr
                .replace(/([^\\])"/g, '$1\\"') // Escape unescaped quotes
                .replace(/\s+/g, ' ') // Normalize whitespace
                .replace(/^\{/, '{"title":"') // Ensure proper opening
                .replace(/\}$/, '"}') // Ensure proper closing
                .replace(/",\s*"/, '","') // Fix property separator
                .replace(/:\s*"/, '":"'); // Fix value separator
            
            parsedResponse = JSON.parse(jsonStr);
        }

        // Validate the structure
        if (!parsedResponse.title || !parsedResponse.content) {
            throw new Error('Invalid translation response structure');
        }

        // Send the cleaned response
        res.json({
            title: parsedResponse.title.trim(),
            content: parsedResponse.content.trim()
        });

    } catch (error) {
        console.error('Translation error:', error);
        console.error('Full error:', error.stack);
        res.status(500).json({
            error: 'Translation failed',
            details: error.message
        });
    }
});

// Add this route to your server.js
app.post('/generate-text-blog', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'No text content provided' });
        }

        const prompt = `
        Task: Convert the following text into a blog article.

        Text: "${text}"

        Instructions:
    IMPORTANT: You must respond ONLY with a valid JSON object.
    DO NOT include any other text, markdown, or formatting.
    DO NOT include \\json or \\\ markers.
    DO NOT add any explanations.
    DO NOT USE ANY HTML TAGS OR MARKUP AT ALL
    DO NOT USE AN <p> TAGS EITHER
    ONLY return a JSON object in this exact format:
        Respond ONLY with a valid JSON object in exactly this format:
        {
            "title": "Generated Title Here",
            "content": "Generated Content Here"
        }

        The response must be valid JSON. Do not include additional text, explanations, or markdown formatting.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const { response } = await model.generateContent(prompt);

        if (!response || typeof response.text !== 'function') {
            throw new Error('Unexpected response structure from the Generative AI model.');
        }

        const rawText = response.text();
        let cleanText = rawText
            .replace(/```json|```/g, '')
            .trim();

        cleanText = cleanText.substring(
            cleanText.indexOf('{'), 
            cleanText.lastIndexOf('}') + 1
        );

        try {
            const blogContent = JSON.parse(cleanText);
            console.log('Generated blog content:', blogContent);
            res.json(blogContent);
        } catch (jsonParseError) {
            console.error('JSON Parsing Error:', jsonParseError.message);
            throw new Error('Failed to parse AI response into JSON.');
        }
    } catch (error) {
        console.error('Error in /generate-text-blog:', error.message);
        res.status(500).json({
            error: 'Error generating blog content',
            details: error.message,
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log('Environment variables loaded:', {
        GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID ? '✓' : '✗',
        GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? '✓' : '✗',
        GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? '✓' : '✗',
        GOOGLE_GENERATIVE_AI_KEY: process.env.GOOGLE_GENERATIVE_AI_KEY ? '✓' : '✗'
    });
});