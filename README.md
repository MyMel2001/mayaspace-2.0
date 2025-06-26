# MayaSpace

MayaSpace is a simple, customizable, and federated social networking platform powered by the ActivityPub protocol. It is designed to be a lightweight alternative to larger platforms, with a focus on user expression and interoperability with the wider Fediverse.

## Features

- **User Accounts:** Standard registration and login system with secure password hashing.
- **Customizable Profiles:** Users can set a display name, bio, and apply custom CSS to their profile pages.
- **Media Uploads:** Create posts with text, images, GIFs, and videos. Uploaded media is automatically compressed for web-friendly viewing.
- **ActivityPub Federation:**
  - Users have their own ActivityPub actor and are discoverable from other federated platforms (like Mastodon, Pleroma, etc.).
  - Create and share posts that can be federated to followers.
  - Receive and process `Follow` and `Unfollow` requests from other users in the Fediverse.
- **Easy Configuration:** Application settings are managed through a `.env` file.
- **April Fool's Theming:** Includes a fun, client-side theme change that activates on April 1st.

## Prerequisites

Before you begin, ensure you have the following installed on your server:
- [Node.js](https://nodejs.org/) (v18.x or later recommended)
- [npm](https://www.npmjs.com/) (usually comes with Node.js)
- [ffmpeg](https://ffmpeg.org/download.html): This is required for video and GIF processing.

## Getting Started

### 1. Clone the repository
```bash
git clone <repository_url>
cd mayaspace-2.0
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure your environment
Copy the example environment file to a new `.env` file.
```bash
cp .env.example .env
```
Now, open `.env` and customize the variables:

- `DOMAIN`: Your public domain name (e.g., `mayaspace.example.com`). **Do not use `localhost` for production.**
- `PORT`: The port the application will run on (defaults to 3000).
- `SESSION_SECRET`: A long, random, and secret string for securing user sessions.
- `DATABASE_PATH`: The path to the main SQLite database file.
- `SESSIONS_DATABASE_PATH`: The path to the session database file.

### 4. Running the Application

To start the server for development, run:
```bash
npm start
```
The server will be running at `http://localhost:3000` (or your configured domain and port).

For production, it is highly recommended to use a process manager like `pm2` to ensure the application runs continuously.

```bash
# Install pm2 globally
npm install pm2 -g

# Start the application with pm2
pm2 start index.js --name mayaspace
```

It is also recommended to run this application behind a reverse proxy like Nginx or Caddy to handle SSL/TLS termination.

## Federation Status

MayaSpace has a foundational implementation of ActivityPub.

- **Outgoing:** Users can create posts that are delivered to their followers' inboxes across the Fediverse.
- **Incoming:** The server can process `Follow` and `Undo Follow` requests, allowing users from other servers to subscribe to local accounts.

Future development could include handling `Like` and `Announce` (boost) activities, displaying federated posts in a timeline, and more. 