// `npm start` is the production entry point. Set the mode before importing the
// server so Fastify serves the built React application as well as the API.
process.env.NODE_ENV ??= "production";
process.env.HOST ??= "127.0.0.1";
await import("./index.js");
