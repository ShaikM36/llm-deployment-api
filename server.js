const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Environment variables - set these in Render/Vercel
const MY_SECRET = process.env.MY_SECRET; // Your secret from the form
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Main endpoint to receive tasks
app.post('/deploy', async (req, res) => {
  console.log('Received request:', req.body);
  
  // Step 1: Verify secret
  if (req.body.secret !== MY_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Step 2: Send immediate 200 response
  res.status(200).json({ status: 'accepted', message: 'Processing your request' });

  // Step 3: Process asynchronously
  processTask(req.body).catch(err => console.error('Task processing failed:', err));
});

async function processTask(taskData) {
  const { email, task, round, nonce, brief, checks, evaluation_url, attachments } = taskData;

  try {
    console.log(`Processing task: ${task}, round: ${round}`);

    // Step 1: Generate code using Gemini
    const generatedCode = await generateCodeWithGemini(brief, checks, attachments);

    // Step 2: Create GitHub repo
    const repoName = `${task}-r${round}`;
    const repo = await createGitHubRepo(repoName);

    // Step 3: Push code to repo
    const commitSha = await pushCodeToRepo(repo.data.name, generatedCode, brief);

    // Step 4: Enable GitHub Pages
    await enableGitHubPages(repo.data.name);
    const pagesUrl = `https://${GITHUB_USERNAME}.github.io/${repo.data.name}/`;

    // Step 5: Wait for Pages to deploy (give it 2 minutes)
    console.log('Waiting for GitHub Pages to deploy...');
    await new Promise(resolve => setTimeout(resolve, 120000));

    // Step 6: Notify evaluation endpoint
    await notifyEvaluation({
      email,
      task,
      round,
      nonce,
      repo_url: repo.data.html_url,
      commit_sha: commitSha,
      pages_url: pagesUrl
    }, evaluation_url);

    console.log(`Task ${task} completed successfully`);
  } catch (error) {
    console.error('Error processing task:', error);
  }
}

async function generateCodeWithGemini(brief, checks, attachments) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

  // Prepare attachments info
  let attachmentsInfo = '';
  if (attachments && attachments.length > 0) {
    attachmentsInfo = '\n\nAttachments:\n';
    attachments.forEach(att => {
      attachmentsInfo += `- ${att.name}: ${att.url}\n`;
    });
  }

  const prompt = `You are a code generator. Create a complete, working single-page HTML application.

TASK BRIEF:
${brief}

CHECKS (these will be evaluated):
${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${attachmentsInfo}

REQUIREMENTS:
1. Generate a SINGLE HTML file with embedded CSS and JavaScript
2. Make it fully functional and ready to deploy
3. Use CDN links for any libraries (jsdelivr, unpkg, cdnjs)
4. Handle all edge cases
5. Make it look professional with good UI/UX
6. Ensure all checks will pass

IMPORTANT:
- If attachments are data URIs, fetch and use them in the code
- Do NOT use localStorage or sessionStorage
- Make sure all IDs and elements mentioned in checks exist
- Return ONLY the HTML code, no explanations

Generate the complete HTML file now:`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  let code = response.text();

  // Clean up code blocks if present
  code = code.replace(/```html\n?/g, '').replace(/```\n?/g, '');

  return {
    'index.html': code,
    'README.md': generateReadme(brief, checks),
    'LICENSE': getMITLicense()
  };
}

async function createGitHubRepo(repoName) {
  console.log(`Creating repo: ${repoName}`);
  
  try {
    const repo = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      description: 'Auto-generated deployment',
      public: true,
      auto_init: false
    });
    return repo;
  } catch (error) {
    if (error.status === 422) {
      // Repo already exists, delete and recreate
      console.log('Repo exists, deleting and recreating...');
      await octokit.repos.delete({
        owner: GITHUB_USERNAME,
        repo: repoName
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description: 'Auto-generated deployment',
        public: true,
        auto_init: false
      });
    }
    throw error;
  }
}

async function pushCodeToRepo(repoName, files, brief) {
  console.log(`Pushing code to ${repoName}`);

  // Create blobs for each file
  const blobs = {};
  for (const [filename, content] of Object.entries(files)) {
    const blob = await octokit.git.createBlob({
      owner: GITHUB_USERNAME,
      repo: repoName,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64'
    });
    blobs[filename] = blob.data.sha;
  }

  // Create tree
  const tree = await octokit.git.createTree({
    owner: GITHUB_USERNAME,
    repo: repoName,
    tree: Object.entries(blobs).map(([path, sha]) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha
    }))
  });

  // Create commit
  const commit = await octokit.git.createCommit({
    owner: GITHUB_USERNAME,
    repo: repoName,
    message: `Initial deployment: ${brief.substring(0, 50)}...`,
    tree: tree.data.sha,
    parents: []
  });

  // Update main branch
  await octokit.git.createRef({
    owner: GITHUB_USERNAME,
    repo: repoName,
    ref: 'refs/heads/main',
    sha: commit.data.sha
  });

  return commit.data.sha;
}

async function enableGitHubPages(repoName) {
  console.log(`Enabling GitHub Pages for ${repoName}`);
  
  try {
    await octokit.repos.createPagesSite({
      owner: GITHUB_USERNAME,
      repo: repoName,
      source: {
        branch: 'main',
        path: '/'
      }
    });
  } catch (error) {
    console.log('Pages might already be enabled:', error.message);
  }
}

async function notifyEvaluation(data, evaluationUrl) {
  console.log(`Notifying evaluation endpoint: ${evaluationUrl}`);
  
  let retries = 0;
  let delay = 1000; // Start with 1 second

  while (retries < 5) {
    try {
      const response = await axios.post(evaluationUrl, data, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      
      if (response.status === 200) {
        console.log('Evaluation notification successful');
        return;
      }
    } catch (error) {
      console.error(`Notification attempt ${retries + 1} failed:`, error.message);
    }
    
    retries++;
    await new Promise(resolve => setTimeout(resolve, delay));
    delay *= 2; // Exponential backoff
  }
  
  throw new Error('Failed to notify evaluation endpoint after retries');
}

function generateReadme(brief, checks) {
  return `# Auto-Generated Application

## Summary
${brief}

## Setup
1. Clone this repository
2. Open \`index.html\` in a web browser
3. The application runs entirely in the browser

## Usage
The application is deployed at GitHub Pages and can be accessed directly.

## Features
This application was generated to meet the following requirements:
${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Code Explanation
- **index.html**: Main application file containing HTML, CSS, and JavaScript
- All dependencies are loaded via CDN for zero-configuration deployment
- The application is fully self-contained and requires no build process

## License
MIT License - See LICENSE file for details
`;
}

function getMITLicense() {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'API is ready to receive tasks' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
