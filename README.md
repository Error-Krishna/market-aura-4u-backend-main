# Market Aura 4U Backend

Backend API for Market Aura 4U, a marketing SaaS application for generating and publishing social media content.

## Tech Stack

- Node.js
- Express.js
- MongoDB
- Mongoose
- JWT authentication
- bcrypt
- Axios
- Groq API
- Instagram integration
- Twitter/X integration
- Razorpay
- CORS
- Cookie Parser

## Prerequisites

- Node.js
- npm
- MongoDB

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root and use `.env.example` as the reference:

```env
PORT=8000
NODE_ENV=development

MONGO_URI=

JWT_SECREAT_KEY=

GROQ_API_KEY=

INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_REDIRECT_URI=

TWITTER_ACCESS_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
```

Do not commit `.env` to source control.

## Running the Backend

```bash
npm start
```

The application entry point is:

```text
src/app.js
```

## API Base Path

The main API is mounted under:

```text
/api
```

Version 1 endpoints are mounted under:

```text
/api/v1
```

### Main API Areas

- `/api/v1/auth` — authentication and user onboarding
- `/api/v1/content` — content generation, publishing, and history
- `/api/v1/auth/instagram` — Instagram authentication
- `/api/v1/user/payment` — payment operations
- `/api/v1/publish/instagram` — Instagram publishing

## Project Structure

```text
src/
├── app.js
├── config/
│   └── db.js
├── controllers/
│   ├── auth/
│   ├── connectAccount/
│   ├── content/
│   └── payments/
├── middleware/
├── models/
├── routes/
│   └── v1/
└── utils/
```

## Authentication

The backend uses JWT-based authentication.

Authentication middleware checks tokens from:

- Cookies
- `Authorization: Bearer <token>` headers

## Development Notes

Environment variables are used for database credentials, authentication secrets, third-party API credentials, and payment credentials.

Keep secrets out of source control and use `.env.example` as the template for local configuration.
