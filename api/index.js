/* Vercel serverless entry — serves the full Express app. */
const { createApp } = require('../app');

let ready = null;

module.exports = async (req, res) => {
  if (!ready) ready = createApp();
  const { app } = await ready;
  return app(req, res);
};
