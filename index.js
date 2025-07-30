require('dotenv').config();
const express = require('express');
const { QuickDB } = require('quick.db');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const activitypub = require('activitypub-express');
const sanitizeHtml = require('sanitize-html');
const QuickDBStore = require('./store');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const { BskyAgent } = require('@atproto/api');

// Simple captcha system
function generateCaptcha() {
  const operations = ['+', '-', '*'];
  const operation = operations[Math.floor(Math.random() * operations.length)];
  
  let num1, num2, answer;
  
  switch (operation) {
    case '+':
      num1 = Math.floor(Math.random() * 50) + 1;
      num2 = Math.floor(Math.random() * 50) + 1;
      answer = num1 + num2;
      break;
    case '-':
      num1 = Math.floor(Math.random() * 50) + 20; // Ensure positive result
      num2 = Math.floor(Math.random() * (num1 - 1)) + 1;
      answer = num1 - num2;
      break;
    case '*':
      num1 = Math.floor(Math.random() * 12) + 1;
      num2 = Math.floor(Math.random() * 12) + 1;
      answer = num1 * num2;
      break;
  }
  
  return {
    question: `${num1} ${operation} ${num2} = ?`,
    answer: answer
  };
}

function verifyCaptcha(userAnswer, correctAnswer) {
  return parseInt(userAnswer) === parseInt(correctAnswer);
}

const upload = multer({ 
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || 'localhost';

// -- Database --
const db = new QuickDB({ filePath: process.env.DATABASE_PATH || 'mayaspace.sqlite' });
const apexStore = new QuickDBStore();

// -- App Settings --
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Remove timeouts for upload processing
app.use((req, res, next) => {
  if (req.path === '/new-post') {
    req.setTimeout(0); // No timeout
    res.setTimeout(0); // No timeout
  }
  next();
});

// Session configuration (must come before routes that use sessions)
app.use(session({
    store: new SQLiteStore({ db: process.env.SESSIONS_DATABASE_PATH || 'sessions.sqlite', concurrentDB: true }),
    secret: process.env.SESSION_SECRET || 'a very secret key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// API Routes
// User search endpoint
app.get('/api/search/users', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.json([]);
  }
  
  try {
    const results = [];
    
    // Search local users
    const allUsers = await db.get('users') || {};
    for (const [username, user] of Object.entries(allUsers)) {
      if (username.toLowerCase().includes(q.toLowerCase()) || 
          (user.displayName && user.displayName.toLowerCase().includes(q.toLowerCase()))) {
        results.push({
          id: user.actor.id,
          username: username,
          name: user.displayName || username,
          domain: 'Local user',
          type: 'local'
        });
      }
    }
    
    // Search federated users (WebFinger lookup)
    if (q.includes('@') || q.includes('.')) {
      try {
        const federatedUser = await searchFederatedUser(q);
        if (federatedUser) {
          results.push(federatedUser);
        }
      } catch (error) {
        console.error('Federated search error:', error);
      }
    }
    
    res.json(results.slice(0, 10)); // Limit to 10 results
  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Like/dislike post endpoint
app.post('/api/posts/react', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { postId, action } = req.body;
  if (!postId || !['like', 'dislike'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  try {
    const posts = await db.get('posts') || [];
    const postIndex = posts.findIndex(p => p.id === postId);
    
    if (postIndex === -1) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const post = posts[postIndex];
    const userId = req.session.user.username;
    
    // Initialize reaction arrays if they don't exist
    if (!post.likedBy) post.likedBy = [];
    if (!post.dislikedBy) post.dislikedBy = [];
    
    // Remove existing reactions from this user
    post.likedBy = post.likedBy.filter(u => u !== userId);
    post.dislikedBy = post.dislikedBy.filter(u => u !== userId);
    
    // Add new reaction
    if (action === 'like') {
      post.likedBy.push(userId);
    } else {
      post.dislikedBy.push(userId);
    }
    
    // Update counts
    post.likes = post.likedBy.length;
    post.dislikes = post.dislikedBy.length;
    
    // Calculate post score for sorting
    post.score = post.likes - post.dislikes;
    
    posts[postIndex] = post;
    await db.set('posts', posts);
    
    res.json({
      likes: post.likes,
      dislikes: post.dislikes,
      score: post.score
    });
  } catch (error) {
    console.error('Reaction error:', error);
    res.status(500).json({ error: 'Failed to update reaction' });
  }
});

// Follow user endpoint
app.post('/api/follow', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }
  
  try {
    const currentUser = req.session.user.username;
    
    // Check if it's a local or remote user
    const isLocal = userId.includes(`https://${DOMAIN}/u/`);
    
    if (isLocal) {
      // Handle local follow
      const targetUsername = userId.split('/u/')[1];
      const targetUser = await db.get(`users.${targetUsername}`);
      
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Add to local following list
      const following = await db.get(`users.${currentUser}.following`) || [];
      if (!following.includes(userId)) {
        await db.push(`users.${currentUser}.following`, userId);
      }
      
      // Add to target's followers
      const followers = await db.get(`users.${targetUsername}.followers`) || [];
      if (!followers.includes(`https://${DOMAIN}/u/${currentUser}`)) {
        await db.push(`users.${targetUsername}.followers`, `https://${DOMAIN}/u/${currentUser}`);
      }
    } else {
      // Handle federated follow
      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `https://${DOMAIN}/activities/${crypto.randomBytes(16).toString('hex')}`,
        type: 'Follow',
        actor: `https://${DOMAIN}/u/${currentUser}`,
        object: userId,
        published: new Date().toISOString()
      };
      
      // Store the follow activity
      await apex.store.saveActivity(followActivity);
      
      // Add to following list
      const following = await db.get(`users.${currentUser}.following`) || [];
      if (!following.includes(userId)) {
        await db.push(`users.${currentUser}.following`, userId);
      }
      
      // Send federated follow request
      try {
        await apex.net.activity.send(followActivity, currentUser);
      } catch (federationError) {
        console.error('Federation error:', federationError);
        // Don't fail the whole request if federation fails
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// Reply to post endpoint
app.post('/reply', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  
  const { postId, content, captcha } = req.body;
  
  // Verify captcha
  if (!verifyCaptcha(captcha, req.session.captchaAnswer)) {
    return res.status(400).send('Invalid captcha. Please try again.');
  }
  
  // Clear captcha from session after use
  delete req.session.captchaAnswer;
  if (!postId || !content) {
    return res.status(400).send('Post ID and content are required');
  }
  
  try {
    const posts = await db.get('posts') || [];
    const parentPost = posts.find(p => p.id === postId);
    
    if (!parentPost) {
      return res.status(404).send('Post not found');
    }
    
    const replyId = crypto.randomBytes(16).toString('hex');
    const reply = {
      id: replyId,
      author: req.session.user.username,
      content,
      createdAt: new Date().toISOString(),
      replyTo: postId,
      likes: 0,
      dislikes: 0,
      likedBy: [],
      dislikedBy: [],
      score: 0
    };
    
    await db.push('posts', reply);
    
    // Bridge reply to Bluesky if both users have it enabled
    try {
      await bridgeReplyToBluesky(req.session.user.username, reply, parentPost);
    } catch (error) {
      console.error('Bluesky reply bridge error:', error);
      // Don't fail the reply if Bluesky bridge fails
    }
    
    res.redirect('/');
  } catch (error) {
    console.error('Reply error:', error);
    res.status(500).send('Failed to create reply');
  }
});

// Helper function for federated user search
async function searchFederatedUser(query) {
  try {
    let identifier = query;
    
    // Handle different input formats
    if (!identifier.startsWith('http') && !identifier.includes('@')) {
      return null; // Can't search without proper identifier
    }
    
    if (identifier.includes('@') && !identifier.startsWith('http')) {
      // WebFinger lookup
      const [username, domain] = identifier.split('@').slice(-2);
      if (!username || !domain) return null;
      
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
      
      const response = await fetch(webfingerUrl, {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      
      if (!response.ok) return null;
      
      const webfingerData = await response.json();
      const actorLink = webfingerData.links?.find(link => 
        link.rel === 'self' && link.type === 'application/activity+json'
      );
      
      if (!actorLink) return null;
      identifier = actorLink.href;
    }
    
    // Fetch actor data
    const actorResponse = await fetch(identifier, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
      },
      timeout: 5000
    });
    
    if (!actorResponse.ok) return null;
    
    const actorData = await actorResponse.json();
    
    return {
      id: actorData.id,
      username: actorData.preferredUsername,
      name: actorData.name || actorData.preferredUsername,
      domain: new URL(actorData.id).hostname,
      type: 'federated',
      summary: actorData.summary
    };
  } catch (error) {
    console.error('Federated search error:', error);
    return null;
  }
}

// Bluesky bridge functionality
async function bridgeToBluesky(username, post) {
  const blueskySettings = await db.get(`users.${username}.blueskySettings`);
  
  if (!blueskySettings || !blueskySettings.enabled || !blueskySettings.handle || !blueskySettings.password) {
    return; // Bridge not enabled or configured
  }
  
  try {
    console.log('Bridging post to Bluesky for user:', username);
    console.log('Using handle:', JSON.stringify(blueskySettings.handle));
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    
    const loginResult = await agent.login({
      identifier: blueskySettings.handle,
      password: blueskySettings.password
    });
    
    console.log('Bluesky bridge login successful for:', blueskySettings.handle);
    
    let postText = post.content;
    
    // Add source attribution
    postText += `\n\n— Posted from MayaSpace`;
    
    // Create Bluesky post
    const blueskyPost = {
      text: postText,
      createdAt: new Date().toISOString()
    };
    
    // Handle media attachments (basic implementation)
    if (post.attachment && post.attachment.mediaType.startsWith('image/')) {
      try {
        // For now, we'll skip image uploads as they require more complex handling
        // In a production environment, you'd want to download the image and upload it to Bluesky
        console.log('Image attachment detected but not yet supported for Bluesky bridge');
      } catch (mediaError) {
        console.error('Media upload to Bluesky failed:', mediaError);
      }
    }
    
    const result = await agent.post(blueskyPost);
    console.log('Successfully bridged post to Bluesky:', result.uri);
    
    // Convert AT Protocol URI to web URL for easier access
    const postId = result.uri.split('/').pop(); // Extract post ID from URI
    const webUrl = `https://bsky.app/profile/${blueskySettings.handle}/post/${postId}`;
    console.log('Bluesky web URL:', webUrl);
    
    // Update the post with both URIs for reference
    const posts = await db.get('posts') || [];
    const postIndex = posts.findIndex(p => p.id === post.id);
    if (postIndex !== -1) {
      posts[postIndex].blueskyUri = result.uri; // AT Protocol URI
      posts[postIndex].blueskyWebUrl = webUrl;  // Human-readable web URL
      await db.set('posts', posts);
    }
    
  } catch (error) {
    console.error('Bluesky bridge error for user', username, ':', error);
    console.error('Error details:', {
      message: error.message,
      status: error.status,
      code: error.code
    });
    throw error;
  }
}

// Bluesky bridge functionality for replies
async function bridgeReplyToBluesky(replyUsername, reply, originalPost) {
  console.log('=== CHECKING BLUESKY REPLY BRIDGE ===');
  console.log('Reply author:', replyUsername);
  console.log('Original post author:', originalPost.author);
  
  // Get both users' Bluesky settings
  const replyUserSettings = await db.get(`users.${replyUsername}.blueskySettings`);
  const originalUserSettings = await db.get(`users.${originalPost.author}.blueskySettings`);
  
  console.log('Reply user has Bluesky enabled:', replyUserSettings?.enabled && replyUserSettings?.connected);
  console.log('Original user has Bluesky enabled:', originalUserSettings?.enabled && originalUserSettings?.connected);
  
  // Both users must have Bluesky bridge enabled and connected
  if (!replyUserSettings?.enabled || !replyUserSettings?.connected || 
      !originalUserSettings?.enabled || !originalUserSettings?.connected) {
    console.log('Skipping Bluesky reply bridge - not both users have it enabled/connected');
    return;
  }
  
  try {
    console.log('Bridging reply to Bluesky for user:', replyUsername);
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    
    const loginResult = await agent.login({
      identifier: replyUserSettings.handle,
      password: replyUserSettings.password
    });
    
    console.log('Bluesky reply bridge login successful for:', replyUserSettings.handle);
    
    // Create reply text with quoted original
    let replyText = `"${originalPost.content}" --@${originalPost.author}\n\n${reply.content}`;
    
    // Add source attribution
    replyText += `\n\n— Reply from MayaSpace`;
    
    // Create Bluesky post
    const blueskyPost = {
      text: replyText,
      createdAt: new Date().toISOString()
    };
    
    // If the original post was bridged to Bluesky, make this a proper reply
    if (originalPost.blueskyUri) {
      console.log('Making proper Bluesky reply to:', originalPost.blueskyUri);
      blueskyPost.reply = {
        root: originalPost.blueskyUri,
        parent: originalPost.blueskyUri
      };
    } else {
      console.log('Original post not on Bluesky, posting as quote-style post');
    }
    
    const result = await agent.post(blueskyPost);
    console.log('Successfully bridged reply to Bluesky:', result.uri);
    
    // Convert AT Protocol URI to web URL
    const postId = result.uri.split('/').pop();
    const webUrl = `https://bsky.app/profile/${replyUserSettings.handle}/post/${postId}`;
    console.log('Bluesky reply web URL:', webUrl);
    
    // Update the reply with Bluesky URIs
    const posts = await db.get('posts') || [];
    const replyIndex = posts.findIndex(p => p.id === reply.id);
    if (replyIndex !== -1) {
      posts[replyIndex].blueskyUri = result.uri;
      posts[replyIndex].blueskyWebUrl = webUrl;
      await db.set('posts', posts);
    }
    
  } catch (error) {
    console.error('Bluesky reply bridge error for user', replyUsername, ':', error);
    console.error('Error details:', {
      message: error.message,
      status: error.status,
      code: error.code
    });
    throw error;
  }
}

// Session middleware moved above to before API routes

// -- ActivityPub --
const apex = activitypub({
    name: 'MayaSpace',
    version: '1.0.0',
    domain: DOMAIN,
    actorParam: 'username',
    objectParam: 'id',
    activityParam: 'id',
    store: apexStore,
    endpoints: {
        proxyUrl: `https://${DOMAIN}/proxy`,
    },
    routes: {
        actor: '/u/:username',
        object: '/o/:id',
        activity: '/s/:id',
        inbox: '/u/:username/inbox',
        outbox: '/u/:username/outbox',
        followers: '/u/:username/followers',
        following: '/u/:username/following',
        liked: '/u/:username/liked',
        collections: '/u/:username/c/:id',
        blocked: '/u/:username/blocked',
        rejections: '/u/:username/rejections',
        rejected: '/u/:username/rejected',
        shares: '/s/:id/shares',
        likes: '/s/:id/likes'
    }
});

app.use((req, res, next) => {
    res.locals.sessionUser = req.session.user;
    res.locals.apex = apex;
    res.locals.DOMAIN = DOMAIN;
    next();
});

// Mount ActivityPub routes
app.use(
  '/',
  (req, res, next) => {
    if (req.session.user) {
      res.locals.apex.actor = req.session.user;
    }
    next();
  },
  apex
);

// Captcha endpoint with canvas image
app.get('/api/captcha', (req, res) => {
  const captcha = generateCaptcha();
  req.session.captchaAnswer = captcha.answer;
  
  // Generate canvas-based captcha image
  const captchaImage = generateCaptchaImage(captcha.question);
  
  res.json({ 
    question: captcha.question,
    image: captchaImage 
  });
});

// Generate captcha image with canvas
function generateCaptchaImage(text) {
  // Use node-canvas simulation (we'll create a base64 data URL)
  const width = 200;
  const height = 80;
  
  // Create SVG-based captcha (works without node-canvas dependency)
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
  const randomColor = () => colors[Math.floor(Math.random() * colors.length)];
  
  // Generate random lines
  let lines = '';
  for (let i = 0; i < 5; i++) {
    const x1 = Math.random() * width;
    const y1 = Math.random() * height;
    const x2 = Math.random() * width;
    const y2 = Math.random() * height;
    const color = randomColor();
    const strokeWidth = Math.random() * 3 + 1;
    
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" opacity="0.7"/>`;
  }
  
  // Generate random circles/dots
  let circles = '';
  for (let i = 0; i < 8; i++) {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = Math.random() * 8 + 2;
    const color = randomColor();
    
    circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="0.4"/>`;
  }
  
  // Create distorted text effect
  const characters = text.split('');
  let textElements = '';
  let currentX = 20;
  
  characters.forEach((char, index) => {
    const fontSize = 24 + Math.random() * 8; // 24-32px
    const rotation = (Math.random() - 0.5) * 30; // -15 to +15 degrees
    const yOffset = Math.random() * 10 - 5; // -5 to +5px vertical offset
    const color = '#2c3e50'; // Dark color for readability
    
    textElements += `
      <text x="${currentX}" y="${40 + yOffset}" 
            font-family="Comic Sans MS, Chalkduster, fantasy" 
            font-size="${fontSize}" 
            fill="${color}" 
            font-weight="bold"
            transform="rotate(${rotation} ${currentX} ${40 + yOffset})">
        ${char}
      </text>`;
    
    currentX += fontSize * 0.7; // Space characters
  });
  
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="roughpaper" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence baseFrequency="0.04" numOctaves="5" result="noise" seed="1"/>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1"/>
        </filter>
      </defs>
      
      <!-- Background with slight texture -->
      <rect width="100%" height="100%" fill="#f8f9fa" filter="url(#roughpaper)"/>
      
      <!-- Background lines -->
      ${lines}
      
      <!-- Background circles -->
      ${circles}
      
      <!-- Text -->
      ${textElements}
      
      <!-- Overlay lines (on top of text) -->
      <line x1="0" y1="${Math.random() * height}" x2="${width}" y2="${Math.random() * height}" stroke="${randomColor()}" stroke-width="2" opacity="0.3"/>
      <line x1="${Math.random() * width}" y1="0" x2="${Math.random() * width}" y2="${height}" stroke="${randomColor()}" stroke-width="2" opacity="0.3"/>
    </svg>
  `;
  
  // Convert SVG to base64 data URL
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

// -- Routes --
app.get('/', async (req, res) => {
    const posts = await db.get('posts') || [];
    
    // Initialize missing reaction data and calculate scores
    const postsWithScores = posts.map(post => {
        if (!post.likedBy) post.likedBy = [];
        if (!post.dislikedBy) post.dislikedBy = [];
        if (typeof post.likes !== 'number') post.likes = post.likedBy.length;
        if (typeof post.dislikes !== 'number') post.dislikes = post.dislikedBy.length;
        if (typeof post.score !== 'number') post.score = post.likes - post.dislikes;
        return post;
    });
    
    // Sort posts by score (likes - dislikes) first, then by creation time
    // Higher score means higher position
    // Now includes replies with quoted original posts
    const sortedPosts = postsWithScores.sort((a, b) => {
        // Primary sort: by score (likes - dislikes)
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        
        // Secondary sort: by creation time (newest first)
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
    
    // Add quoted post information for replies
    const postsWithQuotes = sortedPosts.map(post => {
        if (post.replyTo) {
            // Find the original post this is replying to
            const originalPost = postsWithScores.find(p => p.id === post.replyTo);
            if (originalPost) {
                post.quotedPost = {
                    content: originalPost.content,
                    author: originalPost.author,
                    createdAt: originalPost.createdAt
                };
            }
        }
        return post;
    });
    
    res.render('home', { 
        title: 'Welcome to MayaSpace',
        posts: postsWithQuotes
    });
});

app.post('/new-post', upload.single('media'), async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  const { content, captcha } = req.body;
  
  // Verify captcha
  if (!verifyCaptcha(captcha, req.session.captchaAnswer)) {
    return res.status(400).send('Invalid captcha. Please try again.');
  }
  
  // Clear captcha from session after use
  delete req.session.captchaAnswer;
  if (!content) {
    return res.status(400).send('Content is required');
  }

  let mediaPath = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const tempPath = req.file.path;
    
    // Ensure uploads directory exists
    const uploadsDir = path.join('public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    const targetPath = path.join('public', 'uploads', req.file.filename);
    mediaPath = req.file.filename;

    if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      const outputPath = targetPath + '.webp';
      mediaPath += '.webp';
      await sharp(tempPath).webp({ quality: 80 }).toFile(outputPath);
      fs.unlinkSync(tempPath); // Clean up original upload
    } else if (ext === '.gif') {
      const outputPath = targetPath + '.gif';
      mediaPath += '.gif';
      await new Promise((resolve, reject) => {
        ffmpeg(tempPath)
          .outputOptions([
            '-vf', 'scale=iw*0.7:ih*0.7', // Scale to 70% of original dimensions
            '-q:v', '20' // Quality setting (lower is better, 1-31 range, ~20 gives 80% quality)
          ])
          .toFormat('gif')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      }).finally(() => fs.unlinkSync(tempPath));
    } else if (['.mp4', '.mov', '.webm'].includes(ext)) {
      const outputPath = targetPath + '.mp4';
      mediaPath += '.mp4';
      await new Promise((resolve, reject) => {
        ffmpeg(tempPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .toFormat('mp4')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      }).finally(() => fs.unlinkSync(tempPath));
    } else {
       fs.renameSync(tempPath, targetPath);
    }
  }


  const id = crypto.randomBytes(16).toString('hex');
  const post = {
    id,
    author: req.session.user.username,
    content,
    createdAt: new Date().toISOString()
  };
  
  // Add attachment if media was uploaded
  if (mediaPath) {
    const mediaUrl = `https://${DOMAIN}/uploads/${mediaPath}`;
    let mimeType = 'image/webp';
    if (mediaPath.endsWith('.mp4')) {
      mimeType = 'video/mp4';
    } else if (mediaPath.endsWith('.gif')) {
      mimeType = 'image/gif';
    }
    post.attachment = {
      mediaType: mimeType,
      url: mediaUrl
    };
  }
  
  await db.push('posts', post);

  // Bridge to Bluesky if enabled
  try {
    await bridgeToBluesky(req.session.user.username, post);
  } catch (error) {
    console.error('Bluesky bridge error:', error);
    // Don't fail the post if Bluesky bridge fails
  }

  // Federate post
  if (process.env.APEX_DOMAIN) {
    const note = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${process.env.APEX_URL}/posts/${post.id}`,
      type: 'Note',
      published: new Date().toISOString(),
      attributedTo: `${process.env.APEX_URL}/u/${req.session.user.username}`,
      content: `<p>${post.content}</p>`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${process.env.APEX_URL}/u/${req.session.user.username}/followers`]
    };
    if (post.attachment) {
      note.attachment = [{
        type: 'Document',
        mediaType: post.attachment.mediaType,
        url: post.attachment.url.replace(`https://${DOMAIN}`, process.env.APEX_URL || `https://${DOMAIN}`),
        name: 'attachment'
      }];
    }
    const actorName = req.session.user.username;
    // Manually invoke the outbox post handler
    const mockReq = { ...req, body: note, params: { actor: actorName } };
    const mockRes = {
      locals: res.locals,
      status: (code) => {
        console.log(`Federation returned status ${code} for ${post.id}`);
        return {
          json: (data) => {
            if (!res.headersSent) res.redirect('/');
          }
        }
      },
      json: (data) => {
         if (!res.headersSent) res.redirect('/');
      }
    };
    const next = (err) => {
      if (err) console.error('Federation error', err);
      if (!res.headersSent) res.redirect('/');
    };
    return apex.net.outbox.post(mockReq, mockRes, next);
  }
  res.redirect('/');
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    const captcha = generateCaptcha();
    req.session.captchaAnswer = captcha.answer;
    res.render('register', { title: 'Register', captcha: captcha.question });
});

app.post('/register', async (req, res) => {
    const { username, password, captcha } = req.body;
    
    // Verify captcha
    if (!verifyCaptcha(captcha, req.session.captchaAnswer)) {
        return res.status(400).send('Invalid captcha. Please try again.');
    }
    
    // Clear captcha from session after use
    delete req.session.captchaAnswer;
    if (!username || !password) return res.status(400).send("Username and password are required.");

    const existingUser = await db.get(`users.${username}`);
    if (existingUser) return res.status(400).send("User already exists.");

    const hashedPassword = await bcrypt.hash(password, 10);
    const actor = await apex.createActor(username, username, 'A MayaSpace user');
    
    // Add collections to the actor
    actor.followers = `https://${DOMAIN}/u/${username}/followers`;
    actor.following = `https://${DOMAIN}/u/${username}/following`;
    actor.liked = `https://${DOMAIN}/u/${username}/liked`;

    const user = {
        username,
        password: hashedPassword,
        actor: actor,
        createdAt: new Date().toISOString()
    };
    await db.set(`users.${username}`, user);
    await apexStore.saveObject(actor);

    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    const captcha = generateCaptcha();
    req.session.captchaAnswer = captcha.answer;
    res.render('login', { title: 'Login', captcha: captcha.question });
});

app.post('/login', async (req, res) => {
    const { username, password, captcha } = req.body;
    
    // Verify captcha
    if (!verifyCaptcha(captcha, req.session.captchaAnswer)) {
        return res.status(400).send('Invalid captcha. Please try again.');
    }
    
    // Clear captcha from session after use
    delete req.session.captchaAnswer;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(400).send("Invalid username or password.");

    const match = await bcrypt.compare(password, user.password);
    if (match) {
        req.session.user = {
            username: user.username,
            id: user.actor.id
        };
        res.redirect(`/u/${user.username}`);
    } else {
        res.status(400).send("Invalid username or password.");
    }
});

app.get('/settings', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const user = await db.get(`users.${req.session.user.username}`);
    const blueskySettings = await db.get(`users.${req.session.user.username}.blueskySettings`) || {};
    const captcha = generateCaptcha();
    req.session.captchaAnswer = captcha.answer;
    res.render('settings', { title: 'Settings', user, blueskySettings, captcha: captcha.question });
});

app.post('/settings', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { displayName, bio, customCss, blueskyHandle, blueskyPassword, enableBlueskyBridge, captcha } = req.body;
    const { username } = req.session.user;
    
    // Verify captcha
    if (!verifyCaptcha(captcha, req.session.captchaAnswer)) {
        return res.status(400).send('Invalid captcha. Please try again.');
    }
    
    // Clear captcha from session after use
    delete req.session.captchaAnswer;

    const sanitizedCss = sanitizeHtml(customCss, {
        allowedTags: [],
        allowedAttributes: {},
        allowedStyles: {
            '*': {
                // Allow all text and layout styling
                'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'font-size': [/^\d+px$/],
                'font-family': [/^[\s\w,-]+$/],
                'text-align': [/^left$/, /^right$/, /^center$/],
                'text-decoration': [/^none$/, /^underline$/, /^overline$/, /^line-through$/],
                'border': [/^\d+px\s(solid|dashed|dotted)\s(rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)|#([0-9a-f]{3}){1,2})$/],
                'padding': [/^\d+px$/],
                'margin': [/^\d+px$/],
            }
        }
    });
    
    await db.set(`users.${username}.displayName`, displayName);
    await db.set(`users.${username}.bio`, bio);
    await db.set(`users.${username}.customCss`, sanitizedCss);

    // Handle Bluesky settings
    if (blueskyHandle || blueskyPassword || enableBlueskyBridge !== undefined) {
        console.log('=== BLUESKY SETTINGS UPDATE ===');
        console.log('Raw handle:', JSON.stringify(blueskyHandle)); // Shows invisible characters
        console.log('Password length:', blueskyPassword ? blueskyPassword.length : 0);
        console.log('Bridge enabled:', enableBlueskyBridge === 'on');
        
        // Sanitize handle by removing invisible characters and whitespace
        const sanitizedHandle = blueskyHandle ? blueskyHandle.trim().replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '') : '';
        
        console.log('Sanitized handle:', JSON.stringify(sanitizedHandle));
        
        const blueskySettings = {
            handle: sanitizedHandle,
            password: blueskyPassword || '',
            enabled: enableBlueskyBridge === 'on'
        };
        
        // Test Bluesky connection if credentials provided
        if (blueskySettings.enabled && blueskySettings.handle && blueskySettings.password) {
            console.log('=== TESTING BLUESKY CONNECTION ===');
            try {
                console.log('Testing Bluesky connection for:', blueskySettings.handle);
                const agent = new BskyAgent({ service: 'https://bsky.social' });
                
                const loginResult = await agent.login({
                    identifier: blueskySettings.handle,
                    password: blueskySettings.password
                });
                
                console.log('Bluesky login successful:', loginResult.success);
                blueskySettings.connected = true;
                blueskySettings.error = null;
            } catch (error) {
                console.error('Bluesky connection test failed:', error);
                blueskySettings.connected = false;
                
                // Provide more specific error messages
                if (error.message.includes('Invalid identifier or password')) {
                    blueskySettings.error = 'Invalid Bluesky handle or app password. Please check your credentials.';
                } else if (error.message.includes('network') || error.code === 'ENOTFOUND') {
                    blueskySettings.error = 'Network error connecting to Bluesky. Please check your internet connection.';
                } else if (error.message.includes('rate limit') || error.status === 429) {
                    blueskySettings.error = 'Rate limited by Bluesky. Please try again later.';
                } else if (error.message.includes('InvalidRequest')) {
                    blueskySettings.error = 'Invalid request format. Please make sure you\'re using your handle (not email) and an app password.';
                } else if (error.status === 401 || error.status === 403) {
                    blueskySettings.error = 'Authentication failed. Please verify your handle and app password are correct.';
                } else {
                    blueskySettings.error = `Connection failed: ${error.message || 'Unknown error'}. Please try again.`;
                }
                
                console.error('=== DETAILED BLUESKY ERROR ===');
                console.error('Error message:', error.message);
                console.error('Error status:', error.status);
                console.error('Error code:', error.code);
                console.error('Full error object:', error);
                console.error('Error stack:', error.stack);
                console.error('=== END ERROR DETAILS ===');
            }
        } else {
            console.log('Skipping Bluesky connection test - missing credentials or disabled');
        }
        
        // Log settings without exposing password
        const settingsToLog = { ...blueskySettings };
        if (settingsToLog.password) {
            settingsToLog.password = `[${settingsToLog.password.length} characters]`;
        }
        console.log('Saving Bluesky settings:', settingsToLog);
        await db.set(`users.${username}.blueskySettings`, blueskySettings);
    }

    const actorId = req.session.user.id;
    const actor = await apex.store.getObject(actorId);
    if (!actor) {
        return res.status(404).send('Actor not found.');
    }
    
    actor.name = displayName;
    actor.summary = bio;
    await apex.store.updateObject(actor, actorId, true);

    res.redirect(`/u/${username}`);
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/u/:username', async (req, res) => {
    const { username } = req.params;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(404).send('User not found');
    
    const allPosts = await db.get('posts') || [];
    const userPosts = allPosts.filter(p => p.author === username)
                              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Add quoted post information for replies in profile view
    const userPostsWithQuotes = userPosts.map(post => {
        if (post.replyTo) {
            const originalPost = allPosts.find(p => p.id === post.replyTo);
            if (originalPost) {
                post.quotedPost = {
                    content: originalPost.content,
                    author: originalPost.author,
                    createdAt: originalPost.createdAt
                };
            }
        }
        return post;
    });

    res.render('profile', {
        title: `${user.displayName || user.username}'s Profile`,
        user: user,
        posts: userPostsWithQuotes
    });
});

app.get('/u/:username/followers', async (req, res) => {
    const { username } = req.params;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(404).send('Not Found');
    const followers = await db.get(`users.${username}.followers`) || [];
    res.json(apex.utils.toCollection(req.originalUrl, followers));
});

app.get('/u/:username/following', (req, res) => {
    res.json(apex.utils.toCollection(req.originalUrl, []));
});

app.get('/u/:username/liked', (req, res) => {
    res.json(apex.utils.toCollection(req.originalUrl, []));
});

// ActivityPub event handlers
app.on('apex-inbox', async ({ activity }) => {
    try {
        if (activity.type === 'Follow') {
            const followedUsername = apex.utils.nameFromIRI(activity.object);
            if (!followedUsername) return;
            
            const user = await db.get(`users.${followedUsername}`);
            if (!user) return;

            const followers = await db.get(`users.${followedUsername}.followers`) || [];
            if (!followers.includes(activity.actor)) {
                await db.push(`users.${followedUsername}.followers`, activity.actor);
            }
        } else if (activity.type === 'Undo' && activity.object.type === 'Follow') {
            const followedUsername = apex.utils.nameFromIRI(activity.object.object);
            if (!followedUsername) return;

            const user = await db.get(`users.${followedUsername}`);
            if (!user) return;

            const currentFollowers = await db.get(`users.${followedUsername}.followers`) || [];
            const newFollowers = currentFollowers.filter(follower => follower !== activity.actor);
            await db.set(`users.${followedUsername}.followers`, newFollowers);
        }
    } catch (err) {
        console.error('Error in inbox handler:', err);
    }
});

app.get('/posts/:id', (req, res) => {
// ... existing code ...

});

// Chat routes
app.get('/chat', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    // Get recent chat messages
    const messages = await db.get('chat_messages') || [];
    const recentMessages = messages.slice(-50); // Last 50 messages
    
    res.render('chat', {
        title: 'Chat',
        messages: recentMessages
    });
});

// Socket.io for real-time chat
io.on('connection', (socket) => {
    console.log('User connected to chat');
    
    socket.on('join', (userData) => {
        socket.userData = userData;
        socket.join('global_chat');
        socket.broadcast.to('global_chat').emit('user_joined', userData.username);
    });
    
    socket.on('send_message', async (data) => {
        if (!socket.userData) return;
        
        const message = {
            id: crypto.randomBytes(16).toString('hex'),
            author: socket.userData.username,
            content: sanitizeHtml(data.content, {
                allowedTags: [],
                allowedAttributes: {}
            }),
            timestamp: new Date().toISOString()
        };
        
        // Save to database
        await db.push('chat_messages', message);
        
        // Broadcast to all users
        io.to('global_chat').emit('new_message', message);
    });
    
    socket.on('disconnect', () => {
        if (socket.userData) {
            socket.broadcast.to('global_chat').emit('user_left', socket.userData.username);
        }
        console.log('User disconnected from chat');
    });
});

// -- Server --
server.listen(port, () => {
    console.log(`MayaSpace is listening on port ${port}`);
});
